"""
Método N2 modificado (Fajfar 2000) — punto de desempeño por pushover.

Pipeline:
    pushover MDOF  ──Γ,m*──►  SDOF (Sd, Sa)
                              │
                              ├── truncar 20% strength drop
                              ├── idealización bilineal equal-energy (K* en 60% peak)
                              ├── T* efectivo
                              └── interp espectro elástico en T* → Sae, Sde
                                   │
                                   ├── Tc Newmark-Hall del espectro
                                   └── Rμ = Sae/Say
                                        │
                                        ├── T* ≥ Tc  → Sd_obj = Sde (equal displacement)
                                        └── T* <  Tc → Sd_obj = (Sde/Rμ)·[1 + (Rμ-1)·Tc/T*]
                                             │
                                             └── D_techo = Γ · Sd_obj  (de vuelta a MDOF)

Referencias:
    Fajfar, P. (2000). "A nonlinear analysis method for performance-based
        seismic design." Earthquake Spectra, 16(3), 573–592.
    Eurocode 8 §4.3 Anexo B (versión formal del N2).

Unidades (consistentes en todas las funciones):
    - Desplazamientos: m
    - Fuerza: kN
    - Masa: ton (= kN·s²/m)
    - Aceleración: m/s²
    - Período: s
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

import numpy as np

# Compatibilidad numpy 1.x (prod Docker usa 1.26.4) y 2.x (dev local).
# `np.trapezoid` existe en 2.0+; `np.trapz` fue deprecado pero sigue disponible en 1.x.
_trapz = getattr(np, "trapezoid", getattr(np, "trapz", None))
if _trapz is None:
    raise ImportError("numpy sin np.trapezoid/np.trapz — versión incompatible")


# ──────────────────────────────────────────────────────────────────────────────
# Resultado estructurado
# ──────────────────────────────────────────────────────────────────────────────

@dataclass
class N2Result:
    """Salida completa del método N2 por dirección."""

    # ── Datos del MDOF→SDOF ──────────────────────────────────────────────────
    gamma_1:         float          # Factor de participación modal Γ₁ (dir)
    m_ast:           float          # Masa SDOF equivalente m* [ton]
    # ── Capacidad SDOF ───────────────────────────────────────────────────────
    Sd_capacity:     list[float]    # Sd[] completo (m)
    Sa_capacity:     list[float]    # Sa[] completo (m/s²)
    Sd_useful:       list[float]    # Sd[] truncado al 20% drop
    Sa_useful:       list[float]    # Sa[] truncado al 20% drop
    Sd_degraded:     list[float]    # Sd[] más allá del 20% drop (cola)
    Sa_degraded:     list[float]    # Sa[] más allá del 20% drop
    idx_falla:       int            # Índice en Sd/Sa del punto de 20% drop
    strength_drop_found: bool
    # ── Idealización bilineal ────────────────────────────────────────────────
    K_star:          float          # Rigidez inicial del bilineal (m/s²/m)
    Say:             float          # Aceleración de fluencia SDOF (m/s²)
    Sdy:             float          # Desplazamiento de fluencia SDOF (m)
    T_star:          float          # Período efectivo SDOF (s)
    Sa_max:          float          # Pico Sa del pushover (m/s²)
    Sd_ultimo:       float          # Sd al 20% drop (m)
    # ── Espectro ADRS ────────────────────────────────────────────────────────
    T_spec:          list[float]    # Períodos (s)
    Sa_spec:         list[float]    # Sa elástico (m/s²)
    Sd_spec:         list[float]    # Sd elástico = Sa·(T/2π)² (m)
    Tc:              float          # Período de esquina Newmark-Hall (s)
    # ── Punto de desempeño ───────────────────────────────────────────────────
    Sae:             float          # Sa elástico en T* (m/s²)
    Sde:             float          # Sd elástico en T* (m)
    R_mu:            float          # Factor de reducción Sae/Say
    rule:            Literal["equal_displacement", "equal_energy"]
    Sd_target:       float          # Sd objetivo SDOF (m)
    D_target:        float          # D_techo objetivo MDOF (m) = Γ·Sd_target
    ductility:       float          # μ = Sd_target / Sdy
    is_collapse:     bool           # True si Sd_target > Sd_ultimo
    # ── Metadatos ────────────────────────────────────────────────────────────
    bilinear_sd:     list[float] = field(default_factory=list)
    bilinear_sa:     list[float] = field(default_factory=list)
    warnings:        list[str]   = field(default_factory=list)


# ──────────────────────────────────────────────────────────────────────────────
# MDOF → SDOF
# ──────────────────────────────────────────────────────────────────────────────

def mdof_to_sdof(
    dtecho:  np.ndarray,
    Vbasal:  np.ndarray,
    gamma_1: float,
    m_ast:   float,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Convierte la curva pushover MDOF (δ_techo vs V_basal) al SDOF equivalente
    usando el factor de participación Γ₁ y la masa SDOF m*.

    Parámetros
    ----------
    dtecho : (n,) ndarray
        Desplazamiento de techo [m].
    Vbasal : (n,) ndarray
        Cortante basal [kN].
    gamma_1 : float
        Factor de participación modal del primer modo en la dir del pushover.
    m_ast : float
        Masa SDOF equivalente [ton]. m* = partiMass / Γ.

    Retorna
    -------
    (Sd, Sa) : tuple of (n,) ndarrays
        Sd en metros, Sa en m/s² (consistente con m*=ton y V=kN).
    """
    if gamma_1 <= 0 or m_ast <= 0:
        raise ValueError(f"Γ₁ y m* deben ser positivos (Γ₁={gamma_1}, m*={m_ast}).")
    Sd = np.asarray(dtecho, dtype=float) / gamma_1
    # [kN] / ([ton] × adim) = m/s² (coherente porque 1 kN = 1 ton·m/s²)
    Sa = np.asarray(Vbasal, dtype=float) / (gamma_1 * m_ast)
    return Sd, Sa


# ──────────────────────────────────────────────────────────────────────────────
# Truncar al 20% strength drop
# ──────────────────────────────────────────────────────────────────────────────

def truncate_strength_drop(
    Sd: np.ndarray,
    Sa: np.ndarray,
    drop_ratio: float = 0.80,
) -> tuple[np.ndarray, np.ndarray, int, bool]:
    """
    Trunca la curva en el primer punto después del pico donde la fuerza baja
    por debajo de `drop_ratio × Sa_max` (default 80% = 20% de caída).

    Retorna (Sd_util, Sa_util, idx_falla, strength_drop_found).
    Si no se encuentra caída, usa la curva completa y marca `found=False`.
    """
    Sa = np.asarray(Sa, dtype=float)
    Sd = np.asarray(Sd, dtype=float)
    if Sa.size == 0:
        raise ValueError("Curva vacía.")
    idx_pico = int(np.argmax(Sa))
    Sa_max   = float(Sa[idx_pico])
    Sa_lim   = drop_ratio * Sa_max

    idx_falla = len(Sa) - 1
    found     = False
    for i in range(idx_pico, len(Sa)):
        if Sa[i] < Sa_lim:
            idx_falla = i
            found     = True
            break

    return Sd[:idx_falla + 1], Sa[:idx_falla + 1], idx_falla, found


# ──────────────────────────────────────────────────────────────────────────────
# Idealización bilineal equal-energy
# ──────────────────────────────────────────────────────────────────────────────

def bilinear_equal_energy(
    Sd_util: np.ndarray,
    Sa_util: np.ndarray,
    stiffness_at_fraction: float = 0.60,
) -> tuple[float, float, float, float]:
    """
    Idealización bilineal (K* en el `stiffness_at_fraction` del pico, meseta
    plástica horizontal) determinada por el principio de igual energía.

    Procedimiento:
        1. Sa_60 = 0.60·Sa_max   (o fracción indicada).
        2. Sd_60 = interp(Sa_60, rama ascendente).
        3. K* = Sa_60 / Sd_60.
        4. E_real = ∫ Sa_util dSd_util  (área bajo capacidad).
        5. Resolver Say² − 2·K*·Sd_ult·Say + 2·K*·E_real = 0.
        6. Sdy = Say / K*,   T* = 2π·√(Sdy / Say).

    Retorna (K_star, Say, Sdy, T_star).
    """
    Sa_util = np.asarray(Sa_util, dtype=float)
    Sd_util = np.asarray(Sd_util, dtype=float)
    if Sa_util.size < 2:
        raise ValueError("Se requieren ≥ 2 puntos para idealización bilineal.")

    idx_pico = int(np.argmax(Sa_util))
    Sa_max   = float(Sa_util[idx_pico])
    Sd_ult   = float(Sd_util[-1])
    Sa_frac  = stiffness_at_fraction * Sa_max

    # Rama ascendente (incluye el pico) para interpolar
    Sa_asc = Sa_util[: idx_pico + 1]
    Sd_asc = Sd_util[: idx_pico + 1]
    if Sa_asc.size < 2 or Sa_asc[-1] <= Sa_asc[0]:
        raise ValueError("Rama ascendente insuficiente para idealización bilineal.")
    # np.interp requiere x monótono creciente; en pushover eso suele cumplirse
    # en Sa durante la rama ascendente. Si no, forzamos sort por Sa.
    order = np.argsort(Sa_asc)
    Sd_60 = float(np.interp(Sa_frac, Sa_asc[order], Sd_asc[order]))
    if Sd_60 <= 0:
        raise ValueError(
            f"Sd_{int(stiffness_at_fraction*100)} ≤ 0 — rama ascendente degenerada."
        )

    K_star = Sa_frac / Sd_60

    E_real = float(_trapz(Sa_util, Sd_util))

    # Say² − 2·K·Sd_ult·Say + 2·K·E = 0  →  Say = (2KSd_ult − √Δ)/2
    b = -2.0 * K_star * Sd_ult
    c =  2.0 * K_star * E_real
    disc = max(0.0, b * b - 4.0 * c)
    Say = (-b - np.sqrt(disc)) / 2.0
    if Say <= 0 or Say > Sa_max * 1.5:
        raise ValueError(f"Say inválido tras idealización ({Say=:.4f}).")

    Sdy = Say / K_star
    T_star = 2.0 * np.pi * np.sqrt(Sdy / Say)
    return K_star, Say, Sdy, T_star


# ──────────────────────────────────────────────────────────────────────────────
# Período de esquina (Newmark-Hall)
# ──────────────────────────────────────────────────────────────────────────────

def corner_period_newmark_hall(
    T_spec: np.ndarray,
    Sa_g:   np.ndarray,
) -> float:
    """
    Período de esquina Tc del espectro vía Newmark-Hall:
        Sv  = Sa · T / (2π)
        Tc  = 2π · (Sv_max / Sa_max)
    Separa el rango de "equal displacement" (T* ≥ Tc) del "equal energy".

    Parámetros
    ----------
    T_spec : (n,) ndarray  — períodos (s)
    Sa_g : (n,) ndarray    — Sa elástico en g (adim). Internamente lo tratamos
                             independiente de unidades porque Tc solo depende
                             de la forma del espectro.
    """
    T  = np.asarray(T_spec, dtype=float)
    Sa = np.asarray(Sa_g, dtype=float)
    if T.size == 0 or Sa.size == 0:
        raise ValueError("Espectro vacío para Tc.")
    Sv      = Sa * T / (2.0 * np.pi)
    Sv_max  = float(np.max(Sv))
    Sa_max  = float(np.max(Sa))
    if Sa_max <= 0:
        raise ValueError("Sa_max ≤ 0 — espectro degenerado.")
    return 2.0 * np.pi * (Sv_max / Sa_max)


# ──────────────────────────────────────────────────────────────────────────────
# Punto de desempeño N2 modificado
# ──────────────────────────────────────────────────────────────────────────────

def n2_target_displacement(
    T_star: float,
    Tc:     float,
    Sae:    float,
    Say:    float,
) -> tuple[float, float, Literal["equal_displacement", "equal_energy"]]:
    """
    Desplazamiento objetivo SDOF por el método N2 modificado:
        Sde = Sae · (T*/2π)²
        Rμ  = Sae / Say
        T* ≥ Tc  →  Sd_obj = Sde                                 (equal displacement)
        T* <  Tc →  Sd_obj = (Sde/Rμ) · [1 + (Rμ−1)·Tc/T*]       (equal energy)

    Retorna (Sd_target, R_mu, rule).
    """
    if T_star <= 0 or Say <= 0:
        raise ValueError(f"T* y Say deben ser positivos (T*={T_star}, Say={Say}).")
    Sde = Sae * (T_star / (2.0 * np.pi)) ** 2
    R_mu = Sae / Say
    if T_star >= Tc:
        return Sde, R_mu, "equal_displacement"
    R_eff = max(R_mu, 1.0)
    Sd_obj = (Sde / R_eff) * (1.0 + (R_eff - 1.0) * (Tc / T_star))
    return Sd_obj, R_mu, "equal_energy"


# ──────────────────────────────────────────────────────────────────────────────
# Orquestador
# ──────────────────────────────────────────────────────────────────────────────

def run_n2(
    *,
    dtecho:   np.ndarray,
    Vbasal:   np.ndarray,
    gamma_1:  float,
    m_ast:    float,
    T_spec:   np.ndarray,
    Sa_spec_mps2: np.ndarray,
) -> N2Result:
    """
    Ejecuta el pipeline N2 completo con la curva pushover MDOF y el espectro
    elástico del sitio (en m/s²).

    Importante: el espectro debe venir en m/s² (NO en g). Si viene en g,
    multiplica por 9.81 antes de llamar.
    """
    warnings: list[str] = []

    # 1) MDOF → SDOF
    Sd_cap, Sa_cap = mdof_to_sdof(dtecho, Vbasal, gamma_1, m_ast)

    # 2) Truncar al 20% drop
    Sd_util, Sa_util, idx_falla, found = truncate_strength_drop(Sd_cap, Sa_cap)
    if not found:
        warnings.append(
            "La curva pushover no alcanzó el 20% de caída de resistencia. "
            "N2 utiliza la curva disponible; el resultado puede ser no conservador."
        )

    Sd_ultimo = float(Sd_util[-1])
    Sa_max    = float(np.max(Sa_cap))

    # 3) Bilineal equal-energy
    K_star, Say, Sdy, T_star = bilinear_equal_energy(Sd_util, Sa_util)

    # 4) Tc del espectro
    Tc = corner_period_newmark_hall(T_spec, Sa_spec_mps2)

    # 5) Interpolación Sae en T*
    T_arr  = np.asarray(T_spec, dtype=float)
    Sa_arr = np.asarray(Sa_spec_mps2, dtype=float)
    order  = np.argsort(T_arr)
    Sae = float(np.interp(T_star, T_arr[order], Sa_arr[order]))
    Sde = Sae * (T_star / (2.0 * np.pi)) ** 2

    # 6) Punto de desempeño
    Sd_target, R_mu, rule = n2_target_displacement(T_star, Tc, Sae, Say)
    D_target  = gamma_1 * Sd_target
    ductility = max(1.0, Sd_target / Sdy) if Sdy > 0 else 1.0
    is_collapse = Sd_target > Sd_ultimo
    if is_collapse:
        warnings.append(
            f"Sd objetivo ({Sd_target:.4f} m) supera Sd último ({Sd_ultimo:.4f} m) "
            "— el edificio no supera la demanda sísmica."
        )

    # Espectro Sd para ADRS plot
    Sd_spec = Sa_arr * (T_arr / (2.0 * np.pi)) ** 2

    # Bilineal para plot (3 puntos: origen, fluencia, meseta hasta máx(Sd_ult, Sd_obj))
    tail_sd = max(Sd_ultimo, Sd_target, Sdy * 1.05)
    bilinear_sd = [0.0, Sdy, tail_sd]
    bilinear_sa = [0.0, Say, Say]

    Sd_degraded = (
        Sd_cap[idx_falla:].tolist() if idx_falla < len(Sd_cap) - 1 else []
    )
    Sa_degraded = (
        Sa_cap[idx_falla:].tolist() if idx_falla < len(Sa_cap) - 1 else []
    )

    return N2Result(
        gamma_1=float(gamma_1),
        m_ast=float(m_ast),
        Sd_capacity=Sd_cap.tolist(),
        Sa_capacity=Sa_cap.tolist(),
        Sd_useful=Sd_util.tolist(),
        Sa_useful=Sa_util.tolist(),
        Sd_degraded=Sd_degraded,
        Sa_degraded=Sa_degraded,
        idx_falla=int(idx_falla),
        strength_drop_found=bool(found),
        K_star=float(K_star),
        Say=float(Say),
        Sdy=float(Sdy),
        T_star=float(T_star),
        Sa_max=float(Sa_max),
        Sd_ultimo=float(Sd_ultimo),
        T_spec=T_arr.tolist(),
        Sa_spec=Sa_arr.tolist(),
        Sd_spec=Sd_spec.tolist(),
        Tc=float(Tc),
        Sae=float(Sae),
        Sde=float(Sde),
        R_mu=float(R_mu),
        rule=rule,
        Sd_target=float(Sd_target),
        D_target=float(D_target),
        ductility=float(ductility),
        is_collapse=bool(is_collapse),
        bilinear_sd=bilinear_sd,
        bilinear_sa=bilinear_sa,
        warnings=warnings,
    )
