"""Tests de la Tabla 6-6 (condensada) del protocolo FEMA P-2018."""

import pytest

from engine.field_assessment.fema_p2018 import DEFAULT_TABLE_6_6, interp_rating


def test_below_range_returns_zero():
    """Ratio muy bajo (<0.25) -> rating 0.0."""
    assert interp_rating(0.0) == 0.0
    assert interp_rating(0.10) == 0.0


def test_first_band_flat():
    """Dentro de [0.0, 0.25] el rating es 0.0."""
    assert interp_rating(0.20) == 0.0


def test_second_band_flat():
    """Dentro de [0.5, 0.7] el rating es 0.3."""
    assert interp_rating(0.5) == pytest.approx(0.3)
    assert interp_rating(0.6) == pytest.approx(0.3)
    assert interp_rating(0.7) == pytest.approx(0.3)


def test_third_band_flat():
    """Dentro de [0.9, 1.1] el rating es 0.5 (demanda = capacidad)."""
    assert interp_rating(1.0) == pytest.approx(0.5)


def test_fourth_band_flat():
    """Dentro de [1.4, 1.8] el rating es 0.7."""
    assert interp_rating(1.5) == pytest.approx(0.7)


def test_fifth_band_flat():
    """Dentro de [1.8, 2.5] el rating es 0.8."""
    assert interp_rating(2.0) == pytest.approx(0.8)


def test_sixth_band_flat():
    """Por encima de 3.0 el rating es 0.93 (perdida de soporte casi segura)."""
    assert interp_rating(3.5) == pytest.approx(0.93)
    assert interp_rating(10.0) == pytest.approx(0.93)


def test_interpolation_between_first_and_second_band():
    """En el hueco (0.25, 0.5): interpola linealmente entre centros 0.125 y 0.6."""
    # centro banda 1 = 0.125, rating 0.0
    # centro banda 2 = 0.6,   rating 0.3
    # ratio 0.4 esta a (0.4-0.125)/(0.6-0.125) = 57.9% del camino
    expected = 0.0 + (0.3 - 0.0) * (0.4 - 0.125) / (0.6 - 0.125)
    assert interp_rating(0.4) == pytest.approx(expected, rel=1e-6)


def test_interpolation_between_second_and_third_band():
    """En el hueco (0.7, 0.9): interpola linealmente entre centros de bandas 2 y 3."""
    # centro banda 2 = 0.6,  rating 0.3
    # centro banda 3 = 1.0,  rating 0.5
    # ratio 0.8 esta a (0.8-0.6)/(1.0-0.6) = 50% del camino -> 0.4
    assert interp_rating(0.8) == pytest.approx(0.4, rel=1e-6)


def test_interpolation_monotonic_across_full_range():
    """Rating debe ser no-decreciente en todo el rango [0, 3.0]."""
    ratios = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9,
              1.0, 1.2, 1.4, 1.6, 1.8, 2.0, 2.5, 3.0, 3.5]
    ratings = [interp_rating(r) for r in ratios]
    for i in range(1, len(ratings)):
        assert ratings[i] >= ratings[i - 1] - 1e-9, (
            f"Rating decrecio: r={ratios[i-1]} -> {ratings[i-1]:.4f}, "
            f"r={ratios[i]} -> {ratings[i]:.4f}"
        )


def test_default_table_has_six_bands():
    """La tabla condensada del enunciado tiene 6 bandas."""
    assert len(DEFAULT_TABLE_6_6) == 6


def test_custom_table_works():
    """Puedes pasar tu propia tabla si tienes la version completa de FEMA P-2018."""
    from engine.field_assessment.fema_p2018.table_6_6 import Band

    custom = [
        Band(0.0, 0.5, 0.10),
        Band(1.0, 2.0, 0.60),
    ]
    assert interp_rating(0.3, custom) == pytest.approx(0.10)
    assert interp_rating(1.5, custom) == pytest.approx(0.60)
