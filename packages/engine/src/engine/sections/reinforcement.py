"""Generadores de patrones de barras de refuerzo -> fibras individuales (y, z, area).

Cada barra se representa como una fibra puntual explicita (`PointFiberSpec`), en vez
de usar los helpers `layer(...)` de OpenSees, para tener control exacto de la
posicion de cada barra y poder reutilizar las mismas coordenadas al dibujar la
vista previa 2D de la seccion en el frontend.
"""
from __future__ import annotations

import math

from engine.sections.geometry import CircularSection, PointFiberSpec, RectangularSection

BAR_AREAS_MM2: dict[str, float] = {
    # Barras de refuerzo #3-#11 (diametro nominal en mm -> area en mm^2)
    "#3": 71.0, "#4": 129.0, "#5": 199.0, "#6": 284.0, "#7": 387.0,
    "#8": 510.0, "#9": 645.0, "#10": 819.0, "#11": 1006.0,
}


def bar_area(bar_id: str) -> float:
    try:
        return BAR_AREAS_MM2[bar_id]
    except KeyError as exc:
        raise ValueError(f"Barra desconocida: {bar_id}. Opciones: {sorted(BAR_AREAS_MM2)}") from exc


def rect_perimeter_bars(
    section: RectangularSection,
    cover_to_bar_centroid: float,
    n_bars_y: int,
    n_bars_z: int,
    area_per_bar: float,
    mat_tag: int,
) -> list[PointFiberSpec]:
    """Distribucion perimetral de barras en una seccion rectangular.

    n_bars_y: numero de barras por cara horizontal (superior/inferior), incluye esquinas.
    n_bars_z: numero de barras por cara vertical (izq/der), incluye esquinas.
    """
    if n_bars_y < 2 or n_bars_z < 2:
        raise ValueError("Se requieren al menos 2 barras por cara (las esquinas).")

    hh, hw = section.height / 2, section.width / 2
    y_out, z_out = hh - cover_to_bar_centroid, hw - cover_to_bar_centroid

    bars: list[PointFiberSpec] = []

    for i in range(n_bars_y):
        z = -z_out + i * (2 * z_out) / (n_bars_y - 1)
        bars.append(PointFiberSpec(mat_tag, y_out, z, area_per_bar))
        bars.append(PointFiberSpec(mat_tag, -y_out, z, area_per_bar))

    for i in range(1, n_bars_z - 1):
        y = -y_out + i * (2 * y_out) / (n_bars_z - 1)
        bars.append(PointFiberSpec(mat_tag, y, z_out, area_per_bar))
        bars.append(PointFiberSpec(mat_tag, y, -z_out, area_per_bar))

    return bars


def circ_perimeter_bars(
    section: CircularSection,
    cover_to_bar_centroid: float,
    n_bars: int,
    area_per_bar: float,
    mat_tag: int,
) -> list[PointFiberSpec]:
    """Distribucion de barras en anillo, uniformemente espaciadas, seccion circular."""
    if n_bars < 4:
        raise ValueError("Se requieren al menos 4 barras en una seccion circular.")

    radius = section.diameter / 2 - cover_to_bar_centroid
    bars = []
    for i in range(n_bars):
        theta = 2 * math.pi * i / n_bars
        y = radius * math.cos(theta)
        z = radius * math.sin(theta)
        bars.append(PointFiberSpec(mat_tag, y, z, area_per_bar))
    return bars


def total_steel_area(bars: list[PointFiberSpec]) -> float:
    return sum(b.area for b in bars)
