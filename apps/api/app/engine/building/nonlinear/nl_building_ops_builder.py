"""
NLBuildingOPSBuilder — Modelo MVLEM_3D no lineal para pushover de edificio de muros.

Construye el dominio OpenSees con elementos MVLEM_3D con fibras no lineales
(Concrete02 + Steel02) distribuidas conforme al diseño RC por pier.

Toma:
  - model      : canonical_model.json (geometría, masas, materiales)
  - raw_data   : tablas ETABS del XLSX (mismas que WallModelBuilder)
  - design_rows: lista de dicts de wall_design_results.json["designs"]

Unidades: m · kN · s  (E, Gc, Ks en kPa = kN/m²)
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import pandas as pd

_K_PIER_PROPS  = 'TABLE:  "PIER SECTION PROPERTIES"'
_K_PIER_SPANDR = 'TABLE:  "SHELL ASSIGNMENTS - PIER SPANDR"'
_K_SHELLS      = 'TABLE:  "OBJECTS AND ELEMENTS - SHELLS"'
_K_SH_WALL     = 'TABLE:  "SHELL SECTIONS - WALL"'
_K_SH_ASSIGN   = 'TABLE:  "SHELL ASSIGNMENTS - SECTIONS"'

_NODE_WALL_OFFSET = 20_000_000
_NODE_CM_OFFSET   = 10_000_000
_ELE_WALL_OFFSET  = 50_000_000
_MAT_START        = 1_000_000
_NU               = 0.2      # Poisson del concreto


def _f(val, default: float = 0.0) -> float:
    try:
        v = float(val)
        return v if math.isfinite(v) else default
    except (TypeError, ValueError):
        return default


def _s(val, default: str = "") -> str:
    if val is None or (isinstance(val, float) and math.isnan(val)):
        return default
    return str(val).strip()


class NLBuildingOPSBuilder:
    """
    Modelo no lineal MVLEM_3D de edificio de muros para pushover.

    Fibras Concrete02 (confinado EBE + no confinado alma) + Steel02.
    Un elemento MVLEM_3D por pier × story, con corte elástico equivalente.
    """

    def __init__(
        self,
        model:       dict,          # canonical_model.json
        raw_data:    dict,          # tablas ETABS del XLSX
        design_rows: list[dict],    # wall_design_results.json["designs"]
        fc_mpa:      float = 21.0,  # fc fallback si no está en el material
        fy_mpa:      float = 420.0, # fy acero longitudinal
        n_fibers:    int   = 10,    # macrofibras por pier
    ):
        self._m        = model
        self._rd       = raw_data
        self._n_fibers = n_fibers
        self._fc_def   = fc_mpa
        self._fy_mpa   = fy_mpa

        # Índice de diseño (pier, story) → fila compacta del diseño
        self._design: dict[tuple, dict] = {
            (r["pier"], r["story"]): r for r in (design_rows or [])
        }

        self._stories_order: list[str]         = []
        self._stories_z:     dict[str, float]  = {}
        self._joint_xy:      dict[str, tuple]  = {}

        self._pier_geom:      dict[tuple, dict]    = {}
        self._node_map:       dict[tuple, int]     = {}
        self._ele_map:        dict[tuple, int]     = {}
        self._cm_map:         dict[str, dict]      = {}
        self._wall_top_nodes: dict[str, list[int]] = {}
        self._base_nodes:     list[int]            = []

        self._node_ctr = _NODE_WALL_OFFSET
        self._ele_ctr  = _ELE_WALL_OFFSET
        self._mat_ctr  = _MAT_START

        # Caches de materiales (evitan duplicados)
        self._mat_unc:   dict[float, int] = {}  # fc_mpa → Concrete02 no confinado
        self._mat_cfd:   dict[float, int] = {}  # fc_mpa*K → Concrete02 confinado
        self._mat_stl:   dict[float, int] = {}  # fy_mpa → Steel02
        self._mat_shr:   dict[int,   int] = {}  # round(Ks) → Elastic shear

        self._ops = None

    # ── API pública ───────────────────────────────────────────────────────────

    def build(self) -> dict:
        """
        Construye el dominio OpenSees (queda ACTIVO para análisis posterior).

        Returns:
            cm_nodes, base_nodes, control_node, stories_order,
            stories_z, total_height, pier_elements
        """
        import openseespy.opensees as ops
        self._ops = ops

        ops.wipe()
        ops.model("basic", "-ndm", 3, "-ndf", 6)

        self._load_stories()
        self._load_joints()
        self._extract_pier_geometry()

        if not self._pier_geom:
            raise ValueError("No se encontraron pieres válidos en el modelo.")

        self._create_pier_nodes()
        self._fix_base_nodes()
        self._create_mvlem_elements()
        self._create_cm_nodes()
        self._apply_diaphragms()

        total_h   = max(self._stories_z.values(), default=0.0)
        roof      = self._stories_order[-1] if self._stories_order else ""
        ctrl_node = self._cm_map.get(roof, {}).get("tag")

        # Metadata para reconstruir cada pier deformable en el frontend:
        # asocia tag de nodo (ni,nj,nk,nl) → coords de referencia y (pier,story).
        pier_lines: list[dict] = []
        for (pier, story), g in self._pier_geom.items():
            idx = g["story_idx"]
            pier_lines.append({
                "pier":       pier,
                "story":      story,
                "story_idx":  idx,
                "coords_ref": {
                    "base_left":  [g["x1"], g["y1"], g["z_base"]],
                    "base_right": [g["x2"], g["y2"], g["z_base"]],
                    "top_right":  [g["x2"], g["y2"], g["z_top"]],
                    "top_left":   [g["x1"], g["y1"], g["z_top"]],
                },
                "node_tags": {
                    "base_left":  self._node_map[(pier, idx - 1, 0)],
                    "base_right": self._node_map[(pier, idx - 1, 1)],
                    "top_right":  self._node_map[(pier, idx,     1)],
                    "top_left":   self._node_map[(pier, idx,     0)],
                },
                "lw_m": g["lw"],
                "tw_m": g["tw"],
                "hw_m": g["hw"],
            })

        return {
            "cm_nodes":      self._cm_map,
            "base_nodes":    self._base_nodes,
            "control_node":  ctrl_node,
            "stories_order": self._stories_order,
            "stories_z":     self._stories_z,
            "total_height":  total_h,
            "pier_elements": self._ele_map,
            "pier_lines":    pier_lines,
        }

    def run_gravity(
        self,
        pier_pu: dict,   # (pier, story) → Pu_kN (compresión positiva)
        steps:   int = 10,
    ) -> dict:
        """
        Análisis gravitacional incremental (LoadControl).
        Aplica Pu por pier como carga puntual en nodos top (dividida en 2).
        Bloquea las cargas con loadConst al terminar.
        """
        ops = self._ops
        ops.timeSeries("Linear", 1)
        ops.pattern("Plain", 1, 1)

        for (pier, story), Pu in pier_pu.items():
            if abs(Pu) < 0.1:
                continue
            if story not in self._stories_order:
                continue
            idx = self._stories_order.index(story)
            if idx <= 0:
                continue
            nl_tag = self._node_map.get((pier, idx, 0))
            nk_tag = self._node_map.get((pier, idx, 1))
            for tag in [nl_tag, nk_tag]:
                if tag:
                    ops.load(tag, 0.0, 0.0, -Pu / 2.0, 0.0, 0.0, 0.0)

        ops.system("BandGeneral")
        ops.numberer("RCM")
        ops.constraints("Transformation")
        ops.test("NormDispIncr", 1.0e-6, 30, 0)
        ops.algorithm("Newton")
        ops.integrator("LoadControl", 1.0 / steps)
        ops.analysis("Static")

        ok = ops.analyze(steps)
        if ok != 0:
            ops.algorithm("ModifiedNewton")
            ok = ops.analyze(steps)

        ops.loadConst("-time", 0.0)
        return {"status": "success" if ok == 0 else "partial"}

    def run_pushover(
        self,
        direction:        str   = "X",
        target_drift_pct: float = 2.0,
        inc_m:            float = 0.001,
        result_path:      Path | None = None,
        cancel_flag:      list[bool] | None = None,
        history_path:     Path | None = None,
        history_stride:   int = 1,
    ) -> dict:
        """
        Pushover desplazamiento-controlado con carga triangular en nodos CM.
        Nodo de control: CM de la azotea.

        Si `history_path` está definido, guarda un NPZ comprimido con:
          - disp_cm    : (n_steps, n_cm, 3)      desplazamientos u,v,w de CM
          - disp_top   : (n_steps, n_top, 3)     desplazamientos wall_top nodes
          - ele_force  : (n_steps, n_ele, n_dof) fuerzas de cada MVLEM_3D
          - metadata   : mapeo de nodos y elementos con story/pier
        Se usa `history_stride` para submuestrear (1 = cada paso).
        """
        ops = self._ops
        total_h = max(self._stories_z.values(), default=1.0)
        roof    = self._stories_order[-1] if self._stories_order else ""
        ctrl    = self._cm_map.get(roof, {}).get("tag")

        if not ctrl:
            return {"status": "failed", "message": "Sin nodo de control (CM azotea)."}

        sign = -1.0 if direction.startswith("-") else 1.0
        axis = direction.lstrip("-")
        dof  = 1 if axis == "X" else 2

        target_disp = sign * (target_drift_pct / 100.0) * total_h
        n_steps     = max(10, int(abs(target_disp) / abs(inc_m)))

        # Patrón triangular: fuerza proporcional a la altura del CM de cada piso
        ops.timeSeries("Linear", 2)
        ops.pattern("Plain", 2, 2)

        cm_list = [(info["tag"], info["z"]) for info in self._cm_map.values()]
        total_z = sum(z for _, z in cm_list) or 1.0
        for cm_tag, z in cm_list:
            fi = sign * (z / total_z)
            load = [fi, 0.0, 0.0, 0.0, 0.0, 0.0] if dof == 1 else [0.0, fi, 0.0, 0.0, 0.0, 0.0]
            ops.load(cm_tag, *load)

        ops.system("BandGeneral")
        ops.numberer("RCM")
        ops.constraints("Transformation")
        ops.integrator("DisplacementControl", ctrl, dof, sign * inc_m)
        ops.analysis("Static")

        steps_out = []
        converged = 0

        # ── Captura de historia (deformada + fuerzas por paso) ────────────────
        capture      = history_path is not None
        cm_tags      = [info["tag"] for _, info in sorted(
                            self._cm_map.items(), key=lambda kv: self._stories_z.get(kv[0], 0.0))]
        top_tags     = sorted({t for tags in self._wall_top_nodes.values() for t in tags})
        ele_items    = sorted(self._ele_map.items(), key=lambda kv: kv[1])
        ele_tags     = [tag for _, tag in ele_items]

        hist_disp_cm:   list[list[list[float]]] = []
        hist_disp_top:  list[list[list[float]]] = []
        hist_ele_force: list[list[list[float]]] = []

        def _capture_step() -> None:
            if not capture:
                return
            hist_disp_cm.append([
                [float(ops.nodeDisp(t, 1)), float(ops.nodeDisp(t, 2)), float(ops.nodeDisp(t, 3))]
                for t in cm_tags
            ])
            hist_disp_top.append([
                [float(ops.nodeDisp(t, 1)), float(ops.nodeDisp(t, 2)), float(ops.nodeDisp(t, 3))]
                for t in top_tags
            ])
            forces_step: list[list[float]] = []
            for t in ele_tags:
                try:
                    f = ops.eleForce(t)
                except Exception:
                    f = []
                forces_step.append([float(v) for v in f])
            hist_ele_force.append(forces_step)

        for step_idx in range(n_steps):
            if cancel_flag and cancel_flag[0]:
                break
            if self._try_step() != 0:
                break
            converged += 1
            ctrl_disp  = float(ops.nodeDisp(ctrl, dof))
            base_shear = self._base_shear(dof)
            drift_pct  = abs(ctrl_disp) / total_h * 100.0

            steps_out.append({
                "step":           converged,
                "displacement_m": round(ctrl_disp, 6),
                "drift_pct":      round(drift_pct, 4),
                "base_shear_kN":  round(base_shear, 2),
            })

            # Submuestrea historia (stride) para reducir tamaño
            if capture and (converged % max(1, history_stride) == 0):
                _capture_step()

            if result_path:
                self._write_partial(result_path, direction, steps_out,
                                    "running", n_steps, converged)

        # ── Serialización de historia ─────────────────────────────────────────
        history_meta: dict | None = None
        if capture and hist_disp_cm:
            import numpy as _np
            history_path.parent.mkdir(parents=True, exist_ok=True)
            _np.savez_compressed(
                history_path,
                disp_cm    = _np.asarray(hist_disp_cm,   dtype=_np.float32),
                disp_top   = _np.asarray(hist_disp_top,  dtype=_np.float32),
                ele_force  = _np.asarray(hist_ele_force, dtype=_np.float32),
                cm_tags    = _np.asarray(cm_tags,        dtype=_np.int64),
                top_tags   = _np.asarray(top_tags,       dtype=_np.int64),
                ele_tags   = _np.asarray(ele_tags,       dtype=_np.int64),
            )
            history_meta = {
                "path":           str(history_path),
                "captured_steps": len(hist_disp_cm),
                "stride":         history_stride,
                "cm_nodes": [
                    {"tag": t, "story": s, "x": info["x"], "y": info["y"], "z": info["z"]}
                    for s, info in self._cm_map.items()
                    for t in [info["tag"]] if info["tag"] in cm_tags
                ],
                "top_nodes": [{"tag": int(t)} for t in top_tags],
                "elements": [
                    {"tag": int(tag), "pier": pier, "story": story}
                    for (pier, story), tag in ele_items
                ],
            }

        status = (
            "success" if converged == n_steps
            else ("partial" if converged > 0 else "failed")
        )
        result = {
            "status":           status,
            "direction":        direction,
            "converged_steps":  converged,
            "total_steps":      n_steps,
            "target_drift_pct": target_drift_pct,
            "steps":            steps_out,
            "summary": {
                "max_drift_pct":       max((s["drift_pct"]     for s in steps_out), default=0.0),
                "max_base_shear_kN":   max((s["base_shear_kN"] for s in steps_out), default=0.0),
                "last_displacement_m": steps_out[-1]["displacement_m"] if steps_out else 0.0,
            } if steps_out else {},
        }
        if history_meta:
            result["history"] = history_meta
        if result_path:
            self._write_partial(result_path, direction, steps_out, status, n_steps, converged)
        return result

    def wipe(self) -> None:
        if self._ops:
            try:
                self._ops.wipe()
            except Exception:
                pass

    # ── Carga de datos ────────────────────────────────────────────────────────

    def _load_stories(self) -> None:
        stories = self._m.get("stories", {})
        self._stories_z     = {s: d["elevation_m"] for s, d in stories.items()}
        self._stories_order = sorted(stories, key=lambda s: stories[s]["elevation_m"])

    def _load_joints(self) -> None:
        for label, jd in self._m.get("joints", {}).items():
            self._joint_xy[label] = (float(jd.get("x", 0.0)), float(jd.get("y", 0.0)))

    def _extract_pier_geometry(self) -> None:
        pier_props_df  = self._rd.get(_K_PIER_PROPS)
        pier_spandr_df = self._rd.get(_K_PIER_SPANDR)
        shells_df      = self._rd.get(_K_SHELLS)
        sh_wall_df     = self._rd.get(_K_SH_WALL)
        sh_assign_df   = self._rd.get(_K_SH_ASSIGN)
        materials      = self._m.get("materials", {})

        if not isinstance(pier_props_df, pd.DataFrame) or pier_props_df.empty:
            return

        elem_to_sec: dict[str, str] = {}
        if isinstance(sh_assign_df, pd.DataFrame):
            lc = "Unique Name" if "Unique Name" in sh_assign_df.columns else "Element Label"
            for _, r in sh_assign_df.iterrows():
                lbl = _s(r.get(lc, "")); sec = _s(r.get("Section", ""))
                if lbl and sec:
                    elem_to_sec[lbl] = sec

        sec_to_mat: dict[str, str] = {}
        if isinstance(sh_wall_df, pd.DataFrame):
            for _, r in sh_wall_df.iterrows():
                sec = _s(r.get("Name", "")); mat = _s(r.get("Material", ""))
                if sec:
                    sec_to_mat[sec] = mat

        shell_to_joints: dict[str, list[str]] = {}
        if isinstance(shells_df, pd.DataFrame):
            for _, r in shells_df.iterrows():
                lbl = _s(r.get("Element Label", ""))
                js  = [_s(r.get(f"Joint {i}", "")) for i in range(1, 5)]
                if lbl:
                    shell_to_joints[lbl] = [j for j in js if j]

        ps_shells: dict[tuple, list[str]] = {}
        if isinstance(pier_spandr_df, pd.DataFrame):
            for _, r in pier_spandr_df.iterrows():
                pier  = _s(r.get("Pier",  ""))
                story = _s(r.get("Story", ""))
                lbl   = _s(r.get("Unique Name", ""))
                if pier and story and lbl:
                    ps_shells.setdefault((pier, story), []).append(lbl)

        for _, row in pier_props_df.iterrows():
            story = _s(row.get("Story", ""))
            pier  = _s(row.get("Pier",  ""))
            lw    = _f(row.get("Length",    0.0))
            tw    = _f(row.get("Thickness", 0.2))

            if not pier or not story or lw < 0.01 or story not in self._stories_order:
                continue
            idx = self._stories_order.index(story)
            if idx == 0:
                continue

            z_top  = self._stories_z[story]
            z_base = self._stories_z[self._stories_order[idx - 1]]
            hw     = z_top - z_base
            if hw < 0.01:
                continue

            shells_here = ps_shells.get((pier, story), [])
            all_jl: list[str] = []
            for sl in shells_here:
                all_jl.extend(shell_to_joints.get(sl, []))

            unique_coords: list[tuple] = []
            seen: set = set()
            for jl in all_jl:
                xy = self._joint_xy.get(jl)
                if xy and xy not in seen:
                    seen.add(xy); unique_coords.append(xy)

            if len(unique_coords) < 2:
                continue

            x1 = y1 = x2 = y2 = 0.0
            max_d = 0.0
            for i in range(len(unique_coords)):
                for j in range(i + 1, len(unique_coords)):
                    d = math.hypot(unique_coords[j][0] - unique_coords[i][0],
                                   unique_coords[j][1] - unique_coords[i][1])
                    if d > max_d:
                        max_d = d
                        x1, y1 = unique_coords[i]
                        x2, y2 = unique_coords[j]

            fc_mpa = self._fc_def
            Ec_kPa = 25_000_000.0
            if shells_here:
                sec  = elem_to_sec.get(shells_here[0], "")
                mn   = sec_to_mat.get(sec, "")
                mdat = materials.get(mn, {})
                if mdat:
                    Ec_kPa = mdat.get("E_mpa", 25000.0) * 1000.0
                    fc_mpa = mdat.get("fpc_mpa", self._fc_def)

            self._pier_geom[(pier, story)] = {
                "lw": lw, "tw": tw, "hw": hw,
                "z_base": z_base, "z_top": z_top,
                "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                "fc_mpa": fc_mpa,
                "Ec_kPa": Ec_kPa,
                "story_idx": idx,
            }

    # ── Materiales ────────────────────────────────────────────────────────────

    def _next_mat(self) -> int:
        self._mat_ctr += 1
        return self._mat_ctr

    def _get_unconf(self, fc: float) -> int:
        k = round(fc, 2)
        if k not in self._mat_unc:
            tag    = self._next_mat()
            fc_kPa = fc * 1000.0
            self._ops.uniaxialMaterial(
                "Concrete02", tag,
                -fc_kPa, -0.002,
                -0.2 * fc_kPa, -0.006,
                0.1, 0.0, 0.0,
            )
            self._mat_unc[k] = tag
        return self._mat_unc[k]

    def _get_conf(self, fc: float, K: float = 1.3) -> int:
        k = round(fc * K, 3)
        if k not in self._mat_cfd:
            tag   = self._next_mat()
            fcc   = fc * K * 1000.0      # kPa
            epscc = 0.004
            epscu = 0.016                 # 4 × epscc (Mander)
            ft    = 0.1 * fcc
            Ets   = ft / 0.002
            self._ops.uniaxialMaterial(
                "Concrete02", tag,
                -fcc, -epscc,
                -0.2 * fcc, -epscu,
                0.1, ft, Ets,
            )
            self._mat_cfd[k] = tag
        return self._mat_cfd[k]

    def _get_steel(self, fy: float) -> int:
        k = round(fy, 1)
        if k not in self._mat_stl:
            tag = self._next_mat()
            self._ops.uniaxialMaterial(
                "Steel02", tag,
                fy * 1000.0,          # Fy [kPa]
                200_000_000.0,         # E0 = 200 GPa [kPa]
                0.01,                  # b (hardening)
                15.0, 0.925, 0.15,     # R0, cR1, cR2
            )
            self._mat_stl[k] = tag
        return self._mat_stl[k]

    def _get_shear(self, Ks: float) -> int:
        k = round(Ks)
        if k not in self._mat_shr:
            tag = self._next_mat()
            self._ops.uniaxialMaterial("Elastic", tag, max(Ks, 1.0))
            self._mat_shr[k] = tag
        return self._mat_shr[k]

    # ── Nodos ─────────────────────────────────────────────────────────────────

    def _create_pier_nodes(self) -> None:
        ops = self._ops
        self._wall_top_nodes = {s: [] for s in self._stories_order}

        for (pier, story), g in self._pier_geom.items():
            idx    = g["story_idx"]
            x1, y1 = g["x1"], g["y1"]
            x2, y2 = g["x2"], g["y2"]

            for side, (xn, yn) in enumerate([(x1, y1), (x2, y2)]):
                key = (pier, idx - 1, side)
                if key not in self._node_map:
                    self._node_ctr += 1
                    self._node_map[key] = self._node_ctr
                    ops.node(self._node_ctr, xn, yn, g["z_base"])

            for side, (xn, yn) in enumerate([(x1, y1), (x2, y2)]):
                key = (pier, idx, side)
                if key not in self._node_map:
                    self._node_ctr += 1
                    self._node_map[key] = self._node_ctr
                    ops.node(self._node_ctr, xn, yn, g["z_top"])
                    self._wall_top_nodes[story].append(self._node_ctr)

    def _fix_base_nodes(self) -> None:
        for (pier, bnd_idx, side), tag in self._node_map.items():
            if bnd_idx == 0:
                self._ops.fix(tag, 1, 1, 1, 1, 1, 1)
                if tag not in self._base_nodes:
                    self._base_nodes.append(tag)

    # ── Discretización de fibras ──────────────────────────────────────────────

    def _discretize(
        self, pier: str, story: str, lw: float, tw: float, fc: float,
    ) -> tuple[list, list, list, list, list]:
        """
        Genera vectores (thick, width, rho_v, mat_conc, mat_steel) para MVLEM_3D.

        Layout con EBE: [EBE_izq (n_lc fib)] [alma (n_web)] [EBE_der (n_lc fib)]
        Sin EBE: fibras uniformes con rho_v del alma.
        """
        n  = self._n_fibers
        ds = self._design.get((pier, story))
        mc_unc = self._get_unconf(fc)
        ms     = self._get_steel(self._fy_mpa)

        if ds is None or not ds.get("ebe_required", False):
            rv = float((ds or {}).get("rho_v_pct", 0.25)) / 100.0
            rv = max(rv, 0.0025)
            return ([tw]*n, [lw/n]*n, [rv]*n, [mc_unc]*n, [ms]*n)

        mc_cf = self._get_conf(fc)

        # Longitud del elemento de borde
        lc   = float(ds.get("be_lc_m", ds.get("lc_m", 0.1)))
        lc   = min(max(lc, 0.05), lw / 3.0)
        lw_w = max(lw - 2.0 * lc, 0.05)

        rho_web = max(float(ds.get("rho_v_pct", 0.25)) / 100.0, 0.0025)

        # ρ_v EBE desde barras de diseño
        n_bars = int(ds.get("be_n_bars", 4))
        db_m   = float(ds.get("be_db_mm", 16.0)) / 1000.0
        As_be  = n_bars * math.pi * (db_m / 2.0) ** 2
        rho_be = min(As_be / (lc * tw), 0.08)
        rho_be = max(rho_be, rho_web)

        # Fibras por zona
        n_lc  = max(1, round(n * lc / lw))
        n_lc  = min(n_lc, (n - 2) // 2)
        n_lc  = max(n_lc, 1)
        n_web = max(n - 2 * n_lc, 1)
        m     = n_lc + n_web + n_lc

        thick = [tw] * m
        width = [lc / n_lc] * n_lc + [lw_w / n_web] * n_web + [lc / n_lc] * n_lc
        rho   = [rho_be] * n_lc   + [rho_web] * n_web        + [rho_be] * n_lc
        mat_c = [mc_cf] * n_lc    + [mc_unc] * n_web          + [mc_cf] * n_lc
        mat_s = [ms] * m

        return (thick, width, rho, mat_c, mat_s)

    # ── Elementos MVLEM_3D ────────────────────────────────────────────────────

    def _create_mvlem_elements(self) -> None:
        ops = self._ops

        for (pier, story), g in self._pier_geom.items():
            idx    = g["story_idx"]
            lw, tw = g["lw"], g["tw"]
            fc     = g["fc_mpa"]

            ni = self._node_map[(pier, idx - 1, 0)]
            nj = self._node_map[(pier, idx - 1, 1)]
            nk = self._node_map[(pier, idx,     1)]
            nl = self._node_map[(pier, idx,     0)]

            thick, width, rho, mat_c, mat_s = self._discretize(pier, story, lw, tw, fc)
            m = len(thick)

            # Resorte de corte elástico (Gc × lw × tw)
            Gc = g["Ec_kPa"] / (2.0 * (1.0 + _NU))
            sh = self._get_shear(Gc * lw * tw)

            self._ele_ctr += 1
            ops.element(
                "MVLEM_3D", self._ele_ctr,
                ni, nj, nk, nl, m,
                "-thick",       *thick,
                "-width",       *width,
                "-rho",         *rho,
                "-matConcrete", *mat_c,
                "-matSteel",    *mat_s,
                "-matShear",    sh,
                "-CoR",         0.4,
                "-Poisson",     _NU,
            )
            self._ele_map[(pier, story)] = self._ele_ctr

    # ── Nodos CM y diafragmas ─────────────────────────────────────────────────

    def _create_cm_nodes(self) -> None:
        ops = self._ops
        for idx, (_, md) in enumerate(self._m.get("masses", {}).items()):
            story = str(md.get("story", ""))
            tag   = _NODE_CM_OFFSET + idx + 1
            x = float(md.get("x_cm_m", 0.0))
            y = float(md.get("y_cm_m", 0.0))
            z = float(md.get("z_m",    0.0))
            ops.node(tag, x, y, z)
            ops.mass(tag,
                     float(md.get("mass_x_t",    1.0)),
                     float(md.get("mass_y_t",    1.0)),
                     0.0, 0.0, 0.0,
                     float(md.get("mass_rz_tm2", 1.0)))
            ops.fix(tag, 0, 0, 1, 1, 1, 0)
            self._cm_map[story] = {"tag": tag, "x": x, "y": y, "z": z}

    def _apply_diaphragms(self) -> None:
        ops = self._ops
        for story, cm_info in self._cm_map.items():
            slaves = self._wall_top_nodes.get(story, [])
            if not slaves:
                continue
            for tag in slaves:
                ops.fix(tag, 0, 0, 0, 1, 1, 0)
            try:
                ops.rigidDiaphragm(3, cm_info["tag"], *slaves)
            except Exception as e:
                print(f"[NLBuildingOPSBuilder] rigidDiaphragm {story}: {e}")

    # ── Análisis helpers ──────────────────────────────────────────────────────

    def _try_step(self) -> int:
        ops = self._ops
        for alg, test_tol, test_iter, alg_args in [
            ("Newton",         1e-5, 25, ()),
            ("Newton",         1e-4, 35, ("-initial",)),
            ("ModifiedNewton", 1e-4, 50, ()),
            ("KrylovNewton",   1e-3, 50, ()),
        ]:
            ops.test("NormDispIncr", test_tol, test_iter, 0)
            ops.algorithm(alg, *alg_args)
            if ops.analyze(1) == 0:
                return 0
        return -1

    def _base_shear(self, dof: int) -> float:
        ops = self._ops
        ops.reactions()
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
        from datetime import datetime, timezone
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps({
            "status": status, "direction": direction,
            "converged_steps": converged, "total_steps": total,
            "steps": steps,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }, indent=2), encoding="utf-8")
        tmp.replace(path)
