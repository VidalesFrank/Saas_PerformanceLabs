"""
Selector de refuerzo longitudinal — NSR-10 / ACI 318.

COLUMNAS: la distribución perimetral governa.
  1. Se calcula la cantidad mínima de barras que cumplen s ≤ 200 mm
     en cada cara (Bc y Hc a partir del recubrimiento nominal).
  2. Con ese número mínimo de barras se busca el diámetro más pequeño
     que cubra el As requerido.
  3. Si el diámetro máximo (#11) sigue siendo insuficiente, se agregan
     barras a las caras largas (de dos en dos, una por cara) hasta cubrir As.

VIGAS: por área requerida por cara (superior e inferior).
  Se selecciona la combinación n×diámetro que cubre As_req con el menor
  número de barras posible y mayor diámetro (constructivamente más limpio).
  Si una sola capa no cabe en el ancho, se evalúa distribución en dos capas.

Unidades internas: mm, mm².  Interfaces públicas: cm².
"""
from __future__ import annotations

import math

# ── Catálogo de barras (equivalentes ASTM / NSR-10) ──────────────────────────

BARS: list[dict] = [
    {"label": "#3",  "diam_mm":  9.5,  "area_mm2":   71.0},
    {"label": "#4",  "diam_mm": 12.7,  "area_mm2":  127.0},
    {"label": "#5",  "diam_mm": 15.9,  "area_mm2":  200.0},
    {"label": "#6",  "diam_mm": 19.1,  "area_mm2":  284.0},
    {"label": "#7",  "diam_mm": 22.2,  "area_mm2":  387.0},
    {"label": "#8",  "diam_mm": 25.4,  "area_mm2":  510.0},
    {"label": "#9",  "diam_mm": 28.7,  "area_mm2":  645.0},
    {"label": "#10", "diam_mm": 32.3,  "area_mm2":  819.0},
    {"label": "#11", "diam_mm": 35.8,  "area_mm2": 1006.0},
]

_BAR_BY_LABEL = {b["label"]: b for b in BARS}

S_MAX_COL_MM = 200.0   # separación máxima entre barras longitudinales de columnas

def bar_area_mm2(label: str) -> float:
    return _BAR_BY_LABEL[label]["area_mm2"]

def bar_diam_mm(label: str) -> float:
    return _BAR_BY_LABEL[label]["diam_mm"]


# ── Helpers de distribución geométrica (columnas) ─────────────────────────────

def _geometry_min_bars(b_mm: float, h_mm: float, cover_mm: float) -> tuple[int, int, int]:
    """
    Calcula la distribución mínima de barras que garantiza s ≤ 200 mm
    en todas las caras del perímetro confinado.

    Parámetros
    ----------
    b_mm, h_mm : dimensiones de la sección en mm
    cover_mm   : recubrimiento nominal (a la cara exterior del estribo) en mm

    Retorna
    -------
    (n_total, n_int_B, n_int_H) donde:
      n_int_B = barras intermedias en cada cara corta (paralelas a B, en y=±hy)
      n_int_H = barras intermedias en cada cara larga (paralelas a H, en x=±bx)
      n_total = 4 + 2·n_int_B + 2·n_int_H
    """
    Bc = b_mm - 2.0 * cover_mm   # span de la cara corta entre esquinas
    Hc = h_mm - 2.0 * cover_mm   # span de la cara larga entre esquinas

    Bc = max(Bc, 0.001)
    Hc = max(Hc, 0.001)

    n_sp_B = max(1, math.ceil(Bc / S_MAX_COL_MM))
    n_sp_H = max(1, math.ceil(Hc / S_MAX_COL_MM))

    n_int_B = n_sp_B - 1   # intermedias por cara corta (top y bottom)
    n_int_H = n_sp_H - 1   # intermedias por cara larga (left y right)

    n_total = 4 + 2 * n_int_B + 2 * n_int_H
    return n_total, n_int_B, n_int_H


def _distribute_n_bars(n_total: int, b_mm: float, h_mm: float, cover_mm: float) -> tuple[int, int]:
    """
    Dado un n_total de barras, calcula n_int_B y n_int_H que minimizan la
    separación máxima en cualquier cara, manteniendo la distribución simétrica.

    Se usa en verify_column_arrangement cuando el usuario cambia n_bars.
    """
    # La distribución geométrica mínima fija n_int_B
    _, n_int_B_min, _ = _geometry_min_bars(b_mm, h_mm, cover_mm)
    n_int_B = n_int_B_min

    n_extra = n_total - 4 - 2 * n_int_B
    # Si sobran barras, van a las caras largas
    if n_extra < 0:
        # n_total es menor que el mínimo geométrico; reducir n_int_B si es necesario
        while n_int_B > 0 and (4 + 2 * n_int_B) > n_total:
            n_int_B -= 1
        n_extra = n_total - 4 - 2 * n_int_B

    n_int_H = max(0, n_extra // 2)
    return n_int_B, n_int_H


# ── Posiciones de barras (columnas) ───────────────────────────────────────────

def _column_bar_positions(
    b_mm:    float,
    h_mm:    float,
    d_c:     float,   # distancia del centroide de barra a la cara de la sección
    n_int_B: int,     # barras intermedias en cada cara corta (y = ±hy)
    n_int_H: int,     # barras intermedias en cada cara larga (x = ±bx)
) -> list[dict]:
    """
    Coordenadas de barras en mm desde el centroide de la sección.

    Convención: eje x → dirección B (ancho), eje y → dirección H (alto).

    Las 4 barras de esquina siempre van primero.
    Las barras intermedias de las caras cortas (top y bottom) varían en x.
    Las barras intermedias de las caras largas (left y right) varían en y.
    """
    bx = b_mm / 2.0 - d_c   # x de las barras de esquina
    hy = h_mm / 2.0 - d_c   # y de las barras de esquina

    bx = max(bx, 0.0)
    hy = max(hy, 0.0)

    positions: list[dict] = [
        {"x": -bx, "y": -hy},
        {"x": +bx, "y": -hy},
        {"x": +bx, "y": +hy},
        {"x": -bx, "y": +hy},
    ]

    # Intermedias en caras cortas (top y bottom, distribuidas en x)
    if n_int_B > 0:
        for i in range(1, n_int_B + 1):
            x = -bx + (2.0 * bx) * i / (n_int_B + 1)
            positions.append({"x": round(x, 1), "y": -hy})
            positions.append({"x": round(x, 1), "y": +hy})

    # Intermedias en caras largas (left y right, distribuidas en y)
    if n_int_H > 0:
        for i in range(1, n_int_H + 1):
            y = -hy + (2.0 * hy) * i / (n_int_H + 1)
            positions.append({"x": -bx, "y": round(y, 1)})
            positions.append({"x": +bx, "y": round(y, 1)})

    return [{"x": round(p["x"], 1), "y": round(p["y"], 1)} for p in positions]


# ── Selector de barras (columnas) ─────────────────────────────────────────────

def select_column_bars(
    As_req_cm2:    float,
    b_m:           float,
    h_m:           float,
    cover_m:       float = 0.040,
    tie_diam_mm:   float = 9.5,
    fy_MPa:        float = 420.0,
    fc_MPa:        float = 21.0,
    min_bar_label: str   = "#5",
) -> dict:
    """
    Selecciona barras longitudinales para columna rectangular.

    Algoritmo:
      1. Distribución mínima por criterio s ≤ 200 mm en cada cara.
      2. Con ese n_min, buscar el diámetro más pequeño que cubra As_req.
      3. Si #11 con n_min es insuficiente, agregar barras (2 por vez) a las
         caras largas hasta cubrir As_req o alcanzar un límite razonable.
      4. Verificar separación libre mínima (NSR-10 C.26.4.1).

    Retorna n_bars, bar_label, n_int_B, n_int_H, bar_positions, As_placed_cm2,
    rho_pct, warnings, errors, valid.
    """
    b_mm   = b_m * 1000.0
    h_mm   = h_m * 1000.0
    cov    = cover_m * 1000.0
    Ag     = b_mm * h_mm

    rho_min   = 0.01
    rho_max   = 0.08
    As_min_mm2 = rho_min * Ag
    As_max_mm2 = rho_max * Ag
    As_req_mm2 = As_req_cm2 * 100.0
    As_target  = max(As_req_mm2, As_min_mm2)

    warnings: list[str] = []
    errors:   list[str] = []

    if As_req_mm2 > As_max_mm2:
        errors.append(
            f"As requerido {As_req_cm2:.1f} cm² > As_max {As_max_mm2/100:.1f} cm² "
            f"(ρ_max=8%). Aumente la sección."
        )

    min_idx = next((i for i, b in enumerate(BARS) if b["label"] == min_bar_label), 2)

    # ── Paso 1: distribución mínima por geometría ─────────────────────────────
    n_min, n_int_B, n_int_H = _geometry_min_bars(b_mm, h_mm, cov)

    # ── Paso 2: menor diámetro que cubre As_target con n_min barras ──────────
    chosen_bar:   dict | None = None
    chosen_n:     int         = n_min
    chosen_n_iB:  int         = n_int_B
    chosen_n_iH:  int         = n_int_H

    for bar in BARS[min_idx:]:
        if n_min * bar["area_mm2"] >= As_target:
            chosen_bar = bar
            break

    # ── Paso 3: si #11 con n_min no alcanza, agregar barras a caras largas ───
    if chosen_bar is None:
        bar_max = BARS[-1]
        cur_n_iH = n_int_H
        cur_n    = n_min

        while cur_n * bar_max["area_mm2"] < As_target and cur_n < 48:
            cur_n_iH += 1
            cur_n = 4 + 2 * n_int_B + 2 * cur_n_iH

        chosen_bar  = bar_max
        chosen_n    = cur_n
        chosen_n_iB = n_int_B
        chosen_n_iH = cur_n_iH

        if chosen_n * chosen_bar["area_mm2"] < As_target:
            errors.append(
                "No fue posible cubrir As requerido con la sección actual. "
                "Aumente la sección o revise la carga."
            )
        else:
            warnings.append(
                f"Se agregaron barras a las caras largas para cubrir As requerido "
                f"({chosen_n} barras {chosen_bar['label']})."
            )
    else:
        chosen_n    = n_min
        chosen_n_iB = n_int_B
        chosen_n_iH = n_int_H

    # ── Verificar separación libre en cara larga ──────────────────────────────
    diam  = chosen_bar["diam_mm"]
    d_c   = cov + tie_diam_mm + diam / 2.0
    hy    = h_mm / 2.0 - d_c
    n_on_H_face = 2 + chosen_n_iH

    if n_on_H_face > 1 and hy > 0:
        free_H     = 2.0 * hy
        clear_H    = (free_H - n_on_H_face * diam) / (n_on_H_face - 1)
        min_clear  = max(1.5 * diam, 40.0)
        if clear_H < min_clear:
            warnings.append(
                f"Separación libre en cara larga ({clear_H:.0f} mm) < mínimo "
                f"({min_clear:.0f} mm). Considere reducir el diámetro."
            )

    # ── Verificar cuantías ────────────────────────────────────────────────────
    As_pl = chosen_n * chosen_bar["area_mm2"]
    rho   = As_pl / Ag

    if rho < rho_min:
        warnings.append(f"ρ = {rho*100:.2f}% < ρ_min = 1.0% (NSR-10 C.10.9.1)")
    if rho > rho_max:
        errors.append(f"ρ = {rho*100:.2f}% > ρ_max = 8.0% (NSR-10 C.10.9.1)")

    # ── Posiciones para visualización ─────────────────────────────────────────
    positions = _column_bar_positions(b_mm, h_mm, d_c, chosen_n_iB, chosen_n_iH)

    return {
        "n_bars":         chosen_n,
        "n_int_B":        chosen_n_iB,
        "n_int_H":        chosen_n_iH,
        "bar_label":      chosen_bar["label"],
        "diam_mm":        chosen_bar["diam_mm"],
        "As_req_cm2":     round(As_req_cm2, 2),
        "As_placed_cm2":  round(As_pl / 100.0, 2),
        "rho_pct":        round(rho * 100.0, 2),
        "bar_positions":  positions,
        "warnings":       warnings,
        "errors":         errors,
        "valid":          len(errors) == 0,
    }


def verify_column_arrangement(
    bar_label:   str,
    n_bars:      int,
    b_m:         float,
    h_m:         float,
    cover_m:     float = 0.040,
    tie_diam_mm: float = 9.5,
) -> dict:
    """
    Verifica el espaciamiento de una configuración editada manualmente.

    La distribución n_int_B / n_int_H se recalcula usando la regla geométrica
    como base para n_int_B, asignando las barras sobrantes a las caras largas.
    """
    b_mm = b_m * 1000.0
    h_mm = h_m * 1000.0
    cov  = cover_m * 1000.0
    Ag   = b_mm * h_mm

    bar   = _BAR_BY_LABEL.get(bar_label, BARS[2])
    diam  = bar["diam_mm"]
    d_c   = cov + tie_diam_mm + diam / 2.0
    As_pl = n_bars * bar["area_mm2"]
    rho   = As_pl / Ag

    n_int_B, n_int_H = _distribute_n_bars(n_bars, b_mm, h_mm, cov)
    n_on_H_face = 2 + n_int_H

    warnings: list[str] = []
    errors:   list[str] = []

    # Separación en cara larga
    hy = h_mm / 2.0 - d_c
    if n_on_H_face > 1 and hy > 0:
        free_H    = 2.0 * hy
        clear_H   = (free_H - n_on_H_face * diam) / (n_on_H_face - 1)
        min_clear = max(1.5 * diam, 40.0)
        if clear_H < min_clear:
            errors.append(
                f"Separación libre ({clear_H:.0f} mm) < mínimo "
                f"({min_clear:.0f} mm) (NSR-10 C.26.4.1)"
            )
    else:
        clear_H = 0.0

    # Separación en cara corta
    bx = b_mm / 2.0 - d_c
    n_on_B_face = 2 + n_int_B
    if n_on_B_face > 1 and bx > 0:
        free_B    = 2.0 * bx
        clear_B   = (free_B - n_on_B_face * diam) / (n_on_B_face - 1)
        min_clear = max(1.5 * diam, 40.0)
        if clear_B < min_clear:
            errors.append(
                f"Separación libre en cara corta ({clear_B:.0f} mm) < mínimo "
                f"({min_clear:.0f} mm) (NSR-10 C.26.4.1)"
            )

    if rho < 0.01:
        warnings.append(f"ρ = {rho*100:.2f}% < ρ_min = 1.0% (NSR-10 C.10.9.1)")
    if rho > 0.08:
        errors.append(f"ρ = {rho*100:.2f}% > ρ_max = 8.0% (NSR-10 C.10.9.1)")

    positions = _column_bar_positions(b_mm, h_mm, d_c, n_int_B, n_int_H)

    return {
        "n_bars":        n_bars,
        "n_int_B":       n_int_B,
        "n_int_H":       n_int_H,
        "bar_label":     bar_label,
        "diam_mm":       diam,
        "As_placed_cm2": round(As_pl / 100.0, 2),
        "rho_pct":       round(rho * 100.0, 2),
        "clear_mm":      round(clear_H, 1),
        "bar_positions": positions,
        "warnings":      warnings,
        "errors":        errors,
        "valid":         len(errors) == 0,
    }


# ── Vigas ─────────────────────────────────────────────────────────────────────

def select_beam_bars(
    As_req_cm2:    float,
    b_m:           float,
    h_m:           float,
    cover_m:       float = 0.040,
    tie_diam_mm:   float = 9.5,
    fy_MPa:        float = 420.0,
    fc_MPa:        float = 21.0,
    min_bar_label: str   = "#4",
) -> dict:
    """
    Selecciona barras longitudinales para una cara de viga (superior o inferior).

    Algoritmo:
      1. Buscar la solución en una sola capa que cubra As_req con el menor
         número de barras y mayor diámetro (preferir soluciones limpias).
      2. Si ninguna combinación de 1 capa cabe en el ancho, evaluar 2 capas.
      3. Verificar As ≥ As_req y espaciamiento libre ≥ max(db, 25mm).

    Mínimo 2 barras por cara (NSR-10 C.18.6.3).
    """
    b_mm   = b_m * 1000.0
    h_mm   = h_m * 1000.0
    cov    = cover_m * 1000.0
    As_req = As_req_cm2 * 100.0   # mm²

    min_idx = next((i for i, b in enumerate(BARS) if b["label"] == min_bar_label), 1)

    warnings: list[str] = []
    errors:   list[str] = []

    # ── Una capa ──────────────────────────────────────────────────────────────
    best: dict | None = None
    best_score = float("inf")

    for bar in BARS[min_idx:]:
        diam  = bar["diam_mm"]
        a_per = bar["area_mm2"]
        d_c   = cov + tie_diam_mm + diam / 2.0
        avail = b_mm - 2.0 * d_c   # ancho disponible entre extremos de armadura

        # n mínimo que cubra As_req (al menos 2)
        n_min_req = max(2, math.ceil(As_req / a_per))

        for n in range(n_min_req, 11):
            if avail <= 0 or n * diam > avail:
                break   # no caben físicamente

            # Espaciamiento libre
            clear = (avail - n * diam) / (n - 1) if n > 1 else avail - diam
            min_cl = max(diam, 25.0)   # NSR-10 C.26.4.2.1
            if clear < min_cl:
                break   # al agregar más barras el espaciamiento solo empeora

            As_pl = n * a_per
            if As_pl < As_req * 0.98:
                continue

            # Puntuación: preferir mayor diámetro (menos barras = solución más limpia)
            waste  = (As_pl - As_req) / max(As_req, 1.0)
            score  = waste * 50.0 + n * 2.0 - BARS.index(bar) * 5.0
            if score < best_score:
                best_score = score
                best = {"n": n, "bar": bar, "d_c": d_c, "layers": 1}

    # ── Dos capas (fallback si una capa no alcanza) ───────────────────────────
    if best is None:
        for bar in BARS[min_idx:]:
            diam  = bar["diam_mm"]
            a_per = bar["area_mm2"]
            d_c1  = cov + tie_diam_mm + diam / 2.0
            avail = b_mm - 2.0 * d_c1

            # Máximo de barras que caben en una capa
            n_max_layer = int(avail / (diam + max(diam, 25.0))) + 1 if avail > 0 else 0
            n_max_layer = max(n_max_layer, 0)

            if n_max_layer < 2:
                continue

            n_total_req = max(2, math.ceil(As_req / a_per))

            for n1 in range(2, n_max_layer + 1):
                n2 = n_total_req - n1
                if n2 < 0:
                    n2 = 0
                n_total = n1 + n2
                As_pl = n_total * a_per
                if As_pl < As_req * 0.98:
                    continue

                waste  = (As_pl - As_req) / max(As_req, 1.0)
                score  = waste * 50.0 + n_total * 2.0 - BARS.index(bar) * 5.0 + 20.0
                if score < best_score:
                    best_score = score
                    best = {"n": n_total, "bar": bar, "d_c": d_c1,
                            "layers": 2, "n_layer1": n1, "n_layer2": n2}

    # ── Fallback absoluto ─────────────────────────────────────────────────────
    if best is None:
        bar = BARS[-1]
        n   = max(2, math.ceil(As_req / bar["area_mm2"]))
        d_c = cov + tie_diam_mm + bar["diam_mm"] / 2.0
        best = {"n": n, "bar": bar, "d_c": d_c, "layers": 1}
        warnings.append("Configuración con restricciones relajadas. Verifique espaciamiento.")

    bar   = best["bar"]
    n     = best["n"]
    d_c   = best["d_c"]
    As_pl = n * bar["area_mm2"]
    layers = best.get("layers", 1)

    if layers == 2:
        warnings.append(
            f"Se requieren 2 capas de barras ({best.get('n_layer1',0)} + "
            f"{best.get('n_layer2',0)} barras {bar['label']})."
        )

    positions = _beam_bar_x_positions(b_mm, d_c, n)

    return {
        "n_bars":        n,
        "bar_label":     bar["label"],
        "diam_mm":       bar["diam_mm"],
        "As_req_cm2":    round(As_req_cm2, 2),
        "As_placed_cm2": round(As_pl / 100.0, 2),
        "layers":        layers,
        "bar_positions": positions,
        "warnings":      warnings,
        "errors":        errors,
        "valid":         len(errors) == 0,
    }


def _beam_bar_x_positions(b_mm: float, d_c: float, n: int) -> list[dict]:
    """
    Coordenadas x de barras de viga en mm desde el centroide de la sección.
    Solo retorna la componente x (la y la asigna el caller según cara sup/inf).
    """
    if n == 0:
        return []
    avail = b_mm - 2.0 * d_c
    if n == 1:
        xs = [0.0]
    else:
        step = avail / (n - 1) if avail > 0 else 0.0
        xs   = [-avail / 2.0 + step * i for i in range(n)]
    return [{"x": round(x, 1)} for x in xs]


def verify_beam_arrangement(
    bar_label:   str,
    n_bars:      int,
    b_m:         float,
    cover_m:     float = 0.040,
    tie_diam_mm: float = 9.5,
) -> dict:
    """Verifica el espaciamiento de una configuración de viga editada manualmente."""
    b_mm  = b_m * 1000.0
    cov   = cover_m * 1000.0
    bar   = _BAR_BY_LABEL.get(bar_label, BARS[1])
    diam  = bar["diam_mm"]
    d_c   = cov + tie_diam_mm + diam / 2.0
    avail = b_mm - 2.0 * d_c
    As_pl = n_bars * bar["area_mm2"]

    warnings: list[str] = []
    errors:   list[str] = []

    if n_bars < 2:
        errors.append("Mínimo 2 barras longitudinales por cara (NSR-10 C.18.6.3)")

    if avail <= 0 or n_bars * diam > avail:
        errors.append(
            f"Las {n_bars} barras {bar_label} no caben en el ancho disponible "
            f"({max(avail,0):.0f} mm). Reduzca el diámetro o el número de barras."
        )
    elif n_bars > 1:
        clear  = (avail - n_bars * diam) / (n_bars - 1)
        min_cl = max(diam, 25.0)
        if clear < min_cl:
            errors.append(
                f"Separación libre ({clear:.0f} mm) < mínimo "
                f"({min_cl:.0f} mm) (NSR-10 C.26.4.2.1)"
            )

    return {
        "n_bars":        n_bars,
        "bar_label":     bar_label,
        "diam_mm":       diam,
        "As_placed_cm2": round(As_pl / 100.0, 2),
        "bar_positions": _beam_bar_x_positions(b_mm, d_c, n_bars),
        "warnings":      warnings,
        "errors":        errors,
        "valid":         len(errors) == 0,
    }
