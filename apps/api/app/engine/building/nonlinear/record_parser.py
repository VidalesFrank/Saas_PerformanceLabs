"""
Parser robusto de registros sísmicos para NLTHA.

Soporta tres familias de formato:
  - PEER NGA `.at2`  : header de 4 líneas + datos en columnas múltiples con dt
                       y npts embebidos en la 4a línea.
  - FEMA P-695 txt   : una aceleración por línea, sin header. Opcionalmente una
                       sola línea de metadata al inicio.
  - CSV `(t, a)`     : dos columnas (tiempo, aceleración) separadas por comas.

Autodetecta formato y unidades donde es posible. Produce siempre un archivo
"clean" en una columna por línea para que OpenSees `timeSeries('Path', ...)`
lo lea sin ambigüedad.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Optional

import numpy as np


RecordFormat = Literal["peer_at2", "fema_flat", "csv_time_acc", "flat_whitespace"]
UnitHint     = Literal["g", "mps2", "cm/s2"]


# Patrones para extraer NPTS y DT del header PEER (varía entre revisiones)
_PEER_NPTS_RE = re.compile(r"NPTS\s*[=:]\s*([0-9]+)",      re.IGNORECASE)
_PEER_DT_RE   = re.compile(r"DT\s*[=:]\s*([0-9eE.+\-]+)",  re.IGNORECASE)


@dataclass
class RecordInfo:
    """Metadata del registro parseado."""
    accel:        np.ndarray            # aceleraciones (unidades del archivo original)
    dt:           Optional[float]       # paso de muestreo (s) o None si no se detectó
    n_pts:        int
    pga:          float                 # máximo valor absoluto en las unidades originales
    units_hint:   Optional[UnitHint]    # unidad detectada o None si no fue inferible
    format:       RecordFormat
    duration_s:   Optional[float]       # dt × (n_pts-1) o None
    header_lines: list[str]             # primeras líneas de texto (debug/UI)
    description:  str                   # resumen humano para log/UI


def _looks_numeric_line(s: str) -> bool:
    """True si la línea contiene solo tokens numéricos (ignora espacios)."""
    tokens = s.replace(",", " ").split()
    if not tokens:
        return False
    for t in tokens:
        try:
            float(t)
        except ValueError:
            return False
    return True


def _detect_format(head_lines: list[str]) -> RecordFormat:
    """Clasifica el formato mirando las primeras ~10 líneas."""
    joined = "\n".join(head_lines[:6]).upper()
    if "PEER NGA" in joined or "ACCELERATION TIME HISTORY" in joined:
        return "peer_at2"
    if _PEER_NPTS_RE.search(joined) and _PEER_DT_RE.search(joined):
        return "peer_at2"

    # Si todas las líneas numéricas tienen una sola columna → FEMA flat
    numeric_lines = [l for l in head_lines if _looks_numeric_line(l)]
    if numeric_lines:
        all_single_col = all(
            len(l.replace(",", " ").split()) == 1 for l in numeric_lines
        )
        if all_single_col:
            return "fema_flat"
        # Si todas las numéricas tienen 2 columnas → podría ser (t, a)
        all_two_col = all(
            len(l.replace(",", " ").split()) == 2 for l in numeric_lines
        )
        if all_two_col:
            # Detectar si la 1a columna es tiempo monótono creciente
            try:
                rows = [[float(x) for x in l.replace(",", " ").split()] for l in numeric_lines[:5]]
                col1 = [r[0] for r in rows]
                is_monotonic = all(col1[i+1] > col1[i] for i in range(len(col1)-1))
                if is_monotonic:
                    return "csv_time_acc"
            except Exception:
                pass

    # Caso genérico: datos separados por espacios en múltiples líneas (muy similar al PEER sin header)
    return "flat_whitespace"


def _detect_units(head_lines: list[str]) -> Optional[UnitHint]:
    """Intenta inferir unidades del header. Devuelve None si no es claro."""
    text = "\n".join(head_lines[:6]).lower()
    # Orden importa: "cm/sec/sec" debe matchear antes que "sec"
    if any(u in text for u in ("cm/sec/sec", "cm/sec2", "cm/s2", "cm/s^2", "cm/s/s")):
        return "cm/s2"
    if any(u in text for u in ("m/s/s", "m/sec/sec", "m/s2", "m/s^2", "mps2")):
        return "mps2"
    if "units of g" in text or "in units of g" in text or " g " in f" {text} ":
        return "g"
    return None


def _parse_peer_at2(lines: list[str]) -> tuple[np.ndarray, Optional[float], int]:
    """
    Parsea un .at2 del PEER NGA. Header típico:
      Línea 1-3: título / descripción / fuente
      Línea 4:   `NPTS=... DT=... SEC` (varía el orden y mayúsculas)
      Líneas 5+: datos (múltiples columnas por línea separadas por espacios)
    """
    dt = None
    npts = None
    data_start = 0

    # Busca línea con NPTS/DT; típicamente es la 4a pero puede estar en otra posición
    for i, line in enumerate(lines[:10]):
        up = line.upper()
        m_npts = _PEER_NPTS_RE.search(up)
        m_dt   = _PEER_DT_RE.search(up)
        if m_npts and m_dt:
            npts = int(m_npts.group(1))
            dt   = float(m_dt.group(1))
            data_start = i + 1
            break

    if data_start == 0:
        # No encontró header con NPTS/DT; asume que todas las líneas son datos
        data_start = 0

    # Colectar todos los números a partir de data_start
    values: list[float] = []
    for line in lines[data_start:]:
        for tok in line.replace(",", " ").split():
            try:
                values.append(float(tok))
            except ValueError:
                continue
    accel = np.asarray(values, dtype=np.float64)
    if npts and len(accel) > npts:
        accel = accel[:npts]
    return accel, dt, len(accel)


def _parse_fema_flat(lines: list[str]) -> np.ndarray:
    """Una aceleración por línea. Ignora líneas vacías o no numéricas."""
    values: list[float] = []
    for line in lines:
        s = line.strip()
        if not s:
            continue
        try:
            values.append(float(s))
        except ValueError:
            # posible header en la primera línea: la ignoramos silenciosamente
            continue
    return np.asarray(values, dtype=np.float64)


def _parse_csv_time_acc(lines: list[str]) -> tuple[np.ndarray, Optional[float]]:
    """(tiempo, aceleración) → devuelve accel y dt derivado del primer paso."""
    times:  list[float] = []
    accels: list[float] = []
    for line in lines:
        s = line.strip()
        if not s:
            continue
        toks = s.replace(",", " ").split()
        if len(toks) < 2:
            continue
        try:
            times.append(float(toks[0]))
            accels.append(float(toks[1]))
        except ValueError:
            continue
    accel = np.asarray(accels, dtype=np.float64)
    dt    = float(times[1] - times[0]) if len(times) >= 2 else None
    return accel, dt


def _parse_flat_whitespace(lines: list[str]) -> np.ndarray:
    """Flat con múltiples valores por línea (como PEER pero sin header reconocible)."""
    values: list[float] = []
    for line in lines:
        for tok in line.replace(",", " ").split():
            try:
                values.append(float(tok))
            except ValueError:
                continue
    return np.asarray(values, dtype=np.float64)


def parse_record(path: str) -> RecordInfo:
    """
    Parsea un archivo de registro sísmico y devuelve `RecordInfo`.

    Lanza ValueError si no se pueden extraer al menos 10 aceleraciones.
    No lanza por falta de dt o unidades — devuelve None en esos campos
    para que el llamador decida qué hacer (preguntarle al usuario).
    """
    if not os.path.exists(path):
        raise FileNotFoundError(path)

    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        lines = f.readlines()
    if not lines:
        raise ValueError("Archivo vacío")

    head = [ln.rstrip("\n") for ln in lines[:10]]
    fmt  = _detect_format(head)

    if fmt == "peer_at2":
        accel, dt, npts = _parse_peer_at2(lines)
    elif fmt == "fema_flat":
        accel = _parse_fema_flat(lines)
        dt    = None
        npts  = len(accel)
    elif fmt == "csv_time_acc":
        accel, dt = _parse_csv_time_acc(lines)
        npts = len(accel)
    else:
        accel = _parse_flat_whitespace(lines)
        dt    = None
        npts  = len(accel)

    if len(accel) < 10:
        raise ValueError(
            f"Solo {len(accel)} aceleraciones detectadas. Formato inválido o "
            f"archivo truncado. Head:\n{chr(10).join(head[:5])}"
        )

    pga   = float(np.max(np.abs(accel)))
    units = _detect_units(head)
    duration = (dt * (npts - 1)) if dt else None

    desc_parts = [f"format={fmt}", f"n={npts}"]
    if dt:       desc_parts.append(f"dt={dt:.5f}s")
    if duration: desc_parts.append(f"duración={duration:.1f}s")
    if units:    desc_parts.append(f"unidades={units}")
    desc_parts.append(f"PGA={pga:.4g}")

    return RecordInfo(
        accel        = accel,
        dt           = dt,
        n_pts        = npts,
        pga          = pga,
        units_hint   = units,
        format       = fmt,
        duration_s   = duration,
        header_lines = head[:6],
        description  = " · ".join(desc_parts),
    )


def write_clean_record(accel: np.ndarray, out_path: str) -> None:
    """
    Escribe el array de aceleraciones a disco en formato de una columna por
    línea con precisión suficiente. Es el formato más robusto para OpenSees
    `timeSeries('Path', ..., -filePath, ...)`.
    """
    out_dir = os.path.dirname(out_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    # 7 dígitos significativos — mantiene precisión y archivos manejables
    np.savetxt(out_path, accel, fmt="%.7e")


def parse_and_clean(
    input_path:  str,
    clean_path:  str,
) -> dict:
    """
    Parsea el archivo original y produce `clean_path` (una aceleración por
    línea). Devuelve un dict serializable listo para el preview del UI.
    """
    info = parse_record(input_path)
    write_clean_record(info.accel, clean_path)

    return {
        "clean_path":    clean_path,
        "format":        info.format,
        "n_samples":     info.n_pts,
        "dt_detected":   info.dt,
        "duration_s":    info.duration_s,
        "pga":           info.pga,
        "units_hint":    info.units_hint,
        "header_lines":  info.header_lines,
        "description":   info.description,
        # Preview downsampled a ~800 puntos para el acelerograma del panel
        "preview": _build_preview(info.accel, info.dt),
    }


def _build_preview(accel: np.ndarray, dt: Optional[float]) -> dict:
    """Downsample del acelerograma a ≤800 puntos para graficar en el panel."""
    n = len(accel)
    if n == 0:
        return {"t": [], "a": []}
    stride = max(1, n // 800)
    a_ds   = accel[::stride].astype(float).tolist()
    if dt:
        t_ds = (np.arange(0, n, stride, dtype=float) * dt).tolist()
    else:
        t_ds = list(range(0, n, stride))
    return {"t": t_ds, "a": a_ds, "stride": stride}
