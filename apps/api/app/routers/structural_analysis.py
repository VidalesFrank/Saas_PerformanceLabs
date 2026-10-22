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
from typing import Annotated

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
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


@router.delete("/jobs/{job_id}/cancel", status_code=200)
def cancel_job(job_id: str, user: CurrentUser, db: DB):
    """Cancela un job activo (pending o running)."""
    job = _get_job(db, job_id, user)
    if job.status not in (StructuralJobStatus.pending, StructuralJobStatus.running):
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
