"""Tests del módulo de servicio y fisuración."""
import math
import pytest

from engine.sections.document import (
    ConcreteDef, ConcreteRegion, RectShape,
    ReinforcementBar, SectionDocument, SteelDef,
)
from engine.sections.serviceability import (
    concrete_modulus, modulus_of_rupture, compute_serviceability,
)


class TestConcreteModulus:
    def test_ec_28MPa(self):
        # Ec = 4700·√28 = 24870 MPa
        assert abs(concrete_modulus(28) - 4700 * math.sqrt(28)) < 0.1

    def test_ec_lightweight(self):
        # Concreto ligero (wc=1600): factor = (1600/2400)^1.5 = 0.544
        assert abs(concrete_modulus(28, wc_kg_m3=1600) - 4700 * math.sqrt(28) * (1600/2400)**1.5) < 0.1


class TestModulusOfRupture:
    def test_fr_28MPa(self):
        # fr = 0.62·√28 = 3.28 MPa
        assert abs(modulus_of_rupture(28) - 0.62 * math.sqrt(28)) < 0.001

    def test_fr_lightweight_lambda(self):
        assert abs(modulus_of_rupture(28, lam=0.85) - 0.62 * 0.85 * math.sqrt(28)) < 0.001


# ── Viga 300×500 con 3#8 en fondo (caso canónico Nilson Ex. 6.3) ────────────

def _beam_300x500_3num8() -> SectionDocument:
    c = ConcreteDef(fpc=28.0)
    s = SteelDef(fy=420.0, Es=200000.0)
    cover = 40
    y_bot = -250 + cover
    bars = [
        ReinforcementBar(y=y_bot, z=-100, bar_size="#8", steel_id=s.id),
        ReinforcementBar(y=y_bot, z=0.0,  bar_size="#8", steel_id=s.id),
        ReinforcementBar(y=y_bot, z=+100, bar_size="#8", steel_id=s.id),
    ]
    return SectionDocument(
        concrete_defs=[c], steel_defs=[s],
        regions=[ConcreteRegion(shape=RectShape(height=500, width=300),
                                 concrete_id=c.id, cover_to_bar=cover)],
        bars=bars,
    )


class TestServiceabilityBeam:
    def test_Mcr_formula(self):
        # Mcr = fr·Ig/yt
        # Ig = 300·500³/12 = 3.125e9 mm⁴, yt = 250 mm
        # fr = 0.62·√28 = 3.28 MPa
        # Mcr = 3.28 · 3.125e9 / 250 = 41.03·10⁶ N·mm = 41.03 kN·m
        r = compute_serviceability(_beam_300x500_3num8(), Ma_kNm=0.0, element_kind="beam")
        Mcr_teor = 0.62 * math.sqrt(28) * (300 * 500**3 / 12) / 250 / 1e6
        assert abs(r.Mcr_kNm - Mcr_teor) / Mcr_teor < 1e-3

    def test_Ig_matches_gross(self):
        # Ig = 300·500³/12 = 3.125e9 mm⁴ = 312,500 cm⁴
        r = compute_serviceability(_beam_300x500_3num8())
        assert abs(r.Ig_cm4 - 312500) / 312500 < 1e-6

    def test_Icr_less_than_Ig(self):
        # Regla básica: Icr < Ig (sección fisurada tiene menos rigidez)
        r = compute_serviceability(_beam_300x500_3num8())
        assert r.Icr_cm4 < r.Ig_cm4
        assert r.Icr_cm4 > 0.05 * r.Ig_cm4    # pero no absurdamente bajo

    def test_Icr_matches_closed_form(self):
        # Viga 300×500 con 3#8 a d=460 mm:
        # kd² + (2n·As/b)·kd − 2n·As·d/b = 0
        # → kd ≈ 157.5 mm (n=8.04, As=1530)
        # Icr = b·kd³/3 + n·As·(d − kd)²
        r = compute_serviceability(_beam_300x500_3num8())
        n = 200000 / (4700 * math.sqrt(28))     # 8.04
        As = 1530                                 # 3·510
        b = 300
        d = 460
        c1 = 2 * n * As / b
        c2 = 2 * n * As * d / b
        kd = (-c1 + math.sqrt(c1 ** 2 + 4 * c2)) / 2
        Icr_teor = b * kd ** 3 / 3 + n * As * (d - kd) ** 2
        Icr_teor_cm4 = Icr_teor / 1e4
        # Tolerancia 5% (nuestra iteración usa (n-1) para acero comprimido — más preciso)
        assert abs(r.Icr_cm4 - Icr_teor_cm4) / Icr_teor_cm4 < 0.05

    def test_Ie_equals_Ig_when_Ma_below_Mcr(self):
        # Si Ma < Mcr: sección no fisurada → Ie = Ig
        r = compute_serviceability(_beam_300x500_3num8(), Ma_kNm=20.0)   # Mcr ≈ 41 kN·m
        assert r.Ie_cm4 == r.Ig_cm4

    def test_Ie_between_Ig_and_Icr_when_Ma_above_Mcr(self):
        # Ma > Mcr → Icr ≤ Ie ≤ Ig
        r = compute_serviceability(_beam_300x500_3num8(), Ma_kNm=100.0)
        assert r.Icr_cm4 <= r.Ie_cm4 <= r.Ig_cm4

    def test_Ie_branson_formula(self):
        # Ie = (Mcr/Ma)³·Ig + [1-(Mcr/Ma)³]·Icr
        r = compute_serviceability(_beam_300x500_3num8(), Ma_kNm=80.0)
        ratio = r.Mcr_kNm / 80.0
        Ie_teor = ratio**3 * r.Ig_cm4 + (1 - ratio**3) * r.Icr_cm4
        assert abs(r.Ie_cm4 - Ie_teor) / Ie_teor < 1e-3


class TestNSR10Recommendation:
    def test_beam_recommends_035(self):
        r = compute_serviceability(_beam_300x500_3num8(), element_kind="beam")
        assert abs(r.Ie_over_Ig_recommended - 0.35) < 1e-6

    def test_column_recommends_070(self):
        r = compute_serviceability(_beam_300x500_3num8(), element_kind="column")
        assert abs(r.Ie_over_Ig_recommended - 0.70) < 1e-6

    def test_wall_uncracked_070(self):
        r = compute_serviceability(_beam_300x500_3num8(), element_kind="wall", wall_cracked=False)
        assert abs(r.Ie_over_Ig_recommended - 0.70) < 1e-6

    def test_wall_cracked_035(self):
        r = compute_serviceability(_beam_300x500_3num8(), element_kind="wall", wall_cracked=True)
        assert abs(r.Ie_over_Ig_recommended - 0.35) < 1e-6

    def test_slab_2d_025(self):
        r = compute_serviceability(_beam_300x500_3num8(), element_kind="slab_2d")
        assert abs(r.Ie_over_Ig_recommended - 0.25) < 1e-6


class TestServiceabilityMaterials:
    def test_n_ratio(self):
        r = compute_serviceability(_beam_300x500_3num8())
        # n = Es/Ec = 200000 / (4700·√28) = 8.04
        n_teor = 200000 / (4700 * math.sqrt(28))
        assert abs(r.n - n_teor) < 0.01

    def test_Ec_matches_formula(self):
        r = compute_serviceability(_beam_300x500_3num8())
        assert abs(r.Ec_MPa - 4700 * math.sqrt(28)) < 0.1
