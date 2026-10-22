"""
Estados de daño y fragilidades lognormales por elemento (Fase 5).

Marco coexiste con IO/LS/CP (ASCE 41-17); ambos se calculan en paralelo y la
UI puede mostrar cualquiera (preferentemente DS para reporte de reparación).

Cada DS tiene:
    - Nombre configurable por el usuario (DS1_name, DS2_name, ...)
    - Mediana θ_i derivada del M-φ + rotation_capacity.
    - Dispersión β_i configurable por proyecto (default 0.40; 0.60 si detallado
      deficiente).
    - Acción de reparación asociada (texto libre).

Fragilidad lognormal estándar:
    P(DS ≥ DSi | θ) = Φ(ln(θ / θ_mediana_i) / β_i)
    P(DS = DSi | θ) = P(DS ≥ DSi) − P(DS ≥ DSi+1)

Referencias:
    FEMA P-58                   Fragilidades lognormales componente
    HAZUS MH 2.1                Metodología daño edificios
    Porter (2015)               A beginner's guide to fragility
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import Optional

from .element_data import ElementData
from .rotation_capacity import RotationCapacity
from .failure_mode import FailureModeResult


# ─────────────────────────────────────────────────────────────────────────────
# Definición de un DS (configurable por el usuario)
# ─────────────────────────────────────────────────────────────────────────────
@dataclass
class DamageStateDef:
    """Definición de un estado de daño con su acción de reparación.

    threshold_source identifica de qué cantidad viene la mediana:
        "theta_y"            → fluencia (DS1)
        "theta_eps_c_004"    → descascaramiento del cover (DS2)
        "theta_075_eps_cu"   → exposición refuerzo (DS3)
        "theta_u"            → último (DS4)
    """
    id:                str                     # "DS1" | "DS2" | "DS3" | "DS4"
    name:              str                     # p. ej. "Fisuración visible"
    threshold_source:  str
    repair_action:     str
    beta_override:     Optional[float] = None  # β específico de este DS (si None usa global)


DEFAULT_DS_CATALOG: list[DamageStateDef] = [
    DamageStateDef(id="DS1", name="Fisuración visible",
                   threshold_source="theta_y",
                   repair_action="Inyección de epóxico"),
    DamageStateDef(id="DS2", name="Descascaramiento",
                   threshold_source="theta_eps_c_004",
                   repair_action="Reparación con mortero"),
    DamageStateDef(id="DS3", name="Exposición del refuerzo / pandeo incipiente",
                   threshold_source="theta_075_eps_cu",
                   repair_action="Reparación mayor / encamisado"),
    DamageStateDef(id="DS4", name="Pandeo o fractura de barras / pérdida de capacidad",
                   threshold_source="theta_u",
                   repair_action="Reemplazo del elemento"),
]


# ─────────────────────────────────────────────────────────────────────────────
# Fragilidad del elemento
# ─────────────────────────────────────────────────────────────────────────────
@dataclass
class ElementFragility:
    """Fragilidades lognormales de un elemento, un par (mediana, β) por DS."""
    fid:         str
    medians:     dict[str, float]       # {"DS1": θ_y, "DS2": θ_eps_c_004, ...}
    betas:       dict[str, float]       # {"DS1": 0.40, ...}
    ds_catalog:  list[DamageStateDef] = field(default_factory=lambda: list(DEFAULT_DS_CATALOG))

    def to_dict(self) -> dict:
        return {
            "fid":         self.fid,
            "medians":     self.medians,
            "betas":       self.betas,
            "ds_catalog":  [asdict(d) for d in self.ds_catalog],
        }

    # ─── Probabilidades ──────────────────────────────────────────────────────
    def P_exceed(self, theta: float, ds_id: str) -> float:
        """P(DS ≥ DSi | θ) usando fragilidad lognormal."""
        med = self.medians.get(ds_id, 0.0)
        beta = self.betas.get(ds_id, 0.40)
        if med <= 0 or theta <= 0 or beta <= 0:
            return 0.0
        # Φ(ln(θ/θ_med) / β)
        z = math.log(theta / med) / beta
        return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))

    def P_in_state(self, theta: float) -> dict[str, float]:
        """P(DS = DSi | θ) por diferencia de cumulatives.

        Devuelve dict con DS0 ("sin daño"), DS1, DS2, DS3, DS4.
        ∑P = 1.
        """
        ds_ids = [d.id for d in self.ds_catalog]
        p_exceed = {ds_id: self.P_exceed(theta, ds_id) for ds_id in ds_ids}

        result: dict[str, float] = {}
        # DS0 (sin daño) = 1 − P(DS ≥ DS1)
        result["DS0"] = max(0.0, 1.0 - p_exceed[ds_ids[0]])
        for i, ds_id in enumerate(ds_ids):
            p_above = p_exceed[ds_ids[i + 1]] if i + 1 < len(ds_ids) else 0.0
            result[ds_id] = max(0.0, p_exceed[ds_id] - p_above)
        return result

    def most_likely_state(self, theta: float) -> str:
        """DS con mayor probabilidad para la demanda θ dada."""
        probs = self.P_in_state(theta)
        return max(probs.items(), key=lambda kv: kv[1])[0]


# ─────────────────────────────────────────────────────────────────────────────
# Builder
# ─────────────────────────────────────────────────────────────────────────────
def build_fragility(
    el:                   ElementData,
    rc:                   RotationCapacity,
    fm:                   Optional[FailureModeResult] = None,
    beta_global:          float = 0.40,
    beta_poor_detailing:  float = 0.60,
    ds_catalog:           Optional[list[DamageStateDef]] = None,
) -> ElementFragility:
    """Construye fragilidad por elemento desde rotation_capacity.

    Prioridad para medianas:
        DS1 → rc.theta_y
        DS2 → rc.theta_DS2 (si existe) o rc.theta_IO
        DS3 → rc.theta_DS3 (si existe) o rc.theta_LS
        DS4 → rc.theta_DS4 (si existe) o rc.theta_u

    β:
        Por default beta_global (ej. 0.40). Si el elemento tiene banderas de
        detallado deficiente (fm.flags contiene HOOK_90 / SPLICE_IN_HINGE /
        S_OVER_DB_GT_6 / RHO_SH_LT_DMO) usa beta_poor_detailing.
    """
    catalog = ds_catalog or list(DEFAULT_DS_CATALOG)

    # Medianas por DS — mapeo threshold_source → valor de rc
    def _median_for(src: str) -> float:
        if src == "theta_y":          return rc.theta_y
        if src == "theta_eps_c_004":  return rc.theta_DS2 or rc.theta_IO
        if src == "theta_075_eps_cu": return rc.theta_DS3 or rc.theta_LS
        if src == "theta_u":          return rc.theta_DS4 or rc.theta_u
        return 0.0

    medians: dict[str, float] = {}
    for ds in catalog:
        medians[ds.id] = _median_for(ds.threshold_source)

    # Garantizar monotonicidad (cada DS mediana ≥ anterior)
    prev = 0.0
    for ds in catalog:
        if medians[ds.id] < prev:
            medians[ds.id] = prev * 1.01
        prev = medians[ds.id]

    # Dispersión β — poor detailing penaliza
    is_poor = False
    if fm:
        poor_flags = {"HOOK_90", "SPLICE_IN_HINGE", "S_OVER_DB_GT_6",
                      "RHO_SH_LT_DMO"}
        is_poor = any(f in poor_flags for f in fm.flags)
    beta_default = beta_poor_detailing if is_poor else beta_global

    betas: dict[str, float] = {}
    for ds in catalog:
        betas[ds.id] = ds.beta_override if ds.beta_override is not None else beta_default

    return ElementFragility(
        fid=el.fid,
        medians=medians,
        betas=betas,
        ds_catalog=catalog,
    )
