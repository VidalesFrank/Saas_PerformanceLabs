"""
Celery task — Wall Demands (Módulo 1 muros).

Flujo:
  1. Carga canonical_model.json + raw_data XLSX del proyecto
  2. WallModelBuilder → modelo MVLEM_3D elástico
  3. WallDemandAnalyzer → FHE NSR-10 + combinaciones por pier
  4. Guarda results/wall_demands.json
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone

from app.tasks.celery_app import celery_app


@celery_app.task(name="app.tasks.structural_wall_demands_task.run_wall_demands", bind=True)
def run_wall_demands(
    self,
    job_id: str,
    project_id: str,
    input_file: str | None = None,
    parameters_dict: dict | None = None,
    e2k_file: str | None = None,
    extra_params: dict | None = None,
):
    """
    Lanza el análisis de demandas de muros (FHE NSR-10 + MVLEM_3D).
    """
    from app.db import SessionLocal
    from app.models import StructuralJob, StructuralJobStatus

    db = SessionLocal()
    try:
        job = db.query(StructuralJob).filter(StructuralJob.id == job_id).first()
        if not job:
            return {"error": "Job not found"}

        job.status = StructuralJobStatus.running
        db.commit()

        project = job.project
        if not project.canonical_model_path:
            raise ValueError("No hay modelo canónico. Ejecuta primero el análisis de importación.")

        canonical_path = project.canonical_model_path
        work_dir       = os.path.dirname(os.path.dirname(canonical_path))

        # El XLSX puede estar en input_file_path (xlsx directo) o generado en import
        xlsx_path = project.input_file_path
        if not xlsx_path or not os.path.exists(xlsx_path):
            xlsx_path = os.path.join(work_dir, "input", "input_model.xlsx")
        if not os.path.exists(xlsx_path):
            raise FileNotFoundError(
                "XLSX de importación no encontrado. "
                "Asegúrate de que el análisis de importación se completó correctamente."
            )

        # ── 1. Cargar modelo canónico ──────────────────────────────────────────
        with open(canonical_path, encoding="utf-8") as f:
            model = json.load(f)

        # ── 2. Cargar raw_data desde XLSX ─────────────────────────────────────
        raw_data = _load_wall_raw_data(xlsx_path)

        # ── 3. Parámetros sísmicos ─────────────────────────────────────────────
        seismic = parameters_dict or {}
        if extra_params:
            seismic.update(extra_params)

        # ── 4. Distribución de cargas tributarias (método de 45°) ─────────────
        from app.engine.building.linear.tributary_load import (
            load_slab_intensities, TributaryLoadComputer
        )
        from app.engine.building.linear.gravity_ops_builder import GravityOPSBuilder

        slab_intensities = load_slab_intensities(raw_data)
        trib_computer    = TributaryLoadComputer(model, slab_intensities)
        tributary_loads  = trib_computer.compute()

        print(f"[gravity] Losas con carga: {tributary_loads['summary']['slab_count']}")
        print(f"[gravity] Carga muerta total: {tributary_loads['summary']['total_dead_kN']:.1f} kN")
        print(f"[gravity] Carga viva total:   {tributary_loads['summary']['total_live_kN']:.1f} kN")

        # ── 5. Análisis gravitacional con ShellMITC4 ──────────────────────────
        gravity_builder = GravityOPSBuilder(model, tributary_loads)
        gravity_result  = gravity_builder.run()

        ctrl = gravity_result['control']
        print(f"[gravity] Balance W_aplicado={ctrl['total_applied_dead_kN']:.1f} kN "
              f"W_reaccion={ctrl['total_reaction_dead_kN']:.1f} kN "
              f"error={ctrl['balance_error_pct']:.2f}%")

        # ── 6. Build MVLEM_3D + demandas laterales ────────────────────────────
        from app.engine.building.linear.wall_model_builder import WallModelBuilder
        from app.engine.building.linear.wall_demands import WallDemandAnalyzer

        n_fibers = int((extra_params or {}).get("n_fibers", 10))
        wb     = WallModelBuilder(model, raw_data, n_fibers=n_fibers)
        binfo  = wb.build()

        # Inyectar fuerzas gravitacionales del análisis ShellMITC4
        # en el analizador (reemplaza la distribución por área de sección)
        analyzer = WallDemandAnalyzer(binfo, model, seismic,
                                      gravity_overrides=gravity_result['pier_gravity'])
        result   = analyzer.run()

        # ── 7. Guardar resultado ───────────────────────────────────────────────
        res_dir  = os.path.join(work_dir, "results")
        os.makedirs(res_dir, exist_ok=True)
        res_path = os.path.join(res_dir, "wall_demands.json")

        payload = {
            "status":        "success",
            "job_id":        job_id,
            "project_id":    project_id,
            "fhe_params":    result["fhe_params"],
            "story_forces":  result["story_forces"],
            "gravity_axials": result["gravity_axials"],
            "pier_demands":  result["pier_demands"],
            "pier_count":    len(binfo["pier_geom"]),
            "story_count":   len(binfo["stories_order"]) - 1,
            "gravity_control": ctrl,
            "tributary_summary": tributary_loads["summary"],
        }
        with open(res_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)

        summary = {
            "pier_count":    payload["pier_count"],
            "story_count":   payload["story_count"],
            "W_kN":          result["fhe_params"]["W_kN"],
            "Vb_kN":         result["fhe_params"]["Vb_kN"],
            "T_s":           result["fhe_params"]["T_s"],
            "demands_count": len(result["pier_demands"]),
        }

        job.status        = StructuralJobStatus.success
        job.result_path   = res_path
        job.result_summary = json.dumps(summary)
        job.finished_at   = datetime.now(timezone.utc)
        db.commit()

        return payload

    except Exception as exc:
        db.rollback()
        try:
            from app.models import StructuralJobStatus
            j = db.query(__import__("app.models", fromlist=["StructuralJob"]).StructuralJob)\
                  .filter_by(id=job_id).first()
            if j:
                j.status        = StructuralJobStatus.failed
                j.error_message = str(exc)[:4000]
                j.finished_at   = datetime.now(timezone.utc)
                db.commit()
        except Exception:
            pass
        raise
    finally:
        db.close()


# ── Carga de tablas del XLSX de importación ───────────────────────────────────

_WALL_TABLE_MAP = {
    'Pier Section Properties':          'TABLE:  "PIER SECTION PROPERTIES"',
    'Shell Assignments - Pier Spandr':  'TABLE:  "SHELL ASSIGNMENTS - PIER SPANDR"',
    'Objects and Elements - Shells':    'TABLE:  "OBJECTS AND ELEMENTS - SHELLS"',
    'Shell Sections - Wall':            'TABLE:  "SHELL SECTIONS - WALL"',
    'Shell Assignments - Sections':     'TABLE:  "SHELL ASSIGNMENTS - SECTIONS"',
    'Mass Summary by Diaphragm':        'TABLE:  "MASS SUMMARY BY DIAPHRAGM"',
    # Para distribución de cargas tributarias
    'Shell Loads - Uniform':            'Shell Loads - Uniform',
}


def _load_wall_raw_data(xlsx_path: str) -> dict:
    import pandas as pd

    raw_data: dict = {}
    xl = pd.ExcelFile(xlsx_path)
    sheet_names = xl.sheet_names

    for sheet_name, key in _WALL_TABLE_MAP.items():
        if sheet_name not in sheet_names:
            raw_data[key] = None
            continue
        try:
            df = pd.read_excel(xl, sheet_name=sheet_name, skiprows=1, header=0)
            # Drop units row (row 0 typically has unit labels like 'm', 'kN')
            if len(df) > 0:
                df = df.drop(index=0).reset_index(drop=True)
            raw_data[key] = df
        except Exception:
            raw_data[key] = None

    return raw_data
