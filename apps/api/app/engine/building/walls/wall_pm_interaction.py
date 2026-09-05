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
    Usa interpolación lineal segmentada de la envolvente.
    """
    # Para cada nivel P, busca el Mn máximo en la envolvente reducida
    pts = list(zip(diagram.phiPn_kN, diagram.phiMn_kNm))
    # Ordena por P (de menor a mayor)
    pts.sort(key=lambda p: p[0])

    # Busca el momento máximo a nivel Pu por interpolación
    phi_P_vals = [p[0] for p in pts]
    phi_M_vals = [p[1] for p in pts]

    if Pu_kN < phi_P_vals[0] or Pu_kN > phi_P_vals[-1]:
        return False

    # Interpolación lineal
    for i in range(len(pts) - 1):
        P0, M0 = pts[i]
        P1, M1 = pts[i + 1]
        if P0 <= Pu_kN <= P1:
            t = (Pu_kN - P0) / (P1 - P0) if P1 != P0 else 0.0
            M_cap = M0 + t * (M1 - M0)
            return Mu_kNm <= M_cap
    return False
