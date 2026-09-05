"""Corrección de línea base para señales sísmicas.

Implementa varios métodos de corrección. Ninguno modifica los datos originales;
siempre retorna una nueva copia corregida.

Referencias:
  - Boore & Bommer (2005), Processing of Strong-Motion Accelerograms.
  - Chopra (2012), Dynamics of Structures.
"""

from __future__ import annotations

import numpy as np


# ── Métodos individuales ──────────────────────────────────────────────────────

def remove_mean(signal: np.ndarray) -> np.ndarray:
    """Elimina el valor medio de la señal.

    a_corr(t) = a(t) - mean(a)

    Es la corrección más sencilla. Apropiada cuando el offset es constante.
    """
    return signal - np.mean(signal)


def remove_linear_trend(signal: np.ndarray) -> np.ndarray:
    """Elimina una tendencia lineal ajustada por mínimos cuadrados.

    Ajusta a(t) = A + B*t y resta el ajuste:
        a_corr(t) = a(t) - (A + B*t)

    Es equivalente a usar numpy.polynomial.polynomial.polyfit de grado 1.
    """
    n = len(signal)
    t = np.arange(n, dtype=float)
    # Ajuste lineal: coeffs[0] = B (pendiente), coeffs[1] = A (intercepto)
    coeffs = np.polyfit(t, signal, 1)
    trend = np.polyval(coeffs, t)
    return signal - trend


def remove_polynomial_trend(signal: np.ndarray, order: int = 2) -> np.ndarray:
    """Elimina una tendencia polinómica de grado `order`.

    Ajusta p(t) = a_0 + a_1*t + ... + a_n*t^n por mínimos cuadrados
    y resta el ajuste de la señal.

    Args:
        signal: señal de entrada.
        order: grado del polinomio (1=lineal, 2=cuadrático, 3=cúbico, ...).
    """
    n = len(signal)
    t = np.arange(n, dtype=float)
    coeffs = np.polyfit(t, signal, order)
    trend = np.polyval(coeffs, t)
    return signal - trend


def zero_pad_endpoints(signal: np.ndarray, n_pad: int = 50) -> np.ndarray:
    """Rellena con ceros los extremos para reducir efectos de borde al filtrar."""
    return np.pad(signal, n_pad, mode="constant", constant_values=0.0)


# ── Función unificada ─────────────────────────────────────────────────────────

def apply_baseline_correction(
    signal: np.ndarray,
    method: str,
    order: int = 2,
) -> np.ndarray:
    """Aplica corrección de línea base a la señal.

    Args:
        signal: señal de entrada (no se modifica).
        method: método de corrección:
            'mean'          — eliminar valor medio
            'linear'        — eliminar tendencia lineal
            'polynomial'    — eliminar tendencia polinómica (usar `order`)
        order: grado del polinomio (solo para method='polynomial').

    Returns:
        Nueva señal corregida.
    """
    methods = {
        "mean":       lambda s: remove_mean(s),
        "linear":     lambda s: remove_linear_trend(s),
        "polynomial": lambda s: remove_polynomial_trend(s, order),
    }
    fn = methods.get(method.lower())
    if fn is None:
        raise ValueError(
            f"Método de corrección desconocido: '{method}'. "
            f"Opciones: {list(methods.keys())}"
        )
    return fn(signal.copy())


def baseline_correction_report(
    original: np.ndarray,
    corrected: np.ndarray,
    dt: float,
) -> dict:
    """Genera un informe comparativo entre señal original y corregida."""
    from ..analysis.intensity import compute_pga
    from ..processing.integration import compute_all

    v_orig,  d_orig  = compute_all(original,  dt)
    v_corr,  d_corr  = compute_all(corrected, dt)

    return {
        "pga_original_ms2":   compute_pga(original),
        "pga_corrected_ms2":  compute_pga(corrected),
        "pgv_original_ms":    float(np.max(np.abs(v_orig))),
        "pgv_corrected_ms":   float(np.max(np.abs(v_corr))),
        "pgd_original_m":     float(np.max(np.abs(d_orig))),
        "pgd_corrected_m":    float(np.max(np.abs(d_corr))),
        "mean_original":      float(np.mean(original)),
        "mean_corrected":     float(np.mean(corrected)),
        "residual_velocity_original": float(v_orig[-1]),
        "residual_velocity_corrected": float(v_corr[-1]),
        "residual_displacement_original": float(d_orig[-1]),
        "residual_displacement_corrected": float(d_corr[-1]),
    }
