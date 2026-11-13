"""
Clasificación cruzada de modo de falla para columnas de pórticos.

Combina:
  1. Predicción ASCE 41-17 §10.3 (del `element_thresholds.json`, Fase 2 del
     plan de evaluación por elemento): Vp/Vn → flexión / flexión-cortante /
     cortante.
  2. Observación durante el sismo (del `damage.hinges` del NLTHA): peor nivel
     de rotación plástica alcanzado entre los dos extremos del elemento.

Produce una categorización forense:

  - `shear_failed`       : ASCE 41 predijo cortante Y el elemento plastificó
                            durante el sismo → la columna falló por cortante
                            antes de desarrollar su capacidad dúctil. El
                            modelo de fibras subestima el daño real; en campo
                            se esperan fisuras diagonales y pérdida de
                            capacidad resistente súbita.
  - `flexure_shear_risk` : ASCE 41 predijo flexión-cortante Y el elemento
                            plastificó. Hay riesgo de transición a modo
                            frágil con ciclos adicionales; inspección urgente.
  - `flexural_ductile`   : ASCE 41 predijo flexión pura Y plastificó. Es el
                            comportamiento esperado; reparable con resane.
  - `no_damage`          : el elemento no plastificó, el modo es irrelevante.

Esta clasificación se consume en la radiografía 3D como marcador superpuesto
(⚡ en shear_failed, ✕ en flexure_shear_risk).
"""
from __future__ import annotations

from typing import Literal, Optional

import numpy as np

FailureCategory = Literal[
    "shear_failed", "flexure_shear_risk", "flexural_ductile", "no_damage",
]

# ASCE 41-17 §10.3.3 → granulardad numérica (orden ascendente de riesgo frágil)
_ASCE_RANK = {"flexion": 0, "flexion_cortante": 1, "cortante": 2}
_HINGE_RANK = {"none": 0, "near_io": 0, "io": 1, "ls": 2, "cp": 3, "collapse": 4}


# ─────────────────────────────────────────────────────────────────────────────
# Demanda real: M(t) por extremo (M-φ bilineal) + V(t) por equilibrio
# ─────────────────────────────────────────────────────────────────────────────

def _bilinear_M(
    kappa_abs: np.ndarray,     # (n_steps,) rad/m
    kappa_y:   float,          # rad/m
    kappa_u:   float,          # rad/m
    M_peak_kNm: float,
    alpha:     float = 0.02,   # strain hardening fraccional post-fluencia
) -> np.ndarray:
    """
    Momento en kN·m desde la curvatura, con bilineal equal-energy:
      M = EI·κ            si |κ| ≤ κ_y   (EI ≡ My/κ_y, My ≈ M_peak)
      M = My + α·EI·(κ-κ_y)  si |κ| > κ_y

    Para κ_y ≤ 0 o M_peak ≤ 0 devuelve ceros (elemento mal caracterizado).
    """
    if kappa_y <= 1e-9 or M_peak_kNm <= 0:
        return np.zeros_like(kappa_abs)
    EI = M_peak_kNm / kappa_y
    My = M_peak_kNm
    out = np.where(
        kappa_abs <= kappa_y,
        EI * kappa_abs,
        My + alpha * EI * (kappa_abs - kappa_y),
    )
    return np.asarray(out, dtype=np.float32)


def compute_demand_dcr_per_column(
    *,
    sect_def:          np.ndarray,     # (n_steps, n_elements, 8)
    sect_tags:         list[int],       # ele_tag en orden de sect_def
    element_lines:     list[dict],      # metadata frames (fid, kind, story, node_i/j)
    joints_ref:        dict[str, list[float]],  # {node_id: [x, y, z]}
    thresholds_by_fid: dict[str, dict], # fid → {M_peak_kNm, theta_y, Lp_mm, phi_u, Vn_kN}
) -> dict[str, dict]:
    """
    Para cada columna, calcula las envolventes:
      M_demand_max_kNm, DCR_flex = M_demand/Mp
      V_demand_max_kN,  DCR_shear = V_demand/Vn

    Donde:
      M(t) por extremo se reconstruye de κ(t) con bilineal equal-energy.
      V(t) = (M_i(t) + M_j(t)) / L_col  (equilibrio doble curvatura).

    sect_def shape = (n_steps, n_elements, 8), formato por elemento:
      [axial_i, κz_i, κy_i, torsion_i, axial_j, κz_j, κy_j, torsion_j]

    Returns:
      {fid: {M_demand_max_kNm, V_demand_max_kN, DCR_flex, DCR_shear,
             M_i_max_kNm, M_j_max_kNm, kappa_i_max, kappa_j_max, L_col_m}}
    """
    if sect_def is None or sect_def.ndim != 3 or sect_def.shape[0] == 0:
        return {}
    n_steps, n_el, ncols = sect_def.shape
    if ncols < 7:
        return {}

    tag_to_idx = {int(t): i for i, t in enumerate(sect_tags)}
    out: dict[str, dict] = {}

    for el in element_lines:
        if el.get("kind") != "column":
            continue
        fid = str(el.get("fid", ""))
        th = thresholds_by_fid.get(fid)
        if not th:
            continue
        ele_tag = int(el.get("ele_tag", -1))
        idx = tag_to_idx.get(ele_tag)
        if idx is None or idx >= n_el:
            continue

        # Longitud de columna desde coords de los nodos.
        n_i = str(el.get("node_i", ""))
        n_j = str(el.get("node_j", ""))
        ri = joints_ref.get(n_i)
        rj = joints_ref.get(n_j)
        if not ri or not rj:
            continue
        L_col = float(np.sqrt(
            (rj[0] - ri[0])**2 + (rj[1] - ri[1])**2 + (rj[2] - ri[2])**2
        ))
        if L_col < 0.1:
            continue

        # Parámetros M-φ bilineal del elemento (desde Fase 3-7).
        M_peak = float(th.get("M_peak_kNm", 0.0))
        theta_y = float(th.get("theta_y", 0.0))
        Lp_m   = float(th.get("Lp_mm", 0.0)) / 1000.0
        phi_u  = float(th.get("phi_u_rad_per_m", 0.1))
        Vn     = float(th.get("Vn_kN", 0.0))
        if M_peak <= 0 or theta_y <= 0 or Lp_m <= 0 or Vn <= 0:
            continue
        kappa_y = theta_y / Lp_m         # rad/m — curvatura de fluencia
        kappa_u = max(phi_u, kappa_y * 2.0)

        # Historia de curvaturas (magnitud, combinada bidireccional).
        slab = sect_def[:, idx, :]         # (n_steps, 8)
        kappa_i = np.sqrt(slab[:, 1]**2 + slab[:, 2]**2).astype(np.float32)
        kappa_j = np.sqrt(slab[:, 5]**2 + slab[:, 6]**2).astype(np.float32)

        M_i_hist = _bilinear_M(np.abs(kappa_i), kappa_y, kappa_u, M_peak)
        M_j_hist = _bilinear_M(np.abs(kappa_j), kappa_y, kappa_u, M_peak)
        V_hist   = (M_i_hist + M_j_hist) / L_col

        M_i_max = float(M_i_hist.max())
        M_j_max = float(M_j_hist.max())
        M_dem_max = max(M_i_max, M_j_max)
        V_dem_max = float(V_hist.max())

        out[fid] = {
            "M_demand_max_kNm": round(M_dem_max, 2),
            "V_demand_max_kN":  round(V_dem_max, 2),
            "DCR_flex":         round(M_dem_max / M_peak, 3),
            "DCR_shear":        round(V_dem_max / Vn, 3),
            "M_i_max_kNm":      round(M_i_max, 2),
            "M_j_max_kNm":      round(M_j_max, 2),
            "kappa_i_max":      round(float(kappa_i.max()), 5),
            "kappa_j_max":      round(float(kappa_j.max()), 5),
            "L_col_m":          round(L_col, 3),
            "kappa_y":          round(kappa_y, 5),
            "Mp_kNm":           M_peak,
            "Vn_kN":            Vn,
        }
    return out


def _worst_hinge_level(hinges: list[dict], fid: str) -> tuple[str, float]:
    """Devuelve (max_level, max_dcr) sobre los dos extremos del elemento."""
    max_level = "none"
    max_dcr   = 0.0
    for h in hinges:
        if str(h.get("fid", "")) != str(fid):
            continue
        lvl = str(h.get("damage_level", "none"))
        if _HINGE_RANK.get(lvl, 0) > _HINGE_RANK.get(max_level, 0):
            max_level = lvl
        dcr = float(h.get("dcr", 0.0))
        if dcr > max_dcr:
            max_dcr = dcr
    return max_level, max_dcr


def classify_frame_failure_modes(
    *,
    element_thresholds_rows: list[dict],
    hinges:                   list[dict],
    demand_by_fid:            Optional[dict[str, dict]] = None,
) -> dict:
    """Clasifica cada columna por categoría de modo de falla.

    Args:
        element_thresholds_rows: `rows` del `element_thresholds.json` (Fase 7).
            Cada fila trae `fid`, `kind`, `failure_mode`, `asce_condition`,
            `Vp_kN`, `Vn_kN`, `Vp_over_Vn`, `flags`.
        hinges: `damage.hinges` del NLTHA. Cada entrada trae `fid`, `end`,
            `damage_level`, `dcr`, `theta_p_max`.
        demand_by_fid: opcional — salida de `compute_demand_dcr_per_column`.
            Si está presente, la clasificación añade `DCR_flex` y `DCR_shear`
            observados y vuelve a decidir `category`:
              - DCR_shear ≥ 1.0 → shear_failed_observed
              - DCR_flex  ≥ 1.0 → flexural_yielded_observed
              - else: usa el camino predictivo (ASCE 41 × hinges).

    Returns:
        {
          "status": "success",
          "n_total": N,
          "counts": {category: int},
          "elements": [
            {"fid", "kind", "story", "section",
             "asce_prediction": "flexion|flexion_cortante|cortante",
             "asce_condition":  "i|ii|iii|iv",
             "Vp_kN", "Vn_kN", "Vp_over_Vn", "flags": [...],
             "observed_hinge":  "none|io|ls|cp|collapse",
             "max_dcr":         float,
             "category":        FailureCategory,
             "needs_marker":    bool,       # True si cat ∈ shear_* (pinta en 3D)
             "marker_symbol":   "lightning|cross|",
            },
            ...
          ],
        }
    """
    elements: list[dict] = []
    counts   = {"shear_failed": 0, "flexure_shear_risk": 0,
                "flexural_ductile": 0, "no_damage": 0}

    for row in element_thresholds_rows:
        if str(row.get("kind", "")) != "column":
            continue  # scope: solo columnas (vigas rara vez fallan por cortante)
        fid         = str(row.get("fid", ""))
        asce_mode   = str(row.get("failure_mode", "flexion"))
        asce_cond   = str(row.get("asce_condition", "i"))
        Vp          = float(row.get("Vp_kN", 0.0))
        Vn          = float(row.get("Vn_kN", 0.0))
        ratio       = float(row.get("Vp_over_Vn", 0.0))
        flags       = list(row.get("flags", []) or [])
        story       = str(row.get("story", ""))
        section     = str(row.get("section", ""))

        hinge_level, max_dcr = _worst_hinge_level(hinges, fid)
        plastified = _HINGE_RANK.get(hinge_level, 0) >= _HINGE_RANK["io"]

        # Métricas de demanda real (si están disponibles).
        dem = (demand_by_fid or {}).get(fid, {}) if demand_by_fid else {}
        dcr_flex  = float(dem.get("DCR_flex",  0.0))
        dcr_shear = float(dem.get("DCR_shear", 0.0))

        # Clasificación — prioriza observación de capacidad superada.
        if dcr_shear >= 1.0:
            # El cortante demandado por el sismo superó Vn → falla frágil real.
            category = "shear_failed"
            marker   = "lightning"
        elif dcr_flex >= 1.0:
            # La columna fluyó por flexión durante el sismo. Si además la
            # predicción es flexion_cortante/cortante, marca riesgo.
            if asce_mode in ("cortante", "flexion_cortante") or dcr_shear >= 0.8:
                category = "flexure_shear_risk"
                marker   = "cross"
            else:
                category = "flexural_ductile"
                marker   = ""
        elif plastified:
            # Hinge activo pero sin cruzar Mp/Vn — comportamiento marginal.
            if asce_mode == "cortante":
                category = "shear_failed"
                marker   = "lightning"
            elif asce_mode == "flexion_cortante":
                category = "flexure_shear_risk"
                marker   = "cross"
            else:
                category = "flexural_ductile"
                marker   = ""
        else:
            category = "no_damage"
            marker   = ""

        counts[category] += 1

        entry: dict = {
            "fid":             fid,
            "kind":            "column",
            "story":           story,
            "section":         section,
            "asce_prediction": asce_mode,
            "asce_condition":  asce_cond,
            "Vp_kN":           round(Vp, 2),
            "Vn_kN":           round(Vn, 2),
            "Vp_over_Vn":      round(ratio, 3),
            "flags":           flags,
            "observed_hinge":  hinge_level,
            "max_dcr":         round(max_dcr, 3),
            "category":        category,
            "needs_marker":    bool(marker),
            "marker_symbol":   marker,
        }
        if dem:
            entry.update({
                "M_demand_max_kNm": dem.get("M_demand_max_kNm"),
                "V_demand_max_kN":  dem.get("V_demand_max_kN"),
                "DCR_flex":         dem.get("DCR_flex"),
                "DCR_shear":        dem.get("DCR_shear"),
                "Mp_kNm":           dem.get("Mp_kNm"),
            })
        elements.append(entry)

    # Orden descendente por severidad (shear primero, luego dcr)
    _CAT_RANK = {"shear_failed": 3, "flexure_shear_risk": 2,
                 "flexural_ductile": 1, "no_damage": 0}
    elements.sort(key=lambda e: (-_CAT_RANK[e["category"]], -e["max_dcr"]))

    return {
        "status":   "success",
        "scheme":   "ASCE 41-17 §10.3.3 (predicción) × damage.hinges (observación)",
        "n_total":  len(elements),
        "counts":   counts,
        "elements": elements,
    }


__all__ = [
    "classify_frame_failure_modes",
    "compute_demand_dcr_per_column",
    "FailureCategory",
]
