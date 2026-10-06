"""
Diagrama de interacción P-M para muro rectangular.
Barrido de c para generar la envolvente completa.
"""
from __future__ import annotations
import math
from typing import List

from .wall_design_schemas import InteractionDiagram
from .neutral_axis import (
    beta1, compute_forces, _phi_factor, EPSILON_CU
)

N_POINTS = 60  # puntos en el diagrama


def build_interaction_diagram(
    lw_m: float, tw_m: float,
    fc_mpa: float, fy_mpa: float,
    bars: List[dict],
) -> InteractionDiagram:
    """
    Genera la envolvente P-M (nominal y reducida).
    c varía desde muy pequeño (tracción pura) hasta lw×3 (compresión pura).
    """
    Pn_list, Mn_list = [], []
    phiPn_list, phiMn_list = [], []

    # Tensión pura (acero todo en tracción)
    Pu_tens = -sum(b["As"] * fy_mpa / 1000.0 for b in bars)
    Pn_list.append(Pu_tens); Mn_list.append(0.0)
    phiPn_list.append(0.90 * Pu_tens); phiMn_list.append(0.0)

    # Barrido de c
    c_values = []
    # Zona dominada por tensión: c < lw (pequeño)
    for i in range(1, N_POINTS // 2 + 1):
        c_values.append(lw_m * i / (N_POINTS // 2))
    # Zona dominada por compresión: c > lw
    for i in range(1, N_POINTS // 2 + 1):
        c_values.append(lw_m + lw_m * 2.0 * i / (N_POINTS // 2))

    for c in c_values:
        Pn, Mn = compute_forces(c, lw_m, tw_m, fc_mpa, fy_mpa, bars)
        Mn = abs(Mn)
        phi = _phi_factor(c, lw_m, fy_mpa)

        # Límite superior de compresión: 0.80×φ×Pn_max (ACI 318-25 §22.4.2.1)
        Pn_cap_max = 0.85 * fc_mpa * (lw_m * tw_m - sum(b["As"]/1e6 for b in bars)) * 1000 \
                     + fy_mpa * sum(b["As"]/1e6 for b in bars) * 1000
        Pn = min(Pn, Pn_cap_max)

        Pn_list.append(Pn); Mn_list.append(Mn)
        phiPn_list.append(phi * Pn); phiMn_list.append(phi * Mn)

    # Punto de compresión pura (φ = 0.65, aplica 0.80 factor)
    Pn0 = 0.85 * fc_mpa * (lw_m * tw_m) * 1000 + fy_mpa * sum(b["As"] for b in bars) / 1000
    Pn0_max = 0.80 * Pn0  # ACI 318-25 §22.4.2.1
    Pn_list.append(Pn0_max); Mn_list.append(0.0)
    phiPn_list.append(0.65 * Pn0_max); phiMn_list.append(0.0)

    return InteractionDiagram(
        Pn_kN=Pn_list, Mn_kNm=Mn_list,
        phiPn_kN=phiPn_list, phiMn_kNm=phiMn_list,
    )


def is_demand_inside(
    Pu_kN: float, Mu_kNm: float,
    diagram: InteractionDiagram,
) -> bool:
    """
    Verifica si el punto de demanda (Pu, Mu) queda dentro del diagrama φPn-φMn.

    El diagrama es una curva CERRADA generada por barrido de `c`: comienza en
    tensión pura (M=0, P<0), sube hasta el balance (M máximo) y baja hasta
    compresión pura (M=0, P>0). Para un `Pu` dado, hay varios segmentos que
    lo cruzan; el `M_cap` es el MÁXIMO M interpolado sobre esos segmentos.

    Ordenar los puntos por P y luego interpolar es incorrecto: mezcla puntos
    de la rama superior con los ceros de tensión/compresión pura y subestima
    la capacidad, forzando al auto-diseño a escalar refuerzo innecesariamente.
    """
    Pn_list = list(diagram.phiPn_kN)
    Mn_list = list(diagram.phiMn_kNm)
    n = len(Pn_list)
    if n < 2:
        return False

    M_cap = -1.0
    for i in range(n - 1):
        P0, M0 = Pn_list[i], Mn_list[i]
        P1, M1 = Pn_list[i + 1], Mn_list[i + 1]
        lo, hi = (P0, P1) if P0 <= P1 else (P1, P0)
        if lo <= Pu_kN <= hi:
            if P1 == P0:
                M_at = max(M0, M1)
            else:
                t = (Pu_kN - P0) / (P1 - P0)
                M_at = M0 + t * (M1 - M0)
            if M_at > M_cap:
                M_cap = M_at

    if M_cap < 0:
        return False
    return Mu_kNm <= M_cap
