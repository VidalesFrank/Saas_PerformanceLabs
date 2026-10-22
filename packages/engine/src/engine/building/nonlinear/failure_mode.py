"""
Clasificación de modo de falla por elemento (Fase 2).

Para cada viga/columna calcula:
    - Vp (cortante asociado a la plastificación por flexión) = 2·Mp / Ln
    - Vn según NSR-10 / ACI 318-19 (edificios nuevos o detallado dúctil)
    - Vn según Sezen-Moehle (2004) (edificios existentes, degrada con μ)
    - Vp/Vn y clasificación ASCE 41-17 §10.3 condiciones i-iv
    - Banderas de detallado deficiente

Referencias:
    ACI 318-19 §22.5.5          Vc concreto
    NSR-10 C.11.2.1.1           Vc = 0.17·λ·√f'c·b·d (compatible)
    Sezen & Moehle (2004)       "Shear Strength Model for Lightly RC Columns"
                                ASCE JSE 130(11), ec. 1-4.
    ASCE 41-17 §10.3.3          condiciones de clasificación
    Elwood & Moehle (2003)      drift de pérdida de capacidad por cortante
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import Literal

from .element_data import ElementData

FailureMode  = Literal["flexion", "flexion_cortante", "cortante"]
AsceCondition = Literal["i", "ii", "iii", "iv"]


@dataclass
class FailureModeResult:
    """Clasificación completa del modo de falla."""
    failure_mode:      FailureMode
    asce_condition:    AsceCondition
    Mp_kNm:            float
    Vp_kN:             float
    Vn_ACI_kN:         float
    Vn_SezenMoehle_kN: float
    Vn_kN:             float           # gobernante
    Vp_over_Vn:        float
    k_shear:           float           # factor Sezen-Moehle (1.0 → 0.7)
    flags:             list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


# ─────────────────────────────────────────────────────────────────────────────
# Vn por ACI 318-19 / NSR-10 C.11
# ─────────────────────────────────────────────────────────────────────────────
def compute_vn_aci(el: ElementData) -> float:
    """Resistencia nominal al cortante Vn = Vc + Vs según ACI 318-19.

    Unidades: resultado en kN.

        Vc = 0.17 · λ · √f'c · b · d                 (NSR-10 C.11.2.1.1)
        Factor axial para columnas (compresión):
            Vc *= (1 + N / (14·Ag·f'c/MPa))   → eq. 22.5.6.1 simplificada
        Vs = n_legs_h · A_tie · fyh · d / s          (ramas ∥ h en columna
                                                      resisten corte vertical)
    """
    fc  = el.materials.fc_MPa
    fyh = el.materials.fyh_MPa
    b   = el.geometry.b_m * 1000.0        # mm
    d   = el.geometry.d_mm
    s   = el.transverse.s_confined_mm     # Vn se evalúa con s_confined (crítico)

    # Vc base (SI) — unidades: MPa · mm² = N
    Vc = 0.17 * math.sqrt(fc) * b * d

    # Factor axial — compresión amplifica Vc (ACI 318-19 §22.5.6.1)
    if el.kind == "column":
        Ag_mm2 = el.geometry.Ag_mm2
        N_N = el.axial.N_grav_kN * 1000.0
        if N_N > 0 and Ag_mm2 > 0:
            factor = 1.0 + N_N / (14.0 * Ag_mm2)   # ACI ec. simplificada
            Vc *= factor
        elif N_N < 0 and Ag_mm2 > 0:
            # Tracción — penaliza (NSR-10 C.11.2.2.3)
            Vc *= max(0.0, 1.0 + N_N / (3.5 * Ag_mm2))

    # Vs — ramas en dirección "y" (vertical) resisten el corte transversal
    n_legs_cross = el.transverse.n_legs_h if el.kind == "column" else el.transverse.n_legs_h
    A_tie = el.transverse.A_tie_mm2
    Vs = n_legs_cross * A_tie * fyh * d / max(s, 1.0) if s > 0 else 0.0

    return (Vc + Vs) / 1000.0  # N → kN


# ─────────────────────────────────────────────────────────────────────────────
# Vn por Sezen-Moehle 2004 (edificios existentes, degrada con ductilidad)
# ─────────────────────────────────────────────────────────────────────────────
def _k_sezen_moehle(mu_disp: float) -> float:
    """Factor k en Sezen-Moehle 2004 — degrada con la demanda de ductilidad.

        k = 1.0        si μ ≤ 2
        k = 0.7        si μ ≥ 6
        lineal entre 2 y 6
    """
    if mu_disp <= 2.0:
        return 1.0
    if mu_disp >= 6.0:
        return 0.7
    return 1.0 - 0.075 * (mu_disp - 2.0)


def compute_vn_sezen_moehle(el: ElementData, mu_disp: float = 2.0) -> tuple[float, float]:
    """Modelo Sezen & Moehle (2004) para columnas de concreto con detallado
    deficiente. Devuelve (Vn_kN, k_shear).

        Vn = k · [ Vc + Vs ]
        Vc = (0.5·√f'c / (a/d)) · √(1 + N/(0.5·√f'c·Ag)) · 0.8·Ag
        Vs = n_legs_h · A_tie · fy · d / s · k

    Donde a/d = Ls/d (luz de cortante entre peralte efectivo).
    Las unidades: f'c, fy en MPa; Ag en mm²; Vn en N (se divide /1000 para kN).
    """
    fc  = el.materials.fc_MPa
    fyh = el.materials.fyh_MPa
    b   = el.geometry.b_m * 1000.0
    d   = el.geometry.d_mm
    s   = el.transverse.s_confined_mm
    Ag  = el.geometry.Ag_mm2
    Ls  = el.geometry.Ls_m * 1000.0    # mm
    N_N = max(0.0, el.axial.N_grav_kN) * 1000.0

    a_over_d = max(Ls / max(d, 1.0), 2.0)  # Sezen limita a a/d ∈ [2, 4]
    a_over_d = min(a_over_d, 4.0)

    sqrt_fc = math.sqrt(fc)
    Vc = (0.5 * sqrt_fc / a_over_d) * math.sqrt(1.0 + N_N / (0.5 * sqrt_fc * max(Ag, 1.0))) * 0.8 * Ag

    n_legs = el.transverse.n_legs_h
    A_tie  = el.transverse.A_tie_mm2
    Vs     = n_legs * A_tie * fyh * d / max(s, 1.0)

    k  = _k_sezen_moehle(mu_disp)
    Vn = k * (Vc + Vs)
    return Vn / 1000.0, k


# ─────────────────────────────────────────────────────────────────────────────
# Vp — cortante asociado a la plastificación por flexión
# ─────────────────────────────────────────────────────────────────────────────
def compute_vp(Mp_kNm: float, Ln_m: float) -> float:
    """Vp = 2·Mp/Ln (doble curvatura típica en pórticos sismo-resistentes).

    Para elemento en voladizo, el usuario debe ajustar llamando compute_vp(Mp, 2·L).
    """
    return 2.0 * Mp_kNm / max(Ln_m, 0.1)


# ─────────────────────────────────────────────────────────────────────────────
# Banderas de detallado deficiente
# ─────────────────────────────────────────────────────────────────────────────
def flag_deficient_detailing(el: ElementData) -> list[str]:
    """Lista banderas de detallado que afectan la rotación de capacidad.

    Códigos:
        HOOK_90          Gancho sísmico a 90° (no cumple DMO/DES).
        SPLICE_IN_HINGE  Empalme por traslape dentro de la zona de rótula.
        S_OVER_DB_GT_6   s/db > 6 → riesgo de pandeo de barras longitudinales.
        RHO_SH_LT_DMO    ρ_sh no cumple mínimo NSR-10 C.21 (DMO).
        RHO_SH_LT_DES    ρ_sh no cumple mínimo ACI 318 §18.7.5 (DES).
        LOW_CONFINEMENT  ρ_s volumétrica < 0.004 (poco confinamiento).
        HIGH_AXIAL       ν > 0.5 (columna muy cargada axialmente).
    """
    flags: list[str] = []

    if el.transverse.hook_type == "90deg":
        flags.append("HOOK_90")
    if el.detailing.splice_in_hinge:
        flags.append("SPLICE_IN_HINGE")
    if el.detailing.s_over_db_long > 6.0:
        flags.append("S_OVER_DB_GT_6")
    if not el.detailing.rho_sh_meets_DMO:
        flags.append("RHO_SH_LT_DMO")
    if not el.detailing.rho_sh_meets_DES:
        flags.append("RHO_SH_LT_DES")
    if el.transverse.rho_s_vol > 0 and el.transverse.rho_s_vol < 0.004:
        flags.append("LOW_CONFINEMENT")
    if el.kind == "column" and el.axial.nu > 0.5:
        flags.append("HIGH_AXIAL")

    return flags


# ─────────────────────────────────────────────────────────────────────────────
# Clasificación ASCE 41-17 §10.3.3
# ─────────────────────────────────────────────────────────────────────────────
def _classify(Vp_over_Vn: float, flags: list[str]) -> tuple[FailureMode, AsceCondition]:
    """Mapea Vp/Vn + banderas de detallado al esquema ASCE 41-17.

    Umbrales (ASCE 41-17 §10.3.3):
        Vp/Vn ≤ 0.6  → condición i   → flexión  (si detallado OK)
        0.6 < Vp/Vn ≤ 1.0  → condición ii  → flexión-cortante
        Vp/Vn > 1.0  → condición iii → cortante
        splice en zona rótula → condición iv (sobre-escribe)
    """
    if "SPLICE_IN_HINGE" in flags:
        return "flexion_cortante", "iv"

    detallado_deficiente = any(f in flags for f in
                                ("HOOK_90", "RHO_SH_LT_DMO", "S_OVER_DB_GT_6"))

    if Vp_over_Vn > 1.0:
        return "cortante", "iii"
    if Vp_over_Vn > 0.6 or detallado_deficiente:
        return "flexion_cortante", "ii"
    return "flexion", "i"


def compute_failure_mode(
    el:       ElementData,
    Mp_kNm:   float,
    mu_disp:  float = 2.0,
) -> FailureModeResult:
    """Punto de entrada principal — devuelve clasificación completa.

    Args:
        el:       ElementData del elemento.
        Mp_kNm:   capacidad a flexión plastica (de Fase 3 M-φ).
                  Si no se ha corrido M-φ todavía, usar aproximación: Mp ≈ 0.9·fy·As·d
                  (válido para vigas rectangulares subarmadas).
        mu_disp:  demanda de ductilidad asumida para Sezen-Moehle.
                  Default 2.0 → k=1.0. Se puede iterar en Fase 6 con el pushover real.
    """
    Vp              = compute_vp(Mp_kNm, el.geometry.Ln_m)
    Vn_aci          = compute_vn_aci(el)
    Vn_sm, k_shear  = compute_vn_sezen_moehle(el, mu_disp)
    flags           = flag_deficient_detailing(el)

    # Vn gobernante: para edificios nuevos con detallado DMO/DES, ACI es fiable.
    # Para edificios existentes con detallado deficiente, Sezen-Moehle degrada.
    if "HOOK_90" in flags or "RHO_SH_LT_DMO" in flags:
        Vn = min(Vn_aci, Vn_sm)
    else:
        Vn = Vn_aci

    ratio = Vp / Vn if Vn > 0 else float("inf")
    mode, cond = _classify(ratio, flags)

    return FailureModeResult(
        failure_mode      = mode,
        asce_condition    = cond,
        Mp_kNm            = Mp_kNm,
        Vp_kN             = Vp,
        Vn_ACI_kN         = Vn_aci,
        Vn_SezenMoehle_kN = Vn_sm,
        Vn_kN             = Vn,
        Vp_over_Vn        = ratio,
        k_shear           = k_shear,
        flags             = flags,
    )
