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
    # Dinámico: hasta 24 h (22 pares × múltiples escalas IDA)
    "app.tasks.dynamic_task.run_dynamic":     {"time_limit": 86400, "soft_time_limit": 86100},
}
