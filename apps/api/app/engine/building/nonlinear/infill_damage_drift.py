"""
Daño de paneles de mampostería no estructural por deriva de piso.

Complemento a `infill_damage.py` (que mide daño por elongación del puntal
equivalente del modelo RCF-AD). Este criterio opera directamente sobre la
envolvente de deriva del entrepiso en el que vive el panel y es el que usan
los lineamientos de evaluación no estructural (NSR-10 A.9, FEMA 356 Tabla
C7-1, HAZUS-MH 2.1 §5.4.5 RM1L para muros divisorios de mampostería).

Umbrales (fracción, no %):
    θ < 0.002   → none        (sin daño apreciable)
    θ < 0.005   → cracking    (fisuras finas)
    θ < 0.015   → degrading   (fisuras diagonales, separación)
    θ ≥ 0.015   → collapse    (colapso del panel, posible fuera-del-plano)

La deriva aplicable se escoge según la orientación del panel:
    * dx > dy  (panel en plano XZ) → se usa la deriva del eje X.
    * dy ≥ dx  (panel en plano YZ) → se usa la deriva del eje Y.

El entrepiso se identifica buscando el índice `i` de `stories_z` cuya cota
coincide con la cota superior del panel (`tl.z`); si no hay match exacto se
toma el más cercano.
"""
from __future__ import annotations

from typing import Iterable

import numpy as np


# Umbrales FEMA 356 Tabla C7-1 / HAZUS-MH 2.1 (fracción, no %)
_LEVEL_THRESHOLDS: list[tuple[float, str]] = [
    (0.002, "none"),
    (0.005, "cracking"),
    (0.015, "degrading"),
    (float("inf"), "collapse"),
]


def _classify(theta: float) -> str:
    for thr, name in _LEVEL_THRESHOLDS:
        if theta < thr:
            return name
    return "collapse"


def _panel_orientation(coords: dict) -> str:
    """
    Devuelve "X" o "Y" según la componente horizontal dominante del panel.
    El panel se asume vertical: usamos solo bl→br (lado inferior) para
    determinar su eje en planta.
    """
    bl = coords.get("bl", [0.0, 0.0, 0.0])
    br = coords.get("br", [0.0, 0.0, 0.0])
    dx = abs(float(br[0]) - float(bl[0]))
    dy = abs(float(br[1]) - float(bl[1]))
    return "X" if dx >= dy else "Y"


def _panel_z_range(coords: dict) -> tuple[float, float]:
    """Cota mínima y máxima del panel (base y top)."""
    zs = [float(coords.get(k, [0.0, 0.0, 0.0])[2]) for k in ("bl", "br", "tl", "tr")]
    return (min(zs), max(zs))


def _story_index_for_z(z_top: float, stories_z: list[float]) -> int:
    """
    Devuelve el índice (0-based) del entrepiso cuya cota superior está más
    cerca de `z_top`. `stories_z` viene ordenado ascendente (piso 1, 2, ...).
    """
    if not stories_z:
        return -1
    diffs = [abs(float(z) - float(z_top)) for z in stories_z]
    return int(min(range(len(diffs)), key=lambda i: diffs[i]))


def compute_infill_damage_by_drift(
    *,
    infill_lines: list[dict],
    drift_x:      np.ndarray,     # (n_steps, n_entrepisos) deriva relativa (fracción)
    drift_y:      np.ndarray,
    stories_z:    list[float],    # cotas Z de cada piso superior (orden ascendente)
) -> dict:
    """
    Clasifica cada panel por la deriva máxima del entrepiso en el que vive,
    tomada en la dirección de su orientación. Retorna el mismo schema que
    `compute_infill_damage_from_history` para que el frontend pueda consumir
    ambas fuentes de daño de forma intercambiable.

    `drift_x` / `drift_y`: deriva relativa por paso (fracción, no %). Base
    excluida; shape (n_steps, n_stories).
    """
    if not infill_lines:
        return {"status": "no_infills", "n_total": 0, "panels": [],
                "panel_ids": [], "history": []}
    if drift_x is None or drift_y is None or drift_x.size == 0 or drift_y.size == 0:
        return {"status": "no_data", "n_total": len(infill_lines),
                "panels": [], "panel_ids": [], "history": []}
    if not stories_z:
        return {"status": "no_stories_z", "n_total": len(infill_lines),
                "panels": [], "panel_ids": [], "history": []}

    n_steps = min(drift_x.shape[0], drift_y.shape[0])
    panels: list[dict] = []
    panel_ids: list[str] = []
    history_cols: list[np.ndarray] = []
    n_coll = 0
    n_deg  = 0

    for inf in infill_lines:
        pid = str(inf.get("panel_id", ""))
        panel_ids.append(pid)
        coords = inf.get("coords", {}) or {}
        orient = _panel_orientation(coords)
        _, z_top = _panel_z_range(coords)
        idx = _story_index_for_z(z_top, stories_z)
        if idx < 0 or idx >= drift_x.shape[1]:
            # Panel sin entrepiso identificable → sin daño (no se castiga).
            history_cols.append(np.zeros(n_steps, dtype=np.float32))
            panels.append({
                "panel_id": pid, "story": str(inf.get("story", "")),
                "orientation": orient, "story_idx": -1,
                "max_drift_pct": 0.0, "max_level": "none",
                "step_first_cracking": -1, "step_first_collapse": -1,
            })
            continue

        hist = (np.abs(drift_x[:n_steps, idx]) if orient == "X"
                else np.abs(drift_y[:n_steps, idx]))
        history_cols.append(hist.astype(np.float32))
        max_th = float(hist.max()) if hist.size else 0.0
        lvl = _classify(max_th)
        if lvl == "collapse":
            n_coll += 1
        elif lvl == "degrading":
            n_deg += 1
        # Primer paso donde cruza cada umbral (0.005 y 0.015)
        first_crack = int(np.argmax(hist >= 0.005)) if np.any(hist >= 0.005) else -1
        first_coll  = int(np.argmax(hist >= 0.015)) if np.any(hist >= 0.015) else -1
        panels.append({
            "panel_id":            pid,
            "story":               str(inf.get("story", "")),
            "orientation":         orient,
            "story_idx":           idx,
            "max_drift_pct":       round(max_th * 100.0, 4),
            "max_level":           lvl,
            "step_first_cracking": first_crack,
            "step_first_collapse": first_coll,
        })

    # History: (n_steps, n_panels) con deriva por paso para cada panel —
    # redondeada a 5 decimales (fracción). Útil si el frontend quiere animar
    # el daño por panel paso a paso.
    history = (np.stack(history_cols, axis=1) if history_cols
               else np.zeros((0, 0), dtype=np.float32))
    history_list = [
        [round(float(x), 5) for x in row] for row in history.tolist()
    ]

    return {
        "status":      "success",
        "scheme":      "FEMA 356 C7-1 / HAZUS-MH (deriva de entrepiso)",
        "thresholds":  {"cracking": 0.005, "degrading": 0.015, "collapse": 0.015},
        "n_total":     len(panels),
        "n_collapsed": n_coll,
        "n_degrading": n_deg,
        "max_drift_pct": round(max((p["max_drift_pct"] for p in panels), default=0.0), 4),
        "panel_ids":   panel_ids,
        "panels":      panels,
        "history":     history_list,
    }


def worst_level_per_panel(
    by_elong: dict | None, by_drift: dict | None,
) -> dict[str, dict]:
    """
    Combina los dos criterios de daño por panel y devuelve un dict
    `panel_id → {max_level, sources: [...]}` con el peor nivel de los dos.
    Útil para colorear el visor 3D de forma conservadora.
    """
    order = ("none", "cracking", "degrading", "collapse")
    rank  = {name: i for i, name in enumerate(order)}
    out: dict[str, dict] = {}

    def _merge(src_name: str, src: dict | None) -> None:
        if not src or src.get("status") != "success":
            return
        for p in src.get("panels", []):
            pid = str(p.get("panel_id", ""))
            lvl = str(p.get("max_level", "none"))
            cur = out.setdefault(pid, {"max_level": "none", "sources": {}})
            cur["sources"][src_name] = lvl
            if rank.get(lvl, 0) > rank.get(cur["max_level"], 0):
                cur["max_level"] = lvl

    _merge("drift", by_drift)
    _merge("elongation", by_elong)
    return out


__all__ = [
    "compute_infill_damage_by_drift",
    "worst_level_per_panel",
]
