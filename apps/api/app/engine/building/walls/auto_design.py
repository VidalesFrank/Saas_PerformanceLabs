"""
Propuesta automática de refuerzo para muros RC rectangulares.
Algoritmo iterativo: mínimos → cortante → interacción P-M → EBE → confinamiento.
"""
from __future__ import annotations
import math
from typing import List, Optional

from .wall_design_schemas import (
    WallDemandCombo, WallReinforcement, BoundaryZoneReinf, WebZoneReinf,
    bar_area, STANDARD_DIAMETERS_MM,
)
from .neutral_axis import find_neutral_axis
from .wall_pm_interaction import build_interaction_diagram, is_demand_inside
from .boundary_element import check_boundary_element
from .confinement import design_confinement
from .shear_design import design_shear

RHO_MIN = 0.0025
PHI_FLEX = 0.65  # arranque conservador (compresión)


def _next_bar_size(db_mm: float) -> float:
    """Siguiente diámetro estándar hacia arriba."""
    for d in STANDARD_DIAMETERS_MM:
        if d > db_mm + 0.01:
            return d
    return db_mm


def _select_web_reinforcement(
    lw_m: float, tw_m: float, hw_m: float,
    fc_mpa: float, fyt_mpa: float,
    Vu_kN: float,
    ductility: str,
) -> WebZoneReinf:
    """
    Selecciona refuerzo mínimo del alma que satisface cortante.
    Empieza con #4@300mm (ρ ≈ 0.0028) y escala si es necesario.
    """
    from .shear_design import RHO_MIN_WEB

    # Cuantía requerida por cortante (iteración)
    Acv = lw_m * tw_m
    hw_lw = hw_m / lw_m
    alpha_c = 0.25 if hw_lw <= 1.5 else (0.17 if hw_lw >= 2.0 else 0.25 - 0.08 * (hw_lw - 1.5) / 0.5)

    # Vn_min = φ·Acv·1000·(αc·√f'c + ρmin·fyt) ≥ Vu
    Vn_min = 0.75 * Acv * 1000 * (alpha_c * math.sqrt(fc_mpa) + RHO_MIN_WEB * fyt_mpa)
    if Vn_min >= Vu_kN:
        rho_h_req = RHO_MIN_WEB
    else:
        rho_h_req = (Vu_kN / (0.75 * Acv * 1000.0) - alpha_c * math.sqrt(fc_mpa)) / fyt_mpa
        rho_h_req = max(rho_h_req, RHO_MIN_WEB)

    # Selecciona barra y espaciado (2 cortinas)
    n_curtains = 2
    db = 12.7  # valor por defecto si no hay iteración válida
    spacing = 300.0
    for db_try in [12.7, 15.9, 19.1]:
        A_bar = bar_area(db_try)
        sp = n_curtains * A_bar / (rho_h_req * tw_m * 1e6) * 1000  # mm
        sp = min(sp, 300.0 if ductility == "DES" else 450.0)
        sp = max(sp, 100.0)
        rho_prov = n_curtains * A_bar / (sp / 1000 * tw_m * 1e6)
        if rho_prov >= rho_h_req:
            db = db_try
            spacing = sp
            break

    rho_v_min = max(RHO_MIN_WEB, rho_h_req if hw_lw < 2.0 else RHO_MIN_WEB)
    db_v = db
    spacing_v_m = n_curtains * bar_area(db_v) / (rho_v_min * tw_m * 1e6)
    spacing_v_mm = min(max(spacing_v_m * 1000, 100.0), 300.0 if ductility == "DES" else 450.0)

    return WebZoneReinf(
        vert_db_mm=db_v, vert_spacing_mm=spacing_v_mm,
        horiz_db_mm=db, horiz_spacing_mm=spacing,
        n_curtains=n_curtains,
    )


def auto_design(
    lw_m: float, tw_m: float, hw_m: float,
    fc_mpa: float, fy_mpa: float, fyt_mpa: float,
    demands: List[WallDemandCombo],
    ductility: str = "DES",
    cover_mm: float = 40.0,
    delta_u_hw: Optional[float] = None,
) -> WallReinforcement:
    """
    Propone el refuerzo mínimo que satisface todos los requisitos.
    """
    # Combinación gobernante: mayor Mu con la compresión más baja (crítica para EBE)
    gov = max(demands, key=lambda d: d.Mu_kNm)
    Vu_max = max(d.Vu_kN for d in demands)

    # 1. Refuerzo del alma
    web = _select_web_reinforcement(lw_m, tw_m, hw_m, fc_mpa, fyt_mpa, Vu_max, ductility)

    # 2. Revisión preliminar de EBE (método de esfuerzo)
    be_check_prelim = check_boundary_element(
        gov.Pu_kN, gov.Mu_kNm, lw_m, tw_m, hw_m, fc_mpa,
        c_m=lw_m * 0.3,  # estimación inicial del eje neutro
        ductility=ductility,
        delta_u_hw=delta_u_hw,
    )
    ebe_required = be_check_prelim.required

    # 3. Diseño del elemento de borde longitudinal
    # Empieza con mínimo (4-#5) y escala hasta satisfacer P-M
    db_be = 15.9  # #5 inicial
    n_be = 4      # mínimo 4 barras por elemento de borde
    lc = max(be_check_prelim.lc_m, 0.3) if ebe_required else max(tw_m, 0.3)  # mínimo un espesor

    for _ in range(20):  # iteración de escalado de refuerzo
        be_left = BoundaryZoneReinf(
            n_bars=n_be, db_mm=db_be,
            cover_mm=cover_mm, tie_db_mm=9.5,
            tie_spacing_mm=100.0 if ductility == "DES" else 150.0,
            length_m=lc,
        )
        reinf = WallReinforcement(be_left=be_left, web=web, be_right=be_left, symmetric=True)
        bars = reinf.all_bars(lw_m, tw_m, cover_mm)

        # Revisar interacción P-M para todas las combinaciones
        diag = build_interaction_diagram(lw_m, tw_m, fc_mpa, fy_mpa, bars)
        all_inside = all(is_demand_inside(d.Pu_kN, d.Mu_kNm, diag) for d in demands)

        if all_inside:
            break

        # Escalar: primero aumentar número de barras, luego diámetro
        if n_be < 12:
            n_be += 2
        else:
            db_be = _next_bar_size(db_be)
            n_be = 4  # reset al aumentar diámetro

    # 4. Eje neutro real con el refuerzo propuesto
    na = find_neutral_axis(gov.Pu_kN, lw_m, tw_m, fc_mpa, fy_mpa, bars)

    # 5. Revisión EBE con eje neutro real
    be_check = check_boundary_element(
        gov.Pu_kN, gov.Mu_kNm, lw_m, tw_m, hw_m, fc_mpa,
        c_m=na.c_m, ductility=ductility, delta_u_hw=delta_u_hw,
    )

    # 6. Ajustar longitud EBE si es necesario
    if be_check.required and lc < be_check.lc_m:
        lc = be_check.lc_m
        be_left = BoundaryZoneReinf(
            n_bars=n_be, db_mm=db_be,
            cover_mm=cover_mm, tie_db_mm=9.5,
            tie_spacing_mm=100.0 if ductility == "DES" else 150.0,
            length_m=lc,
        )
        reinf = WallReinforcement(be_left=be_left, web=web, be_right=be_left, symmetric=True)

    # 7. Confinamiento EBE
    if be_check.required:
        conf = design_confinement(
            lc, tw_m, fc_mpa, fyt_mpa,
            db_long_mm=db_be, n_bars=n_be,
            cover_mm=cover_mm, ductility=ductility,
        )
        # Si no cumple Ash, aumentar patas del estribo a 3 (#4)
        if not conf.ok_ash:
            be_left.tie_db_mm = 12.7  # #4
            be_left.n_legs_b = 3

    return reinf
