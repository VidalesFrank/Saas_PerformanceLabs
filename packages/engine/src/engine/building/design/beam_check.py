"""
Diseño de vigas rectangulares — NSR-10 / ACI 318.

Flujo:
  1. Demanda gravitacional → w·L²/12 (soporte) y w·L²/24 (vano), w·L/2 cortante
  2. Demanda sísmica     → método del pórtico (igual que columnas)
  3. Envolvente por combinaciones NSR-10 B.3.4
  4. Diseño a flexión   → As_req (acero longitudinal)
  5. Diseño a cortante  → s_estribos (estribos #3@s)

Unidades: kN, m, MPa, cm².
"""
from __future__ import annotations

import math
from collections import defaultdict


# ── Parseo de secciones ────────────────────────────────────────────────────────

import re

_RE_DIMS = re.compile(r"(\d+\.?\d*)\s*[xX×]\s*(\d+\.?\d*)")
_RE_FC   = re.compile(r"(\d+(?:\.\d+)?)\s*MPa", re.IGNORECASE)


def parse_beam_section(name: str) -> dict | None:
    m = _RE_DIMS.search(name)
    if not m:
        return None
    b, h = float(m.group(1)), float(m.group(2))
    if b > 10:
        b /= 100.0
    if h > 10:
        h /= 100.0
    fc_m = _RE_FC.search(name)
    fc = float(fc_m.group(1)) if fc_m else 21.0
    return {"b_m": round(b, 4), "h_m": round(h, 4), "fc_MPa": fc}


# ── Demandas de gravedad ──────────────────────────────────────────────────────

def _beta1(fc_MPa: float) -> float:
    if fc_MPa <= 28.0:
        return 0.85
    return max(0.65, 0.85 - 0.05 * (fc_MPa - 28.0) / 7.0)


def beam_span(joints: dict, joint_i: str, joint_j: str) -> float:
    """Longitud en planta entre extremos (m)."""
    ji = joints.get(str(joint_i), {})
    jj = joints.get(str(joint_j), {})
    dx = jj.get("x", 0.0) - ji.get("x", 0.0)
    dy = jj.get("y", 0.0) - ji.get("y", 0.0)
    return round(math.sqrt(dx * dx + dy * dy), 4) or 3.0  # fallback 3 m


def distribute_gravity_beams(
    story_masses_t: dict[str, float],
    beams_by_story: dict[str, list[str]],
    beam_lengths: dict[str, float],
    story_order: list[str],
    g: float = 9.81,
) -> dict[str, dict]:
    """
    Distribuye la carga gravitatoria de cada piso entre las vigas.

    Asume carga uniformemente distribuida w = W_piso / L_total_vigas.
    Devuelve por viga:  Mu_neg_kNm (soporte), Mu_pos_kNm (vano), Vu_kN.
    """
    out: dict[str, dict] = {}

    for story in story_order:
        mass_t = story_masses_t.get(story, 0.0)
        w_floor_kN = mass_t * g   # solo la masa de este piso, no acumulada

        beams = beams_by_story.get(story, [])
        if not beams:
            continue

        total_L = sum(beam_lengths.get(fid, 3.0) for fid in beams)
        w = w_floor_kN / total_L if total_L > 0 else 0.0  # kN/m

        for fid in beams:
            L = beam_lengths.get(fid, 3.0)
            out[fid] = {
                "Mu_neg_kNm": round(w * L ** 2 / 12.0, 2),   # en empotramientos
                "Mu_pos_kNm": round(w * L ** 2 / 24.0, 2),   # en vano
                "Vu_kN":      round(w * L / 2.0, 2),
                "w_kNm":      round(w, 3),
                "L_m":        round(L, 3),
            }
    return out


# ── Demanda sísmica ────────────────────────────────────────────────────────────

def distribute_seismic_beams(
    story_shears_kN: dict[str, float],
    columns_by_story: dict[str, list[str]],
    beams_by_story: dict[str, list[str]],
    story_heights_m: dict[str, float],
    story_order: list[str],
) -> dict[str, float]:
    """
    Método del pórtico para vigas.

    Equilibrio de momentos en el nudo: ΣM_col = ΣM_vigas
    Momento por columna = V_story / n_cols × h/2.
    El momento sícmico de la viga = momento de columna del nudo (conservador).
    """
    moments: dict[str, float] = {}
    for story in story_order:
        shear = abs(story_shears_kN.get(story, 0.0))
        h     = story_heights_m.get(story, 3.0)
        n_col = len(columns_by_story.get(story, []))
        beams = beams_by_story.get(story, [])
        if not beams or n_col == 0:
            continue
        mu_col = shear / n_col * (h / 2.0)   # momento por columna = momento en nudo
        # Momento sísmico de la viga ≈ mu_col (conservador, para vigas exteriores es exacto)
        for fid in beams:
            moments[fid] = round(mu_col, 2)
    return moments


# ── Diseño flexión ────────────────────────────────────────────────────────────

def design_flexure(
    Mu_kNm: float,
    b_m: float,
    h_m: float,
    fc_MPa: float,
    fy_MPa: float = 420.0,
    cover_m: float = 0.065,
) -> dict:
    """
    Calcula el acero longitudinal requerido para resistir Mu.

    NSR-10 C.9.6.1 — Acero mínimo:
        As_min ≥ max(0.25√fc/fy, 1.4/fy) × bw × d
    NSR-10 C.9.7.3.3 / ACI 318-19 §9.3.3 — Acero máximo (ε_t ≥ 0.004):
        c_max = d × 3/7 → As_max = 0.85·β1·fc·b·c_max / fy

    design_status:
        "OK"                 — diseño dentro de límites
        "GOVERNED_BY_ASMIN"  — As_req < As_min; se usa As_min
        "SECTION_INSUFFICIENT" — As_req > As_max; sección real no resiste
    """
    b = b_m * 1000.0
    h = h_m * 1000.0
    d = h - cover_m * 1000.0  # distancia al centroide del acero de tensión

    # Acero mínimo (NSR-10 C.9.6.1)
    As_min = max(0.25 * math.sqrt(fc_MPa) / fy_MPa, 1.4 / fy_MPa) * b * d

    # Acero máximo (ε_t ≥ 0.004)
    b1 = _beta1(fc_MPa)
    c_max = d * 3.0 / 7.0
    As_max = 0.85 * b1 * fc_MPa * b * c_max / fy_MPa

    design_status = "OK"

    if Mu_kNm <= 0.001:
        As_req = As_min
        design_status = "GOVERNED_BY_ASMIN"
    else:
        Mu_Nmm = Mu_kNm * 1.0e6
        phi = 0.90
        disc = d ** 2 - 2.0 * Mu_Nmm / (phi * 0.85 * fc_MPa * b)
        if disc < 0:
            # Mu excede la capacidad absoluta de la sección (incluso con As → ∞)
            return {
                "As_req_cm2":    -1.0,
                "As_min_cm2":    round(As_min / 100.0, 2),
                "As_max_cm2":    round(As_max / 100.0, 2),
                "phi_Mn_kNm":    0.0,
                "rho":           0.0,
                "dcr_flex":      999.0,
                "ok_flex":       False,
                "section_fail":  True,
                "design_status": "SECTION_INSUFFICIENT",
                "Mu_kNm":        round(Mu_kNm, 1),
            }
        As_req = 0.85 * fc_MPa * b * (d - math.sqrt(disc)) / fy_MPa

    if As_req < As_min:
        As_req = As_min
        design_status = "GOVERNED_BY_ASMIN"

    insufficient = As_req > As_max
    if insufficient:
        As_req = As_max
        design_status = "SECTION_INSUFFICIENT"

    # Recomputar a desde el As_req FINAL (no desde la ecuación original)
    a_mm = As_req * fy_MPa / (0.85 * fc_MPa * b)
    phi_Mn = 0.90 * As_req * fy_MPa * (d - a_mm / 2.0) / 1.0e6
    dcr = Mu_kNm / phi_Mn if phi_Mn > 0.01 else 0.0

    return {
        "As_req_cm2":    round(As_req / 100.0, 2),
        "As_min_cm2":    round(As_min / 100.0, 2),
        "As_max_cm2":    round(As_max / 100.0, 2),
        "phi_Mn_kNm":    round(phi_Mn, 1),
        "rho":           round(As_req / (b * d), 4),
        "dcr_flex":      round(dcr, 3),
        "ok_flex":       dcr <= 1.0,
        "section_fail":  False,
        "design_status": design_status,
        "Mu_kNm":        round(Mu_kNm, 1),
    }


# ── Diseño cortante ───────────────────────────────────────────────────────────

# Estirbo #3 (D=9.5mm), 2 ramas → Av = 2 × 71 mm² = 142 mm²
_AV_STIRRUP_MM2 = 142.0
_FY_STIRRUP     = 420.0   # MPa (acero de estribos)


def design_shear(
    Vu_kN: float,
    b_m: float,
    h_m: float,
    fc_MPa: float,
    cover_m: float = 0.065,
) -> dict:
    """
    Diseño de estribos usando estirbo #3 (2 ramas, Av=142 mm²).

    NSR-10 C.22.5.5 / ACI 318-19:
        Vc = 0.17 · √fc · bw · d    (N, mm)
    NSR-10 C.9.7.6.2 — Estirbo mínimo:
        Av/s_min = max(0.062√fc·bw/fy, 0.35·bw/fy)
    NSR-10 C.9.7.6.3 — Espaciado máximo:
        s_max = min(d/2, 600 mm)
    """
    b   = b_m * 1000.0
    h   = h_m * 1000.0
    d   = h - cover_m * 1000.0

    phi = 0.75
    Vc  = 0.17 * math.sqrt(fc_MPa) * b * d / 1000.0  # kN
    phi_Vc = phi * Vc

    if Vu_kN <= phi_Vc:
        # Solo estribos mínimos
        Av_s_min  = max(0.062 * math.sqrt(fc_MPa) * b / _FY_STIRRUP,
                        0.35 * b / _FY_STIRRUP)          # mm²/mm
        s_min_mm  = _AV_STIRRUP_MM2 / Av_s_min           # mm
        s_max_mm  = min(d / 2.0, 600.0)
        s_prov_mm = min(s_min_mm, s_max_mm)
    else:
        Vs_req = Vu_kN / phi - Vc  # kN
        # Vs = Av/s × fy × d  (kN) → s = Av × fy × d / (Vs × 1000)
        s_req_mm  = _AV_STIRRUP_MM2 * _FY_STIRRUP * d / (Vs_req * 1000.0)
        s_max_mm  = min(d / 2.0, 600.0)
        s_prov_mm = max(50.0, min(s_req_mm, s_max_mm))

    # Capacidad con el estribo provisto
    phi_Vs   = phi * _AV_STIRRUP_MM2 * _FY_STIRRUP * d / (s_prov_mm * 1000.0)  # kN
    phi_Vn   = phi_Vc + phi_Vs
    dcr_shear = Vu_kN / phi_Vn if phi_Vn > 0.01 else 0.0

    return {
        "phi_Vc_kN":     round(phi_Vc, 1),
        "phi_Vs_kN":     round(phi_Vs, 1),
        "phi_Vn_kN":     round(phi_Vn, 1),
        "s_mm":          round(s_prov_mm),
        "Av_cm2_m":      round(_AV_STIRRUP_MM2 / s_prov_mm * 1000.0 / 100.0, 2),
        "dcr_shear":     round(dcr_shear, 3),
        "ok_shear":      dcr_shear <= 1.0,
    }


# ── Verificación completa de una viga ─────────────────────────────────────────

def check_beam(
    Mu_neg_kNm: float,
    Mu_pos_kNm: float,
    Vu_kN: float,
    b_m: float,
    h_m: float,
    fc_MPa: float,
    fy_MPa: float = 420.0,
    cover_m: float = 0.065,
) -> dict:
    """
    Diseña y verifica una viga rectangular con demandas Mu_neg, Mu_pos, Vu.
    Devuelve resultado consolidado.
    """
    # Diseño por el momento dominante (negativo en soportes)
    Mu_design = max(Mu_neg_kNm, Mu_pos_kNm)
    flex = design_flexure(Mu_design, b_m, h_m, fc_MPa, fy_MPa, cover_m)

    # Diseño a cortante
    shear = design_shear(Vu_kN, b_m, h_m, fc_MPa, cover_m)

    ok = flex["ok_flex"] and shear["ok_shear"] and not flex.get("section_fail")
    dcr = max(flex["dcr_flex"], shear["dcr_shear"])

    return {
        "Mu_neg_kNm":   round(Mu_neg_kNm, 1),
        "Mu_pos_kNm":   round(Mu_pos_kNm, 1),
        "Vu_kN":        round(Vu_kN, 1),
        # Flexión
        "As_neg_cm2":   flex["As_req_cm2"],
        "As_pos_cm2":   round(flex["As_req_cm2"] * 0.5, 2),  # al menos 50% del As neg
        "As_min_cm2":   flex["As_min_cm2"],
        "As_max_cm2":   flex["As_max_cm2"],
        "phi_Mn_kNm":   flex["phi_Mn_kNm"],
        "rho":          flex["rho"],
        "dcr_flex":     flex["dcr_flex"],
        "ok_flex":      flex["ok_flex"],
        "section_fail": flex.get("section_fail", False),
        # Cortante
        "phi_Vc_kN":    shear["phi_Vc_kN"],
        "phi_Vs_kN":    shear["phi_Vs_kN"],
        "phi_Vn_kN":    shear["phi_Vn_kN"],
        "s_mm":         shear["s_mm"],
        "Av_cm2_m":     shear["Av_cm2_m"],
        "dcr_shear":    shear["dcr_shear"],
        "ok_shear":     shear["ok_shear"],
        # Global
        "dcr":          round(dcr, 3),
        "ok":           ok,
        "fc_MPa":       fc_MPa,
        "fy_MPa":       fy_MPa,
    }
