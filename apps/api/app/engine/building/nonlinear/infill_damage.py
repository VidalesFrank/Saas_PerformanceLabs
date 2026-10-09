"""
Daño de paneles de infill durante pushover — modelo de puntal equivalente RCF-AD.

Entradas:
    history_path  : NPZ generado por NLFrameOPSBuilder.run_pushover. Debe
                    contener `infill_elong`, `infill_panel_ids`, `infill_L0_m`,
                    `infill_e0_strain`, `infill_eu_strain`.
    infill_lines  : metadata de paneles (panel_id, story, etc.) tal como la
                    retorna el builder.

Modelo de daño:
    Concrete01 (masonry) tiene curva ascendente hasta (fm, e0) y descendente
    plana hasta (fmu=0.01·fm, eu=2·e0). Sin tracción.

    strain compresiva del puntal: eps_c = -elong / L0 (positiva al acortarse).

    damage_index = clamp((eps_c - e0) / (eu - e0), 0, 1)
        - eps_c < e0            → damage = 0.0  (elástico)
        - e0 ≤ eps_c < eu       → damage ∈ (0, 1) (fisurado/degradando)
        - eps_c ≥ eu            → damage = 1.0  (colapso del panel)

    Daño por panel = max(damage_diag1, damage_diag2) en cada paso.

Niveles cualitativos (coherentes con la cadena de colores del visor):
    none      : damage < 0.05
    cracking  : 0.05 ≤ damage < 0.5
    degrading : 0.5  ≤ damage < 0.95
    collapse  : damage ≥ 0.95
"""
from __future__ import annotations

from pathlib import Path

import numpy as np


_LEVEL_THRESHOLDS = [
    (0.05, "none"),
    (0.50, "cracking"),
    (0.95, "degrading"),
    (float("inf"), "collapse"),
]


def _classify(damage: float) -> str:
    for thr, name in _LEVEL_THRESHOLDS:
        if damage < thr:
            return name
    return "collapse"


def compute_infill_damage_from_history(
    history_path: Path | str,
    infill_lines: list[dict],
) -> dict:
    """
    Lee el NPZ del pushover y retorna daño de infills por paso + resumen.

    Returns:
      {
        "status":       "success" | "no_infills" | "no_data",
        "n_total":      N,
        "n_collapsed":  int,
        "n_degrading":  int,
        "max_damage":   0..1,
        "panels": [                           # snapshot final por panel
          {"panel_id", "story",
           "max_damage", "max_level",
           "step_first_cracking", "step_first_collapse",
           "max_strain", "max_elong_m"},
          ...
        ],
        "history": [                          # alineada con los steps capturados
          [damage_panel_0, damage_panel_1, ...],   # paso 0
          ...
        ],
      }
    """
    path = Path(history_path)
    if not path.exists():
        return {"status": "no_data", "n_total": 0, "panels": [], "history": []}

    npz = np.load(path, allow_pickle=False)
    if "infill_elong" not in npz.files or "infill_panel_ids" not in npz.files:
        return {"status": "no_infills", "n_total": 0, "panels": [], "history": []}

    elong      = np.asarray(npz["infill_elong"], dtype=np.float64)  # (n_steps, n_panels, 2)
    panel_ids  = [str(p) for p in npz["infill_panel_ids"].tolist()]
    L0         = np.asarray(npz["infill_L0_m"],     dtype=np.float64)
    e0         = np.asarray(npz["infill_e0_strain"],dtype=np.float64)
    eu         = np.asarray(npz["infill_eu_strain"],dtype=np.float64)

    if elong.ndim != 3 or elong.size == 0:
        return {"status": "no_data", "n_total": len(panel_ids), "panels": [], "history": []}

    n_steps, n_panels, _ = elong.shape

    # Strain compresivo (positivo cuando el puntal se acorta)
    # elong > 0 → tracción → el material no resiste → strain compresivo = 0
    L0_safe = np.where(L0 > 1e-9, L0, 1.0).reshape(1, n_panels, 1)
    eps_c = np.clip(-elong / L0_safe, 0.0, None)   # (n_steps, n_panels, 2)

    # Damage index por diagonal
    e0_b = e0.reshape(1, n_panels, 1)
    eu_b = eu.reshape(1, n_panels, 1)
    denom = np.where(eu_b - e0_b > 1e-9, eu_b - e0_b, 1.0)
    dmg_diag = np.clip((eps_c - e0_b) / denom, 0.0, 1.0)
    dmg_diag = np.where(eu_b - e0_b > 1e-9, dmg_diag, 0.0)

    # Daño por panel = max de las 2 diagonales
    dmg_panel = dmg_diag.max(axis=2)                 # (n_steps, n_panels)
    eps_panel = eps_c.max(axis=2)                    # strain compresiva mayor del paso

    # Snapshot por panel
    panels: list[dict] = []
    meta_by_id = {str(p.get("panel_id")): p for p in infill_lines}
    n_coll = 0
    n_deg  = 0
    for j, pid in enumerate(panel_ids):
        max_d = float(dmg_panel[:, j].max())
        max_e = float(eps_panel[:, j].max())
        max_el = float(np.abs(elong[:, j, :]).max())
        # Primer paso donde cruza cada umbral
        first_crack = int(np.argmax(dmg_panel[:, j] >= 0.05)) if np.any(dmg_panel[:, j] >= 0.05) else -1
        first_coll  = int(np.argmax(dmg_panel[:, j] >= 0.95)) if np.any(dmg_panel[:, j] >= 0.95) else -1
        lvl = _classify(max_d)
        if lvl == "collapse":
            n_coll += 1
        elif lvl == "degrading":
            n_deg += 1
        meta = meta_by_id.get(pid, {})
        panels.append({
            "panel_id":            pid,
            "story":               str(meta.get("story", "")),
            "max_damage":          round(max_d, 4),
            "max_level":           lvl,
            "step_first_cracking": first_crack,
            "step_first_collapse": first_coll,
            "max_strain":          round(max_e, 6),
            "max_elong_m":         round(max_el, 6),
        })

    # Historia por paso — redondeada a 3 decimales para reducir payload
    history = [
        [round(float(dmg_panel[i, j]), 3) for j in range(n_panels)]
        for i in range(n_steps)
    ]

    return {
        "status":      "success",
        "n_total":     n_panels,
        "n_collapsed": n_coll,
        "n_degrading": n_deg,
        "max_damage":  round(float(dmg_panel.max()), 4),
        "panel_ids":   panel_ids,
        "panels":      panels,
        "history":     history,
    }
