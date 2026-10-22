"""Tests Fase 2 — modo de falla."""
from __future__ import annotations

import math

import pytest

from engine.building.nonlinear.element_data import (
    AxialState, Detailing, ElementData, FieldObservations, Geometry,
    LongitudinalReinf, Materials, TransverseReinf,
)
from engine.building.nonlinear.failure_mode import (
    _k_sezen_moehle,
    compute_failure_mode,
    compute_vn_aci,
    compute_vn_sezen_moehle,
    compute_vp,
    flag_deficient_detailing,
)


def _column_dmo() -> ElementData:
    """Columna RC 400×400, DMO: 8·#6 long, estribos #3 @100 con 3×2 ramas."""
    geo = Geometry(b_m=0.40, h_m=0.40, cover_m=0.040,
                   d_mm=341.0, L_m=3.0, Ln_m=3.0, Ls_m=1.5)
    mat = Materials(fc_MPa=28.0, fy_MPa=420.0, fu_MPa=630.0, eps_su=0.10, fyh_MPa=420.0)
    long_r = LongitudinalReinf(As_cm2=22.8, n_bars=8, bar_label="#6", db_mm=19.1,
                               rho=0.01425, rho_prima=0.00712, As_prima_cm2=11.4)
    tran_r = TransverseReinf(tie_bar_label="#3", db_tie_mm=9.5,
                             n_legs_b=3, n_legs_h=2,
                             s_confined_mm=100, s_general_mm=150,
                             A_tie_mm2=math.pi * 9.5 ** 2 / 4,
                             rho_sh_b=0.00354, rho_sh_h=0.00266,
                             rho_sh=0.00266, rho_s_vol=0.008,
                             hook_type="135deg")
    detail = Detailing(splice_in_hinge=False, s_over_db_long=5.24,
                      rho_sh_meets_DES=False, rho_sh_meets_DMO=True,
                      compliance_level="DMO")
    axial = AxialState(N_grav_kN=420.0, nu=0.094)
    return ElementData(fid="C1", kind="column", story="P1", section_name="C40x40",
                       node_i="J1", node_j="J2",
                       geometry=geo, materials=mat, longitudinal=long_r,
                       transverse=tran_r, axial=axial, detailing=detail,
                       field=FieldObservations())


def _column_poor_detailing() -> ElementData:
    """Columna con detallado deficiente: gancho 90°, s/db=10, estribos esparcidos."""
    c = _column_dmo()
    c.transverse.hook_type = "90deg"
    c.transverse.s_confined_mm = 200
    c.detailing.s_over_db_long = 200 / 19.1   # 10.47
    c.detailing.rho_sh_meets_DMO = False
    c.detailing.rho_sh_meets_DES = False
    return c


def _beam_dmo() -> ElementData:
    """Viga 300×500, 4·#6 top, 2·#5 bot en end_i, estribos #3 @100."""
    geo = Geometry(b_m=0.30, h_m=0.50, cover_m=0.040,
                   d_mm=441.0, L_m=5.0, Ln_m=5.0, Ls_m=2.5)
    mat = Materials(fc_MPa=28.0, fy_MPa=420.0, fu_MPa=630.0, eps_su=0.10, fyh_MPa=420.0)
    long_r = LongitudinalReinf(As_cm2=11.4, n_bars=4, bar_label="#6", db_mm=19.1,
                               rho=0.0076, rho_prima=0.00265, As_prima_cm2=3.97)
    tran_r = TransverseReinf(tie_bar_label="#3", db_tie_mm=9.5,
                             n_legs_b=2, n_legs_h=2,
                             s_confined_mm=100, s_general_mm=200,
                             A_tie_mm2=math.pi * 9.5 ** 2 / 4,
                             rho_sh_b=0.00089, rho_sh_h=0.00472,
                             rho_sh=0.00089, rho_s_vol=0.005,
                             hook_type="135deg")
    detail = Detailing(splice_in_hinge=False, s_over_db_long=5.24,
                      rho_sh_meets_DES=False, rho_sh_meets_DMO=True,
                      compliance_level="DMO")
    return ElementData(fid="V1", kind="beam", story="P1", section_name="V30x50",
                       node_i="J1", node_j="J2",
                       geometry=geo, materials=mat, longitudinal=long_r,
                       transverse=tran_r, axial=AxialState(), detailing=detail)


# ─── Vn ACI ──────────────────────────────────────────────────────────────────
def test_vn_aci_column_matches_hand_calc():
    """Columna 400×400, N=420kN compresión, estribos #3@100 con 2 ramas en h.

    Vc = 0.17·√28·400·341 ≈ 122700 N
    Factor axial = 1 + 420000/(14·400·400) = 1.188
    Vc' = 145800 N
    Vs = 2·70.88·420·341/100 ≈ 203000 N
    Vn ≈ 348.8 kN
    """
    c = _column_dmo()
    Vn = compute_vn_aci(c)
    assert Vn == pytest.approx(348.8, rel=5e-2)


def test_vn_aci_beam_matches_hand_calc():
    """Viga 300×500 sin axial, 2 ramas @100.

    Vc = 0.17·√28·300·441 ≈ 119000 N
    Vs = 2·70.88·420·441/100 ≈ 262600 N
    Vn ≈ 381.6 kN
    """
    v = _beam_dmo()
    Vn = compute_vn_aci(v)
    assert Vn == pytest.approx(381.6, rel=5e-2)


def test_vn_aci_scales_with_axial():
    c_low  = _column_dmo()
    c_low.axial.N_grav_kN  = 100.0
    c_high = _column_dmo()
    c_high.axial.N_grav_kN = 1500.0
    assert compute_vn_aci(c_high) > compute_vn_aci(c_low)


# ─── Sezen-Moehle ────────────────────────────────────────────────────────────
def test_sezen_moehle_k_factor():
    assert _k_sezen_moehle(1.0)  == 1.0
    assert _k_sezen_moehle(2.0)  == 1.0
    assert _k_sezen_moehle(6.0)  == 0.7
    assert _k_sezen_moehle(10.0) == 0.7
    assert _k_sezen_moehle(4.0)  == pytest.approx(0.85)


def test_vn_sezen_moehle_degrades_with_ductility():
    c = _column_dmo()
    Vn_low,  k_low  = compute_vn_sezen_moehle(c, mu_disp=1.0)
    Vn_high, k_high = compute_vn_sezen_moehle(c, mu_disp=6.0)
    assert k_low == 1.0
    assert k_high == pytest.approx(0.7)
    assert Vn_high < Vn_low


# ─── Vp ──────────────────────────────────────────────────────────────────────
def test_vp_formula():
    assert compute_vp(Mp_kNm=100.0, Ln_m=4.0) == 50.0


# ─── Clasificación ───────────────────────────────────────────────────────────
def test_flexion_dominated_when_Mp_low():
    """Mp bajo (100 kN·m) en columna con Vn≈350 kN → Vp/Vn ≈ 0.19 → flexión."""
    c = _column_dmo()
    r = compute_failure_mode(c, Mp_kNm=100.0)
    assert r.failure_mode == "flexion"
    assert r.asce_condition == "i"
    assert r.Vp_over_Vn < 0.6


def test_shear_dominated_when_Mp_high():
    """Mp alto fuerza Vp > Vn → cortante."""
    c = _column_dmo()
    r = compute_failure_mode(c, Mp_kNm=1000.0)   # 2·1000/3 = 667 kN > 348
    assert r.failure_mode == "cortante"
    assert r.asce_condition == "iii"
    assert r.Vp_over_Vn > 1.0


def test_flexion_cortante_middle_range():
    """Vp/Vn entre 0.6 y 1.0 → flexión-cortante."""
    c = _column_dmo()
    r = compute_failure_mode(c, Mp_kNm=400.0)   # Vp = 267 → ratio ≈ 0.77
    assert r.failure_mode == "flexion_cortante"
    assert r.asce_condition == "ii"


def test_poor_detailing_forces_flexion_cortante():
    """Columna con gancho 90° + s/db=10 — aunque Vp/Vn sea bajo, es ii."""
    c = _column_poor_detailing()
    r = compute_failure_mode(c, Mp_kNm=100.0)
    assert r.failure_mode == "flexion_cortante"
    assert "HOOK_90" in r.flags
    assert "S_OVER_DB_GT_6" in r.flags


def test_splice_in_hinge_forces_condition_iv():
    c = _column_dmo()
    c.detailing.splice_in_hinge = True
    r = compute_failure_mode(c, Mp_kNm=100.0)
    assert r.asce_condition == "iv"
    assert "SPLICE_IN_HINGE" in r.flags


# ─── Banderas ────────────────────────────────────────────────────────────────
def test_flags_hook_90_detected():
    c = _column_poor_detailing()
    flags = flag_deficient_detailing(c)
    assert "HOOK_90" in flags
    assert "S_OVER_DB_GT_6" in flags
    assert "RHO_SH_LT_DMO" in flags


def test_flags_high_axial_detected():
    c = _column_dmo()
    c.axial.nu = 0.6
    assert "HIGH_AXIAL" in flag_deficient_detailing(c)


def test_flags_low_confinement_detected():
    c = _column_dmo()
    c.transverse.rho_s_vol = 0.002
    assert "LOW_CONFINEMENT" in flag_deficient_detailing(c)


def test_no_flags_in_well_detailed_column():
    c = _column_dmo()
    c.detailing.rho_sh_meets_DES = True
    c.transverse.rho_s_vol = 0.012
    flags = flag_deficient_detailing(c)
    assert len(flags) == 0


# ─── Serialización ───────────────────────────────────────────────────────────
def test_failure_mode_to_dict():
    c = _column_dmo()
    r = compute_failure_mode(c, Mp_kNm=200.0)
    d = r.to_dict()
    import json
    json.dumps(d)       # debe ser JSON-serializable
    assert d["failure_mode"] in ("flexion", "flexion_cortante", "cortante")
