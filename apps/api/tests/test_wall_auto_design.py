"""
Tests del motor de auto-diseño de muros RC — auto_design.py refactor.

Verifica:
  - 3 escalones de cuantía mínima según Vu / Vc
  - Cortinas por tw en `_select_web_reinforcement`
  - Sin-EBE: cuando σ ≤ threshold, no se emiten zonas de borde y el refuerzo
    del alma se distribuye en todo lw
  - Con-EBE: cuando σ > threshold, ρ_BE ∈ [1%, 4%]
  - WallNotDesignableError cuando la búsqueda no encuentra refuerzo válido
  - Umbral DMO = 0.30·f'c (menor exigencia que DES 0.20·f'c)
  - #3 (9.5 mm) elegido en alma cuando permite bajar a 0.20% con Vu bajo
"""
import pytest

from app.engine.building.walls.auto_design import (
    auto_design,
    _min_reinforcement_ratios,
    _select_web_reinforcement,
    WallNotDesignableError,
    RHO_MIN_LOW_V, RHO_MIN_MED_V, RHO_MIN_HIGH_V,
)
from app.engine.building.walls.wall_design_schemas import (
    WallDemandCombo, WallReinforcement, BoundaryZoneReinf, WebZoneReinf,
    curtains_for_tw, TW_SINGLE_CURTAIN_M,
)
from app.engine.building.walls.boundary_element import (
    SIGMA_THRESHOLD_DES, SIGMA_THRESHOLD_DMO,
)


# ── Umbrales normativos DES vs DMO ────────────────────────────────────────────

class TestBoundaryElementThresholds:
    def test_des_threshold_is_020(self):
        assert SIGMA_THRESHOLD_DES == pytest.approx(0.20)

    def test_dmo_threshold_is_030(self):
        """NSR-10 C.21.4.4.6 — DMO menos exigente que DES."""
        assert SIGMA_THRESHOLD_DMO == pytest.approx(0.30)

    def test_dmo_less_strict_than_des(self):
        assert SIGMA_THRESHOLD_DMO > SIGMA_THRESHOLD_DES


# ── Tier de cuantías por Vu / Vc ──────────────────────────────────────────────

class TestReinforcementTiers:
    def test_low_shear_uses_0012(self):
        rho_v, rho_h, tier = _min_reinforcement_ratios(Vu_kN=10.0, Acv_m2=0.3, fc_mpa=28.0)
        assert tier == "low"
        assert rho_v == pytest.approx(RHO_MIN_LOW_V)
        assert rho_h == pytest.approx(0.0020)

    def test_medium_shear_uses_0020(self):
        rho_v, rho_h, tier = _min_reinforcement_ratios(Vu_kN=100.0, Acv_m2=0.3, fc_mpa=28.0)
        assert tier == "medium"
        assert rho_v == pytest.approx(RHO_MIN_MED_V)
        assert rho_h == pytest.approx(0.0025)

    def test_high_shear_uses_0025(self):
        rho_v, rho_h, tier = _min_reinforcement_ratios(Vu_kN=200.0, Acv_m2=0.3, fc_mpa=28.0)
        assert tier == "high"
        assert rho_v == pytest.approx(RHO_MIN_HIGH_V)
        assert rho_h == pytest.approx(0.0025)

    def test_low_tier_requires_small_bars(self):
        rho_v_ok, _, tier_ok = _min_reinforcement_ratios(Vu_kN=10.0, Acv_m2=0.3, fc_mpa=28.0, db_ref_mm=12.7)
        rho_v_no, _, tier_no = _min_reinforcement_ratios(Vu_kN=10.0, Acv_m2=0.3, fc_mpa=28.0, db_ref_mm=19.1)
        assert tier_ok == "low"
        assert rho_v_ok == pytest.approx(RHO_MIN_LOW_V)
        assert "medium" in tier_no
        assert rho_v_no == pytest.approx(RHO_MIN_MED_V)


# ── Cortinas según espesor ────────────────────────────────────────────────────

class TestCurtainsRule:
    def test_curtains_helper_thin(self):
        assert curtains_for_tw(0.10) == 1
        assert curtains_for_tw(0.12) == 1
        assert curtains_for_tw(TW_SINGLE_CURTAIN_M) == 1  # borde inclusivo

    def test_curtains_helper_normal(self):
        assert curtains_for_tw(0.16) == 2
        assert curtains_for_tw(0.20) == 2
        assert curtains_for_tw(0.40) == 2

    def test_thin_wall_web_1_curtain(self):
        web, _tier = _select_web_reinforcement(
            lw_m=3.0, tw_m=0.12, hw_m=3.0,
            fc_mpa=28.0, fyt_mpa=420.0,
            Vu_kN=50.0, ductility="DES",
        )
        assert web.n_curtains == 1

    def test_normal_wall_web_2_curtains(self):
        web, _tier = _select_web_reinforcement(
            lw_m=3.0, tw_m=0.30, hw_m=3.0,
            fc_mpa=28.0, fyt_mpa=420.0,
            Vu_kN=50.0, ductility="DES",
        )
        assert web.n_curtains == 2


# ── Sin EBE (demandas bajas) ──────────────────────────────────────────────────

class TestNoBoundaryElement:
    """
    Cuando σ ≤ threshold, el motor NO debe emitir EBE. `be_left` y `be_right`
    quedan vacíos y `all_bars()` distribuye el refuerzo del alma en todo lw.
    """

    def test_low_demand_wall_returns_empty_boundaries(self):
        # lw=4, tw=0.30 con Pu=200/Mu=200: σ ≈ 0.63 MPa < 5.6 MPa (0.20·28)
        demands = [
            WallDemandCombo(label="1.2D+L+E", Pu_kN=200.0, Vu_kN=40.0, Mu_kNm=200.0),
            WallDemandCombo(label="0.9D-E",   Pu_kN=50.0,  Vu_kN=40.0, Mu_kNm=200.0),
        ]
        reinf = auto_design(
            lw_m=4.0, tw_m=0.30, hw_m=15.0,
            fc_mpa=28.0, fy_mpa=420.0, fyt_mpa=420.0,
            demands=demands, ductility="DES",
        )
        assert reinf.be_left.is_empty
        assert reinf.be_right.is_empty
        assert reinf.be_left.n_bars == 0
        assert reinf.be_left.length_m == 0.0

    def test_no_ebe_distributes_web_over_full_length(self):
        demands = [WallDemandCombo(label="1.2D", Pu_kN=100.0, Vu_kN=30.0, Mu_kNm=100.0)]
        reinf = auto_design(
            lw_m=3.5, tw_m=0.20, hw_m=15.0,
            fc_mpa=28.0, fy_mpa=420.0, fyt_mpa=420.0,
            demands=demands, ductility="DES",
        )
        bars = reinf.all_bars(lw_m=3.5, tw_m=0.20)
        assert all(b["zone"] == "web" for b in bars), "sin EBE, todas las barras son web"
        xs = [b["x"] for b in bars]
        # Barras cubren el ancho del muro (con recubrimientos en extremos)
        assert min(xs) < 0.5 and max(xs) > 3.0

    def test_dmo_more_permissive_than_des(self):
        """DMO con σ=0.25·f'c NO requiere EBE; DES con la misma demanda SÍ lo requiere."""
        # Ajustamos demandas para σ ≈ 0.25·f'c = 7 MPa
        demands = [
            WallDemandCombo(label="1.2D+L+E", Pu_kN=1000.0, Vu_kN=100.0, Mu_kNm=4200.0),
        ]
        des = auto_design(
            lw_m=4.0, tw_m=0.30, hw_m=15.0,
            fc_mpa=28.0, fy_mpa=420.0, fyt_mpa=420.0,
            demands=demands, ductility="DES",
        )
        dmo = auto_design(
            lw_m=4.0, tw_m=0.30, hw_m=15.0,
            fc_mpa=28.0, fy_mpa=420.0, fyt_mpa=420.0,
            demands=demands, ductility="DMO",
        )
        assert not des.be_left.is_empty, "DES exige EBE con σ ≈ 0.25·f'c"
        assert dmo.be_left.is_empty, "DMO no exige EBE con σ ≈ 0.25·f'c"


# ── Con EBE (demandas altas) ──────────────────────────────────────────────────

class TestBoundaryElementRequired:
    def test_heavy_wall_gets_ebe_with_be_reinf(self):
        # Muro esbelto con Mu grande → σ > 0.20·f'c → EBE requerido.
        # lw=4, tw=0.30, P=1500, M=6000 → σ ≈ 1250+7500 = 8750 kN/m² = 8.75 MPa > 5.6
        demands = [
            WallDemandCombo(label="1.2D+L+E", Pu_kN=1500.0, Vu_kN=400.0, Mu_kNm=6000.0),
            WallDemandCombo(label="0.9D-E",   Pu_kN=400.0,  Vu_kN=400.0, Mu_kNm=6000.0),
        ]
        reinf = auto_design(
            lw_m=4.0, tw_m=0.30, hw_m=18.0,
            fc_mpa=28.0, fy_mpa=420.0, fyt_mpa=420.0,
            demands=demands, ductility="DES",
        )
        assert not reinf.be_left.is_empty
        As_be   = reinf.be_left.As_mm2
        area_be = reinf.be_left.length_m * 0.30 * 1e6
        rho_be  = As_be / area_be
        assert rho_be >= 0.010, f"ρ_BE debería ser ≥ 1%, obtuvo {rho_be:.4f}"
        assert rho_be <= 0.040, f"ρ_BE debería ser ≤ 4%, obtuvo {rho_be:.4f}"
        assert reinf.be_left.length_m > 0.15


# ── #3 en alma con demandas bajas ────────────────────────────────────────────

class TestSmallBarInWeb:
    def test_low_shear_dmo_picks_3_bar(self):
        """
        Con Vu bajo y DMO (s_max=450 mm), el motor puede elegir #3 (9.5 mm)
        para llegar a ρ ≈ 0.20% sin que el cap de espaciamiento empuje al alza.
        """
        web, tier = _select_web_reinforcement(
            lw_m=3.0, tw_m=0.15, hw_m=12.0,
            fc_mpa=28.0, fyt_mpa=420.0,
            Vu_kN=15.0, ductility="DMO",
        )
        assert tier == "low"
        # Con tw=0.15, n_cur=1 (borde inclusivo), #3 alcanza para ρ_h ≈ 0.20%
        assert web.horiz_db_mm <= 12.7 + 0.01, (
            f"Se esperaba #3 o #4 en el alma; obtuvo db={web.horiz_db_mm}"
        )


# ── No diseñable — WallNotDesignableError ────────────────────────────────────

class TestNotDesignable:
    def test_impossible_demand_raises(self):
        """
        Un muro pequeño con Mu enorme no puede diseñarse con ρ_BE ≤ 4%.
        El motor NO debe caer en 12#8 — debe levantar excepción explícita.
        """
        demands = [
            WallDemandCombo(label="1.2D+L+E", Pu_kN=200.0, Vu_kN=800.0, Mu_kNm=20000.0),
        ]
        with pytest.raises(WallNotDesignableError) as exc:
            auto_design(
                lw_m=1.5, tw_m=0.15, hw_m=6.0,
                fc_mpa=21.0, fy_mpa=420.0, fyt_mpa=420.0,
                demands=demands, ductility="DES",
            )
        assert "no se encontró" in str(exc.value).lower() or "no diseñable" in str(exc.value).lower()


# ── Geometría de barras ──────────────────────────────────────────────────────

class TestBarsGeometry:
    def test_all_bars_have_x_y_zone(self):
        be = BoundaryZoneReinf(
            n_bars=4, db_mm=19.1, cover_mm=40, tie_db_mm=9.5,
            tie_spacing_mm=100, length_m=0.5, n_curtains=2,
        )
        web = WebZoneReinf(
            vert_db_mm=12.7, vert_spacing_mm=200,
            horiz_db_mm=12.7, horiz_spacing_mm=200, n_curtains=2,
        )
        reinf = WallReinforcement(be_left=be, web=web, be_right=be, symmetric=True)
        bars = reinf.all_bars(lw_m=3.0, tw_m=0.30, cover_mm=40)

        assert all("x" in b and "y" in b and "zone" in b for b in bars)
        n_bars_be = sum(1 for b in bars if b["zone"] == "boundary")
        assert n_bars_be == 16
        assert all(0.0 <= b["y"] <= 0.30 for b in bars)

    def test_empty_be_produces_only_web_bars(self):
        empty = BoundaryZoneReinf(
            n_bars=0, db_mm=0, cover_mm=40, tie_db_mm=0,
            tie_spacing_mm=0, length_m=0.0, n_curtains=1,
        )
        web = WebZoneReinf(
            vert_db_mm=9.5, vert_spacing_mm=250,
            horiz_db_mm=9.5, horiz_spacing_mm=300, n_curtains=1,
        )
        reinf = WallReinforcement(be_left=empty, web=web, be_right=empty, symmetric=True)
        bars = reinf.all_bars(lw_m=2.5, tw_m=0.12, cover_mm=40)

        assert all(b["zone"] == "web" for b in bars)
        assert len(bars) > 0


# ── Espaciamiento máximo 0.30 m siempre ──────────────────────────────────────

class TestMaxSpacing:
    def test_web_spacing_never_exceeds_300mm_des(self):
        """
        DES con Vu bajo: separación provista no puede pasarse de 300 mm
        aunque la cuantía mínima permitiera espaciamientos mayores.
        """
        web, _ = _select_web_reinforcement(
            lw_m=3.0, tw_m=0.15, hw_m=12.0,
            fc_mpa=28.0, fyt_mpa=420.0,
            Vu_kN=15.0, ductility="DES",
        )
        assert web.vert_spacing_mm  <= 300.0 + 1e-6
        assert web.horiz_spacing_mm <= 300.0 + 1e-6

    def test_web_spacing_never_exceeds_300mm_dmo(self):
        """DMO ya no relaja a 450 mm — sigue capando en 300 mm."""
        web, _ = _select_web_reinforcement(
            lw_m=3.0, tw_m=0.15, hw_m=12.0,
            fc_mpa=28.0, fyt_mpa=420.0,
            Vu_kN=15.0, ductility="DMO",
        )
        assert web.vert_spacing_mm  <= 300.0 + 1e-6
        assert web.horiz_spacing_mm <= 300.0 + 1e-6

    def test_pm_does_not_overprescribe_on_moderate_demands(self):
        """
        Bug 7 (regresión): con is_demand_inside arreglado, un muro que
        realmente cabe con ~4-6 barras del BE moderado NO debe escalar
        hasta 12 barras #8.
        """
        # Muro tw=0.30, lw=3.0, hw=15, con Mu moderado que exige EBE pero no extremo.
        # σ = P/A + M/S = 800/0.9 + 2000·1.5/(0.3·27/12) = 889 + 4444 = 5333 kN/m² ≈ 5.3 MPa
        # → Casi threshold DES 5.6 MPa, así que EBE probable con lc corto.
        demands = [
            WallDemandCombo(label="1.2D+L+E", Pu_kN=800.0, Vu_kN=250.0, Mu_kNm=2000.0),
            WallDemandCombo(label="0.9D-E",   Pu_kN=200.0, Vu_kN=250.0, Mu_kNm=2000.0),
        ]
        reinf = auto_design(
            lw_m=3.0, tw_m=0.30, hw_m=15.0,
            fc_mpa=28.0, fy_mpa=420.0, fyt_mpa=420.0,
            demands=demands, ductility="DES",
        )
        if not reinf.be_left.is_empty:
            n_bars_per_curtain = reinf.be_left.n_bars
            db_mm = reinf.be_left.db_mm
            # El motor NO debe escalar a 6#8/cortina (=12#8 total) para esta demanda.
            # Un absurdo típico del bug de is_demand_inside.
            is_absurd = n_bars_per_curtain >= 6 and db_mm >= 25.0
            assert not is_absurd, (
                f"Sobredimensionamiento absurdo: {n_bars_per_curtain}#{db_mm}mm/cortina"
            )

    def test_all_bars_respect_target_spacing_in_short_wall(self):
        """
        Muro pequeño sin EBE (caso M12-A): con web_len ≈ 0.5 m y sp_target=300,
        deben quedar al menos 2 barras y la separación efectiva ≤ 300 mm.
        """
        empty = BoundaryZoneReinf(
            n_bars=0, db_mm=0, cover_mm=40, tie_db_mm=0,
            tie_spacing_mm=0, length_m=0.0, n_curtains=1,
        )
        web = WebZoneReinf(
            vert_db_mm=9.5, vert_spacing_mm=300,
            horiz_db_mm=9.5, horiz_spacing_mm=300, n_curtains=1,
        )
        reinf = WallReinforcement(be_left=empty, web=web, be_right=empty, symmetric=True)
        bars = reinf.all_bars(lw_m=0.5, tw_m=0.12, cover_mm=40)

        assert len(bars) >= 2, f"Sin EBE, muro corto debe tener ≥ 2 barras (obtuvo {len(bars)})"
        xs = sorted(b["x"] for b in bars)
        max_gap = max(xs[i + 1] - xs[i] for i in range(len(xs) - 1))
        assert max_gap <= 0.30 + 1e-6, f"Separación máxima {max_gap * 1000:.1f} mm > 300 mm"
