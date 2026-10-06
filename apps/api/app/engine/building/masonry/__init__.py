"""
Módulo Masonry — Modelado de paneles de mampostería como puntales equivalentes.

Formulación adoptada de RCF-AD (Guerrero et al. 2022 / Borah et al. 2021):
- Material uniaxial Concrete01 con relaciones Em/fm por tipo de ladrillo (VP/HP).
- Puntales cruzados diagonales (Truss elements) que trabajan a compresión.
- Reducción por aberturas: Al-Chaar (2002).
"""
from .masonry_material import MasonryMaterialDef, masonry_concrete01_params
from .infill_strut import (
    InfillPanel,
    strut_geometry,
    al_chaar_reduction,
)

__all__ = [
    "MasonryMaterialDef",
    "masonry_concrete01_params",
    "InfillPanel",
    "strut_geometry",
    "al_chaar_reduction",
]
