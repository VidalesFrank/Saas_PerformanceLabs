"""Fase 0 - Toma de datos en campo y triaje sismico post-sismo.

Dos sub-flujos independientes:

  A) ATC-20 / AIS-IDIGER: clasificacion de ocupabilidad tras el sismo
     (verde INSPECCIONADO / amarillo USO RESTRINGIDO / rojo INSEGURO).
     Ver `atc20.py`.

  B) FEMA P-2018 (ATC-78): calculo del Building Rating (BR) por
     Column/Wall Rating -> Story Rating -> Building Rating, con
     ajustes por dano observado y atajos WSI / elastico global.
     Ver `fema_p2018/`.

Ambos operan sobre dataclasses puros definidos en `schemas.py`. Ninguna
dependencia web (FastAPI/Pydantic). Unidades: m, kN, adimensional.
"""

from .atc20 import Placard, PlacardResult, evaluate_placard
from .fema_p2018 import (
    DEFAULT_DAMAGE_LAMBDA,
    DEFAULT_TABLE_6_6,
    ExceptionalFlags,
    ShortcutInput,
    ShortcutResult,
    TriageDecision,
    TriageInput,
    TriageResult,
    apply_shortcuts,
    check_exceptional,
    check_typology_covered,
    interp_rating,
    run_triage,
)
from .schemas import (
    Access,
    AccessCondition,
    ComponentDamage,
    ComponentInput,
    DamageLevel,
    Direction,
    HazardCheck,
    HazardResponse,
    HazardSeverity,
    HazardsInput,
    Occupancy,
    SafetyInput,
    StoryInput,
    StructuralSystem,
)

__all__ = [
    # ATC-20
    "Placard",
    "PlacardResult",
    "evaluate_placard",
    # FEMA P-2018
    "DEFAULT_DAMAGE_LAMBDA",
    "DEFAULT_TABLE_6_6",
    "ExceptionalFlags",
    "ShortcutInput",
    "ShortcutResult",
    "TriageDecision",
    "TriageInput",
    "TriageResult",
    "apply_shortcuts",
    "check_exceptional",
    "check_typology_covered",
    "interp_rating",
    "run_triage",
    # Schemas
    "Access",
    "AccessCondition",
    "ComponentDamage",
    "ComponentInput",
    "DamageLevel",
    "Direction",
    "HazardCheck",
    "HazardResponse",
    "HazardSeverity",
    "HazardsInput",
    "Occupancy",
    "SafetyInput",
    "StoryInput",
    "StructuralSystem",
]
