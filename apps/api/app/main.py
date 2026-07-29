from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.db import engine
from app.models import Base, BuildingJob, BuildingJobStatus
from app.routers import auth, catalog, sections, seismic
from app.routers import building_projects, building_analysis
from app.routers import section_editor


def _create_tables() -> None:
    Base.metadata.create_all(bind=engine)


def _cleanup_orphaned_jobs() -> None:
    """
    Al arrancar, marca como 'failed' los jobs que quedaron en estado running/pending
    sin tarea Celery activa (worker reiniciado, crash, etc.).
    Solo afecta BuildingJob — el módulo de análisis 3D.
    """
    from sqlalchemy.orm import Session
    from app.db import SessionLocal

    db: Session = SessionLocal()
    try:
        orphans = (
            db.query(BuildingJob)
            .filter(
                BuildingJob.status.in_([BuildingJobStatus.running, BuildingJobStatus.pending])
            )
            .all()
        )
        for job in orphans:
            job.status = BuildingJobStatus.failed
            job.error_message = "Worker reiniciado o caído — job interrumpido"
            job.finished_at = datetime.now(timezone.utc)
        if orphans:
            db.commit()
            print(f"[startup] {len(orphans)} job(s) huérfano(s) marcados como failed")
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


@app.get("/api/v1/health")
def health() -> dict:
    return {"status": "ok", "version": "0.2.0"}
