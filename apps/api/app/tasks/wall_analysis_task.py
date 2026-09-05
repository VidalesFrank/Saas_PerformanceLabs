"""
Celery tasks — Módulo 5: Análisis de Muros RC 3D.

Analysis sequence per project:
  1. gravity  → establishes initial stress state
  2. modal    → runs post-gravity eigenvalue analysis
  3. pushover → monotonic DisplacementControl (one Celery task per direction)

Each task writes results to {work_dir}/wall_projects/{project_id}/{job_id}_result.json
and updates WallJob.status / result_path / result_summary in the DB.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from app.tasks.celery_app import celery_app

GRAVITY_ACCEL = 9.81  # m/s²


def _work_dir(project_id: str) -> Path:
    from app.config import settings
    base = Path(getattr(settings, "upload_dir", "/tmp/performancelabs"))
    d    = base / "wall_projects" / project_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def _load_document(project_id: str) -> dict:
    path = _work_dir(project_id) / "wall_project.json"
    if not path.exists():
        raise FileNotFoundError(f"Wall project document not found: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def _mark_job(db, job_id: str, status, result_path=None, summary=None, error=None):
    from app.models import WallJob
    job = db.query(WallJob).filter(WallJob.id == job_id).first()
    if not job:
        return
    job.status = status
    if result_path:
        job.result_path   = str(result_path)
    if summary is not None:
        job.result_summary = summary
    if error is not None:
        job.error_message = str(error)[:4000]
    job.finished_at = datetime.now(timezone.utc)
    db.commit()


# ── Gravity analysis ──────────────────────────────────────────────────────────

@celery_app.task(bind=True, name="app.tasks.wall_analysis_task.run_gravity")
def run_gravity(self, project_id: str, job_id: str):
    from app.db import SessionLocal
    from app.models import WallJob, WallJobStatus
    from app.engine.building.walls.ops_wall_builder import WallAnalysisModel

    db = SessionLocal()
    try:
        job = db.query(WallJob).filter(WallJob.id == job_id).first()
        if not job:
            return {"error": "Job not found"}
        job.status = WallJobStatus.running
        db.commit()

        doc    = _load_document(project_id)
        model  = WallAnalysisModel(doc)
        model.build()

        axial  = doc.get("gravity_loads", {})
        result = model.run_gravity(
            axial_loads_kN={k: float(v) for k, v in axial.items()},
            steps=int(doc.get("analysis", {}).get("gravity_steps", 10)),
        )
        model.wipe()

        res_path = _work_dir(project_id) / f"{job_id}_gravity.json"
        res_path.write_text(json.dumps(result, indent=2), encoding="utf-8")

        status  = WallJobStatus.success if result.get("status") == "success" else WallJobStatus.failed
        summary = {"steps_run": result.get("steps_run", 0)}
        _mark_job(db, job_id, status, res_path, summary)
        return result

    except Exception as exc:
        db.rollback()
        try:
            _mark_job(db, job_id, __import__("app.models", fromlist=["WallJobStatus"]).WallJobStatus.failed,
                      error=str(exc))
        except Exception:
            pass
        raise
    finally:
        db.close()


# ── Modal analysis ────────────────────────────────────────────────────────────

@celery_app.task(bind=True, name="app.tasks.wall_analysis_task.run_modal")
def run_modal(self, project_id: str, job_id: str):
    from app.db import SessionLocal
    from app.models import WallJob, WallJobStatus
    from app.engine.building.walls.ops_wall_builder import WallAnalysisModel

    db = SessionLocal()
    try:
        job = db.query(WallJob).filter(WallJob.id == job_id).first()
        if not job:
            return {"error": "Job not found"}
        job.status = WallJobStatus.running
        db.commit()

        doc   = _load_document(project_id)
        n_modes = int(doc.get("analysis", {}).get("modal_modes", 6))

        model = WallAnalysisModel(doc)
        model.build()
        model.run_gravity(
            axial_loads_kN={k: float(v) for k, v in doc.get("gravity_loads", {}).items()},
            steps=int(doc.get("analysis", {}).get("gravity_steps", 10)),
        )
        result = model.run_modal(n_modes)
        model.wipe()

        res_path = _work_dir(project_id) / f"{job_id}_modal.json"
        res_path.write_text(json.dumps(result, indent=2), encoding="utf-8")

        status = WallJobStatus.success if result.get("status") == "success" else WallJobStatus.failed
        summary = {
            "T1_s": result.get("periods_s", [0])[0] if result.get("periods_s") else 0.0,
            "n_modes": result.get("n_modes", 0),
        }
        _mark_job(db, job_id, status, res_path, summary)
        return result

    except Exception as exc:
        db.rollback()
        try:
            from app.models import WallJobStatus
            _mark_job(db, job_id, WallJobStatus.failed, error=str(exc))
        except Exception:
            pass
        raise
    finally:
        db.close()


# ── Pushover analysis ─────────────────────────────────────────────────────────

@celery_app.task(bind=True, name="app.tasks.wall_analysis_task.run_pushover")
def run_pushover(self, project_id: str, job_id: str, direction: str = "X"):
    from app.db import SessionLocal
    from app.models import WallJob, WallJobStatus
    from app.engine.building.walls.ops_wall_builder import WallAnalysisModel

    db = SessionLocal()
    try:
        job = db.query(WallJob).filter(WallJob.id == job_id).first()
        if not job:
            return {"error": "Job not found"}
        job.status         = WallJobStatus.running
        job.push_direction = direction
        db.commit()

        doc = _load_document(project_id)
        a   = doc.get("analysis", {})

        target_drift = float(a.get("target_drift_pct",          2.0))
        inc_m        = float(a.get("displacement_increment_m", 0.001))

        model = WallAnalysisModel(doc)
        model.build()
        model.run_gravity(
            axial_loads_kN={k: float(v) for k, v in doc.get("gravity_loads", {}).items()},
            steps=int(a.get("gravity_steps", 10)),
        )

        res_path = _work_dir(project_id) / f"{job_id}_pushover_{direction.replace('-','m')}.json"
        result = model.run_pushover(
            direction=direction,
            target_drift_pct=target_drift,
            inc_m=inc_m,
            result_path=res_path,
        )
        model.wipe()

        s = result.get("summary", {})
        status = WallJobStatus.success if result["status"] == "success" else (
            WallJobStatus.success if result["status"] == "partial" else WallJobStatus.failed
        )
        summary = {
            "direction":         direction,
            "max_drift_pct":     s.get("max_drift_pct", 0.0),
            "max_base_shear_kN": s.get("max_base_shear_kN", 0.0),
            "converged_steps":   result.get("converged_steps", 0),
            "status":            result["status"],
        }
        _mark_job(db, job_id, status, res_path, summary)
        return result

    except Exception as exc:
        db.rollback()
        try:
            from app.models import WallJobStatus
            _mark_job(db, job_id, WallJobStatus.failed, error=str(exc))
        except Exception:
            pass
        raise
    finally:
        db.close()
