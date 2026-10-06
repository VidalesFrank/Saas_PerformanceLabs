"""
Tests del módulo masonry — infills como puntales equivalentes.

Verifica:
  - MasonryMaterialDef.resolved_Em_mpa para VP (775·fm), HP (622·fm) y custom.
  - custom sin Em explícito debe lanzar ValueError.
  - masonry_concrete01_params retorna 4-tupla con signos negativos (compresión
    OpenSees) y valores consistentes con Kent-Park simplificado.
  - strut_geometry: diagonal, ancho efectivo, área bruta y área efectiva con
    reducción de Al-Chaar.
  - al_chaar_reduction: valores tabulados (0%, 10%, 20%, 30%, 50%, 100%).
  - InfillPanel.validate: rangos de opening_ratio, width_ratio, thickness_m.
  - cache_key es estable entre instancias equivalentes.
"""
import math

import pytest

from app.engine.building.masonry import (
    MasonryMaterialDef,
    masonry_concrete01_params,
    InfillPanel,
    strut_geometry,
    al_chaar_reduction,
)


# ── MasonryMaterialDef ────────────────────────────────────────────────────────

class TestMasonryMaterialDef:
    def test_vp_em_uses_775_ratio(self):
        """Guerrero et al. 2022: Em = 775·fm para ladrillo de perforación vertical."""
        m = MasonryMaterialDef(name="M_VP_5", fm_mpa=5.0, brick_type="VP")
        assert m.resolved_Em_mpa() == pytest.approx(3875.0)

    def test_hp_em_uses_622_ratio(self):
        """Borah et al. 2021: Em = 622·fm para ladrillo de perforación horizontal."""
        m = MasonryMaterialDef(name="M_HP_5", fm_mpa=5.0, brick_type="HP")
        assert m.resolved_Em_mpa() == pytest.approx(3110.0)

    def test_custom_requires_explicit_em(self):
        m = MasonryMaterialDef(name="M_C", fm_mpa=10.0, brick_type="custom", Em_mpa=None)
        with pytest.raises(ValueError):
            m.resolved_Em_mpa()

    def test_custom_with_em_returns_it(self):
        """NSR-10 D.5.4 puede requerir Em explícito de laboratorio."""
        m = MasonryMaterialDef(name="M_C", fm_mpa=10.0, brick_type="custom", Em_mpa=8000.0)
        assert m.resolved_Em_mpa() == pytest.approx(8000.0)

    def test_brick_type_case_insensitive(self):
        m_lower = MasonryMaterialDef(name="M", fm_mpa=5.0, brick_type="vp")
        m_upper = MasonryMaterialDef(name="M", fm_mpa=5.0, brick_type="VP")
        assert m_lower.resolved_Em_mpa() == m_upper.resolved_Em_mpa()

    def test_explicit_em_overrides_computed(self):
        """Si Em_mpa se pasa aunque el tipo sea VP/HP, gana el explícito."""
        m = MasonryMaterialDef(name="M", fm_mpa=5.0, brick_type="VP", Em_mpa=5000.0)
        assert m.resolved_Em_mpa() == pytest.approx(5000.0)

    def test_cache_key_is_stable(self):
        m1 = MasonryMaterialDef(name="X", fm_mpa=5.0, brick_type="VP")
        m2 = MasonryMaterialDef(name="X", fm_mpa=5.0, brick_type="VP")
        assert m1.cache_key == m2.cache_key


# ── masonry_concrete01_params ─────────────────────────────────────────────────

class TestMasonryConcrete01Params:
    def test_all_four_values_are_negative(self):
        """OpenSees Concrete01: compresión negativa por convención."""
        m = MasonryMaterialDef(name="M", fm_mpa=5.0, brick_type="VP")
        fpc, e0, fpcu, eu = masonry_concrete01_params(m)
        assert fpc < 0
        assert e0 < 0
        assert fpcu < 0
        assert eu < 0

    def test_vp_5mpa_matches_hand_calc(self):
        """
        VP fm=5 → Em=3875 → e0 = 2·5/3875 = 0.002581.
        fmu = 0.01·5 = 0.05 MPa. emu = 2·e0.
        """
        m = MasonryMaterialDef(name="M", fm_mpa=5.0, brick_type="VP")
        fpc, e0, fpcu, eu = masonry_concrete01_params(m)
        assert fpc == pytest.approx(-5.0)
        assert e0 == pytest.approx(-2 * 5.0 / 3875.0)
        assert fpcu == pytest.approx(-0.05)
        assert eu == pytest.approx(2 * e0)

    def test_custom_em_8000_fm_10(self):
        """
        NSR-10 D preset: fm=10, Em=8000 → e0 = 20/8000 = 0.0025.
        fmu = 0.1. emu = 0.005.
        """
        m = MasonryMaterialDef(name="M", fm_mpa=10.0, brick_type="custom", Em_mpa=8000.0)
        fpc, e0, fpcu, eu = masonry_concrete01_params(m)
        assert fpc == pytest.approx(-10.0)
        assert e0 == pytest.approx(-0.0025)
        assert fpcu == pytest.approx(-0.1)
        assert eu == pytest.approx(-0.005)

    def test_zero_fm_raises(self):
        m = MasonryMaterialDef(name="M", fm_mpa=0.0, brick_type="VP")
        with pytest.raises(ValueError):
            masonry_concrete01_params(m)

    def test_negative_fm_raises(self):
        m = MasonryMaterialDef(name="M", fm_mpa=-3.0, brick_type="VP")
        with pytest.raises(ValueError):
            masonry_concrete01_params(m)


# ── al_chaar_reduction ────────────────────────────────────────────────────────

class TestAlChaarReduction:
    """
    Al-Chaar (2002) — ERDC/CERL TR-02-1.
    λ = 1 - 2·ρ^0.54 + ρ^1.14
    """

    def test_no_openings_returns_one(self):
        assert al_chaar_reduction(0.0) == pytest.approx(1.0)

    def test_full_opening_returns_zero(self):
        assert al_chaar_reduction(1.0) == pytest.approx(0.0)

    def test_10_percent_openings(self):
        lam = al_chaar_reduction(0.10)
        expected = 1 - 2 * 0.10 ** 0.54 + 0.10 ** 1.14
        assert lam == pytest.approx(expected)

    def test_20_percent_openings(self):
        lam = al_chaar_reduction(0.20)
        expected = 1 - 2 * 0.20 ** 0.54 + 0.20 ** 1.14
        assert lam == pytest.approx(expected)
        # Sanity: 20% aberturas debe reducir el ancho efectivo drásticamente
        assert lam < 0.35

    def test_50_percent_openings_small(self):
        """
        A 50% de aberturas el aporte del panel cae drásticamente: λ ≈ 0.078.
        Referencia analítica: 1 - 2·(0.5)^0.54 + (0.5)^1.14 = 0.0782...
        """
        lam = al_chaar_reduction(0.50)
        assert lam == pytest.approx(1 - 2 * 0.5 ** 0.54 + 0.5 ** 1.14)
        assert lam < 0.10  # menos del 10% del ancho contribuye

    def test_monotonically_decreasing(self):
        prev = 1.0
        for r in (0.05, 0.10, 0.20, 0.30, 0.40, 0.50):
            lam = al_chaar_reduction(r)
            assert lam <= prev
            prev = lam

    def test_out_of_range_is_clipped(self):
        """Valores fuera de [0,1] se saturan sin explotar."""
        assert al_chaar_reduction(-0.1) == pytest.approx(1.0)
        assert al_chaar_reduction(2.0) == pytest.approx(0.0)


# ── strut_geometry ────────────────────────────────────────────────────────────

class TestStrutGeometry:
    def test_panel_4x3_no_openings(self):
        """
        Panel 4×3m, tw=0.15m, sin aberturas, width_ratio=0.25:
          diagonal = √(4² + 3²) = 5 m
          eff_width = 0.25·5 = 1.25 m
          area_gross = 1.25·0.15 = 0.1875 m²
          λ = 1.0 → area_effective = 0.1875 m²
        """
        sg = strut_geometry(
            L_panel_m=4.0, H_panel_m=3.0, thickness_m=0.15,
            width_ratio=0.25, opening_ratio=0.0,
        )
        assert sg["diagonal_m"] == pytest.approx(5.0)
        assert sg["effective_width_m"] == pytest.approx(1.25)
        assert sg["area_gross_m2"] == pytest.approx(0.1875)
        assert sg["lambda_openings"] == pytest.approx(1.0)
        assert sg["area_effective_m2"] == pytest.approx(0.1875)

    def test_panel_with_20_percent_openings(self):
        """Reducción por Al-Chaar aplica solo al área, no al ancho geométrico."""
        sg = strut_geometry(
            L_panel_m=4.0, H_panel_m=3.0, thickness_m=0.15,
            width_ratio=0.25, opening_ratio=0.20,
        )
        assert sg["effective_width_m"] == pytest.approx(1.25)  # geometría no cambia
        assert sg["lambda_openings"] == pytest.approx(al_chaar_reduction(0.20))
        assert sg["area_effective_m2"] == pytest.approx(
            sg["area_gross_m2"] * sg["lambda_openings"]
        )

    def test_angle_matches_geometry(self):
        """Panel 4×3: ángulo = atan(3/4) ≈ 36.87°."""
        sg = strut_geometry(L_panel_m=4.0, H_panel_m=3.0, thickness_m=0.15)
        assert sg["angle_rad"] == pytest.approx(math.atan2(3.0, 4.0))

    def test_square_panel_has_45_deg(self):
        sg = strut_geometry(L_panel_m=3.0, H_panel_m=3.0, thickness_m=0.15)
        assert sg["angle_rad"] == pytest.approx(math.pi / 4)

    def test_zero_dimension_raises(self):
        with pytest.raises(ValueError):
            strut_geometry(L_panel_m=0.0, H_panel_m=3.0, thickness_m=0.15)
        with pytest.raises(ValueError):
            strut_geometry(L_panel_m=4.0, H_panel_m=0.0, thickness_m=0.15)


# ── InfillPanel.validate ──────────────────────────────────────────────────────

class TestInfillPanelValidate:
    def _make(self, **overrides) -> InfillPanel:
        kwargs = dict(
            panel_id="INF-1", pier="P1", story="ST1",
            thickness_m=0.15, masonry_material_id="M1",
            opening_ratio=0.0, width_ratio=0.25,
        )
        kwargs.update(overrides)
        return InfillPanel(**kwargs)

    def test_defaults_are_valid(self):
        self._make().validate()  # no raise

    def test_negative_thickness_raises(self):
        with pytest.raises(ValueError):
            self._make(thickness_m=-0.1).validate()

    def test_zero_thickness_raises(self):
        with pytest.raises(ValueError):
            self._make(thickness_m=0.0).validate()

    def test_opening_ratio_above_1_raises(self):
        with pytest.raises(ValueError):
            self._make(opening_ratio=1.5).validate()

    def test_opening_ratio_negative_raises(self):
        with pytest.raises(ValueError):
            self._make(opening_ratio=-0.1).validate()

    def test_width_ratio_out_of_range_raises(self):
        with pytest.raises(ValueError):
            self._make(width_ratio=0.02).validate()
        with pytest.raises(ValueError):
            self._make(width_ratio=0.70).validate()

    def test_boundary_values_accepted(self):
        self._make(opening_ratio=0.0).validate()
        self._make(opening_ratio=1.0).validate()
        self._make(width_ratio=0.05).validate()
        self._make(width_ratio=0.50).validate()
