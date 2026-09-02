"""
Walls engine module — Analytical models for nonlinear wall elements.

Supported formulations:
  - MVLEM_3D          : Flexure-dominated wall model
  - SFI_MVLEM_3D      : Shear-flexure interaction
  - E_SFI_MVLEM_3D    : Efficient shear-flexure interaction (recommended for 3D buildings)
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

__all__ = [
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
]
