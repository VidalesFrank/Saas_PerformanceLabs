"""Pruebas de confinamiento Mander (1988) usado por el pipeline no lineal."""
import pytest

from engine.building.nonlinear import (
    confinement_to_dict,
    default_confinement,
    mander_rect_confinement,
)


class TestManderConfinement:
    def test_column_400_tie3_s100(self):
        """Columna 400×400 fc=21 MPa con 8#6 y estribo #3 @ 100 (2+2 ramas).

        Valores de referencia según cálculo manual Mander:
        - K ≈ 1.25-1.40 (confinamiento moderado-alto)
        - ε_cc > ε_co = 0.002
        - ε_cu > 0.008 (claramente superior al no confinado)
        """
        r = mander_rect_confinement(
            b_m=0.40, h_m=0.40, cover_m=0.040, fc_MPa=21.0,
            fy_tie_MPa=420.0, db_tie_mm=9.5, s_mm=100,
            n_legs_b=2, n_legs_h=2, n_long_bars=8, db_long_mm=19.1,
        )
        assert 1.25 <= r.K <= 1.40
        assert r.fcc_MPa > 21.0
        assert r.eps_cc > 0.002
        assert r.eps_cu > 0.008
        assert 0.0 < r.k_e <= 1.0

    def test_column_s200_less_confined(self):
        """Mismo armado longitudinal pero s=200 → menor confinamiento."""
        r100 = mander_rect_confinement(
            b_m=0.40, h_m=0.40, cover_m=0.040, fc_MPa=21.0,
            fy_tie_MPa=420.0, db_tie_mm=9.5, s_mm=100,
            n_legs_b=2, n_legs_h=2, n_long_bars=8, db_long_mm=19.1,
        )
        r200 = mander_rect_confinement(
            b_m=0.40, h_m=0.40, cover_m=0.040, fc_MPa=21.0,
            fy_tie_MPa=420.0, db_tie_mm=9.5, s_mm=200,
            n_legs_b=2, n_legs_h=2, n_long_bars=8, db_long_mm=19.1,
        )
        assert r200.K < r100.K
        assert r200.k_e < r100.k_e
        # Pero sigue siendo > 1 (hay algo de confinamiento)
        assert r200.K > 1.0

    def test_des_column_high_confinement(self):
        """Columna DES 500×500 con grapas intermedias (4+4 ramas, s=100)."""
        r = mander_rect_confinement(
            b_m=0.50, h_m=0.50, cover_m=0.040, fc_MPa=28.0,
            fy_tie_MPa=420.0, db_tie_mm=9.5, s_mm=100,
            n_legs_b=4, n_legs_h=4, n_long_bars=12, db_long_mm=25.4,
        )
        assert r.K > 1.35      # alto confinamiento
        assert r.fcc_MPa > 35.0

    def test_default_fallback(self):
        """default_confinement devuelve K=1.3 fijo."""
        r = default_confinement(21.0)
        assert r.K == 1.3
        assert r.fcc_MPa == pytest.approx(27.3, abs=0.1)
        assert r.eps_cc == 0.004
        assert r.eps_cu == 0.016
        assert r.source == "default"

    def test_minimal_input_safe(self):
        """No debe explotar con geometrías pequeñas / cover grande."""
        r = mander_rect_confinement(
            b_m=0.15, h_m=0.15, cover_m=0.030, fc_MPa=21.0,
            fy_tie_MPa=420.0, db_tie_mm=9.5, s_mm=100,
            n_legs_b=2, n_legs_h=2, n_long_bars=4, db_long_mm=12.7,
        )
        assert r.K >= 1.0

    def test_to_dict_schema(self):
        r = default_confinement(21.0)
        d = confinement_to_dict(r)
        for key in ("K", "fcc_MPa", "fco_MPa", "eps_co", "eps_cc", "eps_cu",
                    "eps_sp", "k_e", "rho_x", "rho_y", "rho_s", "fl_prime_MPa",
                    "source"):
            assert key in d


class TestNLSpecBuilderWithConfinement:
    """Integración: NLSpecBuilder debe emitir el bloque 'confinement'."""

    def _canonical_sample(self) -> dict:
        return {
            "stories": {"S1": {"elevation_m": 3.0}},
            "joints": {
                "1": {"x": 0.0, "y": 0.0, "z": 0.0, "story": "Base"},
                "2": {"x": 0.0, "y": 0.0, "z": 3.0, "story": "S1"},
                "3": {"x": 5.0, "y": 0.0, "z": 3.0, "story": "S1"},
            },
            "frames": {
                "C1": {"element_type": "column", "joint_i": "1", "joint_j": "2",
                       "section": "C40",       "story": "S1"},
                "B1": {"element_type": "beam",   "joint_i": "2", "joint_j": "3",
                       "section": "V30x40",     "story": "S1"},
            },
            "sections": {
                "C40":     {"b_m": 0.40, "h_m": 0.40, "type": "column", "material": "C21"},
                "V30x40":  {"b_m": 0.30, "h_m": 0.40, "type": "beam",   "material": "C21"},
            },
            "materials": {
                "C21": {"fpc_mpa": 21.0, "type": "concrete"},
                "A420": {"fy_mpa": 420.0, "type": "steel"},
            },
            "masses": {},
            "restraints": {"1": [1, 1, 1, 1, 1, 1]},
        }

    def test_column_emits_confinement_with_design(self):
        from engine.building.nonlinear import NLSpecBuilder

        canonical = self._canonical_sample()
        col_detail = {
            "columns": [{
                "frame_id": "C1",
                "proposed_reinforcement": {
                    "longitudinal": {"n_bars": 8, "bar_label": "#6", "As_placed_cm2": 22.72},
                    "transverse":   {"tie_bar_label": "#3", "n_legs_b": 2, "n_legs_h": 2,
                                     "s_confined_mm": 100, "s_general_mm": 200,
                                     "L_confinement_mm": 400},
                },
            }],
        }
        builder = NLSpecBuilder(canonical, col_detail, {}, energy_dissipation="DMO")
        spec = builder.build()
        col = spec["elements"]["columns"]["C1"]
        assert "confinement" in col
        end = col["confinement"]["end"]
        mid = col["confinement"]["mid"]
        assert end["source"] == "designed"
        assert mid["source"] == "designed"
        assert end["K"] > mid["K"]        # end más confinada
        assert end["K"] >= 1.0

    def test_beam_emits_confinement_with_design(self):
        from engine.building.nonlinear import NLSpecBuilder

        canonical = self._canonical_sample()
        beam_detail = {
            "beams": [{
                "frame_id": "B1",
                "reinforcement_by_zone": {
                    "end_i": {"top": {"n_bars": 3, "bar_label": "#6", "As_placed_cm2": 8.5},
                               "bot": {"n_bars": 2, "bar_label": "#5", "As_placed_cm2": 4.0}},
                    "mid":   {"top": {"n_bars": 2, "bar_label": "#5", "As_placed_cm2": 4.0},
                               "bot": {"n_bars": 2, "bar_label": "#5", "As_placed_cm2": 4.0}},
                    "end_j": {"top": {"n_bars": 3, "bar_label": "#6", "As_placed_cm2": 8.5},
                               "bot": {"n_bars": 2, "bar_label": "#5", "As_placed_cm2": 4.0}},
                },
                "shear_design": {
                    "tie_bar_label": "#3", "n_legs": 2,
                    "zone_end": {"s_mm": 100}, "zone_mid": {"s_mm": 200},
                },
            }],
        }
        builder = NLSpecBuilder(canonical, {}, beam_detail, energy_dissipation="DMO")
        spec = builder.build()
        beam = spec["elements"]["beams"]["B1"]
        assert "confinement" in beam
        assert beam["confinement"]["end"]["K"] >= 1.0
        assert beam["confinement"]["end"]["K"] > beam["confinement"]["mid"]["K"]

    def test_column_without_design_uses_default(self):
        from engine.building.nonlinear import NLSpecBuilder

        canonical = self._canonical_sample()
        builder = NLSpecBuilder(canonical, {}, {}, energy_dissipation="DMO")
        spec = builder.build()
        col = spec["elements"]["columns"]["C1"]
        assert col["confinement"]["end"]["K"] == 1.3
        assert col["confinement"]["end"]["source"] == "default"
