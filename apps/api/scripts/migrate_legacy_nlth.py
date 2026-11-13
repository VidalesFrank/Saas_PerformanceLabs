"""Migración: mueve NLTH legacy (en work/results/) a work/nlth/<job_id>/."""
import json
from pathlib import Path
from datetime import datetime
from app.db import SessionLocal
from app.models import StructuralJob, StructuralAnalysisType

db = SessionLocal()
try:
    # Último NLTH success por proyecto
    jobs = db.query(StructuralJob).filter(
        StructuralJob.analysis_type == StructuralAnalysisType.nlth,
        StructuralJob.status == "success",
        StructuralJob.result_path.isnot(None),
    ).order_by(StructuralJob.created_at.desc()).all()

    seen_projects = set()
    migrated = 0
    for job in jobs:
        if job.project_id in seen_projects:
            continue
        seen_projects.add(job.project_id)
        src_json = Path(job.result_path)
        if not src_json.exists() or "work/results/" not in str(src_json):
            continue
        work_dir = src_json.parent.parent  # .../work/results/.. -> .../work
        dst_dir  = work_dir / "nlth" / str(job.id)
        if dst_dir.exists():
            print(f"[skip] {job.id} ya migrado")
            continue
        dst_dir.mkdir(parents=True, exist_ok=True)

        payload = json.loads(src_json.read_text(encoding="utf-8"))
        env     = payload.get("envelope", {})

        (dst_dir / "nlth_results.json").write_bytes(src_json.read_bytes())
        src_npz = work_dir / "results" / "nlth_history.npz"
        if src_npz.exists():
            (dst_dir / "nlth_history.npz").write_bytes(src_npz.read_bytes())

        meta = {
            "job_id":        str(job.id),
            "project_id":    job.project_id,
            "system":        payload.get("system", "frames"),
            "record_x_file": payload.get("record_x_file", "record_x"),
            "record_y_file": payload.get("record_y_file", "record_y"),
            "scale":         payload.get("meta", {}).get("scale", 1.0),
            "dtrec":         payload.get("meta", {}).get("dtrec", 0.0),
            "dt_analysis":   payload.get("meta", {}).get("dt_analysis", 0.005),
            "damping":       payload.get("meta", {}).get("damping", 0.05),
            "record_units":  payload.get("meta", {}).get("record_units", "g"),
            "duration":      payload.get("meta", {}).get("duration_s"),
            "collapse_mode": "ductile",
            "status":        payload.get("status", "success"),
            "max_drift_pct": env.get("max_drift_pct", 0.0),
            "max_roof_m":    env.get("max_roof_disp_total_m", 0.0),
            "pga_x_g":       env.get("pga_x_g", 0.0),
            "pga_y_g":       env.get("pga_y_g", 0.0),
            "Vb_peak_kN":    max(env.get("max_Vb_x_kN", 0.0) or 0.0,
                                 env.get("max_Vb_y_kN", 0.0) or 0.0),
            "residual_drift_pct": env.get("residual_drift_pct", 0.0),
            "t_elapsed_s":   env.get("t_elapsed_s", 0.0),
            "t_target_s":    env.get("t_target_s", 0.0),
            "wall_time_min": (payload.get("runtime") or {}).get("wall_time_min", 0.0),
            "aborted":       bool((payload.get("health") or {}).get("aborted")),
            "abort_reason":  (payload.get("health") or {}).get("abort_reason"),
            "computed_at":   payload.get("computed_at")
                             or (job.finished_at.isoformat() if job.finished_at else datetime.utcnow().isoformat()),
            "migrated_from_legacy": True,
        }
        (dst_dir / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        job.result_path = str(dst_dir / "nlth_results.json")
        migrated += 1
        print(f"[ok]  {job.project_id} :: {job.id} -> {dst_dir}")
    db.commit()
    print(f"\nMigrados: {migrated}")
finally:
    db.close()
