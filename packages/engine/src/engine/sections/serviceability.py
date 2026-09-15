"""Análisis de servicio y fisuración — Módulo 2.

Calcula las propiedades relevantes para el análisis lineal en el rango de
servicio y para el diseño por deflexiones/fisuración:

  · Mcr — momento de fisuración                (NSR-10 C.9.5.2.3, ACI 24.2.3.5)
  · fr  — módulo de rotura                     fr = 0.62·√f'c
  · Ig  — inercia bruta (sección no fisurada)
  · Icr — inercia fisurada (sección transformada, concreto sin tracción)
  · Ie  — inercia efectiva de Branson          (NSR-10 C.9.5.2.3, Ec. C.9-8)
  · Curvatura de fisuración φcr = Mcr / (Ec·Ig)
  · Recomendación NSR-10 A.5.3 para análisis sísmico (secciones fisuradas)

Referencias:
  - NSR-10 Título C, Sec. C.9.5 (Deflexiones).
  - NSR-10 Título A, Sec. A.5.3 (Secciones para análisis).
  - ACI 318-19, §24.2.3, §6.6.3.1 (secciones fisuradas para análisis).
  - MacGregor & Wight (2016), Reinforced Concrete: Mechanics & Design, Cap. 9.
  - Branson (1965), Instantaneous and Time-Dependent Deflections of Simple
    and Continuous Reinforced Concrete Beams.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Literal

from engine.sections.document import (
    RectShape, CircShape, PolygonShape, SectionDocument,
    IShape, TShape, LShape, DoubleTShape,
)
from engine.sections.reinforcement import BAR_AREAS_MM2
from engine.sections.section_properties import (
    compute_geometric_properties, _shape_polygon, _polygon_integrals, _clip_polygon_below,
)


ElementKind = Literal["beam", "column", "wall", "slab_2d", "diaphragm"]


# ─────────────────────────────────────────────────────────────────────────────
# Resultado
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class ServiceabilityResult:
    # ── Materiales derivados ──
    fr_MPa:          float     # módulo de rotura
    Ec_MPa:          float     # módulo de elasticidad del concreto (NSR-10 C.8.5.1)
    Es_MPa:          float
    n:               float     # ratio modular Es/Ec

    # ── Fisuración ──
    Mcr_kNm:         float     # momento de fisuración positivo
    Mcr_neg_kNm:     float     # momento de fisuración negativo (asimetría)
    yt_mm:           float     # distancia del centroide a la fibra en tracción
    Ig_cm4:          float

    # ── Sección fisurada ──
    Icr_cm4:         float     # calculado sobre eje horizontal (flexión positiva)
    c_neutral_mm:    float     # profundidad del eje neutro fisurado (desde fibra comp.)

    # ── Inercia efectiva (para Ma dado) ──
    Ma_kNm:          float     # momento aplicado usado para calcular Ie
    Ie_cm4:          float     # inercia efectiva Branson

    # ── Curvaturas de servicio ──
    phi_cr_1_per_km: float     # curvatura al fisurar = Mcr / (Ec·Ig)
    phi_service_1_per_km: float # curvatura aproximada bajo Ma = Ma / (Ec·Ie)

    # ── NSR-10 A.5.3 (análisis sísmico) ──
    Ie_over_Ig_recommended: float
    element_kind:    str
    Ie_recommended_cm4: float

    notes:           list[str] = field(default_factory=list)


# ─────────────────────────────────────────────────────────────────────────────
# Ec del concreto y fr
# ─────────────────────────────────────────────────────────────────────────────

def concrete_modulus(fpc_MPa: float, wc_kg_m3: float = 2400.0) -> float:
    """Módulo de elasticidad del concreto.

    NSR-10 C.8.5.1 (Ec. C.8-1 para concreto normal): Ec = 4700·√f'c  [MPa]
    ACI 318-19 §19.2.2.1(b) idéntico.
    Para concreto de densidad wc: multiplicar por (wc/2400)^1.5.
    """
    Ec = 4700.0 * math.sqrt(max(fpc_MPa, 0.0))
    if abs(wc_kg_m3 - 2400.0) > 1.0:
        Ec *= (wc_kg_m3 / 2400.0) ** 1.5
    return Ec


def modulus_of_rupture(fpc_MPa: float, lam: float = 1.0) -> float:
    """fr = 0.62·λ·√f'c [MPa] — NSR-10 C.9.5.2.3, ACI 24.2.3.5."""
    return 0.62 * lam * math.sqrt(max(fpc_MPa, 0.0))


# ─────────────────────────────────────────────────────────────────────────────
# Icr — inercia fisurada por iteración numérica
# ─────────────────────────────────────────────────────────────────────────────

def _cracked_neutral_axis(
    polygons: list[list[tuple[float, float]]],
    bars: list[tuple[float, float, float]],   # (y, z, As)
    n: float,
    y_top: float,
    y_bot: float,
) -> tuple[float, float, float]:
    """Encuentra el eje neutro para sección transformada por bisección.

    Convención: y positivo hacia arriba. Flexión positiva → concreto comprimido
    arriba del eje neutro, acero traccionado abajo.

    Sección transformada (estándar Nilson/Nawy):
      · concreto en compresión (y > y_n): área bruta
      · barras traccionadas (y < y_n): factor de transformación n
      · barras comprimidas (y > y_n): factor (n − 1) (se resta el concreto desplazado)

    Condición de equilibrio: momento estático de la sección transformada
    respecto al eje neutro = 0.

    Retorna (y_neutral, Icr, c_from_top_fiber).
    """
    tol = 1e-4
    lo, hi = y_bot, y_top
    y_n = 0.5 * (lo + hi)

    def q_transformed(y_n_trial: float) -> tuple[float, float]:
        """Retorna (Q_transformada respecto a y_n_trial, A_concreto_arriba)."""
        A_c = 0.0
        Q_c_local = 0.0
        for poly in polygons:
            below = _clip_polygon_below(poly, y_n_trial)
            intg_full = _polygon_integrals(poly)
            intg_below = _polygon_integrals(below)
            A_above = intg_full["A"] - intg_below["A"]
            Q_above = intg_full["Qz"] - intg_below["Qz"]
            # ∫(y − y_n) dA para la parte arriba
            Q_c_local += Q_above - y_n_trial * A_above
            A_c += A_above

        Q_s = 0.0
        for (yb, zb, As) in bars:
            if yb < y_n_trial:
                # barra en tracción → n·As, contribución negativa a Q (y-y_n<0)
                Q_s += n * As * (yb - y_n_trial)
            else:
                # barra en compresión → (n-1)·As
                Q_s += (n - 1.0) * As * (yb - y_n_trial)
        return Q_c_local + Q_s, A_c

    for _ in range(80):
        y_n = 0.5 * (lo + hi)
        Q_net, A_c = q_transformed(y_n)
        if A_c > 0 and abs(Q_net) < tol * A_c * (y_top - y_bot):
            break
        # Q_net > 0 → compresión domina el momento estático → subir el eje neutro
        # (para reducir el brazo de compresión y aumentar el de tracción)
        # Q_net < 0 → tracción domina → bajar el eje neutro
        if Q_net > 0:
            lo = y_n
        else:
            hi = y_n

    # Icr respecto al eje neutro (concreto arriba + acero transformado)
    Icr = 0.0
    for poly in polygons:
        below = _clip_polygon_below(poly, y_n)
        intg_full = _polygon_integrals(poly)
        intg_below = _polygon_integrals(below)
        A_above = intg_full["A"] - intg_below["A"]
        Q_above = intg_full["Qz"] - intg_below["Qz"]
        I_above = intg_full["Iz"] - intg_below["Iz"]
        # I respecto a y_n: I_orig − 2·y_n·Q_orig + y_n²·A_orig
        I_local = I_above - 2 * y_n * Q_above + y_n * y_n * A_above
        Icr += I_local
    for (yb, zb, As) in bars:
        factor = n if yb < y_n else (n - 1.0)
        Icr += factor * As * (yb - y_n) ** 2

    return y_n, Icr, y_top - y_n


# ─────────────────────────────────────────────────────────────────────────────
# Recomendaciones NSR-10 A.5.3 / ACI 6.6.3.1
# ─────────────────────────────────────────────────────────────────────────────

_NSR10_A53: dict[str, float] = {
    "beam":       0.35,
    "column":     0.70,
    "wall":       0.70,     # muro no fisurado (para fisurado usar 0.35)
    "wall_cracked": 0.35,
    "slab_2d":    0.25,
    "diaphragm":  0.50,
}


# ─────────────────────────────────────────────────────────────────────────────
# Función principal
# ─────────────────────────────────────────────────────────────────────────────

def compute_serviceability(
    doc: SectionDocument,
    Ma_kNm: float = 0.0,
    element_kind: ElementKind = "beam",
    lam: float = 1.0,
    wall_cracked: bool = False,
) -> ServiceabilityResult:
    """Calcula todas las propiedades de servicio y fisuración de una sección.

    Args:
        doc:           SectionDocument con geometría + materiales + barras.
        Ma_kNm:        momento aplicado en servicio (para Ie de Branson).
        element_kind:  "beam" | "column" | "wall" | "slab_2d" | "diaphragm".
        lam:           factor de concreto ligero para fr (1.0 normal).
        wall_cracked:  para muros: True → 0.35·Ig, False → 0.70·Ig (A.5.3).
    """
    props = compute_geometric_properties(doc)

    cdef = doc.default_concrete()
    sdef = doc.default_steel()
    fpc = cdef.fpc if cdef else 28.0
    fy  = sdef.fy if sdef else 420.0
    Es  = sdef.Es if sdef else 200_000.0

    Ec = concrete_modulus(fpc)
    fr = modulus_of_rupture(fpc, lam)
    n_ratio = Es / Ec if Ec > 0 else 0.0

    # ── Ig: inercia BRUTA del concreto puro (sin barras) según NSR-10 C.9.5.2.3 ──
    # (props.Iz incluye contribución de barras — para Ig de servicio no la queremos)
    polygons = [_shape_polygon(r.shape) for r in doc.regions if not r.is_void]
    # Centroide del concreto puro:
    A_c_tot = 0.0
    Qz_c_tot = 0.0
    Qy_c_tot = 0.0
    Iz_orig_c = 0.0
    for poly in polygons:
        intg = _polygon_integrals(poly)
        A_c_tot   += intg["A"]
        Qz_c_tot  += intg["Qz"]
        Qy_c_tot  += intg["Qy"]
        Iz_orig_c += intg["Iz"]
    yc = Qz_c_tot / A_c_tot if A_c_tot > 0 else 0.0
    zc = Qy_c_tot / A_c_tot if A_c_tot > 0 else 0.0
    Ig = Iz_orig_c - A_c_tot * yc * yc     # Steiner al centroide

    # Fibras extremas del concreto puro
    all_pts = [pt for poly in polygons for pt in poly]
    y_max = max(p[0] for p in all_pts) - yc if all_pts else 0.0
    y_min = min(p[0] for p in all_pts) - yc if all_pts else 0.0
    yt_pos = abs(y_min)        # para flexión positiva, tracción abajo → yt = |y_min|
    yt_neg = abs(y_max)
    Mcr_pos = fr * Ig / max(yt_pos, 1e-9)         # N·mm
    Mcr_neg = fr * Ig / max(yt_neg, 1e-9)

    # ── Icr (por iteración) — flexión positiva ──
    polygons_c = [[(y - yc, z - zc) for (y, z) in poly] for poly in polygons]

    bars_c = [(b.y - yc, b.z - zc, BAR_AREAS_MM2.get(b.bar_size, 0.0)) for b in doc.bars]

    try:
        y_n, Icr, c_from_top = _cracked_neutral_axis(
            polygons_c, bars_c, n_ratio, y_max, y_min,
        )
    except Exception:
        y_n, Icr, c_from_top = 0.0, Ig, 0.0

    # ── Ie de Branson ──
    Ma = abs(Ma_kNm) * 1e6    # a N·mm
    if Ma < 1e-9 or Ma <= Mcr_pos:
        Ie = Ig
    else:
        ratio = Mcr_pos / Ma
        Ie = ratio ** 3 * Ig + (1 - ratio ** 3) * Icr
        Ie = min(Ie, Ig)

    # ── Curvaturas ──
    EI_g = Ec * Ig
    EI_e = Ec * Ie
    phi_cr = Mcr_pos / EI_g if EI_g > 0 else 0.0        # 1/mm
    phi_ser = Ma / EI_e if EI_e > 0 and Ma > 0 else 0.0

    # Convertir 1/mm → 1/km (× 1e6)
    phi_cr_km = phi_cr * 1e6
    phi_ser_km = phi_ser * 1e6

    # ── Recomendación NSR-10 A.5.3 ──
    if element_kind == "wall" and wall_cracked:
        Ie_ratio_A53 = _NSR10_A53["wall_cracked"]
        kind_label = "wall (fisurado)"
    else:
        Ie_ratio_A53 = _NSR10_A53.get(element_kind, 0.35)
        kind_label = element_kind
    Ie_A53 = Ie_ratio_A53 * Ig

    notes: list[str] = []
    if Ma > 0 and Ma <= Mcr_pos:
        notes.append(f"Ma ({Ma/1e6:.1f} kN·m) ≤ Mcr ({Mcr_pos/1e6:.1f} kN·m) → sección no fisurada, "
                     "Ie = Ig (no aplica Branson).")
    if abs(props.Iyz) > 0.01 * props.Iz:
        notes.append("Sección asimétrica (Iyz ≠ 0) — resultado aplica a flexión sobre eje z "
                     "principal aproximado. Para diseño formal usar ejes principales.")
    if Icr > Ig * 0.95:
        notes.append("Icr calculado ≈ Ig — la sección quizás no tiene armadura suficiente o "
                     "el eje neutro no se resolvió correctamente. Revisar.")

    return ServiceabilityResult(
        fr_MPa=fr,
        Ec_MPa=Ec,
        Es_MPa=Es,
        n=n_ratio,
        Mcr_kNm=Mcr_pos / 1e6,
        Mcr_neg_kNm=Mcr_neg / 1e6,
        yt_mm=yt_pos,
        Ig_cm4=Ig / 1e4,
        Icr_cm4=Icr / 1e4,
        c_neutral_mm=c_from_top,
        Ma_kNm=Ma_kNm,
        Ie_cm4=Ie / 1e4,
        phi_cr_1_per_km=phi_cr_km,
        phi_service_1_per_km=phi_ser_km,
        Ie_over_Ig_recommended=Ie_ratio_A53,
        element_kind=kind_label,
        Ie_recommended_cm4=Ie_A53 / 1e4,
        notes=notes,
    )
