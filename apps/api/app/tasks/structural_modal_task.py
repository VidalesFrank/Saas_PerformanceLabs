"""
Tarea Celery — Módulo 1: Análisis Modal Lineal.

Requiere que el modelo canónico (structural_model.json) ya haya sido generado
por structural_import_task (F1).

Flujo:
1. Cargar structural_model.json del proyecto.
2. Construir modelo OpenSees con LinearOPSBuilder (elasticBeamColumn + diafragma).
3. Ejecutar ops.eigen() con fallback de solvers.
4. Extraer períodos, masas participativas, formas modales.
5. Guardar modal_results.json como resultado del job.
6. Actualizar analysis_results.modal en structural_model.json.
"""
import json
import math
import os
import traceback

import numpy as np

from app.tasks.celery_app import celery_app
from app.tasks.structural_helpers import (
    get_db_session, mark_running, mark_success, mark_failed,
)


@celery_app.task(name="app.tasks.structural_modal_task.run_modal", bind=True)
def run_modal(
    self,
    job_id: str,
    project_id: str,
    input_file: str | None,
    e2k_file: str | None = None,
    parameters_dict: dict | None = None,
    extra_params: dict | None = None,
):
    """Ejecuta el análisis modal lineal sobre el modelo canónico del proyecto."""
    db = get_db_session()
    try:
        mark_running(db, job_id)

        from app.config import settings
        from app.models import StructuralProject
        from app.engine.building.linear.ops_builder import LinearOPSBuilder

        # ── 1. Verificar modelo canónico ─────────────────────────────────────
        project = db.get(StructuralProject, project_id)
        if not project or not project.canonical_model_path:
            raise FileNotFoundError(
                "No se encontró el modelo canónico. Ejecuta primero 'Validar modelo'."
            )
        canonical_path = project.canonical_model_path
        if not os.path.exists(canonical_path):
            raise FileNotFoundError(f"structural_model.json no encontrado: {canonical_path}")

        with open(canonical_path, "r", encoding="utf-8") as f:
            model = json.load(f)

        # ── 2. Parámetros de análisis ─────────────────────────────────────────
        n_modes = 12
        if parameters_dict and "n_modes" in parameters_dict:
            n_modes = int(parameters_dict["n_modes"])
        elif project.parameters_json:
            try:
                params = json.loads(project.parameters_json)
                n_modes = int(params.get("n_modes", 12))
            except Exception:
                pass

        n_stories = len(model.get("stories", {}))
        # ARPACK requires n_modes < n_DOF strictly.
        # With rigid diaphragms: n_DOF ≈ 3 × n_stories (Ux, Uy, Rz per floor).
        # Keep at least 2 fewer modes than estimated DOF to avoid SIGABRT.
        n_dof_estimate = max(3, 3 * n_stories)
        max_modes = max(2, n_dof_estimate - 2)
        n_modes   = min(n_modes, max_modes)
        print(f"[modal] n_stories={n_stories}, n_dof_est={n_dof_estimate}, n_modes={n_modes}")

        # ── 3. Construir modelo OpenSees ──────────────────────────────────────
        print("[modal] Construyendo modelo OpenSees…")
        import openseespy.opensees as ops
        builder = LinearOPSBuilder(model)
        builder.build()
        print("[modal] Modelo construido")

        # ── 4-11. Eigen + extracción de resultados en proceso aislado ─────────
        # os.fork() aísla los SIGABRT de ARPACK/LAPACK para que no maten el worker.
        modal_raw = _run_eigen_forked(ops, n_modes)
        ops.wipe()

        eigenvalues   = modal_raw["eigenvalues"]
        node_coords   = modal_raw["node_coords"]
        mode_shapes   = modal_raw["mode_shapes"]
        elements_conn = modal_raw["elements"]
        pmx           = modal_raw.get("pmx",  [0.0] * len(eigenvalues))
        pmy           = modal_raw.get("pmy",  [0.0] * len(eigenvalues))
        pmrz          = modal_raw.get("pmrz", [0.0] * len(eigenvalues))
        print(f"[modal] {len(eigenvalues)} eigenvalores calculados")

        # ── 9. Períodos ───────────────────────────────────────────────────────
        periods = []
        for lam in eigenvalues:
            if lam > 0:
                omega = math.sqrt(lam)
                periods.append(2.0 * math.pi / omega)
            else:
                periods.append(0.0)

        # ── 10. Tabla de modos ────────────────────────────────────────────────
        modes_table = []
        cum_ux = cum_uy = cum_rz = 0.0
        for i, T in enumerate(periods):
            px  = pmx[i]  if i < len(pmx)  else 0.0
            py  = pmy[i]  if i < len(pmy)  else 0.0
            prz = pmrz[i] if i < len(pmrz) else 0.0
            cum_ux += px; cum_uy += py; cum_rz += prz
            modes_table.append({
                "mode": i + 1,
                "T":       round(T,   4),
                "Ux_pct":  round(px,  2),
                "Uy_pct":  round(py,  2),
                "Rz_pct":  round(prz, 2),
                "Ux_cum":  round(min(cum_ux, 100.0), 2),
                "Uy_cum":  round(min(cum_uy, 100.0), 2),
                "Rz_cum":  round(min(cum_rz, 100.0), 2),
            })

        # ── 11. Períodos dominantes + viewer ──────────────────────────────────
        T1   = periods[0] if periods else 0.0
        T1_x = _dominant_period(modes_table, "Ux_pct", periods)
        T1_y = _dominant_period(modes_table, "Uy_pct", periods)

        # mode_shapes del hijo ya son str(tag) → ev[:3] (solo CM nodes)
        shapes_viewer = {
            str(m): mode_shapes.get(str(m), {})
            for m in range(1, len(eigenvalues) + 1)
        }

        result = {
            "num_modes":  len(eigenvalues),
            "num_floors": n_stories,
            "T1":   round(T1,   4),
            "T1_x": round(T1_x, 4),
            "T1_y": round(T1_y, 4),
            "modes_table": modes_table,
            "viewer": {
                "nodes":       {str(k): v for k, v in node_coords.items()},
                "mode_shapes": shapes_viewer,
                "elements":    elements_conn,
            },
        }

        # ── 12. Guardar modal_results.json ────────────────────────────────────
        work_dir    = os.path.dirname(os.path.dirname(canonical_path))  # uploads/structural/{pid}/work
        results_dir = os.path.join(work_dir, "results")
        os.makedirs(results_dir, exist_ok=True)

        modal_path = os.path.join(results_dir, "modal_results.json")
        with open(modal_path, "w", encoding="utf-8") as f:
            json.dump(_make_serializable(result), f, ensure_ascii=False, indent=2)
        print(f"[modal] Guardado → {modal_path}")

        # ── 13. Actualizar structural_model.json ──────────────────────────────
        model["analysis_results"]["modal"] = {
            "T1": round(T1, 4), "T1_x": round(T1_x, 4), "T1_y": round(T1_y, 4),
            "num_modes": len(eigenvalues),
        }
        with open(canonical_path, "w", encoding="utf-8") as f:
            json.dump(model, f, ensure_ascii=False, indent=2)

        summary = {
            "T1": round(T1, 4), "T1_x": round(T1_x, 4), "T1_y": round(T1_y, 4),
            "num_modes": len(eigenvalues), "n_stories": n_stories,
        }
        print(f"[modal] T1={T1:.4f}s | T1_x={T1_x:.4f}s | T1_y={T1_y:.4f}s")
        mark_success(db, job_id, modal_path, summary=summary)
        return {"status": "success", **summary}

    except Exception as exc:
        mark_failed(db, job_id, traceback.format_exc())
        raise self.retry(exc=exc, max_retries=0)
    finally:
        db.close()


# ── Helpers ───────────────────────────────────────────────────────────────────

_CM_TAG_OFFSET = 10_000_000  # nodos CM virtuales (ver ops_builder.py)


def _run_eigen_forked(ops, n_modes: int) -> dict:
    """
    Tries each eigen solver in its own forked child process (fork from the parent each time).
    If a solver SIGABRT's the child, the parent's OpenSees state is untouched and the
    next solver is attempted. Celery worker never dies from a solver crash.
    """
    import os
    import signal as _signal
    import tempfile
    import time
    import json as _json

    solvers = [
        ((n_modes,),                     "ARPACK"),
        (("-symmBandLapack", n_modes),   "symmBandLapack"),
        (("-fullGenLapack",  n_modes),   "fullGenLapack"),
    ]

    for solver_args, solver_name in solvers:
        tmp = tempfile.mktemp(suffix=f"_modal_{solver_name}.json")

        pid = os.fork()

        if pid == 0:
            # ── Child: try ONE solver, write everything, exit ──────────────────
            for sig in (_signal.SIGTERM, _signal.SIGINT, _signal.SIGHUP):
                try:
                    _signal.signal(sig, _signal.SIG_DFL)
                except Exception:
                    pass
            try:
                lam = ops.eigen(*solver_args)
                if not lam:
                    os._exit(1)

                all_tags    = ops.getNodeTags()
                cm_tags     = [t for t in all_tags if t >= _CM_TAG_OFFSET]
                viewer_tags = cm_tags if cm_tags else all_tags

                node_coords = {str(t): [float(c) for c in ops.nodeCoord(t)] for t in all_tags}

                mode_shapes: dict[str, dict] = {}
                for mode in range(1, len(lam) + 1):
                    shape: dict[str, list] = {}
                    for tag in viewer_tags:
                        try:
                            ev = ops.nodeEigenvector(tag, mode)
                            shape[str(tag)] = [float(v) for v in ev[:3]]
                        except Exception:
                            shape[str(tag)] = [0.0, 0.0, 0.0]
                    mode_shapes[str(mode)] = shape

                try:
                    mp   = ops.modalProperties("-return")
                    pmx  = [float(v) for v in mp.get("partiMassRatiosMX",  [])]
                    pmy  = [float(v) for v in mp.get("partiMassRatiosMY",  [])]
                    pmrz = [float(v) for v in mp.get("partiMassRatiosRMZ", [])]
                except Exception:
                    n = len(lam)
                    pmx = pmy = pmrz = [0.0] * n

                elements = _get_elements_connectivity(ops)

                payload = {
                    "eigenvalues": [float(l) for l in lam],
                    "node_coords": node_coords,
                    "mode_shapes": mode_shapes,
                    "elements":    elements,
                    "pmx": pmx, "pmy": pmy, "pmrz": pmrz,
                }
                with open(tmp, "w") as f:
                    _json.dump(payload, f)
                os._exit(0)
            except Exception:
                os._exit(1)

        # ── Parent: wait for this child, read result or try next solver ────────
        deadline = time.time() + 300
        while time.time() < deadline:
            finished, status = os.waitpid(pid, os.WNOHANG)
            if finished != 0:
                break
            time.sleep(0.5)
        else:
            try:
                os.kill(pid, _signal.SIGTERM); time.sleep(2)
                os.kill(pid, _signal.SIGKILL); os.waitpid(pid, 0)
            except ProcessLookupError:
                pass
            print(f"[modal] Solver {solver_name}: timeout — intentando siguiente")
            if os.path.exists(tmp):
                os.unlink(tmp)
            continue

        exit_ok = os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0
        exit_info = os.WEXITSTATUS(status) if os.WIFEXITED(status) else "SIGNAL"
        print(f"[modal] Solver {solver_name}: exit={exit_info}")

        if exit_ok and os.path.exists(tmp):
            try:
                with open(tmp) as f:
                    data = _json.load(f)
                os.unlink(tmp)
                return data
            except Exception:
                pass

        if os.path.exists(tmp):
            os.unlink(tmp)

    raise RuntimeError(
        "Todos los solvers eigen fallaron (ARPACK, symmBandLapack, fullGenLapack). "
        "El modelo tiene problemas numéricos severos. "
        "Revisa: (1) juntas sin restricción, (2) secciones con A=0 o E=0, "
        "(3) elementos de longitud cero, (4) advertencias del import_validate."
    )


def _run_eigen(ops, n_modes: int) -> list:
    """Ejecuta ops.eigen() con fallback de solvers.
    ARPACK (default) es el más rápido para modelos grandes.
    fullGenLapack es denso y muy lento — solo como último recurso.
    """
    solvers = [
        (n_modes,),                      # ARPACK — rápido
        ("-symmBandLapack",  n_modes),   # banda simétrica — medio
        ("-fullGenLapack",   n_modes),   # denso — muy lento, último recurso
    ]
    for args in solvers:
        try:
            result = ops.eigen(*args)
            if result:
                return list(result)
        except Exception as e:
            name = args[0] if isinstance(args[0], str) else "ARPACK"
            print(f"[modal] Solver {name} falló: {e}")
    raise RuntimeError("Todos los solvers eigen fallaron. Verifica el modelo.")


def _dominant_period(modes_table: list, key: str, periods: list) -> float:
    """Retorna el período del modo con mayor participación en la dirección 'key'."""
    if not modes_table:
        return 0.0
    best = max(modes_table, key=lambda m: m.get(key, 0.0))
    idx = best["mode"] - 1
    return periods[idx] if idx < len(periods) else 0.0


def _get_elements_connectivity(ops) -> list:
    """Extrae la conectividad de elementos para el visor 3D."""
    elements = []
    try:
        for tag in ops.getEleTags():
            try:
                nodes = ops.eleNodes(tag)
                n = len(nodes)
                if n == 2:
                    elements.append([int(nodes[0]), int(nodes[1])])
                elif n in (4, 8):
                    for i in range(4):
                        elements.append([int(nodes[i]), int(nodes[(i + 1) % 4])])
            except Exception:
                pass
    except Exception as e:
        print(f"[modal] getEleTags: {e}")
    return elements


def _make_serializable(obj):
    """Convierte numpy/inf/nan a tipos JSON-serializables."""
    if isinstance(obj, dict):
        return {k: _make_serializable(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_make_serializable(i) for i in obj]
    if isinstance(obj, np.ndarray):
        return _make_serializable(obj.tolist())
    if isinstance(obj, (np.floating, float)):
        return None if (math.isnan(obj) or math.isinf(obj)) else float(obj)
    if isinstance(obj, (np.integer, int)):
        return int(obj)
    return obj
