"""Traduce el contrato HTTP (SectionCreate / JSON almacenado) a objetos del motor de ingenieria.

Es el unico punto de la API que conoce tanto el esquema HTTP como los tipos de
`engine`. El motor en si (`packages/engine`) no tiene ninguna dependencia de FastAPI.
"""
from __future__ import annotations

from engine.materials.concrete import (
    CircConfinement,
    ConcreteMaterialParams,
    RectConfinement,
    mander_confined_circ,
    mander_confined_rect,
    unconfined_concrete,
)
from engine.materials.steel import SteelMaterialParams, reinforcing_steel
from engine.sections.geometry import CircularSection, PointFiberSpec, PolygonSection, RectangularSection
from engine.sections.reinforcement import bar_area, circ_perimeter_bars, rect_perimeter_bars, rect_layout_bars

from app.models import ShapeType
from app.schemas import SectionCreate

# Las barras se agregan como fibras individuales; el mat_tag real (envuelto en
# MinMax) lo asigna engine.analysis.interaction al construir el modelo.
_BAR_MAT_TAG_PLACEHOLDER = 0


def split_payload(payload: SectionCreate) -> tuple[dict, dict, dict]:
    """Separa el payload validado en los tres bloques JSON que se persisten en `Section`."""
    geometry = {
        "width": payload.width, "height": payload.height, "diameter": payload.diameter,
        "vertices": payload.vertices, "core_vertices": payload.core_vertices,
    }
    materials = {
        "fpc": payload.fpc, "fy": payload.fy, "es": payload.es,
        "hoop_bar_diameter": payload.hoop_bar_diameter, "hoop_spacing": payload.hoop_spacing,
        "hoop_legs_x": payload.hoop_legs_x, "hoop_legs_y": payload.hoop_legs_y,
        "hoop_leg_area": payload.hoop_leg_area, "is_spiral": payload.is_spiral,
    }
    reinforcement = {
        "bar_id": payload.bar_id, "cover_to_bar_centroid": payload.cover_to_bar_centroid,
        "n_bars_y": payload.n_bars_y, "n_bars_z": payload.n_bars_z, "n_bars": payload.n_bars,
        "bars": payload.bars,
    }
    return geometry, materials, reinforcement


def build_engine_inputs(
    shape_type: ShapeType, geometry: dict, materials: dict, reinforcement: dict, cover: float
) -> tuple[object, list[PointFiberSpec], ConcreteMaterialParams, ConcreteMaterialParams, SteelMaterialParams, float]:
    """Reconstruye (shape, bars, core_params, cover_params, steel_params, depth_for_curvature)
    a partir de los bloques geometry/materials/reinforcement, para cualquier forma soportada."""
    fpc, fy, es = materials["fpc"], materials["fy"], materials["es"]
    steel_params = reinforcing_steel(fy=fy, E0=es)
    area_per_bar = bar_area(reinforcement["bar_id"])
    cover_params = unconfined_concrete(fpc)

    if shape_type in (ShapeType.rectangular, ShapeType.square):
        width, height = geometry["width"], geometry["height"]
        shape = RectangularSection(width=width, height=height, cover=cover)
        bars = rect_perimeter_bars(
            shape, cover_to_bar_centroid=reinforcement["cover_to_bar_centroid"],
            n_bars_y=reinforcement["n_bars_y"], n_bars_z=reinforcement["n_bars_z"],
            area_per_bar=area_per_bar, mat_tag=_BAR_MAT_TAG_PLACEHOLDER,
        )
        ast = sum(b.area for b in bars)
        conf = RectConfinement(
            bc=width - 2 * cover, dc=height - 2 * cover, s=materials["hoop_spacing"],
            hoop_bar_diameter=materials["hoop_bar_diameter"],
            num_legs_x=materials["hoop_legs_x"], num_legs_y=materials["hoop_legs_y"],
            leg_area=materials["hoop_leg_area"],
            clear_bar_spacings=_estimate_rect_clear_spacings(shape, reinforcement),
            rho_cc=ast / shape.core_area,
        )
        core_params = mander_confined_rect(fpc, fyh=fy, confinement=conf)
        depth_for_curvature = height

    elif shape_type == ShapeType.circular:
        diameter = geometry["diameter"]
        shape = CircularSection(diameter=diameter, cover=cover)
        bars = circ_perimeter_bars(
            shape, cover_to_bar_centroid=reinforcement["cover_to_bar_centroid"],
            n_bars=reinforcement["n_bars"], area_per_bar=area_per_bar, mat_tag=_BAR_MAT_TAG_PLACEHOLDER,
        )
        ast = sum(b.area for b in bars)
        conf = CircConfinement(
            ds=diameter - 2 * cover, s=materials["hoop_spacing"], hoop_bar_diameter=materials["hoop_bar_diameter"],
            bar_area=materials["hoop_leg_area"], rho_cc=ast / shape.core_area,
            is_spiral=materials.get("is_spiral", True),
        )
        core_params = mander_confined_circ(fpc, fyh=fy, confinement=conf)
        depth_for_curvature = diameter

    elif shape_type == ShapeType.special:
        vertices = [tuple(v) for v in geometry["vertices"]]
        core_vertices = [tuple(v) for v in geometry["core_vertices"]] if geometry.get("core_vertices") else None
        shape = PolygonSection(vertices=vertices, core_vertices=core_vertices)
        bars = [
            PointFiberSpec(_BAR_MAT_TAG_PLACEHOLDER, y, z, area_per_bar) for y, z in reinforcement["bars"]
        ]
        # v1: sin modelo de confinamiento diferenciado para poligonos arbitrarios
        # (ver nota en engine.sections.geometry.PolygonSection).
        ys = [v[0] for v in vertices]
        depth_for_curvature = max(ys) - min(ys)

    else:
        raise ValueError(f"shape_type no soportado: {shape_type}")

    return shape, bars, core_params, cover_params, steel_params, depth_for_curvature


def _estimate_rect_clear_spacings(shape: RectangularSection, reinforcement: dict) -> list[float]:
    """Aproxima wi (separaciones libres entre barras soportadas, para el ke de Mander)
    asumiendo barras uniformemente distribuidas en el perimetro. Simplificacion v1;
    reemplazar con las posiciones reales de barras si se requiere mayor precision."""
    n_y, n_z = reinforcement["n_bars_y"], reinforcement["n_bars_z"]
    spacing_z = shape.core_width / max(n_y - 1, 1)
    spacing_y = shape.core_height / max(n_z - 1, 1)
    return [spacing_z] * (n_y - 1) + [spacing_y] * (n_z - 1)
