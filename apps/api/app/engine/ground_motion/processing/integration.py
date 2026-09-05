"""Integración numérica de señales sísmicas.

Implementa la regla trapezoidal para obtener velocidad y desplazamiento
a partir de la aceleración. Incluye opciones de corrección de drift.

Referencia: Chopra (2012), Dynamics of Structures, Cap. 4.
"""

from __future__ import annotations

import numpy as np


def integrate_trapz(signal: np.ndarray, dt: float) -> np.ndarray:
    """Integración trapezoidal acumulativa de una señal con Δt constante.

    Calcula la integral acumulativa usando la regla del trapecio:
        I[0] = 0
        I[i] = I[i-1] + dt/2 * (signal[i-1] + signal[i])

    Args:
        signal: array 1D de la señal a integrar.
        dt: intervalo de tiempo en segundos (debe ser > 0 y constante).

    Returns:
        Array 1D con la integral acumulativa, mismo tamaño que signal.
    """
    n = len(signal)
    result = np.zeros(n)
    for i in range(1, n):
        result[i] = result[i - 1] + 0.5 * dt * (signal[i - 1] + signal[i])
    return result


def integrate_trapz_vec(signal: np.ndarray, dt: float) -> np.ndarray:
    """Versión vectorizada de integrate_trapz (más rápida para señales largas).

    Fórmula: I[i] = dt/2 * (signal[0] + 2*signal[1] + ... + 2*signal[i-1] + signal[i])
                   = dt * (cumsum[i] - (signal[0] + signal[i]) / 2)
    """
    cumsum = np.cumsum(signal)
    # Corrección trapezoidal correcta: descontar el promedio de extremos
    integral = dt * (cumsum - 0.5 * (signal[0] + signal))
    return integral


def compute_velocity(acc_ms2: np.ndarray, dt: float) -> np.ndarray:
    """Integra aceleración para obtener velocidad.

    Args:
        acc_ms2: aceleración en m/s².
        dt: Δt en segundos.

    Returns:
        Velocidad en m/s.
    """
    return integrate_trapz_vec(acc_ms2, dt)


def compute_displacement(vel_ms: np.ndarray, dt: float) -> np.ndarray:
    """Integra velocidad para obtener desplazamiento.

    Args:
        vel_ms: velocidad en m/s.
        dt: Δt en segundos.

    Returns:
        Desplazamiento en m.
    """
    return integrate_trapz_vec(vel_ms, dt)


def compute_all(acc_ms2: np.ndarray, dt: float) -> tuple[np.ndarray, np.ndarray]:
    """Calcula velocidad y desplazamiento a partir de aceleración.

    Args:
        acc_ms2: aceleración en m/s².
        dt: Δt en segundos.

    Returns:
        (vel_ms, disp_m) — velocidad en m/s y desplazamiento en m.
    """
    vel  = compute_velocity(acc_ms2, dt)
    disp = compute_displacement(vel, dt)
    return vel, disp


def compute_all_corrected(
    acc_ms2: np.ndarray,
    dt: float,
    correct_velocity: bool = True,
    correct_displacement: bool = True,
) -> tuple[np.ndarray, np.ndarray]:
    """Calcula velocidad y desplazamiento con corrección de drift por tendencia lineal.

    Después de integrar la aceleración para obtener v(t):
      1. Elimina la tendencia lineal de v(t) → v_corr(t).
      2. Integra v_corr(t) para obtener d(t).
      3. Elimina la tendencia lineal de d(t) → d_corr(t).

    Esta corrección es equivalente a una corrección de línea base aplicada
    en el dominio de la velocidad y el desplazamiento, evitando drift numérico.

    Args:
        acc_ms2: aceleración en m/s².
        dt: Δt en segundos.
        correct_velocity: si True aplica detrend lineal a v(t).
        correct_displacement: si True aplica detrend lineal a d(t).

    Returns:
        (vel_ms, disp_m) corregidas.
    """
    from .baseline import remove_linear_trend

    vel = compute_velocity(acc_ms2, dt)
    if correct_velocity:
        vel = remove_linear_trend(vel)

    disp = compute_displacement(vel, dt)
    if correct_displacement:
        disp = remove_linear_trend(disp)

    return vel, disp
