"""
Utilidades compartidas por todas las tareas Celery del módulo building.
Gestión de sesiones DB y transiciones de estado de BuildingJob.
"""
import os
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.db import SessionLocal
from app.models import BuildingJob, BuildingJobStatus


# Mapeo clave JSON → nombre en español que espera ImportParametersData de archetype_1
_PARAM_NAMES = [
    ("proyect_name",       "Nombre del proyecto"),
    ("city",               "Ciudad"),
    ("soil_type",          "Tipo Perfil de Suelo"),
    ("edification_use",    "Grupo de Uso"),
    ("construction_year",  "Año de Construcción"),
    ("code",               "Norma Aplicada"),
    ("structure_system",   "Sistema Estructural"),
    ("confined_elements",  "Elementos Confinados"),
    ("energy_dissipation", "Capacidad de Disipación de Energía"),
    ("integration_points", "Puntos de Integración"),
    ("load_case",          "Combinación Carga de Servicio"),
    ("cm_load",            "Super Dead Load Pattern Name"),
    ("cv_load",            "Live Load Pattern Name"),
    ("shell_craking",      "Agrietamiento de las Losas"),
    ("rebar_type",         "Refuerzo de los Elementos"),
]


def get_db_session() -> Session:
    return SessionLocal()


def mark_running(db: Session, job_id: str) -> None:
    job = db.get(BuildingJob, job_id)
    if job:
        job.status = BuildingJobStatus.running
        db.commit()


def mark_success(db: Session, job_id: str, result_path: str, summary: dict | None = None) -> None:
    job = db.get(BuildingJob, job_id)
    if job:
        job.status = BuildingJobStatus.success
        job.result_path = result_path
        job.result_summary = summary
        job.finished_at = datetime.now(timezone.utc)
        db.commit()


def mark_failed(db: Session, job_id: str, error_message: str) -> None:
    job = db.get(BuildingJob, job_id)
    if job:
        job.status = BuildingJobStatus.failed
        job.error_message = error_message[:4000]
        job.finished_at = datetime.now(timezone.utc)
        db.commit()


def write_parameters_excel(params: dict, output_path: str) -> None:
    """Genera input_parameters.xlsx desde el dict de parámetros del proyecto."""
    import openpyxl
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Parametros"
    for key, spanish_name in _PARAM_NAMES:
        ws.append([spanish_name, params.get(key, "")])
    wb.save(output_path)


def get_engine_building_path() -> str:
    """Retorna la ruta absoluta al directorio engine/building."""
    return os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "engine", "building")
    )


def patch_root_path(work_dir: str) -> None:
    """
    Aplica el root_path al módulo archetype_1 y sus submódulos importados.
    archetype_1 usa una variable global `root_path` para construir todas las
    rutas internas — debe ser parcheada antes de instanciar cualquier clase.
    """
    import sys
    import types
    import importlib

    engine_path = get_engine_building_path()
    if engine_path not in sys.path:
        sys.path.insert(0, engine_path)

    # Reimportar para asegurar que el módulo está cargado
    if "archetype_1" not in sys.modules:
        importlib.import_module("archetype_1")

    archetype_1 = sys.modules["archetype_1"]
    archetype_1.root_path = work_dir

    for name, obj in vars(archetype_1).items():
        if isinstance(obj, types.ModuleType) and hasattr(obj, "root_path"):
            obj.root_path = work_dir


def prepare_work_dir(project_id: str, upload_dir: str, input_file: str,
                     parameters_dict: dict | None = None,
                     parameters_file: str | None = None) -> str:
    """
    Construye el work_dir con la estructura exacta que espera archetype_1:
        work_dir/
          data/database/input_model.xlsx
          data/temp/csi_tables/input_model.xlsx
          data/temp/csi_tables/input_parameters.xlsx
          data/process/json/
          outputs/

    Retorna la ruta al work_dir creado.
    """
    import shutil

    work_dir       = os.path.join(upload_dir, str(project_id), "work")
    database_dir   = os.path.join(work_dir, "data", "database")
    csi_tables_dir = os.path.join(work_dir, "data", "temp", "csi_tables")
    process_dir    = os.path.join(work_dir, "data", "process", "json")
    outputs_dir    = os.path.join(work_dir, "outputs")

    for d in [database_dir, csi_tables_dir, process_dir, outputs_dir]:
        os.makedirs(d, exist_ok=True)

    if input_file and os.path.exists(input_file):
        shutil.copy(input_file, os.path.join(database_dir,   "input_model.xlsx"))
        shutil.copy(input_file, os.path.join(csi_tables_dir, "input_model.xlsx"))

    if parameters_dict:
        params_xlsx = os.path.join(csi_tables_dir, "input_parameters.xlsx")
        write_parameters_excel(parameters_dict, params_xlsx)
        shutil.copy(params_xlsx, os.path.join(database_dir, "input_parameters.xlsx"))
    elif parameters_file and os.path.exists(parameters_file):
        shutil.copy(parameters_file, os.path.join(csi_tables_dir, "input_parameters.xlsx"))
        shutil.copy(parameters_file, os.path.join(database_dir,   "input_parameters.xlsx"))

    return work_dir
