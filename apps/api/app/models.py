import enum
import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, Enum, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Plan(str, enum.Enum):
    free = "free"
    pro = "pro"
    premium = "premium"


class ShapeType(str, enum.Enum):
    rectangular = "rectangular"
    square = "square"
    circular = "circular"
    special = "special"


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    plan: Mapped[Plan] = mapped_column(Enum(Plan), default=Plan.free, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    projects: Mapped[list["Project"]] = relationship(back_populates="owner", cascade="all, delete-orphan")


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    owner_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    owner: Mapped["User"] = relationship(back_populates="projects")
    sections: Mapped[list["Section"]] = relationship(back_populates="project", cascade="all, delete-orphan")


class Section(Base):
    __tablename__ = "sections"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    owner_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False)
    project_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("projects.id"), nullable=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    shape_type: Mapped[ShapeType] = mapped_column(Enum(ShapeType), nullable=False)
    geometry: Mapped[dict] = mapped_column(JSON, nullable=False)
    materials: Mapped[dict] = mapped_column(JSON, nullable=False)
    reinforcement: Mapped[dict] = mapped_column(JSON, nullable=False)
    cover: Mapped[float] = mapped_column(Float, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    project: Mapped["Project | None"] = relationship(back_populates="sections")
    results: Mapped[list["InteractionResult"]] = relationship(back_populates="section", cascade="all, delete-orphan")


class InteractionResult(Base):
    __tablename__ = "interaction_results"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    section_id: Mapped[str] = mapped_column(String(36), ForeignKey("sections.id"), nullable=False)
    points: Mapped[list] = mapped_column(JSON, nullable=False)
    result_metadata: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    section: Mapped["Section"] = relationship(back_populates="results")


# ─────────────────────────────────────────────────────────────────────────────
# Módulo 2 v2 — Section Engineering (nuevo modelo de datos)
# ─────────────────────────────────────────────────────────────────────────────

class SectionV2(Base):
    """Sección de concreto reforzado en formato SectionDocument (Módulo 2 v2).

    El campo `document` almacena el JSON completo del SectionDocument del engine,
    incluyendo regiones, barras y materiales. Es el objeto principal del editor
    gráfico de secciones.
    """
    __tablename__ = "sections_v2"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    owner_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    document: Mapped[dict] = mapped_column(JSON, nullable=False)
    schema_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )

    owner: Mapped["User"] = relationship("User", foreign_keys=[owner_id])


# ─────────────────────────────────────────────────────────────────────────────
# Módulo 3 — Análisis No Lineal 3D de Edificios
# ─────────────────────────────────────────────────────────────────────────────

class BuildingAnalysisType(str, enum.Enum):
    archetype = "archetype"   # Generación del modelo OpenSees desde XLSX/E2K
    modal     = "modal"       # Análisis modal (periodos y masas participativas)
    pushover  = "pushover"    # Análisis estático no lineal bidireccional
    dynamic   = "dynamic"     # Análisis dinámico tiempo-historia (FEMA P-695)


class BuildingJobStatus(str, enum.Enum):
    pending   = "pending"     # En cola, esperando worker
    running   = "running"     # Ejecutándose en el worker Celery
    success   = "success"     # Completado exitosamente
    failed    = "failed"      # Falló — ver error_message
    cancelled = "cancelled"   # Cancelado por el usuario


class BuildingProject(Base):
    """Proyecto de análisis no lineal 3D de un edificio."""
    __tablename__ = "building_projects"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    owner_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False)

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Parámetros del proyecto (ciudad, suelo, uso, etc.) guardados como JSON
    parameters_json: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Rutas a archivos subidos (relativas a UPLOAD_DIR/{project_id}/)
    input_file_path: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    e2k_file_path: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    rebar_file_path: Mapped[str | None] = mapped_column(String(1000), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )

    owner: Mapped["User"] = relationship("User", foreign_keys=[owner_id])
    jobs: Mapped[list["BuildingJob"]] = relationship(
        "BuildingJob", back_populates="project", cascade="all, delete-orphan"
    )


class BuildingJob(Base):
    """Job de análisis asincrónico ejecutado por Celery."""
    __tablename__ = "building_jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)

    # ID de tarea Celery (para revocar o hacer polling interno)
    celery_task_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)

    analysis_type: Mapped[BuildingAnalysisType] = mapped_column(
        Enum(BuildingAnalysisType), nullable=False
    )
    status: Mapped[BuildingJobStatus] = mapped_column(
        Enum(BuildingJobStatus), default=BuildingJobStatus.pending, nullable=False
    )

    # Ruta al archivo de resultado principal (JSON, PKL, etc.)
    result_path: Mapped[str | None] = mapped_column(String(1000), nullable=True)

    # Mensaje de error truncado a 4000 caracteres
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Metadatos extras del resultado (resumen ligero: T1, Vmax, etc.)
    result_summary: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    project_id: Mapped[str] = mapped_column(String(36), ForeignKey("building_projects.id"), nullable=False)
    owner_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    project: Mapped["BuildingProject"] = relationship("BuildingProject", back_populates="jobs")
    owner: Mapped["User"] = relationship("User", foreign_keys=[owner_id])
