"""Lectura de archivos miniSEED (.msd, .mseed) para el módulo Ground Motion.

miniSEED es el formato binario estándar internacional para intercambio de datos
sismológicos (FDSN/IRIS/USGS/SGC). Un archivo típico contiene una serie de
tiempo continua de un solo canal, con metadata autodescriptiva en cada bloque:
red, estación, location, canal, dt, npts, dtype, timestamp de inicio.

Este módulo puentea obspy → GroundMotionRecord: el .msd salta el wizard de
mapeo de columnas del flujo TXT/CSV porque ya trae toda la info estructural.

Asunción de unidades: los .msd normalmente vienen en counts (int32 del ADC),
pero el usuario indica al importar en qué unidad interpretar los valores
crudos (por defecto 'g'). No aplicamos respuesta instrumental aquí — eso
requiere StationXML o dataless-SEED por separado.
"""

from __future__ import annotations

import io
from pathlib import Path
from typing import Any

import numpy as np

from ..record import GroundMotionRecord, ProcessingStep, SignalChannel
from ..units import ACC_TO_MS2, COUNTS_UNIT, G_STD, acc_to_ms2
from .detector import ColumnInfo, DetectedStructure


MINISEED_EXTS = {".msd", ".mseed", ".seed"}

# Umbral heurístico para autodetectar counts: si el dtype es entero (típico
# ADC) y el máximo absoluto supera este valor, es virtualmente imposible que
# sean g o m/s² físicos (100 g = 981 m/s² sería un impacto de proyectil).
# Kinemetrics / GeoSIG / SGC entregan miniSEED en counts sin excepción.
_COUNTS_AUTODETECT_THRESHOLD = 100.0


def is_miniseed_filename(filename: str) -> bool:
    """Detecta si el nombre del archivo sugiere formato miniSEED."""
    return Path(filename).suffix.lower() in MINISEED_EXTS


def _read_stream(content: bytes):
    """Lee bytes miniSEED con obspy y devuelve un Stream ya fusionado.

    Fusiona múltiples records/gaps con interpolación (obspy method=1) para
    entregar una traza continua. Si hay varios canales dentro del mismo
    archivo (poco común en un .msd por día/estación), quedan como Traces
    separados dentro del Stream retornado.
    """
    from obspy import read as obspy_read

    st = obspy_read(io.BytesIO(content), format="MSEED")
    if len(st) == 0:
        raise ValueError("El archivo miniSEED no contiene trazas.")
    # merge(method=1) une records consecutivos del mismo canal e interpola gaps
    st = st.merge(method=1, fill_value="interpolate")
    return st


def _extract_component_from_channel(channel_code: str) -> str:
    """Deduce el componente (E/N/Z) del último carácter del código SEED.

    Códigos SEED de 3 letras: banda + instrumento + orientación
      - Orientación estándar: E (este), N (norte), Z (vertical)
      - Alternativa: 1, 2, 3 (numérica cuando no está alineado con N/E)
    """
    if not channel_code:
        return ""
    last = channel_code[-1].upper()
    mapping = {"E": "EW", "N": "NS", "Z": "V", "1": "H1", "2": "H2", "3": "V"}
    return mapping.get(last, last)


def _trace_preview(data: np.ndarray, n: int = 8) -> list[float]:
    """Primeros N valores como lista (para el preview de la UI)."""
    return [round(float(v), 6) for v in data[:n]]


def _looks_like_counts(data: np.ndarray) -> bool:
    """Heurística: los valores parecen counts crudos del ADC.

    True si el dtype es entero, o si el máximo absoluto excede el umbral
    (100 unidades). Un acelerograma físico jamás alcanza 100 g/m/s² — si el
    número lo hace, son counts sin calibrar.
    """
    if np.issubdtype(data.dtype, np.integer):
        return True
    finite = data[np.isfinite(data)]
    if finite.size == 0:
        return False
    return float(np.max(np.abs(finite))) > _COUNTS_AUTODETECT_THRESHOLD


# ── DetectedStructure sintética ──────────────────────────────────────────────

def detect_miniseed_structure(filename: str, content: bytes) -> DetectedStructure:
    """Retorna un DetectedStructure sintético para un archivo miniSEED.

    A diferencia del detector de TXT/CSV, aquí no hay columnas que interpretar:
    cada Trace del Stream es UN canal de aceleración con dt/npts conocidos.
    Devolvemos una columna por trace, marcada como oscilatoria y con unidad
    sugerida 'g'. El frontend ya no necesita preguntar por dt (viene en
    header_metadata) ni por magnitud (siempre acceleration).
    """
    st = _read_stream(content)
    warnings: list[str] = []

    # Metadata común (tomada de la primera traza; miniSEED de estación única
    # suele tener todas las trazas con la misma fs y timestamps compatibles)
    first = st[0]
    dt = float(first.stats.delta)
    fs = float(first.stats.sampling_rate)
    looks_counts = _looks_like_counts(first.data)
    suggested_unit = COUNTS_UNIT if looks_counts else "g"

    header_metadata: dict[str, Any] = {
        "dt":              dt,
        "fs":              fs,
        "network":         first.stats.network,
        "station":         first.stats.station,
        "location":        first.stats.location,
        "channel":         first.stats.channel,
        "starttime":       str(first.stats.starttime),
        "endtime":         str(first.stats.endtime),
        "npts":            int(first.stats.npts),
        "dtype":           str(first.data.dtype),
        "n_traces":        len(st),
        "suggested_unit":  suggested_unit,
        "looks_like_counts": looks_counts,
    }

    columns: list[ColumnInfo] = []
    preview_rows: list[list[Any]] = []

    max_npts = 0
    for i, tr in enumerate(st):
        data = tr.data
        max_npts = max(max_npts, tr.stats.npts)
        valid = data[np.isfinite(data)] if np.issubdtype(data.dtype, np.floating) else data
        header = f"{tr.stats.channel or f'CH{i+1}'} ({_extract_component_from_channel(tr.stats.channel)})"
        columns.append(ColumnInfo(
            index=i,
            header=header,
            n_valid=int(tr.stats.npts),
            n_nan=0,
            min_val=float(valid.min()) if len(valid) else 0.0,
            max_val=float(valid.max()) if len(valid) else 0.0,
            mean_val=float(valid.mean()) if len(valid) else 0.0,
            is_monotonic_increasing=False,
            is_oscillatory=True,
            delta_stats={"mean": dt, "min": dt, "max": dt, "std": 0.0, "cv": 0.0, "regular": True},
            preview=_trace_preview(data),
            suggested_role="possible_signal",
            confidence=1.0,
        ))

    # Preview de filas: cada fila es un instante de tiempo con una muestra por canal
    # (todas las trazas comparten fs → asumimos alineación temporal para las primeras filas)
    n_prev = min(15, min(tr.stats.npts for tr in st))
    for r in range(n_prev):
        preview_rows.append([float(tr.data[r]) for tr in st])

    warnings.append(
        f"Archivo miniSEED detectado (fs={fs:g} Hz, dt={dt:g} s, npts={max_npts:,}). "
        f"El formato es autodescriptivo — el wizard omite el mapeo de columnas."
    )
    if looks_counts:
        warnings.append(
            f"Los valores parecen counts crudos del ADC (max_abs={abs(columns[0].max_val):.0f}, "
            f"dtype={first.data.dtype}). Se importarán como 'counts' sin escalar. "
            f"Aplica la calibración del sensor (counts/g) o el PGA de referencia después de importar "
            f"para obtener m/s² físicos."
        )
    if max_npts > 1_000_000:
        duration_min = (max_npts * dt) / 60.0
        warnings.append(
            f"Registro muy largo ({max_npts:,} muestras ~ {duration_min:.1f} min). "
            f"Puede tardar en cargar/graficar. Considera recortar la ventana del evento "
            f"después de importar."
        )

    return DetectedStructure(
        filename=filename,
        file_format="mseed",
        n_rows=max_npts,
        n_cols=len(st),
        has_header=True,
        delimiter="",
        header_metadata=header_metadata,
        columns=columns,
        n_skipped_rows=0,
        warnings=warnings,
        preview_rows=preview_rows,
        wrapped_series_hint=False,
    )


# ── Constructor de GroundMotionRecord ────────────────────────────────────────

def build_record_from_miniseed(
    filename: str,
    content: bytes,
    record_name: str = "",
    metadata: dict | None = None,
    unit: str = "g",
    trace_index: int = 0,
) -> GroundMotionRecord:
    """Construye un GroundMotionRecord a partir de un archivo miniSEED.

    Args:
        filename:    nombre original del archivo.
        content:     bytes del archivo.
        record_name: nombre para el registro; si vacío, usa el stem del archivo.
        metadata:    metadata adicional; se enriquece con info del header SEED.
        unit:        unidad en que interpretar los valores crudos ('g' por
                     defecto). Si el sensor entrega counts, el usuario deberá
                     reescalar posteriormente aplicando la sensibilidad.
        trace_index: índice del Trace a usar cuando el archivo tenga varios
                     canales. Por defecto el primero. (En esta primera versión
                     cargamos un solo canal por archivo — la fusión E/N/Z es
                     una mejora posterior.)

    Returns:
        GroundMotionRecord con un único canal de aceleración.
    """
    st = _read_stream(content)
    if trace_index >= len(st):
        raise ValueError(
            f"trace_index={trace_index} fuera de rango (el archivo tiene {len(st)} trazas)."
        )

    tr = st[trace_index]
    stats = tr.stats

    # int32 counts → float64 para no perder precisión al restar medias/tendencias
    raw_vals = np.asarray(tr.data, dtype=np.float64)

    # 'counts' es válido pero no está en ACC_TO_MS2 (no tiene factor intrínseco):
    # se guarda tal cual y se calibra después vía apply_calibration().
    if unit == COUNTS_UNIT:
        vals_si = raw_vals.copy()
        si_unit = COUNTS_UNIT
    else:
        if unit not in ACC_TO_MS2:
            key_lower = unit.lower()
            if not any(k.lower() == key_lower for k in ACC_TO_MS2):
                raise ValueError(
                    f"Unidad de aceleración no reconocida: '{unit}'. "
                    f"Opciones: {list(ACC_TO_MS2.keys()) + [COUNTS_UNIT]}"
                )
        vals_si = acc_to_ms2(raw_vals, unit)
        si_unit = "m/s²"

    component = _extract_component_from_channel(stats.channel)
    channel = SignalChannel(
        name=f"{stats.station}.{stats.channel}" if stats.station else stats.channel or "ACC",
        quantity="acceleration",
        component=component,
        original_unit=unit,
        si_unit=si_unit,
        raw_values=raw_vals.copy(),
        values_si=vals_si,
        processed_values=None,
        processing_history=[],
    )

    # Enriquecer metadata con el header SEED (sin pisar lo que envió el usuario)
    md = dict(metadata or {})
    md.setdefault("network",   stats.network)
    md.setdefault("station",   stats.station)
    md.setdefault("location",  stats.location)
    md.setdefault("channel",   stats.channel)
    md.setdefault("starttime", str(stats.starttime))
    md.setdefault("endtime",   str(stats.endtime))
    if not md.get("component") and component:
        md["component"] = component

    dt = float(stats.delta)
    n = int(stats.npts)
    record = GroundMotionRecord(
        name=record_name or Path(filename).stem,
        source_file=filename,
        source_format="mseed",
        dt=dt,
        n_samples=n,
        duration=float((n - 1) * dt),
        fs=float(stats.sampling_rate),
        nyquist=float(stats.sampling_rate) / 2.0,
        channels=[channel],
        metadata=md,
    )
    record.time = np.arange(n) * dt
    return record


# ── Calibración de canales en counts → m/s² ──────────────────────────────────

def apply_calibration(
    record: GroundMotionRecord,
    *,
    mode: str,
    sensitivity_counts_per_g: float | None = None,
    pga_reference_ms2: float | None = None,
    component: str = "",
) -> dict:
    """Aplica calibración a los canales de aceleración de un record.

    Convierte counts (o cualquier unidad) a m/s² físicos usando uno de dos
    modos:

    - ``mode='sensitivity'``: multiplica por G_STD / sensitivity_counts_per_g.
      Requiere que el proveedor entregue la sensibilidad del datalogger
      (típicamente ~500 000 counts/g para redes SGC).

    - ``mode='pga_reference'``: normaliza para que ``|a|_max = pga_reference_ms2``
      después de restar la media (DC). Útil cuando se conoce el PGA oficial de
      un reporte y no hay hoja de calibración.

    Args:
        record:  GroundMotionRecord (será mutado in-place — values_si se reemplaza).
        mode:    'sensitivity' | 'pga_reference'.
        sensitivity_counts_per_g: counts por g (para modo 'sensitivity').
        pga_reference_ms2:        PGA objetivo en m/s² (para modo 'pga_reference').
        component: si se especifica, calibra solo el canal de ese componente;
                   si no, calibra todos los canales de aceleración.

    Returns:
        dict con el factor aplicado y el PGA resultante por canal calibrado
        (para el reporte de vuelta al usuario).

    Notas:
        - raw_values NUNCA se modifican — la trazabilidad al archivo original
          se mantiene.
        - Al calibrar se pone si_unit='m/s²' y se registra un ProcessingStep
          en processing_log del record.
        - En modo 'pga_reference' cada canal se calibra a su propio factor —
          si tienes 3 componentes con 3 PGA distintos hay que llamar 3 veces.
    """
    if mode not in ("sensitivity", "pga_reference"):
        raise ValueError(f"mode='{mode}' inválido. Use 'sensitivity' o 'pga_reference'.")
    if mode == "sensitivity":
        if sensitivity_counts_per_g is None or sensitivity_counts_per_g <= 0:
            raise ValueError("sensitivity_counts_per_g debe ser > 0 en modo 'sensitivity'.")
    else:
        if pga_reference_ms2 is None or pga_reference_ms2 <= 0:
            raise ValueError("pga_reference_ms2 debe ser > 0 en modo 'pga_reference'.")

    channels_calibrated: list[dict] = []
    for ch in record.channels:
        if ch.quantity != "acceleration":
            continue
        if component and ch.component.upper() != component.upper():
            continue

        # La calibración siempre se aplica desde raw_values para ser idempotente:
        # llamar dos veces con distintos factores no acumula errores.
        raw = ch.raw_values.astype(np.float64, copy=False)

        if mode == "sensitivity":
            # counts → g: divide por counts/g. g → m/s²: multiplica por G_STD.
            factor_ms2_per_count = G_STD / float(sensitivity_counts_per_g)
        else:
            # pga_reference: quitar DC para no sesgar el pico, calcular factor
            dc = float(raw.mean())
            peak_abs = float(np.max(np.abs(raw - dc)))
            if peak_abs == 0.0:
                raise ValueError(f"Canal '{ch.name}' es constante — no se puede calibrar por PGA.")
            factor_ms2_per_count = float(pga_reference_ms2) / peak_abs

        vals_si = raw * factor_ms2_per_count
        ch.values_si = vals_si
        ch.si_unit = "m/s²"
        # processed_values se invalida — el usuario reprocesa después si quiere
        ch.processed_values = None

        pga_ms2 = float(np.max(np.abs(vals_si - vals_si.mean())))
        channels_calibrated.append({
            "component":      ch.component,
            "channel_name":   ch.name,
            "factor_ms2_per_count": factor_ms2_per_count,
            "sensitivity_counts_per_g": G_STD / factor_ms2_per_count,
            "pga_ms2":        pga_ms2,
            "pga_g":          pga_ms2 / G_STD,
        })

    if not channels_calibrated:
        raise ValueError(
            "No se calibró ningún canal. Verifica que existan canales de aceleración"
            + (f" para el componente '{component}'." if component else ".")
        )

    step = ProcessingStep(
        operation="calibration",
        params={
            "mode": mode,
            "sensitivity_counts_per_g": sensitivity_counts_per_g,
            "pga_reference_ms2": pga_reference_ms2,
            "component": component,
            "results": channels_calibrated,
        },
        description=(
            f"Calibración por {mode} aplicada a {len(channels_calibrated)} canal(es)"
        ),
    )
    record.processing_log.append(step)

    return {"mode": mode, "channels": channels_calibrated}
