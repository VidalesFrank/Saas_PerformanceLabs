"""Router para el módulo Ground Motion Analysis — Análisis de Acelerogramas.

Endpoints:
  POST /api/v1/ground-motion/detect          Detectar estructura del archivo (sin auth)
  POST /api/v1/ground-motion/records         Crear registro (importar)
  GET  /api/v1/ground-motion/records         Listar registros del usuario
  GET  /api/v1/ground-motion/records/{id}    Obtener registro + datos
  DELETE /api/v1/ground-motion/records/{id}  Eliminar registro
  GET  /api/v1/ground-motion/records/{id}/timeseries    Historia de tiempo
  POST /api/v1/ground-motion/records/{id}/process       Procesar señal (baseline/filter)
  POST /api/v1/ground-motion/records/{id}/intensity     Calcular IMs (sync)
  POST /api/v1/ground-motion/records/{id}/fft           FFT (sync)
  POST /api/v1/ground-motion/records/{id}/spectrum      Espectro de respuesta (sync/async)
  GET  /api/v1/ground-motion/jobs/{job_id}              Estado de job
  GET  /api/v1/ground-motion/jobs/{job_id}/result       Resultado de job
"""

from __future__ import annotations

import json
import os
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.config import settings
from app.db import get_db
from app.models import GMJob, GMJobStatus, GroundMotionRecord, User

from app.engine.ground_motion.io.detector import detect_structure
from app.engine.ground_motion.io.parser import (
    ColumnMapping,
    build_record,
    record_from_storage_dict,
    record_to_storage_dict,
)
from app.engine.ground_motion.processing.integration import compute_all, compute_all_corrected
from app.engine.ground_motion.processing.baseline import (
    apply_baseline_correction,
    baseline_correction_report,
)
from app.engine.ground_motion.processing.filtering import butterworth_filter, filter_report
from app.engine.ground_motion.analysis.intensity import compute_all_intensity_measures
from app.engine.ground_motion.analysis.frequency import compute_fft, compute_psd_welch
from app.engine.ground_motion.analysis.spectra import (
    response_spectrum,
    response_spectrum_multi_xi,
    default_period_array,
    spectrum_at_period,
)
from app.engine.ground_motion.analysis.inelastic_spectra import inelastic_spectrum_multi_mu

import numpy as np

router = APIRouter(prefix="/api/v1/ground-motion", tags=["ground-motion"])


# ── Directorio de datos ───────────────────────────────────────────────────────

def _gm_dir(record_id: str) -> str:
    base = os.path.join(settings.base_data_dir, "ground_motion", record_id)
    os.makedirs(base, exist_ok=True)
    return base


def _load_record_data(record: GroundMotionRecord):
    """Carga el JSON del registro desde disco y retorna un GroundMotionRecord."""
    if not record.raw_data_path or not os.path.exists(record.raw_data_path):
        raise HTTPException(404, "Datos del registro no encontrados en disco.")
    with open(record.raw_data_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return record_from_storage_dict(data)


def _save_record_data(record_db: GroundMotionRecord, gm_rec) -> str:
    """Serializa el GroundMotionRecord a JSON y lo guarda en disco."""
    gm_rec.id = record_db.id
    data = record_to_storage_dict(gm_rec)
    path = os.path.join(_gm_dir(record_db.id), "record_data.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f)
    return path


# ── Esquemas Pydantic ─────────────────────────────────────────────────────────

class ColumnMappingIn(BaseModel):
    col_index: int
    quantity: str       # 'acceleration' | 'time' | 'velocity' | 'displacement' | 'ignore'
    unit: str           # 'g', 'm/s²', 's', 'cm/s', etc.
    component: str = ""
    name: str = ""


class CreateRecordRequest(BaseModel):
    name: str = Field("", description="Nombre del registro")
    column_mappings: list[ColumnMappingIn]
    dt: float | None = Field(None, description="Δt en segundos (requerido si no hay columna de tiempo)")
    metadata: dict = Field(default_factory=dict)
    flatten: bool = Field(
        False,
        description=(
            "True si el archivo es UNA sola serie de tiempo repartida en varias "
            "columnas por línea (formato PEER/NGA — ver detect().wrapped_series_hint). "
            "Las columnas mapeadas se concatenan fila-mayor en un único canal."
        ),
    )


class RecordOut(BaseModel):
    id: str
    name: str
    source_file: str | None
    dt: float | None
    n_samples: int | None
    duration: float | None
    acc_unit_original: str | None
    metadata_json: dict | None
    created_at: str


class ProcessRequest(BaseModel):
    operation: str      # 'baseline' | 'filter'
    component: str = ""
    # Baseline params
    baseline_method: str = "linear"   # 'mean' | 'linear' | 'polynomial'
    polynomial_order: int = 2
    # Filter params
    filter_type: str = "bandpass"      # 'lowpass' | 'highpass' | 'bandpass' | 'bandstop'
    fc_low: float | None = None
    fc_high: float | None = None
    filter_order: int = 4
    # Integration options
    correct_after_integrate: bool = True


class SpectrumRequest(BaseModel):
    component: str = ""
    xi: float = 0.05
    xi_list: list[float] = Field(default_factory=lambda: [0.02, 0.05, 0.10])
    T_min: float = 0.01
    T_max: float = 4.0
    n_points: int = 150
    multi_xi: bool = False


class SpectrumAtPeriodRequest(BaseModel):
    component: str = ""
    T: float
    xi: float = 0.05


# ── Endpoint: detectar estructura del archivo ─────────────────────────────────

@router.post("/detect")
async def detect_file_structure(file: UploadFile = File(...)) -> dict:
    """Detecta la estructura matemática del archivo sin crear ningún registro.

    Retorna columnas, filas, tipo de separador, metadata del encabezado
    y heurísticas por columna. No requiere autenticación.
    """
    content = await file.read()
    try:
        result = detect_structure(file.filename or "unknown.txt", content)
    except Exception as exc:
        raise HTTPException(400, f"Error analizando el archivo: {exc}")

    return {
        "filename":        result.filename,
        "file_format":     result.file_format,
        "n_rows":          result.n_rows,
        "n_cols":          result.n_cols,
        "has_header":      result.has_header,
        "delimiter":       result.delimiter,
        "header_metadata": result.header_metadata,
        "n_skipped_rows":  result.n_skipped_rows,
        "warnings":        result.warnings,
        "preview_rows":    result.preview_rows,
        "wrapped_series_hint": result.wrapped_series_hint,
        "columns": [
            {
                "index":                    c.index,
                "header":                   c.header,
                "n_valid":                  c.n_valid,
                "n_nan":                    c.n_nan,
                "min_val":                  c.min_val,
                "max_val":                  c.max_val,
                "mean_val":                 c.mean_val,
                "is_monotonic_increasing":  c.is_monotonic_increasing,
                "is_oscillatory":           c.is_oscillatory,
                "delta_stats":              c.delta_stats,
                "preview":                  c.preview,
                "suggested_role":           c.suggested_role,
                "confidence":               c.confidence,
            }
            for c in result.columns
        ],
    }


# ── Endpoint: crear registro (importar) ──────────────────────────────────────

@router.post("/records", response_model=RecordOut)
async def create_record(
    file: UploadFile = File(...),
    config: str = Form(...),   # JSON string de CreateRecordRequest
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Importa un archivo de acelerograma y crea un GroundMotionRecord."""
    # Parsear config
    try:
        req = CreateRecordRequest.model_validate_json(config)
    except Exception as exc:
        raise HTTPException(422, f"Config inválida: {exc}")

    content = await file.read()
    filename = file.filename or "record.txt"

    # Convertir mapeos
    mappings = [
        ColumnMapping(
            col_index=m.col_index,
            quantity=m.quantity,
            unit=m.unit,
            component=m.component,
            name=m.name,
        )
        for m in req.column_mappings
    ]

    # Construir record científico
    try:
        gm_rec = build_record(
            filename=filename,
            content=content,
            column_mappings=mappings,
            dt=req.dt,
            record_name=req.name or Path(filename).stem,
            metadata=req.metadata,
            flatten=req.flatten,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    except Exception as exc:
        raise HTTPException(500, f"Error importando el registro: {exc}\n{traceback.format_exc()}")

    # Crear registro en BD
    acc_ch = gm_rec.get_acceleration_channel()
    record_db = GroundMotionRecord(
        owner_id=current_user.id,
        name=gm_rec.name,
        source_file=filename,
        dt=gm_rec.dt,
        n_samples=gm_rec.n_samples,
        duration=gm_rec.duration,
        acc_unit_original=acc_ch.original_unit if acc_ch else None,
        metadata_json=gm_rec.metadata,
    )
    db.add(record_db)
    db.flush()   # obtener ID

    # Guardar JSON en disco
    path = _save_record_data(record_db, gm_rec)
    record_db.raw_data_path = path
    db.commit()
    db.refresh(record_db)

    return _record_to_out(record_db)


# ── Endpoint: listar registros ────────────────────────────────────────────────

@router.get("/records", response_model=list[RecordOut])
def list_records(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list:
    records = (
        db.query(GroundMotionRecord)
        .filter(GroundMotionRecord.owner_id == current_user.id)
        .order_by(GroundMotionRecord.created_at.desc())
        .all()
    )
    return [_record_to_out(r) for r in records]


# ── Endpoint: obtener registro ────────────────────────────────────────────────

@router.get("/records/{record_id}")
def get_record(
    record_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    record_db = _get_record_or_404(record_id, current_user.id, db)
    out = _record_to_out(record_db)
    # Agregar jobs del registro
    jobs = [_job_to_out(j) for j in record_db.jobs]
    out["jobs"] = jobs
    return out


# ── Endpoint: eliminar registro ───────────────────────────────────────────────

@router.delete("/records/{record_id}", status_code=204)
def delete_record(
    record_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    record_db = _get_record_or_404(record_id, current_user.id, db)
    # Eliminar archivos del disco
    gm_dir = os.path.join(settings.base_data_dir, "ground_motion", record_id)
    import shutil
    if os.path.isdir(gm_dir):
        shutil.rmtree(gm_dir, ignore_errors=True)
    db.delete(record_db)
    db.commit()


# ── Endpoint: historia de tiempo ──────────────────────────────────────────────

@router.get("/records/{record_id}/timeseries")
def get_timeseries(
    record_id: str,
    component: str = "",
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Retorna la historia de tiempo (a, v, d) con integración numérica."""
    record_db = _get_record_or_404(record_id, current_user.id, db)
    gm_rec    = _load_record_data(record_db)

    ts = gm_rec.timeseries_to_dict(component)
    if not ts:
        raise HTTPException(404, "No se encontró canal de aceleración para el componente indicado.")

    acc_ms2 = np.array(ts["a_ms2"])
    dt = record_db.dt or gm_rec.dt

    vel, disp = compute_all_corrected(acc_ms2, dt)

    ts["v_ms"]  = vel.tolist()
    ts["d_m"]   = disp.tolist()
    ts["pgv_ms"] = float(np.max(np.abs(vel)))
    ts["pgd_m"]  = float(np.max(np.abs(disp)))

    return ts


# ── Endpoint: procesar señal ──────────────────────────────────────────────────

@router.post("/records/{record_id}/process")
def process_signal(
    record_id: str,
    req: ProcessRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Aplica corrección de línea base o filtrado y guarda el resultado."""
    record_db = _get_record_or_404(record_id, current_user.id, db)
    gm_rec    = _load_record_data(record_db)

    acc_ch = gm_rec.get_acceleration_channel(req.component)
    if acc_ch is None:
        raise HTTPException(404, "Canal de aceleración no encontrado.")

    original = acc_ch.effective_values_si()

    if req.operation == "baseline":
        corrected = apply_baseline_correction(
            original, req.baseline_method, req.polynomial_order
        )
        report = baseline_correction_report(original, corrected, gm_rec.dt)
        acc_ch.processed_values = corrected
        from app.engine.ground_motion.record import ProcessingStep
        acc_ch.processing_history.append(ProcessingStep(
            operation=f"baseline_{req.baseline_method}",
            params={"method": req.baseline_method, "polynomial_order": req.polynomial_order},
            description=f"Corrección de línea base: {req.baseline_method}",
        ))

    elif req.operation == "filter":
        if req.fc_low is None and req.fc_high is None:
            raise HTTPException(422, "Especifica fc_low y/o fc_high para el filtro.")
        try:
            corrected = butterworth_filter(
                original, gm_rec.fs,
                req.filter_type, req.fc_low, req.fc_high, req.filter_order
            )
        except ValueError as exc:
            raise HTTPException(422, str(exc))
        report = filter_report(original, corrected, gm_rec.fs)
        acc_ch.processed_values = corrected
        from app.engine.ground_motion.record import ProcessingStep
        acc_ch.processing_history.append(ProcessingStep(
            operation="filter_butterworth",
            params={
                "filter_type": req.filter_type, "fc_low": req.fc_low,
                "fc_high": req.fc_high, "order": req.filter_order,
            },
            description=f"Filtro Butterworth {req.filter_type}",
        ))

    elif req.operation == "reset":
        acc_ch.processed_values = None
        acc_ch.processing_history.clear()
        report = {"message": "Señal restaurada a valores SI originales."}
        corrected = original

    else:
        raise HTTPException(422, f"Operación desconocida: {req.operation}")

    # Guardar cambios
    _save_record_data(record_db, gm_rec)
    record_db.updated_at = datetime.now(timezone.utc)
    db.commit()

    # Calcular series derivadas para la respuesta
    vel, disp = compute_all_corrected(corrected, gm_rec.dt)

    t = gm_rec.time.tolist() if len(gm_rec.time) > 0 else (np.arange(len(corrected)) * gm_rec.dt).tolist()

    return {
        "operation": req.operation,
        "report": report,
        "t": t,
        "a_ms2": corrected.tolist(),
        "a_original_ms2": original.tolist(),
        "v_ms": vel.tolist(),
        "d_m": disp.tolist(),
    }


# ── Endpoint: intensity measures ──────────────────────────────────────────────

@router.post("/records/{record_id}/intensity")
def compute_intensity(
    record_id: str,
    component: str = "",
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Calcula todos los parámetros de intensidad sísmica (PGA, PGV, Arias, CAV, ...)."""
    record_db = _get_record_or_404(record_id, current_user.id, db)
    gm_rec    = _load_record_data(record_db)

    acc_ch = gm_rec.get_acceleration_channel(component)
    if acc_ch is None:
        raise HTTPException(404, "Canal de aceleración no encontrado.")

    acc_ms2 = acc_ch.effective_values_si()
    vel, disp = compute_all_corrected(acc_ms2, gm_rec.dt)

    ims = compute_all_intensity_measures(acc_ms2, vel, disp, gm_rec.dt)

    from app.engine.ground_motion.analysis.intensity import compute_significant_duration
    dur_595 = compute_significant_duration(acc_ms2, gm_rec.dt, 5.0, 95.0)
    dur_575 = compute_significant_duration(acc_ms2, gm_rec.dt, 5.0, 75.0)

    return {
        **ims,
        "duration_record": gm_rec.duration,
        "dt": gm_rec.dt,
        "fs": gm_rec.fs,
        "nyquist": gm_rec.nyquist,
        "ia_cumulative": dur_595["ia_cum"],
        "ia_cumulative_normalized": dur_595["ia_cum_normalized"],
        "t": dur_595["t"],
        "D5_95_details": {k: v for k, v in dur_595.items() if k not in ("ia_cum", "ia_cum_normalized", "t")},
        "D5_75_details": {k: v for k, v in dur_575.items() if k not in ("ia_cum", "ia_cum_normalized", "t")},
    }


# ── Endpoint: FFT ─────────────────────────────────────────────────────────────

@router.post("/records/{record_id}/fft")
def compute_frequency(
    record_id: str,
    component: str = "",
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Calcula FFT y PSD (Welch) de la señal de aceleración."""
    record_db = _get_record_or_404(record_id, current_user.id, db)
    gm_rec    = _load_record_data(record_db)

    acc_ch = gm_rec.get_acceleration_channel(component)
    if acc_ch is None:
        raise HTTPException(404, "Canal de aceleración no encontrado.")

    acc_ms2 = acc_ch.effective_values_si()

    fft_result = compute_fft(acc_ms2, gm_rec.dt)
    psd_result = compute_psd_welch(acc_ms2, gm_rec.dt)

    return {
        "fft": fft_result,
        "psd": psd_result,
        "dt": gm_rec.dt,
        "fs": gm_rec.fs,
        "nyquist": gm_rec.nyquist,
        "n_samples": gm_rec.n_samples,
    }


# ── Endpoint: espectro de respuesta ──────────────────────────────────────────

@router.post("/records/{record_id}/spectrum")
def compute_spectrum_endpoint(
    record_id: str,
    req: SpectrumRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Calcula el espectro de respuesta elástico usando Newmark-β.

    Para N_points ≤ 300 se calcula sincrónicamente.
    Para N_points > 300 se lanzará una tarea Celery (aún no implementado en Phase 1).
    """
    record_db = _get_record_or_404(record_id, current_user.id, db)
    gm_rec    = _load_record_data(record_db)

    acc_ch = gm_rec.get_acceleration_channel(req.component)
    if acc_ch is None:
        raise HTTPException(404, "Canal de aceleración no encontrado.")

    acc_ms2 = acc_ch.effective_values_si()
    T_array = default_period_array(req.T_min, req.T_max, req.n_points)

    if req.multi_xi:
        result = response_spectrum_multi_xi(acc_ms2, gm_rec.dt, T_array, req.xi_list)
    else:
        result = response_spectrum(acc_ms2, gm_rec.dt, T_array, req.xi)

    result["component"] = req.component or "default"
    result["record_name"] = record_db.name
    return result


# ── Endpoint: demanda a periodo específico ─────────────────────────────────────

@router.post("/records/{record_id}/spectrum/at-period")
def spectrum_at_period_endpoint(
    record_id: str,
    req: SpectrumAtPeriodRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Calcula la demanda espectral para un periodo T específico (Spectrum Inspector)."""
    record_db = _get_record_or_404(record_id, current_user.id, db)
    gm_rec    = _load_record_data(record_db)

    acc_ch = gm_rec.get_acceleration_channel(req.component)
    if acc_ch is None:
        raise HTTPException(404, "Canal de aceleración no encontrado.")

    acc_ms2 = acc_ch.effective_values_si()
    result  = spectrum_at_period(acc_ms2, gm_rec.dt, req.T, req.xi)
    return result


# ── Endpoint: espectro de respuesta inelástica ───────────────────────────────

@router.post("/records/{record_id}/inelastic-spectrum", response_model=dict)
async def compute_inelastic_spectrum(
    record_id: str,
    params: dict = Body(default={}),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Espectro de respuesta inelástica (ductilidad constante EPP).

    Calcula espectros de ductilidad constante para múltiples valores de μ
    usando el oscilador SDOF elasto-perfectamente plástico (α=0) con el
    método Newmark-β predictor-corrector (misma formulación que /spectrum).

    Body params:
      - xi       : float — amortiguamiento fraccional (default 0.05).
      - mu_list  : list[float] — ductilidades objetivo (default [1.0, 1.5, 2.0, 3.0, 4.0, 6.0]).
      - T_min    : float — periodo mínimo en s (default 0.01).
      - T_max    : float — periodo máximo en s (default 4.0).
      - n_points : int — número de puntos del espectro (default 100).
      - component: str — componente del canal de aceleración (default "").

    Returns:
      {
        "T":          [...],
        "Sa_elastic": [...],
        "spectra": {
          "1.0": {"Sa_inel": [...], "Sd_inel": [...], "R": [...]},
          "2.0": {...},
          ...
        },
        "xi": float,
        "mu_list": [...],
        "component": str,
        "record_name": str,
      }
    """
    xi        = float(params.get("xi", 0.05))
    mu_list   = list(params.get("mu_list", [1.0, 1.5, 2.0, 3.0, 4.0, 6.0]))
    T_min     = float(params.get("T_min", 0.01))
    T_max     = float(params.get("T_max", 4.0))
    n_points  = int(params.get("n_points", 100))
    component = str(params.get("component", ""))

    record_db = _get_record_or_404(record_id, current_user.id, db)
    gm_rec    = _load_record_data(record_db)

    acc_ch = gm_rec.get_acceleration_channel(component)
    if acc_ch is None:
        raise HTTPException(404, "Canal de aceleración no encontrado.")

    acc_ms2 = acc_ch.effective_values_si()
    T_array = default_period_array(T_min, T_max, n_points)

    result = inelastic_spectrum_multi_mu(acc_ms2, gm_rec.dt, T_array, xi, mu_list)
    result["component"]   = component or "default"
    result["record_name"] = record_db.name
    return result


# ── Endpoint: estado de job ───────────────────────────────────────────────────

@router.get("/jobs/{job_id}")
def get_job_status(
    job_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    job = db.get(GMJob, job_id)
    if not job or job.owner_id != current_user.id:
        raise HTTPException(404, "Job no encontrado.")
    return _job_to_out(job)


@router.get("/jobs/{job_id}/result")
def get_job_result(
    job_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    job = db.get(GMJob, job_id)
    if not job or job.owner_id != current_user.id:
        raise HTTPException(404, "Job no encontrado.")
    if job.status != GMJobStatus.success:
        raise HTTPException(400, f"Job aún no completado (status: {job.status}).")
    if not job.result_path or not os.path.exists(job.result_path):
        raise HTTPException(404, "Archivo de resultado no encontrado.")
    with open(job.result_path, "r", encoding="utf-8") as f:
        return json.load(f)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_record_or_404(record_id: str, owner_id: str, db: Session) -> GroundMotionRecord:
    rec = db.get(GroundMotionRecord, record_id)
    if not rec or rec.owner_id != owner_id:
        raise HTTPException(404, "Registro de movimiento del suelo no encontrado.")
    return rec


def _record_to_out(r: GroundMotionRecord) -> dict:
    return {
        "id":                r.id,
        "name":              r.name,
        "source_file":       r.source_file,
        "dt":                r.dt,
        "n_samples":         r.n_samples,
        "duration":          r.duration,
        "acc_unit_original": r.acc_unit_original,
        "metadata_json":     r.metadata_json or {},
        "created_at":        r.created_at.isoformat() if r.created_at else "",
        "updated_at":        r.updated_at.isoformat() if r.updated_at else "",
    }


def _job_to_out(j: GMJob) -> dict:
    return {
        "id":             j.id,
        "job_type":       j.job_type,
        "status":         j.status.value,
        "result_summary": j.result_summary,
        "error_message":  j.error_message,
        "created_at":     j.created_at.isoformat() if j.created_at else "",
        "finished_at":    j.finished_at.isoformat() if j.finished_at else None,
    }
