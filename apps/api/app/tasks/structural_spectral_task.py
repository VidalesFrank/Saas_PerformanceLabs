"""
Tarea Celery — Módulo 1: Análisis Espectral RSA + Verificación FHE.

Requiere:
  - structural_model.json (canonical_model_path en StructuralProject)
  - modal_results.json   (uploads/.../work/results/modal_results.json)
  - parameters_json del proyecto (SeismicParameters NSR-10)

Flujo:
1. Cargar modelo canónico y resultados modales.
2. SpectralAnalyzer: calcular fuerzas, cortantes, derivas por piso (CQC/SRSS).
3. FHEChecker: verificar Vb_modal ≥ Vb_min y escalar si es necesario.
4. Aplicar escala FHE a fuerzas y cortantes.
5. Guardar spectral_results.json.
6. Actualizar analysis_results.spectral en structural_model.json.
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


@celery_app.task(name="app.tasks.structural_spectral_task.run_spectral", bind=True)
def run_spectral(
    self,
    job_id: str,
    project_id: str,
    input_file: str | None,
    e2k_file: str | None = None,
    parameters_dict: dict | None = None,
    extra_params: dict | None = None,
):
    """Análisis espectral RSA y verificación FHE NSR-10 para el Módulo 1."""
    db = get_db_session()
    try:
        mark_running(db, job_id)

        from app.models import StructuralProject
        from app.engine.building.linear.spectral_analysis import SpectralAnalyzer
        from app.engine.building.linear.fhe import FHEChecker

        # ── 1. Verificar precondiciones ───────────────────────────────────────
        project = db.get(StructuralProject, project_id)
        if not project:
            raise ValueError(f"Proyecto {project_id} no encontrado.")
        if not project.canonical_model_path or not os.path.exists(project.canonical_model_path):
            raise FileNotFoundError(
                "Modelo canónico no encontrado. Ejecuta primero 'Validar modelo'."
            )
        if not project.parameters_json:
            raise ValueError(
                "No hay parámetros sísmicos configurados. "
                "Completa el formulario NSR-10 en la pestaña 'Análisis Sísmico'."
            )

        canonical_path = project.canonical_model_path
        work_dir   = os.path.dirname(os.path.dirname(canonical_path))
        modal_path = os.path.join(work_dir, "results", "modal_results.json")

        if not os.path.exists(modal_path):
            raise FileNotFoundError(
                "Resultados modales no encontrados. Ejecuta primero el 'Análisis Modal'."
            )

        # ── 2. Cargar datos ───────────────────────────────────────────────────
        with open(canonical_path, "r", encoding="utf-8") as f:
            model = json.load(f)
        with open(modal_path, "r", encoding="utf-8") as f:
            modal_results = json.load(f)

        params = parameters_dict or json.loads(project.parameters_json)
        print(f"[spectral] Aa={params.get('Aa')}, Av={params.get('Av')}, "
              f"R={params.get('R')}, método={params.get('combination_method','CQC')}")

        # ── 3. Análisis espectral RSA ─────────────────────────────────────────
        analyzer = SpectralAnalyzer(model, modal_results, params)
        raw = analyzer.analyze()

        print(f"[spectral] Vb_modal_x={raw['_Vb_modal_x_kN']} kN | "
              f"Vb_modal_y={raw['_Vb_modal_y_kN']} kN | "
              f"W={raw['_W_kN']} kN")

        # ── 4. Verificación FHE ───────────────────────────────────────────────
        checker = FHEChecker()
        fhe = checker.check(
            W_kN=raw["_W_kN"],
            Vb_modal_x_kN=raw["_Vb_modal_x_kN"],
            Vb_modal_y_kN=raw["_Vb_modal_y_kN"],
            spectral_params=raw["_spectral_params"],
            seismic_params=params,
        )

        print(f"[spectral] FHE: Vb_min={fhe['Vb_min_x_kN']} kN | "
              f"scale_x={fhe['scale_x']:.3f} | scale_y={fhe['scale_y']:.3f} | "
              f"scaled_x={fhe['scaled_x']} | scaled_y={fhe['scaled_y']}")

        # ── 5. Aplicar escala FHE a fuerzas y cortantes ───────────────────────
        sx = fhe["scale_x"]
        sy = fhe["scale_y"]

        story_forces_x  = {s: round(v * sx, 2) for s, v in raw["story_forces_x"].items()}
        story_forces_y  = {s: round(v * sy, 2) for s, v in raw["story_forces_y"].items()}
        story_shears_x  = {s: round(v * sx, 2) for s, v in raw["story_shears_x"].items()}
        story_shears_y  = {s: round(v * sy, 2) for s, v in raw["story_shears_y"].items()}
        story_drifts    = [
            {**d,
             "drift_x_pct": round(d["drift_x_pct"] * sx, 4),
             "drift_y_pct": round(d["drift_y_pct"] * sy, 4),
             "disp_x_m":   round(d["disp_x_m"] * sx, 5),
             "disp_y_m":   round(d["disp_y_m"] * sy, 5)}
            for d in raw["story_drifts"]
        ]

        # ── 6. Verificación de derivas NSR-10 A.6.3 ───────────────────────────
        DRIFT_LIMIT_PCT = 1.0  # NSR-10: 1% para estructuras convencionales
        max_drift_x = max((d["drift_x_pct"] for d in story_drifts), default=0.0)
        max_drift_y = max((d["drift_y_pct"] for d in story_drifts), default=0.0)
        drift_ok_x  = max_drift_x <= DRIFT_LIMIT_PCT
        drift_ok_y  = max_drift_y <= DRIFT_LIMIT_PCT

        # ── 7. Empaquetar resultado final ─────────────────────────────────────
        result = {
            "spectrum":           raw["spectrum"],
            "spectral_params":    raw["spectral_params"],
            "story_drifts":       story_drifts,
            "story_forces_x":     story_forces_x,
            "story_forces_y":     story_forces_y,
            "story_shears_x":     story_shears_x,
            "story_shears_y":     story_shears_y,
            "fhe":                fhe,
            "combination_method": raw["combination_method"],
            "n_modes_used":       raw["n_modes_used"],
            "mass_participation_x": raw["mass_participation_x"],
            "mass_participation_y": raw["mass_participation_y"],
            "drift_check": {
                "limit_pct":  DRIFT_LIMIT_PCT,
                "max_x_pct":  round(max_drift_x, 4),
                "max_y_pct":  round(max_drift_y, 4),
                "ok_x":       drift_ok_x,
                "ok_y":       drift_ok_y,
            },
        }

        # ── 8. Guardar spectral_results.json ──────────────────────────────────
        results_dir = os.path.join(work_dir, "results")
        os.makedirs(results_dir, exist_ok=True)

        spectral_path = os.path.join(results_dir, "spectral_results.json")
        with open(spectral_path, "w", encoding="utf-8") as f:
            json.dump(_serializable(result), f, ensure_ascii=False, indent=2)
        print(f"[spectral] Guardado → {spectral_path}")

        # ── 9. Actualizar structural_model.json ───────────────────────────────
        model["analysis_results"]["spectral"] = {
            "Vb_final_x_kN": fhe["Vb_final_x_kN"],
            "Vb_final_y_kN": fhe["Vb_final_y_kN"],
            "max_drift_x_pct": round(max_drift_x, 4),
            "max_drift_y_pct": round(max_drift_y, 4),
            "drift_ok": drift_ok_x and drift_ok_y,
            "scaled_x": fhe["scaled_x"],
            "scaled_y": fhe["scaled_y"],
        }
        with open(canonical_path, "w", encoding="utf-8") as f:
            json.dump(model, f, ensure_ascii=False, indent=2)

        # ── 10. Resumen del job ───────────────────────────────────────────────
        summary = {
            "Vb_final_x_kN": fhe["Vb_final_x_kN"],
            "Vb_final_y_kN": fhe["Vb_final_y_kN"],
            "Cs_used":        fhe["Cs_used"],
            "scaled_x":       fhe["scaled_x"],
            "scaled_y":       fhe["scaled_y"],
            "max_drift_x_pct": round(max_drift_x, 4),
            "max_drift_y_pct": round(max_drift_y, 4),
            "drift_ok":       drift_ok_x and drift_ok_y,
            "combination_method": raw["combination_method"],
        }
        mark_success(db, job_id, spectral_path, summary=summary)
        return {"status": "success", **summary}

    except Exception as exc:
        mark_failed(db, job_id, traceback.format_exc())
        raise self.retry(exc=exc, max_retries=0)
    finally:
        db.close()


def _serializable(obj):
    """Convierte numpy / inf / nan a tipos JSON-serializables."""
    if isinstance(obj, dict):
        return {k: _serializable(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_serializable(i) for i in obj]
    if isinstance(obj, np.ndarray):
        return _serializable(obj.tolist())
    if isinstance(obj, (np.floating, float)):
        return None if (math.isnan(obj) or math.isinf(obj)) else float(obj)
    if isinstance(obj, (np.integer, int)):
        return int(obj)
    return obj
