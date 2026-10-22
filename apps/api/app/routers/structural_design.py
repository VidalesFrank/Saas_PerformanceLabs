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
    # Al editar el refuerzo (patrón o individual) se invalida el spec no lineal
    # cacheado — así el próximo pushover / NLTHA lo regenera con los nuevos valores.
    _invalidate_nonlinear_spec(project)


def _invalidate_nonlinear_spec(project: StructuralProject) -> None:
    try:
        wd = _work_dir(project)
    except HTTPException:
        return
    spec_path = os.path.join(wd, "nonlinear", "nonlinear_model.json")
    if os.path.exists(spec_path):
        try:
            os.remove(spec_path)
        except OSError:
            pass


def _section_patterns(saved_r: dict) -> dict:
    """Devuelve el dict de patrones de sección, sin mutar `saved_r`."""
    sp = saved_r.get("section_patterns")
    return sp if isinstance(sp, dict) else {}


def _section_key(element_type: str, section_name: str) -> str:
    return f"{element_type.lower()}:{section_name}"


# ── Schemas ───────────────────────────────────────────────────────────────────

class SaveReinforcementRequest(BaseModel):
    reinforcement: dict                # contenido libre; validado por el engine
    notes: str | None = None


class BulkReinforcementRequest(BaseModel):
    frame_ids: list[str]
    reinforcement: dict
    notes: str | None = None
    pattern_label: str | None = None   # etiqueta visible para el ingeniero


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

    def _reinf_meta(fid: str) -> dict:
        entry = saved_r.get(fid) or {}
        return {
            "source":        entry.get("source"),         # "bulk" | "manual" | None
            "pattern_label": entry.get("pattern_label"),
            "bulk_batch_id": entry.get("bulk_batch_id"),
        }

    if col_data:
        for c in col_data.get("columns", []):
            modified = c["id"] in saved_r
            frames.append({
                "frame_id":    c["id"],
                "story":       c["story"],
                "element_type": "column",
                "section":     c["section"],
                "dcr":         c.get("dcr", 0.0),
                "ok":          c.get("ok", True),
                "has_detail":  c.get("has_detail", False),
                "user_modified": modified,
                "status":      _frame_status(c.get("dcr", 0.0), c.get("ok", True), modified),
                **_reinf_meta(c["id"]),
            })

    if beam_data:
        for b in beam_data.get("beams", []):
            modified = b["id"] in saved_r
            frames.append({
                "frame_id":    b["id"],
                "story":       b["story"],
                "element_type": "beam",
                "section":     b["section"],
                "dcr":         b.get("dcr", 0.0),
                "ok":          b.get("ok", True),
                "has_detail":  b.get("has_detail", False),
                "user_modified": modified,
                "status":      _frame_status(b.get("dcr", 0.0), b.get("ok", True), modified),
                **_reinf_meta(b["id"]),
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
        "source":        "manual",
        # Si venía de un bulk previo y el usuario lo ajusta a mano, se descarta
        # la referencia al batch (así el "undo del patrón" no lo revierta).
        "pattern_label": None,
        "bulk_batch_id": None,
    }
    _save_reinforcement(project, saved_r)

    return {
        "frame_id": frame_id,
        "saved":    True,
        "message":  f"Refuerzo definitivo guardado para {frame_id}.",
    }


# ── PUT /frames/reinforcement/bulk ────────────────────────────────────────────

@router.put("/frames/reinforcement/bulk")
def save_reinforcement_bulk(
    project_id: str,
    payload: BulkReinforcementRequest,
    user: CurrentUser,
    db: DB,
):
    """
    Aplica el mismo refuerzo a varios frames de UNA SOLA sección y tipo.

    Valida que todos los frame_ids:
      - existan en los resultados de diseño del proyecto
      - sean del mismo element_type (todos columnas o todos vigas)
      - compartan la misma `section`
    Si no, retorna 400 con el detalle de la discrepancia.

    Cada entrada escrita en reinforcement.json queda marcada con:
      source="bulk", bulk_batch_id, pattern_label.
    """
    import uuid

    project = _get_project(db, project_id, user)
    rd      = _results_dir(project)

    if not payload.frame_ids:
        raise HTTPException(status_code=400, detail="frame_ids vacío.")

    # Indexar frames por id para validar homogeneidad
    col_data  = _load_json_safe(os.path.join(rd, "design_columns_results.json")) or {}
    beam_data = _load_json_safe(os.path.join(rd, "beam_design_results.json")) or {}
    index: dict[str, dict] = {}
    for c in col_data.get("columns", []):
        index[c["id"]] = {"element_type": "column", "section": c.get("section")}
    for b in beam_data.get("beams", []):
        index[b["id"]] = {"element_type": "beam", "section": b.get("section")}

    missing = [fid for fid in payload.frame_ids if fid not in index]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Frames no encontrados en los resultados de diseño: {missing[:5]}"
                   + (" …" if len(missing) > 5 else ""),
        )

    types    = {index[fid]["element_type"] for fid in payload.frame_ids}
    sections = {index[fid]["section"]      for fid in payload.frame_ids}
    if len(types) > 1:
        raise HTTPException(
            status_code=400,
            detail=f"Selección mixta: hay {sorted(types)}. Debe ser un solo element_type.",
        )
    if len(sections) > 1:
        raise HTTPException(
            status_code=400,
            detail=f"Selección con secciones distintas: {sorted(sections)}. Debe ser una sola.",
        )

    batch_id = f"b-{_utc_now().replace(':', '').replace('-', '')[:15]}-{uuid.uuid4().hex[:6]}"
    saved_at = _utc_now()
    saved_r  = _load_reinforcement(project)

    for fid in payload.frame_ids:
        saved_r[fid] = {
            "reinforcement": payload.reinforcement,
            "notes":         payload.notes,
            "saved_at":      saved_at,
            "source":        "bulk",
            "pattern_label": payload.pattern_label,
            "bulk_batch_id": batch_id,
        }
    _save_reinforcement(project, saved_r)

    return {
        "saved":          True,
        "n_frames":       len(payload.frame_ids),
        "frame_ids":      payload.frame_ids,
        "bulk_batch_id":  batch_id,
        "pattern_label":  payload.pattern_label,
        "element_type":   next(iter(types)),
        "section":        next(iter(sections)),
        "message":        f"Patrón aplicado a {len(payload.frame_ids)} elementos.",
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


# ─────────────────────────────────────────────────────────────────────────────
# Patrones de refuerzo POR SECCIÓN (as-built, edificios existentes)
#
# Permiten definir refuerzo longitudinal + transversal a nivel de sección
# geométrica (ej: C40x40, V30x40) que aplicará a todos los elementos que la
# usen, sin necesidad de correr el diseño automático. Convive con los
# overrides individuales por frame_id (que tienen mayor prioridad).
# ─────────────────────────────────────────────────────────────────────────────


class SectionReinforcementPayload(BaseModel):
    mode:            str                 # "manual" (único soportado hoy; "auto" = DELETE)
    longitudinal:    dict | None = None
    transverse:      dict | None = None  # columnas
    zones:           dict | None = None  # vigas
    shear:           dict | None = None  # vigas
    pattern_label:   str | None  = None
    notes:           str | None  = None


class SectionValidationRequest(BaseModel):
    longitudinal:  dict | None = None
    transverse:    dict | None = None
    zones:         dict | None = None
    shear:         dict | None = None


def _collect_sections_from_canonical(canonical: dict) -> list[dict]:
    """
    Agrupa los frames del canonical por (element_type, section_name).
    Devuelve una fila por combinación con conteo y propiedades geométricas.
    """
    sections_dict = canonical.get("sections", {})
    materials     = canonical.get("materials", {})
    frames        = canonical.get("frames",    {})

    groups: dict[tuple, dict] = {}
    for fid, fd in frames.items():
        et = str(fd.get("element_type", "")).lower()
        if et not in ("column", "beam"):
            continue
        sec_name = str(fd.get("section", ""))
        if not sec_name:
            continue
        key = (et, sec_name)
        if key not in groups:
            sec_d = sections_dict.get(sec_name, {}) or {}
            mat   = str(sec_d.get("material", ""))
            fpc   = ((materials.get(mat) or {}).get("fpc_mpa")
                     or (materials.get(mat) or {}).get("fc_MPa") or 21.0)
            groups[key] = {
                "section_key":  _section_key(et, sec_name),
                "section_name": sec_name,
                "element_type": et,
                "b_m":          float(sec_d.get("b_m", 0.30)),
                "h_m":          float(sec_d.get("h_m", 0.40 if et == "beam" else 0.30)),
                "material":     mat,
                "fc_MPa":       float(fpc),
                "fy_MPa":       420.0,
                "cover_m":      0.040,
                "frame_ids":    [],
                "stories":      set(),
            }
        groups[key]["frame_ids"].append(fid)
        if fd.get("story"):
            groups[key]["stories"].add(str(fd["story"]))

    out: list[dict] = []
    for g in groups.values():
        out.append({
            **g,
            "n_elements": len(g["frame_ids"]),
            "stories":    sorted(g.pop("stories")),
        })
    out.sort(key=lambda g: (0 if g["element_type"] == "column" else 1, g["section_name"]))
    return out


@router.get("/sections")
def list_sections(project_id: str, user: CurrentUser, db: DB):
    """
    Lista las secciones geométricas del modelo con estado de refuerzo:
      - `mode`: "auto" (sin patrón manual) | "manual" (as-built definido)
      - resumen del refuerzo si manual
      - cantidad de frames que usan la sección
    """
    project = _get_project(db, project_id, user)
    canonical = _load_json_safe(project.canonical_model_path) if project.canonical_model_path else None
    if not canonical:
        raise HTTPException(status_code=400, detail="Modelo canónico no disponible.")

    sections  = _collect_sections_from_canonical(canonical)
    saved_r   = _load_reinforcement(project)
    patterns  = _section_patterns(saved_r)

    # Frames con override individual (para informar al cliente cuántos están
    # con override vs heredando de la sección)
    frame_overrides = {
        fid for fid, v in saved_r.items()
        if fid != "section_patterns" and isinstance(v, dict) and "reinforcement" in v
    }

    for s in sections:
        key   = s["section_key"]
        patt  = patterns.get(key)
        s["mode"]           = "manual" if patt else "auto"
        s["pattern"]        = patt
        s["pattern_label"]  = (patt or {}).get("pattern_label")
        s["updated_at"]     = (patt or {}).get("updated_at")
        s["n_overrides"]    = sum(1 for fid in s["frame_ids"] if fid in frame_overrides)

    return {
        "sections":   sections,
        "n_total":    len(sections),
        "n_manual":   sum(1 for s in sections if s["mode"] == "manual"),
        "n_auto":     sum(1 for s in sections if s["mode"] == "auto"),
    }


@router.put("/sections/{element_type}/{section_name}/reinforcement")
def save_section_reinforcement(
    project_id:   str,
    element_type: str,
    section_name: str,
    payload:      SectionReinforcementPayload,
    user:         CurrentUser,
    db:           DB,
):
    """
    Guarda el patrón de refuerzo as-built para una sección geométrica.
    Aplica a todos los frames que usen esa sección (salvo que tengan override
    individual). Invalida el spec no lineal cacheado.
    """
    et = element_type.lower()
    if et not in ("column", "beam"):
        raise HTTPException(status_code=400, detail=f"element_type inválido: {element_type}")
    if payload.mode.lower() != "manual":
        raise HTTPException(
            status_code=400,
            detail="mode debe ser 'manual' (usa DELETE para volver a 'auto').",
        )

    project = _get_project(db, project_id, user)

    # Verificar que la sección exista en el canonical
    canonical = _load_json_safe(project.canonical_model_path) if project.canonical_model_path else None
    if not canonical:
        raise HTTPException(status_code=400, detail="Modelo canónico no disponible.")
    sections = _collect_sections_from_canonical(canonical)
    key = _section_key(et, section_name)
    sec_info = next((s for s in sections if s["section_key"] == key), None)
    if not sec_info:
        raise HTTPException(
            status_code=404,
            detail=f"Sección '{section_name}' no se usa en ningún elemento de tipo '{et}'.",
        )

    saved_r  = _load_reinforcement(project)
    patterns = dict(_section_patterns(saved_r))

    entry: dict[str, object] = {
        "mode":          "manual",
        "section_name":  section_name,
        "element_type":  et,
        "pattern_label": payload.pattern_label,
        "notes":         payload.notes,
        "updated_at":    _utc_now(),
    }
    if et == "column":
        if not payload.longitudinal or not payload.transverse:
            raise HTTPException(
                status_code=400,
                detail="Columna: se requieren `longitudinal` y `transverse`.",
            )
        entry["longitudinal"] = payload.longitudinal
        entry["transverse"]   = payload.transverse
    else:
        if not payload.zones or not payload.shear:
            raise HTTPException(
                status_code=400,
                detail="Viga: se requieren `zones` (end_i, mid, end_j) y `shear`.",
            )
        entry["zones"] = payload.zones
        entry["shear"] = payload.shear

    patterns[key] = entry
    saved_r["section_patterns"] = patterns
    _save_reinforcement(project, saved_r)

    return {
        "ok":            True,
        "section_key":   key,
        "n_elements":    sec_info["n_elements"],
        "pattern_label": payload.pattern_label,
        "message":       f"Patrón as-built aplicado a {sec_info['n_elements']} elementos.",
    }


@router.delete("/sections/{element_type}/{section_name}/reinforcement")
def delete_section_reinforcement(
    project_id:   str,
    element_type: str,
    section_name: str,
    user:         CurrentUser,
    db:           DB,
):
    """
    Elimina el patrón as-built de una sección (vuelve a modo auto).
    Los overrides individuales de frames NO se tocan.
    """
    et = element_type.lower()
    key = _section_key(et, section_name)
    project = _get_project(db, project_id, user)
    saved_r = _load_reinforcement(project)
    patterns = dict(_section_patterns(saved_r))
    if key not in patterns:
        return {"ok": True, "removed": False, "message": "La sección ya estaba en modo auto."}
    patterns.pop(key, None)
    saved_r["section_patterns"] = patterns
    _save_reinforcement(project, saved_r)
    return {"ok": True, "removed": True, "section_key": key}


@router.get("/overrides")
def list_frame_overrides(project_id: str, user: CurrentUser, db: DB):
    """
    Lista todos los overrides individuales por frame_id (del reinforcement.json).
    No incluye los patrones de sección — solo overrides elemento-por-elemento.
    """
    project = _get_project(db, project_id, user)
    saved_r = _load_reinforcement(project)
    overrides: dict[str, dict] = {}
    for fid, val in saved_r.items():
        if fid == "section_patterns":
            continue
        if not isinstance(val, dict):
            continue
        reinf = val.get("reinforcement", val)
        overrides[fid] = {
            "reinforcement": reinf,
            "source":        val.get("source"),
            "pattern_label": val.get("pattern_label"),
            "notes":         val.get("notes"),
            "saved_at":      val.get("saved_at") or val.get("updated_at"),
        }
    return {"overrides": overrides, "n_total": len(overrides)}


@router.delete("/frames/{frame_id}/reinforcement")
def delete_frame_reinforcement(
    project_id: str,
    frame_id:   str,
    user:       CurrentUser,
    db:         DB,
):
    """Elimina el override individual del frame — vuelve a heredar del patrón de sección."""
    project = _get_project(db, project_id, user)
    saved_r = _load_reinforcement(project)
    if frame_id not in saved_r:
        return {"ok": True, "removed": False, "frame_id": frame_id}
    saved_r.pop(frame_id, None)
    _save_reinforcement(project, saved_r)
    return {"ok": True, "removed": True, "frame_id": frame_id}


@router.post("/sections/{element_type}/{section_name}/validate-nsr10")
def validate_section_reinforcement(
    project_id:   str,
    element_type: str,
    section_name: str,
    payload:      SectionValidationRequest,
    user:         CurrentUser,
    db:           DB,
):
    """
    Valida un refuerzo propuesto contra NSR-10 (checks constructivos; no bloquea).
    Devuelve warnings con nivel info/warning/error.
    """
    from engine.building.nonlinear import validate_frame_reinforcement

    et = element_type.lower()
    if et not in ("column", "beam"):
        raise HTTPException(status_code=400, detail=f"element_type inválido: {element_type}")

    project = _get_project(db, project_id, user)
    canonical = _load_json_safe(project.canonical_model_path) if project.canonical_model_path else None
    if not canonical:
        raise HTTPException(status_code=400, detail="Modelo canónico no disponible.")

    sections = _collect_sections_from_canonical(canonical)
    key = _section_key(et, section_name)
    sec_info = next((s for s in sections if s["section_key"] == key), None)
    if not sec_info:
        raise HTTPException(status_code=404, detail=f"Sección '{section_name}' no encontrada.")

    params = json.loads(project.parameters_json) if project.parameters_json else {}
    ed     = params.get("energy_dissipation", "DMO")

    if et == "column":
        reinf = {
            "longitudinal": payload.longitudinal or {},
            "transverse":   payload.transverse   or {},
        }
    else:
        reinf = {
            "zones": payload.zones or {},
            "shear": payload.shear or {},
        }

    geom = {
        "b_m":    sec_info["b_m"],
        "h_m":    sec_info["h_m"],
        "fc_MPa": sec_info["fc_MPa"],
        "fy_MPa": sec_info["fy_MPa"],
    }
    result = validate_frame_reinforcement(et, reinf, geom, ed)
    result["section_key"] = key
    return result
