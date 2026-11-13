"""
Seed script — campaña "Sismo San José del Palmar (10-ago-2026)".

Inventaría los archivos .AT2 (formato CEER) copiados a
``apps/api/colombia_library/<REGION>/`` y crea / actualiza los registros
correspondientes en la tabla ``GroundMotionRecord``.

Idempotente: identifica un registro por ``name`` (p. ej. ``COALA_NS``). Si ya
existe con la misma campaña, se actualizan metadatos y dt/npt; si no, se crea.

Solo procesa componentes NS y EW; las verticales (VER) se ignoran por ahora.

Uso:
    cd apps/api
    ../../.venv/Scripts/python.exe scripts/seed_colombia_2026_08_10.py

Opciones:
    --dry-run      no persiste nada, solo reporta
    --owner-email  email del User al que se le asignan los registros
                   (default: vidalesfrankdaniel@gmail.com; fallback al primer
                   User que exista)
"""
from __future__ import annotations

import argparse
import csv
import os
import sys
from pathlib import Path

# El script vive en apps/api/scripts; añadimos apps/api al sys.path para que
# `from app.xxx import ...` funcione al correrlo directo con python.
_HERE = Path(__file__).resolve().parent
_API_DIR = _HERE.parent
if str(_API_DIR) not in sys.path:
    sys.path.insert(0, str(_API_DIR))

from app.db import SessionLocal  # noqa: E402
from app.models import GroundMotionRecord, User  # noqa: E402
from app.engine.building.at2_parser import parse_at2_ceer, read_ceer_header  # noqa: E402

CAMPAIGN = "colombia_2026_08_10"
CAMPAIGN_LABEL = "Sismo San José del Palmar (10-ago-2026)"
EVENT_DATE = "2026-08-10"
EVENT_NAME = "San José del Palmar"

LIBRARY_DIR = _API_DIR / "colombia_library"
REGIONS = ["CALI", "MANIZALES", "PEREIRA", "SGC"]


def _find_metadata_csv(region_dir: Path) -> Path | None:
    for f in region_dir.iterdir():
        if f.suffix.lower() == ".csv":
            return f
    return None


def _read_metadata_csv(csv_path: Path) -> dict[str, dict]:
    """Devuelve un mapping station → metadata dict.

    Toleramos cambios en el orden de columnas entre regiones: buscamos
    por nombre de columna case-insensitive.
    """
    out: dict[str, dict] = {}
    if not csv_path.exists():
        return out
    with csv_path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            lower = {(k or "").strip().lower(): (v or "").strip() for k, v in row.items()}
            name = lower.get("name station") or lower.get("name") or lower.get("station")
            if not name:
                continue
            def _f(key: str) -> float | None:
                raw = lower.get(key)
                if raw in (None, "", "-"):
                    return None
                try:
                    return float(raw)
                except ValueError:
                    return None
            out[name] = {
                "npt":  int(_f("npt") or 0),
                "dt":   _f("dt"),
                "latitude":  _f("latitude"),
                "longitude": _f("longitude"),
                "soil":      lower.get("soil") or lower.get("soil type"),
            }
    return out


def _parse_filename(path: Path) -> tuple[str, str] | None:
    """Extrae (station, component) del nombre de archivo ``<STATION>_<COMP>.AT2``."""
    stem = path.stem
    if "_" not in stem:
        return None
    sta, comp = stem.rsplit("_", 1)
    comp = comp.upper()
    return sta, comp


def seed(dry_run: bool = False, owner_email: str = "vidalesfrankdaniel@gmail.com") -> dict:
    db = SessionLocal()
    stats = {
        "scanned":    0,
        "inserted":   0,
        "updated":    0,
        "skipped_ver": 0,
        "skipped_other": 0,
        "errors":     [],
    }

    # Owner
    owner = db.query(User).filter(User.email == owner_email).first()
    if owner is None:
        owner = db.query(User).order_by(User.id).first()
        if owner is None:
            raise RuntimeError("No existe ningún User en la DB — crea uno primero.")
        print(f"[warn] Usuario {owner_email} no existe, usando fallback {owner.email}")
    owner_id = owner.id

    for region in REGIONS:
        region_dir = LIBRARY_DIR / region
        if not region_dir.exists():
            print(f"[skip] {region} no está en {LIBRARY_DIR}")
            continue
        meta_csv = _find_metadata_csv(region_dir)
        meta = _read_metadata_csv(meta_csv) if meta_csv else {}
        print(f"[{region}] CSV={meta_csv.name if meta_csv else 'NO CSV'} ({len(meta)} estaciones)")

        at2_files = sorted(region_dir.glob("*.AT2"))
        for p in at2_files:
            stats["scanned"] += 1
            parsed = _parse_filename(p)
            if parsed is None:
                stats["skipped_other"] += 1
                continue
            sta, comp = parsed
            if comp not in ("NS", "EW"):
                stats["skipped_ver"] += 1
                continue

            try:
                dt_s, ag = parse_at2_ceer(p)
            except Exception as e:  # noqa: BLE001
                stats["errors"].append(f"{region}/{p.name}: {e}")
                continue

            n_samples = int(len(ag))
            duration = round(n_samples * dt_s, 3)
            csv_meta = meta.get(sta) or {}

            record_name = f"{sta}_{comp}"
            metadata_json = {
                "campaign":       CAMPAIGN,
                "campaign_label": CAMPAIGN_LABEL,
                "region":         region,
                "station":        sta,
                "component":      comp,
                "soil_class":     csv_meta.get("soil"),
                "latitude":       csv_meta.get("latitude"),
                "longitude":      csv_meta.get("longitude"),
                "event_date":     EVENT_DATE,
                "event_name":     EVENT_NAME,
                "source_format":  "CEER",
                "npt_csv":        csv_meta.get("npt"),
                "dt_csv":         csv_meta.get("dt"),
            }

            existing = (
                db.query(GroundMotionRecord)
                .filter(GroundMotionRecord.name == record_name)
                .first()
            )

            if existing is not None:
                # Solo actualizamos si corresponde a la misma campaña (seguridad).
                existing_md = existing.metadata_json or {}
                if existing_md.get("campaign") not in (None, CAMPAIGN):
                    stats["errors"].append(
                        f"{record_name}: colisión de nombre con otra campaña "
                        f"({existing_md.get('campaign')!r}). Omitido."
                    )
                    continue
                existing.source_file   = str(p)
                existing.dt            = float(dt_s)
                existing.n_samples     = n_samples
                existing.duration      = duration
                existing.acc_unit_original = "g"
                existing.metadata_json = metadata_json
                if not dry_run:
                    db.add(existing)
                stats["updated"] += 1
            else:
                new_rec = GroundMotionRecord(
                    name=record_name,
                    source_file=str(p),
                    raw_data_path=None,
                    dt=float(dt_s),
                    n_samples=n_samples,
                    duration=duration,
                    acc_unit_original="g",
                    metadata_json=metadata_json,
                    owner_id=owner_id,
                )
                if not dry_run:
                    db.add(new_rec)
                stats["inserted"] += 1

        # Commit por región para que un error no mate todo.
        if not dry_run:
            db.commit()

    if not dry_run:
        db.commit()
    db.close()
    return stats


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--owner-email", default="vidalesfrankdaniel@gmail.com")
    args = parser.parse_args()

    print(f"Library dir: {LIBRARY_DIR}")
    print(f"Dry run: {args.dry_run}")
    print()

    stats = seed(dry_run=args.dry_run, owner_email=args.owner_email)

    print()
    print("=" * 60)
    print(f"Archivos escaneados:        {stats['scanned']}")
    print(f"Registros insertados:       {stats['inserted']}")
    print(f"Registros actualizados:     {stats['updated']}")
    print(f"Verticales ignoradas:       {stats['skipped_ver']}")
    print(f"Otros omitidos:             {stats['skipped_other']}")
    print(f"Errores:                    {len(stats['errors'])}")
    for e in stats["errors"][:20]:
        print(f"  - {e}")
    if len(stats["errors"]) > 20:
        print(f"  ... y {len(stats['errors']) - 20} más")
    print("=" * 60)
    if args.dry_run:
        print("** DRY RUN — no se persistió nada **")
    return 0 if not stats["errors"] else 1


if __name__ == "__main__":
    sys.exit(main())
