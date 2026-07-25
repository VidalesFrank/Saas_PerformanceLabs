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
