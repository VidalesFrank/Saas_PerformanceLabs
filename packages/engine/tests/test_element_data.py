"""Tests Fase 1 — ElementData.

Cubre:
    - Poblado de columna y viga desde un spec mínimo mock.
    - Cálculo de ν = N_grav/(Ag·f'c) con y sin extractor de gravedad.
    - Chequeos de detallado DES/DMO.
    - Loader de observations.csv (completitud + overrides de campo).
    - Override de Lp medida activa L_p_method="measured".
"""
from __future__ import annotations

import json
import math
import textwrap
from pathlib import Path

import pytest

from engine.building.nonlinear.element_data import (
    AxialState,
    ElementData,
    FieldObservations,
    elements_from_spec,
    load_axial_from_gravity,
    load_observations_csv,
)


# ─── Spec mock mínimo ────────────────────────────────────────────────────────
def _mock_spec() -> dict:
    """Spec con 1 columna + 1 viga, suficiente para probar todos los campos."""
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
                        "longitudinal": {
                            "n_bars": 8, "bar_label": "#6", "As_cm2": 22.8,
                        },
                        "transverse": {
                            "tie_bar_label": "#3",
                            "n_legs_b": 3, "n_legs_h": 2,
                            "s_confined_mm": 100, "s_general_mm": 150,
                            "L_confinement_mm": 400,
                        },
                    },
                    "confinement": {
                        "end": {"rho_s": 0.012, "K": 1.35, "fcc_MPa": 37.8},
                        "mid": {"rho_s": 0.008, "K": 1.20, "fcc_MPa": 33.6},
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
                        "shear": {
                            "tie_bar_label": "#3", "n_legs": 2,
                            "s_confined_mm": 100, "s_central_mm": 200,
                        },
                    },
                    "confinement": {
                        "end": {"rho_s": 0.010, "K": 1.25, "fcc_MPa": 35.0},
                        "mid": {"rho_s": 0.005, "K": 1.10, "fcc_MPa": 30.8},
                    },
                    "has_design": True,
                },
            },
        },
    }


# ─── Pobladores básicos ──────────────────────────────────────────────────────
def test_populate_column_from_spec():
    eles = elements_from_spec(_mock_spec())
    assert "C-B2-1" in eles
    c = eles["C-B2-1"]

    assert c.kind == "column"
    assert c.section_name == "C40x40"
    assert c.geometry.b_m == 0.40
    assert c.geometry.h_m == 0.40
    assert c.geometry.Ls_m == pytest.approx(1.5)   # L/2 doble curvatura

    # Peralte efectivo: h − cover − db_tie − db_long/2 = 400-40-9.5-19.1/2 ≈ 341
    assert c.geometry.d_mm == pytest.approx(400 - 40 - 9.5 - 19.1 / 2, abs=0.5)

    # Materiales: fc=28, fy=420, fu=630 → fu/fy=1.5 (default A615)
    assert c.materials.fc_MPa == 28.0
    assert c.materials.fy_MPa == 420.0
    assert c.materials.fu_MPa == 630.0
    assert c.materials.eps_su == 0.10

    # Refuerzo longitudinal
    assert c.longitudinal.n_bars == 8
    assert c.longitudinal.bar_label == "#6"
    assert c.longitudinal.As_cm2 == 22.8
    # ρ = 22.8 cm² / (40·40 cm²) = 0.01425
    assert c.longitudinal.rho == pytest.approx(0.01425, rel=1e-3)

    # Refuerzo transversal — convención Mander: n_legs_b ∥ b
    assert c.transverse.n_legs_b == 3
    assert c.transverse.n_legs_h == 2
    assert c.transverse.s_confined_mm == 100
    # A_tie = π·(9.5)²/4 ≈ 70.9 mm²
    assert c.transverse.A_tie_mm2 == pytest.approx(math.pi * 9.5 ** 2 / 4, abs=0.5)
    # ρ_sh_b = n_legs_h · A_tie / (b · s) = 2 · 70.9 / (400 · 100) ≈ 0.00354
    assert c.transverse.rho_sh_b == pytest.approx(2 * 70.88 / (400 * 100), rel=1e-2)
    # ρ_s volumétrica tomada del Mander del spec
    assert c.transverse.rho_s_vol == 0.012

    # Axial sin extractor: N_grav=0, ν=0
    assert c.axial.N_grav_kN == 0.0
    assert c.axial.nu == 0.0

    # Detallado
    assert c.detailing.compliance_level == "DMO"
    # ρ_sh_min DES = 0.09·fc/fyh = 0.09·28/420 = 0.006
    # ρ_sh gobernante min(0.00354, 0.00266) = 0.00266 → NO cumple DES ni DMO (0.003)
    assert c.detailing.rho_sh_meets_DES is False


def test_populate_beam_from_spec():
    eles = elements_from_spec(_mock_spec())
    assert "V-AB-1" in eles
    v = eles["V-AB-1"]

    assert v.kind == "beam"
    assert v.geometry.L_m == 5.0
    assert v.geometry.Ls_m == pytest.approx(2.5)

    # Refuerzo longitudinal zona end_i: top 4·#6 (tracción) = 11.4 cm²
    #                                    bot 2·#5 (compresión) = 3.97 cm²
    expected_As_top = 4 * math.pi * 19.1 ** 2 / 4 / 100.0
    assert v.longitudinal.As_cm2 == pytest.approx(expected_As_top, rel=1e-3)
    # ρ (sobre Ag): As_top / (30·50) = 11.4/1500 ≈ 0.0076
    assert v.longitudinal.rho == pytest.approx(expected_As_top / 1500.0, rel=1e-3)

    # Shear: 2 ramas, s=100mm, tie #3
    assert v.transverse.n_legs_h == 2
    assert v.transverse.s_confined_mm == 100


def test_axial_from_gravity_extractor(tmp_path: Path):
    axial_payload = {
        "C-B2-1": {"N_grav_kN": 420.0},
        "V-AB-1": {"N_grav_kN": 5.0},
    }
    p = tmp_path / "axial.json"
    p.write_text(json.dumps(axial_payload), encoding="utf-8")

    loaded = load_axial_from_gravity(p)
    assert loaded["C-B2-1"]["N_grav_kN"] == 420.0

    eles = elements_from_spec(_mock_spec(), axial_json=loaded)
    c = eles["C-B2-1"]
    assert c.axial.N_grav_kN == 420.0

    # ν = 420 kN · 1000 / (400·400 mm² · 28 MPa) = 420000/4_480_000 ≈ 0.0938
    expected_nu = 420_000.0 / (400.0 * 400.0 * 28.0)
    assert c.axial.nu == pytest.approx(expected_nu, rel=1e-3)


def test_load_axial_file_missing_returns_empty(tmp_path: Path):
    assert load_axial_from_gravity(tmp_path / "noexiste.json") == {}


# ─── Observations CSV ────────────────────────────────────────────────────────
def test_load_observations_csv(tmp_path: Path):
    content = textwrap.dedent("""\
        fid,L_p_measured_mm,hook_type,splice_in_hinge,fu_MPa,eps_su,damage_notes
        C-B2-1,350,135deg,FALSE,,,fisura 2mm cara sur
        V-AB-1,,90deg,TRUE,650,0.08,
    """)
    p = tmp_path / "observations.csv"
    p.write_text(content, encoding="utf-8")

    obs = load_observations_csv(p)
    assert set(obs.keys()) == {"C-B2-1", "V-AB-1"}

    c = obs["C-B2-1"]
    assert c["L_p_measured_mm"] == 350.0
    assert c["hook_type"] == "135deg"
    assert c["splice_in_hinge"] is False
    assert "fu_MPa" not in c                    # celda vacía omitida
    assert c["damage_notes"] == "fisura 2mm cara sur"

    v = obs["V-AB-1"]
    assert "L_p_measured_mm" not in v           # celda vacía omitida
    assert v["hook_type"] == "90deg"
    assert v["splice_in_hinge"] is True
    assert v["fu_MPa"] == 650.0
    assert v["eps_su"] == 0.08


def test_lp_measured_activates_measured_method(tmp_path: Path):
    """Lp medida en campo debe activar L_p_method='measured' automáticamente."""
    observations = {"C-B2-1": {"L_p_measured_mm": 350.0, "hook_type": "135deg"}}
    eles = elements_from_spec(_mock_spec(), observations=observations)
    c = eles["C-B2-1"]
    assert c.field.L_p_measured_mm == 350.0
    assert c.field.L_p_method == "measured"
    assert c.transverse.hook_type == "135deg"


def test_lp_not_measured_defaults_to_paulay_priestley():
    """Sin Lp medida, el método default es paulay_priestley."""
    eles = elements_from_spec(_mock_spec())
    c = eles["C-B2-1"]
    assert c.field.L_p_measured_mm is None
    assert c.field.L_p_method == "paulay_priestley"


def test_observations_can_override_fu_and_eps_su():
    observations = {"C-B2-1": {"fu_MPa": 700.0, "eps_su": 0.09}}
    eles = elements_from_spec(_mock_spec(), observations=observations)
    c = eles["C-B2-1"]
    assert c.materials.fu_MPa == 700.0
    assert c.materials.eps_su == 0.09


def test_observations_can_override_splice_in_hinge():
    observations = {"C-B2-1": {"splice_in_hinge": True}}
    eles = elements_from_spec(_mock_spec(), observations=observations)
    assert eles["C-B2-1"].detailing.splice_in_hinge is True


# ─── Integración + serialización ─────────────────────────────────────────────
def test_elementdata_to_dict_roundtrip():
    eles = elements_from_spec(_mock_spec())
    d = eles["C-B2-1"].to_dict()
    assert d["fid"] == "C-B2-1"
    assert d["geometry"]["b_m"] == 0.40
    assert d["transverse"]["n_legs_b"] == 3
    # Debe ser JSON-serializable
    json.dumps(d)


def test_detailing_DES_level_detected():
    spec = _mock_spec()
    spec["general"]["energy_dissipation"] = "DES"
    eles = elements_from_spec(spec)
    assert eles["C-B2-1"].detailing.compliance_level == "DES"


def test_s_over_db_computed():
    eles = elements_from_spec(_mock_spec())
    c = eles["C-B2-1"]
    # s_confined=100, db_long=19.1 → s/db ≈ 5.24 (OK para pandeo, < 6)
    assert c.detailing.s_over_db_long == pytest.approx(100 / 19.1, rel=1e-3)


def test_rho_sh_meets_DES_when_densely_tied():
    """Columna con estribos muy juntos y 4 ramas en cada dir → DES OK."""
    spec = _mock_spec()
    tran = spec["elements"]["columns"]["C-B2-1"]["reinforcement"]["transverse"]
    tran["n_legs_b"] = 4
    tran["n_legs_h"] = 4
    tran["s_confined_mm"] = 60      # junto
    tran["tie_bar_label"] = "#4"    # 12.7 mm
    eles = elements_from_spec(spec)
    c = eles["C-B2-1"]
    # ρ_sh_b = 4·π·12.7²/4/(400·60) = 507 / 24000 ≈ 0.0211
    # ρ_min DES = 0.09·28/420 ≈ 0.006 → cumple
    assert c.detailing.rho_sh_meets_DES is True
    assert c.detailing.rho_sh_meets_DMO is True
