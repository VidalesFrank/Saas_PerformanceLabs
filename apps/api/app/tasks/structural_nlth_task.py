"""
Celery task — Módulo 1: Análisis cronológico no lineal (NLTHA / Time-History).

Soporta edificios de muros (MVLEM_3D), pórticos (fibras + rótulas) y pórticos
con infills (puntales equivalentes de mampostería). Un edificio mixto
muros+pórticos debe correr dos NLTHA independientes (igual que el pushover),
una por cada sistema.

Requiere:
  - canonical_model.json
  - record_x_path, record_y_path: archivos ACC (una columna por línea) con
    aceleraciones del sismo (unidades configurables: g | mps2 | cm/s2).
  - Para muros: wall_design_results.json + wall_demands.json
  - Para pórticos: nonlinear_model.json (spec)

Produce:
  - nlth_results.json (summary + time-history de techo + envolventes)
  - nlth_history.npz  (historia completa por paso)
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from app.tasks.celery_app import celery_app


def _autodetect_dtrec(clean_path: str) -> float | None:
    """
    Busca `record_{dir}_source.*` junto al `clean_path` y lo pasa por el parser
    para extraer dt del header (PEER .at2 lo trae; FEMA flat no).
    """
    try:
        from pathlib import Path
        p = Path(clean_path)
        stem = p.stem  # "record_x" o "record_y"
        # Busca el "source" en el mismo directorio con cualquier extensión
        for cand in p.parent.glob(f"{stem}_source.*"):
            from app.engine.building.nonlinear.record_parser import parse_record
            info = parse_record(str(cand))
            if info.dt and info.dt > 0:
                return float(info.dt)
    except Exception:
        pass
    return None


def _update_job_progress(job_id: str, progress: dict) -> None:
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


@celery_app.task(name="app.tasks.structural_nlth_task.run_nlth", bind=True)
def run_nlth_task(
    self,
    job_id:          str,
    project_id:      str,
    input_file:      str | None = None,
    parameters_dict: dict | None = None,
    e2k_file:        str | None = None,
    extra_params:    dict | None = None,
):
    """
    Ejecuta NLTHA bidireccional sobre el edificio.

    Parámetros útiles en `parameters_dict`:
      - system           : "walls" | "frames"  (requerido)
      - record_x_path    : ruta absoluta al ACC de la componente X
      - record_y_path    : ruta absoluta al ACC de la componente Y
      - dtrec            : paso del registro en segundos (requerido)
      - dt_analysis      : paso Newmark inicial (default 0.005 s)
      - damping          : fracción de amortiguamiento Rayleigh (default 0.05)
      - scale            : factor de escala multiplicativo (default 1.0)
      - record_units     : "g" | "mps2" | "cm/s2" (default "g")
      - duration         : recorte en segundos (opcional)
    """
    from app.db import SessionLocal
    from app.models import StructuralJob, StructuralJobStatus
    import time as _time

    wall_t0 = _time.perf_counter()
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
        os.makedirs(res_dir, exist_ok=True)

        # ── Parámetros ───────────────────────────────────────────────────────
        params = dict(parameters_dict or {})
        if extra_params:
            params.update(extra_params)

        system        = str(params.get("system", "")).lower()
        record_x_path = str(params.get("record_x_path", ""))
        record_y_path = str(params.get("record_y_path", ""))
        dtrec         = float(params.get("dtrec", 0.0))
        dt_analysis   = float(params.get("dt_analysis", 0.005))
        damping       = float(params.get("damping", 0.05))
        scale         = float(params.get("scale", 1.0))
        record_units  = str(params.get("record_units", "g")).lower()
        duration      = params.get("duration")
        duration      = float(duration) if duration not in (None, "") else None

        if system not in ("walls", "frames"):
            raise ValueError(
                f"system='{system}' no soportado. Usa 'walls' o 'frames'. "
                "Para edificios mixtos corre un NLTHA por sistema."
            )
        if not record_x_path or not os.path.exists(record_x_path):
            raise FileNotFoundError(f"record_x_path no existe: {record_x_path}")
        if not record_y_path or not os.path.exists(record_y_path):
            raise FileNotFoundError(f"record_y_path no existe: {record_y_path}")

        # Autodetección de dt desde el archivo source adyacente al clean si no
        # viene en los parámetros. Busca `record_{dir}_source.*` en el mismo dir.
        if dtrec <= 0:
            dtrec = _autodetect_dtrec(record_x_path) or 0.0
            if dtrec <= 0:
                dtrec = _autodetect_dtrec(record_y_path) or 0.0
            if dtrec <= 0:
                raise ValueError(
                    "dtrec (paso del registro) no se pudo detectar automáticamente. "
                    "Indícalo manualmente — revisa el header del archivo."
                )
            print(f"[nlth] dtrec autodetectado = {dtrec:.5f}s desde header")

        print(f"[nlth] system={system} scale={scale} dtrec={dtrec}s "
              f"damping={damping} units={record_units} duration={duration}")

        hist_path = Path(res_dir) / "nlth_history.npz"
        out_path  = Path(res_dir) / "nlth_results.json"

        # ── Construir builder según sistema ──────────────────────────────────
        if system == "walls":
            payload = _run_wall_nlth(
                project=project, canonical_path=canonical_path, work_dir=work_dir,
                record_x_path=record_x_path, record_y_path=record_y_path,
                dtrec=dtrec, dt_analysis=dt_analysis, damping=damping,
                scale=scale, record_units=record_units, duration=duration,
                hist_path=hist_path, job_id=job_id,
            )
        else:  # frames
            payload = _run_frame_nlth(
                project=project, canonical_path=canonical_path, work_dir=work_dir,
                record_x_path=record_x_path, record_y_path=record_y_path,
                dtrec=dtrec, dt_analysis=dt_analysis, damping=damping,
                scale=scale, record_units=record_units, duration=duration,
                hist_path=hist_path, job_id=job_id,
            )

        wall_time_s = _time.perf_counter() - wall_t0
        t_sim = float(payload["envelope"].get("t_elapsed_s", 0.0)) or 1e-9
        payload["system"]        = system
        payload["project_id"]    = project_id
        payload["computed_at"]   = datetime.now(timezone.utc).isoformat()
        payload["record_x_file"] = os.path.basename(record_x_path)
        payload["record_y_file"] = os.path.basename(record_y_path)
        payload["runtime"] = {
            "wall_time_s":     round(wall_time_s, 2),
            "wall_time_min":   round(wall_time_s / 60.0, 2),
            "t_simulated_s":   float(payload["envelope"].get("t_elapsed_s", 0.0)),
            "speed_ratio":     round(wall_time_s / t_sim, 2),  # seg wall por seg simulado
        }

        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)

        print(f"[nlth] ✓ {payload['status']} | "
              f"deriva máx = {payload['envelope']['max_drift_pct']:.3f}% | "
              f"d techo máx = {payload['envelope']['max_roof_disp_total_m']*1000:.1f} mm | "
              f"wall = {wall_time_s/60.0:.1f} min")

        job.result_path = str(out_path)
        job.result_summary = {
            "status":         payload["status"],
            "max_drift_pct":  payload["envelope"]["max_drift_pct"],
            "max_roof_m":     payload["envelope"]["max_roof_disp_total_m"],
            "t_elapsed_s":    payload["envelope"]["t_elapsed_s"],
            "t_target_s":     payload["envelope"]["t_target_s"],
            "wall_time_min":  round(wall_time_s / 60.0, 2),
        }
        job.status = (
            StructuralJobStatus.success if payload["status"] == "success"
            else StructuralJobStatus.failed
        )
        job.finished_at = datetime.now(timezone.utc)
        job.progress_json = {"stage": "done", "pct": 100}
        db.commit()

        return {"ok": True, "path": str(out_path)}

    except Exception as e:
        import traceback
        traceback.print_exc()
        try:
            job.status = StructuralJobStatus.failed
            job.error_message = str(e)
            job.finished_at = datetime.now(timezone.utc)
            job.progress_json = {"stage": "failed", "message": str(e)}
            db.commit()
        except Exception:
            pass
        return {"error": str(e)}

    finally:
        db.close()


def _run_wall_nlth(
    *, project, canonical_path, work_dir,
    record_x_path, record_y_path,
    dtrec, dt_analysis, damping, scale, record_units, duration,
    hist_path, job_id,
) -> dict:
    """NLTHA para edificios de muros (MVLEM_3D)."""
    res_dir      = os.path.join(work_dir, "results")
    design_path  = os.path.join(res_dir, "wall_design_results.json")
    demands_path = os.path.join(res_dir, "wall_demands.json")

    if not os.path.exists(design_path):
        raise FileNotFoundError("wall_design_results.json faltante — corre diseño de muros antes.")
    if not os.path.exists(demands_path):
        raise FileNotFoundError("wall_demands.json faltante — corre demandas de muros antes.")

    with open(canonical_path, encoding="utf-8") as f:
        model = json.load(f)
    with open(design_path, encoding="utf-8") as f:
        design_data = json.load(f)
    with open(demands_path, encoding="utf-8") as f:
        demands_data = json.load(f)

    design_rows = design_data.get("designs", [])
    fc_mpa      = float(design_data.get("fc_mpa",  21.0))
    fy_mpa      = float(design_data.get("fy_mpa", 420.0))

    # Pu gravitacional por pier (misma lógica que el pushover)
    pier_pu: dict[tuple, float] = {}
    for row in demands_data.get("pier_demands", []):
        label = row.get("combo", "G")
        if "E" in label.upper():
            continue
        key = (row["pier"], row["story"])
        Pu  = abs(float(row.get("Pu_kN", 0.0)))
        if Pu > pier_pu.get(key, 0.0):
            pier_pu[key] = Pu

    # raw_data desde XLSX o shim
    xlsx_path = project.input_file_path
    if not xlsx_path or not os.path.exists(xlsx_path):
        xlsx_path = os.path.join(work_dir, "input", "input_model.xlsx")
    if os.path.exists(xlsx_path):
        from app.tasks.structural_wall_demands_task import _load_wall_raw_data
        raw_data = _load_wall_raw_data(xlsx_path)
    else:
        from app.tasks.wall_demands_canonical_shim import raw_data_from_canonical
        raw_data = raw_data_from_canonical(model)

    from app.engine.building.nonlinear.nl_wall_ops_builder import NLWallOPSBuilder

    builder = NLWallOPSBuilder(
        model       = model,
        raw_data    = raw_data,
        design_rows = design_rows,
        fc_mpa      = fc_mpa,
        fy_mpa      = fy_mpa,
    )
    _update_job_progress(job_id, {"stage": "build", "system": "walls"})
    info = builder.build()
    print(f"[nlth] wall builder: {len(info['pier_elements'])} elementos MVLEM_3D")

    _update_job_progress(job_id, {"stage": "gravity", "system": "walls"})
    grav = builder.run_gravity(pier_pu, steps=10)
    print(f"[nlth] gravedad muros: {grav['status']}")

    def _cb(data: dict) -> None:
        _update_job_progress(job_id, {
            "stage": "dynamic", "system": "walls",
            "step": data["step"], "total": data["total"],
            "t": data["t"], "pct": data["pct"],
        })

    _update_job_progress(job_id, {"stage": "dynamic", "system": "walls", "pct": 0})
    return builder.run_dynamic(
        record_x_path = record_x_path,
        record_y_path = record_y_path,
        dtrec         = dtrec,
        dt_analysis   = dt_analysis,
        damping       = damping,
        scale         = scale,
        record_units  = record_units,
        duration      = duration,
        history_path  = hist_path,
        progress_cb   = _cb,
    )


def _run_frame_nlth(
    *, project, canonical_path, work_dir,
    record_x_path, record_y_path,
    dtrec, dt_analysis, damping, scale, record_units, duration,
    hist_path, job_id,
) -> dict:
    """NLTHA para edificios de pórticos (fibras + rótulas + infills)."""
    nl_spec_path = os.path.join(work_dir, "nonlinear", "nonlinear_model.json")
    if not os.path.exists(nl_spec_path):
        raise FileNotFoundError(
            "nonlinear_model.json faltante. Genera el spec no lineal primero."
        )
    with open(canonical_path, encoding="utf-8") as f:
        canonical = json.load(f)
    with open(nl_spec_path, encoding="utf-8") as f:
        spec = json.load(f)

    from app.engine.building.nonlinear.nl_frame_ops_builder import NLFrameOPSBuilder

    builder = NLFrameOPSBuilder(canonical=canonical, spec=spec)
    _update_job_progress(job_id, {"stage": "build", "system": "frames"})
    info = builder.build()
    print(f"[nlth] frame builder: {info['n_columns']} cols, {info['n_beams']} vigas, "
          f"{info['n_infills']} infills")

    _update_job_progress(job_id, {"stage": "gravity", "system": "frames"})
    grav = builder.run_gravity(steps=10)
    print(f"[nlth] gravedad pórticos: {grav['status']}")

    def _cb(data: dict) -> None:
        _update_job_progress(job_id, {
            "stage": "dynamic", "system": "frames",
            "step": data["step"], "total": data["total"],
            "t": data["t"], "pct": data["pct"],
        })

    _update_job_progress(job_id, {"stage": "dynamic", "system": "frames", "pct": 0})
    payload = builder.run_dynamic(
        record_x_path = record_x_path,
        record_y_path = record_y_path,
        dtrec         = dtrec,
        dt_analysis   = dt_analysis,
        damping       = damping,
        scale         = scale,
        record_units  = record_units,
        duration      = duration,
        history_path  = hist_path,
        progress_cb   = _cb,
    )

    # Daño por rótula plástica (ASCE 41) — ejecuta sobre el NPZ ya persistido
    try:
        from app.engine.building.nonlinear.hinge_damage import (
            compute_hinge_damage_from_history,
        )
        damage = compute_hinge_damage_from_history(
            history_path  = hist_path,
            element_lines = info["element_lines"],
            spec          = spec,
            direction     = "nlth",
        )
        payload["damage"] = damage
        payload["element_lines"] = info["element_lines"]
        print(f"[nlth] Rótulas críticas: "
              f"{damage.get('n_critical', 0)} / "
              f"{damage.get('n_total', 0)} elementos "
              f"(DCR máx = {damage.get('max_dcr', 0):.2f})")
    except Exception as e_dmg:
        print(f"[nlth] WARN hinge_damage: {e_dmg}")
        payload["damage"] = {"status": "failed", "message": str(e_dmg)}

    # Eventos locales: aplastamiento, pandeo, fluencia, fractura (Bloque B)
    try:
        from app.engine.building.nonlinear.event_detector import (
            detect_events_nlth,
        )
        ev = detect_events_nlth(
            npz_path      = str(hist_path),
            spec          = spec,
            element_lines = info["element_lines"],
        )
        payload["events"] = ev
        if ev.get("status") == "success":
            s = ev["summary"]
            print(f"[nlth] Eventos: fluencia={s['first_yield_bar']}, "
                  f"cover_crush={s['cover_crush']}, core_crush={s['core_crush']}, "
                  f"pandeo={s['bar_buckling']}, fractura={s['bar_fracture']}")
        else:
            print(f"[nlth] Eventos: {ev.get('status')}")
    except Exception as e_ev:
        print(f"[nlth] WARN events: {e_ev}")
        payload["events"] = {"status": "failed", "message": str(e_ev)}

    # Daño de infills — mismo cálculo que pushover (requiere infill_elong en NPZ)
    if info.get("infill_lines"):
        try:
            from app.engine.building.nonlinear.infill_damage import (
                compute_infill_damage_from_history,
            )
            infill_dmg = compute_infill_damage_from_history(
                history_path = hist_path,
                infill_lines = info["infill_lines"],
            )
            payload["infill_damage"] = infill_dmg
            payload["infill_lines"]  = info["infill_lines"]
            if infill_dmg.get("status") == "success":
                print(f"[nlth] Infills: {infill_dmg.get('n_collapsed', 0)} colapsados, "
                      f"{infill_dmg.get('n_degrading', 0)} degradando / "
                      f"{infill_dmg.get('n_total', 0)} paneles "
                      f"(dañomax = {infill_dmg.get('max_damage', 0):.2f})")
            else:
                print(f"[nlth] Infill damage: {infill_dmg.get('status')}")
        except Exception as e_inf:
            print(f"[nlth] WARN infill_damage: {e_inf}")
            payload["infill_damage"] = {"status": "failed", "message": str(e_inf)}

    return payload
