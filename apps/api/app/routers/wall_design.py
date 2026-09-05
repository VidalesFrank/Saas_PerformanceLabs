"""
Router diseño de muros RC — NSR-10 / ACI 318-25
Prefix: /api/v1/wall-design
"""
from __future__ import annotations
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.auth import get_current_user
from app.models import User
from app.engine.building.walls.wall_design_engine import compute_wall_design
from app.engine.building.walls.wall_design_schemas import (
    WallDemandCombo,
    WallReinforcement,
    BoundaryZoneReinf,
    WebZoneReinf,
    BAR_DB,
)

router = APIRouter(prefix="/api/v1/wall-design", tags=["wall-design"])


# ── Pydantic schemas ──────────────────────────────────────────────────────────

class DemandComboIn(BaseModel):
    label: str
    Pu_kN: float
    Vu_kN: float
    Mu_kNm: float
    is_seismic: bool = True


class BoundaryZoneIn(BaseModel):
    n_bars: int = 4
    db_mm: float = 15.9
    cover_mm: float = 40.0
    tie_db_mm: float = 9.5
    tie_spacing_mm: float = 100.0
    length_m: float = 0.5


class WebZoneIn(BaseModel):
    vert_db_mm: float = 12.7
    vert_spacing_mm: float = 250.0
    horiz_db_mm: float = 12.7
    horiz_spacing_mm: float = 250.0
    n_curtains: int = 2


class ManualReinfIn(BaseModel):
    be_left: BoundaryZoneIn
    web: WebZoneIn
    be_right: BoundaryZoneIn
    symmetric: bool = True


class WallDesignRequest(BaseModel):
    # Geometría
    lw_m: float = Field(..., gt=0, description="Longitud del muro (m)")
    tw_m: float = Field(..., gt=0, description="Espesor del muro (m)")
    hw_m: float = Field(..., gt=0, description="Altura del muro (m)")
    # Materiales
    fc_mpa: float = Field(28.0, gt=0)
    fy_mpa: float = Field(420.0, gt=0)
    fyt_mpa: float = Field(420.0, gt=0)
    # Ductilidad
    ductility: str = Field("DES", pattern="^(DES|DMO)$")
    # Demandas
    demands: List[DemandComboIn] = Field(..., min_length=1)
    # Modo
    mode: str = Field("auto", pattern="^(auto|manual)$")
    manual_reinf: Optional[ManualReinfIn] = None
    # Opcionales
    cover_mm: float = 40.0
    delta_u_hw: Optional[float] = None


# ── Helpers ───────────────────────────────────────────────────────────────────

def _to_bz_reinf(bz: BoundaryZoneIn) -> BoundaryZoneReinf:
    return BoundaryZoneReinf(
        n_bars=bz.n_bars,
        db_mm=bz.db_mm,
        cover_mm=bz.cover_mm,
        tie_db_mm=bz.tie_db_mm,
        tie_spacing_mm=bz.tie_spacing_mm,
        length_m=bz.length_m,
    )


def _to_web_reinf(w: WebZoneIn) -> WebZoneReinf:
    return WebZoneReinf(
        vert_db_mm=w.vert_db_mm,
        vert_spacing_mm=w.vert_spacing_mm,
        horiz_db_mm=w.horiz_db_mm,
        horiz_spacing_mm=w.horiz_spacing_mm,
        n_curtains=w.n_curtains,
    )


# ── Endpoint principal ────────────────────────────────────────────────────────

@router.post("/compute")
def compute_design(
    req: WallDesignRequest,
    current_user: User = Depends(get_current_user),
):
    """Diseño completo de un muro rectangular RC."""
    try:
        demands = [
            WallDemandCombo(
                label=d.label,
                Pu_kN=d.Pu_kN,
                Vu_kN=d.Vu_kN,
                Mu_kNm=d.Mu_kNm,
                is_seismic=d.is_seismic,
            )
            for d in req.demands
        ]

        manual_reinf: Optional[WallReinforcement] = None
        if req.mode == "manual" and req.manual_reinf:
            mr = req.manual_reinf
            manual_reinf = WallReinforcement(
                be_left=_to_bz_reinf(mr.be_left),
                web=_to_web_reinf(mr.web),
                be_right=_to_bz_reinf(mr.be_right),
                symmetric=mr.symmetric,
            )

        result = compute_wall_design(
            lw_m=req.lw_m,
            tw_m=req.tw_m,
            hw_m=req.hw_m,
            fc_mpa=req.fc_mpa,
            fy_mpa=req.fy_mpa,
            fyt_mpa=req.fyt_mpa,
            ductility=req.ductility,
            demands=demands,
            mode=req.mode,
            manual_reinf=manual_reinf,
            cover_mm=req.cover_mm,
            delta_u_hw=req.delta_u_hw,
        )
        return result

    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/bar-database")
def get_bar_database(current_user: User = Depends(get_current_user)):
    """Devuelve la base de datos de barras estándar."""
    return [
        {"db_mm": db, "area_mm2": area}
        for db, area in sorted(BAR_DB.items())
    ]
