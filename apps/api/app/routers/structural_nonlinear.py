"""
Router — Módulo 1: Gestión del modelo no lineal (spec JSON).

Prefix: /api/v1/projects/nonlinear
Auth:   JWT requerido.

Endpoints:
  GET  /{project_id}/spec            → estado (missing|current|stale) + metadata
  POST /{project_id}/spec/generate   → genera o regenera el spec (síncrono)
  GET  /{project_id}/spec/download   → descarga nonlinear_model.json
  POST /{project_id}/spec/upload     → carga un JSON externo como spec del proyecto
  DELETE /{project_id}/spec          → elimina el spec (resetea a missing)
"""
import hashlib
import json
import os
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.db import get_db
from app.models import StructuralProject, User

router = APIRouter(prefix="/api/v1/projects/nonlinear", tags=["nonlinear-spec"])

CurrentUser = Annotated[User, Depends(get_current_user)]
DB          = Annotated[Session, Depends(get_db)]


# ── Helpers de rutas ───────────────────────────────────────────────────────────

def _get_project_or_404(db: Session, project_id: str, user: User) -> StructuralProject:
    p = db.get(StructuralProject, project_id)
    if not p or p.user_id != user.id:
        raise HTTPException(status_code=404, detail="Proyecto no encontrado.")
    return p


def _work_dir(project: StructuralProject) -> str | None:
    if not project.canonical_model_path:
        return None
    return os.path.dirname(os.path.dirname(project.canonical_model_path))


def _spec_path(project: StructuralProject) -> str | None:
    wd = _work_dir(project)
    if not wd:
        return None
    return os.path.join(wd, "nonlinear", "nonlinear_model.json")


def _results_dir(project: StructuralProject) -> str | None:
    wd = _work_dir(project)
    return os.path.join(wd, "results") if wd else None


def _load_json(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _load_json_safe(path: str | None) -> dict:
    if not path or not os.path.exists(path):
        return {}
    try:
        return _load_json(path)
    except Exception:
        return {}


def _source_digest(canonical: dict, col_detail: dict, beam_detail: dict) -> str:
    """Reproduce el digest que NLSpecBuilder usa, para detectar staleness."""
    h = hashlib.sha256()
    for obj in (
        canonical.get("joints",    {}),
        canonical.get("frames",    {}),
        canonical.get("sections",  {}),
        canonical.get("materials", {}),
        {c["frame_id"]: c for c in col_detail.get("columns", []) if "frame_id" in c},
        {b["frame_id"]: b for b in beam_detail.get("beams",   []) if "frame_id" in b},
    ):
        h.update(json.dumps(obj, sort_keys=True, ensure_ascii=False).encode())
    return h.hexdigest()


def _spec_status(project: StructuralProject) -> dict:
    """
    Retorna:
      status: "missing" | "current" | "stale"
      metadata: contenido de spec["metadata"] si existe
      spec_path: ruta al archivo (o None)
    """
    path = _spec_path(project)
    if not path or not os.path.exists(path):
        return {"status": "missing", "metadata": None, "spec_path": path}

    try:
        spec = _load_json(path)
    except Exception:
        return {"status": "missing", "metadata": None, "spec_path": path}

    saved_digest = spec.get("metadata", {}).get("source_digest", "")

    # Calcular digest actual solo si existen los archivos
    rd = _results_dir(project)
    col_detail  = _load_json_safe(os.path.join(rd, "design_columns_detail.json") if rd else None)
    beam_detail = _load_json_safe(os.path.join(rd, "beam_design_detail.json")    if rd else None)

    canonical = {}
    if project.canonical_model_path and os.path.exists(project.canonical_model_path):
        canonical = _load_json_safe(project.canonical_model_path)

    current_digest = _source_digest(canonical, col_detail, beam_detail)
    status = "current" if current_digest == saved_digest else "stale"

    return {
        "status":    status,
        "metadata":  spec.get("metadata", {}),
        "validation": spec.get("validation", {}),
        "spec_path": path,
    }


# ── GET /spec ─────────────────────────────────────────────────────────────────

@router.get("/{project_id}/spec")
def get_spec_status(project_id: str, user: CurrentUser, db: DB):
    """
    Retorna el estado del modelo no lineal del proyecto:
    - missing:  no se ha generado aún
    - current:  generado y alineado con el diseño actual
    - stale:    generado pero el diseño cambió → debe regenerarse
    """
    project = _get_project_or_404(db, project_id, user)
    info = _spec_status(project)
    return {
        "status":     info["status"],
        "metadata":   info["metadata"],
        "validation": info.get("validation"),
    }


# ── POST /spec/generate ───────────────────────────────────────────────────────

@router.post("/{project_id}/spec/generate")
def generate_spec(project_id: str, user: CurrentUser, db: DB):
    """
    Genera (o regenera) el modelo no lineal a partir del diseño actual.

    Requiere:
    - structural_model.json   (modelo canónico validado)
    - design_columns_detail.json  (opcional — sin diseño usa defaults)
    - beam_design_detail.json     (opcional — sin diseño usa defaults)
    """
    from engine.building.nonlinear import NLSpecBuilder

    project = _get_project_or_404(db, project_id, user)

    if not project.canonical_model_path or not os.path.exists(project.canonical_model_path):
        raise HTTPException(
            status_code=422,
            detail="El modelo canónico no está disponible. Importa y valida el modelo primero.",
        )

    canonical = _load_json(project.canonical_model_path)
    rd        = _results_dir(project)

    col_detail  = _load_json_safe(os.path.join(rd, "design_columns_detail.json") if rd else None)
    beam_detail = _load_json_safe(os.path.join(rd, "beam_design_detail.json")    if rd else None)
    user_reinf  = _load_json_safe(os.path.join(rd, "reinforcement.json")         if rd else None)

    # Nivel de ductilidad desde parámetros del proyecto
    params = json.loads(project.parameters_json) if project.parameters_json else {}
    ed     = params.get("energy_dissipation", "DMO")

    builder = NLSpecBuilder(
        canonical          = canonical,
        col_detail         = col_detail,
        beam_detail        = beam_detail,
        user_reinforcement = user_reinf,
        energy_dissipation = ed,
        project_id         = project_id,
    )

    try:
        spec = builder.build()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Error generando spec: {exc}") from exc

    # Guardar en {work_dir}/nonlinear/nonlinear_model.json
    wd       = _work_dir(project)
    nl_dir   = os.path.join(wd, "nonlinear")
    os.makedirs(nl_dir, exist_ok=True)
    out_path = os.path.join(nl_dir, "nonlinear_model.json")

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(spec, f, ensure_ascii=False, indent=2)

    meta = spec.get("metadata", {})
    val  = spec.get("validation", {})

    return {
        "ok":         True,
        "spec_path":  out_path,
        "metadata":   meta,
        "validation": val,
        "message":    (
            f"Spec generado: {meta.get('n_columns', 0)} columnas, "
            f"{meta.get('n_beams', 0)} vigas, "
            f"{meta.get('n_stories', 0)} pisos."
        ),
    }


# ── GET /spec/download ────────────────────────────────────────────────────────

@router.get("/{project_id}/spec/download")
def download_spec(project_id: str, user: CurrentUser, db: DB):
    """Descarga el nonlinear_model.json del proyecto."""
    project  = _get_project_or_404(db, project_id, user)
    path     = _spec_path(project)

    if not path or not os.path.exists(path):
        raise HTTPException(
            status_code=404,
            detail="El modelo no lineal no ha sido generado aún. Usa POST /spec/generate.",
        )

    filename = f"nonlinear_model_{project_id[:8]}.json"
    return FileResponse(
        path,
        media_type="application/json",
        filename=filename,
    )


# ── POST /spec/upload ─────────────────────────────────────────────────────────

@router.post("/{project_id}/spec/upload")
async def upload_spec(project_id: str, file: UploadFile, user: CurrentUser, db: DB):
    """
    Carga un nonlinear_model.json externo como spec del proyecto.

    Valida que el JSON tenga schema_version = "1.0" y los bloques requeridos.
    No valida que el modelo sea coherente con el proyecto actual.
    """
    project = _get_project_or_404(db, project_id, user)

    if not project.canonical_model_path:
        raise HTTPException(
            status_code=422,
            detail="El proyecto no tiene un modelo canónico. Importa el modelo primero.",
        )

    content = await file.read()
    try:
        spec = json.loads(content)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"JSON inválido: {exc}") from exc

    # Validación mínima del schema
    if spec.get("schema_version") != "1.0":
        raise HTTPException(
            status_code=400,
            detail="schema_version inválido. Se requiere '1.0'.",
        )
    required = ("metadata", "materials", "nodes", "elements")
    missing  = [k for k in required if k not in spec]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Campos requeridos faltantes: {missing}",
        )

    # Guardar
    wd     = _work_dir(project)
    nl_dir = os.path.join(wd, "nonlinear")
    os.makedirs(nl_dir, exist_ok=True)
    out_path = os.path.join(nl_dir, "nonlinear_model.json")

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(spec, f, ensure_ascii=False, indent=2)

    meta = spec.get("metadata", {})
    return {
        "ok":       True,
        "message":  "Spec cargado correctamente.",
        "metadata": meta,
    }


# ── DELETE /spec ──────────────────────────────────────────────────────────────

@router.delete("/{project_id}/spec")
def delete_spec(project_id: str, user: CurrentUser, db: DB):
    """Elimina el spec del proyecto (resetea estado a 'missing')."""
    project  = _get_project_or_404(db, project_id, user)
    path     = _spec_path(project)

    if path and os.path.exists(path):
        os.remove(path)
        return {"ok": True, "message": "Spec eliminado."}

    return {"ok": True, "message": "No había spec que eliminar."}
