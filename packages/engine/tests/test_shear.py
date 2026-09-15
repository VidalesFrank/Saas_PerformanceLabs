"""Tests del motor de cortante — NSR-10 y ACI 318-19.

Cada test compara el resultado del motor contra valores calculados a mano con
las fórmulas de código. La consistencia entre NSR-10 y ACI 318-19 se verifica
en los casos comunes (misma fórmula de Vs, mismo φ, mismo s_max en zonas no
sísmicas).
"""
import math
import pytest

from engine.sections.shear import (
    ShearDemand, ShearGeometry, TransverseReinforcement,
    compute_shear_check, _lambda_s,
)


# ── Fixtures reusables ──────────────────────────────────────────────────────

def _beam_400x600():
    """Viga 400×600 mm, d=540 mm, f'c=28 MPa."""
    return ShearGeometry(bw_mm=400, d_mm=540, Ag_mm2=400 * 600, h_mm=600)


def _column_400x400():
    """Columna 400×400 mm, d=350 mm."""
    return ShearGeometry(bw_mm=400, d_mm=350, Ag_mm2=400 * 400, h_mm=400)


# ── Tests NSR-10: Vc ────────────────────────────────────────────────────────

class TestVcNSR10:
    def test_beam_vc_simplified(self):
        # Vc = 0.17·1·√28·400·540 = 0.17·5.2915·400·540 = 194,325 N
        r = compute_shear_check(
            "NSR-10", "beam", "DMI", 28.0,
            _beam_400x600(),
            ShearDemand(Vu_N=100e3),
        )
        Vc_teor = 0.17 * math.sqrt(28) * 400 * 540
        assert abs(r.Vc_N - Vc_teor) / Vc_teor < 1e-6
        assert r.articles["Vc"] == "C.11.2.1.1"

    def test_column_with_axial_compression(self):
        # Nu = +500,000 N; Ag = 160,000 mm²  → factor = 1 + 500000/(14·160000) = 1.2232
        Nu = 500e3
        r = compute_shear_check(
            "NSR-10", "column", "DMI", 28.0,
            _column_400x400(),
            ShearDemand(Vu_N=80e3, Nu_N=Nu),
        )
        Ag = 160_000
        factor = 1.0 + Nu / (14.0 * Ag)
        Vc_teor = 0.17 * factor * math.sqrt(28) * 400 * 350
        assert abs(r.Vc_N - Vc_teor) / Vc_teor < 1e-6
        assert r.articles["Vc"] == "C.11.2.1.2"

    def test_column_with_axial_tension_zeroes_out(self):
        # Nu muy negativo → Vc = 0 (o cerca)
        r = compute_shear_check(
            "NSR-10", "column", "DMI", 28.0,
            _column_400x400(),
            ShearDemand(Vu_N=10e3, Nu_N=-2e6),   # tracción extrema
        )
        assert r.Vc_N == 0.0
        assert r.articles["Vc"] == "C.11.2.1.3"


# ── Tests ACI 318-19: Vc ─────────────────────────────────────────────────────

class TestVcACI:
    def test_beam_vc_with_min_reinf(self):
        # Con refuerzo mínimo, Vc = max((a), (b)).
        # (a) Vc_a = 0.17·√28·400·540 = 194,325 N
        # (b) Vc_b = 0.66·(0.01)^(1/3)·√28·400·540 = 0.66·0.2154·5.29·400·540 = 162,562 N
        # → Vc = 194,325 N
        rho_w = 0.01
        r = compute_shear_check(
            "ACI 318-19", "beam", "DMI", 28.0,
            _beam_400x600(),
            ShearDemand(Vu_N=100e3),
            rho_w=rho_w,
            transverse=TransverseReinforcement(Av_mm2=200, s_mm=200, fyt_MPa=420),
        )
        Vc_a = 0.17 * math.sqrt(28) * 400 * 540
        Vc_b = 0.66 * math.sqrt(28) * (rho_w ** (1/3)) * 400 * 540
        Vc_teor = max(Vc_a, Vc_b)
        assert abs(r.Vc_N - Vc_teor) / Vc_teor < 1e-6

    def test_beam_no_transverse_uses_lambda_s(self):
        # Sin refuerzo mínimo, Vc = 0.66·λs·λ·(ρw)^(1/3)·√f'c·bw·d
        # d = 540 → λs = √(2/(1+0.004·540)) = √(2/3.16) = √0.633 = 0.795
        d = 540
        lam_s = _lambda_s(d)
        assert abs(lam_s - math.sqrt(2 / (1 + 0.004 * 540))) < 1e-10
        rho_w = 0.01
        r = compute_shear_check(
            "ACI 318-19", "beam", "DMI", 28.0,
            _beam_400x600(),
            ShearDemand(Vu_N=50e3),
            rho_w=rho_w,
            transverse=None,
        )
        Vc_teor = 0.66 * lam_s * (rho_w ** (1/3)) * math.sqrt(28) * 400 * 540
        assert abs(r.Vc_N - Vc_teor) / Vc_teor < 1e-3
        assert r.articles["Vc"] == "22.5.5.1(c)"

    def test_column_axial_term_matches_manual(self):
        # ACI usa Nu/(6·Ag) — Nu = 500 kN, Ag = 160,000 → axial_term = 500000/(6·160000) = 0.5208
        # con refuerzo mínimo: Vc_a = (0.17·√28 + 0.5208)·400·350
        Nu = 500e3
        Ag = 160_000
        r = compute_shear_check(
            "ACI 318-19", "column", "DMI", 28.0,
            _column_400x400(),
            ShearDemand(Vu_N=50e3, Nu_N=Nu),
            rho_w=0.02,
            transverse=TransverseReinforcement(Av_mm2=142, s_mm=100, fyt_MPa=420),
        )
        axial = Nu / (6.0 * Ag)
        Vc_a = (0.17 * math.sqrt(28) + axial) * 400 * 350
        Vc_b = (0.66 * (0.02 ** (1/3)) * math.sqrt(28) + axial) * 400 * 350
        Vc_teor = max(Vc_a, Vc_b)
        assert abs(r.Vc_N - Vc_teor) / Vc_teor < 1e-3


# ── Tests: Vs — común a ambos códigos ───────────────────────────────────────

class TestVs:
    def test_vs_formula(self):
        # Vs = Av·fyt·d/s. Av = 2·71 = 142 mm² (#3 dos ramas), fyt=420, d=540, s=150
        Av, fyt, s = 142.0, 420.0, 150.0
        d = 540.0
        Vs_teor = Av * fyt * d / s
        r = compute_shear_check(
            "NSR-10", "beam", "DMI", 28.0,
            _beam_400x600(),
            ShearDemand(Vu_N=250e3),
            transverse=TransverseReinforcement(Av_mm2=Av, s_mm=s, fyt_MPa=fyt),
        )
        assert abs(r.Vs_N - Vs_teor) / Vs_teor < 1e-6

    def test_vs_capped_at_max(self):
        # Estribo muy pesado → Vs > Vs_lim → se cappea a 0.66·√f'c·bw·d
        r = compute_shear_check(
            "NSR-10", "beam", "DMI", 28.0,
            _beam_400x600(),
            ShearDemand(Vu_N=800e3),
            transverse=TransverseReinforcement(Av_mm2=5000, s_mm=50, fyt_MPa=420),
        )
        Vs_lim = 0.66 * math.sqrt(28) * 400 * 540
        assert abs(r.Vs_N - Vs_lim) / Vs_lim < 1e-6
        assert r.status == "fail"   # el diseño falla porque el Vs demanda supera el límite

    def test_nsr10_vs_aci_vs_identico(self):
        # Vs no depende del código
        d1 = ShearGeometry(bw_mm=300, d_mm=450, Ag_mm2=300*500, h_mm=500)
        arg = dict(
            fpc_MPa=28.0, geom=d1, demand=ShearDemand(Vu_N=200e3),
            transverse=TransverseReinforcement(Av_mm2=142, s_mm=120, fyt_MPa=420),
            rho_w=0.012,
        )
        r_n = compute_shear_check("NSR-10",     "beam", "DMI", **arg)
        r_a = compute_shear_check("ACI 318-19", "beam", "DMI", **arg)
        assert abs(r_n.Vs_N - r_a.Vs_N) < 1e-6


# ── Tests: espaciamiento máximo ──────────────────────────────────────────────

class TestSpacing:
    def test_general_low_vs(self):
        # Vs bajo → s_max = min(d/2, 600) = min(270, 600) = 270
        r = compute_shear_check(
            "NSR-10", "beam", "DMI", 28.0,
            _beam_400x600(),
            ShearDemand(Vu_N=100e3),
            transverse=TransverseReinforcement(Av_mm2=142, s_mm=200, fyt_MPa=420),
        )
        assert r.s_max_mm == 270.0   # d/2

    def test_general_high_vs_switches_to_d4(self):
        # Vs alto → s_max = min(d/4, 300) = min(135, 300) = 135
        # 0.33·√28·400·540 = 377,190 N; usamos Av grande a s=100 → Vs = 322,272·(2)...
        # Con Av=568, s=100 → Vs = 568·420·540/100 = 1,288,224 (>> 377 kN)
        r = compute_shear_check(
            "NSR-10", "beam", "DMI", 28.0,
            _beam_400x600(),
            ShearDemand(Vu_N=200e3),
            transverse=TransverseReinforcement(Av_mm2=568, s_mm=100, fyt_MPa=420),
        )
        assert r.s_max_mm == 135.0  # d/4

    def test_confined_zone_column_des(self):
        # Columna DES → s_max en Lo = min(dim_min/4, 6·db, 150) = min(400/4, 6·25, 150) = min(100, 150, 150) = 100
        r = compute_shear_check(
            "NSR-10", "column", "DES", 28.0,
            _column_400x400(),
            ShearDemand(Vu_N=80e3, Nu_N=200e3),
            transverse=TransverseReinforcement(Av_mm2=200, s_mm=90, fyt_MPa=420),
            db_long_mm=25.4, dim_min_mm=400,
        )
        # d/4 = 350/4 = 87.5 → s_max general = 87.5
        # sísmico = min(100, 150, 150) = 100 → total = min(87.5, 100) = 87.5
        assert r.s_max_mm <= 100
        assert "s_max_seismic" in r.articles


# ── Tests: DCR y estatus ────────────────────────────────────────────────────

class TestDCR:
    def test_ok_status_when_adequate(self):
        r = compute_shear_check(
            "NSR-10", "beam", "DMI", 28.0,
            _beam_400x600(),
            ShearDemand(Vu_N=150e3),
            transverse=TransverseReinforcement(Av_mm2=142, s_mm=150, fyt_MPa=420),
        )
        assert r.status == "ok"
        assert r.DCR < 1.0

    def test_fail_when_underdesigned(self):
        r = compute_shear_check(
            "NSR-10", "beam", "DMI", 28.0,
            _beam_400x600(),
            ShearDemand(Vu_N=500e3),
            transverse=TransverseReinforcement(Av_mm2=142, s_mm=200, fyt_MPa=420),
        )
        assert r.status == "fail"
        assert r.DCR > 1.0

    def test_no_transverse_status(self):
        r = compute_shear_check(
            "NSR-10", "beam", "DMI", 28.0,
            _beam_400x600(),
            ShearDemand(Vu_N=300e3),
            transverse=None,
        )
        assert r.status == "no-transverse"

    def test_phi_075(self):
        r = compute_shear_check(
            "NSR-10", "beam", "DMI", 28.0,
            _beam_400x600(),
            ShearDemand(Vu_N=100e3),
            transverse=TransverseReinforcement(Av_mm2=142, s_mm=150, fyt_MPa=420),
        )
        assert abs(r.phi_Vn_N - 0.75 * r.Vn_N) < 1e-6


# ── Test: Av mínimo ─────────────────────────────────────────────────────────

class TestAvMin:
    def test_av_min_formula(self):
        # Av,min = max(0.062·√f'c·bw·s/fyt, 0.35·bw·s/fyt)
        # con bw=400, s=200, fyt=420, f'c=28:
        #   0.062·√28·400·200/420 = 62.4 mm²
        #   0.35·400·200/420 = 66.7 mm² ← gobierna
        r = compute_shear_check(
            "NSR-10", "beam", "DMI", 28.0,
            _beam_400x600(),
            ShearDemand(Vu_N=100e3),
            transverse=TransverseReinforcement(Av_mm2=142, s_mm=200, fyt_MPa=420),
        )
        Av_min_teor = max(
            0.062 * math.sqrt(28) * 400 * 200 / 420,
            0.35 * 400 * 200 / 420,
        )
        assert abs(r.Av_min_mm2 - Av_min_teor) < 0.1
