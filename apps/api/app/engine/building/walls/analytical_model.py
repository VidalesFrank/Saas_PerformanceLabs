"""
Wall analytical model hierarchy.

WallAnalyticalModel (base)
├── MVLEM3DModel       — MVLEM_3D
├── SFIMVLEM3DModel    — SFI_MVLEM_3D
└── ESFIMVLEM3DModel   — E_SFI_MVLEM_3D  (recommended default)

Physical wall data (geometry, reinforcement, materials) is kept separate from
the analytical formulation. The same physical wall can be re-analyzed with
a different formulation without re-defining its geometry.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from .macrofiber import MacroFiber, AutoDiscretization, BoundaryZone, WebZone


class WallFormulation(str, Enum):
    MVLEM_3D      = "MVLEM_3D"
    SFI_MVLEM_3D  = "SFI_MVLEM_3D"
    E_SFI_MVLEM_3D = "E_SFI_MVLEM_3D"

    @property
    def label(self) -> str:
        return {
            "MVLEM_3D":       "MVLEM_3D",
            "SFI_MVLEM_3D":   "SFI-MVLEM-3D",
            "E_SFI_MVLEM_3D": "E-SFI-MVLEM-3D",
        }[self.value]

    @property
    def description(self) -> str:
        return {
            "MVLEM_3D":       "Flexure-dominated wall model",
            "SFI_MVLEM_3D":   "Shear-flexure interaction",
            "E_SFI_MVLEM_3D": "Efficient shear-flexure interaction formulation",
        }[self.value]

    @property
    def uses_rc_panel(self) -> bool:
        """True for formulations that require nDMaterial RC panel per macrofiber."""
        return self in (WallFormulation.SFI_MVLEM_3D, WallFormulation.E_SFI_MVLEM_3D)


@dataclass
class WallAnalyticalModel:
    """
    Base class — common parameters for all wall macrofiber formulations.

    Attributes:
        formulation   : Element type to generate.
        node_i        : Bottom-left node tag (iNode).
        node_j        : Bottom-right node tag (jNode).
        node_k        : Top-right node tag (kNode).
        node_l        : Top-left node tag (lNode).
                        Ordered counterclockwise per OpenSees convention.
        macrofibers   : List of discretized fibers (left → right).
        density_t_m3  : Mass density (tonnes/m³). Default from concrete ~2.4.
        source_pier   : Identifier tracing back to the ETABS pier label.
        source_story  : Story this segment belongs to.
    """
    formulation:  WallFormulation
    node_i:       str
    node_j:       str
    node_k:       str
    node_l:       str
    macrofibers:  list[MacroFiber] = field(default_factory=list)
    density_t_m3: float = 2.4
    source_pier:  str = ""
    source_story: str = ""

    @property
    def n_fibers(self) -> int:
        return len(self.macrofibers)

    @property
    def total_width_m(self) -> float:
        return round(sum(mf.width_m for mf in self.macrofibers), 6)

    def to_dict(self) -> dict:
        return {
            "formulation":   self.formulation.value,
            "nodes":         [self.node_i, self.node_j, self.node_k, self.node_l],
            "n_fibers":      self.n_fibers,
            "total_width_m": self.total_width_m,
            "macrofibers":   [mf.to_dict() for mf in self.macrofibers],
            "density_t_m3":  self.density_t_m3,
            "source_pier":   self.source_pier,
            "source_story":  self.source_story,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "WallAnalyticalModel":
        form = WallFormulation(data["formulation"])
        return create_wall_model(form, data)


@dataclass
class MVLEM3DModel(WallAnalyticalModel):
    """
    MVLEM_3D — Multiple-Vertical-Line-Element-Model (3D).

    Uses uniaxial materials per fiber (Concrete + Steel separately).
    No RC panel material required.

    Extra parameter:
        c_rot : Center of rotation (normalized wall height, 0–1). Default 0.4.
    """
    c_rot: float = 0.4

    def __post_init__(self):
        self.formulation = WallFormulation.MVLEM_3D

    def to_dict(self) -> dict:
        d = super().to_dict()
        d["c_rot"] = self.c_rot
        return d


@dataclass
class SFIMVLEM3DModel(WallAnalyticalModel):
    """
    SFI_MVLEM_3D — Shear-Flexure Interaction MVLEM.

    Each macrofiber receives an nDMaterial (RC panel / FSAM).
    """
    c_rot:        float = 0.4
    thick_mod:    float = 0.63
    poisson:      float = 0.25

    def __post_init__(self):
        self.formulation = WallFormulation.SFI_MVLEM_3D

    def to_dict(self) -> dict:
        d = super().to_dict()
        d.update({"c_rot": self.c_rot, "thick_mod": self.thick_mod, "poisson": self.poisson})
        return d


@dataclass
class ESFIMVLEM3DModel(WallAnalyticalModel):
    """
    E_SFI_MVLEM_3D — Efficient Shear-Flexure Interaction MVLEM.

    Recommended for 3D building models with axial–flexure–shear coupling.
    Each macrofiber receives an nDMaterial (RC panel / FSAM).

    Optional parameters (OpenSees -CoR, -ThickMod, -Poisson, -Density):
        c_rot     : Center of rotation (0–1). Default 0.4.
        thick_mod : Out-of-plane thickness modifier. Default 0.63.
        poisson   : Poisson ratio for out-of-plane. Default 0.25.
    """
    c_rot:     float = 0.4
    thick_mod: float = 0.63
    poisson:   float = 0.25

    def __post_init__(self):
        self.formulation = WallFormulation.E_SFI_MVLEM_3D

    def to_dict(self) -> dict:
        d = super().to_dict()
        d.update({
            "c_rot":     self.c_rot,
            "thick_mod": self.thick_mod,
            "poisson":   self.poisson,
        })
        return d

    @classmethod
    def from_physical_wall(
        cls,
        node_i: str, node_j: str, node_k: str, node_l: str,
        wall_length_m: float,
        wall_thickness_m: float,
        left_boundary: BoundaryZone | None,
        web: WebZone,
        right_boundary: BoundaryZone | None,
        n_fibers: int = 8,
        c_rot: float = 0.4,
        thick_mod: float = 0.63,
        poisson: float = 0.25,
        density_t_m3: float = 2.4,
        source_pier: str = "",
        source_story: str = "",
    ) -> "ESFIMVLEM3DModel":
        """
        Build an ESFIMVLEM3DModel from physical wall zone definitions.

        Discretization honours boundary–web boundaries: boundary fibers are not
        split across zone boundaries.
        """
        fibers = AutoDiscretization.auto(
            wall_length_m=wall_length_m,
            wall_thickness_m=wall_thickness_m,
            left_boundary=left_boundary,
            web=web,
            right_boundary=right_boundary,
            n_fibers=n_fibers,
        )
        return cls(
            formulation=WallFormulation.E_SFI_MVLEM_3D,
            node_i=node_i, node_j=node_j, node_k=node_k, node_l=node_l,
            macrofibers=fibers,
            density_t_m3=density_t_m3,
            source_pier=source_pier,
            source_story=source_story,
            c_rot=c_rot,
            thick_mod=thick_mod,
            poisson=poisson,
        )


# ── Factory ───────────────────────────────────────────────────────────────────

_MODEL_CLASSES: dict[WallFormulation, type[WallAnalyticalModel]] = {
    WallFormulation.MVLEM_3D:       MVLEM3DModel,
    WallFormulation.SFI_MVLEM_3D:   SFIMVLEM3DModel,
    WallFormulation.E_SFI_MVLEM_3D: ESFIMVLEM3DModel,
}


def create_wall_model(formulation: WallFormulation, data: dict) -> WallAnalyticalModel:
    """Deserialise a wall analytical model from a plain dict."""
    from .macrofiber import MacroFiber as _MF

    cls = _MODEL_CLASSES[formulation]
    nodes = data.get("nodes", ["", "", "", ""])

    shared = dict(
        formulation=formulation,
        node_i=nodes[0] if len(nodes) > 0 else "",
        node_j=nodes[1] if len(nodes) > 1 else "",
        node_k=nodes[2] if len(nodes) > 2 else "",
        node_l=nodes[3] if len(nodes) > 3 else "",
        macrofibers=[_MF.from_dict(mf) for mf in data.get("macrofibers", [])],
        density_t_m3=data.get("density_t_m3", 2.4),
        source_pier=data.get("source_pier", ""),
        source_story=data.get("source_story", ""),
    )

    if formulation == WallFormulation.MVLEM_3D:
        return MVLEM3DModel(**shared, c_rot=data.get("c_rot", 0.4))

    if formulation == WallFormulation.SFI_MVLEM_3D:
        return SFIMVLEM3DModel(
            **shared,
            c_rot=data.get("c_rot", 0.4),
            thick_mod=data.get("thick_mod", 0.63),
            poisson=data.get("poisson", 0.25),
        )

    return ESFIMVLEM3DModel(
        **shared,
        c_rot=data.get("c_rot", 0.4),
        thick_mod=data.get("thick_mod", 0.63),
        poisson=data.get("poisson", 0.25),
    )
