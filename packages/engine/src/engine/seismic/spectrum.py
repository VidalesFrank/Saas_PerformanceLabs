"""Calculo del espectro elastico de diseno NSR-10 (Titulo A, Capitulo A.2).

Implementa las formulas de A.2.6 para Sa(T), mas los espectros derivados
de desplazamiento Sd(T) y pseudo-velocidad Sv(T).

Convenio de unidades publico:
  Aa, Av  → adimensional (fraccion de g)
  Sa      → adimensional (fraccion de g)
  Sd      → cm
  Sv      → cm/s
  T       → segundos
"""

from __future__ import annotations

import numpy as np

from .nsr10_data import FA_TABLE, FV_TABLE, _AA_BREAKS, _AV_BREAKS

_G_CM_S2 = 980.665  # cm/s²

# Coeficiente de importancia I — NSR-10 A.2.5.2 (Tabla A.2.5-1)
# Valores vigentes según el ajuste reglamentario del NSR-10.
USE_GROUP_I: dict[str, float] = {
    "I":   1.00,  # Grupo I — Estructuras de ocupación normal
    "II":  1.10,  # Grupo II — Estructuras de ocupación especial
    "III": 1.25,  # Grupo III — Edificaciones de atención a la comunidad
    "IV":  1.40,  # Grupo IV — Edificaciones indispensables
}

USE_GROUP_LABEL: dict[str, str] = {
    "I":   "Grupo I — Ocupación normal",
    "II":  "Grupo II — Ocupación especial",
    "III": "Grupo III — Atención a la comunidad",
    "IV":  "Grupo IV — Edificaciones indispensables",
}


def importance_factor(use_group: str) -> float:
    """Devuelve el coeficiente de importancia I según el grupo de uso NSR-10."""
    try:
        return USE_GROUP_I[use_group]
    except KeyError as exc:
        raise ValueError(
            f"Grupo de uso '{use_group}' no válido. Use I, II, III o IV."
        ) from exc


def get_site_factors(Aa: float, Av: float, soil_type: str) -> tuple[float, float]:
    """Interpola Fa y Fv de las Tablas A.2.4-1/2 del NSR-10.

    Para suelo F (estudio especifico) lanza ValueError porque no hay tablas.
    Clamping: Aa/Av fuera del rango [0.10, 0.30] usan los extremos de la tabla.
    """
    if soil_type == "F":
        raise ValueError(
            "Perfil de suelo tipo F requiere estudio de sitio especifico (NSR-10 A.2.5.4). "
            "No se puede calcular el espectro con las tablas estandar."
        )
    if soil_type not in FA_TABLE:
        raise ValueError(f"Tipo de suelo '{soil_type}' no valido. Use A, B, C, D, E o F.")

    Fa = float(np.interp(Aa, _AA_BREAKS, FA_TABLE[soil_type]))
    Fv = float(np.interp(Av, _AV_BREAKS, FV_TABLE[soil_type]))
    return Fa, Fv


def spectral_parameters(Aa: float, Av: float, Fa: float, Fv: float) -> dict[str, float]:
    """Parametros del espectro de diseno NSR-10 A.2.6.

    Retorna: SDs, SD1, T0, Ts, TL (todos en sus unidades naturales: g y s).
    TL = 4.0 s (valor estandar NSR-10, verificar Tabla A.2.6-1 para cada zona).
    """
    SDs = 2.5 * Aa * Fa
    SD1 = Av * Fv
    if SDs <= 0:
        raise ValueError("SDs = 0: revise los coeficientes Aa y Fa.")
    Ts = SD1 / SDs
    T0 = 0.2 * Ts
    TL = 4.0
    return {"SDs": round(SDs, 4), "SD1": round(SD1, 4), "T0": round(T0, 4), "Ts": round(Ts, 4), "TL": TL}


def _sa_at_T(T: float, SDs: float, SD1: float, T0: float, Ts: float, TL: float) -> float:
    """Sa(T) en fraccion de g, formula NSR-10 A.2.6."""
    if T <= 0:
        return 0.4 * SDs
    if T <= T0:
        return SDs * (0.4 + 0.6 * T / T0)
    if T <= Ts:
        return SDs
    if T <= TL:
        return SD1 / T
    return SD1 * TL / (T * T)


def compute_spectrum(
    Aa: float,
    Av: float,
    soil_type: str,
    T_max: float = 4.0,
    n_points: int = 300,
    use_group: str = "I",
) -> dict:
    """Calcula el espectro elastico completo NSR-10, multiplicado por el
    coeficiente de importancia I del grupo de uso (A.2.5.2).

    Retorna un dict con:
      - params: SDs, SD1, T0, Ts, TL, Fa, Fv, I, use_group
      - puntos: lista de {T, Sa, Sd, Sv} — todos ya multiplicados por I
      - zona_sismica: "baja" | "intermedia" | "alta"
    """
    from .nsr10_data import zona_sismica

    Fa, Fv = get_site_factors(Aa, Av, soil_type)
    I = importance_factor(use_group)
    params = spectral_parameters(Aa, Av, Fa, Fv)
    SDs, SD1, T0, Ts, TL = params["SDs"], params["SD1"], params["T0"], params["Ts"], params["TL"]

    # Puntos T: densos en zonas de quiebre + uniformes hasta T_max
    key_Ts = [0.0, T0 * 0.5, T0, (T0 + Ts) / 2, Ts, Ts * 1.5, TL, T_max]
    key_Ts = [t for t in key_Ts if 0 <= t <= T_max]
    T_uniform = np.linspace(0.0, T_max, n_points).tolist()
    T_all = sorted(set([round(t, 6) for t in T_uniform + key_Ts]))

    puntos = []
    for T in T_all:
        Sa = _sa_at_T(T, SDs, SD1, T0, Ts, TL) * I
        # Sd = Sa * g * T² / (4π²)  [cm]
        Sd = Sa * _G_CM_S2 * T**2 / (4 * np.pi**2) if T > 0 else 0.0
        # Sv = Sa * g * T / (2π)    [cm/s]
        Sv = Sa * _G_CM_S2 * T / (2 * np.pi) if T > 0 else 0.0
        puntos.append({
            "T": round(T, 5),
            "Sa": round(Sa, 6),
            "Sd": round(Sd, 4),
            "Sv": round(Sv, 4),
        })

    return {
        "params": {
            **params,
            "Fa": round(Fa, 4),
            "Fv": round(Fv, 4),
            "I": round(I, 2),
            "use_group": use_group,
        },
        "puntos": puntos,
        "zona_sismica": zona_sismica(Aa),
    }


def compute_spectrum_from_params(
    SDs: float,
    SD1: float,
    T0: float,
    Ts: float,
    TL: float = 4.0,
    T_max: float = 4.0,
    n_points: int = 300,
    use_group: str = "I",
) -> dict:
    """Calcula el espectro elastico directamente desde parametros espectrales,
    multiplicado por el coeficiente de importancia I del grupo de uso.

    Util para espectros de microzonificacion donde Fa/Fv no corresponden
    a las tablas estandar NSR-10 sino a valores especificos de cada zona.

    Retorna un dict con:
      - params: SDs, SD1, T0, Ts, TL, I, use_group
      - puntos: lista de {T, Sa, Sd, Sv} — ya multiplicados por I
    """
    I = importance_factor(use_group)
    key_Ts = [0.0, T0 * 0.5, T0, (T0 + Ts) / 2, Ts, Ts * 1.5, TL, T_max]
    key_Ts = [t for t in key_Ts if 0 <= t <= T_max]
    T_uniform = np.linspace(0.0, T_max, n_points).tolist()
    T_all = sorted(set([round(t, 6) for t in T_uniform + key_Ts]))

    puntos = []
    for T in T_all:
        Sa = _sa_at_T(T, SDs, SD1, T0, Ts, TL) * I
        Sd = Sa * _G_CM_S2 * T**2 / (4 * np.pi**2) if T > 0 else 0.0
        Sv = Sa * _G_CM_S2 * T / (2 * np.pi) if T > 0 else 0.0
        puntos.append({
            "T": round(T, 5),
            "Sa": round(Sa, 6),
            "Sd": round(Sd, 4),
            "Sv": round(Sv, 4),
        })

    return {
        "params": {
            "SDs": round(SDs, 4),
            "SD1": round(SD1, 4),
            "T0": round(T0, 4),
            "Ts": round(Ts, 4),
            "TL": TL,
            "I":   round(I, 2),
            "use_group": use_group,
        },
        "puntos": puntos,
    }
