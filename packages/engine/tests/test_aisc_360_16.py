"""Tests del modulo de verificacion AISC 360-16.

Valores de referencia del AISC Steel Construction Manual 15th Edition:
    - W14x90/A992 como columna (Chapter E — compresion)
    - W24x55/A992 como viga (Chapter F — flexion)
    - Combinada H1-1a/b con demanda variable
"""
from __future__ import annotations

import math

import pytest

from engine.building.design.aisc_360_16 import (
    PHI_B,
    PHI_C,
    check_steel_member,
    combined_check,
    compression_strength,
    flexural_strength_strong_axis,
    flexural_strength_weak_axis,
)
from engine.sections.steel_section import make_steel_section


# ─────────────────────────────────────────────────────────────────────────────
# Chapter E — Compresion
# ─────────────────────────────────────────────────────────────────────────────

class TestCompression:

    def test_w14x90_a992_short_column(self):
        """W14x90/A992 con KL = 3 m (ry=93.98 mm → λ ≈ 32, zona inelastica).

        Valores aproximados AISC Manual Table 4-1:
        - W14x90 ry ≈ 93.9 mm, A = 16.77 cm² (en SI).
        - Para KL = 3000 mm, λ ≈ 32, Fcr ≈ 335 MPa → Pn ≈ 5930 kN.
        """
        sec = make_steel_section("W14X90", "A992")
        r = compression_strength(sec, K_times_L_mm=3000.0, axis="weak")
        # Zona inelastica (λ << λ_lim para A992)
        assert r.mode == "inelastic"
        # Pn esperado ~5500 kN (A·Fcr con Fcr≈320 MPa en zona inelastica).
        # AISC Manual puede dar ligeramente distinto por slenderness reductions.
        assert 5000 < r.Pn_kN < 6500
        assert r.phi_Pn_kN == pytest.approx(PHI_C * r.Pn_kN, rel=1e-6)

    def test_w14x90_a992_slender_elastic(self):
        """W14x90 con KL = 15 m (columna larga → zona elastica).

        λ = 15000/93.9 ≈ 160 >> λ_lim ≈ 113 → Fcr = 0.877·Fe.
        """
        sec = make_steel_section("W14X90", "A992")
        r = compression_strength(sec, K_times_L_mm=15_000.0, axis="weak")
        assert r.mode == "elastic"
        assert r.Fcr_MPa == pytest.approx(0.877 * r.Fe_MPa, rel=1e-9)

    def test_lam_lim_matches_formula(self):
        """λ_lim = 4.71 √(E/Fy). Para A992 (Fy=345, E=200000) → λ_lim ≈ 113.4."""
        sec = make_steel_section("W14X90", "A992")
        r = compression_strength(sec, K_times_L_mm=3000.0)
        expected = 4.71 * math.sqrt(200_000.0 / 345.0)
        assert r.lam_lim == pytest.approx(expected, rel=1e-9)


# ─────────────────────────────────────────────────────────────────────────────
# Chapter F — Flexion
# ─────────────────────────────────────────────────────────────────────────────

class TestFlexureStrongAxis:

    def test_w24x55_lb_zero_plastic(self):
        """W24x55/A992 con Lb=0 → Mn = Mp = Zx·fy ≈ 757 kN·m.

        Z_x W24X55 = 2.196e6 mm³, Fy = 345 MPa → Mp = 2.196e6 · 345 / 1e6 = 757.6 kN·m.
        """
        sec = make_steel_section("W24X55", "A992")
        r = flexural_strength_strong_axis(sec, Lb_mm=0.0)
        assert r.region == "plastic"
        assert r.Mn_kNm == pytest.approx(sec.Mp_x / 1e6, rel=1e-9)
        assert 740 < r.Mn_kNm < 770

    def test_w24x55_long_unbraced_elastic_ltb(self):
        """W24x55 con Lb muy grande (Lb > Lr) → zona elastica LTB, Mn < Mp."""
        sec = make_steel_section("W24X55", "A992")
        r = flexural_strength_strong_axis(sec, Lb_mm=12_000.0)
        assert r.region in ("inelastic_LTB", "elastic_LTB")
        assert r.Mn_kNm < r.Mp_kNm

    def test_w24x55_Lp_in_range(self):
        """Lp = 1.76 · ry · √(E/Fy). W24X55 ry≈34 mm → Lp ≈ 1430 mm."""
        sec = make_steel_section("W24X55", "A992")
        r = flexural_strength_strong_axis(sec, Lb_mm=0.0)
        expected_Lp = 1.76 * sec.shape.ry * math.sqrt(200_000.0 / 345.0)
        assert r.Lp_mm == pytest.approx(expected_Lp, rel=1e-9)
        assert 1200 < r.Lp_mm < 1700

    def test_cb_amplifies_moderately(self):
        """Cb > 1 amplifica Mn solo en zona LTB; en plastica se mantiene en Mp."""
        sec = make_steel_section("W24X55", "A992")
        r1 = flexural_strength_strong_axis(sec, Lb_mm=4000.0, Cb=1.0)
        r2 = flexural_strength_strong_axis(sec, Lb_mm=4000.0, Cb=1.5)
        if r1.region == "plastic":
            # Si estamos en zona plastica, Cb no debe cambiar (Mn = Mp)
            assert r1.Mn_kNm == pytest.approx(r2.Mn_kNm, rel=1e-9)
        else:
            # En zona LTB, Mn con Cb mayor >= Mn con Cb menor (pero ≤ Mp)
            assert r2.Mn_kNm >= r1.Mn_kNm


class TestFlexureWeakAxis:

    def test_w24x55_weak_axis_mp(self):
        """Eje debil sin LTB: Mn = min(Mp, 1.6·Fy·Sy)."""
        sec = make_steel_section("W24X55", "A992")
        r = flexural_strength_weak_axis(sec)
        Fy = sec.material.fy
        Sy = sec.shape.Sy
        Zy = sec.shape.Zy
        Mp = Zy * Fy
        Mn_expected = min(Mp, 1.6 * Fy * Sy)
        assert r.Mn_Nmm == pytest.approx(Mn_expected, rel=1e-9)


# ─────────────────────────────────────────────────────────────────────────────
# Chapter H — Combinada
# ─────────────────────────────────────────────────────────────────────────────

class TestCombined:

    def test_axial_dominated_H1_1a(self):
        """Pr/Pc = 0.5 (≥ 0.2) → H1-1a aplica."""
        r = combined_check(
            Pr_kN=1000, Mrx_kNm=200, Mry_kNm=0,
            Pc_kN=2000, Mcx_kNm=600, Mcy_kNm=200,
        )
        assert r.equation == "H1-1a"
        # DC = 0.5 + (8/9)·(200/600) = 0.5 + 0.296 = 0.796
        assert r.DC == pytest.approx(0.5 + (8/9) * (200/600), rel=1e-9)

    def test_flexure_dominated_H1_1b(self):
        """Pr/Pc = 0.1 (< 0.2) → H1-1b aplica."""
        r = combined_check(
            Pr_kN=200, Mrx_kNm=300, Mry_kNm=100,
            Pc_kN=2000, Mcx_kNm=600, Mcy_kNm=200,
        )
        assert r.equation == "H1-1b"
        # DC = 0.1/2 + (300/600 + 100/200) = 0.05 + 0.5 + 0.5 = 1.05
        assert r.DC == pytest.approx(0.05 + 0.5 + 0.5, rel=1e-9)
        assert r.ok is False

    def test_ok_below_unity(self):
        r = combined_check(
            Pr_kN=100, Mrx_kNm=100, Mry_kNm=0,
            Pc_kN=2000, Mcx_kNm=600, Mcy_kNm=200,
        )
        # DC = 0.05/2 + 100/600 = 0.025 + 0.167 ≈ 0.192
        assert r.ok is True
        assert r.DC < 0.3


# ─────────────────────────────────────────────────────────────────────────────
# API de alto nivel — check_steel_member
# ─────────────────────────────────────────────────────────────────────────────

class TestMemberCheck:

    def test_w14x90_a992_column_combined(self):
        """Columna W14x90/A992 de 3 m, demanda 1500 kN axial + 100 kN·m Mx."""
        sec = make_steel_section("W14X90", "A992")
        chk = check_steel_member(
            sec, L_mm=3000.0, K=1.0,
            Pr_kN=1500, Mrx_kNm=100, Mry_kNm=0,
        )
        assert chk.compression.Pn_kN > 0
        assert chk.flexure_x.Mn_kNm > 0
        assert chk.combined.ok is True
        assert chk.combined.DC < 1.0

    def test_summary_fields_populated(self):
        sec = make_steel_section("W24X55", "A992")
        chk = check_steel_member(
            sec, L_mm=4000.0, Lb_mm=4000.0,
            Pr_kN=0, Mrx_kNm=200, Mry_kNm=0,
        )
        assert chk.section_name == "W24X55"
        assert chk.grade == "A992"
        assert chk.combined.equation in ("H1-1a", "H1-1b")
