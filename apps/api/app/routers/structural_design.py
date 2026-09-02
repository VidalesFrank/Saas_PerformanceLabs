"""
Router — Módulo 1: Detalle de diseño por frame + edición de refuerzo definitivo.

Prefix: /api/v1/projects/{project_id}/design

Endpoints:
  GET  /frames                    → lista de todos los frames con estado de diseño
  GET  /frames/{frame_id}         → detalle completo de un frame (columna o viga)
  PUT  /frames/{frame_id}/reinforcement   → guardar refuerzo definitivo del ingeniero
  POST /frames/{frame_id}/verify  → re-verificar con refuerzo editado

Estos endpoints son ADICIONALES — no modifican el flujo de jobs existente.
"""
import json
import os
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.db import get_db
from app.models import StructuralProject, User

router = APIRouter(
    prefix="/api/v1/projects/{project_id}/design",
    tags=["structural-design-detail"],
)

CurrentUser = Annotated[User, Depends(get_current_user)]
DB          = Annotated[Session, Depends(get_db)]


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_project(db: Session, project_id: str, user: User) -> StructuralProject:
    project = db.get(StructuralProject, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Proyecto no encontrado")
    if project.owner_id != user.id:
        raise HTTPException(status_code=403, detail="Sin acceso a este proyecto")
    return project


def _work_dir(project: StructuralProject) -> str:
    if not project.canonical_model_path:
        raise HTTPException(status_code=400, detail="El modelo aún no ha sido validado.")
    return os.path.dirname(os.path.dirname(project.canonical_model_path))


def _results_dir(project: StructuralProject) -> str:
    return os.path.join(_work_dir(project), "results")


def _reinforcement_path(project: StructuralProject) -> str:
    return os.path.join(_results_dir(project), "reinforcement.json")


def _load_json_safe(path: str) -> dict | list | None:
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return None


def _load_reinforcement(project: StructuralProject) -> dict:
    data = _load_json_safe(_reinforcement_path(project))
    return data if isinstance(data, dict) else {}


def _save_reinforcement(project: StructuralProject, reinforcement: dict) -> None:
    path = _reinforcement_path(project)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(reinforcement, f, ensure_ascii=False, indent=2)


# ── Schemas ───────────────────────────────────────────────────────────────────

class SaveReinforcementRequest(BaseModel):
    reinforcement: dict                # contenido libre; validado por el engine
    notes: str | None = None


class VerifyRequest(BaseModel):
    reinforcement: dict


# ── GET /frames ───────────────────────────────────────────────────────────────

@router.get("/frames")
def list_frames(project_id: str, user: CurrentUser, db: DB):
    """
    Retorna la lista de todos los frames (columnas y vigas) con su estado de diseño.
    Agrupa por piso y tipo.
    """
    project = _get_project(db, project_id, user)
    rd      = _results_dir(project)

    # Cargar resúmenes de diseño
    col_data  = _load_json_safe(os.path.join(rd, "design_columns_results.json"))
    beam_data = _load_json_safe(os.path.join(rd, "beam_design_results.json"))
    saved_r   = _load_reinforcement(project)

    frames: list[dict] = []

    if col_data:
        for c in col_data.get("columns", []):
            frames.append({
                "frame_id":    c["id"],
                "story":       c["story"],
                "element_type": "column",
                "section":     c["section"],
                "dcr":         c.get("dcr", 0.0),
                "ok":          c.get("ok", True),
                "has_detail":  c.get("has_detail", False),
                "user_modified": c["id"] in saved_r,
                "status":      _frame_status(c.get("dcr", 0.0), c.get("ok", True), c["id"] in saved_r),
            })

    if beam_data:
        for b in beam_data.get("beams", []):
            frames.append({
                "frame_id":    b["id"],
                "story":       b["story"],
                "element_type": "beam",
                "section":     b["section"],
                "dcr":         b.get("dcr", 0.0),
                "ok":          b.get("ok", True),
                "has_detail":  b.get("has_detail", False),
                "user_modified": b["id"] in saved_r,
                "status":      _frame_status(b.get("dcr", 0.0), b.get("ok", True), b["id"] in saved_r),
            })

    # Cargar modelo para obtener el orden de pisos
    model_data = _load_json_safe(project.canonical_model_path) if project.canonical_model_path else {}
    stories_raw = model_data.get("stories", {}) if model_data else {}
    story_order = [
        name for name, _ in sorted(
            stories_raw.items(),
            key=lambda kv: kv[1].get("elevation_m", 0.0)
        )
    ]
    story_idx = {s: i for i, s in enumerate(story_order)}

    frames.sort(key=lambda f: (
        story_idx.get(f["story"], 9999),
        0 if f["element_type"] == "column" else 1,
        f["frame_id"],
    ))

    return {
        "frames":      frames,
        "story_order": story_order,
        "n_columns":   sum(1 for f in frames if f["element_type"] == "column"),
        "n_beams":     sum(1 for f in frames if f["element_type"] == "beam"),
        "n_ok":        sum(1 for f in frames if f["ok"]),
        "n_ng":        sum(1 for f in frames if not f["ok"]),
    }


# ── GET /frames/{frame_id} ────────────────────────────────────────────────────

@router.get("/frames/{frame_id}")
def get_frame_detail(project_id: str, frame_id: str, user: CurrentUser, db: DB):
    """
    Retorna el detalle completo de diseño de un frame específico.
    Incluye curva P-M (columnas) o demandas por zona (vigas), barras propuestas,
    estribos, chequeos y — si existe — el refuerzo definitivo guardado por el usuario.
    """
    project = _get_project(db, project_id, user)
    rd      = _results_dir(project)

    saved_r = _load_reinforcement(project)
    user_reinforcement = saved_r.get(frame_id)

    # Buscar en detalle de columnas
    col_detail = _load_json_safe(os.path.join(rd, "design_columns_detail.json"))
    if col_detail:
        for c in col_detail.get("columns", []):
            if c["frame_id"] == frame_id:
                c["final_reinforcement"] = user_reinforcement
                c["user_modified"] = user_reinforcement is not None
                return c

    # Buscar en detalle de vigas
    beam_detail = _load_json_safe(os.path.join(rd, "beam_design_detail.json"))
    if beam_detail:
        for b in beam_detail.get("beams", []):
            if b["frame_id"] == frame_id:
                b["final_reinforcement"] = user_reinforcement
                b["user_modified"] = user_reinforcement is not None
                return b

    # Si no hay detalle aún, buscar en resúmenes (datos básicos)
    col_summary = _load_json_safe(os.path.join(rd, "design_columns_results.json"))
    if col_summary:
        for c in col_summary.get("columns", []):
            if c["id"] == frame_id:
                return {
                    "frame_id":    c["id"],
                    "story":       c["story"],
                    "element_type": "column",
                    "section":     c["section"],
                    "geometry": {
                        "b_m": c["b_m"], "h_m": c["h_m"],
                        "fc_MPa": c["fc_MPa"], "fy_MPa": 420.0,
                    },
                    "demands": {
                        "governing": {
                            "Pu_kN": c["Pu_kN"], "Mu_res_kNm": c["Mu_kNm"],
                            "Mu2_kNm": c["Mu_kNm"], "Mu3_kNm": 0.0,
                            "combo": c["combo"],
                        }
                    },
                    "max_dcr":    c["dcr"],
                    "overall_ok": c["ok"],
                    "final_reinforcement": user_reinforcement,
                    "user_modified": user_reinforcement is not None,
                    "detail_available": False,
                }

    beam_summary = _load_json_safe(os.path.join(rd, "beam_design_results.json"))
    if beam_summary:
        for b in beam_summary.get("beams", []):
            if b["id"] == frame_id:
                return {
                    "frame_id":    b["id"],
                    "story":       b["story"],
                    "element_type": "beam",
                    "section":     b["section"],
                    "geometry": {
                        "b_m": b["b_m"], "h_m": b["h_m"],
                        "L_m": b["L_m"], "fc_MPa": b["fc_MPa"], "fy_MPa": 420.0,
                    },
                    "demands": {
                        "governing": {
                            "Mu_neg_kNm": b["Mu_neg_kNm"],
                            "Mu_pos_kNm": b["Mu_pos_kNm"],
                            "Vu_kN": b["Vu_kN"], "combo": b["combo"],
                        }
                    },
                    "max_dcr":    b["dcr"],
                    "overall_ok": b["ok"],
                    "final_reinforcement": user_reinforcement,
                    "user_modified": user_reinforcement is not None,
                    "detail_available": False,
                }

    raise HTTPException(status_code=404, detail=f"Frame '{frame_id}' no encontrado en los resultados de diseño.")


# ── PUT /frames/{frame_id}/reinforcement ──────────────────────────────────────

@router.put("/frames/{frame_id}/reinforcement")
def save_reinforcement(
    project_id: str,
    frame_id: str,
    payload: SaveReinforcementRequest,
    user: CurrentUser,
    db: DB,
):
    """
    Guarda el refuerzo definitivo para un frame específico.
    El refuerzo se almacena en reinforcement.json (por frame).
    """
    project = _get_project(db, project_id, user)

    saved_r = _load_reinforcement(project)
    saved_r[frame_id] = {
        "reinforcement": payload.reinforcement,
        "notes":         payload.notes,
        "saved_at":      _utc_now(),
    }
    _save_reinforcement(project, saved_r)

    return {
        "frame_id": frame_id,
        "saved":    True,
        "message":  f"Refuerzo definitivo guardado para {frame_id}.",
    }


# ── POST /frames/{frame_id}/verify ────────────────────────────────────────────

@router.post("/frames/{frame_id}/verify")
def verify_frame(
    project_id: str,
    frame_id: str,
    payload: VerifyRequest,
    user: CurrentUser,
    db: DB,
):
    """
    Re-verifica un frame con el refuerzo editado manualmente.
    No modifica los archivos de resultado — solo devuelve el resultado de la verificación.
    """
    project = _get_project(db, project_id, user)
    rd      = _results_dir(project)

    # Cargar modelo canónico para tener contexto
    model_data = _load_json_safe(project.canonical_model_path)
    if not model_data:
        raise HTTPException(status_code=400, detail="Modelo canónico no disponible.")

    sections  = model_data.get("sections",  {})
    materials = model_data.get("materials", {})
    joints    = model_data.get("joints",    {})
    frames    = model_data.get("frames",    {})

    # Buscar datos del frame
    frame_data = frames.get(frame_id)
    if not frame_data:
        raise HTTPException(status_code=404, detail=f"Frame '{frame_id}' no encontrado en el modelo.")

    element_type = frame_data.get("element_type", "")

    # Cargar parámetros sísmicos
    params = json.loads(project.parameters_json) if project.parameters_json else {}
    seismic_ctx = {
        "sections":          sections,
        "materials":         materials,
        "energy_dissipation": params.get("energy_dissipation", "DMO"),
    }

    if element_type == "column":
        return _verify_column(frame_id, frame_data, joints, rd, seismic_ctx, payload.reinforcement)
    elif element_type == "beam":
        return _verify_beam(frame_id, frame_data, joints, rd, seismic_ctx, payload.reinforcement)
    else:
        raise HTTPException(status_code=400, detail=f"Tipo de elemento '{element_type}' no reconocido.")


def _verify_column(frame_id, frame_data, joints, rd, seismic_ctx, reinforcement) -> dict:
    """Re-verifica columna con refuerzo editado."""
    from engine.building.design.column_designer import ColumnDesigner

    # Obtener demandas del detalle existente
    detail = _find_frame_detail(rd, frame_id, "column")
    if not detail:
        raise HTTPException(status_code=400, detail="Ejecuta el diseño de columnas primero.")

    demands_by_combo = detail.get("demands", {}).get("by_combination", [])

    designer = ColumnDesigner(
        frame_id         = frame_id,
        frame_data       = frame_data,
        joints           = joints,
        demands_by_combo = demands_by_combo,
        seismic_params   = seismic_ctx,
        cover_m          = 0.040,
        fy_MPa           = 420.0,
    )
    return designer.verify_custom(reinforcement)


def _verify_beam(frame_id, frame_data, joints, rd, seismic_ctx, reinforcement) -> dict:
    """Re-verifica viga con refuerzo editado."""
    from engine.building.design.beam_designer import BeamDesigner

    detail = _find_frame_detail(rd, frame_id, "beam")
    if not detail:
        raise HTTPException(status_code=400, detail="Ejecuta el diseño de vigas primero.")

    demands_by_combo = detail.get("demands", {}).get("by_combination", [])
    demands_by_zone  = {
        zone: detail["demands"]["by_zone"][zone]
        for zone in ("end_i", "mid", "end_j")
        if zone in detail.get("demands", {}).get("by_zone", {})
    }

    designer = BeamDesigner(
        frame_id          = frame_id,
        frame_data        = frame_data,
        joints            = joints,
        demands_by_zone   = demands_by_zone,
        demands_by_combo  = demands_by_combo,
        seismic_params    = seismic_ctx,
        cover_m           = 0.040,
        fy_MPa            = 420.0,
    )
    return designer.verify_custom(reinforcement)


# ── Utils ─────────────────────────────────────────────────────────────────────

def _frame_status(dcr: float, ok: bool, user_modified: bool) -> str:
    if user_modified:
        return "user_modified"
    if not ok:
        return "ng"
    if dcr > 0.85:
        return "warning"
    return "ok"


def _find_frame_detail(rd: str, frame_id: str, etype: str) -> dict | None:
    filename = "design_columns_detail.json" if etype == "column" else "beam_design_detail.json"
    key      = "columns" if etype == "column" else "beams"
    data     = _load_json_safe(os.path.join(rd, filename))
    if not data:
        return None
    for item in data.get(key, []):
        if item.get("frame_id") == frame_id:
            return item
    return None


def _utc_now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
