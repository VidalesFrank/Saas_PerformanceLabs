"""Superficie de interaccion biaxial P-M-M via rotacion del eje neutro.

Para cada angulo theta del eje neutro (0..2pi), rota las coordenadas de las
fibras y calcula la curva P-M correspondiente. La superficie 3D resultante
vive en el espacio (P, Mx, My).

Convenio de salida:
  P  [N]    compresion positiva
  Mx [N·mm] momento eje fuerte (flexion en direccion y = altura)
  My [N·mm] momento eje debil  (flexion en direccion z = ancho)

Para theta=0:   (Mx, My) = (M, 0)  -- igual al diagrama P-M existente (eje fuerte)
Para theta=pi/2: (Mx, My) = (0, M)  -- diagrama P-M eje debil

Optimizacion de simetria:
  - Seccion rectangular/cuadrada (doblemente simetrica): solo calcula Q1 [0..pi/2]
    y expeja al resto de cuadrantes (aprox. 1/4 del costo computacional).
  - Seccion circular: isotropica, un solo angulo se replica a todos.
  - Seccion especial: barre los num_angles completos sin asumir simetria.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import openseespy.opensees as ops

from engine.materials.concrete import ConcreteMaterialParams
from engine.materials.steel import SteelMaterialParams
from engine.sections.geometry import (
    CircPatchSpec,
    CircularSection,
    PointFiberSpec,
    PolygonSection,
    RectPatchSpec,
    RectangularSection,
)

from .interaction import (
    ELE_TAG,
    SEC_TAG,
    STEEL_MAT_TAG_WRAPPED,
    Shape,
    _define_materials,
)


# ── Dataclass de salida ───────────────────────────────────────────────────────

@dataclass(frozen=True)
class PMMPoint:
    P: float      # N, compresion positiva
    Mx: float     # N·mm, momento eje fuerte
    My: float     # N·mm, momento eje debil
    theta: float  # rad, angulo del eje neutro


# ── Discretizacion de patches -> fibras individuales ─────────────────────────

def _disc_rect(patch: RectPatchSpec) -> list[PointFiberSpec]:
    dy = (patch.y2 - patch.y1) / patch.nf_y
    dz = (patch.z2 - patch.z1) / patch.nf_z
    area = abs(dy * dz)
    return [
        PointFiberSpec(patch.mat_tag, patch.y1 + (i + 0.5) * dy, patch.z1 + (j + 0.5) * dz, area)
        for i in range(patch.nf_y)
        for j in range(patch.nf_z)
    ]


def _disc_circ(patch: CircPatchSpec) -> list[PointFiberSpec]:
    ang_s = math.radians(patch.ang[0])
    ang_e = math.radians(patch.ang[1])
    d_ang = (ang_e - ang_s) / patch.nf_circ
    dr = (patch.r_ext - patch.r_int) / patch.nf_rad
    fibers: list[PointFiberSpec] = []
    for k_r in range(patch.nf_rad):
        r_in = patch.r_int + k_r * dr
        r_out = patch.r_int + (k_r + 1) * dr
        r_mid = (r_in + r_out) / 2
        area = 0.5 * (r_out**2 - r_in**2) * d_ang
        for k_c in range(patch.nf_circ):
            ang = ang_s + (k_c + 0.5) * d_ang
            fibers.append(PointFiberSpec(
                patch.mat_tag,
                patch.y_center + r_mid * math.cos(ang),
                patch.z_center + r_mid * math.sin(ang),
                area,
            ))
    return fibers


def _section_to_fibers(shape: Shape) -> list[PointFiberSpec]:
    """Devuelve fibras individuales de concreto (sin barras de acero)."""
    if isinstance(shape, RectangularSection):
        core, covers = shape.patches(1, 2)   # CORE=1, COVER=2
        return _disc_rect(core) + [f for cp in covers for f in _disc_rect(cp)]
    if isinstance(shape, CircularSection):
        core, covers = shape.patches(1, 2)
        return _disc_circ(core) + [f for cp in covers for f in _disc_circ(cp)]
    if isinstance(shape, PolygonSection):
        return shape.fibers(1, 2)
    raise TypeError(f"Forma no soportada: {type(shape)}")


# ── Rotacion de fibras ────────────────────────────────────────────────────────

def _rotate(fibers: list[PointFiberSpec], theta: float) -> list[PointFiberSpec]:
    c, s = math.cos(theta), math.sin(theta)
    return [PointFiberSpec(f.mat_tag, f.y * c + f.z * s, -f.y * s + f.z * c, f.area) for f in fibers]


# ── Analisis OpenSees a angulo fijo ───────────────────────────────────────────

def _mc_max(
    concrete_rot: list[PointFiberSpec],
    steel_rot: list[PointFiberSpec],
    core: ConcreteMaterialParams,
    cover: ConcreteMaterialParams,
    steel: SteelMaterialParams,
    p_n: float,          # N, compresion positiva
    max_curv: float,
    num_incr: int = 45,
) -> float:
    """Momento maximo a carga axial p_n con fibras ya rotadas al angulo deseado."""
    ops.wipe()
    ops.model("basic", "-ndm", 2, "-ndf", 3)
    _define_materials(core, cover, steel)

    ops.section("Fiber", SEC_TAG)
    for f in concrete_rot:
        ops.fiber(f.y, f.z, f.area, f.mat_tag)
    for f in steel_rot:
        ops.fiber(f.y, f.z, f.area, STEEL_MAT_TAG_WRAPPED)

    ops.node(1, 0.0, 0.0)
    ops.node(2, 0.0, 0.0)
    ops.fix(1, 1, 1, 1)
    ops.fix(2, 0, 1, 0)
    ops.element("zeroLengthSection", ELE_TAG, 1, 2, SEC_TAG)

    ops.timeSeries("Constant", 1)
    ops.pattern("Plain", 1, 1)
    ops.load(2, -p_n, 0.0, 0.0)   # OpenSees: compresion = negativa

    ops.system("BandGeneral")
    ops.numberer("Plain")
    ops.constraints("Plain")
    ops.test("NormUnbalance", 1.0e-6, 20)
    ops.algorithm("Newton")
    ops.integrator("LoadControl", 0.1)
    ops.analysis("Static")

    for _ in range(10):
        if ops.analyze(1) != 0:
            return 0.0
    ops.loadConst("-time", 0.0)

    ops.timeSeries("Linear", 2)
    ops.pattern("Plain", 2, 2)
    ops.load(2, 0.0, 0.0, 1.0)
    ops.integrator("DisplacementControl", 2, 3, max_curv / num_incr)

    max_m = 0.0
    for _ in range(num_incr):
        ok = ops.analyze(1)
        if ok != 0:
            ops.algorithm("ModifiedNewton")
            ok = ops.analyze(1)
            ops.algorithm("Newton")
            if ok != 0:
                break
        m = ops.getLoadFactor(2)
        if abs(m) > abs(max_m):
            max_m = m
    return abs(max_m)


# ── Expansion de simetria (rectangular/cuadrada) ──────────────────────────────

def _expand_quad_symmetry(
    angles_q1: list[float],
    pm_by_angle: dict[float, list[tuple[float, float]]],
) -> list[tuple[float, list[tuple[float, float, float]]]]:
    """Expande curvas del 1er cuadrante a los 4 cuadrantes.

    Devuelve lista de (theta, [(P, Mx, My), ...]) ordenada por theta.
    """
    result: list[tuple[float, list[tuple[float, float, float]]]] = []
    EPS = 1e-9

    for theta in angles_q1:
        pm = pm_by_angle[theta]
        c, s = math.cos(theta), math.sin(theta)
        pmM = [(p, m * c, m * s) for p, m in pm]
        pmQ3 = [(p, -m * c, -m * s) for p, m in pm]

        result.append((theta, pmM))
        result.append((math.pi + theta, pmQ3))

        # Q2 y Q4 solo existen para angulos fuera de los ejes
        if theta > EPS and theta < math.pi / 2 - EPS:
            pmQ2 = [(p, -m * c, m * s) for p, m in pm]
            pmQ4 = [(p, m * c, -m * s) for p, m in pm]
            result.append((math.pi - theta, pmQ2))
            result.append((2 * math.pi - theta, pmQ4))
        # Eje theta=pi/2: Q3 ya es (pi + pi/2 = 3pi/2), Q4 = (2pi - pi/2 = 3pi/2) → duplicado con Q3
        # Eje theta=0:    Q3 ya es pi, Q2 = pi (duplicado con Q3), Q4 = 2pi (= Q1) → no agregar

    result.sort(key=lambda x: x[0])
    return result


# ── Funcion publica ───────────────────────────────────────────────────────────

def compute_pmm_surface(
    shape: Shape,
    bars: list[PointFiberSpec],
    core_params: ConcreteMaterialParams,
    cover_params: ConcreteMaterialParams,
    steel_params: SteelMaterialParams,
    num_angles: int = 8,
    num_points: int = 10,
) -> list[PMMPoint]:
    """Calcula la superficie P-M-M barriendo el angulo del eje neutro.

    num_angles : numero de angulos en [0, 2pi). Recomendado: 8..16.
    num_points : niveles de P por angulo (excluyendo puntos de contorno).
    """
    ast = sum(b.area for b in bars)
    ag = shape.gross_area
    p_abs_max = 0.85 * cover_params.fpc * (ag - ast) + steel_params.fy * ast
    p_abs_min = -steel_params.fy * ast
    p_levels = list(np.linspace(0.98 * p_abs_max, 0.98 * p_abs_min, num_points))

    concrete_fibers = _section_to_fibers(shape)

    is_circ = isinstance(shape, CircularSection)
    is_doubly_sym = isinstance(shape, RectangularSection)  # cuadrada es subclase

    # ── Determinar angulos a calcular efectivamente ───────────────────────────
    if is_circ:
        angles_unique = [0.0]
    elif is_doubly_sym:
        n_q1 = max(2, num_angles // 4 + 1)
        angles_unique = list(np.linspace(0.0, math.pi / 2, n_q1))
    else:
        angles_unique = list(np.linspace(0.0, 2 * math.pi, num_angles, endpoint=False))

    # ── Calcular P-M para cada angulo unico ──────────────────────────────────
    pm_by_angle: dict[float, list[tuple[float, float]]] = {}
    for theta in angles_unique:
        theta = float(theta)
        rot_c = _rotate(concrete_fibers, theta)
        rot_s = _rotate(bars, theta)

        y_vals = [f.y for f in rot_c]
        d_eff = max(y_vals) - min(y_vals) if y_vals else 1.0
        max_curv = 6.0 * 0.025 / max(d_eff, 1.0)

        pm: list[tuple[float, float]] = []
        for p in p_levels:
            m = _mc_max(rot_c, rot_s, core_params, cover_params, steel_params, p, max_curv)
            pm.append((float(p), m))
        pm_by_angle[theta] = pm

    # ── Construir lista de PMMPoint ───────────────────────────────────────────
    points: list[PMMPoint] = []

    if is_circ:
        angles_all = np.linspace(0.0, 2 * math.pi, num_angles, endpoint=False)
        for theta in angles_all:
            theta = float(theta)
            pm = pm_by_angle[0.0]
            c, s = math.cos(theta), math.sin(theta)
            points.append(PMMPoint(P=p_abs_max, Mx=0.0, My=0.0, theta=theta))
            for p, m in pm:
                points.append(PMMPoint(P=p, Mx=m * c, My=m * s, theta=theta))
            points.append(PMMPoint(P=p_abs_min, Mx=0.0, My=0.0, theta=theta))

    elif is_doubly_sym:
        expanded = _expand_quad_symmetry(angles_unique, pm_by_angle)
        for theta, pm3 in expanded:
            points.append(PMMPoint(P=p_abs_max, Mx=0.0, My=0.0, theta=theta))
            for p, mx, my in pm3:
                points.append(PMMPoint(P=p, Mx=mx, My=my, theta=theta))
            points.append(PMMPoint(P=p_abs_min, Mx=0.0, My=0.0, theta=theta))

    else:
        for theta in angles_unique:
            theta = float(theta)
            pm = pm_by_angle[theta]
            c, s = math.cos(theta), math.sin(theta)
            points.append(PMMPoint(P=p_abs_max, Mx=0.0, My=0.0, theta=theta))
            for p, m in pm:
                points.append(PMMPoint(P=p, Mx=m * c, My=m * s, theta=theta))
            points.append(PMMPoint(P=p_abs_min, Mx=0.0, My=0.0, theta=theta))

    return points
