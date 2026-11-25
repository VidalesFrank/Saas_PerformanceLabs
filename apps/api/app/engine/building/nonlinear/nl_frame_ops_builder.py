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
        n_integration_pts: int = 5,       # 5 IPs es suficiente con HingeRadau
                                           # (localiza integración en rótulas con
                                           # pesos adaptativos; subir a 7 no mejora
                                           # precisión pero sube 30% costo)
        plastic_hinge_len: float = 0.0,   # 0 → auto = max(h_m/2, 0.1)
        collapse_mode:     str   = "ductile",  # "physical" | "ductile"
    ):
        self._c       = canonical
        self._s       = spec
        self._n_ip    = n_integration_pts
        self._lp_user = plastic_hinge_len
        # "physical": MinMax wraps Concrete02/Steel02 → fibras mueren al cruzar
        #             crush/fractura, captura colapso físico, puede causar
        #             non-convergence cuando varias fibras mueren a la vez.
        # "ductile":  SIN MinMax, los materiales mantienen su rama descendente
        #             al residual (20%/40%) indefinidamente, nunca "mueren".
        #             Mejor convergencia, obtiene curva/historia completa, pero
        #             no captura crush físico.
        self._collapse_mode = str(collapse_mode).lower().strip()
        if self._collapse_mode not in ("physical", "ductile"):
            self._collapse_mode = "ductile"

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
        self._mat_masonry_strains: dict[str, tuple[float, float]] = {}
        # ↑ material_id → (e0, eu) deformaciones positivas al pico y al colapso
        self._infill_order:  list[str] = []  # panel_id en orden estable de captura
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

    def run_gravity(self, factor: float = 1.0, steps: int = 10,
                    axial_out_path: Path | None = None) -> dict:
        """
        Análisis gravitacional incremental aplicando el peso del edificio como
        carga puntual en los CM (W_kN del spec). Se divide en N pasos y se
        bloquea con loadConst al terminar.

        Si axial_out_path está dado, al final persiste un JSON con la carga
        axial por elemento (columnas y vigas): {fid: {N_grav_kN}}. Convención
        de compresión POSITIVA.
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

        if axial_out_path is not None:
            self._persist_axial_from_gravity(axial_out_path)

        return {"status": "success" if ok == 0 else "partial"}

    def _persist_axial_from_gravity(self, out_path: Path) -> None:
        """Extrae la fuerza axial de cada columna y viga tras loadConst y la
        persiste a disco para que el posproceso (ElementData, Fase 1) la lea.

        En forceBeamColumn, ``sectionForce(ele, ip_section, 1)`` devuelve la
        fuerza axial de la sección en el IP indicado. Convención OpenSees:
        compresión < 0 → se invierte el signo para almacenar compresión > 0.

        Si la lectura falla para algún elemento, su entrada queda en 0.0 — no
        se aborta el análisis.
        """
        ops = self._ops
        payload: dict[str, dict] = {}

        for fid, ele_tag in self._ele_col_map.items():
            try:
                # IP 1 — extremo i de la columna
                N = float(ops.sectionForce(ele_tag, 1, 1))
                payload[fid] = {"N_grav_kN": -N}       # compresión positiva
            except Exception:
                payload[fid] = {"N_grav_kN": 0.0}

        for fid, ele_tag in self._ele_bm_map.items():
            try:
                N = float(ops.sectionForce(ele_tag, 1, 1))
                payload[fid] = {"N_grav_kN": -N}       # usualmente ≈ 0 en vigas
            except Exception:
                payload[fid] = {"N_grav_kN": 0.0}

        out_path = Path(out_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

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
        # Infills — orden estable idéntico al de self._infill_lines
        infill_panel_ids = list(self._infill_order)
        infill_truss_tags: list[list[int]] = [
            list(self._ele_infill_map.get(pid, [])) for pid in infill_panel_ids
        ]

        hist_joint:   list[list[list[float]]] = []
        hist_cm:      list[list[list[float]]] = []
        hist_col_def: list[list[list[float]]] = []  # per ele, 2 extremos → (k_i, k_j, eps_i, eps_j)
        hist_bm_def:  list[list[list[float]]] = []
        hist_infill:  list[list[list[float]]] = []  # (n_steps, n_panels, 2) elongación axial (m)

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
            # Elongación axial de cada corotTruss (basicDeformation → lista de 1 valor)
            if infill_truss_tags:
                step_inf: list[list[float]] = []
                for tag_pair in infill_truss_tags:
                    pair_vals: list[float] = []
                    for t in tag_pair:
                        try:
                            bd = ops.basicDeformation(t)
                            pair_vals.append(float(bd[0]) if bd else 0.0)
                        except Exception:
                            pair_vals.append(0.0)
                    # Rellenar a 2 valores si el panel sólo tuvo una diagonal
                    while len(pair_vals) < 2:
                        pair_vals.append(0.0)
                    step_inf.append(pair_vals)
                hist_infill.append(step_inf)

        steps_out: list[dict] = []
        converged = 0
        # Health tracking (Ola 2) — mismo esquema que dinámico para que el UI
        # pueda consumir el mismo bloque independiente del tipo de análisis.
        health: dict = {
            "status":                "success",
            "aborted":               False,
            "abort_reason":          None,
            "abort_step":            None,
            "abort_drift_pct":       None,
            "n_failed_steps":        0,
            "n_bisections_total":    0,
            "pathological_element":  None,
            "pathological_ranking":  [],
        }

        # Tracking del cortante pico para detectar colapso del edificio (Ola 4).
        # Criterio de parada: al perder 75 % de la resistencia lateral pico
        # (Vb/Vb_pico ≤ 0.25) el pushover se detiene — continuar después pierde
        # significado físico. Esto evita:
        #   - oscilaciones residuales por MinMax post-crush
        #   - curvas que caen "casi a cero" y luego rebotan por redistribución
        #     numérica (no refleja capacidad real del edificio después de pandeo
        #     del refuerzo y aplastamiento del núcleo)
        # Valor acordado con el ingeniero estructural (Frank Vidales, 2026-11-04).
        # Más agresivo que el criterio ATC-40 clásico (0.80 = early softening)
        # y más conservador que llegar a 0 absoluto.
        VB_PEAK_MIN_KN       = 50.0   # Vb_pico debe superarse para habilitar el check
        VB_COLLAPSE_FRAC     = 0.25   # Vb ≤ 25 % del pico → colapso (75 % pérdida)
        VB_COLLAPSE_STEPS    = 2      # 2 pasos consecutivos bajo el umbral confirman
        vb_peak_abs          = 0.0
        vb_collapse_streak   = 0

        for step_idx in range(n_steps):
            if cancel_flag and cancel_flag[0]:
                health["status"]       = "partial"
                health["aborted"]      = True
                health["abort_reason"] = "user_cancel"
                health["abort_step"]   = converged
                break
            # Primero paso completo; si falla, bisection progresivo.
            # Esto permite "atravesar" fallos locales (una fibra entra a crush
            # con MinMax) sin detener el pushover global — el edificio todavía
            # tiene capacidad por redistribución.
            if self._try_step_with_bisection(sign, inc_m, dof) != 0:
                health["status"]          = "partial"
                health["aborted"]         = True
                health["abort_reason"]    = "step_fail"
                health["abort_step"]      = converged
                health["abort_drift_pct"] = (
                    round(abs(float(ops.nodeDisp(self._control_node, dof))) / total_h * 100.0, 4)
                )
                self._populate_pathological_frames(health, col_tags + bm_tags)
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

            # Detección de colapso del edificio — Vb ya perdió 75 % del pico.
            vb_abs = abs(base_shear)
            if vb_abs > vb_peak_abs:
                vb_peak_abs = vb_abs
            if vb_peak_abs > VB_PEAK_MIN_KN:
                if vb_abs <= VB_COLLAPSE_FRAC * vb_peak_abs:
                    vb_collapse_streak += 1
                else:
                    vb_collapse_streak = 0
                if vb_collapse_streak >= VB_COLLAPSE_STEPS:
                    pct_loss = (1.0 - vb_abs / vb_peak_abs) * 100.0
                    health["status"]          = "partial"
                    health["aborted"]         = True
                    health["abort_reason"]    = "vb_near_zero"
                    health["abort_step"]      = converged
                    health["abort_drift_pct"] = round(drift_pct, 4)
                    health["vb_peak_kN"]      = round(vb_peak_abs, 2)
                    health["vb_at_abort_kN"]  = round(vb_abs, 2)
                    health["vb_loss_pct"]     = round(pct_loss, 1)
                    self._populate_pathological_frames(health, col_tags + bm_tags)
                    print(
                        f"[frame_pushover] Dir {direction}: COLAPSO — Vb cayó "
                        f"{pct_loss:.0f} % (de {vb_peak_abs:.1f} kN a {vb_abs:.1f} kN) "
                        f"en drift {drift_pct:.3f}% → análisis detenido"
                    )
                    break

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
            payload: dict = dict(
                disp_joint   = _np.asarray(hist_joint,  dtype=_np.float32),
                disp_cm      = _np.asarray(hist_cm,     dtype=_np.float32),
                col_sect_def = _np.asarray(hist_col_def, dtype=_np.float32),
                bm_sect_def  = _np.asarray(hist_bm_def,  dtype=_np.float32),
                joint_tags   = _np.asarray(joint_tag_ints, dtype=_np.int64),
                cm_tags      = _np.asarray(cm_tags,     dtype=_np.int64),
                col_tags     = _np.asarray(col_tags,    dtype=_np.int64),
                bm_tags      = _np.asarray(bm_tags,     dtype=_np.int64),
            )
            if infill_panel_ids and hist_infill:
                L0_arr = _np.asarray(
                    [next((p["L0_m"] for p in self._infill_lines if p["panel_id"] == pid), 0.0)
                     for pid in infill_panel_ids],
                    dtype=_np.float32,
                )
                e0_arr = _np.asarray(
                    [next((p["e0_strain"] for p in self._infill_lines if p["panel_id"] == pid), 0.0)
                     for pid in infill_panel_ids],
                    dtype=_np.float32,
                )
                eu_arr = _np.asarray(
                    [next((p["eu_strain"] for p in self._infill_lines if p["panel_id"] == pid), 0.0)
                     for pid in infill_panel_ids],
                    dtype=_np.float32,
                )
                payload["infill_elong"]      = _np.asarray(hist_infill, dtype=_np.float32)
                payload["infill_panel_ids"]  = _np.asarray(infill_panel_ids, dtype="U64")
                payload["infill_L0_m"]       = L0_arr
                payload["infill_e0_strain"]  = e0_arr
                payload["infill_eu_strain"]  = eu_arr
            _np.savez_compressed(history_path, **payload)
            history_meta = {
                "path":           str(history_path),
                "captured_steps": len(hist_joint),
                "stride":         history_stride,
                "n_joints":       len(joint_tag_ints),
                "n_cm":           len(cm_tags),
                "n_columns":      len(col_tags),
                "n_beams":        len(bm_tags),
                "n_infills":      len(infill_panel_ids),
            }

        status = (
            "success" if converged == n_steps
            else ("partial" if converged > 0 else "failed")
        )
        # Si salió success pero no hubo abort registrado, igual poblamos el top
        # ranking para contexto del usuario.
        if status == "success" and not health["aborted"]:
            self._populate_pathological_frames(health, col_tags + bm_tags)

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
            "health":           health,
        }
        if history_meta:
            result["history"] = history_meta
        if result_path:
            self._write_partial(result_path, direction, pattern_type,
                                steps_out, status, n_steps, converged)
        return result

    def run_dynamic(
        self,
        record_x_path:  str,
        record_y_path:  str,
        dtrec:          float,
        dt_analysis:    float = 0.005,
        damping:        float = 0.05,
        scale:          float = 1.0,
        record_units:   str   = "g",      # "g" | "mps2" | "cm/s2"
        duration:       float | None = None,
        history_path:   Path | None = None,
        progress_cb               = None,
    ) -> dict:
        """
        Análisis cronológico no lineal (NLTHA) bidireccional sobre el modelo
        de pórticos no lineal (fibras + rótulas + infills). La carga
        gravitacional debe estar aplicada previamente con `run_gravity()`.

        Los elementos registrados son columnas + vigas (frame). Los puntales
        de infill contribuyen a la respuesta pero no se registran en Prot.
        """
        from .nlth_runner import run_nlth

        if not self._control_node:
            raise RuntimeError("Modelo sin nodo de control (CM azotea).")
        if not self._base_nodes:
            raise RuntimeError("Modelo sin nodos base — no se puede correr NLTHA.")

        # CM ordenados por z
        cm_sorted = sorted(
            self._cm_nodes.items(),
            key=lambda kv: self._stories_z.get(kv[0], 0.0),
        )
        cm_tags   = [info["tag"] for _, info in cm_sorted]
        stories_z = [self._stories_z[s] for s, _ in cm_sorted]

        base_tag      = self._base_nodes[0]
        nodes_control = [base_tag] + cm_tags
        control_node  = self._control_node

        # Elementos a registrar: columnas + vigas (fibras forceBeamColumn)
        col_tags = sorted(self._ele_col_map.values())
        bm_tags  = sorted(self._ele_bm_map.values())
        elements = col_tags + bm_tags
        total_height = max(self._stories_z.values(), default=1.0)

        # Infills: panel_ids + truss tag pairs + arrays L0/e0/eu para capturar
        # elongación y post-procesar daño por panel.
        infill_panel_ids   = list(self._infill_order)
        infill_truss_tags  = [list(self._ele_infill_map.get(pid, []))
                              for pid in infill_panel_ids]
        infill_L0_arr      = [next((p["L0_m"]      for p in self._infill_lines
                                     if p["panel_id"] == pid), 0.0)
                               for pid in infill_panel_ids]
        infill_e0_arr      = [next((p["e0_strain"] for p in self._infill_lines
                                     if p["panel_id"] == pid), 0.0)
                               for pid in infill_panel_ids]
        infill_eu_arr      = [next((p["eu_strain"] for p in self._infill_lines
                                     if p["panel_id"] == pid), 0.0)
                               for pid in infill_panel_ids]

        return run_nlth(
            ops_module    = self._ops,
            nodes_control = nodes_control,
            base_nodes    = list(self._base_nodes),
            elements      = elements,
            control_node  = control_node,
            stories_z     = stories_z,
            total_height  = total_height,
            record_x_path = record_x_path,
            record_y_path = record_y_path,
            dtrec         = dtrec,
            dt_analysis   = dt_analysis,
            damping       = damping,
            scale         = scale,
            record_units  = record_units,
            duration      = duration,
            eletype       = "frame",
            history_path  = history_path,
            progress_cb   = progress_cb,
            infill_panel_ids  = infill_panel_ids,
            infill_truss_tags = infill_truss_tags,
            infill_L0_arr     = infill_L0_arr,
            infill_e0_arr     = infill_e0_arr,
            infill_eu_arr     = infill_eu_arr,
        )

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
        """Concrete02 Mander envuelto en MinMax.

        Dos esquemas según confinamiento:

          - `label == "conf"` (núcleo confinado DMO/DES):
             * Residual post-pico: 40% de f'c (consistente con Mander para
               confinamiento efectivo s/db≤8 — el estribo mantiene al núcleo
               trabajando mucho más allá de εcu nominal).
             * MinMax crush en -4.0·εcu (en el rango 0.08-0.10 típico Mander),
               para no "matar" la fibra prematuramente y evitar snap-throughs
               numéricos cuando múltiples fibras cruzan simultáneamente.

          - `label != "conf"` (recubrimiento sin confinar):
             * Residual 20% (el no-confinado no retiene mucho post-pico).
             * MinMax crush en -3.0·εcu (sin estribo cercano, el crush físico
               ocurre más rápido pero necesitamos margen para que la columna
               redistribuya a las caras internas).

        Esto permite capturar comportamiento DMO completo hasta drift ≥ 4%
        sin perder convergencia en edificios bien detallados.
        """
        key = (round(fcc_MPa, 2), round(eps_cc, 5), round(eps_cu, 5), label)
        if key in self._mat_concrete:
            return self._mat_concrete[key]

        confined = (label == "conf")

        # Material base Concrete02 — residual depende del nivel de confinamiento.
        tag_base = self._next_mat()
        fcc_kPa = fcc_MPa * 1000.0
        f_cu    = (0.40 if confined else 0.20) * fcc_kPa   # residual
        ft      = 0.10 * fcc_kPa                            # tracción
        Ets     = ft / max(eps_cc * 0.5, 0.0005)
        self._ops.uniaxialMaterial(
            "Concrete02", tag_base,
            -fcc_kPa, -eps_cc,
            -f_cu,    -eps_cu,
            0.1, ft, Ets,
        )

        # Modo ductile → no envolvemos; Concrete02 mantiene residual indefinido.
        if self._collapse_mode == "ductile":
            self._mat_concrete[key] = tag_base
            return tag_base

        # Modo physical → MinMax wrapper con crush físico adaptado al confinamiento.
        tag_wrap = self._next_mat()
        eps_crush   = (-4.0 if confined else -3.0) * eps_cu
        eps_tension = +5.0 * (ft / 1000.0 / 24000.0)
        self._ops.uniaxialMaterial(
            "MinMax", tag_wrap, tag_base,
            "-min", eps_crush,
            "-max", eps_tension,
        )
        self._mat_concrete[key] = tag_wrap
        return tag_wrap

    def _get_steel(self, fy_MPa: float, eps_su: float = 0.10, b_hard: float = 0.01) -> int:
        """Steel02 (Menegotto-Pinto) envuelto en MinMax para fractura simétrica.

        Default εsu = 0.10 (A615 Gr60). Al llegar a |ε| ≥ εsu, la barra
        fractura (σ=0 definitivo) — captura el colapso dúctil del acero
        longitudinal, que Steel02 solo no hace.

        Para acero estructural (A36/A572/A992/A500) usar b_hard ≈ 0.003 y
        eps_su ≈ 0.20 — ductilidad del perfil laminado es mayor que la barra.
        """
        key = (round(fy_MPa, 1), round(eps_su, 4), round(b_hard, 4))
        if key in self._mat_steel:
            return self._mat_steel[key]
        tag_base = self._next_mat()
        self._ops.uniaxialMaterial(
            "Steel02", tag_base,
            fy_MPa * 1000.0,       # Fy [kPa]
            200_000_000.0,          # E0 = 200 GPa [kPa]
            b_hard,                 # b (hardening)
            15.0, 0.925, 0.15,      # R0, cR1, cR2
        )
        # Modo ductile → no envolvemos; Steel02 no fractura y mantiene
        # resistencia post-fluencia con hardening residual.
        if self._collapse_mode == "ductile":
            self._mat_steel[key] = tag_base
            return tag_base

        # Modo physical → MinMax con buffer 1.5·εsu (A615 Gr60 real).
        tag_wrap = self._next_mat()
        eps_fail = 1.5 * eps_su
        self._ops.uniaxialMaterial(
            "MinMax", tag_wrap, tag_base,
            "-min", -eps_fail,
            "-max",  eps_fail,
        )
        self._mat_steel[key] = tag_wrap
        return tag_wrap

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

        # Mallado reducido alineado con estrucmed-web (archetype_1 original).
        # Previamente 8×8 core + laterales 2×10 = 136 fibras/sección; ahora
        # 6×6 core + laterales 2×6 = 84 fibras. Se mantiene resolución suficiente
        # para captar la ley momento-curvatura; speedup del solver ~1.4×.
        n_fib_core_y = 6
        n_fib_core_z = 6
        n_fib_cov_t  = 2   # transverse (through cover thickness)
        n_fib_lat_lo = 6   # longitudinal subdivs en los covers laterales

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
        ops.patch("rect", mat_cover, n_fib_cov_t, n_fib_lat_lo,
                  y1,  z1,  yc1, z2)          # left (abarca esquinas)
        ops.patch("rect", mat_cover, n_fib_cov_t, n_fib_lat_lo,
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

    # ── Sección fiber para acero estructural (W / HSS / Pipe) ────────────────

    def _build_steel_fiber_section(
        self, sec_tag: int, steel: dict,
    ) -> None:
        """Construye una seccion Fiber de perfil laminado AISC con un solo
        material Steel02 (MinMax-wrapped para fractura ductil).

        Convencion local: y = depth (strong), z = width (weak). Origen en el
        centroide. Unidades: m / kN.

        Soportados:
        - W-shape: 3 patches (flange sup, flange inf, alma)
        - HSS rectangular: 4 strips perimetrales (caja hueca)
        - Pipe / HSS redondo: patch circular anular
        """
        ops = self._ops

        fy = float(steel.get("fy_MPa", 345.0))
        aisc_type = str(steel.get("aisc_type", "W")).upper()

        # Familias geometricas (ver `engine.sections.steel_shapes`):
        # - I-shapes:   W/S/M/HP + IPE/HEA/HEB/HEM  -> 3 patches (flanges + alma)
        # - Box (HSS):  HSS_RECT + PTE              -> 4 strips perimetrales
        # - Round tube: PIPE/HSS_ROUND + PHR        -> patch circular anular
        _I_FAM   = {"W", "S", "M", "HP", "IPE", "HEA", "HEB", "HEM"}
        _BOX_FAM = {"HSS_RECT", "PTE"}
        _RND_FAM = {"PIPE", "HSS_ROUND", "PHR"}

        # Material acero estructural: b=0.003, eps_su=0.20 (ductil A992/A500)
        mat_tag = self._get_steel(fy, eps_su=0.20, b_hard=0.003)

        # Rigidez torsional elastica
        E = float(steel.get("E_MPa", 200_000.0)) * 1000.0   # kPa
        G = float(steel.get("G_MPa", 77_000.0))  * 1000.0
        J = float(steel.get("J_m4", 1e-6))
        torsion_tag = self._get_torsion(G * J)
        ops.section("Fiber", sec_tag, "-torsion", torsion_tag)

        if aisc_type in _I_FAM:
            d  = float(steel.get("d_m", 0.3))
            bf = float(steel.get("bf_m", 0.2))
            tw = float(steel.get("tw_m", 0.01))
            tf = float(steel.get("tf_m", 0.015))
            hd = d / 2.0
            hb = bf / 2.0
            hw_core = (d - 2.0 * tf) / 2.0
            htw = tw / 2.0
            nf_flange_w, nf_flange_t = 10, 2
            nf_web_d, nf_web_t = 12, 2
            # Flange superior
            ops.patch("rect", mat_tag, nf_flange_t, nf_flange_w,
                       hw_core, -hb,  hd,     hb)
            # Flange inferior
            ops.patch("rect", mat_tag, nf_flange_t, nf_flange_w,
                      -hd,     -hb, -hw_core, hb)
            # Alma
            ops.patch("rect", mat_tag, nf_web_d, nf_web_t,
                      -hw_core, -htw, hw_core, htw)

        elif aisc_type in _BOX_FAM:
            d  = float(steel.get("d_m", 0.2))
            bf = float(steel.get("bf_m", 0.2))
            t  = float(steel.get("t_des_m", 0.012))
            hd = d / 2.0
            hb = bf / 2.0
            hd_in = hd - t
            hb_in = hb - t
            nfl, nft = 8, 1
            # Strip superior
            ops.patch("rect", mat_tag, nft, nfl, hd_in,  -hb, hd,     hb)
            # Strip inferior
            ops.patch("rect", mat_tag, nft, nfl, -hd,    -hb, -hd_in, hb)
            # Strip izquierdo
            ops.patch("rect", mat_tag, nfl, nft, -hd_in, -hb,    hd_in, -hb_in)
            # Strip derecho
            ops.patch("rect", mat_tag, nfl, nft, -hd_in, hb_in,  hd_in,  hb)

        elif aisc_type in _RND_FAM:
            OD = float(steel.get("OD_m", 0.2))
            t  = float(steel.get("t_des_m", 0.008))
            r_ext = OD / 2.0
            r_int = r_ext - t
            ops.patch("circ", mat_tag, 24, 3, 0.0, 0.0, r_int, r_ext)

        else:
            # Fallback: perfil desconocido → seccion rectangular solida con
            # area A_m2. Marginalmente conservador pero evita fallo duro.
            A = float(steel.get("A_m2", 0.01))
            half = math.sqrt(A) / 2.0
            ops.patch("rect", mat_tag, 6, 6, -half, -half, half, half)

    def _build_steel_frame_element(
        self, fid: str, el: dict, kind: str,
    ) -> None:
        """Construye un forceBeamColumn con seccion fiber de acero. Reusa
        HingeRadau (mismo patron que RC) con sec_end = sec_mid = seccion de
        acero (uniforme a lo largo). lp ≈ d/2 (regla de pulgar perfiles
        laminados).

        kind ∈ {"column", "beam"}.
        """
        ops = self._ops
        steel = el.get("steel", {})
        geo   = el.get("geometry", {})
        L     = float(geo.get("L_m", 3.0))
        d     = float(steel.get("d_m", 0.3))
        lp    = self._lp_user if self._lp_user > 0.0 else max(d / 2.0, 0.10)
        lp    = min(lp, L * 0.45)

        ni_lbl = el["node_i"]; nj_lbl = el["node_j"]
        ni = _joint_tag(ni_lbl); nj = _joint_tag(nj_lbl)

        sec_tag = self._next_sec()
        self._build_steel_fiber_section(sec_tag, steel)

        integ_tag = self._next_integ()
        try:
            ops.beamIntegration(
                "HingeRadau", integ_tag,
                sec_tag, float(lp), sec_tag, float(lp), sec_tag,
            )
            transf = _TRANSF_COL if kind == "column" else _TRANSF_BM
            if kind == "column":
                ele_tag = _ELE_COL_OFFSET + len(self._ele_col_map) + 1
            else:
                ele_tag = _ELE_BM_OFFSET + len(self._ele_bm_map) + 1
            ops.element(
                "forceBeamColumn", ele_tag, ni, nj, transf, integ_tag,
                "-iter", 50, 1.0e-8,
            )
        except Exception as exc:
            print(f"[NLFrameOPSBuilder] {kind} acero {fid}: {exc}")
            return

        if kind == "column":
            self._ele_col_map[fid] = ele_tag
            self._valid_frame_joints.add(ni_lbl)
            self._valid_frame_joints.add(nj_lbl)
        else:
            self._ele_bm_map[fid] = ele_tag

        self._element_lines.append({
            "fid":       str(fid),
            "kind":      kind,
            "story":     el.get("story", ""),
            "ele_tag":   ele_tag,
            "node_i":    ni, "node_j": nj,
            "node_i_lbl": ni_lbl, "node_j_lbl": nj_lbl,
            "material_kind": "steel",
            "steel_shape": steel.get("shape", ""),
            "steel_grade": steel.get("grade", ""),
            "d_m": d,
            "L_m": L,
            "lp_m": round(lp, 4),
        })

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

    def _column_bar_layers_by_group(
        self, groups: dict, b_m: float, h_m: float, cover_m: float,
    ) -> list[dict]:
        """
        Distribución granular: 4 esquinas con un diámetro + 4 caras (top, bot,
        left, right) con sus propios diámetros y conteos.

        Las esquinas son fibras puntuales en las 4 esquinas internas.
        Las caras: capas rectas entre esquinas, con n_bars intermedias.
        """
        # Diámetros y áreas por grupo
        corner = groups.get("corners", {})
        db_corner_m = _bar_diam_m(corner.get("bar_label", "#6"))
        As_corner   = _bar_area_m2(corner.get("bar_label", "#6"))

        # Coordenadas de las 4 esquinas internas (centro de barra)
        # El eje "y" apunta en dirección b, "z" en dirección h (convención OpenSees)
        y_lo = -b_m / 2.0 + cover_m + db_corner_m / 2.0
        y_hi =  b_m / 2.0 - cover_m - db_corner_m / 2.0
        z_lo = -h_m / 2.0 + cover_m + db_corner_m / 2.0
        z_hi =  h_m / 2.0 - cover_m - db_corner_m / 2.0

        layers: list[dict] = []

        # 4 esquinas como fibras puntuales
        for (yc, zc) in [(y_lo, z_hi), (y_hi, z_hi), (y_lo, z_lo), (y_hi, z_lo)]:
            layers.append({"kind": "point", "y": yc, "z": zc, "As_m2": As_corner, "n": 1})

        # Barras intermedias por cara (entre las dos esquinas correspondientes)
        for face_key, (y1, z1, y2, z2) in [
            ("top_face",   (y_lo, z_hi, y_hi, z_hi)),
            ("bot_face",   (y_lo, z_lo, y_hi, z_lo)),
            ("left_face",  (y_lo, z_lo, y_lo, z_hi)),
            ("right_face", (y_hi, z_lo, y_hi, z_hi)),
        ]:
            face = groups.get(face_key, {})
            n_face = int(face.get("n_bars", 0))
            if n_face <= 0:
                continue
            label = str(face.get("bar_label", "#5"))
            As    = _bar_area_m2(label)
            db    = _bar_diam_m(label)
            # Insertar las N barras ENTRE las dos esquinas (sin tocarlas). La
            # `ops.layer("straight", ...)` con n+2 bar coloca puntos en los
            # extremos; usamos un sub-tramo para evitar duplicar las esquinas.
            if face_key in ("top_face", "bot_face"):
                step = (y2 - y1) / (n_face + 1)
                for i in range(1, n_face + 1):
                    y = y1 + step * i
                    z = z1
                    layers.append({
                        "kind": "point", "y": y, "z": z,
                        "As_m2": As, "n": 1, "db_m": db,
                    })
            else:
                step = (z2 - z1) / (n_face + 1)
                for i in range(1, n_face + 1):
                    y = y1
                    z = z1 + step * i
                    layers.append({
                        "kind": "point", "y": y, "z": z,
                        "As_m2": As, "n": 1, "db_m": db,
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

            # ── Branch acero estructural ────────────────────────────────
            if col.get("material_kind") == "steel":
                self._build_steel_frame_element(fid, col, kind="column")
                continue

            geo    = col.get("geometry", {})
            b      = float(geo.get("b_m", 0.30))
            h      = float(geo.get("h_m", 0.30))
            L      = float(geo.get("L_m", 3.0))
            fc     = float(geo.get("fc_MPa", 21.0))
            fy     = float(geo.get("fy_MPa", 420.0))
            cover  = float(geo.get("cover_m", 0.040))

            long_r = col.get("reinforcement", {}).get("longitudinal", {})
            # Si viene granular (grupos), usar reparto por grupo con diámetros
            # distintos. Si no, caer al legacy (un solo diámetro).
            groups = long_r.get("groups")

            conf   = col.get("confinement", {})
            conf_end = conf.get("end", {})
            conf_mid = conf.get("mid", {})

            # Secciones Fiber (end y mid)
            sec_end = self._next_sec()
            sec_mid = self._next_sec()
            if isinstance(groups, dict):
                bar_layers = self._column_bar_layers_by_group(groups, b, h, cover)
            else:
                n_bars = int(long_r.get("n_bars", 8))
                label  = str(long_r.get("bar_label", "#5"))
                db_m   = _bar_diam_m(label)
                As_bar = _bar_area_m2(label)
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
                # -iter 50 1e-8: itera hasta 50 veces internamente para encontrar
                # fuerzas/deformaciones compatibles de la sección (defaults de
                # OpenSees son 10 iter / 1e-16, muy estrictos en no-linealidad
                # fuerte y causan "failed to get compatible element forces").
                ops.element(
                    "forceBeamColumn", ele_tag, ni, nj, _TRANSF_COL, integ_tag,
                    "-iter", 50, 1.0e-8,
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
        n_elastic_short = 0

        for fid, bm in beams.items():
            ni_lbl = bm["node_i"]; nj_lbl = bm["node_j"]
            if ni_lbl not in self._valid_joints or nj_lbl not in self._valid_joints:
                continue

            # ── Branch acero estructural ────────────────────────────────
            if bm.get("material_kind") == "steel":
                self._build_steel_frame_element(fid, bm, kind="beam")
                continue

            geo    = bm.get("geometry", {})
            b      = float(geo.get("b_m", 0.30))
            h      = float(geo.get("h_m", 0.40))
            L      = float(geo.get("L_m", 4.0))
            fc     = float(geo.get("fc_MPa", 21.0))
            fy     = float(geo.get("fy_MPa", 420.0))
            cover  = float(geo.get("cover_m", 0.040))

            # ── Vigas cortas (L/h < 2): modelar como elasticBeamColumn ──────
            # ACI 318 §18.10.7 las trata como "coupling beams" con formulación
            # aparte. forceBeamColumn + HingeRadau en L/h < 2 genera oscilación
            # numérica porque los 6 IPs (2 Lobatto por hinge + 2 Gauss interior)
            # quedan amontonados: intervalo elástico interior = L − 2·lp
            # puede ser < 0.5·L y los IPs se superponen. El elemento pelea con
            # el solver aún a deformaciones pequeñas (verificado 2026-11-04 con
            # viga 80000249 de Prueba 4: θ_p = 0.0007 rad y hacía bulldozer).
            # Modelarlas elásticas es conservador: la demanda se transfiere a
            # los pórticos principales adyacentes (que son los que diseñamos).
            if L / h < 2.0:
                Ec_mpa = 4700 * (fc ** 0.5)  # NSR-10 C.8.5.1
                Ec_kpa = Ec_mpa * 1000.0
                Ag   = b * h
                Iy   = b * (h ** 3) / 12.0
                Iz   = h * (b ** 3) / 12.0
                Jx   = 0.21 * b * (h ** 3) * (
                    1.0 - 0.63 * b / h + 0.052 * (b / h) ** 5
                ) if b < h else 0.21 * h * (b ** 3)
                Gc_kpa = Ec_kpa / (2.0 * (1.0 + 0.2))
                ele_tag = _ELE_BM_OFFSET + len(self._ele_bm_map) + 1
                ni = _joint_tag(ni_lbl); nj = _joint_tag(nj_lbl)
                try:
                    ops.element(
                        "elasticBeamColumn", ele_tag, ni, nj,
                        float(Ag), float(Ec_kpa), float(Gc_kpa),
                        float(Jx), float(Iy), float(Iz),
                        _TRANSF_BM,
                    )
                except Exception as exc:
                    print(f"[NLFrameOPSBuilder] viga corta fid={fid} L/h={L/h:.2f}: {exc}")
                    continue
                self._ele_bm_map[fid] = ele_tag
                self._element_lines.append({
                    "fid":        str(fid),
                    "kind":       "beam",
                    "model":      "elastic",   # distinción vs "fiber"
                    "story":      bm.get("story", ""),
                    "ele_tag":    ele_tag,
                    "node_i":     ni, "node_j": nj,
                    "node_i_lbl": ni_lbl, "node_j_lbl": nj_lbl,
                    "b_m": b, "h_m": h, "L_m": L, "lp_m": 0.0,
                    "reason_elastic": f"L/h={L/h:.2f} < 2 (coupling beam, estabilidad numérica)",
                })
                n_elastic_short += 1
                continue

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
                # -iter: ver nota en columnas; mismo criterio para vigas que
                # entran a plasticidad rápido (vigas DMO con θ_IO ≈ 0.005).
                ops.element(
                    "forceBeamColumn", ele_tag, ni, nj, _TRANSF_BM, integ_tag,
                    "-iter", 50, 1.0e-8,
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

        if n_elastic_short > 0:
            print(f"[NLFrameOPSBuilder] {n_elastic_short} vigas cortas (L/h < 2) "
                  f"modeladas como elasticBeamColumn — coupling/spandrel beams, "
                  f"no participan en mecanismo de colapso.")

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
            # Deformaciones positivas al pico y colapso del material (para damage index)
            self._mat_masonry_strains[mat_id] = (abs(float(eps0)), abs(float(epsu)))
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
                    self._infill_order.append(str(pid))
                    mat_id = str(panel.get("masonry_material_id", ""))
                    e0_m, eu_m = self._mat_masonry_strains.get(mat_id, (0.0, 0.0))
                    L0_m = float(g["diagonal_m"])
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
                        "material_id":    mat_id,
                        "ele_tags":       tags,
                        # Metadata para post-proceso de daño
                        "L0_m":           round(L0_m, 6),
                        "e0_strain":      round(e0_m, 8),
                        "eu_strain":      round(eu_m, 8),
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

    def _populate_pathological_frames(
        self, health: dict, elements: list[int], top_n: int = 5
    ) -> None:
        """
        Al abortar el pushover, sondea elementos para rankearlos por rotación
        plástica acumulada. Permite al usuario ver qué elemento tumbó el análisis.
        """
        ops = self._ops
        ranked: list[dict] = []
        for tag in elements:
            try:
                pd = ops.eleResponse(int(tag), 'plasticDeformation')
                if pd is None:
                    continue
                theta_max = max((abs(float(x)) for x in pd), default=0.0)
                ranked.append({
                    "ele_tag":     int(tag),
                    "theta_p_max": round(theta_max, 5),
                })
            except Exception:
                continue
        if not ranked:
            return
        ranked.sort(key=lambda r: -r["theta_p_max"])
        health["pathological_element"] = dict(ranked[0])
        health["pathological_ranking"] = ranked[:top_n]

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

    def _try_step_with_bisection(
        self,
        sign:   float,
        inc_m:  float,
        dof:    int,
        max_subdivisions: tuple[int, ...] = (2, 4, 10, 20, 50, 100),
    ) -> int:
        """Intenta un paso completo. Si falla, subdivide el incremento
        progresivamente y reintenta hasta `max_subdivisions`.

        Permite "atravesar" transiciones bruscas (p.ej. una fibra entra
        a crush con MinMax) con pasos finos aunque el solver no converja
        con el incremento completo.

        Retorna 0 si tras alguna subdivisión el conjunto de sub-pasos
        logra avanzar un incremento equivalente al original, −1 si todas
        las subdivisiones fallan.
        """
        ops = self._ops
        # Primer intento con el step completo
        if self._try_step() == 0:
            return 0

        for n_sub in max_subdivisions:
            inc_sub = sign * inc_m / n_sub
            ops.integrator("DisplacementControl", self._control_node, dof, inc_sub)
            ok_sub = 0
            for _ in range(n_sub):
                if self._try_step() != 0:
                    break
                ok_sub += 1
            # Siempre restaurar el integrator original (importante para el
            # próximo paso principal)
            ops.integrator("DisplacementControl", self._control_node, dof, sign * inc_m)
            if ok_sub == n_sub:
                return 0
            # Si avanzamos parcialmente, aceptamos y seguimos — es mejor que detener
            if ok_sub >= max(1, n_sub // 2):
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
