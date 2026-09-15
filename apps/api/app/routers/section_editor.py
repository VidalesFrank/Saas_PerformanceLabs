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
    IShape, TShape, LShape, DoubleTShape,
    RectConfinementDef, CircConfinementDef,
)
from engine.sections.compiler import compile as compile_doc
from engine.sections.nsr10_check import compute_nsr10_check
from engine.sections.section_properties import compute_geometric_properties
from engine.sections.shear import (
    ShearDemand, ShearGeometry, TransverseReinforcement,
    compute_shear_check,
)
from engine.sections.ductility import compute_ductility_metrics, LpMethod
from engine.sections.serviceability import compute_serviceability
from engine.analysis.cyclic import (
    compute_cyclic_moment_curvature,
    generate_atc24_history, generate_sinusoidal_history,
)
from engine.sections.design import (
    ColumnGeometry, DesignDemand, design_column,
)
from engine.analysis.interaction import compute_interaction_diagram, identify_key_points
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
        fields = {kk: vv for kk, vv in s.items() if kk != "kind"}
        if k == "rect":         return RectShape(**fields)
        if k == "circ":         return CircShape(**fields)
        if k == "ishape":       return IShape(**fields)
        if k == "tshape":       return TShape(**fields)
        if k == "lshape":       return LShape(**fields)
        if k == "doubletshape": return DoubleTShape(**fields)
        verts = [tuple(v) for v in s.get("vertices", [])]
        return PolygonShape(vertices=verts)

    def _conf(c: dict | None):
        if c is None:
            return None
        if c.get("kind") == "rect":
            return RectConfinementDef(**{kk: vv for kk, vv in c.items() if kk != "kind"})
        return CircConfinementDef(**{kk: vv for kk, vv in c.items() if kk != "kind"})

    # Filtrar campos desconocidos por si vienen versiones anteriores del schema
    _cf = {"id", "label", "fpc", "eco", "model_kind", "ft", "Ets", "lambda_c"}
    _sf = {"id", "label", "fy", "Es", "b", "model_kind", "fpu", "eps_ult"}
    concrete_defs = [ConcreteDef(**{k: v for k, v in c.items() if k in _cf})
                     for c in d.get("concrete_defs", [])]
    steel_defs    = [SteelDef(**{k: v for k, v in c.items() if k in _sf})
                     for c in d.get("steel_defs", [])]

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

    num_points = int(body.get("num_points", 40))
    theta_deg = float(body.get("theta_deg", 0.0))
    diagram = compute_interaction_diagram(compiled, num_points=num_points, theta_deg=theta_deg)

    points = [{"p_kn": UC.n_to_kn(pt.P), "m_knm": UC.nmm_to_knm(pt.M)} for pt in diagram]
    raw_key_pts = identify_key_points(diagram)
    key_points = {
        k: {"p_kn": v["p_kn"], "m_knm": v["m_knm"]}
        for k, v in raw_key_pts.items()
    }
    return {
        "section_id": section_id,
        "points": points,
        "p_max_kn": UC.n_to_kn(diagram[0].P),
        "p_min_kn": UC.n_to_kn(diagram[-1].P),
        "m_max_knm": UC.nmm_to_knm(max(pt.M for pt in diagram)),
        "key_points": key_points,
        "theta_deg": theta_deg,
        "num_points_computed": len(points),
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


@router.get("/{section_id}/geometric-properties")
def get_geometric_properties(
    section_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Propiedades geométricas ingenieriles de la sección.

    Retorna Ag, An, ρg, centroide, Iy, Iz, Iyz, Sy±, Sz±, ry, rz, Zpy, Zpz,
    factores de forma, ejes principales (I1, I2, θp) y extremos de fibra.

    Todas las unidades son SI base internas del motor: mm, mm², mm³, mm⁴.
    Devuelve también una vista en unidades ingenieriles: cm², cm⁴, cm³ para
    facilitar la lectura en la UI.
    """
    row = _get_owned(db, section_id, user)
    doc = _dict_to_doc(row.document)
    props = compute_geometric_properties(doc)

    # SI interno (mm, mm², mm³, mm⁴)
    si = dataclasses.asdict(props)

    # Ingeniería (cm² para áreas, cm⁴ para inercias, cm³ para módulos, cm para radios)
    engineering = {
        "gross_area_cm2":  props.gross_area / 100.0,
        "net_area_cm2":    props.net_area / 100.0,
        "steel_area_cm2":  props.steel_area / 100.0,
        "rho_g_pct":       props.rho_g * 100.0,
        "centroid_y_cm":   props.centroid_y / 10.0,
        "centroid_z_cm":   props.centroid_z / 10.0,
        "depth_cm":        props.depth / 10.0,
        "width_cm":        props.width / 10.0,
        "Iy_cm4":          props.Iy / 1e4,
        "Iz_cm4":          props.Iz / 1e4,
        "Iyz_cm4":         props.Iyz / 1e4,
        "Sy_pos_cm3":      props.Sy_pos / 1e3,
        "Sy_neg_cm3":      props.Sy_neg / 1e3,
        "Sz_pos_cm3":      props.Sz_pos / 1e3,
        "Sz_neg_cm3":      props.Sz_neg / 1e3,
        "ry_cm":           props.ry / 10.0,
        "rz_cm":           props.rz / 10.0,
        "Zpy_cm3":         props.Zpy / 1e3,
        "Zpz_cm3":         props.Zpz / 1e3,
        "fs_y":            props.fs_y,
        "fs_z":            props.fs_z,
        "I1_cm4":          props.I1 / 1e4,
        "I2_cm4":          props.I2 / 1e4,
        "theta_p_deg":     props.theta_p_deg,
    }

    return {
        "section_id": section_id,
        "si":         si,
        "engineering": engineering,
    }


@router.post("/{section_id}/ductility")
def run_ductility_analysis(
    section_id: str,
    body: dict,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Deriva métricas de ductilidad (φy_ideal, μφ, μΔ, Lp, energía) del M-φ.

    body: {
      axial_load_kn:   float,
      member_length_mm: float (default 3000),
      db_long_mm:      float (default 25.4),
      Lp_method:       "priestley_2007" | "paulay_priestley" | "baker" | "atc_32",
      fu_over_fy:      float (default 1.35),
      theta_deg:       float (default 0),
    }
    """
    row = _get_owned(db, section_id, user)
    doc = _dict_to_doc(row.document)
    try:
        compiled = compile_doc(doc)
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))

    from engine.analysis.moment_curvature import compute_moment_curvature
    from engine.sections.section_properties import compute_geometric_properties

    props = compute_geometric_properties(doc)
    axial_N = float(body.get("axial_load_kn", 0.0)) * 1000.0
    L_mm    = float(body.get("member_length_mm", 3000.0))
    db_l    = float(body.get("db_long_mm", 25.4))
    method  = str(body.get("Lp_method", "priestley_2007"))
    fu_fy   = float(body.get("fu_over_fy", 1.35))
    theta   = float(body.get("theta_deg", 0.0))

    fy = doc.default_steel().fy if doc.default_steel() else 420.0

    mc = compute_moment_curvature(compiled, axial_load_n=axial_N,
                                   num_incr=200, theta_deg=theta)
    try:
        metrics = compute_ductility_metrics(
            mc, member_length_mm=L_mm,
            db_long_mm=db_l, fy_MPa=fy,
            section_depth_mm=props.depth,
            Lp_method=method,  # type: ignore
            fu_over_fy=fu_fy,
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    return {
        "section_id": section_id,
        "input": {
            "axial_load_kn":     axial_N / 1000.0,
            "member_length_mm":  L_mm,
            "db_long_mm":        db_l,
            "Lp_method":         method,
            "fu_over_fy":        fu_fy,
            "fy_MPa":            fy,
            "theta_deg":         theta,
        },
        "bilinear": {
            "phi_yield_ideal_1_per_m":  metrics.phi_yield_ideal * 1000.0,   # 1/mm → 1/m
            "moment_yield_ideal_kNm":   metrics.moment_yield_ideal / 1e6,
            "phi_ultimate_1_per_m":     metrics.phi_ultimate * 1000.0,
            "moment_ultimate_kNm":      metrics.moment_ultimate / 1e6,
        },
        "ductility": {
            "mu_phi":                    metrics.mu_phi,
            "mu_delta":                  metrics.mu_delta,
        },
        "plastic_hinge": {
            "Lp_mm":                     metrics.Lp_mm,
            "Lp_over_L":                 metrics.Lp_over_L,
            "method":                    metrics.Lp_method,
        },
        "energy": {
            "capacity_kNm_per_m":        metrics.energy_kNm_per_m,
        },
        "curve": [
            {"phi_1_per_m": p.phi * 1000.0, "moment_kNm": p.moment / 1e6}
            for p in mc.curve
        ],
        "notes": metrics.notes,
    }


@router.post("/design-column")
def design_column_endpoint(
    body: dict,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Diseño paramétrico inverso: geometría + demandas → armados óptimos.

    Endpoint standalone (NO requiere sectionId — la sección es virtual).

    body: {
      geometry: {
        kind: "column_rect" | "column_circ",
        height_mm | width_mm       (si rect),
        diameter_mm                 (si circ),
        cover_mm, fpc_MPa, fy_MPa
      },
      demands: [ {Pu_kN, Mux_kNm, Muy_kNm}, ... ],
      ductility: "DMI" | "DMO" | "DES",
      top_k:  int (default 5),
      rho_min: float (default 0.01),
      rho_max: float | null
    }
    """
    g = body.get("geometry", {})
    geom = ColumnGeometry(
        kind=g.get("kind", "column_rect"),
        height_mm=float(g.get("height_mm", 0)),
        width_mm=float(g.get("width_mm", 0)),
        diameter_mm=float(g.get("diameter_mm", 0)),
        cover_mm=float(g.get("cover_mm", 40)),
        fpc_MPa=float(g.get("fpc_MPa", 28)),
        fy_MPa=float(g.get("fy_MPa", 420)),
    )
    demands = [
        DesignDemand(
            Pu_N=float(d.get("Pu_kN", 0)) * 1000,
            Mux_Nmm=float(d.get("Mux_kNm", 0)) * 1e6,
            Muy_Nmm=float(d.get("Muy_kNm", 0)) * 1e6,
        )
        for d in body.get("demands", [])
    ]
    ductility = str(body.get("ductility", "DMO"))
    top_k     = int(body.get("top_k", 5))
    rho_min   = float(body.get("rho_min", 0.01))
    rho_max   = body.get("rho_max")

    try:
        r = design_column(
            geom=geom, demands=demands,
            ductility=ductility,  # type: ignore
            top_k=top_k, rho_min=rho_min,
            rho_max=float(rho_max) if rho_max is not None else None,
        )
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))

    return {
        "n_candidates_evaluated": r.n_candidates_evaluated,
        "n_valid":                r.n_valid,
        "all_infeasible":         r.all_infeasible,
        "candidates": [
            {
                "n_bars":      c.n_bars,
                "bar_size":    c.bar_size,
                "layout":      c.layout,
                "n_bars_y":    c.n_bars_y,
                "n_bars_z":    c.n_bars_z,
                "As_cm2":      c.As_mm2 / 100.0,
                "rho_g_pct":   c.rho_g * 100.0,
                "max_DCR":     c.max_DCR if math.isfinite(c.max_DCR) else 999.0,
                "worst_demand_idx": c.worst_demand_idx,
                "demand_DCRs": [d if math.isfinite(d) else 999.0 for d in c.demand_DCRs],
                "all_pass":    c.all_pass,
                "P0_kN":       c.p0_kN,
            }
            for c in r.top_candidates
        ],
        "notes": r.notes,
    }


@router.post("/{section_id}/cyclic")
def run_cyclic(
    section_id: str,
    body: dict,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Análisis cíclico M-φ con historial de curvatura prescrito.

    body: {
      axial_load_kn: float (default 0),
      protocol:      "atc_24" | "sinusoidal" | "user" (default "atc_24"),
      phi_yield_1_per_m: float (para atc_24, default 0.05, típico columna),
      phi_max_1_per_m:   float (para sinusoidal, default 0.05),
      ductilities:   list[float] (para atc_24, default [0.5,1,1.5,2,3,4]),
      cycles_per_step: int (default 2),
      n_cycles:      int (para sinusoidal, default 5),
      decay:         float (default 0),
      steps_per_cycle: int (default 20),
      phi_history_1_per_m: list[float] (para "user"),
      theta_deg:     float (default 0)
    }
    """
    row = _get_owned(db, section_id, user)
    doc = _dict_to_doc(row.document)
    try:
        compiled = compile_doc(doc)
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))

    axial_n   = float(body.get("axial_load_kn", 0.0)) * 1000.0
    theta     = float(body.get("theta_deg", 0.0))
    protocol  = str(body.get("protocol", "atc_24"))
    steps     = int(body.get("steps_per_cycle", 20))

    # Convertir φ de 1/m (UI) a 1/mm (engine)
    def _to_mm(v_1_per_m: float) -> float:
        return v_1_per_m / 1000.0

    if protocol == "atc_24":
        phi_y = _to_mm(float(body.get("phi_yield_1_per_m", 0.05)))
        duct = body.get("ductilities", [0.5, 1.0, 1.5, 2.0, 3.0, 4.0])
        cps  = int(body.get("cycles_per_step", 2))
        history = generate_atc24_history(phi_y, list(duct), cps, steps)
    elif protocol == "sinusoidal":
        phi_max = _to_mm(float(body.get("phi_max_1_per_m", 0.05)))
        nc     = int(body.get("n_cycles", 5))
        decay  = float(body.get("decay", 0.0))
        history = generate_sinusoidal_history(phi_max, nc, decay, steps)
    else:
        user_hist = body.get("phi_history_1_per_m", [])
        history = [_to_mm(float(v)) for v in user_hist]
        if len(history) < 2:
            raise HTTPException(422, "phi_history_1_per_m debe tener ≥ 2 puntos.")

    try:
        r = compute_cyclic_moment_curvature(
            compiled, history, axial_load_n=axial_n,
            theta_deg=theta, protocol_label=protocol,
        )
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))

    return {
        "section_id": section_id,
        "protocol":   r.protocol,
        "axial_load_kn": axial_n / 1000.0,
        "curve": [
            {"phi_1_per_m": p.phi * 1000.0, "moment_kNm": p.moment / 1e6}
            for p in r.curve
        ],
        "cycles": [
            {
                "peak_pos_phi_1_per_m": c.peak_pos_phi * 1000.0,
                "peak_neg_phi_1_per_m": c.peak_neg_phi * 1000.0,
                "peak_pos_M_kNm":       c.peak_pos_M / 1e6,
                "peak_neg_M_kNm":       c.peak_neg_M / 1e6,
                "Ed_kNm2":              c.energy_dissipated / 1e6,  # N·mm·(1/mm) → N → /1000 = kN → /1000 = ... revisar
                "Es_kNm2":              c.energy_elastic / 1e6,
                "xi_eq_pct":            c.xi_eq_pct,
                "K_sec_pos_kNm2":       c.K_sec_pos / 1e12,   # N·mm² → kN·m² = /1e12
                "K_sec_neg_kNm2":       c.K_sec_neg / 1e12,
            }
            for c in r.cycles
        ],
        "total_energy_dis_kN": r.total_energy_dis / 1e6,
        "n_points":            len(r.curve),
        "n_cycles":            len(r.cycles),
        "notes":               r.notes,
    }


@router.post("/{section_id}/serviceability")
def run_serviceability(
    section_id: str,
    body: dict,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Análisis de servicio: Mcr, Icr, Ie (Branson) y recomendación NSR-10 A.5.3.

    body: {
      Ma_kNm:       float (default 0, momento aplicado para Ie de Branson),
      element_kind: "beam" | "column" | "wall" | "slab_2d" | "diaphragm",
      lambda_c:     float (default 1.0),
      wall_cracked: bool (default false, solo aplica a wall)
    }
    """
    row = _get_owned(db, section_id, user)
    doc = _dict_to_doc(row.document)

    Ma_kNm       = float(body.get("Ma_kNm", 0.0))
    element_kind = str(body.get("element_kind", "beam"))
    lam          = float(body.get("lambda_c", 1.0))
    wall_cracked = bool(body.get("wall_cracked", False))

    try:
        r = compute_serviceability(
            doc, Ma_kNm=Ma_kNm, element_kind=element_kind,  # type: ignore
            lam=lam, wall_cracked=wall_cracked,
        )
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))

    return {
        "section_id": section_id,
        "input": {
            "Ma_kNm":       Ma_kNm,
            "element_kind": element_kind,
            "lambda_c":     lam,
            "wall_cracked": wall_cracked,
        },
        "materials": {
            "fr_MPa": r.fr_MPa,
            "Ec_MPa": r.Ec_MPa,
            "Es_MPa": r.Es_MPa,
            "n":      r.n,
        },
        "cracking": {
            "Mcr_kNm":     r.Mcr_kNm,
            "Mcr_neg_kNm": r.Mcr_neg_kNm,
            "yt_mm":       r.yt_mm,
            "Ig_cm4":      r.Ig_cm4,
        },
        "cracked_section": {
            "Icr_cm4":      r.Icr_cm4,
            "c_neutral_mm": r.c_neutral_mm,
        },
        "effective": {
            "Ie_cm4":              r.Ie_cm4,
            "phi_cr_1_per_km":     r.phi_cr_1_per_km,
            "phi_service_1_per_km": r.phi_service_1_per_km,
        },
        "nsr10_A53": {
            "element_kind":      r.element_kind,
            "Ie_over_Ig":         r.Ie_over_Ig_recommended,
            "Ie_recommended_cm4": r.Ie_recommended_cm4,
        },
        "notes": r.notes,
    }


@router.post("/{section_id}/shear-check")
def run_shear_check(
    section_id: str,
    body: dict,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Verifica cortante NSR-10 o ACI 318-19 con Vu/Nu/Mu de diseño.

    body: {
      code:       "NSR-10" | "ACI 318-19",
      element:    "beam" | "column" | "wall",
      ductility:  "DMI" | "DMO" | "DES",
      Vu_kN:      float,
      Nu_kN:      float (default 0, + compresión),
      Mu_kNm:     float (default 0),
      Av_mm2:     float | null (área total ramas por corte, null = sin estribos),
      s_mm:       float (default 150),
      fyt_MPa:    float (default 420),
      d_mm:       float | null (canto útil; si null se toma h - 60 mm),
      bw_mm:      float | null (ancho alma; si null se toma width geométrico),
      rho_w:      float (default 0.01, solo ACI 318-19),
      lambda_c:   float (default 1.0),
      db_long_mm: float (default 25.4)
    }
    """
    row = _get_owned(db, section_id, user)
    doc = _dict_to_doc(row.document)
    props = compute_geometric_properties(doc)

    code       = str(body.get("code", "NSR-10"))
    element    = str(body.get("element", "beam"))
    ductility  = str(body.get("ductility", "DMI"))

    fpc = doc.default_concrete().fpc if doc.default_concrete() else 28.0

    # Geometría
    bw    = float(body.get("bw_mm") or props.width)
    d     = float(body.get("d_mm")  or max(props.depth - 60.0, 100.0))
    Ag    = props.gross_area
    h     = props.depth
    dim_m = min(props.depth, props.width)
    geom  = ShearGeometry(bw_mm=bw, d_mm=d, Ag_mm2=Ag, h_mm=h)

    # Demanda
    demand = ShearDemand(
        Vu_N=float(body.get("Vu_kN", 0.0)) * 1000.0,
        Nu_N=float(body.get("Nu_kN", 0.0)) * 1000.0,
        Mu_Nmm=float(body.get("Mu_kNm", 0.0)) * 1e6,
    )

    # Transversal
    Av = body.get("Av_mm2")
    if Av is not None and float(Av) > 0:
        transverse = TransverseReinforcement(
            Av_mm2=float(Av),
            s_mm=float(body.get("s_mm", 150.0)),
            fyt_MPa=float(body.get("fyt_MPa", 420.0)),
        )
    else:
        transverse = None

    rho_w = float(body.get("rho_w", 0.01))
    lam   = float(body.get("lambda_c", 1.0))
    db_l  = float(body.get("db_long_mm", 25.4))

    try:
        r = compute_shear_check(
            code=code, element=element, ductility=ductility,
            fpc_MPa=fpc, geom=geom, demand=demand, transverse=transverse,
            rho_w=rho_w, lam=lam, db_long_mm=db_l, dim_min_mm=dim_m,
        )
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))

    return {
        "section_id": section_id,
        "code": r.code,
        "element": r.element,
        "ductility": r.ductility,
        "geometry_used": {
            "bw_mm": bw, "d_mm": d, "Ag_mm2": Ag,
            "fpc_MPa": fpc, "dim_min_mm": dim_m,
        },
        "components": {
            "Vc_kN":     r.Vc_N     / 1000.0,
            "Vs_kN":     r.Vs_N     / 1000.0,
            "Vn_kN":     r.Vn_N     / 1000.0,
            "phi_Vn_kN": r.phi_Vn_N / 1000.0,
            "Vu_kN":     r.Vu_N     / 1000.0,
            "DCR":       r.DCR if math.isfinite(r.DCR) else 999.0,
        },
        "detailing": {
            "s_max_mm":     r.s_max_mm,
            "Av_min_mm2":   r.Av_min_mm2,
        },
        "status":   r.status,
        "articles": r.articles,
        "notes":    r.notes,
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
