"""Tests de senales excepcionales y verificacion de tipologia FEMA P-2018."""

import pytest

from engine.field_assessment import StructuralSystem
from engine.field_assessment.fema_p2018 import (
    ExceptionalFlags,
    check_exceptional,
    check_typology_covered,
)


# --- Tipologia -----------------------------------------------------------------


def test_rc_frame_covered():
    r = check_typology_covered(StructuralSystem.rc_frame)
    assert r.covered is True


def test_rc_wall_covered():
    assert check_typology_covered(StructuralSystem.rc_wall).covered is True


def test_rc_dual_covered():
    assert check_typology_covered(StructuralSystem.rc_dual).covered is True


def test_rc_infill_covered():
    assert check_typology_covered(StructuralSystem.rc_infill).covered is True


@pytest.mark.parametrize(
    "system",
    [
        StructuralSystem.tilt_up,
        StructuralSystem.lift_slab,
        StructuralSystem.urm,
        StructuralSystem.steel,
        StructuralSystem.wood,
        StructuralSystem.masonry_confined,
        StructuralSystem.other,
    ],
)
def test_non_rc_systems_not_covered(system):
    """Todos los sistemas fuera del alcance v1 son 'no cubiertos'."""
    r = check_typology_covered(system)
    assert r.covered is False
    assert "no cubierto" in r.reason


# --- Senales excepcionales ----------------------------------------------------


def test_no_flags_returns_not_exceptional():
    r = check_exceptional(ExceptionalFlags())
    assert r.is_exceptional is False
    assert r.active_flags == []


def test_no_asbuilt_docs_triggers():
    r = check_exceptional(ExceptionalFlags(no_asbuilt_docs=True))
    assert r.is_exceptional is True
    assert "no_asbuilt_docs" in r.active_flags


def test_incomplete_load_path_triggers():
    r = check_exceptional(ExceptionalFlags(incomplete_load_path=True))
    assert r.is_exceptional is True


def test_discontinuous_walls_triggers():
    r = check_exceptional(ExceptionalFlags(discontinuous_walls=True))
    assert r.is_exceptional is True


def test_exceptionally_weak_triggers():
    r = check_exceptional(ExceptionalFlags(exceptionally_weak=True))
    assert r.is_exceptional is True


def test_extreme_torsion_triggers():
    r = check_exceptional(ExceptionalFlags(extreme_torsion=True))
    assert r.is_exceptional is True


def test_pounding_active_when_separation_below_1_5_pct():
    """Separacion 90 mm vs edificio de 8 m: 1.5%*8000 = 120 mm > 90 -> pounding."""
    flags = ExceptionalFlags(separation_mm=90.0, shorter_building_height_m=8.0)
    assert flags.pounding_active() is True
    r = check_exceptional(flags)
    assert r.is_exceptional is True
    assert "pounding" in r.active_flags


def test_pounding_inactive_when_separation_above_1_5_pct():
    """Separacion 150 mm vs 8 m: 120 mm requerido, sobra -> sin pounding."""
    flags = ExceptionalFlags(separation_mm=150.0, shorter_building_height_m=8.0)
    assert flags.pounding_active() is False
    r = check_exceptional(flags)
    assert r.is_exceptional is False


def test_pounding_boundary_exact():
    """Exactamente 1.5 % NO dispara pounding (estricto: separacion < 1.5%)."""
    flags = ExceptionalFlags(separation_mm=120.0, shorter_building_height_m=8.0)
    assert flags.pounding_active() is False


def test_pounding_needs_both_fields():
    """Si falta separacion o altura, pounding no aplica."""
    assert ExceptionalFlags(separation_mm=50.0).pounding_active() is False
    assert ExceptionalFlags(shorter_building_height_m=5.0).pounding_active() is False


def test_geotech_hazard_triggers():
    r = check_exceptional(ExceptionalFlags(geotech_hazard=True))
    assert r.is_exceptional is True
    assert "geotech_hazard" in r.active_flags


def test_multiple_flags_all_reported():
    r = check_exceptional(
        ExceptionalFlags(
            no_asbuilt_docs=True,
            extreme_torsion=True,
            geotech_hazard=True,
        )
    )
    assert r.is_exceptional is True
    assert set(r.active_flags) >= {"no_asbuilt_docs", "extreme_torsion", "geotech_hazard"}
