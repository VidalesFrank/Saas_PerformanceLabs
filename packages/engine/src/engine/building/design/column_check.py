"""
Verificación PM de columnas rectangulares — NSR-10 / ACI 318.

Todas las funciones son puras (sin OpenSees). El motor de cálculo
usa la envolvente de las combinaciones NSR-10 B.3.4 y el método del
pórtico (portal method) para distribuir las fuerzas sísmicas espectrales.

Unidades: kN, m, MPa (N/mm²), kN·m.
"""
from __future__ import annotations

import re


# ── Parseo de secciones ETABS ─────────────────────────────────────────────────

_RE_DIMS = re.compile(r"(\d+\.?\d*)\s*[xX×]\s*(\d+\.?\d*)")
_RE_FC   = re.compile(r"(\d+(?:\.\d+)?)\s*MPa", re.IGNORECASE)


def parse_section(name: str) -> dict | None:
    """
    Parsea el nombre de una sección ETABS y extrae dimensiones y f'c.

    Ejemplos reconocidos:
      "00_C_0.40x0.60_(21 MPa)"  → {b_m:0.40, h_m:0.60, fc_MPa:21}
      "COL_40x40_C28"            → {b_m:0.40, h_m:0.40, fc_MPa:28}
      "30x50"                    → {b_m:0.30, h_m:0.50, fc_MPa:21}

    Retorna None si no se reconoce el patrón.
    """
    m = _RE_DIMS.search(name)
    if not m:
        return None
    b, h = float(m.group(1)), float(m.group(2))
    # Si los valores superan 10 m, asumimos que están en cm → convertir a m
    if b > 10:
        b /= 100.0
    if h > 10:
        h /= 100.0
    # f'c
    fc_m = _RE_FC.search(name)
    fc = float(fc_m.group(1)) if fc_m else 21.0
    return {"b_m": round(b, 4), "h_m": round(h, 4), "fc_MPa": fc}


# ── Capacidad P-M (analítica) ─────────────────────────────────────────────────

def pm_capacity(
    b_m: float,
    h_m: float,
    fc_MPa: float,
    rho: float = 0.01,
    fy_MPa: float = 420.0,
    cover_m: float = 0.065,
) -> dict:
    """
    Calcula los puntos clave de la envolvente P-M para una sección rectangular
    con distribución de acero simétrica (ρ total asumido).

    Retorna (todos en kN / kN·m):
        phi_Pn_max  — compresión máxima (con factor 0.80 NSR-10)
        phi_Pb      — axial en el punto de balance
        phi_Mb      — momento en el punto de balance
        phi_Mn      — momento puro (Pu = 0)
        phi_Pt      — tensión pura
    """
    # mm y mm²
    b   = b_m  * 1000.0
    h   = h_m  * 1000.0
    cov = cover_m * 1000.0          # mm de recubrimiento al centroide del acero
    Ag  = b * h
    Ast = rho * Ag
    Ast_s = Ast / 2.0               # acero en cada cara (tensión / compresión)
    dp  = cov                       # distancia al centroide del acero en compresión
    d   = h - cov                   # distancia al centroide del acero en tensión
    Es  = 200_000.0                 # MPa

    # β₁ NSR-10 (≡ ACI 318-14 §22.2.2.4.3)
    if fc_MPa <= 28.0:
        beta1 = 0.85
    else:
        beta1 = max(0.65, 0.85 - 0.05 * (fc_MPa - 28.0) / 7.0)

    # ── Compresión pura ──────────────────────────────────────────────────────
    Pn_max = 0.85 * fc_MPa * (Ag - Ast) + fy_MPa * Ast        # N
    phi_Pn_max = 0.65 * 0.80 * Pn_max / 1_000.0               # kN (tied column)

    # ── Tensión pura ─────────────────────────────────────────────────────────
    phi_Pt = 0.90 * fy_MPa * Ast / 1_000.0                    # kN

    # ── Punto de balance ─────────────────────────────────────────────────────
    eps_y = fy_MPa / Es
    xb    = d * 0.003 / (0.003 + eps_y)
    ab    = beta1 * xb

    Cc = 0.85 * fc_MPa * ab * b    # N  (bloque de compresión en el hormigón)

    eps_s_prime = 0.003 * (xb - dp) / xb if xb > 1e-6 else 0.0
    fs_prime    = min(fy_MPa, Es * eps_s_prime)
    Cs = Ast_s * (fs_prime - 0.85 * fc_MPa)                   # N
    T  = Ast_s * fy_MPa                                        # N

    Pb = Cc + Cs - T                                           # N

    # Momento respecto al centroide de la sección (h/2)
    Mb = (Cc * (h / 2.0 - ab / 2.0)
          + abs(Cs) * (h / 2.0 - dp)
          + T * (d - h / 2.0))                                 # N·mm

    phi_Pb = 0.65 * Pb / 1_000.0                              # kN
    phi_Mb = 0.65 * Mb / 1_000_000.0                          # kN·m

    # ── Momento puro (Pu = 0) ────────────────────────────────────────────────
    a_0 = Ast_s * fy_MPa / (0.85 * fc_MPa * b)
    Mn  = Ast_s * fy_MPa * (d - a_0 / 2.0)                   # N·mm
    phi_Mn = 0.90 * Mn / 1_000_000.0                          # kN·m

    return {
        "phi_Pn_max_kN": round(phi_Pn_max, 1),
        "phi_Pb_kN":     round(max(phi_Pb, 0.0), 1),
        "phi_Mb_kNm":    round(phi_Mb, 1),
        "phi_Mn_kNm":    round(max(phi_Mn, 0.1), 1),
        "phi_Pt_kN":     round(phi_Pt, 1),
        "Ag_m2":         round(Ag / 1_000_000.0, 4),
        "Ast_cm2":       round(Ast / 100.0, 2),
        "rho_pct":       round(rho * 100.0, 2),
        "b_m": b_m, "h_m": h_m, "fc_MPa": fc_MPa,
    }


# ── Verificación de un punto (Pu, Mu) ────────────────────────────────────────

def check_pm(Pu_kN: float, Mu_kNm: float, cap: dict) -> dict:
    """
    Verifica si el punto (Pu, Mu) está dentro de la envolvente P-M.

    La curva se aproxima por tramos lineales que unen los cuatro puntos clave:
        (φPn_max, 0) → (φPb, φMb) → (0, φMn) → (–φPt, 0)

    Retorna dcr (ratio demanda/capacidad) y ok (bool).
    """
    Pmax = cap["phi_Pn_max_kN"]
    Pb   = cap["phi_Pb_kN"]
    Mb   = cap["phi_Mb_kNm"]
    Mn   = cap["phi_Mn_kNm"]
    Pt   = cap["phi_Pt_kN"]

    Mu_abs = abs(Mu_kNm)

    # Fuera del extremo de compresión → fallo inmediato
    if Pu_kN > Pmax:
        return {"dcr": round(Pu_kN / max(Pmax, 0.001), 3), "ok": False,
                "Mu_cap_kNm": 0.0, "limit": "P_max"}

    # Interpolación lineal por tramos en la envolvente P-M
    if Pb >= Pmax:
        Mu_cap = Mb
    elif Pu_kN >= Pb:
        t = (Pu_kN - Pmax) / (Pb - Pmax)
        Mu_cap = t * Mb
    elif Pu_kN >= 0.0:
        t = (Pu_kN - Pb) / (0.0 - Pb) if abs(Pb) > 0.1 else 0.0
        Mu_cap = Mb + t * (Mn - Mb)
    else:
        t = (-Pu_kN) / Pt if Pt > 0.1 else 1.0
        Mu_cap = max(Mn * (1.0 - t), 0.0)

    Mu_cap = max(Mu_cap, 0.001)
    dcr_m  = Mu_abs / Mu_cap

    # DCR de compresión pura (complementario)
    dcr_p  = Pu_kN / Pmax if Pmax > 0 else 0.0

    dcr = max(dcr_m, max(dcr_p, 0.0))

    return {
        "dcr":          round(dcr, 3),
        "ok":           dcr <= 1.0,
        "Mu_cap_kNm":   round(Mu_cap, 1),
    }


# ── Distribución de cargas por piso (método del pórtico) ─────────────────────

def distribute_gravity(
    story_masses_t: dict[str, float],
    columns_by_story: dict[str, list[str]],
    story_order: list[str],
    g: float = 9.81,
) -> dict[str, float]:
    """
    Distribuye la carga gravitatoria acumulada (desde techo hasta cada piso)
    de forma igual entre las columnas del piso.

    story_masses_t  : {story_name: masa_en_toneladas}
    columns_by_story: {story_name: [frame_id, ...]}
    story_order     : pisos de base a techo
    Retorna {frame_id: Pu_gravity_kN}
    """
    gravity: dict[str, float] = {}

    # Peso acumulado de techo hacia abajo
    cumulative_kN = 0.0
    for story in reversed(story_order):
        mass_t = story_masses_t.get(story, 0.0)
        cumulative_kN += mass_t * g   # kN en este piso
        cols = columns_by_story.get(story, [])
        n = len(cols)
        if n == 0:
            continue
        pu_per_col = cumulative_kN / n
        for fid in cols:
            gravity[fid] = round(pu_per_col, 1)

    return gravity


def distribute_seismic_moment(
    story_shears_kN: dict[str, float],
    columns_by_story: dict[str, list[str]],
    story_heights_m: dict[str, float],
    story_order: list[str],
) -> dict[str, float]:
    """
    Portal method: distribuye el cortante de piso equitativamente entre columnas.
    Momento en el extremo = cortante × altura_piso / 2 (punto de inflexión a media altura).
    Retorna {frame_id: Mu_seismic_kNm}
    """
    moments: dict[str, float] = {}
    for story in story_order:
        shear = story_shears_kN.get(story, 0.0)
        h     = story_heights_m.get(story, 3.0)
        cols  = columns_by_story.get(story, [])
        n     = len(cols)
        if n == 0:
            continue
        mu = abs(shear) / n * (h / 2.0)
        for fid in cols:
            moments[fid] = round(mu, 2)
    return moments
