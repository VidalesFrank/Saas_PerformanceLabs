"""
Celery task — Módulo 1: Pushover no lineal de edificios de pórticos RC.

Requiere:
  - canonical_model.json       (geometría de nodos/frames/masas)
  - nonlinear_model.json       (spec generado por NLSpecBuilder — incluye
                                armado real + confinamiento Mander por sección)

Produce:
  - nl_frame_pushover_results.json  (curvas pushover por dirección + summary)
  - nl_frame_pushover_{dir}_history.npz  (desplazamientos + deformaciones de
                                           sección por paso para post-proceso
                                           de daño por rótula plástica)
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from app.tasks.celery_app import celery_app


def _update_job_progress(job_id: str, progress: dict) -> None:
    """
    Actualiza `progress_json` del StructuralJob en una sesión corta aislada.
    Si falla, se ignora (no debe tumbar el análisis por un error de BD).
    """
    try:
        from app.db import SessionLocal
        from app.models import StructuralJob
        db = SessionLocal()
        try:
            job = db.get(StructuralJob, job_id)
            if job:
                job.progress_json = progress
                db.commit()
        finally:
            db.close()
    except Exception:
        pass


@celery_app.task(
    name="app.tasks.structural_frame_pushover_task.run_frame_pushover",
    bind=True,
)
def run_frame_pushover(
    self,
    job_id:          str,
    project_id:      str,
    input_file:      str | None = None,
    parameters_dict: dict | None = None,
    e2k_file:        str | None = None,
    extra_params:    dict | None = None,
):
    """
    Ejecuta pushover no lineal de pórticos.

    Parámetros útiles en `parameters_dict` (todos opcionales):
      - pattern_type     : "triangular" | "uniforme" | "modal"  (default "triangular")
      - target_drift_pct : float (default 2.0)
      - inc_m            : paso de desplazamiento en m (default 0.001)
      - directions       : lista ["X","Y"] (default ambos)
      - n_integration_pts: IPs por elemento (default 5)
      - history_stride   : submuestreo del NPZ (default 1)
    """
    from app.db import SessionLocal
    from app.models import StructuralJob, StructuralJobStatus

    db = SessionLocal()
    try:
        job = db.get(StructuralJob, job_id)
        if not job:
            return {"error": "Job not found"}

        job.status        = StructuralJobStatus.running
        job.progress_json = {"stage": "init"}
        db.commit()

        project = job.project
        if not project.canonical_model_path:
            raise ValueError("El proyecto no tiene un modelo canónico.")

        canonical_path = project.canonical_model_path
        work_dir       = os.path.dirname(os.path.dirname(canonical_path))
        res_dir        = os.path.join(work_dir, "results")
        nl_spec_path   = os.path.join(work_dir, "nonlinear", "nonlinear_model.json")

        if not os.path.exists(nl_spec_path):
            # Generar el spec si no existe (el router debería haberlo generado,
            # pero por robustez lo intentamos aquí también)
            _ensure_nl_spec(project, work_dir)

        if not os.path.exists(nl_spec_path):
            raise FileNotFoundError(
                "nonlinear_model.json no encontrado. "
                "Genera el modelo no lineal primero (POST /projects/nonlinear/{id}/spec/generate)."
            )

        with open(canonical_path, encoding="utf-8") as f:
            canonical = json.load(f)
        with open(nl_spec_path, encoding="utf-8") as f:
            spec = json.load(f)

        # ── Parámetros ───────────────────────────────────────────────────────
        params = dict(parameters_dict or {})
        if extra_params:
            params.update(extra_params)
        pattern_type    = str(params.get("pattern_type", "triangular")).lower()
        target_drift    = float(params.get("target_drift_pct", 2.0))
        inc_m           = float(params.get("inc_m", 0.001))
        directions      = params.get("directions", ["X", "Y"])
        n_ip            = int(params.get("n_integration_pts", 5))
        history_stride  = int(params.get("history_stride", 1))

        if pattern_type not in ("triangular", "uniforme", "modal"):
            raise ValueError(
                f"pattern_type '{pattern_type}' no soportado. "
                "Debe ser 'triangular', 'uniforme' o 'modal'."
            )

        print(f"[frame_pushover] Patrón: {pattern_type} | deriva: {target_drift}% | "
              f"inc: {inc_m*1000:.1f} mm | direcciones: {directions}")
        print(f"[frame_pushover] Spec: {spec['metadata'].get('n_columns', 0)} columnas, "
              f"{spec['metadata'].get('n_beams', 0)} vigas, "
              f"{spec['metadata'].get('n_stories', 0)} pisos.")

        # ── Importar builder ─────────────────────────────────────────────────
        from app.engine.building.nonlinear.nl_frame_ops_builder import NLFrameOPSBuilder

        os.makedirs(res_dir, exist_ok=True)
        results_by_dir: dict[str, dict] = {}

        for direction in directions:
            print(f"[frame_pushover] ── Pushover {direction} ──────────────────")
            hist_path = Path(res_dir) / f"nl_frame_pushover_{direction.replace('-', 'm')}_history.npz"
            part_path = Path(res_dir) / f"nl_frame_pushover_{direction.replace('-', 'm')}_partial.json"

            builder = NLFrameOPSBuilder(
                canonical         = canonical,
                spec              = spec,
                n_integration_pts = n_ip,
            )
            try:
                info = builder.build()
                print(f"[frame_pushover] Dominio {direction}: "
                      f"{info['n_columns']} cols, {info['n_beams']} vigas, "
                      f"ctrl_node={info['control_node']}, H={info['total_height']:.2f}m")

                _update_job_progress(job_id, {
                    "stage":     "gravity",
                    "direction": direction,
                })
                grav = builder.run_gravity(steps=10)
                print(f"[frame_pushover] Gravedad {direction}: {grav['status']}")

                def _progress_cb(data: dict) -> None:
                    pct = int(100.0 * data["step"] / max(data["total"], 1))
                    _update_job_progress(job_id, {
                        "stage":          "pushover",
                        "direction":      data["direction"],
                        "pattern_type":   pattern_type,
                        "step":           data["step"],
                        "total":          data["total"],
                        "pct":            pct,
                        "drift_pct":      data["drift_pct"],
                        "base_shear_kN":  data["base_shear_kN"],
                    })

                push = builder.run_pushover(
                    direction        = direction,
                    pattern_type     = pattern_type,
                    target_drift_pct = target_drift,
                    inc_m            = inc_m,
                    result_path      = part_path,
                    history_path     = hist_path,
                    history_stride   = history_stride,
                    progress_cb      = _progress_cb,
                )
                push["element_lines"] = info["element_lines"]
                push["infill_lines"]  = info.get("infill_lines", [])
                push["stories_z"]     = info["stories_z"]
                push["total_height"]  = info["total_height"]

                print(f"[frame_pushover] Pushover {direction}: {push['status']} "
                      f"| {push['converged_steps']}/{push['total_steps']} pasos "
                      f"| deriva max {push['summary'].get('max_drift_pct', 0):.3f}% "
                      f"| Vb max {push['summary'].get('max_base_shear_kN', 0):.1f} kN")

                # Daño por rótula plástica (F4 — se ejecuta si el módulo está disponible)
                if push.get("history"):
                    try:
                        from app.engine.building.nonlinear.hinge_damage import (
                            compute_hinge_damage_from_history,
                        )
                        damage = compute_hinge_damage_from_history(
                            history_path  = hist_path,
                            element_lines = info["element_lines"],
                            spec          = spec,
                            direction     = direction,
                        )
                        push["damage"] = damage
                        print(f"[frame_pushover] Rótulas críticas {direction}: "
                              f"{damage.get('n_critical', 0)} / "
                              f"{damage.get('n_total', 0)} elementos "
                              f"(DCR máx = {damage.get('max_dcr', 0):.2f})")
                    except ImportError:
                        print("[frame_pushover] (hinge_damage no disponible — se omite daño)")
                    except Exception as e_dmg:
                        print(f"[frame_pushover] WARN damage {direction}: {e_dmg}")

                results_by_dir[direction] = push

            except Exception as e_dir:
                import traceback
                print(f"[frame_pushover] ERROR en dirección {direction}: {e_dir}")
                traceback.print_exc()
                results_by_dir[direction] = {"status": "failed", "message": str(e_dir)}
            finally:
                builder.wipe()

        # ── Resumen final ─────────────────────────────────────────────────────
        summary = {
            d: {
                "status":           r.get("status"),
                "converged_steps":  r.get("converged_steps", 0),
                "total_steps":      r.get("total_steps", 0),
                "pattern_type":     r.get("pattern_type", pattern_type),
                **r.get("summary", {}),
                "n_critical_hinges": r.get("damage", {}).get("n_critical", 0),
                "max_dcr":           r.get("damage", {}).get("max_dcr", 0.0),
            }
            for d, r in results_by_dir.items()
        }

        # Si TODAS las direcciones fallaron → el análisis falló (no "success")
        any_ok = any(
            (r.get("status") in ("success", "partial") and r.get("converged_steps", 0) > 0)
            for r in results_by_dir.values()
        )
        overall_status = "success" if any_ok else "failed"

        result = {
            "status":           overall_status,
            "job_id":           job_id,
            "project_id":       project_id,
            "pattern_type":     pattern_type,
            "target_drift_pct": target_drift,
            "n_integration_pts": n_ip,
            "summary":          summary,
            "pushover_X":       results_by_dir.get("X"),
            "pushover_Y":       results_by_dir.get("Y"),
            "computed_at":      datetime.now(timezone.utc).isoformat(),
        }

        res_path = os.path.join(res_dir, "nl_frame_pushover_results.json")
        with open(res_path, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2)

        db_summary = {
            "directions":   directions,
            "pattern_type": pattern_type,
            "summary": {
                d: {k: v for k, v in s.items() if k in (
                    "status", "max_drift_pct", "max_base_shear_kN",
                    "converged_steps", "total_steps",
                    "n_critical_hinges", "max_dcr",
                )}
                for d, s in summary.items()
            },
        }

        # Refrescar job para evitar conflictos con el progress_cb (puede haber
        # commiteado desde otra sesión en paralelo)
        db.expire_all()
        job = db.get(StructuralJob, job_id)
        if any_ok:
            job.status        = StructuralJobStatus.success
            job.progress_json = {"stage": "done", "pct": 100}
        else:
            job.status        = StructuralJobStatus.failed
            # Mensaje de error con la primera razón concreta encontrada
            msgs = [
                f"Dir {d}: {r.get('message') or r.get('status', 'failed')}"
                for d, r in results_by_dir.items()
            ]
            job.error_message = (
                "El pushover no convergió en ninguna dirección.\n" + "\n".join(msgs)
            )[:4000]
            job.progress_json = {"stage": "done", "pct": 100, "status": "failed"}
        job.result_path    = res_path
        job.result_summary = db_summary
        job.finished_at    = datetime.now(timezone.utc)
        db.commit()
        return result

    except Exception as exc:
        db.rollback()
        try:
            from app.models import StructuralJobStatus
            j = db.get(
                __import__("app.models", fromlist=["StructuralJob"]).StructuralJob,
                job_id,
            )
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


def _ensure_nl_spec(project, work_dir: str) -> None:
    """
    Si el spec no existe, lo genera a partir de design_columns_detail +
    beam_design_detail + canonical. Si tampoco hay diseño, usa defaults
    NSR-10 ρ=1% + estribos mínimos (NLSpecBuilder maneja ambos casos).
    """
    nl_dir = os.path.join(work_dir, "nonlinear")
    os.makedirs(nl_dir, exist_ok=True)
    out_path = os.path.join(nl_dir, "nonlinear_model.json")

    if os.path.exists(out_path):
        return

    from engine.building.nonlinear import NLSpecBuilder

    with open(project.canonical_model_path, encoding="utf-8") as f:
        canonical = json.load(f)

    rd = os.path.join(work_dir, "results")

    def _load(p: str) -> dict:
        try:
            with open(p, encoding="utf-8") as fh:
                return json.load(fh)
        except Exception:
            return {}

    col_detail  = _load(os.path.join(rd, "design_columns_detail.json"))
    beam_detail = _load(os.path.join(rd, "beam_design_detail.json"))
    user_reinf  = _load(os.path.join(rd, "reinforcement.json"))

    params = json.loads(project.parameters_json) if project.parameters_json else {}
    ed = params.get("energy_dissipation", "DMO")

    builder = NLSpecBuilder(
        canonical          = canonical,
        col_detail         = col_detail,
        beam_detail        = beam_detail,
        user_reinforcement = user_reinf,
        energy_dissipation = ed,
        project_id         = str(getattr(project, "id", "")),
    )
    spec = builder.build()
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(spec, f, ensure_ascii=False, indent=2)
    print(f"[frame_pushover] Spec generado automáticamente: {out_path}")
