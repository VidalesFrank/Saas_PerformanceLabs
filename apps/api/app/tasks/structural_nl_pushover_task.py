"""
Celery task — Módulo 1: Pushover no lineal de edificio de muros (NSR-10).

Requiere:
  - canonical_model.json   (geometría, masas, materiales)
  - wall_design_results.json (diseño RC por pier: armado, EBE, ρ)
  - wall_demands.json      (para cargas gravitacionales por pier)
  - XLSX de importación    (tablas ETABS: pier props, shell assignments, etc.)

Produce:
  - nl_pushover_results.json  (curvas pushover X e Y + summary)
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from app.tasks.celery_app import celery_app


@celery_app.task(name="app.tasks.structural_nl_pushover_task.run_nl_pushover", bind=True)
def run_nl_pushover(
    self,
    job_id: str,
    project_id: str,
    input_file: str | None = None,
    parameters_dict: dict | None = None,
    e2k_file: str | None = None,
    extra_params: dict | None = None,
):
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
            raise ValueError("No hay modelo canónico.")

        canonical_path = project.canonical_model_path
        work_dir       = os.path.dirname(os.path.dirname(canonical_path))
        res_dir        = os.path.join(work_dir, "results")

        design_path  = os.path.join(res_dir, "wall_design_results.json")
        demands_path = os.path.join(res_dir, "wall_demands.json")

        if not os.path.exists(design_path):
            raise FileNotFoundError(
                "wall_design_results.json no encontrado. "
                "Ejecuta primero el diseño de muros RC."
            )
        if not os.path.exists(demands_path):
            raise FileNotFoundError(
                "wall_demands.json no encontrado. "
                "Ejecuta primero el análisis de demandas de muros."
            )

        # ── Cargar datos ──────────────────────────────────────────────────────
        with open(canonical_path, encoding="utf-8") as f:
            model = json.load(f)
        with open(design_path, encoding="utf-8") as f:
            design_data = json.load(f)
        with open(demands_path, encoding="utf-8") as f:
            demands_data = json.load(f)

        design_rows = design_data.get("designs", [])
        fc_mpa      = float(design_data.get("fc_mpa",  21.0))
        fy_mpa      = float(design_data.get("fy_mpa", 420.0))

        # ── Parámetros del pushover ───────────────────────────────────────────
        params        = dict(parameters_dict or {})
        if extra_params:
            params.update(extra_params)

        target_drift  = float(params.get("target_drift_pct", 2.0))
        inc_m         = float(params.get("inc_m", 0.001))
        n_fibers      = int(params.get("n_fibers", 10))
        directions    = params.get("directions", ["X", "Y"])

        # ── Cargas gravitacionales por pier desde wall_demands.json ───────────
        # Usa la combinación de gravedad (sin E) con mayor Pu
        pier_pu: dict[tuple, float] = {}
        for row in demands_data.get("pier_demands", []):
            label = row.get("combo", "G")
            if "E" in label.upper():
                continue
            key = (row["pier"], row["story"])
            Pu  = abs(float(row.get("Pu_kN", 0.0)))
            if Pu > pier_pu.get(key, 0.0):
                pier_pu[key] = Pu

        print(f"[nl_pushover] {len(pier_pu)} pares pier/story con carga gravitacional")
        print(f"[nl_pushover] {len(design_rows)} pieres con diseño RC")
        print(f"[nl_pushover] fc={fc_mpa} MPa  fy={fy_mpa} MPa  deriva objetivo={target_drift}%")

        # ── Cargar raw_data del XLSX ──────────────────────────────────────────
        from app.tasks.structural_wall_demands_task import _load_wall_raw_data

        xlsx_path = project.input_file_path
        if not xlsx_path or not os.path.exists(xlsx_path):
            xlsx_path = os.path.join(work_dir, "input", "input_model.xlsx")
        if not os.path.exists(xlsx_path):
            raise FileNotFoundError("XLSX de importación no encontrado.")

        raw_data = _load_wall_raw_data(xlsx_path)
        print(f"[nl_pushover] raw_data cargado desde {os.path.basename(xlsx_path)}")

        # ── Importar builder ──────────────────────────────────────────────────
        from app.engine.building.nonlinear.nl_building_ops_builder import NLBuildingOPSBuilder

        os.makedirs(res_dir, exist_ok=True)

        results_by_dir: dict[str, dict] = {}

        for direction in directions:
            print(f"[nl_pushover] ── Pushover {direction} ──────────────────────")
            part_path = Path(res_dir) / f"nl_pushover_{direction.replace('-', 'm')}_partial.json"

            builder = NLBuildingOPSBuilder(
                model       = model,
                raw_data    = raw_data,
                design_rows = design_rows,
                fc_mpa      = fc_mpa,
                fy_mpa      = fy_mpa,
                n_fibers    = n_fibers,
            )
            try:
                info = builder.build()
                n_elem = len(info["pier_elements"])
                print(f"[nl_pushover] Modelo {direction}: {n_elem} elementos MVLEM_3D")

                grav_result = builder.run_gravity(pier_pu, steps=10)
                print(f"[nl_pushover] Gravedad {direction}: {grav_result['status']}")

                push_result = builder.run_pushover(
                    direction        = direction,
                    target_drift_pct = target_drift,
                    inc_m            = inc_m,
                    result_path      = part_path,
                )
                print(
                    f"[nl_pushover] Pushover {direction}: {push_result['status']} "
                    f"| {push_result['converged_steps']}/{push_result['total_steps']} pasos "
                    f"| deriva max {push_result['summary'].get('max_drift_pct', 0):.2f}% "
                    f"| Vb max {push_result['summary'].get('max_base_shear_kN', 0):.1f} kN"
                )
                results_by_dir[direction] = push_result

            except Exception as e_dir:
                print(f"[nl_pushover] ERROR en dirección {direction}: {e_dir}")
                results_by_dir[direction] = {"status": "failed", "message": str(e_dir)}
            finally:
                builder.wipe()

        # ── Guardar resultado final ───────────────────────────────────────────
        summary = {
            d: {
                "status":          r.get("status"),
                "converged_steps": r.get("converged_steps", 0),
                "total_steps":     r.get("total_steps", 0),
                **r.get("summary", {}),
            }
            for d, r in results_by_dir.items()
        }

        result = {
            "status":      "success",
            "job_id":      job_id,
            "project_id":  project_id,
            "fc_mpa":      fc_mpa,
            "fy_mpa":      fy_mpa,
            "target_drift_pct": target_drift,
            "n_fibers":    n_fibers,
            "summary":     summary,
            "pushover_X":  results_by_dir.get("X"),
            "pushover_Y":  results_by_dir.get("Y"),
            "computed_at": datetime.now(timezone.utc).isoformat(),
        }

        res_path = os.path.join(res_dir, "nl_pushover_results.json")
        with open(res_path, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2)

        db_summary = {
            "directions": directions,
            "summary": {
                d: {k: v for k, v in s.items() if k in (
                    "status", "max_drift_pct", "max_base_shear_kN",
                    "converged_steps", "total_steps",
                )}
                for d, s in summary.items()
            },
        }

        job.status         = StructuralJobStatus.success
        job.result_path    = res_path
        job.result_summary = json.dumps(db_summary)
        job.finished_at    = datetime.now(timezone.utc)
        db.commit()
        return result

    except Exception as exc:
        db.rollback()
        try:
            from app.models import StructuralJobStatus
            j = db.query(
                __import__("app.models", fromlist=["StructuralJob"]).StructuralJob
            ).filter_by(id=job_id).first()
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
