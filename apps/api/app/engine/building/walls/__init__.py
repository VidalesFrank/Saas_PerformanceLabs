"""
Walls engine module — Analytical models for nonlinear wall elements.

Supported formulations:
  - MVLEM_3D          : Flexure-dominated wall model
  - SFI_MVLEM_3D      : Shear-flexure interaction
  - E_SFI_MVLEM_3D    : Efficient shear-flexure interaction (recommended for 3D buildings)

Design module (NSR-10 / ACI 318-25):
  - compute_wall_design : Orquestador principal (auto o manual)
"""
from .analytical_model import (
    WallFormulation,
    WallAnalyticalModel,
    MVLEM3DModel,
    SFIMVLEM3DModel,
    ESFIMVLEM3DModel,
    create_wall_model,
)
from .macrofiber import MacroFiber, MacroFiberRegion, AutoDiscretization, BoundaryZone, WebZone
from .rc_panel_material import RCPanelMaterial, FSAMParams, ConcreteMaterialDef, SteelMaterialDef
from .material_registry import MaterialRegistry
from .ops_generator import WallOpsGenerator
from .validator import WallAnalyticalValidator, ValidationResult
from .material_presets import (
    default_material_catalog,
    all_concretecm_presets_list,
    colombian_concretecm_presets,
    colombian_mvlem_basic_set,
    reinforcing_bar_preset,
    wwm_reinforcement_preset,
    elastic_wall_shear_material,
)

# ── Design module ─────────────────────────────────────────────────────────────
from .wall_design_engine import compute_wall_design
from .wall_design_schemas import (
    WallDemandCombo,
    WallReinforcement,
    BoundaryZoneReinf,
    WebZoneReinf,
    WallDesignResult,
    NeutralAxisResult,
    BoundaryElementResult,
    ShearDesignResult,
    InteractionDiagram,
    CodeCheck,
    BAR_DB,
    bar_area,
    STANDARD_DIAMETERS_MM,
)
from .neutral_axis import find_neutral_axis, beta1
from .wall_pm_interaction import build_interaction_diagram, is_demand_inside
from .boundary_element import check_boundary_element, extreme_fiber_stress_mpa
from .confinement import design_confinement, ConfinementResult
from .shear_design import design_shear
from .auto_design import auto_design

__all__ = [
    # Analytical models
    "WallFormulation",
    "WallAnalyticalModel",
    "MVLEM3DModel",
    "SFIMVLEM3DModel",
    "ESFIMVLEM3DModel",
    "create_wall_model",
    "MacroFiber",
    "MacroFiberRegion",
    "AutoDiscretization",
    "BoundaryZone",
    "WebZone",
    "RCPanelMaterial",
    "FSAMParams",
    "ConcreteMaterialDef",
    "SteelMaterialDef",
    "MaterialRegistry",
    "WallOpsGenerator",
    "WallAnalyticalValidator",
    "ValidationResult",
    "default_material_catalog",
    "all_concretecm_presets_list",
    "colombian_concretecm_presets",
    "colombian_mvlem_basic_set",
    "reinforcing_bar_preset",
    "wwm_reinforcement_preset",
    "elastic_wall_shear_material",
    # Design module
    "compute_wall_design",
    "WallDemandCombo",
    "WallReinforcement",
    "BoundaryZoneReinf",
    "WebZoneReinf",
    "WallDesignResult",
    "NeutralAxisResult",
    "BoundaryElementResult",
    "ShearDesignResult",
    "InteractionDiagram",
    "CodeCheck",
    "BAR_DB",
    "bar_area",
    "STANDARD_DIAMETERS_MM",
    "find_neutral_axis",
    "beta1",
    "build_interaction_diagram",
    "is_demand_inside",
    "check_boundary_element",
    "extreme_fiber_stress_mpa",
    "design_confinement",
    "ConfinementResult",
    "design_shear",
    "auto_design",
]
