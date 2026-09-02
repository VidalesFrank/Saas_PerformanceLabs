"""
MacroFiber discretization for wall analytical models.

A macrofiber represents one vertical strip of the wall section, characterized by:
  - Geometry: width, thickness
  - Reinforcement: rho_v (vertical), rho_h (horizontal)
  - Materials: concrete name, steel_v name, steel_h name
  - Region: BOUNDARY_LEFT | WEB | BOUNDARY_RIGHT

AutoDiscretization distributes fibers respecting boundary–web zone boundaries
so no single fiber straddles a confined/unconfined transition.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class MacroFiberRegion(str, Enum):
    BOUNDARY_LEFT  = "boundary_left"
    WEB            = "web"
    BOUNDARY_RIGHT = "boundary_right"


@dataclass
class MacroFiber:
    """
    Single macrofiber strip of a wall analytical model.

    All lengths in metres; reinforcement ratios dimensionless (e.g. 0.022 = 2.2%).
    """
    index:           int                # 1-based position left → right
    width_m:         float
    thickness_m:     float
    region:          MacroFiberRegion
    rho_vertical:    float              # vertical steel ratio (dimensionless)
    rho_horizontal:  float              # horizontal steel ratio (dimensionless)
    concrete_name:   str                # e.g. "C28" (key in materials dict)
    steel_v_name:    str                # vertical reinforcing steel name
    steel_h_name:    str                # horizontal reinforcing steel name
    # RC panel material tag is managed by MaterialRegistry — not stored here
    rc_panel_key:    str = ""           # cache key produced by MaterialRegistry

    def to_dict(self) -> dict:
        return {
            "index":          self.index,
            "width_m":        self.width_m,
            "thickness_m":    self.thickness_m,
            "region":         self.region.value,
            "rho_vertical":   self.rho_vertical,
            "rho_horizontal": self.rho_horizontal,
            "concrete_name":  self.concrete_name,
            "steel_v_name":   self.steel_v_name,
            "steel_h_name":   self.steel_h_name,
            "rc_panel_key":   self.rc_panel_key,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "MacroFiber":
        return cls(
            index=data.get("index", 0),
            width_m=data.get("width_m", 0.0),
            thickness_m=data.get("thickness_m", 0.0),
            region=MacroFiberRegion(data.get("region", "web")),
            rho_vertical=data.get("rho_vertical", 0.0),
            rho_horizontal=data.get("rho_horizontal", 0.0),
            concrete_name=data.get("concrete_name", ""),
            steel_v_name=data.get("steel_v_name", ""),
            steel_h_name=data.get("steel_h_name", ""),
            rc_panel_key=data.get("rc_panel_key", ""),
        )


# ── Physical zone definitions ─────────────────────────────────────────────────

@dataclass
class BoundaryZone:
    """Physical boundary element zone (left or right)."""
    width_m:       float
    thickness_m:   float        # usually equals wall thickness
    rho_vertical:  float
    rho_horizontal: float = 0.0
    concrete_name: str = ""
    steel_v_name:  str = ""
    steel_h_name:  str = ""


@dataclass
class WebZone:
    """Central web region of the wall."""
    thickness_m:   float
    rho_vertical:  float
    rho_horizontal: float
    concrete_name: str = ""
    steel_v_name:  str = ""
    steel_h_name:  str = ""


# ── Auto-discretization ───────────────────────────────────────────────────────

class AutoDiscretization:
    """
    Distributes macrofibers across a wall respecting zone boundaries.

    Strategy:
      1. Each boundary zone gets at least 1 fiber (more if boundary is wide).
      2. Remaining fibers fill the web proportionally.
      3. No fiber straddles the boundary–web interface.
      4. If n_fibers < 4 and boundaries exist, boundaries each get 1 fiber
         and the remaining go to the web.
    """

    @staticmethod
    def auto(
        wall_length_m:    float,
        wall_thickness_m: float,
        left_boundary:    BoundaryZone | None,
        web:              WebZone,
        right_boundary:   BoundaryZone | None,
        n_fibers:         int = 8,
    ) -> list[MacroFiber]:

        n_fibers = max(n_fibers, 2)
        lb_width = left_boundary.width_m  if left_boundary  else 0.0
        rb_width = right_boundary.width_m if right_boundary else 0.0
        web_width = wall_length_m - lb_width - rb_width
        web_width = max(web_width, 0.0)

        # Allocate fibers per zone
        n_lb = AutoDiscretization._fibers_for_zone(lb_width, wall_length_m, n_fibers) if lb_width > 0 else 0
        n_rb = AutoDiscretization._fibers_for_zone(rb_width, wall_length_m, n_fibers) if rb_width > 0 else 0
        n_web = max(n_fibers - n_lb - n_rb, 1)

        fibers: list[MacroFiber] = []
        idx = 1

        # Left boundary fibers
        if lb_width > 0 and left_boundary is not None:
            fiber_w = lb_width / n_lb if n_lb > 0 else lb_width
            for _ in range(n_lb):
                fibers.append(MacroFiber(
                    index=idx, width_m=round(fiber_w, 6),
                    thickness_m=left_boundary.thickness_m or wall_thickness_m,
                    region=MacroFiberRegion.BOUNDARY_LEFT,
                    rho_vertical=left_boundary.rho_vertical,
                    rho_horizontal=left_boundary.rho_horizontal,
                    concrete_name=left_boundary.concrete_name,
                    steel_v_name=left_boundary.steel_v_name,
                    steel_h_name=left_boundary.steel_h_name,
                ))
                idx += 1

        # Web fibers
        if web_width > 0:
            fiber_w = web_width / n_web
            for _ in range(n_web):
                fibers.append(MacroFiber(
                    index=idx, width_m=round(fiber_w, 6),
                    thickness_m=web.thickness_m or wall_thickness_m,
                    region=MacroFiberRegion.WEB,
                    rho_vertical=web.rho_vertical,
                    rho_horizontal=web.rho_horizontal,
                    concrete_name=web.concrete_name,
                    steel_v_name=web.steel_v_name,
                    steel_h_name=web.steel_h_name,
                ))
                idx += 1

        # Right boundary fibers
        if rb_width > 0 and right_boundary is not None:
            fiber_w = rb_width / n_rb if n_rb > 0 else rb_width
            for _ in range(n_rb):
                fibers.append(MacroFiber(
                    index=idx, width_m=round(fiber_w, 6),
                    thickness_m=right_boundary.thickness_m or wall_thickness_m,
                    region=MacroFiberRegion.BOUNDARY_RIGHT,
                    rho_vertical=right_boundary.rho_vertical,
                    rho_horizontal=right_boundary.rho_horizontal,
                    concrete_name=right_boundary.concrete_name,
                    steel_v_name=right_boundary.steel_v_name,
                    steel_h_name=right_boundary.steel_h_name,
                ))
                idx += 1

        # Renumber consecutively in case allocation math adjusted counts
        for i, mf in enumerate(fibers, start=1):
            mf.index = i

        return fibers

    @staticmethod
    def _fibers_for_zone(zone_width: float, total_width: float, total_fibers: int) -> int:
        proportion = zone_width / total_width if total_width > 0 else 0.0
        n = max(1, round(proportion * total_fibers))
        return n

    @staticmethod
    def uniform(
        wall_length_m:    float,
        wall_thickness_m: float,
        rho_vertical:     float,
        rho_horizontal:   float,
        concrete_name:    str,
        steel_v_name:     str,
        steel_h_name:     str,
        n_fibers:         int = 8,
    ) -> list[MacroFiber]:
        """Uniform discretization — all fibers have identical properties."""
        fiber_w = wall_length_m / n_fibers
        return [
            MacroFiber(
                index=i + 1,
                width_m=round(fiber_w, 6),
                thickness_m=wall_thickness_m,
                region=MacroFiberRegion.WEB,
                rho_vertical=rho_vertical,
                rho_horizontal=rho_horizontal,
                concrete_name=concrete_name,
                steel_v_name=steel_v_name,
                steel_h_name=steel_h_name,
            )
            for i in range(n_fibers)
        ]
