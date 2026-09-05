"""Detección automática de la estructura de un archivo de datos sísmicos.

Filosofía: detectar estructura matemática, NO interpretar significado físico.
El programa determina cuántas columnas hay y su comportamiento estadístico.
El usuario confirma qué representa cada columna.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np


# ── Resultado de la detección ─────────────────────────────────────────────────

@dataclass
class ColumnInfo:
    index: int
    header: str                    # nombre del encabezado si existe, else 'Column N'
    n_valid: int                   # valores numéricos válidos
    n_nan: int                     # NaN detectados
    min_val: float
    max_val: float
    mean_val: float
    is_monotonic_increasing: bool  # posible columna de tiempo
    is_oscillatory: bool           # señal tipo aceleración
    delta_stats: dict | None       # estadísticas de diferencias (si monotónica)
    preview: list[float]           # primeros 8 valores válidos
    suggested_role: str            # 'likely_time' | 'possible_signal' | 'unknown'
    confidence: float              # 0.0 – 1.0


@dataclass
class DetectedStructure:
    """Resultado completo de la detección de estructura del archivo."""
    filename: str
    file_format: str               # 'txt' | 'csv' | 'xlsx'
    n_rows: int                    # filas de datos numéricos (sin encabezados)
    n_cols: int
    has_header: bool
    delimiter: str                 # sep detectado: ' ' | ',' | '\t' | ';'
    header_metadata: dict          # metadata extraída de líneas de cabecera
    columns: list[ColumnInfo]
    n_skipped_rows: int           # líneas de texto antes de los datos
    warnings: list[str]
    preview_rows: list[list[Any]] # primeras 15 filas


# ── Heurísticas de detección ──────────────────────────────────────────────────

_METADATA_PATTERNS = [
    (r"NPTS\s*[=:]\s*(\d+)",         "npts",      int),
    (r"DT\s*[=:]\s*([\d.eE+\-]+)",   "dt",        float),
    (r"DELTA\s*T\s*[=:]\s*([\d.eE+\-]+)", "dt",   float),
    (r"TIME\s*STEP\s*[=:]\s*([\d.eE+\-]+)", "dt", float),
    (r"DT\s*=\s*([\d.]+)\s*SEC",     "dt",        float),
    (r"NPTS\s*=\s*(\d+)",            "npts",      int),
    (r"SAMPLING\s*FREQ\s*[=:]\s*([\d.]+)", "fs",  float),
]

_NUMBER_RE = re.compile(
    r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$"
)


def _is_number(s: str) -> bool:
    return bool(_NUMBER_RE.match(s.strip()))


def _try_parse_float(s: str) -> float | None:
    try:
        return float(s.strip())
    except (ValueError, AttributeError):
        return None


def _detect_delimiter(lines: list[str]) -> str:
    """Detecta el separador más probable en una muestra de líneas."""
    # Contar candidatos en las primeras líneas numéricas
    sample = [ln for ln in lines if ln.strip()][:20]
    scores: dict[str, int] = {",": 0, "\t": 0, ";": 0}
    for ln in sample:
        scores[","] += ln.count(",")
        scores["\t"] += ln.count("\t")
        scores[";"] += ln.count(";")

    # Si alguno domina, usarlo; si no, asumir espacio/whitespace
    best = max(scores, key=lambda k: scores[k])
    if scores[best] > 0:
        return best
    return " "  # whitespace (split())


def _parse_line(line: str, sep: str) -> list[float | None]:
    """Parsea una línea de texto usando el separador indicado."""
    if sep == " ":
        parts = line.split()
    else:
        parts = line.split(sep)
    return [_try_parse_float(p) for p in parts]


def _extract_metadata_from_headers(text_lines: list[str]) -> dict:
    """Busca metadata conocida (NPTS, DT, etc.) en líneas no numéricas."""
    metadata: dict = {}
    combined = " ".join(text_lines).upper()
    for pattern, key, cast in _METADATA_PATTERNS:
        m = re.search(pattern, combined, re.IGNORECASE)
        if m:
            try:
                metadata[key] = cast(m.group(1))
            except (ValueError, IndexError):
                pass
    return metadata


def _analyze_column(values: list[float], header: str, idx: int) -> ColumnInfo:
    """Calcula estadísticas y heurísticas para una columna."""
    arr = np.array(values, dtype=float)
    valid = arr[np.isfinite(arr)]
    n_nan = int(np.sum(~np.isfinite(arr)))

    if len(valid) == 0:
        return ColumnInfo(
            index=idx, header=header, n_valid=0, n_nan=n_nan,
            min_val=0, max_val=0, mean_val=0,
            is_monotonic_increasing=False, is_oscillatory=False,
            delta_stats=None, preview=[],
            suggested_role="unknown", confidence=0.0,
        )

    diffs = np.diff(valid)
    is_mono = bool(np.all(diffs > 0)) if len(diffs) > 0 else False

    delta_stats = None
    if is_mono and len(diffs) > 1:
        d_mean = float(np.mean(diffs))
        d_min  = float(np.min(diffs))
        d_max  = float(np.max(diffs))
        d_std  = float(np.std(diffs))
        cv = d_std / d_mean if d_mean > 0 else 1.0
        delta_stats = {
            "mean": d_mean, "min": d_min, "max": d_max,
            "std": d_std, "cv": cv,
            "regular": cv < 0.01,  # variación < 1% → muestreo regular
        }

    # Heurística: ¿es oscilante alrededor de cero?
    mean_val = float(np.mean(valid))
    std_val  = float(np.std(valid))
    max_val  = float(np.max(valid))
    min_val  = float(np.min(valid))
    is_osc   = (not is_mono and abs(mean_val) < 0.3 * std_val and min_val < 0)

    # Rol sugerido
    if is_mono and valid[0] >= 0 and valid[0] < 1.0:
        if delta_stats and delta_stats["regular"]:
            role, conf = "likely_time", 0.95
        else:
            role, conf = "possible_time", 0.70
    elif is_osc:
        role, conf = "possible_signal", 0.75
    else:
        role, conf = "unknown", 0.40

    preview = [round(float(v), 8) for v in valid[:8]]

    return ColumnInfo(
        index=idx,
        header=header,
        n_valid=int(len(valid)),
        n_nan=n_nan,
        min_val=min_val,
        max_val=max_val,
        mean_val=float(mean_val),
        is_monotonic_increasing=is_mono,
        is_oscillatory=is_osc,
        delta_stats=delta_stats,
        preview=preview,
        suggested_role=role,
        confidence=conf,
    )


# ── Función principal ─────────────────────────────────────────────────────────

def detect_structure(filename: str, content: bytes) -> DetectedStructure:
    """Detecta la estructura de un archivo de datos sísmicos a partir de su contenido.

    Solo analiza la estructura matemática: columnas, tipos, comportamiento.
    No infiere significado físico (aceleración, tiempo, etc.).

    Args:
        filename: nombre del archivo (para inferir formato).
        content: contenido del archivo en bytes.

    Returns:
        DetectedStructure con toda la información detectada.
    """
    ext = Path(filename).suffix.lower()
    warnings: list[str] = []

    # ── Excel (delega a pandas) ───────────────────────────────────────────────
    if ext in (".xls", ".xlsx"):
        return _detect_excel(filename, content)

    # ── TXT / CSV ─────────────────────────────────────────────────────────────
    try:
        text = content.decode("utf-8", errors="replace")
    except Exception:
        text = content.decode("latin-1", errors="replace")

    raw_lines = text.splitlines()

    # Separar líneas de texto (cabecera/metadata) de líneas numéricas
    header_lines: list[str] = []
    numeric_lines: list[str] = []
    found_numeric = False

    for ln in raw_lines:
        stripped = ln.strip()
        if not stripped:
            continue
        parts = stripped.split()
        # Si al menos el 50% de los tokens son numéricos → línea de datos
        num_count = sum(1 for p in parts if _is_number(p))
        ratio = num_count / max(len(parts), 1)
        if ratio >= 0.5:
            numeric_lines.append(stripped)
            found_numeric = True
        elif not found_numeric:
            header_lines.append(stripped)
        # Ignorar líneas de texto que aparezcan DESPUÉS de los datos (inusuales)

    header_metadata = _extract_metadata_from_headers(header_lines)

    # Detectar delimitador
    delimiter = _detect_delimiter(numeric_lines)

    # Detectar encabezados de columnas
    col_headers: list[str] = []
    has_header = False
    if header_lines:
        last_header = header_lines[-1]
        parts = last_header.split(delimiter) if delimiter != " " else last_header.split()
        # Si ninguno es numérico → posible encabezado de columnas
        if all(not _is_number(p) for p in parts) and len(parts) > 0:
            col_headers = [p.strip() for p in parts]
            has_header = True

    # Parsear datos numéricos
    parsed_rows: list[list[float | None]] = []
    for ln in numeric_lines:
        row = _parse_line(ln, delimiter)
        if any(v is not None for v in row):
            parsed_rows.append(row)

    if not parsed_rows:
        return DetectedStructure(
            filename=filename, file_format=ext.lstrip("."),
            n_rows=0, n_cols=0, has_header=False, delimiter=delimiter,
            header_metadata=header_metadata, columns=[],
            n_skipped_rows=len(header_lines),
            warnings=["No se encontraron datos numéricos en el archivo."],
            preview_rows=[],
        )

    # Número de columnas (moda del número de elementos por fila)
    row_lens = [len(r) for r in parsed_rows]
    from collections import Counter
    n_cols = Counter(row_lens).most_common(1)[0][0]

    # Filtrar filas con número incorrecto de columnas
    valid_rows = [r for r in parsed_rows if len(r) == n_cols]
    if len(valid_rows) < len(parsed_rows):
        warnings.append(
            f"{len(parsed_rows) - len(valid_rows)} filas ignoradas por número "
            f"inconsistente de columnas."
        )

    # Construir encabezados por defecto
    while len(col_headers) < n_cols:
        col_headers.append(f"Column {len(col_headers) + 1}")

    # Transponer para obtener columnas
    col_data: list[list[float]] = [[] for _ in range(n_cols)]
    for row in valid_rows:
        for ci in range(n_cols):
            v = row[ci] if ci < len(row) else None
            if v is not None:
                col_data[ci].append(v)

    # Analizar cada columna
    columns = [
        _analyze_column(col_data[ci], col_headers[ci], ci)
        for ci in range(n_cols)
    ]

    # Preview: primeras 15 filas válidas
    preview = []
    for row in valid_rows[:15]:
        preview.append([float(v) if v is not None else None for v in row])

    # Validaciones globales
    n_rows = len(valid_rows)
    if n_rows == 0:
        warnings.append("No se encontraron filas de datos válidas.")
    if n_rows > 0 and any(c.n_nan > 0 for c in columns):
        total_nan = sum(c.n_nan for c in columns)
        warnings.append(f"Se detectaron {total_nan} valores NaN o no numéricos.")

    # Verificar consistencia con NPTS del encabezado
    if "npts" in header_metadata:
        expected = header_metadata["npts"]
        if abs(n_rows - expected) > 2:
            warnings.append(
                f"El encabezado indica NPTS={expected} pero se encontraron "
                f"{n_rows} filas de datos."
            )

    return DetectedStructure(
        filename=filename,
        file_format=ext.lstrip(".") or "txt",
        n_rows=n_rows,
        n_cols=n_cols,
        has_header=has_header,
        delimiter=delimiter,
        header_metadata=header_metadata,
        columns=columns,
        n_skipped_rows=len(header_lines),
        warnings=warnings,
        preview_rows=preview,
    )


def _detect_excel(filename: str, content: bytes) -> DetectedStructure:
    """Detecta estructura en archivos Excel (.xls / .xlsx)."""
    try:
        import pandas as pd
        df = pd.read_excel(io.BytesIO(content), header=None, nrows=500)
    except Exception as exc:
        return DetectedStructure(
            filename=filename, file_format="xlsx",
            n_rows=0, n_cols=0, has_header=False, delimiter="",
            header_metadata={}, columns=[],
            n_skipped_rows=0,
            warnings=[f"Error leyendo Excel: {exc}"],
            preview_rows=[],
        )

    warnings: list[str] = []
    has_header = False
    col_headers: list[str] = []

    # Detectar si la primera fila es encabezado
    first_row = df.iloc[0].tolist() if len(df) > 0 else []
    if any(isinstance(v, str) for v in first_row):
        has_header = True
        col_headers = [str(v).strip() if v is not None else f"Column {i+1}"
                       for i, v in enumerate(first_row)]
        df = df.iloc[1:].reset_index(drop=True)

    # Convertir a numérico
    df_num = df.apply(pd.to_numeric, errors="coerce")
    n_rows, n_cols = df_num.shape

    while len(col_headers) < n_cols:
        col_headers.append(f"Column {len(col_headers) + 1}")

    columns = []
    for ci in range(n_cols):
        col_vals = df_num.iloc[:, ci].dropna().tolist()
        columns.append(_analyze_column(col_vals, col_headers[ci], ci))

    preview = []
    for ri in range(min(15, n_rows)):
        preview.append([
            float(df_num.iloc[ri, ci]) if not np.isnan(df_num.iloc[ri, ci]) else None
            for ci in range(n_cols)
        ])

    return DetectedStructure(
        filename=filename,
        file_format="xlsx",
        n_rows=n_rows,
        n_cols=n_cols,
        has_header=has_header,
        delimiter="",
        header_metadata={},
        columns=columns,
        n_skipped_rows=1 if has_header else 0,
        warnings=warnings,
        preview_rows=preview,
    )
