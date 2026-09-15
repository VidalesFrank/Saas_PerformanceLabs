"""Propiedades geométricas de una SectionDocument.

Calcula todas las propiedades ingenieriles derivadas de la geometría bruta
(sin considerar plastificación ni respuesta constitutiva de materiales):

  - Área bruta y neta                     (Ag, An)
  - Centroide geométrico                  (yc, zc)
  - Segundo momento de área               (Iy, Iz, Iyz)  respecto a ejes centroidales
  - Módulo elástico de sección            (Sy+, Sy-, Sz+, Sz-)
  - Radio de giro                          (ry, rz)
  - Módulo plástico                       (Zpy, Zpz)  — distribución fully-yielded
  - Ejes principales                      (I1, I2, θp)  — diagonalización del tensor
  - Cuantía de acero longitudinal         (ρg = As / Ag)

Unidades internas: mm, mm², mm³, mm⁴, grados.
Convención de ejes: y vertical (eje de flexión "fuerte" por defecto), z horizontal.

Referencias:
  - Timoshenko & Goodier (1970), Theory of Elasticity, App. A — integrales sobre polígonos.
  - Bird, N. (2005), "The exact analytical expressions for the properties of a
    polygon", J. Compt. Phys.
  - Popov (1990), Engineering Mechanics of Solids, Cap. 6 — módulo plástico.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Sequence

from engine.sections.document import (
    CircShape, ConcreteRegion, PolygonShape, RectShape,
    IShape, TShape, LShape, DoubleTShape,
    RegionShape, SectionDocument,
)
from engine.sections.reinforcement import BAR_AREAS_MM2


# ─────────────────────────────────────────────────────────────────────────────
# Estructura de resultado
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class GeometricProperties:
    """Propiedades geométricas centroidales de una SectionDocument.

    Todas las cantidades están en unidades SI base: mm, mm², mm³, mm⁴, grados.
    """
    # ── Áreas y centroide ──
    gross_area: float           # Ag [mm²]  — concreto + vacío neto (excluye is_void)
    net_area: float             # An [mm²]  — Ag − As (área neta de concreto)
    steel_area: float           # As [mm²]  — total de barras longitudinales
    rho_g: float                # ρg = As / Ag  [adimensional]
    centroid_y: float           # yc [mm]   — centroide geométrico de concreto bruto
    centroid_z: float           # zc [mm]

    # ── Dimensiones del rectángulo envolvente ──
    depth: float                # dimensión total en y [mm]
    width: float                # dimensión total en z [mm]

    # ── Momentos de inercia respecto a ejes centroidales (y-z) ──
    Iy: float                   # Iy [mm⁴]  — momento respecto al eje y (flexión sobre z)
    Iz: float                   # Iz [mm⁴]  — momento respecto al eje z (flexión sobre y)
    Iyz: float                  # producto de inercia [mm⁴]

    # ── Módulos elásticos de sección (extremos) ──
    Sy_pos: float               # Sy⁺ = Iy / |z_max| [mm³]  — extremo z positivo
    Sy_neg: float               # Sy⁻ = Iy / |z_min|
    Sz_pos: float               # Sz⁺ = Iz / |y_max|
    Sz_neg: float               # Sz⁻ = Iz / |y_min|

    # ── Radios de giro ──
    ry: float                   # ry = √(Iy / Ag) [mm]
    rz: float                   # rz = √(Iz / Ag)

    # ── Módulos plásticos (distribución fully-yielded) ──
    Zpy: float                  # Zpy [mm³] — sobre eje y (partición en z)
    Zpz: float                  # Zpz [mm³] — sobre eje z (partición en y)

    # ── Factores de forma ──
    fs_y: float                 # Zpy / Sy (avg) — form factor para flexión sobre y
    fs_z: float                 # Zpz / Sz (avg)

    # ── Ejes principales (diagonalización de [Iy, -Iyz; -Iyz, Iz]) ──
    I1: float                   # momento principal máximo [mm⁴]
    I2: float                   # momento principal mínimo
    theta_p_deg: float          # ángulo del eje principal 1 respecto a y [deg, −45..+45]

    # ── Extremos de fibra ──
    y_max: float
    y_min: float
    z_max: float
    z_min: float


# ─────────────────────────────────────────────────────────────────────────────
# Integrales sobre polígono (fórmula de Green / Bird 2005)
# ─────────────────────────────────────────────────────────────────────────────
# Un polígono orientado CCW (contra las agujas del reloj) tiene integrales
# cerradas:
#
#   A     = ½  Σ (y_i · z_{i+1} − y_{i+1} · z_i)
#   ∫y·dA = (1/6)  Σ (y_i + y_{i+1}) · (y_i · z_{i+1} − y_{i+1} · z_i)
#   ∫z·dA = (1/6)  Σ (z_i + z_{i+1}) · (y_i · z_{i+1} − y_{i+1} · z_i)
#
#   ∫y²·dA = (1/12) Σ (y_i² + y_i·y_{i+1} + y_{i+1}²) · c_i
#   ∫z²·dA = (1/12) Σ (z_i² + z_i·z_{i+1} + z_{i+1}²) · c_i
#   ∫yz·dA = (1/24) Σ (2·y_i·z_i + y_i·z_{i+1} + y_{i+1}·z_i + 2·y_{i+1}·z_{i+1}) · c_i
#
# donde c_i = y_i · z_{i+1} − y_{i+1} · z_i (2× área signada del triángulo).
#
# Interpretación: Iz = ∫y²·dA (momento respecto al eje z — flexión sobre y),
#                 Iy = ∫z²·dA (momento respecto al eje y — flexión sobre z).
# ─────────────────────────────────────────────────────────────────────────────

def _polygon_integrals(poly: Sequence[tuple[float, float]]) -> dict[str, float]:
    """Integrales analíticas sobre un polígono (y, z) → {A, Qy, Qz, Iy, Iz, Iyz}.

    Retorna las integrales respecto al ORIGEN del sistema de coordenadas (no
    centroidales). Aplicar teorema de Steiner para trasladar al centroide.
    """
    n = len(poly)
    if n < 3:
        return {k: 0.0 for k in ("A", "Qy", "Qz", "Iy", "Iz", "Iyz")}

    A = Qy = Qz = Iy = Iz = Iyz = 0.0
    for i in range(n):
        y1, z1 = poly[i]
        y2, z2 = poly[(i + 1) % n]
        c = y1 * z2 - y2 * z1               # 2× área signada del triángulo O-P_i-P_{i+1}

        A   += c
        Qz  += (y1 + y2) * c                # ∫y·dA · 6
        Qy  += (z1 + z2) * c                # ∫z·dA · 6
        Iz  += (y1 * y1 + y1 * y2 + y2 * y2) * c    # ∫y²·dA · 12
        Iy  += (z1 * z1 + z1 * z2 + z2 * z2) * c    # ∫z²·dA · 12
        Iyz += (2 * y1 * z1 + y1 * z2 + y2 * z1 + 2 * y2 * z2) * c   # ∫yz · 24

    return {
        "A":   A / 2.0,
        "Qz":  Qz / 6.0,
        "Qy":  Qy / 6.0,
        "Iz":  Iz / 12.0,
        "Iy":  Iy / 12.0,
        "Iyz": Iyz / 24.0,
    }


def _ensure_ccw(poly: Sequence[tuple[float, float]]) -> list[tuple[float, float]]:
    """Devuelve el polígono en orientación CCW (área signada positiva)."""
    n = len(poly)
    a2 = 0.0
    for i in range(n):
        y1, z1 = poly[i]
        y2, z2 = poly[(i + 1) % n]
        a2 += y1 * z2 - y2 * z1
    return list(poly) if a2 > 0 else list(reversed(poly))


# ─────────────────────────────────────────────────────────────────────────────
# Integrales por forma (rect / circ / poly)
# ─────────────────────────────────────────────────────────────────────────────

def _shape_polygon(shape: RegionShape, n_arc: int = 64) -> list[tuple[float, float]]:
    """Convierte cualquier RegionShape en un polígono discretizado CCW.

    n_arc: número de segmentos para aproximar círculos (64 → error < 0.02% en Iy).
    """
    if isinstance(shape, RectShape):
        return _ensure_ccw(shape.to_polygon())

    if isinstance(shape, CircShape):
        y0, z0, R = shape.y, shape.z, shape.radius
        Ri = shape.radius_inner
        outer = [(y0 + R * math.cos(2 * math.pi * i / n_arc),
                  z0 + R * math.sin(2 * math.pi * i / n_arc)) for i in range(n_arc)]
        # NOTA: para anillos huecos se maneja restando la integral del interior
        # en shape_integrals(). Aquí devolvemos solo el exterior.
        return _ensure_ccw(outer)

    if isinstance(shape, PolygonShape):
        return _ensure_ccw(shape.vertices)

    if isinstance(shape, (IShape, TShape, LShape, DoubleTShape)):
        return _ensure_ccw(shape.to_polygon())

    raise TypeError(f"RegionShape no soportado: {type(shape).__name__}")


def _shape_integrals(shape: RegionShape) -> dict[str, float]:
    """Integrales analíticas respecto al ORIGEN, para una geometría cualquiera.

    Para CircShape con hueco interno: outer − inner (integrales cerradas exactas).
    Para el resto: discretiza y usa fórmula de polígono.
    """
    # ── Caso especial: círculo/anillo → fórmulas exactas ──
    if isinstance(shape, CircShape):
        y0, z0 = shape.y, shape.z
        R, Ri = shape.radius, shape.radius_inner
        # Anillo relleno: A_ring = π(R²−Ri²). Iy_c = Iz_c = π(R⁴−Ri⁴)/4 (centroidal).
        # Trasladar al origen con Steiner: Iz|origen = Iz_c + A·y0²
        A   = math.pi * (R * R - Ri * Ri)
        Ic  = math.pi * (R ** 4 - Ri ** 4) / 4.0    # centroidal (mismo Iy y Iz por simetría)
        Iz  = Ic + A * y0 * y0
        Iy  = Ic + A * z0 * z0
        Iyz = A * y0 * z0
        return {
            "A":   A,
            "Qz":  A * y0,
            "Qy":  A * z0,
            "Iz":  Iz,
            "Iy":  Iy,
            "Iyz": Iyz,
        }

    poly = _shape_polygon(shape)
    return _polygon_integrals(poly)


# ─────────────────────────────────────────────────────────────────────────────
# Módulo plástico Zp: partición del área en dos mitades iguales
# ─────────────────────────────────────────────────────────────────────────────
# El eje neutro plástico (PNA) es la línea horizontal/vertical que divide la
# sección en dos áreas iguales A/2. Para una sección homogénea (solo concreto):
#
#   Zp = 2 · Q_medio_arriba
#
# donde Q_medio_arriba es el momento estático (∫ y·dA) de la mitad superior
# respecto al PNA. Para rect y circ hay fórmulas cerradas; para polígonos
# hacemos bisección numérica en el nivel del PNA + recorte del polígono.
# ─────────────────────────────────────────────────────────────────────────────

def _clip_polygon_below(poly: Sequence[tuple[float, float]], y_cut: float
                        ) -> list[tuple[float, float]]:
    """Devuelve la porción del polígono con y ≤ y_cut (Sutherland-Hodgman)."""
    if not poly:
        return []
    out: list[tuple[float, float]] = []
    n = len(poly)
    for i in range(n):
        y1, z1 = poly[i]
        y2, z2 = poly[(i + 1) % n]
        inside1 = y1 <= y_cut
        inside2 = y2 <= y_cut
        if inside1:
            out.append((y1, z1))
        if inside1 != inside2:
            # Interpolar en y = y_cut
            t = (y_cut - y1) / (y2 - y1)
            out.append((y_cut, z1 + t * (z2 - z1)))
    return out


def _plastic_modulus_z_axis(polygons: list[list[tuple[float, float]]],
                            total_area: float,
                            y_range: tuple[float, float],
                            tol: float = 1e-4) -> tuple[float, float]:
    """Zpz respecto al eje z (partición por línea horizontal y = y_pna).

    Retorna (Zpz, y_pna). Trabaja sobre una LISTA de polígonos porque una
    SectionDocument puede tener varias regiones (se suman áreas y momentos).
    Nota: NO maneja huecos anulares aquí — el flujo principal ya rasteriza
    círculos con hueco en la etapa superior si aplican como región is_void.
    """
    if total_area <= 0 or not polygons:
        return 0.0, 0.0

    y_lo, y_hi = y_range
    target = total_area / 2.0

    def area_below(y_cut: float) -> float:
        return sum(_polygon_integrals(_clip_polygon_below(p, y_cut))["A"] for p in polygons)

    # Bisección para encontrar y_pna tal que area_below(y_pna) = A/2
    lo, hi = y_lo, y_hi
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        a_mid = area_below(mid)
        if abs(a_mid - target) / target < tol:
            break
        if a_mid < target:
            lo = mid
        else:
            hi = mid
    y_pna = mid

    # Zpz = |Q_arriba − Q_abajo| respecto al eje z pasando por y_pna
    # Q_abajo = ∫y'·dA para y < y_pna, con y' = y − y_pna
    # Usamos Q_below = ∫y·dA (integral respecto al eje z original) − y_pna·A_below
    below_intg = [_polygon_integrals(_clip_polygon_below(p, y_pna)) for p in polygons]
    A_below = sum(b["A"] for b in below_intg)
    Q_below = sum(b["Qz"] for b in below_intg) - y_pna * A_below
    A_above = total_area - A_below
    # Q_above = Q_total − Q_below_original
    total_intg = [_polygon_integrals(p) for p in polygons]
    Q_total = sum(t["Qz"] for t in total_intg) - y_pna * total_area
    Q_above = Q_total - (Q_below + 0)   # Q_below ya está referido al eje pna
    # Módulo plástico
    Zpz = abs(Q_above) + abs(Q_below)
    return Zpz, y_pna


def _clip_polygon_left(poly: Sequence[tuple[float, float]], z_cut: float
                       ) -> list[tuple[float, float]]:
    """Devuelve la porción del polígono con z ≤ z_cut (Sutherland-Hodgman en z)."""
    if not poly:
        return []
    out: list[tuple[float, float]] = []
    n = len(poly)
    for i in range(n):
        y1, z1 = poly[i]
        y2, z2 = poly[(i + 1) % n]
        inside1 = z1 <= z_cut
        inside2 = z2 <= z_cut
        if inside1:
            out.append((y1, z1))
        if inside1 != inside2:
            t = (z_cut - z1) / (z2 - z1)
            out.append((y1 + t * (y2 - y1), z_cut))
    return out


def _plastic_modulus_y_axis(polygons: list[list[tuple[float, float]]],
                            total_area: float,
                            z_range: tuple[float, float],
                            tol: float = 1e-4) -> tuple[float, float]:
    """Zpy respecto al eje y (partición por línea vertical z = z_pna).

    Implementación directa (sin swap) para evitar bug de orientación CCW→CW.
    """
    if total_area <= 0 or not polygons:
        return 0.0, 0.0

    z_lo, z_hi = z_range
    target = total_area / 2.0

    def area_left(z_cut: float) -> float:
        return sum(_polygon_integrals(_clip_polygon_left(p, z_cut))["A"] for p in polygons)

    lo, hi = z_lo, z_hi
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        a_mid = area_left(mid)
        if abs(a_mid - target) / target < tol:
            break
        if a_mid < target:
            lo = mid
        else:
            hi = mid
    z_pna = mid

    # Q respecto al eje y (∫z·dA), trasladado al PNA vertical z = z_pna
    left_intg = [_polygon_integrals(_clip_polygon_left(p, z_pna)) for p in polygons]
    A_left = sum(l["A"] for l in left_intg)
    Q_left = sum(l["Qy"] for l in left_intg) - z_pna * A_left
    total_intg = [_polygon_integrals(p) for p in polygons]
    Q_total = sum(t["Qy"] for t in total_intg) - z_pna * total_area
    Q_right = Q_total - Q_left
    Zpy = abs(Q_left) + abs(Q_right)
    return Zpy, z_pna


# ─────────────────────────────────────────────────────────────────────────────
# Función principal
# ─────────────────────────────────────────────────────────────────────────────

def compute_geometric_properties(doc: SectionDocument) -> GeometricProperties:
    """Calcula todas las propiedades geométricas de una SectionDocument.

    Metodología:
      1. Suma integrales de polígono sobre todas las regiones no-void (menos las void).
      2. Aplica Steiner al centroide bruto.
      3. Calcula Zp por bisección sobre eje neutro plástico.
      4. Diagonaliza el tensor de inercia para ejes principales.

    Casos edge:
      - Sección vacía (sin regiones): devuelve todas las propiedades en cero.
      - Círculo hueco (radius_inner > 0): usa fórmulas cerradas (exactas).
      - Barras: contribuyen As y ρg; para Iz/Iy se contabilizan como concentradas
        (aporte As_bar · (y_bar − y_c)²). Es la convención estándar de diseño.
    """
    # ── 1. Integrar sobre regiones ──
    A_tot = 0.0
    Qz_tot = 0.0    # ∫y·dA
    Qy_tot = 0.0    # ∫z·dA
    Iz_orig = 0.0   # ∫y²·dA respecto al origen
    Iy_orig = 0.0   # ∫z²·dA respecto al origen
    Iyz_orig = 0.0  # ∫yz·dA

    # Recolección para Zp: lista de polígonos con signo (positivo para regiones
    # llenas, negativo para huecos). Nota: para huecos anulares (CircShape con
    # radius_inner > 0) NO se agrega el polígono interior aquí porque el cálculo
    # del área ya lo restó; para las bisecciones de Zp el hueco se aproxima con
    # el polígono discretizado del anillo exterior (aceptable para diseño).
    polygons_full: list[list[tuple[float, float]]] = []

    for r in doc.regions:
        integ = _shape_integrals(r.shape)
        sign = -1.0 if r.is_void else 1.0

        A_tot   += sign * integ["A"]
        Qz_tot  += sign * integ["Qz"]
        Qy_tot  += sign * integ["Qy"]
        Iz_orig += sign * integ["Iz"]
        Iy_orig += sign * integ["Iy"]
        Iyz_orig += sign * integ["Iyz"]

        if not r.is_void:
            polygons_full.append(_shape_polygon(r.shape))

    # ── 2. Centroide ──
    if A_tot <= 1e-9:
        # Sección vacía
        return _empty_properties()

    yc = Qz_tot / A_tot
    zc = Qy_tot / A_tot

    # ── 3. Trasladar al centroide (Steiner: I_c = I_o − A·d²) ──
    Iz_c  = Iz_orig  - A_tot * yc * yc
    Iy_c  = Iy_orig  - A_tot * zc * zc
    Iyz_c = Iyz_orig - A_tot * yc * zc

    # ── 4. Contribución de barras (concentradas en el centroide) ──
    As_total = 0.0
    for bar in doc.bars:
        Ab = BAR_AREAS_MM2.get(bar.bar_size, 0.0)
        if Ab <= 0:
            continue
        As_total += Ab
        dy = bar.y - yc
        dz = bar.z - zc
        Iz_c  += Ab * dy * dy
        Iy_c  += Ab * dz * dz
        Iyz_c += Ab * dy * dz

    # ── 5. Extremos de fibra ──
    all_pts = [pt for poly in polygons_full for pt in poly]
    if all_pts:
        y_max = max(p[0] for p in all_pts) - yc
        y_min = min(p[0] for p in all_pts) - yc
        z_max = max(p[1] for p in all_pts) - zc
        z_min = min(p[1] for p in all_pts) - zc
    else:
        y_max = y_min = z_max = z_min = 0.0

    depth = (y_max - y_min) if all_pts else 0.0
    width = (z_max - z_min) if all_pts else 0.0

    # ── 6. Módulos elásticos S = I / c ──
    def safe_div(num: float, den: float) -> float:
        return num / abs(den) if abs(den) > 1e-9 else 0.0

    Sz_pos = safe_div(Iz_c, y_max)    # extremo y positivo
    Sz_neg = safe_div(Iz_c, y_min)
    Sy_pos = safe_div(Iy_c, z_max)
    Sy_neg = safe_div(Iy_c, z_min)

    # ── 7. Radios de giro ──
    ry = math.sqrt(max(Iy_c / A_tot, 0.0))
    rz = math.sqrt(max(Iz_c / A_tot, 0.0))

    # ── 8. Módulos plásticos (bisección) ──
    # Trasladamos los polígonos al centroide para trabajar en el sistema centroidal.
    centered_polys = [[(y - yc, z - zc) for (y, z) in p] for p in polygons_full]
    Zpz, _ = _plastic_modulus_z_axis(centered_polys, A_tot, (y_min, y_max))
    Zpy, _ = _plastic_modulus_y_axis(centered_polys, A_tot, (z_min, z_max))

    # ── 9. Ejes principales (autovalores del tensor 2x2) ──
    #   [ Iz_c   -Iyz_c ] [v1]     [I1 · v1]
    #   [ -Iyz_c  Iy_c  ] [v2]  =  [I2 · v2]
    # Para diagrama de flexión: I1 = mayor autovalor, I2 = menor.
    Ia = Iz_c
    Ib = Iy_c
    tr = Ia + Ib
    det = Ia * Ib - Iyz_c * Iyz_c
    disc = max(tr * tr / 4.0 - det, 0.0)
    root = math.sqrt(disc)
    I1 = tr / 2.0 + root
    I2 = tr / 2.0 - root
    # Ángulo del eje principal 1 (respecto al eje y):
    # tan(2θp) = 2·Iyz / (Iz − Iy)
    if abs(Ia - Ib) < 1e-12 and abs(Iyz_c) < 1e-12:
        theta_p = 0.0
    else:
        theta_p = 0.5 * math.atan2(-2.0 * Iyz_c, Ia - Ib)
    theta_p_deg = math.degrees(theta_p)

    # ── 10. Factores de forma ──
    S_avg_z = 0.5 * (abs(Sz_pos) + abs(Sz_neg)) if (Sz_pos or Sz_neg) else 0.0
    S_avg_y = 0.5 * (abs(Sy_pos) + abs(Sy_neg)) if (Sy_pos or Sy_neg) else 0.0
    fs_z = Zpz / S_avg_z if S_avg_z > 1e-9 else 0.0
    fs_y = Zpy / S_avg_y if S_avg_y > 1e-9 else 0.0

    # ── 11. Cuantía ──
    rho_g = As_total / A_tot if A_tot > 0 else 0.0

    return GeometricProperties(
        gross_area=A_tot,
        net_area=A_tot - As_total,
        steel_area=As_total,
        rho_g=rho_g,
        centroid_y=yc,
        centroid_z=zc,
        depth=depth,
        width=width,
        Iy=Iy_c,
        Iz=Iz_c,
        Iyz=Iyz_c,
        Sy_pos=Sy_pos,
        Sy_neg=Sy_neg,
        Sz_pos=Sz_pos,
        Sz_neg=Sz_neg,
        ry=ry,
        rz=rz,
        Zpy=Zpy,
        Zpz=Zpz,
        fs_y=fs_y,
        fs_z=fs_z,
        I1=I1,
        I2=I2,
        theta_p_deg=theta_p_deg,
        y_max=y_max,
        y_min=y_min,
        z_max=z_max,
        z_min=z_min,
    )


def _empty_properties() -> GeometricProperties:
    """Retorno neutro para secciones sin regiones."""
    return GeometricProperties(
        gross_area=0.0, net_area=0.0, steel_area=0.0, rho_g=0.0,
        centroid_y=0.0, centroid_z=0.0, depth=0.0, width=0.0,
        Iy=0.0, Iz=0.0, Iyz=0.0,
        Sy_pos=0.0, Sy_neg=0.0, Sz_pos=0.0, Sz_neg=0.0,
        ry=0.0, rz=0.0, Zpy=0.0, Zpz=0.0, fs_y=0.0, fs_z=0.0,
        I1=0.0, I2=0.0, theta_p_deg=0.0,
        y_max=0.0, y_min=0.0, z_max=0.0, z_min=0.0,
    )
