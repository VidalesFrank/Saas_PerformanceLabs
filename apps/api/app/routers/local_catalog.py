"""
Router — Catálogo de registros sísmicos locales (campañas colombianas).

Shape de respuesta compatible con /fema-library para que el frontend consuma
los pares con la misma UI (tabla, selección, filtros).

Endpoints:
    GET /local-catalog/campaigns                     — campañas disponibles
    GET /local-catalog/catalog?campaign=...          — pares + espectros
    GET /local-catalog/pairs?campaign=...            — alias (compat)
    GET /local-catalog/record/{name}/preview         — timeseries decimado
    POST /local-catalog/scale-factor                 — factor FEMA P-695 §6.2
"""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.db import get_db
from app.models import User
from app.engine.building.colombia_catalog import (
    get_catalog, list_campaigns, read_record_timeseries, compute_scale_for_pair,
)

router = APIRouter(prefix="/api/v1/local-catalog", tags=["local-catalog"])

CurrentUser = Annotated[User, Depends(get_current_user)]
DB = Annotated[Session, Depends(get_db)]


@router.get("/campaigns")
def get_campaigns(user: CurrentUser, db: DB) -> dict:
    """Devuelve las campañas sísmicas con registros disponibles en la DB."""
    return {"campaigns": list_campaigns(db)}


@router.get("/catalog")
def get_catalog_endpoint(
    user: CurrentUser, db: DB,
    campaign: str = Query("colombia_2026_08_10", description="Clave de la campaña"),
) -> dict:
    """Catálogo completo (99 pares horizontales + espectros Sa(T) 5% damping)."""
    cat = get_catalog(db, campaign=campaign)
    if not cat["available"]:
        raise HTTPException(
            status_code=404,
            detail=f"No hay pares horizontales para campaña {campaign!r}. "
                   f"¿Corriste el seed script?",
        )
    return cat


@router.get("/pairs")
def list_pairs_endpoint(
    user: CurrentUser, db: DB,
    campaign: str = Query("colombia_2026_08_10"),
) -> dict:
    """Alias de /catalog — compatible con el shape /fema-library/pairs."""
    return get_catalog(db, campaign=campaign)


@router.get("/record/{record_name}/preview")
def get_record_preview(
    record_name: str, user: CurrentUser, db: DB,
    max_points: int = Query(600, ge=50, le=5000),
    campaign: str = Query("colombia_2026_08_10"),
) -> dict:
    """Timeseries decimado del registro (p. ej. ``CPER6_NS``) para preview en UI."""
    try:
        return read_record_timeseries(db, record_name, campaign=campaign, max_points=max_points)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


class LocalScaleRequest(BaseModel):
    pair_id:     int    = Field(..., ge=1)
    T1_s:        float  = Field(..., gt=0, le=10.0)
    sa_target_g: float  = Field(..., gt=0, le=5.0)
    xi:          float  = Field(0.05, ge=0, le=0.2)
    campaign:    str    = Field("colombia_2026_08_10")


@router.post("/scale-factor")
def compute_scale(req: LocalScaleRequest, user: CurrentUser, db: DB) -> dict:
    """Factor de escala FEMA P-695 §6.2 (mismo factor a H1 y H2)."""
    try:
        res = compute_scale_for_pair(
            db, pair_id=req.pair_id, T1_s=req.T1_s,
            sa_target_g=req.sa_target_g, campaign=req.campaign, xi=req.xi,
        )
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "pair_id":              req.pair_id,
        "campaign":             req.campaign,
        "T1_s":                 res.T1_s,
        "xi":                   req.xi,
        "sa_target_g":          res.sa_target,
        "sa_h1_unscaled_g":     round(res.sa_h1_unscaled, 5),
        "sa_h2_unscaled_g":     round(res.sa_h2_unscaled, 5),
        "sa_geomean_unscaled_g": round(res.sa_geomean_unscaled, 5),
        "sa_geomean_scaled_g":  round(res.sa_geomean_scaled, 5),
        "scale":                round(res.scale, 5),
    }
