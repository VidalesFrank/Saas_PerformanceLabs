"""Tests del importador miniSEED (.msd/.mseed).

Valida:
  - Detección de estructura sintética (1 columna, metadata SEED completa)
  - Construcción de GroundMotionRecord directamente desde bytes miniSEED
  - Enrutamiento correcto desde detect_structure y build_record al parser SEED
  - Preservación de raw_values y conversión g -> m/s²
"""

from __future__ import annotations

import io

import numpy as np
import pytest

from app.engine.ground_motion.io.detector import detect_structure
from app.engine.ground_motion.io.miniseed import (
    apply_calibration,
    build_record_from_miniseed,
    detect_miniseed_structure,
    is_miniseed_filename,
)
from app.engine.ground_motion.io.parser import ColumnMapping, build_record
from app.engine.ground_motion.units import COUNTS_UNIT, G_STD


# ── Fixture: miniSEED sintético en memoria ────────────────────────────────────

def _synthetic_mseed_bytes(
    npts: int = 5000,
    fs: float = 200.0,
    network: str = "ED",
    station: str = "TEST",
    location: str = "00",
    channel: str = "HNE",
) -> bytes:
    """Genera un miniSEED válido en memoria con una traza sintética.

    Uso obspy para crear la traza y writing directo al buffer, evitando IO.
    """
    from obspy import Trace, Stream, UTCDateTime

    rng = np.random.default_rng(0)
    # Señal tipo acelerograma en 'g' (valores típicos < 1 g)
    t = np.arange(npts) / fs
    data = (0.3 * np.sin(2 * np.pi * 3.0 * t) * np.exp(-0.5 * t)
            + 0.05 * rng.standard_normal(npts))
    # miniSEED almacena mejor int32; multiplicamos por 1e6 para no perder precisión
    data_int = (data * 1e6).astype(np.int32)

    tr = Trace(data=data_int)
    tr.stats.network = network
    tr.stats.station = station
    tr.stats.location = location
    tr.stats.channel = channel
    tr.stats.sampling_rate = fs
    tr.stats.starttime = UTCDateTime("2026-08-10T00:00:00")

    buf = io.BytesIO()
    Stream([tr]).write(buf, format="MSEED", encoding="STEIM2", reclen=4096)
    return buf.getvalue()


# ── Tests ─────────────────────────────────────────────────────────────────────

class TestMiniseedFilenameDetection:
    def test_msd_extension(self):
        assert is_miniseed_filename("ED.MADOS.10.HNE.D.2026.222.msd")

    def test_mseed_extension(self):
        assert is_miniseed_filename("record.mseed")

    def test_seed_extension(self):
        assert is_miniseed_filename("dataless.seed")

    def test_txt_not_miniseed(self):
        assert not is_miniseed_filename("GM01.txt")

    def test_csv_not_miniseed(self):
        assert not is_miniseed_filename("record.csv")


class TestDetectMiniseedStructure:
    def test_returns_single_column_structure(self):
        content = _synthetic_mseed_bytes(npts=1000, fs=100.0)
        d = detect_miniseed_structure("test.msd", content)

        assert d.file_format == "mseed"
        assert d.n_cols == 1, "Un solo canal debe traducirse en 1 columna"
        assert d.n_rows == 1000
        assert d.has_header is True
        assert d.wrapped_series_hint is False

    def test_header_metadata_has_seed_fields(self):
        content = _synthetic_mseed_bytes(
            npts=500, fs=250.0, network="CO", station="XYZ",
            location="00", channel="HNZ",
        )
        d = detect_miniseed_structure("x.msd", content)

        assert d.header_metadata["network"] == "CO"
        assert d.header_metadata["station"] == "XYZ"
        assert d.header_metadata["channel"] == "HNZ"
        assert abs(d.header_metadata["dt"] - 0.004) < 1e-12
        assert d.header_metadata["fs"] == 250.0
        assert d.header_metadata["npts"] == 500

    def test_column_is_oscillatory(self):
        content = _synthetic_mseed_bytes(npts=1000)
        d = detect_miniseed_structure("test.msd", content)
        col = d.columns[0]
        assert col.is_oscillatory is True
        assert col.suggested_role == "possible_signal"
        assert col.n_valid == 1000
        assert col.confidence == 1.0

    def test_component_extracted_from_channel(self):
        # HNE -> EW
        d_e = detect_miniseed_structure("e.msd", _synthetic_mseed_bytes(channel="HNE"))
        assert "EW" in d_e.columns[0].header
        # HNN -> NS
        d_n = detect_miniseed_structure("n.msd", _synthetic_mseed_bytes(channel="HNN"))
        assert "NS" in d_n.columns[0].header
        # HNZ -> V
        d_z = detect_miniseed_structure("z.msd", _synthetic_mseed_bytes(channel="HNZ"))
        assert "V" in d_z.columns[0].header


class TestDetectStructureRoutesToMiniseed:
    """El detector genérico debe desviar automáticamente al parser SEED por extensión."""

    def test_msd_routes_to_miniseed(self):
        content = _synthetic_mseed_bytes(npts=200)
        d = detect_structure("archivo.msd", content)
        assert d.file_format == "mseed"
        assert "network" in d.header_metadata

    def test_mseed_routes_to_miniseed(self):
        content = _synthetic_mseed_bytes(npts=200)
        d = detect_structure("archivo.mseed", content)
        assert d.file_format == "mseed"


class TestBuildRecordFromMiniseed:
    def test_basic_record_construction(self):
        content = _synthetic_mseed_bytes(
            npts=2000, fs=100.0, network="ED", station="MADOS",
            location="10", channel="HNE",
        )
        rec = build_record_from_miniseed(
            "ED.MADOS.10.HNE.D.2026.222.msd",
            content,
            record_name="MADOS_E",
        )

        assert rec.n_samples == 2000
        assert abs(rec.dt - 0.01) < 1e-12
        assert rec.fs == 100.0
        assert rec.nyquist == 50.0
        assert abs(rec.duration - 19.99) < 1e-8
        assert len(rec.channels) == 1

    def test_channel_is_acceleration_in_g(self):
        content = _synthetic_mseed_bytes(npts=100)
        rec = build_record_from_miniseed("x.msd", content, unit="g")
        ch = rec.channels[0]

        assert ch.quantity == "acceleration"
        assert ch.original_unit == "g"
        assert ch.si_unit == "m/s²"
        # values_si debe ser raw * G_STD
        np.testing.assert_allclose(ch.values_si, ch.raw_values * G_STD, rtol=1e-12)

    def test_metadata_enriched_from_seed_header(self):
        content = _synthetic_mseed_bytes(
            network="ED", station="MADOS", location="10", channel="HNZ",
        )
        rec = build_record_from_miniseed("x.msd", content, metadata={"earthquake": "Matiz"})

        assert rec.metadata["earthquake"] == "Matiz"  # no sobrescribe lo del usuario
        assert rec.metadata["network"] == "ED"
        assert rec.metadata["station"] == "MADOS"
        assert rec.metadata["channel"] == "HNZ"
        assert rec.metadata["component"] == "V"
        assert "starttime" in rec.metadata

    def test_time_vector_starts_at_zero(self):
        content = _synthetic_mseed_bytes(npts=500, fs=250.0)
        rec = build_record_from_miniseed("x.msd", content)
        assert abs(rec.time[0]) < 1e-15
        assert abs(rec.time[-1] - 499 * 0.004) < 1e-10

    def test_unknown_unit_raises(self):
        content = _synthetic_mseed_bytes(npts=100)
        with pytest.raises(ValueError, match="no reconocida"):
            build_record_from_miniseed("x.msd", content, unit="furlongs/fortnight²")

    def test_build_record_routes_to_miniseed(self):
        """El parser genérico también debe desviar por extensión."""
        content = _synthetic_mseed_bytes(npts=300)
        mappings = [ColumnMapping(col_index=0, quantity="acceleration", unit="g")]
        rec = build_record("x.msd", content, mappings, dt=None, record_name="R")

        assert rec.source_format == "mseed"
        assert rec.n_samples == 300
        assert rec.channels[0].original_unit == "g"

    def test_raw_values_preserved(self):
        """raw_values NO deben modificarse — deben ser exactamente los ints del SEED."""
        content = _synthetic_mseed_bytes(npts=200)
        rec = build_record_from_miniseed("x.msd", content)
        ch = rec.channels[0]
        # obspy devuelve int32; convertimos a float64 sin perder valor entero
        assert np.all(ch.raw_values == ch.raw_values.astype(np.int64).astype(np.float64))


# ── Autodetección de counts ─────────────────────────────────────────────────

class TestCountsAutodetection:
    def test_int32_large_values_detected_as_counts(self):
        """int32 con valores grandes debe sugerir unidad 'counts'."""
        # _synthetic_mseed_bytes multiplica la señal por 1e6 → siempre int32 grande
        content = _synthetic_mseed_bytes(npts=500)
        d = detect_miniseed_structure("x.msd", content)
        assert d.header_metadata["suggested_unit"] == COUNTS_UNIT
        assert d.header_metadata["looks_like_counts"] is True
        # El warning debe mencionar counts
        assert any("counts" in w.lower() for w in d.warnings)

    def test_build_with_counts_unit_keeps_raw_scale(self):
        """unit='counts' debe copiar raw a values_si sin multiplicar por G_STD."""
        content = _synthetic_mseed_bytes(npts=200)
        rec = build_record_from_miniseed("x.msd", content, unit=COUNTS_UNIT)
        ch = rec.channels[0]
        assert ch.original_unit == COUNTS_UNIT
        assert ch.si_unit == COUNTS_UNIT
        np.testing.assert_array_equal(ch.values_si, ch.raw_values)


# ── Calibración: modo 'sensitivity' ─────────────────────────────────────────

class TestCalibrationSensitivity:
    def test_sensitivity_reproduces_known_pga(self):
        """counts → m/s² usando counts/g debe reproducir el PGA correcto.

        Emulamos el caso MADOS: counts con max_abs=155148 y sensitivity=505000
        counts/g → PGA esperado = 155148/505000 * G_STD = 3.013 m/s².
        """
        # Construimos un record en counts sintético con ese pico
        content = _synthetic_mseed_bytes(npts=1000)
        rec = build_record_from_miniseed("x.msd", content, unit=COUNTS_UNIT)
        ch = rec.channels[0]
        peak_counts = float(np.max(np.abs(ch.raw_values - ch.raw_values.mean())))

        sensitivity = 505_000.0
        result = apply_calibration(rec, mode="sensitivity", sensitivity_counts_per_g=sensitivity)

        expected_pga = peak_counts / sensitivity * G_STD
        got_pga = result["channels"][0]["pga_ms2"]
        assert abs(got_pga - expected_pga) < 1e-8

        # values_si actualizado, si_unit cambia a m/s², raw preservado
        assert ch.si_unit == "m/s²"
        assert ch.original_unit == COUNTS_UNIT  # el origen no se pierde
        assert ch.raw_values[0] != ch.values_si[0]  # values_si sí cambió

    def test_sensitivity_is_idempotent(self):
        """Calibrar dos veces con la misma sensibilidad debe dar el mismo resultado
        (siempre parte de raw_values, no de la calibración anterior)."""
        content = _synthetic_mseed_bytes(npts=500)
        rec = build_record_from_miniseed("x.msd", content, unit=COUNTS_UNIT)

        apply_calibration(rec, mode="sensitivity", sensitivity_counts_per_g=500_000)
        first = rec.channels[0].values_si.copy()

        apply_calibration(rec, mode="sensitivity", sensitivity_counts_per_g=500_000)
        second = rec.channels[0].values_si

        np.testing.assert_array_equal(first, second)

    def test_sensitivity_invalid_raises(self):
        content = _synthetic_mseed_bytes(npts=100)
        rec = build_record_from_miniseed("x.msd", content, unit=COUNTS_UNIT)
        with pytest.raises(ValueError, match="sensitivity"):
            apply_calibration(rec, mode="sensitivity", sensitivity_counts_per_g=0)
        with pytest.raises(ValueError, match="sensitivity"):
            apply_calibration(rec, mode="sensitivity", sensitivity_counts_per_g=None)


# ── Calibración: modo 'pga_reference' ───────────────────────────────────────

class TestCalibrationPgaReference:
    def test_pga_reference_normalizes_to_target(self):
        """Después de calibrar por PGA, |values_si - mean|_max debe ser el PGA objetivo."""
        content = _synthetic_mseed_bytes(npts=1000)
        rec = build_record_from_miniseed("x.msd", content, unit=COUNTS_UNIT)
        target = 3.0341  # PGA HNE del reporte MADOS

        result = apply_calibration(rec, mode="pga_reference", pga_reference_ms2=target)

        got = result["channels"][0]["pga_ms2"]
        assert abs(got - target) < 1e-8

    def test_pga_reference_invalid_raises(self):
        content = _synthetic_mseed_bytes(npts=100)
        rec = build_record_from_miniseed("x.msd", content, unit=COUNTS_UNIT)
        with pytest.raises(ValueError, match="pga_reference"):
            apply_calibration(rec, mode="pga_reference", pga_reference_ms2=None)
        with pytest.raises(ValueError, match="pga_reference"):
            apply_calibration(rec, mode="pga_reference", pga_reference_ms2=-1)


# ── Calibración: logging y componente selectivo ─────────────────────────────

class TestCalibrationBookkeeping:
    def test_appends_processing_step(self):
        content = _synthetic_mseed_bytes(npts=100)
        rec = build_record_from_miniseed("x.msd", content, unit=COUNTS_UNIT)
        assert len(rec.processing_log) == 0

        apply_calibration(rec, mode="sensitivity", sensitivity_counts_per_g=500_000)

        assert len(rec.processing_log) == 1
        assert rec.processing_log[0].operation == "calibration"
        assert rec.processing_log[0].params["mode"] == "sensitivity"

    def test_invalid_mode_raises(self):
        content = _synthetic_mseed_bytes(npts=100)
        rec = build_record_from_miniseed("x.msd", content, unit=COUNTS_UNIT)
        with pytest.raises(ValueError, match="mode"):
            apply_calibration(rec, mode="unknown_mode")

    def test_default_sensitivity_gives_physical_pga(self):
        """Sensibilidad default 500 000 counts/g debe dar un PGA físicamente razonable
        para un acelerograma en counts (validación contra dataset MADOS)."""
        # _synthetic_mseed_bytes multiplica por 1e6 → señal con peak ~1e6 counts
        # Con 500 000 counts/g → PGA ~ 2 g ~ 19.6 m/s² (rango razonable de acelerograma)
        content = _synthetic_mseed_bytes(npts=1000)
        rec = build_record_from_miniseed("x.msd", content, unit=COUNTS_UNIT)

        result = apply_calibration(rec, mode="sensitivity", sensitivity_counts_per_g=500_000)

        pga = result["channels"][0]["pga_ms2"]
        # Debe ser físicamente razonable (0.001 g a 10 g); no absurdo como 150 000 m/s²
        assert 0.001 * G_STD < pga < 10.0 * G_STD, \
            f"PGA={pga:.4f} m/s² fuera de rango físico razonable"

    def test_component_filter_no_match(self):
        """Pedir un componente que no existe debe ser un error explícito."""
        content = _synthetic_mseed_bytes(channel="HNE")  # componente EW
        rec = build_record_from_miniseed("x.msd", content, unit=COUNTS_UNIT)
        with pytest.raises(ValueError, match="No se calibró"):
            apply_calibration(
                rec, mode="sensitivity",
                sensitivity_counts_per_g=500_000, component="V",
            )
