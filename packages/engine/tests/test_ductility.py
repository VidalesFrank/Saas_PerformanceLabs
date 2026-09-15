"""Tests del módulo de ductilidad y longitud de rótula plástica."""
import math
import pytest

from engine.analysis.moment_curvature import MomentCurvaturePoint, MomentCurvatureResult
from engine.sections.ductility import (
    plastic_hinge_length, displacement_ductility, compute_ductility_metrics,
)


# ── Test: fórmula de Priestley ─────────────────────────────────────────────

class TestPriestleyLp:
    def test_priestley_ratio(self):
        # Lp = k·L + Lsp, k = min(0.2·(fu/fy − 1), 0.08)
        # Con fu/fy = 1.35 → k = min(0.07, 0.08) = 0.07
        # L = 3000 mm, db = 25.4 mm, fy = 420 MPa
        # Lsp = 0.022·420·25.4 = 234.7 mm
        # Lp = 0.07·3000 + 234.7 = 210 + 234.7 = 444.7 mm
        Lp, name, _ = plastic_hinge_length(
            L_mm=3000, db_mm=25.4, fy_MPa=420, section_depth_mm=400,
            method="priestley_2007", fu_over_fy=1.35,
        )
        assert "Priestley" in name
        assert abs(Lp - (0.07 * 3000 + 0.022 * 420 * 25.4)) < 0.5

    def test_priestley_k_capped_at_008(self):
        # Con fu/fy muy alto (1.60), k = min(0.12, 0.08) = 0.08
        Lp, _, _ = plastic_hinge_length(
            L_mm=3000, db_mm=25.4, fy_MPa=420, section_depth_mm=400,
            method="priestley_2007", fu_over_fy=1.60,
        )
        expected = 0.08 * 3000 + 0.022 * 420 * 25.4
        assert abs(Lp - expected) < 0.5


class TestPaulayPriestley:
    def test_pp_formula(self):
        # Lp = 0.08·L + 6·db
        Lp, name, _ = plastic_hinge_length(
            L_mm=3000, db_mm=25.4, fy_MPa=420, section_depth_mm=400,
            method="paulay_priestley",
        )
        assert "Paulay" in name
        expected = 0.08 * 3000 + 6 * 25.4
        assert abs(Lp - expected) < 0.1


class TestBaker:
    def test_baker_half_d(self):
        Lp, name, _ = plastic_hinge_length(
            L_mm=3000, db_mm=25.4, fy_MPa=420, section_depth_mm=400,
            method="baker",
        )
        assert "Baker" in name
        assert abs(Lp - 200) < 0.1     # 0.5·400


# ── Test: ductilidad de desplazamiento ─────────────────────────────────────

class TestDisplacementDuctility:
    def test_mu_delta_formula(self):
        # μΔ = 1 + 3·(μφ−1)·(Lp/L)·(1 − 0.5·Lp/L)
        mu_phi = 8.0
        L = 3000
        Lp = 300
        mu_delta = displacement_ductility(mu_phi, Lp, L)
        expected = 1 + 3 * 7 * (300 / 3000) * (1 - 0.5 * 300 / 3000)
        assert abs(mu_delta - expected) < 0.001

    def test_mu_delta_less_than_mu_phi(self):
        # Regla general: μΔ < μφ (la ductilidad de miembro es menor que la de sección)
        mu_delta = displacement_ductility(mu_phi=8.0, Lp=300, L=3000)
        assert mu_delta < 8.0
        assert mu_delta > 1.0

    def test_mu_delta_when_no_ductility(self):
        mu_delta = displacement_ductility(mu_phi=1.0, Lp=300, L=3000)
        assert abs(mu_delta - 1.0) < 1e-9


# ── Test: integración con MomentCurvatureResult ─────────────────────────────

def _synthetic_mc_curve() -> MomentCurvatureResult:
    """Curva M-φ sintética representativa de columna 400×400 8#8:
    Mu ≈ 320 kN·m, φy ≈ 8e-6, φu ≈ 6.4e-5, μφ ≈ 8.
    """
    curve = []
    Mu = 320e6   # N·mm
    phi_y = 8e-6
    phi_u = 64e-6
    # Región elástica hasta 0.7·Mu (aproximación primera fluencia)
    for i in range(11):
        phi = i * (0.7 * phi_y) / 10
        m   = phi / phi_y * Mu * 0.7 / 0.7   # lineal
        curve.append(MomentCurvaturePoint(phi=phi, moment=m))
    # Transición hasta Mu
    for i in range(1, 11):
        phi = 0.7 * phi_y + i * (phi_y - 0.7 * phi_y) / 10
        m   = 0.7 * Mu + i * (0.3 * Mu) / 10
        curve.append(MomentCurvaturePoint(phi=phi, moment=m))
    # Plateau hasta φu
    for i in range(1, 21):
        phi = phi_y + i * (phi_u - phi_y) / 20
        m   = Mu * (1.0 - 0.05 * (i / 20))    # descenso muy leve
        curve.append(MomentCurvaturePoint(phi=phi, moment=m))

    return MomentCurvatureResult(
        curve=curve,
        phi_yield=phi_y,
        moment_yield=0.9 * Mu,
        phi_max=phi_u,
        moment_max=Mu,
        phi_ultimate=phi_u,
        moment_ultimate=0.95 * Mu,
        ductility=phi_u / phi_y,
        axial_load_n=0.0,
        ei_secant=Mu / phi_y,
        failure_reached=True,
    )


class TestComputeMetrics:
    def test_computes_all_fields(self):
        mc = _synthetic_mc_curve()
        m = compute_ductility_metrics(
            mc, member_length_mm=3000,
            db_long_mm=25.4, fy_MPa=420, section_depth_mm=400,
        )
        assert m.phi_yield_ideal > 0
        assert m.moment_yield_ideal > 0
        assert m.mu_phi > 1.0
        assert m.mu_delta > 1.0
        assert m.mu_delta < m.mu_phi
        assert m.Lp_mm > 0
        assert m.energy_kNm_per_m > 0
        assert "Priestley" in m.Lp_method

    def test_lp_over_L_reasonable(self):
        mc = _synthetic_mc_curve()
        m = compute_ductility_metrics(mc, member_length_mm=3000,
                                       db_long_mm=25.4, fy_MPa=420,
                                       section_depth_mm=400)
        # Lp/L típicamente entre 0.05 y 0.25 para columnas altas
        assert 0.05 < m.Lp_over_L < 0.35

    def test_warning_when_short_member(self):
        # Lp/L > 0.3 → debe advertir
        mc = _synthetic_mc_curve()
        m = compute_ductility_metrics(mc, member_length_mm=500,
                                       db_long_mm=25.4, fy_MPa=420,
                                       section_depth_mm=400)
        assert m.Lp_over_L > 0.30
        assert any("Lp/L" in n for n in m.notes)
