"""Modelos de concreto (Mander, Priestley & Park, 1988) -> parametros para OpenSeesPy Concrete01.

Unidades: N, mm, MPa en todo el modulo.

El motor no reimplementa la integracion tension-deformacion del concreto (eso lo
hace OpenSees al resolver la fiber section). Este modulo solo calcula los
parametros del material confinado/no confinado (fpc, epsc0, fpcu, epsU) que se
pasan directamente a `ops.uniaxialMaterial('Concrete01', tag, -fpc, -epsc0, -fpcu, -epsU)`
al construir la seccion.

Nota para revision futura: la formula de resistencia confinada biaxial de Mander
(f'lx != f'ly) se aproxima aqui promediando f'lx y f'ly cuando son distintos, en
vez de usar la superficie de falla biaxial completa del paper original. Es una
simplificacion razonable para estribos simetricos; reemplazar por la rutina propia
del usuario si se requiere mayor precision.
"""
from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class ConcreteMaterialParams:
    """Parametros listos para `uniaxialMaterial('Concrete01', ...)` (valores positivos)."""

    fpc: float    # resistencia maxima a compresion (MPa)
    epsc0: float  # deformacion unitaria en fpc
    fpcu: float   # resistencia residual/aplastamiento (MPa)
    epsU: float   # deformacion unitaria ultima


@dataclass(frozen=True)
class ConfinedConcreteReport:
    """Resultado completo del modelo de confinamiento Mander, incluyendo parametros intermedios.

    Complementa ConcreteMaterialParams con los valores de ingenieria que permiten
    verificar el confinamiento y generar el reporte profesional de la seccion.
    """

    params: ConcreteMaterialParams  # listos para Concrete01
    ke: float           # factor de efectividad de confinamiento [-]
    fl: float           # presion lateral efectiva de confinamiento [MPa]
    rho_s: float        # cuantia volumetrica de acero de confinamiento [-]
    fcc_over_fc: float  # factor de amplificacion de resistencia f'cc/f'c [-]
    fyh: float          # resistencia a la fluencia del acero de confinamiento [MPa]


def unconfined_concrete(
    fpc: float,
    eco: float = 0.002,
    fpcu_ratio: float = 0.2,
    ecu: float = 0.006,
) -> ConcreteMaterialParams:
    """Concreto de recubrimiento (no confinado). Rama descendente simplificada."""
    return ConcreteMaterialParams(fpc=fpc, epsc0=eco, fpcu=fpcu_ratio * fpc, epsU=ecu)


@dataclass(frozen=True)
class RectConfinement:
    """Geometria de confinamiento para estribos rectangulares (Mander et al. 1988)."""

    bc: float                  # dimension del nucleo eje-a-eje de estribo, direccion x (mm)
    dc: float                  # dimension del nucleo eje-a-eje de estribo, direccion y (mm)
    s: float                    # espaciamiento centro a centro de estribos (mm)
    hoop_bar_diameter: float    # diametro de la barra del estribo (mm)
    num_legs_x: int             # ramas de estribo/ganchos que restringen la direccion x
    num_legs_y: int             # ramas de estribo/ganchos que restringen la direccion y
    leg_area: float             # area de una rama de estribo (mm^2)
    clear_bar_spacings: list[float]  # wi: separaciones libres entre barras longitudinales soportadas (mm)
    rho_cc: float                # cuantia de acero longitudinal respecto al area del nucleo (Asl/Ac)


def mander_confined_rect_report(
    fpc: float,
    fyh: float,
    confinement: RectConfinement,
    eco: float = 0.002,
    esu_transverse: float = 0.10,
) -> ConfinedConcreteReport:
    """Concreto de nucleo confinado por estribos rectangulares (Mander et al. 1988).

    Retorna el reporte completo con parametros intermedios (ke, fl, rho_s, f'cc/f'c)
    ademas de los parametros para Concrete01.
    """
    bc, dc, s = confinement.bc, confinement.dc, confinement.s
    s_prime = max(s - confinement.hoop_bar_diameter, 0.0)

    sum_wi2 = sum(w * w for w in confinement.clear_bar_spacings)
    ae_over_ac = (
        (1 - sum_wi2 / (6 * bc * dc))
        * (1 - s_prime / (2 * bc))
        * (1 - s_prime / (2 * dc))
    )
    ke = ae_over_ac / (1 - confinement.rho_cc)
    ke = min(max(ke, 0.0), 1.0)

    rho_x = (confinement.num_legs_x * confinement.leg_area) / (s * dc)
    rho_y = (confinement.num_legs_y * confinement.leg_area) / (s * bc)
    flx = ke * rho_x * fyh
    fly = ke * rho_y * fyh
    fl = 0.5 * (flx + fly)  # aproximacion para confinamiento no exactamente igual en ambas direcciones

    fpcc = _mander_confined_strength(fpc, fl)
    epscc = eco * (1 + 5 * (fpcc / fpc - 1))

    rho_s = (2 * confinement.num_legs_x * confinement.leg_area / (dc * s)
             + 2 * confinement.num_legs_y * confinement.leg_area / (bc * s)) / 2
    ecu = 0.004 + 1.4 * rho_s * fyh * esu_transverse / fpcc

    params = ConcreteMaterialParams(fpc=fpcc, epsc0=epscc, fpcu=0.2 * fpcc, epsU=ecu)
    return ConfinedConcreteReport(
        params=params,
        ke=ke,
        fl=fl,
        rho_s=rho_s,
        fcc_over_fc=fpcc / fpc,
        fyh=fyh,
    )


def mander_confined_rect(
    fpc: float,
    fyh: float,
    confinement: RectConfinement,
    eco: float = 0.002,
    esu_transverse: float = 0.10,
) -> ConcreteMaterialParams:
    """Concreto de nucleo confinado por estribos rectangulares (Mander et al. 1988)."""
    return mander_confined_rect_report(fpc, fyh, confinement, eco, esu_transverse).params


@dataclass(frozen=True)
class CircConfinement:
    """Geometria de confinamiento para estribos/espirales circulares."""

    ds: float                  # diametro del nucleo eje-a-eje del estribo/espiral (mm)
    s: float                    # espaciamiento centro a centro (mm)
    hoop_bar_diameter: float    # diametro de la barra del estribo/espiral (mm)
    bar_area: float              # area de la barra del estribo/espiral (mm^2)
    rho_cc: float                 # cuantia de acero longitudinal respecto al area del nucleo
    is_spiral: bool = True         # True: espiral continua (ke=0.95); False: estribos circulares (ke=1.0)


def mander_confined_circ_report(
    fpc: float,
    fyh: float,
    confinement: CircConfinement,
    eco: float = 0.002,
    esu_transverse: float = 0.10,
) -> ConfinedConcreteReport:
    """Concreto de nucleo confinado por espiral/estribos circulares (Mander et al. 1988).

    Retorna el reporte completo con parametros intermedios.
    """
    ds, s = confinement.ds, confinement.s
    s_prime = max(s - confinement.hoop_bar_diameter, 0.0)

    # Mander et al. (1988), Eq. 5 (circular): ke = 0.95 para espiral, 1.0 para estribos circulares.
    factor = 0.95 if confinement.is_spiral else 1.0
    ke = factor * (1 - s_prime / (2 * ds)) / (1 - confinement.rho_cc)
    ke = min(max(ke, 0.0), 1.0)

    rho_s = 4 * confinement.bar_area / (ds * s)
    fl = 0.5 * ke * rho_s * fyh

    fpcc = _mander_confined_strength(fpc, fl)
    epscc = eco * (1 + 5 * (fpcc / fpc - 1))
    ecu = 0.004 + 1.4 * rho_s * fyh * esu_transverse / fpcc

    params = ConcreteMaterialParams(fpc=fpcc, epsc0=epscc, fpcu=0.2 * fpcc, epsU=ecu)
    return ConfinedConcreteReport(
        params=params,
        ke=ke,
        fl=fl,
        rho_s=rho_s,
        fcc_over_fc=fpcc / fpc,
        fyh=fyh,
    )


def mander_confined_circ(
    fpc: float,
    fyh: float,
    confinement: CircConfinement,
    eco: float = 0.002,
    esu_transverse: float = 0.10,
) -> ConcreteMaterialParams:
    """Concreto de nucleo confinado por espiral/estribos circulares (Mander et al. 1988)."""
    return mander_confined_circ_report(fpc, fyh, confinement, eco, esu_transverse).params


def _mander_confined_strength(fpc: float, fl: float) -> float:
    """Ecuacion cerrada de Mander para f'cc/f'c con confinamiento ~igual en ambas direcciones."""
    ratio = -1.254 + 2.254 * math.sqrt(1 + 7.94 * fl / fpc) - 2 * fl / fpc
    return ratio * fpc
