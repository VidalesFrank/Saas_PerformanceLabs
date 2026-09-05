"""
Orquestador del diseño de muros RC.
Recibe inputs completos → devuelve WallDesignResult.
"""
from __future__ import annotations
from typing import List, Optional

from .wall_design_schemas import (
    WallDemandCombo, WallReinforcement, WallDesignResult,
    NeutralAxisResult, InteractionDiagram,
)
from .neutral_axis import find_neutral_axis
from .wall_pm_interaction import build_interaction_diagram, is_demand_inside
from .boundary_element import check_boundary_element
from .confinement import design_confinement
from .shear_design import design_shear
from .code_checks import generate_checks
from .auto_design import auto_design


def compute_wall_design(
    # Geometría
    lw_m: float,
    tw_m: float,
    hw_m: float,
    # Materiales
    fc_mpa: float,
    fy_mpa: float,
    fyt_mpa: float,
    # Ductilidad
    ductility: str,  # "DES" | "DMO"
    # Demandas
    demands: List[WallDemandCombo],
    # Modo y refuerzo (solo si mode="manual")
    mode: str = "auto",  # "auto" | "manual"
    manual_reinf: Optional[WallReinforcement] = None,
    # Opcionales
    cover_mm: float = 40.0,
    delta_u_hw: Optional[float] = None,
) -> dict:
    """
    Devuelve un diccionario serializable con todos los resultados del diseño.
    """
    if not demands:
        raise ValueError("Se requiere al menos una combinación de carga")

    # ── 1. Refuerzo ───────────────────────────────────────────────────────────
    if mode == "auto":
        reinf = auto_design(
            lw_m, tw_m, hw_m, fc_mpa, fy_mpa, fyt_mpa,
            demands, ductility, cover_mm, delta_u_hw,
        )
    else:
        if manual_reinf is None:
            raise ValueError("Se requiere refuerzo manual si mode='manual'")
        reinf = manual_reinf

    bars = reinf.all_bars(lw_m, tw_m, cover_mm)

    # ── 2. Combinación gobernante (mayor Mu) ──────────────────────────────────
    gov = max(demands, key=lambda d: d.Mu_kNm)
    Vu_max = max(d.Vu_kN for d in demands)

    # ── 3. Eje neutro ─────────────────────────────────────────────────────────
    na = find_neutral_axis(gov.Pu_kN, lw_m, tw_m, fc_mpa, fy_mpa, bars)

    # ── 4. Diagrama de interacción ────────────────────────────────────────────
    diag = build_interaction_diagram(lw_m, tw_m, fc_mpa, fy_mpa, bars)

    # ── 5. Puntos de demanda ──────────────────────────────────────────────────
    demand_pts = []
    for d in demands:
        inside = is_demand_inside(d.Pu_kN, d.Mu_kNm, diag)
        demand_pts.append({
            "label": d.label, "Pu_kN": d.Pu_kN,
            "Mu_kNm": d.Mu_kNm, "Vu_kN": d.Vu_kN,
            "inside": inside, "is_seismic": d.is_seismic,
        })

    # ── 6. Elemento de borde ──────────────────────────────────────────────────
    be = check_boundary_element(
        gov.Pu_kN, gov.Mu_kNm, lw_m, tw_m, hw_m, fc_mpa,
        c_m=na.c_m, ductility=ductility, delta_u_hw=delta_u_hw,
    )

    # ── 7. Cortante ───────────────────────────────────────────────────────────
    rho_t = reinf.web.rho_h_with_tw(tw_m)
    rho_v = reinf.web.rho_v_with_tw(tw_m)
    shear = design_shear(
        Vu_max, lw_m, tw_m, hw_m, fc_mpa, fyt_mpa,
        rho_t, rho_v, ductility,
    )

    # ── 8. Confinamiento EBE ──────────────────────────────────────────────────
    conf = None
    if be.required:
        conf = design_confinement(
            be.lc_m, tw_m, fc_mpa, fyt_mpa,
            db_long_mm=reinf.be_left.db_mm,
            n_bars=reinf.be_left.n_bars,
            cover_mm=cover_mm,
            ductility=ductility,
            tie_db_mm=reinf.be_left.tie_db_mm,
        )

    # ── 9. Revisión NSR-10 / ACI 318-25 ──────────────────────────────────────
    checks = generate_checks(
        lw_m, tw_m, hw_m, fc_mpa, fy_mpa, fyt_mpa, ductility,
        na, be, shear, reinf,
        gov.Pu_kN, gov.Mu_kNm, Vu_max,
        confinement=conf,
    )
    is_ok = all(c.ok for c in checks)

    # ── 10. Serialización ─────────────────────────────────────────────────────
    def _be_to_dict(b):
        return {
            "n_bars": b.n_bars, "db_mm": b.db_mm, "cover_mm": b.cover_mm,
            "tie_db_mm": b.tie_db_mm, "tie_spacing_mm": b.tie_spacing_mm,
            "length_m": b.length_m, "As_mm2": b.As_mm2,
        }

    result = {
        "ok": is_ok,
        "governing_combo": gov.label,
        "ductility": ductility,
        "mode": mode,
        # Geometry
        "geometry": {"lw_m": lw_m, "tw_m": tw_m, "hw_m": hw_m},
        # Bars for visualization
        "bars": bars,
        # Reinforcement
        "reinforcement": {
            "be_left":  _be_to_dict(reinf.be_left),
            "be_right": _be_to_dict(reinf.be_right),
            "web": {
                "vert_db_mm": reinf.web.vert_db_mm,
                "vert_spacing_mm": reinf.web.vert_spacing_mm,
                "horiz_db_mm": reinf.web.horiz_db_mm,
                "horiz_spacing_mm": reinf.web.horiz_spacing_mm,
                "n_curtains": reinf.web.n_curtains,
                "rho_v": rho_v, "rho_h": rho_t,
            },
        },
        # Neutral axis
        "neutral_axis": {
            "c_m": na.c_m, "a_m": na.a_m, "beta1": na.beta1,
            "Pn_kN": na.Pn_kN, "Mn_kNm": na.Mn_kNm,
            "phi": na.phi_flexure,
            "phiPn_kN": na.phiPn_kN, "phiMn_kNm": na.phiMn_kNm,
            "steel_strains": na.steel_strains,
            "ok": na.ok, "message": na.message,
        },
        # Boundary element
        "boundary_element": {
            "required": be.required, "method": be.method,
            "lc_m": be.lc_m, "c_m": be.c_m,
            "sigma_max_mpa": be.sigma_max_mpa,
            "threshold_mpa": be.threshold_mpa,
            "c_limit_m": be.c_limit_m,
            "drift_ratio": be.drift_ratio,
            "message": be.message,
        },
        # Confinement
        "confinement": {
            "Ash_req_mm2": conf.Ash_req_mm2,
            "Ash_prov_mm2": conf.Ash_prov_mm2,
            "s_mm": conf.s_mm,
            "s_max_code_mm": conf.s_max_code_mm,
            "ok_ash": conf.ok_ash,
            "ok_spacing": conf.ok_spacing,
            "message": conf.message,
        } if conf else None,
        # Shear
        "shear": {
            "hw_lw": shear.hw_lw, "alpha_c": shear.alpha_c,
            "Acv_m2": shear.Acv_m2,
            "Vn_max_kN": shear.Vn_max_kN, "phi_Vn_kN": shear.phi_Vn_kN,
            "Vu_kN": shear.Vu_kN,
            "rho_t_req": shear.rho_t_required, "rho_t_prov": shear.rho_t_provided,
            "rho_v_prov": shear.rho_v_provided,
            "Vn_limit_kN": shear.Vn_limit_kN,
            "ok_shear": shear.ok_shear,
            "ok_rho_t": shear.ok_rho_t_min,
            "ok_rho_v": shear.ok_rho_v_min,
            "ok_vn_limit": shear.ok_vn_limit,
        },
        # P-M interaction
        "interaction": {
            "Pn_kN": diag.Pn_kN, "Mn_kNm": diag.Mn_kNm,
            "phiPn_kN": diag.phiPn_kN, "phiMn_kNm": diag.phiMn_kNm,
        },
        "demand_points": demand_pts,
        # Code checks
        "checks": [
            {
                "article": c.article, "description": c.description,
                "demand": c.demand, "capacity": c.capacity,
                "unit": c.unit, "ok": c.ok, "dcr": round(c.dcr, 3),
            }
            for c in checks
        ],
        # Summary
        "summary": {
            "total_checks": len(checks),
            "failed_checks": sum(1 for c in checks if not c.ok),
            "ebe_required": be.required,
            "c_m": round(na.c_m, 4),
            "lc_m": round(be.lc_m, 3),
            "phi_Mn_kNm": round(na.phiMn_kNm, 1),
            "phi_Vn_kN": round(shear.phi_Vn_kN, 1),
        },
    }
    return result
