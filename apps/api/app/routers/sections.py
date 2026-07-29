import bisect
import math

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from engine.analysis.interaction import compute_interaction_diagram
from engine.analysis.moment_curvature import compute_moment_curvature
from engine.analysis.pmm_surface import compute_pmm_surface

from app.auth import get_current_user
from app.db import get_db
from app.engine_adapter import build_compiled_section, build_section_summary, split_payload
from app.models import InteractionResult, Section, User
from app.schemas import (
    InteractionResultOut, MomentCurvatureRequest, MomentCurvatureResultOut,
    MCPointOut, SectionCreate, SectionOut,
    PMMSurfaceRequest, PMMSurfaceResultOut, PMMArcOut, PMMPointOut, PMMDemandOut,
)
from app.unit_converter import UnitConverter as UC

router = APIRouter(prefix="/api/v1/sections", tags=["sections"])


@router.post("", response_model=SectionOut, status_code=201)
def create_section(
    payload: SectionCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> Section:
    geometry, materials, reinforcement = split_payload(payload)
    try:
        build_compiled_section(payload.shape_type, geometry, materials, reinforcement, payload.cover)
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=f"Datos de seccion incompletos o invalidos: {exc}") from exc

    section = Section(
        owner_id=user.id, project_id=payload.project_id, name=payload.name, shape_type=payload.shape_type,
        geometry=geometry, materials=materials, reinforcement=reinforcement, cover=payload.cover,
    )
    db.add(section)
    db.commit()
    db.refresh(section)
    return section


@router.get("", response_model=list[SectionOut])
def list_sections(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[Section]:
    return db.query(Section).filter(Section.owner_id == user.id).order_by(Section.created_at.desc()).all()


@router.get("/{section_id}", response_model=SectionOut)
def get_section(section_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Section:
    return _get_owned_section(db, section_id, user)


@router.post("/{section_id}/interaction-diagram", response_model=InteractionResultOut)
def run_interaction_diagram(
    section_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> InteractionResult:
    section = _get_owned_section(db, section_id, user)
    compiled = build_compiled_section(
        section.shape_type, section.geometry, section.materials, section.reinforcement, section.cover
    )
    diagram = compute_interaction_diagram(compiled)

    result = InteractionResult(
        section_id=section.id,
        points=[{"P": pt.P, "M": pt.M} for pt in diagram],
        result_metadata={
            "num_points": len(diagram),
            "p_max_compresion": diagram[0].P,
            "p_max_tension": diagram[-1].P,
            "m_max": max(pt.M for pt in diagram),
        },
    )
    db.add(result)
    db.commit()
    db.refresh(result)
    return result


@router.post("/{section_id}/moment-curvature", response_model=MomentCurvatureResultOut)
def run_moment_curvature(
    section_id: str,
    body: MomentCurvatureRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MomentCurvatureResultOut:
    section = _get_owned_section(db, section_id, user)
    compiled = build_compiled_section(
        section.shape_type, section.geometry, section.materials, section.reinforcement, section.cover
    )
    axial_n = UC.kn_to_n(body.axial_load_kn)

    result = compute_moment_curvature(
        compiled,
        axial_load_n=axial_n,
        num_incr=body.num_incr,
        curvature_multiple=body.curvature_multiple,
    )

    material_summary, section_summary = build_section_summary(
        section.shape_type, section.geometry, section.materials,
        section.reinforcement, section.cover, axial_load_n=axial_n,
    )

    return MomentCurvatureResultOut(
        section_id=section_id,
        axial_load_kn=body.axial_load_kn,
        curve=[MCPointOut(phi=UC.phi_mm_to_m(pt.phi), moment=UC.nmm_to_knm(pt.moment))
               for pt in result.curve],
        phi_yield=UC.phi_mm_to_m(result.phi_yield),
        moment_yield=UC.nmm_to_knm(result.moment_yield),
        phi_max=UC.phi_mm_to_m(result.phi_max),
        moment_max=UC.nmm_to_knm(result.moment_max),
        phi_ultimate=UC.phi_mm_to_m(result.phi_ultimate),
        moment_ultimate=UC.nmm_to_knm(result.moment_ultimate),
        ductility=result.ductility,
        ei_secant_kNm2=UC.nmm2_to_knm2(result.ei_secant),
        failure_reached=result.failure_reached,
        material_summary=material_summary,
        section_summary=section_summary,
    )


@router.post("/{section_id}/pmm-surface", response_model=PMMSurfaceResultOut)
def run_pmm_surface(
    section_id: str,
    body: PMMSurfaceRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> PMMSurfaceResultOut:
    section = _get_owned_section(db, section_id, user)
    compiled = build_compiled_section(
        section.shape_type, section.geometry, section.materials, section.reinforcement, section.cover
    )

    raw = compute_pmm_surface(compiled, num_angles=body.num_angles, num_points=body.num_points)

    from collections import defaultdict
    bucket: dict[float, list] = defaultdict(list)
    for pt in raw:
        key = round(math.degrees(pt.theta), 4)
        bucket[key].append(pt)

    curves: list[PMMArcOut] = []
    for theta_deg in sorted(bucket.keys()):
        pts_sorted = sorted(bucket[theta_deg], key=lambda p: p.P, reverse=True)
        curves.append(PMMArcOut(
            theta_deg=theta_deg,
            points=[
                PMMPointOut(p=UC.n_to_kn(pt.P), mx=UC.nmm_to_knm(pt.Mx), my=UC.nmm_to_knm(pt.My))
                for pt in pts_sorted
            ],
        ))

    p_max = max(pt.P for pt in raw)
    p_min = min(pt.P for pt in raw)
    m_max = max(math.sqrt(pt.Mx**2 + pt.My**2) for pt in raw)

    demands_out = [_check_demand(curves, d.p_kn, d.mx_knm, d.my_knm) for d in body.demands]

    return PMMSurfaceResultOut(
        section_id=section_id,
        curves=curves,
        p_max_kn=UC.n_to_kn(p_max),
        p_min_kn=UC.n_to_kn(p_min),
        m_max_knm=UC.nmm_to_knm(m_max),
        demands_out=demands_out,
    )


def _interp_m_at_p(points: list[PMMPointOut], p_target: float) -> float:
    for i in range(len(points) - 1):
        p_hi, p_lo = points[i].p, points[i + 1].p
        m_hi = math.sqrt(points[i].mx**2 + points[i].my**2)
        m_lo = math.sqrt(points[i + 1].mx**2 + points[i + 1].my**2)
        if p_lo <= p_target <= p_hi:
            t = (p_target - p_lo) / (p_hi - p_lo) if abs(p_hi - p_lo) > 1e-9 else 0.0
            return m_lo + t * (m_hi - m_lo)
    return 0.0


def _check_demand(
    curves: list[PMMArcOut],
    p_kn: float,
    mx_knm: float,
    my_knm: float,
) -> PMMDemandOut:
    m_demand = math.sqrt(mx_knm**2 + my_knm**2)

    if m_demand < 1e-9:
        inside = any(c.points[-1].p <= p_kn <= c.points[0].p for c in curves)
        return PMMDemandOut(
            p_kn=p_kn, mx_knm=mx_knm, my_knm=my_knm,
            m_demand_knm=0.0, m_capacity_knm=0.0, dcr=0.0, inside=inside,
        )

    theta_u = math.atan2(my_knm, mx_knm)
    if theta_u < 0:
        theta_u += 2 * math.pi

    angles = [c.theta_deg * math.pi / 180 for c in curves]
    n = len(angles)

    idx = bisect.bisect_right(angles, theta_u)
    lo_idx = (idx - 1) % n
    hi_idx = idx % n

    a_lo = angles[lo_idx]
    a_hi = angles[hi_idx]
    if hi_idx == 0:
        a_hi += 2 * math.pi

    denom = a_hi - a_lo
    t_ang = max(0.0, min(1.0, (theta_u - a_lo) / denom)) if abs(denom) > 1e-9 else 0.0

    m_lo = _interp_m_at_p(curves[lo_idx].points, p_kn)
    m_hi = _interp_m_at_p(curves[hi_idx].points, p_kn)
    m_cap = m_lo + t_ang * (m_hi - m_lo)

    if m_cap < 1e-6:
        return PMMDemandOut(
            p_kn=p_kn, mx_knm=mx_knm, my_knm=my_knm,
            m_demand_knm=round(m_demand, 3), m_capacity_knm=0.0,
            dcr=float("inf"), inside=False,
        )

    dcr = m_demand / m_cap
    return PMMDemandOut(
        p_kn=p_kn, mx_knm=mx_knm, my_knm=my_knm,
        m_demand_knm=round(m_demand, 3),
        m_capacity_knm=round(m_cap, 3),
        dcr=round(dcr, 4),
        inside=dcr <= 1.0,
    )


def _get_owned_section(db: Session, section_id: str, user: User) -> Section:
    section = db.get(Section, section_id)
    if section is None or section.owner_id != user.id:
        raise HTTPException(status_code=404, detail="Seccion no encontrada")
    return section
