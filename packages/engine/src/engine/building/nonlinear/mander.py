"""
Modelo de confinamiento de Mander (1988) para secciones rectangulares de
concreto reforzado.

Referencia:
    Mander J.B., Priestley M.J.N., Park R. (1988).
    "Theoretical Stress-Strain Model for Confined Concrete".
    Journal of Structural Engineering ASCE 114(8), 1804-1826.

Formulación empleada (sección rectangular confinada por estribos cerrados):

  Presión lateral efectiva por dirección:
      f_le_x = k_e · ρ_x · f_yh
      f_le_y = k_e · ρ_y · f_yh

      donde ρ_x = Σ A_tie_x / (s · h_c)   (cuantía transversal paralela a x)
            ρ_y = Σ A_tie_y / (s · b_c)   (cuantía transversal paralela a y)

  Coeficiente de confinamiento efectivo (ec. 3 del paper, 1988):
      k_e = [1 - Σ w'_i² / (6·b_c·h_c)] · [1 - s'/(2·b_c)] · [1 - s'/(2·h_c)]
            / (1 - ρ_cc)

      s'   = separación clara vertical entre estribos = s - d_bh
      w'_i = separación clara entre barras longitudinales adyacentes (asumida
             uniforme en cada cara: w' = (b_c - n_bars·d_b) / (n_bars - 1))
      ρ_cc = cuantía longitudinal referida al núcleo = A_st / (b_c·h_c)

  Esfuerzo de compresión confinado (ec. 7, caso unidireccional):
      f_cc' = f'_c · [ -1.254 + 2.254·√(1 + 7.94·f_l'/f'_c) - 2·f_l'/f'_c ]

  Para presiones biaxiales desiguales (f_le_x ≠ f_le_y) se emplea la fig. 4 del
  paper (gráfico de interacción). Para simplicidad y robustez numérica, se usa
  la aproximación de Paulay & Priestley (1992): f_l' ≈ (f_le_x + f_le_y) / 2 —
  consistente con lo que hace OpenSees en Concrete04 cuando se da k=K global.

  Deformación de compresión confinada:
      ε_cc = ε_co · (1 + 5·(f_cc'/f'_c - 1))      (ec. 5)
      ε_cu = 0.004 + 1.4·ρ_s·f_yh·ε_sm / f_cc'     (ec. 20)

      donde ρ_s = ρ_x + ρ_y, y ε_sm ≈ 0.15 (deformación de ruptura del acero).

Unidades: f'c, f_yh, f_cc' en MPa. Dimensiones en metros (b, h, cover) y
milímetros (d_b, d_bh, s). Devuelve K = f_cc'/f'_c adimensional.
"""
from __future__ import annotations

import math
from dataclasses import dataclass


_EPS_CO    = 0.002   # deformación pico del concreto no confinado
_EPS_SM    = 0.15    # deformación de ruptura del acero (Mander típico)
_EPS_SP    = 0.006   # deformación de spalling del concreto no confinado


@dataclass(frozen=True)
class ConfinementResult:
    """Resultado del cálculo de confinamiento Mander."""
    K:           float   # f_cc'/f'_c
    fcc_MPa:     float   # resistencia confinada
    fco_MPa:     float   # resistencia no confinada (= f'c)
    eps_co:      float   # deformación pico no confinada (fijo = 0.002)
    eps_cc:      float   # deformación pico confinada
    eps_cu:      float   # deformación última confinada
    eps_sp:      float   # deformación de spalling (no confinado)
    k_e:         float   # coeficiente de confinamiento efectivo
    rho_x:       float   # cuantía transversal paralela a x
    rho_y:       float   # cuantía transversal paralela a y
    rho_s:       float   # suma rho_x + rho_y (cuantía volumétrica equivalente)
    f_le_x_MPa:  float   # presión efectiva en x
    f_le_y_MPa:  float   # presión efectiva en y
    fl_prime_MPa: float  # presión equivalente usada en Mander (promedio)
    b_core_m:    float   # ancho del núcleo (centro a centro de estribos)
    h_core_m:    float   # alto del núcleo
    s_mm:        float   # separación de estribos usada
    source:      str     # "designed" | "default"


def _bar_area_mm2(db_mm: float) -> float:
    return math.pi * db_mm * db_mm / 4.0


def mander_rect_confinement(
    b_m:          float,       # dimensión de la sección (dirección paralela a y)
    h_m:          float,       # dimensión perpendicular (paralela a z local)
    cover_m:      float,       # recubrimiento al centro del estribo
    fc_MPa:       float,       # f'c
    fy_tie_MPa:   float,       # f_yh del estribo (acero transversal)
    db_tie_mm:    float,       # diámetro de la rama del estribo
    s_mm:         float,       # separación de estribos (centro a centro)
    n_legs_b:     int,         # ramas paralelas a dirección 'b' (atan carga en y)
    n_legs_h:     int,         # ramas paralelas a dirección 'h' (atan carga en z)
    n_long_bars:  int,         # total de barras longitudinales en el perímetro
    db_long_mm:   float,       # diámetro de las barras longitudinales
    source:       str = "designed",
) -> ConfinementResult:
    """
    Calcula el confinamiento Mander para una sección rectangular estribada.

    Convención: 'b' es la dimensión paralela al eje local y (ancho),
                'h' es la dimensión paralela al eje local z (alto).
    Las "n_legs_b" son las ramas del estribo que viajan en dirección b
    (y por lo tanto generan presión lateral en dirección h = z local).
    """
    # Dimensiones del núcleo (centro de estribos a centro de estribos)
    b_core = max(b_m - 2.0 * cover_m, 0.05)
    h_core = max(h_m - 2.0 * cover_m, 0.05)
    b_core_mm = b_core * 1000.0
    h_core_mm = h_core * 1000.0

    # Área de una rama de estribo
    A_tie = _bar_area_mm2(db_tie_mm)       # mm²
    A_long = _bar_area_mm2(db_long_mm)     # mm²

    # Cuantías transversales (Mander 1988, ec. 2):
    #   ρ_x = A_sx / (s · h_c)  → presión en dirección x = b
    #   ρ_y = A_sy / (s · b_c)  → presión en dirección y = h
    # donde A_sx = n_legs_h × A_tie (ramas perpendiculares a b, "cruzan" h)
    #       A_sy = n_legs_b × A_tie (ramas perpendiculares a h, "cruzan" b)
    A_sx = max(n_legs_h, 2) * A_tie
    A_sy = max(n_legs_b, 2) * A_tie
    rho_x = A_sx / max(s_mm * h_core_mm, 1.0)
    rho_y = A_sy / max(s_mm * b_core_mm, 1.0)

    # Separación de barras longitudinales (asumidas uniformes por cara)
    # Separación libre w' = (b_core - n_face·d_b) / (n_face - 1)
    # Simplificación: asumir n_long_bars distribuido perimetralmente, con
    # n_face = max(2, n_long_bars // 4 + 1) por cara.
    n_face = max(2, int(round(n_long_bars / 4.0)) + 1)
    w_prime_b = max(
        (b_core_mm - n_face * db_long_mm) / max(n_face - 1, 1),
        0.0,
    )
    w_prime_h = max(
        (h_core_mm - n_face * db_long_mm) / max(n_face - 1, 1),
        0.0,
    )
    # Σw'² en el perímetro (contribución de las 4 caras)
    sum_w2 = 2 * (n_face - 1) * w_prime_b**2 + 2 * (n_face - 1) * w_prime_h**2

    # Separación clara vertical entre estribos
    s_clear = max(s_mm - db_tie_mm, 1.0)

    # Cuantía longitudinal referida al núcleo
    A_st = max(n_long_bars, 4) * A_long
    rho_cc = min(A_st / max(b_core_mm * h_core_mm, 1.0), 0.08)

    # Coeficiente de confinamiento efectivo (Mander 1988, ec. 3)
    term1 = max(1.0 - sum_w2 / max(6.0 * b_core_mm * h_core_mm, 1.0), 0.0)
    term2 = max(1.0 - s_clear / (2.0 * b_core_mm), 0.0)
    term3 = max(1.0 - s_clear / (2.0 * h_core_mm), 0.0)
    denom = max(1.0 - rho_cc, 0.05)
    k_e = term1 * term2 * term3 / denom
    k_e = max(0.0, min(k_e, 1.0))

    # Presiones laterales efectivas por dirección
    f_le_x = k_e * rho_x * fy_tie_MPa
    f_le_y = k_e * rho_y * fy_tie_MPa

    # Promedio equivalente (aproximación común — Paulay & Priestley 1992)
    f_l_prime = 0.5 * (f_le_x + f_le_y)

    # Resistencia confinada (Mander 1988, ec. 7)
    if f_l_prime <= 0.001 or fc_MPa <= 0.1:
        fcc = fc_MPa
    else:
        r = f_l_prime / fc_MPa
        fcc = fc_MPa * (-1.254 + 2.254 * math.sqrt(1.0 + 7.94 * r) - 2.0 * r)
        fcc = max(fcc, fc_MPa)

    K = fcc / fc_MPa if fc_MPa > 0.1 else 1.0

    # Deformación pico confinada (Mander 1988, ec. 5)
    eps_cc = _EPS_CO * (1.0 + 5.0 * (K - 1.0))

    # Deformación última confinada (ec. 20 — forma simplificada)
    rho_s = rho_x + rho_y
    eps_cu = 0.004 + 1.4 * rho_s * fy_tie_MPa * _EPS_SM / max(fcc, 1.0)
    eps_cu = max(eps_cu, 2.0 * eps_cc)       # al menos 2·ε_cc
    eps_cu = min(eps_cu, 0.030)              # cap físico razonable

    return ConfinementResult(
        K            = round(K, 4),
        fcc_MPa      = round(fcc, 2),
        fco_MPa      = round(fc_MPa, 2),
        eps_co       = _EPS_CO,
        eps_cc       = round(eps_cc, 5),
        eps_cu       = round(eps_cu, 5),
        eps_sp       = _EPS_SP,
        k_e          = round(k_e, 4),
        rho_x        = round(rho_x, 6),
        rho_y        = round(rho_y, 6),
        rho_s        = round(rho_s, 6),
        f_le_x_MPa   = round(f_le_x, 3),
        f_le_y_MPa   = round(f_le_y, 3),
        fl_prime_MPa = round(f_l_prime, 3),
        b_core_m     = round(b_core, 4),
        h_core_m     = round(h_core, 4),
        s_mm         = round(s_mm, 1),
        source       = source,
    )


def default_confinement(fc_MPa: float) -> ConfinementResult:
    """
    Fallback cuando no se dispone de datos del estribo: K=1.3 (concreto
    "ligeramente confinado"), ε_cc = 0.004, ε_cu = 0.016. Es el default
    histórico del `NLBuildingOPSBuilder` de muros.
    """
    fcc = 1.3 * fc_MPa
    return ConfinementResult(
        K            = 1.3,
        fcc_MPa      = round(fcc, 2),
        fco_MPa      = round(fc_MPa, 2),
        eps_co       = _EPS_CO,
        eps_cc       = 0.004,
        eps_cu       = 0.016,
        eps_sp       = _EPS_SP,
        k_e          = 0.0,
        rho_x        = 0.0,
        rho_y        = 0.0,
        rho_s        = 0.0,
        f_le_x_MPa   = 0.0,
        f_le_y_MPa   = 0.0,
        fl_prime_MPa = 0.0,
        b_core_m     = 0.0,
        h_core_m     = 0.0,
        s_mm         = 0.0,
        source       = "default",
    )


def confinement_to_dict(c: ConfinementResult) -> dict:
    """Serializa el resultado a dict (consumible por el spec JSON)."""
    return {
        "K":            c.K,
        "fcc_MPa":      c.fcc_MPa,
        "fco_MPa":      c.fco_MPa,
        "eps_co":       c.eps_co,
        "eps_cc":       c.eps_cc,
        "eps_cu":       c.eps_cu,
        "eps_sp":       c.eps_sp,
        "k_e":          c.k_e,
        "rho_x":        c.rho_x,
        "rho_y":        c.rho_y,
        "rho_s":        c.rho_s,
        "f_le_x_MPa":   c.f_le_x_MPa,
        "f_le_y_MPa":   c.f_le_y_MPa,
        "fl_prime_MPa": c.fl_prime_MPa,
        "b_core_m":     c.b_core_m,
        "h_core_m":     c.h_core_m,
        "s_mm":         c.s_mm,
        "source":       c.source,
    }
