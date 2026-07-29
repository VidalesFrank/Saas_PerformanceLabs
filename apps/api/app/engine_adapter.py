"""Traduce el contrato HTTP (SectionCreate / JSON almacenado) a CompiledFiberSection.

Es el unico punto de la API que conoce tanto el esquema HTTP como los tipos de
`engine`. El motor en si (`packages/engine`) no tiene ninguna dependencia de FastAPI.
"""
from __future__ import annotations

from engine.sections.compiler import CompiledFiberSection, compile as compile_section, document_from_legacy
from engine.sections.document import SectionDocument
from engine.sections.reinforcement import bar_area, BAR_AREAS_MM2
from engine.materials.concrete import (
    ConfinedConcreteReport,
    unconfined_concrete,
)

from app.models import ShapeType
from app.schemas import SectionCreate
from app.unit_converter import UnitConverter as UC


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


def build_compiled_section(
    shape_type: ShapeType,
    geometry: dict,
    materials: dict,
    reinforcement: dict,
    cover: float,
) -> CompiledFiberSection:
    """Convierte los dicts de la API legacy a CompiledFiberSection via SectionDocument.

    Mantiene compatibilidad total con los endpoints /api/v1/sections existentes.
    """
    doc = document_from_legacy(
        shape_type=shape_type.value,
        geometry=geometry,
        materials=materials,
        reinforcement=reinforcement,
        cover=cover,
    )
    return compile_section(doc)


def build_compiled_from_document(doc: SectionDocument) -> CompiledFiberSection:
    """Convierte un SectionDocument (nuevo formato) a CompiledFiberSection."""
    return compile_section(doc)


def build_section_summary(
    shape_type: ShapeType,
    geometry: dict,
    materials: dict,
    reinforcement: dict,
    cover: float,
    axial_load_n: float = 0.0,
) -> tuple[dict, dict]:
    """Computa (material_summary, section_summary) para el reporte profesional M-phi.

    Reconstruye el documento para extraer el reporte Mander y propiedades geométricas.
    """
    compiled = build_compiled_section(shape_type, geometry, materials, reinforcement, cover)
    fpc = materials["fpc"]
    fy = materials["fy"]
    es = materials.get("es", 200_000.0)
    eps_yield = fy / es

    # Extraer reporte Mander de la primera región compilada
    report: ConfinedConcreteReport | None = None
    for rpt in compiled.mander_reports.values():
        if rpt is not None:
            report = rpt
            break

    if report is not None:
        unconf = unconfined_concrete(fpc)
        material_summary = {
            "fpc_MPa": round(fpc, 1),
            "epsc0_unconf": round(unconf.epsc0, 4),
            "ecu_unconf": round(unconf.epsU, 4),
            "fpcc_MPa": round(report.params.fpc, 2),
            "fcc_sobre_fc": round(report.fcc_over_fc, 3),
            "ke": round(report.ke, 3),
            "fl_MPa": round(report.fl, 3),
            "rho_s_pct": round(report.rho_s * 100, 3),
            "epsc0_conf": round(report.params.epsc0, 4),
            "ecu_conf": round(report.params.epsU, 4),
            "fyh_MPa": round(report.fyh, 1),
            "fy_MPa": round(fy, 1),
            "eps_y": round(eps_yield, 5),
        }
    else:
        material_summary = {
            "fpc_MPa": round(fpc, 1),
            "fpcc_MPa": round(fpc, 1),
            "nota": "Confinamiento no calculado para esta geometría",
            "fy_MPa": round(fy, 1),
            "eps_y": round(eps_yield, 5),
        }

    # Propiedades geométricas
    ag = compiled.gross_area
    ast = compiled.steel_area
    p_kn = UC.n_to_kn(axial_load_n)

    if shape_type in (ShapeType.rectangular, ShapeType.square):
        w, h = geometry["width"], geometry["height"]
        section_summary = {
            "forma": "Rectangular",
            "b_mm": round(w, 1),
            "h_mm": round(h, 1),
            "recubrimiento_mm": round(cover, 1),
            "area_bruta_mm2": round(ag, 0),
            "area_acero_mm2": round(ast, 1),
            "rho_t_pct": round(ast / ag * 100, 3) if ag > 0 else 0.0,
            "n_barras": len([b for b in _bars_from_reinforcement(reinforcement, shape_type, geometry, cover)]),
            "varilla": reinforcement["bar_id"],
            "P_sobre_fcAg": round(axial_load_n / (fpc * ag), 4) if fpc * ag > 0 else 0.0,
            "P_kN": round(p_kn, 1),
        }
    elif shape_type == ShapeType.circular:
        d = geometry["diameter"]
        section_summary = {
            "forma": "Circular",
            "D_mm": round(d, 1),
            "recubrimiento_mm": round(cover, 1),
            "area_bruta_mm2": round(ag, 0),
            "area_acero_mm2": round(ast, 1),
            "rho_t_pct": round(ast / ag * 100, 3) if ag > 0 else 0.0,
            "n_barras": reinforcement.get("n_bars", 0),
            "varilla": reinforcement["bar_id"],
            "P_sobre_fcAg": round(axial_load_n / (fpc * ag), 4) if fpc * ag > 0 else 0.0,
            "P_kN": round(p_kn, 1),
        }
    else:
        section_summary = {
            "forma": "Especial (polígono)",
            "area_bruta_mm2": round(ag, 0),
            "area_acero_mm2": round(ast, 1),
            "P_kN": round(p_kn, 1),
        }

    return material_summary, section_summary


def _bars_from_reinforcement(reinforcement: dict, shape_type, geometry: dict, cover: float) -> list:
    """Helper temporal para contar barras en el summary."""
    bar_id = reinforcement.get("bar_id", "#8")
    if shape_type in (ShapeType.rectangular, ShapeType.square):
        n_y = reinforcement.get("n_bars_y", 3) or 3
        n_z = reinforcement.get("n_bars_z", 3) or 3
        n = 2 * n_y + 2 * (n_z - 2)
        return list(range(n))
    if shape_type == ShapeType.circular:
        return list(range(reinforcement.get("n_bars", 8) or 8))
    return reinforcement.get("bars") or []
