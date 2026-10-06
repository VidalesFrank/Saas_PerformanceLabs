"""
NLFrameOPSBuilder — Modelo OpenSees no lineal para pushover de edificios de
pórticos de concreto reforzado (RC Moment Resisting Frames).

Toma como entrada:
  - canonical : canonical_model.json (geometría de nodos, restraints, masas)
  - spec      : nonlinear_model.json producido por NLSpecBuilder (incluye
                armado de columnas/vigas y bloque `confinement` Mander por
                sección y zona)

Produce:
  - Elementos forceBeamColumn con secciones Fiber (Concrete02 confinado Mander
    + Concrete02 no confinado + Steel02) usando integración HingeRadau para
    concentrar la plasticidad en los extremos (zonas donde está el
    confinamiento de diseño).
  - Diafragma rígido por piso con nodo CM maestro.
  - Patrones de carga lateral: triangular / uniforme / modal.
  - Captura de historia (desplazamientos de todos los joints + rotaciones
    plásticas en los extremos de cada elemento) → NPZ comprimido para post-
    proceso de daño por rótula.

Unidades: m, kN, kPa (= MPa·1000). Convención de ejes OpenSees:
  - DOF 1: Ux (dirección X global)
  - DOF 2: Uy (dirección Y global)
  - DOF 3: Uz (vertical)
  - DOF 4-5-6: rotaciones Rx, Ry, Rz
"""
from __future__ import annotations

import json
import math
from pathlib import Path


# ── Offsets de tag para evitar colisiones con WallBuilder ────────────────────
_NODE_FRAME_OFFSET  = 0            # nodos ETABS siguen siendo int(label)
_NODE_CM_OFFSET     = 30_000_000   # distinto de wall (10M) para evitar choques
_ELE_COL_OFFSET     = 70_000_000
_ELE_BM_OFFSET      = 80_000_000
_ELE_INFILL_OFFSET  = 85_000_000   # corotTruss diagonales de infill
_SEC_OFFSET         = 90_000_000
_INTEG_OFFSET       = 95_000_000   # beamIntegration tags
_MAT_OFFSET         = 100_000_000
_MAT_MASONRY_OFFSET = 110_000_000  # Concrete01 por material_id de masonry
_TRANSF_COL         = 1
_TRANSF_BM          = 2


# ── Diámetros ASTM/NSR-10 ─────────────────────────────────────────────────────
_BAR_DIAM_MM = {
    "#3":  9.5,  "#4": 12.7,  "#5": 15.9,  "#6": 19.1,  "#7": 22.2,
    "#8": 25.4,  "#9": 28.7,  "#10": 32.3, "#11": 35.8,
}


def _bar_diam_m(label: str, default: float = 0.0159) -> float:
    mm = _BAR_DIAM_MM.get(str(label).strip())
    return mm / 1000.0 if mm else default


def _bar_area_m2(label: str, default: float = 2.0e-4) -> float:
    db = _bar_diam_m(label, default=math.sqrt(default * 4.0 / math.pi))
    return math.pi * db * db / 4.0


def _joint_tag(label: str) -> int:
    """Convierte un label de joint ETABS a tag entero (mismo esquema que
    LinearOPSBuilder)."""
    try:
        return int(float(label))
    except (TypeError, ValueError):
        return abs(hash(label)) % (_NODE_CM_OFFSET - 1000) + 1000


class NLFrameOPSBuilder:
    """
    Construye el modelo no lineal de pórticos y ejecuta gravedad + pushover.

    Uso:
        builder = NLFrameOPSBuilder(canonical, spec)
        info = builder.build()
        builder.run_gravity()
        res  = builder.run_pushover(direction="X", pattern_type="triangular")
    """

    def __init__(
        self,
        canonical:         dict,
        spec:              dict,
        n_integration_pts: int = 5,
        plastic_hinge_len: float = 0.0,   # 0 → auto = max(h_m/2, 0.1)
    ):
        self._c       = canonical
        self._s       = spec
        self._n_ip    = n_integration_pts
        self._lp_user = plastic_hinge_len

        # Materiales / secciones cacheadas
        self._mat_ctr   = _MAT_OFFSET
        self._sec_ctr   = _SEC_OFFSET
        self._integ_ctr = _INTEG_OFFSET
        self._mat_concrete: dict[tuple, int] = {}  # (fcc_MPa, eps_cc, eps_cu, "conf") → tag
        self._mat_steel:    dict[float, int] = {}  # fy_MPa → tag
        self._mat_torsion:  dict[int,   int] = {}  # round(GJ/1000) → tag
        self._sec_by_key:   dict[str, int]   = {}  # (fid|"end"/"mid") → sec_tag

        # Infraestructura del dominio
        self._ops            = None
        self._stories_order: list[str] = []
        self._stories_z:     dict[str, float] = {}
        self._cm_nodes:      dict[str, dict] = {}
        self._joint_story:   dict[str, str] = {}
        self._valid_joints:  set[str] = set()  # joints que SÍ se crearon
        self._story_slaves:  dict[str, list[int]] = {}  # story → tags de nodos esclavos
        self._ele_col_map:   dict[str, int] = {}  # fid → ele_tag
        self._ele_bm_map:    dict[str, int] = {}  # fid → ele_tag
        self._ele_infill_map:dict[str, list[int]] = {}  # panel_id → [tag_diag1, tag_diag2]
        self._mat_masonry:   dict[str, int] = {}  # material_id → uniaxialMaterial tag
        self._base_nodes:    list[int] = []
        self._control_node:  int | None = None

        # Metadata para visualización
        self._element_lines: list[dict] = []
        self._infill_lines:  list[dict] = []   # paneles para pintar en 3D

    # ── API pública ────────────────────────────────────────────────────────────

    def build(self) -> dict:
        import openseespy.opensees as ops
        self._ops = ops

        ops.wipe()
        ops.model("basic", "-ndm", 3, "-ndf", 6)

        self._load_stories()
        self._create_nodes()
        self._apply_restraints()
        self._create_geom_transfs()
        self._build_columns()
        self._build_beams()
        self._build_infill_struts()
        self._create_cm_nodes_and_masses()
        self._apply_diaphragms()

        total_h = max(self._stories_z.values(), default=0.0)
        roof    = self._stories_order[-1] if self._stories_order else ""
        self._control_node = (self._cm_nodes.get(roof) or {}).get("tag")

        # Validación: sin elementos el modelo es inútil → fail-fast con mensaje
        n_cols  = len(self._ele_col_map)
        n_beams = len(self._ele_bm_map)
        total_spec_cols  = len(self._s.get("elements", {}).get("columns", {}))
        total_spec_beams = len(self._s.get("elements", {}).get("beams",   {}))
        if n_cols == 0 and n_beams == 0:
            raise RuntimeError(
                f"NLFrameOPSBuilder no construyó ningún elemento. "
                f"Spec tiene {total_spec_cols} columnas y {total_spec_beams} vigas, "
                f"pero todas fallaron al crear la sección Fiber o el elemento forceBeamColumn. "
                f"Revisa los stderr previos de OpenSees para el error específico."
            )
        if not self._control_node:
            raise RuntimeError(
                f"NLFrameOPSBuilder no encontró el nodo CM de la azotea "
                f"(piso '{roof}'). Verifica que el spec incluya 'masses' "
                f"para todos los pisos del modelo."
            )

        return {
            "cm_nodes":       self._cm_nodes,
            "base_nodes":     self._base_nodes,
            "control_node":   self._control_node,
            "stories_order":  self._stories_order,
            "stories_z":      self._stories_z,
            "total_height":   total_h,
            "n_columns":      len(self._ele_col_map),
            "n_beams":        len(self._ele_bm_map),
            "n_infills":      len(self._ele_infill_map),
            "element_lines":  self._element_lines,
            "infill_lines":   self._infill_lines,
        }

    def run_gravity(self, factor: float = 1.0, steps: int = 10) -> dict:
        """
        Análisis gravitacional incremental aplicando el peso del edificio como
        carga puntual en los CM (W_kN del spec). Se divide en N pasos y se
        bloquea con loadConst al terminar.
        """
        ops = self._ops
        ops.timeSeries("Linear", 1)
        ops.pattern("Plain", 1, 1)

        masses = self._s.get("masses", {})
        for md in masses.values():
            story = str(md.get("story", ""))
            cm = self._cm_nodes.get(story)
            if not cm:
                continue
            W = float(md.get("W_kN", 0.0)) * factor
            if W <= 0.01:
                continue
            # Carga gravitacional distribuida al diafragma a través del CM.
            # El diafragma la reparte a las columnas via restricciones.
            ops.load(cm["tag"], 0.0, 0.0, -W, 0.0, 0.0, 0.0)

        ops.system("UmfPack")
        ops.numberer("RCM")
        ops.constraints("Transformation")
        ops.test("NormDispIncr", 1.0e-5, 50, 0)
        ops.algorithm("Newton")
        ops.integrator("LoadControl", 1.0 / max(steps, 1))
        ops.analysis("Static")

        ok = ops.analyze(max(steps, 1))
        if ok != 0:
            ops.algorithm("ModifiedNewton")
            ok = ops.analyze(max(steps, 1))

        ops.loadConst("-time", 0.0)
        return {"status": "success" if ok == 0 else "partial"}

    def run_pushover(
        self,
        direction:        str   = "X",
        pattern_type:     str   = "triangular",  # triangular | uniforme | modal
        target_drift_pct: float = 2.0,
        inc_m:            float = 0.001,
        result_path:      Path | None = None,
        history_path:     Path | None = None,
        history_stride:   int = 1,
        progress_cb       = None,   # callable(info_dict) para progreso en vivo
        cancel_flag:      list[bool] | None = None,
    ) -> dict:
        """
        Pushover desplazamiento-controlado con patrón de carga seleccionable.

        - triangular: F_i proporcional a m_i · z_i  (NSR-10 A.4.3 equivalente)
        - uniforme : F_i constante por piso (ASCE 7 §12.8.3)
        - modal   : F_i proporcional al modo fundamental en la dirección pedida
                    (requiere ops.eigen(1) previo — se lanza aquí)

        El NPZ de historia captura por cada paso convergido:
          disp_joint  : (n_steps, n_joint, 6) desplazamientos de todos los joints
          disp_cm     : (n_steps, n_cm,    3) desplazamientos de CMs
          ele_defs_col: (n_steps, n_col,   N) deformaciones de secciones por IP
          ele_defs_bm : (n_steps, n_bm,    N) idem para vigas
        """
        ops = self._ops
        total_h = max(self._stories_z.values(), default=1.0)

        if not self._control_node:
            return {"status": "failed", "message": "Sin nodo de control (CM azotea)."}

        axis = direction.lstrip("-")
        sign = -1.0 if direction.startswith("-") else 1.0
        dof  = 1 if axis == "X" else 2

        # Factores de distribución por piso según el patrón
        try:
            factors = self._lateral_factors(pattern_type.lower(), dof)
        except Exception as exc:
            return {"status": "failed", "message": f"Patrón '{pattern_type}': {exc}"}

        target_disp = sign * (target_drift_pct / 100.0) * total_h
        n_steps     = max(10, int(abs(target_disp) / max(abs(inc_m), 1e-6)))

        # Patrón de carga lateral: F_i aplicada en el CM de cada piso
        ops.timeSeries("Linear", 2)
        ops.pattern("Plain", 2, 2)
        for story, fact in factors.items():
            cm = self._cm_nodes.get(story)
            if not cm:
                continue
            load = [0.0] * 6
            load[dof - 1] = sign * fact
            ops.load(cm["tag"], *load)

        ops.system("UmfPack")
        ops.numberer("RCM")
        ops.constraints("Transformation")
        ops.integrator("DisplacementControl", self._control_node, dof, sign * inc_m)
        ops.analysis("Static")

        # ── Captura de historia ───────────────────────────────────────────────
        capture = history_path is not None
        joint_tags = sorted(self._valid_joints,
                            key=lambda j: _joint_tag(j))
        joint_tag_ints = [_joint_tag(j) for j in joint_tags]
        cm_tags = [info["tag"] for info in self._cm_nodes.values()]
        col_tags = [self._ele_col_map[fid] for fid in sorted(self._ele_col_map)]
        bm_tags  = [self._ele_bm_map[fid]  for fid in sorted(self._ele_bm_map)]

        hist_joint:   list[list[list[float]]] = []
        hist_cm:      list[list[list[float]]] = []
        hist_col_def: list[list[list[float]]] = []  # per ele, 2 extremos → (k_i, k_j, eps_i, eps_j)
        hist_bm_def:  list[list[list[float]]] = []

        def _capture() -> None:
            if not capture:
                return
            hist_joint.append([
                [float(ops.nodeDisp(t, k)) for k in range(1, 7)]
                for t in joint_tag_ints
            ])
            hist_cm.append([
                [float(ops.nodeDisp(t, k)) for k in range(1, 4)]
                for t in cm_tags
            ])
            # Deformaciones de sección en los IP de los extremos i (IP=1) y j
            # (IP=6 para HingeRadau; es siempre 6 porque HingeRadau coloca 2
            # Lobatto en cada hinge + 2 Gauss en el interior).
            # sectionDeformation devuelve 4 valores con `-torsion`:
            # [axial, κz, κy, torsion_rate] → 8 valores por elemento.
            def _ele_sect_strain(tag: int) -> list[float]:
                out: list[float] = []
                for ip in (1, 6):
                    try:
                        d = ops.sectionDeformation(tag, ip)
                        out.extend([float(x) for x in d])
                    except Exception:
                        out.extend([0.0, 0.0, 0.0, 0.0])
                return out
            hist_col_def.append([_ele_sect_strain(t) for t in col_tags])
            hist_bm_def.append( [_ele_sect_strain(t) for t in bm_tags])

        steps_out: list[dict] = []
        converged = 0

        for step_idx in range(n_steps):
            if cancel_flag and cancel_flag[0]:
                break
            if self._try_step() != 0:
                break
            converged += 1
            ctrl_disp  = float(ops.nodeDisp(self._control_node, dof))
            base_shear = self._base_shear(dof)
            drift_pct  = abs(ctrl_disp) / total_h * 100.0

            step_info = {
                "step":           converged,
                "displacement_m": round(ctrl_disp, 6),
                "drift_pct":      round(drift_pct, 4),
                "base_shear_kN":  round(base_shear, 2),
            }
            steps_out.append(step_info)

            if capture and (converged % max(1, history_stride) == 0):
                _capture()

            if progress_cb and (converged % 5 == 0 or converged == n_steps):
                try:
                    progress_cb({
                        "direction":    direction,
                        "step":         converged,
                        "total":        n_steps,
                        "drift_pct":    step_info["drift_pct"],
                        "base_shear_kN": step_info["base_shear_kN"],
                    })
                except Exception:
                    pass

            if result_path:
                self._write_partial(result_path, direction, pattern_type,
                                    steps_out, "running", n_steps, converged)

        # ── Serialización de historia ─────────────────────────────────────────
        history_meta: dict | None = None
        if capture and hist_joint:
            import numpy as _np
            Path(history_path).parent.mkdir(parents=True, exist_ok=True)
            _np.savez_compressed(
                history_path,
                disp_joint   = _np.asarray(hist_joint,  dtype=_np.float32),
                disp_cm      = _np.asarray(hist_cm,     dtype=_np.float32),
                col_sect_def = _np.asarray(hist_col_def, dtype=_np.float32),
                bm_sect_def  = _np.asarray(hist_bm_def,  dtype=_np.float32),
                joint_tags   = _np.asarray(joint_tag_ints, dtype=_np.int64),
                cm_tags      = _np.asarray(cm_tags,     dtype=_np.int64),
                col_tags     = _np.asarray(col_tags,    dtype=_np.int64),
                bm_tags      = _np.asarray(bm_tags,     dtype=_np.int64),
            )
            history_meta = {
                "path":           str(history_path),
                "captured_steps": len(hist_joint),
                "stride":         history_stride,
                "n_joints":       len(joint_tag_ints),
                "n_cm":           len(cm_tags),
                "n_columns":      len(col_tags),
                "n_beams":        len(bm_tags),
            }

        status = (
            "success" if converged == n_steps
            else ("partial" if converged > 0 else "failed")
        )
        result = {
            "status":           status,
            "direction":        direction,
            "pattern_type":     pattern_type,
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
            self._write_partial(result_path, direction, pattern_type,
                                steps_out, status, n_steps, converged)
        return result

    def wipe(self) -> None:
        if self._ops:
            try:
                self._ops.wipe()
            except Exception:
                pass

    # ── Construcción del dominio ──────────────────────────────────────────────

    def _load_stories(self) -> None:
        stories = self._s.get("stories", {}) or self._c.get("stories", {})
        self._stories_z     = {s: float(d.get("elevation_m", 0.0)) for s, d in stories.items()}
        self._stories_order = sorted(self._stories_z, key=lambda s: self._stories_z[s])

    def _create_nodes(self) -> None:
        """Crea solo los nodos que serán usados por frames o restraints.
        Los joints huérfanos del spec se omiten para no inflar el dominio."""
        ops = self._ops
        nodes = self._s.get("nodes", {})
        cols  = self._s.get("elements", {}).get("columns", {})
        beams = self._s.get("elements", {}).get("beams",   {})
        restraints = self._c.get("restraints", {})

        used: set[str] = set(restraints.keys())
        for col in cols.values():
            used.add(col["node_i"]); used.add(col["node_j"])
        for bm in beams.values():
            used.add(bm["node_i"]);  used.add(bm["node_j"])

        for lbl, nd in nodes.items():
            if lbl not in used:
                continue
            tag = _joint_tag(lbl)
            ops.node(tag, float(nd["x"]), float(nd["y"]), float(nd["z"]))
            self._valid_joints.add(lbl)
            self._joint_story[lbl] = str(nd.get("story", ""))

    def _apply_restraints(self) -> None:
        ops = self._ops
        for lbl, dofs in self._c.get("restraints", {}).items():
            if lbl not in self._valid_joints:
                continue
            tag = _joint_tag(lbl)
            ops.fix(tag, *[int(d) for d in dofs])
            if tag not in self._base_nodes:
                self._base_nodes.append(tag)

    def _create_geom_transfs(self) -> None:
        """
        Dos transformaciones geométricas:
          - PDelta para columnas (incluye efectos P-Δ importantes en pushover)
          - Linear para vigas (horizontales, sin P-Δ geométrico)
        """
        ops = self._ops
        # Columnas: vecxz = [1,0,0] (eje local z vertical, local y en Y global)
        ops.geomTransf("PDelta", _TRANSF_COL, 1.0, 0.0, 0.0)
        # Vigas: vecxz = [0,0,1] (eje local z vertical)
        ops.geomTransf("Linear", _TRANSF_BM,  0.0, 0.0, 1.0)

    # ── Materiales uniaxiales ─────────────────────────────────────────────────

    def _next_mat(self) -> int:
        self._mat_ctr += 1
        return self._mat_ctr

    def _next_sec(self) -> int:
        self._sec_ctr += 1
        return self._sec_ctr

    def _get_concrete(
        self, fcc_MPa: float, eps_cc: float, eps_cu: float, label: str = "conf",
    ) -> int:
        """Concrete02 con parámetros Mander (ya calculados por fase F1)."""
        key = (round(fcc_MPa, 2), round(eps_cc, 5), round(eps_cu, 5), label)
        if key in self._mat_concrete:
            return self._mat_concrete[key]
        tag = self._next_mat()
        fcc_kPa = fcc_MPa * 1000.0
        f_cu    = 0.20 * fcc_kPa          # 20% residual
        ft      = 0.10 * fcc_kPa          # resistencia a tracción
        Ets     = ft / max(eps_cc * 0.5, 0.0005)
        self._ops.uniaxialMaterial(
            "Concrete02", tag,
            -fcc_kPa, -eps_cc,            # fpc, epsc0
            -f_cu,    -eps_cu,            # fpcu, epsU
            0.1, ft, Ets,                 # lambda, ft, Ets
        )
        self._mat_concrete[key] = tag
        return tag

    def _get_steel(self, fy_MPa: float) -> int:
        key = round(fy_MPa, 1)
        if key in self._mat_steel:
            return self._mat_steel[key]
        tag = self._next_mat()
        self._ops.uniaxialMaterial(
            "Steel02", tag,
            fy_MPa * 1000.0,       # Fy [kPa]
            200_000_000.0,          # E0 = 200 GPa [kPa]
            0.01,                   # b (hardening)
            15.0, 0.925, 0.15,      # R0, cR1, cR2
        )
        self._mat_steel[key] = tag
        return tag

    # ── Secciones Fiber ───────────────────────────────────────────────────────

    def _next_integ(self) -> int:
        self._integ_ctr += 1
        return self._integ_ctr

    def _get_torsion(self, GJ_kN_m2: float) -> int:
        """
        Material uniaxialElastic para la rigidez torsional (ndf=6 requiere
        rigidez en Rx del eje local → torsión). OpenSeesPy NO soporta la
        sintaxis Tcl `-GJ`, hay que agregar `-torsion <matTag>` con un
        material elástico explícito.
        """
        key = round(GJ_kN_m2 / 1000.0)
        if key in self._mat_torsion:
            return self._mat_torsion[key]
        tag = self._next_mat()
        self._ops.uniaxialMaterial("Elastic", tag, float(GJ_kN_m2))
        self._mat_torsion[key] = tag
        return tag

    def _build_fiber_section(
        self,
        sec_tag:    int,
        b_m:        float,
        h_m:        float,
        cover_m:    float,
        fc_MPa:     float,         # f'c no confinado
        confinement: dict,         # bloque "end" o "mid" del spec
        fy_MPa:     float,
        bars_layers: list[dict],   # [{n, As_m2, y, z}, ...] en coords locales
    ) -> None:
        """
        Construye una sección Fiber rectangular con:
          - Núcleo confinado (Concrete02 Mander)
          - Recubrimiento no confinado (Concrete02 fc_MPa, eps_co=0.002, eps_cu=0.006)
          - Barras longitudinales como fibras puntuales

        Coordenadas locales: y ∈ [-b/2, b/2], z ∈ [-h/2, h/2]
        """
        ops = self._ops

        fcc = float(confinement.get("fcc_MPa", fc_MPa * 1.3))
        eps_cc = float(confinement.get("eps_cc", 0.004))
        eps_cu = float(confinement.get("eps_cu", 0.016))

        mat_core  = self._get_concrete(fcc,   eps_cc, eps_cu, "conf")
        mat_cover = self._get_concrete(fc_MPa, 0.002, 0.006,  "unconf")
        mat_steel = self._get_steel(fy_MPa)

        y1 = -b_m / 2.0; y2 = b_m / 2.0
        z1 = -h_m / 2.0; z2 = h_m / 2.0
        yc1 = -b_m / 2.0 + cover_m; yc2 = b_m / 2.0 - cover_m
        zc1 = -h_m / 2.0 + cover_m; zc2 = h_m / 2.0 - cover_m

        if yc2 <= yc1 or zc2 <= zc1:
            # Cover demasiado grande: sin núcleo confinado efectivo
            yc1, yc2 = y1 * 0.5, y2 * 0.5
            zc1, zc2 = z1 * 0.5, z2 * 0.5

        n_fib_core_y = 8
        n_fib_core_z = 8
        n_fib_cov_t  = 2   # transverse (through cover thickness)

        # Rigidez torsional elástica (G ≈ Ec/2.4, J ≈ b·h³/3 para rect sólida)
        G_kPa = (4700.0 * (fc_MPa ** 0.5)) * 1000.0 / 2.4
        J_m4  = (min(b_m, h_m) ** 3) * max(b_m, h_m) / 3.0
        GJ    = G_kPa * J_m4
        torsion_tag = self._get_torsion(GJ)
        ops.section("Fiber", sec_tag, "-torsion", torsion_tag)
        # Núcleo confinado
        ops.patch("rect", mat_core, n_fib_core_y, n_fib_core_z,
                  yc1, zc1, yc2, zc2)
        # Recubrimientos no confinados (4 lados)
        ops.patch("rect", mat_cover, n_fib_core_y, n_fib_cov_t,
                  yc1, z1,  yc2, zc1)         # bottom
        ops.patch("rect", mat_cover, n_fib_core_y, n_fib_cov_t,
                  yc1, zc2, yc2, z2)          # top
        ops.patch("rect", mat_cover, n_fib_cov_t, 10,
                  y1,  z1,  yc1, z2)          # left (abarca esquinas)
        ops.patch("rect", mat_cover, n_fib_cov_t, 10,
                  yc2, z1,  y2,  z2)          # right (abarca esquinas)

        # Barras longitudinales
        for layer in bars_layers:
            n = int(layer.get("n", 0))
            if n < 1:
                continue
            As = float(layer.get("As_m2", 0.0))
            if layer.get("kind") == "straight":
                ya, za = layer["y1"], layer["z1"]
                yb, zb = layer["y2"], layer["z2"]
                ops.layer("straight", mat_steel, n, As, ya, za, yb, zb)
            else:
                # fibra puntual
                ops.fiber(float(layer["y"]), float(layer["z"]), As, mat_steel)

    # ── Distribución de barras ────────────────────────────────────────────────

    def _column_bar_layers(
        self, n_bars: int, db_m: float, As_bar_m2: float,
        b_m: float, h_m: float, cover_m: float,
    ) -> list[dict]:
        """
        Distribución típica de barras longitudinales de una columna rectangular.

        Reparte n_bars perimetrales:
          - n_face = max(2, round(n/4) + 1) en caras superior e inferior
          - resto distribuido en caras laterales (barras intermedias)
        """
        if n_bars < 4 or As_bar_m2 <= 0.0:
            return []
        # Coords internas (al centro de barra, dentro del estribo)
        inner_y1 = -b_m / 2.0 + cover_m + db_m / 2.0
        inner_y2 =  b_m / 2.0 - cover_m - db_m / 2.0
        inner_z1 = -h_m / 2.0 + cover_m + db_m / 2.0
        inner_z2 =  h_m / 2.0 - cover_m - db_m / 2.0

        n_face = max(2, int(round(n_bars / 4.0)) + 1)
        n_face = min(n_face, (n_bars + 2) // 2)
        n_side_total = max(0, n_bars - 2 * n_face)
        n_side_per_face = n_side_total // 2  # igual por lado (puede sobrar 1)

        layers: list[dict] = []
        # Top layer
        layers.append({
            "kind": "straight", "n": n_face, "As_m2": As_bar_m2,
            "y1": inner_y1, "z1": inner_z2,
            "y2": inner_y2, "z2": inner_z2,
        })
        # Bottom layer
        layers.append({
            "kind": "straight", "n": n_face, "As_m2": As_bar_m2,
            "y1": inner_y1, "z1": inner_z1,
            "y2": inner_y2, "z2": inner_z1,
        })
        # Side layers (sin esquinas, ya contadas)
        if n_side_per_face > 0 and inner_z2 > inner_z1:
            # Separación vertical entre side bars (sin repetir esquinas)
            # Se usa layer straight con n_side_per_face puntos entre z1 y z2
            z_side_lo = inner_z1 + (inner_z2 - inner_z1) / (n_side_per_face + 1)
            z_side_hi = inner_z2 - (inner_z2 - inner_z1) / (n_side_per_face + 1)
            # Left side
            layers.append({
                "kind": "straight", "n": n_side_per_face, "As_m2": As_bar_m2,
                "y1": inner_y1, "z1": z_side_lo,
                "y2": inner_y1, "z2": z_side_hi,
            })
            # Right side
            layers.append({
                "kind": "straight", "n": n_side_per_face, "As_m2": As_bar_m2,
                "y1": inner_y2, "z1": z_side_lo,
                "y2": inner_y2, "z2": z_side_hi,
            })
        # Barras sobrantes impares: añadir al top (constructivo)
        remainder = n_bars - 2 * n_face - 2 * n_side_per_face
        if remainder > 0:
            layers.append({
                "kind": "straight", "n": remainder, "As_m2": As_bar_m2,
                "y1": inner_y1, "z1": inner_z2,
                "y2": inner_y2, "z2": inner_z2,
            })
        return layers

    def _beam_bar_layers(
        self,
        n_top: int, db_top_m: float, As_top_m2: float,
        n_bot: int, db_bot_m: float, As_bot_m2: float,
        b_m: float, h_m: float, cover_m: float,
    ) -> list[dict]:
        """Distribución típica de barras de viga: top layer + bot layer."""
        layers: list[dict] = []
        inner_y1_top = -b_m / 2.0 + cover_m + db_top_m / 2.0
        inner_y2_top =  b_m / 2.0 - cover_m - db_top_m / 2.0
        inner_z_top  =  h_m / 2.0 - cover_m - db_top_m / 2.0

        inner_y1_bot = -b_m / 2.0 + cover_m + db_bot_m / 2.0
        inner_y2_bot =  b_m / 2.0 - cover_m - db_bot_m / 2.0
        inner_z_bot  = -h_m / 2.0 + cover_m + db_bot_m / 2.0

        if n_top >= 1 and As_top_m2 > 0.0:
            layers.append({
                "kind": "straight", "n": max(n_top, 2), "As_m2": As_top_m2,
                "y1": inner_y1_top, "z1": inner_z_top,
                "y2": inner_y2_top, "z2": inner_z_top,
            })
        if n_bot >= 1 and As_bot_m2 > 0.0:
            layers.append({
                "kind": "straight", "n": max(n_bot, 2), "As_m2": As_bot_m2,
                "y1": inner_y1_bot, "z1": inner_z_bot,
                "y2": inner_y2_bot, "z2": inner_z_bot,
            })
        return layers

    # ── Columnas ──────────────────────────────────────────────────────────────

    def _build_columns(self) -> None:
        ops = self._ops
        cols = self._s.get("elements", {}).get("columns", {})

        for fid, col in cols.items():
            ni_lbl = col["node_i"]; nj_lbl = col["node_j"]
            if ni_lbl not in self._valid_joints or nj_lbl not in self._valid_joints:
                continue
            geo    = col.get("geometry", {})
            b      = float(geo.get("b_m", 0.30))
            h      = float(geo.get("h_m", 0.30))
            L      = float(geo.get("L_m", 3.0))
            fc     = float(geo.get("fc_MPa", 21.0))
            fy     = float(geo.get("fy_MPa", 420.0))
            cover  = float(geo.get("cover_m", 0.040))

            long_r = col.get("reinforcement", {}).get("longitudinal", {})
            n_bars = int(long_r.get("n_bars", 8))
            label  = str(long_r.get("bar_label", "#5"))
            db_m   = _bar_diam_m(label)
            As_bar = _bar_area_m2(label)

            conf   = col.get("confinement", {})
            conf_end = conf.get("end", {})
            conf_mid = conf.get("mid", {})

            # Secciones Fiber (end y mid)
            sec_end = self._next_sec()
            sec_mid = self._next_sec()
            bar_layers = self._column_bar_layers(n_bars, db_m, As_bar, b, h, cover)
            self._build_fiber_section(sec_end, b, h, cover, fc, conf_end, fy, bar_layers)
            self._build_fiber_section(sec_mid, b, h, cover, fc, conf_mid, fy, bar_layers)

            # Longitud de rótula plástica
            lp = self._lp_user if self._lp_user > 0.0 else max(h / 2.0, 0.10)
            lp = min(lp, L * 0.45)

            ele_tag = _ELE_COL_OFFSET + len(self._ele_col_map) + 1
            integ_tag = self._next_integ()
            ni = _joint_tag(ni_lbl); nj = _joint_tag(nj_lbl)
            try:
                ops.beamIntegration(
                    "HingeRadau", integ_tag,
                    sec_end, float(lp), sec_end, float(lp), sec_mid,
                )
                ops.element(
                    "forceBeamColumn", ele_tag, ni, nj, _TRANSF_COL, integ_tag,
                )
            except Exception as exc:
                print(f"[NLFrameOPSBuilder] columna {fid}: {exc}")
                continue
            self._ele_col_map[fid] = ele_tag

            self._element_lines.append({
                "fid":       str(fid),
                "kind":      "column",
                "story":     col.get("story", ""),
                "ele_tag":   ele_tag,
                "node_i":    ni, "node_j": nj,
                "node_i_lbl": ni_lbl, "node_j_lbl": nj_lbl,
                "b_m": b, "h_m": h, "L_m": L,
                "lp_m": round(lp, 4),
            })

    # ── Vigas ─────────────────────────────────────────────────────────────────

    def _build_beams(self) -> None:
        ops = self._ops
        beams = self._s.get("elements", {}).get("beams", {})

        for fid, bm in beams.items():
            ni_lbl = bm["node_i"]; nj_lbl = bm["node_j"]
            if ni_lbl not in self._valid_joints or nj_lbl not in self._valid_joints:
                continue
            geo    = bm.get("geometry", {})
            b      = float(geo.get("b_m", 0.30))
            h      = float(geo.get("h_m", 0.40))
            L      = float(geo.get("L_m", 4.0))
            fc     = float(geo.get("fc_MPa", 21.0))
            fy     = float(geo.get("fy_MPa", 420.0))
            cover  = float(geo.get("cover_m", 0.040))

            # Armado: usamos zona "end_i" como representativo (crítica)
            zones  = bm.get("reinforcement", {}).get("zones", {})
            end_i  = zones.get("end_i", {})
            top    = end_i.get("top", {})
            bot    = end_i.get("bot", {})
            n_top  = int(top.get("n_bars", 2))
            n_bot  = int(bot.get("n_bars", 2))
            db_top = _bar_diam_m(top.get("bar_label", "#5"))
            db_bot = _bar_diam_m(bot.get("bar_label", "#5"))
            As_top = _bar_area_m2(top.get("bar_label", "#5"))
            As_bot = _bar_area_m2(bot.get("bar_label", "#5"))

            conf = bm.get("confinement", {})
            conf_end = conf.get("end", {})
            conf_mid = conf.get("mid", {})

            sec_end = self._next_sec()
            sec_mid = self._next_sec()
            bar_layers = self._beam_bar_layers(
                n_top, db_top, As_top, n_bot, db_bot, As_bot, b, h, cover
            )
            self._build_fiber_section(sec_end, b, h, cover, fc, conf_end, fy, bar_layers)
            self._build_fiber_section(sec_mid, b, h, cover, fc, conf_mid, fy, bar_layers)

            lp = self._lp_user if self._lp_user > 0.0 else max(h / 2.0, 0.10)
            lp = min(lp, L * 0.45)

            ele_tag = _ELE_BM_OFFSET + len(self._ele_bm_map) + 1
            integ_tag = self._next_integ()
            ni = _joint_tag(ni_lbl); nj = _joint_tag(nj_lbl)
            try:
                ops.beamIntegration(
                    "HingeRadau", integ_tag,
                    sec_end, float(lp), sec_end, float(lp), sec_mid,
                )
                ops.element(
                    "forceBeamColumn", ele_tag, ni, nj, _TRANSF_BM, integ_tag,
                )
            except Exception as exc:
                print(f"[NLFrameOPSBuilder] viga {fid}: {exc}")
                continue
            self._ele_bm_map[fid] = ele_tag

            self._element_lines.append({
                "fid":       str(fid),
                "kind":      "beam",
                "story":     bm.get("story", ""),
                "ele_tag":   ele_tag,
                "node_i":    ni, "node_j": nj,
                "node_i_lbl": ni_lbl, "node_j_lbl": nj_lbl,
                "b_m": b, "h_m": h, "L_m": L,
                "lp_m": round(lp, 4),
            })

    # ── Infills (puntales equivalentes RCF-AD) ────────────────────────────────

    def _build_infill_struts(self) -> None:
        """
        Para cada panel definido en canonical["infills"], crea 2 corotTruss
        diagonales cruzados entre las 4 esquinas del vano (nodo base-izq,
        base-der, tope-izq, tope-der), identificadas vía column_i_fid y
        column_j_fid del canonical["frames"].

        Material: Concrete01 masonry (solo compresión; en tracción σ ≡ 0).
        El elemento Truss transmite ambas pero el material deja σ=0 en
        tracción → equivale a un puntal solo-compresión.
        """
        from app.engine.building.masonry import (
            MasonryMaterialDef,
            masonry_concrete01_params,
            strut_geometry,
        )

        infills   = self._c.get("infills", {}) or {}
        materials = self._c.get("masonryMaterials", {}) or {}
        frames    = self._c.get("frames", {}) or {}
        if not infills:
            return

        ops = self._ops

        def _ensure_masonry_mat(mat_id: str) -> int | None:
            if mat_id in self._mat_masonry:
                return self._mat_masonry[mat_id]
            m = materials.get(mat_id)
            if not m:
                return None
            try:
                mdef = MasonryMaterialDef(
                    name       = str(m.get("name", mat_id)),
                    fm_mpa     = float(m.get("fm_mpa", 0.0)),
                    brick_type = str(m.get("brick_type", "VP")),
                    Em_mpa     = (float(m["Em_mpa"]) if m.get("Em_mpa") else None),
                )
                fpc, eps0, fpcu, epsu = masonry_concrete01_params(mdef)
            except Exception as exc:
                print(f"[NLFrameOPSBuilder] material masonry '{mat_id}': {exc}")
                return None
            tag = _MAT_MASONRY_OFFSET + len(self._mat_masonry) + 1
            # Concrete01 — convertir MPa a kPa (×1000)
            ops.uniaxialMaterial(
                "Concrete01", tag,
                fpc * 1000.0, eps0, fpcu * 1000.0, epsu,
            )
            self._mat_masonry[mat_id] = tag
            return tag

        n_ok = 0
        for pid, panel in infills.items():
            fi = str(panel.get("column_i_fid", ""))
            fj = str(panel.get("column_j_fid", ""))
            story = str(panel.get("story", ""))
            if not fi or not fj:
                continue   # panel sin columnas asignadas → ignorar silencio
            col_i = frames.get(fi); col_j = frames.get(fj)
            if not col_i or not col_j:
                print(f"[NLFrameOPSBuilder] infill '{pid}': column fid no existe ({fi}, {fj})")
                continue
            # El panel pertenece a un story: los 4 nodos esquina se derivan
            # de la columna ETABS que atraviesa ese story.
            # Convención: node_i = base del story, node_j = tope del story.
            ni_bot = col_i.get("joint_i") or col_i.get("node_i")
            ni_top = col_i.get("joint_j") or col_i.get("node_j")
            nj_bot = col_j.get("joint_i") or col_j.get("node_i")
            nj_top = col_j.get("joint_j") or col_j.get("node_j")
            if not all([ni_bot, ni_top, nj_bot, nj_top]):
                print(f"[NLFrameOPSBuilder] infill '{pid}': falta joint en frames")
                continue
            for lbl in (ni_bot, ni_top, nj_bot, nj_top):
                if lbl not in self._valid_joints:
                    print(f"[NLFrameOPSBuilder] infill '{pid}': joint '{lbl}' no está en el dominio")
                    break
            else:
                # Coordenadas para calcular geometría del panel
                nodes = self._s.get("nodes", {})
                p_bl = nodes.get(ni_bot, {}); p_tl = nodes.get(ni_top, {})
                p_br = nodes.get(nj_bot, {}); p_tr = nodes.get(nj_top, {})

                def _xyz(nd):
                    return (float(nd.get("x", 0.0)),
                            float(nd.get("y", 0.0)),
                            float(nd.get("z", 0.0)))
                xyz_bl = _xyz(p_bl); xyz_tl = _xyz(p_tl)
                xyz_br = _xyz(p_br); xyz_tr = _xyz(p_tr)

                H = max(xyz_tl[2] - xyz_bl[2], xyz_tr[2] - xyz_br[2])
                L = math.hypot(xyz_br[0] - xyz_bl[0],
                               xyz_br[1] - xyz_bl[1])
                if H <= 0.0 or L <= 0.0:
                    print(f"[NLFrameOPSBuilder] infill '{pid}': geometría nula L={L} H={H}")
                    continue
                try:
                    g = strut_geometry(
                        L_panel_m     = L,
                        H_panel_m     = H,
                        thickness_m   = float(panel.get("thickness_m", 0.15)),
                        width_ratio   = float(panel.get("width_ratio", 0.25)),
                        opening_ratio = float(panel.get("opening_ratio", 0.0)),
                    )
                except Exception as exc:
                    print(f"[NLFrameOPSBuilder] infill '{pid}': {exc}")
                    continue
                A_eff = float(g["area_effective_m2"])
                if A_eff <= 1e-8:
                    continue   # abertura total → panel no aporta

                mat_tag = _ensure_masonry_mat(str(panel.get("masonry_material_id", "")))
                if not mat_tag:
                    print(f"[NLFrameOPSBuilder] infill '{pid}': material no encontrado")
                    continue

                # 2 diagonales cruzadas: BL-TR y BR-TL
                tags: list[int] = []
                for (na, nb) in ((ni_bot, nj_top), (nj_bot, ni_top)):
                    ta = _joint_tag(na); tb = _joint_tag(nb)
                    ele_tag = _ELE_INFILL_OFFSET + len(self._ele_infill_map) * 2 + len(tags) + 1
                    try:
                        ops.element("corotTruss", ele_tag, ta, tb, A_eff, mat_tag)
                        tags.append(ele_tag)
                    except Exception as exc:
                        print(f"[NLFrameOPSBuilder] infill '{pid}' truss: {exc}")

                if tags:
                    self._ele_infill_map[str(pid)] = tags
                    self._infill_lines.append({
                        "panel_id":   str(pid),
                        "story":      story,
                        "nodes":      {
                            "bl": _joint_tag(ni_bot), "tl": _joint_tag(ni_top),
                            "br": _joint_tag(nj_bot), "tr": _joint_tag(nj_top),
                        },
                        "coords": {
                            "bl": xyz_bl, "tl": xyz_tl,
                            "br": xyz_br, "tr": xyz_tr,
                        },
                        "L_m": round(L, 4),
                        "H_m": round(H, 4),
                        "thickness_m":    float(panel.get("thickness_m", 0.15)),
                        "effective_width_m": round(float(g["effective_width_m"]), 4),
                        "area_effective_m2": round(A_eff, 6),
                        "lambda_openings":   round(float(g["lambda_openings"]), 3),
                        "material_id":    str(panel.get("masonry_material_id", "")),
                        "ele_tags":       tags,
                    })
                    n_ok += 1
        if n_ok:
            print(f"[NLFrameOPSBuilder] Infills creados: {n_ok} paneles ({sum(len(v) for v in self._ele_infill_map.values())} puntales)")

    # ── Nodos CM, masas y diafragmas ──────────────────────────────────────────

    def _create_cm_nodes_and_masses(self) -> None:
        ops = self._ops
        masses = self._s.get("masses", {})
        counter = 0
        for key, md in masses.items():
            story = str(md.get("story", ""))
            if story not in self._stories_order:
                continue
            counter += 1
            tag = _NODE_CM_OFFSET + counter
            x = float(md.get("x_cm_m", 0.0))
            y = float(md.get("y_cm_m", 0.0))
            z = float(md.get("z_m",    self._stories_z.get(story, 0.0)))
            ops.node(tag, x, y, z)
            mx = float(md.get("mass_x_t",   1.0))
            my = float(md.get("mass_y_t",   1.0))
            mr = float(md.get("mass_rz_tm2", 1.0))
            ops.mass(tag, mx, my, 0.0, 0.0, 0.0, mr)
            # Restringimos Uz y Rx/Ry del CM: solo trasladamos lateral y rotamos
            # alrededor del eje vertical. Dejar Rz libre para que el diafragma
            # torsional funcione.
            ops.fix(tag, 0, 0, 1, 1, 1, 0)
            self._cm_nodes[story] = {"tag": tag, "x": x, "y": y, "z": z,
                                       "mass_x_t": mx, "mass_y_t": my,
                                       "W_kN": float(md.get("W_kN", mx * 9.81))}

    def _apply_diaphragms(self) -> None:
        ops = self._ops

        # Contamos columnas y vigas por nodo para distinguir "nudos reales"
        # (al menos una columna y una viga) de nodos huérfanos / intermedios.
        beams_dict = self._s.get("elements", {}).get("beams",   {})
        cols_dict  = self._s.get("elements", {}).get("columns", {})
        n_cols_at: dict[str, int] = {}
        n_bms_at:  dict[str, int] = {}
        for col in cols_dict.values():
            n_cols_at[str(col.get("node_i"))] = n_cols_at.get(str(col.get("node_i")), 0) + 1
            n_cols_at[str(col.get("node_j"))] = n_cols_at.get(str(col.get("node_j")), 0) + 1
        for bm in beams_dict.values():
            n_bms_at[str(bm.get("node_i"))] = n_bms_at.get(str(bm.get("node_i")), 0) + 1
            n_bms_at[str(bm.get("node_j"))] = n_bms_at.get(str(bm.get("node_j")), 0) + 1

        for story, cm in self._cm_nodes.items():
            slaves: list[int] = []
            slave_labels: list[str] = []
            for lbl in self._valid_joints:
                if self._joint_story.get(lbl) != story:
                    continue
                tag = _joint_tag(lbl)
                if tag in self._base_nodes:
                    continue
                slaves.append(tag)
                slave_labels.append(lbl)
            if not slaves:
                continue
            # Nudos reales (≥1 col + ≥1 viga): Rx, Ry libres → la viga puede
            # desarrollar curvatura entre dos nudos reales (κ ≠ 0 → rótulas).
            # Nodos huérfanos (intermedios de viga sin columna, o solo con
            # columna sin viga): Rx, Ry fijos → evita singularidad por rigidez
            # rotacional insuficiente. Uz siempre fijo (sin losa explícita).
            for tag, lbl in zip(slaves, slave_labels):
                is_real_joint = (n_cols_at.get(lbl, 0) >= 1 and
                                 n_bms_at.get(lbl, 0)  >= 1)
                try:
                    if is_real_joint:
                        ops.fix(tag, 0, 0, 1, 0, 0, 0)
                    else:
                        ops.fix(tag, 0, 0, 1, 1, 1, 0)
                except Exception:
                    pass
            try:
                ops.rigidDiaphragm(3, cm["tag"], *slaves)
                self._story_slaves[story] = slaves
            except Exception as exc:
                print(f"[NLFrameOPSBuilder] rigidDiaphragm {story}: {exc}")

    # ── Patrón de carga lateral ───────────────────────────────────────────────

    def _lateral_factors(self, pattern_type: str, dof: int) -> dict:
        """
        Retorna {story: factor_i} con suma = 1.0 (normalizado), para aplicar al
        CM de cada piso. El sentido lo pone el pushover.
        """
        masses = self._s.get("masses", {})
        info_by_story: dict[str, dict] = {}
        for md in masses.values():
            story = str(md.get("story", ""))
            if story not in self._stories_order:
                continue
            info_by_story[story] = {
                "mass": float(md.get("mass_x_t" if dof == 1 else "mass_y_t", 1.0)),
                "z":    float(md.get("z_m", self._stories_z.get(story, 0.0))),
            }
        stories = [s for s in self._stories_order if s in info_by_story]
        n = len(stories)
        if n == 0:
            raise ValueError("No hay masas por piso para construir el patrón.")

        if pattern_type == "triangular":
            # F_i ∝ m_i · z_i (k=1, NSR-10 A.4.3)
            raw = [info_by_story[s]["mass"] * info_by_story[s]["z"] for s in stories]
        elif pattern_type == "uniforme":
            raw = [info_by_story[s]["mass"] for s in stories]
        elif pattern_type == "modal":
            raw = self._modal_factors(stories, dof)
        else:
            raise ValueError(f"Patrón '{pattern_type}' no soportado.")

        s = sum(abs(r) for r in raw) or 1.0
        return {story: raw[i] / s for i, story in enumerate(stories)}

    def _modal_factors(self, stories: list[str], dof: int) -> list[float]:
        """
        Factor_i = φ_i (desplazamiento modal) × m_i del modo 1.

        Lanza ops.eigen(1) temporalmente (sin alterar el estado persistente)
        y toma los nodeEigenvector de los CMs.
        """
        ops = self._ops
        try:
            vals = ops.eigen("-fullGenLapack", 1)
        except Exception:
            # fallback a ARPACK si fullGenLapack no está disponible
            vals = ops.eigen(1)
        if not vals or vals[0] <= 0:
            # Fallback a triangular si eigen falla
            return [1.0 / (i + 1) for i in range(len(stories))]

        masses = self._s.get("masses", {})
        story_mass = {}
        for md in masses.values():
            s = str(md.get("story", ""))
            if s:
                story_mass[s] = float(md.get("mass_x_t" if dof == 1 else "mass_y_t", 1.0))

        out: list[float] = []
        for story in stories:
            cm = self._cm_nodes.get(story)
            if not cm:
                out.append(0.0); continue
            try:
                phi = float(ops.nodeEigenvector(cm["tag"], 1, dof))
            except Exception:
                phi = 0.0
            m_i = story_mass.get(story, 1.0)
            out.append(phi * m_i)
        return out

    # ── Análisis helpers ──────────────────────────────────────────────────────

    def _try_step(self) -> int:
        """Intenta un paso con varios algoritmos / tolerancias. Retorna 0 si
        convergió."""
        ops = self._ops
        for alg, tol, iters, args in [
            ("Newton",         1.0e-5, 25, ()),
            ("Newton",         1.0e-4, 35, ("-initial",)),
            ("ModifiedNewton", 1.0e-4, 50, ()),
            ("KrylovNewton",   1.0e-3, 50, ()),
            ("NewtonLineSearch", 1.0e-3, 50, ("-type", "Bisection")),
        ]:
            ops.test("NormDispIncr", tol, iters, 0)
            try:
                ops.algorithm(alg, *args)
            except Exception:
                continue
            if ops.analyze(1) == 0:
                return 0
        return -1

    def _base_shear(self, dof: int) -> float:
        ops = self._ops
        try:
            ops.reactions()
        except Exception:
            return 0.0
        total = 0.0
        for tag in self._base_nodes:
            try:
                total += ops.nodeReaction(tag, dof)
            except Exception:
                pass
        return -total

    def _write_partial(
        self, path: Path, direction: str, pattern_type: str,
        steps: list, status: str, total: int, converged: int,
    ) -> None:
        from datetime import datetime, timezone
        tmp = Path(path).with_suffix(".tmp")
        tmp.write_text(json.dumps({
            "status":          status,
            "direction":       direction,
            "pattern_type":    pattern_type,
            "converged_steps": converged,
            "total_steps":     total,
            "steps":           steps,
            "updated_at":      datetime.now(timezone.utc).isoformat(),
        }, indent=2), encoding="utf-8")
        tmp.replace(path)
