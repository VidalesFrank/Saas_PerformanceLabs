"""Tests Fase 5 — DS + fragilidades lognormales."""
from __future__ import annotations

import math

import pytest

from engine.building.nonlinear.damage_states import (
    DEFAULT_DS_CATALOG,
    DamageStateDef,
    ElementFragility,
    build_fragility,
)
from engine.building.nonlinear.element_data import (
    AxialState, Detailing, ElementData, FieldObservations, Geometry,
    LongitudinalReinf, Materials, TransverseReinf,
)
from engine.building.nonlinear.failure_mode import compute_failure_mode
from engine.building.nonlinear.moment_curvature_element import compute_moment_curvature
from engine.building.nonlinear.rotation_capacity import compute_rotation_capacity


def _column() -> ElementData:
    long_r = LongitudinalReinf(
        As_cm2=22.8, n_bars=8, bar_label="#6", db_mm=19.1,
        rho=0.01425, rho_prima=0.00712, As_prima_cm2=11.4,
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


# ─── DS catalog ──────────────────────────────────────────────────────────────
def test_default_catalog_has_4_states():
    assert len(DEFAULT_DS_CATALOG) == 4
    assert [d.id for d in DEFAULT_DS_CATALOG] == ["DS1", "DS2", "DS3", "DS4"]


def test_catalog_names_in_spanish():
    assert "Fisuración" in DEFAULT_DS_CATALOG[0].name
    assert "Descascaramiento" in DEFAULT_DS_CATALOG[1].name


def test_catalog_names_customizable():
    custom = [
        DamageStateDef(id="DS1", name="Mi fisura",
                       threshold_source="theta_y",
                       repair_action="algo"),
        DamageStateDef(id="DS4", name="Mi colapso",
                       threshold_source="theta_u",
                       repair_action="otro"),
    ]
    c = _column()
    mc = compute_moment_curvature(c)
    rc = compute_rotation_capacity(c, mc=mc, method="haselton")
    frag = build_fragility(c, rc, ds_catalog=custom)
    assert frag.ds_catalog[0].name == "Mi fisura"
    assert len(frag.medians) == 2


# ─── Builder ─────────────────────────────────────────────────────────────────
def test_fragility_populates_all_4_ds():
    c = _column()
    mc = compute_moment_curvature(c)
    rc = compute_rotation_capacity(c, mc=mc, method="haselton")
    frag = build_fragility(c, rc)
    assert set(frag.medians.keys()) == {"DS1", "DS2", "DS3", "DS4"}
    # Monotonicidad
    ms = [frag.medians[k] for k in ("DS1", "DS2", "DS3", "DS4")]
    assert all(ms[i] <= ms[i + 1] for i in range(len(ms) - 1))


def test_fragility_beta_global_default_040():
    c = _column()
    mc = compute_moment_curvature(c)
    rc = compute_rotation_capacity(c, mc=mc, method="haselton")
    frag = build_fragility(c, rc)
    assert all(b == 0.40 for b in frag.betas.values())


def test_fragility_beta_poor_detailing_060():
    c = _column()
    c.transverse.hook_type = "90deg"
    mc = compute_moment_curvature(c)
    fm = compute_failure_mode(c, Mp_kNm=200.0)
    rc = compute_rotation_capacity(c, mc=mc, fm=fm, method="haselton")
    frag = build_fragility(c, rc, fm=fm, beta_global=0.40,
                            beta_poor_detailing=0.60)
    assert all(b == 0.60 for b in frag.betas.values())


def test_fragility_beta_override_per_ds():
    custom = [
        DamageStateDef(id="DS1", name="X", threshold_source="theta_y",
                       repair_action="X", beta_override=0.25),
        DamageStateDef(id="DS4", name="Y", threshold_source="theta_u",
                       repair_action="Y"),
    ]
    c = _column()
    mc = compute_moment_curvature(c)
    rc = compute_rotation_capacity(c, mc=mc, method="haselton")
    frag = build_fragility(c, rc, ds_catalog=custom, beta_global=0.40)
    assert frag.betas["DS1"] == 0.25
    assert frag.betas["DS4"] == 0.40


# ─── Probabilidades ──────────────────────────────────────────────────────────
def test_P_exceed_zero_at_zero_demand():
    c = _column()
    mc = compute_moment_curvature(c)
    rc = compute_rotation_capacity(c, mc=mc, method="haselton")
    frag = build_fragility(c, rc)
    assert frag.P_exceed(theta=0.0, ds_id="DS1") == 0.0


def test_P_exceed_half_at_median():
    """A la mediana θ_med, Φ(0) = 0.5."""
    c = _column()
    mc = compute_moment_curvature(c)
    rc = compute_rotation_capacity(c, mc=mc, method="haselton")
    frag = build_fragility(c, rc)
    med_DS1 = frag.medians["DS1"]
    p = frag.P_exceed(theta=med_DS1, ds_id="DS1")
    assert p == pytest.approx(0.5, abs=1e-6)


def test_P_exceed_monotonic_in_theta():
    c = _column()
    mc = compute_moment_curvature(c)
    rc = compute_rotation_capacity(c, mc=mc, method="haselton")
    frag = build_fragility(c, rc)
    p_low  = frag.P_exceed(0.001, "DS2")
    p_high = frag.P_exceed(0.030, "DS2")
    assert p_high > p_low


def test_P_in_state_sum_to_one():
    c = _column()
    mc = compute_moment_curvature(c)
    rc = compute_rotation_capacity(c, mc=mc, method="haselton")
    frag = build_fragility(c, rc)
    for theta in [0.001, 0.01, 0.03, 0.08]:
        probs = frag.P_in_state(theta)
        assert sum(probs.values()) == pytest.approx(1.0, abs=1e-6)


def test_most_likely_state_shifts_with_demand():
    c = _column()
    mc = compute_moment_curvature(c)
    rc = compute_rotation_capacity(c, mc=mc, method="haselton")
    frag = build_fragility(c, rc)
    # Baja demanda → DS0 ("sin daño")
    assert frag.most_likely_state(0.0001) == "DS0"
    # Alta demanda → DS4
    assert frag.most_likely_state(1.0) == "DS4"


# ─── Serialización ───────────────────────────────────────────────────────────
def test_fragility_to_dict_serializable():
    c = _column()
    mc = compute_moment_curvature(c)
    rc = compute_rotation_capacity(c, mc=mc, method="haselton")
    frag = build_fragility(c, rc)
    import json
    s = json.dumps(frag.to_dict())
    assert "medians" in s
    assert "DS1" in s
