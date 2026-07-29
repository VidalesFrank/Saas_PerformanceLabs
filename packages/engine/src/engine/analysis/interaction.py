"""Diagrama de interaccion P-M via seccion de fibras en OpenSeesPy.

Unico modulo del motor que importa OpenSeesPy directamente. Construye la fiber
section a partir de un CompiledFiberSection y traza la envolvente P-M barriendo
momento-curvatura a carga axial constante.

Convencion de signos publica (InteractionPoint): P positivo = compresion,
M siempre positivo (magnitud de la capacidad a momento). Internamente se convierte
a la convencion de OpenSees/Concrete01 (compresion = deformacion/esfuerzo negativo).
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import openseespy.opensees as ops

from engine.sections.compiler import CompiledFiberSection

SEC_TAG = 1
ELE_TAG = 1


@dataclass(frozen=True)
class InteractionPoint:
    P: float  # N, positivo = compresion
    M: float  # N*mm, magnitud de capacidad a momento


def _define_materials(compiled: CompiledFiberSection) -> None:
    """Registra todos los materiales de la sección compilada en OpenSees."""
    for tag, params in compiled.concrete_materials:
        ops.uniaxialMaterial("Concrete01", tag,
                             -params.fpc, -params.epsc0, -params.fpcu, -params.epsU)
    s = compiled.steel_params
    ops.uniaxialMaterial("Steel02", compiled.steel_tag,
                         s.fy, s.E0, s.b, s.R0, s.cR1, s.cR2)
    ops.uniaxialMaterial("MinMax", compiled.steel_wrapped_tag,
                         compiled.steel_tag,
                         "-min", -s.eps_rupture, "-max", s.eps_rupture)


def _build_section(compiled: CompiledFiberSection) -> None:
    """Construye la fiber section en OpenSees a partir de la sección compilada."""
    ops.section("Fiber", SEC_TAG)
    for p in compiled.rect_patches:
        ops.patch("rect", p.mat_tag, p.nf_y, p.nf_z, p.y1, p.z1, p.y2, p.z2)
    for p in compiled.circ_patches:
        ops.patch("circ", p.mat_tag, p.nf_circ, p.nf_rad,
                  p.y_center, p.z_center, p.r_int, p.r_ext, *p.ang)
    for f in compiled.point_fibers:
        ops.fiber(f.y, f.z, f.area, f.mat_tag)
    for b in compiled.bar_fibers:
        ops.fiber(b.y, b.z, b.area, b.mat_tag)


def _build_section_at_angle(compiled: CompiledFiberSection, theta_rad: float) -> None:
    """Build fiber section using explicit fibers rotated by theta_rad.

    Effective lever arm: y_eff = y*cos(θ) + z*sin(θ).
    Uses all_concrete_fibers + all_bar_fibers (pre-discretized) for correct rotation.
    """
    cos_t = math.cos(theta_rad)
    sin_t = math.sin(theta_rad)
    ops.section("Fiber", SEC_TAG)
    for f in compiled.all_concrete_fibers:
        y_eff = f.y * cos_t + f.z * sin_t
        ops.fiber(y_eff, 0.0, f.area, f.mat_tag)
    for b in compiled.all_bar_fibers:
        y_eff = b.y * cos_t + b.z * sin_t
        ops.fiber(y_eff, 0.0, b.area, b.mat_tag)


def _effective_depth(compiled: CompiledFiberSection, theta_rad: float) -> float:
    """Projected depth in the bending direction (for curvature range scaling)."""
    if abs(theta_rad) < 1e-9:
        return compiled.depth_for_curvature
    cos_t = math.cos(theta_rad)
    sin_t = math.sin(theta_rad)
    ys = [f.y * cos_t + f.z * sin_t for f in compiled.all_concrete_fibers]
    return (max(ys) - min(ys)) if len(ys) >= 2 else compiled.depth_for_curvature


def _moment_curvature_max(
    compiled: CompiledFiberSection,
    axial_load_compression_positive: float,
    max_curvature: float,
    num_incr: int = 60,
    theta_rad: float = 0.0,
) -> float:
    """Traza momento-curvatura a P constante y devuelve la magnitud del momento maximo.

    Reconstruye el modelo desde cero en cada llamada para evitar estado residual.
    """
    p_ops = -axial_load_compression_positive  # OpenSees: compresion = negativo

    ops.wipe()
    ops.model("basic", "-ndm", 2, "-ndf", 3)
    _define_materials(compiled)
    if abs(theta_rad) < 1e-9:
        _build_section(compiled)
    else:
        _build_section_at_angle(compiled, theta_rad)

    ops.node(1, 0.0, 0.0)
    ops.node(2, 0.0, 0.0)
    ops.fix(1, 1, 1, 1)
    ops.fix(2, 0, 1, 0)
    ops.element("zeroLengthSection", ELE_TAG, 1, 2, SEC_TAG)

    ops.timeSeries("Constant", 1)
    ops.pattern("Plain", 1, 1)
    ops.load(2, p_ops, 0.0, 0.0)

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

    d_phi = max_curvature / num_incr
    ops.integrator("DisplacementControl", 2, 3, d_phi)

    max_moment = 0.0
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
        moment = ops.getLoadFactor(2)
        if abs(moment) > abs(max_moment):
            max_moment = moment
    return abs(max_moment)


def compute_interaction_diagram(
    compiled: CompiledFiberSection,
    num_points: int = 15,
    theta_deg: float = 0.0,
) -> list[InteractionPoint]:
    """Calcula la envolvente P-M completa: compresion pura → flexion → tension pura."""
    theta_rad = math.radians(theta_deg)

    ast = compiled.steel_area
    ag = compiled.gross_area
    fy = compiled.steel_params.fy
    fpc = compiled.fpc_nominal

    p_exact_max = 0.85 * fpc * (ag - ast) + fy * ast
    p_exact_min = -fy * ast
    max_curvature = 6 * 0.025 / _effective_depth(compiled, theta_rad)

    p_levels = np.linspace(0.98 * p_exact_max, 0.98 * p_exact_min, num_points)
    diagram = [InteractionPoint(P=p_exact_max, M=0.0)]
    for p in p_levels:
        m = _moment_curvature_max(compiled, float(p), max_curvature, num_incr=120, theta_rad=theta_rad)
        if m > 0.0:  # skip convergence failures to avoid zigzag
            diagram.append(InteractionPoint(P=float(p), M=m))
    diagram.append(InteractionPoint(P=p_exact_min, M=0.0))
    return diagram
