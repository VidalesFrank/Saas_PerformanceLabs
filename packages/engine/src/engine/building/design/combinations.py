"""
Combinaciones de diseño NSR-10 Título B — B.3.4 (LRFD).

Las fuerzas sísmicas E del RSA ya incorporan el factor de reducción R
(el espectro de diseño NSR-10 opera al nivel de diseño, no al nivel elástico).
Los factores ±1.0·E en las combinaciones se aplican directamente sobre las
demandas del análisis espectral.

Se consideran las cuatro combinaciones fundamentales con sismo:
  - 1.2D + 1.0L ± 1.0Ex      (NSR-10 B.3.4-5)
  - 1.2D + 1.0L ± 1.0Ey      (NSR-10 B.3.4-5)
  - 0.9D ± 1.0Ex              (NSR-10 B.3.4-7, crítica en tensión)
  - 0.9D ± 1.0Ey              (NSR-10 B.3.4-7, crítica en tensión)
"""

from __future__ import annotations

NSR10_COMBINATIONS: list[dict] = [
    # ── Gravitacionales ──────────────────────────────────────────────────────
    {
        "id":      "G1",
        "name":    "Gravitacional 1",
        "group":   "gravity",
        "ref":     "B.3.4-1",
        "formula": "1.4·CM",
        "factors": {"CM": 1.4, "CV": 0.0, "Ex": 0.0, "Ey": 0.0},
        "note":    "Controla cuando CM >> CV (ej. losas macizas sin mucha carga viva).",
    },
    {
        "id":      "G2",
        "name":    "Gravitacional 2",
        "group":   "gravity",
        "ref":     "B.3.4-2",
        "formula": "1.2·CM + 1.6·CV",
        "factors": {"CM": 1.2, "CV": 1.6, "Ex": 0.0, "Ey": 0.0},
        "note":    "Combinación gravitacional de diseño por flexión y cortante en vigas.",
    },
    # ── Sísmicas — Dirección X ───────────────────────────────────────────────
    {
        "id":      "S1",
        "name":    "Sísmica +X",
        "group":   "seismic_x",
        "ref":     "B.3.4-5",
        "formula": "1.2·CM + 1.0·CV + 1.0·Ex",
        "factors": {"CM": 1.2, "CV": 1.0, "Ex": +1.0, "Ey": 0.0},
        "note":    "Sismo +X. Controla compresión máxima en columnas del lado de barlovento.",
    },
    {
        "id":      "S2",
        "name":    "Sísmica -X",
        "group":   "seismic_x",
        "ref":     "B.3.4-5",
        "formula": "1.2·CM + 1.0·CV - 1.0·Ex",
        "factors": {"CM": 1.2, "CV": 1.0, "Ex": -1.0, "Ey": 0.0},
        "note":    "Sismo -X. Complementaria a S1.",
    },
    {
        "id":      "S5",
        "name":    "Sísmica +X (0.9D)",
        "group":   "seismic_x",
        "ref":     "B.3.4-7",
        "formula": "0.9·CM + 1.0·Ex",
        "factors": {"CM": 0.9, "CV": 0.0, "Ex": +1.0, "Ey": 0.0},
        "note":    "Mínima carga muerta + sismo. Crítica para tensión en columnas y muros.",
    },
    {
        "id":      "S6",
        "name":    "Sísmica -X (0.9D)",
        "group":   "seismic_x",
        "ref":     "B.3.4-7",
        "formula": "0.9·CM - 1.0·Ex",
        "factors": {"CM": 0.9, "CV": 0.0, "Ex": -1.0, "Ey": 0.0},
        "note":    "Complementaria a S5.",
    },
    # ── Sísmicas — Dirección Y ───────────────────────────────────────────────
    {
        "id":      "S3",
        "name":    "Sísmica +Y",
        "group":   "seismic_y",
        "ref":     "B.3.4-5",
        "formula": "1.2·CM + 1.0·CV + 1.0·Ey",
        "factors": {"CM": 1.2, "CV": 1.0, "Ex": 0.0, "Ey": +1.0},
        "note":    "Sismo +Y. Controla compresión máxima en columnas del lado de barlovento.",
    },
    {
        "id":      "S4",
        "name":    "Sísmica -Y",
        "group":   "seismic_y",
        "ref":     "B.3.4-5",
        "formula": "1.2·CM + 1.0·CV - 1.0·Ey",
        "factors": {"CM": 1.2, "CV": 1.0, "Ex": 0.0, "Ey": -1.0},
        "note":    "Complementaria a S3.",
    },
    {
        "id":      "S7",
        "name":    "Sísmica +Y (0.9D)",
        "group":   "seismic_y",
        "ref":     "B.3.4-7",
        "formula": "0.9·CM + 1.0·Ey",
        "factors": {"CM": 0.9, "CV": 0.0, "Ex": 0.0, "Ey": +1.0},
        "note":    "Mínima carga muerta + sismo. Crítica para tensión.",
    },
    {
        "id":      "S8",
        "name":    "Sísmica -Y (0.9D)",
        "group":   "seismic_y",
        "ref":     "B.3.4-7",
        "formula": "0.9·CM - 1.0·Ey",
        "factors": {"CM": 0.9, "CV": 0.0, "Ex": 0.0, "Ey": -1.0},
        "note":    "Complementaria a S7.",
    },
]

# Todos los IDs disponibles (para validación)
_VALID_IDS: frozenset[str] = frozenset(c["id"] for c in NSR10_COMBINATIONS)

# Selección por defecto: todas (NSR-10 requiere al menos las 10)
DEFAULT_SELECTED_IDS: list[str] = [c["id"] for c in NSR10_COMBINATIONS]

# Orden canónico de grupos para UI
GROUP_ORDER = ["gravity", "seismic_x", "seismic_y"]
GROUP_LABELS = {
    "gravity":   "Gravitacionales",
    "seismic_x": "Sísmicas — Dirección X",
    "seismic_y": "Sísmicas — Dirección Y",
}


def validate_selected_ids(selected: list[str]) -> list[str]:
    """
    Filtra IDs inválidos preservando el orden canónico.
    Garantiza que G1 y G2 siempre estén incluidas (NSR-10 mínimo).
    """
    order = {c["id"]: i for i, c in enumerate(NSR10_COMBINATIONS)}
    valid = sorted(
        (cid for cid in selected if cid in _VALID_IDS),
        key=lambda x: order[x],
    )
    for required in ("G1", "G2"):
        if required not in valid:
            valid.insert(0, required)
    return valid
