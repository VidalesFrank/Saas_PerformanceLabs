"""
MaterialRegistry — auto-assigns integer OpenSees tags and deduplicates materials.

Motivation (point 28 of spec): a building with 500 macrofibers should not create
500 FSAM materials if many share identical physics. The registry caches by
content-hash key and returns the same tag for physically equivalent definitions.

Usage:
    registry = MaterialRegistry(start_tag=1)
    tag = registry.get_or_create_fsam(rc_panel_material)
    tag_conc = registry.get_or_create_concrete(concrete_def)
    tag_steel = registry.get_or_create_steel(steel_def)
    all_defs = registry.to_dict()   # serialisable summary for debug/preview
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .rc_panel_material import (
    ConcreteMaterialDef,
    SteelMaterialDef,
    RCPanelMaterial,
)


@dataclass
class MaterialRegistry:
    """
    Manages OpenSees material tag allocation.

    Tags are allocated in the order they are first requested.
    Subsequent requests for the same physics return the cached tag.
    """
    start_tag: int = 1

    # Internal stores: key → (tag, definition_dict)
    _concrete: dict[str, tuple[int, dict]] = field(default_factory=dict, repr=False)
    _steel:    dict[str, tuple[int, dict]] = field(default_factory=dict, repr=False)
    _fsam:     dict[str, tuple[int, dict]] = field(default_factory=dict, repr=False)
    _counter:  int = field(default=1, repr=False)

    def __post_init__(self):
        self._counter = self.start_tag

    def _next_tag(self) -> int:
        t = self._counter
        self._counter += 1
        return t

    # ── Concrete ──────────────────────────────────────────────────────────────

    def _concrete_key(self, c: ConcreteMaterialDef) -> str:
        return f"CONC|{c.name}|{c.fpc_mpa}|{c.confined}|{c.eps_c0}|{c.eps_cu}"

    def get_or_create_concrete(self, c: ConcreteMaterialDef) -> int:
        key = self._concrete_key(c)
        if key not in self._concrete:
            tag = self._next_tag()
            self._concrete[key] = (tag, {
                "tag": tag, "type": "Concrete02",
                "name": c.name, "fpc_mpa": c.fpc_mpa, "fpcu_mpa": c.fpcu_mpa,
                "eps_c0": c.eps_c0, "eps_cu": c.eps_cu, "ft_mpa": c.ft_mpa,
                "Ets": c.Ets, "E_mpa": c.E_mpa, "confined": c.confined,
            })
        return self._concrete[key][0]

    # ── Steel ─────────────────────────────────────────────────────────────────

    def _steel_key(self, s: SteelMaterialDef) -> str:
        return f"STEEL|{s.name}|{s.fy_mpa}|{s.E_mpa}|{s.b}"

    def get_or_create_steel(self, s: SteelMaterialDef) -> int:
        key = self._steel_key(s)
        if key not in self._steel:
            tag = self._next_tag()
            self._steel[key] = (tag, {
                "tag": tag, "type": "Steel02",
                "name": s.name, "fy_mpa": s.fy_mpa, "E_mpa": s.E_mpa,
                "b": s.b, "R0": s.R0, "cR1": s.cR1, "cR2": s.cR2,
            })
        return self._steel[key][0]

    # ── FSAM nDMaterial ───────────────────────────────────────────────────────

    def get_or_create_fsam(self, panel: RCPanelMaterial) -> int:
        """
        Ensures concrete and steel sub-materials are registered first, then
        creates the FSAM nDMaterial if not already cached.
        Returns the FSAM tag.
        """
        key = panel.cache_key
        if key not in self._fsam:
            t_conc = self.get_or_create_concrete(panel.concrete_def)
            t_sv   = self.get_or_create_steel(panel.steel_v_def)
            t_sh   = self.get_or_create_steel(panel.steel_h_def)
            t_fsam = self._next_tag()
            self._fsam[key] = (t_fsam, {
                "tag":            t_fsam,
                "type":           "FSAM",
                "rho_vertical":   panel.rho_vertical,
                "rho_horizontal": panel.rho_horizontal,
                "tag_steel_h":    t_sh,
                "tag_steel_v":    t_sv,
                "tag_concrete":   t_conc,
                "nu":             panel.fsam.nu,
                "alfadow":        panel.fsam.alfadow,
                "cache_key":      key,
            })
        return self._fsam[key][0]

    # ── Serialisation ─────────────────────────────────────────────────────────

    def to_dict(self) -> dict:
        return {
            "concrete_materials": [v for _, v in self._concrete.values()],
            "steel_materials":    [v for _, v in self._steel.values()],
            "fsam_materials":     [v for _, v in self._fsam.values()],
            "total_tags":         self._counter - self.start_tag,
        }

    @classmethod
    def from_dict(cls, data: dict, start_tag: int = 1) -> "MaterialRegistry":
        reg = cls(start_tag=start_tag)
        max_tag = start_tag - 1
        for entry in data.get("concrete_materials", []):
            key = f"CONC|{entry['name']}|{entry['fpc_mpa']}|{entry['confined']}|{entry['eps_c0']}|{entry['eps_cu']}"
            reg._concrete[key] = (entry["tag"], entry)
            max_tag = max(max_tag, entry["tag"])
        for entry in data.get("steel_materials", []):
            key = f"STEEL|{entry['name']}|{entry['fy_mpa']}|{entry['E_mpa']}|{entry['b']}"
            reg._steel[key] = (entry["tag"], entry)
            max_tag = max(max_tag, entry["tag"])
        for entry in data.get("fsam_materials", []):
            key = entry.get("cache_key", str(entry["tag"]))
            reg._fsam[key] = (entry["tag"], entry)
            max_tag = max(max_tag, entry["tag"])
        reg._counter = max_tag + 1
        return reg
