"""Validación cruzada específica del espectro ELÁSTICO (newmark_sdof)
vs OpenSees con material Elastic + integrador Newmark 0.5, 0.25.

Además genera un espectro completo (30 periodos) para verificar la FORMA de la
curva Sa vs T con un acelerograma sintético y compara Sa punto a punto.
"""
from __future__ import annotations

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import openseespy.opensees as ops

from app.engine.ground_motion.analysis.spectra import newmark_sdof, response_spectrum

G = 9.80665


def opensees_elastic_sdof(ag, dt, T, xi):
    m = 1.0
    omega = 2 * np.pi / T
    k = m * omega ** 2

    ops.wipe()
    ops.model('basic', '-ndm', 1, '-ndf', 1)
    ops.node(1, 0.0); ops.node(2, 0.0)
    ops.fix(1, 1); ops.mass(2, m)

    # Material puramente elástico
    ops.uniaxialMaterial('Elastic', 1, k)
    ops.element('zeroLength', 1, 1, 2, '-mat', 1, '-dir', 1)
    ops.rayleigh(2.0 * xi * omega, 0.0, 0.0, 0.0)

    tag_ts = 100
    ops.timeSeries('Path', tag_ts, '-dt', dt, '-values', *ag.tolist())
    ops.pattern('UniformExcitation', 1, 1, '-accel', tag_ts)

    ops.constraints('Plain')
    ops.numberer('Plain')
    ops.system('BandGeneral')
    ops.test('NormDispIncr', 1e-10, 30)
    ops.algorithm('Newton')
    ops.integrator('Newmark', 0.5, 0.25)
    ops.analysis('Transient')

    n = len(ag)
    u = np.zeros(n); v = np.zeros(n); arel = np.zeros(n)
    arel[0] = -ag[0]
    for i in range(1, n):
        ops.analyze(1, dt)
        u[i] = ops.nodeDisp(2, 1)
        v[i] = ops.nodeVel(2, 1)
        arel[i] = ops.nodeAccel(2, 1)
    a_abs = arel + ag
    ops.wipe()
    return u, v, a_abs


def main():
    print("\n" + "#" * 78)
    print("#  VALIDACIÓN — Espectro elástico newmark_sdof vs OpenSees Elastic")
    print("#" * 78)

    # Acelerograma sintético amplio (contenido en 0.5–5 Hz)
    rng = np.random.default_rng(2026)
    dt  = 0.005
    t   = np.arange(0, 25.0, dt)
    ag  = (0.35 * G * np.sin(2 * np.pi * 1.2 * t) * np.exp(-0.06 * t)
         + 0.15 * G * np.sin(2 * np.pi * 3.0 * t + 0.4) * np.exp(-0.05 * t)
         + 0.06 * G * rng.standard_normal(len(t)) * np.exp(-0.06 * t))
    print(f"\n  Registro: PGA = {np.max(np.abs(ag))/G:.4f} g,  duración = {t[-1]:.1f} s,  dt = {dt} s")

    # ── Comparación puntual: máx |u| y máx |a_abs| en 8 periodos ──
    print("\n  Comparación de picos por periodo (ξ = 5%):")
    print(f"    {'T (s)':>6}  {'Sd_ours (cm)':>13}  {'Sd_OpS (cm)':>13}  {'Δ (%)':>7}   "
          f"{'Sa_ours (g)':>12}  {'Sa_OpS (g)':>12}  {'Δ (%)':>7}")
    print("    " + "-" * 100)

    max_err_u = 0.0
    max_err_a = 0.0
    xi = 0.05
    for T in [0.05, 0.10, 0.15, 0.30, 0.5, 1.0, 2.0, 3.0]:
        u_e, _, _, a_e = newmark_sdof(ag, dt, T, xi)
        u_o, _, a_o    = opensees_elastic_sdof(ag, dt, T, xi)
        sd_e = np.max(np.abs(u_e)) * 100
        sd_o = np.max(np.abs(u_o)) * 100
        sa_e = np.max(np.abs(a_e)) / G
        sa_o = np.max(np.abs(a_o)) / G
        err_u = (sd_e - sd_o) / sd_o * 100 if sd_o > 0 else 0
        err_a = (sa_e - sa_o) / sa_o * 100 if sa_o > 0 else 0
        max_err_u = max(max_err_u, abs(err_u))
        max_err_a = max(max_err_a, abs(err_a))
        tag = "[OK  ]" if abs(err_u) < 2 and abs(err_a) < 2 else "[    ]"
        print(f"    {tag} {T:5.2f}  {sd_e:13.4f}  {sd_o:13.4f}  {err_u:+7.3f}   "
              f"{sa_e:12.5f}  {sa_o:12.5f}  {err_a:+7.3f}")

    print(f"\n  Máx |ΔSd| = {max_err_u:.3f}%    Máx |ΔSa| = {max_err_a:.3f}%")

    # ── Espectro completo con response_spectrum (para chequear la forma) ──
    print("\n" + "=" * 78)
    print("  Espectro completo (25 puntos entre T=0.05 y T=3.0 s, ξ=5%)")
    print("=" * 78)
    T_arr = np.logspace(np.log10(0.05), np.log10(3.0), 25)
    spec = response_spectrum(ag, dt, T_arr, xi=0.05)
    print(f"\n  {'T (s)':>7}  {'Sd (cm)':>10}  {'Sv (cm/s)':>12}  {'Sa (g)':>10}  {'PSA (g)':>10}  {'PSV (cm/s)':>12}")
    print("  " + "-" * 74)
    for i, T in enumerate(T_arr):
        print(f"  {T:7.4f}  {spec['Sd'][i]*100:10.4f}  {spec['Sv'][i]*100:12.4f}  "
              f"{spec['Sa'][i]/G:10.5f}  {spec['PSA'][i]/G:10.5f}  {spec['PSV'][i]*100:12.4f}")

    print("\n  Coherencia:")
    print(f"    - Sa(T→0) debe ≈ PGA = {np.max(np.abs(ag))/G:.4f} g")
    print(f"    - PSA[i] = ω²·Sd[i] exacto (chequeado en tests)")
    print(f"    - Sa ≈ PSA para ξ=0; para ξ=5% pueden diferir hasta ~10% cerca de resonancias")

    return 0 if max_err_u < 2 and max_err_a < 2 else 1


if __name__ == "__main__":
    sys.exit(main())
