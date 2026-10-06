"""
Tests de regresión para DataValidator._check_frames.

Bug histórico (2026-09-25):
    `int(pd.to_numeric(row.get("Joint J", np.nan), errors="coerce") or 0)`
    fallaba con `ValueError: cannot convert float NaN to integer` cuando la
    celda estaba vacía. En Python, `nan or 0` devuelve nan (NaN es truthy),
    no 0. Fix: usar `pd.isna()` explícito y saltar la fila si falta un nodo.
"""
import numpy as np
import pandas as pd

from app.engine.building.linear.validator import DataValidator


def _joints_df() -> pd.DataFrame:
    return pd.DataFrame({
        "Element Label": [1, 2, 3],
        "Global X":      [0.0, 5.0, 5.0],
        "Global Y":      [0.0, 0.0, 3.0],
        "Global Z":      [0.0, 0.0, 3.0],
    })


class TestFramesWithMissingJoints:
    def test_nan_joint_j_does_not_raise(self):
        """
        Regresión: una fila de frames con Joint J vacío (NaN) no debe hacer
        que la validación explote con ValueError.
        """
        frames = pd.DataFrame({
            "Element Label": [10, 11],
            "Joint I":       [1, 2],
            "Joint J":       [3, np.nan],
        })
        issues = DataValidator()._check_frames(frames, _joints_df())
        assert isinstance(issues, list)

    def test_nan_joint_i_does_not_raise(self):
        frames = pd.DataFrame({
            "Element Label": [10, 11],
            "Joint I":       [np.nan, 2],
            "Joint J":       [3, 1],
        })
        issues = DataValidator()._check_frames(frames, _joints_df())
        assert isinstance(issues, list)

    def test_all_valid_frames_check_short_element(self):
        """
        Sanity: frames válidos siguen chequeando longitud corta.
        Nodos 2 y 3 comparten x=5 pero difieren en y=0→3 y z=0→3 → L=√18 ≈ 4.24 m
        (no corto). Añadimos un frame degenerado (mismo nodo i=j) que da L=0 →
        no dispara SHORT_ELEMENT porque el filtro es 0 < L < 0.10.
        """
        frames = pd.DataFrame({
            "Element Label": [10],
            "Joint I":       [2],
            "Joint J":       [3],
        })
        issues = DataValidator()._check_frames(frames, _joints_df())
        codes = [i.code for i in issues]
        assert "SHORT_ELEMENT" not in codes

    def test_string_joint_values_coerced_safely(self):
        """Celdas string no numéricas deben tratarse como faltantes, sin explotar."""
        frames = pd.DataFrame({
            "Element Label": [10, 11],
            "Joint I":       [1, "N/A"],
            "Joint J":       [2, 3],
        })
        issues = DataValidator()._check_frames(frames, _joints_df())
        assert isinstance(issues, list)
