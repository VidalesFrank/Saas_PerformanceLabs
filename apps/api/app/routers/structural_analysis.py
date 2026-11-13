"""
Router — Módulo 1: Lanzamiento, estado y resultados de análisis estructural.

Prefix: /api/v1/projects/analysis
Auth:   JWT requerido en todos los endpoints.

Flujo de análisis:
  import_validate → modal → spectral

Cada etapa es un job Celery independiente. El frontend hace polling cada 3s.
"""
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.db import get_db
from app.models import (
    StructuralProject, StructuralJob,
    StructuralAnalysisType, StructuralJobStatus, User,
)

router = APIRouter(prefix="/api/v1/projects/analysis", tags=["structural-analysis"])

CurrentUser = Annotated[User, Depends(get_current_user)]
DB          = Annotated[Session, Depends(get_db)]


# ── Schemas ───────────────────────────────────────────────────────────────────

class LaunchRequest(BaseModel):
    project_id:    str
    analysis_type: StructuralAnalysisType
    extra_params:  dict | None = None    # parámetros adicionales específicos de la tarea


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
    progress: dict | None = None

    @classmethod
    def from_orm(cls, j: StructuralJob) -> "JobOut":
        # Varios tasks guardan result_summary con json.dumps(...) en una
        # columna SQLAlchemy JSON — Postgres/SQLite lo persisten como string
        # y lo devuelven como str al leer. Se re-parsea aquí para que el
        # schema Pydantic (dict | None) no rechace la respuesta.
        raw = j.result_summary
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except (ValueError, TypeError):
                raw = None
        progress = getattr(j, "progress_json", None)
        if isinstance(progress, str):
            try:
                progress = json.loads(progress)
            except (ValueError, TypeError):
                progress = None
        return cls(
            id=j.id,
            celery_task_id=j.celery_task_id,
            analysis_type=j.analysis_type.value,
            status=j.status.value,
            result_path=j.result_path,
            result_summary=raw,
            error_message=j.error_message,
            project_id=j.project_id,
            created_at=j.created_at.isoformat(),
            finished_at=j.finished_at.isoformat() if j.finished_at else None,
            progress=progress,
        )


# ── Helpers ───────────────────────────────────────────────────────────────────

def _input_hash(
    project:       StructuralProject,
    analysis_type: StructuralAnalysisType,
    extra_params:  dict | None,
) -> str | None:
    """
    Hash SHA-256 de las entradas que determinan el resultado de un análisis:
      - contenido del canonical_model.json (si existe)
      - project.parameters_json
      - extra_params serializado con sort_keys
      - analysis_type

    Si canonical_model no existe todavía, retorna None (no se puede cachear).
    """
    if not project.canonical_model_path or not os.path.exists(project.canonical_model_path):
        return None
    try:
        h = hashlib.sha256()
        with open(project.canonical_model_path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 16), b""):
                h.update(chunk)
        h.update((project.parameters_json or "").encode("utf-8"))
        h.update(
            json.dumps(extra_params or {}, sort_keys=True, ensure_ascii=True).encode("utf-8")
        )
        h.update(analysis_type.value.encode("ascii"))
        return h.hexdigest()
    except OSError:
        return None


def _cached_success_for(
    db:            Session,
    project:       StructuralProject,
    analysis_type: StructuralAnalysisType,
    input_hash:    str,
) -> StructuralJob | None:
    """
    Busca el último job success del mismo tipo y proyecto cuyo result_summary
    contenga el mismo input_hash. Si el archivo de resultado ya no existe en
    disco (ej. fue borrado manualmente), NO se considera cache hit.
    """
    candidates = (
        db.query(StructuralJob)
        .filter(
            StructuralJob.project_id == project.id,
            StructuralJob.analysis_type == analysis_type,
            StructuralJob.status == StructuralJobStatus.success,
        )
        .order_by(StructuralJob.finished_at.desc())
        .limit(8)
        .all()
    )
    for j in candidates:
        raw = j.result_summary
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except (ValueError, TypeError):
                continue
        if not isinstance(raw, dict):
            continue
        if raw.get("input_hash") != input_hash:
            continue
        if j.result_path and not os.path.exists(j.result_path):
            continue
        return j
    return None


def _get_project(db: Session, project_id: str, user: User) -> StructuralProject:
    project = db.get(StructuralProject, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Proyecto no encontrado")
    if project.owner_id != user.id:
        raise HTTPException(status_code=403, detail="Sin acceso a este proyecto")
    return project


def _get_job(db: Session, job_id: str, user: User) -> StructuralJob:
    job = db.get(StructuralJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job no encontrado")
    project = db.get(StructuralProject, job.project_id)
    if not project or project.owner_id != user.id:
        raise HTTPException(status_code=403, detail="Sin acceso a este job")
    return job


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/launch", response_model=JobOut, status_code=201)
def launch_analysis(payload: LaunchRequest, user: CurrentUser, db: DB):
    """
    Lanza un análisis en background vía Celery.

    Orden requerido: import_validate → modal → spectral.
    El backend valida que exista el archivo de entrada para import_validate,
    y que haya un modelo canónico para modal y spectral.
    """
    project = _get_project(db, payload.project_id, user)

    # Validaciones de prerequisitos por tipo de análisis
    if payload.analysis_type == StructuralAnalysisType.import_validate:
        has_file = bool(project.input_file_path) or bool(project.e2k_file_path)
        if not has_file:
            raise HTTPException(
                status_code=400,
                detail="Sube un archivo de modelo (.xlsx o .e2k) antes de validar.",
            )

    elif payload.analysis_type == StructuralAnalysisType.modal:
        if project.validation_status not in ("ok", "has_warnings"):
            raise HTTPException(
                status_code=400,
                detail="El modelo debe estar validado (sin errores críticos) antes del análisis modal.",
            )

    elif payload.analysis_type == StructuralAnalysisType.spectral:
        if not project.canonical_model_path:
            raise HTTPException(
                status_code=400,
                detail="Ejecuta el análisis modal primero.",
            )
        if not project.parameters_json:
            raise HTTPException(
                status_code=400,
                detail="Configura los parámetros sísmicos NSR-10 antes del análisis espectral.",
            )

    elif payload.analysis_type in (
        StructuralAnalysisType.design_columns,
        StructuralAnalysisType.design_beams,
    ):
        if not project.canonical_model_path:
            raise HTTPException(
                status_code=400,
                detail="El modelo debe estar validado antes del diseño.",
            )
        # Verifica que exista spectral_results.json
        work_dir = os.path.dirname(os.path.dirname(project.canonical_model_path))
        spectral_path = os.path.join(work_dir, "results", "spectral_results.json")
        if not os.path.exists(spectral_path):
            raise HTTPException(
                status_code=400,
                detail="Ejecuta el análisis espectral RSA antes del diseño.",
            )

    elif payload.analysis_type == StructuralAnalysisType.wall_demands:
        if not project.canonical_model_path:
            raise HTTPException(
                status_code=400,
                detail="El modelo debe estar importado antes de calcular demandas de muros.",
            )
        if not project.parameters_json:
            raise HTTPException(
                status_code=400,
                detail="Configura los parámetros sísmicos NSR-10 antes del análisis de muros.",
            )

    elif payload.analysis_type == StructuralAnalysisType.wall_design:
        if not project.canonical_model_path:
            raise HTTPException(
                status_code=400,
                detail="El modelo debe estar importado antes del diseño de muros.",
            )
        work_dir_wd = os.path.dirname(os.path.dirname(project.canonical_model_path))
        if not os.path.exists(os.path.join(work_dir_wd, "results", "wall_demands.json")):
            raise HTTPException(
                status_code=400,
                detail="Ejecuta el análisis de demandas de muros antes del diseño.",
            )

    elif payload.analysis_type == StructuralAnalysisType.nl_pushover:
        if not project.canonical_model_path:
            raise HTTPException(
                status_code=400,
                detail="El modelo debe estar importado antes del pushover no lineal.",
            )
        work_dir_nl = os.path.dirname(os.path.dirname(project.canonical_model_path))
        if not os.path.exists(os.path.join(work_dir_nl, "results", "wall_design_results.json")):
            raise HTTPException(
                status_code=400,
                detail="Ejecuta el diseño de muros RC antes del pushover no lineal.",
            )

    elif payload.analysis_type == StructuralAnalysisType.frame_pushover:
        if not project.canonical_model_path:
            raise HTTPException(
                status_code=400,
                detail="El modelo debe estar importado antes del pushover de pórticos.",
            )
        # El spec no lineal se genera on-the-fly si no existe; el diseño de
        # columnas/vigas es recomendado pero no obligatorio (fallback a
        # defaults NSR-10 ρ=1% + estribos mínimos).
        work_dir_fp = os.path.dirname(os.path.dirname(project.canonical_model_path))
        has_col_design  = os.path.exists(os.path.join(work_dir_fp, "results", "design_columns_detail.json"))
        has_beam_design = os.path.exists(os.path.join(work_dir_fp, "results", "beam_design_detail.json"))
        if not (has_col_design or has_beam_design):
            # Permitir pero advertir vía header o log — por ahora dejamos pasar
            # y el NLSpecBuilder usará defaults mínimos.
            pass

    # ── Cache por hash: si el último job success del mismo tipo tiene los
    #    mismos inputs (canonical + parameters + extra_params), reutilízalo
    #    en vez de re-lanzar Celery. Ahorra 1-190s por corrida.
    if payload.analysis_type != StructuralAnalysisType.import_validate:
        input_hash = _input_hash(project, payload.analysis_type, payload.extra_params)
        if input_hash:
            cached = _cached_success_for(db, project, payload.analysis_type, input_hash)
            if cached:
                return JobOut.from_orm(cached)

    # Crear el registro del job
    job = StructuralJob(
        analysis_type=payload.analysis_type,
        status=StructuralJobStatus.pending,
        project_id=payload.project_id,
        owner_id=user.id,
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    # Despachar a Celery
    try:
        from app.tasks.celery_app import celery_app

        parameters_dict = None
        if project.parameters_json:
            try:
                parameters_dict = json.loads(project.parameters_json)
            except Exception:
                pass

        task_map = {
            StructuralAnalysisType.import_validate: "app.tasks.structural_import_task.run_import",
            StructuralAnalysisType.modal:           "app.tasks.structural_modal_task.run_modal",
            StructuralAnalysisType.spectral:        "app.tasks.structural_spectral_task.run_spectral",
            StructuralAnalysisType.design_columns:  "app.tasks.structural_design_task.run_design_columns",
            StructuralAnalysisType.design_beams:    "app.tasks.structural_beam_task.run_design_beams",
            StructuralAnalysisType.wall_demands:    "app.tasks.structural_wall_demands_task.run_wall_demands",
            StructuralAnalysisType.wall_design:     "app.tasks.structural_wall_design_task.run_wall_design",
            StructuralAnalysisType.nl_pushover:     "app.tasks.structural_nl_pushover_task.run_nl_pushover",
            StructuralAnalysisType.variant_pushover: "app.tasks.structural_variant_pushover_task.run_variant_pushover",
            StructuralAnalysisType.frame_pushover:  "app.tasks.structural_frame_pushover_task.run_frame_pushover",
            StructuralAnalysisType.nlth:            "app.tasks.structural_nlth_task.run_nlth",
        }

        kwargs: dict = {
            "job_id":          job.id,
            "project_id":      project.id,
            "input_file":      project.input_file_path,
            "parameters_dict": parameters_dict,
        }
        # e2k_file solo lo necesita run_import; no enviarlo a modal/spectral
        if payload.analysis_type == StructuralAnalysisType.import_validate:
            kwargs["e2k_file"] = project.e2k_file_path
        if payload.extra_params:
            kwargs["extra_params"] = payload.extra_params

        task = celery_app.send_task(task_map[payload.analysis_type], kwargs=kwargs)
        job.celery_task_id = task.id
        db.commit()
        db.refresh(job)

    except Exception as e:
        job.status = StructuralJobStatus.failed
        job.error_message = str(e)[:4000]
        job.finished_at = datetime.now(timezone.utc)
        db.commit()
        raise HTTPException(status_code=500, detail=f"Error al despachar tarea Celery: {e}")

    return JobOut.from_orm(job)


@router.get("/jobs/{job_id}", response_model=JobOut)
def get_job_status(job_id: str, user: CurrentUser, db: DB):
    """Consulta el estado de un job (polling desde el frontend cada 3s)."""
    return JobOut.from_orm(_get_job(db, job_id, user))


@router.get("/jobs/{job_id}/result")
def get_job_result(job_id: str, user: CurrentUser, db: DB):
    """Retorna el resultado de un job completado. JSON → objeto. Otros → FileResponse."""
    job = _get_job(db, job_id, user)
    if job.status != StructuralJobStatus.success:
        raise HTTPException(
            status_code=400,
            detail=f"El job aún no completó. Estado: {job.status.value}",
        )
    if not job.result_path or not os.path.exists(job.result_path):
        raise HTTPException(status_code=404, detail="Archivo de resultado no encontrado")

    if job.result_path.endswith(".json"):
        with open(job.result_path, "r", encoding="utf-8") as f:
            return json.load(f)
    return FileResponse(job.result_path, filename=os.path.basename(job.result_path))


@router.get("/jobs/{job_id}/download")
def download_job_result(job_id: str, user: CurrentUser, db: DB):
    """Fuerza la descarga del archivo de resultado."""
    job = _get_job(db, job_id, user)
    if job.status != StructuralJobStatus.success:
        raise HTTPException(status_code=400, detail="El job no ha completado")
    if not job.result_path or not os.path.exists(job.result_path):
        raise HTTPException(status_code=404, detail="Archivo de resultado no encontrado")
    return FileResponse(
        job.result_path,
        filename=os.path.basename(job.result_path),
        media_type="application/octet-stream",
    )


@router.get("/{project_id}/wall-demands")
def get_wall_demands(project_id: str, user: CurrentUser, db: DB):
    """
    Retorna el resultado más reciente de wall_demands para el proyecto.
    Lee directamente wall_demands.json si existe, sin necesitar el job_id.
    """
    project = _get_project(db, project_id, user)
    if not project.canonical_model_path:
        raise HTTPException(status_code=404, detail="Modelo canónico no disponible")

    work_dir   = os.path.dirname(os.path.dirname(project.canonical_model_path))
    result_path = os.path.join(work_dir, "results", "wall_demands.json")

    if not os.path.exists(result_path):
        raise HTTPException(status_code=404, detail="No hay resultados de demandas de muros aún")

    with open(result_path, "r", encoding="utf-8") as f:
        return json.load(f)


@router.get("/{project_id}/wall-design")
def get_wall_design(project_id: str, user: CurrentUser, db: DB):
    """Retorna el resultado más reciente de wall_design para el proyecto."""
    project = _get_project(db, project_id, user)
    if not project.canonical_model_path:
        raise HTTPException(status_code=404, detail="Modelo canónico no disponible")

    work_dir    = os.path.dirname(os.path.dirname(project.canonical_model_path))
    result_path = os.path.join(work_dir, "results", "wall_design_results.json")

    if not os.path.exists(result_path):
        raise HTTPException(status_code=404, detail="No hay resultados de diseño de muros aún")

    with open(result_path, "r", encoding="utf-8") as f:
        return json.load(f)


@router.get("/{project_id}/nl-pushover")
def get_nl_pushover(project_id: str, user: CurrentUser, db: DB):
    """Retorna los resultados del pushover no lineal del edificio de muros."""
    project = _get_project(db, project_id, user)
    if not project.canonical_model_path:
        raise HTTPException(status_code=404, detail="Modelo canónico no disponible")

    work_dir    = os.path.dirname(os.path.dirname(project.canonical_model_path))
    result_path = os.path.join(work_dir, "results", "nl_pushover_results.json")

    if not os.path.exists(result_path):
        raise HTTPException(status_code=404, detail="No hay resultados de pushover no lineal aún")

    with open(result_path, "r", encoding="utf-8") as f:
        return json.load(f)


@router.get("/{project_id}/nl-pushover/{direction}/history")
def get_nl_pushover_history(
    project_id: str,
    direction:  str,
    user:       CurrentUser,
    db:         DB,
    max_frames: int = 60,
):
    """
    Retorna la historia comprimida (NPZ) de la deformada del pushover para una
    dirección, submuestreada a ~max_frames keyframes.

    Response:
      - direction, total_height_m, drift_cap
      - frames: [{step, drift_pct, base_shear_kN, disp: {tag: [ux,uy,uz]}}]
      - pier_lines: array con coords_ref + node_tags de cada pier
      - pier_damage: [{pier, story, di_effective, damage_level}]
      - metadata (total pasos, frames capturados, stride)
    """
    import numpy as np

    project = _get_project(db, project_id, user)
    if not project.canonical_model_path:
        raise HTTPException(status_code=404, detail="Modelo canónico no disponible")

    work_dir = os.path.dirname(os.path.dirname(project.canonical_model_path))
    npz_path = os.path.join(work_dir, "results", f"nl_pushover_{direction.replace('-', 'm')}_history.npz")
    res_path = os.path.join(work_dir, "results", "nl_pushover_results.json")

    if not os.path.exists(npz_path):
        raise HTTPException(status_code=404, detail=f"No hay historia NPZ para dirección {direction}")
    if not os.path.exists(res_path):
        raise HTTPException(status_code=404, detail="No hay resultados de pushover")

    with open(res_path, "r", encoding="utf-8") as f:
        results = json.load(f)

    dir_result = results.get(f"pushover_{direction.upper().lstrip('-')}") or (
        results.get("pushover_X") if direction.upper() in ("X", "-X")
        else results.get("pushover_Y")
    )
    if not dir_result:
        raise HTTPException(status_code=404, detail=f"Dirección {direction} no encontrada en resultados")

    # ── Carga NPZ ─────────────────────────────────────────────────────────────
    data = np.load(npz_path, allow_pickle=False)
    disp_cm  = data["disp_cm"]       # (n_frames, n_cm, 3)
    disp_top = data["disp_top"]      # (n_frames, n_top, 3)
    cm_tags  = data["cm_tags"].tolist()
    top_tags = data["top_tags"].tolist()

    n_captured = int(disp_cm.shape[0])
    if n_captured == 0:
        raise HTTPException(status_code=404, detail="Historia vacía")

    # ── Submuestreo uniforme a max_frames ─────────────────────────────────────
    if n_captured > max_frames:
        idx = np.linspace(0, n_captured - 1, max_frames, dtype=int)
    else:
        idx = np.arange(n_captured)

    # Mapa paso → step_data del pushover (steps del result JSON)
    steps_pushover = dir_result.get("steps", [])
    # Como history_stride puede ser >1, el índice del frame no equivale al step
    # directo. Usamos la relación: frame_i corresponde al step (i+1)*stride (aprox).
    hist_meta   = dir_result.get("history", {})
    stride      = int(hist_meta.get("stride", 1))

    frames_out = []
    for fi in idx:
        # Aproximación al step del pushover
        step_num = int((fi + 1) * stride)
        if step_num <= 0 or step_num > len(steps_pushover):
            step_num = min(len(steps_pushover), step_num)
        s = steps_pushover[step_num - 1] if 0 < step_num <= len(steps_pushover) else {}

        disp_map: dict[str, list[float]] = {}
        for j, tag in enumerate(cm_tags):
            u = disp_cm[fi, j]
            disp_map[str(int(tag))] = [float(u[0]), float(u[1]), float(u[2])]
        for j, tag in enumerate(top_tags):
            u = disp_top[fi, j]
            disp_map[str(int(tag))] = [float(u[0]), float(u[1]), float(u[2])]

        frames_out.append({
            "frame":         int(fi),
            "step":          step_num,
            "drift_pct":     s.get("drift_pct", 0.0),
            "base_shear_kN": s.get("base_shear_kN", 0.0),
            "disp":          disp_map,
        })

    # ── Damage index por pier (rank global) ───────────────────────────────────
    damage = dir_result.get("damage", {})
    pier_damage = damage.get("pier_damage", [])
    damage_by_pier_story = {
        (r["pier"], r["story"]): {
            "di":     r["di_effective"],
            "di_base": r["di_base"],
            "level":  r["damage_level"],
            "drift_pct": r["drift_pct"],
        }
        for r in pier_damage
    }

    # ── Enriquece pier_lines con daño para el frontend ────────────────────────
    pier_lines_out = []
    for pl in dir_result.get("pier_lines", []):
        key = (pl["pier"], pl["story"])
        d = damage_by_pier_story.get(key, {"di": 0.0, "level": "none", "drift_pct": 0.0})
        pier_lines_out.append({**pl, "damage": d})

    return {
        "direction":      direction,
        "total_height_m": dir_result.get("total_height", 0.0),
        "target_drift_pct": dir_result.get("target_drift_pct", 2.0),
        "drift_cap":      damage.get("drift_cap", 0.015),
        "n_frames":       len(frames_out),
        "n_captured":     n_captured,
        "n_total_steps":  dir_result.get("total_steps", 0),
        "stride":         stride,
        "frames":         frames_out,
        "pier_lines":     pier_lines_out,
        "story_drifts":   damage.get("story_drifts", []),
        "summary":        dir_result.get("summary", {}),
    }


@router.get("/{project_id}/nl-pushover/{direction}/pier-response")
def get_nl_pushover_pier_response(
    project_id: str,
    direction:  str,
    user:       CurrentUser,
    db:         DB,
    pier:       str,
    story:      str,
):
    """
    Respuesta local de UN pier específico durante el pushover:
      - M-φ  (momento-curvatura estimada) en base del muro, plano de flexión
      - V-δ  (cortante-desplazamiento) proyectado en dirección del muro

    Estimaciones:
      - M_base : proyección de (Mx,My) en base sobre normal horizontal al muro
      - V_base : proyección de (Fx,Fy) en base sobre dirección del muro
      - δ_top  : (u_top - u_bot) · d̂
      - φ      : drift / lp con lp = 0.5·lw (Priestley 2007, rótula plástica)
    """
    import numpy as np

    project = _get_project(db, project_id, user)
    if not project.canonical_model_path:
        raise HTTPException(status_code=404, detail="Modelo canónico no disponible")

    work_dir = os.path.dirname(os.path.dirname(project.canonical_model_path))
    npz_path = os.path.join(work_dir, "results", f"nl_pushover_{direction.replace('-', 'm')}_history.npz")
    res_path = os.path.join(work_dir, "results", "nl_pushover_results.json")

    if not os.path.exists(npz_path) or not os.path.exists(res_path):
        raise HTTPException(status_code=404, detail="Historia del pushover no disponible")

    with open(res_path, "r", encoding="utf-8") as f:
        results = json.load(f)

    dir_key    = "pushover_X" if direction.upper().lstrip("-") == "X" else "pushover_Y"
    dir_result = results.get(dir_key)
    if not dir_result:
        raise HTTPException(status_code=404, detail=f"Dirección {direction} no encontrada")

    # ── Localiza el pier en el metadata ───────────────────────────────────────
    pier_lines: list[dict] = dir_result.get("pier_lines", [])
    pl = next((p for p in pier_lines if p["pier"] == pier and p["story"] == story), None)
    if not pl:
        raise HTTPException(status_code=404, detail=f"Pier {pier}/{story} no encontrado")

    c_ref     = pl["coords_ref"]
    lw        = float(pl["lw_m"])
    hw        = float(pl["hw_m"])
    x1, y1, _ = c_ref["base_left"]
    x2, y2, _ = c_ref["base_right"]
    dx, dy    = x2 - x1, y2 - y1
    d_norm    = (dx*dx + dy*dy) ** 0.5 or 1.0
    d         = (dx / d_norm, dy / d_norm)             # dirección del muro en planta
    n         = (-d[1], d[0])                          # normal horizontal al muro

    n_bl = int(pl["node_tags"]["base_left"])
    n_br = int(pl["node_tags"]["base_right"])
    n_tl = int(pl["node_tags"]["top_left"])
    n_tr = int(pl["node_tags"]["top_right"])

    # Buscar el índice del elemento MVLEM_3D asociado a este pier (para eleForce).
    # Necesitamos leer el mapping pier→element del builder. Como el NPZ solo tiene
    # ele_tags[], iteramos y buscamos el que tenga estos nodos base.
    data = np.load(npz_path, allow_pickle=False)
    ele_tags = data["ele_tags"].tolist()
    top_tags = data["top_tags"].tolist()
    cm_tags  = data["cm_tags"].tolist()

    # Índices en top_tags para los top nodes del pier
    try:
        i_tl = top_tags.index(n_tl)
        i_tr = top_tags.index(n_tr)
    except ValueError:
        raise HTTPException(status_code=500, detail=f"Nodos top del pier no en NPZ")

    # ── Encuentra el índice del elemento MVLEM_3D del pier ───────────────────
    # El result JSON tiene "elements" en history con {tag, pier, story}
    hist_meta = dir_result.get("history", {})
    ele_meta  = hist_meta.get("elements", [])
    ele_tag_target = next((e["tag"] for e in ele_meta if e["pier"] == pier and e["story"] == story), None)
    if ele_tag_target is None or ele_tag_target not in ele_tags:
        raise HTTPException(status_code=500, detail="Elemento MVLEM_3D del pier no localizado")
    ele_idx = ele_tags.index(ele_tag_target)

    # ── Extrae historia frame por frame ──────────────────────────────────────
    disp_top   = data["disp_top"]     # (n_frames, n_top, 3)
    ele_force  = data["ele_force"]    # (n_frames, n_ele, 24)
    n_frames   = disp_top.shape[0]

    steps_meta = dir_result.get("steps", [])
    stride     = int(hist_meta.get("stride", 1))

    lp = 0.5 * lw  # longitud de rótula plástica (Priestley 2007)

    m_phi_curve: list[dict] = []
    v_delta_curve: list[dict] = []

    for fi in range(n_frames):
        # Desplazamiento del top (promedio de las 2 esquinas)
        u_tl = disp_top[fi, i_tl]
        u_tr = disp_top[fi, i_tr]
        u_top = ((float(u_tl[0]) + float(u_tr[0])) / 2.0,
                 (float(u_tl[1]) + float(u_tr[1])) / 2.0,
                 (float(u_tl[2]) + float(u_tr[2])) / 2.0)

        # Base fija (u_bot ≈ 0). Proyección sobre dirección del muro
        delta = u_top[0] * d[0] + u_top[1] * d[1]
        drift = abs(delta) / hw if hw > 0 else 0.0
        phi   = drift / lp if lp > 0 else 0.0            # 1/m

        # Fuerzas en base: nodos i (base_left) y j (base_right)
        # Layout eleForce: [F_i_x, F_i_y, F_i_z, M_i_x, M_i_y, M_i_z, F_j_x, ...]
        ef = ele_force[fi, ele_idx]
        if len(ef) < 24:
            continue
        Fix, Fiy, _, Mix, Miy, _ = float(ef[0]),  float(ef[1]),  float(ef[2]),  float(ef[3]),  float(ef[4]),  float(ef[5])
        Fjx, Fjy, _, Mjx, Mjy, _ = float(ef[6]),  float(ef[7]),  float(ef[8]),  float(ef[9]),  float(ef[10]), float(ef[11])

        # Cortante base proyectado en la dirección del muro (nótese signo:
        # eleForce da la fuerza del elemento sobre el nodo; para tener el cortante
        # base "reacción" tomamos signo positivo)
        V_base = (Fix + Fjx) * d[0] + (Fiy + Fjy) * d[1]

        # Momento flector en plano proyectado sobre n = (-dy, dx)
        Mx_tot = Mix + Mjx
        My_tot = Miy + Mjy
        M_base = Mx_tot * n[0] + My_tot * n[1]

        step_num = min(len(steps_meta), (fi + 1) * stride)
        s = steps_meta[step_num - 1] if 0 < step_num <= len(steps_meta) else {}

        m_phi_curve.append({
            "step":         step_num,
            "phi_1_per_m":  round(phi, 6),
            "moment_kNm":   round(abs(M_base), 2),
            "drift_pct":    s.get("drift_pct", 0.0),
        })
        v_delta_curve.append({
            "step":         step_num,
            "delta_m":      round(delta, 6),
            "shear_kN":     round(V_base, 2),
            "drift_pct":    s.get("drift_pct", 0.0),
        })

    # ── Estimaciones de fluencia (heurística basada en cambio de pendiente) ──
    def _detect_yield(curve: list[dict], x_key: str, y_key: str) -> dict | None:
        if len(curve) < 6:
            return None
        # Aproxima punto de fluencia como cuando la pendiente cae al 70% de la
        # pendiente inicial (secante).
        xs = [p[x_key] for p in curve]
        ys = [abs(p[y_key]) for p in curve]
        y_max = max(ys) or 1.0
        # Pendiente inicial elástica: primeros 3 puntos
        if xs[2] - xs[0] == 0:
            return None
        k0 = (ys[2] - ys[0]) / (xs[2] - xs[0])
        for i in range(3, len(curve)):
            if xs[i] - xs[0] == 0:
                continue
            k_i = (ys[i] - ys[0]) / (xs[i] - xs[0])
            if k_i < 0.7 * k0 and ys[i] > 0.4 * y_max:
                return {**curve[i], "note": "yield_estimate"}
        return None

    return {
        "pier":        pier,
        "story":       story,
        "direction":   direction,
        "lw_m":        lw,
        "hw_m":        hw,
        "lp_m":        lp,
        "damage":      next(
            (p["damage"] for p in results.get(dir_key, {}).get("pier_lines", []) if p["pier"] == pier and p["story"] == story),
            None,
        ) if "damage" in (pier_lines[0] if pier_lines else {}) else None,
        "M_phi":       m_phi_curve,
        "V_delta":     v_delta_curve,
        "yield_M_phi": _detect_yield(m_phi_curve, "phi_1_per_m", "moment_kNm"),
        "yield_V_delta": _detect_yield(v_delta_curve, "delta_m", "shear_kN"),
    }


# ── Variantes de diseño (Fase 6) ──────────────────────────────────────────────

@router.get("/{project_id}/design-variants")
def list_design_variants(project_id: str, user: CurrentUser, db: DB):
    """Lista todas las variantes de diseño creadas para el proyecto."""
    from app.services.design_variants import list_variants

    project = _get_project(db, project_id, user)
    if not project.canonical_model_path:
        raise HTTPException(status_code=404, detail="Modelo canónico no disponible")

    work_dir = os.path.dirname(os.path.dirname(project.canonical_model_path))
    return {"variants": list_variants(work_dir)}


class _VariantCreatePayload(BaseModel):
    name:        str
    description: str = ""


@router.post("/{project_id}/design-variants", status_code=201)
def create_design_variant(
    project_id: str,
    payload:    _VariantCreatePayload,
    user:       CurrentUser,
    db:         DB,
):
    """Crea una nueva variante de diseño (sin overrides todavía)."""
    from app.services.design_variants import create_variant

    project = _get_project(db, project_id, user)
    if not project.canonical_model_path:
        raise HTTPException(status_code=404, detail="Modelo canónico no disponible")

    work_dir = os.path.dirname(os.path.dirname(project.canonical_model_path))
    return create_variant(work_dir, payload.name, payload.description)


class _VariantUpdatePayload(BaseModel):
    name:        str | None = None
    description: str | None = None
    overrides:   dict | None = None    # {"pier|story": {be_n_bars, be_db_mm, ...} | null}


@router.put("/{project_id}/design-variants/{variant_id}")
def update_design_variant(
    project_id: str,
    variant_id: str,
    payload:    _VariantUpdatePayload,
    user:       CurrentUser,
    db:         DB,
):
    """
    Actualiza una variante — nombre, descripción y/o overrides.
    Los overrides se hacen merge: enviar {pier|story: null} elimina ese override.
    """
    from app.services.design_variants import update_variant

    project = _get_project(db, project_id, user)
    if not project.canonical_model_path:
        raise HTTPException(status_code=404, detail="Modelo canónico no disponible")

    work_dir = os.path.dirname(os.path.dirname(project.canonical_model_path))
    try:
        return update_variant(
            work_dir, variant_id,
            {k: v for k, v in payload.model_dump().items() if v is not None},
        )
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.delete("/{project_id}/design-variants/{variant_id}", status_code=200)
def delete_design_variant(
    project_id: str,
    variant_id: str,
    user:       CurrentUser,
    db:         DB,
):
    """Elimina una variante de diseño."""
    from app.services.design_variants import delete_variant

    project = _get_project(db, project_id, user)
    if not project.canonical_model_path:
        raise HTTPException(status_code=404, detail="Modelo canónico no disponible")

    work_dir = os.path.dirname(os.path.dirname(project.canonical_model_path))
    ok = delete_variant(work_dir, variant_id)
    if not ok:
        raise HTTPException(status_code=404, detail=f"Variante {variant_id} no encontrada")
    return {"deleted": variant_id}


@router.post(
    "/{project_id}/design-variants/{variant_id}/analyze",
    response_model=JobOut,
    status_code=201,
)
def analyze_design_variant(
    project_id: str,
    variant_id: str,
    user:       CurrentUser,
    db:         DB,
):
    """
    Lanza el pushover no lineal de una variante de diseño (Sprint 6.2).

    Reusa el pipeline `structural_variant_pushover_task`: aplica los overrides
    sobre el diseño baseline y corre el pushover completo. Los resultados se
    persisten por variante para poder compararlos con el baseline en el frontend.
    """
    from app.services.design_variants import get_variant, update_variant

    project = _get_project(db, project_id, user)
    if not project.canonical_model_path:
        raise HTTPException(status_code=404, detail="Modelo canónico no disponible")

    work_dir = os.path.dirname(os.path.dirname(project.canonical_model_path))

    variant = get_variant(work_dir, variant_id)
    if variant is None:
        raise HTTPException(status_code=404, detail=f"Variante {variant_id} no encontrada")
    if not variant.get("overrides"):
        raise HTTPException(
            status_code=400,
            detail="La variante no tiene overrides. Añade al menos un cambio antes de analizarla.",
        )
    if variant.get("status") == "analyzing":
        raise HTTPException(
            status_code=409,
            detail="La variante ya está siendo analizada. Espera a que termine.",
        )

    # Prerequisitos como en nl_pushover
    baseline_design_path = os.path.join(work_dir, "results", "wall_design_results.json")
    if not os.path.exists(baseline_design_path):
        raise HTTPException(
            status_code=400,
            detail="No hay diseño baseline (wall_design_results.json). Ejecuta primero el diseño de muros RC.",
        )
    baseline_pushover = os.path.join(work_dir, "results", "nl_pushover_results.json")
    if not os.path.exists(baseline_pushover):
        raise HTTPException(
            status_code=400,
            detail="No hay pushover baseline. Ejecuta primero el pushover no lineal del baseline.",
        )

    # Crear el job
    job = StructuralJob(
        analysis_type = StructuralAnalysisType.variant_pushover,
        status        = StructuralJobStatus.pending,
        project_id    = project.id,
        owner_id      = user.id,
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    # Despachar tarea
    try:
        from app.tasks.celery_app import celery_app

        parameters_dict = None
        if project.parameters_json:
            try:
                parameters_dict = json.loads(project.parameters_json)
            except Exception:
                pass

        kwargs = {
            "job_id":          job.id,
            "project_id":      project.id,
            "input_file":      project.input_file_path,
            "parameters_dict": parameters_dict,
            "extra_params":    {"variant_id": variant_id},
        }
        task = celery_app.send_task(
            "app.tasks.structural_variant_pushover_task.run_variant_pushover",
            kwargs=kwargs,
        )
        job.celery_task_id = task.id
        db.commit()
        db.refresh(job)

        # Marca la variante como analyzing (el task también lo hace, pero adelantamos
        # el estado para que el frontend lo vea de inmediato en el listado).
        update_variant(
            work_dir, variant_id,
            {
                "status":               "analyzing",
                "analysis_job_id":      job.id,
                "analysis_result_path": None,
                "error_message":        None,
            },
        )
    except Exception as e:
        job.status = StructuralJobStatus.failed
        job.error_message = str(e)[:4000]
        job.finished_at = datetime.now(timezone.utc)
        db.commit()
        raise HTTPException(status_code=500, detail=f"Error al despachar tarea Celery: {e}")

    return JobOut.from_orm(job)


@router.get("/{project_id}/design-variants/{variant_id}/result")
def get_design_variant_result(
    project_id: str,
    variant_id: str,
    user:       CurrentUser,
    db:         DB,
):
    """
    Retorna el resultado del pushover no lineal ejecutado sobre la variante.
    Formato idéntico a `nl_pushover_results.json` + campos `variant_id`, `variant_name`.
    """
    from app.services.design_variants import get_variant

    project = _get_project(db, project_id, user)
    if not project.canonical_model_path:
        raise HTTPException(status_code=404, detail="Modelo canónico no disponible")

    work_dir = os.path.dirname(os.path.dirname(project.canonical_model_path))

    variant = get_variant(work_dir, variant_id)
    if variant is None:
        raise HTTPException(status_code=404, detail=f"Variante {variant_id} no encontrada")

    result_path = variant.get("analysis_result_path") or os.path.join(
        work_dir, "results", f"nl_pushover_variant_{variant_id}_results.json"
    )
    if not os.path.exists(result_path):
        raise HTTPException(
            status_code=404,
            detail="La variante aún no tiene resultado. Ejecuta el análisis primero.",
        )

    with open(result_path, "r", encoding="utf-8") as f:
        return json.load(f)


# ── Pushover No Lineal de Pórticos (Módulo 1 — F2-F6) ────────────────────────

@router.get("/{project_id}/nl-frame-pushover")
def get_nl_frame_pushover(project_id: str, user: CurrentUser, db: DB):
    """Retorna los resultados del pushover no lineal de pórticos."""
    project = _get_project(db, project_id, user)
    if not project.canonical_model_path:
        raise HTTPException(status_code=404, detail="Modelo canónico no disponible")

    work_dir    = os.path.dirname(os.path.dirname(project.canonical_model_path))
    result_path = os.path.join(work_dir, "results", "nl_frame_pushover_results.json")
    if not os.path.exists(result_path):
        raise HTTPException(status_code=404, detail="No hay resultados de pushover de pórticos aún")
    with open(result_path, "r", encoding="utf-8") as f:
        return json.load(f)


@router.get("/{project_id}/nl-frame-pushover/{direction}/history")
def get_nl_frame_pushover_history(
    project_id: str,
    direction:  str,
    user:       CurrentUser,
    db:         DB,
    max_frames: int = 60,
):
    """
    Historia submuestreada de la deformada del pushover de pórticos para una
    dirección (X o Y).

    Response:
      - direction, total_height_m
      - frames: [{step, drift_pct, base_shear_kN, disp: {tag: [ux,uy,uz]}}]
      - element_lines: metadata de columnas/vigas (fid, kind, node_i, node_j,
                        b_m, h_m, L_m, lp_m, story)
      - hinge_damage: lista por extremo con nivel ASCE 41 (none/io/ls/cp/collapse)
      - story_drifts: por piso
    """
    import numpy as np

    project = _get_project(db, project_id, user)
    if not project.canonical_model_path:
        raise HTTPException(status_code=404, detail="Modelo canónico no disponible")

    work_dir = os.path.dirname(os.path.dirname(project.canonical_model_path))
    npz_path = os.path.join(
        work_dir, "results",
        f"nl_frame_pushover_{direction.replace('-', 'm')}_history.npz",
    )
    res_path = os.path.join(work_dir, "results", "nl_frame_pushover_results.json")

    if not os.path.exists(npz_path):
        raise HTTPException(status_code=404, detail=f"No hay historia NPZ para dirección {direction}")
    if not os.path.exists(res_path):
        raise HTTPException(status_code=404, detail="No hay resultados de pushover de pórticos")

    with open(res_path, "r", encoding="utf-8") as f:
        results = json.load(f)
    dir_key    = "pushover_X" if direction.upper().lstrip("-") == "X" else "pushover_Y"
    dir_result = results.get(dir_key)
    if not dir_result:
        raise HTTPException(status_code=404, detail=f"Dirección {direction} no encontrada")

    data = np.load(npz_path, allow_pickle=False)
    disp_joint = data["disp_joint"]    # (n_frames, n_joint, 6)
    joint_tags = data["joint_tags"].tolist()

    n_captured = int(disp_joint.shape[0])
    if n_captured == 0:
        raise HTTPException(status_code=404, detail="Historia vacía")

    if n_captured > max_frames:
        idx = np.linspace(0, n_captured - 1, max_frames, dtype=int)
    else:
        idx = np.arange(n_captured)

    steps_pushover = dir_result.get("steps", [])
    hist_meta      = dir_result.get("history", {})
    stride         = int(hist_meta.get("stride", 1))

    frames_out = []
    for fi in idx:
        step_num = min(len(steps_pushover), int((fi + 1) * stride))
        s = steps_pushover[step_num - 1] if 0 < step_num <= len(steps_pushover) else {}
        disp_map: dict[str, list[float]] = {}
        for j, tag in enumerate(joint_tags):
            u = disp_joint[fi, j]
            disp_map[str(int(tag))] = [float(u[0]), float(u[1]), float(u[2])]
        frames_out.append({
            "frame":         int(fi),
            "step":          step_num,
            "drift_pct":     s.get("drift_pct", 0.0),
            "base_shear_kN": s.get("base_shear_kN", 0.0),
            "disp":          disp_map,
        })

    # Nodos (coords de referencia) para la geometría indeformada en el frontend
    # Se leen del canonical para no depender del NPZ.
    with open(project.canonical_model_path, encoding="utf-8") as f:
        canonical = json.load(f)
    joints_ref: dict[str, list[float]] = {}
    for lbl, jd in canonical.get("joints", {}).items():
        try:
            tag = str(int(float(lbl)))
        except (TypeError, ValueError):
            tag = str(lbl)
        joints_ref[tag] = [float(jd.get("x", 0)), float(jd.get("y", 0)), float(jd.get("z", 0))]

    damage        = dir_result.get("damage", {})
    infill_damage = dir_result.get("infill_damage", {})

    # Historia θ_p por rótula alineada con los frames submuestreados.
    # Permite al visor clasificar nivel de daño por frame bajo umbrales ajustables.
    hinges_enriched = list(damage.get("hinges", []))
    try:
        spec_path = os.path.join(work_dir, "nonlinear", "nonlinear_model.json")
        if os.path.exists(spec_path):
            with open(spec_path, encoding="utf-8") as f:
                spec = json.load(f)
            from app.engine.building.nonlinear.hinge_damage import compute_theta_p_submatrix
            submatrix = compute_theta_p_submatrix(
                history_path  = npz_path,
                element_lines = dir_result.get("element_lines", []),
                spec          = spec,
                frame_indices = idx.tolist(),
            )
            for h in hinges_enriched:
                key = f"{h.get('fid')}|{h.get('end')}"
                extra = submatrix.get(key)
                if extra:
                    h["theta_p_hist"]  = extra["theta_p_hist"]
                    h["theta_IO_base"] = h.get("theta_IO_base", extra["theta_IO_base"])
                    h["theta_LS_base"] = h.get("theta_LS_base", extra["theta_LS_base"])
                    h["theta_CP_base"] = h.get("theta_CP_base", extra["theta_CP_base"])
                    h["k_conf"]        = h.get("k_conf", extra["k_conf"])
                    h["rho_s"]         = h.get("rho_s", extra["rho_s"])
    except Exception as e_sub:
        print(f"[nl_frame_pushover] WARN theta_p submatrix: {e_sub}")

    # Historia de daño de infills alineada con los frames submuestreados
    infill_hist_full = infill_damage.get("history") or []
    infill_hist_sub: list[list[float]] = []
    if infill_hist_full:
        for fi in idx:
            if 0 <= int(fi) < len(infill_hist_full):
                infill_hist_sub.append(infill_hist_full[int(fi)])
            else:
                infill_hist_sub.append([0.0] * len(infill_damage.get("panel_ids", [])))

    return {
        "direction":        direction,
        "total_height_m":   dir_result.get("total_height", 0.0),
        "target_drift_pct": dir_result.get("target_drift_pct", 2.0),
        "pattern_type":     dir_result.get("pattern_type", "triangular"),
        "n_frames":         len(frames_out),
        "n_captured":       n_captured,
        "n_total_steps":    dir_result.get("total_steps", 0),
        "stride":           stride,
        "frames":           frames_out,
        "joints_ref":       joints_ref,
        "stories_z":        dir_result.get("stories_z", {}),
        "element_lines":    dir_result.get("element_lines", []),
        "infill_lines":     dir_result.get("infill_lines", []),
        "hinge_damage":     hinges_enriched,
        "damage_by_element": damage.get("by_element", {}),
        "infill_damage": {
            "status":       infill_damage.get("status", "no_infills"),
            "n_total":      infill_damage.get("n_total", 0),
            "n_collapsed":  infill_damage.get("n_collapsed", 0),
            "n_degrading":  infill_damage.get("n_degrading", 0),
            "max_damage":   infill_damage.get("max_damage", 0.0),
            "panel_ids":    infill_damage.get("panel_ids", []),
            "panels":       infill_damage.get("panels", []),
            "history":      infill_hist_sub,
        },
        "summary":          dir_result.get("summary", {}),
    }


@router.get("/{project_id}/nl-frame-pushover/{direction}/element-response")
def get_nl_frame_element_response(
    project_id: str,
    direction:  str,
    user:       CurrentUser,
    db:         DB,
    fid:        str,
    end:        str = "i",
):
    """
    Respuesta local de un extremo (i/j) de un elemento (columna o viga)
    durante el pushover: curva M-φ aproximada a partir de las
    sectionDeformations capturadas en el NPZ.

    Query:
      - fid : frame_id del elemento
      - end : "i" | "j" (extremo del elemento)
    """
    import numpy as np

    project = _get_project(db, project_id, user)
    if not project.canonical_model_path:
        raise HTTPException(status_code=404, detail="Modelo canónico no disponible")

    work_dir = os.path.dirname(os.path.dirname(project.canonical_model_path))
    npz_path = os.path.join(
        work_dir, "results",
        f"nl_frame_pushover_{direction.replace('-', 'm')}_history.npz",
    )
    res_path = os.path.join(work_dir, "results", "nl_frame_pushover_results.json")
    if not os.path.exists(npz_path) or not os.path.exists(res_path):
        raise HTTPException(status_code=404, detail="Historia del pushover no disponible")

    with open(res_path, "r", encoding="utf-8") as f:
        results = json.load(f)
    dir_key    = "pushover_X" if direction.upper().lstrip("-") == "X" else "pushover_Y"
    dir_result = results.get(dir_key)
    if not dir_result:
        raise HTTPException(status_code=404, detail=f"Dirección {direction} no encontrada")

    # Localiza el elemento en element_lines
    ele_lines = dir_result.get("element_lines", [])
    el = next((e for e in ele_lines if str(e.get("fid")) == str(fid)), None)
    if not el:
        raise HTTPException(status_code=404, detail=f"Elemento {fid} no encontrado")

    kind    = el["kind"]
    ele_tag = int(el["ele_tag"])
    lp      = float(el.get("lp_m", 0.2))

    data = np.load(npz_path, allow_pickle=False)
    arr_key  = "col_sect_def" if kind == "column" else "bm_sect_def"
    tag_key  = "col_tags"      if kind == "column" else "bm_tags"
    if arr_key not in data.files:
        raise HTTPException(status_code=404, detail="Historia sin deformaciones de sección")
    arr  = data[arr_key]
    tags = data[tag_key].tolist()
    if ele_tag not in tags:
        raise HTTPException(status_code=404, detail=f"ele_tag {ele_tag} no en NPZ")
    idx = tags.index(ele_tag)
    slab = arr[:, idx, :]
    if slab.shape[1] < 6:
        raise HTTPException(status_code=500, detail="Formato inesperado de deformaciones")

    # Elegir columnas por extremo
    base = 0 if end.lower() == "i" else 3
    eps_hist = slab[:, base + 0]
    kz_hist  = slab[:, base + 1]
    ky_hist  = slab[:, base + 2]
    kappa    = np.maximum(np.abs(kz_hist), np.abs(ky_hist))

    # Mapea curvatura ↔ paso del pushover
    steps_pushover = dir_result.get("steps", [])
    hist_meta = dir_result.get("history", {})
    stride    = int(hist_meta.get("stride", 1))

    curve: list[dict] = []
    for i, k_val in enumerate(kappa):
        step_num = min(len(steps_pushover), int((i + 1) * stride))
        s = steps_pushover[step_num - 1] if 0 < step_num <= len(steps_pushover) else {}
        curve.append({
            "step":        step_num,
            "kappa_1_per_m": float(k_val),
            "eps_axial":   float(eps_hist[i]),
            "drift_pct":   s.get("drift_pct", 0.0),
            "base_shear_kN": s.get("base_shear_kN", 0.0),
        })

    # Daño del extremo (si ya se computó)
    hinges = dir_result.get("damage", {}).get("hinges", [])
    hinge = next((h for h in hinges if h["fid"] == str(fid) and h["end"] == end.lower()), None)

    return {
        "fid":        str(fid),
        "end":        end.lower(),
        "kind":       kind,
        "story":      el.get("story", ""),
        "lp_m":       lp,
        "b_m":        el.get("b_m"),
        "h_m":        el.get("h_m"),
        "L_m":        el.get("L_m"),
        "curve":      curve,
        "hinge":      hinge,
    }


# ──────────────────────────────────────────────────────────────────────────────
# Método N2 — punto de desempeño sobre el pushover (pórticos y muros)
# ──────────────────────────────────────────────────────────────────────────────

def _modal_participation_from_shape(
    canonical_path: str,
    modal:          dict,
    direction:      str,
) -> tuple[float, float, str]:
    """
    Calcula (Γ, m*, diagnostic) para el modo dominante en la dirección pedida
    a partir de las masas de piso del canonical y la forma modal persistida en
    `modal.viewer.mode_shapes`.

    Prueba hasta 5 modos candidatos (ordenados por Ux_pct/Uy_pct) y se queda
    con el primero cuya forma modal da un Γ razonable (|Γ| ≥ 0.5 y m* > 1 ton).

    `diagnostic` es un string legible que explica qué pasó — se usa en el
    mensaje de error del handler si todos los candidatos fallan.
    """
    if not canonical_path or not os.path.exists(canonical_path):
        return 0.0, 0.0, "canonical_model_path no existe"
    try:
        with open(canonical_path, encoding="utf-8") as f:
            canonical = json.load(f)
    except Exception as exc:
        return 0.0, 0.0, f"no fue posible leer canonical: {exc}"

    stories = canonical.get("stories", {}) or {}
    masses  = canonical.get("masses", {})  or {}

    story_mass: dict[str, tuple[float, float, float]] = {}
    total_mass_dir = 0.0
    for md in masses.values():
        s = str(md.get("story", ""))
        if not s:
            continue
        z  = float(stories.get(s, {}).get("elevation_m", 0.0))
        mx = float(md.get("mass_x_t", 0.0))
        my = float(md.get("mass_y_t", 0.0))
        story_mass[s] = (z, mx, my)
        total_mass_dir += (mx if direction == "X" else my)
    if not story_mass:
        return 0.0, 0.0, "canonical.masses está vacío"
    if total_mass_dir <= 0:
        return 0.0, 0.0, (
            f"canonical.masses no tiene masa en dirección {direction} "
            f"(todas las mass_{direction.lower()}_t son 0). Revisa el modelo."
        )

    modes_table = modal.get("modes_table") or []
    if not modes_table:
        return 0.0, 0.0, "modal.modes_table está vacío"

    viewer      = modal.get("viewer") or {}
    mode_shapes = viewer.get("mode_shapes", {}) or {}
    node_coords = viewer.get("nodes", {})       or {}
    if not mode_shapes:
        return 0.0, 0.0, "modal.viewer.mode_shapes está vacío"

    pct_key = "Ux_pct" if direction == "X" else "Uy_pct"
    dof_idx = 0 if direction == "X" else 1

    # Candidatos: top-5 modos ordenados por masa participativa decreciente
    ranked = sorted(
        range(len(modes_table)),
        key=lambda i: -float(modes_table[i].get(pct_key, 0.0) or 0.0),
    )[:5]

    attempts: list[str] = []
    for idx in ranked:
        row       = modes_table[idx]
        mode_num  = int(row.get("mode", idx + 1))
        mass_pct  = float(row.get(pct_key, 0.0) or 0.0)

        shape = mode_shapes.get(str(mode_num), {}) or {}
        if not shape:
            attempts.append(f"modo {mode_num} ({pct_key}={mass_pct:.1f}%): sin forma modal persistida")
            continue

        node_phi: list[tuple[float, float]] = []
        for tag_str, ev in shape.items():
            coord = node_coords.get(tag_str)
            if not coord or len(coord) < 3 or not ev or len(ev) < 2:
                continue
            node_phi.append((float(coord[2]), float(ev[dof_idx])))
        if not node_phi:
            attempts.append(f"modo {mode_num} ({pct_key}={mass_pct:.1f}%): sin componentes en dir {direction}")
            continue

        sum_mphi  = 0.0
        sum_mphi2 = 0.0
        for z_node, phi in node_phi:
            best_s, best_dz = None, float("inf")
            for s, (z_s, _, _) in story_mass.items():
                dz = abs(z_s - z_node)
                if dz < best_dz:
                    best_dz, best_s = dz, s
            if best_s is None:
                continue
            _, mx, my = story_mass[best_s]
            m = mx if direction == "X" else my
            if m <= 0:
                continue
            sum_mphi  += m * phi
            sum_mphi2 += m * phi * phi

        if sum_mphi2 <= 1e-12:
            attempts.append(f"modo {mode_num}: Σ(m·φ²)≈0 (forma modal plana en {direction})")
            continue

        # Normaliza la forma modal al nodo con |φ_max|=1 (Fajfar 2000 §4).
        # Divide por el valor CON SIGNO del nodo con mayor |φ|, para que el
        # modo normalizado tenga +1 en ese nodo (orientación consistente).
        phi_max_signed = max(node_phi, key=lambda t: abs(t[1]))[1]
        if abs(phi_max_signed) < 1e-12:
            attempts.append(f"modo {mode_num}: forma modal degenerada (|φ_max|≈0)")
            continue
        sum_mphi_n  = sum_mphi  / phi_max_signed
        sum_mphi2_n = sum_mphi2 / (phi_max_signed * phi_max_signed)

        gamma = sum_mphi_n / sum_mphi2_n
        m_ast = sum_mphi_n

        # Las formas modales de OpenSees están definidas salvo signo global.
        # Si Γ queda negativo (modo invertido respecto a la convención física
        # "edificio desplazándose en + hacia arriba"), se flipea el modo entero.
        # Es equivalente a cambiar φ → −φ y no altera la respuesta modal.
        if gamma < 0:
            gamma = -gamma
            m_ast = -m_ast

        # Criterios de aceptación del modo: Γ razonable y m* > 1% masa total.
        if gamma < 0.5 or m_ast < max(0.01 * total_mass_dir, 1.0):
            attempts.append(
                f"modo {mode_num} ({pct_key}={mass_pct:.1f}%): "
                f"Γ={gamma:.3f} m*={m_ast:.2f}t fuera de rango físico"
            )
            continue

        return float(gamma), float(m_ast), (
            f"modo {mode_num} aceptado (Γ={gamma:.3f}, m*={m_ast:.1f}t, "
            f"participación={mass_pct:.1f}%)"
        )

    return 0.0, 0.0, (
        f"ningún modo pasó el criterio físico para dirección {direction}. "
        f"Intentos: {' | '.join(attempts) if attempts else 'sin candidatos'}"
    )


def _run_n2_core(
    project,
    project_id:     str,
    direction:      str,
    push_filename:  str,                       # "nl_frame_pushover_results.json" | "nl_pushover_results.json"
    output_name:    str,                       # "n2_{dir}.json" | "n2_wall_{dir}.json"
    damage_counts:  "callable",                # dir_res, step_idx -> dict con conteos (hinges o pieres)
) -> dict:
    """
    Núcleo compartido del cálculo N2 (Fajfar 2000). Lee pushover + modal +
    espectro NSR-10, corre `run_n2` del engine y persiste el payload.

    `damage_counts` recibe el bloque de la dirección del pushover y el índice del
    paso ≈ D_target, y devuelve el sub-dict de conteos a embeber en `mdof_target`.
    """
    import numpy as np

    direction = direction.upper()
    if direction not in ("X", "Y"):
        raise HTTPException(400, "direction debe ser X o Y")

    if not project.canonical_model_path:
        raise HTTPException(404, "Modelo canónico no disponible")

    work_dir = os.path.dirname(os.path.dirname(project.canonical_model_path))

    # 1) Pushover
    push_path = os.path.join(work_dir, "results", push_filename)
    if not os.path.exists(push_path):
        raise HTTPException(404, "No hay resultados de pushover; córrelo antes del N2.")
    with open(push_path, encoding="utf-8") as f:
        push = json.load(f)
    dir_key = f"pushover_{direction}"
    dir_res = push.get(dir_key)
    if not dir_res or not dir_res.get("steps"):
        raise HTTPException(404, f"Pushover dirección {direction} no disponible.")
    steps = dir_res["steps"]
    dtecho = np.array([float(s.get("displacement_m", 0.0)) for s in steps], dtype=float)
    Vbasal = np.array([float(s.get("base_shear_kN",  0.0)) for s in steps], dtype=float)

    # 2) Modal — Γ y m* por dirección
    # El `structural_modal_task` (Módulo 1, que corre desde la UI) escribe en
    # `work_dir/results/modal_results.json`. El `modal_task` del Módulo 3
    # legado escribe en `settings.output_dir/{project_id}/modal/`. Probamos
    # ambas ubicaciones para máxima compatibilidad.
    from app.config import settings
    modal_candidates = [
        os.path.join(work_dir, "results", "modal_results.json"),
        os.path.join(settings.output_dir, str(project_id), "modal", "modal_results.json"),
    ]
    modal_path = next((p for p in modal_candidates if os.path.exists(p)), None)
    if modal_path is None:
        raise HTTPException(
            404,
            "No hay resultados del análisis modal. "
            "Ve a la sección 'Sísmico + Modal + Espectral' y ejecuta el modal primero.",
        )
    with open(modal_path, encoding="utf-8") as f:
        modal = json.load(f)

    # Preferencia 1: bloque `sdof` ya persistido (modal_task del Módulo 3 nuevo).
    sdof = modal.get("sdof") or {}
    dir_sdof = sdof.get(direction.lower()) or {}
    gamma_1 = dir_sdof.get("gamma")
    m_ast   = dir_sdof.get("m_ast")

    # Preferencia 2: modes_table enriquecido con gamma_x/y, m_ast_x/y por modo.
    if not gamma_1 or not m_ast or gamma_1 == 0 or m_ast == 0:
        modes_table = modal.get("modes_table") or []
        pct_key = "Ux_pct" if direction == "X" else "Uy_pct"
        g_key   = "gamma_x" if direction == "X" else "gamma_y"
        m_key   = "m_ast_x" if direction == "X" else "m_ast_y"
        candidates = [m for m in modes_table if m.get(g_key) and m.get(m_key)]
        if candidates:
            dom = max(candidates, key=lambda m: float(m.get(pct_key, 0.0) or 0.0))
            gamma_1 = float(dom.get(g_key) or 0.0)
            m_ast   = float(dom.get(m_key) or 0.0)

    # Preferencia 3 (fallback): calcular Γ y m* on-the-fly desde canonical
    # (masas por piso) + viewer.mode_shapes (forma del modo dominante). Esto
    # permite correr N2 sobre proyectos del Módulo 1 cuyo modal lineal no
    # persistió los participation factors.
    diagnostic_msg = ""
    if not gamma_1 or not m_ast or gamma_1 == 0 or m_ast == 0:
        gamma_1, m_ast, diagnostic_msg = _modal_participation_from_shape(
            project.canonical_model_path, modal, direction,
        )
        print(f"[n2] dir={direction} fallback modal: {diagnostic_msg}")

    if not gamma_1 or not m_ast or gamma_1 == 0 or m_ast == 0:
        raise HTTPException(
            400,
            f"No fue posible obtener Γ/m* para la dirección {direction}. "
            f"Diagnóstico: {diagnostic_msg or 'sin datos de participación modal'}. "
            "Si solo falla en una dirección, verifica que el edificio tenga "
            "rigidez y masa en esa dirección, y que el análisis modal haya "
            "capturado suficientes modos (mínimo 90% de masa participativa).",
        )

    # 3) Espectro NSR-10 del proyecto en m/s²
    # `project.parameters_json` es un string JSON (Text en la BD), no un dict.
    raw_params = project.parameters_json
    if isinstance(raw_params, str):
        try:
            params = json.loads(raw_params)
        except Exception:
            params = {}
    else:
        params = raw_params or {}
    Aa = float(params.get("Aa") or 0.0)
    Av = float(params.get("Av") or 0.0)
    soil = str(params.get("soil_type") or "D")
    if Aa <= 0 or Av <= 0:
        raise HTTPException(
            400,
            "Faltan parámetros sísmicos Aa/Av en el proyecto. "
            "Defínelos en la sección Sísmico antes de calcular el N2.",
        )
    from engine.seismic.spectrum import compute_spectrum
    spec = compute_spectrum(Aa, Av, soil, T_max=4.0, n_points=400)
    puntos = spec["puntos"]
    T_spec   = np.array([float(p["T"])  for p in puntos], dtype=float)
    Sa_g     = np.array([float(p["Sa"]) for p in puntos], dtype=float)
    Sa_mps2  = Sa_g * 9.81

    # 4) Factor de importancia aplicado al espectro de desempeño:
    #    el N2 se evalúa contra el espectro de DISEÑO (Sa × I), coherente con A.3.
    I = float(params.get("importance_factor") or 1.0)
    Sa_mps2 = Sa_mps2 * I

    # 5) Correr N2
    from engine.performance.n2 import run_n2
    try:
        res = run_n2(
            dtecho=dtecho, Vbasal=Vbasal,
            gamma_1=float(gamma_1), m_ast=float(m_ast),
            T_spec=T_spec, Sa_spec_mps2=Sa_mps2,
        )
    except Exception as exc:
        raise HTTPException(500, f"N2 falló: {exc}")

    # 6) Localizar paso del pushover ≈ D_target y pedir conteos de daño
    target_step_idx = int(np.argmin(np.abs(dtecho - res.D_target)))
    step_data = steps[target_step_idx] if steps else {}
    damage_block = damage_counts(dir_res, target_step_idx) or {}

    # 7) Payload
    mdof_target = {
        "D_target_m":    res.D_target,
        "pushover_step": step_data.get("step"),
        "drift_pct":     step_data.get("drift_pct"),
        "base_shear_kN": step_data.get("base_shear_kN"),
    }
    mdof_target.update(damage_block)

    payload = {
        "status":        "collapse" if res.is_collapse else "success",
        "project_id":    project_id,
        "direction":     direction,
        "spectrum": {
            "source":  "NSR-10",
            "params":  spec["params"],
            "zona":    spec.get("zona_sismica"),
            "I_factor": I,
            "T":       res.T_spec,
            "Sa_mps2": res.Sa_spec,
            "Sd_m":    res.Sd_spec,
        },
        "sdof": {
            "gamma_1":    res.gamma_1,
            "m_ast_ton":  res.m_ast,
            "T_star":     res.T_star,
            "K_star":     res.K_star,
            "Say_mps2":   res.Say,
            "Sdy_m":      res.Sdy,
            "Sa_max_mps2": res.Sa_max,
            "Sd_ultimo_m": res.Sd_ultimo,
            "idx_falla":   res.idx_falla,
            "strength_drop_found": res.strength_drop_found,
            "Tc":         res.Tc,
            "Sae_mps2":   res.Sae,
            "Sde_m":      res.Sde,
            "R_mu":       res.R_mu,
            "rule":       res.rule,
            "Sd_target_m": res.Sd_target,
            "ductility":  res.ductility,
            "is_collapse": res.is_collapse,
        },
        "capacity": {
            "Sd_m":          res.Sd_capacity,
            "Sa_mps2":       res.Sa_capacity,
            "Sd_useful_m":   res.Sd_useful,
            "Sa_useful_mps2":res.Sa_useful,
            "Sd_degraded_m": res.Sd_degraded,
            "Sa_degraded_mps2": res.Sa_degraded,
            "bilinear_sd":   res.bilinear_sd,
            "bilinear_sa":   res.bilinear_sa,
        },
        "mdof_target": mdof_target,
        "warnings":    res.warnings,
        "computed_at": datetime.now(timezone.utc).isoformat(),
    }

    out_path = os.path.join(work_dir, "results", output_name)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)

    return payload


def _hinge_damage_counts(dir_res: dict, _step_idx: int) -> dict:
    """
    Pórticos: cuenta rótulas por nivel ASCE 41 (io/ls/cp/collapse). El conteo
    reporta el máximo histórico de la curva pushover (ya persistido en el
    task), no el estado en el paso δ_target — el panel UI explica la nota.
    """
    hinges = (dir_res.get("damage") or {}).get("hinges", [])
    return {
        "n_hinges_IO":       sum(1 for h in hinges if h.get("damage_level") == "io"),
        "n_hinges_LS":       sum(1 for h in hinges if h.get("damage_level") == "ls"),
        "n_hinges_CP":       sum(1 for h in hinges if h.get("damage_level") == "cp"),
        "n_hinges_collapse": sum(1 for h in hinges if h.get("damage_level") == "collapse"),
    }


def _pier_damage_counts(dir_res: dict, _step_idx: int) -> dict:
    """
    Muros: cuenta pieres por nivel Park-Ang (none/minor/moderate/severe/collapse)
    desde `damage.pier_damage`. El UI mapea minor→IO, moderate→LS, severe→CP,
    collapse→Colapso para preservar las 4 pills comunes con pórticos.
    """
    pieres = (dir_res.get("damage") or {}).get("pier_damage", [])
    return {
        "n_piers_none":     sum(1 for p in pieres if p.get("damage_level") == "none"),
        "n_piers_minor":    sum(1 for p in pieres if p.get("damage_level") == "minor"),
        "n_piers_moderate": sum(1 for p in pieres if p.get("damage_level") == "moderate"),
        "n_piers_severe":   sum(1 for p in pieres if p.get("damage_level") == "severe"),
        "n_piers_collapse": sum(1 for p in pieres if p.get("damage_level") == "collapse"),
    }


def _get_n2_result(project, direction: str, output_name: str) -> dict:
    """Lee un N2 persistido desde `results/{output_name}` o 404."""
    if direction.upper() not in ("X", "Y"):
        raise HTTPException(400, "direction debe ser X o Y")
    if not project.canonical_model_path:
        raise HTTPException(404, "Modelo canónico no disponible")
    work_dir = os.path.dirname(os.path.dirname(project.canonical_model_path))
    path = os.path.join(work_dir, "results", output_name)
    if not os.path.exists(path):
        raise HTTPException(404, "No hay resultado N2; corre POST .../n2 primero.")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


@router.post("/{project_id}/nl-frame-pushover/{direction}/n2")
def compute_n2_frame(project_id: str, direction: str, user: CurrentUser, db: DB):
    """N2 para pórticos (consume `nl_frame_pushover_results.json`)."""
    project = _get_project(db, project_id, user)
    return _run_n2_core(
        project        = project,
        project_id     = project_id,
        direction      = direction,
        push_filename  = "nl_frame_pushover_results.json",
        output_name    = f"n2_{direction.lower()}.json",
        damage_counts  = _hinge_damage_counts,
    )


@router.get("/{project_id}/nl-frame-pushover/{direction}/n2")
def get_n2_frame(project_id: str, direction: str, user: CurrentUser, db: DB):
    project = _get_project(db, project_id, user)
    return _get_n2_result(project, direction, f"n2_{direction.lower()}.json")


@router.post("/{project_id}/nl-pushover/{direction}/n2")
def compute_n2_wall(project_id: str, direction: str, user: CurrentUser, db: DB):
    """N2 para muros (consume `nl_pushover_results.json`)."""
    project = _get_project(db, project_id, user)
    return _run_n2_core(
        project        = project,
        project_id     = project_id,
        direction      = direction,
        push_filename  = "nl_pushover_results.json",
        output_name    = f"n2_wall_{direction.lower()}.json",
        damage_counts  = _pier_damage_counts,
    )


@router.get("/{project_id}/nl-pushover/{direction}/n2")
def get_n2_wall(project_id: str, direction: str, user: CurrentUser, db: DB):
    project = _get_project(db, project_id, user)
    return _get_n2_result(project, direction, f"n2_wall_{direction.lower()}.json")


@router.get("/{project_id}/nl-frame-pushover/export/xlsx")
def export_nl_frame_pushover_xlsx(project_id: str, user: CurrentUser, db: DB):
    """Descarga XLSX con resumen + curvas + rótulas + metadata."""
    from fastapi.responses import Response
    from app.services.frame_pushover_export import build_xlsx_bytes

    project = _get_project(db, project_id, user)
    if not project.canonical_model_path:
        raise HTTPException(status_code=404, detail="Modelo canónico no disponible")

    work_dir = os.path.dirname(os.path.dirname(project.canonical_model_path))
    res_path = os.path.join(work_dir, "results", "nl_frame_pushover_results.json")
    if not os.path.exists(res_path):
        raise HTTPException(status_code=404, detail="No hay resultados de pushover de pórticos")

    with open(res_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    content = build_xlsx_bytes(data)
    filename = f"pushover_porticos_{project.name.replace(' ', '_')}.xlsx"
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ──────────────────────────────────────────────────────────────────────────────
# NLTHA — Análisis cronológico no lineal (time-history)
# ──────────────────────────────────────────────────────────────────────────────

@router.post("/{project_id}/nlth/upload-record")
async def upload_nlth_record(
    project_id: str,
    direction:  str,                     # "X" | "Y"
    user:       CurrentUser,
    db:         DB,
    file:       UploadFile = File(...),
):
    """
    Sube un archivo de registro sísmico para el NLTHA.

    Formatos soportados (autodetección):
      - PEER NGA `.at2` (header + columnas múltiples, dt embebido)
      - FEMA P-695 txt plano (una aceleración por línea)
      - CSV `(tiempo, aceleración)`

    El archivo original se guarda en `work_dir/records/record_{dir}_source.*`.
    Se genera también `work_dir/records/record_{dir}.acc` (una aceleración por
    línea) que es el que OpenSees consume. La respuesta trae preview + dt
    detectado + PGA + units hint para el panel UI.
    """
    direction = direction.upper()
    if direction not in ("X", "Y"):
        raise HTTPException(400, "direction debe ser X o Y")

    project = _get_project(db, project_id, user)
    if not project.canonical_model_path:
        raise HTTPException(404, "Modelo canónico no disponible")

    work_dir = os.path.dirname(os.path.dirname(project.canonical_model_path))
    rec_dir  = os.path.join(work_dir, "records")
    os.makedirs(rec_dir, exist_ok=True)

    # 1) Guardar el archivo original (preserva extensión para debug)
    orig_ext = os.path.splitext(file.filename or "")[1].lower() or ".txt"
    src_path   = os.path.join(rec_dir, f"record_{direction.lower()}_source{orig_ext}")
    clean_path = os.path.join(rec_dir, f"record_{direction.lower()}.acc")

    content = await file.read()
    with open(src_path, "wb") as f:
        f.write(content)

    # 2) Parsear + generar clean_path
    from app.engine.building.nonlinear.record_parser import parse_and_clean
    try:
        info = parse_and_clean(src_path, clean_path)
    except Exception as exc:
        raise HTTPException(
            400,
            f"No fue posible parsear el registro: {exc}. "
            "Formatos soportados: PEER .at2, FEMA txt, CSV (t,a).",
        )

    if info["n_samples"] < 10:
        raise HTTPException(
            400,
            f"Archivo inválido: solo {info['n_samples']} muestras detectadas.",
        )

    return {
        "ok":           True,
        "direction":    direction,
        "path":         clean_path,            # el que va al task
        "source_path":  src_path,              # original para debug
        "filename":     file.filename,
        "format":       info["format"],        # peer_at2 | fema_flat | csv_time_acc | flat_whitespace
        "n_samples":    info["n_samples"],
        "dt_detected":  info["dt_detected"],   # None si no se encontró en el header
        "duration_s":   info["duration_s"],
        "pga":          info["pga"],
        "units_hint":   info["units_hint"],    # "g" | "cm/s2" | "mps2" | None
        "header_lines": info["header_lines"],
        "description":  info["description"],
        "preview":      info["preview"],       # {t[], a[], stride}
    }


@router.get("/{project_id}/nlth/records")
def list_nlth_records(project_id: str, user: CurrentUser, db: DB):
    """Devuelve metadata de los registros X/Y que ya están en el servidor.

    Permite al panel UI pre-llenar `uploadX`/`uploadY` al montar sin exigir
    que el usuario re-suba archivos cada vez que refresca la página.

    Formato de respuesta compatible con /nlth/upload-record (misma shape que
    NLTHUploadResult) para que setUploadX/Y lo acepten directamente.
    """
    project = _get_project(db, project_id, user)
    if not project.canonical_model_path:
        raise HTTPException(404, "Modelo canónico no disponible")

    work_dir = os.path.dirname(os.path.dirname(project.canonical_model_path))
    rec_dir  = os.path.join(work_dir, "records")

    from app.engine.building.nonlinear.record_parser import parse_and_clean

    result: dict[str, dict | None] = {"X": None, "Y": None}
    for direction in ("X", "Y"):
        clean_path = os.path.join(rec_dir, f"record_{direction.lower()}.acc")
        if not os.path.exists(clean_path):
            continue
        # Re-parsear para obtener metadata (dt, pga, preview). Como ya está
        # limpio (.acc), parse_and_clean lo devuelve en formato flat.
        try:
            info = parse_and_clean(clean_path, clean_path)
        except Exception:
            result[direction] = {
                "ok": True, "direction": direction, "path": clean_path,
                "filename": f"record_{direction.lower()}.acc",
                "n_samples": None, "dt_detected": None, "pga": None,
                "duration_s": None, "preview": {"t": [], "a": [], "stride": 1},
            }
            continue
        # Buscar el nombre del archivo original para mostrar algo descriptivo
        source_filename = None
        for ext in (".at2", ".AT2", ".txt", ".csv", ".acc"):
            src = os.path.join(rec_dir, f"record_{direction.lower()}_source{ext}")
            if os.path.exists(src):
                source_filename = os.path.basename(src)
                break
        result[direction] = {
            "ok":            True,
            "direction":     direction,
            "path":          clean_path,
            "filename":      source_filename or f"record_{direction.lower()}.acc",
            "format":        info["format"],
            "n_samples":     info["n_samples"],
            "dt_detected":   info["dt_detected"],
            "duration_s":    info["duration_s"],
            "pga":           info["pga"],
            "units_hint":    info["units_hint"],
            "header_lines":  info.get("header_lines", []),
            "description":   info["description"],
            "preview":       info["preview"],
        }
    return result


class SelectLibraryPairRequest(BaseModel):
    """
    Request para `POST /{project_id}/nlth/select-library-pair`.
    Modos de escalado:
      - "manual":    usa `scale_manual` directamente (default 1.0).
      - "sa_target": usuario pasa `T1_s` + `sa_target_g` → backend calcula scale.
      - "nsr10":     backend lee el espectro NSR-10 guardado del proyecto y
                     usa Sa_NSR10(T1) como sa_target; T1 también puede venir
                     del modal result si no se envía.
    """
    pair_id:       int   = Field(..., ge=1, le=22)
    scale_mode:    str   = Field("manual", pattern="^(manual|sa_target|nsr10)$")
    scale_manual:  float = Field(1.0, gt=0, le=10.0)
    T1_s:          float | None = None
    sa_target_g:   float | None = None
    xi:            float = Field(0.05, ge=0, le=0.2)


@router.post("/{project_id}/nlth/select-library-pair")
def select_library_pair(
    project_id: str, req: SelectLibraryPairRequest,
    user: CurrentUser, db: DB,
) -> dict:
    """
    Copia los 2 archivos del par FEMA seleccionado a los paths estándar del
    proyecto (`record_x.acc`, `record_y.acc`) y calcula el factor de escala
    según el modo elegido. Devuelve metadata compatible con `upload-record`
    para que el panel pre-llene `uploadX`/`uploadY` automáticamente.
    """
    import shutil

    from app.engine.building.fema_catalog import (
        FEMA_PAIRS, compute_scale_for_pair, get_record_path, get_record_dt,
        read_record_timeseries, library_available,
    )

    if not library_available():
        raise HTTPException(503, "Biblioteca FEMA no disponible en el servidor.")

    pair = next((p for p in FEMA_PAIRS if p["pair"] == req.pair_id), None)
    if pair is None:
        raise HTTPException(404, f"Par FEMA {req.pair_id} no existe.")

    project = _get_project(db, project_id, user)
    if not project.canonical_model_path:
        raise HTTPException(404, "Modelo canónico no disponible")
    work_dir = os.path.dirname(os.path.dirname(project.canonical_model_path))
    rec_dir  = os.path.join(work_dir, "records")
    os.makedirs(rec_dir, exist_ok=True)

    # ── Resolver scale según el modo ─────────────────────────────────────────
    scale_info: dict = {"mode": req.scale_mode}
    if req.scale_mode == "manual":
        scale = float(req.scale_manual)
        scale_info["scale"] = round(scale, 5)
    elif req.scale_mode == "sa_target":
        if not req.T1_s or not req.sa_target_g:
            raise HTTPException(400, "scale_mode=sa_target requiere T1_s y sa_target_g.")
        res = compute_scale_for_pair(req.pair_id, req.T1_s, req.sa_target_g, req.xi)
        scale = res.scale
        scale_info.update({
            "T1_s":                  res.T1_s,
            "sa_target_g":           res.sa_target,
            "sa_h1_unscaled_g":      round(res.sa_h1_unscaled, 5),
            "sa_h2_unscaled_g":      round(res.sa_h2_unscaled, 5),
            "sa_geomean_unscaled_g": round(res.sa_geomean_unscaled, 5),
            "scale":                 round(res.scale, 5),
        })
    elif req.scale_mode == "nsr10":
        # Lee T1 del modal_results.json y Sa(T1) del spectral_results.json
        res_dir = os.path.join(work_dir, "results")
        modal_path    = os.path.join(res_dir, "modal_results.json")
        spectral_path = os.path.join(res_dir, "spectral_results.json")
        if not os.path.exists(modal_path):
            raise HTTPException(400, "Falta modal_results.json — corre el análisis modal antes.")
        if not os.path.exists(spectral_path):
            raise HTTPException(400, "Falta spectral_results.json — corre el análisis espectral antes.")
        with open(modal_path, encoding="utf-8") as f:
            modal = json.load(f)
        with open(spectral_path, encoding="utf-8") as f:
            spectral = json.load(f)
        T1 = req.T1_s or float(modal.get("T1") or modal.get("T1_x") or 0.0)
        if T1 <= 0:
            raise HTTPException(400, "No se pudo determinar T1 del análisis modal.")
        # Sa(T1) desde el espectro guardado: busca el más cercano en la curva.
        spectrum = spectral.get("spectrum") or {}
        T_vals  = spectrum.get("T_values")  or spectrum.get("T") or []
        Sa_vals = spectrum.get("Sa")        or spectrum.get("Sa_g") or []
        if not T_vals or not Sa_vals:
            raise HTTPException(400, "Espectro NSR-10 no encontrado en spectral_results.json.")
        import numpy as _np
        sa_nsr10 = float(_np.interp(T1, _np.asarray(T_vals), _np.asarray(Sa_vals)))
        res = compute_scale_for_pair(req.pair_id, T1, sa_nsr10, req.xi)
        scale = res.scale
        scale_info.update({
            "T1_s":                  T1,
            "sa_nsr10_g":            round(sa_nsr10, 5),
            "sa_target_g":           round(sa_nsr10, 5),
            "sa_h1_unscaled_g":      round(res.sa_h1_unscaled, 5),
            "sa_h2_unscaled_g":      round(res.sa_h2_unscaled, 5),
            "sa_geomean_unscaled_g": round(res.sa_geomean_unscaled, 5),
            "scale":                 round(res.scale, 5),
        })
    else:
        raise HTTPException(400, f"scale_mode desconocido: {req.scale_mode}")

    # ── Copiar los 2 archivos al workspace ───────────────────────────────────
    gm_h1, gm_h2 = pair["files"]
    results = {}
    for direction, gm_name in (("X", gm_h1), ("Y", gm_h2)):
        src = get_record_path(gm_name)
        dst_clean  = os.path.join(rec_dir, f"record_{direction.lower()}.acc")
        dst_source = os.path.join(rec_dir, f"record_{direction.lower()}_source.txt")
        shutil.copy(src, dst_clean)
        shutil.copy(src, dst_source)
        preview = read_record_timeseries(gm_name, max_points=600)
        dt_rec   = get_record_dt(gm_name)
        pga      = preview["pga"]
        duration = preview["duration_s"]
        results[direction] = {
            "ok":           True,
            "direction":    direction,
            "path":         dst_clean,
            "source_path":  dst_source,
            "filename":     f"FEMA par {pair['pair']:02d} — {pair['earthquake']} "
                            f"({pair['year']}, Mw {pair['mw']}, {pair['station']}) · {gm_name}",
            "format":       "fema_flat",
            "n_samples":    preview["n_full"],
            "dt_detected":  dt_rec,
            "duration_s":   duration,
            "pga":          pga,
            "units_hint":   "g",
            "header_lines": [],
            "description":  f"FEMA P-695 Far-Field — par {pair['pair']}, {gm_name}",
            "preview":      {"t": preview["t"], "a": preview["a"],
                             "stride": max(1, preview["n_full"] // 600)},
            "fema_pair_id":  pair["pair"],
            "fema_gm_name":  gm_name,
        }

    return {
        "pair":        {
            "pair_id":    pair["pair"],
            "earthquake": pair["earthquake"],
            "year":       pair["year"],
            "mw":         pair["mw"],
            "station":    pair["station"],
            "rrup_km":    pair["rrup_km"],
            "files":      pair["files"],
        },
        "scale":    round(scale, 5),
        "scale_info": scale_info,
        "upload_x": results["X"],
        "upload_y": results["Y"],
    }


@router.get("/{project_id}/modal/result")
def get_modal_result(project_id: str, user: CurrentUser, db: DB):
    """Último `modal_results.json` del proyecto (si existe)."""
    project = _get_project(db, project_id, user)
    if not project.canonical_model_path:
        raise HTTPException(404, "Modelo canónico no disponible")
    work_dir = os.path.dirname(os.path.dirname(project.canonical_model_path))
    path = os.path.join(work_dir, "results", "modal_results.json")
    if not os.path.exists(path):
        raise HTTPException(404, "No hay resultados modales.")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


@router.get("/{project_id}/spectral/result")
def get_spectral_result(project_id: str, user: CurrentUser, db: DB):
    """Último `spectral_results.json` del proyecto (incluye espectro NSR-10)."""
    project = _get_project(db, project_id, user)
    if not project.canonical_model_path:
        raise HTTPException(404, "Modelo canónico no disponible")
    work_dir = os.path.dirname(os.path.dirname(project.canonical_model_path))
    path = os.path.join(work_dir, "results", "spectral_results.json")
    if not os.path.exists(path):
        raise HTTPException(404, "No hay resultados espectrales.")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


@router.get("/{project_id}/nlth/result")
def get_nlth_result(project_id: str, user: CurrentUser, db: DB):
    """Devuelve el último `nlth_results.json` persistido."""
    project = _get_project(db, project_id, user)
    if not project.canonical_model_path:
        raise HTTPException(404, "Modelo canónico no disponible")
    work_dir = os.path.dirname(os.path.dirname(project.canonical_model_path))
    path = os.path.join(work_dir, "results", "nlth_results.json")
    if not os.path.exists(path):
        raise HTTPException(404, "No hay resultados NLTHA. Lanza un job primero.")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


@router.get("/{project_id}/nlth/jobs")
def list_nlth_jobs(project_id: str, user: CurrentUser, db: DB):
    """Historial de análisis NLTH del proyecto.

    Lee cada `nlth/<job_id>/meta.json` (liviano, ~1 KB) para evitar cargar el
    JSON completo del resultado. Devuelve ordenado por fecha descendente.
    """
    project = _get_project(db, project_id, user)
    if not project.canonical_model_path:
        raise HTTPException(404, "Modelo canónico no disponible")
    work_dir = os.path.dirname(os.path.dirname(project.canonical_model_path))
    jobs_dir = os.path.join(work_dir, "nlth")
    if not os.path.isdir(jobs_dir):
        return {"jobs": []}

    out: list[dict] = []
    for name in os.listdir(jobs_dir):
        meta_file = os.path.join(jobs_dir, name, "meta.json")
        if not os.path.isfile(meta_file):
            continue
        try:
            with open(meta_file, encoding="utf-8") as f:
                meta = json.load(f)
            meta["has_history_npz"] = os.path.isfile(
                os.path.join(jobs_dir, name, "nlth_history.npz")
            )
            out.append(meta)
        except Exception as e:
            out.append({
                "job_id": name, "status": "parse_error", "error": str(e),
            })
    out.sort(key=lambda m: m.get("computed_at", ""), reverse=True)
    return {"jobs": out}


@router.get("/{project_id}/nlth/result/{job_id}")
def get_nlth_result_by_job(
    project_id: str, job_id: str, user: CurrentUser, db: DB,
):
    """Devuelve el `nlth_results.json` de un job histórico específico."""
    project = _get_project(db, project_id, user)
    if not project.canonical_model_path:
        raise HTTPException(404, "Modelo canónico no disponible")
    work_dir = os.path.dirname(os.path.dirname(project.canonical_model_path))
    path = os.path.join(work_dir, "nlth", job_id, "nlth_results.json")
    if not os.path.exists(path):
        raise HTTPException(404, f"NLTH job {job_id} no encontrado")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


@router.post("/{project_id}/nlth/activate/{job_id}")
def activate_nlth_job(
    project_id: str, job_id: str, user: CurrentUser, db: DB,
):
    """Copia un job histórico al shim `results/` para que los módulos que leen
    "el último" (verificador, export XLSX, diagnóstico por elemento) operen
    sobre este análisis específico. No borra nada — solo re-apunta el shim.
    """
    project = _get_project(db, project_id, user)
    if not project.canonical_model_path:
        raise HTTPException(404, "Modelo canónico no disponible")
    work_dir   = os.path.dirname(os.path.dirname(project.canonical_model_path))
    src_json   = Path(work_dir) / "nlth" / job_id / "nlth_results.json"
    src_npz    = Path(work_dir) / "nlth" / job_id / "nlth_history.npz"
    if not src_json.exists():
        raise HTTPException(404, f"NLTH job {job_id} no encontrado")
    res_dir = Path(work_dir) / "results"
    res_dir.mkdir(parents=True, exist_ok=True)
    (res_dir / "nlth_results.json").write_bytes(src_json.read_bytes())
    if src_npz.exists():
        (res_dir / "nlth_history.npz").write_bytes(src_npz.read_bytes())
    return {"ok": True, "activated_job_id": job_id}


@router.delete("/{project_id}/nlth/{job_id}")
def delete_nlth_job(
    project_id: str, job_id: str, user: CurrentUser, db: DB,
):
    """Borra un análisis NLTH del historial (carpeta `nlth/<job_id>/` + DB)."""
    project = _get_project(db, project_id, user)
    if not project.canonical_model_path:
        raise HTTPException(404, "Modelo canónico no disponible")
    work_dir = os.path.dirname(os.path.dirname(project.canonical_model_path))
    job_dir  = Path(work_dir) / "nlth" / job_id
    if not job_dir.exists():
        raise HTTPException(404, f"NLTH job {job_id} no encontrado")
    import shutil as _shutil
    _shutil.rmtree(job_dir, ignore_errors=True)
    # También marcar el StructuralJob en DB (si existe) para que no aparezca
    # en otras listas. No borramos el registro completo por auditoría.
    db_job = db.get(StructuralJob, job_id)
    if db_job is not None:
        db_job.result_path = None
        db.commit()
    return {"ok": True, "deleted_job_id": job_id}


class NLTHImportRequest(BaseModel):
    """Bundle NLTH exportado desde otro proyecto / sesión (Fase 2 export/import).

    Acepta tanto el formato bundle (`{export_meta, result}`) como el payload
    crudo (`NLTHResult`): se detecta por la presencia del campo `envelope`.
    """
    export_meta: dict | None = None
    result:      dict | None = None
    # Compatibilidad con payload crudo
    envelope:    dict | None = None


@router.post("/{project_id}/nlth/import")
def import_nlth_bundle(
    project_id: str,
    payload:    NLTHImportRequest,
    user:       CurrentUser,
    db:         DB,
):
    """Persiste un bundle JSON NLTH exportado como un job real del proyecto.

    Flujo:
      1. Detecta si es bundle o payload crudo.
      2. Genera nuevo `job_id`, crea `work_dir/nlth/<job_id>/` con
         `nlth_results.json` + `meta.json` (derivado del payload).
      3. Crea StructuralJob(analysis_type=nlth, status=success) marcado como
         `imported=true`. No persiste `.npz` (el bundle solo lleva el summary).
      4. Devuelve `job_id` y status 201 para que el cliente navegue al nuevo job.
    """
    import uuid
    from datetime import datetime, timezone

    project = _get_project(db, project_id, user)
    if not project.canonical_model_path:
        raise HTTPException(404, "Modelo canónico no disponible")
    work_dir = os.path.dirname(os.path.dirname(project.canonical_model_path))

    # ── Normalizar payload ──
    body = payload.model_dump(exclude_none=True)
    export_meta = body.get("export_meta") or {}
    if "result" in body and isinstance(body["result"], dict):
        result = body["result"]
    elif "envelope" in body:
        result = {k: v for k, v in body.items() if k not in ("export_meta",)}
    else:
        raise HTTPException(400, "Bundle inválido: no se encontró ni `result` ni `envelope`.")

    env = result.get("envelope") or {}
    if not env:
        raise HTTPException(400, "El payload no contiene `envelope` — no es un NLTHResult válido.")

    # ── Persistir en work_dir/nlth/<job_id>/ ──
    job_id = str(uuid.uuid4())
    job_dir = Path(work_dir) / "nlth" / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    (job_dir / "nlth_results.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8",
    )

    # Derivar meta.json liviano a partir del result (mismo shape que al correr)
    now_iso = datetime.now(timezone.utc).isoformat()
    meta = {
        "job_id":       job_id,
        "project_id":   project.id,
        "status":       "success",
        "imported":     True,
        "source":       export_meta.get("exporter") or "external_bundle",
        "exported_at":  export_meta.get("exported_at"),
        "record_x":     export_meta.get("record_x") or env.get("record_x"),
        "record_y":     export_meta.get("record_y") or env.get("record_y"),
        "scale":        export_meta.get("scale")    or env.get("scale"),
        "dtrec":        env.get("dtrec"),
        "max_drift_pct": env.get("max_drift_pct"),
        "residual_drift_pct": env.get("residual_drift_pct"),
        "pga_vector_g":  env.get("pga_vector_g"),
        "Vb_peak_kN":    env.get("Vb_peak_kN"),
        "computed_at":   now_iso,
    }
    (job_dir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8",
    )

    # ── Crear StructuralJob en DB ──
    job = StructuralJob(
        id             = job_id,
        project_id     = project.id,
        owner_id       = user.id,
        analysis_type  = StructuralAnalysisType.nlth,
        status         = StructuralJobStatus.success,
        result_path    = str(job_dir / "nlth_results.json"),
        progress_json  = {
            "stage":     "imported",
            "imported":  True,
            "export_meta": export_meta,
        },
        finished_at    = datetime.now(timezone.utc),
    )
    db.add(job); db.commit(); db.refresh(job)

    return {
        "ok":      True,
        "job_id":  job.id,
        "meta":    meta,
        "message": (
            f"Bundle NLTH importado como job {job.id[:8]}… "
            f"(registro={meta['record_x'] or '?'}, scale={meta['scale']})"
        ),
    }


# ── Umbrales editables para re-evaluación del cronológico ────────────────────

class RecomputeEventsRequest(BaseModel):
    """
    Umbrales globales que sobrescriben los calculados por elemento. Todos
    opcionales — una clave ausente conserva el valor del spec/geometría.
    """
    eps_sy:       float | None = None   # fluencia del acero (ε_sy = fy/E)
    eps_cu_cover: float | None = None   # aplastamiento del recubrimiento
    eps_cu_core:  float | None = None   # aplastamiento del núcleo confinado
    eps_su:       float | None = None   # fractura por tensión del acero
    eps_bk:       float | None = None   # pandeo del refuerzo longitudinal


def _nlth_paths(project: StructuralProject) -> tuple[str, str, str]:
    """Devuelve (work_dir, nlth_results.json, nlth_history.npz)."""
    if not project.canonical_model_path:
        raise HTTPException(404, "Modelo canónico no disponible")
    work_dir = os.path.dirname(os.path.dirname(project.canonical_model_path))
    return (
        work_dir,
        os.path.join(work_dir, "results", "nlth_results.json"),
        os.path.join(work_dir, "results", "nlth_history.npz"),
    )


@router.get("/{project_id}/nlth/thresholds-meta")
def get_nlth_thresholds_meta(project_id: str, user: CurrentUser, db: DB):
    """Defaults globales + rangos observados por elemento (para poblar sliders)."""
    from app.engine.building.nonlinear.event_detector import (
        build_elements_meta, default_thresholds, observed_threshold_ranges,
    )
    project = _get_project(db, project_id, user)
    _work_dir, result_path, _hist_path = _nlth_paths(project)
    if not os.path.exists(result_path):
        raise HTTPException(404, "No hay resultados NLTHA. Lanza un job primero.")
    with open(result_path, encoding="utf-8") as f:
        result = json.load(f)
    element_lines = result.get("element_lines") or []
    spec_path = _ensure_nonlinear_spec(project)
    with open(spec_path, encoding="utf-8") as f:
        spec = json.load(f)
    elements_meta = build_elements_meta(spec, element_lines)
    return {
        "defaults":            default_thresholds(),
        "observed":            observed_threshold_ranges(elements_meta),
        "user_override":       result.get("events", {}).get("thresholds_user_override", {}),
        "n_elements_detected": len(elements_meta),
    }


@router.post("/{project_id}/nlth/recompute-events")
def recompute_nlth_events(
    project_id: str, req: RecomputeEventsRequest, user: CurrentUser, db: DB,
):
    """
    Re-ejecuta el detector de eventos locales sobre el NPZ existente con los
    umbrales dados y actualiza `nlth_results.json`. No re-corre el NLTHA — solo
    reclasifica el estado de daño de cada elemento. Toma segundos.
    """
    from app.engine.building.nonlinear.event_detector import detect_events_nlth

    project = _get_project(db, project_id, user)
    _work_dir, result_path, hist_path = _nlth_paths(project)
    if not os.path.exists(result_path):
        raise HTTPException(404, "No hay resultados NLTHA. Lanza un job primero.")
    if not os.path.exists(hist_path):
        raise HTTPException(404, "nlth_history.npz no encontrado. "
                            "Relanza el NLTHA con el motor actual para persistir sect_def.")

    with open(result_path, encoding="utf-8") as f:
        result = json.load(f)
    element_lines = result.get("element_lines") or []
    if not element_lines:
        raise HTTPException(400, "El resultado NLTHA no persistió element_lines; relanzarlo.")

    spec_path = _ensure_nonlinear_spec(project)
    with open(spec_path, encoding="utf-8") as f:
        spec = json.load(f)

    override = {k: v for k, v in req.model_dump().items() if v is not None}
    ev = detect_events_nlth(
        npz_path=hist_path, spec=spec, element_lines=element_lines,
        thresholds_override=override,
    )
    result["events"] = ev
    result["events_recomputed_at"] = datetime.now(timezone.utc).isoformat()

    with open(result_path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)

    return {
        "status":   ev.get("status", "unknown"),
        "events":   ev,
        "n_events": len(ev.get("events", [])),
    }


@router.post("/{project_id}/nlth/recompute-failure-modes")
def recompute_failure_modes(project_id: str, user: CurrentUser, db: DB):
    """
    Clasifica cada columna por modo de falla combinando:
      1. Predicción ASCE 41-17 §10.3 (Vp/Vn desde element_thresholds.json).
      2. Rótulas observadas durante el NLTHA (damage.hinges).
      3. Demanda real: M(t) por extremo (M-φ bilineal) + V(t) por equilibrio
         doble curvatura — desde `sect_def` del NPZ. Permite verificar si la
         capacidad Mp o Vn fue efectivamente superada por el sismo.

    No re-corre análisis.
    """
    import numpy as _np
    from app.engine.building.nonlinear.failure_classification import (
        classify_frame_failure_modes, compute_demand_dcr_per_column,
    )
    project = _get_project(db, project_id, user)
    _work_dir, result_path, hist_path = _nlth_paths(project)
    if not os.path.exists(result_path):
        raise HTTPException(404, "No hay resultados NLTHA. Lanza un job primero.")

    with open(result_path, encoding="utf-8") as f:
        result = json.load(f)

    wd = _project_work_dir(project)
    et_path = wd / "nonlinear" / "element_thresholds.json"
    if not et_path.exists():
        raise HTTPException(
            422,
            "Falta `element_thresholds.json` (Fase 7). "
            "Corre `/element-thresholds` antes de clasificar el modo de falla.",
        )
    with open(et_path, encoding="utf-8") as f:
        et = json.load(f)
    rows = et.get("rows") or []

    # Umbrales por fid (para M-φ bilineal).
    thresholds_by_fid = {
        str(r.get("fid")): r for r in rows if r.get("kind") == "column"
    }

    # Demanda real desde sect_def del NPZ (si existe).
    demand_by_fid: dict = {}
    try:
        if os.path.exists(hist_path):
            with _np.load(hist_path, allow_pickle=False) as data:
                if "sect_def" in data.files and "sect_tags" in data.files:
                    sect_def  = _np.asarray(data["sect_def"], dtype=_np.float32)
                    sect_tags = [int(t) for t in data["sect_tags"].tolist()]
                    element_lines = result.get("element_lines") or []
                    joints_ref = ((result.get("history") or {}).get("joints_ref")
                                   or result.get("joints_ref") or {})
                    if not joints_ref:
                        # Fallback: pedir al pushover history la geometría.
                        from app.engine.building.nonlinear.nl_frame_ops_builder import (
                            NLFrameOPSBuilder,
                        )
                        # Si no tenemos joints_ref persistido, usamos distancia
                        # L_col = altura del piso del canonical.
                        canonical_path = project.canonical_model_path
                        if canonical_path and os.path.exists(canonical_path):
                            with open(canonical_path, encoding="utf-8") as fc:
                                canonical = json.load(fc)
                            joints_ref = {
                                str(nid): [float(j.get("x", 0)), float(j.get("y", 0)),
                                            float(j.get("z", 0))]
                                for nid, j in (canonical.get("joints") or {}).items()
                            }
                    demand_by_fid = compute_demand_dcr_per_column(
                        sect_def=sect_def, sect_tags=sect_tags,
                        element_lines=element_lines, joints_ref=joints_ref,
                        thresholds_by_fid=thresholds_by_fid,
                    )
    except Exception as e_dem:
        print(f"[WARN] no se pudo calcular demanda: {e_dem}")

    hinges = ((result.get("damage") or {}).get("hinges")) or []
    classification = classify_frame_failure_modes(
        element_thresholds_rows=rows, hinges=hinges,
        demand_by_fid=demand_by_fid,
    )
    result["failure_modes"] = classification
    result["failure_modes_recomputed_at"] = datetime.now(timezone.utc).isoformat()

    with open(result_path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)

    return {
        "status":          classification.get("status", "unknown"),
        "counts":          classification.get("counts", {}),
        "n_total":         classification.get("n_total", 0),
        "failure_modes":   classification,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Ola 7 — Diagnóstico post-NLTH del elemento patológico + recomendaciones
# ─────────────────────────────────────────────────────────────────────────────
def _resolve_demand_for_fid(
    result: dict,
    fid: str,
) -> tuple[float, float | None]:
    """Busca demanda θ_p_max y V_max para un fid en nlth_results.json.

    Orden de preferencia:
      1. damage.hinges (del event detector) — contiene theta_p_max por rótula.
      2. health.pathological_ranking — contiene theta_p_max y strain axial.
      3. fallback: 0.
    """
    theta_demand = 0.0
    V_demand: float | None = None

    damage = (result.get("damage") or {})
    for h in damage.get("hinges", []) or []:
        if str(h.get("fid", "")) == str(fid):
            tp = float(h.get("theta_p_max", 0.0) or 0.0)
            if tp > theta_demand:
                theta_demand = tp
            v = h.get("V_max_kN") or h.get("V_demand_kN")
            if v is not None:
                try:
                    V_demand = float(v)
                except (TypeError, ValueError):
                    pass

    if theta_demand <= 0.0:
        health = result.get("health") or {}
        pe = health.get("pathological_element") or {}
        if str(pe.get("fid", "")) == str(fid):
            theta_demand = float(pe.get("theta_p_max", 0.0) or 0.0)
        else:
            for row in health.get("pathological_ranking", []) or []:
                if str(row.get("fid", "")) == str(fid):
                    theta_demand = float(row.get("theta_p_max", 0.0) or 0.0)
                    break

    return theta_demand, V_demand


def _build_element_data(project: StructuralProject, fid: str):
    """Reconstruye ElementData para un fid desde el spec actual.

    Devuelve (el, spec_confinement) listos para diagnose_element.
    """
    from engine.building.nonlinear import elements_from_spec, load_axial_from_gravity, load_observations_csv
    spec_path = _ensure_nonlinear_spec(project)
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    wd = _project_work_dir(project)
    axial = load_axial_from_gravity(wd / "nonlinear" / "axial_from_gravity.json")
    obs   = load_observations_csv(wd / "nonlinear" / "observations.csv")
    elements = elements_from_spec(spec, axial_json=axial, observations=obs)
    el = elements.get(str(fid))
    if el is None:
        raise HTTPException(
            404, detail=f"Elemento fid={fid} no encontrado en nonlinear_model.json. "
                         "Verifica que el modelo esté construido."
        )
    kind_key = "columns" if el.kind == "column" else "beams"
    spec_el = spec.get("elements", {}).get(kind_key, {}).get(str(fid), {})
    conf = spec_el.get("confinement", {}) or {}
    spec_conf = conf.get("end", conf.get("mid"))
    return el, spec_conf


@router.get("/{project_id}/nlth/element-diagnosis/{fid}")
def get_element_diagnosis(
    project_id: str,
    fid:        str,
    user:       CurrentUser,
    db:         DB,
    theta_demand_override: float | None = None,
    V_demand_kN_override:  float | None = None,
    method:     str = "haselton",
):
    """Diagnóstico completo de un elemento + recomendaciones de refuerzo.

    Toma demanda del último `nlth_results.json` (damage.hinges o pathological
    element). El usuario puede override con query params para explorar
    escenarios hipotéticos.

    Returns:
        ElementDiagnosis.to_dict() — ver reinforcement_recommender.py.
    """
    from engine.building.nonlinear import diagnose_element

    project = _get_project(db, project_id, user)
    _work_dir, result_path, _hist_path = _nlth_paths(project)

    theta_demand = float(theta_demand_override or 0.0)
    V_demand = V_demand_kN_override

    if theta_demand <= 0.0 and os.path.exists(result_path):
        with open(result_path, encoding="utf-8") as f:
            result = json.load(f)
        theta_demand, v_from_result = _resolve_demand_for_fid(result, fid)
        if V_demand is None:
            V_demand = v_from_result

    el, spec_conf = _build_element_data(project, fid)

    try:
        diag = diagnose_element(
            el=el,
            theta_demand=theta_demand,
            V_demand_kN=V_demand,
            method=method,  # type: ignore[arg-type]
            spec_conf=spec_conf,
        )
    except Exception as exc:
        raise HTTPException(500, detail=f"Error al diagnosticar: {type(exc).__name__}: {exc}")

    return diag.to_dict()


class ApplyReinforcementFixRequest(BaseModel):
    fid:        str
    action_id:  str           # ActionId de ReinforcementOption
    changes:    dict          # payload "changes" del ReinforcementOption aplicado
    notes:      str | None = None


@router.post("/{project_id}/nlth/apply-reinforcement-fix")
def apply_reinforcement_fix(
    project_id: str,
    payload:    ApplyReinforcementFixRequest,
    user:       CurrentUser,
    db:         DB,
):
    """Persiste un override de refuerzo para un elemento en `reinforcement.json`.

    Mergea `payload.changes` dentro del subdiccionario `reinforcement` del fid.
    Al escribir el archivo se invalida `nonlinear_model.json` — el próximo
    pushover/NLTH lo regenera con los nuevos valores.
    """
    from app.routers.structural_design import _load_reinforcement, _save_reinforcement
    project = _get_project(db, project_id, user)

    saved = _load_reinforcement(project)
    entry = saved.get(payload.fid, {}) or {}
    existing_reinf = entry.get("reinforcement") or {}

    # Merge superficial por subsección (longitudinal / transverse / shear / detailing)
    merged = dict(existing_reinf)
    for section_key, section_vals in payload.changes.items():
        if isinstance(section_vals, dict):
            cur = dict(merged.get(section_key) or {})
            cur.update(section_vals)
            merged[section_key] = cur
        else:
            merged[section_key] = section_vals

    saved[payload.fid] = {
        "reinforcement": merged,
        "notes":         payload.notes or f"Fix {payload.action_id} aplicado por Ola 7",
        "saved_at":      datetime.now(timezone.utc).isoformat(),
        "source":        "ola7_diagnosis",
        "action_id":     payload.action_id,
        "pattern_label": None,
        "bulk_batch_id": None,
    }
    _save_reinforcement(project, saved)

    return {
        "saved":      True,
        "fid":        payload.fid,
        "action_id":  payload.action_id,
        "message":    f"Fix aplicado a {payload.fid}. Relanza el NLTH para verificar.",
    }


# ─────────────────────────────────────────────────────────────────────────────
# IDA — Incremental Dynamic Analysis sobre biblioteca FEMA P-695
# ─────────────────────────────────────────────────────────────────────────────
class IDALaunchRequest(BaseModel):
    """Lanzamiento de IDA: N pares × M niveles de Sa."""
    pair_ids:       list[int]
    sa_min:         float            # g
    sa_max:         float            # g
    n_levels:       int              # niveles de Sa
    T1_s:           float            # período fundamental para escalado
    system:         str  = "frames"  # frames | walls
    damping:        float = 0.05
    dt_analysis:    float = 0.005
    spacing:        str   = "linear" # linear | log
    collapse_mode:  str   = "ductile"
    # Fuente de registros: "fema" (22 pares FEMA P-695) o clave de campaña
    # local p.ej. "colombia_2026_08_10" (Sismo San José del Palmar).
    catalog_source: str   = "fema"


@router.post("/{project_id}/ida/launch", status_code=202)
def launch_ida(
    project_id: str,
    payload:    IDALaunchRequest,
    user:       CurrentUser,
    db:         DB,
):
    """Lanza un IDA: encola N_pares × N_niveles NLTHA livianos en paralelo.

    El orquestador vive en Celery como `run_ida`; usa `chord` para consolidar
    automáticamente al terminar todos los hijos en un `ida_results.json` con
    curvas IM-EDP por par + percentiles 16/50/84 + Sa mediana de colapso.
    """
    from app.tasks.structural_ida_task import run_ida_task
    import uuid

    project = _get_project(db, project_id, user)

    if not payload.pair_ids:
        raise HTTPException(400, "Selecciona al menos un par FEMA.")
    if payload.n_levels < 2:
        raise HTTPException(400, "n_levels debe ser ≥ 2.")
    if payload.T1_s <= 0:
        raise HTTPException(400, "T1_s debe ser > 0 (corre modal primero).")
    if payload.sa_max <= payload.sa_min:
        raise HTTPException(400, "sa_max debe ser > sa_min.")

    # Crear job IDA en la DB
    params = payload.model_dump()
    job = StructuralJob(
        id             = str(uuid.uuid4()),
        project_id     = project.id,
        owner_id       = user.id,
        analysis_type  = StructuralAnalysisType.ida,
        status         = StructuralJobStatus.pending,
        progress_json  = {"stage": "pending", "params": params},
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    # Lanzar orquestador (params van vía argumentos al task, no al modelo DB)
    task = run_ida_task.delay(
        job_id=job.id,
        project_id=project.id,
        parameters_dict=params,
    )
    job.celery_task_id = task.id
    db.commit()

    return {
        "job_id":      job.id,
        "celery_id":   task.id,
        "pair_ids":    payload.pair_ids,
        "n_levels":    payload.n_levels,
        "n_total":     len(payload.pair_ids) * payload.n_levels,
        "status":      "dispatched",
        "message":     f"IDA lanzado: {len(payload.pair_ids)} pares × {payload.n_levels} niveles.",
    }


@router.get("/{project_id}/ida/result")
def get_ida_result(project_id: str, user: CurrentUser, db: DB):
    """Devuelve el último `ida_results.json` consolidado (el más reciente por
    `finished_at`). Si ningún IDA ha terminado, 404.
    """
    project = _get_project(db, project_id, user)

    jobs = (
        db.query(StructuralJob)
        .filter(StructuralJob.project_id == project.id)
        .filter(StructuralJob.analysis_type == StructuralAnalysisType.ida)
        .filter(StructuralJob.status == StructuralJobStatus.success)
        .order_by(StructuralJob.finished_at.desc())
        .limit(1)
        .all()
    )
    if not jobs or not jobs[0].result_path:
        raise HTTPException(404, "Ningún IDA completado todavía.")

    path = jobs[0].result_path
    if not os.path.exists(path):
        raise HTTPException(404, f"ida_results.json no encontrado en {path}")
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    data["job_id"] = jobs[0].id
    return data


@router.get("/{project_id}/ida/progress/{job_id}")
def get_ida_progress(project_id: str, job_id: str, user: CurrentUser, db: DB):
    """Devuelve progreso del IDA (contado de results persistidos / total)."""
    project = _get_project(db, project_id, user)
    job = db.get(StructuralJob, job_id)
    if not job or job.project_id != project.id:
        raise HTTPException(404, "Job IDA no encontrado.")
    if job.analysis_type != StructuralAnalysisType.ida:
        raise HTTPException(400, f"Job {job_id} no es un IDA.")

    if not project.canonical_model_path:
        raise HTTPException(404, "Modelo canónico no disponible")
    work_dir = os.path.dirname(os.path.dirname(project.canonical_model_path))
    results_dir = os.path.join(work_dir, "ida", job.id, "results")

    n_done = 0
    if os.path.isdir(results_dir):
        n_done = sum(1 for f in os.listdir(results_dir) if f.startswith("pair_") and f.endswith(".json"))

    meta_path = os.path.join(work_dir, "ida", job.id, "meta.json")
    n_total = 0
    meta = None
    if os.path.exists(meta_path):
        try:
            with open(meta_path, encoding="utf-8") as f:
                meta = json.load(f)
            n_total = int(meta.get("total_runs", 0))
        except Exception:
            pass

    pct = (n_done / n_total * 100.0) if n_total > 0 else 0.0

    return {
        "job_id":    job.id,
        "status":    job.status.value if hasattr(job.status, "value") else str(job.status),
        "n_done":    n_done,
        "n_total":   n_total,
        "pct":       round(pct, 1),
        "progress":  job.progress_json,
        "meta":      meta,
    }


@router.get("/{project_id}/ida/jobs")
def list_ida_jobs(project_id: str, user: CurrentUser, db: DB):
    """Lista los jobs IDA del proyecto (para dropdown en UI)."""
    project = _get_project(db, project_id, user)
    jobs = (
        db.query(StructuralJob)
        .filter(StructuralJob.project_id == project.id)
        .filter(StructuralJob.analysis_type == StructuralAnalysisType.ida)
        .order_by(StructuralJob.created_at.desc())
        .all()
    )
    return [
        {
            "job_id":        j.id,
            "status":        j.status.value if hasattr(j.status, "value") else str(j.status),
            "created_at":    j.created_at.isoformat() if j.created_at else None,
            "finished_at":   j.finished_at.isoformat() if j.finished_at else None,
            "params":        (j.progress_json or {}).get("params") if isinstance(j.progress_json, dict) else None,
            "result_summary": j.result_summary,
        }
        for j in jobs
    ]


# ─────────────────────────────────────────────────────────────────────────────
# NLRHA — Nonlinear Response History Analysis (ASCE 7-22 Cap 16 / NSR-10 A.5.4.6)
#
# Diferencia operativa con IDA:
#   IDA   = barrido de Sa (Sa_min → Sa_max, varios niveles) para investigación
#           (Sa mediana de colapso, fragilidad, FEMA P-695).
#   NLRHA = UN solo nivel Sa_target = Sa_NSR-10(T1, ciudad, suelo) · I · MCE_mult,
#           para verificación del edificio ante el sismo de código.
#
# Para no duplicar pipeline, reutiliza `run_ida_task` con `n_levels=1`
# (ya soportado en `_sa_grid`). El job queda como `analysis_type=ida` pero
# `progress_json.mode="nlrha"` lo distingue en los listados.
# ─────────────────────────────────────────────────────────────────────────────

# NSR-10 A.2.5.2 — coeficiente de importancia por grupo de uso
_NSR10_IMPORTANCE: dict[str, float] = {"I": 1.0, "II": 1.0, "III": 1.25, "IV": 1.5}

# Límites de deriva (NSR-10 A.6.4.2 edificaciones de concreto / ASCE 7-22 §16.4)
_NSR10_DRIFT_LIMIT_MEAN_PCT = 1.0   # deriva promedio
_NSR10_DRIFT_LIMIT_MAX_PCT  = 1.5   # overshoot permitido para P84


class NLRHALaunchRequest(BaseModel):
    """Lanzamiento NLRHA: N pares escalados al Sa de código."""
    pair_ids:        list[int]
    Aa:              float = Field(..., gt=0,  le=0.5,  description="A.2.3 coef. aceleración pico efectiva")
    Av:              float = Field(..., gt=0,  le=0.5,  description="A.2.3 coef. velocidad")
    soil_type:       str   = Field(..., pattern=r"^[A-E]$", description="Perfil A-E (F requiere estudio especial)")
    use_group:       str   = Field("II", pattern=r"^(I|II|III|IV)$")
    T1_s:            float = Field(..., gt=0,  le=10.0)
    mce_multiplier:  float = Field(1.0, ge=1.0, le=1.5, description="1.0 SDE · 1.5 MCE_R")
    system:          str   = "frames"
    damping:         float = 0.05
    dt_analysis:     float = 0.005
    # Mismo contrato que IDA
    catalog_source:  str   = "fema"


def _nsr10_sa_at_T(Aa: float, Av: float, soil_type: str, T_s: float) -> dict:
    """Sa(T) de código NSR-10 + parámetros SDs/SD1/T0/Ts/TL/Fa/Fv."""
    from engine.seismic.spectrum import get_site_factors, spectral_parameters, _sa_at_T
    Fa, Fv = get_site_factors(Aa, Av, soil_type)
    p = spectral_parameters(Aa, Av, Fa, Fv)
    Sa = _sa_at_T(T_s, p["SDs"], p["SD1"], p["T0"], p["Ts"], p["TL"])
    return {"Sa_g": float(Sa), "Fa": Fa, "Fv": Fv, **p}


def _verify_nsr10_drift_limit(ida_result: dict) -> dict:
    """Evalúa cumplimiento de Δ ≤ 1 % NSR-10 A.6.4.2 sobre el perfil P50/P84."""
    stats_per_level = ida_result.get("stats_per_level", [])
    if not stats_per_level:
        return {"overall": "no_data", "stories": []}
    level = stats_per_level[0]  # NLRHA: único nivel
    prof = level.get("drift_profile") or {}
    p50 = prof.get("p50") or []
    p84 = prof.get("p84") or []
    stories: list[dict] = []
    all_ok = True
    for i in range(len(p50)):
        mean = float(p50[i])
        pmax = float(p84[i]) if i < len(p84) else mean
        ok = (mean <= _NSR10_DRIFT_LIMIT_MEAN_PCT) and (pmax <= _NSR10_DRIFT_LIMIT_MAX_PCT)
        if not ok:
            all_ok = False
        stories.append({
            "story":           i + 1,
            "drift_p50_pct":   round(mean, 3),
            "drift_p84_pct":   round(pmax, 3),
            "ratio_vs_limit":  round(mean / _NSR10_DRIFT_LIMIT_MEAN_PCT, 3),
            "ok":              bool(ok),
        })
    return {
        "overall":         "pass" if all_ok else "fail",
        "limit_mean_pct":  _NSR10_DRIFT_LIMIT_MEAN_PCT,
        "limit_max_pct":   _NSR10_DRIFT_LIMIT_MAX_PCT,
        "stories":         stories,
        "n_pairs":         level.get("n_total"),
        "n_collapsed":     level.get("n_collapsed"),
    }


@router.post("/{project_id}/nlrha/launch", status_code=202)
def launch_nlrha(
    project_id: str,
    payload:    NLRHALaunchRequest,
    user:       CurrentUser,
    db:         DB,
):
    """Verificación NSR-10 / ASCE 7-22 Cap 16 mediante NLRHA de N pares a Sa de código."""
    from app.tasks.structural_ida_task import run_ida_task
    import uuid

    project = _get_project(db, project_id, user)

    if not payload.pair_ids:
        raise HTTPException(400, "Selecciona al menos un par.")
    if len(payload.pair_ids) < 3:
        raise HTTPException(
            400,
            f"NSR-10 A.5.4.6 requiere ≥ 3 pares (seleccionaste {len(payload.pair_ids)}).",
        )

    try:
        sa_info = _nsr10_sa_at_T(payload.Aa, payload.Av, payload.soil_type, payload.T1_s)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    I_factor  = _NSR10_IMPORTANCE[payload.use_group]
    sa_target = round(sa_info["Sa_g"] * I_factor * payload.mce_multiplier, 4)
    if sa_target <= 0:
        raise HTTPException(400, f"Sa_target={sa_target} ≤ 0. Revise Aa/Av/soil/T1.")

    params = {
        "pair_ids":    payload.pair_ids,
        "sa_min":      sa_target,
        "sa_max":      sa_target,
        "n_levels":    1,
        "T1_s":        payload.T1_s,
        "system":      payload.system,
        "damping":     payload.damping,
        "dt_analysis": payload.dt_analysis,
        "spacing":     "linear",
        "collapse_mode": "ductile",
        "catalog_source": payload.catalog_source,
        # Metadatos NLRHA (persistidos en progress_json.params)
        "mode":                "nlrha",
        "nsr10_Aa":            payload.Aa,
        "nsr10_Av":            payload.Av,
        "soil_type":           payload.soil_type,
        "use_group":           payload.use_group,
        "importance_factor":   I_factor,
        "mce_multiplier":      payload.mce_multiplier,
        "sa_nsr10_T1_g":       round(sa_info["Sa_g"], 4),
        "sa_target_g":         sa_target,
        "spectral_params":     {k: sa_info[k] for k in ("SDs", "SD1", "T0", "Ts", "TL", "Fa", "Fv")},
    }

    job = StructuralJob(
        id             = str(uuid.uuid4()),
        project_id     = project.id,
        owner_id       = user.id,
        analysis_type  = StructuralAnalysisType.ida,
        status         = StructuralJobStatus.pending,
        progress_json  = {"stage": "pending", "params": params, "mode": "nlrha"},
    )
    db.add(job); db.commit(); db.refresh(job)

    task = run_ida_task.delay(
        job_id=job.id, project_id=project.id, parameters_dict=params,
    )
    job.celery_task_id = task.id
    db.commit()

    return {
        "job_id":          job.id,
        "celery_id":       task.id,
        "pair_ids":        payload.pair_ids,
        "sa_nsr10_T1_g":   round(sa_info["Sa_g"], 4),
        "I_factor":        I_factor,
        "mce_multiplier":  payload.mce_multiplier,
        "sa_target_g":     sa_target,
        "spectral_params": {k: sa_info[k] for k in ("SDs", "SD1", "T0", "Ts", "TL", "Fa", "Fv")},
        "status":          "dispatched",
        "message":         (
            f"NLRHA lanzado: {len(payload.pair_ids)} pares escalados a "
            f"Sa={sa_target:.3f}g (Sa_NSR-10={sa_info['Sa_g']:.3f}g × I={I_factor} × {payload.mce_multiplier}×)."
        ),
    }


@router.get("/{project_id}/nlrha/result")
def get_nlrha_result(project_id: str, user: CurrentUser, db: DB):
    """Último NLRHA exitoso + evaluación NSR-10 A.6.4.2 por piso."""
    project = _get_project(db, project_id, user)

    jobs = (
        db.query(StructuralJob)
        .filter(StructuralJob.project_id == project.id)
        .filter(StructuralJob.analysis_type == StructuralAnalysisType.ida)
        .filter(StructuralJob.status == StructuralJobStatus.success)
        .order_by(StructuralJob.finished_at.desc())
        .all()
    )
    target = None
    for j in jobs:
        progress = j.progress_json or {}
        if isinstance(progress, dict) and progress.get("mode") == "nlrha":
            target = j
            break
    if not target or not target.result_path:
        raise HTTPException(404, "Ningún NLRHA completado todavía.")

    if not os.path.exists(target.result_path):
        raise HTTPException(404, f"Resultado no encontrado en {target.result_path}")
    with open(target.result_path, encoding="utf-8") as f:
        data = json.load(f)
    data["job_id"] = target.id
    progress = target.progress_json or {}
    params = progress.get("params") if isinstance(progress, dict) else None
    if params:
        data["nlrha_meta"] = {k: params.get(k) for k in (
            "mode", "nsr10_Aa", "nsr10_Av", "soil_type", "use_group",
            "importance_factor", "mce_multiplier",
            "sa_nsr10_T1_g", "sa_target_g", "spectral_params",
        ) if k in params}
    data["nsr10_verification"] = _verify_nsr10_drift_limit(data)
    return data


@router.get("/{project_id}/nlrha/jobs")
def list_nlrha_jobs(project_id: str, user: CurrentUser, db: DB):
    """Lista jobs NLRHA (sólo los que llevan mode=nlrha)."""
    project = _get_project(db, project_id, user)
    jobs = (
        db.query(StructuralJob)
        .filter(StructuralJob.project_id == project.id)
        .filter(StructuralJob.analysis_type == StructuralAnalysisType.ida)
        .order_by(StructuralJob.created_at.desc())
        .all()
    )
    out: list[dict] = []
    for j in jobs:
        progress = j.progress_json or {}
        if not isinstance(progress, dict) or progress.get("mode") != "nlrha":
            continue
        out.append({
            "job_id":        j.id,
            "status":        j.status.value if hasattr(j.status, "value") else str(j.status),
            "created_at":    j.created_at.isoformat() if j.created_at else None,
            "finished_at":   j.finished_at.isoformat() if j.finished_at else None,
            "params":        progress.get("params"),
            "result_summary": j.result_summary,
        })
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Ola 8 — Performance-based design verifier
# ─────────────────────────────────────────────────────────────────────────────
class PerformanceVerifyRequest(BaseModel):
    """Parámetros para el verificador performance-based."""
    performance_level: str = "LS"                    # IO | LS | CP
    theta_target_column: float | None = None          # override en rad
    theta_target_beam:   float | None = None
    method:              str = "haselton"             # haselton | ec8_3 | mecanico
    max_iterations:      int = 6
    skip_coupling_beams: bool = True
    save_fixes:          bool = False                # True → persiste al reinforcement.json


@router.post("/{project_id}/verify-performance-capacity")
def verify_performance_capacity_endpoint(
    project_id: str,
    payload:    PerformanceVerifyRequest,
    user:       CurrentUser,
    db:         DB,
):
    """Verifica y (opcionalmente) ajusta el refuerzo para cumplir θ_target por
    nivel de desempeño ASCE 41-17.

    Pipeline (sin tocar OpenSees):
        1. Lee nonlinear_model.json actual.
        2. Para cada elemento calcula θ_CP (Haselton) vs θ_target.
        3. Si θ_CP < θ_target, aplica ajustes incrementales (s↓, n_legs↑, etc.).
        4. Si `save_fixes=true`, persiste los overrides en reinforcement.json —
           el próximo NLTH/Pushover leerá los nuevos valores.
    """
    from engine.building.nonlinear import (
        verify_performance_capacity, apply_verification_fixes,
        load_axial_from_gravity, load_observations_csv,
    )
    from app.routers.structural_design import _load_reinforcement, _save_reinforcement

    project = _get_project(db, project_id, user)
    work_dir = _project_work_dir(project)
    spec_path = _ensure_nonlinear_spec(project)

    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    axial = load_axial_from_gravity(work_dir / "nonlinear" / "axial_from_gravity.json")
    obs = load_observations_csv(work_dir / "nonlinear" / "observations.csv")

    theta_overrides = {}
    if payload.theta_target_column is not None:
        theta_overrides["column"] = payload.theta_target_column
    if payload.theta_target_beam is not None:
        theta_overrides["beam"] = payload.theta_target_beam

    try:
        result = verify_performance_capacity(
            spec=spec,
            performance_level=payload.performance_level,  # type: ignore[arg-type]
            theta_overrides=theta_overrides or None,
            method=payload.method,                        # type: ignore[arg-type]
            axial_json=axial,
            observations=obs,
            max_iterations=payload.max_iterations,
            skip_coupling_beams=payload.skip_coupling_beams,
        )
    except Exception as exc:
        raise HTTPException(500, detail=f"Error en el verificador: {type(exc).__name__}: {exc}")

    # Persistir reporte para que la UI pueda releerlo sin recalcular
    out_path = work_dir / "nonlinear" / "performance_verification.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result.to_dict(), indent=2, ensure_ascii=False),
                        encoding="utf-8")

    saved_fixes_count = 0
    if payload.save_fixes:
        current_reinf = _load_reinforcement(project)
        updated_reinf = apply_verification_fixes(result, current_reinf, only_adjusted=True)
        saved_fixes_count = len(updated_reinf) - len(current_reinf) + sum(
            1 for fid, v in updated_reinf.items()
            if current_reinf.get(fid) != v
        )
        _save_reinforcement(project, updated_reinf)

    payload_dict = result.to_dict()
    payload_dict["saved_fixes"]       = payload.save_fixes
    payload_dict["saved_fixes_count"] = saved_fixes_count
    return payload_dict


@router.get("/{project_id}/verify-performance-capacity")
def get_performance_verification(project_id: str, user: CurrentUser, db: DB):
    """Devuelve el último reporte de verificación performance-based persistido."""
    project = _get_project(db, project_id, user)
    work_dir = _project_work_dir(project)
    out_path = work_dir / "nonlinear" / "performance_verification.json"
    if not out_path.exists():
        raise HTTPException(
            404,
            detail="Verificación performance-based aún no ejecutada — "
                   "lanza POST /verify-performance-capacity primero.",
        )
    return json.loads(out_path.read_text(encoding="utf-8"))


@router.delete("/jobs/{job_id}/cancel", status_code=200)
def cancel_job(job_id: str, user: CurrentUser, db: DB):
    """
    Cancela un job activo (pending o running). Envía SIGKILL al fork de Celery
    para matar instantáneamente el proceso OpenSees — SIGTERM no funciona bien
    con OpenSees porque el C++ ignora señales durante el loop de análisis
    (verificado 2026-11-04 con la task colgada de Prueba 4).
    """
    job = _get_job(db, job_id, user)
    if job.status not in (StructuralJobStatus.pending, StructuralJobStatus.running):
        raise HTTPException(
            status_code=400,
            detail="Solo se pueden cancelar jobs activos (pending o running)",
        )
    if job.celery_task_id:
        try:
            from app.tasks.celery_app import celery_app
            celery_app.control.revoke(job.celery_task_id, terminate=True, signal="SIGKILL")
        except Exception:
            pass
    job.status = StructuralJobStatus.cancelled
    job.error_message = "Cancelado por el usuario"
    job.finished_at = datetime.now(timezone.utc)
    db.commit()
    return {"detail": "Job cancelado exitosamente"}


# ═════════════════════════════════════════════════════════════════════════════
# Fase 7 — Umbrales por elemento (Fases 1-6 orquestadas)
# ═════════════════════════════════════════════════════════════════════════════
from pathlib import Path as _Path

from engine.building.nonlinear import (
    DEFAULT_DS_CATALOG,
    DamageStateDef,
    compute_element_thresholds,
    load_axial_from_gravity,
    load_observations_csv,
)


class DamageStateConfig(BaseModel):
    id:                str
    name:              str
    threshold_source:  str
    repair_action:     str
    beta_override:     float | None = None


class ElementThresholdsRequest(BaseModel):
    """Parámetros del cálculo de umbrales (todos opcionales)."""
    metodo_rotacion:      str   = "haselton"          # mecanico | ec8_3 | haselton
    metodo_umbrales:      str   = "FEMA"              # FEMA | elemento | ambos
    beta_global:          float = 0.40
    beta_poor_detailing:  float = 0.60
    ds_catalog:           list[DamageStateConfig] | None = None


def _project_work_dir(project: StructuralProject) -> _Path:
    """Carpeta de trabajo del proyecto donde viven los JSON de análisis."""
    if not project.canonical_model_path:
        raise HTTPException(404, detail="Modelo canónico no disponible")
    return _Path(os.path.dirname(os.path.dirname(project.canonical_model_path)))


def _ensure_nonlinear_spec(project: StructuralProject) -> _Path:
    """Devuelve la ruta de nonlinear_model.json, generándolo si no existe.

    Reusa la misma lógica que POST /nl-spec/{pid}/spec/generate del router
    structural_nonlinear — así el usuario no tiene que llamar a dos endpoints
    para empezar a usar la evaluación por elemento.
    """
    from engine.building.nonlinear import NLSpecBuilder as _NLSpecBuilder

    wd = _project_work_dir(project)
    spec_path = wd / "nonlinear" / "nonlinear_model.json"
    if spec_path.exists():
        return spec_path

    # Fallback: generarlo si tenemos el canonical model
    if not project.canonical_model_path or not os.path.exists(project.canonical_model_path):
        raise HTTPException(
            422,
            detail="El modelo canónico no está disponible. "
                   "Importa y valida el modelo primero.",
        )

    with open(project.canonical_model_path, "r", encoding="utf-8") as fh:
        canonical = json.load(fh)
    results_dir = wd / "results"

    def _load_safe(path: _Path) -> dict | None:
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None

    col_detail  = _load_safe(results_dir / "design_columns_detail.json")
    beam_detail = _load_safe(results_dir / "beam_design_detail.json")
    reinf_json  = _load_safe(results_dir / "reinforcement.json")

    if isinstance(reinf_json, dict):
        section_patterns = reinf_json.pop("section_patterns", {})
        user_reinf       = reinf_json
    else:
        section_patterns, user_reinf = {}, reinf_json

    params = json.loads(project.parameters_json) if project.parameters_json else {}
    ed     = params.get("energy_dissipation", "DMO")

    builder = _NLSpecBuilder(
        canonical          = canonical,
        col_detail         = col_detail or {},
        beam_detail        = beam_detail or {},
        user_reinforcement = user_reinf,
        section_patterns   = section_patterns,
        energy_dissipation = ed,
        project_id         = str(project.id),
    )
    try:
        spec = builder.build()
    except Exception as exc:
        raise HTTPException(500, detail=f"Error generando nonlinear_model.json: {exc}")

    spec_path.parent.mkdir(parents=True, exist_ok=True)
    spec_path.write_text(json.dumps(spec, indent=2), encoding="utf-8")
    return spec_path


@router.post("/{project_id}/element-thresholds")
def post_element_thresholds(
    project_id: str,
    payload:    ElementThresholdsRequest,
    user:       CurrentUser,
    db:         DB,
):
    """Calcula umbrales por elemento ejecutando Fases 1-6.

    Lee del proyecto:
        results/nonlinear_model.json        (requerido)
        results/axial_from_gravity.json     (opcional — mejora ν)
        inputs/observations.csv             (opcional — Lp medida, hooks, etc.)

    Devuelve la tabla por elemento + fragilidades + resumen.
    """
    project = _get_project(db, project_id, user)
    work_dir = _project_work_dir(project)
    spec_path = _ensure_nonlinear_spec(project)

    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    axial = load_axial_from_gravity(work_dir / "nonlinear" / "axial_from_gravity.json")
    obs = load_observations_csv(work_dir / "nonlinear" / "observations.csv")

    ds_catalog = None
    if payload.ds_catalog:
        ds_catalog = [DamageStateDef(**d.model_dump()) for d in payload.ds_catalog]

    try:
        result = compute_element_thresholds(
            spec=spec,
            axial_json=axial,
            observations=obs,
            metodo_rotacion=payload.metodo_rotacion,   # type: ignore[arg-type]
            metodo_umbrales=payload.metodo_umbrales,   # type: ignore[arg-type]
            beta_global=payload.beta_global,
            beta_poor_detailing=payload.beta_poor_detailing,
            ds_catalog=ds_catalog,
        )
    except Exception as e:
        raise HTTPException(500, detail=f"Error en el pipeline: {type(e).__name__}: {e}")

    # Persistir para que el posproceso del pushover (hinge_damage) lo lea
    out_path = work_dir / "nonlinear" / "element_thresholds.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result.to_dict(), indent=2), encoding="utf-8")

    return result.to_dict()


@router.get("/{project_id}/element-thresholds")
def get_element_thresholds(
    project_id: str,
    user:       CurrentUser,
    db:         DB,
):
    """Devuelve la última tabla de umbrales calculada (desde JSON persistido)."""
    project = _get_project(db, project_id, user)
    work_dir = _project_work_dir(project)
    out_path = work_dir / "nonlinear" / "element_thresholds.json"
    if not out_path.exists():
        raise HTTPException(404, detail="Umbrales por elemento aún no calculados — "
                                        "lanza POST /element-thresholds primero.")
    return json.loads(out_path.read_text(encoding="utf-8"))


@router.get("/{project_id}/damage-states-catalog")
def get_damage_states_catalog(
    project_id: str,
    user:       CurrentUser,
    db:         DB,
):
    """Devuelve el catálogo de DS actual (persistido) o el default."""
    project = _get_project(db, project_id, user)
    work_dir = _project_work_dir(project)
    cat_path = work_dir / "nonlinear" / "damage_states_catalog.json"
    if cat_path.exists():
        return json.loads(cat_path.read_text(encoding="utf-8"))
    # Default
    return [
        {"id": d.id, "name": d.name,
         "threshold_source": d.threshold_source,
         "repair_action":    d.repair_action,
         "beta_override":    d.beta_override}
        for d in DEFAULT_DS_CATALOG
    ]


@router.put("/{project_id}/damage-states-catalog")
def put_damage_states_catalog(
    project_id: str,
    catalog:    list[DamageStateConfig],
    user:       CurrentUser,
    db:         DB,
):
    """Persiste el catálogo de DS editado por el usuario."""
    project = _get_project(db, project_id, user)
    work_dir = _project_work_dir(project)
    cat_path = work_dir / "nonlinear" / "damage_states_catalog.json"
    cat_path.parent.mkdir(parents=True, exist_ok=True)
    data = [d.model_dump() for d in catalog]
    cat_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return {"saved": True, "n_states": len(catalog)}


@router.post("/{project_id}/field-observations")
async def upload_field_observations(
    project_id: str,
    file:       UploadFile,
    user:       CurrentUser,
    db:         DB,
):
    """Sube observations.csv con observaciones de campo (Lp medida, hooks, etc.).

    Columnas aceptadas (fid obligatorio, resto opcional):
        fid, L_p_measured_mm, L_p_method, hook_type, splice_in_hinge,
        fu_MPa, eps_su, damage_notes, photo_path
    """
    project = _get_project(db, project_id, user)
    work_dir = _project_work_dir(project)
    out = work_dir / "nonlinear" / "observations.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    content = await file.read()
    out.write_bytes(content)
    # Validar que se puede parsear
    try:
        parsed = load_observations_csv(out)
    except Exception as e:
        raise HTTPException(400, detail=f"CSV inválido: {e}")
    return {"saved": True, "n_elements": len(parsed)}


@router.get("/{project_id}/field-observations")
def get_field_observations(
    project_id: str,
    user:       CurrentUser,
    db:         DB,
):
    """Devuelve observaciones de campo persistidas."""
    project = _get_project(db, project_id, user)
    work_dir = _project_work_dir(project)
    csv_path = work_dir / "nonlinear" / "observations.csv"
    if not csv_path.exists():
        return {"observations": {}, "n_elements": 0}
    parsed = load_observations_csv(csv_path)
    return {"observations": parsed, "n_elements": len(parsed)}


class FieldObservationItem(BaseModel):
    fid:              str
    L_p_measured_mm:  float | None = None
    L_p_method:       str | None   = None
    hook_type:        str | None   = None
    splice_in_hinge:  bool | None  = None
    fu_MPa:           float | None = None
    eps_su:           float | None = None
    damage_notes:     str | None   = None
    photo_path:       str | None   = None


@router.put("/{project_id}/field-observations/{fid}")
def put_field_observation(
    project_id: str,
    fid:        str,
    payload:    FieldObservationItem,
    user:       CurrentUser,
    db:         DB,
):
    """Upsert de UNA observación. Mantiene las demás intactas."""
    project = _get_project(db, project_id, user)
    work_dir = _project_work_dir(project)
    csv_path = work_dir / "nonlinear" / "observations.csv"
    existing = load_observations_csv(csv_path) if csv_path.exists() else {}

    entry: dict = {}
    for k, v in payload.model_dump(exclude={"fid"}).items():
        if v is not None and v != "":
            entry[k] = v
    existing[fid] = entry

    # Reescribir CSV con todas las entradas
    cols = ["fid", "L_p_measured_mm", "L_p_method", "hook_type",
            "splice_in_hinge", "fu_MPa", "eps_su", "damage_notes", "photo_path"]
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    with csv_path.open("w", encoding="utf-8", newline="") as fh:
        fh.write(",".join(cols) + "\n")
        for fid_e, data in existing.items():
            row = [fid_e] + [str(data.get(c, "")) for c in cols[1:]]
            fh.write(",".join(row) + "\n")
    return {"saved": True, "fid": fid}


# ─── Demanda unificada por elemento (del NLTHA o pushover) ──────────────────
def _load_demand_from_frame_pushover(work_dir: _Path) -> dict:
    """Lee nl_frame_pushover_results.json y combina X + Y por fid."""
    res_path = work_dir / "results" / "nl_frame_pushover_results.json"
    if not res_path.exists():
        return {}
    data = json.loads(res_path.read_text(encoding="utf-8"))

    by_fid: dict[str, dict] = {}
    for direction in ("X", "Y", "-X", "-Y"):
        bucket = data.get("directions", {}).get(direction) \
              or data.get("results_by_dir", {}).get(direction) \
              or (data if data.get("direction") == direction else None)
        if not isinstance(bucket, dict):
            continue
        damage = bucket.get("damage") or {}
        for h in damage.get("hinges", []):
            fid = str(h.get("fid", ""))
            tp  = float(h.get("theta_p_max", 0.0))
            cur = by_fid.setdefault(fid, {
                "theta_p_max": 0.0, "end_at_max": "", "direction_at_max": "",
                "level": "none",
                "theta_IO_fema": h.get("theta_IO"),
                "theta_LS_fema": h.get("theta_LS"),
                "theta_CP_fema": h.get("theta_CP"),
                "kind": h.get("kind"), "story": h.get("story"),
            })
            if tp > cur["theta_p_max"]:
                cur["theta_p_max"]    = tp
                cur["end_at_max"]     = str(h.get("end", ""))
                cur["direction_at_max"] = direction
                cur["level"]          = str(h.get("damage_level", "none"))
    return by_fid


def _load_demand_from_nlth(work_dir: _Path) -> dict:
    """Lee nlth_results.json y devuelve θ_p_max por fid."""
    res_path = work_dir / "results" / "nlth_results.json"
    if not res_path.exists():
        return {}
    data = json.loads(res_path.read_text(encoding="utf-8"))
    damage = data.get("damage") or {}

    by_fid: dict[str, dict] = {}
    for h in damage.get("hinges", []):
        fid = str(h.get("fid", ""))
        tp  = float(h.get("theta_p_max", 0.0))
        cur = by_fid.setdefault(fid, {
            "theta_p_max": 0.0, "end_at_max": "", "direction_at_max": "nlth",
            "level": "none",
            "theta_IO_fema": h.get("theta_IO"),
            "theta_LS_fema": h.get("theta_LS"),
            "theta_CP_fema": h.get("theta_CP"),
            "kind": h.get("kind"), "story": h.get("story"),
        })
        if tp > cur["theta_p_max"]:
            cur["theta_p_max"] = tp
            cur["end_at_max"]  = str(h.get("end", ""))
            cur["level"]       = str(h.get("damage_level", "none"))
    return by_fid


@router.get("/{project_id}/element-demand")
def get_element_demand(
    project_id: str,
    user:       CurrentUser,
    db:         DB,
):
    """Devuelve θ_p_max por fid envolviendo NLTHA + pushover (lo que exista).

    Si ambos existen, el máximo por fid gana (envolvente).
    """
    project = _get_project(db, project_id, user)
    work_dir = _project_work_dir(project)

    nlth_demand     = _load_demand_from_nlth(work_dir)
    pushover_demand = _load_demand_from_frame_pushover(work_dir)

    if not nlth_demand and not pushover_demand:
        return {"source": "none", "by_fid": {}, "n_elements": 0,
                "n_from_nlth": 0, "n_from_pushover": 0}

    all_fids = set(nlth_demand) | set(pushover_demand)
    by_fid: dict[str, dict] = {}
    n_n = n_p = 0

    for fid in all_fids:
        n = nlth_demand.get(fid)
        p = pushover_demand.get(fid)
        if n and p:
            if n["theta_p_max"] >= p["theta_p_max"]:
                by_fid[fid] = {**n, "source": "nlth"}
                n_n += 1
            else:
                by_fid[fid] = {**p, "source": "pushover"}
                n_p += 1
        elif n:
            by_fid[fid] = {**n, "source": "nlth"}
            n_n += 1
        else:
            by_fid[fid] = {**p, "source": "pushover"}
            n_p += 1

    source = "both" if nlth_demand and pushover_demand else (
             "nlth" if nlth_demand else "pushover")

    # Persistir para usos posteriores (p. ej. recalcular tabla con demanda sin refetch)
    out = work_dir / "nonlinear" / "element_demand.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "source": source, "by_fid": by_fid,
        "n_elements": len(by_fid),
        "n_from_nlth": n_n, "n_from_pushover": n_p,
    }, indent=2), encoding="utf-8")

    return {
        "source": source, "by_fid": by_fid,
        "n_elements": len(by_fid),
        "n_from_nlth": n_n, "n_from_pushover": n_p,
    }


class ApplyLpToSectionRequest(BaseModel):
    """Aplicar Lp medida a todos los frames de una sección (shortcut UI)."""
    section_name:    str
    kind:            str          # "column" | "beam"
    L_p_measured_mm: float


@router.post("/{project_id}/field-observations/apply-lp-to-section")
def apply_lp_to_section(
    project_id: str,
    payload:    ApplyLpToSectionRequest,
    user:       CurrentUser,
    db:         DB,
):
    """Shortcut: aplicar la misma Lp a todos los elementos de una sección."""
    project = _get_project(db, project_id, user)
    work_dir = _project_work_dir(project)

    spec_path = work_dir / "results" / "nonlinear_model.json"
    if not spec_path.exists():
        raise HTTPException(404, detail="nonlinear_model.json no encontrado")
    spec = json.loads(spec_path.read_text(encoding="utf-8"))

    kind_key = "columns" if payload.kind == "column" else "beams"
    fids = [fid for fid, el in spec.get("elements", {}).get(kind_key, {}).items()
            if el.get("section") == payload.section_name]
    if not fids:
        raise HTTPException(404, detail=f"Sección {payload.section_name} sin elementos")

    csv_path = work_dir / "nonlinear" / "observations.csv"
    existing = load_observations_csv(csv_path) if csv_path.exists() else {}
    for fid in fids:
        existing.setdefault(fid, {})
        existing[fid]["L_p_measured_mm"] = payload.L_p_measured_mm
        existing[fid]["L_p_method"] = "measured"

    cols = ["fid", "L_p_measured_mm", "L_p_method", "hook_type",
            "splice_in_hinge", "fu_MPa", "eps_su", "damage_notes", "photo_path"]
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    with csv_path.open("w", encoding="utf-8", newline="") as fh:
        fh.write(",".join(cols) + "\n")
        for fid_e, data in existing.items():
            row = [fid_e] + [str(data.get(c, "")) for c in cols[1:]]
            fh.write(",".join(row) + "\n")

    return {"applied_to": fids, "n_elements": len(fids)}
