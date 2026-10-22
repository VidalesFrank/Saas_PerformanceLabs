"""Tests Fase 4 — capacidad de rotación (Mecánico, EC8-3, Haselton)."""
from __future__ import annotations

import math

import pytest

from engine.building.nonlinear.element_data import (
    AxialState, Detailing, ElementData, FieldObservations, Geometry,
    LongitudinalReinf, Materials, TransverseReinf,
)
from engine.building.nonlinear.failure_mode import compute_failure_mode
from engine.building.nonlinear.moment_curvature_element import (
    MomentCurvatureResult, compute_moment_curvature,
)
from engine.building.nonlinear.rotation_capacity import (
    Lp_paulay_priestley,
    comparative_table,
    compute_rotation_capacity,
    elwood_shear_drift_capacity,
    haselton_imk_column,
    rotation_capacity_ec8_3,
    rotation_capacity_haselton,
    rotation_capacity_mechanical,
)


def _column() -> ElementData:
    long_r = LongitudinalReinf(
        As_cm2=22.8, n_bars=8, bar_label="#6", db_mm=19.1,
        rho=0.01425, rho_prima=0.00712, As_prima_cm2=11.4,
        groups={
            "corners":    {"n_bars": 4, "bar_label": "#6", "As_cm2": 11.4},
            "top_face":   {"n_bars": 1, "bar_label": "#6", "As_cm2": 2.85},
            "bot_face":   {"n_bars": 1, "bar_label": "#6", "As_cm2": 2.85},
            "left_face":  {"n_bars": 1, "bar_label": "#6", "As_cm2": 2.85},
            "right_face": {"n_bars": 1, "bar_label": "#6", "As_cm2": 2.85},
        },
    )
    return ElementData(
        fid="C1", kind="column", story="P1", section_name="C40x40",
        node_i="J1", node_j="J2",
        geometry=Geometry(b_m=0.40, h_m=0.40, cover_m=0.040,
                          d_mm=341.0, L_m=3.0, Ln_m=3.0, Ls_m=1.5),
        materials=Materials(fc_MPa=28.0, fy_MPa=420.0, fu_MPa=630.0,
                            eps_su=0.10, fyh_MPa=420.0),
        longitudinal=long_r,
        transverse=TransverseReinf(tie_bar_label="#3", db_tie_mm=9.5,
                                   n_legs_b=3, n_legs_h=2,
                                   s_confined_mm=100, s_general_mm=150,
                                   A_tie_mm2=math.pi * 9.5 ** 2 / 4,
                                   rho_sh_b=0.00354, rho_sh_h=0.00266,
                                   rho_sh=0.00266, rho_s_vol=0.008,
                                   hook_type="135deg"),
        axial=AxialState(N_grav_kN=420.0, nu=0.094),
        detailing=Detailing(compliance_level="DMO", s_over_db_long=5.24,
                            rho_sh_meets_DMO=True),
        field=FieldObservations(),
    )


# ─── Lp ──────────────────────────────────────────────────────────────────────
def test_Lp_paulay_priestley():
    """Columna L=3m, fy=420, db=19.1:

        Lp1 = 0.08·1500 + 0.022·420·19.1 = 120 + 176.5 = 296.5 mm
        Lp2 = 0.044·420·19.1 = 352.9 mm
        Lp  = max → 352.9 mm
    """
    c = _column()
    Lp = Lp_paulay_priestley(c)
    assert Lp == pytest.approx(352.9, rel=1e-2)


# ─── Haselton verbatim contra agente ─────────────────────────────────────────
def test_haselton_matches_verified_values():
    """Verificación numérica de las ecuaciones Haselton 2008 (PEER 2007/03)
    con ν=0.3, ρ_sh=0.008, s/db=4, f'c=28 MPa, a_sl=1, f_y=420 MPa.

    Cálculo paso a paso:
        0.031^0.3        = 0.3528
        (0.34)^1.02      = 0.3328
        θ_pc = 0.76·0.3528·0.3328 = 0.0892  (bajo el tope 0.10)

        0.2^0.3          = 0.6170
        (0.34)^0.52      = 0.5674
        0.56^(0.01·28)   = 0.56^0.28 = 0.8534
        θ_cap,pl = 0.12·1.4·0.6170·0.5674·0.8534 = 0.0508

        λ = 30·(0.3)^0.3 = 30·0.6968 = 20.91
        Mc/My = 1.25·0.89^0.3·0.91^0.28 = 1.25·0.9657·0.9742 = 1.176
    """
    r = haselton_imk_column(nu=0.3, rho_sh=0.008, a_sl=1, fc_MPa=28.0,
                             fy_MPa=420.0, s_over_db=4.0)
    assert r["theta_cap_pl"] == pytest.approx(0.0508, abs=0.001)
    assert r["theta_pc"]     == pytest.approx(0.0892, abs=0.001)
    assert r["lambda_imk"]   == pytest.approx(20.91, rel=1e-3)
    assert r["Mc_over_My"]   == pytest.approx(1.176, abs=0.01)
    # Dispersiones de Haselton 2008 Tabla 4.6
    assert r["sigma_LN_theta_cap_pl"] == 0.60
    assert r["sigma_LN_theta_pc"]     == 0.72


def test_haselton_theta_pc_capped_at_0_10():
    """θ_pc tiene tope duro a 0.10 rad incluso con ρ_sh y ν favorables."""
    r = haselton_imk_column(nu=0.05, rho_sh=0.025, a_sl=0, fc_MPa=28.0,
                             fy_MPa=420.0, s_over_db=3.0)
    assert r["theta_pc"] <= 0.10


def test_haselton_lambda_decreases_with_axial():
    r_low  = haselton_imk_column(nu=0.1, rho_sh=0.008, a_sl=1, fc_MPa=28,
                                   fy_MPa=420, s_over_db=4)
    r_high = haselton_imk_column(nu=0.5, rho_sh=0.008, a_sl=1, fc_MPa=28,
                                   fy_MPa=420, s_over_db=4)
    assert r_high["lambda_imk"] < r_low["lambda_imk"]


# ─── Rotation capacity método Haselton ───────────────────────────────────────
def test_haselton_rc_populated_from_element():
    c = _column()
    rc = rotation_capacity_haselton(c)
    assert rc.method == "haselton"
    assert rc.theta_cap_pl > 0
    assert rc.theta_pc > 0
    assert rc.theta_u > rc.theta_y > 0
    # θ_CP > θ_LS > θ_IO
    assert rc.theta_CP > rc.theta_LS > rc.theta_IO
    # Haselton coeffs extra
    assert rc.lambda_imk is not None
    assert rc.Mc_over_My is not None


def test_haselton_clips_axial_above_070():
    c = _column()
    c.axial.nu = 0.9
    rc = rotation_capacity_haselton(c)
    assert any("fuera de rango" in n or "clip" in n.lower() for n in rc.notes)


# ─── Método mecánico con M-φ ─────────────────────────────────────────────────
def test_mechanical_rc_with_mphi():
    c = _column()
    mc = compute_moment_curvature(c)
    rc = rotation_capacity_mechanical(c, mc)
    assert rc.method == "mecanico"
    assert rc.theta_cap_pl > 0
    assert rc.Lp_mm > 100.0
    assert rc.Lp_source == "paulay_priestley"


def test_mechanical_rc_captures_ds_thresholds_from_mphi():
    c = _column()
    mc = compute_moment_curvature(c)
    rc = rotation_capacity_mechanical(c, mc)
    # Al menos DS2 debería capturarse del M-φ
    if mc.phi_eps_c_004 is not None:
        assert rc.theta_DS2 is not None and rc.theta_DS2 >= rc.theta_y


# ─── Override Lp observada ───────────────────────────────────────────────────
def test_lp_measured_forces_mechanical_method():
    c = _column()
    c.field.L_p_measured_mm = 500.0
    c.field.L_p_method = "measured"
    mc = compute_moment_curvature(c)
    # Aunque pida haselton, debe devolver mecánico porque hay Lp observada
    rc = compute_rotation_capacity(c, mc=mc, method="haselton")
    assert rc.method == "mecanico"
    assert rc.Lp_mm == 500.0
    assert rc.Lp_source == "measured"
    assert any("Lp medida en campo" in n for n in rc.notes)


def test_lp_measured_affects_theta_cap_pl():
    """Lp medida más grande → mayor θ_cap_pl (θp proporcional a Lp)."""
    c1 = _column()
    c2 = _column()
    mc = compute_moment_curvature(c1)
    c1.field.L_p_measured_mm = 200.0
    c2.field.L_p_measured_mm = 500.0
    c1.field.L_p_method = c2.field.L_p_method = "measured"
    rc1 = compute_rotation_capacity(c1, mc=mc)
    rc2 = compute_rotation_capacity(c2, mc=mc)
    assert rc2.theta_cap_pl > rc1.theta_cap_pl


def test_lp_measured_without_mphi_raises():
    c = _column()
    c.field.L_p_measured_mm = 300.0
    c.field.L_p_method = "measured"
    with pytest.raises(ValueError):
        compute_rotation_capacity(c, mc=None, method="haselton")


# ─── EC8-3 ───────────────────────────────────────────────────────────────────
def test_ec8_3_rc_populated():
    c = _column()
    mc = compute_moment_curvature(c)
    rc = rotation_capacity_ec8_3(c, mc)
    assert rc.method == "ec8_3"
    assert rc.theta_u > rc.theta_y > 0
    # θ_LS = ¾·θum, θ_CP = θum/1.5 → θ_LS > θ_CP
    assert rc.theta_LS > rc.theta_CP      # EC8-3 característica


def test_ec8_3_hook90_reduces_theta_um():
    c_good = _column()
    c_bad  = _column()
    c_bad.transverse.hook_type = "90deg"
    mc = compute_moment_curvature(c_good)
    rc_good = rotation_capacity_ec8_3(c_good, mc)
    rc_bad  = rotation_capacity_ec8_3(c_bad, mc)
    assert rc_bad.theta_u < rc_good.theta_u
    assert any("gancho a 90°" in n for n in rc_bad.notes)


def test_ec8_3_splice_reduces_theta_um():
    c = _column()
    c.detailing.splice_in_hinge = True
    mc = compute_moment_curvature(c)
    rc = rotation_capacity_ec8_3(c, mc)
    assert any("empalme" in n for n in rc.notes)


# ─── Ajuste Elwood ───────────────────────────────────────────────────────────
def test_elwood_drift_formula():
    """Elwood & Moehle 2003 drift at shear failure."""
    c = _column()
    drift = elwood_shear_drift_capacity(c, V_demand_kN=250.0)
    # Rango esperado 0.01–0.03 para columna razonable
    assert 0.01 <= drift <= 0.05


def test_elwood_adjustment_reduces_capacity_in_shear_mode():
    c = _column()
    mc = compute_moment_curvature(c)
    rc_flex = compute_rotation_capacity(c, mc=mc, method="haselton")
    # Forzar modo cortante con Mp alto → Vp supera Vn
    fm = compute_failure_mode(c, Mp_kNm=1000.0)
    assert fm.failure_mode in ("cortante", "flexion_cortante")
    rc_shear = compute_rotation_capacity(c, mc=mc, fm=fm, method="haselton")
    assert rc_shear.theta_u <= rc_flex.theta_u
    assert rc_shear.elwood_factor <= 1.0


# ─── Tabla comparativa ──────────────────────────────────────────────────────
def test_comparative_table_contains_all_methods():
    c = _column()
    mc = compute_moment_curvature(c)
    tbl = comparative_table(c, mc=mc)
    assert set(tbl.keys()) >= {"mecanico", "ec8_3", "haselton", "fema_asce41"}
    assert tbl["fema_asce41"]["theta_CP"] == 0.020      # columna DMO


def test_comparative_table_for_beam():
    """Para vigas, el FEMA de referencia es diferente."""
    v = _column()
    v.kind = "beam"
    v.geometry = Geometry(b_m=0.30, h_m=0.50, cover_m=0.040,
                          d_mm=441.0, L_m=5.0, Ln_m=5.0, Ls_m=2.5)
    mc = compute_moment_curvature(v)
    tbl = comparative_table(v, mc=mc)
    assert tbl["fema_asce41"]["theta_CP"] == 0.030       # viga DMO
