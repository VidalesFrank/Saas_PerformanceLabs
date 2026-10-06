"""Tests para downsampling LTTB y storage binario .npy.

Estos dos cambios permiten manejar registros muy largos (24 h a 250 Hz →
21.6 M muestras) sin que el endpoint /timeseries devuelva 1.7 GB de JSON.
"""

from __future__ import annotations

import os
import tempfile

import numpy as np
import pytest

from app.engine.ground_motion.io.parser import (
    load_record_auto,
    load_record_binary,
    save_record_binary,
)
from app.engine.ground_motion.record import GroundMotionRecord, ProcessingStep, SignalChannel
from app.engine.ground_motion.processing.downsample import lttb_downsample, lttb_indices


# ── LTTB ────────────────────────────────────────────────────────────────────

class TestLTTB:
    def test_no_downsampling_if_n_out_ge_n(self):
        x = np.arange(100, dtype=float)
        y = np.sin(x / 10)
        x_ds, y_ds = lttb_downsample(x, y, 100)
        assert len(x_ds) == 100
        assert len(y_ds) == 100

        x_ds, y_ds = lttb_downsample(x, y, 500)
        assert len(x_ds) == 100  # nunca amplía

    def test_preserves_endpoints(self):
        """El primer y el último punto se conservan siempre."""
        x = np.arange(1000, dtype=float)
        y = np.sin(x / 30)
        x_ds, y_ds = lttb_downsample(x, y, 50)

        assert x_ds[0] == x[0]
        assert x_ds[-1] == x[-1]
        assert y_ds[0] == y[0]
        assert y_ds[-1] == y[-1]

    def test_output_length_matches_n_out(self):
        x = np.arange(10_000, dtype=float)
        y = np.sin(x / 100)
        x_ds, y_ds = lttb_downsample(x, y, 200)
        assert len(x_ds) == 200
        assert len(y_ds) == 200

    def test_preserves_peak_visually(self):
        """Una serie con un pico agudo debe conservar el pico en la salida."""
        n = 5000
        x = np.arange(n, dtype=float)
        y = np.zeros(n)
        peak_idx = 2500
        y[peak_idx] = 100.0

        x_ds, y_ds = lttb_downsample(x, y, 100)
        # El pico debe estar cerca (mismo bin) y con amplitud similar
        max_idx = int(np.argmax(y_ds))
        assert abs(x_ds[max_idx] - peak_idx) < n / 100  # dentro del bin
        assert y_ds[max_idx] == 100.0                    # amplitud exacta

    def test_indices_match_downsample(self):
        """lttb_indices debe reproducir exactamente lttb_downsample."""
        x = np.linspace(0, 10, 3000)
        y = np.sin(2 * np.pi * x) + 0.1 * np.random.default_rng(0).standard_normal(3000)

        x_ds, y_ds = lttb_downsample(x, y, 150)
        idx = lttb_indices(x, y, 150)

        np.testing.assert_array_equal(x_ds, x[idx])
        np.testing.assert_array_equal(y_ds, y[idx])

    def test_x_axis_monotonic_after_downsample(self):
        x = np.arange(10_000, dtype=float)
        y = np.random.default_rng(0).standard_normal(10_000)
        x_ds, _ = lttb_downsample(x, y, 500)
        # x debe seguir siendo estrictamente creciente
        assert np.all(np.diff(x_ds) > 0)


# ── Storage binario .npy ────────────────────────────────────────────────────

def _make_record(n: int = 500, with_processed: bool = False) -> GroundMotionRecord:
    """Registro sintético con 2 canales para probar el roundtrip."""
    dt = 0.005
    t = np.arange(n) * dt
    a1 = np.sin(2 * np.pi * 3 * t)
    a2 = np.cos(2 * np.pi * 3 * t)

    ch1 = SignalChannel(
        name="H1", quantity="acceleration", component="EW",
        original_unit="g", si_unit="m/s²",
        raw_values=a1, values_si=a1 * 9.80665,
        processed_values=(a1 * 0.5) if with_processed else None,
        processing_history=[
            ProcessingStep(operation="baseline_mean", params={"method": "mean"}, description="test"),
        ] if with_processed else [],
    )
    ch2 = SignalChannel(
        name="H2", quantity="acceleration", component="NS",
        original_unit="g", si_unit="m/s²",
        raw_values=a2, values_si=a2 * 9.80665,
    )

    rec = GroundMotionRecord(
        id="rec-abc", name="test", source_file="x.msd", source_format="mseed",
        dt=dt, n_samples=n, duration=(n - 1) * dt, fs=1 / dt, nyquist=0.5 / dt,
        time=t, channels=[ch1, ch2], metadata={"station": "TEST"},
        processing_log=[
            ProcessingStep(operation="calibration", params={"mode": "sensitivity"}, description="init"),
        ],
    )
    return rec


class TestBinaryStorage:
    def test_roundtrip_preserves_arrays(self):
        rec = _make_record(n=1000, with_processed=True)
        with tempfile.TemporaryDirectory() as tmp:
            meta_path = save_record_binary(rec, tmp)
            assert meta_path.endswith("record_meta.json")
            assert os.path.exists(os.path.join(tmp, "arrays", "time.npy"))
            assert os.path.exists(os.path.join(tmp, "arrays", "ch0_raw.npy"))
            assert os.path.exists(os.path.join(tmp, "arrays", "ch0_si.npy"))
            assert os.path.exists(os.path.join(tmp, "arrays", "ch0_proc.npy"))
            # ch1 no tiene processed_values → no debe existir ese archivo
            assert not os.path.exists(os.path.join(tmp, "arrays", "ch1_proc.npy"))

            rec2 = load_record_binary(meta_path)

        assert rec2.id == rec.id
        assert rec2.n_samples == rec.n_samples
        assert rec2.dt == rec.dt
        assert len(rec2.channels) == 2
        for c_orig, c_load in zip(rec.channels, rec2.channels):
            np.testing.assert_array_equal(c_orig.raw_values, c_load.raw_values)
            np.testing.assert_array_equal(c_orig.values_si, c_load.values_si)
            if c_orig.processed_values is not None:
                np.testing.assert_array_equal(c_orig.processed_values, c_load.processed_values)
            else:
                assert c_load.processed_values is None
        np.testing.assert_array_equal(rec.time, rec2.time)

    def test_metadata_preserved(self):
        rec = _make_record()
        with tempfile.TemporaryDirectory() as tmp:
            save_record_binary(rec, tmp)
            rec2 = load_record_binary(tmp)  # directorio también funciona
        assert rec2.metadata == rec.metadata
        assert len(rec2.processing_log) == 1
        assert rec2.processing_log[0].operation == "calibration"

    def test_processing_history_preserved(self):
        rec = _make_record(with_processed=True)
        with tempfile.TemporaryDirectory() as tmp:
            save_record_binary(rec, tmp)
            rec2 = load_record_binary(tmp)
        assert len(rec2.channels[0].processing_history) == 1
        assert rec2.channels[0].processing_history[0].operation == "baseline_mean"

    def test_load_auto_detects_binary_dir(self):
        rec = _make_record()
        with tempfile.TemporaryDirectory() as tmp:
            save_record_binary(rec, tmp)
            # Cargar dando el directorio
            rec_dir = load_record_auto(tmp)
            # Cargar dando el JSON meta
            rec_meta = load_record_auto(os.path.join(tmp, "record_meta.json"))
        assert rec_dir.n_samples == rec.n_samples
        assert rec_meta.n_samples == rec.n_samples

    def test_load_auto_fallback_to_legacy_json(self):
        """Registros viejos guardados con el formato v1 (JSON inline) deben seguir cargando."""
        import json
        from app.engine.ground_motion.io.parser import record_to_storage_dict

        rec = _make_record()
        with tempfile.TemporaryDirectory() as tmp:
            legacy_path = os.path.join(tmp, "record_data.json")
            with open(legacy_path, "w") as f:
                json.dump(record_to_storage_dict(rec), f)
            rec_loaded = load_record_auto(legacy_path)
        assert rec_loaded.n_samples == rec.n_samples
        np.testing.assert_array_equal(rec_loaded.channels[0].raw_values, rec.channels[0].raw_values)
