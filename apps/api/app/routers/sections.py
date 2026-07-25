from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from engine.analysis.interaction import compute_interaction_diagram

from app.auth import get_current_user
from app.db import get_db
from app.engine_adapter import build_engine_inputs, split_payload
from app.models import InteractionResult, Section, User
from app.schemas import InteractionResultOut, SectionCreate, SectionOut

router = APIRouter(prefix="/api/v1/sections", tags=["sections"])


@router.post("", response_model=SectionOut, status_code=201)
def create_section(
    payload: SectionCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> Section:
    geometry, materials, reinforcement = split_payload(payload)
    try:
        build_engine_inputs(payload.shape_type, geometry, materials, reinforcement, payload.cover)
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
    shape, bars, core_params, cover_params, steel_params, depth = build_engine_inputs(
        section.shape_type, section.geometry, section.materials, section.reinforcement, section.cover
    )
    diagram = compute_interaction_diagram(shape, bars, core_params, cover_params, steel_params, depth)

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


def _get_owned_section(db: Session, section_id: str, user: User) -> Section:
    section = db.get(Section, section_id)
    if section is None or section.owner_id != user.id:
        raise HTTPException(status_code=404, detail="Seccion no encontrada")
    return section
