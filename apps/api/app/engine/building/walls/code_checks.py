"""
Tabla de revisión NSR-10 / ACI 318-25 para muros RC.
Genera lista de CodeCheck con artículo, demanda, capacidad, estado.
"""
from __future__ import annotations
import math
from typing import List
from .wall_design_schemas import (
    CodeCheck, WallDesignResult, BoundaryElementResult,
    ShearDesignResult, NeutralAxisResult, WallReinforcement,
)


def generate_checks(
    # Geometry
    lw_m: float, tw_m: float, hw_m: float,
    fc_mpa: float, fy_mpa: float, fyt_mpa: float,
    ductility: str,
    # Results
    na: NeutralAxisResult,
    be: BoundaryElementResult,
    shear: ShearDesignResult,
    reinf: WallReinforcement,
    Pu_kN: float, Mu_kNm: float, Vu_kN: float,
    confinement=None,
) -> List[CodeCheck]:
    checks: List[CodeCheck] = []

    ref_pre = "NSR-10 C.21.9" if ductility == "DES" else "NSR-10 C.21.4"

    # ── 1. Espesor mínimo del muro ────────────────────────────────────────────
    # ACI 318-25 §18.10.2.3: tw ≥ max(100mm, hw/25) para muros especiales
    tw_mm = tw_m * 1000
    tw_min_mm = max(100.0, hw_m / 25.0 * 1000.0)
    checks.append(CodeCheck(
        article="{}.2.3 / ACI 318-25 §18.10.2.3".format(ref_pre),
        description="Espesor mínimo del muro tw",
        demand=tw_min_mm, capacity=tw_mm, unit="mm",
        ok=tw_mm >= tw_min_mm,
        dcr=tw_min_mm / max(tw_mm, 1.0),
    ))

    # ── 2. Cuantía mínima horizontal ──────────────────────────────────────────
    rho_h = shear.rho_t_provided
    rho_h_min = 0.0025
    checks.append(CodeCheck(
        article="{}.2.1 / ACI 318-25 §18.10.2.1".format(ref_pre),
        description="Cuantía mínima horizontal ρh ≥ 0.0025",
        demand=rho_h_min, capacity=rho_h, unit="",
        ok=rho_h >= rho_h_min,
        dcr=rho_h_min / max(rho_h, 1e-6),
    ))

    # ── 3. Cuantía mínima vertical ────────────────────────────────────────────
    rho_v = shear.rho_v_provided
    rho_v_min = 0.0025
    checks.append(CodeCheck(
        article="{}.2.1 / ACI 318-25 §18.10.2.1".format(ref_pre),
        description="Cuantía mínima vertical ρv ≥ 0.0025",
        demand=rho_v_min, capacity=rho_v, unit="",
        ok=rho_v >= rho_v_min,
        dcr=rho_v_min / max(rho_v, 1e-6),
    ))

    # ── 4. Relación ρv ≥ ρh (si hw/lw < 2.0) ────────────────────────────────
    hw_lw = hw_m / lw_m
    if hw_lw < 2.0:
        checks.append(CodeCheck(
            article="ACI 318-25 §18.10.2.2",
            description="ρv ≥ ρh (ya que hw/lw = {:.2f} < 2.0)".format(hw_lw),
            demand=rho_h, capacity=rho_v, unit="",
            ok=rho_v >= rho_h,
            dcr=rho_h / max(rho_v, 1e-6),
        ))

    # ── 5. Resistencia al cortante φVn ≥ Vu ──────────────────────────────────
    checks.append(CodeCheck(
        article="{}.4 / ACI 318-25 §18.10.4".format(ref_pre),
        description="Resistencia al cortante φVn ≥ Vu",
        demand=Vu_kN, capacity=shear.phi_Vn_kN, unit="kN",
        ok=shear.ok_shear,
        dcr=Vu_kN / max(shear.phi_Vn_kN, 1.0),
    ))

    # ── 6. Límite máximo de cortante Vn ≤ 0.83√f'c·Acv ──────────────────────
    checks.append(CodeCheck(
        article="ACI 318-25 §18.10.4.4",
        description="Límite máximo Vn ≤ 0.83·√f'c·Acv",
        demand=shear.Vn_max_kN, capacity=shear.Vn_limit_kN, unit="kN",
        ok=shear.ok_vn_limit,
        dcr=shear.Vn_max_kN / max(shear.Vn_limit_kN, 1.0),
    ))

    # ── 7. Interacción P-M (φPn ≥ Pu y φMn ≥ Mu) ────────────────────────────
    checks.append(CodeCheck(
        article="ACI 318-25 §22.4-22.5",
        description="Resistencia a flexo-compresión φPn/φMn",
        demand=Pu_kN, capacity=na.phiPn_kN, unit="kN (Pu)",
        ok=na.phiPn_kN >= Pu_kN,
        dcr=Pu_kN / max(na.phiPn_kN, 1.0),
    ))
    checks.append(CodeCheck(
        article="ACI 318-25 §22.4-22.5",
        description="Momento reducido φMn ≥ Mu",
        demand=Mu_kNm, capacity=na.phiMn_kNm, unit="kN·m",
        ok=na.phiMn_kNm >= Mu_kNm,
        dcr=Mu_kNm / max(na.phiMn_kNm, 1.0),
    ))

    # ── 8. Elemento de borde ──────────────────────────────────────────────────
    if be.required:
        checks.append(CodeCheck(
            article="{}.6 / ACI 318-25 §18.10.6".format(ref_pre),
            description="EBE requerido — longitud mínima lc",
            demand=be.lc_m * 1000, capacity=reinf.be_left.length_m * 1000, unit="mm",
            ok=reinf.be_left.length_m >= be.lc_m * 0.99,
            dcr=be.lc_m / max(reinf.be_left.length_m, 1e-3),
        ))

        # Confinamiento EBE
        if confinement is not None:
            checks.append(CodeCheck(
                article="{}.6.4 / ACI 318-25 §18.10.6.4".format(ref_pre),
                description="Confinamiento EBE: Ash provista ≥ Ash requerida",
                demand=confinement.Ash_req_mm2,
                capacity=confinement.Ash_prov_mm2,
                unit="mm²",
                ok=confinement.ok_ash,
                dcr=confinement.Ash_req_mm2 / max(confinement.Ash_prov_mm2, 1.0),
            ))
            checks.append(CodeCheck(
                article="ACI 318-25 §18.10.6.4(d)",
                description="Espaciado estribos EBE s ≤ s_máx",
                demand=confinement.s_mm,
                capacity=confinement.s_max_code_mm,
                unit="mm",
                ok=confinement.ok_spacing,
                dcr=confinement.s_mm / max(confinement.s_max_code_mm, 1.0),
            ))

    # ── 9. Cuantía máxima longitudinal (evitar acero excesivo) ───────────────
    Ag_mm2 = lw_m * 1000 * tw_m * 1000
    As_total = reinf.be_left.As_mm2 + reinf.be_right.As_mm2
    rho_long = As_total / Ag_mm2
    rho_long_max = 0.04  # ACI 318-25 §18.10.2
    checks.append(CodeCheck(
        article="ACI 318-25 §18.10.2 / NSR-10 C.21.9.2",
        description="Cuantía longitudinal total ρlong ≤ 0.04",
        demand=rho_long, capacity=rho_long_max, unit="",
        ok=rho_long <= rho_long_max,
        dcr=rho_long / rho_long_max,
    ))

    return checks
