"""
Daño por rótula plástica en pórticos RC — ASCE 41-17 §10.3.

Clasifica el estado de cada extremo de columna/viga en los niveles de
desempeño:
    IO (Immediate Occupancy), LS (Life Safety), CP (Collapse Prevention)
y "collapse" cuando se excede 1.5·θ_CP (colapso dúctil asumido).

Entradas:
    history_path  : NPZ generado por NLFrameOPSBuilder.run_pushover con
                    `col_sect_def` y `bm_sect_def` (deformaciones de sección
                    por paso en los 2 IPs extremos).
    element_lines : metadata de elementos (fid, kind, story, lp, b, h, L).
    spec          : nonlinear_model.json (para extraer confinamiento Mander y
                    acero longitudinal).
    direction     : "X" | "Y" | "-X" | "-Y" (solo informativo).

Salida (dict JSON):
    {
      "status": "success",
      "n_total": N,
      "n_critical": M,        # rótulas con DCR ≥ 0.5
      "max_dcr": 0.78,
      "max_level": "ls",
      "hinges": [             # por elemento × extremo
        {"fid", "kind", "story", "end": "i"|"j",
         "theta_p_max", "theta_IO", "theta_LS", "theta_CP",
         "damage_level", "dcr",
         "step_first_IO", "step_first_LS", "step_first_CP"},
        ...
      ],
      "by_element": {
        "<fid>": {"max_level", "max_dcr", "end_i": {...}, "end_j": {...}},
        ...
      },
    }

Referencia:
    ASCE/SEI 41-17 "Seismic Evaluation and Retrofit of Existing Buildings"
    Tabla 10-7 (vigas RC) y Tabla 10-8 (columnas RC).

Valores base empleados (ductilidad "controlled by flexure"):
    - Vigas (DMO):     θ_IO=0.010  θ_LS=0.020  θ_CP=0.030  rad
    - Columnas (DMO): θ_IO=0.005  θ_LS=0.012  θ_CP=0.020  rad

Factor por confinamiento (ρ_s del Mander):
    k_conf = clip(ρ_s / 0.012, 0.6, 1.4)
             (ρ_s = 1.2% ≈ confinamiento típico sísmico → k=1.0)
"""
from __future__ import annotations

from pathlib import Path
from typing import Iterable

import numpy as np


# Capacidades base por tipo (rad), nivel "controlled by flexure"
_CAP_BEAM   = {"IO": 0.010, "LS": 0.020, "CP": 0.030}
_CAP_COLUMN = {"IO": 0.005, "LS": 0.012, "CP": 0.020}

_DCR_CRITICAL = 0.5   # umbral para marcar un extremo como "crítico"


def _classify(theta_p: float, io: float, ls: float, cp: float) -> str:
    """Nivel de daño ASCE 41 por rotación plástica."""
    if theta_p < 0.5 * io:
        return "none"
    if theta_p < io:
        return "near_io"       # pre-IO (entre 0.5·IO y IO)
    if theta_p < ls:
        return "io"
    if theta_p < cp:
        return "ls"
    if theta_p < 1.5 * cp:
        return "cp"
    return "collapse"


def _confinement_factor(rho_s: float) -> float:
    """
    Escala la capacidad plástica según la cuantía transversal volumétrica.
    Secciones poco confinadas pierden capacidad; muy confinadas la ganan.
    """
    if rho_s <= 0:
        return 0.7
    k = rho_s / 0.012     # 1.2% típico sísmico
    return float(max(0.6, min(k, 1.4)))


def _yield_curvature(fy_MPa: float, h_m: float) -> float:
    """
    Curvatura de fluencia aproximada (Priestley 2007 §4.2):
        κ_y ≈ 2.1 · ε_y / h    (vigas)
        κ_y ≈ 2.3 · ε_y / h    (columnas con axial moderado)

    Se usa 2.2 como valor único (promedio) para simplificar.
    Unidades: 1/m
    """
    eps_y = fy_MPa / 200_000.0
    return 2.2 * eps_y / max(h_m, 0.05)


def compute_hinge_damage_from_history(
    history_path:  Path,
    element_lines: list[dict],
    spec:          dict,
    direction:     str = "X",
) -> dict:
    """
    Post-procesa el NPZ del pushover para calcular rotaciones plásticas y
    niveles de daño por elemento × extremo según ASCE 41-17.
    """
    if not Path(history_path).exists():
        return {"status": "no_history", "message": f"NPZ no encontrado: {history_path}"}

    data = np.load(history_path, allow_pickle=False)
    # Formato pushover: col_sect_def + bm_sect_def separados por tipo.
    col_def = data["col_sect_def"] if "col_sect_def" in data.files else np.empty((0,))
    bm_def  = data["bm_sect_def"]  if "bm_sect_def"  in data.files else np.empty((0,))
    col_tags = data["col_tags"].tolist() if "col_tags" in data.files else []
    bm_tags  = data["bm_tags"].tolist()  if "bm_tags"  in data.files else []

    # Formato NLTH: sect_def unificado (col+beam) + sect_tags. Si el NPZ viene
    # del cronológico, los arrays separados estarán vacíos. Reusamos el mismo
    # tensor para ambos tipos y filtramos por ele_tag (único).
    use_unified = (col_def.size == 0 and bm_def.size == 0) and ("sect_def" in data.files)
    if use_unified:
        unified_def = data["sect_def"]
        col_def = unified_def
        bm_def  = unified_def
        all_tags = data["sect_tags"].tolist() if "sect_tags" in data.files else []
        col_tags = all_tags
        bm_tags  = all_tags

    n_steps_col = col_def.shape[0] if col_def.size else 0
    n_steps_bm  = bm_def.shape[0]  if bm_def.size  else 0
    n_steps     = max(n_steps_col, n_steps_bm)

    if n_steps == 0:
        return {"status": "empty_history"}

    # Mapas fid ↔ ele_tag ↔ index
    cols_by_fid = {str(fid): spec.get("elements", {}).get("columns", {}).get(fid)
                   for fid in spec.get("elements", {}).get("columns", {})}
    beams_by_fid = {str(fid): spec.get("elements", {}).get("beams", {}).get(fid)
                    for fid in spec.get("elements", {}).get("beams", {})}

    # Index de ele_tag en el array NPZ (orden del builder: sorted keys)
    col_tag_to_idx = {int(t): i for i, t in enumerate(col_tags)}
    bm_tag_to_idx  = {int(t): i for i, t in enumerate(bm_tags)}

    hinges: list[dict] = []
    by_element: dict[str, dict] = {}

    for e in element_lines:
        fid     = str(e.get("fid", ""))
        kind    = e.get("kind", "beam")
        ele_tag = int(e.get("ele_tag", 0))
        lp      = float(e.get("lp_m", max(float(e.get("h_m", 0.3)) / 2.0, 0.1)))
        h_m     = float(e.get("h_m", 0.3))

        spec_el = cols_by_fid.get(fid) if kind == "column" else beams_by_fid.get(fid)
        if not spec_el:
            continue

        geo    = spec_el.get("geometry", {})
        fy_MPa = float(geo.get("fy_MPa", 420.0))
        conf   = spec_el.get("confinement", {})
        rho_s  = float((conf.get("end") or {}).get("rho_s", 0.0))
        k_conf = _confinement_factor(rho_s)

        base_cap = _CAP_COLUMN if kind == "column" else _CAP_BEAM
        theta_io = base_cap["IO"] * k_conf
        theta_ls = base_cap["LS"] * k_conf
        theta_cp = base_cap["CP"] * k_conf

        kappa_y = _yield_curvature(fy_MPa, h_m)
        theta_y = kappa_y * lp

        # Localizar deformaciones en NPZ
        if kind == "column":
            idx = col_tag_to_idx.get(ele_tag)
            arr = col_def if idx is not None else None
        else:
            idx = bm_tag_to_idx.get(ele_tag)
            arr = bm_def if idx is not None else None

        if arr is None or arr.size == 0:
            continue

        # Formato de ele_sect_strain: concatenación de los dos IPs extremos.
        # sectionDeformation devuelve [axial, κz, κy] (3 valores) o
        # [axial, κz, κy, torsion] (4 valores si la sección usa `-torsion`).
        # Por eso el tamaño por extremo = slab.shape[1] // 2 (3 o 4).
        slab = arr[:, idx, :]
        if slab.shape[1] < 6 or slab.shape[1] % 2 != 0:
            continue
        n_vals = slab.shape[1] // 2   # 3 o 4

        theta_p_i_hist = _theta_plastic(slab[:, 1],          slab[:, 2],          lp, kappa_y)
        theta_p_j_hist = _theta_plastic(slab[:, n_vals + 1], slab[:, n_vals + 2], lp, kappa_y)

        theta_io_base = base_cap["IO"]
        theta_ls_base = base_cap["LS"]
        theta_cp_base = base_cap["CP"]

        for end_label, hist in (("i", theta_p_i_hist), ("j", theta_p_j_hist)):
            tp_max = float(np.max(hist)) if hist.size else 0.0
            level  = _classify(tp_max, theta_io, theta_ls, theta_cp)
            dcr    = tp_max / theta_cp if theta_cp > 0 else 0.0

            step_io = int(np.argmax(hist >= theta_io)) + 1 if np.any(hist >= theta_io) else None
            step_ls = int(np.argmax(hist >= theta_ls)) + 1 if np.any(hist >= theta_ls) else None
            step_cp = int(np.argmax(hist >= theta_cp)) + 1 if np.any(hist >= theta_cp) else None

            record = {
                "fid":            fid,
                "kind":           kind,
                "story":          e.get("story", ""),
                "end":            end_label,
                "ele_tag":        ele_tag,
                "node_tag":       int(e.get("node_i") if end_label == "i" else e.get("node_j")),
                "theta_p_max":    round(tp_max, 6),
                "theta_y":        round(theta_y, 6),
                "theta_IO":       round(theta_io, 6),
                "theta_LS":       round(theta_ls, 6),
                "theta_CP":       round(theta_cp, 6),
                "theta_IO_base":  round(theta_io_base, 6),
                "theta_LS_base":  round(theta_ls_base, 6),
                "theta_CP_base":  round(theta_cp_base, 6),
                "k_conf":         round(k_conf, 3),
                "rho_s":          round(rho_s, 5),
                "damage_level":   level,
                "dcr":            round(dcr, 3),
                "step_first_IO":  step_io,
                "step_first_LS":  step_ls,
                "step_first_CP":  step_cp,
            }
            hinges.append(record)

            entry = by_element.setdefault(fid, {
                "fid":       fid,
                "kind":      kind,
                "story":     e.get("story", ""),
                "max_dcr":   0.0,
                "max_level": "none",
            })
            if dcr > entry["max_dcr"]:
                entry["max_dcr"]   = round(dcr, 3)
                entry["max_level"] = level
            entry[f"end_{end_label}"] = record

    n_total    = len(hinges)
    n_critical = sum(1 for h in hinges if h["dcr"] >= _DCR_CRITICAL)
    max_dcr    = max((h["dcr"] for h in hinges), default=0.0)
    max_level  = _top_level([h["damage_level"] for h in hinges])
    max_theta_p = max((h["theta_p_max"] for h in hinges), default=0.0)

    # Orden descendente por DCR (para ranking frontend)
    hinges.sort(key=lambda r: -r["dcr"])

    # Campos legacy consumidos por NLTHPanel.tsx: `counts` (dict level→n) y
    # `max_theta_p`. Convivir con el formato nuevo mantiene retro-compat con
    # paneles que no se han migrado al esquema (n_total/by_element).
    counts: dict[str, int] = {"none": 0, "near_io": 0, "io": 0, "ls": 0, "cp": 0, "collapse": 0}
    for h in hinges:
        lvl = h.get("damage_level", "none")
        counts[lvl] = counts.get(lvl, 0) + 1

    return {
        "status":      "success",
        "direction":   direction,
        "n_total":     n_total,
        "n_critical":  n_critical,
        "max_dcr":     round(max_dcr, 3),
        "max_level":   max_level,
        "max_theta_p": round(max_theta_p, 6),
        "counts":      counts,
        "hinges":      hinges,
        "by_element":  by_element,
    }


def compute_theta_p_submatrix(
    history_path:  Path,
    element_lines: list[dict],
    spec:          dict,
    frame_indices: Iterable[int],
) -> dict:
    """
    Para cada extremo (fid × end) devuelve la serie θ_p submuestreada en los
    índices `frame_indices` del NPZ, junto con θ_IO/LS/CP base y el factor
    k_conf — así el frontend puede reclasificar nivel de daño por frame bajo
    umbrales ajustables sin recalcular en el backend.

    Retorna:
        {
          "<fid>|i": {"theta_p_hist":[...], "theta_IO_base":..., ...},
          "<fid>|j": {...},
          ...
        }
    """
    if not Path(history_path).exists():
        return {}

    data = np.load(history_path, allow_pickle=False)
    col_def = data["col_sect_def"] if "col_sect_def" in data.files else np.empty((0,))
    bm_def  = data["bm_sect_def"]  if "bm_sect_def"  in data.files else np.empty((0,))
    col_tags = data["col_tags"].tolist() if "col_tags" in data.files else []
    bm_tags  = data["bm_tags"].tolist()  if "bm_tags"  in data.files else []

    # Fallback para NPZ del NLTH (sect_def + sect_tags unificados).
    if col_def.size == 0 and bm_def.size == 0 and "sect_def" in data.files:
        unified_def = data["sect_def"]
        col_def = unified_def
        bm_def  = unified_def
        all_tags = data["sect_tags"].tolist() if "sect_tags" in data.files else []
        col_tags = all_tags
        bm_tags  = all_tags

    idx_arr = np.asarray(list(frame_indices), dtype=int)
    if idx_arr.size == 0:
        return {}

    cols_by_fid  = spec.get("elements", {}).get("columns", {})
    beams_by_fid = spec.get("elements", {}).get("beams", {})
    col_tag_to_idx = {int(t): i for i, t in enumerate(col_tags)}
    bm_tag_to_idx  = {int(t): i for i, t in enumerate(bm_tags)}

    out: dict[str, dict] = {}

    for e in element_lines:
        fid     = str(e.get("fid", ""))
        kind    = e.get("kind", "beam")
        ele_tag = int(e.get("ele_tag", 0))
        lp      = float(e.get("lp_m", max(float(e.get("h_m", 0.3)) / 2.0, 0.1)))
        h_m     = float(e.get("h_m", 0.3))

        spec_el = cols_by_fid.get(fid) if kind == "column" else beams_by_fid.get(fid)
        if not spec_el:
            continue

        geo    = spec_el.get("geometry", {})
        fy_MPa = float(geo.get("fy_MPa", 420.0))
        conf   = spec_el.get("confinement", {})
        rho_s  = float((conf.get("end") or {}).get("rho_s", 0.0))
        k_conf = _confinement_factor(rho_s)

        base_cap = _CAP_COLUMN if kind == "column" else _CAP_BEAM
        kappa_y  = _yield_curvature(fy_MPa, h_m)

        if kind == "column":
            arr_idx = col_tag_to_idx.get(ele_tag)
            arr     = col_def if arr_idx is not None else None
        else:
            arr_idx = bm_tag_to_idx.get(ele_tag)
            arr     = bm_def if arr_idx is not None else None
        if arr is None or arr.size == 0:
            continue
        slab = arr[:, arr_idx, :]
        if slab.shape[1] < 6 or slab.shape[1] % 2 != 0:
            continue
        n_vals = slab.shape[1] // 2

        n_steps = slab.shape[0]
        safe_idx = np.clip(idx_arr, 0, n_steps - 1)

        hist_i = _theta_plastic(slab[:, 1],          slab[:, 2],          lp, kappa_y)
        hist_j = _theta_plastic(slab[:, n_vals + 1], slab[:, n_vals + 2], lp, kappa_y)
        hist_i_sub = [float(x) for x in np.round(hist_i[safe_idx], 7)]
        hist_j_sub = [float(x) for x in np.round(hist_j[safe_idx], 7)]

        payload = {
            "theta_IO_base": round(base_cap["IO"], 6),
            "theta_LS_base": round(base_cap["LS"], 6),
            "theta_CP_base": round(base_cap["CP"], 6),
            "k_conf":        round(k_conf, 3),
            "rho_s":         round(rho_s, 5),
            "lp_m":          round(lp, 4),
        }
        out[f"{fid}|i"] = {**payload, "theta_p_hist": hist_i_sub}
        out[f"{fid}|j"] = {**payload, "theta_p_hist": hist_j_sub}

    return out


def _theta_plastic(
    curv_z_hist: np.ndarray,
    curv_y_hist: np.ndarray,
    lp:          float,
    kappa_y:     float,
) -> np.ndarray:
    """
    Rotación plástica equivalente por paso:
        θ_p(t) = max(|κ_z(t)|, |κ_y(t)|) excedente sobre κ_y, por L_p.

    Clamp a 0 cuando la demanda es sub-fluencia.
    """
    kappa = np.maximum(np.abs(curv_z_hist), np.abs(curv_y_hist))
    excess = np.maximum(kappa - kappa_y, 0.0)
    return excess * lp


_LEVEL_ORDER = ("none", "near_io", "io", "ls", "cp", "collapse")


def _top_level(levels: list[str]) -> str:
    if not levels:
        return "none"
    idx = max(_LEVEL_ORDER.index(l) for l in levels if l in _LEVEL_ORDER)
    return _LEVEL_ORDER[idx]
