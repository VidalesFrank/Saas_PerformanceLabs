"""Limpia registros GroundMotionRecord que duplican un nombre del catálogo Colombia.

Problema: imports manuales (p. ej. "cargar CPER6_EW aparte para comparar") crean
registros con el mismo ``name`` que un registro del catálogo pero sin
``metadata_json.campaign``. Las búsquedas por ``name`` en el catálogo pueden
devolver estos huérfanos de forma no-determinística y romper el preview.

Este script identifica los huérfanos y pregunta antes de borrar.

Uso:
    cd apps/api
    ../../.venv/Scripts/python.exe scripts/cleanup_orphan_gm_records.py            # dry-run
    ../../.venv/Scripts/python.exe scripts/cleanup_orphan_gm_records.py --apply    # borra
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_API_DIR = _HERE.parent
if str(_API_DIR) not in sys.path:
    sys.path.insert(0, str(_API_DIR))

from app.db import SessionLocal  # noqa: E402
from app.models import GroundMotionRecord  # noqa: E402

CAMPAIGN = "colombia_2026_08_10"


def find_orphans(db) -> list[GroundMotionRecord]:
    """Registros con mismo name que uno del catálogo pero sin campaign."""
    all_rows = db.query(GroundMotionRecord).all()
    catalog_names = {
        r.name for r in all_rows
        if (r.metadata_json or {}).get("campaign") == CAMPAIGN
    }
    orphans = [
        r for r in all_rows
        if r.name in catalog_names
        and (r.metadata_json or {}).get("campaign") != CAMPAIGN
    ]
    return orphans


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Ejecuta las eliminaciones.")
    args = parser.parse_args()

    db = SessionLocal()
    orphans = find_orphans(db)

    print(f"Catálogo activo: {CAMPAIGN}")
    print(f"Registros huérfanos encontrados: {len(orphans)}")
    print()
    for r in orphans:
        md = r.metadata_json or {}
        print(f"  id={r.id}")
        print(f"    name          = {r.name}")
        print(f"    campaign      = {md.get('campaign', '(ninguna)')}")
        print(f"    source_file   = {r.source_file!r}")
        print(f"    raw_data_path = {r.raw_data_path}")
        print(f"    created_at    = {r.created_at}")
        print()

    if not args.apply:
        print("[dry-run] no se borró nada. Agregá --apply para ejecutar.")
        db.close()
        return 0

    for r in orphans:
        # 1. Borrar archivos en disco
        if r.raw_data_path:
            gm_dir = os.path.dirname(r.raw_data_path)
            if gm_dir and os.path.isdir(gm_dir):
                try:
                    shutil.rmtree(gm_dir)
                    print(f"  rm -r {gm_dir}")
                except OSError as e:
                    print(f"  WARN no pude borrar {gm_dir}: {e}")
        # 2. Borrar fila DB (cascade borra GMJobs asociados)
        db.delete(r)
        print(f"  DELETE FROM gm_records WHERE id={r.id}")

    db.commit()
    print(f"\n[OK] {len(orphans)} huérfanos eliminados.")
    db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
