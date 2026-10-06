"""
InfillPanel + geometría del puntal equivalente.

Modelo: dos diagonales cruzadas tipo Truss entre las 4 esquinas del panel.
Cada diagonal solo trabaja a compresión (Concrete01), lo cual reproduce el
comportamiento del puntal equivalente bidireccional durante pushover cíclico.

Ancho efectivo del puntal:
    b_strut = width_ratio · L_diagonal

    donde:
        L_diagonal = √(L_panel² + H_panel²)
        width_ratio ∈ [0.05, 0.50], default 0.25 (Mainstone simplificado).

Reducción por aberturas (Al-Chaar 2002):
    λ = 1 - 2·ρ^0.54 + ρ^1.14

    donde ρ = A_abertura / A_panel = opening_ratio ∈ [0, 1].
    Para ρ = 0 → λ = 1.0 (sin reducción).
    Para ρ = 1 → λ = 0.0 (panel completamente abierto = no aporta).
"""
from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class InfillPanel:
    """
    Definición inmutable de un panel de infill.

    Attributes:
        panel_id: Identificador único del panel (ej. "INF-001").
        pier: Pier ETABS al que se asocia (bay definido por columnas del pier).
        story: Story ETABS al que pertenece.
        thickness_m: Espesor del panel (m).
        masonry_material_id: id del material en canonical_model["masonryMaterials"].
        opening_ratio: A_abertura/A_panel ∈ [0, 1]. 0 = sin abertura.
        width_ratio: Ancho efectivo del puntal como fracción de la diagonal.
                     Default 0.25 (Mainstone simplificado).
    """
    panel_id: str
    pier: str
    story: str
    thickness_m: float
    masonry_material_id: str
    opening_ratio: float = 0.0
    width_ratio: float = 0.25

    def validate(self) -> None:
        if self.thickness_m <= 0:
            raise ValueError(f"thickness_m debe ser > 0 (got {self.thickness_m})")
        if not (0.0 <= self.opening_ratio <= 1.0):
            raise ValueError(f"opening_ratio ∈ [0,1] (got {self.opening_ratio})")
        if not (0.05 <= self.width_ratio <= 0.50):
            raise ValueError(f"width_ratio ∈ [0.05, 0.50] (got {self.width_ratio})")


def strut_geometry(
    L_panel_m: float,
    H_panel_m: float,
    thickness_m: float,
    width_ratio: float = 0.25,
    opening_ratio: float = 0.0,
) -> dict:
    """
    Calcula geometría del puntal equivalente para un panel dado.

    Retorna dict con:
        diagonal_m       : longitud de la diagonal del panel
        effective_width_m: ancho del puntal antes de reducción
        area_gross_m2    : área bruta = eff_width · thickness
        lambda_openings  : factor de reducción Al-Chaar
        area_effective_m2: área final del puntal = area_gross · lambda
        angle_rad        : ángulo de la diagonal respecto a la horizontal
    """
    if L_panel_m <= 0 or H_panel_m <= 0:
        raise ValueError(f"L y H deben ser > 0 (L={L_panel_m}, H={H_panel_m})")
    diag = math.hypot(L_panel_m, H_panel_m)
    eff_w = diag * width_ratio
    A_gross = eff_w * thickness_m
    lam = al_chaar_reduction(opening_ratio)
    A_eff = A_gross * lam
    angle = math.atan2(H_panel_m, L_panel_m)
    return {
        "diagonal_m":        diag,
        "effective_width_m": eff_w,
        "area_gross_m2":     A_gross,
        "lambda_openings":   lam,
        "area_effective_m2": A_eff,
        "angle_rad":         angle,
    }


def al_chaar_reduction(opening_ratio: float) -> float:
    """
    Factor de reducción del ancho efectivo por presencia de aberturas.

    Fuente: Al-Chaar, G. (2002). "Evaluating strength and stiffness of
    unreinforced masonry infill structures." ERDC/CERL TR-02-1.

    λ = 1 - 2·ρ^0.54 + ρ^1.14

    Comportamiento:
        ρ = 0.00 → λ = 1.000
        ρ = 0.10 → λ ≈ 0.496
        ρ = 0.20 → λ ≈ 0.321
        ρ = 0.30 → λ ≈ 0.210
        ρ = 0.50 → λ ≈ 0.078
        ρ = 1.00 → λ = 0.000
    """
    r = max(0.0, min(1.0, float(opening_ratio)))
    if r == 0.0:
        return 1.0
    if r >= 1.0:
        return 0.0
    lam = 1.0 - 2.0 * r ** 0.54 + r ** 1.14
    return max(0.0, lam)
