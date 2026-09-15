"""Ductilidad y longitud de rótula plástica (Lp) — post-procesamiento de M-φ.

A partir de una MomentCurvatureResult ya calculada, deriva:

  · Idealización bilineal (Priestley 2007, Sec. 4.2.5):
      φy_ideal = φy' · (Mn / My')
    donde φy' y My' son curvatura y momento en primera fluencia (barra o
    fibra crítica del concreto). Mn = momento nominal (Mmax).

  · Longitud de rótula plástica Lp (varios métodos):
      - Priestley et al. 2007 (default):  Lp = k·L + Lsp
                                          k  = min(0.2·(fu/fy − 1), 0.08)
                                          Lsp = 0.022·fy·db (strain penetration)
      - Paulay & Priestley 1992:          Lp = 0.08·L + 6·db
      - Baker 1956 simplificado:          Lp = 0.5·d
      - ATC-32 / Caltrans:                Lp = 0.08·L + 0.15·fy·db (fy en ksi)

  · Ductilidad de miembro μΔ (Priestley 2007, Ec. 4.30):
      μΔ = 1 + 3·(μφ − 1)·(Lp/L)·(1 − 0.5·Lp/L)
    Válida cuando Lp << L (columnas/vigas esbeltas). Para Lp/L > 0.5 la
    aproximación degrada; en ese caso usar la versión integrada exacta.

  · Energía disipada Eh = ∫₀^φu M(φ) dφ  (área bajo la curva M-φ hasta falla).

Referencias primarias:
  - Priestley, Calvi & Kowalsky (2007), "Displacement-Based Seismic Design of
    Structures", Sec. 4.2.
  - Paulay & Priestley (1992), "Seismic Design of Reinforced Concrete and
    Masonry Buildings", Sec. 3.5.
  - Baker (1956), "The Ultimate Load Theory Applied to the Design of Reinforced
    and Prestressed Concrete Frames".
  - ASCE 41-17, Ch. 10 — evaluación por desempeño.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Literal

import numpy as np

from engine.analysis.moment_curvature import MomentCurvatureResult


LpMethod = Literal["priestley_2007", "paulay_priestley", "baker", "atc_32"]


@dataclass(frozen=True)
class DuctilityMetrics:
    """Métricas de ductilidad e idealización bilineal a partir de una curva M-φ."""
    # ── Idealización bilineal ──
    phi_yield_ideal:   float     # [1/mm]  φy idealizado (Priestley)
    moment_yield_ideal: float    # [N·mm]  My idealizado (= Mn en Priestley)
    phi_ultimate:      float     # [1/mm]  φu (curvatura de falla, tomada del engine)
    moment_ultimate:   float     # [N·mm]  M en φu

    # ── Ductilidades ──
    mu_phi:            float     # μφ = φu / φy_ideal  (ductilidad de curvatura)
    mu_delta:          float     # μΔ = ductilidad de desplazamiento (nivel miembro)

    # ── Longitud rótula plástica ──
    Lp_mm:             float
    Lp_method:         str
    Lp_over_L:         float     # Lp / L, útil para juzgar validez de la fórmula μΔ

    # ── Energía ──
    energy_kNm_per_m:  float     # ∫ M dφ hasta φu, en (kN·m)·(1/m) = kN

    # ── Notas de la evaluación ──
    notes:             list[str] = field(default_factory=list)


# ─────────────────────────────────────────────────────────────────────────────
# Longitud de rótula plástica — varios métodos
# ─────────────────────────────────────────────────────────────────────────────

def plastic_hinge_length(
    L_mm: float,
    db_mm: float,
    fy_MPa: float,
    section_depth_mm: float,
    method: LpMethod = "priestley_2007",
    fu_over_fy: float = 1.35,
) -> tuple[float, str, str]:
    """Calcula Lp según el método seleccionado.

    Retorna (Lp [mm], nombre del método, referencia bibliográfica).
    """
    L  = max(L_mm, 1.0)
    db = max(db_mm, 1.0)
    d  = max(section_depth_mm, 1.0)
    fy = max(fy_MPa, 1.0)

    if method == "priestley_2007":
        # Lp = k·L + Lsp,  k = min(0.2·(fu/fy − 1), 0.08)
        k   = min(0.2 * (fu_over_fy - 1.0), 0.08)
        Lsp = 0.022 * fy * db
        Lp  = k * L + Lsp
        return Lp, "Priestley 2007", "Displacement-Based Seismic Design, Ec. 4.31"

    if method == "paulay_priestley":
        Lp = 0.08 * L + 6.0 * db
        return Lp, "Paulay & Priestley 1992", "Sec. 3.5.4 (Ec. 3.54)"

    if method == "baker":
        Lp = 0.5 * d
        return Lp, "Baker 1956 (simplificado)", "Ultimate Load Theory"

    if method == "atc_32":
        # ATC-32/Caltrans (Priestley 1996): fy en ksi (÷ 6.89)
        fy_ksi = fy / 6.89
        Lp = 0.08 * L + 0.15 * fy_ksi * db     # resultado en mm cuando db en mm
        return Lp, "ATC-32 / Caltrans", "Priestley et al. 1996"

    raise ValueError(f"Método desconocido: {method!r}")


# ─────────────────────────────────────────────────────────────────────────────
# Ductilidad de desplazamiento μΔ
# ─────────────────────────────────────────────────────────────────────────────

def displacement_ductility(mu_phi: float, Lp: float, L: float) -> float:
    """Convierte ductilidad de curvatura → ductilidad de desplazamiento (Priestley Ec. 4.30).

    μΔ = 1 + 3·(μφ − 1)·(Lp/L)·(1 − 0.5·Lp/L)

    Válida para elementos en voladizo bajo carga concentrada en el extremo (o
    equivalente). Para vigas doblemente empotradas usar la mitad de la luz L/2.
    """
    if L <= 0 or Lp <= 0 or mu_phi <= 1:
        return 1.0
    ratio = Lp / L
    return 1.0 + 3.0 * (mu_phi - 1.0) * ratio * (1.0 - 0.5 * ratio)


# ─────────────────────────────────────────────────────────────────────────────
# Idealización bilineal — Priestley 2007
# ─────────────────────────────────────────────────────────────────────────────

def _first_yield_from_curve(curve: list) -> tuple[float, float]:
    """Estima (φy', My') = primer punto donde el momento supera 0.7·Mmax.

    Es una aproximación al 'primera fluencia' cuando no se rastrea la barra
    crítica directamente. Priestley recomienda tomar el punto donde la barra
    más traccionada alcanza εy; a nivel de curva M-φ post-procesada, el 70% de
    Mmax es una buena aproximación empírica para columnas típicas.
    """
    if not curve:
        return 0.0, 0.0
    m_max = max(p.moment for p in curve)
    threshold = 0.7 * m_max
    for p in curve:
        if p.moment >= threshold:
            return p.phi, p.moment
    return curve[-1].phi, curve[-1].moment


def _priestley_bilinear(mc: MomentCurvatureResult) -> tuple[float, float]:
    """Idealización Priestley (Ec. 4.4): φy_ideal = φy' · (Mn / My').

    Extiende la recta desde origen pasando por (φy', My') hasta que M = Mn (Mmax).
    """
    phi_y_prime, m_y_prime = _first_yield_from_curve(mc.curve)
    if m_y_prime <= 0:
        return mc.phi_yield, mc.moment_yield
    mn = mc.moment_max
    phi_y_ideal = phi_y_prime * (mn / m_y_prime)
    return phi_y_ideal, mn


# ─────────────────────────────────────────────────────────────────────────────
# Energía disipada
# ─────────────────────────────────────────────────────────────────────────────

def hysteretic_energy_capacity(mc: MomentCurvatureResult) -> float:
    """∫ M dφ desde 0 hasta φu, usando regla del trapecio.

    Retorna [N·mm · 1/mm] = N — es una energía por unidad de longitud del
    elemento (necesita multiplicarse por longitud efectiva Lp para obtener
    energía total absorbida por la rótula plástica).
    """
    if not mc.curve:
        return 0.0
    phis = np.array([p.phi for p in mc.curve])
    moms = np.array([p.moment for p in mc.curve])
    if len(phis) < 2:
        return 0.0
    return float(np.trapezoid(moms, phis))


# ─────────────────────────────────────────────────────────────────────────────
# Función principal
# ─────────────────────────────────────────────────────────────────────────────

def compute_ductility_metrics(
    mc:             MomentCurvatureResult,
    member_length_mm: float,
    db_long_mm:     float = 25.4,
    fy_MPa:         float = 420.0,
    section_depth_mm: float = 400.0,
    Lp_method:      LpMethod = "priestley_2007",
    fu_over_fy:     float = 1.35,
) -> DuctilityMetrics:
    """Deriva métricas de ductilidad de un análisis M-φ.

    Args:
        mc:                 resultado de compute_moment_curvature.
        member_length_mm:   longitud efectiva del miembro (voladizo ≈ altura de
                            entrepiso; viga doblemente empotrada ≈ luz/2).
        db_long_mm:         diámetro de barra longitudinal (para Lsp).
        fy_MPa:             fluencia del acero.
        section_depth_mm:   canto útil (para Baker).
        Lp_method:          método de cálculo de Lp.
        fu_over_fy:         relación fu/fy del acero (typ. 1.25–1.50).
    """
    notes: list[str] = []

    # ── Idealización bilineal Priestley ──
    phi_y_ideal, m_y_ideal = _priestley_bilinear(mc)
    phi_u = mc.phi_ultimate if mc.phi_ultimate > 0 else mc.phi_max
    m_u   = mc.moment_ultimate if mc.moment_ultimate > 0 else mc.moment_max
    mu_phi = phi_u / phi_y_ideal if phi_y_ideal > 0 else 1.0

    # ── Longitud de rótula plástica ──
    Lp, method_name, ref = plastic_hinge_length(
        member_length_mm, db_long_mm, fy_MPa, section_depth_mm,
        method=Lp_method, fu_over_fy=fu_over_fy,
    )
    Lp_over_L = Lp / member_length_mm if member_length_mm > 0 else 0.0

    if Lp_over_L > 0.30:
        notes.append(f"Lp/L = {Lp_over_L:.2f} > 0.30 — la aproximación μΔ de "
                     "Priestley pierde precisión; considerar análisis integrado.")

    # ── Ductilidad de miembro ──
    mu_delta = displacement_ductility(mu_phi, Lp, member_length_mm)

    # ── Energía disipada ──
    energy_N = hysteretic_energy_capacity(mc)
    # Reportar en kN — el resultado ∫M dφ tiene unidades N (N·mm × 1/mm)
    energy_kN = energy_N / 1000.0

    if not mc.failure_reached:
        notes.append("La curva M-φ no alcanzó el criterio de falla (80% Mmax); "
                     "φu es el último punto barrido — los valores son cotas inferiores.")

    return DuctilityMetrics(
        phi_yield_ideal=phi_y_ideal,
        moment_yield_ideal=m_y_ideal,
        phi_ultimate=phi_u,
        moment_ultimate=m_u,
        mu_phi=mu_phi,
        mu_delta=mu_delta,
        Lp_mm=Lp,
        Lp_method=f"{method_name} — {ref}",
        Lp_over_L=Lp_over_L,
        energy_kNm_per_m=energy_kN,
        notes=notes,
    )
