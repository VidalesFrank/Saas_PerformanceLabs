"""Router del editor de secciones — Módulo 2 v2.

Endpoints para el nuevo flujo:
  - CRUD de SectionDocument (biblioteca de secciones)
  - Análisis sobre una sección guardada (P-M, M-φ, P-M-M)
  - Helper para preview de geometría (coordenadas de barras y polígonos)

El objeto central es SectionV2 (DB) que almacena el SectionDocument completo
como JSON. Todos los análisis lo leen, lo compilan y ejecutan en OpenSees.
"""
from __future__ import annotations

import bisect
import dataclasses
import math
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from engine.sections.document import (
    ConcreteDef, SteelDef, ConcreteRegion, ReinforcementBar,
    RectShape, CircShape, PolygonShape, SectionDocument,
    RectConfinementDef, CircConfinementDef,
)
from engine.sections.compiler import compile as compile_doc
from engine.sections.nsr10_check import compute_nsr10_check
from engine.analysis.interaction import compute_interaction_diagram
from engine.analysis.moment_curvature import compute_moment_curvature
from engine.analysis.pmm_surface import compute_pmm_surface

from app.auth import get_current_user
from app.db import get_db
from app.models import SectionV2, User
from app.unit_converter import UnitConverter as UC

router = APIRouter(prefix="/api/v1/editor/sections", tags=["section-editor"])


# ─────────────────────────────────────────────────────────────────────────────
# Serialización / deserialización de SectionDocument ↔ dict
# ─────────────────────────────────────────────────────────────────────────────

def _doc_to_dict(doc: SectionDocument) -> dict:
    """Serializa SectionDocument a dict plano (para JSON en DB)."""
    return dataclasses.asdict(doc)


def _dict_to_doc(d: dict) -> SectionDocument:
    """Deserializa dict (de DB) a SectionDocument."""
    def _shape(s: dict):
        k = s.get("kind", "poly")
        if k == "rect":
            return RectShape(**{kk: vv for kk, vv in s.items() if kk != "kind"})
        if k == "circ":
            return CircShape(**{kk: vv for kk, vv in s.items() if kk != "kind"})
        verts = [tuple(v) for v in s.get("vertices", [])]
        return PolygonShape(vertices=verts)

    def _conf(c: dict | None):
        if c is None:
            return None
        if c.get("kind") == "rect":
            return RectConfinementDef(**{kk: vv for kk, vv in c.items() if kk != "kind"})
        return CircConfinementDef(**{kk: vv for kk, vv in c.items() if kk != "kind"})

    concrete_defs = [ConcreteDef(**c) for c in d.get("concrete_defs", [])]
    steel_defs    = [SteelDef(**s)    for s in d.get("steel_defs", [])]

    regions = []
    for r in d.get("regions", []):
        cp = r.get("core_polygon")
        regions.append(ConcreteRegion(
            id=r["id"], label=r["label"],
            shape=_shape(r["shape"]),
            concrete_id=r["concrete_id"],
            confinement=_conf(r.get("confinement")),
            cover_to_bar=r.get("cover_to_bar", 0.0),
            is_void=r.get("is_void", False),
            core_polygon=[tuple(v) for v in cp] if cp else None,
        ))

    bars = [
        ReinforcementBar(
            id=b["id"], y=b["y"], z=b["z"],
            bar_size=b["bar_size"], steel_id=b["steel_id"],
        )
        for b in d.get("bars", [])
    ]

    return SectionDocument(
        schema_version=d.get("schema_version", 1),
        concrete_defs=concrete_defs,
        steel_defs=steel_defs,
        regions=regions,
        bars=bars,
    )


# ─────────────────────────────────────────────────────────────────────────────
# CRUD
# ─────────────────────────────────────────────────────────────────────────────

@router.post("", status_code=201)
def create_section(
    body: dict,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Crea una nueva sección en la biblioteca.

    `body` debe ser un dict con:
      - name: str
      - description: str | null
      - document: dict  (SectionDocument serializado)
    """
    name = body.get("name", "Sin nombre")
    description = body.get("description")
    doc_dict = body.get("document", {})

    # Solo verificar que el dict es deserializable, sin compilar
    try:
        _dict_to_doc(doc_dict)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Documento de sección inválido: {exc}") from exc

    row = SectionV2(
        owner_id=user.id,
        name=name,
        description=description,
        document=doc_dict,
        schema_version=doc_dict.get("schema_version", 1),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _row_out(row)


@router.get("")
def list_sections(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[dict]:
    rows = (db.query(SectionV2)
            .filter(SectionV2.owner_id == user.id)
            .order_by(SectionV2.created_at.desc())
            .all())
    return [_row_summary(r) for r in rows]


@router.get("/{section_id}")
def get_section(
    section_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    row = _get_owned(db, section_id, user)
    return _row_out(row)


@router.put("/{section_id}")
def update_section(
    section_id: str,
    body: dict,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    row = _get_owned(db, section_id, user)

    if "name" in body:
        row.name = body["name"]
    if "description" in body:
        row.description = body["description"]
    if "document" in body:
        try:
            _dict_to_doc(body["document"])
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"Documento inválido: {exc}") from exc
        row.document = body["document"]
        row.schema_version = body["document"].get("schema_version", 1)

    row.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(row)
    return _row_out(row)


@router.delete("/{section_id}", status_code=204)
def delete_section(
    section_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    row = _get_owned(db, section_id, user)
    db.delete(row)
    db.commit()


# ─────────────────────────────────────────────────────────────────────────────
# Análisis
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/{section_id}/interaction-diagram")
def run_interaction(
    section_id: str,
    body: dict,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Calcula el diagrama de interacción P-M.

    body opcional: { num_points: int }
    """
    row = _get_owned(db, section_id, user)
    doc = _dict_to_doc(row.document)
    compiled = compile_doc(doc)

    num_points = int(body.get("num_points", 15))
    theta_deg = float(body.get("theta_deg", 0.0))
    diagram = compute_interaction_diagram(compiled, num_points=num_points, theta_deg=theta_deg)

    points = [{"p_kn": UC.n_to_kn(pt.P), "m_knm": UC.nmm_to_knm(pt.M)} for pt in diagram]
    return {
        "section_id": section_id,
        "points": points,
        "p_max_kn": UC.n_to_kn(diagram[0].P),
        "p_min_kn": UC.n_to_kn(diagram[-1].P),
        "m_max_knm": UC.nmm_to_knm(max(pt.M for pt in diagram)),
    }


@router.post("/{section_id}/moment-curvature")
def run_moment_curvature_ep(
    section_id: str,
    body: dict,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Calcula la curva M-φ.

    body: { axial_load_kn: float, num_incr?: int, curvature_multiple?: float }
    """
    row = _get_owned(db, section_id, user)
    doc = _dict_to_doc(row.document)
    compiled = compile_doc(doc)

    axial_n = UC.kn_to_n(float(body.get("axial_load_kn", 0.0)))
    num_incr = int(body.get("num_incr", 120))
    curv_mult = float(body.get("curvature_multiple", 8.0))
    theta_deg = float(body.get("theta_deg", 0.0))

    result = compute_moment_curvature(compiled, axial_n, num_incr=num_incr, curvature_multiple=curv_mult, theta_deg=theta_deg)

    return {
        "section_id": section_id,
        "axial_load_kn": UC.n_to_kn(axial_n),
        "curve": [{"phi": UC.phi_mm_to_m(pt.phi), "moment": UC.nmm_to_knm(pt.moment)}
                  for pt in result.curve],
        "phi_yield": UC.phi_mm_to_m(result.phi_yield),
        "moment_yield": UC.nmm_to_knm(result.moment_yield),
        "phi_max": UC.phi_mm_to_m(result.phi_max),
        "moment_max": UC.nmm_to_knm(result.moment_max),
        "phi_ultimate": UC.phi_mm_to_m(result.phi_ultimate),
        "moment_ultimate": UC.nmm_to_knm(result.moment_ultimate),
        "ductility": result.ductility,
        "ei_secant_kNm2": UC.nmm2_to_knm2(result.ei_secant),
        "failure_reached": result.failure_reached,
    }


@router.post("/{section_id}/pmm-surface")
def run_pmm(
    section_id: str,
    body: dict,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Calcula la superficie P-M-M biaxial.

    body: { num_angles?: int, num_points?: int, demands?: [{p_kn, mx_knm, my_knm}] }
    """
    row = _get_owned(db, section_id, user)
    doc = _dict_to_doc(row.document)
    compiled = compile_doc(doc)

    num_angles = int(body.get("num_angles", 8))
    num_points = int(body.get("num_points", 10))
    demands_in = body.get("demands", [])

    raw = compute_pmm_surface(compiled, num_angles=num_angles, num_points=num_points)

    from collections import defaultdict
    bucket: dict[float, list] = defaultdict(list)
    for pt in raw:
        key = round(math.degrees(pt.theta), 4)
        bucket[key].append(pt)

    curves = []
    for theta_deg in sorted(bucket.keys()):
        pts_sorted = sorted(bucket[theta_deg], key=lambda p: p.P, reverse=True)
        curves.append({
            "theta_deg": theta_deg,
            "points": [
                {"p": UC.n_to_kn(pt.P), "mx": UC.nmm_to_knm(pt.Mx), "my": UC.nmm_to_knm(pt.My)}
                for pt in pts_sorted
            ],
        })

    p_vals = [pt.P for pt in raw]
    m_vals = [math.sqrt(pt.Mx**2 + pt.My**2) for pt in raw]

    demands_out = [_check_demand_dict(curves, d) for d in demands_in]

    return {
        "section_id": section_id,
        "curves": curves,
        "p_max_kn": UC.n_to_kn(max(p_vals)),
        "p_min_kn": UC.n_to_kn(min(p_vals)),
        "m_max_knm": UC.nmm_to_knm(max(m_vals)),
        "demands_out": demands_out,
    }


@router.post("/{section_id}/nsr10-check")
def run_nsr10(
    section_id: str,
    body: dict,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Verifica criterios NSR-10 Capítulo C para la sección guardada.

    body: {
      element_type: "columna" | "viga" | "muro",
      ductility: "DMI" | "DMO" | "DES"
    }
    """
    row = _get_owned(db, section_id, user)
    doc = _dict_to_doc(row.document)
    try:
        compiled = compile_doc(doc)
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))

    element_type = str(body.get("element_type", "columna"))
    ductility    = str(body.get("ductility", "DMO"))

    doc_dict = row.document
    bars     = doc_dict.get("bars", [])
    regions  = doc_dict.get("regions", [])
    n_bars   = len(bars)

    main_regions = [r for r in regions if not r.get("is_void", False)]
    cover_mm   = min((r.get("cover_to_bar", 40.0) for r in main_regions), default=40.0)

    # Determinar shape_kind del primer elemento no vacío
    shape_kind = "rect"
    if main_regions:
        first_shape = main_regions[0].get("shape", {})
        kind = first_shape.get("kind", "rect")
        if kind == "circ":
            shape_kind = "circ"
        elif kind == "poly":
            shape_kind = "poly"

    checks = compute_nsr10_check(compiled, element_type, ductility, n_bars, cover_mm, shape_kind)

    n_fail    = sum(1 for c in checks if c.status == "fail")
    n_warning = sum(1 for c in checks if c.status == "warning")
    n_ok      = sum(1 for c in checks if c.status == "ok")

    return {
        "section_id": section_id,
        "element_type": element_type,
        "ductility": ductility,
        "summary": {"ok": n_ok, "fail": n_fail, "warning": n_warning, "total": len(checks)},
        "checks": [
            {
                "article": c.article,
                "description": c.description,
                "demand": round(c.demand, 4),
                "limit": round(c.limit, 4),
                "unit": c.unit,
                "status": c.status,
                "note": c.note,
            }
            for c in checks
        ],
    }


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _get_owned(db: Session, section_id: str, user: User) -> SectionV2:
    row = db.get(SectionV2, section_id)
    if row is None or row.owner_id != user.id:
        raise HTTPException(status_code=404, detail="Sección no encontrada")
    return row


def _row_out(row: SectionV2) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "description": row.description,
        "document": row.document,
        "schema_version": row.schema_version,
        "created_at": row.created_at.isoformat(),
        "updated_at": row.updated_at.isoformat(),
    }


def _row_summary(row: SectionV2) -> dict:
    """Versión reducida para la lista. Incluye geometría compacta para miniatura."""
    doc = row.document
    regions = doc.get("regions", [])
    bars = doc.get("bars", [])
    preview_regions = [{"shape": r["shape"], "is_void": r.get("is_void", False)} for r in regions]
    preview_bars = [{"y": b["y"], "z": b["z"], "bar_size": b["bar_size"]} for b in bars]
    return {
        "id": row.id,
        "name": row.name,
        "description": row.description,
        "n_regions": len(regions),
        "n_bars": len(bars),
        "schema_version": row.schema_version,
        "created_at": row.created_at.isoformat(),
        "updated_at": row.updated_at.isoformat(),
        "preview": {"regions": preview_regions, "bars": preview_bars},
    }


def _check_demand_dict(curves: list[dict], demand: dict) -> dict:
    p_kn    = float(demand.get("p_kn", 0))
    mx_knm  = float(demand.get("mx_knm", 0))
    my_knm  = float(demand.get("my_knm", 0))
    m_demand = math.sqrt(mx_knm**2 + my_knm**2)

    if m_demand < 1e-9:
        return {"p_kn": p_kn, "mx_knm": mx_knm, "my_knm": my_knm,
                "m_demand_knm": 0.0, "m_capacity_knm": 0.0, "dcr": 0.0, "inside": True}

    theta_u = math.atan2(my_knm, mx_knm)
    if theta_u < 0:
        theta_u += 2 * math.pi

    angles = [c["theta_deg"] * math.pi / 180 for c in curves]
    n = len(angles)
    idx    = bisect.bisect_right(angles, theta_u)
    lo_idx = (idx - 1) % n
    hi_idx = idx % n

    a_lo = angles[lo_idx]
    a_hi = angles[hi_idx]
    if hi_idx == 0:
        a_hi += 2 * math.pi

    denom = a_hi - a_lo
    t_ang = max(0.0, min(1.0, (theta_u - a_lo) / denom)) if abs(denom) > 1e-9 else 0.0

    def interp_m(pts: list[dict]) -> float:
        for i in range(len(pts) - 1):
            p_hi, p_lo = pts[i]["p"], pts[i + 1]["p"]
            m_hi = math.sqrt(pts[i]["mx"]**2 + pts[i]["my"]**2)
            m_lo = math.sqrt(pts[i + 1]["mx"]**2 + pts[i + 1]["my"]**2)
            if p_lo <= p_kn <= p_hi:
                t = (p_kn - p_lo) / (p_hi - p_lo) if abs(p_hi - p_lo) > 1e-9 else 0.0
                return m_lo + t * (m_hi - m_lo)
        return 0.0

    m_lo_val = interp_m(curves[lo_idx]["points"])
    m_hi_val = interp_m(curves[hi_idx]["points"])
    m_cap    = m_lo_val + t_ang * (m_hi_val - m_lo_val)

    if m_cap < 1e-6:
        return {"p_kn": p_kn, "mx_knm": mx_knm, "my_knm": my_knm,
                "m_demand_knm": round(m_demand, 3), "m_capacity_knm": 0.0,
                "dcr": float("inf"), "inside": False}

    dcr = m_demand / m_cap
    return {"p_kn": p_kn, "mx_knm": mx_knm, "my_knm": my_knm,
            "m_demand_knm": round(m_demand, 3), "m_capacity_knm": round(m_cap, 3),
            "dcr": round(dcr, 4), "inside": dcr <= 1.0}
