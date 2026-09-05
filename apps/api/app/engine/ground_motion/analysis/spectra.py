"""Espectro de respuesta elástico usando el método de Newmark-β.

Implementación del método de integración paso a paso de Newmark (1959)
con β=1/4, γ=1/2 (aceleración promedio constante — incondicionalmente estable).

Ecuación de movimiento SDOF bajo excitación de base:
    m·ü(t) + c·u̇(t) + k·u(t) = −m·üg(t)

donde u(t) es el desplazamiento relativo respecto a la base.

Resultados del espectro:
    Sd  = max|u(t)|         Desplazamiento espectral (real)
    Sv  = max|u̇(t)|         Velocidad espectral (real)
    Sa  = max|ü(t) + üg(t)| Aceleración espectral (absoluta, real)
    PSV = ω·Sd              Pseudo-velocidad espectral
    PSA = ω²·Sd             Pseudo-aceleración espectral

Referencias:
  - Newmark (1959), A method of computation for structural dynamics.
  - Chopra (2012), Dynamics of Structures, Cap. 5 y Apéndice A.
  - Clough & Penzien (2003), Dynamics of Structures, Cap. 7.
"""

from __future__ import annotations

import numpy as np


# ── Parámetros de Newmark (aceleración promedio) ──────────────────────────────

BETA  = 0.25   # β = 1/4 → aceleración promedio constante (estabilidad incondicional)
GAMMA = 0.50   # γ = 1/2 → sin disipación numérica artificial

# ── Solver SDOF individual ────────────────────────────────────────────────────

def newmark_sdof(
    ag: np.ndarray,
    dt: float,
    T: float,
    xi: float = 0.05,
    beta: float = BETA,
    gamma: float = GAMMA,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Respuesta de un SDOF lineal bajo excitación de base üg(t) usando Newmark-β.

    Args:
        ag  : aceleración de base en m/s² (array 1D).
        dt  : Δt en segundos.
        T   : periodo natural del oscilador en segundos.
        xi  : amortiguamiento fraccional (ej: 0.05 = 5%).
        beta: parámetro β de Newmark.
        gamma: parámetro γ de Newmark.

    Returns:
        (u, v, a_rel, a_abs) — arrays 1D:
          u     : desplazamiento relativo [m]
          v     : velocidad relativa [m/s]
          a_rel : aceleración relativa [m/s²]
          a_abs : aceleración absoluta = a_rel + ag [m/s²]
    """
    if T <= 1e-10:
        # Oscilador rígido: la respuesta es la excitación de base
        a_abs = ag.copy()
        zeros = np.zeros_like(ag)
        return zeros, zeros, zeros, a_abs

    n  = len(ag)
    m  = 1.0                     # masa unitaria (sin pérdida de generalidad)
    omega = 2.0 * np.pi / T
    k  = m * omega ** 2           # k = m·ω²
    c  = 2.0 * xi * m * omega     # c = 2·ξ·m·ω

    # Rigidez efectiva para el esquema predictor-corrector (forma absoluta)
    # De la ecuación de movimiento: (m + γ·dt·c + β·dt²·k)·a_{n+1} = p_eff
    # Referencia: Chopra (2012) Ec. 5.2.12a, forma directa (no incremental)
    k_eff = m + gamma * dt * c + beta * dt ** 2 * k

    u     = np.zeros(n)
    v     = np.zeros(n)
    a_rel = np.zeros(n)

    # Condición inicial: respuesta inicial a partir del equilibrio
    # a[0] = (-k·u[0] - c·v[0] - m·ag[0]) / m = -ag[0]
    a_rel[0] = -ag[0]

    for i in range(n - 1):
        # Fuerza externa incremental (fuerza inercial)
        f_ext = -m * ag[i + 1]

        # Predictor (sin a[i+1])
        u_pred = u[i] + dt * v[i] + dt ** 2 * (0.5 - beta) * a_rel[i]
        v_pred = v[i] + dt * (1.0 - gamma) * a_rel[i]

        # Aceleración en i+1
        p_eff = f_ext - c * v_pred - k * u_pred
        a_rel[i + 1] = p_eff / k_eff

        # Corrector
        u[i + 1] = u_pred + dt ** 2 * beta * a_rel[i + 1]
        v[i + 1] = v_pred + dt * gamma * a_rel[i + 1]

    a_abs = a_rel + ag
    return u, v, a_rel, a_abs


# ── Espectro de respuesta ─────────────────────────────────────────────────────

def response_spectrum(
    ag: np.ndarray,
    dt: float,
    T_array: np.ndarray,
    xi: float = 0.05,
) -> dict:
    """Calcula el espectro de respuesta elástico para un conjunto de periodos.

    Para cada T en T_array resuelve el SDOF con Newmark-β y extrae:
        Sd  = max|u(t)|
        Sv  = max|u̇(t)|
        Sa  = max|ü_abs(t)|
        PSV = ω·Sd
        PSA = ω²·Sd

    Args:
        ag     : aceleración de base en m/s² (array 1D).
        dt     : Δt en segundos.
        T_array: periodos a evaluar en segundos (array 1D).
        xi     : amortiguamiento fraccional.

    Returns:
        dict con listas T, Sd, Sv, Sa, PSV, PSA (misma longitud que T_array).
    """
    n_T = len(T_array)
    Sd  = np.zeros(n_T)
    Sv  = np.zeros(n_T)
    Sa  = np.zeros(n_T)
    PSV = np.zeros(n_T)
    PSA = np.zeros(n_T)

    for i, T in enumerate(T_array):
        u, v, _, a_abs = newmark_sdof(ag, dt, T, xi)
        omega_i = 2.0 * np.pi / max(T, 1e-10)

        sd = float(np.max(np.abs(u)))
        sv = float(np.max(np.abs(v)))
        sa = float(np.max(np.abs(a_abs)))

        Sd[i]  = sd
        Sv[i]  = sv
        Sa[i]  = sa
        PSV[i] = omega_i * sd
        PSA[i] = omega_i ** 2 * sd

    return {
        "T":   T_array.tolist(),
        "Sd":  Sd.tolist(),
        "Sv":  Sv.tolist(),
        "Sa":  Sa.tolist(),
        "PSV": PSV.tolist(),
        "PSA": PSA.tolist(),
        "xi":  xi,
    }


def response_spectrum_multi_xi(
    ag: np.ndarray,
    dt: float,
    T_array: np.ndarray,
    xi_list: list[float],
) -> dict:
    """Calcula el espectro de respuesta para múltiples amortiguamientos.

    Returns:
        dict: {"T": [...], "spectra": {xi_str: {Sd, Sv, Sa, PSV, PSA}}}
    """
    spectra: dict = {}
    for xi in xi_list:
        result = response_spectrum(ag, dt, T_array, xi)
        key = f"{xi:.4f}"
        spectra[key] = {k: result[k] for k in ("Sd", "Sv", "Sa", "PSV", "PSA")}

    return {
        "T":      T_array.tolist(),
        "spectra": spectra,
        "xi_list": xi_list,
    }


def default_period_array(T_min: float = 0.01, T_max: float = 4.0, n_points: int = 200) -> np.ndarray:
    """Genera un array de periodos con escala logarítmica entre T_min y T_max."""
    return np.logspace(np.log10(T_min), np.log10(T_max), n_points)


def spectrum_at_period(
    ag: np.ndarray,
    dt: float,
    T: float,
    xi: float = 0.05,
) -> dict:
    """Calcula la demanda espectral para un periodo específico.

    Útil para el 'Spectrum Inspector': el usuario introduce T y obtiene sa/sd/psv.

    Returns:
        dict con Sd, Sv, Sa, PSV, PSA para ese T.
    """
    u, v, _, a_abs = newmark_sdof(ag, dt, T, xi)
    omega = 2.0 * np.pi / max(T, 1e-10)
    sd = float(np.max(np.abs(u)))
    sv = float(np.max(np.abs(v)))
    sa = float(np.max(np.abs(a_abs)))

    return {
        "T":   T,
        "xi":  xi,
        "Sd":  sd,
        "Sv":  sv,
        "Sa":  sa,
        "PSV": omega * sd,
        "PSA": omega ** 2 * sd,
        "u_history":     u.tolist(),     # historial de desplazamiento del SDOF
        "v_history":     v.tolist(),
        "a_abs_history": a_abs.tolist(), # aceleración absoluta del SDOF
    }
