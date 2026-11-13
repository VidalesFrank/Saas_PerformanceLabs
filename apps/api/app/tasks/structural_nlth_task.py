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


def _enrich_health(health: dict, element_lines: list[dict]) -> None:
    """
    Añade fid/kind/story a `pathological_element` y `pathological_ranking`
    del motor (que sólo conoce ele_tag). Mutación in-place.
    """
    if not health or not element_lines:
        return
    tag_to_info = {
        int(el["ele_tag"]): {
            "fid":   str(el["fid"]),
            "kind":  str(el.get("kind", "?")),
            "story": str(el.get("story", "")),
            "b_m":   float(el.get("b_m", 0.0)),
            "h_m":   float(el.get("h_m", 0.0)),
        }
        for el in element_lines
    }
    def _enrich_one(d: dict) -> dict:
        tag = int(d.get("ele_tag", 0))
        info = tag_to_info.get(tag)
        if info:
            d.update(info)
        return d
    if health.get("pathological_element"):
        _enrich_one(health["pathological_element"])
    for d in health.get("pathological_ranking", []) or []:
        _enrich_one(d)


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


def _extract_ida_summary(payload: dict) -> dict:
    """Extrae métricas pico para IDA desde un payload NLTH completo.

    Incluye perfiles por piso (deriva, aceleración absoluta, desplazamiento) +
    deriva residual + conteo de rótulas plásticas por piso. Permite al UI
    pintar la "radiografía post-sismo" del edificio sin necesidad de guardar
    el NPZ completo. Tamaño típico por archivo: 3-8 KB para un edificio de 10
    pisos (vs ~50 MB del NPZ).

    Diseñado para producir archivos lo suficientemente grandes para ser
    informativos, pero chicos para que 22 pares × 10 niveles = 220 análisis
    quepan en ~1 MB consolidado.
    """
    env = payload.get("envelope") or {}
    health = payload.get("health") or {}
    hinges = ((payload.get("damage") or {}).get("hinges") or [])
    stories_z = [float(z) for z in (payload.get("stories_z") or [])]

    # Rótulas: recorremos UNA sola vez para calcular globales + conteo por piso.
    theta_col_max = 0.0
    theta_beam_max = 0.0
    n_critical_cols = 0
    n_critical_beams = 0
    worst_fid = None
    worst_theta = 0.0
    # hinges_by_story: { "<story_label>": {io, ls, cp, collapse, total,
    #                                      theta_max_col, theta_max_beam} }
    hinges_by_story: dict[str, dict] = {}
    for h in hinges:
        kind = str(h.get("kind", ""))
        tp = float(h.get("theta_p_max", 0.0) or 0.0)
        lvl = str(h.get("damage_level", "")).lower()
        story = str(h.get("story", "") or "—")

        if kind == "column":
            if tp > theta_col_max:
                theta_col_max = tp
            if lvl in ("cp", "collapse"):
                n_critical_cols += 1
        elif kind == "beam":
            if tp > theta_beam_max:
                theta_beam_max = tp
            if lvl in ("cp", "collapse"):
                n_critical_beams += 1
        if tp > worst_theta:
            worst_theta = tp
            worst_fid = str(h.get("fid", ""))

        row = hinges_by_story.setdefault(story, {
            "io": 0, "ls": 0, "cp": 0, "collapse": 0, "total": 0,
            "theta_max_col": 0.0, "theta_max_beam": 0.0,
        })
        row["total"] += 1
        if lvl == "io":       row["io"] += 1
        elif lvl == "ls":     row["ls"] += 1
        elif lvl == "cp":     row["cp"] += 1
        elif lvl == "collapse": row["collapse"] += 1
        if kind == "column" and tp > row["theta_max_col"]:
            row["theta_max_col"] = tp
        elif kind == "beam" and tp > row["theta_max_beam"]:
            row["theta_max_beam"] = tp

    # Flag de colapso: motor abortó por vb_near_zero o deriva > 10% (práctica IDA)
    collapsed = (
        bool(health.get("aborted") and health.get("abort_reason") == "vb_near_zero")
        or float(env.get("max_drift_pct", 0.0) or 0.0) >= 10.0
    )

    # Piso crítico = el que tuvo mayor deriva pico (máx X,Y por entrepiso).
    # Permite al UI responder "¿dónde se concentró el daño?" sin re-calcular.
    drift_x = env.get("max_drift_by_story_x") or []
    drift_y = env.get("max_drift_by_story_y") or []
    critical_story_idx = -1
    critical_story_drift = 0.0
    n_stories_profile = max(len(drift_x), len(drift_y))
    for i in range(n_stories_profile):
        dx = float(drift_x[i]) if i < len(drift_x) else 0.0
        dy = float(drift_y[i]) if i < len(drift_y) else 0.0
        d = max(dx, dy)
        if d > critical_story_drift:
            critical_story_drift = d
            critical_story_idx = i

    return {
        "status":              payload.get("status", "unknown"),
        "max_drift_pct":       float(env.get("max_drift_pct", 0.0) or 0.0),
        "max_roof_m":          float(env.get("max_roof_disp_total_m", 0.0) or 0.0),
        "Vb_peak_kN":          float(env.get("Vb_peak_kN", 0.0) or 0.0),
        "max_Vb_x_kN":         float(env.get("max_Vb_x_kN", 0.0) or 0.0),
        "max_Vb_y_kN":         float(env.get("max_Vb_y_kN", 0.0) or 0.0),
        "theta_col_max":       theta_col_max,
        "theta_beam_max":      theta_beam_max,
        "n_critical_columns":  n_critical_cols,
        "n_critical_beams":    n_critical_beams,
        "n_hinges_total":      len(hinges),
        "worst_fid":           worst_fid,
        "worst_theta_p":       worst_theta,
        "t_elapsed_s":         float(env.get("t_elapsed_s", 0.0) or 0.0),
        "t_target_s":          float(env.get("t_target_s", 0.0) or 0.0),
        "aborted":             bool(health.get("aborted")),
        "abort_reason":        health.get("abort_reason"),
        "vb_loss_pct":         health.get("vb_loss_pct"),
        "collapsed":           collapsed,
        "pathological_fid":    (health.get("pathological_element") or {}).get("fid"),
        # ── Perfiles por piso (Ola A: radiografía post-sismo) ───────────────
        "stories_z":                      stories_z,
        "max_drift_by_story_x_pct":       list(drift_x),
        "max_drift_by_story_y_pct":       list(drift_y),
        "max_abs_accel_by_story_x_mps2":  list(env.get("max_abs_accel_by_story_x_mps2") or []),
        "max_abs_accel_by_story_y_mps2":  list(env.get("max_abs_accel_by_story_y_mps2") or []),
        "accel_amp_by_story_x":           list(env.get("accel_amplification_by_story_x") or []),
        "accel_amp_by_story_y":           list(env.get("accel_amplification_by_story_y") or []),
        "max_disp_by_story_x_m":          list(env.get("max_disp_by_story_x_m") or []),
        "max_disp_by_story_y_m":          list(env.get("max_disp_by_story_y_m") or []),
        "pga_x_g":                        float(env.get("pga_x_g", 0.0) or 0.0),
        "pga_y_g":                        float(env.get("pga_y_g", 0.0) or 0.0),
        "pga_vector_g":                   float(env.get("pga_vector_g", 0.0) or 0.0),
        # Residuales (métrica clave post-sismo FEMA P-58)
        "residual_drift_pct":             float(env.get("residual_drift_pct", 0.0) or 0.0),
        "residual_drift_x_pct":           float(env.get("residual_drift_x_pct", 0.0) or 0.0),
        "residual_drift_y_pct":           float(env.get("residual_drift_y_pct", 0.0) or 0.0),
        "residual_drift_by_story_x_pct":  list(env.get("residual_drift_by_story_x_pct") or []),
        "residual_drift_by_story_y_pct":  list(env.get("residual_drift_by_story_y_pct") or []),
        # Piso crítico
        "critical_story_idx":             critical_story_idx,
        "critical_story_drift_pct":       round(critical_story_drift, 4),
        # Distribución de rótulas por piso (dict ordenado por label)
        "hinges_by_story":                hinges_by_story,
    }


@celery_app.task(
    name="app.tasks.structural_nlth_task.run_nlth",
    bind=True,
    # Límites duros para que una NLTH jamás cuelgue un worker.
    # time_limit mata el proceso con SIGKILL; soft_time_limit da chance de
    # guardar partial state si queremos atrapar la excepción.
    time_limit=3600,        # 1 h hard
    soft_time_limit=3300,   # 55 min soft (deja 5 min para cerrar / persistir)
)
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
        collapse_mode = str(params.get("collapse_mode", "ductile")).lower()

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

        # Cross-check dtrec vs duración del archivo: evita que un dtrec
        # equivocado estire el record a minutos simulados y meta al motor en
        # estados inestables (bug descubierto 2026-11-04 con Prueba 4 y dtrec=0.05
        # sobre un archivo de 3000 líneas → 150 s simulados).
        def _count_lines(path: str) -> int:
            n = 0
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    if line.strip():
                        n += 1
            return n

        n_x = _count_lines(record_x_path)
        n_y = _count_lines(record_y_path)
        dur_x = n_x * dtrec
        dur_y = n_y * dtrec
        # Rangos razonables de dtrec para registros sísmicos:
        #   PEER NGA .at2 → 0.005 s
        #   USGS strong-motion → 0.01 - 0.02 s
        #   Registros antiguos filtrados → 0.025 s máximo
        # dtrec >= 0.05 s casi siempre es error del usuario (equivocación
        # típica: pensar que el record viene en Hz=20 o decimado).
        DTREC_MAX = 0.05
        # 5 min simulados — soporta registros de subducción largos (ej. Perú,
        # Chile, Tohoku, mega-trust events) que exceden los 2 min típicos de
        # registros corticales. Ajustado 2026-11-06 a petición de Frank.
        DUR_MAX   = 300.0
        DUR_MIN   = 2.0      # <2 s no es sismo
        if dtrec >= DTREC_MAX:
            raise ValueError(
                f"dtrec={dtrec}s es inusualmente alto para un registro sísmico. "
                f"Valores típicos: 0.005 s (PEER NGA), 0.01-0.02 s (USGS). "
                f"Verifica el verdadero paso de tu archivo (header del .at2 o "
                f"metadatos de la fuente)."
            )
        if dur_x > DUR_MAX or dur_y > DUR_MAX:
            raise ValueError(
                f"dtrec={dtrec}s × {max(n_x, n_y)} líneas = {max(dur_x, dur_y):.1f}s "
                f"simulados excede el límite razonable ({DUR_MAX}s). "
                f"Verifica que dtrec corresponda al verdadero paso del archivo. "
                f"Un dtrec más grande que el real estira el registro y genera "
                f"inestabilidades numéricas en el solver."
            )
        if dur_x < DUR_MIN or dur_y < DUR_MIN:
            raise ValueError(
                f"dtrec={dtrec}s × {min(n_x, n_y)} líneas = {min(dur_x, dur_y):.2f}s "
                f"simulados es demasiado corto. Verifica dtrec — si el archivo "
                f"tiene miles de líneas probablemente dtrec sea 0.005 u 0.01s."
            )

        print(f"[nlth] system={system} scale={scale} dtrec={dtrec}s "
              f"damping={damping} units={record_units} duration={duration} "
              f"(archivo: {n_x} líneas → {dur_x:.1f}s X, {n_y} líneas → {dur_y:.1f}s Y)")

        # Persistimos cada NLTH en su propia carpeta per-job para construir
        # historial (el usuario puede correr varios análisis sobre el mismo
        # modelo y comparar). Además mantenemos un shim en `results/` para
        # compatibilidad con verificador, export XLSX y diagnóstico por
        # elemento, que todavía leen "el último".
        job_dir   = Path(work_dir) / "nlth" / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        hist_path = job_dir / "nlth_history.npz"
        out_path  = job_dir / "nlth_results.json"
        meta_path = job_dir / "meta.json"

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
                collapse_mode=collapse_mode,
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

        # Meta liviano para listar el historial sin leer el JSON pesado.
        meta = {
            "job_id":        job_id,
            "project_id":    project_id,
            "system":        system,
            "record_x_file": os.path.basename(record_x_path),
            "record_y_file": os.path.basename(record_y_path),
            "scale":         scale,
            "dtrec":         dtrec,
            "dt_analysis":   dt_analysis,
            "damping":       damping,
            "record_units":  record_units,
            "duration":      duration,
            "collapse_mode": collapse_mode,
            "status":        payload["status"],
            "max_drift_pct": payload["envelope"]["max_drift_pct"],
            "max_roof_m":    payload["envelope"]["max_roof_disp_total_m"],
            "pga_x_g":       payload["envelope"].get("pga_x_g", 0.0),
            "pga_y_g":       payload["envelope"].get("pga_y_g", 0.0),
            "Vb_peak_kN":    max(
                payload["envelope"].get("max_Vb_x_kN", 0.0) or 0.0,
                payload["envelope"].get("max_Vb_y_kN", 0.0) or 0.0,
            ),
            "residual_drift_pct": payload["envelope"].get("residual_drift_pct", 0.0),
            "t_elapsed_s":   payload["envelope"]["t_elapsed_s"],
            "t_target_s":    payload["envelope"]["t_target_s"],
            "wall_time_min": round(wall_time_s / 60.0, 2),
            "aborted":       bool((payload.get("health") or {}).get("aborted")),
            "abort_reason":  (payload.get("health") or {}).get("abort_reason"),
            "computed_at":   datetime.now(timezone.utc).isoformat(),
        }
        meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

        # Shim backward-compat: copia al "último" en results/ para que el
        # verificador, export XLSX, performance verifier y diagnóstico por
        # elemento sigan funcionando sin cambios.
        try:
            shim_results = Path(res_dir) / "nlth_results.json"
            shim_history = Path(res_dir) / "nlth_history.npz"
            shim_results.write_bytes(out_path.read_bytes())
            if hist_path.exists():
                shim_history.write_bytes(hist_path.read_bytes())
        except Exception as e_shim:
            print(f"[nlth] warning: shim copy failed: {e_shim}")

        print(f"[nlth] ✓ {payload['status']} | "
              f"deriva máx = {payload['envelope']['max_drift_pct']:.3f}% | "
              f"d techo máx = {payload['envelope']['max_roof_disp_total_m']*1000:.1f} mm | "
              f"wall = {wall_time_s/60.0:.1f} min | "
              f"job_dir = {job_dir}")

        job.result_path = str(out_path)
        job.result_summary = {
            "status":         payload["status"],
            "max_drift_pct":  payload["envelope"]["max_drift_pct"],
            "max_roof_m":     payload["envelope"]["max_roof_disp_total_m"],
            "t_elapsed_s":    payload["envelope"]["t_elapsed_s"],
            "t_target_s":     payload["envelope"]["t_target_s"],
            "wall_time_min":  round(wall_time_s / 60.0, 2),
        }
        # `partial` cuenta como SUCCESS en la DB — el motor nos devolvió un
        # resultado útil (deriva, daño, histéresis) y marcó `health.aborted`
        # con el motivo. El panel UI muestra `AnalysisHealthBanner` para
        # advertir al usuario; no tiene sentido marcarlo "failed" porque no
        # hubo fallo técnico sino un corte limpio al detectar colapso del
        # edificio (vb_near_zero / slow_progress / stall / step_fail).
        job.status = (
            StructuralJobStatus.success
            if payload["status"] in ("success", "partial")
            else StructuralJobStatus.failed
        )
        job.finished_at = datetime.now(timezone.utc)
        job.progress_json = {"stage": "done", "pct": 100}
        db.commit()

        return {"ok": True, "path": str(out_path)}

    except Exception as e:
        # SoftTimeLimitExceeded: viene de Celery cuando la task pasa los 55 min
        # (ver soft_time_limit arriba). Lo tratamos como timeout limpio.
        from celery.exceptions import SoftTimeLimitExceeded
        is_timeout = isinstance(e, SoftTimeLimitExceeded)

        import traceback
        if not is_timeout:
            traceback.print_exc()
        try:
            job.status = StructuralJobStatus.failed
            if is_timeout:
                job.error_message = (
                    "El análisis cronológico excedió el tiempo máximo (55 min). "
                    "Verifica el modelo (elementos patológicos / dtrec correcto) "
                    "o reduce la duración del registro."
                )
                job.progress_json = {"stage": "timeout", "message": job.error_message}
            else:
                job.error_message = str(e)
                job.progress_json = {"stage": "failed", "message": str(e)}
            job.finished_at = datetime.now(timezone.utc)
            db.commit()
        except Exception:
            pass
        return {"error": job.error_message if 'job' in locals() and job else str(e)}

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
    # Muros: builder expone `pier_elements` para enriquecer health con pier_id
    try:
        pier_lines = [
            {"ele_tag": int(info["tag"]), "fid": f"{pier}:{story}",
             "kind": "wall", "story": str(story)}
            for pier, story, info in builder.iter_pier_elements()
        ] if hasattr(builder, "iter_pier_elements") else []
        _enrich_health(payload.get("health", {}), pier_lines)
    except Exception:
        pass
    return payload


def _run_frame_nlth(
    *, project, canonical_path, work_dir,
    record_x_path, record_y_path,
    dtrec, dt_analysis, damping, scale, record_units, duration,
    hist_path, job_id,
    collapse_mode: str = "ductile",
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

    print(f"[nlth] collapse_mode = {collapse_mode}")
    builder = NLFrameOPSBuilder(canonical=canonical, spec=spec, collapse_mode=collapse_mode)
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

    # Enriquecer el bloque `health` (Ola 2) con fid/kind/story humanos. El
    # motor sólo conoce tags; aquí tenemos element_lines para traducir.
    _enrich_health(payload.get("health", {}), info["element_lines"])

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

    # Daño de infills — dos criterios independientes:
    #   1. Elongación del puntal (modelo RCF-AD, requiere infill_elong en NPZ)
    #   2. Deriva de entrepiso (FEMA 356 C7-1 / HAZUS, criterio no estructural)
    if info.get("infill_lines"):
        payload["infill_lines"] = info["infill_lines"]
        try:
            from app.engine.building.nonlinear.infill_damage import (
                compute_infill_damage_from_history,
            )
            infill_dmg = compute_infill_damage_from_history(
                history_path = hist_path,
                infill_lines = info["infill_lines"],
            )
            payload["infill_damage"] = infill_dmg
            if infill_dmg.get("status") == "success":
                print(f"[nlth] Infills (elong): {infill_dmg.get('n_collapsed', 0)} colapsados, "
                      f"{infill_dmg.get('n_degrading', 0)} degradando / "
                      f"{infill_dmg.get('n_total', 0)} paneles "
                      f"(dañomax = {infill_dmg.get('max_damage', 0):.2f})")
            else:
                print(f"[nlth] Infill damage (elong): {infill_dmg.get('status')}")
        except Exception as e_inf:
            print(f"[nlth] WARN infill_damage (elong): {e_inf}")
            payload["infill_damage"] = {"status": "failed", "message": str(e_inf)}

        # Daño por deriva de entrepiso — criterio NSR-10 A.9 / FEMA 356
        try:
            import numpy as _np
            from app.engine.building.nonlinear.infill_damage_drift import (
                compute_infill_damage_by_drift,
            )
            with _np.load(hist_path, allow_pickle=False) as _data:
                _drift_x = _np.asarray(_data["drift_x"], dtype=_np.float32) if "drift_x" in _data.files else _np.zeros((0, 0), _np.float32)
                _drift_y = _np.asarray(_data["drift_y"], dtype=_np.float32) if "drift_y" in _data.files else _np.zeros((0, 0), _np.float32)
            infill_dmg_drift = compute_infill_damage_by_drift(
                infill_lines = info["infill_lines"],
                drift_x      = _drift_x,
                drift_y      = _drift_y,
                stories_z    = payload.get("stories_z", []) or [],
            )
            payload["infill_damage_by_drift"] = infill_dmg_drift
            if infill_dmg_drift.get("status") == "success":
                print(f"[nlth] Infills (deriva): {infill_dmg_drift.get('n_collapsed', 0)} colapsados, "
                      f"{infill_dmg_drift.get('n_degrading', 0)} degradando / "
                      f"{infill_dmg_drift.get('n_total', 0)} paneles "
                      f"(deriva máx = {infill_dmg_drift.get('max_drift_pct', 0):.2f}%)")
            else:
                print(f"[nlth] Infill damage (deriva): {infill_dmg_drift.get('status')}")
        except Exception as e_dr:
            print(f"[nlth] WARN infill_damage_by_drift: {e_dr}")
            payload["infill_damage_by_drift"] = {"status": "failed", "message": str(e_dr)}

    return payload
