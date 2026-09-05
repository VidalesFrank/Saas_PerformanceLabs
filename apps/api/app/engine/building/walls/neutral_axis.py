"""
Eje neutro de un muro de concreto reforzado rectangular.
Bloque de Whitney. Perfil de deformaciones plano (Bernoulli).

Convenio: x=0 en el extremo de compresión (izquierdo).
          c medido desde x=0 hacia la fibra de tensión.
          Compresión POSITIVA en fuerzas.
"""
from __future__ import annotations
import math
from typing import List

from .wall_design_schemas import WallReinforcement, NeutralAxisResult

EPSILON_CU = 0.003
ES_MPA = 200_000.0
N_CONCRETE_FIBERS = 100


def beta1(fc_mpa: float) -> float:
    """Factor del bloque de Whitney (ACI 318-25 §22.2.2.4.3)."""
    b1 = 0.85 - 0.05 * max(fc_mpa - 28.0, 0.0) / 7.0
    return max(b1, 0.65)


def _concrete_force(fc_mpa: float, a_m: float, lw_m: float, tw_m: float) -> tuple:
    """
    Fuerza y brazo del bloque de compresión de Whitney.
    Returns (Cc_kN, xc_m) donde xc es la posición del centroide desde x=0.
    a_m: profundidad del bloque (puede ser > lw_m, se trunca a lw_m)
    """
    a_eff = min(a_m, lw_m)
    Cc = 0.85 * fc_mpa * a_eff * tw_m * 1000.0  # kN
    xc = a_eff / 2.0
    return Cc, xc


def _strain_at(x_m: float, c_m: float) -> float:
    """Deformación en posición x desde el extremo comprimido."""
    if c_m <= 0:
        return -EPSILON_CU
    return EPSILON_CU * (c_m - x_m) / c_m


def _steel_force(bar: dict, c_m: float, fy_mpa: float) -> tuple:
    """
    Fuerza (kN, + compresión) y posición de una barra.
    bar: {"x": x_m, "As": As_mm2}
    """
    eps = _strain_at(bar["x"], c_m)
    fs = max(min(eps * ES_MPA, fy_mpa), -fy_mpa)  # positivo = compresión
    Fs = bar["As"] * fs / 1000.0  # kN, positivo = compresión
    return Fs, bar["x"]


def compute_forces(
    c_m: float,
    lw_m: float, tw_m: float,
    fc_mpa: float, fy_mpa: float,
    bars: List[dict],
) -> tuple:
    """
    ΣF axial (kN, + compresión) y momento (kN·m, respecto al centroide de la sección).
    """
    b1 = beta1(fc_mpa)
    a_m = b1 * c_m
    Cc, xc = _concrete_force(fc_mpa, a_m, lw_m, tw_m)

    P = Cc
    M = Cc * (lw_m / 2.0 - xc)  # momento respecto al centroide (lw/2)

    for bar in bars:
        Fs, xs = _steel_force(bar, c_m, fy_mpa)
        P += Fs
        M += Fs * (lw_m / 2.0 - xs)  # positivo si barra en zona de compresión

    return P, M


def _phi_factor(c_m: float, lw_m: float, fy_mpa: float, is_tied: bool = True) -> float:
    """
    Factor φ de reducción de resistencia (ACI 318-25 §21.2.2).
    Basado en la deformación de la barra más lejana en tensión.
    """
    eps_t = _strain_at(lw_m, c_m)  # deformación en fibra extrema de tensión
    eps_y = fy_mpa / ES_MPA
    phi_comp = 0.65 if is_tied else 0.75
    phi_tens = 0.90
    if eps_t >= 0.005:
        return phi_tens
    if eps_t <= eps_y:
        return phi_comp
    # Transición lineal
    return phi_comp + (phi_tens - phi_comp) * (eps_t - eps_y) / (0.005 - eps_y)


def find_neutral_axis(
    Pu_kN: float,
    lw_m: float, tw_m: float,
    fc_mpa: float, fy_mpa: float,
    bars: List[dict],
    tol: float = 0.5,  # kN de tolerancia
    max_iter: int = 100,
) -> NeutralAxisResult:
    """
    Encuentra c tal que ΣF(c) = Pu mediante bisección.
    Si Pu > P_max_compresión → falla por aplastamiento.
    Si Pu < P_mín_tensión → falla por tracción pura.
    """
    # Límites de bisección
    c_min = 1e-4  # m (casi tracción pura)
    c_max = lw_m * 3.0  # m (más que toda la sección comprimida)

    P_at_max, _ = compute_forces(c_max, lw_m, tw_m, fc_mpa, fy_mpa, bars)
    P_at_min, _ = compute_forces(c_min, lw_m, tw_m, fc_mpa, fy_mpa, bars)

    # Si Pu está fuera del rango de la sección
    if Pu_kN > P_at_max:
        c_sol = c_max
        P_sol, M_sol = compute_forces(c_sol, lw_m, tw_m, fc_mpa, fy_mpa, bars)
        b1 = beta1(fc_mpa)
        return NeutralAxisResult(
            c_m=c_sol, a_m=b1 * c_sol, beta1=b1,
            Pn_kN=P_sol, Mn_kNm=abs(M_sol),
            phi_flexure=0.65,
            phiPn_kN=0.65 * P_sol,
            phiMn_kNm=0.65 * abs(M_sol),
            steel_strains=[_strain_at(b["x"], c_sol) for b in bars],
            ok=False, message="Carga axial supera la capacidad a compresión pura"
        )

    # Bisección
    for _ in range(max_iter):
        c_mid = (c_min + c_max) / 2.0
        P_mid, _ = compute_forces(c_mid, lw_m, tw_m, fc_mpa, fy_mpa, bars)
        if abs(P_mid - Pu_kN) < tol:
            break
        if P_mid > Pu_kN:
            c_max = c_mid
        else:
            c_min = c_mid
    else:
        c_mid = (c_min + c_max) / 2.0

    c_sol = c_mid
    Pn, Mn = compute_forces(c_sol, lw_m, tw_m, fc_mpa, fy_mpa, bars)
    Mn = abs(Mn)
    b1 = beta1(fc_mpa)
    phi = _phi_factor(c_sol, lw_m, fy_mpa)
    strains = [_strain_at(b["x"], c_sol) for b in bars]

    return NeutralAxisResult(
        c_m=c_sol, a_m=b1 * c_sol, beta1=b1,
        Pn_kN=Pn, Mn_kNm=Mn,
        phi_flexure=phi,
        phiPn_kN=phi * Pn,
        phiMn_kNm=phi * Mn,
        steel_strains=strains,
        ok=True, message=""
    )
