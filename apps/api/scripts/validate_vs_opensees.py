"""Comparación numérica: motor EPP-Newmark vs OpenSees (Steel01 + Newmark).

OpenSees es el estándar mundial en dinámica no lineal (McKenna, 2011). Si nuestro
motor concuerda con OpenSees dentro de ±3% para el pico de la respuesta EPP, el
motor está correcto — cualquier desviación mayor respecto a reglas empíricas como
Newmark-Hall proviene de la naturaleza estocástica de esas reglas, no de bugs.

Se compara:
  - Máx |u(t)| del oscilador EPP en varios T y varios fy_norm
  - Máx |ü_abs(t)| en el mismo caso

Referencias:
  - McKenna (2011), OpenSees: A Framework for Earthquake Engineering Simulation.
  - Filippou et al. (1983), Effects of Bond Deterioration on Hysteretic Behavior. (Steel01)
  - Chopra (2012), Cap. 5 y 7.
"""
from __future__ import annotations

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import openseespy.opensees as ops

from app.engine.ground_motion.analysis.spectra import newmark_sdof
from app.engine.ground_motion.analysis.inelastic_spectra import epp_sdof


G = 9.80665


def opensees_epp_sdof(ag: np.ndarray, dt: float, T: float, xi: float, fy_norm: float):
    """Resuelve el SDOF EPP con OpenSees. Retorna (u, u_dot, u_ddot_abs).

    Modelo:
      - Nodo 1 fijo (base), Nodo 2 con masa unitaria en X.
      - Resorte zeroLength con material Steel01 (b=0 → perfectamente plástico).
      - Amortiguamiento Rayleigh proporcional a la masa: αM = 2·ξ·ω
      - Excitación de base: patrón MultipleSupport con groundMotion Plain aplicado
        al nodo 1 (nodo fijo cinemáticamente por Sp constraint).

    Alternativa más simple y estándar: patrón UniformExcitation.
    """
    m     = 1.0
    omega = 2.0 * np.pi / T
    k     = m * omega ** 2
    u_y   = fy_norm / omega ** 2   # = fy / k con m=1
    F_y   = fy_norm                 # = k · u_y (con m=1)

    ops.wipe()
    ops.model('basic', '-ndm', 1, '-ndf', 1)

    ops.node(1, 0.0)
    ops.node(2, 0.0)
    ops.fix(1, 1)
    ops.mass(2, m)

    # Steel01: E, fy, b=0 → EPP
    ops.uniaxialMaterial('Steel01', 1, F_y, k, 0.0)
    ops.element('zeroLength', 1, 1, 2, '-mat', 1, '-dir', 1)

    # Amortiguamiento Rayleigh: αM = 2ξω (masa-proporcional)
    ops.rayleigh(2.0 * xi * omega, 0.0, 0.0, 0.0)

    # Serie de aceleración de base
    tag_ts = 100
    ops.timeSeries('Path', tag_ts, '-dt', dt, '-values', *ag.tolist())

    # Patrón UniformExcitation en dirección 1
    ops.pattern('UniformExcitation', 1, 1, '-accel', tag_ts)

    # Análisis
    ops.constraints('Plain')
    ops.numberer('Plain')
    ops.system('BandGeneral')
    ops.test('NormDispIncr', 1e-8, 30)
    ops.algorithm('Newton')
    ops.integrator('Newmark', 0.5, 0.25)   # γ=1/2, β=1/4 — igual que nuestro engine
    ops.analysis('Transient')

    n = len(ag)
    u    = np.zeros(n)
    v    = np.zeros(n)
    arel = np.zeros(n)
    u[0]    = 0.0
    v[0]    = 0.0
    arel[0] = -ag[0]

    for i in range(1, n):
        ok = ops.analyze(1, dt)
        if ok != 0:
            print(f"    ⚠ OpenSees falló en step {i}. dt={dt}")
            break
        u[i]    = ops.nodeDisp(2, 1)
        v[i]    = ops.nodeVel(2, 1)
        arel[i] = ops.nodeAccel(2, 1)

    a_abs = arel + ag
    ops.wipe()
    return u, v, a_abs


def header(msg: str):
    print("\n" + "=" * 78)
    print(f"  {msg}")
    print("=" * 78)


def main():
    print("\n" + "#" * 78)
    print("#  VALIDACIÓN CRUZADA — Motor EPP vs OpenSees")
    print("#" * 78)

    # ── Acelerograma sintético ──
    rng = np.random.default_rng(2026)
    dt  = 0.005
    t   = np.arange(0, 25.0, dt)
    ag  = (0.35 * G * np.sin(2 * np.pi * 1.2 * t) * np.exp(-0.06 * t)
         + 0.15 * G * np.sin(2 * np.pi * 3.0 * t + 0.4) * np.exp(-0.05 * t)
         + 0.06 * G * rng.standard_normal(len(t)) * np.exp(-0.06 * t))
    print(f"\n  Acelerograma sintético: PGA = {np.max(np.abs(ag))/G:.4f} g,  duración = {t[-1]:.1f} s")

    xi = 0.05

    header("Comparación: max|u| y max|ü_abs| — Nuestro motor vs OpenSees")

    print(f"\n  {'T (s)':>6}  {'fy/PSA_el':>10}  "
          f"{'u_nuestro (cm)':>14}  {'u_OpS (cm)':>12}  {'Δ (%)':>7}   "
          f"{'a_nuestro (g)':>13}  {'a_OpS (g)':>10}  {'Δ (%)':>7}")
    print("  " + "-" * 105)

    max_err_u = 0.0
    max_err_a = 0.0

    for T in [0.15, 0.30, 0.5, 1.0, 1.5, 2.0]:
        omega = 2 * np.pi / T
        # Primero calcular PSA elástico
        u_el, _, _, _ = newmark_sdof(ag, dt, T, xi)
        psa_el = omega ** 2 * float(np.max(np.abs(u_el)))

        # Probar 3 niveles de fluencia
        for frac in [0.6, 0.3, 0.15]:
            fy = frac * psa_el

            # Nuestro engine
            u_e, _, _, a_e, _ = epp_sdof(ag, dt, T, xi, fy)
            u_max_e = float(np.max(np.abs(u_e)))
            a_max_e = float(np.max(np.abs(a_e)))

            # OpenSees
            u_o, _, a_o = opensees_epp_sdof(ag, dt, T, xi, fy)
            u_max_o = float(np.max(np.abs(u_o)))
            a_max_o = float(np.max(np.abs(a_o)))

            err_u = (u_max_e - u_max_o) / u_max_o * 100 if u_max_o > 0 else 0
            err_a = (a_max_e - a_max_o) / a_max_o * 100 if a_max_o > 0 else 0

            max_err_u = max(max_err_u, abs(err_u))
            max_err_a = max(max_err_a, abs(err_a))

            tag = "[OK  ]" if abs(err_u) < 3 and abs(err_a) < 3 else "[    ]"
            print(f"  {tag} {T:5.2f}  {frac:10.2f}  "
                  f"{u_max_e*100:14.4f}  {u_max_o*100:12.4f}  {err_u:+7.3f}   "
                  f"{a_max_e/G:13.5f}  {a_max_o/G:10.5f}  {err_a:+7.3f}")

    print("\n" + "=" * 78)
    print(f"  Máx error absoluto (u): {max_err_u:.2f}%")
    print(f"  Máx error absoluto (a): {max_err_a:.2f}%")
    print("=" * 78)

    veredicto = "MOTOR VALIDADO" if (max_err_u < 3 and max_err_a < 3) else \
                "REVISAR: hay desviación >3% respecto a OpenSees"
    print(f"\n  → {veredicto}\n")
    return 0 if max_err_u < 5 and max_err_a < 5 else 1


if __name__ == "__main__":
    sys.exit(main())
