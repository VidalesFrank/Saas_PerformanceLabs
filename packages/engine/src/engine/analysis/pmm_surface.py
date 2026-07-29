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
  - Seccion doblemente simetrica (compiled.is_doubly_symmetric): solo calcula Q1 [0..pi/2].
  - Seccion isotrópica circular (compiled.is_isotropic): solo calcula un angulo.
  - Resto: barre los num_angles completos.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import openseespy.opensees as ops

from engine.sections.compiler import CompiledFiberSection, disc_circ, disc_rect
from engine.sections.geometry import CircPatchSpec, PointFiberSpec, RectPatchSpec
from .interaction import ELE_TAG, SEC_TAG, _define_materials


# ── Dataclass de salida ───────────────────────────────────────────────────────

@dataclass(frozen=True)
class PMMPoint:
    P: float      # N, compresion positiva
    Mx: float     # N·mm, momento eje fuerte
    My: float     # N·mm, momento eje debil
    theta: float  # rad, angulo del eje neutro


# ── Rotacion de fibras ────────────────────────────────────────────────────────

def _rotate(fibers: list[PointFiberSpec], theta: float) -> list[PointFiberSpec]:
    c, s = math.cos(theta), math.sin(theta)
    return [PointFiberSpec(f.mat_tag, f.y * c + f.z * s, -f.y * s + f.z * c, f.area)
            for f in fibers]


# ── Analisis OpenSees a angulo fijo ───────────────────────────────────────────

def _mc_max(
    concrete_rot: list[PointFiberSpec],
    steel_rot: list[PointFiberSpec],
    compiled: CompiledFiberSection,
    p_n: float,
    max_curv: float,
    num_incr: int = 45,
) -> float:
    """Momento maximo a carga axial p_n con fibras ya rotadas al angulo deseado."""
    ops.wipe()
    ops.model("basic", "-ndm", 2, "-ndf", 3)
    _define_materials(compiled)

    ops.section("Fiber", SEC_TAG)
    for f in concrete_rot:
        ops.fiber(f.y, f.z, f.area, f.mat_tag)
    for f in steel_rot:
        ops.fiber(f.y, f.z, f.area, f.mat_tag)

    ops.node(1, 0.0, 0.0)
    ops.node(2, 0.0, 0.0)
    ops.fix(1, 1, 1, 1)
    ops.fix(2, 0, 1, 0)
    ops.element("zeroLengthSection", ELE_TAG, 1, 2, SEC_TAG)

    ops.timeSeries("Constant", 1)
    ops.pattern("Plain", 1, 1)
    ops.load(2, -p_n, 0.0, 0.0)

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
            if ok != 0:
                ops.algorithm("KrylovNewton")
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
    result: list[tuple[float, list[tuple[float, float, float]]]] = []
    EPS = 1e-9
    for theta in angles_q1:
        pm = pm_by_angle[theta]
        c, s = math.cos(theta), math.sin(theta)
        pmM  = [(p, m * c,  m * s) for p, m in pm]
        pmQ3 = [(p, -m * c, -m * s) for p, m in pm]
        result.append((theta, pmM))
        result.append((math.pi + theta, pmQ3))
        if EPS < theta < math.pi / 2 - EPS:
            pmQ2 = [(p, -m * c, m * s) for p, m in pm]
            pmQ4 = [(p, m * c, -m * s) for p, m in pm]
            result.append((math.pi - theta, pmQ2))
            result.append((2 * math.pi - theta, pmQ4))
    result.sort(key=lambda x: x[0])
    return result


# ── Funcion publica ───────────────────────────────────────────────────────────

def compute_pmm_surface(
    compiled: CompiledFiberSection,
    num_angles: int = 8,
    num_points: int = 10,
) -> list[PMMPoint]:
    """Calcula la superficie P-M-M barriendo el angulo del eje neutro."""
    ast = compiled.steel_area
    ag  = compiled.gross_area
    fy  = compiled.steel_params.fy
    fpc = compiled.fpc_nominal

    p_abs_max = 0.85 * fpc * (ag - ast) + fy * ast
    p_abs_min = -fy * ast
    p_levels  = list(np.linspace(0.98 * p_abs_max, 0.98 * p_abs_min, num_points))

    # Fibras ya discretizadas (para rotación)
    concrete_fibers = compiled.all_concrete_fibers
    bar_fibers      = compiled.all_bar_fibers

    # ── Determinar ángulos únicos según simetría ──────────────────────────────
    if compiled.is_isotropic:
        angles_unique = [0.0]
    elif compiled.is_doubly_symmetric:
        n_q1 = max(2, num_angles // 4 + 1)
        angles_unique = list(np.linspace(0.0, math.pi / 2, n_q1))
    else:
        angles_unique = list(np.linspace(0.0, 2 * math.pi, num_angles, endpoint=False))

    # ── Calcular P-M para cada ángulo único ──────────────────────────────────
    pm_by_angle: dict[float, list[tuple[float, float]]] = {}
    for theta in angles_unique:
        theta = float(theta)
        rot_c = _rotate(concrete_fibers, theta)
        rot_s = _rotate(bar_fibers, theta)

        y_vals = [f.y for f in rot_c]
        d_eff  = max(y_vals) - min(y_vals) if y_vals else 1.0
        max_curv = 6.0 * 0.025 / max(d_eff, 1.0)

        pm: list[tuple[float, float]] = []
        for p in p_levels:
            m = _mc_max(rot_c, rot_s, compiled, p, max_curv)
            if m > 0.0:  # skip convergence failures to avoid surface dimples
                pm.append((float(p), m))
        pm_by_angle[theta] = pm

    # ── Construir lista de PMMPoint ───────────────────────────────────────────
    points: list[PMMPoint] = []

    if compiled.is_isotropic:
        angles_all = np.linspace(0.0, 2 * math.pi, num_angles, endpoint=False)
        for theta in angles_all:
            theta = float(theta)
            pm = pm_by_angle[0.0]
            c, s = math.cos(theta), math.sin(theta)
            points.append(PMMPoint(P=p_abs_max, Mx=0.0, My=0.0, theta=theta))
            for p, m in pm:
                points.append(PMMPoint(P=p, Mx=m * c, My=m * s, theta=theta))
            points.append(PMMPoint(P=p_abs_min, Mx=0.0, My=0.0, theta=theta))

    elif compiled.is_doubly_symmetric:
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


# ── Re-exportar disc_rect / disc_circ (compatibilidad con imports anteriores) ─
__all__ = ["PMMPoint", "compute_pmm_surface", "disc_rect", "disc_circ"]
