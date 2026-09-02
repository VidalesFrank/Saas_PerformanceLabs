from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.db import engine
from app.models import Base, BuildingJob, BuildingJobStatus, StructuralJob, StructuralJobStatus
from app.routers import auth, catalog, sections, seismic
from app.routers import building_projects, building_analysis, building_performance
from app.routers import section_editor
from app.routers import structural_projects, structural_analysis, structural_design, structural_editor
from app.routers import wall_analytical
from app.routers import structural_nonlinear


def _create_tables() -> None:
    Base.metadata.create_all(bind=engine)


def _cleanup_orphaned_jobs() -> None:
    """
    Al arrancar, marca como 'failed' los jobs que quedaron en estado running/pending
    sin tarea Celery activa (worker reiniciado, crash, etc.).
    Afecta BuildingJob (Módulo 3) y StructuralJob (Módulo 1).
    """
    from sqlalchemy.orm import Session
    from app.db import SessionLocal

    db: Session = SessionLocal()
    try:
        n_total = 0

        orphaned_building = (
            db.query(BuildingJob)
            .filter(BuildingJob.status.in_([BuildingJobStatus.running, BuildingJobStatus.pending]))
            .all()
        )
        for job in orphaned_building:
            job.status = BuildingJobStatus.failed
            job.error_message = "Worker reiniciado o caído — job interrumpido"
            job.finished_at = datetime.now(timezone.utc)
        n_total += len(orphaned_building)

        orphaned_structural = (
            db.query(StructuralJob)
            .filter(StructuralJob.status.in_([StructuralJobStatus.running, StructuralJobStatus.pending]))
            .all()
        )
        for job in orphaned_structural:
            job.status = StructuralJobStatus.failed
            job.error_message = "Worker reiniciado o caído — job interrumpido"
            job.finished_at = datetime.now(timezone.utc)
        n_total += len(orphaned_structural)

        if n_total:
            db.commit()
            print(f"[startup] {n_total} job(s) huérfano(s) marcados como failed")
    except Exception as e:
        print(f"[startup] cleanup_orphaned_jobs falló: {e}")
    finally:
        db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    _create_tables()
    _cleanup_orphaned_jobs()
    yield


app = FastAPI(
    title="PerformanceLabs API",
    version="0.2.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    allow_private_network=True,
)

# ── Módulos existentes ────────────────────────────────────────────────────────
app.include_router(auth.router)
app.include_router(catalog.router)
app.include_router(sections.router)
app.include_router(seismic.router)

# ── Módulo 2 v2: Editor de Secciones ─────────────────────────────────────────
app.include_router(section_editor.router)

# ── Módulo 3: Análisis No Lineal 3D de Edificios ─────────────────────────────
app.include_router(building_projects.router)
app.include_router(building_analysis.router)

# ── Módulo 4: Evaluación de Desempeño Sísmico ────────────────────────────────
app.include_router(building_performance.router)

# ── Módulo 1: Constructor de Modelos Estructurales ────────────────────────────
# IMPORTANTE: registrar en orden de especificidad descendente del prefix.
# Las rutas con paths más específicos deben ir antes de las genéricas {id}.
app.include_router(structural_analysis.router)
app.include_router(structural_design.router)
app.include_router(structural_editor.router)
app.include_router(structural_nonlinear.router)
app.include_router(wall_analytical.router)
app.include_router(structural_projects.router)


@app.get("/api/v1/health")
def health() -> dict:
    return {"status": "ok", "version": "0.2.0"}
