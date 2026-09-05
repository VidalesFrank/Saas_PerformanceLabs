"""Análisis en el dominio de la frecuencia.

Implementa FFT y Power Spectral Density (PSD) para señales sísmicas.

Referencias:
  - Clough & Penzien (2003), Dynamics of Structures, Cap. 11.
  - Proakis & Manolakis (2007), Digital Signal Processing, Cap. 8.
"""

from __future__ import annotations

import numpy as np


def compute_fft(signal: np.ndarray, dt: float) -> dict:
    """Calcula la FFT de la señal y retorna el espectro de amplitudes y fases.

    Args:
        signal: señal de entrada (aceleración en m/s² recomendado).
        dt: Δt en segundos.

    Returns:
        dict con:
          freq        : frecuencias en Hz (0 a Nyquist)
          period      : periodos equivalentes en s (1/freq, para freq > 0)
          amplitude   : espectro de amplitudes (|FFT|/N)
          phase       : espectro de fases en radianes
          nyquist_hz  : frecuencia de Nyquist
          dominant_freq_hz : frecuencia dominante
          dominant_period_s: periodo dominante
          n           : número de muestras
    """
    n = len(signal)
    fs = 1.0 / dt
    nyquist = fs / 2.0

    # FFT (solo mitad positiva del espectro — señal real)
    fft_raw = np.fft.rfft(signal)
    freq    = np.fft.rfftfreq(n, d=dt)   # Hz

    # Amplitud normalizada por N (independiente del tamaño de la señal)
    amplitude = np.abs(fft_raw) / n

    # Duplicar amplitudes (excepto DC y Nyquist) para espectro de un lado
    amp_onesided = amplitude.copy()
    amp_onesided[1:-1] *= 2.0

    phase = np.angle(fft_raw)

    # Frecuencia dominante (ignorar DC)
    idx_dom = int(np.argmax(amp_onesided[1:])) + 1
    dominant_freq = float(freq[idx_dom]) if len(freq) > idx_dom else 0.0
    dominant_period = 1.0 / dominant_freq if dominant_freq > 0 else float("inf")

    # Periodos (evitar división por cero en DC)
    with np.errstate(divide="ignore", invalid="ignore"):
        period = np.where(freq > 0, 1.0 / freq, float("inf"))

    return {
        "freq":              freq.tolist(),
        "period":            period.tolist(),
        "amplitude":         amp_onesided.tolist(),
        "phase":             phase.tolist(),
        "nyquist_hz":        float(nyquist),
        "dominant_freq_hz":  dominant_freq,
        "dominant_period_s": dominant_period,
        "n":                 n,
        "fs":                float(fs),
    }


def compute_psd_welch(signal: np.ndarray, dt: float, nperseg: int | None = None) -> dict:
    """Power Spectral Density usando el método de Welch.

    Proporciona estimación suavizada del PSD dividiendo la señal en segmentos
    solapados y promediando los periodogramas.

    Args:
        signal: señal de entrada.
        dt: Δt en segundos.
        nperseg: muestras por segmento. Si None usa min(N//4, 256).

    Returns:
        dict con freq, psd, nyquist_hz, dominant_freq_hz, dominant_period_s.
    """
    try:
        from scipy.signal import welch
    except ImportError as e:
        raise ImportError("scipy es requerido para PSD. pip install scipy") from e

    fs = 1.0 / dt
    n  = len(signal)

    if nperseg is None:
        nperseg = min(n // 4, 256)
        nperseg = max(nperseg, 8)

    freq, psd = welch(signal, fs=fs, nperseg=nperseg)

    idx_dom = int(np.argmax(psd[1:])) + 1 if len(psd) > 1 else 0
    dom_freq   = float(freq[idx_dom]) if len(freq) > idx_dom else 0.0
    dom_period = 1.0 / dom_freq if dom_freq > 0 else float("inf")

    return {
        "freq":              freq.tolist(),
        "psd":               psd.tolist(),
        "nyquist_hz":        float(fs / 2.0),
        "dominant_freq_hz":  dom_freq,
        "dominant_period_s": dom_period,
    }


def smooth_spectrum(amplitude: np.ndarray, window: int = 5) -> np.ndarray:
    """Suavizado del espectro de amplitudes con ventana móvil."""
    kernel = np.ones(window) / window
    return np.convolve(amplitude, kernel, mode="same")
