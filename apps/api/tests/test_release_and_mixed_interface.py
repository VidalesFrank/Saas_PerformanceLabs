"""Tests del dispatch de `release` del ops_builder y del detector de
interfaces concreto↔acero.

El fix de release: ETABS marca con "PINNED" vigas/elementos con hinges en
ambos extremos (biela-truss). Antes el ops_builder saltaba estos elementos.
Ahora los crea con `-releasez 3 -releasey 3` para que transmitan axial.

El detector de interfaces: identifica joints donde convergen frames de concreto
y de acero (apoyos de cubierta metálica). Usado por la UI para marcar y
sugerir tipo de conexión.
"""
from __future__ import annotations

import pytest

from app.engine.building.linear.ops_builder import _release_codes
from app.engine.building.mixed_interface import (
    classify_section, detect_mixed_interfaces, summarize_interfaces,
)


# ─────────────────────────────────────────────────────────────────────────────
# _release_codes — mapeo string ETABS -> (release_z, release_y) OpenSees
# ─────────────────────────────────────────────────────────────────────────────

class TestReleaseCodes:

    def test_empty_is_continuous(self):
        assert _release_codes("") == (0, 0)
        assert _release_codes(None) == (0, 0)
        assert _release_codes("   ") == (0, 0)

    def test_pinned_both_ends(self):
        """ETABS 'PINNED' = ambos extremos liberados (biela/truss)."""
        assert _release_codes("PINNED") == (3, 3)
        assert _release_codes("pinned") == (3, 3)

    def test_i_end_hinge(self):
        assert _release_codes("i") == (1, 1)
        assert _release_codes("I") == (1, 1)

    def test_j_end_hinge(self):
        assert _release_codes("j") == (2, 2)
        assert _release_codes("J") == (2, 2)

    def test_both_ends_hinge(self):
        assert _release_codes("ij") == (3, 3)
        assert _release_codes("IJ") == (3, 3)
        assert _release_codes("ji") == (3, 3)

    def test_etabs_granular_m3i_m3j(self):
        """Liberar solo M33 (flexion fuerte) en ambos extremos → rz=3 ry=0."""
        rz, ry = _release_codes("M3IM3J")
        assert rz == 3
        assert ry == 0

    def test_etabs_granular_m2j(self):
        """Liberar solo M22 (flexion debil) en j → rz=0 ry=2."""
        assert _release_codes("M2J") == (0, 2)


# ─────────────────────────────────────────────────────────────────────────────
# classify_section — detección de tipo por section/material
# ─────────────────────────────────────────────────────────────────────────────

class TestClassifySection:

    def test_steel_by_shape_flag(self):
        sec = {"shape": "steel", "material": "Steel_A992", "aisc_type": "W"}
        mats = {"Steel_A992": {"type": "steel", "fy_mpa": 345.0}}
        assert classify_section(sec, mats) == "steel"

    def test_steel_by_aisc_type_only(self):
        """Si falta shape pero hay aisc_type, es acero."""
        sec = {"aisc_type": "IPE"}
        assert classify_section(sec, {}) == "steel"

    def test_concrete_by_material_type(self):
        sec = {"shape": "Rectangular", "material": "Concrete_28MPa"}
        mats = {"Concrete_28MPa": {"type": "concrete", "fpc_mpa": 28.0}}
        assert classify_section(sec, mats) == "concrete"

    def test_concrete_by_fpc(self):
        """Material sin `type` pero con fpc_mpa > 0 → concreto."""
        sec = {"shape": "Rectangular", "material": "C"}
        mats = {"C": {"fpc_mpa": 21.0}}
        assert classify_section(sec, mats) == "concrete"

    def test_unknown_section(self):
        sec = {"shape": "Something", "material": "X"}
        mats = {"X": {"name": "X"}}
        assert classify_section(sec, mats) == "unknown"


# ─────────────────────────────────────────────────────────────────────────────
# detect_mixed_interfaces — caso cubierta metálica sobre edificio RC
# ─────────────────────────────────────────────────────────────────────────────

def _build_roof_canonical() -> dict:
    """Construye un modelo mínimo: 1 columna RC (de N1 a N2) + 2 cerchas
    metálicas (de N2 a N3 y de N2 a N4). N2 es la interfaz."""
    return {
        "materials": {
            "C28": {"type": "concrete", "fpc_mpa": 28.0, "E_mpa": 24870},
            "Steel_A992": {"type": "steel", "fy_mpa": 345.0, "E_mpa": 200000},
        },
        "sections": {
            "COL-RC":  {"material": "C28", "shape": "Rectangular",
                        "A_m2": 0.16, "I33_m4": 2e-3, "I22_m4": 2e-3, "J_m4": 2e-3,
                        "E_mpa": 24870, "G_mpa": 10370},
            "RAF-IPE": {"material": "Steel_A992", "shape": "steel",
                        "aisc_type": "IPE", "steel_shape": "IPE-300",
                        "A_m2": 5.38e-3, "I33_m4": 8.4e-5, "I22_m4": 6e-6, "J_m4": 2e-7,
                        "E_mpa": 200000, "G_mpa": 77000},
        },
        "frames": {
            "C1":  {"section": "COL-RC",  "joint_i": "N1", "joint_j": "N2", "release": ""},
            "R1":  {"section": "RAF-IPE", "joint_i": "N2", "joint_j": "N3", "release": "PINNED"},
            "R2":  {"section": "RAF-IPE", "joint_i": "N2", "joint_j": "N4", "release": "PINNED"},
        },
        "joints": {
            "N1": {"x": 0, "y": 0, "z": 0},
            "N2": {"x": 0, "y": 0, "z": 6},    # interfaz: encima de la col RC
            "N3": {"x": 3, "y": 0, "z": 7},    # cumbrera a 7m, caballete
            "N4": {"x": -3, "y": 0, "z": 7},
        },
    }


class TestDetectMixedInterfaces:

    def test_detects_roof_support(self):
        can = _build_roof_canonical()
        interfaces = detect_mixed_interfaces(can)
        assert len(interfaces) == 1
        iface = interfaces[0]
        assert iface["joint_id"] == "N2"
        assert iface["z"] == 6.0
        assert "C1" in iface["concrete_frames"]
        assert set(iface["steel_frames"]) == {"R1", "R2"}
        assert iface["is_roof_support"] is True

    def test_summary_counts(self):
        can = _build_roof_canonical()
        interfaces = detect_mixed_interfaces(can)
        s = summarize_interfaces(interfaces)
        assert s["total"] == 1
        assert s["roof_supports"] == 1
        assert s["mid_transitions"] == 0

    def test_all_concrete_no_interfaces(self):
        """Edificio sin acero → cero interfaces."""
        can = _build_roof_canonical()
        # Convertir rafters a concreto
        for name in ("RAF-IPE",):
            can["sections"][name]["material"] = "C28"
            can["sections"][name]["shape"] = "Rectangular"
            can["sections"][name].pop("aisc_type", None)
        interfaces = detect_mixed_interfaces(can)
        assert interfaces == []

    def test_mid_transition_not_roof(self):
        """Columna RC abajo + columna steel arriba (continuación vertical) debe
        detectarse como interfaz pero NO es roof_support ya que ambas son
        verticales — es una transición tipo zapata/pedestal/edificio híbrido."""
        can = _build_roof_canonical()
        # Reemplazar los rafters inclinados por una columna vertical steel.
        can["frames"] = {
            "C1":  {"section": "COL-RC",  "joint_i": "N1", "joint_j": "N2", "release": ""},
            "S1":  {"section": "RAF-IPE", "joint_i": "N2", "joint_j": "N3", "release": ""},
        }
        can["joints"]["N3"] = {"x": 0, "y": 0, "z": 10}
        interfaces = detect_mixed_interfaces(can)
        assert len(interfaces) == 1
        # Aquí sí hay concrete_below y steel sube; la heurística marca como
        # roof_support incluso cuando es transición continua (acepta ambos
        # casos — el usuario decide si es rigid o pinned al asignar release).
        assert interfaces[0]["is_roof_support"] is True

    def test_lateral_steel_beam_no_concrete_below(self):
        """Steel que entra lateral sin columna RC debajo del joint — no es
        roof_support aunque sí es interfaz mixta (puente metálico-RC en el
        plano del piso)."""
        can = {
            "materials": {
                "C28": {"type": "concrete", "fpc_mpa": 28.0},
                "Steel_A992": {"type": "steel", "fy_mpa": 345},
            },
            "sections": {
                "V-RC": {"material": "C28", "shape": "Rectangular"},
                "V-ST": {"material": "Steel_A992", "shape": "steel", "aisc_type": "IPE"},
            },
            "frames": {
                "B1": {"section": "V-RC", "joint_i": "N1", "joint_j": "N2", "release": ""},
                "B2": {"section": "V-ST", "joint_i": "N2", "joint_j": "N3", "release": ""},
            },
            "joints": {
                "N1": {"x": 0, "y": 0, "z": 3},
                "N2": {"x": 5, "y": 0, "z": 3},
                "N3": {"x": 10, "y": 0, "z": 3},
            },
        }
        ifaces = detect_mixed_interfaces(can)
        assert len(ifaces) == 1
        assert ifaces[0]["joint_id"] == "N2"
        assert ifaces[0]["is_roof_support"] is False
