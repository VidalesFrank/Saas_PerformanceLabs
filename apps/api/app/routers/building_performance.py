"""
Router — Evaluación de Desempeño Sísmico (Módulo 4).

Método del Espectro de Capacidad (ATC-40 / NSR-10 Título B).
Endpoint síncrono — sin Celery, la evaluación tarda < 1 s.

Prefix: /api/v1/building/performance
Auth:   JWT requerido.
"""
from __future__ import annotations

import json
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.db import get_db
from app.models import BuildingProject, User

router = APIRouter(prefix="/api/v1/building/performance", tags=["building-performance"])

CurrentUser = Annotated[User, Depends(get_current_user)]
DB          = Annotated[Session, Depends(get_db)]


# ── Schemas ───────────────────────────────────────────────────────────────────

class PerformanceRequest(BaseModel):
    project_id:    str
    direction:     str         = "X"   # "X" | "Y"
    dtecho_pct:    list[float]         # derivas de techo en %
    vbasal_norm:   list[float]         # V/W (fracción de g)
    total_height_m: float              # altura total del edificio (m)
    T1_s:          float               # período fundamental (s)
    Aa:            float | None = None  # override: si no, se busca por ciudad
    Av:            float | None = None  # override


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_project(db: Session, project_id: str, user: User) -> BuildingProject:
    project = db.get(BuildingProject, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Proyecto no encontrado")
    if project.owner_id != user.id:
        raise HTTPException(status_code=403, detail="Sin acceso a este proyecto")
    return project


def _lookup_Aa_Av(city: str) -> tuple[float, float]:
    """Busca Aa y Av para la ciudad en la base de datos NSR-10."""
    from engine.seismic.nsr10_data import MUNICIPIOS, buscar_municipios

    # Búsqueda directa por nombre normalizado
    city_lower = city.strip().lower()
    for data in MUNICIPIOS.values():
        if data["nombre"].lower() == city_lower:
            return data["Aa"], data["Av"]

    # Búsqueda parcial
    results = buscar_municipios(city_lower, limit=1)
    if results:
        return results[0]["Aa"], results[0]["Av"]

    # Fallback: Bogotá (Aa=0.15, Av=0.20) — zona de amenaza moderada
    return 0.15, 0.20


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.post("/evaluate")
def evaluate_performance(payload: PerformanceRequest, user: CurrentUser, db: DB):
    """
    Evalúa el desempeño sísmico por el Método del Espectro de Capacidad.

    Devuelve: curvas ADRS (capacidad + demanda elástica + demanda reducida),
    punto de desempeño, nivel de desempeño (IO/LS/CP/C) y bilineal idealizada.
    """
    project = _get_project(db, payload.project_id, user)

    # Parámetros NSR-10 del proyecto
    params: dict = {}
    if project.parameters_json:
        try:
            params = json.loads(project.parameters_json)
        except Exception:
            pass

    soil_type = params.get("soil_type", "D")
    city      = params.get("city", "Bogotá")

    Aa = payload.Aa
    Av = payload.Av
    if Aa is None or Av is None:
        Aa, Av = _lookup_Aa_Av(city)

    # Validar entrada mínima
    if len(payload.dtecho_pct) < 2 or len(payload.vbasal_norm) < 2:
        raise HTTPException(
            status_code=400,
            detail="Se requieren al menos 2 puntos en la curva pushover.",
        )
    if payload.total_height_m <= 0:
        raise HTTPException(status_code=400, detail="total_height_m debe ser > 0")
    if payload.T1_s <= 0:
        raise HTTPException(status_code=400, detail="T1_s debe ser > 0")

    try:
        from engine.building.performance.capacity_spectrum import evaluate
        from dataclasses import asdict

        result = evaluate(
            dtecho_pct=payload.dtecho_pct,
            vbasal_norm=payload.vbasal_norm,
            total_height_m=payload.total_height_m,
            T1_s=payload.T1_s,
            Aa=Aa,
            Av=Av,
            soil_type=soil_type,
        )
        return asdict(result)

    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error en evaluación de desempeño: {e}")
