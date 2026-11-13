"""
Catálogo de registros sísmicos colombianos — campaña 10-ago-2026 (San José del
Palmar) y futuras campañas locales.

Diferencias con `fema_catalog.py`:
  - No hardcoded: los pares vienen de la tabla `GroundMotionRecord` filtrados
    por `metadata_json.campaign`. Agregar una nueva campaña = correr el seed
    script, sin tocar código.
  - Formato de los .AT2 es CEER (header de 4 líneas), parseado por
    `at2_parser.parse_at2_ceer`.
  - Cada registro trae metadatos extendidos (region, soil_class, lat/lon)
    que la UI usa para filtros.

Shape del objeto `pair` es idéntico al FEMAPair del frontend (mismas keys),
con campos extra opcionales — el frontend puede tiparlos como extensión.
"""
from __future__ import annotations

import math
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np
from sqlalchemy.orm import Session

from app.engine.building.at2_parser import parse_at2_ceer
# Reutilizamos el solver SDOF del fema_catalog — mismo Newmark β=1/4
from app.engine.building.fema_catalog import _sa_at_period, _sa_curve, _SPECTRUM_PERIODS

# Directorio base donde viven los archivos .AT2 (copiados en build/seed).
LIBRARY_DIR = Path(__file__).resolve().parents[3] / "colombia_library"

# Metadatos del evento por campaña. Mw son estimaciones públicas — actualizar
# cuando haya cifras oficiales.
_CAMPAIGN_META: dict[str, dict] = {
    "colombia_2026_08_10": {
        "earthquake":     "Sismo San José del Palmar",
        "event_date":     "2026-08-10",
        "mw":             6.3,
        "country":        "Colombia",
        "label":          "Sismo San José del Palmar (10-ago-2026)",
    },
}

# Cache thread-safe de pares + espectros por campaña.
_pair_cache: dict[str, list[dict]] = {}
_pair_cache_lock = threading.Lock()


def _reset_cache() -> None:
    """Fuerza recomputar el catálogo. Útil en tests y tras reseed."""
    with _pair_cache_lock:
        _pair_cache.clear()


def library_dir() -> Path:
    """Ruta absoluta a la biblioteca de archivos .AT2."""
    return LIBRARY_DIR


def _load_records_from_db(db: Session, campaign: str) -> list:
    """Devuelve los GroundMotionRecord de una campaña, ordenados determinísticamente."""
    from app.models import GroundMotionRecord

    rows = (
        db.query(GroundMotionRecord)
        .filter(GroundMotionRecord.metadata_json.isnot(None))
        .all()
    )
    out = []
    for r in rows:
        md = r.metadata_json or {}
        if md.get("campaign") != campaign:
            continue
        out.append(r)
    # Determinístico por region, station, component — así los pair_id son estables.
    out.sort(key=lambda r: (
        (r.metadata_json or {}).get("region", ""),
        (r.metadata_json or {}).get("station", ""),
        (r.metadata_json or {}).get("component", ""),
    ))
    return out


def _group_horizontal_pairs(records: list) -> list[tuple]:
    """Agrupa registros NS+EW de una misma estación.

    Retorna tuplas ``(region, station, meta_h1, meta_h2, record_h1, record_h2)``
    donde H1 = NS y H2 = EW (convención del catálogo: coincide con la magnitud
    FEMA que alterna H1/H2 por estación).

    Las estaciones sin ambos componentes horizontales se descartan (NSR-10 y
    FEMA P-695 requieren pares; los mono-componente irán a otro módulo si se
    requiere luego).
    """
    by_key: dict[tuple, dict[str, object]] = {}
    for r in records:
        md = r.metadata_json or {}
        key = (md.get("region"), md.get("station"))
        comp = md.get("component", "").upper()
        if comp in ("NS", "EW"):
            by_key.setdefault(key, {})[comp] = r

    pairs = []
    for (region, station), comps in by_key.items():
        if "NS" in comps and "EW" in comps:
            r_ns = comps["NS"]
            r_ew = comps["EW"]
            pairs.append((region, station, r_ns.metadata_json, r_ew.metadata_json, r_ns, r_ew))
    # Mantenemos orden determinístico
    pairs.sort(key=lambda t: (t[0] or "", t[1] or ""))
    return pairs


def _load_signal(record) -> tuple[float, np.ndarray]:
    """Lee la señal de un GroundMotionRecord usando el parser CEER."""
    source = record.source_file
    if not source or not os.path.exists(source):
        raise FileNotFoundError(f"Archivo fuente de registro {record.name} no encontrado: {source}")
    return parse_at2_ceer(source)


def _build_catalog_sync(db: Session, campaign: str) -> list[dict]:
    """Procesa los registros de una campaña y computa PGA + espectros."""
    with _pair_cache_lock:
        cached = _pair_cache.get(campaign)
    if cached is not None:
        return cached

    records = _load_records_from_db(db, campaign)
    pair_tuples = _group_horizontal_pairs(records)
    camp_meta = _CAMPAIGN_META.get(campaign, {})

    result: list[dict] = []
    for idx, (region, station, md_h1, md_h2, rec_h1, rec_h2) in enumerate(pair_tuples, start=1):
        try:
            dt_h1, ag_h1 = _load_signal(rec_h1)
            dt_h2, ag_h2 = _load_signal(rec_h2)
        except Exception as e:  # noqa: BLE001
            # Registramos la pareja pero sin espectros — el frontend muestra "no disponible".
            result.append({
                "pair":        idx,
                "earthquake":  camp_meta.get("earthquake", "—"),
                "year":        int(camp_meta.get("event_date", "2026-01-01").split("-")[0]),
                "mw":          camp_meta.get("mw", 0.0),
                "station":     station,
                "rrup_km":     None,
                "files":       [rec_h1.name, rec_h2.name],
                "dt":          [None, None],
                "pga":         [None, None],
                "duration_s":  [None, None],
                "n_samples":   [None, None],
                "spectra":     None,
                "region":      region,
                "soil_class":  md_h1.get("soil_class") or md_h2.get("soil_class"),
                "latitude":    md_h1.get("latitude"),
                "longitude":   md_h1.get("longitude"),
                "campaign":    campaign,
                "error":       str(e),
                "record_h1_id": rec_h1.id,
                "record_h2_id": rec_h2.id,
            })
            continue

        pga_h1 = float(np.max(np.abs(ag_h1)))
        pga_h2 = float(np.max(np.abs(ag_h2)))
        sa_h1 = _sa_curve(ag_h1, dt_h1, _SPECTRUM_PERIODS)
        sa_h2 = _sa_curve(ag_h2, dt_h2, _SPECTRUM_PERIODS)
        geomean = [
            round(math.sqrt(max(a * b, 0.0)), 5) for a, b in zip(sa_h1, sa_h2)
        ]

        result.append({
            "pair":        idx,
            "earthquake":  camp_meta.get("earthquake", "—"),
            "year":        int(camp_meta.get("event_date", "2026-01-01").split("-")[0]),
            "mw":          camp_meta.get("mw", 0.0),
            "station":     station,
            "rrup_km":     None,
            "files":       [rec_h1.name, rec_h2.name],
            "dt":          [dt_h1, dt_h2],
            "pga":         [round(pga_h1, 5), round(pga_h2, 5)],
            "duration_s":  [round(len(ag_h1) * dt_h1, 3), round(len(ag_h2) * dt_h2, 3)],
            "n_samples":   [int(len(ag_h1)), int(len(ag_h2))],
            "spectra":     {
                "periods": _SPECTRUM_PERIODS,
                rec_h1.name.lower(): sa_h1,
                rec_h2.name.lower(): sa_h2,
                "geomean": geomean,
            },
            # ── Campos extendidos exclusivos del catálogo local ──
            "region":      region,
            "soil_class":  md_h1.get("soil_class") or md_h2.get("soil_class"),
            "latitude":    md_h1.get("latitude"),
            "longitude":   md_h1.get("longitude"),
            "campaign":    campaign,
            "event_date":  camp_meta.get("event_date"),
            "record_h1_id": rec_h1.id,
            "record_h2_id": rec_h2.id,
        })

    with _pair_cache_lock:
        _pair_cache[campaign] = result
    return result


def list_campaigns(db: Session) -> list[dict]:
    """Devuelve las campañas con registros disponibles."""
    from app.models import GroundMotionRecord
    rows = db.query(GroundMotionRecord).all()
    counts: dict[str, int] = {}
    for r in rows:
        md = r.metadata_json or {}
        c = md.get("campaign")
        if c:
            counts[c] = counts.get(c, 0) + 1
    out = []
    for c, n in counts.items():
        meta = _CAMPAIGN_META.get(c, {})
        out.append({
            "campaign":   c,
            "label":      meta.get("label", c),
            "earthquake": meta.get("earthquake"),
            "event_date": meta.get("event_date"),
            "mw":         meta.get("mw"),
            "n_records":  n,
        })
    out.sort(key=lambda x: x["campaign"])
    return out


def get_catalog(db: Session, campaign: str = "colombia_2026_08_10") -> dict:
    """Catálogo de pares horizontales con espectros precomputados (shape FEMAPair)."""
    pairs = _build_catalog_sync(db, campaign)
    return {
        "campaign":  campaign,
        "pairs":     pairs,
        "periods":   _SPECTRUM_PERIODS,
        "available": len(pairs) > 0,
    }


def library_available(db: Session, campaign: str = "colombia_2026_08_10") -> bool:
    """True si hay al menos 1 par horizontal registrado para la campaña."""
    return bool(_build_catalog_sync(db, campaign))


def read_record_timeseries(
    db: Session, record_name: str, campaign: str = "colombia_2026_08_10",
    max_points: int = 600,
) -> dict:
    """Timeseries decimado para preview rápido en UI."""
    from app.models import GroundMotionRecord
    rec = (
        db.query(GroundMotionRecord)
        .filter(GroundMotionRecord.name == record_name)
        .first()
    )
    if rec is None or (rec.metadata_json or {}).get("campaign") != campaign:
        raise FileNotFoundError(f"Registro {record_name} no encontrado en campaña {campaign}")
    dt_rec, ag = _load_signal(rec)
    n_full = int(len(ag))
    stride = max(1, n_full // max_points)
    t = (np.arange(n_full, dtype=float) * dt_rec)[::stride]
    a = ag[::stride]
    md = rec.metadata_json or {}
    return {
        "name":        record_name,
        "t":           [round(float(x), 4) for x in t],
        "a":           [round(float(x), 6) for x in a],
        "dt":          dt_rec,
        "n_full":      n_full,
        "pga":         round(float(np.max(np.abs(ag))), 5),
        "duration_s":  round(n_full * dt_rec, 3),
        "region":      md.get("region"),
        "station":     md.get("station"),
        "component":   md.get("component"),
        "soil_class":  md.get("soil_class"),
    }


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
    db: Session, pair_id: int, T1_s: float, sa_target_g: float,
    campaign: str = "colombia_2026_08_10", xi: float = 0.05,
) -> ScaleResult:
    """Factor de escala FEMA P-695 §6.2 — mismo factor a H1 y H2 para preservar
    la asimetría entre componentes."""
    pairs = _build_catalog_sync(db, campaign)
    pair = next((p for p in pairs if p["pair"] == pair_id), None)
    if pair is None:
        raise ValueError(f"Par colombiano {pair_id} desconocido en campaña {campaign}.")
    if pair.get("error"):
        raise FileNotFoundError(pair["error"])

    from app.models import GroundMotionRecord
    rec_h1 = db.query(GroundMotionRecord).filter(GroundMotionRecord.id == pair["record_h1_id"]).first()
    rec_h2 = db.query(GroundMotionRecord).filter(GroundMotionRecord.id == pair["record_h2_id"]).first()
    dt1, ag1 = _load_signal(rec_h1)
    dt2, ag2 = _load_signal(rec_h2)

    sa_h1 = _sa_at_period(ag1, dt1, T1_s, xi)
    sa_h2 = _sa_at_period(ag2, dt2, T1_s, xi)
    sa_geomean = math.sqrt(max(sa_h1 * sa_h2, 0.0))
    if sa_geomean <= 1e-9:
        raise ValueError(
            f"Sa_geomean(T1={T1_s}) ≈ 0 para el par {pair_id} — "
            f"verifica que T1 esté dentro del contenido espectral."
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


def get_record_path(record_name: str, db: Session) -> str:
    """Ruta absoluta al archivo .AT2 de un registro (usado por el task Celery)."""
    from app.models import GroundMotionRecord
    rec = (
        db.query(GroundMotionRecord)
        .filter(GroundMotionRecord.name == record_name)
        .first()
    )
    if rec is None:
        raise FileNotFoundError(f"Registro {record_name} no encontrado en DB.")
    if not rec.source_file or not os.path.exists(rec.source_file):
        raise FileNotFoundError(f"source_file faltante para {record_name}: {rec.source_file}")
    return rec.source_file


def get_record_dt(record_name: str, db: Session) -> float:
    """dt (s) de un registro (leído de la DB)."""
    from app.models import GroundMotionRecord
    rec = (
        db.query(GroundMotionRecord)
        .filter(GroundMotionRecord.name == record_name)
        .first()
    )
    if rec is None or rec.dt is None:
        raise ValueError(f"dt no disponible para {record_name}")
    return float(rec.dt)
