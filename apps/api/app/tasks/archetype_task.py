"""
Tarea Celery — Generación del modelo estructural OpenSees (archetype).

Flujo:
1. Si existe .e2k: convertir a XLSX mediante E2KParser.
2. Si el XLSX es de ETABS 23: adaptar a formato ETABS 17.
3. Preparar work_dir con la estructura que espera archetype_1.
4. Ejecutar StoreDataBuilder → OPSModelBuilder.
5. Serializar store_data a JSON y guardar en outputs/{project_id}/archetype/.

Salida: processed_data.json
"""
import os
import json
import traceback
import shutil

from app.tasks.celery_app import celery_app
from app.tasks._task_helpers import (
    get_db_session, mark_running, mark_success, mark_failed,
    get_engine_building_path, patch_root_path, prepare_work_dir,
)


@celery_app.task(name="app.tasks.archetype_task.run_archetype", bind=True)
def run_archetype(
    self,
    job_id: str,
    project_id: str,
    input_file: str | None,
    parameters_dict: dict | None = None,
    e2k_file: str | None = None,
    rebar_file: str | None = None,
):
    db = get_db_session()
    try:
        mark_running(db, job_id)

        import sys
        from app.config import settings

        engine_path = get_engine_building_path()
        if engine_path not in sys.path:
            sys.path.insert(0, engine_path)

        # ── 1. Convertir .e2k → XLSX si se suministró ──────────────────────
        if e2k_file and os.path.exists(e2k_file):
            from e2k_parser import E2KParser
            generated_xlsx = os.path.join(
                settings.upload_dir, str(project_id), "e2k", "input_model_generated.xlsx"
            )
            os.makedirs(os.path.dirname(generated_xlsx), exist_ok=True)
            parser = E2KParser(e2k_file)
            parser.parse()
            parser.write_xlsx(generated_xlsx, supplemental_xlsx_path=rebar_file)
            print(f"[archetype] .e2k convertido → {generated_xlsx}")
            input_file = generated_xlsx

        # ── 2. Adaptar ETABS 23 → ETABS 17 si es necesario ─────────────────
        if input_file and os.path.exists(input_file):
            from etabs_adapter import detect_version, adapt_e23_to_e17
            if detect_version(input_file) == "23":
                adapted_path = os.path.join(
                    settings.upload_dir, str(project_id), "adapted", "input_model_e17.xlsx"
                )
                os.makedirs(os.path.dirname(adapted_path), exist_ok=True)
                adapt_e23_to_e17(input_file, adapted_path)
                print(f"[archetype] ETABS23 adaptado → {adapted_path}")
                input_file = adapted_path

        # ── 3. Preparar estructura de directorios ───────────────────────────
        work_dir = prepare_work_dir(
            project_id=project_id,
            upload_dir=settings.upload_dir,
            input_file=input_file,
            parameters_dict=parameters_dict,
        )

        # ── 4. Parchear root_path y ejecutar el motor ───────────────────────
        patch_root_path(work_dir)

        import archetype_1
        from utilities import convertir_a_serializable

        StoreDataBuilder = archetype_1.StoreDataBuilder
        OPSModelBuilder  = archetype_1.OPSModelBuilder

        print(f"[archetype] Iniciando StoreDataBuilder project_id={project_id}")
        store_data = StoreDataBuilder().run_batch_store()
        print(f"[archetype] StoreDataBuilder completado")

        ops_builder = OPSModelBuilder(store_data, modal_analysis=True)
        ops_builder.builder(work_dir)
        print(f"[archetype] OPSModelBuilder completado")

        # ── 5. Guardar resultado JSON ────────────────────────────────────────
        output_dir = os.path.join(settings.output_dir, str(project_id), "archetype")
        os.makedirs(output_dir, exist_ok=True)
        result_path = os.path.join(output_dir, "processed_data.json")

        with open(result_path, "w", encoding="utf-8") as f:
            json.dump(convertir_a_serializable(store_data), f, ensure_ascii=False, indent=2)

        print(f"[archetype] Guardado en {result_path}")
        mark_success(db, job_id, result_path, summary={"project_id": project_id})
        return {"status": "success", "result_path": result_path}

    except Exception as exc:
        mark_failed(db, job_id, traceback.format_exc())
        raise self.retry(exc=exc, max_retries=0)
    finally:
        db.close()
