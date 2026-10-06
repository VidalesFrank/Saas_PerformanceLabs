"""
Tests de importación del grid ETABS al canonical_model.

Verifica:
  - _t_grid del adapter normaliza 'Grid Definitions - Grid Lines' a columnas
    {Axis, Label, Coord_m}.
  - Filtra grid lines sin ID o sin Ordinate.
  - Ignora Grid Line Type que no empiece con X o Y (radial, etc.).
  - CanonicalModelBuilder._build_grid poblá axes_x/axes_y/stories ordenados.
  - Sin tabla Grid Definitions, retorna estructura vacía consistente.
"""
import pandas as pd
import pytest

from app.engine.building.etabs_adapter import _t_grid
from app.engine.building.linear.model_builder import CanonicalModelBuilder, _K_GRID


# ── _t_grid ──────────────────────────────────────────────────────────────────

class TestAdapterGrid:
    def test_normalizes_x_and_y_axes(self):
        df = pd.DataFrame({
            "Name":           ["G1", "G1", "G1"],
            "Grid Line Type": ["X (Cartesian)", "Y (Cartesian)", "X (Cartesian)"],
            "ID":             ["A", "1", "B"],
            "Ordinate":       [0.0, 5.4, 5.46],
        })
        out = _t_grid(df)
        assert list(out.columns) == ["Axis", "Label", "Coord_m"]
        assert len(out) == 3
        assert set(out["Axis"]) == {"X", "Y"}

    def test_alphanumeric_labels_preserved(self):
        """Los labels de ETABS pueden ser A/A1/B'/C1 — deben pasar como string."""
        df = pd.DataFrame({
            "Name":           ["G1"] * 3,
            "Grid Line Type": ["X (Cartesian)"] * 3,
            "ID":             ["A1", "B'", "C2"],
            "Ordinate":       [0.44, 9.45, 13.44],
        })
        out = _t_grid(df)
        assert set(out["Label"]) == {"A1", "B'", "C2"}

    def test_skips_rows_missing_id_or_ordinate(self):
        df = pd.DataFrame({
            "Name":           ["G1", "G1", "G1"],
            "Grid Line Type": ["X (Cartesian)"] * 3,
            "ID":             ["A", "", "B"],
            "Ordinate":       [0.0, 5.0, None],
        })
        out = _t_grid(df)
        assert len(out) == 1
        assert out.iloc[0]["Label"] == "A"

    def test_ignores_non_cartesian_grid_types(self):
        df = pd.DataFrame({
            "Name":           ["G1", "G1"],
            "Grid Line Type": ["Radial", "X (Cartesian)"],
            "ID":             ["R1", "A"],
            "Ordinate":       [45.0, 0.0],
        })
        out = _t_grid(df)
        assert len(out) == 1
        assert out.iloc[0]["Axis"] == "X"

    def test_missing_columns_returns_empty(self):
        df = pd.DataFrame({"Name": ["G1"], "Foo": [1]})
        out = _t_grid(df)
        assert list(out.columns) == ["Axis", "Label", "Coord_m"]
        assert len(out) == 0


# ── CanonicalModelBuilder._build_grid ────────────────────────────────────────

def _minimal_stories() -> dict:
    return {
        "Base":    {"elevation_m": 0.0,  "height_m": 0.0},
        "Story1":  {"elevation_m": 3.0,  "height_m": 3.0},
        "Story2":  {"elevation_m": 6.0,  "height_m": 3.0},
    }


class TestBuildGrid:
    def test_produces_axes_x_y_sorted(self):
        raw = {_K_GRID: pd.DataFrame([
            {"Axis": "X", "Label": "B",  "Coord_m": 5.46},
            {"Axis": "X", "Label": "A",  "Coord_m": 0.0},
            {"Axis": "Y", "Label": "2",  "Coord_m": 5.4},
            {"Axis": "Y", "Label": "1",  "Coord_m": 0.0},
        ])}
        grid = CanonicalModelBuilder(raw)._build_grid(_minimal_stories())
        assert [a["name"] for a in grid["axes_x"]] == ["A", "B"]
        assert [a["name"] for a in grid["axes_y"]] == ["1", "2"]
        assert grid["axes_x"][0]["coord_m"] == 0.0

    def test_stories_from_dict_ordered_by_elevation(self):
        raw = {_K_GRID: pd.DataFrame([
            {"Axis": "X", "Label": "A", "Coord_m": 0.0},
        ])}
        grid = CanonicalModelBuilder(raw)._build_grid(_minimal_stories())
        names = [s["name"] for s in grid["stories"]]
        assert names == ["Base", "Story1", "Story2"]

    def test_no_grid_table_returns_stories_only(self):
        """Sin Grid Definitions pero con stories → axes vacíos pero stories poblados."""
        grid = CanonicalModelBuilder({})._build_grid(_minimal_stories())
        assert grid["axes_x"] == []
        assert grid["axes_y"] == []
        assert len(grid["stories"]) == 3

    def test_no_grid_and_no_stories_returns_empty(self):
        grid = CanonicalModelBuilder({})._build_grid({})
        assert grid == {}

    def test_ignores_unknown_axis_values(self):
        raw = {_K_GRID: pd.DataFrame([
            {"Axis": "X",  "Label": "A", "Coord_m": 0.0},
            {"Axis": "Z",  "Label": "?", "Coord_m": 3.0},
        ])}
        grid = CanonicalModelBuilder(raw)._build_grid({})
        assert len(grid["axes_x"]) == 1
        assert len(grid["axes_y"]) == 0
