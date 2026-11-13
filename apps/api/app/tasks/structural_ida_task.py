"""
Celery tasks — IDA (Incremental Dynamic Analysis) sobre biblioteca FEMA P-695.

Flujo:
    run_ida_pair_level(...)   — un NLTHA liviano para UNA combinación (par, nivel)
    run_ida(...)              — orquestador: encola group(tasks) + consolida

Modo "summary-only": a diferencia de run_nlth, estas tasks NO persisten
nlth_history.npz ni los posprocesos pesados (events, infills). Solo extraen
métricas pico (max_drift_pct, θ_p_max por elemento, Vb_peak, flag colapso) y
las escriben en un JSON de 1-5 KB por combinación. Diseñado para que
N_pares × N_niveles = ~200 análisis no explote storage ni memoria.

El escalado a Sa objetivo reutiliza fema_catalog.compute_scale_for_pair().
Cada análisis apunta a los archivos de /app/fema_library/ directamente —
no se copian al workspace del proyecto.

Carpetas de resultados:
    workspace/ida/<ida_job_id>/
        meta.json                    — grid Sa + pairs + status
        results/
            pair_<pid>_level_<i>.json  — summary por combinación
        ida_results.json             — consolidado (percentiles, curvas)
"""
from __future__ import annotations

import gc
import json
import os
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.tasks.celery_app import celery_app
from app.tasks.structural_nlth_task import _extract_ida_summary, _enrich_health


def _job_dir(work_dir: str, ida_job_id: str) -> Path:
    """Carpeta IDA del proyecto."""
    return Path(work_dir) / "ida" / ida_job_id


def _results_subdir(work_dir: str, ida_job_id: str) -> Path:
    p = _job_dir(work_dir, ida_job_id) / "results"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _trigger_consolidate_if_last(
    *, work_dir: str, ida_job_id: str, project_id: str,
) -> None:
    """Si todos los pair_X_level_Y.json ya existen, dispara el consolidador.

    Reemplaza la dependencia del chord callback de Celery. Lee el meta.json
    del job para saber cuántos análisis se esperan, cuenta los archivos
    presentes y, si llegamos a `total`, encola `consolidate_ida_task`.

    Idempotente: si varias hijas detectan "soy la última" por una race
    condition, el consolidador simplemente sobrescribe `ida_results.json`
    con el mismo contenido. La DB termina `success` igual.
    """
    job_dir   = _job_dir(work_dir, ida_job_id)
    meta_path = job_dir / "meta.json"
    if not meta_path.exists():
        return
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    pair_ids:  list[int]   = [int(p) for p in meta.get("pair_ids", [])]
    sa_levels: list[float] = [float(s) for s in meta.get("sa_levels", [])]
    expected = len(pair_ids) * len(sa_levels)

    results_dir = job_dir / "results"
    if not results_dir.exists():
        return
    done = sum(1 for p in results_dir.glob("pair_*_level_*.json"))
    if done < expected:
        return

    # Guard anti-doble-ejecución: creamos un marker file atómico. Si otra hija
    # ya lo creó, salimos. Si no existía, lo creamos y disparamos. Pathlib no
    # tiene O_EXCL puro, usamos write_text con un touch previo.
    marker = job_dir / ".consolidate_dispatched"
    try:
        # `open(..., "x")` falla si el archivo ya existe → el primero gana.
        with open(marker, "x", encoding="utf-8") as f:
            f.write(datetime.now(timezone.utc).isoformat())
    except FileExistsError:
        return

    # Sacar job_id (== ida_job_id en la arquitectura actual) para que el
    # consolidador pueda marcar el StructuralJob como success.
    consolidate_ida_task.delay(
        child_results=None,
        job_id=ida_job_id,
        project_id=project_id,
        ida_job_id=ida_job_id,
        pair_ids=pair_ids,
        sa_levels=sa_levels,
        meta=meta,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Task hijo: UN análisis (par + nivel)
# ─────────────────────────────────────────────────────────────────────────────
@celery_app.task(
    name="app.tasks.structural_ida_task.run_ida_pair_level",
    bind=True,
    time_limit=1800,        # 30 min hard (análisis liviano, sin history)
    soft_time_limit=1650,   # 27.5 min soft
)
def run_ida_pair_level_task(
    self,
    project_id:    str,
    ida_job_id:    str,
    pair_id:       int,
    level_index:   int,
    sa_target_g:   float,
    T1_s:          float,
    system:        str = "frames",
    damping:       float = 0.05,
    dt_analysis:   float = 0.005,
    xi:            float = 0.05,
    collapse_mode: str   = "ductile",
    catalog_source: str  = "fema",
) -> dict:
    """Corre UN NLTHA liviano para un (pair, Sa_target) y persiste summary.

    `catalog_source` selecciona la biblioteca de registros:
      - ``"fema"`` (default): catálogo FEMA P-695 Far-Field (22 pares).
      - ``"colombia_2026_08_10"`` (u otra campaña local): catálogo persistido
        en DB con registros .AT2 formato CEER.
    """
    from app.db import SessionLocal
    from app.models import StructuralProject

    out_file = None
    hist_tmp = None

    db = SessionLocal()
    try:
        project = db.get(StructuralProject, project_id)
        if not project or not project.canonical_model_path:
            return {"error": "project or canonical not found", "pair_id": pair_id, "level_index": level_index}

        work_dir = os.path.dirname(os.path.dirname(project.canonical_model_path))
        results_dir = _results_subdir(work_dir, ida_job_id)
        out_file = results_dir / f"pair_{pair_id}_level_{level_index}.json"

        # ── Resolver rutas + factor de escala según catálogo ────────────────
        if catalog_source == "fema":
            from app.engine.building.fema_catalog import (
                FEMA_PAIRS, compute_scale_for_pair, get_record_path, get_record_dt,
            )
            pair = next((p for p in FEMA_PAIRS if p["pair"] == pair_id), None)
            if pair is None:
                raise ValueError(f"pair_id={pair_id} no está en el catálogo FEMA.")
            gm_h1, gm_h2 = pair["files"]
            record_x_path = get_record_path(gm_h1)
            record_y_path = get_record_path(gm_h2)
            dtrec_x = get_record_dt(gm_h1)
            dtrec_y = get_record_dt(gm_h2)
            scale_info = compute_scale_for_pair(
                pair_id=pair_id, T1_s=T1_s, sa_target_g=sa_target_g, xi=xi,
            )
        else:
            # Catálogo local (campañas colombianas u otras)
            from app.engine.building import colombia_catalog as local_cat
            cat = local_cat.get_catalog(db, campaign=catalog_source)
            pair = next((p for p in cat["pairs"] if p["pair"] == pair_id), None)
            if pair is None:
                raise ValueError(
                    f"pair_id={pair_id} no está en catálogo {catalog_source!r}."
                )
            gm_h1, gm_h2 = pair["files"]
            record_x_path = local_cat.get_record_path(gm_h1, db)
            record_y_path = local_cat.get_record_path(gm_h2, db)
            dtrec_x = local_cat.get_record_dt(gm_h1, db)
            dtrec_y = local_cat.get_record_dt(gm_h2, db)
            scale_info = local_cat.compute_scale_for_pair(
                db, pair_id=pair_id, T1_s=T1_s,
                sa_target_g=sa_target_g, campaign=catalog_source, xi=xi,
            )

        dtrec = min(dtrec_x, dtrec_y)
        scale = float(scale_info.scale)

        # ── NPZ temporal (se borra tras extraer picos) ──────────────────────
        hist_tmp = _job_dir(work_dir, ida_job_id) / "tmp" / f"hist_{pair_id}_{level_index}.npz"
        hist_tmp.parent.mkdir(parents=True, exist_ok=True)

        t0 = time.perf_counter()

        canonical_path = project.canonical_model_path
        with open(canonical_path, encoding="utf-8") as f:
            canonical = json.load(f)

        if system == "frames":
            nl_spec_path = os.path.join(work_dir, "nonlinear", "nonlinear_model.json")
            if not os.path.exists(nl_spec_path):
                raise FileNotFoundError("nonlinear_model.json faltante — genera el spec primero.")
            with open(nl_spec_path, encoding="utf-8") as f:
                spec = json.load(f)
            from app.engine.building.nonlinear.nl_frame_ops_builder import NLFrameOPSBuilder
            builder = NLFrameOPSBuilder(canonical=canonical, spec=spec, collapse_mode=collapse_mode)
            info = builder.build()
            builder.run_gravity(steps=10)
            payload = builder.run_dynamic(
                record_x_path=record_x_path,
                record_y_path=record_y_path,
                dtrec=dtrec,
                dt_analysis=dt_analysis,
                damping=damping,
                scale=scale,
                record_units="g",
                duration=None,
                history_path=hist_tmp,
                progress_cb=None,
            )
            # Hinge damage: liviano, usa el NPZ. Producirá damage.hinges con θ_p_max
            # que el summary extractor luego colapsa a theta_col_max / theta_beam_max.
            try:
                from app.engine.building.nonlinear.hinge_damage import (
                    compute_hinge_damage_from_history,
                )
                damage = compute_hinge_damage_from_history(
                    history_path=hist_tmp,
                    element_lines=info["element_lines"],
                    spec=spec,
                    direction="nlth",
                )
                payload["damage"] = damage
            except Exception as e_dmg:
                payload["damage"] = {"status": "failed", "message": str(e_dmg)}

            _enrich_health(payload.get("health", {}), info["element_lines"])

        elif system == "walls":
            # IDA sobre muros usa el mismo pipeline reducido
            from app.tasks.structural_nlth_task import _run_wall_nlth
            payload = _run_wall_nlth(
                project=project, canonical_path=canonical_path, work_dir=work_dir,
                record_x_path=record_x_path, record_y_path=record_y_path,
                dtrec=dtrec, dt_analysis=dt_analysis, damping=damping,
                scale=scale, record_units="g", duration=None,
                hist_path=hist_tmp, job_id=f"ida-{pair_id}-{level_index}",
            )
        else:
            raise ValueError(f"system='{system}' no soportado para IDA.")

        wall_s = time.perf_counter() - t0

        # ── Extraer summary liviano ──────────────────────────────────────────
        summary = _extract_ida_summary(payload)
        summary.update({
            "pair_id":          pair_id,
            "level_index":      level_index,
            "Sa_target_g":      sa_target_g,
            "scale":            scale,
            "earthquake":       pair["earthquake"],
            "station":          pair["station"],
            "Mw":               pair["mw"],
            "year":             pair["year"],
            "T1_s":             T1_s,
            "wall_time_s":      round(wall_s, 2),
            "computed_at":      datetime.now(timezone.utc).isoformat(),
        })

        out_file.write_text(json.dumps(summary, indent=2), encoding="utf-8")

        # ── "Last-child trigger" para el consolidador ────────────────────────
        # El chord callback de Celery+Redis no se dispara de forma confiable
        # cuando se emite desde un bind=True task (bug reproducido 2026-11-06
        # con Prueba 4: hijas succeed → consolidate_ida nunca recibido).
        # Fix: cada hija, al terminar, cuenta resultados persistidos. Si es la
        # última, dispara el consolidador como task regular. Es idempotente
        # (sobrescribe ida_results.json) → si dos hijas terminan simultáneas
        # y ambas disparan, el resultado final es el mismo.
        try:
            _trigger_consolidate_if_last(
                work_dir=work_dir, ida_job_id=ida_job_id, project_id=project_id,
            )
        except Exception as e_trig:
            print(f"[ida-trigger] warning: {e_trig}")

        return {
            "ok": True,
            "pair_id":     pair_id,
            "level_index": level_index,
            "path":        str(out_file),
            "collapsed":   summary.get("collapsed", False),
            "max_drift":   summary.get("max_drift_pct", 0.0),
        }

    except Exception as e:
        import traceback
        traceback.print_exc()
        err = {
            "error":       str(e),
            "pair_id":     pair_id,
            "level_index": level_index,
            "Sa_target_g": sa_target_g,
            "status":      "failed",
            "collapsed":   False,
            "max_drift_pct": 0.0,
        }
        if out_file:
            try:
                out_file.write_text(json.dumps(err, indent=2), encoding="utf-8")
            except Exception:
                pass
        return err

    finally:
        db.close()
        # Limpieza: NPZ temporal + GC
        if hist_tmp and hist_tmp.exists():
            try:
                hist_tmp.unlink()
            except Exception:
                pass
        gc.collect()


# ─────────────────────────────────────────────────────────────────────────────
# Orquestador: encola grupo de tasks + consolida
# ─────────────────────────────────────────────────────────────────────────────
def _sa_grid(sa_min: float, sa_max: float, n_levels: int,
             spacing: str = "linear") -> list[float]:
    """Genera el grid de Sa objetivo."""
    import math
    if n_levels < 2:
        return [float(sa_min)]
    if spacing == "log":
        lo, hi = max(sa_min, 1e-3), max(sa_max, sa_min * 1.01)
        step = (math.log(hi) - math.log(lo)) / (n_levels - 1)
        return [round(math.exp(math.log(lo) + i * step), 4) for i in range(n_levels)]
    step = (sa_max - sa_min) / (n_levels - 1)
    return [round(sa_min + i * step, 4) for i in range(n_levels)]


@celery_app.task(
    name="app.tasks.structural_ida_task.run_ida",
    bind=True,
    time_limit=36000,       # 10 h hard (orquestador espera hijos)
    soft_time_limit=35400,  # 9 h 50 min
)
def run_ida_task(
    self,
    job_id:          str,
    project_id:      str,
    input_file:      str | None = None,
    parameters_dict: dict | None = None,
    e2k_file:        str | None = None,
    extra_params:    dict | None = None,
):
    """Orquesta un IDA completo sobre N pares × M niveles de Sa.

    Params esperados en `parameters_dict` (o extra_params):
        pair_ids:     list[int]        — selección del catálogo FEMA
        sa_min:       float (g)
        sa_max:       float (g)
        n_levels:     int
        T1_s:         float            — período fundamental para el escalado
        system:       "frames"|"walls"
        damping:      float            — Rayleigh ξ (default 0.05)
        dt_analysis:  float            — paso Newmark (default 0.005)
        spacing:      "linear"|"log"   — default linear
        collapse_mode: "ductile"|...

    Encola group(run_ida_pair_level) y espera hasta que todos completen; luego
    consolida en ida_results.json con percentiles 16/50/84.
    """
    from app.db import SessionLocal
    from app.models import StructuralJob, StructuralJobStatus
    from celery import group

    params = dict(parameters_dict or {})
    if extra_params:
        params.update(extra_params)

    pair_ids    = [int(p) for p in (params.get("pair_ids") or [])]
    sa_min      = float(params.get("sa_min", 0.1))
    sa_max      = float(params.get("sa_max", 2.0))
    n_levels    = int(params.get("n_levels", 10))
    T1_s        = float(params.get("T1_s", 0.0))
    system      = str(params.get("system", "frames")).lower()
    damping     = float(params.get("damping", 0.05))
    dt_analysis = float(params.get("dt_analysis", 0.005))
    spacing     = str(params.get("spacing", "linear")).lower()
    collapse_mode = str(params.get("collapse_mode", "ductile")).lower()
    catalog_source = str(params.get("catalog_source", "fema"))

    if not pair_ids:
        raise ValueError("pair_ids vacío — selecciona al menos un par FEMA.")
    if T1_s <= 0:
        raise ValueError("T1_s debe ser > 0 (corre modal primero).")

    sa_levels = _sa_grid(sa_min, sa_max, n_levels, spacing)

    db = SessionLocal()
    try:
        job = db.get(StructuralJob, job_id)
        if not job:
            return {"error": "Job not found"}
        job.status = StructuralJobStatus.running
        job.progress_json = {
            "stage":     "launching",
            "n_pairs":   len(pair_ids),
            "n_levels":  n_levels,
            "n_total":   len(pair_ids) * n_levels,
        }
        db.commit()

        project = job.project
        work_dir = os.path.dirname(os.path.dirname(project.canonical_model_path))
        ida_job_id = job_id
        job_dir = _job_dir(work_dir, ida_job_id)
        job_dir.mkdir(parents=True, exist_ok=True)

        # Persistir meta
        meta = {
            "ida_job_id":   ida_job_id,
            "pair_ids":     pair_ids,
            "sa_levels":    sa_levels,
            "sa_min":       sa_min,
            "sa_max":       sa_max,
            "n_levels":     n_levels,
            "T1_s":         T1_s,
            "system":       system,
            "damping":      damping,
            "spacing":      spacing,
            "collapse_mode": collapse_mode,
            "catalog_source": catalog_source,
            "launched_at":  datetime.now(timezone.utc).isoformat(),
            "total_runs":   len(pair_ids) * n_levels,
        }
        (job_dir / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

        # Lanzar chord: group de tasks + callback de consolidación
        from celery import chord
        signatures = []
        for pid in pair_ids:
            for i, sa in enumerate(sa_levels):
                signatures.append(run_ida_pair_level_task.s(
                    project_id=project_id,
                    ida_job_id=ida_job_id,
                    pair_id=pid,
                    level_index=i,
                    sa_target_g=sa,
                    T1_s=T1_s,
                    system=system,
                    damping=damping,
                    dt_analysis=dt_analysis,
                    collapse_mode=collapse_mode,
                    catalog_source=catalog_source,
                ))

        job.progress_json = {
            "stage":    "dispatched",
            "n_total":  len(signatures),
            "n_pairs":  len(pair_ids),
            "n_levels": n_levels,
        }
        db.commit()

        # chord: ejecuta el grupo en paralelo y cuando TODOS terminan,
        # dispara consolidate_ida_task con la lista de resultados hijos.
        chord(signatures)(consolidate_ida_task.s(
            job_id=job_id, project_id=project_id,
            ida_job_id=ida_job_id, pair_ids=pair_ids, sa_levels=sa_levels,
            meta=meta,
        ))

        # El orquestador retorna inmediatamente; el consolidator se encargará
        # de marcar el job como success/failed cuando los hijos terminen.
        return {
            "ok": True,
            "dispatched": len(signatures),
            "ida_job_id": ida_job_id,
            "message": "IDA dispatched — hijos corren en paralelo, consolida al terminar.",
        }

    except Exception as e:
        import traceback; traceback.print_exc()
        try:
            job.status = StructuralJobStatus.failed
            job.error_message = str(e)
            job.progress_json = {"stage": "failed", "message": str(e)}
            job.finished_at = datetime.now(timezone.utc)
            db.commit()
        except Exception:
            pass
        return {"error": str(e)}
    finally:
        db.close()


# ─────────────────────────────────────────────────────────────────────────────
# Callback del chord: consolida y marca el job
# ─────────────────────────────────────────────────────────────────────────────
@celery_app.task(
    name="app.tasks.structural_ida_task.consolidate_ida",
    bind=True,
)
def consolidate_ida_task(
    self,
    child_results:  list[dict] | None,
    job_id:         str,
    project_id:     str,
    ida_job_id:     str,
    pair_ids:       list[int],
    sa_levels:      list[float],
    meta:           dict,
) -> dict:
    """Callback que corre tras el group de run_ida_pair_level_task.

    Recibe la lista de resultados de los hijos (Celery pasa automáticamente
    los returns del group como primer argumento al chord callback).
    """
    from app.db import SessionLocal
    from app.models import StructuralJob, StructuralJobStatus

    db = SessionLocal()
    try:
        job = db.get(StructuralJob, job_id)
        if not job:
            return {"error": "Job not found"}

        try:
            project = job.project
            work_dir = os.path.dirname(os.path.dirname(project.canonical_model_path))

            consolidated = _consolidate_ida(
                work_dir=work_dir, ida_job_id=ida_job_id,
                pair_ids=pair_ids, sa_levels=sa_levels, meta=meta,
            )

            out_path = _job_dir(work_dir, ida_job_id) / "ida_results.json"
            out_path.write_text(json.dumps(consolidated, indent=2), encoding="utf-8")

            # Limpieza del directorio tmp (NPZ residuales si quedaron)
            tmp_dir = _job_dir(work_dir, ida_job_id) / "tmp"
            if tmp_dir.exists():
                try:
                    shutil.rmtree(tmp_dir)
                except Exception:
                    pass

            # `child_results` viene del chord Celery cuando se dispara por esa
            # vía. Con el fallback "last-child trigger" viene None → contamos
            # desde el consolidado (curves). Soporta ambos caminos.
            if child_results:
                n_ok        = sum(1 for r in child_results if r and r.get("ok"))
                n_collapsed = sum(1 for r in child_results if r and r.get("collapsed"))
                n_total     = len(child_results)
            else:
                flat_points = [p for pts in consolidated["curves"].values() for p in pts]
                n_ok        = sum(1 for p in flat_points if p.get("status") == "success")
                n_collapsed = sum(1 for p in flat_points if p.get("collapsed"))
                n_total     = len(flat_points) or (len(pair_ids) * len(sa_levels))

            job.result_path = str(out_path)
            job.result_summary = {
                "n_pairs":     len(pair_ids),
                "n_levels":    len(sa_levels),
                "n_total":     n_total,
                "n_ok":        n_ok,
                "n_collapsed": n_collapsed,
                "sa_median_collapse_g": consolidated.get("sa_median_collapse_g"),
            }
            job.status = StructuralJobStatus.success
            job.finished_at = datetime.now(timezone.utc)
            job.progress_json = {
                "stage": "done", "pct": 100,
                "n_ok": n_ok, "n_total": n_total,
            }
            db.commit()
            return {"ok": True, "path": str(out_path), "n_ok": n_ok, "n_total": n_total}
        except Exception as e:
            import traceback; traceback.print_exc()
            job.status = StructuralJobStatus.failed
            job.error_message = f"Consolidación IDA falló: {e}"
            job.progress_json = {"stage": "failed", "message": str(e)}
            job.finished_at = datetime.now(timezone.utc)
            db.commit()
            return {"error": str(e)}
    finally:
        db.close()


# ─────────────────────────────────────────────────────────────────────────────
# Consolidador
# ─────────────────────────────────────────────────────────────────────────────
def _percentile(values: list[float], pct: float) -> float:
    """Interpolación lineal entre percentiles (compatible numpy)."""
    if not values:
        return 0.0
    s = sorted(values)
    k = (len(s) - 1) * pct / 100.0
    lo = int(k)
    hi = min(lo + 1, len(s) - 1)
    frac = k - lo
    return s[lo] * (1.0 - frac) + s[hi] * frac


def _profile_percentiles(
    all_profiles: list[list[float]], n_stories: int,
) -> dict[str, list[float]]:
    """Percentiles por piso de una lista de perfiles.

    Recibe N perfiles (uno por par), cada uno array[n_stories]. Para cada
    piso i calcula P16/P50/P84 sobre los N valores de ese piso. Si algún
    perfil es más corto que n_stories, se rellena con 0.
    """
    p16 = [0.0] * n_stories
    p50 = [0.0] * n_stories
    p84 = [0.0] * n_stories
    for i in range(n_stories):
        column = [
            float(prof[i]) if prof is not None and i < len(prof) else 0.0
            for prof in all_profiles
        ]
        p16[i] = _percentile(column, 16)
        p50[i] = _percentile(column, 50)
        p84[i] = _percentile(column, 84)
    return {"p16": p16, "p50": p50, "p84": p84}


def _consolidate_ida(
    *, work_dir: str, ida_job_id: str,
    pair_ids:    list[int],
    sa_levels:   list[float],
    meta:        dict,
) -> dict:
    """Agrega summaries de todos los (par, nivel) en curvas IDA + perfiles.

    Produce dos vistas complementarias:
      1. `curves[pair_id]` — recorrido IM–EDP de ese par a través de niveles.
      2. `stats_per_level[k]` — distribución entre pares para el nivel k
         (percentiles globales y perfiles por piso).
    """
    results_dir = _results_subdir(work_dir, ida_job_id)

    # Estructura: {pair_id: [punto_por_nivel]} — incluye TODO el summary, el
    # frontend elige qué usar. Los perfiles son ~200 bytes/piso → tamaño OK.
    curves: dict[str, list[dict]] = {}
    for pid in pair_ids:
        pts = []
        for i, sa in enumerate(sa_levels):
            fname = results_dir / f"pair_{pid}_level_{i}.json"
            if not fname.exists():
                pts.append({"Sa_g": sa, "level_index": i, "status": "missing",
                            "max_drift_pct": None, "collapsed": None})
                continue
            try:
                s = json.loads(fname.read_text(encoding="utf-8"))
            except Exception as e:
                pts.append({"Sa_g": sa, "level_index": i, "status": "parse_error",
                            "error": str(e)})
                continue
            pts.append({
                "Sa_g":            float(sa),
                "level_index":     i,
                "status":          s.get("status", "unknown"),
                "max_drift_pct":   s.get("max_drift_pct"),
                "max_roof_m":      s.get("max_roof_m"),
                "Vb_peak_kN":      s.get("Vb_peak_kN"),
                "theta_col_max":   s.get("theta_col_max"),
                "theta_beam_max":  s.get("theta_beam_max"),
                "collapsed":       bool(s.get("collapsed", False)),
                "aborted":         bool(s.get("aborted", False)),
                "abort_reason":    s.get("abort_reason"),
                "worst_fid":       s.get("worst_fid"),
                "n_critical_cols": s.get("n_critical_columns", 0),
                "n_critical_beams": s.get("n_critical_beams", 0),
                # Perfiles por piso (Ola A)
                "stories_z":                     s.get("stories_z") or [],
                "max_drift_by_story_x_pct":      s.get("max_drift_by_story_x_pct") or [],
                "max_drift_by_story_y_pct":      s.get("max_drift_by_story_y_pct") or [],
                "max_abs_accel_by_story_x_mps2": s.get("max_abs_accel_by_story_x_mps2") or [],
                "max_abs_accel_by_story_y_mps2": s.get("max_abs_accel_by_story_y_mps2") or [],
                "max_disp_by_story_x_m":         s.get("max_disp_by_story_x_m") or [],
                "max_disp_by_story_y_m":         s.get("max_disp_by_story_y_m") or [],
                "accel_amp_by_story_x":          s.get("accel_amp_by_story_x") or [],
                "accel_amp_by_story_y":          s.get("accel_amp_by_story_y") or [],
                "pga_x_g":                       s.get("pga_x_g"),
                "pga_y_g":                       s.get("pga_y_g"),
                "pga_vector_g":                  s.get("pga_vector_g"),
                "residual_drift_pct":            s.get("residual_drift_pct"),
                "residual_drift_x_pct":          s.get("residual_drift_x_pct"),
                "residual_drift_y_pct":          s.get("residual_drift_y_pct"),
                "residual_drift_by_story_x_pct": s.get("residual_drift_by_story_x_pct") or [],
                "residual_drift_by_story_y_pct": s.get("residual_drift_by_story_y_pct") or [],
                "critical_story_idx":            s.get("critical_story_idx"),
                "critical_story_drift_pct":      s.get("critical_story_drift_pct"),
                "hinges_by_story":               s.get("hinges_by_story") or {},
            })
        curves[str(pid)] = pts

    # ── Detectar n_stories canónico desde el primer summary válido ──────────
    stories_z: list[float] = []
    n_stories = 0
    for pid in pair_ids:
        for p in curves[str(pid)]:
            if p.get("stories_z"):
                stories_z = list(p["stories_z"])
                dx = p.get("max_drift_by_story_x_pct") or []
                dy = p.get("max_drift_by_story_y_pct") or []
                n_stories = max(len(dx), len(dy))
                break
        if n_stories > 0:
            break

    # Percentiles por nivel de Sa (banda 16/50/84 clásica FEMA P-695)
    stats_per_level: list[dict] = []
    for i, sa in enumerate(sa_levels):
        drifts = [
            float(curves[str(pid)][i].get("max_drift_pct") or 0.0)
            for pid in pair_ids
            if curves[str(pid)][i].get("max_drift_pct") is not None
        ]
        thetas_col = [
            float(curves[str(pid)][i].get("theta_col_max") or 0.0)
            for pid in pair_ids
            if curves[str(pid)][i].get("theta_col_max") is not None
        ]
        residuals = [
            float(curves[str(pid)][i].get("residual_drift_pct") or 0.0)
            for pid in pair_ids
            if curves[str(pid)][i].get("residual_drift_pct") is not None
        ]
        pga = [
            float(curves[str(pid)][i].get("pga_vector_g") or 0.0)
            for pid in pair_ids
            if curves[str(pid)][i].get("pga_vector_g") is not None
        ]
        n_col = sum(1 for pid in pair_ids if curves[str(pid)][i].get("collapsed"))

        # Perfiles por piso: agregamos dirección (toma el máximo entre X e Y
        # por par, que es la representación "envolvente" que pide el usuario).
        drift_profiles_envelope: list[list[float]] = []
        accel_profiles_envelope: list[list[float]] = []
        disp_profiles_envelope:  list[list[float]] = []
        accel_amp_profiles:      list[list[float]] = []
        for pid in pair_ids:
            p = curves[str(pid)][i]
            dx = p.get("max_drift_by_story_x_pct") or []
            dy = p.get("max_drift_by_story_y_pct") or []
            ax = p.get("max_abs_accel_by_story_x_mps2") or []
            ay = p.get("max_abs_accel_by_story_y_mps2") or []
            ux = p.get("max_disp_by_story_x_m") or []
            uy = p.get("max_disp_by_story_y_m") or []
            amx = p.get("accel_amp_by_story_x") or []
            amy = p.get("accel_amp_by_story_y") or []
            n = max(len(dx), len(dy), len(ax), len(ay))
            if n == 0:
                continue
            drift_profiles_envelope.append(
                [max(dx[k] if k < len(dx) else 0.0, dy[k] if k < len(dy) else 0.0)
                 for k in range(n)]
            )
            accel_profiles_envelope.append(
                [max(ax[k] if k < len(ax) else 0.0, ay[k] if k < len(ay) else 0.0)
                 for k in range(n)]
            )
            disp_profiles_envelope.append(
                [max(ux[k] if k < len(ux) else 0.0, uy[k] if k < len(uy) else 0.0)
                 for k in range(n)]
            )
            accel_amp_profiles.append(
                [max(amx[k] if k < len(amx) else 0.0, amy[k] if k < len(amy) else 0.0)
                 for k in range(n)]
            )

        drift_profile_stats = _profile_percentiles(drift_profiles_envelope, n_stories)
        accel_profile_stats = _profile_percentiles(accel_profiles_envelope, n_stories)
        disp_profile_stats  = _profile_percentiles(disp_profiles_envelope,  n_stories)
        amp_profile_stats   = _profile_percentiles(accel_amp_profiles,      n_stories)

        stats_per_level.append({
            "Sa_g":            float(sa),
            "level_index":     i,
            "drift_p16":       _percentile(drifts, 16),
            "drift_p50":       _percentile(drifts, 50),
            "drift_p84":       _percentile(drifts, 84),
            "theta_col_p50":   _percentile(thetas_col, 50),
            "theta_col_p84":   _percentile(thetas_col, 84),
            "residual_p50":    _percentile(residuals, 50),
            "residual_p84":    _percentile(residuals, 84),
            "pga_p50_g":       _percentile(pga, 50),
            "n_collapsed":     n_col,
            "n_total":         len(pair_ids),
            "collapse_frac":   n_col / len(pair_ids) if pair_ids else 0.0,
            # Perfiles por piso (envolvente X,Y) — percentiles entre pares
            "drift_profile":   drift_profile_stats,
            "accel_profile":   accel_profile_stats,
            "disp_profile":    disp_profile_stats,
            "accel_amp_profile": amp_profile_stats,
        })

    # Sa mediana de colapso (nivel donde fracción colapsada ≥ 50%)
    sa_median_col = None
    for s in stats_per_level:
        if s["collapse_frac"] >= 0.5:
            sa_median_col = s["Sa_g"]
            break

    # Piso crítico global (de mayor frecuencia entre todos los análisis)
    crit_counts: dict[int, int] = {}
    for pid in pair_ids:
        for p in curves[str(pid)]:
            idx = p.get("critical_story_idx")
            if isinstance(idx, int) and idx >= 0:
                crit_counts[idx] = crit_counts.get(idx, 0) + 1
    most_critical_story_idx = max(crit_counts, key=crit_counts.get) if crit_counts else None

    return {
        "meta":             meta,
        "curves":           curves,         # por par
        "stats_per_level":  stats_per_level,
        "sa_median_collapse_g": sa_median_col,
        "stories_z":        stories_z,
        "n_stories":        n_stories,
        "most_critical_story_idx": most_critical_story_idx,
        "n_pairs":          len(pair_ids),
        "n_levels":         len(sa_levels),
        "computed_at":      datetime.now(timezone.utc).isoformat(),
    }
