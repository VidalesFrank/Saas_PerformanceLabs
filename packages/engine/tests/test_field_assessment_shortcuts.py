"""Tests de atajos de riesgo bajo FEMA P-2018: WSI y elastico global."""

import pytest

from engine.field_assessment.fema_p2018 import ShortcutInput, apply_shortcuts


def test_wsi_above_threshold_applies():
    """Un WSI alto (edificio muy amuretado y liviano) califica como bajo."""
    inp = ShortcutInput(
        area_walls_x_m2=3.0,
        area_walls_y_m2=3.0,
        seismic_weight_kN=50.0,     # WSI = 3 * 1000 / 50 = 60 >> 30
        wsi_threshold=30.0,
    )
    r = apply_shortcuts(inp)
    assert r.applied == "wsi"
    assert r.is_low_risk is True
    assert r.wsi_value == pytest.approx(60.0)


def test_wsi_below_threshold_does_not_apply():
    inp = ShortcutInput(
        area_walls_x_m2=0.5,
        area_walls_y_m2=0.5,
        seismic_weight_kN=500.0,   # WSI = 0.5 * 1000 / 500 = 1.0 << 30
        wsi_threshold=30.0,
    )
    r = apply_shortcuts(inp)
    assert r.applied is None
    assert r.is_low_risk is False
    assert r.wsi_value == pytest.approx(1.0)


def test_wsi_uses_minimum_direction():
    """El WSI se calcula con la direccion con MENOS muros (la mas debil)."""
    inp = ShortcutInput(
        area_walls_x_m2=10.0,
        area_walls_y_m2=1.0,        # direccion debil
        seismic_weight_kN=100.0,
        wsi_threshold=30.0,
    )
    r = apply_shortcuts(inp)
    # WSI = 1.0 * 1000 / 100 = 10 < 30 -> no califica pese al buen X.
    assert r.wsi_value == pytest.approx(10.0)
    assert r.is_low_risk is False


def test_elastic_global_below_threshold_applies():
    """Ratio global < 0.5 -> edificio esencialmente elastico."""
    inp = ShortcutInput(
        global_ratio_D_over_C=0.3,
        elastic_threshold=0.5,
    )
    r = apply_shortcuts(inp)
    assert r.applied == "elastic_global"
    assert r.is_low_risk is True


def test_elastic_global_above_threshold_does_not_apply():
    inp = ShortcutInput(
        global_ratio_D_over_C=0.7,
        elastic_threshold=0.5,
    )
    r = apply_shortcuts(inp)
    assert r.applied is None
    assert r.is_low_risk is False


def test_wsi_takes_precedence_over_elastic():
    """Si ambos aplican, WSI se reporta primero (orden del calculo)."""
    inp = ShortcutInput(
        area_walls_x_m2=3.0,
        area_walls_y_m2=3.0,
        seismic_weight_kN=50.0,       # WSI OK
        global_ratio_D_over_C=0.2,    # elastico tambien OK
    )
    r = apply_shortcuts(inp)
    assert r.applied == "wsi"
    assert r.is_low_risk is True


def test_neither_input_returns_no_shortcut():
    """Sin datos -> ningun atajo aplica, resultado neutral."""
    r = apply_shortcuts(ShortcutInput())
    assert r.applied is None
    assert r.is_low_risk is False
    assert r.wsi_value is None
    assert r.global_ratio is None
