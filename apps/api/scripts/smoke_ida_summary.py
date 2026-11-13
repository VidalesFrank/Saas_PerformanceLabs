"""Smoke test del summary enriquecido IDA (Ola A).

Corre dentro del container worker:
    docker exec saas_performancelabs-worker-1 python /app/scripts/smoke_ida_summary.py
"""
import json
from app.tasks.structural_nlth_task import _extract_ida_summary

n = 10
payload = {
    "status": "success",
    "stories_z": [i * 3.0 for i in range(1, n + 1)],
    "envelope": {
        "max_drift_pct": 1.85,
        "max_drift_x_pct": 1.85,
        "max_drift_y_pct": 1.42,
        "max_roof_disp_total_m": 0.165,
        "max_Vb_x_kN": 2150.5,
        "max_Vb_y_kN": 1780.3,
        "Vb_peak_kN": 2150.5,
        "max_drift_by_story_x": [0.3, 0.7, 1.2, 1.5, 1.8, 1.85, 1.7, 1.4, 1.0, 0.6],
        "max_drift_by_story_y": [0.25, 0.6, 1.0, 1.3, 1.4, 1.42, 1.3, 1.1, 0.8, 0.5],
        "max_abs_accel_by_story_x_mps2": [5.5, 6.2, 7.1, 8.0, 8.8, 9.5, 10.1, 10.7, 11.2, 11.5],
        "max_abs_accel_by_story_y_mps2": [5.2, 5.9, 6.7, 7.6, 8.3, 9.0, 9.6, 10.1, 10.6, 10.9],
        "max_disp_by_story_x_m": [0.01, 0.025, 0.05, 0.07, 0.095, 0.12, 0.14, 0.15, 0.16, 0.165],
        "max_disp_by_story_y_m": [0.008, 0.02, 0.04, 0.055, 0.075, 0.095, 0.11, 0.12, 0.13, 0.135],
        "accel_amplification_by_story_x": [1.1, 1.25, 1.4, 1.6, 1.75, 1.9, 2.0, 2.1, 2.2, 2.3],
        "accel_amplification_by_story_y": [1.05, 1.2, 1.35, 1.55, 1.7, 1.85, 1.95, 2.05, 2.15, 2.25],
        "pga_x_g": 0.512, "pga_y_g": 0.48, "pga_vector_g": 0.702,
        "residual_drift_pct": 0.42, "residual_drift_x_pct": 0.42, "residual_drift_y_pct": 0.35,
        "residual_drift_by_story_x_pct": [0.05, 0.12, 0.22, 0.3, 0.38, 0.42, 0.38, 0.3, 0.2, 0.1],
        "residual_drift_by_story_y_pct": [0.04, 0.1, 0.18, 0.25, 0.3, 0.35, 0.3, 0.25, 0.18, 0.08],
        "t_elapsed_s": 40.0, "t_target_s": 40.0,
    },
    "damage": {
        "hinges": [
            {"fid": "C1", "kind": "column", "story": "P03", "theta_p_max": 0.008, "damage_level": "LS"},
            {"fid": "C2", "kind": "column", "story": "P03", "theta_p_max": 0.006, "damage_level": "IO"},
            {"fid": "B1", "kind": "beam",   "story": "P04", "theta_p_max": 0.012, "damage_level": "CP"},
            {"fid": "B2", "kind": "beam",   "story": "P05", "theta_p_max": 0.005, "damage_level": "IO"},
        ],
    },
    "health": {"aborted": False},
}

s = _extract_ida_summary(payload)
raw = json.dumps(s, indent=2)
print(f"keys:                     {len(s)}")
print(f"size enriquecido:         {len(raw)} bytes (~{len(raw)/1024:.1f} KB)")
print(f"critical_story_idx:       {s['critical_story_idx']}")
print(f"critical_story_drift_pct: {s['critical_story_drift_pct']}")
print(f"residual_drift_pct:       {s['residual_drift_pct']}")
print(f"pga_vector_g:             {s['pga_vector_g']}")
print(f"n_stories perfil:         {len(s['max_drift_by_story_x_pct'])}")
print(f"hinges_by_story:          {json.dumps(s['hinges_by_story'], indent=2)}")
print(f"\n→ 22 pares × 10 niveles = 220 archivos × {len(raw)} bytes ≈ {220 * len(raw) / 1024:.0f} KB total")
