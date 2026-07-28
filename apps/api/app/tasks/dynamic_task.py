"""
Tarea Celery — Análisis cronológico no lineal tiempo-historia con FEMA P-695.

Arquitectura:
  - Soporta IDA: N pares × M factores de escala.
  - Cada par corre en subproceso independiente vía os.fork() (requiere Linux/Docker).
  - Envolvente de derivas: percentil 16, media, percentil 84.
  - Resultado web: dynamic_envelope.json

Registros FEMA: 44 archivos .txt en settings.records_dir (22 pares).

Parámetros UI (dynamic_params):
  damping        : float — amortiguamiento (default 0.05)
  scale_factors  : list  — factores de escala para IDA (default [1.0])
  n_pairs        : int   — pares FEMA a correr (max 22, default 22)
  dt_analysis    : float — paso Newmark (default 0.02 s)
  parallel_pairs : int   — pares simultáneos (default = n_pairs, limitado por CPUs)
"""
import os
import json
import traceback
import time
import signal

import numpy as np

from app.tasks.celery_app import celery_app
from app.tasks._task_helpers import (
    get_db_session, mark_running, mark_success, mark_failed,
    get_engine_building_path, patch_root_path, prepare_work_dir,
)

_PAIR_TIMEOUT_S = 90 * 60  # 90 minutos por par

_FEMA_DT = [
    0.010, 0.010, 0.010, 0.010, 0.010, 0.010, 0.010, 0.010, 0.010, 0.010,
    0.005, 0.005, 0.010, 0.010, 0.010, 0.010, 0.005, 0.005,
    0.050, 0.050, 0.020, 0.020, 0.0025, 0.0025, 0.005, 0.005,
    0.005, 0.005, 0.005, 0.005, 0.005, 0.005, 0.005, 0.005,
    0.010, 0.010, 0.005, 0.005, 0.005, 0.005, 0.010, 0.010,
    0.005, 0.005,
]


# ── Utilidades ────────────────────────────────────────────────────────────────

def _build_fema_db(records_folder: str) -> dict:
    txt_files = sorted(f for f in os.listdir(records_folder) if f.endswith(".txt"))
    db = {}
    for i, filename in enumerate(txt_files):
        path = os.path.join(records_folder, filename)
        with open(path, "r") as fh:
            nsteps = sum(1 for line in fh if line.strip())
        db[str(i)] = {
            "record_name":    filename.replace(".txt", ""),
            "file_path":      path,
            "time_increment": _FEMA_DT[i] if i < len(_FEMA_DT) else 0.010,
            "steps_number":   nsteps,
        }
    return db


def _building_height(store_data: dict) -> float:
    com = store_data.get("center_of_mass_information", {})
    if not com:
        return 1.0
    return max(float(v.get("global_z", 1)) for v in com.values()) or 1.0


def _sa_at_period(ag_g: np.ndarray, dt: float, T: float, xi: float = 0.05) -> float:
    ag = np.asarray(ag_g, dtype=float)
    if T <= 0.02:
        return float(np.max(np.abs(ag)))
    omega = 2.0 * np.pi / T
    c_dmp = 2.0 * xi * omega
    k_stt = omega ** 2
    beta, gamma = 0.25, 0.5
    a0 = 1.0 / (beta * dt ** 2)
    a1 = gamma / (beta * dt)
    a2 = 1.0 / (beta * dt)
    a3 = 0.5 / beta - 1.0
    a4 = gamma / beta - 1.0
    a5 = dt * (gamma / (2.0 * beta) - 1.0)
    k_eff = k_stt + c_dmp * a1 + a0
    u = v = max_u = 0.0
    a_old = -ag[0]
    for i in range(len(ag) - 1):
        p_eff = (-ag[i + 1] + a0 * u + a2 * v + a3 * a_old
                 + c_dmp * (a1 * u + a4 * v + a5 * a_old))
        u_new = p_eff / k_eff
        a_new = a0 * (u_new - u) - a2 * v - a3 * a_old
        v_new = v + dt * ((1.0 - gamma) * a_old + gamma * a_new)
        if abs(u_new) > max_u:
            max_u = abs(u_new)
        u, v, a_old = u_new, v_new, a_new
    return float(omega ** 2 * max_u)


# ── Worker de subproceso ──────────────────────────────────────────────────────

def _dynamic_pair_worker(pair_id: int, scale: float, store_data: dict,
                          work_dir: str, engine_path: str,
                          fema_records: dict, params: dict, result_path: str):
    import sys
    import types as _types

    try:
        import matplotlib
        matplotlib.use("Agg")
    except Exception:
        pass

    try:
        from sqlalchemy.orm import close_all_sessions
        close_all_sessions()
    except Exception:
        pass

    t0  = time.time()
    rec1 = fema_records.get(str(2 * pair_id), {})
    rec2 = fema_records.get(str(2 * pair_id + 1), {})

    try:
        if engine_path not in sys.path:
            sys.path.insert(0, engine_path)

        import archetype_1
        archetype_1.root_path = work_dir
        for name, obj in vars(archetype_1).items():
            if isinstance(obj, _types.ModuleType) and hasattr(obj, "root_path"):
                obj.root_path = work_dir

        import dynamic as dyn_module
        import opseestools.analisis3D as optools_an
        import openseespy.opensees as ops

        ops.wipe()
        ops_builder = archetype_1.OPSModelBuilder(store_data, modal_analysis=False)
        ops_builder.builder(work_dir)

        Tol = dyn_module._compute_tol(1e-4)
        optools_an.gravedad(Tol=Tol)
        ops.loadConst("-time", 0.0)

        node_record, _ = dyn_module._control_nodes_from_store(store_data)
        ctrl_node = max(node_record)
        _, eletype = dyn_module._pick_record_elements(store_data)
        record_paths, dtrec, nsteps = dyn_module._read_pair(fema_records, pair_id)

        res = dyn_module.dinamicoBD4_adaptive(
            record_paths=record_paths, dtrec=dtrec, nPts=nsteps,
            dt=params.get("dt_analysis", 0.01),
            factor=9.81 * scale,
            damp=params.get("damping", 0.05),
            IDctrlNode=ctrl_node, IDctrlDOF=1,
            nodes_control=node_record, elements=[],
            modes=(0, 2), Kswitch=1, Tol=Tol, eletype=eletype,
            reduce_factor=0.5, dt_min=1e-4, maxNumIter=25,
        )
        tiempo, techo1, techo2, techoT, _, _, _, _, _, driftX, driftY, _, _ = res

        max_drift_x = [round(float(np.max(np.abs(driftX[:, i]))) * 100, 4)
                       for i in range(driftX.shape[1])]
        max_drift_y = [round(float(np.max(np.abs(driftY[:, i]))) * 100, 4)
                       for i in range(driftY.shape[1])]
        H = _building_height(store_data)

        T1 = params.get("T1")
        xi = params.get("damping", 0.05)
        sa_geomean_unscaled = None
        if T1 and T1 > 0:
            try:
                sa_vals = []
                for rpath in record_paths:
                    with open(rpath, "r") as fh:
                        ag = [float(l.strip()) for l in fh if l.strip()]
                    sa_vals.append(_sa_at_period(np.array(ag), dtrec, T1, xi))
                if len(sa_vals) == 2:
                    sa_geomean_unscaled = float(np.sqrt(sa_vals[0] * sa_vals[1]))
            except Exception as e:
                print(f"[dyn/p{pair_id}/s{scale}] Sa(T1) falló: {e}")

        sa_geomean_scaled = (round(sa_geomean_unscaled * scale, 5)
                             if sa_geomean_unscaled is not None else None)

        n_pts  = len(tiempo)
        stride = max(1, n_pts // 600)
        compact = {
            "pair_id": pair_id, "scale": scale,
            "record_names": [rec1.get("record_name", ""), rec2.get("record_name", "")],
            "max_drift_x": max_drift_x, "max_drift_y": max_drift_y,
            "max_roof_x_m":   round(float(np.max(np.abs(techo1))), 4),
            "max_roof_y_m":   round(float(np.max(np.abs(techo2))), 4),
            "max_roof_x_pct": round(float(np.max(np.abs(techo1))) / H * 100, 4),
            "max_roof_y_pct": round(float(np.max(np.abs(techo2))) / H * 100, 4),
            "T1": round(T1, 4) if T1 else None,
            "sa_geomean_g": sa_geomean_scaled,
            "sa_geomean_unscaled_g": (round(sa_geomean_unscaled, 5)
                                      if sa_geomean_unscaled is not None else None),
            "time_hist": {
                "t": [round(float(v), 4) for v in tiempo[::stride]],
                "x": [round(float(v), 4) for v in techo1[::stride]],
                "y": [round(float(v), 4) for v in techo2[::stride]],
            },
            "elapsed_s": round(time.time() - t0, 1),
            "status": "success",
        }

        os.makedirs(os.path.dirname(result_path), exist_ok=True)
        with open(result_path, "w") as fh:
            json.dump(compact, fh, indent=2)

        print(f"[dyn/p{pair_id}/s{scale}] OK {compact['elapsed_s']}s | "
              f"Δx={max(max_drift_x, default=0):.3f}% Δy={max(max_drift_y, default=0):.3f}%")
        os._exit(0)

    except Exception:
        print(f"[dyn/p{pair_id}/s{scale}] FAILED:\n{traceback.format_exc()}")
        try:
            err = {"pair_id": pair_id, "scale": scale, "status": "failed",
                   "error": traceback.format_exc()[-600:]}
            os.makedirs(os.path.dirname(result_path), exist_ok=True)
            with open(result_path, "w") as fh:
                json.dump(err, fh)
        except Exception:
            pass
        os._exit(1)


def _fork_pair(pair_id, scale, store_data, work_dir, engine_path,
               fema_records, params, result_path) -> int:
    pid = os.fork()
    if pid != 0:
        return pid
    try:
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            try:
                signal.signal(sig, signal.SIG_DFL)
            except Exception:
                pass
        _dynamic_pair_worker(pair_id, scale, store_data, work_dir,
                              engine_path, fema_records, params, result_path)
    except SystemExit as e:
        os._exit(e.code or 0)
    except Exception:
        os._exit(1)


# ── Tarea Celery ──────────────────────────────────────────────────────────────

@celery_app.task(name="app.tasks.dynamic_task.run_dynamic", bind=True)
def run_dynamic(
    self,
    job_id: str,
    project_id: str,
    input_file: str | None,
    parameters_dict: dict | None = None,
    dynamic_params: dict | None = None,
):
    db = get_db_session()
    try:
        mark_running(db, job_id)

        import sys
        from app.config import settings

        engine_path = get_engine_building_path()
        if engine_path not in sys.path:
            sys.path.insert(0, engine_path)

        # ── 1. Parámetros ──────────────────────────────────────────────────
        n_cpu = os.cpu_count() or 4
        dp    = dynamic_params or {}
        n_pairs_req = int(dp.get("n_pairs", 22))

        params = {
            "damping":        float(dp.get("damping",       0.05)),
            "scale_factors":  list(dp.get("scale_factors",  [1.0])),
            "n_pairs":        n_pairs_req,
            "dt_analysis":    float(dp.get("dt_analysis",   0.02)),
            "parallel_pairs": int(dp.get("parallel_pairs",  n_pairs_req)),
        }
        n_pairs       = min(params["n_pairs"], 22)
        scale_factors = params["scale_factors"]
        parallel_pairs = max(1, min(params["parallel_pairs"], n_cpu))

        # ── 2. Cargar arquetipo ────────────────────────────────────────────
        archetype_json = os.path.join(settings.output_dir, str(project_id), "archetype", "processed_data.json")
        if not os.path.exists(archetype_json):
            raise FileNotFoundError("No se encontró el arquetipo. Ejecuta primero 'Modelo Estructural'.")
        with open(archetype_json, "r", encoding="utf-8") as fh:
            store_data = json.load(fh)

        # ── 3. Leer T1 del modal ────────────────────────────────────────────
        T1 = None
        modal_path = os.path.join(settings.output_dir, str(project_id), "modal", "modal_results.json")
        if os.path.exists(modal_path):
            with open(modal_path, "r", encoding="utf-8") as fh:
                modal_data = json.load(fh)
            T1 = (modal_data.get("modes_table") or [{}])[0].get("T")
        params["T1"] = T1
        print(f"[dynamic] T1={T1}s | {len(scale_factors)} escala(s) × {n_pairs} pares | {parallel_pairs} paralelos")

        # ── 4. Localizar registros FEMA ─────────────────────────────────────
        records_folder = settings.records_dir
        if not os.path.exists(records_folder):
            raise FileNotFoundError(
                f"Registros FEMA no encontrados en {records_folder}. "
                "Copia los 44 archivos .txt en apps/api/data/records/fema_records/."
            )
        fema_records = _build_fema_db(records_folder)
        available_pairs = len(fema_records) // 2
        n_pairs = min(n_pairs, available_pairs)
        print(f"[dynamic] {len(fema_records)} registros FEMA disponibles ({available_pairs} pares)")

        # ── 5. Preparar work_dir ────────────────────────────────────────────
        work_dir = prepare_work_dir(
            project_id=project_id,
            upload_dir=settings.upload_dir,
            input_file=input_file,
            parameters_dict=parameters_dict,
        )

        output_dir = os.path.join(settings.output_dir, str(project_id), "dynamic")
        os.makedirs(output_dir, exist_ok=True)

        # ── 6. Lanzar pares en paralelo por escala ─────────────────────────
        t_start     = time.time()
        all_results: list[dict] = []

        for scale in scale_factors:
            print(f"[dynamic] Escala {scale} — lanzando {n_pairs} pares ({parallel_pairs} simultáneos)")
            pair_results: list[dict] = []
            pair_queue   = list(range(n_pairs))
            running_pids: dict[int, tuple[int, float, str]] = {}  # pid → (pair_id, scale, result_path)

            while pair_queue or running_pids:
                # Lanzar hasta parallel_pairs procesos simultáneos
                while pair_queue and len(running_pids) < parallel_pairs:
                    pid_pair = pair_queue.pop(0)
                    res_path = os.path.join(output_dir, f"pair_{pid_pair}_scale_{scale:.3f}.json")
                    child_pid = _fork_pair(pid_pair, scale, store_data, work_dir,
                                           engine_path, fema_records, params, res_path)
                    running_pids[child_pid] = (pid_pair, scale, res_path)

                # Esperar cualquier hijo que haya terminado
                if running_pids:
                    try:
                        finished_pid, wstatus = os.waitpid(-1, 0)
                    except ChildProcessError:
                        break

                    if finished_pid in running_pids:
                        p_id, sc, res_path = running_pids.pop(finished_pid)
                        exit_code = os.WEXITSTATUS(wstatus)
                        if os.path.exists(res_path):
                            with open(res_path, "r") as fh:
                                pair_results.append(json.load(fh))
                        else:
                            pair_results.append({"pair_id": p_id, "scale": sc, "status": "failed"})

            all_results.extend(pair_results)
            success_count = sum(1 for r in pair_results if r.get("status") == "success")
            print(f"[dynamic] Escala {scale}: {success_count}/{n_pairs} pares OK")

        elapsed = time.time() - t_start

        # ── 7. Calcular envolvente (p16, media, p84) ────────────────────────
        success_results = [r for r in all_results if r.get("status") == "success"]
        envelope = _compute_envelope(success_results, store_data)
        ida_curve = _compute_ida_curve(success_results)

        web_data = {
            "n_pairs_run":   n_pairs,
            "n_success":     len(success_results),
            "scale_factors": scale_factors,
            "elapsed_s":     round(elapsed, 1),
            "envelope":      envelope,
            "ida_curve":     ida_curve,
            "pairs":         success_results,
        }

        web_path = os.path.join(output_dir, "dynamic_envelope.json")
        with open(web_path, "w", encoding="utf-8") as fh:
            json.dump(web_data, fh, ensure_ascii=False, indent=2)

        print(f"[dynamic] Resultado guardado: {web_path} ({len(success_results)} pares exitosos)")

        summary = {
            "n_pairs_run": n_pairs,
            "n_success": len(success_results),
            "elapsed_s": round(elapsed, 1),
        }
        mark_success(db, job_id, web_path, summary=summary)
        return {"status": "success", **summary}

    except Exception as exc:
        mark_failed(db, job_id, traceback.format_exc())
        raise self.retry(exc=exc, max_retries=0)
    finally:
        db.close()


# ── Procesamiento de resultados ───────────────────────────────────────────────

def _compute_envelope(results: list[dict], store_data: dict) -> dict:
    """Calcula envolvente p16/media/p84 de derivas máximas por piso."""
    if not results:
        return {}

    n_floors_x = max((len(r.get("max_drift_x", [])) for r in results), default=0)
    n_floors_y = max((len(r.get("max_drift_y", [])) for r in results), default=0)

    def _percentile_by_floor(key: str, n_floors: int) -> dict:
        floors: dict[int, list] = {i: [] for i in range(n_floors)}
        for r in results:
            vals = r.get(key, [])
            for i in range(min(len(vals), n_floors)):
                floors[i].append(vals[i])
        p16, mean, p84 = [], [], []
        for i in range(n_floors):
            arr = np.array(floors[i]) if floors[i] else np.array([0.0])
            p16.append(round(float(np.percentile(arr, 16)), 4))
            mean.append(round(float(np.mean(arr)),          4))
            p84.append(round(float(np.percentile(arr, 84)), 4))
        return {"p16": p16, "mean": mean, "p84": p84}

    return {
        "drift_x": _percentile_by_floor("max_drift_x", n_floors_x),
        "drift_y": _percentile_by_floor("max_drift_y", n_floors_y),
    }


def _compute_ida_curve(results: list[dict]) -> list[dict]:
    """Construye la curva IDA (Sa vs deriva de techo) si hay múltiples escalas."""
    by_scale: dict[float, list] = {}
    for r in results:
        sc = r.get("scale", 1.0)
        if sc not in by_scale:
            by_scale[sc] = []
        max_drift = max(
            max(r.get("max_drift_x", [0]), default=0),
            max(r.get("max_drift_y", [0]), default=0),
        )
        sa = r.get("sa_geomean_g")
        if sa is not None:
            by_scale[sc].append({"drift": max_drift, "sa": sa})

    curve = []
    for scale in sorted(by_scale.keys()):
        vals = by_scale[scale]
        if not vals:
            continue
        drifts = [v["drift"] for v in vals]
        sas    = [v["sa"]    for v in vals]
        curve.append({
            "scale":       scale,
            "drift_p16":   round(float(np.percentile(drifts, 16)), 4),
            "drift_mean":  round(float(np.mean(drifts)),           4),
            "drift_p84":   round(float(np.percentile(drifts, 84)), 4),
            "sa_p16":      round(float(np.percentile(sas, 16)),    5),
            "sa_mean":     round(float(np.mean(sas)),              5),
            "sa_p84":      round(float(np.percentile(sas, 84)),    5),
        })
    return curve
