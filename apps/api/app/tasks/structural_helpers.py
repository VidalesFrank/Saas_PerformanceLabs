"""
Utilidades compartidas por las tareas Celery del Módulo 1 (Constructor de Modelos).
Gestión de sesiones DB y transiciones de estado de StructuralJob.
"""
import os
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.db import SessionLocal
from app.models import StructuralJob, StructuralJobStatus, StructuralProject


def get_db_session() -> Session:
    return SessionLocal()


def mark_running(db: Session, job_id: str) -> None:
    job = db.get(StructuralJob, job_id)
    if job:
        job.status = StructuralJobStatus.running
        db.commit()


def mark_success(
    db: Session,
    job_id: str,
    result_path: str,
    summary: dict | None = None,
) -> None:
    job = db.get(StructuralJob, job_id)
    if job:
        job.status = StructuralJobStatus.success
        job.result_path = result_path
        job.result_summary = summary
        job.finished_at = datetime.now(timezone.utc)
        db.commit()


def mark_failed(db: Session, job_id: str, error_message: str) -> None:
    job = db.get(StructuralJob, job_id)
    if job:
        job.status = StructuralJobStatus.failed
        job.error_message = error_message[:4000]
        job.finished_at = datetime.now(timezone.utc)
        db.commit()


def update_project_validation(
    db: Session,
    project_id: str,
    validation_status: str,
    canonical_model_path: str | None = None,
) -> None:
    """Actualiza el estado de validación y la ruta del modelo canónico en el proyecto."""
    project = db.get(StructuralProject, project_id)
    if project:
        project.validation_status = validation_status
        if canonical_model_path is not None:
            project.canonical_model_path = canonical_model_path
        db.commit()


def prepare_work_dir(project_id: str, upload_dir: str) -> str:
    """
    Crea la estructura de directorios para un proyecto del Módulo 1:
        uploads/structural/{project_id}/work/
          input/       ← archivos de entrada copiados
          canonical/   ← structural_model.json
          results/     ← resultados de análisis (modal, spectral)

    Retorna la ruta al work_dir.
    """
    work_dir = os.path.join(upload_dir, "structural", str(project_id), "work")
    for subdir in ("input", "canonical", "results"):
        os.makedirs(os.path.join(work_dir, subdir), exist_ok=True)
    return work_dir
