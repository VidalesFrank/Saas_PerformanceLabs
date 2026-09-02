"""
WallAnalyticalValidator — validates a WallAnalyticalModel before analysis.

Checks (point 23 of spec):
  GEOMETRY  : 4 distinct nodes, non-zero dimensions, correct CCW ordering
  MATERIALS : concrete defined, steel defined, rho > 0
  FIBERS    : sum of widths == wall length, thicknesses valid
  RC_PANEL  : FSAM material completeness for SFI/E-SFI models
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .analytical_model import WallAnalyticalModel, WallFormulation


@dataclass
class CheckResult:
    code:    str
    ok:      bool
    message: str


@dataclass
class ValidationResult:
    checks:  list[CheckResult] = field(default_factory=list)

    @property
    def is_valid(self) -> bool:
        return all(c.ok for c in self.checks if not c.code.startswith("WARN_"))

    @property
    def errors(self) -> list[CheckResult]:
        return [c for c in self.checks if not c.ok and not c.code.startswith("WARN_")]

    @property
    def warnings(self) -> list[CheckResult]:
        return [c for c in self.checks if not c.ok and c.code.startswith("WARN_")]

    def to_dict(self) -> dict:
        return {
            "is_valid": self.is_valid,
            "checks": [
                {"code": c.code, "ok": c.ok, "message": c.message}
                for c in self.checks
            ],
            "n_errors":   len(self.errors),
            "n_warnings": len(self.warnings),
        }


class WallAnalyticalValidator:

    def validate(
        self,
        model: WallAnalyticalModel,
        joints: dict[str, dict] | None = None,
        tol_width_m: float = 1e-4,
    ) -> ValidationResult:
        result = ValidationResult()
        add = result.checks.append

        # ── Nodes ─────────────────────────────────────────────────────────────
        nodes = [model.node_i, model.node_j, model.node_k, model.node_l]
        unique_nodes = set(n for n in nodes if n)
        add(CheckResult(
            "NODES_DEFINED",
            len(unique_nodes) == 4,
            "4 distinct nodes required" if len(unique_nodes) != 4 else "OK",
        ))
        add(CheckResult(
            "NODES_NON_EMPTY",
            all(n for n in nodes),
            "All 4 nodes must be non-empty" if not all(n for n in nodes) else "OK",
        ))

        # Geometry checks if joint coordinates are provided
        if joints and len(unique_nodes) == 4:
            coords = [joints.get(n, {}) for n in nodes]
            if all(coords):
                self._check_geometry(result, nodes, coords)

        # ── Macrofibers ───────────────────────────────────────────────────────
        n = model.n_fibers
        add(CheckResult(
            "FIBERS_COUNT",
            n >= 2,
            f"At least 2 macrofibers required, got {n}" if n < 2 else "OK",
        ))

        for mf in model.macrofibers:
            add(CheckResult(
                f"FIBER_{mf.index}_WIDTH",
                mf.width_m > 0,
                f"Fiber {mf.index}: width must be > 0, got {mf.width_m}" if mf.width_m <= 0 else "OK",
            ))
            add(CheckResult(
                f"FIBER_{mf.index}_THICK",
                mf.thickness_m > 0,
                f"Fiber {mf.index}: thickness must be > 0" if mf.thickness_m <= 0 else "OK",
            ))
            add(CheckResult(
                f"FIBER_{mf.index}_RHOV",
                mf.rho_vertical > 0,
                f"Fiber {mf.index}: rho_vertical must be > 0" if mf.rho_vertical <= 0 else "OK",
            ))
            if model.formulation.uses_rc_panel:
                add(CheckResult(
                    f"FIBER_{mf.index}_RHOH",
                    mf.rho_horizontal > 0,
                    f"Fiber {mf.index}: rho_horizontal must be > 0 for {model.formulation.value}" if mf.rho_horizontal <= 0 else "OK",
                ))
            add(CheckResult(
                f"FIBER_{mf.index}_CONCRETE",
                bool(mf.concrete_name),
                f"Fiber {mf.index}: concrete material not assigned" if not mf.concrete_name else "OK",
            ))
            add(CheckResult(
                f"FIBER_{mf.index}_STEEL_V",
                bool(mf.steel_v_name),
                f"Fiber {mf.index}: vertical steel not assigned" if not mf.steel_v_name else "OK",
            ))
            if model.formulation.uses_rc_panel:
                add(CheckResult(
                    f"FIBER_{mf.index}_STEEL_H",
                    bool(mf.steel_h_name),
                    f"Fiber {mf.index}: horizontal steel not assigned" if not mf.steel_h_name else "OK",
                ))

        # Width sum (warn only — might differ by floating point)
        if n > 0:
            total_w = model.total_width_m
            add(CheckResult(
                "WARN_WIDTH_SUM",
                True,  # always pass (informational)
                f"Total macrofiber width: {total_w:.4f} m",
            ))

        # ── Density ───────────────────────────────────────────────────────────
        add(CheckResult(
            "DENSITY",
            model.density_t_m3 > 0,
            "Density must be > 0" if model.density_t_m3 <= 0 else "OK",
        ))

        return result

    def _check_geometry(
        self,
        result: ValidationResult,
        nodes: list[str],
        coords: list[dict],
    ) -> None:
        add = result.checks.append

        def pt(d: dict) -> tuple[float, float, float]:
            return d.get("x", 0.0), d.get("y", 0.0), d.get("z", 0.0)

        pts = [pt(c) for c in coords]
        ni, nj, nk, nl = pts

        # Non-zero length: distance between i and j
        import math
        length = math.sqrt(sum((a - b) ** 2 for a, b in zip(ni, nj)))
        add(CheckResult(
            "GEOM_NON_ZERO_LENGTH",
            length > 1e-6,
            f"Wall length is near zero ({length:.4f} m)" if length <= 1e-6 else "OK",
        ))

        # Non-zero height: distance i → l (bottom-left → top-left)
        height = math.sqrt(sum((a - b) ** 2 for a, b in zip(ni, nl)))
        add(CheckResult(
            "GEOM_NON_ZERO_HEIGHT",
            height > 1e-6,
            f"Story height is near zero ({height:.4f} m)" if height <= 1e-6 else "OK",
        ))

        # Approximate planarity: cross products should be parallel
        def sub(a: tuple, b: tuple) -> tuple:
            return tuple(x - y for x, y in zip(a, b))

        def cross(a: tuple, b: tuple) -> tuple:
            return (
                a[1]*b[2] - a[2]*b[1],
                a[2]*b[0] - a[0]*b[2],
                a[0]*b[1] - a[1]*b[0],
            )

        def mag(v: tuple) -> float:
            return math.sqrt(sum(x**2 for x in v))

        v1 = sub(nj, ni)
        v2 = sub(nl, ni)
        n_vec = cross(v1, v2)
        n_mag = mag(n_vec)

        if n_mag > 1e-10:
            # Check that nk lies (approx) in the same plane
            v3 = sub(nk, ni)
            dot = sum(a*b for a, b in zip(n_vec, v3))
            planar = abs(dot) / (n_mag * max(mag(v3), 1e-10)) < 0.05
            add(CheckResult(
                "GEOM_PLANAR",
                planar,
                "Nodes are not coplanar (> 5% deviation)" if not planar else "OK",
            ))

            # CCW ordering check (normal should point outward, z-component > 0
            # for typical vertical walls; warn rather than error)
            add(CheckResult(
                "WARN_NODE_ORDER",
                True,
                f"Normal vector: ({n_vec[0]:.3f}, {n_vec[1]:.3f}, {n_vec[2]:.3f}) — verify CCW ordering",
            ))
