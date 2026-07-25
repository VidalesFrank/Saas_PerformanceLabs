import math

from engine.sections.geometry import CircularSection, PolygonSection, RectangularSection
from engine.sections.reinforcement import bar_area, circ_perimeter_bars, rect_perimeter_bars, total_steel_area


def test_rectangular_section_areas():
    sec = RectangularSection(width=400, height=400, cover=40)
    assert sec.gross_area == 160_000
    assert sec.core_area == 320 * 320


def test_circular_section_areas():
    sec = CircularSection(diameter=500, cover=40)
    assert math.isclose(sec.gross_area, math.pi * 250**2)
    assert math.isclose(sec.core_area, math.pi * 210**2)


def test_polygon_section_area_matches_shoelace_for_rectangle():
    verts = [(-200, -150), (200, -150), (200, 150), (-200, 150)]
    poly = PolygonSection(verts)
    assert poly.gross_area == 400 * 300


def test_rect_perimeter_bars_count_and_symmetry():
    sec = RectangularSection(width=400, height=400, cover=40)
    bars = rect_perimeter_bars(
        sec, cover_to_bar_centroid=52, n_bars_y=3, n_bars_z=3, area_per_bar=bar_area("#8"), mat_tag=1
    )
    assert len(bars) == 8  # perimetro 3x3 = 8 barras (esquinas compartidas)
    assert total_steel_area(bars) == 8 * bar_area("#8")
    ys = sorted({round(b.y, 3) for b in bars})
    assert ys == sorted([-148.0, 0.0, 148.0])


def test_circ_perimeter_bars_count_and_radius():
    sec = CircularSection(diameter=500, cover=40)
    bars = circ_perimeter_bars(sec, cover_to_bar_centroid=52, n_bars=8, area_per_bar=bar_area("#8"), mat_tag=1)
    assert len(bars) == 8
    expected_radius = 250 - 52
    for b in bars:
        r = math.hypot(b.y, b.z)
        assert math.isclose(r, expected_radius, rel_tol=1e-9)


def test_bar_area_unknown_raises():
    import pytest

    with pytest.raises(ValueError):
        bar_area("#99")
