"""
Router — Módulo 1: Lanzamiento, estado y resultados de análisis estructural.

Prefix: /api/v1/projects/analysis
Auth:   JWT requerido en todos los endpoints.

Flujo de análisis:
  import_validate → modal → spectral

Cada etapa es un job Celery independiente. El frontend hace polling cada 3s.
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

    @classmethod
    def from_orm(cls, j: StructuralJob) -> "JobOut":
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
