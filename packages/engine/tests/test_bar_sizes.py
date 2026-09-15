"""Test: bar_sizes individuales por barra en document_from_legacy."""
import math

from engine.sections.compiler import document_from_legacy
from engine.sections.reinforcement import BAR_AREAS_MM2


def _cir_reinforcement(bar_sizes=None, n_bars=8):
    return {
        "bar_id": "#8",
        "cover_to_bar_centroid": 50,
        "n_bars": n_bars,
        "bar_sizes": bar_sizes,
    }


def _rect_reinforcement(bar_sizes=None, n_y=3, n_z=3):
    return {
        "bar_id": "#8",
        "cover_to_bar_centroid": 50,
        "n_bars_y": n_y, "n_bars_z": n_z,
        "bar_sizes": bar_sizes,
    }


def _materials():
    return {"fpc": 28.0, "fy": 420.0, "es": 200000.0}


class TestCircularBarSizes:
    def test_default_uses_bar_id(self):
        doc = document_from_legacy(
            shape_type="circular",
            geometry={"diameter": 500},
            materials=_materials(),
            reinforcement=_cir_reinforcement(),
            cover=40,
        )
        assert all(b.bar_size == "#8" for b in doc.bars)
        assert len(doc.bars) == 8

    def test_bar_sizes_override_individual(self):
        sizes = ["#5", "#8", "#8", "#8", "#8", "#8", "#8", "#8"]
        doc = document_from_legacy(
            shape_type="circular",
            geometry={"diameter": 500},
            materials=_materials(),
            reinforcement=_cir_reinforcement(bar_sizes=sizes),
            cover=40,
        )
        assert doc.bars[0].bar_size == "#5"
        assert doc.bars[1].bar_size == "#8"
        assert doc.bars[7].bar_size == "#8"

    def test_invalid_size_falls_back_to_bar_id(self):
        sizes = ["FOO", "#7", "#8", "#8", "#8", "#8", "#8", "#8"]
        doc = document_from_legacy(
            shape_type="circular",
            geometry={"diameter": 500},
            materials=_materials(),
            reinforcement=_cir_reinforcement(bar_sizes=sizes),
            cover=40,
        )
        assert doc.bars[0].bar_size == "#8"    # FOO ignorado → fallback
        assert doc.bars[1].bar_size == "#7"

    def test_shorter_bar_sizes_falls_back_for_missing(self):
        sizes = ["#4", "#4"]                     # menos que n_bars=8
        doc = document_from_legacy(
            shape_type="circular",
            geometry={"diameter": 500},
            materials=_materials(),
            reinforcement=_cir_reinforcement(bar_sizes=sizes),
            cover=40,
        )
        assert doc.bars[0].bar_size == "#4"
        assert doc.bars[1].bar_size == "#4"
        assert doc.bars[2].bar_size == "#8"    # no hay entrada → fallback

    def test_steel_area_reflects_individual_sizes(self):
        sizes = ["#4"] * 8    # #4 → 129 mm² c/u
        doc = document_from_legacy(
            shape_type="circular",
            geometry={"diameter": 500},
            materials=_materials(),
            reinforcement=_cir_reinforcement(bar_sizes=sizes),
            cover=40,
        )
        expected = 8 * BAR_AREAS_MM2["#4"]
        assert abs(doc.steel_area - expected) < 0.5


class TestRectangularBarSizes:
    def test_bar_sizes_perimeter_order(self):
        # 3x3 = 8 barras totales (2·3 arriba/abajo + 2·(3-2) laterales = 6+2 = 8)
        sizes = ["#5", "#6", "#7", "#8", "#9", "#10", "#11", "#4"]
        doc = document_from_legacy(
            shape_type="rectangular",
            geometry={"width": 400, "height": 400},
            materials=_materials(),
            reinforcement=_rect_reinforcement(bar_sizes=sizes, n_y=3, n_z=3),
            cover=40,
        )
        assert len(doc.bars) == 8
        # Cada barra debe respetar su tamaño asignado
        actual = [b.bar_size for b in doc.bars]
        assert actual == sizes


class TestSpecialBarSizes:
    def test_special_uses_individual_sizes(self):
        explicit_bars = [(150, 150), (150, -150), (-150, 150), (-150, -150)]
        sizes = ["#4", "#5", "#6", "#7"]
        doc = document_from_legacy(
            shape_type="special",
            geometry={"vertices": [(-200, -200), (200, -200), (200, 200), (-200, 200)]},
            materials=_materials(),
            reinforcement={
                "bar_id": "#8",
                "cover_to_bar_centroid": 50,
                "bars": explicit_bars,
                "bar_sizes": sizes,
            },
            cover=40,
        )
        assert [b.bar_size for b in doc.bars] == sizes
