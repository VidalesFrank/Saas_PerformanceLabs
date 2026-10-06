"""Tests del post-proceso de daño por rótula plástica (ASCE 41-17)."""
import numpy as np
import pytest

from app.engine.building.nonlinear.hinge_damage import (
    _classify,
    _confinement_factor,
    _yield_curvature,
    compute_hinge_damage_from_history,
)


class TestClassify:
    cap = {"io": 0.005, "ls": 0.015, "cp": 0.025}

    def test_elastic(self):
        assert _classify(0.001, **self.cap) == "none"

    def test_near_io(self):
        assert _classify(0.003, **self.cap) == "near_io"

    def test_io(self):
        assert _classify(0.010, **self.cap) == "io"

    def test_ls(self):
        assert _classify(0.020, **self.cap) == "ls"

    def test_cp(self):
        assert _classify(0.030, **self.cap) == "cp"

    def test_collapse(self):
        assert _classify(0.050, **self.cap) == "collapse"


class TestConfinementFactor:
    def test_typical(self):
        assert _confinement_factor(0.012) == pytest.approx(1.0, abs=0.001)

    def test_low_bound(self):
        assert _confinement_factor(0.001) == pytest.approx(0.6, abs=0.01)

    def test_high_bound(self):
        assert _confinement_factor(0.100) == pytest.approx(1.4, abs=0.01)


class TestYieldCurvature:
    def test_beam_h40cm(self):
        # ε_y = 420/200000 = 0.0021 → κ_y ≈ 2.2 × 0.0021 / 0.40 ≈ 0.01155 1/m
        assert _yield_curvature(420.0, 0.40) == pytest.approx(0.01155, abs=0.0005)


class TestComputeHingeDamageSynthetic:
    """Verifica el post-proceso con una historia NPZ sintética."""

    def _write_fake_history(self, tmp_path, n_steps=20):
        """
        Un elemento columna con curvatura creciente linealmente hasta superar
        κ_y (fluencia) a mitad del análisis.

        Formato esperado por compute_hinge_damage: col_sect_def[step, idx, :]
        con 6 valores [eps_i, kz_i, ky_i, eps_j, kz_j, ky_j].
        """
        # Columna h=0.4m, fy=420 → κ_y ≈ 0.01155 → lp ≈ 0.2m
        # Para alcanzar θ_p ≈ θ_LS (0.012) con lp=0.2 necesitamos
        # excedente κ ≈ 0.012/0.2 = 0.06 → κ_total ≈ 0.072
        kz_max = 0.08
        kz_hist = np.linspace(0.0, kz_max, n_steps)   # curvatura creciente
        zero   = np.zeros(n_steps)

        # col_sect_def: shape (n_steps, 1 ele, 6)
        col_sect_def = np.zeros((n_steps, 1, 6), dtype=np.float32)
        col_sect_def[:, 0, 1] = kz_hist     # curvatura kz en extremo i
        col_sect_def[:, 0, 4] = kz_hist * 0.3  # extremo j menos deformado

        bm_sect_def = np.zeros((n_steps, 0, 6), dtype=np.float32)

        path = tmp_path / "hist.npz"
        np.savez_compressed(
            path,
            col_sect_def = col_sect_def,
            bm_sect_def  = bm_sect_def,
            col_tags     = np.array([70_000_001], dtype=np.int64),
            bm_tags      = np.array([],           dtype=np.int64),
            joint_tags   = np.array([1, 2],       dtype=np.int64),
            cm_tags      = np.array([30_000_001], dtype=np.int64),
            disp_joint   = np.zeros((n_steps, 2, 6), dtype=np.float32),
            disp_cm      = np.zeros((n_steps, 1, 3), dtype=np.float32),
        )
        return path

    def _spec_single_column(self):
        return {
            "elements": {
                "columns": {
                    "C1": {
                        "node_i": "1", "node_j": "2", "story": "S1",
                        "geometry": {"b_m": 0.4, "h_m": 0.4, "L_m": 3.0,
                                     "fc_MPa": 21.0, "fy_MPa": 420.0,
                                     "cover_m": 0.04},
                        "confinement": {
                            "end": {"K": 1.3, "fcc_MPa": 27.3,
                                    "eps_cc": 0.004, "eps_cu": 0.016,
                                    "rho_s": 0.012},
                            "mid": {"K": 1.1, "fcc_MPa": 23.1,
                                    "eps_cc": 0.0025, "eps_cu": 0.010,
                                    "rho_s": 0.006},
                        },
                    },
                },
                "beams": {},
            },
        }

    def test_damage_classification(self, tmp_path):
        hist_path = self._write_fake_history(tmp_path, n_steps=40)
        spec = self._spec_single_column()
        element_lines = [{
            "fid": "C1", "kind": "column", "story": "S1",
            "ele_tag": 70_000_001,
            "node_i": 1, "node_j": 2,
            "b_m": 0.4, "h_m": 0.4, "L_m": 3.0, "lp_m": 0.2,
        }]

        result = compute_hinge_damage_from_history(
            history_path  = hist_path,
            element_lines = element_lines,
            spec          = spec,
            direction     = "X",
        )

        assert result["status"] == "success"
        assert result["n_total"] == 2   # 2 extremos del único elemento
        assert len(result["hinges"]) == 2

        # Extremo i (curvatura mayor) debe tener DCR > extremo j
        end_i = next(h for h in result["hinges"] if h["end"] == "i")
        end_j = next(h for h in result["hinges"] if h["end"] == "j")
        assert end_i["dcr"] > end_j["dcr"]

        # Con κ_max=0.08 y κ_y≈0.01155, θ_p_max ≈ (0.08-0.01155)·0.2 ≈ 0.0137
        # θ_LS_col ≈ 0.012 × k_conf=1.0 → DCR >= IO (dcr > 0.3)
        assert end_i["theta_p_max"] > 0.005
        assert end_i["damage_level"] in ("io", "ls", "cp", "collapse")

    def test_no_history_file(self, tmp_path):
        from pathlib import Path
        result = compute_hinge_damage_from_history(
            history_path  = Path(tmp_path) / "noexiste.npz",
            element_lines = [],
            spec          = {},
        )
        assert result["status"] == "no_history"

    def test_damage_with_torsion_8cols(self, tmp_path):
        """
        Formato real producido por NLFrameOPSBuilder con sección Fiber + `-torsion`:
        sectionDeformation devuelve 4 valores por IP → 8 columnas por elemento
        [eps_i, κz_i, κy_i, tor_i, eps_j, κz_j, κy_j, tor_j].

        El extremo j debe leerse de slab[:, 5] (κz_j) y slab[:, 6] (κy_j),
        no de [4, 5] como asumía el código anterior.
        """
        n_steps = 40
        ky_j_max = 0.08  # curvatura en el EJE Y del extremo j (empuje en X)

        col_sect_def = np.zeros((n_steps, 1, 8), dtype=np.float32)
        # eps axial pequeño (gravitacional) en ambos extremos
        col_sect_def[:, 0, 0] = -5e-5
        col_sect_def[:, 0, 4] = -5e-5
        # κy en el extremo j (índice 6) crece hasta ky_j_max
        col_sect_def[:, 0, 6] = np.linspace(0.0, ky_j_max, n_steps)
        # κy en el extremo i (índice 2) crece menos → el i debe tener menor DCR
        col_sect_def[:, 0, 2] = np.linspace(0.0, ky_j_max * 0.3, n_steps)

        path = tmp_path / "hist.npz"
        np.savez_compressed(
            path,
            col_sect_def = col_sect_def,
            bm_sect_def  = np.zeros((n_steps, 0, 8), dtype=np.float32),
            col_tags     = np.array([70_000_001], dtype=np.int64),
            bm_tags      = np.array([],           dtype=np.int64),
            joint_tags   = np.array([1, 2],       dtype=np.int64),
            cm_tags      = np.array([30_000_001], dtype=np.int64),
            disp_joint   = np.zeros((n_steps, 2, 6), dtype=np.float32),
            disp_cm      = np.zeros((n_steps, 1, 3), dtype=np.float32),
        )

        spec = self._spec_single_column()
        element_lines = [{
            "fid": "C1", "kind": "column", "story": "S1",
            "ele_tag": 70_000_001,
            "node_i": 1, "node_j": 2,
            "b_m": 0.4, "h_m": 0.4, "L_m": 3.0, "lp_m": 0.2,
        }]
        result = compute_hinge_damage_from_history(
            history_path=path, element_lines=element_lines,
            spec=spec, direction="X",
        )

        assert result["status"] == "success"
        end_i = next(h for h in result["hinges"] if h["end"] == "i")
        end_j = next(h for h in result["hinges"] if h["end"] == "j")

        # El extremo j tiene la curvatura dominante → debe tener mayor daño.
        # Antes del fix, se leía slab[:,5] (axial strain ≈ 0) → DCR_j ≈ 0.
        assert end_j["dcr"] > end_i["dcr"]
        assert end_j["theta_p_max"] > 0.005
        assert end_j["damage_level"] in ("io", "ls", "cp", "collapse")
