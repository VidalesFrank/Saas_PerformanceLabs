"""
Celery task — Módulo 1: Pushover no lineal de una VARIANTE de rediseño.

Toma una variante persistida en `results/wall_design_variants.json`, aplica sus
overrides sobre el diseño baseline y corre un pushover no lineal completo.
Los resultados se guardan por variante para poder compararlos frente al baseline.

Requiere (baseline):
  - canonical_model.json
  - wall_design_results.json
  - wall_demands.json
  - XLSX de importación

Produce:
  - nl_pushover_variant_{variant_id}_results.json
  - nl_pushover_variant_{variant_id}_{direction}_history.npz
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from app.tasks.celery_app import celery_app


@celery_app.task(
    name="app.tasks.structural_variant_pushover_task.run_variant_pushover",
    bind=True,
)
def run_variant_pushover(
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
    from app.services.design_variants import (
        apply_overrides, get_variant, update_variant,
    )

    extra_params = extra_params or {}
    variant_id   = extra_params.get("variant_id")
    if not variant_id:
        raise ValueError("Falta variant_id en extra_params")

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

        # ── Cargar variante ──────────────────────────────────────────────────
        variant = get_variant(work_dir, variant_id)
        if variant is None:
            raise ValueError(f"Variante {variant_id} no encontrada")
        overrides = variant.get("overrides", {}) or {}
        if not overrides:
            raise ValueError(
                "La variante no tiene overrides. Añade al menos un cambio "
                "antes de analizarla."
            )

        # ── Cargar baseline ──────────────────────────────────────────────────
        with open(canonical_path, encoding="utf-8") as f:
            model = json.load(f)
        with open(design_path, encoding="utf-8") as f:
            design_data = json.load(f)
        with open(demands_path, encoding="utf-8") as f:
            demands_data = json.load(f)

        baseline_designs = design_data.get("designs", [])
        design_rows      = apply_overrides(baseline_designs, overrides)

        fc_mpa    = float(design_data.get("fc_mpa",  21.0))
        fy_mpa    = float(design_data.get("fy_mpa", 420.0))
        ductility = str(design_data.get("ductility", "DMO")).upper()

        # Overrides globales de fc/fy si vinieran en la variante (raro)
        # Se toma el máx de los overrides como fc/fy dominante del re-análisis.
        fc_overrides = [
            float(ov["fc_mpa"]) for ov in overrides.values()
            if isinstance(ov, dict) and ov.get("fc_mpa") is not None
        ]
        fy_overrides = [
            float(ov["fy_mpa"]) for ov in overrides.values()
            if isinstance(ov, dict) and ov.get("fy_mpa") is not None
        ]
        if fc_overrides:
            fc_mpa = max(fc_overrides)
        if fy_overrides:
            fy_mpa = max(fy_overrides)

        # ── Parámetros del pushover ──────────────────────────────────────────
        params = dict(parameters_dict or {})
        params.update({k: v for k, v in extra_params.items() if k != "variant_id"})

        target_drift = float(params.get("target_drift_pct", 2.0))
        inc_m        = float(params.get("inc_m", 0.001))
        n_fibers     = int(params.get("n_fibers", 10))
        directions   = params.get("directions", ["X", "Y"])

        # ── Cargas gravitacionales por pier (desde wall_demands baseline) ────
        pier_pu: dict[tuple, float] = {}
        for row in demands_data.get("pier_demands", []):
            label = row.get("combo", "G")
            if "E" in label.upper():
                continue
            key = (row["pier"], row["story"])
            Pu  = abs(float(row.get("Pu_kN", 0.0)))
            if Pu > pier_pu.get(key, 0.0):
                pier_pu[key] = Pu

        print(
            f"[variant_pushover] variante={variant_id} "
            f"overrides={len(overrides)} pieres afectados"
        )
        print(
            f"[variant_pushover] {len(pier_pu)} pares pier/story con carga gravitacional"
        )
        print(
            f"[variant_pushover] fc={fc_mpa} MPa  fy={fy_mpa} MPa  "
            f"deriva objetivo={target_drift}%"
        )

        # ── Cargar raw_data del XLSX ─────────────────────────────────────────
        from app.tasks.structural_wall_demands_task import _load_wall_raw_data

        xlsx_path = project.input_file_path
        if not xlsx_path or not os.path.exists(xlsx_path):
            xlsx_path = os.path.join(work_dir, "input", "input_model.xlsx")
        if not os.path.exists(xlsx_path):
            raise FileNotFoundError("XLSX de importación no encontrado.")

        raw_data = _load_wall_raw_data(xlsx_path)

        # ── Marca variante como analizando ───────────────────────────────────
        update_variant(work_dir, variant_id, {"status": "analyzing"})

        # ── Ejecutar pushover por dirección ──────────────────────────────────
        from app.engine.building.nonlinear.nl_building_ops_builder import (
            NLBuildingOPSBuilder,
        )

        os.makedirs(res_dir, exist_ok=True)
        results_by_dir: dict[str, dict] = {}

        for direction in directions:
            print(f"[variant_pushover] ── Pushover {direction} ──────────────")
            hist_path = Path(res_dir) / (
                f"nl_pushover_variant_{variant_id}_"
                f"{direction.replace('-', 'm')}_history.npz"
            )
            part_path = Path(res_dir) / (
                f"nl_pushover_variant_{variant_id}_"
                f"{direction.replace('-', 'm')}_partial.json"
            )

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
                print(
                    f"[variant_pushover] Modelo {direction}: {n_elem} elementos MVLEM_3D"
                )

                grav_result = builder.run_gravity(pier_pu, steps=10)
                print(
                    f"[variant_pushover] Gravedad {direction}: {grav_result['status']}"
                )

                push_result = builder.run_pushover(
                    direction        = direction,
                    target_drift_pct = target_drift,
                    inc_m            = inc_m,
                    result_path      = part_path,
                    history_path     = hist_path,
                    history_stride   = int(params.get("history_stride", 1)),
                )
                push_result["pier_lines"]   = info["pier_lines"]
                push_result["stories_z"]    = info["stories_z"]
                push_result["total_height"] = info["total_height"]
                print(
                    f"[variant_pushover] Pushover {direction}: "
                    f"{push_result['status']} | "
                    f"{push_result['converged_steps']}/{push_result['total_steps']} pasos "
                    f"| deriva max {push_result['summary'].get('max_drift_pct', 0):.2f}% "
                    f"| Vb max {push_result['summary'].get('max_base_shear_kN', 0):.1f} kN"
                )

                if push_result.get("history"):
                    try:
                        from app.engine.building.nonlinear.damage_index import (
                            compute_pier_damage_from_history,
                        )
                        damage = compute_pier_damage_from_history(
                            history_path = hist_path,
                            steps        = push_result["steps"],
                            design_rows  = design_rows,
                            direction    = direction,
                            ductility    = ductility,
                        )
                        push_result["damage"] = damage
                        print(
                            f"[variant_pushover] Daño {direction}: "
                            f"{damage['n_critical']} pieres críticos "
                            f"(DI>0.4), DI máx = {damage['max_di']:.3f}"
                        )
                    except Exception as e_dmg:
                        print(
                            f"[variant_pushover] WARN damage index {direction}: {e_dmg}"
                        )

                results_by_dir[direction] = push_result

            except Exception as e_dir:
                print(f"[variant_pushover] ERROR en dirección {direction}: {e_dir}")
                results_by_dir[direction] = {"status": "failed", "message": str(e_dir)}
            finally:
                builder.wipe()

        # ── Guardar resultado por variante ──────────────────────────────────
        summary = {
            d: {
                "status":          r.get("status"),
                "converged_steps": r.get("converged_steps", 0),
                "total_steps":     r.get("total_steps", 0),
                **r.get("summary", {}),
                "n_critical_piers": r.get("damage", {}).get("n_critical", 0),
                "max_di":           r.get("damage", {}).get("max_di", 0.0),
            }
            for d, r in results_by_dir.items()
        }

        result = {
            "status":            "success",
            "job_id":            job_id,
            "project_id":        project_id,
            "variant_id":        variant_id,
            "variant_name":      variant.get("name"),
            "n_overrides":       len(overrides),
            "fc_mpa":            fc_mpa,
            "fy_mpa":            fy_mpa,
            "target_drift_pct":  target_drift,
            "n_fibers":          n_fibers,
            "summary":           summary,
            "pushover_X":        results_by_dir.get("X"),
            "pushover_Y":        results_by_dir.get("Y"),
            "computed_at":       datetime.now(timezone.utc).isoformat(),
        }

        res_path = os.path.join(
            res_dir, f"nl_pushover_variant_{variant_id}_results.json"
        )
        with open(res_path, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2)

        db_summary = {
            "variant_id": variant_id,
            "directions": directions,
            "summary": {
                d: {k: v for k, v in s.items() if k in (
                    "status", "max_drift_pct", "max_base_shear_kN",
                    "converged_steps", "total_steps",
                    "n_critical_piers", "max_di",
                )}
                for d, s in summary.items()
            },
        }

        job.status         = StructuralJobStatus.success
        job.result_path    = res_path
        job.result_summary = json.dumps(db_summary)
        job.finished_at    = datetime.now(timezone.utc)
        db.commit()

        # Marca variante como analizada
        update_variant(
            work_dir, variant_id,
            {
                "status":               "analyzed",
                "analysis_job_id":      job_id,
                "analysis_result_path": res_path,
                "analyzed_at":          datetime.now(timezone.utc).isoformat(),
            },
        )
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
            # Marca variante como failed
            if variant_id:
                try:
                    project = db.query(
                        __import__("app.models", fromlist=["StructuralProject"]).StructuralProject
                    ).filter_by(id=project_id).first()
                    if project and project.canonical_model_path:
                        work_dir = os.path.dirname(
                            os.path.dirname(project.canonical_model_path)
                        )
                        from app.services.design_variants import update_variant
                        update_variant(
                            work_dir, variant_id,
                            {
                                "status":          "failed",
                                "analysis_job_id": job_id,
                                "error_message":   str(exc)[:500],
                            },
                        )
                except Exception:
                    pass
        except Exception:
            pass
        raise
    finally:
        db.close()
