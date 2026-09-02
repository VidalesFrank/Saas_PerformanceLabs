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


# ─────────────────────────────────────────────────────────────────────────────
# Módulo 1 — Constructor de Modelos Estructurales (análisis sísmico lineal)
# ─────────────────────────────────────────────────────────────────────────────

class StructuralAnalysisType(str, enum.Enum):
    import_validate = "import_validate"  # Parseo + validación + modelo canónico JSON
    modal           = "modal"            # Análisis modal (eigenvalue)
    spectral        = "spectral"         # RSA modal espectral + ajuste FHE NSR-10
    design_columns  = "design_columns"   # Verificación PM de columnas (NSR-10 B.3.4)
    design_beams    = "design_beams"     # Diseño flexión + cortante de vigas (NSR-10)


class StructuralJobStatus(str, enum.Enum):
    pending   = "pending"
    running   = "running"
    success   = "success"
    failed    = "failed"
    cancelled = "cancelled"


class StructuralProject(Base):
    """Proyecto de análisis sísmico lineal — Módulo 1 Constructor de Modelos.

    Almacena el modelo importado de ETABS (XLSX o .e2k), los parámetros sísmicos
    NSR-10 del proyecto y la ruta al modelo canónico JSON generado tras la validación.
    Es el punto de entrada de toda la cadena de análisis: sísmico → diseño → no lineal.
    """
    __tablename__ = "structural_projects"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    owner_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False)

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Parámetros sísmicos NSR-10 almacenados como JSON
    parameters_json: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Archivos de entrada subidos por el usuario
    input_file_path: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    e2k_file_path:   Mapped[str | None] = mapped_column(String(1000), nullable=True)

    # Ruta al modelo canónico generado (structural_model.json) — producido por import_validate
    canonical_model_path: Mapped[str | None] = mapped_column(String(1000), nullable=True)

    # Estado resumido de la última validación: not_run / has_errors / has_warnings / ok
    validation_status: Mapped[str] = mapped_column(String(20), default="not_run", nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )

    owner: Mapped["User"] = relationship("User", foreign_keys=[owner_id])
    jobs: Mapped[list["StructuralJob"]] = relationship(
        "StructuralJob", back_populates="project", cascade="all, delete-orphan"
    )


class StructuralJob(Base):
    """Job de análisis asincrónico del Módulo 1 (Celery)."""
    __tablename__ = "structural_jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    celery_task_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)

    analysis_type: Mapped[StructuralAnalysisType] = mapped_column(
        Enum(StructuralAnalysisType), nullable=False
    )
    status: Mapped[StructuralJobStatus] = mapped_column(
        Enum(StructuralJobStatus), default=StructuralJobStatus.pending, nullable=False
    )

    result_path: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    result_summary: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    project_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("structural_projects.id"), nullable=False
    )
    owner_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    project: Mapped["StructuralProject"] = relationship("StructuralProject", back_populates="jobs")
    owner: Mapped["User"] = relationship("User", foreign_keys=[owner_id])
