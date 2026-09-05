"""Tests del motor científico de Ground Motion Analysis.

Valida:
  - Importador: formato columna única (tipo GM01.txt)
  - Integración numérica (velocidad, desplazamiento)
  - Corrección de línea base
  - Filtrado Butterworth
  - FFT: frecuencia dominante en señal sintética
  - Intensidad: PGA, Arias, CAV, D5-95
  - Espectro de respuesta: Newmark-β con caso de referencia

Para ejecutar:
    cd apps/api
    ../../.venv/Scripts/python.exe -m pytest tests/test_ground_motion_engine.py -v
"""

import numpy as np
import pytest

from app.engine.ground_motion.io.detector import detect_structure
from app.engine.ground_motion.io.parser import ColumnMapping, build_record
from app.engine.ground_motion.processing.integration import compute_velocity, compute_displacement, compute_all
from app.engine.ground_motion.processing.baseline import remove_mean, remove_linear_trend, apply_baseline_correction
from app.engine.ground_motion.processing.filtering import butterworth_filter
from app.engine.ground_motion.analysis.intensity import (
    compute_pga, compute_arias_intensity, compute_cav,
    compute_significant_duration, compute_all_intensity_measures,
)
from app.engine.ground_motion.analysis.frequency import compute_fft
from app.engine.ground_motion.analysis.spectra import newmark_sdof, response_spectrum, default_period_array
from app.engine.ground_motion.units import acc_to_ms2, G_STD


# ── Fixtures ──────────────────────────────────────────────────────────────────

def gm01_content(n: int = 3000, dt: float = 0.01) -> bytes:
    """Genera contenido sintético equivalente al formato GM01.txt:
    una columna de aceleración en g, sin tiempo, sin encabezado.
    Los valores se generan para simular un acelerograma típico.
    """
    rng = np.random.default_rng(42)
    t = np.arange(n) * dt
    # Señal tipo acelerograma: componente sinusoidal + ruido + envolvente
    a = (0.4 * np.sin(2 * np.pi * 1.5 * t) * np.exp(-0.1 * t)
         + 0.1 * rng.standard_normal(n) * np.exp(-0.05 * t))
    # Convertir a strings con notación científica (como GM01.txt)
    lines = [f"{v:.6E}" for v in a]
    return "\n".join(lines).encode("utf-8")


def synthetic_sine(freq: float = 2.0, dt: float = 0.01, duration: float = 10.0,
                   amplitude: float = 1.0) -> np.ndarray:
    """Señal sinusoidal pura para validar FFT y espectros."""
    t = np.arange(0, duration, dt)
    return amplitude * np.sin(2 * np.pi * freq * t)


def peer_acc_truth(n: int, dt: float) -> np.ndarray:
    """Señal de referencia (en g) usada por peer_wrapped_content — determinista,
    sin ruido, para poder comparar exactamente contra la reconstrucción."""
    t = np.arange(n) * dt
    return 0.3 * np.exp(-0.15 * t) * np.sin(2 * np.pi * 2.0 * t)


def peer_wrapped_content(n: int = 1000, dt: float = 0.02, vals_per_line: int = 5) -> bytes:
    """Genera contenido en el formato REAL PEER/NGA de ancho fijo (el mismo que
    usan los registros FEMA P-695 y prácticamente todo acelerograma real):
    NPTS/DT en el encabezado, N valores por línea en notación científica de
    ancho fijo (14 caracteres), sin separador entre un valor y el siguiente
    cuando este es negativo — el signo ocupa el espacio que normalmente
    separaría los campos (ej. "...E-02-3.616...E-02"). Esta ausencia de
    espacio es la causa real de por qué los acelerogramas reales rompían el
    importador antes del fix de tokenización en detector.py / parser.py.
    """
    acc = peer_acc_truth(n, dt)
    lines = [
        "PEER STRONG MOTION DATABASE RECORD (SAMPLE)",
        "SAMPLE EARTHQUAKE, SAMPLE STATION",
        "ACCELERATION TIME HISTORY IN UNITS OF G",
        f"NPTS=  {n}, DT= {dt} SEC",
    ]
    for i in range(0, n, vals_per_line):
        chunk = acc[i:i + vals_per_line]
        lines.append("".join(f"{v: 14.7E}" for v in chunk))
    return ("\n".join(lines) + "\n").encode("utf-8")


# ── Tests del importador ──────────────────────────────────────────────────────

class TestDetector:
    def test_gm01_single_column_detection(self):
        """GM01.txt: debe detectar 3000 filas, 1 columna, sin tiempo."""
        content = gm01_content(n=3000)
        result = detect_structure("GM01.txt", content)
        assert result.n_rows == 3000, f"Esperados 3000 rows, obtenidos {result.n_rows}"
        assert result.n_cols == 1,   f"Esperada 1 columna, obtenidas {result.n_cols}"
        assert not result.columns[0].is_monotonic_increasing, \
            "La columna NO debería ser monotónica (es aceleración, no tiempo)"

    def test_two_column_time_acc(self):
        """Dos columnas: tiempo + aceleración → detecta tiempo monotónico."""
        dt = 0.01
        n  = 500
        t_vals = np.arange(n) * dt
        a_vals = synthetic_sine(2.0, dt, n * dt)
        lines = [f"{t_vals[i]:.4f}  {a_vals[i]:.6E}" for i in range(n)]
        content = "\n".join(lines).encode("utf-8")

        result = detect_structure("record_2col.txt", content)
        assert result.n_cols == 2
        assert result.columns[0].is_monotonic_increasing, "Primera columna debe ser monotónica (tiempo)"
        assert not result.columns[1].is_monotonic_increasing, "Segunda columna debe ser oscilante (acc)"

    def test_header_metadata_extraction(self):
        """Debe extraer NPTS y DT del encabezado del archivo."""
        header = "NPTS=500, DT=0.01 SEC\n"
        data_lines = "\n".join([f"{np.sin(i * 0.1):.6E}" for i in range(500)])
        content = (header + data_lines).encode("utf-8")

        result = detect_structure("with_header.txt", content)
        assert "npts" in result.header_metadata, "Debe extraer NPTS del encabezado"
        assert result.header_metadata["npts"] == 500
        assert "dt" in result.header_metadata
        assert abs(result.header_metadata["dt"] - 0.01) < 1e-10

    def test_no_silent_dt_assumption(self):
        """GM01.txt: no debe tener dt en header_metadata (no lo inventa)."""
        content = gm01_content(n=100)
        result = detect_structure("GM01.txt", content)
        # Sin encabezado → no hay dt sugerido por metadata
        # (el dt solo viene de columna de tiempo o lo da el usuario)
        assert "dt" not in result.header_metadata or result.header_metadata.get("dt") is None, \
            "No debe asumir Δt de una señal sin metadata"


class TestPeerWrappedFormat:
    """Formato real PEER/NGA: NPTS valores de una sola serie continua
    repartidos en varias columnas por línea, ancho fijo, con números negativos
    pegados al valor anterior (sin espacio). Es el formato estándar de facto
    de acelerogramas reales — incluye los 44 registros FEMA P-695 usados en
    el Módulo 3 (apps/api/data/records/fema_records/*.txt)."""

    def test_detects_wrapped_series_hint(self):
        content = peer_wrapped_content(n=1000, dt=0.02, vals_per_line=5)
        result = detect_structure("peer_sample.txt", content)
        assert result.wrapped_series_hint is True
        assert result.n_cols == 5

    def test_glued_negative_numbers_dont_break_row_count(self):
        """Antes del fix, un valor negativo pegado al anterior (sin espacio de
        separación) fusionaba ambos en un solo token inválido y descuadraba
        filas/columnas — perdiendo silenciosamente la mayoría de los datos."""
        content = peer_wrapped_content(n=1000, dt=0.02, vals_per_line=5)
        result = detect_structure("peer_sample.txt", content)
        assert result.n_rows * result.n_cols == 1000, (
            f"{result.n_rows} filas x {result.n_cols} columnas debería dar 1000 muestras"
        )
        assert not any("inconsistente" in w for w in result.warnings)

    def test_flatten_reconstructs_exact_series(self):
        """build_record(flatten=True) debe reconstruir exactamente la serie
        continua original, no 5 canales paralelos sub-muestreados."""
        dt, n = 0.02, 1000
        content = peer_wrapped_content(n=n, dt=dt, vals_per_line=5)
        result = detect_structure("peer_sample.txt", content)

        mappings = [
            ColumnMapping(col_index=i, quantity="acceleration", unit="g")
            for i in range(result.n_cols)
        ]
        record = build_record(
            "peer_sample.txt", content, mappings, dt=None, flatten=True,
        )

        assert record.n_samples == n
        assert abs(record.dt - dt) < 1e-12

        acc_truth_ms2 = peer_acc_truth(n, dt) * G_STD
        ch = record.get_acceleration_channel()
        assert ch is not None
        np.testing.assert_allclose(ch.values_si, acc_truth_ms2, atol=1e-5,
            err_msg="La serie envuelta reconstruida debe coincidir con la señal original")

    def test_flatten_requires_matching_quantities(self):
        content = peer_wrapped_content(n=1000, dt=0.02, vals_per_line=5)
        mappings = [ColumnMapping(col_index=0, quantity="acceleration", unit="g")] + [
            ColumnMapping(col_index=i, quantity="velocity", unit="cm/s") for i in range(1, 5)
        ]
        with pytest.raises(ValueError):
            build_record("peer_sample.txt", content, mappings, dt=0.02, flatten=True)

    def test_flatten_rejects_time_column(self):
        content = peer_wrapped_content(n=1000, dt=0.02, vals_per_line=5)
        mappings = [ColumnMapping(col_index=0, quantity="time", unit="s")] + [
            ColumnMapping(col_index=i, quantity="acceleration", unit="g") for i in range(1, 5)
        ]
        with pytest.raises(ValueError):
            build_record("peer_sample.txt", content, mappings, dt=None, flatten=True)


class TestParser:
    def test_gm01_build_record(self):
        """GM01.txt: debe construir un record con 3000 muestras después de dar Δt y unidades."""
        content = gm01_content(n=3000, dt=0.01)
        mappings = [ColumnMapping(col_index=0, quantity="acceleration", unit="g")]

        record = build_record(
            filename="GM01.txt",
            content=content,
            column_mappings=mappings,
            dt=0.01,
            record_name="GM01",
        )

        assert record.n_samples == 3000, f"Esperadas 3000 muestras, obtenidas {record.n_samples}"
        assert abs(record.dt - 0.01) < 1e-10,  f"Δt esperado 0.01, obtenido {record.dt}"
        assert abs(record.duration - 29.99) < 1e-6, \
            f"Duration = (N-1)*dt = 29.99 s, obtenido {record.duration}"
        assert abs(record.fs - 100.0) < 1e-6,     f"fs = 100 Hz, obtenido {record.fs}"
        assert abs(record.nyquist - 50.0) < 1e-6, f"Nyquist = 50 Hz, obtenido {record.nyquist}"

    def test_raw_values_immutable(self):
        """Los raw_values deben ser los datos originales sin convertir."""
        # Aceleración en g con valores conocidos
        lines = ["0.4", "0.2", "-0.3"]
        content = "\n".join(lines).encode("utf-8")
        mappings = [ColumnMapping(col_index=0, quantity="acceleration", unit="g")]

        record = build_record("test.txt", content, mappings, dt=0.01)

        acc_ch = record.get_acceleration_channel()
        assert acc_ch is not None

        # raw_values deben ser los valores en g (sin convertir)
        np.testing.assert_allclose(acc_ch.raw_values, [0.4, 0.2, -0.3], rtol=1e-6,
                                   err_msg="raw_values debe contener los datos originales en g")

        # values_si deben estar en m/s²
        expected_si = np.array([0.4, 0.2, -0.3]) * G_STD
        np.testing.assert_allclose(acc_ch.values_si, expected_si, rtol=1e-6,
                                   err_msg="values_si debe estar en m/s²")

    def test_pga_correct(self):
        """PGA debe coincidir exactamente con el máximo valor absoluto."""
        content = gm01_content(n=3000, dt=0.01)
        mappings = [ColumnMapping(col_index=0, quantity="acceleration", unit="g")]
        record = build_record("GM01.txt", content, mappings, dt=0.01)

        acc_ch = record.get_acceleration_channel()
        a = acc_ch.values_si
        pga = compute_pga(a)

        assert abs(pga - np.max(np.abs(a))) < 1e-12, \
            "PGA debe coincidir exactamente con max|a(t)|"

    def test_no_dt_raises_error(self):
        """Sin columna de tiempo y sin dt → debe lanzar ValueError."""
        content = gm01_content(n=100)
        mappings = [ColumnMapping(col_index=0, quantity="acceleration", unit="g")]

        with pytest.raises(ValueError, match="Δt"):
            build_record("GM01.txt", content, mappings, dt=None)

    def test_time_vector_starts_at_zero(self):
        """El vector de tiempo debe iniciar en t=0."""
        content = gm01_content(n=100, dt=0.005)
        mappings = [ColumnMapping(col_index=0, quantity="acceleration", unit="g")]
        record = build_record("GM01.txt", content, mappings, dt=0.005)

        assert abs(record.time[0]) < 1e-12, "t[0] debe ser 0"
        assert abs(record.time[-1] - 99 * 0.005) < 1e-10, \
            f"t[N-1] debe ser (N-1)*dt = {99 * 0.005}, obtenido {record.time[-1]}"


# ── Tests de integración numérica ────────────────────────────────────────────

class TestIntegration:
    def test_velocity_from_constant_acc(self):
        """Integrar aceleración constante debe dar velocidad lineal: v = a*t."""
        dt = 0.01
        n  = 1000
        a  = np.ones(n) * 2.0  # 2 m/s² constante
        v  = compute_velocity(a, dt)

        # v[i] ≈ a*i*dt (trapezoidal, con error O(dt²) en los extremos)
        expected = np.arange(n) * dt * 2.0
        # La diferencia debe ser pequeña (error de un paso en el trapecio)
        np.testing.assert_allclose(v[1:], expected[1:], rtol=1e-3,
                                   err_msg="Integral trapezoidal de acc. constante debe dar v=a·t")

    def test_displacement_from_constant_acc(self):
        """Integrar dos veces aceleración constante: d = 0.5*a*t²."""
        dt = 0.005
        n  = 2000
        a  = np.ones(n) * 1.0  # 1 m/s²
        v  = compute_velocity(a, dt)
        d  = compute_displacement(v, dt)

        t = np.arange(n) * dt
        expected = 0.5 * t ** 2
        # Tolerancia del 1% en el rango de valores
        np.testing.assert_allclose(d[10:], expected[10:], rtol=0.01,
                                   err_msg="Doble integración: d ≈ 0.5·a·t²")

    def test_pga_invariant_after_integration(self):
        """La aceleración original no debe ser modificada durante la integración."""
        a_original = np.array([1.0, -2.0, 3.0, -4.0, 5.0])
        a_copy = a_original.copy()
        _ = compute_all(a_original, 0.01)
        np.testing.assert_array_equal(a_original, a_copy,
                                      err_msg="La aceleración no debe ser modificada al integrar")


# ── Tests de corrección de línea base ───────────────────────────────────────

class TestBaseline:
    def test_remove_mean(self):
        """Después de remove_mean, la media debe ser ~0."""
        a = np.random.default_rng(7).standard_normal(1000) + 0.5  # offset de 0.5
        corrected = remove_mean(a)
        assert abs(np.mean(corrected)) < 1e-10, "Media después de corrección debe ser ~0"

    def test_remove_linear_trend(self):
        """Señal con tendencia lineal → después de corrección, tendencia residual ~0."""
        t = np.linspace(0, 10, 1000)
        trend = 0.05 * t + 2.0
        signal = 0.1 * np.sin(2 * np.pi * 1.0 * t) + trend
        corrected = remove_linear_trend(signal)

        # Ajustar tendencia residual
        coeffs = np.polyfit(np.arange(len(corrected)), corrected, 1)
        assert abs(coeffs[0]) < 1e-6, f"Pendiente residual debe ser ~0, obtenida {coeffs[0]}"

    def test_original_not_modified(self):
        """La señal original no debe modificarse."""
        a = np.ones(100) * 3.0
        a_copy = a.copy()
        _ = apply_baseline_correction(a, "mean")
        np.testing.assert_array_equal(a, a_copy, err_msg="Original no debe modificarse")


# ── Tests de filtrado ─────────────────────────────────────────────────────────

class TestFiltering:
    def test_lowpass_removes_high_freq(self):
        """Filtro lowpass a 5 Hz debe atenuar componente de 20 Hz."""
        fs = 200.0
        dt = 1.0 / fs
        t  = np.arange(0, 5.0, dt)
        # Señal: 2 Hz (pasa) + 20 Hz (bloqueada)
        signal = np.sin(2 * np.pi * 2.0 * t) + np.sin(2 * np.pi * 20.0 * t)

        filtered = butterworth_filter(signal, fs, "lowpass", fc_high=5.0, order=4)

        # Verificar que la componente de 20 Hz está muy atenuada
        # Obtener amplitud de 20 Hz en la señal filtrada
        fft_filt = np.fft.rfft(filtered)
        freq     = np.fft.rfftfreq(len(filtered), d=dt)
        idx_20hz = np.argmin(np.abs(freq - 20.0))
        amp_20hz = np.abs(fft_filt[idx_20hz]) / len(filtered)

        assert amp_20hz < 0.1, f"20 Hz debe estar muy atenuado, amplitud: {amp_20hz:.4f}"

    def test_nyquist_rejection(self):
        """Filtro con fc > Nyquist debe lanzar ValueError."""
        signal = np.ones(1000)
        with pytest.raises(ValueError, match="Nyquist"):
            butterworth_filter(signal, fs=100.0, filter_type="lowpass", fc_high=60.0)

    def test_original_not_modified(self):
        """El filtro no debe modificar la señal original."""
        fs  = 100.0
        sig = np.sin(2 * np.pi * 2.0 * np.arange(1000) / fs)
        sig_copy = sig.copy()
        _ = butterworth_filter(sig, fs, "lowpass", fc_high=5.0)
        np.testing.assert_array_equal(sig, sig_copy)


# ── Tests de intensidad sísmica ───────────────────────────────────────────────

class TestIntensityMeasures:
    def test_pga_exact(self):
        """PGA debe ser exactamente el máximo absoluto de la señal."""
        a = np.array([0.1, -0.5, 0.3, -0.2, 0.4])
        assert compute_pga(a) == pytest.approx(0.5, abs=1e-12)

    def test_arias_intensity_unit(self):
        """Ia de señal sinusoidal conocida: verificar orden de magnitud."""
        dt = 0.005
        duration = 20.0
        t = np.arange(0, duration, dt)
        a = 0.1 * G_STD * np.sin(2 * np.pi * 1.0 * t)  # 0.1g a 1 Hz
        ia = compute_arias_intensity(a, dt)
        # Ia ≈ (π/2g) × (0.1g)² × duration/2 ≈ (π/2) × 0.01 × g × 10 ≈ 0.154 m/s
        expected_approx = (np.pi / 2.0) * (0.1 * G_STD) ** 2 * duration / 2.0 / G_STD
        # Solo verificar orden de magnitud (±50%)
        assert 0.5 * expected_approx < ia < 2.0 * expected_approx, \
            f"Arias: {ia:.4f}, esperado ~{expected_approx:.4f}"

    def test_cav_positive(self):
        """CAV debe ser siempre ≥ 0."""
        a = synthetic_sine(2.0, 0.01, 10.0)
        assert compute_cav(a, 0.01) > 0

    def test_d595_bounds(self):
        """D5-95 debe estar dentro de la duración total del registro."""
        dt = 0.01
        a  = synthetic_sine(2.0, dt, 20.0)
        result = compute_significant_duration(a, dt, 5.0, 95.0)
        duration_total = (len(a) - 1) * dt

        assert result["t_start"] >= 0
        assert result["t_end"]   <= duration_total + dt
        assert result["duration"] > 0

    def test_d595_less_than_d595_full(self):
        """D5-75 debe ser menor que D5-95."""
        dt  = 0.01
        a   = synthetic_sine(1.5, dt, 30.0)
        d75 = compute_significant_duration(a, dt, 5.0, 75.0)
        d95 = compute_significant_duration(a, dt, 5.0, 95.0)
        assert d75["duration"] <= d95["duration"] + 1e-6, \
            "D5-75 debe ser <= D5-95"


# ── Tests de FFT ──────────────────────────────────────────────────────────────

class TestFFT:
    def test_dominant_frequency_sine(self):
        """FFT de señal sinusoidal pura → frecuencia dominante = freq de la señal."""
        target_freq = 3.5  # Hz
        dt = 0.005
        signal = synthetic_sine(freq=target_freq, dt=dt, duration=20.0)

        result = compute_fft(signal, dt)
        dom_freq = result["dominant_freq_hz"]

        assert abs(dom_freq - target_freq) < 0.5, \
            f"Frecuencia dominante: {dom_freq:.2f} Hz, esperada {target_freq} Hz"

    def test_nyquist_in_result(self):
        """El resultado debe incluir la frecuencia de Nyquist."""
        dt = 0.01
        signal = np.random.randn(1000)
        result = compute_fft(signal, dt)
        expected_nyquist = 1.0 / (2 * dt)
        assert abs(result["nyquist_hz"] - expected_nyquist) < 1e-6


# ── Tests del espectro de respuesta (Newmark-β) ─────────────────────────────

class TestResponseSpectrum:
    def test_newmark_undamped_harmonic(self):
        """SDOF sin amortiguamiento bajo carga armónica: verificar respuesta en resonancia.

        Para excitación armónica ag = A·sin(ω_n·t) y ξ=0, la amplitud de respuesta
        crece linealmente (resonancia). Verificamos que el desplazamiento sea grande
        comparado con el cuasiestático (DAF >> 1 cerca de resonancia).
        """
        dt   = 0.005
        T_n  = 1.0   # s → ω_n = 2π rad/s
        xi   = 0.001  # casi sin amortiguamiento
        freq = 1.0 / T_n  # excitación en resonancia
        t    = np.arange(0, 20.0, dt)
        ag   = 0.1 * G_STD * np.sin(2 * np.pi * freq * t)

        u, v, _, _ = newmark_sdof(ag, dt, T_n, xi)

        # En resonancia con ξ≈0, el desplazamiento crece: u_max >> ag_max/ω²
        omega_n = 2 * np.pi / T_n
        u_static = 0.1 * G_STD / omega_n ** 2  # cuasiestático: u_st = F₀/k = F₀/ω²
        u_max = np.max(np.abs(u))
        daf = u_max / u_static

        assert daf > 5.0, f"DAF en resonancia con ξ≈0 debe ser >> 1, obtenido {daf:.1f}"

    def test_pga_at_rigid_limit(self):
        """Para T→0 (estructura muy rígida), Sa ≈ PGA de la excitación."""
        dt  = 0.005
        t   = np.arange(0, 10.0, dt)
        ag  = 0.3 * G_STD * np.sin(2 * np.pi * 2.0 * t) * np.exp(-0.1 * t)
        pga = float(np.max(np.abs(ag)))

        # Período muy corto
        T_arr = np.array([0.01])
        spec  = response_spectrum(ag, dt, T_arr, xi=0.05)
        sa_rigid = spec["Sa"][0]

        # Sa(T→0) ≈ PGA (para T muy corto)
        assert abs(sa_rigid - pga) / pga < 0.15, \
            f"Sa(T=0.01) ≈ PGA. PGA={pga:.3f}, Sa={sa_rigid:.3f}"

    def test_scaling_factor_psa(self):
        """Si se escala ag × 2, todos los espectros deben escalar × 2."""
        dt  = 0.005
        t   = np.arange(0, 15.0, dt)
        ag  = 0.2 * G_STD * np.sin(2 * np.pi * 1.0 * t) * np.exp(-0.05 * t)
        T_arr = default_period_array(0.1, 3.0, 30)

        spec1 = response_spectrum(ag,       dt, T_arr, xi=0.05)
        spec2 = response_spectrum(ag * 2.0, dt, T_arr, xi=0.05)

        sa1 = np.array(spec1["PSA"])
        sa2 = np.array(spec2["PSA"])

        np.testing.assert_allclose(sa2, sa1 * 2.0, rtol=1e-8,
                                   err_msg="SF=2 → todos los espectros deben escalar ×2")

    def test_psa_psv_psd_consistency(self):
        """PSA = ω²·Sd y PSV = ω·Sd para cada periodo (consistencia algebraica)."""
        dt  = 0.005
        t   = np.arange(0, 20.0, dt)
        ag  = 0.3 * G_STD * np.sin(2 * np.pi * 1.5 * t) * np.exp(-0.05 * t)
        T_arr = default_period_array(0.1, 3.0, 20)

        spec = response_spectrum(ag, dt, T_arr, xi=0.05)

        Sd  = np.array(spec["Sd"])
        PSV = np.array(spec["PSV"])
        PSA = np.array(spec["PSA"])

        for i, T in enumerate(T_arr):
            omega = 2 * np.pi / T
            assert abs(PSV[i] - omega * Sd[i]) < 1e-10, \
                f"PSV[{i}] = ω·Sd[{i}]: {PSV[i]:.6f} vs {omega * Sd[i]:.6f}"
            assert abs(PSA[i] - omega**2 * Sd[i]) < 1e-8, \
                f"PSA[{i}] = ω²·Sd[{i}]: {PSA[i]:.6f} vs {omega**2 * Sd[i]:.6f}"


# ── Tests de unidades ─────────────────────────────────────────────────────────

class TestUnits:
    def test_g_to_ms2(self):
        """1 g debe convertirse a 9.80665 m/s²."""
        a_g  = np.array([1.0])
        a_si = acc_to_ms2(a_g, "g")
        assert abs(a_si[0] - G_STD) < 1e-10

    def test_gal_to_ms2(self):
        """1 Gal = 0.01 m/s²."""
        a_gal = np.array([1.0])
        a_si  = acc_to_ms2(a_gal, "Gal")
        assert abs(a_si[0] - 0.01) < 1e-12

    def test_cms2_to_ms2(self):
        """100 cm/s² = 1 m/s²."""
        a_cms2 = np.array([100.0])
        a_si   = acc_to_ms2(a_cms2, "cm/s²")
        assert abs(a_si[0] - 1.0) < 1e-12

    def test_unknown_unit_raises(self):
        """Unidad desconocida debe lanzar ValueError."""
        with pytest.raises(ValueError, match="no reconocida"):
            acc_to_ms2(np.array([1.0]), "parsec/s²")


# ── Tests de espectros inelásticos (EPP ductilidad constante) ─────────────────

from app.engine.ground_motion.analysis.inelastic_spectra import (
    epp_sdof,
    constant_ductility_spectrum,
    inelastic_spectrum_multi_mu,
)


def _synthetic_accel(dt: float = 0.005, duration: float = 20.0) -> np.ndarray:
    """Acelerograma sintético realista (no puramente sinusoidal)."""
    rng = np.random.default_rng(17)
    t   = np.arange(0, duration, dt)
    ag  = (
        0.3 * G_STD * np.sin(2 * np.pi * 1.2 * t) * np.exp(-0.15 * t)
        + 0.15 * G_STD * np.sin(2 * np.pi * 2.5 * t) * np.exp(-0.20 * t)
        + 0.05 * G_STD * rng.standard_normal(len(t)) * np.exp(-0.10 * t)
    )
    return ag


class TestInelasticSpectra:

    def test_mu1_equals_elastic(self):
        """μ=1 → Sa_inel debe ser ≈ PSA_elastic (sin iteración).

        Para ductilidad objetivo = 1 la función retorna el resultado elástico
        directamente: Sa_inel = PSA_elastic y R = 1.0 en todos los periodos.
        """
        ag  = _synthetic_accel()
        dt  = 0.005
        T_array = default_period_array(0.05, 3.0, 40)

        result = constant_ductility_spectrum(ag, dt, T_array, xi=0.05, mu_target=1.0)

        sa_inel    = np.array(result["Sa_inel"])
        sa_elastic = np.array(result["Sa_elastic"])
        r_vals     = np.array(result["R_mu_T"])

        np.testing.assert_allclose(
            sa_inel, sa_elastic, rtol=1e-8,
            err_msg="Para mu=1, Sa_inel debe ser identico a PSA_elastic."
        )
        np.testing.assert_allclose(
            r_vals, np.ones(len(T_array)), rtol=1e-8,
            err_msg="Para mu=1, R debe ser 1.0 en todos los periodos."
        )

    def test_higher_mu_lower_sa(self):
        """Mayor ductilidad → menor Sa inelástica para el mismo T.

        Propiedad fundamental del espectro de ductilidad constante:
        Sa_inel(μ=4) ≤ Sa_inel(μ=2) ≤ Sa_inel(μ=1) = PSA_elastic.
        Se verifica que la relación se cumple en la mayoría de periodos.
        """
        ag  = _synthetic_accel()
        dt  = 0.005
        T_array = default_period_array(0.1, 2.0, 25)

        res_mu2 = constant_ductility_spectrum(ag, dt, T_array, xi=0.05, mu_target=2.0)
        res_mu4 = constant_ductility_spectrum(ag, dt, T_array, xi=0.05, mu_target=4.0)

        sa2 = np.array(res_mu2["Sa_inel"])
        sa4 = np.array(res_mu4["Sa_inel"])

        # Sa con μ=4 debe ser <= Sa con μ=2 en la mayoría de los periodos
        fraction_ok = np.mean(sa4 <= sa2 * 1.05)  # 5% tolerancia numérica
        assert fraction_ok >= 0.85, (
            "Sa(mu=4) debe ser <= Sa(mu=2) en al menos el 85%% de los periodos "
            "({:.0f}%% cumple).".format(fraction_ok * 100)
        )

    def test_r_factor_positive(self):
        """R = PSA_elastic / Sa_inel debe ser >= 1 para mu >= 1.

        Un mayor nivel de ductilidad permite reducir la demanda elástica:
        R >= 1 siempre (no puede amplificarse la demanda respecto al elástico).
        """
        ag  = _synthetic_accel()
        dt  = 0.005
        T_array = default_period_array(0.1, 3.0, 30)

        for mu in [1.5, 2.0, 3.0, 6.0]:
            res = constant_ductility_spectrum(ag, dt, T_array, xi=0.05, mu_target=mu)
            r_vals = np.array(res["R_mu_T"])

            # Tolerancia numérica pequeña para casos donde PSA_el ≈ 0
            r_below_1 = r_vals[r_vals < 0.98]
            assert len(r_below_1) == 0, (
                "R = PSA_el/Sa_inel debe ser >= 1 para mu={} "
                "(valores fuera de rango: {}).".format(mu, r_below_1)
            )

    def test_epp_preserves_ductility(self):
        """La ductilidad alcanzada debe estar dentro de la tolerancia del objetivo.

        constant_ductility_spectrum usa bisección con tol=0.05 (5%). La ductilidad
        alcanzada en la convergencia debe estar dentro de ±10% del objetivo (margen
        generoso para el test).
        """
        ag  = _synthetic_accel()
        dt  = 0.005
        # Periodos intermedios donde la bisección es más exigente
        T_array = default_period_array(0.2, 2.0, 20)

        for mu_target in [2.0, 4.0]:
            res = constant_ductility_spectrum(
                ag, dt, T_array, xi=0.05, mu_target=mu_target, tol=0.05
            )
            mu_ach = np.array(res["mu_achieved"])

            # Periodos donde Sa_elastic es significativa (excluir periodos casi nulos)
            sa_el = np.array(res["Sa_elastic"])
            mask = sa_el > 0.01 * float(np.max(sa_el))

            if np.sum(mask) == 0:
                continue

            rel_err = np.abs(mu_ach[mask] - mu_target) / mu_target
            fraction_ok = np.mean(rel_err <= 0.10)  # 10% tolerancia en test

            assert fraction_ok >= 0.80, (
                "Para mu_target={}, al menos el 80%% de los periodos debe converger "
                "dentro del 10%% de tolerancia ({:.0f}%% cumple).".format(
                    mu_target, fraction_ok * 100
                )
            )

    def test_epp_sdof_no_plasticity_under_elastic(self):
        """EPP sin fluencia: fy_norm muy alta → comportamiento idéntico al elástico."""
        dt   = 0.005
        T    = 1.0
        xi   = 0.05
        ag   = _synthetic_accel(dt=dt)

        from app.engine.ground_motion.analysis.spectra import newmark_sdof
        u_el, _, _, _ = newmark_sdof(ag, dt, T, xi)

        # fy_norm = 100 · PSA_elastic → oscilador nunca plastifica
        omega  = 2.0 * np.pi / T
        psa_el = omega ** 2 * float(np.max(np.abs(u_el)))
        u_ep, _, _, _, _ = epp_sdof(ag, dt, T, xi, fy_norm=100.0 * psa_el)

        np.testing.assert_allclose(
            u_ep, u_el, rtol=1e-6,
            err_msg="EPP con fy >> PSA_el debe coincidir con la respuesta elastica."
        )

    def test_inelastic_spectrum_multi_mu_structure(self):
        """inelastic_spectrum_multi_mu retorna la estructura de dict esperada."""
        ag      = _synthetic_accel()
        dt      = 0.005
        T_array = default_period_array(0.1, 2.0, 15)
        mu_list = [1.0, 2.0, 4.0]

        out = inelastic_spectrum_multi_mu(ag, dt, T_array, xi=0.05, mu_list=mu_list)

        assert "T" in out and len(out["T"]) == len(T_array)
        assert "Sa_elastic" in out and len(out["Sa_elastic"]) == len(T_array)
        assert "spectra" in out
        assert "xi" in out and "mu_list" in out

        for mu in mu_list:
            key = str(float(mu))
            assert key in out["spectra"], "Falta la clave '{}' en spectra.".format(key)
            sp = out["spectra"][key]
            assert "Sa_inel" in sp and len(sp["Sa_inel"]) == len(T_array)
            assert "Sd_inel" in sp and len(sp["Sd_inel"]) == len(T_array)
            assert "R"       in sp and len(sp["R"])       == len(T_array)
