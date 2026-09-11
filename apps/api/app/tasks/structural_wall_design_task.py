"""
Celery task — Módulo 1: Diseño de muros RC por pier (NSR-10 C.21).

Requiere:
  - canonical_model.json   (propiedades de materiales)
  - wall_demands.json      (demandas Pu/Vu/Mu por pier/piso con combos NSR-10)
  - spectral_results.json  (derivas por piso para EBE Método A — opcional)

Produce:
  - wall_design_results.json  (tabla compacta: todos los pieres)
  - wall_design_ng_detail.json (detalle completo: pieres NG + peores OK)
"""
from __future__ import annotations

import json
import math
import os
from collections import defaultdict
from datetime import datetime, timezone

from app.tasks.celery_app import celery_app

_DETAIL_MAX_OK = 20   # cuántos pieres OK guardar en el detalle (los peores por DCR)


@celery_app.task(name="app.tasks.structural_wall_design_task.run_wall_design", bind=True)
def run_wall_design(
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
        demands_path   = os.path.join(work_dir, "results", "wall_demands.json")

        if not os.path.exists(demands_path):
            raise FileNotFoundError(
                "wall_demands.json no encontrado. "
                "Ejecuta primero el análisis de demandas de muros."
            )

        with open(canonical_path, encoding="utf-8") as f:
            model = json.load(f)
        with open(demands_path, encoding="utf-8") as f:
            demands_data = json.load(f)

        params = parameters_dict or {}
        if extra_params:
            params.update(extra_params)

        # ── Propiedades de materiales ─────────────────────────────────────────
        materials = model.get("materials", {})
        ductility = params.get("energy_dissipation", "DMO")
        cover_mm  = float(params.get("cover_mm", 25.0))
        fy_mpa    = float(params.get("fy_mpa",  420.0))
        fyt_mpa   = float(params.get("fyt_mpa", 420.0))

        fc_mpa = 21.0
        for mat in materials.values():
            fpc = float(mat.get("fpc_mpa", 0.0))
            if fpc > 0:
                fc_mpa = fpc
                break

        print(f"[wall_design] fc={fc_mpa} MPa  fy={fy_mpa} MPa  ductility={ductility}")

        # ── Derivas por piso del espectral (para EBE Método A) ───────────────
        # NSR-10 C.21.9.6 / ACI 318-25 §18.10.6.2: c ≥ lw/(600·δu/hw)
        story_drift_x: dict[str, float] = {}
        story_drift_y: dict[str, float] = {}
        spectral_path = os.path.join(work_dir, "results", "spectral_results.json")
        if os.path.exists(spectral_path):
            with open(spectral_path, encoding="utf-8") as f:
                sp = json.load(f)
            for d in sp.get("story_drifts", []):
                sname = d["story"]
                story_drift_x[sname] = abs(d.get("drift_x_pct", 0.0)) / 100.0
                story_drift_y[sname] = abs(d.get("drift_y_pct", 0.0)) / 100.0
            print(f"[wall_design] Derivas cargadas para {len(story_drift_x)} pisos (EBE Método A)")
        else:
            print("[wall_design] spectral_results.json no encontrado — EBE solo Método B (esfuerzo)")

        # ── Agrupar demandas por (pier, story) ───────────────────────────────
        pier_combos: dict[tuple, list[dict]] = defaultdict(list)
        pier_geom:   dict[tuple, dict]       = {}

        for row in demands_data.get("pier_demands", []):
            key = (row["pier"], row["story"])
            pier_combos[key].append(row)
            if key not in pier_geom:
                pier_geom[key] = {
                    "lw_m": float(row.get("lw_m", 1.0)),
                    "tw_m": float(row.get("tw_m", 0.10)),
                    "hw_m": float(row.get("hw_m", 2.45)),
                }

        total_piers = len(pier_geom)
        print(f"[wall_design] {total_piers} pieres × pisos a diseñar")

        from app.engine.building.walls.wall_design_engine import compute_wall_design
        from app.engine.building.walls.wall_design_schemas import WallDemandCombo

        summary_rows: list[dict] = []
        ng_detail:    list[dict] = []
        ok_worst:     list[dict] = []   # para guardar los peores OK en el detalle

        n_ok = n_ng = n_ebe = 0

        for (pier, story), rows in pier_combos.items():
            g  = pier_geom[(pier, story)]
            lw = g["lw_m"]
            tw = g["tw_m"]
            hw = g["hw_m"]

            # Deriva de diseño para EBE Método A (dirección dominante)
            dx = story_drift_x.get(story, 0.0)
            dy = story_drift_y.get(story, 0.0)
            delta_u_hw = max(dx, dy) if (dx > 0 or dy > 0) else None

            # Convertir filas a WallDemandCombo
            combos: list[WallDemandCombo] = []
            for r in rows:
                vu_x = abs(float(r.get("Vu_x_kN", 0.0)))
                vu_y = abs(float(r.get("Vu_y_kN", 0.0)))
                mu_x = abs(float(r.get("Mu_x_kNm", 0.0)))
                mu_y = abs(float(r.get("Mu_y_kNm", 0.0)))
                if vu_x >= vu_y:
                    vu, mu = vu_x, mu_x
                else:
                    vu, mu = vu_y, mu_y
                label = r.get("combo", "G")
                combos.append(WallDemandCombo(
                    label      = label,
                    Pu_kN      = float(r.get("Pu_kN", 0.0)),
                    Vu_kN      = vu,
                    Mu_kNm     = mu,
                    is_seismic = "E" in label,
                ))

            if not combos:
                continue

            try:
                res = compute_wall_design(
                    lw_m        = lw,
                    tw_m        = tw,
                    hw_m        = hw,
                    fc_mpa      = fc_mpa,
                    fy_mpa      = fy_mpa,
                    fyt_mpa     = fyt_mpa,
                    ductility   = ductility,
                    demands     = combos,
                    mode        = "auto",
                    cover_mm    = cover_mm,
                    delta_u_hw  = delta_u_hw,
                )

                ok     = res["ok"]
                summ   = res["summary"]
                reinf  = res["reinforcement"]
                shear  = res["shear"]

                # DCR máximo entre todas las verificaciones
                max_dcr = max((c["dcr"] for c in res["checks"]), default=0.0)

                row_compact = {
                    "pier":  pier,
                    "story": story,
                    "lw_m":  lw,
                    "tw_m":  tw,
                    "hw_m":  hw,
                    "ok":    ok,
                    "n_failed":     summ["failed_checks"],
                    "max_dcr":      round(max_dcr, 3),
                    "ebe_required": summ["ebe_required"],
                    "ebe_method":   res["boundary_element"]["method"],
                    "lc_m":         round(summ["lc_m"], 3),
                    "c_m":          round(summ["c_m"], 4),
                    "phi_Mn_kNm":   round(summ["phi_Mn_kNm"], 1),
                    "phi_Vn_kN":    round(summ["phi_Vn_kN"], 1),
                    "Vu_kN":        round(shear["Vu_kN"], 1),
                    "governing_combo": res["governing_combo"],
                    # Refuerzo alma
                    "web_horiz_db_mm":  reinf["web"]["horiz_db_mm"],
                    "web_horiz_sp_mm":  round(reinf["web"]["horiz_spacing_mm"], 0),
                    "web_vert_db_mm":   reinf["web"]["vert_db_mm"],
                    "web_vert_sp_mm":   round(reinf["web"]["vert_spacing_mm"], 0),
                    "rho_h_pct":        round(reinf["web"]["rho_h"] * 100, 4),
                    "rho_v_pct":        round(reinf["web"]["rho_v"] * 100, 4),
                    # Elemento de borde
                    "be_n_bars": reinf["be_left"]["n_bars"],
                    "be_db_mm":  reinf["be_left"]["db_mm"],
                    "be_lc_m":   round(reinf["be_left"]["length_m"], 3),
                }
                summary_rows.append(row_compact)

                if ok:
                    n_ok += 1
                    ok_worst.append({"pier": pier, "story": story,
                                     "max_dcr": max_dcr, "detail": res})
                else:
                    n_ng += 1
                    ng_detail.append({"pier": pier, "story": story, "detail": res})

                if summ["ebe_required"]:
                    n_ebe += 1

            except Exception as e_d:
                print(f"[wall_design] WARN {pier}/{story}: {e_d}")
                summary_rows.append({
                    "pier": pier, "story": story,
                    "lw_m": lw, "tw_m": tw, "hw_m": hw,
                    "ok": False, "error": str(e_d),
                })
                n_ng += 1

        # Peores pieres OK (mayor DCR) para el archivo de detalle
        ok_worst.sort(key=lambda x: -x["max_dcr"])
        ok_worst_detail = [x["detail"] | {"pier": x["pier"], "story": x["story"]}
                           for x in ok_worst[:_DETAIL_MAX_OK]]

        # Estadísticas globales
        dcrs = [r.get("max_dcr", 0.0) for r in summary_rows if "max_dcr" in r]
        max_dcr_global = round(max(dcrs), 3) if dcrs else 0.0

        result = {
            "status":      "success",
            "job_id":      job_id,
            "project_id":  project_id,
            "fc_mpa":      fc_mpa,
            "fy_mpa":      fy_mpa,
            "ductility":   ductility,
            "pier_count":  total_piers,
            "n_ok":        n_ok,
            "n_ng":        n_ng,
            "n_ebe":       n_ebe,
            "max_dcr":     max_dcr_global,
            "ebe_method":  "displacement" if story_drift_x else "stress",
            "designs":     summary_rows,
        }

        res_dir = os.path.join(work_dir, "results")
        os.makedirs(res_dir, exist_ok=True)

        res_path = os.path.join(res_dir, "wall_design_results.json")
        with open(res_path, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2)

        # Detalle: pieres NG + peores OK
        ng_path = os.path.join(res_dir, "wall_design_ng_detail.json")
        with open(ng_path, "w", encoding="utf-8") as f:
            json.dump({
                "ng_piers": ng_detail,
                "worst_ok_piers": ok_worst_detail,
            }, f, indent=2)

        print(f"[wall_design] {n_ok} OK / {n_ng} NG | {n_ebe} EBE | "
              f"max_DCR={max_dcr_global:.3f} | método_EBE={'A(desp)' if story_drift_x else 'B(esfuerzo)'}")

        summary_db = {
            "pier_count": total_piers,
            "n_ok":       n_ok,
            "n_ng":       n_ng,
            "n_ebe":      n_ebe,
            "max_dcr":    max_dcr_global,
            "ebe_method": result["ebe_method"],
        }

        job.status         = StructuralJobStatus.success
        job.result_path    = res_path
        job.result_summary = json.dumps(summary_db)
        job.finished_at    = datetime.now(timezone.utc)
        db.commit()
        return result

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
