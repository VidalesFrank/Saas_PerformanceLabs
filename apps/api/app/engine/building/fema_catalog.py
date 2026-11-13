"""
Catálogo de registros FEMA P-695 Far-Field (22 pares × 2 componentes = 44 regs).

Los archivos físicos viven en /app/data/fema_library/GM01.txt … GM44.txt
(un valor de aceleración por línea, en unidades de g). El conjunto se usa
para análisis cronológico no lineal (NLTHA) y escalado FEMA P-695 por
Sa(T1) geomean de las dos componentes horizontales.

Datos portados del módulo `records.py` de estrucmed-web, verificados contra
la Tabla A-4 del documento FEMA P-695 (2009).
"""
from __future__ import annotations

import math
import os
import threading
from dataclasses import dataclass
from typing import Optional

import numpy as np

# ─────────────────────────────────────────────────────────────────────────────
# Metadatos de los 22 pares Far-Field (FEMA P-695 Tabla A-4)
# ─────────────────────────────────────────────────────────────────────────────

FEMA_PAIRS: list[dict] = [
    {"pair": 1,  "earthquake": "Northridge",         "year": 1994, "mw": 6.7, "station": "Beverly Hills - Mulhol",   "rrup_km": 13.3, "files": ["GM01", "GM02"]},
    {"pair": 2,  "earthquake": "Northridge",         "year": 1994, "mw": 6.7, "station": "Canyon Country - WLC",     "rrup_km": 26.5, "files": ["GM03", "GM04"]},
    {"pair": 3,  "earthquake": "Duzce, Turkey",      "year": 1999, "mw": 7.1, "station": "Bolu",                     "rrup_km": 12.0, "files": ["GM05", "GM06"]},
    {"pair": 4,  "earthquake": "Hector Mine",        "year": 1999, "mw": 7.1, "station": "Hector",                   "rrup_km": 11.7, "files": ["GM07", "GM08"]},
    {"pair": 5,  "earthquake": "Imperial Valley",    "year": 1979, "mw": 6.5, "station": "Delta",                    "rrup_km": 22.0, "files": ["GM09", "GM10"]},
    {"pair": 6,  "earthquake": "Imperial Valley",    "year": 1979, "mw": 6.5, "station": "El Centro Array #11",      "rrup_km": 12.5, "files": ["GM11", "GM12"]},
    {"pair": 7,  "earthquake": "Kobe, Japan",        "year": 1995, "mw": 6.9, "station": "Nishi-Akashi",             "rrup_km": 7.1,  "files": ["GM13", "GM14"]},
    {"pair": 8,  "earthquake": "Kobe, Japan",        "year": 1995, "mw": 6.9, "station": "Shin-Osaka",               "rrup_km": 19.2, "files": ["GM15", "GM16"]},
    {"pair": 9,  "earthquake": "Kocaeli, Turkey",    "year": 1999, "mw": 7.5, "station": "Duzce",                    "rrup_km": 15.4, "files": ["GM17", "GM18"]},
    {"pair": 10, "earthquake": "Kocaeli, Turkey",    "year": 1999, "mw": 7.5, "station": "Arcelik",                  "rrup_km": 13.5, "files": ["GM19", "GM20"]},
    {"pair": 11, "earthquake": "Landers",            "year": 1992, "mw": 7.3, "station": "Coolwater",                "rrup_km": 19.7, "files": ["GM21", "GM22"]},
    {"pair": 12, "earthquake": "Landers",            "year": 1992, "mw": 7.3, "station": "Yermo Fire Station",       "rrup_km": 23.6, "files": ["GM23", "GM24"]},
    {"pair": 13, "earthquake": "Loma Prieta",        "year": 1989, "mw": 6.9, "station": "Capitola",                 "rrup_km": 15.2, "files": ["GM25", "GM26"]},
    {"pair": 14, "earthquake": "Loma Prieta",        "year": 1989, "mw": 6.9, "station": "Gilroy Array #3",          "rrup_km": 12.8, "files": ["GM27", "GM28"]},
    {"pair": 15, "earthquake": "Manjil, Iran",       "year": 1990, "mw": 7.4, "station": "Abbar",                    "rrup_km": 12.6, "files": ["GM29", "GM30"]},
    {"pair": 16, "earthquake": "Superstition Hills", "year": 1987, "mw": 6.5, "station": "El Centro Imp. Co.",       "rrup_km": 18.2, "files": ["GM31", "GM32"]},
    {"pair": 17, "earthquake": "Superstition Hills", "year": 1987, "mw": 6.5, "station": "Poe Road (temp)",          "rrup_km": 11.2, "files": ["GM33", "GM34"]},
    {"pair": 18, "earthquake": "Cape Mendocino",     "year": 1992, "mw": 7.0, "station": "Rio Dell Overpass",        "rrup_km": 14.3, "files": ["GM35", "GM36"]},
    {"pair": 19, "earthquake": "Chi-Chi, Taiwan",    "year": 1999, "mw": 7.6, "station": "CHY101",                   "rrup_km": 10.0, "files": ["GM37", "GM38"]},
    {"pair": 20, "earthquake": "Chi-Chi, Taiwan",    "year": 1999, "mw": 7.6, "station": "TCU045",                   "rrup_km": 26.0, "files": ["GM39", "GM40"]},
    {"pair": 21, "earthquake": "San Fernando",       "year": 1971, "mw": 6.6, "station": "LA - Hollywood Stor",      "rrup_km": 22.8, "files": ["GM41", "GM42"]},
    {"pair": 22, "earthquake": "Friuli, Italy",      "year": 1976, "mw": 6.5, "station": "Tolmezzo",                 "rrup_km": 15.8, "files": ["GM43", "GM44"]},
]

# dt (s) de cada archivo — índice 0=GM01 … índice 43=GM44.
# Valores oficiales del dataset FEMA P-695 Far-Field.
_FEMA_DT: list[float] = [
    0.010, 0.010, 0.010, 0.010, 0.010, 0.010, 0.010, 0.010, 0.010, 0.010,
    0.005, 0.005, 0.010, 0.010, 0.010, 0.010, 0.005, 0.005,
    0.050, 0.050, 0.020, 0.020, 0.0025, 0.0025, 0.005, 0.005,
    0.005, 0.005, 0.005, 0.005, 0.005, 0.005, 0.005, 0.005,
    0.010, 0.010, 0.005, 0.005, 0.005, 0.005, 0.010, 0.010,
    0.005, 0.005,
]

# Períodos para el espectro de respuesta precomputado (s).
# Resolución suficiente para selección visual + línea de T1 del edificio.
_SPECTRUM_PERIODS: list[float] = [
    0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50,
    0.60, 0.75, 1.00, 1.25, 1.50, 2.00, 2.50, 3.00, 3.50, 4.00,
]

# Directorio donde viven los 44 .txt dentro del container.
# Copiados en build via `COPY apps/api /app` → viven en `/app/fema_library/`.
# `apps/api/data/` está en .dockerignore (uploads de usuarios); por eso no
# usamos `data/fema_library/`.
LIBRARY_DIR = "/app/fema_library"

# Cache thread-safe de espectros precomputados.
_spectra_cache: dict = {}
_spectra_lock  = threading.Lock()


# ─────────────────────────────────────────────────────────────────────────────
# Newmark β=1/4 para Sa(T, ξ)
# ─────────────────────────────────────────────────────────────────────────────

def _sa_at_period(ag_g: np.ndarray, dt: float, T: float, xi: float = 0.05) -> float:
    """
    Pseudo-aceleración espectral Sa(T, ξ) en g. Entrada y salida en g.
    Método: Newmark β=1/4 (aceleración media, incondicionalmente estable).
    """
    ag = np.asarray(ag_g, dtype=float)
    if T <= 0.02:
        return float(np.max(np.abs(ag)))

    omega = 2.0 * math.pi / T
    c_dmp = 2.0 * xi * omega
    k_stt = omega ** 2

    beta, gamma = 0.25, 0.5
    a0 = 1.0 / (beta * dt ** 2)
    a1 = gamma / (beta * dt)
    a2 = 1.0 / (beta * dt)
    a3 = 0.5 / beta - 1.0
    a4 = gamma / beta - 1.0
    a5 = dt * (gamma / (2.0 * beta) - 1.0)

    k_eff = k_stt + c_dmp * a1 + a0

    u = 0.0
    v = 0.0
    a_old = -ag[0]
    max_u = 0.0

    for i in range(len(ag) - 1):
        p_eff = (-ag[i + 1]
                 + a0 * u + a2 * v + a3 * a_old
                 + c_dmp * (a1 * u + a4 * v + a5 * a_old))
        u_new = p_eff / k_eff
        a_new = a0 * (u_new - u) - a2 * v - a3 * a_old
        v_new = v + dt * ((1.0 - gamma) * a_old + gamma * a_new)
        if abs(u_new) > max_u:
            max_u = abs(u_new)
        u, v, a_old = u_new, v_new, a_new

    return float(omega ** 2 * max_u)


def _sa_curve(ag_g: np.ndarray, dt: float, periods: list[float],
              xi: float = 0.05) -> list[float]:
    """Vector de Sa(T) para una lista de periodos."""
    return [round(_sa_at_period(ag_g, dt, T, xi), 5) for T in periods]


# ─────────────────────────────────────────────────────────────────────────────
# Accessor principal del catálogo
# ─────────────────────────────────────────────────────────────────────────────

def get_record_path(gm_name: str) -> str:
    """Ruta absoluta al archivo .txt de un registro (GM01 … GM44)."""
    return os.path.join(LIBRARY_DIR, f"{gm_name}.txt")


def get_record_dt(gm_name: str) -> float:
    """dt (s) del registro según el índice GM01..GM44."""
    idx = int(gm_name.replace("GM", "").lstrip("0") or "0") - 1
    if 0 <= idx < len(_FEMA_DT):
        return _FEMA_DT[idx]
    raise ValueError(f"Registro desconocido: {gm_name!r}")


def library_available() -> bool:
    """`True` si todos los 44 archivos están presentes en el disco."""
    for pair in FEMA_PAIRS:
        for gm in pair["files"]:
            if not os.path.exists(get_record_path(gm)):
                return False
    return True


def _load_record_values(gm_name: str) -> Optional[np.ndarray]:
    """Carga un .txt como np.ndarray de aceleración en g."""
    path = get_record_path(gm_name)
    if not os.path.exists(path):
        return None
    try:
        return np.loadtxt(path, dtype=float).reshape(-1)
    except Exception:
        return None


def _compute_spectra_sync() -> list[dict]:
    """
    Procesa los 44 archivos: PGA + espectro de respuesta a `_SPECTRUM_PERIODS`
    + media geométrica por par (convención FEMA P-695).
    Cache thread-safe: solo se calcula una vez por proceso.
    """
    with _spectra_lock:
        if _spectra_cache.get("data"):
            return _spectra_cache["data"]

        result: list[dict] = []
        for pair in FEMA_PAIRS:
            entry: dict = {k: v for k, v in pair.items() if k != "files"}
            entry["files"] = pair["files"]
            entry["dt"]    = [get_record_dt(gm) for gm in pair["files"]]
            entry["pga"]   = []
            entry["duration_s"] = []
            entry["n_samples"]  = []
            sa_by_file: dict[str, list[float]] = {}

            for gm_name in pair["files"]:
                ag = _load_record_values(gm_name)
                if ag is None:
                    entry["pga"].append(None)
                    entry["duration_s"].append(None)
                    entry["n_samples"].append(None)
                    continue
                dt_rec = get_record_dt(gm_name)
                entry["pga"].append(round(float(np.max(np.abs(ag))), 5))
                entry["duration_s"].append(round(len(ag) * dt_rec, 3))
                entry["n_samples"].append(int(len(ag)))
                sa_by_file[gm_name.lower()] = _sa_curve(ag, dt_rec, _SPECTRUM_PERIODS)

            if len(sa_by_file) == 2:
                (gm_h1, gm_h2) = pair["files"]
                arr1 = sa_by_file[gm_h1.lower()]
                arr2 = sa_by_file[gm_h2.lower()]
                geomean = [
                    round(math.sqrt(max(a * b, 0.0)), 5) for a, b in zip(arr1, arr2)
                ]
                entry["spectra"] = {
                    "periods": _SPECTRUM_PERIODS,
                    gm_h1.lower(): arr1,
                    gm_h2.lower(): arr2,
                    "geomean": geomean,
                }
            else:
                entry["spectra"] = None

            result.append(entry)

        _spectra_cache["data"] = result
        return result


def get_catalog() -> dict:
    """
    Devuelve catálogo completo con espectros precomputados.
    Shape:
        {
          "pairs":    [ {pair, earthquake, year, mw, station, rrup_km,
                         files, dt, pga, duration_s, n_samples, spectra}, … ],
          "periods":  [0.05, 0.10, …, 4.0],
          "available": true/false,
        }
    """
    if not library_available():
        return {
            "pairs": [
                {
                    "pair": p["pair"], "earthquake": p["earthquake"],
                    "year": p["year"], "mw": p["mw"],
                    "station": p["station"], "rrup_km": p["rrup_km"],
                    "files": p["files"],
                    "dt": [get_record_dt(gm) for gm in p["files"]],
                    "pga": [], "duration_s": [], "n_samples": [],
                    "spectra": None,
                }
                for p in FEMA_PAIRS
            ],
            "periods":   _SPECTRUM_PERIODS,
            "available": False,
        }

    return {
        "pairs":    _compute_spectra_sync(),
        "periods":  _SPECTRUM_PERIODS,
        "available": True,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Helpers para escalado FEMA P-695 por Sa(T1) geomean
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class ScaleResult:
    scale:                float
    sa_geomean_unscaled:  float
    sa_geomean_scaled:    float
    sa_h1_unscaled:       float
    sa_h2_unscaled:       float
    T1_s:                 float
    sa_target:            float


def compute_scale_for_pair(
    pair_id: int, T1_s: float, sa_target_g: float, xi: float = 0.05,
) -> ScaleResult:
    """
    Calcula el factor de escala para que la media geométrica de Sa(T1) de las
    dos componentes del par iguale `sa_target_g` — convención FEMA P-695 §6.2.

    Fórmulas:
        Sa_geomean = sqrt( Sa_H1(T1) · Sa_H2(T1) )
        scale      = sa_target_g / Sa_geomean
    """
    pair = next((p for p in FEMA_PAIRS if p["pair"] == pair_id), None)
    if pair is None:
        raise ValueError(f"Par FEMA desconocido: {pair_id}")

    sa_vals: list[float] = []
    for gm_name in pair["files"]:
        ag = _load_record_values(gm_name)
        if ag is None:
            raise FileNotFoundError(f"Registro {gm_name} no disponible en {LIBRARY_DIR}")
        sa_vals.append(_sa_at_period(ag, get_record_dt(gm_name), T1_s, xi))

    sa_h1, sa_h2 = sa_vals
    sa_geomean = math.sqrt(max(sa_h1 * sa_h2, 0.0))
    if sa_geomean <= 1e-9:
        raise ValueError(
            f"Sa_geomean(T1={T1_s}) ≈ 0 para el par {pair_id} — "
            f"verifica que T1 esté dentro del contenido espectral del registro"
        )

    scale = sa_target_g / sa_geomean
    return ScaleResult(
        scale=scale,
        sa_geomean_unscaled=sa_geomean,
        sa_geomean_scaled=sa_target_g,
        sa_h1_unscaled=sa_h1,
        sa_h2_unscaled=sa_h2,
        T1_s=T1_s,
        sa_target=sa_target_g,
    )


def read_record_timeseries(gm_name: str, max_points: int = 600) -> dict:
    """
    Devuelve timeseries decimado para preview rápido en UI.
    Resultado: {"t": [...], "a": [...], "dt": 0.005, "n_full": 3000, "pga": 0.42}
    """
    ag = _load_record_values(gm_name)
    if ag is None:
        raise FileNotFoundError(f"Registro {gm_name} no disponible")
    dt_rec = get_record_dt(gm_name)
    n_full = int(len(ag))
    stride = max(1, n_full // max_points)
    t = (np.arange(n_full, dtype=float) * dt_rec)[::stride]
    a = ag[::stride]
    return {
        "gm_name":   gm_name,
        "t":         [round(float(x), 4) for x in t],
        "a":         [round(float(x), 6) for x in a],
        "dt":        dt_rec,
        "n_full":    n_full,
        "pga":       round(float(np.max(np.abs(ag))), 5),
        "duration_s": round(n_full * dt_rec, 3),
    }
