"""
Índice de daño Park-Ang (1985) simplificado para edificios de muros MVLEM_3D.

Referencia: Park, Y.J. & Ang, A.H.-S. (1985). "Mechanistic Seismic Damage Model
for Reinforced Concrete". Journal of Structural Engineering ASCE, 111(4).

Formulación clásica:
    DI = δ_max / δ_u  +  β · (∫ dE_h) / (F_y · δ_u)

Para pushover monotónico el término energético es marginal (no hay ciclos
inelásticos), por lo que la implementación se reduce a la relación
demanda/capacidad de deriva combinada con el DCR de diseño del pier.

Clasificación (Park & Ang):
    DI < 0.10   → No daño
    0.10-0.25   → Daño menor (grietas capilares)
    0.25-0.40   → Daño moderado (grietas visibles, spalling incipiente)
    0.40-1.00   → Daño severo (spalling, pandeo de barras)
    DI ≥ 1.00   → Colapso local
"""
from __future__ import annotations

from pathlib import Path
from typing import Iterable

import numpy as np

# Capacidad de deriva típica por ductilidad NSR-10 (rad = m/m)
_DRIFT_CAPACITY = {
    "DES": 0.025,   # Especial → 2.5 %
    "DMO": 0.015,   # Moderada → 1.5 %
    "DMI": 0.010,   # Mínima   → 1.0 %
}

# Umbral de daño para "pier crítico" (Park-Ang moderado→severo)
_DI_CRITICAL = 0.40


def _story_drifts_from_disp(
    disp_cm:   np.ndarray,      # (n_steps, n_cm, 3)
    cm_z:      list[float],     # elevaciones de CM en el mismo orden que disp_cm[:,i,:]
    direction: str,
) -> np.ndarray:
    """
    Deriva relativa por piso: (u_i - u_{i-1}) / (z_i - z_{i-1}).
    El piso base (idx 0) mira contra z=0 con u=0 (empotrado).

    Retorna (n_steps, n_stories) con la deriva de cada piso en cada paso.
    """
    axis = direction.lstrip("-")
    dof  = 0 if axis == "X" else 1
    u    = disp_cm[:, :, dof]            # (n_steps, n_cm)
    n_steps, n_cm = u.shape

    drifts = np.zeros((n_steps, n_cm), dtype=np.float32)
    for i in range(n_cm):
        z_i   = cm_z[i]
        z_im1 = cm_z[i - 1] if i > 0 else 0.0
        h     = max(z_i - z_im1, 1e-6)
        u_im1 = u[:, i - 1] if i > 0 else 0.0
        drifts[:, i] = np.abs(u[:, i] - u_im1) / h
    return drifts


def compute_pier_damage_from_history(
    history_path: Path,
    steps:        list[dict],
    design_rows:  list[dict],
    direction:    str,
    ductility:    str = "DMO",
) -> dict:
    """
    Post-procesa el NPZ de historia del pushover para calcular:
      - Deriva máxima por piso
      - Índice de daño Park-Ang simplificado por pier × story
      - Ranking de pieres críticos (DI descendente)

    Devuelve un dict serializable a JSON.
    """
    if not Path(history_path).exists():
        return {"status": "no_history", "message": f"NPZ no encontrado: {history_path}"}

    data = np.load(history_path, allow_pickle=False)
    disp_cm = data["disp_cm"]         # (n_steps, n_cm, 3)
    cm_tags = data["cm_tags"].tolist()
    n_steps = disp_cm.shape[0]

    if n_steps == 0:
        return {"status": "empty_history"}

    # ── Deriva por piso ──────────────────────────────────────────────────────
    # Los CM están ordenados por elevación ascendente (garantizado por el builder)
    # Se necesita la lista de elevaciones — se reconstruye del design_rows via
    # unicidad (piso ↔ hw acumulado) o se toma del step con máx deriva:
    story_names = sorted({r["story"] for r in design_rows})
    story_order_by_z = _story_order_from_design(design_rows)

    # cm_z: usa el orden de story_order_by_z si coincide en cantidad
    if len(story_order_by_z) == len(cm_tags):
        cm_z = [z for _, z in story_order_by_z]
        story_names_ordered = [s for s, _ in story_order_by_z]
    else:
        # Fallback: asume paso uniforme de piso 3 m
        cm_z = [(i + 1) * 3.0 for i in range(len(cm_tags))]
        story_names_ordered = [f"Story{i+1}" for i in range(len(cm_tags))]

    drifts_by_step  = _story_drifts_from_disp(disp_cm, cm_z, direction)
    max_drift_story = drifts_by_step.max(axis=0)   # (n_stories,)

    # ── DI por pier ──────────────────────────────────────────────────────────
    drift_cap = _DRIFT_CAPACITY.get(ductility.upper(), _DRIFT_CAPACITY["DMO"])

    pier_di: list[dict] = []
    for row in design_rows:
        story  = row["story"]
        if story not in story_names_ordered:
            continue
        s_idx  = story_names_ordered.index(story)
        drift  = float(max_drift_story[s_idx])

        # DI base por deriva de piso
        di_base = drift / drift_cap

        # Escalado por DCR del diseño (pieres con capacidad justa son más críticos)
        max_dcr = float(row.get("max_dcr", 0.5) or 0.5)
        di_eff  = di_base * (0.5 + 0.5 * max_dcr)

        # Amplifica si es EBE (borde crítico según NSR-10 C.21.9)
        if row.get("ebe_required"):
            di_eff *= 1.15

        pier_di.append({
            "pier":         row["pier"],
            "story":        story,
            "drift_pct":    round(drift * 100.0, 4),
            "di_base":      round(di_base, 3),
            "di_effective": round(di_eff, 3),
            "max_dcr":      round(max_dcr, 3),
            "ebe_required": bool(row.get("ebe_required", False)),
            "damage_level": _classify_damage(di_eff),
        })

    pier_di.sort(key=lambda r: -r["di_effective"])

    max_di = pier_di[0]["di_effective"] if pier_di else 0.0
    n_crit = sum(1 for r in pier_di if r["di_effective"] >= _DI_CRITICAL)

    return {
        "status":        "success",
        "direction":     direction,
        "ductility":     ductility,
        "drift_cap":     drift_cap,
        "n_critical":    n_crit,
        "max_di":        round(float(max_di), 3),
        "story_drifts": [
            {
                "story":         s,
                "z_m":           z,
                "max_drift_pct": round(float(max_drift_story[i]) * 100.0, 4),
            }
            for i, (s, z) in enumerate(zip(story_names_ordered, cm_z))
        ],
        "pier_damage":   pier_di,
    }


def _story_order_from_design(design_rows: Iterable[dict]) -> list[tuple[str, float]]:
    """
    Recupera (story, z) ordenados de menor a mayor a partir de hw acumulado.
    Asume que el primer piso arranca en z=0 y suma hw_m sucesivamente por story.
    """
    story_hw: dict[str, float] = {}
    for r in design_rows:
        s  = r["story"]
        hw = float(r.get("hw_m", 3.0) or 3.0)
        if s not in story_hw or hw > story_hw[s]:
            story_hw[s] = hw

    # Los stories de ETABS suelen venir con nombres tipo "Story1", "Story2", ...
    # o "N1", "N2". El orden no es alfabético. Sin embargo, en el pushover los
    # CM se ordenaron por elevación → usamos ese mismo orden extrayendo hw.
    # Como fallback, se ordenan por nombre y se asume elevaciones acumuladas.
    stories = sorted(story_hw.keys())
    z = 0.0
    out: list[tuple[str, float]] = []
    for s in stories:
        z += story_hw[s]
        out.append((s, z))
    return out


def _classify_damage(di: float) -> str:
    if di < 0.10: return "none"
    if di < 0.25: return "minor"
    if di < 0.40: return "moderate"
    if di < 1.00: return "severe"
    return "collapse"
