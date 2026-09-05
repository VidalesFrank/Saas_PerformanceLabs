"""
Diseño por cortante de muros RC.
NSR-10 C.21.9.4 (DES) / C.21.4 (DMO) — ACI 318-25 §18.10.4.

Vn = Acv × (αc × √f'c + ρt × fyt)   [ACI 318-25 Eq. 18.10.4.1]
Vn ≤ 0.83 × √f'c × Acv              [ACI 318-25 §18.10.4.4]
φ = 0.75 para cortante
"""
from __future__ import annotations
import math
from .wall_design_schemas import ShearDesignResult

PHI_SHEAR = 0.75
RHO_MIN_WEB = 0.0025  # NSR-10 C.21.9.2.1


def _alpha_c(hw_lw: float) -> float:
    """
    Factor αc dependiente de relación altura/longitud.
    ACI 318-25 §18.10.4.1:
      αc = 0.25 si hw/lw ≤ 1.5
      αc = 0.17 si hw/lw ≥ 2.0
      Interpolación lineal entre 1.5 y 2.0
    """
    if hw_lw <= 1.5:
        return 0.25
    if hw_lw >= 2.0:
        return 0.17
    return 0.25 + (0.17 - 0.25) * (hw_lw - 1.5) / (2.0 - 1.5)


def design_shear(
    Vu_kN: float,
    lw_m: float, tw_m: float, hw_m: float,
    fc_mpa: float, fyt_mpa: float,
    rho_t_provided: float,  # cuantía horizontal provista
    rho_v_provided: float,  # cuantía vertical provista
    ductility: str = "DES",
) -> ShearDesignResult:
    """
    Diseña el refuerzo por cortante para un muro rectangular.
    """
    hw_lw = hw_m / lw_m
    alpha_c = _alpha_c(hw_lw)
    Acv = lw_m * tw_m  # m²

    # Vn con la cuantía horizontal provista
    Vn_prov = Acv * 1000.0 * (alpha_c * math.sqrt(fc_mpa) + rho_t_provided * fyt_mpa)

    # Límite máximo de Vn
    Vn_limit = 0.83 * math.sqrt(fc_mpa) * Acv * 1000.0  # kN

    # Cuantía horizontal mínima requerida por cortante (despejando ρt)
    # φVn = Vu → Vn = Vu/φ
    # Acv(αc√f'c + ρt·fyt) = Vu/φ
    # ρt = (Vu/(φ·Acv·1000) - αc√f'c) / fyt
    Vn_required = Vu_kN / PHI_SHEAR
    rho_t_shear = (Vn_required / (Acv * 1000.0) - alpha_c * math.sqrt(fc_mpa)) / fyt_mpa
    rho_t_shear = max(rho_t_shear, 0.0)  # si Vc ya es suficiente, ρt mínimo
    rho_t_required = max(rho_t_shear, RHO_MIN_WEB)

    # Cuantía vertical mínima (NSR-10 C.21.9.2.1)
    rho_v_min = RHO_MIN_WEB
    if hw_lw < 2.0:
        rho_v_min = max(rho_v_min, rho_t_provided)  # ρv ≥ ρh si hw/lw < 2

    phi_Vn = PHI_SHEAR * min(Vn_prov, Vn_limit)

    ok_shear    = phi_Vn >= Vu_kN
    ok_rho_t    = rho_t_provided >= rho_t_required
    ok_rho_v    = rho_v_provided >= rho_v_min
    ok_vn_limit = Vn_prov <= Vn_limit * 1.001  # pequeña tolerancia numérica

    return ShearDesignResult(
        hw_lw=hw_lw,
        alpha_c=alpha_c,
        Acv_m2=Acv,
        Vn_max_kN=Vn_prov,
        phi_Vn_kN=phi_Vn,
        Vu_kN=Vu_kN,
        rho_t_required=rho_t_required,
        rho_t_provided=rho_t_provided,
        rho_v_provided=rho_v_provided,
        Vn_limit_kN=Vn_limit,
        ok_shear=ok_shear,
        ok_rho_t_min=ok_rho_t,
        ok_rho_v_min=ok_rho_v,
        ok_vn_limit=ok_vn_limit,
        phi=PHI_SHEAR,
    )
