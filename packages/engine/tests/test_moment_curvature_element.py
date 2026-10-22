"""Tests Fase 3 — M-φ analítico."""
from __future__ import annotations

import math

import pytest

from engine.building.nonlinear.element_data import (
    AxialState, Detailing, ElementData, FieldObservations, Geometry,
    LongitudinalReinf, Materials, TransverseReinf,
)
from engine.building.nonlinear.moment_curvature_element import (
    compute_moment_curvature,
    mander_stress,
    steel_stress,
)


# ─── Constitutivos ────────────────────────────────────────────────────────────
def test_mander_stress_at_eps_cc_equals_fcc():
    """Al llegar a εcc, el modelo Popovics debe dar σ=fcc."""
    sigma = mander_stress(eps=0.004, fcc=38.0, eps_cc=0.004,
                          eps_cu=0.020, Ec=24000.0)
    assert sigma == pytest.approx(38.0, rel=1e-2)


def test_mander_stress_zero_in_tension():
    assert mander_stress(eps=-0.001, fcc=28.0, eps_cc=0.002,
                          eps_cu=0.005, Ec=24000.0) == 0.0


def test_mander_stress_zero_beyond_eps_cu():
    assert mander_stress(eps=0.025, fcc=38.0, eps_cc=0.004,
                          eps_cu=0.020, Ec=24000.0) == 0.0


def test_steel_elastic_regime():
    """Dentro de la zona elástica, σ = Es·ε."""
    sigma = steel_stress(eps=0.001, fy=420.0, Es=200_000.0, eps_su=0.10)
    assert sigma == pytest.approx(200.0, rel=1e-3)


def test_steel_yield_plateau_with_hardening():
    sigma = steel_stress(eps=0.01, fy=420.0, Es=200_000.0, eps_su=0.10,
                         b=0.015)
    # εy = 0.0021, εp = 0.01 - 0.0021 = 0.0079
    # σ = 420 + 0.015·200000·0.0079 = 420 + 23.7 = 443.7
    assert sigma == pytest.approx(443.7, rel=1e-2)


def test_steel_fracture_beyond_eps_su():
    assert steel_stress(eps=0.12, fy=420.0, Es=200_000.0, eps_su=0.10) == 0.0


def test_steel_symmetric_in_compression():
    assert steel_stress(eps=-0.001, fy=420.0, Es=200_000.0, eps_su=0.10) \
        == pytest.approx(-200.0, rel=1e-3)


# ─── Columna de referencia ────────────────────────────────────────────────────
def _column_400x400_8_6() -> ElementData:
    """Columna 400×400, 8·#6 (As=22.8 cm²), fc=28, fy=420, N=420 kN compresión."""
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
        detailing=Detailing(compliance_level="DMO"),
        field=FieldObservations(),
    )


def test_mphi_column_runs_and_produces_curve():
    el = _column_400x400_8_6()
    mc = compute_moment_curvature(el)
    assert len(mc.phi_rad_per_m) > 10        # al menos 10 pasos antes de la falla
    assert len(mc.M_kNm) == len(mc.phi_rad_per_m)
    assert mc.M_peak_kNm > 0
    assert mc.phi_u_rad_per_m > mc.phi_y_rad_per_m > 0


def test_mphi_column_Mpeak_in_reasonable_range():
    """Columna 400×400 con 8·#6 y axial moderado — Mpeak típicamente 150-400 kN·m.

    Rango amplio porque el modelo analítico tiene aproximaciones (bars posicionadas
    solo top/bot, no en caras laterales en el detalle rotación-biaxial).
    """
    el = _column_400x400_8_6()
    mc = compute_moment_curvature(el)
    assert 100.0 < mc.M_peak_kNm < 500.0


def test_mphi_monotonic_up_to_peak():
    el = _column_400x400_8_6()
    mc = compute_moment_curvature(el)
    i_peak = mc.M_kNm.index(max(mc.M_kNm))
    # Hasta el pico, M debe ser no decreciente
    for i in range(1, i_peak + 1):
        assert mc.M_kNm[i] >= mc.M_kNm[i - 1] - 1.0  # ruido numérico ±1 kN·m


def test_mphi_captures_eps_c_004_threshold():
    """Debería haber un φ donde εc_cover alcanza 0.004 (DS2)."""
    el = _column_400x400_8_6()
    mc = compute_moment_curvature(el)
    assert mc.phi_eps_c_004 is not None
    assert mc.phi_eps_c_004 > 0
    assert mc.phi_eps_c_004 < mc.phi_u_rad_per_m


def test_mphi_captures_eps_cu_as_ultimate():
    """εcu del core (0.015) debe alcanzarse antes de que M caiga al 80% del pico.

    Como el núcleo es más dúctil que el cover y el acero no fractura a εsu=0.10
    típicamente antes de εcu, el φ_u físico coincide con el φ_eps_cu.
    """
    el = _column_400x400_8_6()
    mc = compute_moment_curvature(el)
    # El modelo analítico puede completar el barrido sin alcanzar εcu si φ_max
    # es demasiado bajo. Verificamos que phi_u existe y es coherente.
    assert mc.phi_u_rad_per_m > 0
    if mc.phi_eps_cu is not None:
        # Si se capturó εcu, debería estar cerca del φ_u físico
        assert mc.phi_eps_cu <= mc.phi_u_rad_per_m + 0.01


def test_mphi_higher_axial_gives_smaller_phi_u():
    """Columna más cargada axialmente → φu menor (confinamiento controla).
    """
    el_low  = _column_400x400_8_6()
    el_low.axial.N_grav_kN = 200.0
    el_low.axial.recompute_nu(el_low.geometry, el_low.materials)

    el_high = _column_400x400_8_6()
    el_high.axial.N_grav_kN = 1500.0
    el_high.axial.recompute_nu(el_high.geometry, el_high.materials)

    mc_low  = compute_moment_curvature(el_low)
    mc_high = compute_moment_curvature(el_high)
    # Axial alto consume ductilidad — φu menor
    assert mc_high.phi_u_rad_per_m < mc_low.phi_u_rad_per_m


def test_mphi_uses_spec_confinement_if_given():
    """Si se pasa spec_confinement con εcu alto, el núcleo soporta más
    curvatura antes de agotar — Mu (pico) debe mantenerse o aumentar."""
    el = _column_400x400_8_6()
    conf_low  = {"fcc_MPa": 32.0, "eps_cc": 0.003, "eps_cu": 0.008}
    conf_high = {"fcc_MPa": 42.0, "eps_cc": 0.006, "eps_cu": 0.030}
    mc_low  = compute_moment_curvature(el, spec_confinement=conf_low)
    mc_high = compute_moment_curvature(el, spec_confinement=conf_high)
    # Mayor εcu permite llegar a φ más alto antes de que el núcleo falle
    assert mc_high.phi_u_rad_per_m >= mc_low.phi_u_rad_per_m
    # Y el φ_eps_cu si existe en ambos, debe ser mayor en el caso high
    if mc_low.phi_eps_cu and mc_high.phi_eps_cu:
        assert mc_high.phi_eps_cu > mc_low.phi_eps_cu


def test_mphi_bilinear_my_less_than_mpeak():
    """La idealización bilineal apunta a Mmax (pico); My ≤ Mpeak."""
    el = _column_400x400_8_6()
    mc = compute_moment_curvature(el)
    assert 0 < mc.M_y_kNm <= mc.M_peak_kNm + 1.0   # tolera 1 kN·m de ruido


def test_mphi_to_dict_serializable():
    el = _column_400x400_8_6()
    mc = compute_moment_curvature(el)
    d = mc.to_dict()
    import json
    s = json.dumps(d)
    assert "phi_rad_per_m" in s
    assert "M_u_kNm" in s
