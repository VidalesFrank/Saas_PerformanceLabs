"""Análisis cíclico de sección — histéresis M-φ bajo historial de curvatura.

Aplica un historial cíclico de curvatura (usando el mismo modelo fiber section
que M-φ monotónico) y devuelve los lazos histeréticos M vs φ + métricas:

  · Energía disipada por ciclo Ed
  · Energía elástica equivalente Es = ½·M_max·φ_max
  · Amortiguamiento equivalente Jacobsen: ξ_eq = Ed / (4π·Es)
  · Rigidez secante en el pico de cada ciclo
  · Degradación de rigidez entre ciclos

REQUIERE materiales con memoria histerética:
  · Concrete02 (Yassin) — con descarga y recarga histerética
  · Steel02 (Menegotto-Pinto) — con Bauschinger

Configurar en el SectionDocument los model_kind correspondientes antes de
llamar a este análisis (ver Fase 2A).

Referencias:
  - Jacobsen (1930), Steady forced vibrations damped by pure friction.
  - Chopra (2012), Dynamics of Structures, Sec. 3.9 — amortiguamiento equivalente.
  - ATC-24 (1992), Guidelines for cyclic seismic testing.
  - FEMA 461 (2007), Interim testing protocols.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Literal

import numpy as np
import openseespy.opensees as ops

from engine.sections.compiler import CompiledFiberSection
from .interaction import ELE_TAG, SEC_TAG, _define_materials, _build_section, _build_section_at_angle, _effective_depth


CycleProtocol = Literal["atc_24", "sinusoidal_decay", "user"]


# ─────────────────────────────────────────────────────────────────────────────
# Estructuras
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class CyclicPoint:
    phi:    float    # 1/mm
    moment: float    # N·mm (signado — positivo/negativo según carga)


@dataclass
class CycleMetric:
    """Métricas de un ciclo individual."""
    peak_pos_phi: float
    peak_neg_phi: float
    peak_pos_M:   float
    peak_neg_M:   float
    energy_dissipated: float   # ∮ M·dφ del ciclo [N]
    energy_elastic:    float   # ½·M_max·φ_max
    xi_eq_pct:         float   # amortiguamiento equivalente Jacobsen [%]
    K_sec_pos:         float   # rigidez secante en pico positivo [N·mm² / rad]
    K_sec_neg:         float


@dataclass
class CyclicResult:
    curve:            list[CyclicPoint]    # historia completa M-φ
    phi_history:      list[float]           # historial prescrito
    cycles:           list[CycleMetric]     # métricas por ciclo
    total_energy_dis: float                 # energía total disipada [N·mm·rad] = [N·mm/(1/mm)] = N·mm²
    axial_load_n:     float
    protocol:         str
    notes:            list[str] = field(default_factory=list)


# ─────────────────────────────────────────────────────────────────────────────
# Generadores de historial
# ─────────────────────────────────────────────────────────────────────────────

def generate_atc24_history(
    phi_yield: float,
    ductilities: list[float] | None = None,
    cycles_per_step: int = 2,
    steps_per_cycle: int = 20,
) -> list[float]:
    """Historial estándar ATC-24: amplitudes crecientes en escalón.

    Cada nivel de ductilidad μ = φ/φy se aplica `cycles_per_step` veces (típico 2 o 3).
    Cada ciclo se discretiza con `steps_per_cycle` pasos (default 20).

    Args:
        phi_yield:       curvatura de fluencia (referencia) [1/mm].
        ductilities:     lista de μ = φ_max/φy (default [0.5, 1, 1.5, 2, 3, 4, 6, 8]).
        cycles_per_step: número de ciclos por nivel (default 2).
        steps_per_cycle: puntos por ciclo (default 20).
    """
    if ductilities is None:
        ductilities = [0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0, 8.0]

    history: list[float] = [0.0]
    for mu in ductilities:
        amp = mu * phi_yield
        for _ in range(cycles_per_step):
            for k in range(steps_per_cycle):
                # Onda triangular: 0 → +amp → -amp → 0
                t = k / steps_per_cycle
                if t < 0.25:
                    v = amp * (4 * t)
                elif t < 0.75:
                    v = amp * (2 - 4 * t)
                else:
                    v = amp * (4 * t - 4)
                history.append(v)
    return history


def generate_sinusoidal_history(
    phi_max:  float,
    n_cycles: int = 5,
    decay:    float = 0.0,
    steps_per_cycle: int = 40,
) -> list[float]:
    """Historial senoidal (opcionalmente decayente).

    decay = 0 → amplitud constante.  decay > 0 → decrece exponencialmente.
    """
    history: list[float] = []
    for k in range(n_cycles * steps_per_cycle + 1):
        t = k / steps_per_cycle
        env = math.exp(-decay * t) if decay > 0 else 1.0
        history.append(phi_max * env * math.sin(2 * math.pi * t))
    return history


# ─────────────────────────────────────────────────────────────────────────────
# Análisis principal
# ─────────────────────────────────────────────────────────────────────────────

def compute_cyclic_moment_curvature(
    compiled: CompiledFiberSection,
    phi_history: list[float],
    axial_load_n: float = 0.0,
    theta_deg:    float = 0.0,
    protocol_label: str = "user",
) -> CyclicResult:
    """Análisis cíclico M-φ.

    Aplica el historial de curvatura prescrito paso a paso y registra M(φ).
    Usa DisplacementControl con incrementos variables (Δφ = φ_{i+1} − φ_i).
    """
    theta_rad = math.radians(theta_deg)
    p_ops = -axial_load_n

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

    # ── Aplicar carga axial ──
    ops.timeSeries("Constant", 1)
    ops.pattern("Plain", 1, 1)
    ops.load(2, p_ops, 0.0, 0.0)

    ops.system("BandGeneral")
    ops.numberer("Plain")
    ops.constraints("Plain")
    ops.test("NormUnbalance", 1.0e-6, 30)
    ops.algorithm("Newton")
    ops.integrator("LoadControl", 0.1)
    ops.analysis("Static")

    for _ in range(10):
        if ops.analyze(1) != 0:
            return _empty_result(axial_load_n, protocol_label)
    ops.loadConst("-time", 0.0)

    # ── Aplicar historial cíclico ──
    ops.timeSeries("Linear", 2)
    ops.pattern("Plain", 2, 2)
    ops.load(2, 0.0, 0.0, 1.0)

    curve: list[CyclicPoint] = []
    phi_actual: list[float] = []
    notes: list[str] = []

    curr_phi = 0.0
    for phi_target in phi_history:
        d_phi = phi_target - curr_phi
        if abs(d_phi) < 1e-14:
            continue
        # DisplacementControl con incremento igual a Δφ
        ops.integrator("DisplacementControl", 2, 3, d_phi)
        ok = ops.analyze(1)
        if ok != 0:
            # Sub-dividir el paso
            n_sub = 5
            ops.integrator("DisplacementControl", 2, 3, d_phi / n_sub)
            for _ in range(n_sub):
                ok = ops.analyze(1)
                if ok != 0:
                    ops.algorithm("KrylovNewton")
                    ok = ops.analyze(1)
                    ops.algorithm("Newton")
                if ok != 0:
                    break
            if ok != 0:
                notes.append(f"Convergencia perdida en φ = {phi_target:.6f}")
                break
        phi_i = ops.nodeDisp(2, 3)
        m_i   = ops.getLoadFactor(2)
        curve.append(CyclicPoint(phi=phi_i, moment=m_i))
        phi_actual.append(phi_i)
        curr_phi = phi_target

    if not curve:
        return _empty_result(axial_load_n, protocol_label)

    # ── Post-proceso: métricas por ciclo ──
    cycles = _cycle_metrics(curve)
    total_ed = sum(c.energy_dissipated for c in cycles)

    return CyclicResult(
        curve=curve,
        phi_history=phi_actual,
        cycles=cycles,
        total_energy_dis=total_ed,
        axial_load_n=axial_load_n,
        protocol=protocol_label,
        notes=notes,
    )


def _cycle_metrics(curve: list[CyclicPoint]) -> list[CycleMetric]:
    """Detecta ciclos por cruces por cero de φ (subiendo) y calcula métricas."""
    if len(curve) < 4:
        return []

    phis = np.array([p.phi for p in curve])
    moms = np.array([p.moment for p in curve])

    # Detectar cruces por cero de φ subiendo (inicio de ciclo)
    starts: list[int] = [0]
    for i in range(1, len(phis)):
        if phis[i - 1] < 0 and phis[i] >= 0:
            starts.append(i)
    starts.append(len(phis) - 1)

    cycles: list[CycleMetric] = []
    for a, b in zip(starts, starts[1:]):
        if b - a < 4:
            continue
        seg_phi = phis[a:b + 1]
        seg_M   = moms[a:b + 1]
        # Trapezoidal ∮ M·dφ del ciclo
        Ed = float(0.5 * np.sum((seg_M[:-1] + seg_M[1:]) * np.diff(seg_phi)))
        Ed = abs(Ed)   # magnitud del área encerrada

        i_pos = int(np.argmax(seg_M))
        i_neg = int(np.argmin(seg_M))
        M_pos, phi_pos = float(seg_M[i_pos]), float(seg_phi[i_pos])
        M_neg, phi_neg = float(seg_M[i_neg]), float(seg_phi[i_neg])

        M_amp   = 0.5 * (abs(M_pos) + abs(M_neg))
        phi_amp = 0.5 * (abs(phi_pos) + abs(phi_neg))
        Es = 0.5 * M_amp * phi_amp
        xi_eq = (Ed / (4 * math.pi * Es)) * 100.0 if Es > 0 else 0.0

        K_pos = M_pos / phi_pos if abs(phi_pos) > 1e-14 else 0.0
        K_neg = M_neg / phi_neg if abs(phi_neg) > 1e-14 else 0.0

        cycles.append(CycleMetric(
            peak_pos_phi=phi_pos, peak_neg_phi=phi_neg,
            peak_pos_M=M_pos, peak_neg_M=M_neg,
            energy_dissipated=Ed, energy_elastic=Es,
            xi_eq_pct=xi_eq,
            K_sec_pos=K_pos, K_sec_neg=K_neg,
        ))
    return cycles


def _empty_result(axial_load_n: float, protocol: str) -> CyclicResult:
    return CyclicResult(
        curve=[], phi_history=[], cycles=[],
        total_energy_dis=0.0, axial_load_n=axial_load_n, protocol=protocol,
    )
