"""
Análisis cronológico no lineal (NLTHA / Time-History) para edificios.

Thin wrapper sobre `dinamicoBD4_adaptive` del motor dinámico que:
  - Compone el `factor` del timeSeries según unidades del registro (g vs m/s²).
  - Deriva `nPts` desde el archivo si no se pasa `duration`.
  - Captura Vb(t) sumando reacciones de los nodos base.
  - Calcula envolventes (derivas, aceleraciones) y clasificación de daño.
  - Serializa la salida en payload amigable para la API + NPZ comprimido.

Diseñado para funcionar con `NLWallOPSBuilder` (muros, MVLEM_3D) y
`NLFrameOPSBuilder` (pórticos con fibras + rótulas + infills).

Unidades: m, kN, s. Aceleraciones en m/s² (o g con `record_units="g"`).
"""
from __future__ import annotations

from pathlib import Path
from typing import Callable, Literal, Optional

import numpy as np

from app.engine.building.dynamic import dinamicoBD4_adaptive


# ──────────────────────────────────────────────────────────────────────────────
# Umbrales ASCE 41-17 por defecto para rotación plástica de rótulas (rad)
# Columnas RC con confinamiento DMO típico — misma convención que el
# HingeThresholdsPanel del pushover.
# ──────────────────────────────────────────────────────────────────────────────
_HINGE_THRESHOLDS_DEFAULT = {
    "IO":       0.005,   # Immediate Occupancy
    "LS":       0.015,   # Life Safety
    "CP":       0.025,   # Collapse Prevention
    "collapse": 0.040,   # colapso efectivo
}


# Capacidad de deriva típica por ductilidad NSR-10 (fracción = m/m)
_DRIFT_CAPACITY = {
    "DES": 0.025, "DMO": 0.015, "DMI": 0.010,
}
_DI_CRITICAL = 0.40


def _count_steps_in_record(path: str) -> int:
    """Cuenta líneas no vacías en un archivo ACC (una columna por línea)."""
    n = 0
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            if line.strip():
                n += 1
    return n


def _resolve_factor(record_units: str, scale: float) -> float:
    u = record_units.lower().strip()
    if u in ("g", "gal_g"):
        return 9.81 * scale
    if u in ("mps2", "m/s2", "m/s^2"):
        return scale
    if u == "cm/s2":
        return 0.01 * scale
    raise ValueError(f"record_units desconocidas: {record_units!r} (usa 'g' | 'mps2' | 'cm/s2')")


def _classify_hinge(theta_p_max: float, th: dict) -> str:
    """Clasifica una rótula por su |θ_p| máximo histórico. Devuelve io|ls|cp|collapse|none."""
    if theta_p_max >= th["collapse"]: return "collapse"
    if theta_p_max >= th["CP"]:       return "cp"
    if theta_p_max >= th["LS"]:       return "ls"
    if theta_p_max >= th["IO"]:       return "io"
    return "none"


def _hinge_damage_from_history(
    Prot:         Optional[np.ndarray],   # (n_ele, n_steps, 6)
    elements:     list[int],
    th:           dict,
) -> dict:
    """
    Para pórticos: cada elemento tiene 6 rotaciones plásticas (3 por extremo).
    Tomamos `θ_p_max = max |θ_p|` sobre todos los pasos y DOFs de rotación
    (dofs 3,4,5 por extremo) y clasificamos por umbrales ASCE 41.
    """
    if Prot is None or Prot.size == 0:
        return {"status": "no_data", "n_elements": 0}

    # DOFs 3,4,5 son las rotaciones del extremo i; 9,10,11 del extremo j.
    # Prot aquí tiene 6 columnas → es un resumen por elemento (3 rot i + 3 rot j).
    # Tomamos el máximo absoluto sobre todas.
    theta_max = np.max(np.abs(Prot), axis=(1, 2))  # (n_ele,)

    buckets  = {"none": 0, "io": 0, "ls": 0, "cp": 0, "collapse": 0}
    worst    = []
    for i, ele_tag in enumerate(elements):
        tp = float(theta_max[i])
        lvl = _classify_hinge(tp, th)
        buckets[lvl] += 1
        worst.append({
            "element":     int(ele_tag),
            "theta_p_max": round(tp, 5),
            "level":       lvl,
        })
    worst.sort(key=lambda r: -r["theta_p_max"])

    return {
        "status":     "success",
        "scheme":     "ASCE 41-17 (rotación plástica)",
        "thresholds": th,
        "counts":     buckets,
        "max_theta_p": float(theta_max.max()) if theta_max.size else 0.0,
        "worst_elements": worst[:20],
    }


def _pier_damage_from_history(
    driftX:      np.ndarray,
    driftY:      np.ndarray,
    stories_z:   list[float],
    ductility:   str = "DMO",
    direction:   str = "X",
) -> dict:
    """
    Para muros: estimador Park-Ang simplificado por piso:
      DI = max |deriva(t)| / drift_capacity_ductilidad
      Severe:  DI ≥ 0.40
      Collapse: DI ≥ 1.00
    No distingue pier individual (el NPZ del NLTHA no persiste resp. por pier
    como el pushover). Da un resumen por piso que sirve para evaluación global.
    """
    drift_cap = _DRIFT_CAPACITY.get(ductility.upper(), _DRIFT_CAPACITY["DMO"])
    drift_src = driftX if direction == "X" else driftY
    if drift_src is None or drift_src.size == 0:
        return {"status": "no_data"}

    story_rows = []
    buckets    = {"none": 0, "minor": 0, "moderate": 0, "severe": 0, "collapse": 0}
    for i in range(drift_src.shape[1]):
        max_drift = float(np.max(np.abs(drift_src[:, i])))
        di        = max_drift / drift_cap
        if   di >= 1.00: level = "collapse"
        elif di >= 0.40: level = "severe"
        elif di >= 0.25: level = "moderate"
        elif di >= 0.10: level = "minor"
        else:            level = "none"
        buckets[level] += 1
        story_rows.append({
            "story_idx":  i + 1,
            "z_m":        float(stories_z[i]) if i < len(stories_z) else 0.0,
            "max_drift_pct": round(max_drift * 100.0, 4),
            "DI":          round(di, 3),
            "level":       level,
        })

    return {
        "status":     "success",
        "scheme":     "Park-Ang simplificado por piso (deriva/capacidad)",
        "ductility":  ductility,
        "drift_cap":  drift_cap,
        "counts":     buckets,
        "max_di":     max((r["DI"] for r in story_rows), default=0.0),
        "stories":    story_rows,
    }


def run_nlth(
    *,
    ops_module,
    nodes_control:    list[int],         # [base_node, cm_z1, cm_z2, ..., cm_zN]
    base_nodes:       list[int],         # todos los nodos de la base (para Vb)
    elements:         list[int],
    control_node:     int,
    stories_z:        list[float],
    total_height:     float,
    record_x_path:    str,
    record_y_path:    str,
    dtrec:            float,
    dt_analysis:      float = 0.005,
    damping:          float = 0.05,
    scale:            float = 1.0,
    record_units:     Literal["g", "mps2", "cm/s2"] = "g",
    duration:         Optional[float] = None,
    eletype:          Literal["wall", "frame"] = "wall",
    history_path:     Optional[Path] = None,
    progress_cb:      Optional[Callable[[dict], None]] = None,
    # Daño post-sismo
    ductility:        str = "DMO",
    hinge_thresholds: Optional[dict] = None,   # None → ASCE 41 default
    # Bloque B — captura de deformaciones de sección cada N pasos para
    # detección de eventos locales (aplastamiento, pandeo, fluencia, fractura).
    # Stride típico: 10 (resolución 0.05s para dtrec=0.005).  0 = desactivado.
    sect_def_stride:  int = 10,
    # Captura paralela de infills (mismo stride que sect_def).  Si estos args
    # vienen poblados, se persiste el daño por panel en el payload final.
    infill_panel_ids:  Optional[list[str]]        = None,
    infill_truss_tags: Optional[list[list[int]]]  = None,
    infill_L0_arr:     Optional[list[float]]      = None,
    infill_e0_arr:     Optional[list[float]]      = None,
    infill_eu_arr:     Optional[list[float]]      = None,
) -> dict:
    """Ejecuta NLTHA bidireccional. Ver module docstring para schema de salida."""
    nPts_x = _count_steps_in_record(record_x_path)
    nPts_y = _count_steps_in_record(record_y_path)
    nPts = min(nPts_x, nPts_y)
    if duration is not None:
        nPts = min(nPts, int(duration / dtrec) + 1)

    factor = _resolve_factor(record_units, scale)

    # Captura de sect_def solo tiene sentido en frames (fibras).
    stride = sect_def_stride if eletype == "frame" else 0

    result_tuple = dinamicoBD4_adaptive(
        record_paths  = [record_x_path, record_y_path],
        dtrec         = dtrec,
        nPts          = nPts,
        dt            = dt_analysis,
        factor        = factor,
        damp          = damping,
        IDctrlNode    = control_node,
        IDctrlDOF     = 1,
        nodes_control = nodes_control,
        elements      = elements,
        modes         = (0, 2),
        Kswitch       = 1,
        Tol           = 1e-4,
        eletype       = eletype,
        progress_cb   = progress_cb,
        progress_every= 25,
        base_nodes    = base_nodes,
        sect_def_stride   = stride,
        infill_truss_tags = infill_truss_tags,
    )

    sect_def_arr:    Optional[np.ndarray] = None
    sect_t_arr:      Optional[np.ndarray] = None
    infill_elong_arr: Optional[np.ndarray] = None
    if len(result_tuple) == 18:
        (tiempo, techo1, techo2, techoT,
         node_disp, node_vel, node_acel, node_disp2, node_acel2,
         driftX, driftY, Prot, Eds, Vb_x, Vb_y,
         sect_def_arr, sect_t_arr, infill_elong_arr) = result_tuple
    elif len(result_tuple) == 17:
        (tiempo, techo1, techo2, techoT,
         node_disp, node_vel, node_acel, node_disp2, node_acel2,
         driftX, driftY, Prot, Eds, Vb_x, Vb_y,
         sect_def_arr, sect_t_arr) = result_tuple
    else:
        (tiempo, techo1, techo2, techoT,
         node_disp, node_vel, node_acel, node_disp2, node_acel2,
         driftX, driftY, Prot, Eds, Vb_x, Vb_y) = result_tuple

    t_elapsed = float(tiempo[-1]) if len(tiempo) > 0 else 0.0
    t_target  = dtrec * nPts
    status    = "success" if t_elapsed + 1e-6 >= t_target else "partial"

    # ── Envolventes ─────────────────────────────────────────────────────────
    max_abs_x = float(np.max(np.abs(techo1))) if techo1.size else 0.0
    max_abs_y = float(np.max(np.abs(techo2))) if techo2.size else 0.0

    drift_max_by_story_x: list[float] = []
    drift_max_by_story_y: list[float] = []
    if driftX.size:
        drift_max_by_story_x = [float(np.max(np.abs(driftX[:, i]))) * 100.0 for i in range(driftX.shape[1])]
    if driftY.size:
        drift_max_by_story_y = [float(np.max(np.abs(driftY[:, i]))) * 100.0 for i in range(driftY.shape[1])]
    max_drift_x_pct = max(drift_max_by_story_x, default=0.0)
    max_drift_y_pct = max(drift_max_by_story_y, default=0.0)

    # Envolvente de aceleración absoluta por piso (m/s² y g). Se omite base.
    accel_max_x_mps2: list[float] = []
    accel_max_y_mps2: list[float] = []
    if node_acel.size and node_acel.ndim == 2:
        for i in range(1, node_acel.shape[1]):   # skip base (idx 0)
            accel_max_x_mps2.append(float(np.max(np.abs(node_acel[:, i]))))
            accel_max_y_mps2.append(float(np.max(np.abs(node_acel2[:, i]))))

    # Vb máximos
    max_Vb_x_kN = float(np.max(np.abs(Vb_x))) if Vb_x is not None and Vb_x.size else 0.0
    max_Vb_y_kN = float(np.max(np.abs(Vb_y))) if Vb_y is not None and Vb_y.size else 0.0

    # ── Daño post-sismo ─────────────────────────────────────────────────────
    th = hinge_thresholds or _HINGE_THRESHOLDS_DEFAULT
    if eletype == "frame":
        damage = _hinge_damage_from_history(Prot, elements, th)
    else:
        damage_dir = "X" if max_drift_x_pct >= max_drift_y_pct else "Y"
        damage = _pier_damage_from_history(driftX, driftY, stories_z, ductility, damage_dir)

    # ── Persistir NPZ con historia completa (opcional) ──────────────────────
    hist_meta: Optional[dict] = None
    if history_path is not None:
        history_path.parent.mkdir(parents=True, exist_ok=True)
        npz_payload: dict = dict(
            t          = tiempo.astype(np.float32),
            techo_x    = techo1.astype(np.float32),
            techo_y    = techo2.astype(np.float32),
            node_disp_x= node_disp.astype(np.float32),
            node_disp_y= node_disp2.astype(np.float32),
            node_acel_x= node_acel.astype(np.float32),
            node_acel_y= node_acel2.astype(np.float32),
            drift_x    = driftX.astype(np.float32),
            drift_y    = driftY.astype(np.float32),
            Vb_x       = Vb_x.astype(np.float32) if Vb_x is not None else np.zeros((0,), np.float32),
            Vb_y       = Vb_y.astype(np.float32) if Vb_y is not None else np.zeros((0,), np.float32),
            plastic_def= Prot.astype(np.float32) if Prot is not None else np.zeros((0,), np.float32),
        )
        if sect_def_arr is not None and sect_def_arr.size > 0:
            npz_payload["sect_def"] = sect_def_arr
            npz_payload["sect_t"]   = (sect_t_arr if sect_t_arr is not None
                                       else np.zeros((0,), np.float32))
            npz_payload["sect_tags"] = np.asarray(elements, dtype=np.int64)
        # Infills (opcional): mismo stride que sect_def, campos compatibles con
        # `compute_infill_damage_from_history` para reusar el post-process.
        if (infill_elong_arr is not None and infill_elong_arr.size > 0
                and infill_panel_ids):
            npz_payload["infill_elong"]     = infill_elong_arr
            npz_payload["infill_panel_ids"] = np.asarray(infill_panel_ids, dtype="U64")
            npz_payload["infill_L0_m"]      = np.asarray(infill_L0_arr or [], dtype=np.float32)
            npz_payload["infill_e0_strain"] = np.asarray(infill_e0_arr or [], dtype=np.float32)
            npz_payload["infill_eu_strain"] = np.asarray(infill_eu_arr or [], dtype=np.float32)
        np.savez_compressed(history_path, **npz_payload)
        hist_meta = {
            "path":       str(history_path),
            "n_steps":    int(len(tiempo)),
            "dt_rec":     dtrec,
            "n_elements": int(len(elements)),
            "sect_def_stride":   stride,
            "sect_def_captured": bool(sect_def_arr is not None and sect_def_arr.size > 0),
        }

    # ── Downsample del time-history para el JSON (máx ~2000 puntos) ─────────
    n = len(tiempo)
    stride = max(1, n // 2000)
    t_ds       = tiempo[::stride].astype(float).tolist()
    techo_x_ds = techo1[::stride].astype(float).tolist()
    techo_y_ds = techo2[::stride].astype(float).tolist()
    techo_T_ds = techoT[::stride].astype(float).tolist()
    Vb_x_ds    = Vb_x[::stride].astype(float).tolist() if Vb_x is not None else []
    Vb_y_ds    = Vb_y[::stride].astype(float).tolist() if Vb_y is not None else []

    return {
        "status": status,
        "t_s":        t_ds,
        "techo": {
            "x":     techo_x_ds,
            "y":     techo_y_ds,
            "total": techo_T_ds,
        },
        "Vb_history": {
            "x_kN": Vb_x_ds,
            "y_kN": Vb_y_ds,
        },
        "envelope": {
            "max_abs_disp_x_m":        round(max_abs_x, 6),
            "max_abs_disp_y_m":        round(max_abs_y, 6),
            "max_drift_x_pct":         round(max_drift_x_pct, 4),
            "max_drift_y_pct":         round(max_drift_y_pct, 4),
            "max_drift_pct":           round(max(max_drift_x_pct, max_drift_y_pct), 4),
            "max_drift_by_story_x":    [round(d, 4) for d in drift_max_by_story_x],
            "max_drift_by_story_y":    [round(d, 4) for d in drift_max_by_story_y],
            "max_accel_by_story_x_mps2": [round(a, 4) for a in accel_max_x_mps2],
            "max_accel_by_story_y_mps2": [round(a, 4) for a in accel_max_y_mps2],
            "max_Vb_x_kN":             round(max_Vb_x_kN, 2),
            "max_Vb_y_kN":             round(max_Vb_y_kN, 2),
            "max_roof_disp_total_m":   round(float(np.max(np.abs(techoT))), 6) if techoT.size else 0.0,
            "t_elapsed_s":             round(t_elapsed, 4),
            "t_target_s":              round(t_target, 4),
        },
        "damage": damage,
        "meta": {
            "dtrec":          dtrec,
            "dt_analysis":    dt_analysis,
            "damping":        damping,
            "scale":          scale,
            "record_units":   record_units,
            "factor_applied": factor,
            "duration_s":     t_target,
            "total_height_m": total_height,
            "n_stories":      len(stories_z),
            "eletype":        eletype,
            "ductility":      ductility,
        },
        "history": hist_meta,
    }
