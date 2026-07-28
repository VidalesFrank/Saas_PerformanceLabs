from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field

from app.models import Plan, ShapeType

# --- Auth ---


class UserCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8)
    full_name: str


class UserOut(BaseModel):
    id: str
    email: str
    full_name: str
    plan: Plan
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class Token(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


# --- Sections / diagrama de interaccion ---


class SectionCreate(BaseModel):
    name: str
    project_id: str | None = None
    shape_type: ShapeType

    # Rectangular / cuadrada
    width: float | None = None
    height: float | None = None

    # Circular
    diameter: float | None = None

    # Especial
    vertices: list[tuple[float, float]] | None = None
    core_vertices: list[tuple[float, float]] | None = None

    cover: float

    # Materiales
    fpc: float
    fy: float = 420.0
    es: float = 200_000.0

    # Confinamiento (estribos) - rectangular
    hoop_bar_diameter: float | None = None
    hoop_spacing: float | None = None
    hoop_legs_x: int | None = None
    hoop_legs_y: int | None = None
    hoop_leg_area: float | None = None

    # Confinamiento - circular
    is_spiral: bool = True

    # Refuerzo longitudinal - rectangular
    n_bars_y: int | None = None
    n_bars_z: int | None = None

    # Refuerzo longitudinal - circular
    n_bars: int | None = None

    # Refuerzo longitudinal - especial (lista explicita)
    bars: list[tuple[float, float]] | None = None

    bar_id: str = "#8"
    cover_to_bar_centroid: float | None = None

    # Refuerzo rectangular avanzado por cara (Section Designer)
    corner_bar_id: str | None = None
    n_top: int | None = None
    bar_id_top: str | None = None
    n_bottom: int | None = None
    bar_id_bottom: str | None = None
    n_left: int | None = None
    bar_id_left: str | None = None
    n_right: int | None = None
    bar_id_right: str | None = None


class SectionOut(BaseModel):
    id: str
    name: str
    project_id: str | None
    shape_type: ShapeType
    geometry: dict
    materials: dict
    reinforcement: dict
    cover: float
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class InteractionPointOut(BaseModel):
    p: float = Field(alias="P")
    m: float = Field(alias="M")

    model_config = ConfigDict(populate_by_name=True)


class InteractionResultOut(BaseModel):
    id: str
    section_id: str
    points: list[InteractionPointOut]
    result_metadata: dict
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


# ── Interaccion Biaxial P-M-M ────────────────────────────────────────────────

class PMMDemandIn(BaseModel):
    p_kn: float
    mx_knm: float
    my_knm: float


class PMMSurfaceRequest(BaseModel):
    num_angles: int = Field(8, ge=4, le=24)
    num_points: int = Field(10, ge=6, le=20)
    demands: list[PMMDemandIn] = []


class PMMPointOut(BaseModel):
    p: float    # kN
    mx: float   # kN·m
    my: float   # kN·m


class PMMArcOut(BaseModel):
    theta_deg: float
    points: list[PMMPointOut]


class PMMDemandOut(BaseModel):
    p_kn: float
    mx_knm: float
    my_knm: float
    m_demand_knm: float
    m_capacity_knm: float
    dcr: float
    inside: bool


class PMMSurfaceResultOut(BaseModel):
    section_id: str
    curves: list[PMMArcOut]
    p_max_kn: float
    p_min_kn: float
    m_max_knm: float
    demands_out: list[PMMDemandOut]


# ── Momento-Curvatura ─────────────────────────────────────────────────────────

class MomentCurvatureRequest(BaseModel):
    axial_load_kn: float = Field(0.0, description="Carga axial en kN, compresion positiva")
    num_incr: int = Field(120, ge=20, le=500)
    curvature_multiple: float = Field(8.0, ge=2.0, le=20.0)


class MCPointOut(BaseModel):
    phi: float    # 1/m (convertido en la API)
    moment: float # kN·m (convertido en la API)


class MomentCurvatureResultOut(BaseModel):
    section_id: str
    axial_load_kn: float
    curve: list[MCPointOut]
    phi_yield: float        # 1/m  — curvatura bilineal idealizada de fluencia
    moment_yield: float     # kN·m — momento real en phi_yield (interpolado)
    phi_max: float          # 1/m  — curvatura en momento pico
    moment_max: float       # kN·m — momento pico
    phi_ultimate: float     # 1/m  — curvatura de falla (~80% Mmax post-pico)
    moment_ultimate: float  # kN·m — momento en curvatura de falla
    ductility: float        # μφ = φu_falla / φy
    ei_secant_kNm2: float   # kN·m² — rigidez secante efectiva Mmax/φy
    failure_reached: bool   # True si el momento cayó al 80% Mmax; False = límite del barrido
    material_summary: dict  # parametros Mander: f'cc, epsc0, ecu, ke, fl, rho_s
    section_summary: dict   # propiedades geometricas y de armado: rho_t, P/(f'cAg), etc.
