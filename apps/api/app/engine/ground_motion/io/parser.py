"""Parser de archivos de acelerogramas hacia GroundMotionRecord.

Recibe el archivo y el mapeo definido por el usuario (qué columna es qué)
y produce un GroundMotionRecord normalizado con todos los canales en SI.
"""

from __future__ import annotations

import io
import re
from pathlib import Path
from typing import Any

import numpy as np

from ..record import GroundMotionRecord, SignalChannel
from ..units import (
    ACC_TO_MS2, TIME_TO_S, VEL_TO_MS, DISP_TO_M,
    acc_to_ms2, normalize_acc_unit,
)


# ── Esquema de mapeo de columnas ──────────────────────────────────────────────

class ColumnMapping:
    """Define cómo interpretar cada columna de un archivo."""

    def __init__(
        self,
        col_index: int,
        quantity: str,          # 'acceleration' | 'time' | 'velocity' | 'displacement' | 'ignore'
        unit: str,              # 'g', 'm/s²', 's', 'cm/s', etc.
        component: str = "",    # 'H1', 'H2', 'V', 'NS', 'EW', 'X', 'Y', 'Z', ''
        name: str = "",
    ):
        self.col_index = col_index
        self.quantity  = quantity.lower()
        self.unit      = unit
        self.component = component.upper()
        self.name      = name or f"{quantity.capitalize()}_{component or col_index}"


# ── Lectura de datos crudos ───────────────────────────────────────────────────

_NUMBER_RE = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")

def _is_number(s: str) -> bool:
    return bool(_NUMBER_RE.match(s.strip()))

def _try_float(s: str) -> float | None:
    try:
        return float(s.strip())
    except (ValueError, AttributeError):
        return None

def _detect_delimiter(lines: list[str]) -> str:
    sample = [ln for ln in lines if ln.strip()][:20]
    scores = {",": 0, "\t": 0, ";": 0}
    for ln in sample:
        scores[","] += ln.count(",")
        scores["\t"] += ln.count("\t")
        scores[";"] += ln.count(";")
    best = max(scores, key=lambda k: scores[k])
    return best if scores[best] > 0 else " "


def _read_numeric_lines(content: bytes, filename: str) -> tuple[list[list[float]], dict]:
    """Lee las líneas numéricas de TXT/CSV y retorna (filas, metadata_header)."""
    ext = Path(filename).suffix.lower()

    if ext in (".xls", ".xlsx"):
        return _read_excel_lines(content)

    try:
        text = content.decode("utf-8", errors="replace")
    except Exception:
        text = content.decode("latin-1", errors="replace")

    raw_lines = text.splitlines()
    header_lines: list[str] = []
    numeric_lines: list[str] = []
    found = False

    for ln in raw_lines:
        stripped = ln.strip()
        if not stripped:
            continue
        parts = stripped.split()
        ratio = sum(1 for p in parts if _is_number(p)) / max(len(parts), 1)
        if ratio >= 0.5:
            numeric_lines.append(stripped)
            found = True
        elif not found:
            header_lines.append(stripped)

    sep = _detect_delimiter(numeric_lines)

    rows: list[list[float]] = []
    for ln in numeric_lines:
        if sep == " ":
            parts = ln.split()
        else:
            parts = ln.split(sep)
        row = [_try_float(p) for p in parts]
        vals = [v for v in row if v is not None]
        if vals:
            rows.append([v if v is not None else float("nan") for v in row])

    # Metadata del encabezado
    metadata: dict = {}
    combined = " ".join(header_lines).upper()
    for pattern, key, cast in [
        (r"NPTS\s*[=:]\s*(\d+)",             "npts", int),
        (r"DT\s*[=:]\s*([\d.eE+\-]+)",       "dt",   float),
        (r"DELTA\s*T\s*[=:]\s*([\d.eE+\-]+)", "dt",  float),
        (r"DT\s*=\s*([\d.]+)\s*SEC",          "dt",   float),
    ]:
        m = re.search(pattern, combined, re.IGNORECASE)
        if m:
            try:
                metadata[key] = cast(m.group(1))
            except (ValueError, IndexError):
                pass

    return rows, metadata


def _read_excel_lines(content: bytes) -> tuple[list[list[float]], dict]:
    import pandas as pd
    df = pd.read_excel(io.BytesIO(content), header=None)
    # Drop header row if string
    if len(df) > 0:
        first = df.iloc[0].tolist()
        if any(isinstance(v, str) for v in first):
            df = df.iloc[1:].reset_index(drop=True)
    df_num = df.apply(pd.to_numeric, errors="coerce")
    rows = df_num.values.tolist()
    return rows, {}


# ── Constructor de GroundMotionRecord ─────────────────────────────────────────

def build_record(
    filename: str,
    content: bytes,
    column_mappings: list[ColumnMapping],
    dt: float | None = None,
    record_name: str = "",
    metadata: dict | None = None,
    dt_unit: str = "s",
) -> GroundMotionRecord:
    """Construye un GroundMotionRecord a partir del archivo y el mapeo de columnas.

    Args:
        filename: nombre del archivo original.
        content: contenido binario del archivo.
        column_mappings: lista de ColumnMapping — uno por columna que se usará
                         (las columnas con quantity='ignore' se saltan).
        dt: intervalo de tiempo en segundos. Obligatorio si no hay columna de tiempo.
        record_name: nombre para el registro. Si vacío usa el nombre del archivo.
        metadata: dict con metadata adicional (earthquake, station, etc.).
        dt_unit: unidad del tiempo cuando hay columna de tiempo ('s', 'ms').

    Returns:
        GroundMotionRecord normalizado.
    """
    rows, header_meta = _read_numeric_lines(content, filename)

    if not rows:
        raise ValueError("No se encontraron datos numéricos en el archivo.")

    # Usar dt del encabezado como fallback si no se proporcionó
    if dt is None and "dt" in header_meta:
        dt = float(header_meta["dt"])

    # Filtrar mappings activos (no 'ignore')
    active = [m for m in column_mappings if m.quantity != "ignore"]

    # ── Verificar que hay al menos un canal de aceleración ────────────────────
    acc_mappings = [m for m in active if m.quantity == "acceleration"]
    if not acc_mappings:
        raise ValueError("Se debe mapear al menos una columna como 'acceleration'.")

    # ── Extraer columna de tiempo si existe ───────────────────────────────────
    time_mapping = next((m for m in active if m.quantity == "time"), None)
    time_col: np.ndarray | None = None
    computed_dt: float | None = None

    if time_mapping is not None:
        t_raw = np.array([
            row[time_mapping.col_index] if time_mapping.col_index < len(row) else float("nan")
            for row in rows
        ], dtype=float)
        # Convertir a segundos
        t_factor = TIME_TO_S.get(time_mapping.unit, 1.0)
        time_col = t_raw * t_factor

        # Calcular Δt desde la columna de tiempo
        diffs = np.diff(time_col[np.isfinite(time_col)])
        if len(diffs) > 0:
            computed_dt = float(np.mean(diffs))
    elif dt is not None:
        computed_dt = dt
    else:
        raise ValueError(
            "No se encontró columna de tiempo y no se especificó Δt. "
            "Proporcione el intervalo de tiempo del registro."
        )

    if computed_dt is None or computed_dt <= 0:
        raise ValueError(f"Δt inválido: {computed_dt}. Debe ser un número positivo.")

    # ── Construir canales ─────────────────────────────────────────────────────
    channels: list[SignalChannel] = []

    for mapping in active:
        if mapping.quantity == "time":
            continue  # el tiempo se maneja por separado

        raw_vals = np.array([
            row[mapping.col_index] if mapping.col_index < len(row) else float("nan")
            for row in rows
        ], dtype=float)

        # Convertir a SI según la magnitud
        if mapping.quantity == "acceleration":
            vals_si = acc_to_ms2(raw_vals, mapping.unit)
            si_unit = "m/s²"
        elif mapping.quantity == "velocity":
            factor = VEL_TO_MS.get(mapping.unit, 1.0)
            vals_si = raw_vals * factor
            si_unit = "m/s"
        elif mapping.quantity == "displacement":
            factor = DISP_TO_M.get(mapping.unit, 1.0)
            vals_si = raw_vals * factor
            si_unit = "m"
        else:
            vals_si = raw_vals.copy()
            si_unit = mapping.unit

        channels.append(SignalChannel(
            name=mapping.name,
            quantity=mapping.quantity,
            component=mapping.component,
            original_unit=mapping.unit,
            si_unit=si_unit,
            raw_values=raw_vals.copy(),
            values_si=vals_si,
            processed_values=None,
            processing_history=[],
        ))

    # ── Construir record ──────────────────────────────────────────────────────
    n_samples = len(rows)
    record = GroundMotionRecord(
        name=record_name or Path(filename).stem,
        source_file=filename,
        source_format=Path(filename).suffix.lower().lstrip("."),
        dt=computed_dt,
        n_samples=n_samples,
        duration=float((n_samples - 1) * computed_dt),
        fs=1.0 / computed_dt,
        nyquist=0.5 / computed_dt,
        channels=channels,
        metadata=metadata or {},
    )

    # Construir vector de tiempo
    if time_col is not None and len(time_col) == n_samples:
        record.time = time_col
    else:
        record.time = np.arange(n_samples) * computed_dt

    return record


def record_to_storage_dict(record: GroundMotionRecord) -> dict:
    """Serializa el GroundMotionRecord a un dict JSON-compatible para guardar en disco."""
    channels_data = []
    for ch in record.channels:
        channels_data.append({
            "name": ch.name,
            "quantity": ch.quantity,
            "component": ch.component,
            "original_unit": ch.original_unit,
            "si_unit": ch.si_unit,
            "raw_values": ch.raw_values.tolist(),
            "values_si": ch.values_si.tolist(),
            "processed_values": ch.processed_values.tolist() if ch.processed_values is not None else None,
            "processing_history": [
                {"operation": s.operation, "params": s.params,
                 "timestamp": s.timestamp, "description": s.description}
                for s in ch.processing_history
            ],
        })

    return {
        "id": record.id,
        "name": record.name,
        "source_file": record.source_file,
        "source_format": record.source_format,
        "dt": record.dt,
        "n_samples": record.n_samples,
        "duration": record.duration,
        "fs": record.fs,
        "nyquist": record.nyquist,
        "time": record.time.tolist(),
        "channels": channels_data,
        "metadata": record.metadata,
        "processing_log": [
            {"operation": s.operation, "params": s.params,
             "timestamp": s.timestamp, "description": s.description}
            for s in record.processing_log
        ],
        "created_at": record.created_at,
    }


def record_from_storage_dict(data: dict) -> GroundMotionRecord:
    """Reconstituye un GroundMotionRecord desde el dict guardado en disco."""
    from ..record import ProcessingStep

    channels = []
    for ch_data in data.get("channels", []):
        proc_hist = [
            ProcessingStep(
                operation=s["operation"], params=s["params"],
                timestamp=s.get("timestamp", ""), description=s.get("description", ""),
            )
            for s in ch_data.get("processing_history", [])
        ]
        proc_vals = (np.array(ch_data["processed_values"])
                     if ch_data.get("processed_values") is not None else None)
        channels.append(SignalChannel(
            name=ch_data["name"],
            quantity=ch_data["quantity"],
            component=ch_data.get("component", ""),
            original_unit=ch_data.get("original_unit", ""),
            si_unit=ch_data.get("si_unit", ""),
            raw_values=np.array(ch_data["raw_values"]),
            values_si=np.array(ch_data["values_si"]),
            processed_values=proc_vals,
            processing_history=proc_hist,
        ))

    proc_log = [
        ProcessingStep(
            operation=s["operation"], params=s["params"],
            timestamp=s.get("timestamp", ""), description=s.get("description", ""),
        )
        for s in data.get("processing_log", [])
    ]

    return GroundMotionRecord(
        id=data.get("id", ""),
        name=data.get("name", ""),
        source_file=data.get("source_file", ""),
        source_format=data.get("source_format", ""),
        dt=data["dt"],
        n_samples=data["n_samples"],
        duration=data["duration"],
        fs=data["fs"],
        nyquist=data["nyquist"],
        time=np.array(data.get("time", [])),
        channels=channels,
        metadata=data.get("metadata", {}),
        processing_log=proc_log,
        created_at=data.get("created_at", ""),
    )
