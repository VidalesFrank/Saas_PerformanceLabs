"""
Tarea Celery — Módulo 1: Importar, Validar y Construir el Modelo Canónico.

Flujo:
1. Si existe .e2k: convertir a XLSX mediante E2KParser (reutilizado de Módulo 3).
2. Si el XLSX es de ETABS 23: adaptar a formato ETABS 17.
3. Leer tablas con pandas (sin depender de archetype_1).
4. Ejecutar DataValidator → ValidationReport.
5. Si no hay errores críticos: CanonicalModelBuilder → structural_model.json.
6. Guardar validation_report.json como resultado del job.
7. Actualizar validation_status y canonical_model_path en el proyecto.
"""
import json
import os
import shutil
import sys
import traceback

from app.tasks.celery_app import celery_app
from app.tasks.structural_helpers import (
    get_db_session, mark_running, mark_success, mark_failed,
    update_project_validation, prepare_work_dir,
)


def _get_engine_building_path() -> str:
    return os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "engine", "building")
    )


def _load_raw_data(xlsx_path: str) -> tuple[dict, list[str]]:
    """
    Lee todas las tablas ETABS del XLSX.
    Retorna (raw_data dict, sheet_names list).
    El raw_data usa las mismas claves TABLE:... que ImportCSIData de archetype_1.
    """
    import pandas as pd

    TABLE_MAP = {
        'Objects and Elements - Joints':    'TABLE:  "OBJECTS AND ELEMENTS - JOINTS"',
        'Objects and Elements - Frames':    'TABLE:  "OBJECTS AND ELEMENTS - FRAMES"',
        'Objects and Elements - Shells':    'TABLE:  "OBJECTS AND ELEMENTS - SHELLS"',
        'Floor Connectivity':               'TABLE:  "FLOOR CONNECTIVITY"',
        'Material Properties - Concrete':   'TABLE:  "MATERIAL PROPERTIES - CONCRETE"',
        'Mass Summary by Diaphragm':        'TABLE:  "MASS SUMMARY BY DIAPHRAGM"',
        'Joint Assignments - Diaphragms':   'TABLE:  "JOINT ASSIGNMENTS - DIAPHRAGMS"',
        'Joint Assignments - Restraints':   'TABLE:  "JOINT ASSIGNMENTS - RESTRAINTS"',
        'Frame Sections':                   'TABLE:  "FRAME SECTIONS"',
        'Frame Assignments - Sections':     'TABLE:  "FRAME ASSIGNMENTS - SECTIONS"',
        'Frame Assignments - Local Axes':   'TABLE:  "FRAME ASSIGNMENTS - LOCAL AXES"',
        'Frame Assignments - Offsets':      'TABLE:  "FRAME ASSIGNMENTS - OFFSETS"',
        'Frame Loads - Distributed':        'TABLE:  "FRAME LOADS - DISTRIBUTED"',
        'Shell Assignments - Sections':     'TABLE:  "SHELL ASSIGNMENTS - SECTIONS"',
        'Shell Sections - Slab':            'TABLE:  "SHELL SECTIONS - SLAB"',
        'Shell Loads - Uniform':            'TABLE:  "SHELL LOADS - UNIFORM"',
        'Shell Sections - Wall':            'TABLE:  "SHELL SECTIONS - WALL"',
        'Pier Section Properties':          'TABLE:  "PIER SECTION PROPERTIES"',
        'Shell Assignments - Pier Spandr':  'TABLE:  "SHELL ASSIGNMENTS - PIER SPANDR"',
        'Concrete Column Rebar Data':       'TABLE:  "CONCRETE COLUMN REBAR DATA"',
        'Concrete Beam Rebar Data':         'TABLE:  "CONCRETE BEAM REBAR DATA"',
    }

    xl = pd.ExcelFile(xlsx_path)
    sheet_names = xl.sheet_names
    raw_data = {}

    for sheet, key in TABLE_MAP.items():
        if sheet not in sheet_names:
            raw_data[key] = None
            continue

        df = pd.read_excel(xl, sheet_name=sheet, skiprows=1, header=0)
        units_row = df.iloc[0] if len(df) > 0 else pd.Series(dtype=object)
        df = df.drop(index=0).reset_index(drop=True)

        # Normalizar Frame Sections: E17 exporta cm²/cm⁴, el adaptador E23 ya da m²/m⁴.
        # Se lee la fila de unidades para saber qué conversión aplicar.
        if sheet == 'Frame Sections':
            area_unit = str(units_row.get('Area', 'm2') or 'm2').lower()
            if 'cm' in area_unit:
                # 1 cm² = 1e-4 m²,  1 cm⁴ = 1e-8 m⁴
                for col, factor in [('Area', 1e4), ('I33', 1e8), ('I22', 1e8), ('J', 1e8)]:
                    if col in df.columns:
                        df[col] = pd.to_numeric(df[col], errors='coerce') / factor

        raw_data[key] = df

    return raw_data, sheet_names


@celery_app.task(name="app.tasks.structural_import_task.run_import", bind=True)
def run_import(
    self,
    job_id: str,
    project_id: str,
    input_file: str | None,
    e2k_file: str | None = None,
    parameters_dict: dict | None = None,
    extra_params: dict | None = None,
):
    """
    Importa el modelo ETABS, lo valida y construye el modelo canónico JSON.
    """
    db = get_db_session()
    try:
        mark_running(db, job_id)

        engine_path = _get_engine_building_path()
        if engine_path not in sys.path:
            sys.path.insert(0, engine_path)

        from app.config import settings

        # ── 1. Convertir .e2k → XLSX si se suministró ────────────────────────
        if e2k_file and os.path.exists(e2k_file):
            from e2k_parser import E2KParser
            generated_xlsx = os.path.join(
                settings.upload_dir, "structural", str(project_id), "e2k",
                "input_model_generated.xlsx"
            )
            os.makedirs(os.path.dirname(generated_xlsx), exist_ok=True)
            parser = E2KParser(e2k_file)
            parser.parse()
            parser.write_xlsx(generated_xlsx)
            print(f"[import] .e2k convertido → {generated_xlsx}")
            input_file = generated_xlsx

        if not input_file or not os.path.exists(input_file):
            raise FileNotFoundError("No se encontró el archivo de modelo de entrada.")

        # ── 2. Adaptar ETABS 23 → ETABS 17 si es necesario ──────────────────
        from etabs_adapter import detect_version, adapt_e23_to_e17
        if detect_version(input_file) == "23":
            adapted_path = os.path.join(
                settings.upload_dir, "structural", str(project_id), "adapted",
                "input_model_e17.xlsx"
            )
            os.makedirs(os.path.dirname(adapted_path), exist_ok=True)
            adapt_e23_to_e17(input_file, adapted_path)
            print(f"[import] ETABS23 adaptado → {adapted_path}")
            input_file = adapted_path

        # ── 3. Preparar work_dir ──────────────────────────────────────────────
        work_dir = prepare_work_dir(project_id, settings.upload_dir)
        results_dir   = os.path.join(work_dir, "results")
        canonical_dir = os.path.join(work_dir, "canonical")

        # Copiar el xlsx normalizado al work_dir
        shutil.copy(input_file, os.path.join(work_dir, "input", "input_model.xlsx"))

        # ── 4. Leer tablas ETABS ─────────────────────────────────────────────
        print(f"[import] Leyendo tablas ETABS desde {input_file}")
        raw_data, sheet_names = _load_raw_data(input_file)

        # ── 5. Validar ───────────────────────────────────────────────────────
        from app.engine.building.linear.validator import DataValidator
        print(f"[import] Ejecutando DataValidator (hojas encontradas: {len(sheet_names)})")
        validator = DataValidator()
        report = validator.validate(raw_data, sheet_names)
        print(f"[import] Validación: {report.validation_status}, "
              f"críticos={len(report.critical)}, advertencias={len(report.warnings)}")

        # Guardar reporte de validación
        report_path = os.path.join(results_dir, "validation_report.json")
        with open(report_path, "w", encoding="utf-8") as f:
            json.dump(report.to_dict(), f, ensure_ascii=False, indent=2)

        # ── 6. Construir modelo canónico (si no hay errores críticos) ────────
        canonical_model_path = None
        if not report.has_critical:
            from app.engine.building.linear.model_builder import CanonicalModelBuilder
            print(f"[import] Construyendo modelo canónico...")
            builder = CanonicalModelBuilder(raw_data)
            model = builder.build()

            canonical_model_path = os.path.join(canonical_dir, "structural_model.json")
            with open(canonical_model_path, "w", encoding="utf-8") as f:
                json.dump(model, f, ensure_ascii=False, indent=2)
            print(f"[import] Modelo canónico guardado → {canonical_model_path}")

        # ── 7. Actualizar proyecto ───────────────────────────────────────────
        update_project_validation(
            db=db,
            project_id=project_id,
            validation_status=report.validation_status,
            canonical_model_path=canonical_model_path,
        )

        # Resumen para el result_summary del job
        summary = {
            "validation_status": report.validation_status,
            "n_critical": len(report.critical),
            "n_warnings": len(report.warnings),
        }
        if report.model_summary:
            summary.update(report.model_summary.to_dict())

        mark_success(db, job_id, report_path, summary=summary)
        return {"status": "success", "validation_status": report.validation_status}

    except Exception as exc:
        mark_failed(db, job_id, traceback.format_exc())
        raise self.retry(exc=exc, max_retries=0)
    finally:
        db.close()
