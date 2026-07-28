"""
Router — Análisis No Lineal 3D: lanzamiento, estado y resultados.

Prefix: /api/v1/building/analysis
Auth:   JWT requerido en todos los endpoints.

Flujo:
  POST /launch          → crea BuildingJob + despacha tarea Celery
  GET  /jobs/{id}       → polling de estado (pending/running/success/failed)
  GET  /jobs/{id}/result → resultado JSON (solo si status=success)
  GET  /jobs/{id}/download → descarga del archivo de resultado
  DELETE /jobs/{id}/cancel → cancela el job (revoca la tarea Celery)
"""
import json
import os
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.db import get_db
from app.models import (
    BuildingProject, BuildingJob,
    BuildingAnalysisType, BuildingJobStatus, User,
)

router = APIRouter(prefix="/api/v1/building/analysis", tags=["building-analysis"])

CurrentUser = Annotated[User, Depends(get_current_user)]
DB          = Annotated[Session, Depends(get_db)]


# ── Schemas ───────────────────────────────────────────────────────────────────

class LaunchRequest(BaseModel):
    project_id:     str
    analysis_type:  BuildingAnalysisType
    pushover_params: dict | None = None   # Parámetros UI para pushover
    dynamic_params:  dict | None = None   # Parámetros UI para dinámico


class JobOut(BaseModel):
    id: str
    celery_task_id: str | None
    analysis_type: str
    status: str
    result_path: str | None
    result_summary: dict | None
    error_message: str | None
    project_id: str
    created_at: str
    finished_at: str | None

    @classmethod
    def from_orm(cls, j: BuildingJob) -> "JobOut":
        return cls(
            id=j.id,
            celery_task_id=j.celery_task_id,
            analysis_type=j.analysis_type.value,
            status=j.status.value,
            result_path=j.result_path,
            result_summary=j.result_summary,
            error_message=j.error_message,
            project_id=j.project_id,
            created_at=j.created_at.isoformat(),
            finished_at=j.finished_at.isoformat() if j.finished_at else None,
        )


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_project(db: Session, project_id: str, user: User) -> BuildingProject:
    project = db.get(BuildingProject, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Proyecto no encontrado")
    if project.owner_id != user.id:
        raise HTTPException(status_code=403, detail="Sin acceso a este proyecto")
    return project


def _get_job(db: Session, job_id: str, user: User) -> BuildingJob:
    job = db.get(BuildingJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job no encontrado")
    project = db.get(BuildingProject, job.project_id)
    if not project or project.owner_id != user.id:
        raise HTTPException(status_code=403, detail="Sin acceso a este job")
    return job


def _resolve_input_file(project: BuildingProject) -> str | None:
    """Devuelve la ruta al archivo XLSX principal del proyecto (puede ser el generado desde .e2k)."""
    return project.input_file_path


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/launch", response_model=JobOut, status_code=201)
def launch_analysis(payload: LaunchRequest, user: CurrentUser, db: DB):
    """
    Lanza un análisis en background vía Celery.

    Orden recomendado: archetype → modal → pushover → dynamic.
    El motor valida en tiempo de ejecución que los prerequisitos existan
    (por ejemplo, pushover requiere archetype previo).
    """
    project = _get_project(db, payload.project_id, user)

    # Validar que hay al menos un archivo de modelo
    has_model = bool(project.input_file_path) or bool(project.e2k_file_path)
    if not has_model:
        raise HTTPException(
            status_code=400,
            detail="El proyecto no tiene archivo de modelo. Sube un .xlsx o un .e2k primero.",
        )

    # Modal y dinámico requieren parámetros del proyecto
    needs_params = payload.analysis_type in (BuildingAnalysisType.modal, BuildingAnalysisType.dynamic)
    if needs_params and not project.parameters_json:
        raise HTTPException(
            status_code=400,
            detail="Este análisis requiere los parámetros del proyecto (ciudad, suelo, sistema estructural, etc.).",
        )

    # Crear el registro del job
    job = BuildingJob(
        analysis_type=payload.analysis_type,
        status=BuildingJobStatus.pending,
        project_id=payload.project_id,
        owner_id=user.id,
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    # Despachar la tarea Celery
    try:
        from app.tasks.celery_app import celery_app

        parameters_dict = None
        if project.parameters_json:
            try:
                parameters_dict = json.loads(project.parameters_json)
            except Exception:
                pass

        task_map = {
            BuildingAnalysisType.archetype: "app.tasks.archetype_task.run_archetype",
            BuildingAnalysisType.modal:     "app.tasks.modal_task.run_modal",
            BuildingAnalysisType.pushover:  "app.tasks.pushover_task.run_pushover",
            BuildingAnalysisType.dynamic:   "app.tasks.dynamic_task.run_dynamic",
        }

        kwargs: dict = {
            "job_id":          job.id,
            "project_id":      project.id,
            "input_file":      _resolve_input_file(project),
            "parameters_dict": parameters_dict,
        }

        if payload.analysis_type == BuildingAnalysisType.archetype:
            kwargs["e2k_file"]   = project.e2k_file_path
            kwargs["rebar_file"] = project.rebar_file_path

        if payload.analysis_type == BuildingAnalysisType.pushover and payload.pushover_params:
            kwargs["pushover_params"] = payload.pushover_params

        if payload.analysis_type == BuildingAnalysisType.dynamic and payload.dynamic_params:
            kwargs["dynamic_params"] = payload.dynamic_params

        task = celery_app.send_task(task_map[payload.analysis_type], kwargs=kwargs)
        job.celery_task_id = task.id
        db.commit()
        db.refresh(job)

    except Exception as e:
        job.status = BuildingJobStatus.failed
        job.error_message = str(e)[:4000]
        job.finished_at = datetime.now(timezone.utc)
        db.commit()
        raise HTTPException(status_code=500, detail=f"Error al despachar tarea Celery: {e}")

    return JobOut.from_orm(job)


@router.get("/jobs/{job_id}", response_model=JobOut)
def get_job_status(job_id: str, user: CurrentUser, db: DB):
    """Consulta el estado de un job (usado para polling desde el frontend)."""
    return JobOut.from_orm(_get_job(db, job_id, user))


@router.get("/jobs/{job_id}/result")
def get_job_result(job_id: str, user: CurrentUser, db: DB):
    """
    Retorna el resultado de un job completado.
    Si el archivo es JSON, lo devuelve como objeto.
    Otros formatos: FileResponse (descarga).
    """
    job = _get_job(db, job_id, user)
    if job.status != BuildingJobStatus.success:
        raise HTTPException(
            status_code=400,
            detail=f"El job aún no completó. Estado: {job.status.value}",
        )
    if not job.result_path or not os.path.exists(job.result_path):
        raise HTTPException(status_code=404, detail="Archivo de resultado no encontrado en disco")

    if job.result_path.endswith(".json"):
        with open(job.result_path, "r", encoding="utf-8") as f:
            return json.load(f)

    return FileResponse(job.result_path, filename=os.path.basename(job.result_path))


@router.get("/jobs/{job_id}/download")
def download_job_result(job_id: str, user: CurrentUser, db: DB):
    """Fuerza la descarga del archivo de resultado (Excel, JSON, PKL, PNG)."""
    job = _get_job(db, job_id, user)
    if job.status != BuildingJobStatus.success:
        raise HTTPException(status_code=400, detail="El job no ha completado")
    if not job.result_path or not os.path.exists(job.result_path):
        raise HTTPException(status_code=404, detail="Archivo de resultado no encontrado en disco")

    return FileResponse(
        job.result_path,
        filename=os.path.basename(job.result_path),
        media_type="application/octet-stream",
    )


@router.delete("/jobs/{job_id}/cancel", status_code=200)
def cancel_job(job_id: str, user: CurrentUser, db: DB):
    """Cancela un job en estado pending o running (revoca la tarea Celery)."""
    job = _get_job(db, job_id, user)
    if job.status not in (BuildingJobStatus.pending, BuildingJobStatus.running):
        raise HTTPException(
            status_code=400,
            detail="Solo se pueden cancelar jobs activos (pending o running)",
        )

    if job.celery_task_id:
        try:
            from app.tasks.celery_app import celery_app
            celery_app.control.revoke(job.celery_task_id, terminate=True, signal="SIGTERM")
        except Exception:
            pass

    job.status = BuildingJobStatus.cancelled
    job.error_message = "Cancelado por el usuario"
    job.finished_at = datetime.now(timezone.utc)
    db.commit()
    return {"detail": "Job cancelado exitosamente"}
