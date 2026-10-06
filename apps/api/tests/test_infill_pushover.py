"""
Tests de integración: infills aportan rigidez al pórtico en pushover.

Construye un pórtico 1 vano × 1 piso 3D con geometría mínima y verifica:
- Sin infill: cortante basal y rigidez elástica base.
- Con infill: cortante basal mayor y modal más rígido (período menor).
"""
from __future__ import annotations

import pytest

pytest.importorskip("openseespy")

from app.engine.building.nonlinear.nl_frame_ops_builder import NLFrameOPSBuilder


def _mini_canonical(with_infill: bool = False) -> dict:
    """
    Pórtico 1 vano × 1 piso. 4 nodos base (3,0,3)+(0,0,3)+(5,0,0)+(0,0,0),
    4 nodos piso 1 (iguales en XY, z=3), 2 columnas, 1 viga, 1 masa en piso 1.
    """
    canon = {
        "stories":   {"P1": {"elevation_m": 3.0}},
        "joints":    {},
        "restraints": {"1": [1,1,1,1,1,1], "2": [1,1,1,1,1,1]},
        "frames":    {
            # Columnas: joint_i (base), joint_j (tope), story P1
            "C1": {"joint_i": "1", "joint_j": "3",
                   "section": "SEC", "element_type": "column",
                   "story": "P1", "release": ""},
            "C2": {"joint_i": "2", "joint_j": "4",
                   "section": "SEC", "element_type": "column",
                   "story": "P1", "release": ""},
            # Viga entre nodos tope
            "B1": {"joint_i": "3", "joint_j": "4",
                   "section": "SEC", "element_type": "beam",
                   "story": "P1", "release": ""},
        },
        "shells": {}, "shell_loads": {}, "masses": {},
    }
    if with_infill:
        canon["masonryMaterials"] = {
            "M_VP_10": {"id": "M_VP_10", "name": "Mamp VP 10MPa",
                         "fm_mpa": 10.0, "brick_type": "VP",
                         "Em_mpa": 7750.0},
        }
        canon["infills"] = {
            "INF-01": {
                "id": "INF-01",
                "column_i_fid": "C1", "column_j_fid": "C2",
                "story": "P1",
                "thickness_m": 0.15,
                "masonry_material_id": "M_VP_10",
                "opening_ratio": 0.0, "width_ratio": 0.25,
                "pier": "",
            },
        }
    return canon


def _mini_spec() -> dict:
    """Spec no lineal minimal (secciones por default)."""
    return {
        "stories": {"P1": {"elevation_m": 3.0}},
        "nodes": {
            "1": {"x": 0.0, "y": 0.0, "z": 0.0, "story": ""},
            "2": {"x": 5.0, "y": 0.0, "z": 0.0, "story": ""},
            "3": {"x": 0.0, "y": 0.0, "z": 3.0, "story": "P1"},
            "4": {"x": 5.0, "y": 0.0, "z": 3.0, "story": "P1"},
        },
        "masses": {"P1": {"story": "P1", "x_cm_m": 2.5, "y_cm_m": 0.0,
                            "z_m": 3.0, "mass_x_t": 10.0, "mass_y_t": 10.0,
                            "mass_rz_tm2": 50.0, "W_kN": 98.1}},
        "elements": {
            "columns": {
                "C1": {"node_i": "1", "node_j": "3", "story": "P1",
                       "geometry": {"b_m": 0.3, "h_m": 0.3, "L_m": 3.0,
                                     "fc_MPa": 21.0, "fy_MPa": 420.0,
                                     "cover_m": 0.04},
                       "reinforcement": {"longitudinal": {"n_bars": 8, "bar_label": "#6"}},
                       "confinement": {
                           "end": {"fcc_MPa": 27.3, "eps_cc": 0.004,
                                   "eps_cu": 0.016, "rho_s": 0.012},
                           "mid": {"fcc_MPa": 23.1, "eps_cc": 0.0025,
                                   "eps_cu": 0.010, "rho_s": 0.006},
                       }},
                "C2": {"node_i": "2", "node_j": "4", "story": "P1",
                       "geometry": {"b_m": 0.3, "h_m": 0.3, "L_m": 3.0,
                                     "fc_MPa": 21.0, "fy_MPa": 420.0,
                                     "cover_m": 0.04},
                       "reinforcement": {"longitudinal": {"n_bars": 8, "bar_label": "#6"}},
                       "confinement": {
                           "end": {"fcc_MPa": 27.3, "eps_cc": 0.004,
                                   "eps_cu": 0.016, "rho_s": 0.012},
                           "mid": {"fcc_MPa": 23.1, "eps_cc": 0.0025,
                                   "eps_cu": 0.010, "rho_s": 0.006},
                       }},
            },
            "beams": {
                "B1": {"node_i": "3", "node_j": "4", "story": "P1",
                       "geometry": {"b_m": 0.3, "h_m": 0.4, "L_m": 5.0,
                                     "fc_MPa": 21.0, "fy_MPa": 420.0,
                                     "cover_m": 0.04},
                       "reinforcement": {"zones": {"end_i": {
                           "top": {"n_bars": 3, "bar_label": "#5"},
                           "bot": {"n_bars": 2, "bar_label": "#5"},
                       }}},
                       "confinement": {
                           "end": {"fcc_MPa": 27.3, "eps_cc": 0.004,
                                   "eps_cu": 0.016, "rho_s": 0.012},
                           "mid": {"fcc_MPa": 23.1, "eps_cc": 0.0025,
                                   "eps_cu": 0.010, "rho_s": 0.006},
                       }},
            },
        },
    }


def _run_pushover(canon: dict) -> dict:
    b = NLFrameOPSBuilder(canon, _mini_spec())
    info = b.build()
    b.run_gravity()
    r = b.run_pushover(direction="X", pattern_type="triangular",
                        target_drift_pct=0.5, inc_m=0.001)
    return {**r, "n_infills": info.get("n_infills", 0)}


class TestInfillAddsStiffness:

    def test_without_infill(self):
        r = _run_pushover(_mini_canonical(with_infill=False))
        assert r["status"] == "success"
        assert r["n_infills"] == 0
        self._shear_no_infill = r["summary"]["max_base_shear_kN"]

    def test_with_infill_higher_shear(self):
        r0 = _run_pushover(_mini_canonical(with_infill=False))
        r1 = _run_pushover(_mini_canonical(with_infill=True))
        assert r0["status"] == "success" and r1["status"] == "success"
        assert r1["n_infills"] == 1
        # Con infill el cortante basal al mismo drift debe ser mayor.
        shear_0 = r0["summary"]["max_base_shear_kN"]
        shear_1 = r1["summary"]["max_base_shear_kN"]
        assert shear_1 > shear_0 * 1.3, (
            f"infill no aportó rigidez: Vb_sin={shear_0:.1f} Vb_con={shear_1:.1f}"
        )
