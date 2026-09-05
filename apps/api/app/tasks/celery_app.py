from celery import Celery
from app.config import settings

celery_app = Celery(
    "performancelabs",
    broker=settings.celery_broker_url,
    backend=settings.celery_result_backend,
    include=[
        "app.tasks.archetype_task",
        "app.tasks.modal_task",
        "app.tasks.pushover_task",
        "app.tasks.dynamic_task",
        # Módulo 1 — Constructor de Modelos Estructurales
        "app.tasks.structural_import_task",
        "app.tasks.structural_modal_task",
        "app.tasks.structural_spectral_task",
        "app.tasks.structural_design_task",
        "app.tasks.structural_beam_task",
        "app.tasks.structural_wall_demands_task",
        # Módulo 5 — Análisis de Muros RC 3D
        "app.tasks.wall_analysis_task",
    ],
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="America/Bogota",
    enable_utc=True,
    task_track_started=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
)

# Límites de tiempo por tipo de análisis
celery_app.conf.task_annotations = {
    "app.tasks.archetype_task.run_archetype": {"time_limit": 7200,  "soft_time_limit": 7000},
    "app.tasks.modal_task.run_modal":         {"time_limit": 7200,  "soft_time_limit": 7000},
    "app.tasks.pushover_task.run_pushover":   {"time_limit": 7200,  "soft_time_limit": 7000},
    "app.tasks.dynamic_task.run_dynamic":     {"time_limit": 86400, "soft_time_limit": 86100},
    # Módulo 1
    "app.tasks.structural_import_task.run_import":     {"time_limit": 1800, "soft_time_limit": 1700},
    "app.tasks.structural_modal_task.run_modal":       {"time_limit": 3600, "soft_time_limit": 3500},
    "app.tasks.structural_spectral_task.run_spectral": {"time_limit": 1800, "soft_time_limit": 1700},
    "app.tasks.structural_design_task.run_design_columns": {"time_limit": 600,  "soft_time_limit": 550},
    "app.tasks.structural_beam_task.run_design_beams":         {"time_limit": 600,  "soft_time_limit": 550},
    "app.tasks.structural_wall_demands_task.run_wall_demands": {"time_limit": 900,  "soft_time_limit": 850},
    # Módulo 5
    "app.tasks.wall_analysis_task.run_gravity":            {"time_limit": 1800, "soft_time_limit": 1700},
    "app.tasks.wall_analysis_task.run_modal":              {"time_limit": 900,  "soft_time_limit": 850},
    "app.tasks.wall_analysis_task.run_pushover":           {"time_limit": 7200, "soft_time_limit": 7000},
}
