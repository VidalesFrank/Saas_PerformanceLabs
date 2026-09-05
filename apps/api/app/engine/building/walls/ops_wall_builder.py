"""
Wall analysis engine — OpenSeesPy model builder and analysis runner.

Converts a wall project document (wrc-1.0) into a live OpenSees domain
and runs gravity, modal, and pushover analyses.

Units: kN · m throughout (document materials stored in kPa = kN/m²).
"""
from __future__ import annotations

import json
import math
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

GRAVITY_ACCEL = 9.81  # m/s²


class WallAnalysisModel:
    """
    Builds and analyses a wall project document in OpenSees.

    Typical usage:
        m = WallAnalysisModel(doc)
        m.build()
        grav = m.run_gravity()
        modal = m.run_modal(6)
        push = m.run_pushover("X", 2.0, result_path=Path("pushover_X.json"))
        m.wipe()
    """

    def __init__(self, document: dict):
        self.doc          = document
        self.walls_cfg    = document.get("walls", [])
        self.materials_cfg = document.get("materials", {})
        self.analysis_cfg  = document.get("analysis", {})

        self._mat_tag:   dict[str, int] = {}
        self._mat_counter = 1
        self._node_counter = 1
        self._ele_counter  = 1

        self._base_nodes:  list[int] = []
        self._top_nodes:   list[tuple[int, str]] = []  # (node_tag, wall_direction)
        self._control_node: int | None = None
        self._total_height: float = 0.0

    # ── Model construction ────────────────────────────────────────────────────

    def build(self) -> None:
        import openseespy.opensees as ops
        self._ops = ops
        ops.wipe()
        ops.model("basic", "-ndm", 3, "-ndf", 6)
        self._define_materials()
        self._define_geometry()

    def _next_mat(self) -> int:
        t = self._mat_counter; self._mat_counter += 1; return t

    def _next_node(self) -> int:
        t = self._node_counter; self._node_counter += 1; return t

    def _next_ele(self) -> int:
        t = self._ele_counter; self._ele_counter += 1; return t

    def _define_materials(self) -> None:
        ops = self._ops
        for mid, mat in self.materials_cfg.items():
            tag  = self._next_mat()
            kind = mat.get("kind", "Elastic")
            self._mat_tag[mid] = tag

            try:
                if kind == "ConcreteCM":
                    ops.uniaxialMaterial(
                        "ConcreteCM", tag,
                        float(mat["fpcc"]), float(mat["epcc"]), float(mat["Ec"]),
                        float(mat["rc"]), float(mat["xcrn"]),
                        float(mat["ft"]), float(mat["et"]),
                        float(mat["rt"]), float(mat["xcrp"]),
                        int(mat.get("gapClose", 0)),
                    )
                elif kind == "Concrete02":
                    ops.uniaxialMaterial(
                        "Concrete02", tag,
                        float(mat["fpc"]), float(mat["epsc0"]),
                        float(mat["fpcu"]), float(mat["epsU"]),
                        float(mat.get("lamb", 0.1)),
                        float(mat.get("ft", 0.0)), float(mat.get("Ets", 0.0)),
                    )
                elif kind in ("Hysteretic", "HystereticSM"):
                    pos = [v for pt in mat.get("positive", []) for v in pt]
                    neg = [v for pt in mat.get("negative", []) for v in pt]
                    ops.uniaxialMaterial(
                        "Hysteretic", tag,
                        *pos, *neg,
                        float(mat.get("pinchX", 1.0)), float(mat.get("pinchY", 1.0)),
                        float(mat.get("damage1", 0.0)), float(mat.get("damage2", 0.0)),
                        float(mat.get("beta", 0.0)),
                    )
                elif kind == "Elastic":
                    ops.uniaxialMaterial("Elastic", tag, float(mat.get("stiffness", 1e6)))
                else:
                    ops.uniaxialMaterial("Elastic", tag, 1e6)
            except Exception as exc:
                ops.uniaxialMaterial("Elastic", tag, 1e6)

    def _define_geometry(self) -> None:
        ops  = self._ops
        max_h = 0.0
        top_nodes: list[tuple[int, str]] = []

        for wall in self.walls_cfg:
            h     = float(wall.get("height_m",    3.0))
            lw    = float(wall.get("length_m",    4.0))
            tw    = float(wall.get("thickness_m", 0.2))
            x0    = float(wall.get("x0_m", 0.0))
            y0    = float(wall.get("y0_m", 0.0))
            wdir  = wall.get("direction", "X")
            form  = wall.get("formulation", "E_SFI_MVLEM_3D")
            c_rot = float(wall.get("c_rot",     0.4))
            tkm   = float(wall.get("thick_mod", 0.63))
            nu    = float(wall.get("poisson",   0.25))
            dens  = float(wall.get("density_t_m3", 2.4))
            mf    = wall.get("macrofibers", [])
            max_h = max(max_h, h)

            # Corner nodes: i=bot-left, j=bot-right, k=top-right, l=top-left
            if wdir == "X":
                xi, yi, xj, yj = x0, y0, x0 + lw, y0
            else:
                xi, yi, xj, yj = x0, y0, x0, y0 + lw

            ni = self._next_node(); ops.node(ni, xi, yi, 0.0)
            nj = self._next_node(); ops.node(nj, xj, yj, 0.0)
            nk = self._next_node(); ops.node(nk, xj, yj, h)
            nl = self._next_node(); ops.node(nl, xi, yi, h)

            ops.fix(ni, 1,1,1,1,1,1)
            ops.fix(nj, 1,1,1,1,1,1)
            self._base_nodes.extend([ni, nj])

            top_nodes.append((nl, wdir))
            top_nodes.append((nk, wdir))

            # Macrofiber data
            if mf:
                n_fib   = len(mf)
                thick_v = [float(f.get("thickness_m",     tw))          for f in mf]
                width_v = [float(f.get("width_m",     lw / n_fib))      for f in mf]
                rho_v   = [float(f.get("rho_vertical",    0.005))        for f in mf]
                mat_c   = [self._mat_tag.get(f.get("concrete_material_id",""), 1) for f in mf]
                mat_sv  = [self._mat_tag.get(f.get("steel_v_material_id",""),  2) for f in mf]
            else:
                n_fib   = int(wall.get("n_fibers", 8))
                thick_v = [tw] * n_fib
                width_v = [lw / n_fib] * n_fib
                rho_v   = [0.005] * n_fib
                c_mats  = [m for m,d in self.materials_cfg.items() if d.get("kind") in ("ConcreteCM","Concrete02")]
                s_mats  = [m for m,d in self.materials_cfg.items() if d.get("kind") in ("Hysteretic","HystereticSM")]
                c_tag   = self._mat_tag.get(c_mats[0] if c_mats else "", 1)
                s_tag   = self._mat_tag.get(s_mats[0] if s_mats else "", 2)
                mat_c   = [c_tag] * n_fib
                mat_sv  = [s_tag] * n_fib

            eid = self._next_ele()
            if form == "MVLEM_3D":
                sh_tag = self._next_mat()
                ops.uniaxialMaterial("Elastic", sh_tag, 1e4)
                ops.element(
                    "MVLEM_3D", eid, ni, nj, nk, nl, n_fib,
                    "-thick", *thick_v, "-width", *width_v, "-rho", *rho_v,
                    "-matConcrete", *mat_c, "-matSteel", *mat_sv,
                    "-matShear", sh_tag,
                    "-CoR", c_rot, "-ThickMod", tkm, "-Poisson", nu, "-Density", dens,
                )
            else:  # E_SFI_MVLEM_3D (default)
                ops.element(
                    "E_SFI_MVLEM_3D", eid, ni, nj, nk, nl, n_fib,
                    "-thick", *thick_v, "-width", *width_v, "-rho", *rho_v,
                    "-matConcrete", *mat_c, "-matSteel", *mat_sv,
                    "-CoR", c_rot, "-ThickMod", tkm, "-Poisson", nu, "-Density", dens,
                )

        self._total_height = max_h
        self._top_nodes    = top_nodes
        if top_nodes:
            self._control_node = top_nodes[0][0]

    # ── Gravity analysis ──────────────────────────────────────────────────────

    def run_gravity(
        self,
        axial_loads_kN: dict[str, float] | None = None,
        steps: int = 10,
    ) -> dict:
        """
        Incremental gravity analysis using LoadControl.

        axial_loads_kN: optional mapping wall_id → axial load (kN, compression positive)
        applied as nodal point load at both top nodes of each wall.
        Self-weight handled by element Density parameter.
        """
        ops = self._ops

        ops.timeSeries("Linear", 1)
        ops.pattern("Plain", 1, 1)

        if axial_loads_kN:
            for i, wall in enumerate(self.walls_cfg):
                wid = wall.get("id", f"w{i}")
                P   = float(axial_loads_kN.get(wid, 0.0))
                if abs(P) > 0 and len(self._top_nodes) > 2 * i + 1:
                    nl_tag = self._top_nodes[2 * i][0]
                    nk_tag = self._top_nodes[2 * i + 1][0]
                    ops.load(nl_tag, 0.0, 0.0, -P / 2.0, 0.0, 0.0, 0.0)
                    ops.load(nk_tag, 0.0, 0.0, -P / 2.0, 0.0, 0.0, 0.0)

        ops.system("BandGeneral")
        ops.numberer("RCM")
        ops.constraints("Plain")
        ops.test("NormDispIncr", 1.0e-6, 30, 0)
        ops.algorithm("Newton")
        ops.integrator("LoadControl", 1.0 / steps)
        ops.analysis("Static")
        ok = ops.analyze(steps)

        if ok != 0:
            ops.algorithm("ModifiedNewton")
            ok = ops.analyze(steps - 1)

        ops.loadConst("-time", 0.0)

        return {"status": "success" if ok == 0 else "partial", "steps_run": steps}

    # ── Modal analysis ────────────────────────────────────────────────────────

    def run_modal(self, n_modes: int = 6) -> dict:
        """Eigenvalue analysis — returns periods, frequencies, eigenvalues."""
        ops = self._ops
        # Active DOF = top nodes × 6 (base nodes are fully fixed)
        n_active_dof = len(self._top_nodes) * 6
        n_modes = min(n_modes, max(1, n_active_dof))
        try:
            lam = ops.eigen(n_modes)
        except Exception as exc:
            return {"status": "failed", "message": str(exc)}

        periods = []
        freqs   = []
        for l in lam:
            if l > 1e-12:
                T = 2.0 * math.pi / math.sqrt(l)
                periods.append(round(T, 6))
                freqs.append(round(1.0 / T, 4))
            else:
                periods.append(0.0)
                freqs.append(0.0)

        return {
            "status":      "success",
            "n_modes":     n_modes,
            "eigenvalues": [float(l) for l in lam],
            "periods_s":   periods,
            "frequencies_hz": freqs,
        }

    # ── Pushover analysis ─────────────────────────────────────────────────────

    def run_pushover(
        self,
        direction:       str   = "X",
        target_drift_pct: float = 2.0,
        inc_m:           float = 0.001,
        result_path:     Path | None = None,
        cancel_flag:     list[bool] | None = None,  # cancel_flag[0]=True to stop
    ) -> dict:
        """
        Displacement-controlled lateral pushover.

        direction: "X" | "-X" | "Y" | "-Y"
        Writes partial results to result_path after every converged step.
        """
        ops = self._ops

        if not self._control_node:
            return {"status": "failed", "message": "No control node — build the model first"}

        sign = -1.0 if direction.startswith("-") else 1.0
        axis = direction.lstrip("-")
        dof  = 1 if axis == "X" else 2

        target_disp = sign * (target_drift_pct / 100.0) * self._total_height
        n_steps     = max(10, int(abs(target_disp) / abs(inc_m)))

        # Lateral load pattern — uniform height (single story) or first-mode shape
        ops.timeSeries("Linear", 2)
        ops.pattern("Plain", 2, 2)

        for n_tag, n_dir in self._top_nodes:
            f = 1.0 if n_dir == axis else 0.0
            if dof == 1:
                ops.load(n_tag, sign * f, 0.0, 0.0, 0.0, 0.0, 0.0)
            else:
                ops.load(n_tag, 0.0, sign * f, 0.0, 0.0, 0.0, 0.0)

        ops.system("BandGeneral")
        ops.numberer("RCM")
        ops.constraints("Plain")
        ops.integrator("DisplacementControl", self._control_node, dof, sign * inc_m)
        ops.analysis("Static")

        steps     = []
        converged = 0
        failed    = False

        for i in range(n_steps):
            if cancel_flag and cancel_flag[0]:
                break

            ok = self._try_step()

            if ok != 0:
                failed = True
                break

            converged += 1
            ctrl_disp  = float(ops.nodeDisp(self._control_node, dof))
            base_shear = self._base_shear(dof)
            drift_pct  = abs(ctrl_disp) / self._total_height * 100.0

            steps.append({
                "step":           converged,
                "displacement_m": round(ctrl_disp, 6),
                "drift_pct":      round(drift_pct, 4),
                "base_shear_kN":  round(base_shear, 2),
            })

            if result_path:
                self._write_partial(result_path, direction, steps, "running", n_steps, converged)

        status = (
            "success" if converged == n_steps
            else ("partial" if converged > 0 else "failed")
        )

        result = {
            "status":          status,
            "direction":       direction,
            "converged_steps": converged,
            "total_steps":     n_steps,
            "target_drift_pct": target_drift_pct,
            "steps":           steps,
            "summary": {
                "max_drift_pct":      max((s["drift_pct"]     for s in steps), default=0.0),
                "max_base_shear_kN":  max((s["base_shear_kN"] for s in steps), default=0.0),
                "last_displacement_m": steps[-1]["displacement_m"] if steps else 0.0,
            } if steps else {},
        }

        if result_path:
            self._write_partial(result_path, direction, steps, status, n_steps, converged)

        return result

    def _try_step(self) -> int:
        ops = self._ops
        algorithms = [
            ("Newton",         {"test": ("NormDispIncr", 1e-5, 25, 0)}),
            ("Newton",         {"test": ("NormDispIncr", 1e-4, 35, 0), "flag": "-initial"}),
            ("ModifiedNewton", {"test": ("NormDispIncr", 1e-4, 50, 0)}),
            ("KrylovNewton",   {"test": ("NormDispIncr", 1e-3, 50, 0)}),
        ]
        for alg, cfg in algorithms:
            ops.test(*cfg["test"])
            if "flag" in cfg:
                ops.algorithm(alg, cfg["flag"])
            else:
                ops.algorithm(alg)
            ok = ops.analyze(1)
            if ok == 0:
                return 0
        return -1

    def _base_shear(self, dof: int) -> float:
        ops = self._ops
        ops.reactions()  # required to update reaction storage before nodeReaction()
        total = 0.0
        for n in self._base_nodes:
            try:
                total += ops.nodeReaction(n, dof)
            except Exception:
                pass
        return -total

    def _write_partial(
        self, path: Path, direction: str, steps: list,
        status: str, total: int, converged: int,
    ) -> None:
        tmp = path.with_suffix(".tmp")
        payload = {
            "status": status, "direction": direction,
            "converged_steps": converged, "total_steps": total,
            "steps": steps,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        tmp.replace(path)

    def wipe(self) -> None:
        try:
            self._ops.wipe()
        except Exception:
            pass
