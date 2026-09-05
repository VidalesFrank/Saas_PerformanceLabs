"""Parámetros de intensidad sísmica (Intensity Measures).

Todos los cálculos asumen unidades SI internamente:
  aceleración : m/s²
  velocidad   : m/s
  desplazamiento: m
  tiempo      : s

Referencias:
  - Arias (1970), A measure of earthquake intensity.
  - Kramer (1996), Geotechnical Earthquake Engineering, Cap. 2.
  - Chopra (2012), Dynamics of Structures, Cap. 2-3.
"""

from __future__ import annotations

import numpy as np

G_STD = 9.80665  # m/s²

# Compatibilidad numpy 1.x / 2.x: np.trapz fue eliminado en 2.0
def _trapz(y: np.ndarray, dx: float) -> float:
    """Integración trapezoidal escalar, compatible con numpy 1.x y 2.x."""
    return float(0.5 * dx * (float(y[0]) + 2.0 * float(np.sum(y[1:-1])) + float(y[-1])))


# ── Peak values ───────────────────────────────────────────────────────────────

def compute_pga(acc_ms2: np.ndarray) -> float:
    """Peak Ground Acceleration — máximo valor absoluto de la aceleración."""
    return float(np.max(np.abs(acc_ms2)))


def compute_pgv(vel_ms: np.ndarray) -> float:
    """Peak Ground Velocity — máximo valor absoluto de la velocidad."""
    return float(np.max(np.abs(vel_ms)))


def compute_pgd(disp_m: np.ndarray) -> float:
    """Peak Ground Displacement — máximo valor absoluto del desplazamiento."""
    return float(np.max(np.abs(disp_m)))


def compute_pga_pos(acc_ms2: np.ndarray) -> float:
    return float(np.max(acc_ms2))


def compute_pga_neg(acc_ms2: np.ndarray) -> float:
    return float(np.min(acc_ms2))


def time_of_peak(signal: np.ndarray, dt: float) -> float:
    """Instante de tiempo en el que ocurre el máximo valor absoluto."""
    idx = int(np.argmax(np.abs(signal)))
    return float(idx * dt)


# ── Arias Intensity ───────────────────────────────────────────────────────────

def compute_arias_intensity(acc_ms2: np.ndarray, dt: float) -> float:
    """Intensidad de Arias (Ia) en m/s.

    Ia = (π / 2g) × ∫ a²(t) dt

    Unidades: m/s  (si a está en m/s²)

    Referencia: Arias (1970).
    """
    integral = float(_trapz(acc_ms2 ** 2, dx=dt))
    return (np.pi / (2.0 * G_STD)) * integral


def compute_arias_cumulative(acc_ms2: np.ndarray, dt: float) -> np.ndarray:
    """Intensidad de Arias acumulada normalizada (0–1) en cada instante.

    Ia_cum[i] = (π/2g) × ∫₀^{tᵢ} a²(τ) dτ

    Returns:
        Array con la integral acumulada (valores en m/s, sin normalizar).
    """
    a2 = acc_ms2 ** 2
    ia_cum = np.zeros(len(acc_ms2))
    for i in range(1, len(acc_ms2)):
        ia_cum[i] = ia_cum[i - 1] + 0.5 * dt * (a2[i - 1] + a2[i])
    ia_cum *= (np.pi / (2.0 * G_STD))
    return ia_cum


# ── Duración significativa ────────────────────────────────────────────────────

def compute_significant_duration(
    acc_ms2: np.ndarray,
    dt: float,
    p_start: float = 5.0,
    p_end: float = 95.0,
) -> dict:
    """Duración significativa D_{p_start}-{p_end} basada en la intensidad de Arias.

    Encuentra los tiempos t₁ y t₂ donde la Ia acumulada normalizada
    alcanza p_start% y p_end% del total:
        D = t₂ - t₁

    Args:
        acc_ms2: aceleración en m/s².
        dt: Δt en segundos.
        p_start: porcentaje inicial (ej: 5.0 → 5%).
        p_end: porcentaje final (ej: 95.0 → 95%).

    Returns:
        dict con: t_start, t_end, duration, ia_total, ia_cum_normalized.
    """
    ia_cum = compute_arias_cumulative(acc_ms2, dt)
    ia_total = ia_cum[-1]

    if ia_total == 0:
        n = len(acc_ms2)
        t = np.arange(n) * dt
        return {
            "t_start": 0.0, "t_end": t[-1], "duration": t[-1],
            "ia_total": 0.0, "ia_cum": ia_cum.tolist(),
            "ia_cum_normalized": np.zeros(n).tolist(),
            "t": t.tolist(),
            "p_start": p_start, "p_end": p_end,
        }

    ia_norm = ia_cum / ia_total
    t = np.arange(len(acc_ms2)) * dt

    # Interpolación para encontrar los tiempos exactos
    idx_start = np.searchsorted(ia_norm, p_start / 100.0)
    idx_end   = np.searchsorted(ia_norm, p_end   / 100.0)

    idx_start = min(idx_start, len(t) - 1)
    idx_end   = min(idx_end,   len(t) - 1)

    t_start = float(t[idx_start])
    t_end   = float(t[idx_end])

    return {
        "t_start": t_start,
        "t_end":   t_end,
        "duration": t_end - t_start,
        "ia_total": float(ia_total),
        "ia_cum": ia_cum.tolist(),
        "ia_cum_normalized": ia_norm.tolist(),
        "t": t.tolist(),
        "p_start": p_start,
        "p_end":   p_end,
    }


# ── CAV ────────────────────────────────────────────────────────────────────────

def compute_cav(acc_ms2: np.ndarray, dt: float) -> float:
    """Cumulative Absolute Velocity (CAV) en m/s.

    CAV = ∫ |a(t)| dt

    Referencia: EPRI (1988).
    """
    return float(_trapz(np.abs(acc_ms2), dx=dt))


# ── RMS ───────────────────────────────────────────────────────────────────────

def compute_rms_acceleration(acc_ms2: np.ndarray, dt: float) -> float:
    """RMS de la aceleración sobre la duración total."""
    duration = (len(acc_ms2) - 1) * dt
    if duration <= 0:
        return float(np.sqrt(np.mean(acc_ms2 ** 2)))
    integral = float(_trapz(acc_ms2 ** 2, dx=dt))
    return float(np.sqrt(integral / duration))


def compute_rms_velocity(vel_ms: np.ndarray, dt: float) -> float:
    """RMS de la velocidad."""
    duration = (len(vel_ms) - 1) * dt
    if duration <= 0:
        return float(np.sqrt(np.mean(vel_ms ** 2)))
    integral = float(_trapz(vel_ms ** 2, dx=dt))
    return float(np.sqrt(integral / duration))


def compute_rms_displacement(disp_m: np.ndarray, dt: float) -> float:
    """RMS del desplazamiento."""
    duration = (len(disp_m) - 1) * dt
    if duration <= 0:
        return float(np.sqrt(np.mean(disp_m ** 2)))
    integral = float(_trapz(disp_m ** 2, dx=dt))
    return float(np.sqrt(integral / duration))


# ── Función completa ──────────────────────────────────────────────────────────

def compute_all_intensity_measures(
    acc_ms2: np.ndarray,
    vel_ms: np.ndarray,
    disp_m: np.ndarray,
    dt: float,
) -> dict:
    """Calcula todos los parámetros de intensidad sísmica.

    Args:
        acc_ms2: aceleración en m/s².
        vel_ms: velocidad en m/s.
        disp_m: desplazamiento en m.
        dt: Δt en segundos.

    Returns:
        dict con todos los parámetros de intensidad.
    """
    n = len(acc_ms2)
    t = np.arange(n) * dt

    # PGA en distintas unidades
    pga_ms2 = compute_pga(acc_ms2)

    # Arias
    ia = compute_arias_intensity(acc_ms2, dt)
    dur_595 = compute_significant_duration(acc_ms2, dt, 5.0, 95.0)
    dur_575 = compute_significant_duration(acc_ms2, dt, 5.0, 75.0)

    return {
        # Peak values
        "pga_ms2":        pga_ms2,
        "pga_g":          pga_ms2 / G_STD,
        "pga_pos_ms2":    compute_pga_pos(acc_ms2),
        "pga_neg_ms2":    compute_pga_neg(acc_ms2),
        "t_pga":          time_of_peak(acc_ms2, dt),
        "pgv_ms":         compute_pgv(vel_ms),
        "pgv_cms":        compute_pgv(vel_ms) * 100.0,
        "pgd_m":          compute_pgd(disp_m),
        "pgd_cm":         compute_pgd(disp_m) * 100.0,
        "t_pgv":          time_of_peak(vel_ms, dt),
        "t_pgd":          time_of_peak(disp_m, dt),
        # Ratios
        "pgv_pga_ratio":  float(compute_pgv(vel_ms) / max(pga_ms2, 1e-10)),

        # Arias Intensity
        "arias_intensity_ms": ia,
        "arias_intensity_cms": ia * 100.0,

        # Duration
        "D5_95":          dur_595["duration"],
        "D5_95_t_start":  dur_595["t_start"],
        "D5_95_t_end":    dur_595["t_end"],
        "D5_75":          dur_575["duration"],
        "D5_75_t_start":  dur_575["t_start"],
        "D5_75_t_end":    dur_575["t_end"],

        # CAV
        "cav_ms":         compute_cav(acc_ms2, dt),

        # RMS
        "rms_acc_ms2":    compute_rms_acceleration(acc_ms2, dt),
        "rms_vel_ms":     compute_rms_velocity(vel_ms, dt),
        "rms_disp_m":     compute_rms_displacement(disp_m, dt),
        "rms_acc_g":      compute_rms_acceleration(acc_ms2, dt) / G_STD,
    }
