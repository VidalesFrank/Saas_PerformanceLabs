"""
Capacidad de rotación plástica por elemento (Fase 4).

Tres métodos:
    A. Mecánico (Paulay-Priestley + EC8-3)
    B. Eurocódigo 8-3 Anexo A (fórmula empírica θum)
    C. Haselton 2008 — ecuaciones IMK verificadas contra PEER 2007/03

Para cada elemento devuelve:
    θy, θ_cap_pl, θ_pc, θu
    θ_IO, θ_LS, θ_CP (mapeo ASCE 41-17 §10.3.3)
    Rangos de validez y notas

Si el ElementData trae L_p_measured_mm > 0, se fuerza el método Mecánico (A)
usando esa Lp observada en campo — independientemente del método solicitado.
Esto respeta la observación forense y evita contaminar la calibración empírica
de Haselton (que no toma Lp como variable).

Elwood & Moehle (2003): ajuste para elementos controlados por cortante — se
aplica θu *= f_elwood si el modo de falla es cortante o flexión-cortante.

Referencias:
    Paulay & Priestley (1992)  Lp mecánica
    EC8-3 (2005) Anexo A       θum, DL/SD/NC
    Haselton et al. (2008)     PEER 2007/03 — IMK coefs
    Elwood & Moehle (2003)     Drift at shear failure
    ASCE 41-17 §10.3.3         IO/LS/CP mapping
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import Literal, Optional

from .element_data import ElementData
from .moment_curvature_element import MomentCurvatureResult
from .failure_mode import FailureModeResult

RotationMethod = Literal["mecanico", "ec8_3", "haselton"]


@dataclass
class RotationCapacity:
    """Capacidad de rotación plástica + umbrales ASCE 41-17."""
    method:            str              # "mecanico" | "ec8_3" | "haselton"
    Lp_mm:             float            # Lp efectivo utilizado (observado o calculado)
    Lp_source:         str              # "measured" | "paulay_priestley" | ...

    theta_y:           float            # fluencia idealizada
    theta_cap_pl:      float            # plástica hasta pico
    theta_pc:          float            # rama post-pico
    theta_u:           float            # último = θy + θ_cap_pl

    # Umbrales ASCE 41-17 §10.3.3
    theta_IO:          float            # Inmediata Ocupación
    theta_LS:          float            # Seguridad de la Vida
    theta_CP:          float            # Prevención del Colapso

    # Haselton coeffs extra (si método=haselton)
    Mc_over_My:        Optional[float] = None    # strain-hardening ratio
    lambda_imk:        Optional[float] = None    # deterioro cíclico

    # Rotaciones asociadas a umbrales de deformación (si método=mecanico y hay M-φ)
    theta_DS2:         Optional[float] = None    # εc_cover = 0.004
    theta_DS3:         Optional[float] = None    # 0.75·εcu
    theta_DS4:         Optional[float] = None    # εcu

    # Ajuste Elwood si aplica
    elwood_factor:     float = 1.0

    notes:             list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


# ─────────────────────────────────────────────────────────────────────────────
# Lp — Longitud de rótula plástica
# ─────────────────────────────────────────────────────────────────────────────
def Lp_paulay_priestley(el: ElementData) -> float:
    """Paulay & Priestley (1992), Lp en mm.

        Lp = max(0.08·Ls + 0.022·fy·db, 0.044·fy·db)

    Con fy en MPa, db en mm, Ls en mm.
    """
    fy = el.materials.fy_MPa
    db = el.longitudinal.db_mm
    Ls_mm = el.geometry.Ls_m * 1000.0
    Lp1 = 0.08 * Ls_mm + 0.022 * fy * db
    Lp2 = 0.044 * fy * db
    return max(Lp1, Lp2)


def Lp_priestley_2007(el: ElementData) -> float:
    """Priestley et al. (2007) — refinado para columnas con alta ductilidad.

        Lp = kLsp·Ls + Lsp
        Lsp = 0.022·fy·db
        kLsp = max(0.08, 0.2·(fu/fy − 1))

    Para columnas con fu/fy=1.5, kLsp = 0.1 → similar a Paulay-Priestley.
    """
    fy = el.materials.fy_MPa
    fu = el.materials.fu_MPa
    db = el.longitudinal.db_mm
    Ls_mm = el.geometry.Ls_m * 1000.0
    k = max(0.08, 0.2 * (fu / max(fy, 1.0) - 1.0))
    Lsp = 0.022 * fy * db
    return k * Ls_mm + Lsp


def _lp_from_element(el: ElementData) -> tuple[float, str]:
    """Devuelve (Lp_mm, source). Observación de campo tiene prioridad absoluta."""
    if el.field.L_p_measured_mm and el.field.L_p_measured_mm > 0:
        return el.field.L_p_measured_mm, "measured"
    method = el.field.L_p_method
    if method == "priestley_2007":
        return Lp_priestley_2007(el), "priestley_2007"
    if method == "atc_32":
        return 0.5 * el.geometry.h_m * 1000.0, "atc_32"      # ATC-32: Lp = 0.5·h
    return Lp_paulay_priestley(el), "paulay_priestley"


# ─────────────────────────────────────────────────────────────────────────────
# Método A — Mecánico (requiere M-φ de Fase 3)
# ─────────────────────────────────────────────────────────────────────────────
def _theta_y_ec8_3(el: ElementData, phi_y_rad_per_m: float) -> float:
    """Fluencia según EC8-3 Anexo A (viga/columna de hormigón).

        θy = φy·Ls/3 + 0.0013·(1 + 1.5·h/Ls) + 0.13·φy·db·fy/√f'c

    Con φy en rad/m, h/Ls adim, db en mm (se convierte a adim en el término
    de slip), fy en MPa, f'c en MPa. Resultado adim (rad).
    """
    h = el.geometry.h_m
    Ls = el.geometry.Ls_m
    db = el.longitudinal.db_mm
    fy = el.materials.fy_MPa
    fc = el.materials.fc_MPa

    # El término de slip 0.13·φy·db·fy/√f'c: unidades mixtas — típicamente
    # expresadas con db en mm, φy en rad/m, fy en MPa. Resultado rad.
    phi_y_rad_per_mm = phi_y_rad_per_m / 1000.0
    term_flexural  = phi_y_rad_per_m * Ls / 3.0
    term_fixed_end = 0.0013 * (1.0 + 1.5 * h / max(Ls, 0.1))
    term_slip      = 0.13 * phi_y_rad_per_mm * db * fy / math.sqrt(max(fc, 1.0))
    return term_flexural + term_fixed_end + term_slip


def rotation_capacity_mechanical(
    el:    ElementData,
    mc:    MomentCurvatureResult,
) -> RotationCapacity:
    """Método A — fórmulas mecánicas con M-φ real.

        θp = (φu − φy)·Lp
        θu = θy + θp

    Umbrales ASCE 41 (mapeo típico):
        θ_IO = 0.15·θ_cap_pl
        θ_LS = 0.50·θ_cap_pl
        θ_CP = 0.75·θ_cap_pl
    """
    Lp_mm, Lp_src = _lp_from_element(el)

    theta_y = _theta_y_ec8_3(el, mc.phi_y_rad_per_m)

    # φp = φu − φy en rad/m → multiplicar por Lp en mm → convertir mm a m
    delta_phi = max(mc.phi_u_rad_per_m - mc.phi_y_rad_per_m, 0.0)
    theta_cap_pl = delta_phi * (Lp_mm / 1000.0)
    # θ_pc: aproximación mecánica — rama post-pico asumida 2×θ_cap_pl, cap 0.10
    theta_pc = min(2.0 * theta_cap_pl, 0.10)
    theta_u  = theta_y + theta_cap_pl

    # Mapeo ASCE 41
    theta_IO = theta_y + 0.15 * theta_cap_pl
    theta_LS = theta_y + 0.50 * theta_cap_pl
    theta_CP = theta_y + 0.75 * theta_cap_pl

    # Umbrales DS a partir de φ en umbrales de deformación (si están)
    def _theta_at(phi_opt: Optional[float]) -> Optional[float]:
        if phi_opt is None:
            return None
        d = max(phi_opt - mc.phi_y_rad_per_m, 0.0)
        return theta_y + d * (Lp_mm / 1000.0)

    theta_DS2 = _theta_at(mc.phi_eps_c_004)
    theta_DS3 = _theta_at(mc.phi_075_eps_cu)
    theta_DS4 = _theta_at(mc.phi_eps_cu) or theta_u

    return RotationCapacity(
        method="mecanico", Lp_mm=Lp_mm, Lp_source=Lp_src,
        theta_y=theta_y, theta_cap_pl=theta_cap_pl, theta_pc=theta_pc, theta_u=theta_u,
        theta_IO=theta_IO, theta_LS=theta_LS, theta_CP=theta_CP,
        theta_DS2=theta_DS2, theta_DS3=theta_DS3, theta_DS4=theta_DS4,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Método B — EC8-3 Anexo A (empírico)
# ─────────────────────────────────────────────────────────────────────────────
def rotation_capacity_ec8_3(
    el: ElementData,
    mc: Optional[MomentCurvatureResult] = None,
) -> RotationCapacity:
    """EC8-3 (2005) Anexo A, ec. A.1:

        θum = 0.016·(0.3^ν)·[max(0.01, ω')/max(0.01, ω)·f'c]^0.225
              ·(Ls/h)^0.35
              ·25^(α·ρsx·fyw/f'c)
              ·1.25^(100·ρd)

    Límites (elementos primarios, γel=1.5):
        DL (= IO) = θy
        SD (= LS) = ¾·θum
        NC (= CP) = θum / γel
    """
    nu   = el.axial.nu
    omega  = el.longitudinal.rho       * el.materials.fy_MPa / el.materials.fc_MPa
    omega_prime = el.longitudinal.rho_prima * el.materials.fy_MPa / el.materials.fc_MPa
    Ls_h = el.geometry.Ls_m / el.geometry.h_m
    rho_sx = el.transverse.rho_sh
    fyw_fc = el.materials.fyh_MPa / el.materials.fc_MPa
    # α: factor de efectividad del confinamiento, para columnas rect. ≈ 0.6
    alpha = 0.6
    rho_d = 0.0                                             # cuantía diagonal, 0 para RCMRF típico

    base = 0.016 * (0.3 ** nu)
    omega_ratio = max(0.01, omega_prime) / max(0.01, omega) * el.materials.fc_MPa
    f_omega  = omega_ratio ** 0.225
    f_Ls_h   = Ls_h ** 0.35
    f_conf   = 25.0 ** (alpha * rho_sx * fyw_fc)
    f_diag   = 1.25 ** (100.0 * rho_d)
    theta_um = base * f_omega * f_Ls_h * f_conf * f_diag

    notes: list[str] = []

    # Reducciones por detallado deficiente (EC8-3 Anexo A §A.3.2)
    if el.transverse.hook_type == "90deg":
        theta_um *= 0.80
        notes.append("Reducción 0.80 por gancho a 90°")
    if el.detailing.splice_in_hinge:
        theta_um *= 0.75
        notes.append("Reducción 0.75 por empalme en zona rótula")

    # Fluencia θy (del método mecánico si hay M-φ; si no, EC8-3 simplificado)
    if mc:
        theta_y = _theta_y_ec8_3(el, mc.phi_y_rad_per_m)
    else:
        # Simplificación: θy ≈ θum / 5 (ratio típico de ductilidad)
        theta_y = theta_um / 5.0
        notes.append("θy aproximado por falta de M-φ (θum/5)")

    theta_SD = 0.75 * theta_um
    theta_NC = theta_um / 1.5
    theta_cap_pl = theta_NC - theta_y
    theta_pc = min(2.0 * theta_cap_pl, 0.10)
    theta_u  = theta_NC

    # Lp — para reportar; en EC8-3 no se usa explícito
    Lp_mm, Lp_src = _lp_from_element(el)

    return RotationCapacity(
        method="ec8_3", Lp_mm=Lp_mm, Lp_source=Lp_src,
        theta_y=theta_y, theta_cap_pl=theta_cap_pl, theta_pc=theta_pc, theta_u=theta_u,
        theta_IO=theta_y,        # DL
        theta_LS=theta_SD,       # SD
        theta_CP=theta_NC,       # NC
        notes=notes,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Método C — Haselton 2008 (verificado contra PEER 2007/03)
# ─────────────────────────────────────────────────────────────────────────────
def haselton_imk_column(
    nu:       float,
    rho_sh:   float,
    a_sl:     int,
    fc_MPa:   float,
    fy_MPa:   float,
    s_over_db: float,
) -> dict:
    """Haselton et al. 2008 — IMK parameters para columnas RC.

    Modified Option 2 (más usada en práctica):
        θ_cap,pl = 0.12·(1 + 0.4·a_sl)·(0.2)^ν·(0.02 + 40·ρ_sh)^0.52·(0.56)^(0.01·c_units·f'c)
        θ_pc    = min(0.10, 0.76·(0.031)^ν·(0.02 + 40·ρ_sh)^1.02)
        λ       = 30·(0.3)^ν                   (deterioro cíclico, c=1.0)
        Mc/My   = 1.25·(0.89)^ν·(0.91)^(0.01·c_units·f'c)

    Con fc, fy en MPa → c_units=1.0 (nativo).
    sn = (s/db)·√(fy/690)   # 690 MPa ≈ 100 ksi
    """
    c_units = 1.0
    fc = fc_MPa
    sn = s_over_db * math.sqrt(fy_MPa / 690.0)

    theta_cap_pl = (0.12
                    * (1 + 0.4 * a_sl)
                    * (0.2 ** nu)
                    * ((0.02 + 40 * rho_sh) ** 0.52)
                    * (0.56 ** (0.01 * c_units * fc)))

    theta_pc = min(0.10,
                    0.76 * (0.031 ** nu) * ((0.02 + 40 * rho_sh) ** 1.02))

    lam = 30.0 * (0.3 ** nu)

    Mc_My = 1.25 * (0.89 ** nu) * (0.91 ** (0.01 * c_units * fc))

    return {
        "theta_cap_pl": theta_cap_pl,
        "theta_pc":     theta_pc,
        "lambda_imk":   lam,
        "Mc_over_My":   Mc_My,
        "sn":           sn,
        # Dispersiones σ_LN (Haselton 2008, Tabla 4.6)
        "sigma_LN_theta_cap_pl": 0.60,
        "sigma_LN_theta_pc":     0.72,
        "sigma_LN_lambda":       0.49,
        "sigma_LN_Mc_My":        0.10,
    }


def rotation_capacity_haselton(
    el: ElementData,
    mc: Optional[MomentCurvatureResult] = None,
) -> RotationCapacity:
    """Método C — Haselton 2008 (IMK parameters).

    Mapeo ASCE 41-17:
        θ_IO = 0.15·θ_cap,pl
        θ_LS = 0.50·θ_cap,pl
        θ_CP = 0.75·θ_cap,pl + 0.10·θ_pc
    """
    # Validación: Haselton rango ρ_sh ∈ [0.001, 0.025], ν ∈ [0, 0.70], fc ∈ [20, 120]
    notes: list[str] = []
    nu = el.axial.nu
    if nu > 0.70:
        notes.append(f"ν={nu:.2f} > 0.70 fuera de rango Haselton (clipping a 0.70)")
        nu = 0.70
    rho_sh = max(min(el.transverse.rho_sh, 0.025), 0.001)
    if el.transverse.rho_sh < 0.001:
        notes.append("ρ_sh < 0.001 — clipping (poco confinamiento)")

    a_sl = 1    # columnas RC típicamente tienen slip de barras → a_sl = 1
    if el.detailing.splice_in_hinge:
        a_sl = 1       # splice en rótula también activa el slip

    coeffs = haselton_imk_column(
        nu=nu, rho_sh=rho_sh, a_sl=a_sl,
        fc_MPa=el.materials.fc_MPa, fy_MPa=el.materials.fy_MPa,
        s_over_db=el.detailing.s_over_db_long,
    )
    theta_cap_pl = coeffs["theta_cap_pl"]
    theta_pc     = coeffs["theta_pc"]

    # θy: del M-φ si existe; si no, aproximación Haselton con rotación de
    # fluencia típica (de Panagiotakos & Fardis 2001).
    if mc:
        theta_y = _theta_y_ec8_3(el, mc.phi_y_rad_per_m)
    else:
        # Aproximación: θy ≈ 0.5%·(1 + axial)
        theta_y = 0.005 * (1.0 + nu)
        notes.append("θy aproximado (sin M-φ)")

    theta_u = theta_y + theta_cap_pl

    theta_IO = theta_y + 0.15 * theta_cap_pl
    theta_LS = theta_y + 0.50 * theta_cap_pl
    theta_CP = theta_y + 0.75 * theta_cap_pl + 0.10 * theta_pc

    Lp_mm, Lp_src = _lp_from_element(el)

    return RotationCapacity(
        method="haselton", Lp_mm=Lp_mm, Lp_source=Lp_src,
        theta_y=theta_y, theta_cap_pl=theta_cap_pl, theta_pc=theta_pc, theta_u=theta_u,
        theta_IO=theta_IO, theta_LS=theta_LS, theta_CP=theta_CP,
        Mc_over_My=coeffs["Mc_over_My"],
        lambda_imk=coeffs["lambda_imk"],
        notes=notes,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Ajuste Elwood para elementos controlados por cortante
# ─────────────────────────────────────────────────────────────────────────────
def elwood_shear_drift_capacity(el: ElementData, V_demand_kN: float) -> float:
    """Drift (Δ/L) de pérdida de capacidad por cortante, Elwood & Moehle 2003:

        Δ/L = 3/100 + 4·ρ_sh − (1/40)·(v/√f'c) − (1/40)·(P/(Ag·f'c)) ≥ 1/100

    Con ρ_sh adim, v = V/(b·d) en MPa, f'c en MPa, P en N, Ag en mm².
    Resultado adim (rad), aproximable a θ.
    """
    b_mm = el.geometry.b_m * 1000.0
    d    = el.geometry.d_mm
    v_MPa = V_demand_kN * 1000.0 / max(b_mm * d, 1.0)
    sqrt_fc = math.sqrt(max(el.materials.fc_MPa, 1.0))
    rho_sh  = el.transverse.rho_sh
    P_N     = max(el.axial.N_grav_kN, 0.0) * 1000.0
    Ag_fc   = el.geometry.Ag_mm2 * el.materials.fc_MPa

    drift = 0.03 + 4 * rho_sh - (1 / 40) * (v_MPa / sqrt_fc) - (1 / 40) * (P_N / max(Ag_fc, 1.0))
    return max(drift, 0.01)


def apply_elwood_adjustment(rc: RotationCapacity, el: ElementData,
                            fm: FailureModeResult) -> RotationCapacity:
    """Si el elemento es flexión-cortante o cortante, limita θ_cap_pl y recalcula
    θ_u / θ_LS / θ_CP respecto al drift de Elwood.
    """
    if fm.failure_mode == "flexion":
        rc.elwood_factor = 1.0
        return rc

    theta_shear = elwood_shear_drift_capacity(el, fm.Vp_kN)
    # Factor de reducción = min(1, θ_shear / θ_cap_pl)
    if rc.theta_cap_pl <= 0:
        rc.elwood_factor = 1.0
        return rc
    factor = min(1.0, theta_shear / (rc.theta_y + rc.theta_cap_pl))
    rc.elwood_factor = factor

    rc.theta_cap_pl *= factor
    rc.theta_u = rc.theta_y + rc.theta_cap_pl
    rc.theta_IO = rc.theta_y + 0.15 * rc.theta_cap_pl
    rc.theta_LS = rc.theta_y + 0.50 * rc.theta_cap_pl
    rc.theta_CP = rc.theta_y + 0.75 * rc.theta_cap_pl + 0.10 * rc.theta_pc
    rc.notes.append(f"Elwood: ajuste por {fm.failure_mode} con factor {factor:.3f}")
    return rc


# ─────────────────────────────────────────────────────────────────────────────
# Punto de entrada principal
# ─────────────────────────────────────────────────────────────────────────────
def compute_rotation_capacity(
    el:     ElementData,
    mc:     Optional[MomentCurvatureResult] = None,
    fm:     Optional[FailureModeResult]     = None,
    method: RotationMethod = "haselton",
) -> RotationCapacity:
    """Calcula capacidad de rotación según el método especificado.

    L_p_measured_mm > 0 fuerza el método "mecanico" independientemente del
    `method` solicitado (observación de campo tiene prioridad).

    Si fm está dado y el modo es flexión-cortante / cortante, aplica el
    ajuste Elwood automáticamente.
    """
    # Override por observación de campo
    if el.field.L_p_measured_mm and el.field.L_p_measured_mm > 0:
        if mc is None:
            raise ValueError(
                "El método mecánico (activado por L_p_measured_mm) requiere "
                "un MomentCurvatureResult previo. Corre compute_moment_curvature primero."
            )
        rc = rotation_capacity_mechanical(el, mc)
        rc.notes.insert(0, f"Método forzado a mecánico — Lp medida en campo = {el.field.L_p_measured_mm:.0f} mm")
    elif method == "mecanico":
        if mc is None:
            raise ValueError("Método mecánico requiere MomentCurvatureResult")
        rc = rotation_capacity_mechanical(el, mc)
    elif method == "ec8_3":
        rc = rotation_capacity_ec8_3(el, mc)
    elif method == "haselton":
        rc = rotation_capacity_haselton(el, mc)
    else:
        raise ValueError(f"Método desconocido: {method}")

    if fm is not None:
        rc = apply_elwood_adjustment(rc, el, fm)

    return rc


# ─────────────────────────────────────────────────────────────────────────────
# Tabla comparativa
# ─────────────────────────────────────────────────────────────────────────────
def comparative_table(
    el: ElementData,
    mc: Optional[MomentCurvatureResult] = None,
    fm: Optional[FailureModeResult]     = None,
) -> dict:
    """Devuelve capacidades por los 3 métodos + umbrales FEMA.

    Útil para la tabla "comparar métodos" del dashboard (Fase 7).
    """
    results = {}
    for method in ("mecanico", "ec8_3", "haselton"):
        try:
            rc = compute_rotation_capacity(el, mc=mc, fm=fm, method=method)
            results[method] = rc.to_dict()
        except (ValueError, ZeroDivisionError) as e:
            results[method] = {"error": str(e)}

    # Umbrales FEMA/ASCE 41-17 (Tablas 10-7/10-8) — hardcodeados actuales
    if el.kind == "beam":
        results["fema_asce41"] = {
            "theta_IO": 0.010, "theta_LS": 0.020, "theta_CP": 0.030,
            "source": "ASCE 41-17 Tabla 10-7 (DMO)",
        }
    else:
        results["fema_asce41"] = {
            "theta_IO": 0.005, "theta_LS": 0.012, "theta_CP": 0.020,
            "source": "ASCE 41-17 Tabla 10-8 (DMO)",
        }
    return results
