"""
Pipeline por elemento (Fase 6, Opción 1 — posproceso sin tocar OpenSees).

Dado un `nonlinear_model.json` (spec) + `axial_from_gravity.json` (opcional) +
`observations.csv` (opcional), ejecuta Fases 1–5 y devuelve una tabla por
elemento con:
    - ElementData (datos consolidados)
    - MomentCurvatureResult
    - FailureModeResult
    - RotationCapacity (según método configurado)
    - ElementFragility

Esto alimenta tanto el reporte "umbrales por elemento" (Fase 7) como el
switch `metodo_umbrales = FEMA | elemento | ambos` que se aplica en el
hinge_damage del pushover.

El modelo OpenSees NO se toca — toda la Opción 1 es posproceso puro.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Literal, Optional

from .element_data import ElementData, elements_from_spec, load_axial_from_gravity, load_observations_csv
from .moment_curvature_element import compute_moment_curvature, MomentCurvatureResult
from .failure_mode import compute_failure_mode, FailureModeResult
from .rotation_capacity import compute_rotation_capacity, RotationCapacity, RotationMethod
from .damage_states import build_fragility, ElementFragility, DamageStateDef


MetodoUmbrales = Literal["FEMA", "elemento", "ambos"]


@dataclass
class ElementThresholdRow:
    """Un elemento con todos los datos de capacidad calculados."""
    fid:              str
    kind:             str
    story:            str
    section:          str
    # Modo de falla + banderas
    failure_mode:     str
    asce_condition:   str
    flags:            list[str]
    Vp_kN:            float
    Vn_kN:            float
    Vp_over_Vn:       float
    # M-φ pico
    M_peak_kNm:       float
    phi_u_rad_per_m:  float
    # Capacidad de rotación
    method:           str
    Lp_mm:            float
    Lp_source:        str
    theta_y:          float
    theta_IO:         float
    theta_LS:         float
    theta_CP:         float
    theta_u:          float
    # Haselton específicos
    lambda_imk:       Optional[float] = None
    Mc_over_My:       Optional[float] = None
    # Fragilidad
    medians_DS:       dict[str, float] = field(default_factory=dict)
    betas_DS:         dict[str, float] = field(default_factory=dict)
    # Observaciones de campo
    has_measured_Lp:  bool = False
    damage_notes:     Optional[str] = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ElementThresholdResult:
    """Tabla completa por elemento + metadatos del proyecto."""
    metodo_rotacion:       str                   # "mecanico" | "ec8_3" | "haselton"
    metodo_umbrales:       str                   # "FEMA" | "elemento" | "ambos"
    beta_global:           float
    beta_poor_detailing:   float
    rows:                  list[ElementThresholdRow] = field(default_factory=list)
    # Fragilidades crudas por fid (para que el frontend pueda hacer P(DS|θ) interactivo)
    fragilities:           dict[str, dict] = field(default_factory=dict)
    # Diagnóstico
    n_elements:            int = 0
    n_with_lp_measured:    int = 0
    n_poor_detailing:      int = 0
    warnings:              list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "metodo_rotacion":      self.metodo_rotacion,
            "metodo_umbrales":      self.metodo_umbrales,
            "beta_global":          self.beta_global,
            "beta_poor_detailing":  self.beta_poor_detailing,
            "rows":                 [r.to_dict() for r in self.rows],
            "fragilities":          self.fragilities,
            "n_elements":           self.n_elements,
            "n_with_lp_measured":   self.n_with_lp_measured,
            "n_poor_detailing":     self.n_poor_detailing,
            "warnings":             self.warnings,
        }


def compute_element_thresholds(
    spec:                 dict,
    axial_json:           Optional[dict] = None,
    observations:         Optional[dict[str, dict]] = None,
    metodo_rotacion:      RotationMethod = "haselton",
    metodo_umbrales:      MetodoUmbrales = "FEMA",
    beta_global:          float = 0.40,
    beta_poor_detailing:  float = 0.60,
    ds_catalog:           Optional[list[DamageStateDef]] = None,
    mu_disp_default:      float = 2.0,
) -> ElementThresholdResult:
    """Pipeline completo. Devuelve ElementThresholdResult JSON-serializable.

    Args:
        spec:                nonlinear_model.json cargado.
        axial_json:          dict {fid: {N_grav_kN,...}} o None.
        observations:        dict {fid: {L_p_measured_mm, hook_type,...}} o None.
        metodo_rotacion:     por default "haselton" (ver Fase 4).
        metodo_umbrales:     "FEMA" | "elemento" | "ambos" — no afecta este
                             cómputo (siempre produce los umbrales por elemento),
                             pero se persiste en el resultado para que el
                             posproceso del pushover sepa qué aplicar.
        beta_global:         dispersión lognormal default (ν_dB).
        beta_poor_detailing: dispersión para elementos con banderas.
        ds_catalog:          catálogo de DS personalizable.
        mu_disp_default:     demanda de ductilidad asumida para Sezen-Moehle.
                             En Fase 6 el pushover puede iterar con μ real.
    """
    elements = elements_from_spec(spec, axial_json=axial_json,
                                   observations=observations)

    rows: list[ElementThresholdRow] = []
    fragilities: dict[str, dict] = {}
    warnings: list[str] = []
    n_lp = 0
    n_poor = 0

    for fid, el in elements.items():
        try:
            # Confinement del spec (si está disponible)
            spec_conf = None
            kind_key = "columns" if el.kind == "column" else "beams"
            spec_el = spec.get("elements", {}).get(kind_key, {}).get(fid, {})
            conf = spec_el.get("confinement", {})
            if conf:
                spec_conf = conf.get("end", conf.get("mid"))

            mc = compute_moment_curvature(el, spec_confinement=spec_conf)
            fm = compute_failure_mode(el, Mp_kNm=mc.M_peak_kNm, mu_disp=mu_disp_default)
            rc = compute_rotation_capacity(el, mc=mc, fm=fm, method=metodo_rotacion)
            frag = build_fragility(el, rc, fm=fm,
                                     beta_global=beta_global,
                                     beta_poor_detailing=beta_poor_detailing,
                                     ds_catalog=ds_catalog)
            fragilities[fid] = frag.to_dict()

            if el.field.L_p_measured_mm:
                n_lp += 1
            if any(f in fm.flags for f in
                   ("HOOK_90", "SPLICE_IN_HINGE", "S_OVER_DB_GT_6", "RHO_SH_LT_DMO")):
                n_poor += 1

            rows.append(ElementThresholdRow(
                fid=fid, kind=el.kind, story=el.story, section=el.section_name,
                failure_mode=fm.failure_mode, asce_condition=fm.asce_condition,
                flags=fm.flags,
                Vp_kN=fm.Vp_kN, Vn_kN=fm.Vn_kN, Vp_over_Vn=fm.Vp_over_Vn,
                M_peak_kNm=mc.M_peak_kNm, phi_u_rad_per_m=mc.phi_u_rad_per_m,
                method=rc.method, Lp_mm=rc.Lp_mm, Lp_source=rc.Lp_source,
                theta_y=rc.theta_y,
                theta_IO=rc.theta_IO, theta_LS=rc.theta_LS, theta_CP=rc.theta_CP,
                theta_u=rc.theta_u,
                lambda_imk=rc.lambda_imk, Mc_over_My=rc.Mc_over_My,
                medians_DS=frag.medians, betas_DS=frag.betas,
                has_measured_Lp=bool(el.field.L_p_measured_mm),
                damage_notes=el.field.damage_notes,
            ))
        except Exception as e:
            warnings.append(f"fid={fid}: {type(e).__name__}: {e}")

    return ElementThresholdResult(
        metodo_rotacion=metodo_rotacion,
        metodo_umbrales=metodo_umbrales,
        beta_global=beta_global,
        beta_poor_detailing=beta_poor_detailing,
        rows=rows,
        fragilities=fragilities,
        n_elements=len(elements),
        n_with_lp_measured=n_lp,
        n_poor_detailing=n_poor,
        warnings=warnings,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Aplicación del switch en el posproceso del pushover
# ─────────────────────────────────────────────────────────────────────────────
def classify_demand_by_element(
    theta_demand:    float,
    row:             ElementThresholdRow,
) -> dict:
    """Clasifica una demanda θ contra los umbrales de UN elemento usando el
    marco "elemento".

    Returns:
        {
          "level":          "none|near_io|io|ls|cp|collapse",
          "dcr":            θ_demand / θ_CP,
          "theta_IO":       ...,
          "theta_LS":       ...,
          "theta_CP":       ...,
          "most_likely_DS": "DS0|DS1|DS2|DS3|DS4",
        }
    """
    IO, LS, CP = row.theta_IO, row.theta_LS, row.theta_CP

    if   theta_demand < 0.5 * IO:            level = "none"
    elif theta_demand <       IO:            level = "near_io"
    elif theta_demand <       LS:            level = "io"
    elif theta_demand <       CP:            level = "ls"
    elif theta_demand <  1.5 * CP:           level = "cp"
    else:                                    level = "collapse"

    dcr = theta_demand / CP if CP > 0 else 0.0

    # DS más probable requiere la fragilidad — se delega a frontend/caller
    return {
        "level":    level,
        "dcr":      dcr,
        "theta_IO": IO,
        "theta_LS": LS,
        "theta_CP": CP,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Helper para cargar desde disco
# ─────────────────────────────────────────────────────────────────────────────
def compute_from_project_dir(
    project_dir:         Path | str,
    metodo_rotacion:     RotationMethod = "haselton",
    metodo_umbrales:     MetodoUmbrales = "FEMA",
    beta_global:         float = 0.40,
    beta_poor_detailing: float = 0.60,
    ds_catalog:          Optional[list[DamageStateDef]] = None,
) -> ElementThresholdResult:
    """Convenience — carga desde una carpeta estándar de proyecto.

    Espera encontrar:
        <project_dir>/nonlinear_model.json
        <project_dir>/axial_from_gravity.json  (opcional)
        <project_dir>/observations.csv         (opcional)
    """
    import json

    project_dir = Path(project_dir)
    spec_path = project_dir / "nonlinear_model.json"
    if not spec_path.exists():
        raise FileNotFoundError(f"nonlinear_model.json no encontrado en {project_dir}")

    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    axial = load_axial_from_gravity(project_dir / "axial_from_gravity.json")
    obs = load_observations_csv(project_dir / "observations.csv")

    return compute_element_thresholds(
        spec=spec, axial_json=axial, observations=obs,
        metodo_rotacion=metodo_rotacion,
        metodo_umbrales=metodo_umbrales,
        beta_global=beta_global,
        beta_poor_detailing=beta_poor_detailing,
        ds_catalog=ds_catalog,
    )
