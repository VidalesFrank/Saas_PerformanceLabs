"""Fase 8 — Validación: columna canónica + sensibilidad.

Valida el pipeline completo contra:
    1. Columna 400×400 con 8·#8 — valores a mano según Mander/ACI/Haselton.
    2. Sensibilidad frente a ν (axial), ρ_sh, s/db, β.
    3. Benchmark Haselton con casos típicos de la PEER Column Database:
        - Specimen Saatcioglu-Ozcebe B1    (ν=0.0,  ρ_sh=0.011, dúctil)
        - Specimen Sezen 2000-2CLH18       (ν=0.15, ρ_sh=0.0017, deficiente)
        - Specimen Lynn 1996-3SLH18        (ν=0.09, ρ_sh=0.0015, s=hooks90°)

    (Valores de referencia resumidos — datos exactos en los papers originales.
    Los ensayos están en PEER Structural Performance Database https://nisee.berkeley.edu/spd/)
"""
from __future__ import annotations

import math

import pytest

from engine.building.nonlinear.damage_states import build_fragility
from engine.building.nonlinear.element_data import (
    AxialState, Detailing, ElementData, FieldObservations, Geometry,
    LongitudinalReinf, Materials, TransverseReinf,
)
from engine.building.nonlinear.failure_mode import compute_failure_mode
from engine.building.nonlinear.moment_curvature_element import compute_moment_curvature
from engine.building.nonlinear.rotation_capacity import (
    compute_rotation_capacity,
    haselton_imk_column,
)
from engine.building.nonlinear.element_thresholds import compute_element_thresholds


# ─────────────────────────────────────────────────────────────────────────────
# Caso canónico — columna 400×400 con 8·#8, fc=28 MPa, fy=420 MPa
# ─────────────────────────────────────────────────────────────────────────────
def _column_canonical(
    N_grav_kN: float = 500.0,
    tie_spacing_mm: int = 100,
    hook: str = "135deg",
) -> ElementData:
    """Columna 400×400 — 8·#8 (25.4 mm, 40.5 cm² total)."""
    db_long = 25.4
    db_tie  = 9.5
    long_r = LongitudinalReinf(
        As_cm2=4 * math.pi * db_long ** 2 / 4 * 2 / 100.0,   # ≈ 40.5 cm²
        n_bars=8, bar_label="#8", db_mm=db_long,
        rho=0.0254, rho_prima=0.0127,
        As_prima_cm2=20.3,
    )
    A_tie_mm2 = math.pi * db_tie ** 2 / 4
    rho_sh_b = (2 * A_tie_mm2) / (400.0 * tie_spacing_mm)
    rho_sh_h = rho_sh_b
    tran_r = TransverseReinf(
        tie_bar_label="#3", db_tie_mm=db_tie,
        n_legs_b=2, n_legs_h=2,
        s_confined_mm=tie_spacing_mm, s_general_mm=tie_spacing_mm * 2,
        A_tie_mm2=A_tie_mm2,
        rho_sh_b=rho_sh_b, rho_sh_h=rho_sh_h,
        rho_sh=min(rho_sh_b, rho_sh_h),
        rho_s_vol=2 * rho_sh_b,          # aprox volumétrica
        hook_type=hook,                  # type: ignore[arg-type]
    )
    cover_mm = 40
    d_mm = 400 - cover_mm - db_tie - db_long / 2
    geo = Geometry(b_m=0.40, h_m=0.40, cover_m=0.040,
                   d_mm=d_mm, L_m=3.0, Ln_m=3.0, Ls_m=1.5)
    mat = Materials(fc_MPa=28.0, fy_MPa=420.0, fu_MPa=630.0,
                    eps_su=0.10, fyh_MPa=420.0)
    axial = AxialState(N_grav_kN=N_grav_kN)
    axial.recompute_nu(geo, mat)
    detail = Detailing(
        compliance_level="DMO" if hook == "135deg" else "unknown",
        s_over_db_long=tie_spacing_mm / db_long,
        rho_sh_meets_DMO=rho_sh_b >= 0.5 * 0.09 * 28 / 420,
        rho_sh_meets_DES=rho_sh_b >= 0.09 * 28 / 420,
    )
    return ElementData(
        fid="C_canonical", kind="column", story="P1", section_name="C40x40",
        node_i="J1", node_j="J2",
        geometry=geo, materials=mat, longitudinal=long_r,
        transverse=tran_r, axial=axial, detailing=detail,
        field=FieldObservations(),
    )


# ─── Validación numérica manual ───────────────────────────────────────────────
def test_canonical_column_rho_long_matches_hand_calc():
    """8·#8 = 8 · (π·25.4²/4) = 4053 mm² ≈ 40.5 cm². Ag = 1600 cm².
       ρ = 40.5/1600 = 0.0253.
    """
    c = _column_canonical()
    assert c.longitudinal.rho == pytest.approx(0.0254, rel=1e-2)


def test_canonical_column_nu_matches():
    """N=500 kN, Ag·fc = 400·400·28 = 4.48e6 N. ν = 500000/4.48e6 = 0.1116."""
    c = _column_canonical(N_grav_kN=500.0)
    assert c.axial.nu == pytest.approx(0.1116, abs=1e-3)


def test_canonical_column_haselton_values():
    """Columna canónica con ν=0.11, ρ_sh≈0.00354 (2·70.9/400·100):

        θ_cap,pl = 0.12·(1+0.4)·(0.2^0.11)·(0.02+40·0.00354)^0.52·(0.56^0.28)
                 ≈ 0.12·1.4·0.845·0.398·0.853
                 ≈ 0.048
        θ_pc    ≈ 0.76·(0.031^0.11)·(0.1616^1.02) ≈ 0.07
    """
    c = _column_canonical(N_grav_kN=500.0)
    mc = compute_moment_curvature(c)
    rc = compute_rotation_capacity(c, mc=mc, method="haselton")
    assert rc.theta_cap_pl == pytest.approx(0.048, abs=0.015)
    assert rc.theta_pc     == pytest.approx(0.070, abs=0.030)


def test_canonical_column_mphi_mu_in_range():
    """Columna 400×400 8·#8 con N=500 kN — Mu teórico aprox 400 kN·m."""
    c = _column_canonical(N_grav_kN=500.0)
    mc = compute_moment_curvature(c)
    assert 200.0 < mc.M_peak_kNm < 700.0


# ─── Sensibilidad ────────────────────────────────────────────────────────────
def test_sensitivity_axial_decreases_capacity():
    """θ_cap,pl debe decrecer con ν (Haselton: θ ∝ 0.2^ν)."""
    for N in [100.0, 500.0, 1000.0, 2000.0]:
        c = _column_canonical(N_grav_kN=N)
        mc = compute_moment_curvature(c)
        rc = compute_rotation_capacity(c, mc=mc, method="haselton")
        # Guardar para comparación
        if not hasattr(test_sensitivity_axial_decreases_capacity, "_vals"):
            test_sensitivity_axial_decreases_capacity._vals = []
        test_sensitivity_axial_decreases_capacity._vals.append((N, rc.theta_cap_pl))
    vals = test_sensitivity_axial_decreases_capacity._vals
    # Monotonicidad decreciente
    for i in range(1, len(vals)):
        assert vals[i][1] <= vals[i - 1][1] + 1e-6
    delattr(test_sensitivity_axial_decreases_capacity, "_vals")


def test_sensitivity_rho_sh_increases_capacity():
    """Más confinamiento (s menor) → θ mayor."""
    thetas = []
    for s in [50, 100, 200, 300]:
        c = _column_canonical(tie_spacing_mm=s)
        mc = compute_moment_curvature(c)
        rc = compute_rotation_capacity(c, mc=mc, method="haselton")
        thetas.append(rc.theta_cap_pl)
    # s menor → ρ_sh mayor → θ mayor → thetas[0] > thetas[-1]
    assert thetas[0] > thetas[-1]


def test_sensitivity_hook_90_reduces_ec8_3():
    """Gancho 90° en EC8-3 debe reducir θ_u ~20%."""
    c_good = _column_canonical(hook="135deg")
    c_bad  = _column_canonical(hook="90deg")
    mc = compute_moment_curvature(c_good)
    from engine.building.nonlinear.rotation_capacity import rotation_capacity_ec8_3
    rc_good = rotation_capacity_ec8_3(c_good, mc)
    rc_bad  = rotation_capacity_ec8_3(c_bad, mc)
    # 90° reduce ~20% en EC8-3
    assert rc_bad.theta_u / rc_good.theta_u == pytest.approx(0.80, abs=0.02)


def test_sensitivity_beta_affects_fragility_spread():
    """β mayor → fragilidad más dispersa → P(DS=DS2) a demanda media ≠ β bajo."""
    c = _column_canonical()
    mc = compute_moment_curvature(c)
    fm = compute_failure_mode(c, Mp_kNm=mc.M_peak_kNm)
    rc = compute_rotation_capacity(c, mc=mc, fm=fm, method="haselton")
    frag_tight = build_fragility(c, rc, fm=fm, beta_global=0.20)
    frag_wide  = build_fragility(c, rc, fm=fm, beta_global=0.60)

    # A la mediana de DS2, ambos dan P=0.5. Pero muy debajo (0.5·med), el β
    # alto da probabilidad > β bajo (distribución más abierta).
    theta_test = 0.5 * frag_tight.medians["DS2"]
    p_tight = frag_tight.P_exceed(theta_test, "DS2")
    p_wide  = frag_wide.P_exceed(theta_test, "DS2")
    assert p_wide > p_tight


# ─── Benchmarks PEER (aproximados) ────────────────────────────────────────────
def test_peer_saatcioglu_ozcebe_B1_well_confined():
    """Saatcioglu-Ozcebe B1 (1989): columna muy confinada, ν=0, ρ_sh=0.011.

    Esperado: θ_cap,pl ≈ 0.07–0.09 (muy dúctil, cercana al tope).
    """
    h = haselton_imk_column(
        nu=0.0, rho_sh=0.011, a_sl=1,
        fc_MPa=35.0, fy_MPa=430.0, s_over_db=4.0,
    )
    assert h["theta_cap_pl"] > 0.06
    assert h["theta_cap_pl"] < 0.12


def test_peer_sezen_2CLH18_poor_detailing():
    """Sezen 2CLH18 (2000): columna existente mal detallada, ν=0.15, ρ_sh=0.0017.

    Esperado: θ_cap,pl bajo (≈ 0.02–0.03) por bajo confinamiento.
    """
    h = haselton_imk_column(
        nu=0.15, rho_sh=0.0017, a_sl=1,
        fc_MPa=22.0, fy_MPa=434.0, s_over_db=8.0,
    )
    assert h["theta_cap_pl"] < 0.04
    assert h["theta_cap_pl"] > 0.01


def test_peer_lynn_3SLH18_hooks_90():
    """Lynn 3SLH18 (1996): columna con hooks 90°, ν=0.09, ρ_sh=0.0015.

    En Haselton puro no se refleja hooks90° — para capturarlo usar EC8-3.
    Aquí sólo verificamos que θ_cap,pl es bajo (compatible con la rotura
    observada en ensayo cerca de 0.025 rad).
    """
    h = haselton_imk_column(
        nu=0.09, rho_sh=0.0015, a_sl=1,
        fc_MPa=26.0, fy_MPa=331.0, s_over_db=10.0,
    )
    assert h["theta_cap_pl"] < 0.035


# ─── End-to-end: pipeline completo sobre spec mínimo ─────────────────────────
def test_e2e_pipeline_canonical_column_in_spec():
    """Pipeline completo con la columna canónica como único elemento."""
    spec = {
        "general": {"energy_dissipation": "DMO"},
        "materials": {
            "concrete": {"C28": {"fc_MPa": 28.0}},
            "steel":    {"A420": {"fy_MPa": 420.0, "fu_MPa": 630.0}},
        },
        "section_types": {
            "C40x40": {"kind": "column", "b_m": 0.40, "h_m": 0.40,
                       "material_concrete": "C28", "fc_MPa": 28.0},
        },
        "elements": {
            "columns": {
                "C1": {
                    "node_i": "J1", "node_j": "J2", "story": "P1",
                    "section": "C40x40",
                    "geometry": {"b_m": 0.40, "h_m": 0.40, "L_m": 3.0,
                                 "fc_MPa": 28.0, "cover_m": 0.040},
                    "reinforcement": {
                        "longitudinal": {"n_bars": 8, "bar_label": "#8", "As_cm2": 40.5},
                        "transverse": {"tie_bar_label": "#3",
                                       "n_legs_b": 2, "n_legs_h": 2,
                                       "s_confined_mm": 100, "s_general_mm": 200},
                    },
                    "confinement": {
                        "end": {"rho_s": 0.011, "K": 1.3, "fcc_MPa": 36.4,
                                "eps_cc": 0.004, "eps_cu": 0.018},
                        "mid": {"rho_s": 0.006, "K": 1.15, "fcc_MPa": 32.0,
                                "eps_cc": 0.003, "eps_cu": 0.010},
                    },
                    "has_design": True,
                },
            },
            "beams": {},
        },
    }
    axial = {"C1": {"N_grav_kN": 500.0}}
    result = compute_element_thresholds(spec=spec, axial_json=axial,
                                          metodo_rotacion="haselton")
    assert result.n_elements == 1
    row = result.rows[0]
    assert row.theta_IO > 0
    assert row.theta_LS > row.theta_IO
    assert row.theta_CP > row.theta_LS
    assert row.failure_mode in ("flexion", "flexion_cortante", "cortante")
    assert "DS1" in row.medians_DS
    assert "DS4" in row.medians_DS


def test_e2e_pipeline_lp_measured_forces_mechanical():
    """Observación de Lp=350mm debe forzar el método mecánico en el resultado."""
    spec = {
        "general": {"energy_dissipation": "DMO"},
        "materials": {"concrete": {"C28": {"fc_MPa": 28.0}},
                       "steel":    {"A420": {"fy_MPa": 420.0, "fu_MPa": 630.0}}},
        "section_types": {"C40x40": {"kind": "column", "b_m": 0.40, "h_m": 0.40,
                                      "material_concrete": "C28", "fc_MPa": 28.0}},
        "elements": {
            "columns": {
                "C1": {
                    "node_i": "J1", "node_j": "J2", "story": "P1",
                    "section": "C40x40",
                    "geometry": {"b_m": 0.40, "h_m": 0.40, "L_m": 3.0,
                                 "fc_MPa": 28.0, "cover_m": 0.040},
                    "reinforcement": {
                        "longitudinal": {"n_bars": 8, "bar_label": "#8", "As_cm2": 40.5},
                        "transverse": {"tie_bar_label": "#3",
                                       "n_legs_b": 2, "n_legs_h": 2,
                                       "s_confined_mm": 100, "s_general_mm": 200},
                    },
                    "confinement": {
                        "end": {"eps_cc": 0.004, "eps_cu": 0.018, "fcc_MPa": 36.4,
                                "rho_s": 0.011},
                        "mid": {"eps_cc": 0.003, "eps_cu": 0.010, "fcc_MPa": 32.0,
                                "rho_s": 0.006},
                    },
                    "has_design": True,
                },
            },
            "beams": {},
        },
    }
    obs = {"C1": {"L_p_measured_mm": 350.0}}
    result = compute_element_thresholds(spec=spec, observations=obs,
                                          metodo_rotacion="haselton")
    row = result.rows[0]
    assert row.method == "mecanico"
    assert row.Lp_mm == 350.0
    assert row.Lp_source == "measured"
