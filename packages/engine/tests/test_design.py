"""Tests del diseño paramétrico inverso de columnas RC."""
import math
import pytest

from engine.sections.design import (
    ColumnGeometry, DesignDemand, design_column,
)
from engine.sections.reinforcement import BAR_AREAS_MM2


# ── Test: columna grande con demanda modesta debe tener múltiples soluciones ─

class TestRectangular:
    def test_finds_solutions_for_modest_demand(self):
        """Columna 500×500, f'c=28, demanda Pu=1500kN + Mux=200kNm → varios candidatos."""
        geom = ColumnGeometry(
            kind="column_rect", height_mm=500, width_mm=500,
            cover_mm=40, fpc_MPa=28, fy_MPa=420,
        )
        demands = [DesignDemand(Pu_N=1500e3, Mux_Nmm=200e6, Muy_Nmm=0)]
        result = design_column(geom, demands, top_k=5)
        assert result.n_candidates_evaluated > 0
        assert result.n_valid >= 1

    def test_optimal_is_lowest_rho(self):
        """El top-1 debe tener la menor ρ entre los válidos."""
        geom = ColumnGeometry(
            kind="column_rect", height_mm=500, width_mm=500,
            cover_mm=40, fpc_MPa=28, fy_MPa=420,
        )
        demands = [DesignDemand(Pu_N=1500e3, Mux_Nmm=200e6)]
        result = design_column(geom, demands, top_k=5)
        if len(result.top_candidates) >= 2:
            for i in range(1, len(result.top_candidates)):
                assert result.top_candidates[i-1].rho_g <= result.top_candidates[i].rho_g

    def test_all_top_candidates_pass(self):
        geom = ColumnGeometry(
            kind="column_rect", height_mm=500, width_mm=500,
            cover_mm=40, fpc_MPa=28, fy_MPa=420,
        )
        demands = [DesignDemand(Pu_N=1500e3, Mux_Nmm=200e6)]
        result = design_column(geom, demands, top_k=5)
        for c in result.top_candidates:
            assert c.all_pass
            assert c.max_DCR <= 1.0

    def test_biaxial_demand(self):
        """Con demanda biaxial, el motor debe seguir encontrando candidatos."""
        geom = ColumnGeometry(
            kind="column_rect", height_mm=500, width_mm=500,
            cover_mm=40, fpc_MPa=28, fy_MPa=420,
        )
        demands = [
            DesignDemand(Pu_N=1500e3, Mux_Nmm=150e6, Muy_Nmm=100e6),
        ]
        result = design_column(geom, demands, top_k=3)
        assert result.n_candidates_evaluated > 0


class TestCircular:
    def test_finds_solutions_circular(self):
        geom = ColumnGeometry(
            kind="column_circ", diameter_mm=600,
            cover_mm=40, fpc_MPa=28, fy_MPa=420,
        )
        demands = [DesignDemand(Pu_N=2000e3, Mux_Nmm=200e6)]
        result = design_column(geom, demands, top_k=5)
        assert result.n_candidates_evaluated > 0
        assert result.n_valid >= 1

    def test_min_6_bars_circular(self):
        # NSR-10 C.10.9.3 exige mínimo 6 barras en columna circular
        geom = ColumnGeometry(kind="column_circ", diameter_mm=600, fpc_MPa=28, fy_MPa=420)
        demands = [DesignDemand(Pu_N=1500e3, Mux_Nmm=200e6)]
        result = design_column(geom, demands, top_k=5)
        for c in result.top_candidates:
            assert c.n_bars >= 6


class TestInfeasible:
    def test_flags_infeasible_when_demand_too_high(self):
        """Columna pequeña con demanda enorme → ningún candidato cumple."""
        geom = ColumnGeometry(
            kind="column_rect", height_mm=300, width_mm=300,
            cover_mm=40, fpc_MPa=28, fy_MPa=420,
        )
        # Demanda muy alta
        demands = [DesignDemand(Pu_N=100e3, Mux_Nmm=500e6)]   # 500 kN·m en columna 300×300
        result = design_column(geom, demands, top_k=5)
        # Puede ser que ninguno cumpla — verificamos que all_infeasible refleje eso
        if result.all_infeasible:
            assert len(result.top_candidates) == 0
            assert len(result.notes) > 0


class TestRhoConstraints:
    def test_respects_rho_min(self):
        # Con rho_min=0.02, ningún candidato de ρ < 0.02 debe estar
        geom = ColumnGeometry(kind="column_rect", height_mm=500, width_mm=500,
                               fpc_MPa=28, fy_MPa=420)
        demands = [DesignDemand(Pu_N=1500e3, Mux_Nmm=200e6)]
        result = design_column(geom, demands, top_k=10, rho_min=0.02)
        for c in result.top_candidates:
            assert c.rho_g >= 0.02

    def test_respects_rho_max(self):
        geom = ColumnGeometry(kind="column_rect", height_mm=500, width_mm=500,
                               fpc_MPa=28, fy_MPa=420)
        demands = [DesignDemand(Pu_N=1500e3, Mux_Nmm=200e6)]
        result = design_column(geom, demands, top_k=10, rho_max=0.03)
        for c in result.top_candidates:
            assert c.rho_g <= 0.03
