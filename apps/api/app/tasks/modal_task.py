"""
Tarea Celery — Análisis modal.

Requiere que el arquetipo (archetype) ya haya sido generado.

Flujo:
1. Cargar store_data desde processed_data.json.
2. Reconstruir modelo OpenSees con OPSModelBuilder.
3. Aplicar cargas de gravedad.
4. Ejecutar ops.eigen() con fallback de solvers.
5. Extraer periodos, masas participativas y formas modales.
6. Guardar modal_results.json + modal_results.xlsx + modal_results.pkl.

Salida principal: modal_results.json
"""
import os
import json
import math
import shutil
import pickle
import traceback
import numpy as np

from app.tasks.celery_app import celery_app
from app.tasks._task_helpers import (
    get_db_session, mark_running, mark_success, mark_failed,
    get_engine_building_path, patch_root_path, prepare_work_dir,
)


@celery_app.task(name="app.tasks.modal_task.run_modal", bind=True)
def run_modal(
    self,
    job_id: str,
    project_id: str,
    input_file: str | None,
    parameters_dict: dict | None = None,
):
    db = get_db_session()
    try:
        mark_running(db, job_id)

        import sys
        from app.config import settings

        engine_path = get_engine_building_path()
        if engine_path not in sys.path:
            sys.path.insert(0, engine_path)

        # ── 1. Verificar arquetipo ──────────────────────────────────────────
        archetype_json = os.path.join(settings.output_dir, str(project_id), "archetype", "processed_data.json")
        if not os.path.exists(archetype_json):
            raise FileNotFoundError(
                "No se encontró el arquetipo. Ejecuta primero el análisis 'Modelo Estructural'."
            )
        with open(archetype_json, "r", encoding="utf-8") as f:
            store_data = json.load(f)

        # ── 2. Preparar work_dir ────────────────────────────────────────────
        work_dir = prepare_work_dir(
            project_id=project_id,
            upload_dir=settings.upload_dir,
            input_file=input_file,
            parameters_dict=parameters_dict,
        )

        # ── 3. Parchear y reconstruir modelo ────────────────────────────────
        patch_root_path(work_dir)
        import archetype_1
        import openseespy.opensees as ops

        ops.wipe()
        ops_builder = archetype_1.OPSModelBuilder(store_data, modal_analysis=False)
        ops_builder.builder(work_dir)
        print(f"[modal] Modelo reconstruido — project_id={project_id}")

        # ── 4. Gravedad previa al eigen ─────────────────────────────────────
        try:
            import opseestools.analisis3D as optools_an
            optools_an.gravedad(Tol=1e-4)
            ops.loadConst("-time", 0.0)
        except Exception as eg:
            print(f"[modal] Gravedad omitida: {eg}")

        # ── 5. Eigen con fallback de solvers ────────────────────────────────
        num_modes = _get_num_floors(store_data)
        eigenvalues = _run_eigen(num_modes)
        print(f"[modal] {len(eigenvalues)} eigenvalores calculados")

        # ── 6. Coordenadas de nodos ─────────────────────────────────────────
        node_tags  = ops.getNodeTags()
        node_coords = {tag: [float(c) for c in ops.nodeCoord(tag)] for tag in node_tags}

        # ── 7. Periodos y frecuencias ───────────────────────────────────────
        periods, frequencies = [], []
        for lam in eigenvalues:
            if lam > 0:
                omega = math.sqrt(lam)
                periods.append(2.0 * math.pi / omega)
                frequencies.append(omega / (2.0 * math.pi))
            else:
                periods.append(0.0)
                frequencies.append(0.0)

        # ── 8. Formas modales ───────────────────────────────────────────────
        mode_shapes = {}
        for mode in range(1, num_modes + 1):
            shape = {}
            for tag in node_tags:
                try:
                    ev = ops.nodeEigenvector(tag, mode)
                    shape[tag] = [float(v) for v in ev]
                except Exception:
                    shape[tag] = [0.0, 0.0, 0.0]
            mode_shapes[mode] = shape

        # ── 9. Masas participativas ─────────────────────────────────────────
        try:
            mp = ops.modalProperties("-return")
            pmx  = [float(v) for v in mp.get("partiMassRatiosMX",  [])]
            pmy  = [float(v) for v in mp.get("partiMassRatiosMY",  [])]
            pmrz = [float(v) for v in mp.get("partiMassRatiosRMZ", [])]
        except Exception as e:
            print(f"[modal] modalProperties falló: {e}")
            pmx = pmy = pmrz = []

        # ── 10. Tabla de resultados ─────────────────────────────────────────
        modes_table = []
        cum_ux = cum_uy = cum_rz = 0.0
        for i, T in enumerate(periods):
            px  = pmx[i]  if i < len(pmx)  else 0.0
            py  = pmy[i]  if i < len(pmy)  else 0.0
            prz = pmrz[i] if i < len(pmrz) else 0.0
            cum_ux += px; cum_uy += py; cum_rz += prz
            modes_table.append({
                "mode": i + 1, "T": round(T, 4),
                "Ux_pct": round(px, 2),   "Uy_pct": round(py, 2),   "Rz_pct": round(prz, 2),
                "Ux_cum": round(min(cum_ux, 100.0), 2),
                "Uy_cum": round(min(cum_uy, 100.0), 2),
                "Rz_cum": round(min(cum_rz, 100.0), 2),
            })

        # ── 11. Datos para el visor 3D ──────────────────────────────────────
        shapes_for_viewer = {
            str(m): {str(tag): ev[:3] for tag, ev in mode_shapes[m].items()}
            for m in range(1, num_modes + 1)
        }
        elements_connectivity = _get_elements_connectivity()

        result = {
            "num_modes":   num_modes,
            "num_floors":  num_modes,
            "modes_table": modes_table,
            "viewer": {
                "nodes":       {str(k): v for k, v in node_coords.items()},
                "mode_shapes": shapes_for_viewer,
                "elements":    elements_connectivity,
            },
        }

        # ── 12. Guardar outputs ─────────────────────────────────────────────
        output_dir = os.path.join(settings.output_dir, str(project_id), "modal")
        os.makedirs(output_dir, exist_ok=True)

        json_path = os.path.join(output_dir, "modal_results.json")
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(_make_serializable(result), f, ensure_ascii=False, indent=2)

        pkl_path = os.path.join(output_dir, "modal_results.pkl")
        with open(pkl_path, "wb") as f:
            pickle.dump({
                "modes_table": modes_table, "mode_shapes": mode_shapes,
                "node_coords": node_coords, "eigenvalues": eigenvalues,
                "periods": periods, "frequencies": frequencies,
            }, f)

        _save_modal_excel(modes_table, output_dir)

        summary = {
            "T1": round(periods[0], 4) if periods else None,
            "T2": round(periods[1], 4) if len(periods) > 1 else None,
            "T3": round(periods[2], 4) if len(periods) > 2 else None,
            "num_modes": num_modes,
        }
        print(f"[modal] T1={summary['T1']}s | T2={summary['T2']}s | T3={summary['T3']}s")
        mark_success(db, job_id, json_path, summary=summary)
        return {"status": "success", **summary}

    except Exception as exc:
        mark_failed(db, job_id, traceback.format_exc())
        raise self.retry(exc=exc, max_retries=0)
    finally:
        db.close()


# ── Helpers ───────────────────────────────────────────────────────────────────

def _run_eigen(num_modes: int) -> list:
    import openseespy.opensees as ops
    for args in [("-fullGenLapack", num_modes), ("-symmBandLapack", num_modes), (num_modes,)]:
        try:
            result = ops.eigen(*args)
            if result:
                return result
        except Exception as e:
            print(f"[modal] Solver {args[0] if isinstance(args[0], str) else 'ARPACK'} falló: {e}")
    raise RuntimeError("Todos los solvers eigen fallaron")


def _get_num_floors(store_data: dict) -> int:
    try:
        com = store_data.get("center_of_mass", {})
        if com:
            floors = {
                str(nd.get(k)) for nd in com.values() if isinstance(nd, dict)
                for k in ("floor", "story", "piso", "nivel", "level")
                if nd.get(k) is not None and str(nd.get(k)) not in ("0", "Base", "base", "")
            }
            if floors:
                return len(floors)
    except Exception:
        pass
    try:
        joints = store_data.get("joints", {})
        floors = {
            str(jd.get(k)) for jd in joints.values() if isinstance(jd, dict)
            for k in ("floor", "story", "piso", "nivel", "level")
            if jd.get(k) is not None and str(jd.get(k)) not in ("0", "Base", "base", "")
        }
        if floors:
            return len(floors)
    except Exception:
        pass
    return 9  # valor por defecto


def _get_elements_connectivity() -> list:
    import openseespy.opensees as ops
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


def _save_modal_excel(modes_table: list, output_dir: str) -> None:
    try:
        import pandas as pd
        df = pd.DataFrame(modes_table)
        df.columns = ["Modo", "T (s)", "Ux (%)", "Uy (%)", "Rz (%)", "ΣUx (%)", "ΣUy (%)", "ΣRz (%)"]
        excel_path = os.path.join(output_dir, "modal_results.xlsx")
        with pd.ExcelWriter(excel_path, engine="xlsxwriter") as writer:
            df.to_excel(writer, sheet_name="Análisis Modal", index=False)
            wb = writer.book
            ws = writer.sheets["Análisis Modal"]
            fmt_h = wb.add_format({"bold": True, "align": "center", "fg_color": "#1A6B8A", "font_color": "#FFFFFF", "border": 1})
            fmt_c = wb.add_format({"align": "center", "border": 1, "num_format": "0.0000"})
            ws.set_column("A:A", 8); ws.set_column("B:B", 12); ws.set_column("C:H", 14)
            for col, name in enumerate(df.columns):
                ws.write(0, col, name, fmt_h)
            for row in range(1, len(df) + 1):
                for col in range(len(df.columns)):
                    ws.write(row, col, df.iloc[row - 1, col], fmt_c)
    except Exception as e:
        print(f"[modal] No se pudo guardar Excel: {e}")


def _make_serializable(obj):
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
