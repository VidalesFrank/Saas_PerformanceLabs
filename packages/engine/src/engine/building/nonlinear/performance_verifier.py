"""
Performance-based design — verificador de capacidad por elemento (Ola 8).

Diferenciador vs Perform-3D / SAP-NL: en lugar de que el ingeniero itere
manualmente el pushover/NLTH hasta que todos los elementos cumplan θ_target,
este módulo auto-ajusta el refuerzo transversal y longitudinal (dentro de
restricciones NSR-10 C.21 y ACI 318 §18) para alcanzar la capacidad de rotación
exigida por el nivel de desempeño seleccionado.

Flujo típico:
    1. NSR-10 produce refuerzo inicial (design_columns / design_beams).
    2. verify_performance_capacity() recorre todos los elementos, compara
       θ_CP (Haselton) vs θ_target (función del nivel de desempeño y zona).
    3. Si θ_CP < θ_target, aplica ajustes incrementales hasta cumplir:
            s_confined ↓    (en pasos de 25 mm, mínimo 50 mm)
            n_legs_h ↑      (hasta 4)
            tie_bar  ↑      (siguiente comercial)
            long_bar ↑      (si falla por flexión y ρ ≤ 0.04)
    4. Produce reporte con n elementos ajustados + cambios por fid.

El pipeline *no toca* OpenSees — es un post-proceso sobre el spec.

Objetivos típicos por nivel de desempeño (ASCE 41-17 §10.3.3, asumiendo que el
usuario quiere "Life Safety" como mínimo):

    Nivel                        θ_target (columna)   θ_target (viga)
    ──────────────────────────  ──────────────────   ──────────────
    IO — Immediate Occupancy      0.005 rad            0.010 rad
    LS — Life Safety              0.015 rad            0.020 rad
    CP — Collapse Prevention      0.025 rad            0.035 rad

Si Frank define un espectro NSR-10 Aa>0.3 g (zona de amenaza alta), el default
sube automáticamente a LS como piso.
"""
from __future__ import annotations

import copy
from dataclasses import asdict, dataclass, field
from typing import Literal, Optional

from .element_data import ElementData, elements_from_spec
from .failure_mode import compute_failure_mode
from .moment_curvature_element import compute_moment_curvature
from .rotation_capacity import compute_rotation_capacity, RotationMethod
from .reinforcement_recommender import (
    _with_tie_changes, _with_long_bars_upgrade, _next_bar,
)


PerformanceLevel = Literal["IO", "LS", "CP"]


# Umbrales por defecto (ASCE 41-17 §10.3.3, concreto reforzado DMO/DES típico)
_DEFAULT_TARGETS: dict[str, dict[PerformanceLevel, float]] = {
    "column": {"IO": 0.005, "LS": 0.015, "CP": 0.025},
    "beam":   {"IO": 0.010, "LS": 0.020, "CP": 0.035},
}


@dataclass
class ElementVerification:
    """Resultado de verificación de UN elemento."""
    fid:                  str
    kind:                 str
    story:                str
    performance_level:    str
    theta_target:         float
    theta_CP_initial:     float
    theta_CP_final:       float
    meets_target_initial: bool
    meets_target_final:   bool
    iterations:           int
    adjustments:          list[str]       # historia legible: ["s: 150→100", "n_legs: 2→3"]
    changes:              dict            # payload para reinforcement.json
    failure_mode_final:   str
    Vn_final_kN:          float
    Vp_over_Vn_final:     float
    # Si no se pudo cumplir, diagnóstico
    unmet_reason:         Optional[str] = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class PerformanceVerificationResult:
    """Reporte completo del verificador."""
    performance_level:   str
    theta_targets:       dict               # {"column": x, "beam": y}
    method:              str                # haselton / ec8_3 / mecanico
    n_elements:          int
    n_initial_pass:      int                # cumplían antes
    n_adjusted:          int                # ajustados y ahora cumplen
    n_unmet:             int                # siguen sin cumplir
    max_iterations:      int
    elements:            list[ElementVerification] = field(default_factory=list)
    summary_adjustments: dict[str, int]      = field(default_factory=dict)
    warnings:            list[str]           = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "performance_level":   self.performance_level,
            "theta_targets":       self.theta_targets,
            "method":              self.method,
            "n_elements":          self.n_elements,
            "n_initial_pass":      self.n_initial_pass,
            "n_adjusted":          self.n_adjusted,
            "n_unmet":             self.n_unmet,
            "max_iterations":      self.max_iterations,
            "elements":            [e.to_dict() for e in self.elements],
            "summary_adjustments": self.summary_adjustments,
            "warnings":            self.warnings,
        }

    def by_fid(self) -> dict[str, ElementVerification]:
        return {e.fid: e for e in self.elements}


# ─────────────────────────────────────────────────────────────────────────────
# Núcleo de iteración por elemento
# ─────────────────────────────────────────────────────────────────────────────
def _compute_capacity(
    el:        ElementData,
    method:    RotationMethod,
    spec_conf: Optional[dict] = None,
) -> tuple[float, float, float, str]:
    """Devuelve (theta_CP, Vn, Vp_over_Vn, failure_mode)."""
    mc = compute_moment_curvature(el, spec_confinement=spec_conf)
    fm = compute_failure_mode(el, Mp_kNm=mc.M_peak_kNm, mu_disp=2.0)
    rc = compute_rotation_capacity(el, mc=mc, fm=fm, method=method)
    return rc.theta_CP, fm.Vn_kN, fm.Vp_over_Vn, fm.failure_mode


def _iterate_element(
    el_initial:  ElementData,
    theta_target: float,
    method:      RotationMethod,
    spec_conf:   Optional[dict],
    max_iters:   int = 6,
) -> tuple[ElementData, list[str], dict, bool, int]:
    """Intenta llegar a theta_target vía ajustes incrementales.

    Returns (el_final, adjustments_log, changes_dict, meets_target, n_iters).

    Estrategia:
       1. Reducir s_confined de a 25 mm (min 50 mm).
       2. Agregar un leg (n_legs_h, hasta 4).
       3. Subir diámetro estribo (siguiente comercial).
       4. Si failure_mode = flexión y aún no cumple, subir diámetro longitudinal.
    """
    el = copy.deepcopy(el_initial)
    adjustments: list[str] = []
    changes: dict = {}
    n_iters = 0

    theta_cp, _Vn, _vp_vn, fmode = _compute_capacity(el, method, spec_conf)
    if theta_cp >= theta_target:
        return el, [], {}, True, 0

    # Step 1: reducir s_confined
    while el.transverse.s_confined_mm > 75.0 and n_iters < max_iters:
        new_s = max(50.0, el.transverse.s_confined_mm - 25.0)
        el_try = _with_tie_changes(el, s_confined_mm=new_s)
        new_cp, _, _, _ = _compute_capacity(el_try, method, spec_conf)
        adjustments.append(f"s: {el.transverse.s_confined_mm:.0f}→{new_s:.0f} mm (θ_CP {theta_cp*1000:.2f}→{new_cp*1000:.2f} mrad)")
        changes.setdefault("transverse", {})["s_confined_mm"] = new_s
        el = el_try
        theta_cp = new_cp
        n_iters += 1
        if theta_cp >= theta_target:
            return el, adjustments, changes, True, n_iters

    # Step 2: agregar legs
    while el.transverse.n_legs_h < 4 and n_iters < max_iters:
        new_legs = el.transverse.n_legs_h + 1
        el_try = _with_tie_changes(el, n_legs_h=new_legs,
                                   n_legs_b=max(el.transverse.n_legs_b, new_legs - 1))
        new_cp, _, _, _ = _compute_capacity(el_try, method, spec_conf)
        adjustments.append(f"n_legs: {el.transverse.n_legs_h}→{new_legs} (θ_CP {theta_cp*1000:.2f}→{new_cp*1000:.2f} mrad)")
        changes.setdefault("transverse", {})["n_legs_h"] = new_legs
        el = el_try
        theta_cp = new_cp
        n_iters += 1
        if theta_cp >= theta_target:
            return el, adjustments, changes, True, n_iters

    # Step 3: subir diámetro de estribo
    nxt = _next_bar(el.transverse.tie_bar_label)
    if nxt is not None and n_iters < max_iters:
        new_label, _ = nxt
        el_try = _with_tie_changes(el, tie_bar_label=new_label)
        new_cp, _, _, _ = _compute_capacity(el_try, method, spec_conf)
        adjustments.append(f"estribo: {el.transverse.tie_bar_label}→{new_label} (θ_CP {theta_cp*1000:.2f}→{new_cp*1000:.2f} mrad)")
        changes.setdefault("transverse", {})["tie_bar_label"] = new_label
        el = el_try
        theta_cp = new_cp
        n_iters += 1
        if theta_cp >= theta_target:
            return el, adjustments, changes, True, n_iters

    # Step 4: subir diámetro longitudinal (si falla por flexión)
    if fmode in ("flexion", "flexion_cortante") and n_iters < max_iters:
        el_up, new_label = _with_long_bars_upgrade(el)
        if new_label and el_up.longitudinal.rho <= 0.04:
            new_cp, _, _, fmode_new = _compute_capacity(el_up, method, spec_conf)
            adjustments.append(f"long: {el.longitudinal.bar_label}→{new_label} (θ_CP {theta_cp*1000:.2f}→{new_cp*1000:.2f} mrad)")
            changes.setdefault("longitudinal", {})["bar_label"] = new_label
            el = el_up
            theta_cp = new_cp
            fmode = fmode_new
            n_iters += 1

    return el, adjustments, changes, theta_cp >= theta_target, n_iters


def _get_targets(
    performance_level: PerformanceLevel,
    overrides:         Optional[dict[str, float]] = None,
) -> dict[str, float]:
    """Devuelve {"column": θ_target_col, "beam": θ_target_beam}."""
    base = {k: v[performance_level] for k, v in _DEFAULT_TARGETS.items()}
    if overrides:
        for k, v in overrides.items():
            if k in base and v is not None:
                base[k] = float(v)
    return base


# ─────────────────────────────────────────────────────────────────────────────
# Punto de entrada
# ─────────────────────────────────────────────────────────────────────────────
def verify_performance_capacity(
    spec:              dict,
    performance_level: PerformanceLevel = "LS",
    theta_overrides:   Optional[dict[str, float]] = None,
    method:            RotationMethod = "haselton",
    axial_json:        Optional[dict] = None,
    observations:      Optional[dict[str, dict]] = None,
    max_iterations:    int = 6,
    skip_coupling_beams: bool = True,
) -> PerformanceVerificationResult:
    """Verifica y ajusta el refuerzo para cumplir θ_target en todos los elementos.

    Args:
        spec:                nonlinear_model.json como dict.
        performance_level:   IO | LS | CP (ASCE 41-17 §10.3.3).
        theta_overrides:     {"column": x, "beam": y} para sobrescribir defaults.
        method:              método de rotación (haselton default).
        axial_json / observations: como en elements_from_spec.
        max_iterations:      pasos máximos de ajuste por elemento.
        skip_coupling_beams: True → omite vigas L/h<2 (modeladas elásticas).
    """
    elements = elements_from_spec(spec, axial_json=axial_json, observations=observations)
    targets = _get_targets(performance_level, theta_overrides)
    verifications: list[ElementVerification] = []
    adjust_count: dict[str, int] = {}
    n_initial_pass = 0
    n_adjusted = 0
    n_unmet = 0
    warnings: list[str] = []

    for fid, el in elements.items():
        target = targets.get(el.kind, 0.02)

        # Vigas de acoplamiento L/h<2: skip (modeladas elásticas, no se verifican)
        L_over_h = el.geometry.L_m / max(el.geometry.h_m, 0.1)
        if skip_coupling_beams and el.kind == "beam" and L_over_h < 2.0:
            warnings.append(
                f"fid={fid}: viga de acoplamiento (L/h={L_over_h:.2f} < 2) omitida "
                "— diseñar aparte como coupling beam ACI 318 §18.10.7"
            )
            continue

        # Spec confinement para M-φ consistente con OpenSees
        kind_key = "columns" if el.kind == "column" else "beams"
        spec_el = spec.get("elements", {}).get(kind_key, {}).get(fid, {})
        conf = spec_el.get("confinement", {}) or {}
        spec_conf = conf.get("end", conf.get("mid"))

        try:
            theta_cp0, Vn0, vp_vn0, fmode0 = _compute_capacity(el, method, spec_conf)
        except Exception as exc:
            warnings.append(f"fid={fid}: capacidad inicial falló — {type(exc).__name__}: {exc}")
            continue

        initial_pass = theta_cp0 >= target

        if initial_pass:
            n_initial_pass += 1
            verifications.append(ElementVerification(
                fid=fid, kind=el.kind, story=el.story,
                performance_level=performance_level,
                theta_target=target,
                theta_CP_initial=theta_cp0, theta_CP_final=theta_cp0,
                meets_target_initial=True, meets_target_final=True,
                iterations=0, adjustments=[], changes={},
                failure_mode_final=fmode0,
                Vn_final_kN=Vn0, Vp_over_Vn_final=vp_vn0,
            ))
            continue

        # Intentar cumplir
        try:
            el_new, adjustments, changes, meets, n_iters = _iterate_element(
                el, target, method, spec_conf, max_iters=max_iterations,
            )
            theta_cp_f, Vn_f, vp_vn_f, fmode_f = _compute_capacity(el_new, method, spec_conf)
        except Exception as exc:
            warnings.append(f"fid={fid}: iteración falló — {type(exc).__name__}: {exc}")
            continue

        if meets:
            n_adjusted += 1
        else:
            n_unmet += 1

        for adj in adjustments:
            key = adj.split(":")[0]
            adjust_count[key] = adjust_count.get(key, 0) + 1

        verifications.append(ElementVerification(
            fid=fid, kind=el.kind, story=el.story,
            performance_level=performance_level,
            theta_target=target,
            theta_CP_initial=theta_cp0, theta_CP_final=theta_cp_f,
            meets_target_initial=False, meets_target_final=meets,
            iterations=n_iters, adjustments=adjustments, changes=changes,
            failure_mode_final=fmode_f,
            Vn_final_kN=Vn_f, Vp_over_Vn_final=vp_vn_f,
            unmet_reason=None if meets else (
                "Agotados los ajustes dentro de los pasos permitidos. "
                "Considerar encamisado CFRP, aumento de sección, o aceptar "
                "un nivel de desempeño inferior para este elemento."
            ),
        ))

    return PerformanceVerificationResult(
        performance_level=performance_level,
        theta_targets=targets,
        method=method,
        n_elements=len(verifications),
        n_initial_pass=n_initial_pass,
        n_adjusted=n_adjusted,
        n_unmet=n_unmet,
        max_iterations=max_iterations,
        elements=verifications,
        summary_adjustments=adjust_count,
        warnings=warnings,
    )


def apply_verification_fixes(
    result:          PerformanceVerificationResult,
    reinforcement:   dict,
    only_adjusted:   bool = True,
) -> dict:
    """Mergea los `changes` del verificador en un dict reinforcement.json.

    Args:
        result:        salida de verify_performance_capacity().
        reinforcement: dict existente {fid: {reinforcement: {...}, ...}}.
        only_adjusted: True → solo aplica si el elemento fue modificado y cumple.
                       False → aplica incluso a elementos que no cumplen.

    Devuelve una copia del reinforcement actualizada (no muta el original).
    """
    import datetime as _dt
    out = dict(reinforcement)
    saved_at = _dt.datetime.now(_dt.timezone.utc).isoformat()

    for ev in result.elements:
        if not ev.changes:
            continue
        if only_adjusted and not ev.meets_target_final:
            continue
        existing = (out.get(ev.fid, {}) or {}).get("reinforcement") or {}
        merged = dict(existing)
        for key, val in ev.changes.items():
            if isinstance(val, dict):
                cur = dict(merged.get(key) or {})
                cur.update(val)
                merged[key] = cur
            else:
                merged[key] = val
        out[ev.fid] = {
            "reinforcement": merged,
            "notes":         f"Ola 8 — performance-based verify ({ev.performance_level}): "
                             + "; ".join(ev.adjustments),
            "saved_at":      saved_at,
            "source":        "ola8_performance_verify",
            "action_id":     "performance_verify",
            "pattern_label": None,
            "bulk_batch_id": None,
        }
    return out
