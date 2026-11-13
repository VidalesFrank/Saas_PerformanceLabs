"""
Router — Biblioteca de registros FEMA P-695 Far-Field.

Endpoints READ-ONLY (la biblioteca es del sistema, no se edita por usuario):

  GET  /fema-library/pairs                 catálogo completo + espectros precomputados
  GET  /fema-library/record/{gm_name}/preview   timeseries decimado para UI
  POST /fema-library/scale-factor          calcula scale dado pair_id + T1 + Sa_target

El flujo típico desde la UI:
  1. GET /fema-library/pairs → muestra la tabla.
  2. Usuario selecciona un par (dos componentes H1+H2).
  3. GET /fema-library/record/{GMxx}/preview para cada componente → preview.
  4. POST /fema-library/scale-factor con el T1 del edificio y Sa objetivo → factor.
  5. POST /{project}/nlth/select-library-pair (en structural_analysis.py)
     que copia los archivos al workspace del proyecto.
"""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.engine.building.fema_catalog import (
    FEMA_PAIRS, get_catalog, compute_scale_for_pair, read_record_timeseries,
    library_available,
)
from app.auth import get_current_user
from app.models import User

router = APIRouter(prefix="/api/v1/fema-library", tags=["fema-library"])

CurrentUser = Annotated[User, Depends(get_current_user)]


@router.get("/pairs")
def list_pairs(user: CurrentUser) -> dict:
    """
    Catálogo FEMA P-695 Far-Field. 22 pares con espectros de respuesta
    5 % ξ precomputados (Newmark β=1/4) a 18 periodos, más la media
    geométrica por par usada para escalado FEMA P-695.
    """
    return get_catalog()


@router.get("/record/{gm_name}/preview")
def get_record_preview(gm_name: str, user: CurrentUser, max_points: int = 600) -> dict:
    """
    Timeseries decimado del registro para preview en UI. Devuelve hasta
    `max_points` muestras (por defecto 600) + dt original + PGA + duración.
    """
    gm = gm_name.upper().strip()
    # Validar que el nombre existe en el catálogo
    valid = {g for p in FEMA_PAIRS for g in p["files"]}
    if gm not in valid:
        raise HTTPException(status_code=404, detail=f"Registro {gm_name!r} no existe en FEMA P-695.")
    if not library_available():
        raise HTTPException(status_code=503, detail="Biblioteca FEMA no disponible en el servidor.")
    try:
        return read_record_timeseries(gm, max_points=max_points)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


class ScaleRequest(BaseModel):
    pair_id:     int    = Field(..., ge=1, le=22, description="Número del par FEMA (1-22).")
    T1_s:        float  = Field(..., gt=0, le=10.0, description="Período fundamental del edificio (s).")
    sa_target_g: float  = Field(..., gt=0, le=5.0,  description="Sa objetivo en T1 (g).")
    xi:          float  = Field(0.05, ge=0, le=0.2, description="Amortiguamiento (fracción).")


@router.post("/scale-factor")
def compute_scale(req: ScaleRequest, user: CurrentUser) -> dict:
    """
    Calcula el factor de escala para que `Sa_geomean(T1) × scale = sa_target_g`.
    Convención FEMA P-695 §6.2: media geométrica de las dos componentes
    horizontales del par.
    """
    if not library_available():
        raise HTTPException(status_code=503, detail="Biblioteca FEMA no disponible en el servidor.")
    try:
        res = compute_scale_for_pair(
            pair_id=req.pair_id, T1_s=req.T1_s,
            sa_target_g=req.sa_target_g, xi=req.xi,
        )
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "pair_id":              req.pair_id,
        "T1_s":                 res.T1_s,
        "xi":                   req.xi,
        "sa_target_g":          res.sa_target,
        "sa_h1_unscaled_g":     round(res.sa_h1_unscaled, 5),
        "sa_h2_unscaled_g":     round(res.sa_h2_unscaled, 5),
        "sa_geomean_unscaled_g": round(res.sa_geomean_unscaled, 5),
        "sa_geomean_scaled_g":  round(res.sa_geomean_scaled, 5),
        "scale":                round(res.scale, 5),
    }
