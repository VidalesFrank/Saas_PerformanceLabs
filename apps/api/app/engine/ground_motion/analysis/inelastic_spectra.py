"""Espectros de respuesta inelástica (ductilidad constante) — modelo EPP.

Implementa un oscilador SDOF elasto-perfectamente plástico (EPP, α=0) integrado
con el esquema Newmark-β predictor-corrector en forma directa, la misma formulación
usada en spectra.py para el caso elástico.

Modelo histerético EPP:
  - Rama elástica:  F_s = k·u       con |u| ≤ u_y = fy_norm / ω²
  - Fluencia:       F_s = ±fy_norm  (perfectamente plástico, sin endurecimiento)
  - Descarga:       elástica con la misma pendiente k desde el punto de descarga

Rigidez efectiva según el régimen:
  k_eff_elastic = m + γ·dt·c + β·dt²·k       (elástico / descarga)
  k_eff_plastic = m + γ·dt·c                  (plástico, k_tangent = 0)

La transición elástico→plástico y la descarga se detectan paso a paso usando
como indicador la aceleración relativa calculada en el paso tentativo:

  - Si el sistema está en elástico y fs_tentativo > fy_norm → activa fluencia +
  - Si el sistema está en elástico y fs_tentativo < -fy_norm → activa fluencia -
  - Si el sistema está en plástico y a_rel_tentativo·sign_p < 0 → descarga

Este criterio (basado en la aceleración, no en la velocidad) es el estándar
descrito en Chopra (2012), Cap. 7 para integración paso a paso de SDOF inelásticos.

Referencias:
  - Chopra (2012), Dynamics of Structures, Cap. 7.
  - Clough & Penzien (2003), Cap. 7.
  - Newmark (1959), β=1/4, γ=1/2 (aceleración promedio constante).
"""

from __future__ import annotations

import numpy as np

# Parámetros de Newmark — idénticos a spectra.py
BETA  = 0.25
GAMMA = 0.50


def epp_sdof(
    ag: np.ndarray,
    dt: float,
    T: float,
    xi: float,
    fy_norm: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """SDOF elasto-perfectamente plástico (EPP) con excitación de base.

    La fuerza de fluencia fy_norm está normalizada por la masa unitaria (m/s²),
    lo que equivale a trabajar directamente en el espacio de aceleraciones espectrales
    sin necesitar una masa explícita (m=1 kg implícito).

    Criterio de transición (Chopra 2012, Cap. 7):
      - Elástico → Plástico: fs_tentativo supera ±fy_norm
      - Plástico → Elástico: la aceleración tentativa en régimen plástico tiene
        signo contrario al plateau de fluencia activo (la fuerza efectiva ya
        no puede mantener la deformación plástica en la misma dirección)

    Args:
        ag      : aceleración de base [m/s²] — array 1D.
        dt      : paso de tiempo [s].
        T       : periodo natural [s].
        xi      : amortiguamiento fraccional (ej. 0.05 = 5%).
        fy_norm : fuerza de fluencia normalizada por masa [m/s²].

    Returns:
        (u, v, a_rel, a_abs, fs)
          u      : desplazamiento relativo [m]
          v      : velocidad relativa [m/s]
          a_rel  : aceleración relativa [m/s²]
          a_abs  : aceleración absoluta = a_rel + ag [m/s²]
          fs     : historial de fuerza restauradora normalizada [m/s²]
    """
    if T <= 1e-10:
        zeros = np.zeros_like(ag)
        return zeros, zeros, zeros, ag.copy(), np.zeros_like(ag)

    n     = len(ag)
    m     = 1.0
    omega = 2.0 * np.pi / T
    k     = m * omega ** 2
    c     = 2.0 * xi * m * omega

    # Rigideces efectivas precalculadas
    k_eff_e = m + GAMMA * dt * c + BETA * dt ** 2 * k   # elástico / descarga
    k_eff_p = m + GAMMA * dt * c                          # plástico

    u      = np.zeros(n)
    v      = np.zeros(n)
    a_rel  = np.zeros(n)
    fs_arr = np.zeros(n)

    # Condición inicial: equilibrio en t=0
    a_rel[0]  = -ag[0]
    fs_arr[0] = k * u[0]    # = 0

    # Estado histerético
    plastic = False
    sign_p  = 0    # signo del plateau activo: +1 o -1

    for i in range(n - 1):
        # — Predictor (sin a[i+1]) —
        u_pred = u[i] + dt * v[i] + dt ** 2 * (0.5 - BETA) * a_rel[i]
        v_pred = v[i] + dt * (1.0 - GAMMA) * a_rel[i]

        f_ext = -m * ag[i + 1]

        if not plastic:
            # — Régimen elástico —
            p_eff  = f_ext - c * v_pred - k * u_pred
            a_new  = p_eff / k_eff_e
            u_new  = u_pred + dt ** 2 * BETA * a_new
            v_new  = v_pred + dt * GAMMA * a_new
            fs_new = k * u_new

            # Comprobar inicio de fluencia
            if fs_new > fy_norm:
                plastic = True
                sign_p  = 1
                fs_new  = fy_norm
                p_eff_p = f_ext - c * v_pred - fy_norm
                a_new   = p_eff_p / k_eff_p
                u_new   = u_pred + dt ** 2 * BETA * a_new
                v_new   = v_pred + dt * GAMMA * a_new

            elif fs_new < -fy_norm:
                plastic = True
                sign_p  = -1
                fs_new  = -fy_norm
                p_eff_p = f_ext - c * v_pred + fy_norm
                a_new   = p_eff_p / k_eff_p
                u_new   = u_pred + dt ** 2 * BETA * a_new
                v_new   = v_pred + dt * GAMMA * a_new

        else:
            # — Régimen plástico —
            # Intentar continuar en plástico
            fs_plateau = float(sign_p) * fy_norm
            p_eff_p    = f_ext - c * v_pred - fs_plateau
            a_tent     = p_eff_p / k_eff_p

            # Criterio de descarga: si a_tent tiene signo opuesto al plateau,
            # la fuerza efectiva ya no puede sostener la fluencia → descargar
            if a_tent * float(sign_p) < 0.0:
                plastic = False
                p_eff_e = f_ext - c * v_pred - k * u_pred
                a_new   = p_eff_e / k_eff_e
                u_new   = u_pred + dt ** 2 * BETA * a_new
                v_new   = v_pred + dt * GAMMA * a_new
                fs_new  = k * u_new

                # La descarga puede llevar directamente a fluencia opuesta
                if fs_new > fy_norm:
                    plastic = True
                    sign_p  = 1
                    fs_new  = fy_norm
                    p_eff_p = f_ext - c * v_pred - fy_norm
                    a_new   = p_eff_p / k_eff_p
                    u_new   = u_pred + dt ** 2 * BETA * a_new
                    v_new   = v_pred + dt * GAMMA * a_new

                elif fs_new < -fy_norm:
                    plastic = True
                    sign_p  = -1
                    fs_new  = -fy_norm
                    p_eff_p = f_ext - c * v_pred + fy_norm
                    a_new   = p_eff_p / k_eff_p
                    u_new   = u_pred + dt ** 2 * BETA * a_new
                    v_new   = v_pred + dt * GAMMA * a_new

            else:
                # Continuar en plástico
                a_new  = a_tent
                u_new  = u_pred + dt ** 2 * BETA * a_new
                v_new  = v_pred + dt * GAMMA * a_new
                fs_new = fs_plateau

        u[i + 1]      = u_new
        v[i + 1]      = v_new
        a_rel[i + 1]  = a_new
        fs_arr[i + 1] = fs_new

    a_abs = a_rel + ag
    return u, v, a_rel, a_abs, fs_arr


def constant_ductility_spectrum(
    ag: np.ndarray,
    dt: float,
    T_array: np.ndarray,
    xi: float,
    mu_target: float,
    tol: float = 0.05,
    max_iter: int = 30,
) -> dict:
    """Espectro de ductilidad constante mediante bisección sobre fy_norm.

    Para cada periodo T:
      1. Calcula PSA_elastic = ω²·max|u_elástico|.
      2. Si mu_target == 1.0 o PSA_elastic ≈ 0, retorna el resultado elástico.
      3. En otro caso, busca fy_norm tal que μ_ach = max|u| / u_y ≈ mu_target
         por bisección en el intervalo [fy_lo = 0.01·PSA_el, fy_hi = PSA_el].

    La ductilidad se calcula como:
        u_y   = fy_norm / ω²
        μ_ach = max|u(t)| / u_y

    Args:
        ag        : aceleración de base [m/s²].
        dt        : paso de tiempo [s].
        T_array   : periodos a evaluar [s].
        xi        : amortiguamiento fraccional.
        mu_target : ductilidad objetivo (≥ 1.0).
        tol       : tolerancia relativa en ductilidad (default 5%).
        max_iter  : máximo de iteraciones de bisección.

    Returns:
        dict con listas de longitud igual a T_array:
          "T"          : periodos [s]
          "Sd_inel"    : desplazamiento espectral inelástico [m]
          "Sa_inel"    : aceleración espectral inelástica = fy_norm [m/s²]
          "Sa_elastic" : PSA elástico de referencia [m/s²]
          "R_mu_T"     : factor de reducción = PSA_elastic / Sa_inel (≥ 1)
          "mu_achieved": ductilidad alcanzada al converger
    """
    from app.engine.ground_motion.analysis.spectra import newmark_sdof

    n_T        = len(T_array)
    Sd_inel    = np.zeros(n_T)
    Sa_inel    = np.zeros(n_T)
    Sa_elastic = np.zeros(n_T)
    R_mu_T     = np.zeros(n_T)
    mu_ach_arr = np.zeros(n_T)

    for idx, T in enumerate(T_array):
        omega = 2.0 * np.pi / max(T, 1e-10)

        # Espectro elástico de referencia
        u_el, _, _, _ = newmark_sdof(ag, dt, T, xi)
        sd_el   = float(np.max(np.abs(u_el)))
        psa_el  = omega ** 2 * sd_el
        Sa_elastic[idx] = psa_el

        if mu_target == 1.0 or psa_el < 1e-12:
            # Elástico: sin iteración
            Sd_inel[idx]    = sd_el
            Sa_inel[idx]    = psa_el
            R_mu_T[idx]     = 1.0
            mu_ach_arr[idx] = 1.0
            continue

        # Bisección sobre fy_norm
        # fy_hi = PSA_el → oscilador casi elástico → μ ≈ 1
        # fy_lo = PSA_el * 0.01 → fuerte fluencia → μ muy alta
        fy_lo = psa_el * 0.01
        fy_hi = psa_el

        fy_best = psa_el * (1.0 / mu_target)   # primer estimado R≈μ (Newmark-Hall)
        mu_best = 1.0

        for _ in range(max_iter):
            fy_mid = 0.5 * (fy_lo + fy_hi)
            u_y    = fy_mid / (omega ** 2)

            if u_y < 1e-14:
                break

            u_in, _, _, _, _ = epp_sdof(ag, dt, T, xi, fy_mid)
            u_max  = float(np.max(np.abs(u_in)))
            mu_ach = u_max / u_y if u_y > 1e-14 else 1.0

            fy_best = fy_mid
            mu_best = mu_ach

            err = (mu_ach - mu_target) / mu_target
            if abs(err) <= tol:
                break

            # μ_ach > μ_target → fy muy baja → subir fy_lo
            # μ_ach < μ_target → fy muy alta → bajar fy_hi
            if mu_ach > mu_target:
                fy_lo = fy_mid
            else:
                fy_hi = fy_mid

        # Resultados finales
        u_y_final   = fy_best / (omega ** 2)
        sd_inel_val = u_y_final * mu_best

        Sd_inel[idx]    = sd_inel_val
        Sa_inel[idx]    = fy_best
        R_mu_T[idx]     = psa_el / fy_best if fy_best > 1e-14 else 1.0
        mu_ach_arr[idx] = mu_best

    return {
        "T":           T_array.tolist(),
        "Sd_inel":     Sd_inel.tolist(),
        "Sa_inel":     Sa_inel.tolist(),
        "Sa_elastic":  Sa_elastic.tolist(),
        "R_mu_T":      R_mu_T.tolist(),
        "mu_achieved": mu_ach_arr.tolist(),
    }


def inelastic_spectrum_multi_mu(
    ag: np.ndarray,
    dt: float,
    T_array: np.ndarray,
    xi: float,
    mu_list: list[float],
) -> dict:
    """Espectros inelásticos de ductilidad constante para múltiples ductilidades.

    Para μ=1.0 retorna el espectro elástico (PSA/Sd) sin iteración.
    Para μ>1.0 usa bisección mediante constant_ductility_spectrum.

    Args:
        ag      : aceleración de base [m/s²].
        dt      : paso de tiempo [s].
        T_array : periodos a evaluar [s].
        xi      : amortiguamiento fraccional.
        mu_list : lista de ductilidades objetivo (ej. [1.0, 1.5, 2.0, 3.0, 4.0, 6.0]).

    Returns:
        {
          "T":          [...],         # periodos comunes [s]
          "Sa_elastic": [...],         # PSA elástico (referencia, μ=1) [m/s²]
          "spectra": {
            "1.0": {
              "Sa_inel": [...],        # aceleración espectral inelástica [m/s²]
              "Sd_inel": [...],        # desplazamiento espectral inelástico [m]
              "R":       [...],        # factor de reducción = PSA_el / Sa_inel
            },
            "2.0": { ... },
            ...
          },
          "xi":      xi,
          "mu_list": mu_list,
        }
    """
    spectra: dict = {}
    sa_elastic_ref: list[float] = []

    for mu in mu_list:
        result = constant_ductility_spectrum(ag, dt, T_array, xi, float(mu))

        key = str(float(mu))
        spectra[key] = {
            "Sa_inel": result["Sa_inel"],
            "Sd_inel": result["Sd_inel"],
            "R":       result["R_mu_T"],
        }

        if not sa_elastic_ref:
            sa_elastic_ref = result["Sa_elastic"]

    return {
        "T":          T_array.tolist(),
        "Sa_elastic": sa_elastic_ref,
        "spectra":    spectra,
        "xi":         xi,
        "mu_list":    mu_list,
    }
