"""
RC Panel Material for SFI/E-SFI wall formulations.

Hierarchy:
  MacroFiber
    └── RCPanelMaterial (FSAM nDMaterial)
          ├── Concrete uniaxial material (Concrete02)
          ├── Vertical steel uniaxial (Steel02)
          └── Horizontal steel uniaxial (Steel02)

The FSAM (Fixed-Strut-Angle-Model) is the nDMaterial used by SFI_MVLEM_3D
and E_SFI_MVLEM_3D. It captures shear–flexure coupling through an orthogonal
rotating crack model for the RC panel.

Reference: Kolozvari et al. (2018), OpenSees FSAM documentation.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class ConcreteMaterialDef:
    """Uniaxial concrete material parameters (Concrete02 compatible)."""
    name:     str
    fpc_mpa:  float   # f'c (MPa), positive value → negated internally
    fpcu_mpa: float = 0.0   # crushing strength (default: 0.2·f'c)
    eps_c0:   float = 0.0   # strain at f'c (default: 0.002 unconfined / Mander confined)
    eps_cu:   float = 0.0   # ultimate strain
    E_mpa:    float = 0.0   # Young's modulus (computed if 0)
    ft_mpa:   float = 0.0   # tensile strength (default: 0.1·f'c)
    Ets:      float = 0.0   # tension softening slope
    confined: bool  = False

    def __post_init__(self):
        import math
        if self.E_mpa == 0 and self.fpc_mpa > 0:
            self.E_mpa = round(4700.0 * math.sqrt(self.fpc_mpa), 1)
        if self.eps_c0 == 0:
            self.eps_c0 = 0.003 if self.confined else 0.002
        if self.eps_cu == 0:
            self.eps_cu = 0.025 if self.confined else 0.006
        if self.fpcu_mpa == 0:
            self.fpcu_mpa = round(0.2 * self.fpc_mpa, 2)
        if self.ft_mpa == 0:
            self.ft_mpa = round(0.1 * self.fpc_mpa, 2)
        if self.Ets == 0:
            # Linear tension softening to zero over 5× cracking strain
            eps_cr = self.ft_mpa / self.E_mpa if self.E_mpa > 0 else 0.0001
            self.Ets = self.ft_mpa / (5.0 * eps_cr) if eps_cr > 0 else 0.0


@dataclass
class SteelMaterialDef:
    """Uniaxial steel material parameters (Steel02 compatible)."""
    name:   str
    fy_mpa: float = 420.0
    E_mpa:  float = 200_000.0
    b:      float = 0.01    # strain hardening ratio
    R0:     float = 18.0    # transition parameter
    cR1:    float = 0.925
    cR2:    float = 0.15


@dataclass
class FSAMParams:
    """
    Parameters for the FSAM nDMaterial (Fixed-Strut-Angle-Model).

    In OpenSees:
        nDMaterial FSAM $matTag $rho $sX $sY $conc $nu $alfadow
    where:
        rho     = reinforcement ratio (not used directly — we split v/h)
        sX      = tag of horizontal steel uniaxial material
        sY      = tag of vertical steel uniaxial material
        conc    = tag of concrete uniaxial material
        nu      = Poisson effect coefficient (0 = ignore, suggested 0.2)
        alfadow = dowel action stiffness parameter (suggested 0.005)
    """
    nu:      float = 0.2
    alfadow: float = 0.005


@dataclass
class RCPanelMaterial:
    """
    Composite RC panel material — one per macrofiber for SFI/E-SFI models.

    Bundles:
      - concrete definition
      - vertical steel definition
      - horizontal steel definition
      - rho_v, rho_h
      - FSAM parameters

    Does NOT store OpenSees tags — those are assigned by MaterialRegistry.
    """
    concrete_def: ConcreteMaterialDef
    steel_v_def:  SteelMaterialDef
    steel_h_def:  SteelMaterialDef
    rho_vertical:   float
    rho_horizontal: float
    fsam:           FSAMParams = field(default_factory=FSAMParams)

    @property
    def cache_key(self) -> str:
        """
        Deterministic key for MaterialRegistry deduplication.

        Two RCPanelMaterials with identical physics share the same key
        and therefore the same OpenSees material tag.
        """
        c = self.concrete_def
        sv = self.steel_v_def
        sh = self.steel_h_def
        return (
            f"FSAM|"
            f"c:{c.name},{c.fpc_mpa},{c.confined}|"
            f"sv:{sv.name},{sv.fy_mpa},{sv.b}|"
            f"sh:{sh.name},{sh.fy_mpa},{sh.b}|"
            f"rv:{self.rho_vertical:.6f}|"
            f"rh:{self.rho_horizontal:.6f}|"
            f"nu:{self.fsam.nu}|"
            f"ad:{self.fsam.alfadow}"
        )

    def to_dict(self) -> dict:
        return {
            "concrete": {
                "name":     self.concrete_def.name,
                "fpc_mpa":  self.concrete_def.fpc_mpa,
                "confined": self.concrete_def.confined,
                "eps_c0":   self.concrete_def.eps_c0,
                "eps_cu":   self.concrete_def.eps_cu,
                "fpcu_mpa": self.concrete_def.fpcu_mpa,
                "ft_mpa":   self.concrete_def.ft_mpa,
                "Ets":      self.concrete_def.Ets,
                "E_mpa":    self.concrete_def.E_mpa,
            },
            "steel_v": {
                "name":   self.steel_v_def.name,
                "fy_mpa": self.steel_v_def.fy_mpa,
                "E_mpa":  self.steel_v_def.E_mpa,
                "b":      self.steel_v_def.b,
            },
            "steel_h": {
                "name":   self.steel_h_def.name,
                "fy_mpa": self.steel_h_def.fy_mpa,
                "E_mpa":  self.steel_h_def.E_mpa,
                "b":      self.steel_h_def.b,
            },
            "rho_vertical":   self.rho_vertical,
            "rho_horizontal": self.rho_horizontal,
            "fsam": {
                "nu":      self.fsam.nu,
                "alfadow": self.fsam.alfadow,
            },
            "cache_key": self.cache_key,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "RCPanelMaterial":
        c = data["concrete"]
        sv = data["steel_v"]
        sh = data["steel_h"]
        f = data.get("fsam", {})
        return cls(
            concrete_def=ConcreteMaterialDef(
                name=c["name"], fpc_mpa=c["fpc_mpa"], confined=c.get("confined", False),
                eps_c0=c.get("eps_c0", 0.0), eps_cu=c.get("eps_cu", 0.0),
                fpcu_mpa=c.get("fpcu_mpa", 0.0), ft_mpa=c.get("ft_mpa", 0.0),
                Ets=c.get("Ets", 0.0), E_mpa=c.get("E_mpa", 0.0),
            ),
            steel_v_def=SteelMaterialDef(
                name=sv["name"], fy_mpa=sv.get("fy_mpa", 420.0),
                E_mpa=sv.get("E_mpa", 200_000.0), b=sv.get("b", 0.01),
            ),
            steel_h_def=SteelMaterialDef(
                name=sh["name"], fy_mpa=sh.get("fy_mpa", 420.0),
                E_mpa=sh.get("E_mpa", 200_000.0), b=sh.get("b", 0.01),
            ),
            rho_vertical=data.get("rho_vertical", 0.0),
            rho_horizontal=data.get("rho_horizontal", 0.0),
            fsam=FSAMParams(
                nu=f.get("nu", 0.2),
                alfadow=f.get("alfadow", 0.005),
            ),
        )
