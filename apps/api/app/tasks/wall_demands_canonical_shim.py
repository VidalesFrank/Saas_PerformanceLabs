"""
Fallback para `wall_demands` cuando no hay XLSX de importación disponible.

El pipeline original de `structural_wall_demands_task` lee 6 tablas del XLSX
de ETABS (PIER SECTION PROPERTIES, SHELL ASSIGNMENTS - PIER SPANDR, OBJECTS
AND ELEMENTS - SHELLS, SHELL SECTIONS - WALL, SHELL ASSIGNMENTS - SECTIONS,
SHELL LOADS - UNIFORM) para construir el modelo MVLEM_3D y las cargas de
losa. Esa información ya está en el modelo canonical — este módulo la
materializa como DataFrames en el mismo formato esperado por
`WallModelBuilder` y `load_slab_intensities`, permitiendo correr demandas de
muros sin depender del XLSX.
"""
from __future__ import annotations

import math

import pandas as pd


# Keys que espera WallModelBuilder
_K_PIER_PROPS  = 'TABLE:  "PIER SECTION PROPERTIES"'
_K_PIER_SPANDR = 'TABLE:  "SHELL ASSIGNMENTS - PIER SPANDR"'
_K_SHELLS      = 'TABLE:  "OBJECTS AND ELEMENTS - SHELLS"'
_K_SH_WALL     = 'TABLE:  "SHELL SECTIONS - WALL"'
_K_SH_ASSIGN   = 'TABLE:  "SHELL ASSIGNMENTS - SECTIONS"'
_K_LOADS       = 'TABLE:  "SHELL LOADS - UNIFORM"'


def raw_data_from_canonical(model: dict) -> dict:
    """
    Reconstruye el dict `raw_data` ETABS a partir del canonical, con sólo las
    tablas necesarias para wall_demands.

    Parámetros
    ----------
    model : dict
        Contenido de `structural_model.json`. Debe tener `shells`, `joints`,
        `sections`, opcionalmente `shell_loads`.

    Retorna
    -------
    dict con DataFrames mínimos para `WallModelBuilder` y
    `load_slab_intensities`. Entradas que no se pueden derivar quedan como
    DataFrame vacío (nunca None, para no romper los `isinstance(df, DataFrame)`).
    """
    shells   = model.get("shells", {}) or {}
    joints   = model.get("joints", {}) or {}
    sections = model.get("sections", {}) or {}
    shell_loads_by_area = model.get("shell_loads", {}) or {}

    # ── OBJECTS AND ELEMENTS - SHELLS ─────────────────────────────────────────
    rows_shells = []
    for lbl, s in shells.items():
        js = (s.get("joints") or [])
        row = {"Element Label": str(lbl)}
        for i in range(4):
            row[f"Joint {i+1}"] = str(js[i]) if i < len(js) else ""
        rows_shells.append(row)
    df_shells = pd.DataFrame(rows_shells)

    # ── SHELL ASSIGNMENTS - SECTIONS ──────────────────────────────────────────
    rows_assign = [
        {"Unique Name": str(lbl), "Section": str(s.get("section") or "")}
        for lbl, s in shells.items()
    ]
    df_assign = pd.DataFrame(rows_assign)

    # ── SHELL SECTIONS - WALL (section → material) ────────────────────────────
    wall_sections = {
        str(s.get("section") or "")
        for s in shells.values()
        if s.get("element_type") == "wall" and s.get("section")
    }
    rows_sh_wall = [
        {"Name": sec, "Material": str(sections.get(sec, {}).get("material") or "")}
        for sec in sorted(wall_sections) if sec
    ]
    df_sh_wall = pd.DataFrame(rows_sh_wall)

    # ── SHELL ASSIGNMENTS - PIER SPANDR (shells de wall con pier definido) ────
    rows_spandr = []
    for lbl, s in shells.items():
        pier = str(s.get("pier") or "").strip()
        story = str(s.get("story") or "").strip()
        if pier and story and s.get("element_type") == "wall":
            rows_spandr.append({
                "Pier":        pier,
                "Story":       story,
                "Unique Name": str(lbl),
            })
    df_spandr = pd.DataFrame(rows_spandr)

    # ── PIER SECTION PROPERTIES (una fila por (pier, story)) ──────────────────
    rows_props = []
    pier_story_shells: dict[tuple[str, str], list[str]] = {}
    for row in rows_spandr:
        pier_story_shells.setdefault((row["Pier"], row["Story"]), []).append(row["Unique Name"])

    for (pier, story), lbls in pier_story_shells.items():
        thicknesses: list[float] = []
        joint_xy: list[tuple[float, float]] = []
        for lbl in lbls:
            s = shells.get(lbl) or {}
            try:
                thicknesses.append(float(s.get("thickness_m") or 0))
            except (TypeError, ValueError):
                pass
            for jl in (s.get("joints") or []):
                j = joints.get(str(jl)) or {}
                try:
                    joint_xy.append((float(j.get("x", 0)), float(j.get("y", 0))))
                except (TypeError, ValueError):
                    continue

        tw = max(thicknesses) if thicknesses else 0.0

        # Length = distancia máxima entre pares de joints en el plano XY del pier.
        length = 0.0
        pts = list(set(joint_xy))
        for i in range(len(pts)):
            for j in range(i + 1, len(pts)):
                d = math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1])
                if d > length:
                    length = d

        rows_props.append({
            "Story":     story,
            "Pier":      pier,
            "Length":    length,
            "Thickness": tw,
        })
    df_pier_props = pd.DataFrame(rows_props)

    # ── SHELL LOADS - UNIFORM ─────────────────────────────────────────────────
    # Canonical: shell_loads[area_label] = {pattern: intensity_kN_m2}
    #   p.ej. shell_loads["F2"] = {"Live": 1.8, "Sobreimpuesta": 1.7}
    # Expandimos a filas por shell que comparta ese area_label.
    rows_loads = []
    if shell_loads_by_area:
        shells_by_area: dict[str, list[str]] = {}
        for lbl, s in shells.items():
            if s.get("element_type") != "slab":
                continue
            area = str(s.get("area_label") or "").strip()
            if area:
                shells_by_area.setdefault(area, []).append(str(lbl))

        for area, patterns in shell_loads_by_area.items():
            lbls = shells_by_area.get(area, [])
            if not lbls or not isinstance(patterns, dict):
                continue
            for pattern, intensity in patterns.items():
                try:
                    val = float(intensity)
                except (TypeError, ValueError):
                    continue
                for lbl in lbls:
                    rows_loads.append({
                        "Unique Name":  lbl,
                        "Load Pattern": str(pattern),
                        "Load":         val,
                    })
    df_loads = pd.DataFrame(rows_loads)

    return {
        _K_PIER_PROPS:  df_pier_props,
        _K_PIER_SPANDR: df_spandr,
        _K_SHELLS:      df_shells,
        _K_SH_WALL:     df_sh_wall,
        _K_SH_ASSIGN:   df_assign,
        # Alias que acepta load_slab_intensities (prueba ambas keys):
        _K_LOADS:            df_loads,
        "Shell Loads - Uniform": df_loads,
    }
