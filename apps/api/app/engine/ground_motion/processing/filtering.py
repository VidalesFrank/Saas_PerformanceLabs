"""Filtrado digital de señales sísmicas.

Implementa filtros Butterworth de fase cero usando scipy.signal.
El filtrado de fase cero (sosfiltfilt) evita distorsiones temporales
aplicando el filtro hacia adelante y hacia atrás.

Referencia:
  - Boore & Bommer (2005), Processing of Strong-Motion Accelerograms.
  - Proakis & Manolakis (2007), Digital Signal Processing, Cap. 7.
"""

from __future__ import annotations

import numpy as np


# ── Tipos de filtro ───────────────────────────────────────────────────────────

FILTER_TYPES = ("lowpass", "highpass", "bandpass", "bandstop")


def _validate_nyquist(
    fs: float,
    fc_low: float | None,
    fc_high: float | None,
    filter_type: str,
) -> None:
    """Verifica que las frecuencias de corte sean válidas respecto a Nyquist."""
    nyquist = fs / 2.0

    def _check_freq(fc: float, label: str) -> None:
        if fc <= 0:
            raise ValueError(f"Frecuencia de corte {label} debe ser > 0. Recibido: {fc}")
        if fc >= nyquist:
            raise ValueError(
                f"Frecuencia de corte {label} ({fc:.4f} Hz) debe ser menor que la "
                f"frecuencia de Nyquist ({nyquist:.4f} Hz = fs/2 = {fs:.4f}/2). "
                f"Reduce la frecuencia de corte o usa un registro con mayor fs."
            )

    ftype = filter_type.lower()
    if ftype in ("lowpass", "bandpass", "bandstop"):
        if fc_high is None:
            if ftype != "lowpass":
                raise ValueError(f"El filtro {ftype} requiere fc_high.")
        else:
            _check_freq(fc_high, "fc_high")

    if ftype in ("highpass", "bandpass", "bandstop"):
        if fc_low is None:
            raise ValueError(f"El filtro {ftype} requiere fc_low.")
        else:
            _check_freq(fc_low, "fc_low")

    if ftype in ("bandpass", "bandstop") and fc_low is not None and fc_high is not None:
        if fc_low >= fc_high:
            raise ValueError(
                f"Para filtro {ftype}: fc_low ({fc_low:.4f}) debe ser < fc_high ({fc_high:.4f})."
            )


def butterworth_filter(
    signal: np.ndarray,
    fs: float,
    filter_type: str,
    fc_low: float | None = None,
    fc_high: float | None = None,
    order: int = 4,
) -> np.ndarray:
    """Aplica filtro Butterworth de fase cero a la señal.

    Usa scipy.signal.sosfiltfilt para filtrado de fase cero, que evita
    distorsiones en la fase temporal del registro sísmico.

    Args:
        signal: señal de entrada (no se modifica).
        fs: frecuencia de muestreo en Hz.
        filter_type: 'lowpass' | 'highpass' | 'bandpass' | 'bandstop'
        fc_low: frecuencia de corte inferior en Hz (para highpass/bandpass/bandstop).
        fc_high: frecuencia de corte superior en Hz (para lowpass/bandpass/bandstop).
        order: orden del filtro Butterworth (1–10). Orden efectivo es 2×order
               por el filtrado de fase cero (filtfilt).

    Returns:
        Señal filtrada (nueva copia).

    Raises:
        ValueError: si las frecuencias de corte son inválidas.
        ImportError: si scipy no está disponible.
    """
    try:
        from scipy.signal import butter, sosfiltfilt
    except ImportError as e:
        raise ImportError("scipy es requerido para el filtrado. Instala con: pip install scipy") from e

    _validate_nyquist(fs, fc_low, fc_high, filter_type)

    ftype = filter_type.lower()
    nyquist = fs / 2.0

    # Frecuencias normalizadas (0–1, donde 1 = Nyquist)
    if ftype == "lowpass":
        Wn = fc_high / nyquist
    elif ftype == "highpass":
        Wn = fc_low / nyquist
    elif ftype in ("bandpass", "bandstop"):
        Wn = [fc_low / nyquist, fc_high / nyquist]
    else:
        raise ValueError(f"Tipo de filtro no reconocido: '{filter_type}'. "
                         f"Opciones: {FILTER_TYPES}")

    sos = butter(order, Wn, btype=ftype, analog=False, output="sos")
    return sosfiltfilt(sos, signal).copy()


def filter_report(
    original: np.ndarray,
    filtered: np.ndarray,
    fs: float,
) -> dict:
    """Genera un informe comparativo entre señal original y filtrada."""
    from ..analysis.intensity import compute_pga

    return {
        "pga_original_ms2":  compute_pga(original),
        "pga_filtered_ms2":  compute_pga(filtered),
        "rms_original":      float(np.sqrt(np.mean(original ** 2))),
        "rms_filtered":      float(np.sqrt(np.mean(filtered ** 2))),
        "nyquist_hz":        fs / 2.0,
    }
