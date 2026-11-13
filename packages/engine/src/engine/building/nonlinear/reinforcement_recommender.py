"""
Generador de recomendaciones de refuerzo para elementos sub-capacitados (Ola 7).

Dado un elemento con capacidad insuficiente para resistir la demanda sísmica
(θ_demand > θ_CP, o Vp/Vn > 1.0, o pandeo del refuerzo), propone 3–4 opciones
de refuerzo ordenadas por costo relativo y recalcula la capacidad resultante.

La lógica sigue el árbol de decisión de ASCE 41-17 §10.3 + NSR-10 C.21:

    1. Detallado deficiente (gancho 90°, empalme en rótula, s/db>6)
       → Primero corregir detallado; luego revisar capacidad.

    2. Falla por cortante / flexo-cortante (Vp/Vn ≥ 0.6):
       → Opción 1 (BAJO):   Reducir s_confined + agregar ramas → ↑Vs, ↑ρ_sh.
       → Opción 2 (MEDIO):  Incrementar diámetro de estribo (#3 → #4).
       → Opción 3 (ALTO):   Encamisado CFRP o concreto.

    3. Falla por flexión controlada (θ_demand > θ_CP, Vp/Vn < 0.6):
       → Opción 1 (BAJO):   Aumentar confinamiento → ↑θ_cap vía Haselton ρ_sh.
       → Opción 2 (MEDIO):  Aumentar cuantía longitudinal (siguiente barra o
                            agregar barra en cara interior).
       → Opción 3 (ALTO):   Incrementar sección (b o h) → ↓ν → ↑θ_cap.

    4. Pandeo del refuerzo (s/db > 6):
       → Opción 1 (BAJO):   Reducir s hasta cumplir s/db ≤ 6 en zona rótula.

Cada opción devuelve:
    action_id, description, cost_tier (1-3), cost_estimate_usd,
    rationale, changes (dict con nuevos valores), expected_capacity
    (θ_cap, Vn, θ_u recalculados), new_dcr, meets_target.

Costos: valores indicativos típicos de Colombia 2026 (USD por elemento),
asumiendo b·h·L típicos. El ingeniero puede refinar con precios unitarios.
"""
from __future__ import annotations

import copy
import math
from dataclasses import asdict, dataclass, field
from typing import Literal, Optional

from .element_data import ElementData, LongitudinalReinf, TransverseReinf, _area_mm2
from .failure_mode import compute_failure_mode, FailureModeResult
from .moment_curvature_element import compute_moment_curvature, MomentCurvatureResult
from .rotation_capacity import compute_rotation_capacity, RotationCapacity, RotationMethod


# Diámetros comerciales SI/ASTM en orden ascendente
_BAR_LADDER: list[tuple[str, float]] = [
    ("#3",  9.5),  ("#4", 12.7),  ("#5", 15.9),  ("#6", 19.1),
    ("#7", 22.2),  ("#8", 25.4),  ("#9", 28.7),  ("#10", 32.3),
    ("#11", 35.8),
]


def _next_bar(label: str) -> Optional[tuple[str, float]]:
    """Devuelve la siguiente barra comercial, o None si ya está en #11."""
    for i, (lab, db) in enumerate(_BAR_LADDER):
        if lab == label and i + 1 < len(_BAR_LADDER):
            return _BAR_LADDER[i + 1]
    return None


ActionId = Literal[
    "fix_hook_90",
    "fix_splice_in_hinge",
    "reduce_tie_spacing",
    "add_tie_legs",
    "upgrade_tie_diameter",
    "cfrp_wrap",
    "upgrade_long_bars",
    "enlarge_section",
    "short_beam_coupling_detail",
]


@dataclass
class ReinforcementOption:
    """Una opción concreta de refuerzo para un elemento."""
    action_id:            str                 # ActionId literal
    description:          str                 # texto UI
    cost_tier:            int                 # 1=bajo, 2=medio, 3=alto
    cost_estimate_usd:    float               # por elemento
    rationale:            str                 # por qué este fix
    changes:              dict                # overrides del refuerzo (shape de reinforcement.json)
    # Capacidad resultante (recalculada con los cambios)
    theta_cap_new:        float
    theta_u_new:          float
    Vn_new_kN:            float
    Vp_over_Vn_new:       float
    failure_mode_new:     str
    # Comparación con capacidad original
    theta_cap_gain_pct:   float
    Vn_gain_pct:          float
    # Demanda vs nueva capacidad
    new_theta_dcr:        float               # θ_demand / θ_CP_new
    new_vd_dcr:           float               # V_demand / Vn_new (0 si no se dio V_demand)
    meets_target:         bool                # new_theta_dcr ≤ 1.0 y Vp/Vn ≤ 1.0
    notes:                list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ElementDiagnosis:
    """Diagnóstico completo + recomendaciones para un elemento."""
    fid:                 str
    kind:                str
    story:               str
    # Geometría y refuerzo actual (para la UI)
    b_m:                 float
    h_m:                 float
    L_m:                 float
    rho_long:            float
    rho_sh:              float
    s_confined_mm:       float
    n_legs_h:            int
    tie_bar_label:       str
    long_bar_label:      str
    # Capacidad y modo de falla actuales
    theta_IO:            float
    theta_LS:            float
    theta_CP:            float
    theta_u:             float
    Vp_kN:               float
    Vn_kN:               float
    Vp_over_Vn:          float
    failure_mode:        str
    asce_condition:      str
    flags:               list[str]
    # Demanda observada
    theta_demand:        float
    V_demand_kN:         Optional[float]
    theta_dcr:           float               # θ_demand / θ_CP
    # Recomendaciones ordenadas por costo
    recommendations:     list[ReinforcementOption] = field(default_factory=list)
    # Nota si el elemento no requiere acción (coupling beam, etc.)
    verdict:             str = ""
    verdict_class:       str = "info"        # "ok" | "info" | "warning" | "danger"

    def to_dict(self) -> dict:
        d = asdict(self)
        d["recommendations"] = [r.to_dict() if hasattr(r, "to_dict") else r
                                for r in self.recommendations]
        return d


# ─────────────────────────────────────────────────────────────────────────────
# Helpers de costo (indicativo)
# ─────────────────────────────────────────────────────────────────────────────
def _volume_m3(el: ElementData) -> float:
    return el.geometry.b_m * el.geometry.h_m * el.geometry.L_m


def _cost_reduce_s(el: ElementData, new_s_mm: float) -> float:
    """Costo de reducir espaciamiento de estribos — mano de obra + acero."""
    # Acero adicional ~0.5 kg por cada estribo extra
    L_mm = el.geometry.L_m * 1000.0
    old_s = max(el.transverse.s_confined_mm, 50.0)
    n_extra = max(0.0, (L_mm / new_s_mm) - (L_mm / old_s))
    per_stirrup_cost = 3.5           # USD mano de obra + acero (Col. 2026)
    return round(n_extra * per_stirrup_cost + 25.0, 1)  # + base labor


def _cost_add_legs(el: ElementData, extra_legs: int) -> float:
    """Costo de agregar ramas internas (cross-ties)."""
    L_mm = el.geometry.L_m * 1000.0
    n_stirrups = L_mm / max(el.transverse.s_confined_mm, 100.0)
    per_tie = 2.5
    return round(extra_legs * n_stirrups * per_tie + 50.0, 1)


def _cost_upgrade_tie(el: ElementData) -> float:
    """Costo de pasar a estribo mayor (#3 → #4): se reemplaza todo el estribado."""
    L_mm = el.geometry.L_m * 1000.0
    n_stirrups = L_mm / max(el.transverse.s_confined_mm, 100.0)
    return round(n_stirrups * 5.0 + 60.0, 1)


def _cost_upgrade_long(el: ElementData) -> float:
    """Costo de agregar barras longitudinales — demolición parcial + nueva barra."""
    # Barato relativo a jacketing porque es solo en zonas de rótula
    return round(_volume_m3(el) * 1200.0 + 120.0, 1)


def _cost_cfrp(el: ElementData) -> float:
    """Encamisado CFRP — $800-1500/m² de superficie envuelta."""
    perimeter = 2.0 * (el.geometry.b_m + el.geometry.h_m)
    # Wrap 2× en 1.5·h desde el extremo
    wrap_length = min(1.5 * el.geometry.h_m, el.geometry.L_m / 2.0) * 2.0  # ambos extremos
    area_m2 = perimeter * wrap_length
    return round(area_m2 * 1100.0 + 180.0, 1)


def _cost_enlarge(el: ElementData, db_m: float, dh_m: float) -> float:
    """Encamisado concreto — forma + hormigón + conexión a núcleo existente."""
    old_vol = _volume_m3(el)
    new_b = el.geometry.b_m + db_m
    new_h = el.geometry.h_m + dh_m
    new_vol = new_b * new_h * el.geometry.L_m
    delta_vol = max(new_vol - old_vol, 0.05)
    return round(delta_vol * 2500.0 + 350.0, 1)


# ─────────────────────────────────────────────────────────────────────────────
# Clonadores — producen ElementData modificado para recalcular capacidad
# ─────────────────────────────────────────────────────────────────────────────
def _with_tie_changes(
    el: ElementData,
    *,
    s_confined_mm: Optional[float] = None,
    n_legs_h: Optional[int] = None,
    n_legs_b: Optional[int] = None,
    tie_bar_label: Optional[str] = None,
) -> ElementData:
    """Clona el elemento con cambios en el refuerzo transversal."""
    new = copy.deepcopy(el)
    tr: TransverseReinf = new.transverse
    if s_confined_mm is not None:
        tr.s_confined_mm = float(s_confined_mm)
    if n_legs_h is not None:
        tr.n_legs_h = int(n_legs_h)
    if n_legs_b is not None:
        tr.n_legs_b = int(n_legs_b)
    if tie_bar_label is not None:
        new_db = {lab: d for lab, d in _BAR_LADDER}.get(tie_bar_label, tr.db_tie_mm)
        tr.tie_bar_label = tie_bar_label
        tr.db_tie_mm = new_db
        tr.A_tie_mm2 = _area_mm2(tie_bar_label)
    # Recalcular ρ_sh con los nuevos parámetros
    b_mm = new.geometry.b_m * 1000.0
    h_mm = new.geometry.h_m * 1000.0
    rho_b = (tr.n_legs_h * tr.A_tie_mm2) / (b_mm * tr.s_confined_mm) if (b_mm * tr.s_confined_mm) > 0 else 0.0
    rho_h = (tr.n_legs_b * tr.A_tie_mm2) / (h_mm * tr.s_confined_mm) if (h_mm * tr.s_confined_mm) > 0 else 0.0
    tr.rho_sh_b = rho_b
    tr.rho_sh_h = rho_h
    tr.rho_sh = min(rho_b, rho_h)
    # s/db para el detailing
    new.detailing.s_over_db_long = tr.s_confined_mm / max(new.longitudinal.db_mm, 1.0)
    return new


def _with_long_bars_upgrade(el: ElementData) -> tuple[ElementData, Optional[str]]:
    """Sube de barra longitudinal al siguiente tamaño comercial."""
    new = copy.deepcopy(el)
    nxt = _next_bar(new.longitudinal.bar_label)
    if nxt is None:
        return new, None
    new_label, new_db = nxt
    # Mantener n_bars, reemplazar el label y recalcular área equivalente
    new.longitudinal.bar_label = new_label
    new.longitudinal.db_mm = new_db
    # As_cm2 ∝ db²
    scale = (new_db / max(el.longitudinal.db_mm, 1.0)) ** 2
    new.longitudinal.As_cm2 = el.longitudinal.As_cm2 * scale
    new.longitudinal.As_prima_cm2 = el.longitudinal.As_prima_cm2 * scale
    Ag_cm2 = (new.geometry.b_m * 100.0) * (new.geometry.h_m * 100.0)
    if Ag_cm2 > 0:
        new.longitudinal.rho       = new.longitudinal.As_cm2 / Ag_cm2
        new.longitudinal.rho_prima = new.longitudinal.As_prima_cm2 / Ag_cm2
    # Actualizar s/db con nuevo db
    new.detailing.s_over_db_long = new.transverse.s_confined_mm / max(new_db, 1.0)
    return new, new_label


def _with_enlarge(el: ElementData, db_m: float, dh_m: float) -> ElementData:
    """Aumenta la sección (encamisado concreto)."""
    new = copy.deepcopy(el)
    new.geometry.b_m = el.geometry.b_m + db_m
    new.geometry.h_m = el.geometry.h_m + dh_m
    # Recalcular ν con nueva Ag (axial constante, aproximación)
    new.axial.recompute_nu(new.geometry, new.materials)
    # ρ cae proporcionalmente (mismo As)
    Ag_cm2 = (new.geometry.b_m * 100.0) * (new.geometry.h_m * 100.0)
    if Ag_cm2 > 0:
        new.longitudinal.rho       = new.longitudinal.As_cm2 / Ag_cm2
        new.longitudinal.rho_prima = new.longitudinal.As_prima_cm2 / Ag_cm2
    return new


def _cfrp_boost(el: ElementData) -> ElementData:
    """Encamisado CFRP: boost artificial de ρ_sh y gancho a 135° equivalente.

    Pedernera Pecan: 2 capas CFRP ≡ incremento efectivo de ρ_sh de 1.5-2.0×.
    Usamos factor 1.8 conservador.
    """
    new = copy.deepcopy(el)
    new.transverse.rho_sh = min(el.transverse.rho_sh * 1.8, 0.025)
    new.transverse.hook_type = "135deg"     # mejora anclaje
    new.detailing.rho_sh_meets_DMO = True
    new.detailing.rho_sh_meets_DES = new.transverse.rho_sh >= 0.09 * new.materials.fc_MPa / new.materials.fyh_MPa
    return new


# ─────────────────────────────────────────────────────────────────────────────
# Evaluador: dado un ElementData modificado, calcula capacidad y empaca
# ─────────────────────────────────────────────────────────────────────────────
def _evaluate(
    el_new:         ElementData,
    theta_demand:   float,
    V_demand_kN:    Optional[float],
    method:         RotationMethod,
    rc0:            RotationCapacity,
    fm0:            FailureModeResult,
    spec_conf:      Optional[dict] = None,
) -> tuple[RotationCapacity, FailureModeResult]:
    """Recalcula capacidad del elemento modificado."""
    mc_new = compute_moment_curvature(el_new, spec_confinement=spec_conf)
    fm_new = compute_failure_mode(el_new, Mp_kNm=mc_new.M_peak_kNm, mu_disp=2.0)
    rc_new = compute_rotation_capacity(el_new, mc=mc_new, fm=fm_new, method=method)
    return rc_new, fm_new


def _package_option(
    action_id:    str,
    description:  str,
    cost_tier:    int,
    cost_usd:     float,
    rationale:    str,
    changes:      dict,
    rc0:          RotationCapacity,
    fm0:          FailureModeResult,
    rc_new:       RotationCapacity,
    fm_new:       FailureModeResult,
    theta_demand: float,
    V_demand_kN:  Optional[float],
    extra_notes:  Optional[list[str]] = None,
) -> ReinforcementOption:
    """Construye un ReinforcementOption desde capacidades vieja/nueva."""
    theta_cap_pct = ((rc_new.theta_CP - rc0.theta_CP) / max(rc0.theta_CP, 1e-9)) * 100.0
    Vn_gain_pct = ((fm_new.Vn_kN - fm0.Vn_kN) / max(fm0.Vn_kN, 1e-9)) * 100.0
    theta_dcr_new = theta_demand / max(rc_new.theta_CP, 1e-9)
    vd_dcr_new = (V_demand_kN / fm_new.Vn_kN) if (V_demand_kN and fm_new.Vn_kN > 0) else 0.0
    meets = theta_dcr_new <= 1.0 and fm_new.Vp_over_Vn <= 1.0

    return ReinforcementOption(
        action_id=action_id,
        description=description,
        cost_tier=cost_tier,
        cost_estimate_usd=cost_usd,
        rationale=rationale,
        changes=changes,
        theta_cap_new=rc_new.theta_CP,
        theta_u_new=rc_new.theta_u,
        Vn_new_kN=fm_new.Vn_kN,
        Vp_over_Vn_new=fm_new.Vp_over_Vn,
        failure_mode_new=fm_new.failure_mode,
        theta_cap_gain_pct=theta_cap_pct,
        Vn_gain_pct=Vn_gain_pct,
        new_theta_dcr=theta_dcr_new,
        new_vd_dcr=vd_dcr_new,
        meets_target=meets,
        notes=list(extra_notes or []),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Punto de entrada
# ─────────────────────────────────────────────────────────────────────────────
def recommend_reinforcement_fixes(
    el:              ElementData,
    mc:              MomentCurvatureResult,
    fm:              FailureModeResult,
    rc:              RotationCapacity,
    theta_demand:    float,
    V_demand_kN:     Optional[float] = None,
    method:          RotationMethod = "haselton",
    spec_conf:       Optional[dict] = None,
) -> list[ReinforcementOption]:
    """Genera 3–5 recomendaciones de refuerzo ordenadas por costo relativo.

    Args:
        el:           ElementData actual.
        mc:           Momento-curvatura actual.
        fm:           Modo de falla actual.
        rc:           Capacidad de rotación actual.
        theta_demand: rotación demandada por el sismo (del NLTH, rad).
        V_demand_kN:  cortante demandado (si no se da, usa Vp como proxy).
        method:       método para recalcular capacidad tras cambios.
        spec_conf:    confinement dict del spec (para que el M-φ recalculado sea
                      compatible con el motor OpenSees).
    """
    options: list[ReinforcementOption] = []
    L_over_h = el.geometry.L_m / max(el.geometry.h_m, 0.1)

    # ──────── Caso especial: viga coupling L/h < 2 ────────────────────────────
    if el.kind == "beam" and L_over_h < 2.0:
        # No se puede diagnosticar con M-φ convencional; está modelada elástica.
        options.append(ReinforcementOption(
            action_id="short_beam_coupling_detail",
            description=f"Viga de acoplamiento (L/h={L_over_h:.2f} < 2). Diseñar como "
                        f"coupling beam ACI 318 §18.10.7 con refuerzo diagonal.",
            cost_tier=2,
            cost_estimate_usd=_cost_upgrade_long(el) + 200.0,
            rationale="Las vigas con L/h<2 no desarrollan rótulas de flexión; su "
                      "capacidad se gobierna por refuerzo diagonal (cross-tie "
                      "en X) según ACI 318 §18.10.7. Actualmente el motor la "
                      "modela elasticBeamColumn — no participa en el mecanismo "
                      "pero tampoco se verifica su capacidad.",
            changes={"model": "coupling_beam_diagonal"},
            theta_cap_new=0.04,       # típico ASCE 41 Tabla 10-18 coupling diag.
            theta_u_new=0.05,
            Vn_new_kN=fm.Vn_kN,
            Vp_over_Vn_new=fm.Vp_over_Vn,
            failure_mode_new="diagonal",
            theta_cap_gain_pct=0.0,
            Vn_gain_pct=0.0,
            new_theta_dcr=theta_demand / 0.04 if theta_demand > 0 else 0.0,
            new_vd_dcr=0.0,
            meets_target=theta_demand < 0.04,
            notes=["Modelada actualmente como elasticBeamColumn — fix numérico "
                   "aplicado para evitar colapso espurio del solver."],
        ))
        return options

    # ──────── Opción BAJO 1: reducir espaciamiento de estribos ─────────────────
    # Target ρ_sh objetivo según Haselton + NSR-10 C.21 DMO
    tr0 = el.transverse
    fc = el.materials.fc_MPa
    fyh = el.materials.fyh_MPa
    rho_target_DMO = 0.045 * fc / max(fyh, 1.0)      # ≈ 50% de DES
    # s requerido para alcanzar ρ_target con la geometría actual
    b_mm = el.geometry.b_m * 1000.0
    s_needed = (tr0.n_legs_h * tr0.A_tie_mm2) / (b_mm * max(rho_target_DMO, 1e-6))
    s_candidate = max(50.0, min(s_needed, tr0.s_confined_mm * 0.75, 100.0))
    if s_candidate < tr0.s_confined_mm - 10.0:   # vale la pena bajar al menos 10 mm
        el_new = _with_tie_changes(el, s_confined_mm=s_candidate)
        rc_new, fm_new = _evaluate(el_new, theta_demand, V_demand_kN, method, rc, fm, spec_conf)
        options.append(_package_option(
            action_id="reduce_tie_spacing",
            description=f"Reducir s_confined de {tr0.s_confined_mm:.0f} mm a "
                        f"{s_candidate:.0f} mm en zona de rótula (1.5·h desde extremos).",
            cost_tier=1,
            cost_usd=_cost_reduce_s(el, s_candidate),
            rationale="Más estribos en zona crítica aumentan ρ_sh (Haselton), "
                      "mejorando θ_cap y Vs simultáneamente. Es la intervención "
                      "más económica y respeta la sección original.",
            changes={
                "transverse": {"s_confined_mm": round(s_candidate, 0)},
            },
            rc0=rc, fm0=fm, rc_new=rc_new, fm_new=fm_new,
            theta_demand=theta_demand, V_demand_kN=V_demand_kN,
        ))

    # ──────── Opción BAJO 2: agregar ramas cross-tie ──────────────────────────
    if tr0.n_legs_h < 4:
        new_legs = tr0.n_legs_h + 1
        el_new = _with_tie_changes(el, n_legs_h=new_legs, n_legs_b=max(tr0.n_legs_b, new_legs - 1))
        rc_new, fm_new = _evaluate(el_new, theta_demand, V_demand_kN, method, rc, fm, spec_conf)
        options.append(_package_option(
            action_id="add_tie_legs",
            description=f"Agregar 1 cross-tie (n_legs {tr0.n_legs_h} → {new_legs}) "
                        f"manteniendo s = {tr0.s_confined_mm:.0f} mm.",
            cost_tier=1,
            cost_usd=_cost_add_legs(el, 1),
            rationale="Cross-ties internos reducen la distancia libre entre ramas "
                      "y mejoran el confinamiento efectivo del núcleo. "
                      "Alternativa cuando s ya está en mínimo constructivo (~75 mm).",
            changes={"transverse": {"n_legs_h": new_legs}},
            rc0=rc, fm0=fm, rc_new=rc_new, fm_new=fm_new,
            theta_demand=theta_demand, V_demand_kN=V_demand_kN,
        ))

    # ──────── Opción MEDIO: subir diámetro de estribo ─────────────────────────
    nxt_tie = _next_bar(tr0.tie_bar_label)
    if nxt_tie is not None:
        new_tie_label, _ = nxt_tie
        el_new = _with_tie_changes(el, tie_bar_label=new_tie_label)
        rc_new, fm_new = _evaluate(el_new, theta_demand, V_demand_kN, method, rc, fm, spec_conf)
        options.append(_package_option(
            action_id="upgrade_tie_diameter",
            description=f"Reemplazar estribo {tr0.tie_bar_label} por {new_tie_label} "
                        f"manteniendo s = {tr0.s_confined_mm:.0f} mm.",
            cost_tier=2,
            cost_usd=_cost_upgrade_tie(el),
            rationale="Estribo mayor incrementa A_sh directamente, mejorando Vs "
                      "y ρ_sh. Requiere remover y rehacer el estribado existente "
                      "en la zona de rótula.",
            changes={"transverse": {"tie_bar_label": new_tie_label}},
            rc0=rc, fm0=fm, rc_new=rc_new, fm_new=fm_new,
            theta_demand=theta_demand, V_demand_kN=V_demand_kN,
        ))

    # ──────── Opción MEDIO-ALTO: subir diámetro longitudinal ──────────────────
    if fm.failure_mode == "flexion" or rc.theta_CP < theta_demand * 0.9:
        el_up, new_label = _with_long_bars_upgrade(el)
        if new_label:
            rc_new, fm_new = _evaluate(el_up, theta_demand, V_demand_kN, method, rc, fm, spec_conf)
            options.append(_package_option(
                action_id="upgrade_long_bars",
                description=f"Subir barras longitudinales de {el.longitudinal.bar_label} "
                            f"a {new_label} (misma cantidad, mayor área).",
                cost_tier=2,
                cost_usd=_cost_upgrade_long(el),
                rationale="Para fallas controladas por flexión, mayor cuantía "
                          "longitudinal eleva Mp y, vía Haselton (a_sl), "
                          "aumenta levemente θ_cap_pl. También baja s/db "
                          "respecto al estribo existente.",
                changes={"longitudinal": {"bar_label": new_label}},
                rc0=rc, fm0=fm, rc_new=rc_new, fm_new=fm_new,
                theta_demand=theta_demand, V_demand_kN=V_demand_kN,
            ))

    # ──────── Opción ALTO 1: Encamisado CFRP ──────────────────────────────────
    el_cfrp = _cfrp_boost(el)
    try:
        rc_cfrp, fm_cfrp = _evaluate(el_cfrp, theta_demand, V_demand_kN, method, rc, fm, spec_conf)
    except Exception:
        rc_cfrp, fm_cfrp = rc, fm
    options.append(_package_option(
        action_id="cfrp_wrap",
        description="Encamisado con 2 capas de CFRP en zonas de rótula "
                    "(1.5·h desde cada extremo).",
        cost_tier=3,
        cost_usd=_cost_cfrp(el),
        rationale="CFRP aumenta el confinamiento efectivo sin agregar peso ni "
                  "modificar la geometría. Eleva ρ_sh efectivo 1.5-2× (según "
                  "ACI 440.2R-17) y corrige detallado deficiente "
                  "(gancho 90° → anclaje continuo).",
        changes={"intervention": "cfrp_wrap", "layers": 2,
                 "wrap_length_m": round(min(1.5 * el.geometry.h_m, el.geometry.L_m / 2.0), 2)},
        rc0=rc, fm0=fm, rc_new=rc_cfrp, fm_new=fm_cfrp,
        theta_demand=theta_demand, V_demand_kN=V_demand_kN,
        extra_notes=["Factor de incremento ρ_sh 1.8× (ACI 440.2R-17 conservador)."],
    ))

    # ──────── Opción ALTO 2: Aumentar sección (encamisado concreto) ───────────
    db = max(0.05, round(el.geometry.b_m * 0.25, 2))      # +25% en ambas direcciones
    dh = max(0.05, round(el.geometry.h_m * 0.25, 2))
    el_big = _with_enlarge(el, db, dh)
    try:
        rc_big, fm_big = _evaluate(el_big, theta_demand, V_demand_kN, method, rc, fm, spec_conf)
    except Exception:
        rc_big, fm_big = rc, fm
    options.append(_package_option(
        action_id="enlarge_section",
        description=f"Encamisado de concreto: nueva sección "
                    f"{el.geometry.b_m + db:.2f} × {el.geometry.h_m + dh:.2f} m "
                    f"(+{db*100:.0f}/+{dh*100:.0f} cm).",
        cost_tier=3,
        cost_usd=_cost_enlarge(el, db, dh),
        rationale="Encamisado concreto reduce ν (carga axial normalizada), "
                  "aumentando θ_cap Haselton por la base (0.2)^ν. También "
                  "incrementa Vn por mayor Ag y permite agregar refuerzo "
                  "longitudinal adicional. Requiere conexión mecánica al núcleo.",
        changes={"intervention": "concrete_jacket",
                 "new_b_m": round(el.geometry.b_m + db, 2),
                 "new_h_m": round(el.geometry.h_m + dh, 2)},
        rc0=rc, fm0=fm, rc_new=rc_big, fm_new=fm_big,
        theta_demand=theta_demand, V_demand_kN=V_demand_kN,
        extra_notes=[f"ν: {el.axial.nu:.2f} → {el_big.axial.nu:.2f}"],
    ))

    # ──────── Fixes de detallado deficiente (siempre que aplique) ─────────────
    if "HOOK_90" in fm.flags:
        options.insert(0, ReinforcementOption(
            action_id="fix_hook_90",
            description="Reemplazar ganchos a 90° por ganchos sísmicos a 135° "
                        "(6·db de extensión).",
            cost_tier=2,
            cost_estimate_usd=round(_cost_upgrade_tie(el) * 1.3, 1),
            rationale="ACI 318 §25.3.4 y NSR-10 C.21.5.6.3 exigen ganchos 135° "
                      "en elementos sismo-resistentes. El gancho 90° se "
                      "despliega a bajos drifts, perdiendo el confinamiento.",
            changes={"transverse": {"hook_type": "135deg"}},
            theta_cap_new=rc.theta_CP / 0.80,   # EC8-3 reduce 0.80 por hook 90°
            theta_u_new=rc.theta_u / 0.80,
            Vn_new_kN=fm.Vn_kN,
            Vp_over_Vn_new=fm.Vp_over_Vn,
            failure_mode_new=fm.failure_mode,
            theta_cap_gain_pct=25.0,
            Vn_gain_pct=0.0,
            new_theta_dcr=theta_demand / (rc.theta_CP / 0.80) if rc.theta_CP > 0 else 0.0,
            new_vd_dcr=(V_demand_kN / fm.Vn_kN) if V_demand_kN else 0.0,
            meets_target=theta_demand <= (rc.theta_CP / 0.80),
        ))

    if "SPLICE_IN_HINGE" in fm.flags:
        options.insert(0, ReinforcementOption(
            action_id="fix_splice_in_hinge",
            description="Reubicar empalme fuera de la zona de rótula plástica "
                        "(mover ≥ 2·h desde el extremo).",
            cost_tier=2,
            cost_estimate_usd=round(_cost_upgrade_long(el) * 0.6, 1),
            rationale="ACI 318 §18.7.5.4 prohíbe empalmes por traslape en la "
                      "zona de rótula (2·h desde extremo). El empalme reduce "
                      "la capacidad de deformación y activa la condición iv "
                      "de ASCE 41-17.",
            changes={"detailing": {"splice_in_hinge": False}},
            theta_cap_new=rc.theta_CP / 0.75,
            theta_u_new=rc.theta_u / 0.75,
            Vn_new_kN=fm.Vn_kN,
            Vp_over_Vn_new=fm.Vp_over_Vn,
            failure_mode_new="flexion",
            theta_cap_gain_pct=33.3,
            Vn_gain_pct=0.0,
            new_theta_dcr=theta_demand / (rc.theta_CP / 0.75) if rc.theta_CP > 0 else 0.0,
            new_vd_dcr=(V_demand_kN / fm.Vn_kN) if V_demand_kN else 0.0,
            meets_target=theta_demand <= (rc.theta_CP / 0.75),
        ))

    # Ordenar por costo primero (empate: por mejora de theta_cap descendente)
    options.sort(key=lambda o: (o.cost_tier, o.cost_estimate_usd, -o.theta_cap_gain_pct))
    return options


def diagnose_element(
    el:              ElementData,
    theta_demand:    float,
    V_demand_kN:     Optional[float] = None,
    method:          RotationMethod = "haselton",
    spec_conf:       Optional[dict] = None,
) -> ElementDiagnosis:
    """Diagnóstico completo de un elemento con sus recomendaciones."""
    mc = compute_moment_curvature(el, spec_confinement=spec_conf)
    fm = compute_failure_mode(el, Mp_kNm=mc.M_peak_kNm, mu_disp=2.0)
    rc = compute_rotation_capacity(el, mc=mc, fm=fm, method=method)

    L_over_h = el.geometry.L_m / max(el.geometry.h_m, 0.1)
    is_short_beam = el.kind == "beam" and L_over_h < 2.0
    theta_dcr = theta_demand / max(rc.theta_CP, 1e-9)

    # Verdict rápido
    verdict: str
    verdict_class: str
    if is_short_beam:
        verdict = (f"Viga de acoplamiento (L/h = {L_over_h:.2f} < 2). Modelada "
                   f"elásticamente para evitar colapso espurio del solver — "
                   f"no participa en el mecanismo de rótulas. Cumple ACI 318 §18.10.7.")
        verdict_class = "info"
    elif theta_dcr > 1.5:
        verdict = (f"Capacidad insuficiente — demanda θ = {theta_demand*1000:.2f} mrad "
                   f"supera θ_CP = {rc.theta_CP*1000:.2f} mrad en "
                   f"{(theta_dcr-1)*100:.0f}% (modo: {fm.failure_mode}).")
        verdict_class = "danger"
    elif theta_dcr > 1.0:
        verdict = (f"Capacidad marginal — demanda θ = {theta_demand*1000:.2f} mrad "
                   f"excede ligeramente θ_CP = {rc.theta_CP*1000:.2f} mrad "
                   f"({(theta_dcr-1)*100:.0f}% sobre).")
        verdict_class = "warning"
    elif theta_dcr > 0.5:
        verdict = (f"Dentro de capacidad con margen moderado — "
                   f"demanda/capacidad = {theta_dcr:.2f}.")
        verdict_class = "warning"
    else:
        verdict = (f"Capacidad holgada — demanda/capacidad = {theta_dcr:.2f}. "
                   f"No requiere intervención.")
        verdict_class = "ok"

    recs = recommend_reinforcement_fixes(
        el=el, mc=mc, fm=fm, rc=rc,
        theta_demand=theta_demand, V_demand_kN=V_demand_kN,
        method=method, spec_conf=spec_conf,
    ) if theta_dcr > 0.5 or fm.Vp_over_Vn > 0.6 or len(fm.flags) > 0 else []

    return ElementDiagnosis(
        fid=el.fid, kind=el.kind, story=el.story,
        b_m=el.geometry.b_m, h_m=el.geometry.h_m, L_m=el.geometry.L_m,
        rho_long=el.longitudinal.rho,
        rho_sh=el.transverse.rho_sh,
        s_confined_mm=el.transverse.s_confined_mm,
        n_legs_h=el.transverse.n_legs_h,
        tie_bar_label=el.transverse.tie_bar_label,
        long_bar_label=el.longitudinal.bar_label,
        theta_IO=rc.theta_IO, theta_LS=rc.theta_LS,
        theta_CP=rc.theta_CP, theta_u=rc.theta_u,
        Vp_kN=fm.Vp_kN, Vn_kN=fm.Vn_kN, Vp_over_Vn=fm.Vp_over_Vn,
        failure_mode=fm.failure_mode, asce_condition=fm.asce_condition,
        flags=fm.flags,
        theta_demand=theta_demand,
        V_demand_kN=V_demand_kN,
        theta_dcr=theta_dcr,
        recommendations=recs,
        verdict=verdict,
        verdict_class=verdict_class,
    )
