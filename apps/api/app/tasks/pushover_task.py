"""
Tarea Celery — Análisis pushover bidireccional.

Ejecuta las direcciones X e Y en paralelo mediante os.fork() (requiere Linux —
el worker corre en Docker). Cada proceso hijo tiene su propia instancia OpenSees.

Salida principal: outputs/{project_id}/pushover/datos/pushover_web.json
"""
import os
import json
import traceback
import shutil
import time

from app.tasks.celery_app import celery_app
from app.tasks._task_helpers import (
    get_db_session, mark_running, mark_success, mark_failed,
    get_engine_building_path, patch_root_path, prepare_work_dir,
)

_PUSH_TIMEOUT_S = 60 * 60  # 60 minutos por dirección


# ── Worker de subproceso (nivel de módulo — pickle-safe) ─────────────────────

def _pushover_direction_worker(direction: str, store_data: dict,
                                work_dir: str, engine_path: str,
                                push_params: dict) -> None:
    import sys
    import types
    import time as _time

    try:
        import matplotlib
        matplotlib.use("Agg")
    except Exception:
        pass

    t0 = _time.time()
    if engine_path not in sys.path:
        sys.path.insert(0, engine_path)

    import archetype_1
    archetype_1.root_path = work_dir
    for name, obj in vars(archetype_1).items():
        if isinstance(obj, types.ModuleType) and hasattr(obj, "root_path"):
            obj.root_path = work_dir

    import pushover as push_module
    if hasattr(push_module, "root_path"):
        push_module.root_path = work_dir

    import openseespy.opensees as ops
    ops.wipe()

    ops_builder = archetype_1.OPSModelBuilder(store_data, modal_analysis=False)
    ops_builder.builder(work_dir)
    print(f"[pushover/{direction}] Modelo OK — lanzando análisis")

    push = push_module.pushoverclass(
        model_data=store_data,
        main_path=work_dir,
        direction=direction,
        record_elements=False,
        **push_params,
    )
    push.run_analysis()
    print(f"[pushover/{direction}] Completado en {_time.time() - t0:.1f}s")


def _fork_direction(direction: str, store_data: dict,
                    work_dir: str, engine_path: str,
                    push_params: dict) -> int:
    import signal as _signal

    pid = os.fork()
    if pid != 0:
        return pid

    # ── proceso hijo ──────────────────────────────────────────────────────────
    try:
        for sig in (_signal.SIGTERM, _signal.SIGINT, _signal.SIGHUP):
            try:
                _signal.signal(sig, _signal.SIG_DFL)
            except Exception:
                pass
        try:
            from sqlalchemy.orm import close_all_sessions
            close_all_sessions()
        except Exception:
            pass
        _pushover_direction_worker(direction, store_data, work_dir, engine_path, push_params)
        os._exit(0)
    except Exception:
        import traceback as _tb
        print(f"[pushover/{direction}] ERROR: {_tb.format_exc()}")
        os._exit(1)


# ── Tarea Celery ──────────────────────────────────────────────────────────────

@celery_app.task(name="app.tasks.pushover_task.run_pushover", bind=True)
def run_pushover(
    self,
    job_id: str,
    project_id: str,
    input_file: str | None,
    parameters_dict: dict | None = None,
    pushover_params: dict | None = None,
):
    db = get_db_session()
    try:
        mark_running(db, job_id)

        import sys
        from app.config import settings

        engine_path = get_engine_building_path()
        if engine_path not in sys.path:
            sys.path.insert(0, engine_path)

        # ── 1. Cargar arquetipo ─────────────────────────────────────────────
        archetype_json = os.path.join(settings.output_dir, str(project_id), "archetype", "processed_data.json")
        if not os.path.exists(archetype_json):
            raise FileNotFoundError("No se encontró el arquetipo. Ejecuta primero 'Modelo Estructural'.")

        with open(archetype_json, "r", encoding="utf-8") as f:
            store_data = json.load(f)

        # ── 2. Preparar work_dir ────────────────────────────────────────────
        work_dir = prepare_work_dir(
            project_id=project_id,
            upload_dir=settings.upload_dir,
            input_file=input_file,
            parameters_dict=parameters_dict,
        )
        outputs_push = os.path.join(work_dir, "outputs", "pushover_results")
        os.makedirs(outputs_push, exist_ok=True)

        # ── 3. Parámetros del análisis (UI tiene prioridad) ─────────────────
        if pushover_params:
            pp = pushover_params
            push_params = {
                "tag_pattern":  int(pp.get("tag_pattern",  1)),
                "odb_tag":      int(pp.get("odb_tag",      1)),
                "pattern_type": str(pp.get("pattern_type", "uniforme")),
                "Dmax":         float(pp.get("Dmax",       0.10)),
                "DInc":         float(pp.get("DInc",       0.001)),
                "push_error":   float(pp.get("push_error", 1e-5)),
                "maxNumIter":   int(pp.get("maxNumIter",   1000)),
            }
        else:
            push_params = {
                "tag_pattern": 1, "odb_tag": 1, "pattern_type": "uniforme",
                "Dmax": 0.10, "DInc": 0.001, "push_error": 1e-5, "maxNumIter": 1000,
            }

        output_dir = os.path.join(settings.output_dir, str(project_id), "pushover")
        os.makedirs(output_dir, exist_ok=True)

        # ── 4. Lanzar X e Y en paralelo con os.fork() ──────────────────────
        pids: dict[str, int] = {}
        t_start = time.time()

        for direction in ["X", "Y"]:
            pid = _fork_direction(direction, store_data, work_dir, engine_path, push_params)
            pids[direction] = pid
            print(f"[pushover] Dirección {direction} lanzada — PID={pid}")

        # ── 5. Esperar ambos hijos ──────────────────────────────────────────
        import signal as _signal

        pid_to_dir  = {v: k for k, v in pids.items()}
        pending     = set(pids.values())
        exit_codes: dict[str, int]   = {}
        dir_elapsed: dict[str, float] = {}
        deadline    = time.time() + _PUSH_TIMEOUT_S

        while pending and time.time() < deadline:
            for pid in list(pending):
                finished, status = os.waitpid(pid, os.WNOHANG)
                if finished != 0:
                    pending.remove(pid)
                    code      = os.WEXITSTATUS(status)
                    direction = pid_to_dir[pid]
                    exit_codes[direction]  = code
                    dir_elapsed[direction] = round(time.time() - t_start, 1)
                    label = "OK" if code == 0 else f"FAILED (exit={code})"
                    print(f"[pushover] Dir {direction} terminó en {dir_elapsed[direction]:.1f}s — {label}")
            if pending:
                time.sleep(1)

        for pid in pending:
            direction = pid_to_dir[pid]
            print(f"[pushover] Timeout en dir {direction} — terminando PID={pid}")
            try:
                os.kill(pid, _signal.SIGTERM); time.sleep(8); os.kill(pid, _signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)
            exit_codes[direction] = -1; dir_elapsed[direction] = -1

        elapsed = time.time() - t_start

        if not any(c == 0 for c in exit_codes.values()):
            raise RuntimeError("Ambas direcciones fallaron en el análisis pushover.")

        # ── 6. Copiar resultados y construir JSON web ───────────────────────
        work_push_dir = os.path.join(work_dir, "outputs", "pushover_results")
        if os.path.exists(work_push_dir):
            shutil.copytree(work_push_dir, output_dir, dirs_exist_ok=True)

        com_info = store_data.get("center_of_mass_information", {})
        story_heights = [0.0]
        if com_info:
            floors_sorted = sorted(com_info.values(), key=lambda v: v.get("global_z", 0))
            story_heights += [float(v.get("global_z", 0)) for v in floors_sorted]

        web_data: dict = {"story_heights": story_heights, "elapsed_s": round(elapsed, 1)}
        summary: dict = {"elapsed_s": round(elapsed, 1), "directions": {}}

        for direction in ["X", "Y"]:
            json_path = os.path.join(output_dir, "datos", f"pushover_resultados_{direction}.json")
            if not os.path.exists(json_path):
                print(f"[pushover] Sin JSON para dirección {direction}")
                continue
            with open(json_path, "r", encoding="utf-8") as f:
                dir_data = json.load(f)

            dtecho      = dir_data.get("dtecho",      [])
            vbasal      = dir_data.get("vbasal",      [])
            vbasal_norm = dir_data.get("vbasal_norm", [])
            dir_summary = {
                "vmax_kN":         round(max(vbasal),       2) if vbasal      else 0,
                "vmax_norm":       round(max(vbasal_norm),  4) if vbasal_norm else 0,
                "drift_techo_max": round(max(dtecho),       3) if dtecho      else 0,
                "n_steps":         len(dtecho),
                "elapsed_s":       dir_elapsed.get(direction, 0),
                "status":          "success" if exit_codes.get(direction, -1) == 0 else "partial",
            }
            dir_data["summary"] = dir_summary
            web_data[direction] = dir_data
            summary["directions"][direction] = dir_summary

        datos_dir = os.path.join(output_dir, "datos")
        os.makedirs(datos_dir, exist_ok=True)
        web_path = os.path.join(datos_dir, "pushover_web.json")
        with open(web_path, "w", encoding="utf-8") as f:
            json.dump(web_data, f, ensure_ascii=False, indent=2)

        print(f"[pushover] JSON web guardado: {web_path}")
        mark_success(db, job_id, web_path, summary=summary)
        return {"status": "success", "elapsed_s": round(elapsed, 1), "directions": exit_codes}

    except Exception as exc:
        mark_failed(db, job_id, traceback.format_exc())
        raise self.retry(exc=exc, max_retries=0)
    finally:
        db.close()
