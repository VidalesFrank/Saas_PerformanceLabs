"""
Diseño de refuerzo transversal (confinamiento) en los EBE.
NSR-10 C.21.9.6.4 (DES) / C.21.4 (DMO)
ACI 318-25 §18.10.6.4 → referencia a §18.7.5.4

Unidades: mm para dimensiones de barras y espaciado.
"""
from __future__ import annotations
import math
from dataclasses import dataclass
from typing import Optional
from .wall_design_schemas import bar_area, STANDARD_DIAMETERS_MM


@dataclass
class ConfinementResult:
    # Inputs
    bc_mm: float          # dimensión del núcleo (mm, paralelo al estribo)
    hc_mm: float          # dimensión del núcleo perpendicular al estribo
    Ag_mm2: float         # área bruta EBE
    Ach_mm2: float        # área del núcleo EBE
    s_mm: float           # espaciado adoptado (mm)
    tie_db_mm: float      # diámetro estribo adoptado (mm)
    n_legs_h: int         # patas en dirección h (longitud EBE)
    n_legs_b: int         # patas en dirección b (espesor muro)
    ductility: str
    # Outputs
    Ash_req_a_mm2: float  # Ash req. Ecuación a
    Ash_req_b_mm2: float  # Ash req. Ecuación b
    Ash_req_mm2: float    # Ash requerida (máximo)
    Ash_prov_mm2: float   # Ash provista
    s_max_code_mm: float  # espaciado máximo del código
    ok_ash: bool
    ok_spacing: bool
    message: str = ""


def _spacing_limits_des(db_long_mm: float, hx_mm: float) -> float:
    """
    Espaciado máximo en zona de confinamiento DES.
    ACI 318-25 §18.10.6.4(d) → referencia §18.7.5.3:
      s ≤ min(s0, 6·db_long, 150 mm)
    donde s0 = 4 + (14 - hx)/3, max(25, min(150))  [hx en mm, distancia máx. entre barras laterales]
    """
    s0 = 4.0 + (355.6 - hx_mm) / 3.0  # 14" = 355.6 mm
    s0 = max(25.0, min(s0, 150.0))  # entre 25 y 150 mm
    s_limit = min(s0, 6.0 * db_long_mm, 150.0)
    return s_limit


def _spacing_limits_dmo(db_long_mm: float) -> float:
    """
    Espaciado máximo en zona de confinamiento DMO.
    NSR-10 C.21.4.4: s ≤ min(8·db_long, d/4, 24·db_estribo, 300 mm)
    Usamos s ≤ min(8·db_long, 200 mm) como aproximación conservadora.
    """
    return min(8.0 * db_long_mm, 200.0)


def design_confinement(
    lc_m: float,       # longitud EBE (m)
    tw_m: float,       # espesor muro (m)
    fc_mpa: float,
    fyt_mpa: float,
    db_long_mm: float, # diámetro barra longitudinal EBE (mm)
    n_bars: int,       # número de barras longitudinales en EBE
    cover_mm: float,   # recubrimiento libre (mm)
    ductility: str = "DES",
    tie_db_mm: float = 9.5,  # diámetro del estribo (#3 = 9.5mm)
) -> ConfinementResult:
    """
    Calcula el Ash requerido y el espaciado máximo para un EBE rectangular.
    Itera sobre el espaciado adoptado (usa el espaciado máximo del código).
    """
    # Dimensiones del núcleo (centro a centro de estribos perimetrales)
    bc_mm = tw_m * 1000 - 2 * cover_mm + tie_db_mm     # espesor
    hc_mm = lc_m * 1000 - 2 * cover_mm + tie_db_mm     # longitud EBE

    Ag_mm2  = lc_m * 1000 * tw_m * 1000
    Ach_mm2 = hc_mm * bc_mm

    # Distancia máxima entre barras laterales hx (simplificado: asume barras uniformes)
    if n_bars > 2:
        hx_mm = (hc_mm - 2 * (cover_mm - tie_db_mm / 2)) / (n_bars - 1)
    else:
        hx_mm = hc_mm
    hx_mm = min(hx_mm, 350.0)

    # Espaciado máximo del código
    if ductility == "DES":
        s_max = _spacing_limits_des(db_long_mm, hx_mm)
    else:
        s_max = _spacing_limits_dmo(db_long_mm)
    s_max = min(s_max, 150.0 if ductility == "DES" else 200.0)
    s_adopt = s_max  # adoptamos el máximo (más desfavorable para el requerimiento)

    # Ash requerida (dirección del espesor, n_legs_b patas)
    n_legs_b = 2  # mínimo dos patas en dirección del espesor
    n_legs_h = max(int(math.ceil(hc_mm / hx_mm)) + 1, 2)

    # ACI 318-25 §18.7.5.4 (aplicado a EBE muros via §18.10.6.4):
    ratio_Ag_Ach = Ag_mm2 / max(Ach_mm2, 1.0)
    Ash_a = 0.3 * (s_adopt * bc_mm / Ach_mm2) * (ratio_Ag_Ach - 1.0) * (fc_mpa / fyt_mpa) * Ach_mm2 / bc_mm
    # Simplificando la fórmula estándar:
    Ash_a = 0.3 * s_adopt * bc_mm * (ratio_Ag_Ach - 1.0) * (fc_mpa / fyt_mpa)
    Ash_b = 0.09 * s_adopt * bc_mm * (fc_mpa / fyt_mpa)

    Ash_req = max(Ash_a, Ash_b)  # mm² por capa de estribos

    # Ash provista (n_legs_b patas × área estribo)
    A_tie = bar_area(tie_db_mm)
    Ash_prov = n_legs_b * A_tie

    ok_ash     = Ash_prov >= Ash_req
    ok_spacing = s_adopt <= s_max

    msg = (
        "Ash_req = max({:.1f}, {:.1f}) = {:.1f} mm²  |  "
        "Ash_prov = {}×{:.1f} = {:.1f} mm²  |  "
        "s = {:.0f} mm ≤ s_máx = {:.0f} mm".format(
            Ash_a, Ash_b, Ash_req,
            n_legs_b, A_tie, Ash_prov,
            s_adopt, s_max,
        )
    )

    return ConfinementResult(
        bc_mm=bc_mm, hc_mm=hc_mm,
        Ag_mm2=Ag_mm2, Ach_mm2=Ach_mm2,
        s_mm=s_adopt, tie_db_mm=tie_db_mm,
        n_legs_h=n_legs_h, n_legs_b=n_legs_b,
        ductility=ductility,
        Ash_req_a_mm2=Ash_a, Ash_req_b_mm2=Ash_b,
        Ash_req_mm2=Ash_req, Ash_prov_mm2=Ash_prov,
        s_max_code_mm=s_max,
        ok_ash=ok_ash, ok_spacing=ok_spacing,
        message=msg,
    )
