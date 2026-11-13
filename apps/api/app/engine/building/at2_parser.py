"""
Parser de archivos .AT2 formato CEER (Colombia Earthquake Engineering Research).

Estructura típica del archivo:

    CEER STRONG MOTION DATABASE RECORD
    SAN JOSE DEL PALMAR, COALA, EW
    ACCELERATION TIME HISTORY IN UNITS OF G
    NPTS=  56343, DT=   0.0050 SEC,
     -3.2823725E-12 -2.8389202E-11 ... (5 valores por línea)
      3.0291939E-10  1.3251891E-09  ...

4 líneas de cabecera + datos en notación científica (5 por línea, variable).
Unidades: aceleración en **g**.

Diferencias con el TXT crudo FEMA P-695 (que usa 1 valor por línea sin header).
"""
from __future__ import annotations

import re
from pathlib import Path

import numpy as np

# Regex tolerante a espaciado variable: `NPTS=   56343,  DT=  0.0050 SEC,`
_HEADER_RE = re.compile(
    r"NPTS\s*=\s*(?P<npts>\d+)\s*,?\s*DT\s*=\s*(?P<dt>[0-9.eE+\-]+)",
    re.IGNORECASE,
)


def parse_at2_ceer(path: str | Path) -> tuple[float, np.ndarray]:
    """Devuelve ``(dt_s, accel_g)`` leyendo un .AT2 formato CEER.

    Args:
        path: ruta al archivo .AT2.

    Returns:
        dt_s:    paso de muestreo en segundos (float).
        accel_g: aceleración en fracción de g (np.ndarray float64).

    Raises:
        FileNotFoundError: si el archivo no existe.
        ValueError: si el header no se pudo parsear o el conteo npts no coincide.
    """
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"No existe: {p}")

    with p.open("r", encoding="utf-8", errors="replace") as f:
        lines = f.readlines()

    # Buscar la línea con NPTS= y DT= (típicamente la línea 4, pero toleramos).
    header_line_idx = None
    npts: int | None = None
    dt: float | None = None
    for i, line in enumerate(lines[:10]):
        m = _HEADER_RE.search(line)
        if m:
            npts = int(m.group("npts"))
            dt = float(m.group("dt"))
            header_line_idx = i
            break

    if header_line_idx is None or npts is None or dt is None:
        raise ValueError(
            f"No se encontró 'NPTS=... DT=...' en el header de {p.name}. "
            f"Primeras 4 líneas: {lines[:4]!r}"
        )

    # Los datos empiezan después del header.
    data_tokens: list[str] = []
    for line in lines[header_line_idx + 1:]:
        tokens = line.split()
        data_tokens.extend(tokens)

    if not data_tokens:
        raise ValueError(f"Sin datos en {p.name} tras el header.")

    try:
        ag = np.array([float(t) for t in data_tokens], dtype=np.float64)
    except ValueError as exc:
        raise ValueError(f"Token no numérico en {p.name}: {exc}") from exc

    # Tolerancia: a veces los archivos tienen 1-2 muestras más/menos vs npts anunciado.
    # Solo fallamos si la diferencia es > 5 %.
    if abs(len(ag) - npts) > max(10, int(0.05 * npts)):
        raise ValueError(
            f"Conteo inconsistente en {p.name}: header dice NPTS={npts}, "
            f"se leyeron {len(ag)} valores."
        )
    # Truncar al npts anunciado para consistencia (si hay valores extra como "0" al final).
    if len(ag) > npts:
        ag = ag[:npts]

    return dt, ag


def read_ceer_header(path: str | Path) -> dict:
    """Devuelve el header del CEER como dict para introspección rápida.

    Útil para el seed script sin cargar toda la señal en memoria.
    """
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"No existe: {p}")

    with p.open("r", encoding="utf-8", errors="replace") as f:
        head_lines = [f.readline() for _ in range(4)]

    info: dict = {"file": p.name, "header_raw": head_lines}
    for line in head_lines:
        m = _HEADER_RE.search(line)
        if m:
            info["npts"] = int(m.group("npts"))
            info["dt_s"] = float(m.group("dt"))
            break
    # Línea 2 típica: "SAN JOSE DEL PALMAR, COALA, EW"
    if len(head_lines) >= 2:
        parts = [s.strip() for s in head_lines[1].split(",")]
        if len(parts) >= 3:
            info["event_name"] = parts[0]
            info["station_hdr"] = parts[1]
            info["component_hdr"] = parts[2]
    return info
