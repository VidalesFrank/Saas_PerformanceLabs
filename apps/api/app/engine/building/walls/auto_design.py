"""
Auto-diseño de muros RC rectangulares — NSR-10 / ACI 318-25.

Filosofía:
  1. Diseña el ALMA con la cuantía mínima aplicable según el nivel de cortante:
        Vu bajo   (Vu ≤ Vc/12)     → ρv_min = 0.0012, ρh_min = 0.0020  (NSR-10 C.11.6)
        Vu medio  (Vc/12 < Vu ≤ Vc/2) → ρv_min = 0.0020, ρh_min = 0.0025 (NSR-10 C.21.9.2.4)
        Vu alto   (Vu > Vc/2)      → ρv_min = ρh_min = 0.0025             (NSR-10 C.21.9.2.1)
     donde Vc = Acv · √f'c / 6  [MPa, kN].

  2. Evalúa si se requiere elemento de borde (EBE) por criterio de esfuerzo /
     desplazamiento (NSR-10 C.21.9.6 / C.21.4.4).

  3a. **No requiere EBE**: retorna refuerzo distribuido en TODO lw con la
      cuantía del alma. `be_left`/`be_right` quedan vacíos (`n_bars=0`,
      `length_m=0`).

  3b. **Requiere EBE**: busca el refuerzo BE de MENOR As total que satisfaga
      P-M para todas las demandas, con ρ_BE ∈ [1%, 4%]. Si no encuentra,
      levanta `WallNotDesignableError` — no cae en "última defensa" de acero
      excesivo.

  4. Recalcula el eje neutro con el refuerzo real y re-verifica EBE.
  5. Diseña el confinamiento del EBE si aplica (delegado a wall_design_engine).

Convenciones detalladas en `walls/DESIGN_TO_MVLEM.md`.
"""
from __future__ import annotations
import math
from typing import List, Optional

from .wall_design_schemas import (
    WallDemandCombo, WallReinforcement, BoundaryZoneReinf, WebZoneReinf,
    bar_area, STANDARD_DIAMETERS_MM, curtains_for_tw,
)
from .neutral_axis import find_neutral_axis
from .wall_pm_interaction import build_interaction_diagram, is_demand_inside
from .boundary_element import check_boundary_element


class WallNotDesignableError(Exception):
    """Levantada cuando el auto-diseño no puede encontrar un refuerzo válido."""


# ── Constantes del código ────────────────────────────────────────────────────

RHO_MIN_HIGH_V     = 0.0025    # NSR-10 C.21.9.2.1 · ACI 318-25 §18.10.2.1
RHO_MIN_MED_V      = 0.0020    # NSR-10 C.21.9.2.4 · ACI 318-25 §18.10.2.4
RHO_MIN_LOW_V      = 0.0012    # NSR-10 C.11.6      · ACI 318-25 §11.6.2 (barras ≤ #5)
RHO_MIN_LOW_H      = 0.0020    # NSR-10 C.11.6 horizontal
RHO_MIN_HIGH_H     = 0.0025    # sísmico horizontal

RHO_BE_MIN         = 0.010     # 1% mínimo en el EBE cuando sí se requiere
RHO_BE_MAX         = 0.040     # 4% máximo práctico (evita congestión)

DB_MAX_FOR_LOW_MIN = 15.9      # barras ≤ #5 para acceder al mínimo 0.12%

# Separación máxima entre barras de refuerzo en el alma (mm).
# NSR-10 C.14.3.5 / C.21.9.4 y ACI 318-25 §11.7.2.2 / §18.10.4.3.
# En proyectos con OpenSees + macrofibras usamos 300 mm como tope firme
# — ni DES ni DMO pueden exceder este valor.
S_MAX_WALL_MM = 300.0
S_MIN_WALL_MM = 100.0

# Diámetros probados en el alma. Se arranca en #2 (6.4 mm) para poder llegar a
# cuantías bajas (~0.12% LOW o 0.20% MED) sin que el cap de 300 mm empuje al alza.
WEB_BAR_CANDIDATES_MM = (6.4, 9.5, 12.7, 15.9, 19.1)

# Diámetros probados en el BE. #2 y #3 excluidos — se usan como estribos, no longitudinales.
BE_BAR_CANDIDATES_MM  = (12.7, 15.9, 19.1, 22.2, 25.4)


# ── Utilidades ───────────────────────────────────────────────────────────────

def _min_reinforcement_ratios(
    Vu_kN: float, Acv_m2: float, fc_mpa: float, db_ref_mm: float = 12.7,
) -> tuple[float, float, str]:
    """
    Devuelve (ρ_v_min, ρ_h_min, tier_label) según el nivel de cortante.
    El escalón LOW (0.0012 vertical) sólo aplica con barras ≤ #5.
    """
    Vc_kN = Acv_m2 * math.sqrt(max(fc_mpa, 1e-6)) / 6.0 * 1000.0
    if Vc_kN <= 1e-6:
        return RHO_MIN_HIGH_V, RHO_MIN_HIGH_H, "high"
    ratio = Vu_kN / Vc_kN
    if ratio > 0.5:
        return RHO_MIN_HIGH_V, RHO_MIN_HIGH_H, "high"
    if ratio > 1.0 / 12.0:
        return RHO_MIN_MED_V, RHO_MIN_HIGH_H, "medium"
    if db_ref_mm <= DB_MAX_FOR_LOW_MIN + 0.05:
        return RHO_MIN_LOW_V, RHO_MIN_LOW_H, "low"
    return RHO_MIN_MED_V, RHO_MIN_HIGH_H, "medium (db>#5)"


def _alpha_c(hw_lw: float) -> float:
    if hw_lw <= 1.5:
        return 0.25
    if hw_lw >= 2.0:
        return 0.17
    return 0.25 + (0.17 - 0.25) * (hw_lw - 1.5) / 0.5


def _empty_boundary_zone(cover_mm: float) -> BoundaryZoneReinf:
    """Zona de borde vacía — usada cuando no se requiere EBE."""
    return BoundaryZoneReinf(
        n_bars=0, db_mm=0.0, cover_mm=cover_mm,
        tie_db_mm=0.0, tie_spacing_mm=0.0, length_m=0.0,
        n_curtains=1,
    )


# ── Diseño del alma con cuantías variables por cortante ──────────────────────

def _select_web_reinforcement(
    lw_m: float, tw_m: float, hw_m: float,
    fc_mpa: float, fyt_mpa: float,
    Vu_kN: float,
    ductility: str,
    override_rho_v_min: Optional[float] = None,
    override_rho_h_min: Optional[float] = None,
) -> tuple[WebZoneReinf, str]:
    """
    Diseña refuerzo del alma con los 3 escalones de cuantía mínima aplicables.
    Retorna (WebZoneReinf, tier_label).
    """
    Acv        = lw_m * tw_m
    hw_lw      = hw_m / lw_m
    alpha_c    = _alpha_c(hw_lw)
    n_curtains = curtains_for_tw(tw_m)

    # Cuantía horizontal requerida por cortante (ACI 18.10.4.1)
    Vn_required = Vu_kN / 0.75
    rho_h_shear = max(0.0, (Vn_required / (Acv * 1000.0) - alpha_c * math.sqrt(fc_mpa)) / fyt_mpa)

    rho_v_min_code, rho_h_min_code, tier = _min_reinforcement_ratios(Vu_kN, Acv, fc_mpa)
    if override_rho_v_min is not None:
        rho_v_min_code = override_rho_v_min
    if override_rho_h_min is not None:
        rho_h_min_code = override_rho_h_min

    rho_h_target = max(rho_h_shear, rho_h_min_code)
    rho_v_target = rho_v_min_code
    # NSR-10 C.21.9.2.2: si hw/lw < 2, ρv ≥ ρh (para muros bajos)
    if hw_lw < 2.0:
        rho_v_target = max(rho_v_target, rho_h_target)

    # Separación máxima 300 mm firme (no se relaja en DMO).
    s_max_spacing = S_MAX_WALL_MM
    s_min_spacing = S_MIN_WALL_MM

    # Selecciona el MENOR diámetro que provee la cuantía objetivo dentro de
    # [s_min, s_max]. Arranca en #2 (6.4 mm) para muros con Vu muy bajo.
    db_h, sp_h = _pick_bar_and_spacing(
        rho_target=rho_h_target, tw_m=tw_m, n_curtains=n_curtains,
        s_min=s_min_spacing, s_max=s_max_spacing,
    )

    # Vertical: mismo diámetro que horizontal por practicidad de obra.
    db_v    = db_h
    A_bar_v = bar_area(db_v)
    sp_v    = n_curtains * A_bar_v / (rho_v_target * tw_m * 1e6) * 1000
    sp_v    = min(max(sp_v, s_min_spacing), s_max_spacing)

    return WebZoneReinf(
        vert_db_mm=db_v, vert_spacing_mm=sp_v,
        horiz_db_mm=db_h, horiz_spacing_mm=sp_h,
        n_curtains=n_curtains,
    ), tier


def _pick_bar_and_spacing(
    rho_target: float, tw_m: float, n_curtains: int,
    s_min: float, s_max: float,
) -> tuple[float, float]:
    """
    Selecciona el diámetro MÁS PEQUEÑO que puede proveer rho_target dentro del
    rango [s_min, s_max]. Si ningún diámetro alcanza (cap superior), toma el
    que da la cuantía más cercana al target por arriba.
    """
    for db in WEB_BAR_CANDIDATES_MM:
        A_bar = bar_area(db)
        # sp ideal para rho_target exacto
        sp_ideal = n_curtains * A_bar / (rho_target * tw_m * 1e6) * 1000
        if sp_ideal < s_min:
            # Barra demasiado pequeña — subiría el ρ. Prueba la siguiente.
            continue
        sp = min(sp_ideal, s_max)
        rho_prov = n_curtains * A_bar / (sp / 1000 * tw_m * 1e6)
        if rho_prov >= rho_target - 1e-6:
            return db, sp
    # Fallback: la barra más grande, a espaciamiento cap superior
    db = WEB_BAR_CANDIDATES_MM[-1]
    return db, s_max


# ── Búsqueda óptima del EBE ──────────────────────────────────────────────────

def _candidate_be_configs(
    lc_m: float, tw_m: float,
    max_bars_per_curtain: int = 12,
    min_bars_per_curtain: int = 2,
) -> list[tuple[int, float, int]]:
    """
    Genera candidatos (n_bars, db_mm, n_curtains) ordenados por área total
    ASCENDENTE. Aplica límites prácticos de espaciamiento entre barras
    longitudinales (100–300 mm) para evitar congestión.
    """
    n_curtains = curtains_for_tw(tw_m)
    candidates: list[tuple[int, float, int, float]] = []

    for db in BE_BAR_CANDIDATES_MM:
        min_bars = max(min_bars_per_curtain, 2 if n_curtains == 2 else 4)
        for n in range(min_bars, max_bars_per_curtain + 1):
            if n > 1:
                s = (lc_m - 2 * (0.04 + db / 2000)) / (n - 1)
                if s * 1000 < 100:
                    continue
                if s * 1000 > 300:
                    continue
            area_total = n * n_curtains * bar_area(db)
            candidates.append((n, db, n_curtains, area_total))

    candidates.sort(key=lambda x: x[3])
    return [(n, db, ncur) for n, db, ncur, _ in candidates]


def _search_be(
    lw_m: float, tw_m: float,
    fc_mpa: float, fy_mpa: float,
    demands: List[WallDemandCombo],
    web: WebZoneReinf,
    lc_m: float,
    cover_mm: float,
    ductility: str,
    tie_db_mm: float = 9.5,
    max_iterations: int = 60,
) -> Optional[tuple[BoundaryZoneReinf, list[dict], float]]:
    """
    Búsqueda óptima del refuerzo BE: menor As total que satisfaga TODAS las
    demandas dentro del diagrama P-M. Verifica también rango práctico ρ_BE ∈ [1%, 4%].

    Retorna (BoundaryZoneReinf, bars, dcr_max) o None si no encuentra solución.
    """
    tie_spacing_default = 100.0 if ductility == "DES" else 150.0
    candidates = _candidate_be_configs(lc_m, tw_m)
    if not candidates:
        return None

    for i, (n_bars, db_mm, n_curtains) in enumerate(candidates):
        if i >= max_iterations:
            break

        As_total = n_bars * n_curtains * bar_area(db_mm)
        rho_be   = As_total / (lc_m * tw_m * 1e6)
        if rho_be < RHO_BE_MIN * 0.95:
            continue
        if rho_be > RHO_BE_MAX:
            continue

        be = BoundaryZoneReinf(
            n_bars=n_bars, db_mm=db_mm,
            cover_mm=cover_mm,
            tie_db_mm=tie_db_mm,
            tie_spacing_mm=tie_spacing_default,
            length_m=lc_m,
            n_curtains=n_curtains,
        )
        reinf = WallReinforcement(be_left=be, web=web, be_right=be, symmetric=True)
        bars  = reinf.all_bars(lw_m, tw_m, cover_mm)
        diag  = build_interaction_diagram(lw_m, tw_m, fc_mpa, fy_mpa, bars)

        all_inside = True
        dcr_max = 0.0
        for d in demands:
            if not is_demand_inside(d.Pu_kN, d.Mu_kNm, diag):
                all_inside = False
                break
            dcr = abs(d.Mu_kNm) / max(_capacity_at_Pu(d.Pu_kN, diag), 1e-6)
            dcr_max = max(dcr_max, dcr)

        if all_inside:
            return be, bars, dcr_max

    return None


def _capacity_at_Pu(Pu_kN: float, diag) -> float:
    """Capacidad φMn a un nivel de Pu dado (interpolación lineal sobre el envolvente)."""
    Pn = list(diag.phiPn_kN)
    Mn = list(diag.phiMn_kNm)
    if not Pn:
        return 1e-6
    idx_min = min(range(len(Pn)), key=lambda i: abs(Pn[i] - Pu_kN))
    return abs(Mn[idx_min])


# ── Función principal — auto_design ──────────────────────────────────────────

def auto_design(
    lw_m: float, tw_m: float, hw_m: float,
    fc_mpa: float, fy_mpa: float, fyt_mpa: float,
    demands: List[WallDemandCombo],
    ductility: str = "DES",
    cover_mm: float = 40.0,
    delta_u_hw: Optional[float] = None,
    override_rho_v_web_min: Optional[float] = None,
    override_rho_h_web_min: Optional[float] = None,
    override_lc_min_m:      Optional[float] = None,
) -> WallReinforcement:
    """
    Propuesta óptima de refuerzo NSR-10 / ACI 318-25 para un muro rectangular.

    Retorna un `WallReinforcement`. Si el muro NO requiere EBE, `be_left` y
    `be_right` quedan vacíos (`is_empty == True`) y el alma se distribuye en
    todo el largo.

    Levanta `WallNotDesignableError` cuando el muro requiere EBE y ninguna
    configuración de refuerzo cierra el diagrama P-M dentro del rango
    práctico ρ_BE ∈ [1%, 4%].
    """
    gov    = max(demands, key=lambda d: d.Mu_kNm)
    Vu_max = max(d.Vu_kN for d in demands)

    # ── 1. Refuerzo del alma con cuantías variables por cortante ─────────────
    web, _tier = _select_web_reinforcement(
        lw_m, tw_m, hw_m, fc_mpa, fyt_mpa, Vu_max, ductility,
        override_rho_v_min=override_rho_v_web_min,
        override_rho_h_min=override_rho_h_web_min,
    )

    # ── 2. Revisión preliminar de EBE (esfuerzo con c estimado 0.3·lw) ──────
    be_prelim = check_boundary_element(
        gov.Pu_kN, gov.Mu_kNm, lw_m, tw_m, hw_m, fc_mpa,
        c_m=lw_m * 0.3,
        ductility=ductility,
        delta_u_hw=delta_u_hw,
    )

    # ── 3a. Sin EBE — refuerzo distribuido en todo lw ────────────────────────
    if not be_prelim.required:
        empty = _empty_boundary_zone(cover_mm)
        return WallReinforcement(be_left=empty, web=web, be_right=empty, symmetric=True)

    # ── 3b. EBE requerido — búsqueda óptima ──────────────────────────────────
    # Escalones crecientes de lc: el motor debe preferir DISTRIBUIR el refuerzo
    # (crecer lc) antes que CONCENTRARLO (subir n_bars y db en un lc pequeño).
    # Sin este bucle, muros con Mu grande terminan con 10–12 barras #8 en 30 cm.
    lc_min = max(be_prelim.lc_m, tw_m, 0.30)
    if override_lc_min_m:
        lc_min = max(lc_min, override_lc_min_m)
    lc_cap = 0.30 * lw_m
    lc_min = min(lc_min, lc_cap)

    lc_trials: List[float] = [lc_min]
    for factor in (1.5, 2.0, 3.0):
        lc_try = min(lc_min * factor, lc_cap)
        if lc_try > lc_trials[-1] + 1e-3:
            lc_trials.append(lc_try)

    tie_db_mm = 9.5   # #3 arranque
    # Probamos TODOS los lc y elegimos la solución con MENOR As total. Como
    # desempate, la de MENOR ρ_BE (más distribuida, mejor confinamiento).
    # Sin este bucle, el motor se quedaba con la primera solución en lc pequeño
    # y podía dejar barras grandes concentradas cuando había opciones con
    # menos acero total distribuido en más longitud.
    best: Optional[tuple[float, BoundaryZoneReinf, list[dict], float]] = None
    for lc_try in lc_trials:
        candidate = _search_be(
            lw_m, tw_m, fc_mpa, fy_mpa, demands, web, lc_try,
            cover_mm, ductility, tie_db_mm=tie_db_mm,
        )
        if candidate is None:
            continue
        be_c, bars_c, dcr_c = candidate
        as_total = be_c.As_mm2
        rho_c    = as_total / (lc_try * tw_m * 1e6)
        if best is None:
            best = (lc_try, be_c, bars_c, dcr_c)
            continue
        _, be_best, _, _ = best
        as_best  = be_best.As_mm2
        lc_best  = be_best.length_m
        rho_best = as_best / (lc_best * tw_m * 1e6)
        # Preferir menor As. Con As similar (± 5%), preferir menor ρ_BE.
        if as_total < as_best - 5.0:
            best = (lc_try, be_c, bars_c, dcr_c)
        elif abs(as_total - as_best) / max(as_best, 1.0) < 0.05 and rho_c < rho_best - 1e-4:
            best = (lc_try, be_c, bars_c, dcr_c)

    if best is None:
        raise WallNotDesignableError(
            f"EBE requerido pero no se encontró refuerzo válido en ρ_BE ∈ "
            f"[1%, 4%] para ningún lc ∈ [{lc_min:.2f}, {lc_cap:.2f}] m. "
            f"lw={lw_m:.2f} m, tw={tw_m:.2f} m, "
            f"combinación gobernante {gov.label} (Pu={gov.Pu_kN:.0f} kN, "
            f"Mu={gov.Mu_kNm:.0f} kN·m). Revisar geometría o demandas."
        )

    lc, be, bars, _dcr = best

    # ── 4. Eje neutro real con el refuerzo seleccionado ──────────────────────
    na = find_neutral_axis(gov.Pu_kN, lw_m, tw_m, fc_mpa, fy_mpa, bars)

    # ── 5. Revisión EBE con eje neutro real ──────────────────────────────────
    be_check = check_boundary_element(
        gov.Pu_kN, gov.Mu_kNm, lw_m, tw_m, hw_m, fc_mpa,
        c_m=na.c_m, ductility=ductility, delta_u_hw=delta_u_hw,
    )

    # ── 6. Ajuste de lc si crece con c real; re-buscar BE si sube ────────────
    if be_check.required and lc < be_check.lc_m:
        lc_new = min(be_check.lc_m, 0.30 * lw_m)
        result2 = _search_be(
            lw_m, tw_m, fc_mpa, fy_mpa, demands, web, lc_new,
            cover_mm, ductility, tie_db_mm=tie_db_mm,
        )
        if result2 is None:
            raise WallNotDesignableError(
                f"EBE con lc ajustado a {lc_new:.2f} m no encontró refuerzo "
                f"válido. Revisar geometría o demandas."
            )
        be, bars, _dcr = result2

    return WallReinforcement(be_left=be, web=web, be_right=be, symmetric=True)
