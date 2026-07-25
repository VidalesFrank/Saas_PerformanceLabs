"""Diagrama de interaccion P-M via seccion de fibras en OpenSeesPy.

Unico modulo del motor que importa OpenSeesPy directamente. Construye la fiber
section (materiales + patches + barras) y traza la envolvente P-M barriendo
momento-curvatura a carga axial constante, para una serie de niveles de P entre
compresion pura y tension pura.

Convencion de signos publica (InteractionPoint): P positivo = compresion,
M siempre positivo (magnitud de la capacidad a momento). Internamente se convierte
a la convencion de OpenSees/Concrete01 (compresion = deformacion/esfuerzo negativo).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import openseespy.opensees as ops

from engine.materials.concrete import ConcreteMaterialParams
from engine.materials.steel import SteelMaterialParams
from engine.sections.geometry import CircularSection, PointFiberSpec, PolygonSection, RectangularSection

CORE_MAT_TAG = 1
COVER_MAT_TAG = 2
STEEL_MAT_TAG = 3
STEEL_MAT_TAG_WRAPPED = 4
SEC_TAG = 1
ELE_TAG = 1

Shape = RectangularSection | CircularSection | PolygonSection


@dataclass(frozen=True)
class InteractionPoint:
    P: float  # N, positivo = compresion
    M: float  # N*mm, magnitud de capacidad a momento


def _define_materials(core: ConcreteMaterialParams, cover: ConcreteMaterialParams, steel: SteelMaterialParams) -> None:
    ops.uniaxialMaterial("Concrete01", CORE_MAT_TAG, -core.fpc, -core.epsc0, -core.fpcu, -core.epsU)
    ops.uniaxialMaterial("Concrete01", COVER_MAT_TAG, -cover.fpc, -cover.epsc0, -cover.fpcu, -cover.epsU)
    ops.uniaxialMaterial("Steel02", STEEL_MAT_TAG, steel.fy, steel.E0, steel.b, steel.R0, steel.cR1, steel.cR2)
    ops.uniaxialMaterial(
        "MinMax", STEEL_MAT_TAG_WRAPPED, STEEL_MAT_TAG, "-min", -steel.eps_rupture, "-max", steel.eps_rupture
    )


def _build_section(shape: Shape, bars: list[PointFiberSpec]) -> None:
    ops.section("Fiber", SEC_TAG)
    if isinstance(shape, RectangularSection):
        core, covers = shape.patches(CORE_MAT_TAG, COVER_MAT_TAG)
        ops.patch("rect", core.mat_tag, core.nf_y, core.nf_z, core.y1, core.z1, core.y2, core.z2)
        for cp in covers:
            ops.patch("rect", cp.mat_tag, cp.nf_y, cp.nf_z, cp.y1, cp.z1, cp.y2, cp.z2)
    elif isinstance(shape, CircularSection):
        core, covers = shape.patches(CORE_MAT_TAG, COVER_MAT_TAG)
        ops.patch(
            "circ", core.mat_tag, core.nf_circ, core.nf_rad, core.y_center, core.z_center,
            core.r_int, core.r_ext, *core.ang,
        )
        for cp in covers:
            ops.patch(
                "circ", cp.mat_tag, cp.nf_circ, cp.nf_rad, cp.y_center, cp.z_center,
                cp.r_int, cp.r_ext, *cp.ang,
            )
    elif isinstance(shape, PolygonSection):
        for f in shape.fibers(CORE_MAT_TAG, COVER_MAT_TAG):
            ops.fiber(f.y, f.z, f.area, f.mat_tag)
    else:
        raise TypeError(f"Forma de seccion no soportada: {type(shape)}")

    for bar in bars:
        ops.fiber(bar.y, bar.z, bar.area, STEEL_MAT_TAG_WRAPPED)


def _moment_curvature_max(
    shape: Shape,
    bars: list[PointFiberSpec],
    core_params: ConcreteMaterialParams,
    cover_params: ConcreteMaterialParams,
    steel_params: SteelMaterialParams,
    axial_load_compression_positive: float,
    max_curvature: float,
    num_incr: int = 60,
) -> float:
    """Traza momento-curvatura a P constante y devuelve la magnitud del momento maximo.

    Reconstruye el modelo (materiales + seccion + elemento) desde cero en cada
    llamada: es mas costoso que reutilizar el dominio entre niveles de P, pero
    evita por completo los problemas de estado residual (patrones de carga,
    nodos) entre corridas sucesivas de OpenSees, que son una fuente comun de
    resultados incorrectos silenciosos.
    """
    p_ops = -axial_load_compression_positive  # OpenSees/Concrete01: compresion = negativo

    ops.wipe()
    ops.model("basic", "-ndm", 2, "-ndf", 3)
    _define_materials(core_params, cover_params, steel_params)
    _build_section(shape, bars)

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
            ops.algorithm("Newton")
            if ok != 0:
                break
        moment = ops.getLoadFactor(2)
        if abs(moment) > abs(max_moment):
            max_moment = moment
    return abs(max_moment)


def compute_interaction_diagram(
    shape: Shape,
    bars: list[PointFiberSpec],
    core_params: ConcreteMaterialParams,
    cover_params: ConcreteMaterialParams,
    steel_params: SteelMaterialParams,
    depth_for_curvature: float,
    num_points: int = 15,
) -> list[InteractionPoint]:
    """Calcula la envolvente P-M completa: compresion pura -> flexion -> tension pura.

    `depth_for_curvature` es la dimension de la seccion en la direccion de flexion
    analizada (altura para rectangular, diametro para circular) y se usa solo para
    escalar la curvatura maxima del barrido.
    """
    ast = sum(b.area for b in bars)
    ag = shape.gross_area

    p_exact_max = 0.85 * cover_params.fpc * (ag - ast) + steel_params.fy * ast
    p_exact_min = -steel_params.fy * ast

    max_curvature = 6 * 0.025 / depth_for_curvature

    p_levels = np.linspace(0.98 * p_exact_max, 0.98 * p_exact_min, num_points)
    diagram = [InteractionPoint(P=p_exact_max, M=0.0)]
    for p in p_levels:
        m = _moment_curvature_max(
            shape, bars, core_params, cover_params, steel_params, float(p), max_curvature
        )
        diagram.append(InteractionPoint(P=float(p), M=m))
    diagram.append(InteractionPoint(P=p_exact_min, M=0.0))
    return diagram
