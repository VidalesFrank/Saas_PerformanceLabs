"""Curva momento-curvatura via seccion de fibras en OpenSeesPy.

Calcula la curva M-phi completa a carga axial constante. La fluencia se identifica
por el metodo bilineal igual-energia (estandar ASCE 41 / Priestley & Calvi 2007):
se construye una curva bilineal elastoplastica con el mismo area que la real hasta
phi_u, lo que entrega la curvatura idealizada de fluencia phi_y y la rigidez
secante efectiva EI_ef = Mu / phi_y.

Reutiliza los helpers de materiales y seccion de interaction.py.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import openseespy.opensees as ops

from engine.sections.geometry import PointFiberSpec
from engine.materials.concrete import ConcreteMaterialParams
from engine.materials.steel import SteelMaterialParams

from .interaction import (
    ELE_TAG,
    SEC_TAG,
    Shape,
    _build_section,
    _define_materials,
)


@dataclass(frozen=True)
class MomentCurvaturePoint:
    phi: float    # curvatura [1/mm]
    moment: float  # momento [N·mm], positivo


@dataclass
class MomentCurvatureResult:
    curve: list[MomentCurvaturePoint]
    phi_yield: float        # [1/mm]  curvatura bilineal idealizada de fluencia
    moment_yield: float     # [N·mm]  momento real en phi_yield (interpolado)
    phi_max: float          # [1/mm]  curvatura en momento pico
    moment_max: float       # [N·mm]  momento pico
    phi_ultimate: float     # [1/mm]  curvatura de falla (~80% Mmax post-pico, ultimo punto)
    moment_ultimate: float  # [N·mm]  momento en curvatura de falla
    ductility: float        # μφ = φu_falla / φy
    axial_load_n: float     # [N] carga axial aplicada, compresion positiva
    ei_secant: float        # [N·mm²] rigidez secante efectiva = Mmax / φy
    failure_reached: bool   # True si el momento cayo al 80% Mmax; False = limite del barrido


def compute_moment_curvature(
    shape: Shape,
    bars: list[PointFiberSpec],
    core_params: ConcreteMaterialParams,
    cover_params: ConcreteMaterialParams,
    steel_params: SteelMaterialParams,
    axial_load_n: float,
    depth_for_curvature: float,
    num_incr: int = 120,
    curvature_multiple: float = 8.0,
) -> MomentCurvatureResult:
    """Traza la curva M-phi completa a carga axial constante.

    axial_load_n : N, compresion positiva (convencion publica).
    depth_for_curvature : dimension de la seccion en la direccion de flexion [mm].
    curvature_multiple : factor para la curvatura maxima del barrido (default 8 x 0.025/depth).

    Identificacion de fluencia: metodo bilineal igual-energia.
    El barrido se detiene cuando el momento cae por debajo del 80% del pico
    o cuando el analisis no converge tras algoritmos de fallback.
    """
    p_ops = -axial_load_n  # OpenSees/Concrete01: compresion = negativo

    ops.wipe()
    ops.model("basic", "-ndm", 2, "-ndf", 3)
    _define_materials(core_params, cover_params, steel_params)
    _build_section(shape, bars)

    ops.node(1, 0.0, 0.0)
    ops.node(2, 0.0, 0.0)
    ops.fix(1, 1, 1, 1)
    ops.fix(2, 0, 1, 0)
    ops.element("zeroLengthSection", ELE_TAG, 1, 2, SEC_TAG)

    # ── Carga axial constante ─────────────────────────────────────────────────
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
            return _empty_result(axial_load_n)
    ops.loadConst("-time", 0.0)

    # ── Barrido de curvatura ──────────────────────────────────────────────────
    max_curvature = curvature_multiple * 0.025 / depth_for_curvature
    d_phi = max_curvature / num_incr

    ops.timeSeries("Linear", 2)
    ops.pattern("Plain", 2, 2)
    ops.load(2, 0.0, 0.0, 1.0)
    ops.integrator("DisplacementControl", 2, 3, d_phi)

    curve: list[MomentCurvaturePoint] = []
    moment_peak = 0.0
    failure_reached = False

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

        phi = abs(ops.nodeDisp(2, 3))
        moment = abs(ops.getLoadFactor(2))
        curve.append(MomentCurvaturePoint(phi=phi, moment=moment))

        if moment > moment_peak:
            moment_peak = moment
        elif moment_peak > 0 and moment < 0.80 * moment_peak:
            failure_reached = True
            break  # caida post-pico: curvatura ultima alcanzada

    if not curve:
        return _empty_result(axial_load_n)

    # ── Post-proceso ──────────────────────────────────────────────────────────
    moments = np.array([pt.moment for pt in curve])
    phis    = np.array([pt.phi    for pt in curve])

    # Punto de momento maximo
    idx_peak    = int(np.argmax(moments))
    moment_max  = float(moments[idx_peak])
    phi_max     = float(phis[idx_peak])

    # Punto de falla: ultimo punto de la curva (~80% Mmax post-pico, o fin de barrido)
    phi_ultimate    = float(phis[-1])
    moment_ultimate = float(moments[-1])

    # ── Fluencia: metodo bilineal igual-energia (Paulay & Priestley, ASCE 41) ─
    # Bilineal elastoplastica con plateau en Mmax, igual area hasta phi_max:
    #   Area_bilineal = Mmax*phi_max - 0.5*Mmax*phi_y  =>  phi_y = 2*(Mmax*phi_max - E) / Mmax
    phis_to_peak    = phis[:idx_peak + 1]
    moments_to_peak = moments[:idx_peak + 1]
    # Regla trapezoidal manual — compatible con numpy 1.x y 2.x
    energy_to_peak  = float(0.5 * np.sum(
        (moments_to_peak[:-1] + moments_to_peak[1:]) * np.diff(phis_to_peak)
    ))

    if moment_max > 0 and phi_max > 0:
        phi_yield = 2.0 * (moment_max * phi_max - energy_to_peak) / moment_max
        phi_yield = max(phi_yield, float(phis[0]))  # cota inferior: primer punto
        phi_yield = min(phi_yield, phi_max)          # cota superior: phi_max
    else:
        phi_yield = phi_max

    # Momento real en la curva en phi_y idealizado
    moment_yield = float(np.interp(phi_yield, phis, moments))

    # Ductilidad = curvatura de falla / curvatura de fluencia
    ductility = phi_ultimate / phi_yield if phi_yield > 0 else 0.0
    # Rigidez secante efectiva basada en el momento pico
    ei_secant = moment_max / phi_yield if phi_yield > 0 else 0.0

    return MomentCurvatureResult(
        curve=curve,
        phi_yield=phi_yield,
        moment_yield=moment_yield,
        phi_max=phi_max,
        moment_max=moment_max,
        phi_ultimate=phi_ultimate,
        moment_ultimate=moment_ultimate,
        ductility=ductility,
        axial_load_n=axial_load_n,
        ei_secant=ei_secant,
        failure_reached=failure_reached,
    )


def _empty_result(axial_load_n: float) -> MomentCurvatureResult:
    return MomentCurvatureResult(
        curve=[], phi_yield=0.0, moment_yield=0.0,
        phi_max=0.0, moment_max=0.0,
        phi_ultimate=0.0, moment_ultimate=0.0,
        ductility=0.0, axial_load_n=axial_load_n,
        ei_secant=0.0, failure_reached=False,
    )
