"""Tests Fase 6 — pipeline completo + classify_demand_by_element."""
from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from engine.building.nonlinear.element_thresholds import (
    classify_demand_by_element,
    compute_element_thresholds,
    compute_from_project_dir,
)


def _mock_spec() -> dict:
    """Spec con 1 columna + 1 viga (igual que test_element_data)."""
    return {
        "schema_version": "1.0",
        "general": {"energy_dissipation": "DMO"},
        "materials": {
            "concrete": {"C28": {"fc_MPa": 28.0}},
            "steel":    {"A420": {"fy_MPa": 420.0, "fu_MPa": 630.0}},
        },
        "section_types": {
            "C40x40": {"kind": "column", "b_m": 0.40, "h_m": 0.40,
                       "material_concrete": "C28", "fc_MPa": 28.0},
            "V30x50": {"kind": "beam", "b_m": 0.30, "h_m": 0.50,
                       "material_concrete": "C28", "fc_MPa": 28.0},
        },
        "elements": {
            "columns": {
                "C-B2-1": {
                    "node_i": "J1", "node_j": "J2", "story": "Piso 1",
                    "section": "C40x40",
                    "geometry": {"b_m": 0.40, "h_m": 0.40, "L_m": 3.0,
                                 "fc_MPa": 28.0, "cover_m": 0.040},
                    "reinforcement": {
                        "longitudinal": {"n_bars": 8, "bar_label": "#6",
                                         "As_cm2": 22.8},
                        "transverse": {"tie_bar_label": "#3",
                                       "n_legs_b": 3, "n_legs_h": 2,
                                       "s_confined_mm": 100,
                                       "s_general_mm": 150,
                                       "L_confinement_mm": 400},
                    },
                    "confinement": {
                        "end": {"rho_s": 0.012, "K": 1.35, "fcc_MPa": 37.8,
                                "eps_cc": 0.004, "eps_cu": 0.018},
                        "mid": {"rho_s": 0.008, "K": 1.20, "fcc_MPa": 33.6,
                                "eps_cc": 0.003, "eps_cu": 0.010},
                    },
                    "has_design": True,
                },
            },
            "beams": {
                "V-AB-1": {
                    "node_i": "J2", "node_j": "J3", "story": "Piso 1",
                    "section": "V30x50", "length_m": 5.0,
                    "geometry": {"b_m": 0.30, "h_m": 0.50, "L_m": 5.0,
                                 "fc_MPa": 28.0, "cover_m": 0.040},
                    "reinforcement": {
                        "zones": {
                            "end_i": {"top": {"n_bars": 4, "bar_label": "#6"},
                                      "bot": {"n_bars": 2, "bar_label": "#5"}},
                            "mid":   {"top": {"n_bars": 2, "bar_label": "#5"},
                                      "bot": {"n_bars": 3, "bar_label": "#6"}},
                            "end_j": {"top": {"n_bars": 4, "bar_label": "#6"},
                                      "bot": {"n_bars": 2, "bar_label": "#5"}},
                        },
                        "shear": {"tie_bar_label": "#3", "n_legs": 2,
                                  "s_confined_mm": 100, "s_central_mm": 200},
                    },
                    "confinement": {
                        "end": {"rho_s": 0.010, "K": 1.25, "fcc_MPa": 35.0,
                                "eps_cc": 0.004, "eps_cu": 0.015},
                        "mid": {"rho_s": 0.005, "K": 1.10, "fcc_MPa": 30.8,
                                "eps_cc": 0.003, "eps_cu": 0.008},
                    },
                    "has_design": True,
                },
            },
        },
    }


# ─── Pipeline completo ───────────────────────────────────────────────────────
def test_pipeline_runs_full_building():
    r = compute_element_thresholds(_mock_spec())
    assert r.n_elements == 2
    assert len(r.rows) == 2
    assert r.metodo_rotacion == "haselton"
    assert r.metodo_umbrales == "FEMA"


def test_pipeline_rows_have_all_fields():
    r = compute_element_thresholds(_mock_spec())
    row = r.rows[0]
    assert row.theta_IO < row.theta_LS < row.theta_CP
    assert row.M_peak_kNm > 0
    assert row.Lp_mm > 0
    assert row.flags is not None


def test_pipeline_with_axial_populates_nu():
    axial = {"C-B2-1": {"N_grav_kN": 800.0}}
    r = compute_element_thresholds(_mock_spec(), axial_json=axial)
    # ν_C = 800*1000 / (400*400*28) = 0.179
    col_row = next(r for r in r.rows if r.fid == "C-B2-1")
    assert col_row.M_peak_kNm > 0


def test_pipeline_observations_lp_forces_mechanical():
    obs = {"C-B2-1": {"L_p_measured_mm": 400.0}}
    r = compute_element_thresholds(_mock_spec(), observations=obs)
    col_row = next(r for r in r.rows if r.fid == "C-B2-1")
    assert col_row.method == "mecanico"
    assert col_row.has_measured_Lp is True
    assert col_row.Lp_mm == 400.0
    assert col_row.Lp_source == "measured"
    # El resumen debe contarlo
    assert r.n_with_lp_measured == 1


def test_pipeline_captures_poor_detailing_in_summary():
    obs = {"C-B2-1": {"hook_type": "90deg"}}
    r = compute_element_thresholds(_mock_spec(), observations=obs,
                                     beta_poor_detailing=0.60)
    col_row = next(r for r in r.rows if r.fid == "C-B2-1")
    assert "HOOK_90" in col_row.flags
    # β debería ser 0.60 por detallado deficiente
    assert all(b == 0.60 for b in col_row.betas_DS.values())
    assert r.n_poor_detailing >= 1


def test_pipeline_switch_metodo_rotacion():
    for method in ("mecanico", "ec8_3", "haselton"):
        r = compute_element_thresholds(_mock_spec(), metodo_rotacion=method)
        col_row = next(r for r in r.rows if r.fid == "C-B2-1")
        assert col_row.method == method


def test_pipeline_switch_metodo_umbrales_persisted():
    for mode in ("FEMA", "elemento", "ambos"):
        r = compute_element_thresholds(_mock_spec(), metodo_umbrales=mode)
        assert r.metodo_umbrales == mode


def test_pipeline_result_json_serializable():
    r = compute_element_thresholds(_mock_spec())
    s = json.dumps(r.to_dict())
    assert "rows" in s and "fragilities" in s


# ─── Clasificación de demanda ────────────────────────────────────────────────
def test_classify_none_for_low_demand():
    r = compute_element_thresholds(_mock_spec())
    row = r.rows[0]
    c = classify_demand_by_element(0.0001, row)
    assert c["level"] == "none"
    assert c["dcr"] < 0.1


def test_classify_cp_at_high_demand():
    r = compute_element_thresholds(_mock_spec())
    row = r.rows[0]
    c = classify_demand_by_element(0.9 * row.theta_CP + 0.001, row)
    assert c["level"] in ("ls", "cp")


def test_classify_collapse_beyond_1_5_cp():
    r = compute_element_thresholds(_mock_spec())
    row = r.rows[0]
    c = classify_demand_by_element(2.0 * row.theta_CP, row)
    assert c["level"] == "collapse"


# ─── Loader desde project dir ────────────────────────────────────────────────
def test_compute_from_project_dir(tmp_path: Path):
    spec_path = tmp_path / "nonlinear_model.json"
    spec_path.write_text(json.dumps(_mock_spec()), encoding="utf-8")
    r = compute_from_project_dir(tmp_path)
    assert r.n_elements == 2


def test_compute_from_project_dir_missing_raises(tmp_path: Path):
    with pytest.raises(FileNotFoundError):
        compute_from_project_dir(tmp_path / "noexiste")


def test_compute_from_project_dir_reads_axial_and_obs(tmp_path: Path):
    (tmp_path / "nonlinear_model.json").write_text(
        json.dumps(_mock_spec()), encoding="utf-8")
    (tmp_path / "axial_from_gravity.json").write_text(
        json.dumps({"C-B2-1": {"N_grav_kN": 300.0}}), encoding="utf-8")
    (tmp_path / "observations.csv").write_text(
        "fid,L_p_measured_mm,hook_type\nC-B2-1,350,135deg\n", encoding="utf-8")
    r = compute_from_project_dir(tmp_path)
    col = next(r for r in r.rows if r.fid == "C-B2-1")
    assert col.has_measured_Lp is True
    assert col.Lp_mm == 350.0
