"""Tests unitarios del método N2 (Fajfar 2000)."""
from __future__ import annotations

import math

import numpy as np
import pytest

from engine.performance.n2 import (
    bilinear_equal_energy,
    corner_period_newmark_hall,
    mdof_to_sdof,
    n2_target_displacement,
    run_n2,
    truncate_strength_drop,
)

GRAV = 9.81  # m/s²


# ──────────────────────────────────────────────────────────────────────────────
# Fixtures
# ──────────────────────────────────────────────────────────────────────────────

def _bilinear_pushover(
    Vy_kN:        float = 1000.0,
    delta_y_m:    float = 0.05,
    delta_ult_m:  float = 0.30,
    hardening:    float = 0.02,
    n_asc:        int   = 20,
    n_pos:        int   = 60,
) -> tuple[np.ndarray, np.ndarray]:
    """Curva pushover bilineal con pequeño endurecimiento, sin degradación."""
    dasc = np.linspace(0.0, delta_y_m, n_asc)
    Vasc = (Vy_kN / delta_y_m) * dasc
    dpost = np.linspace(delta_y_m, delta_ult_m, n_pos)[1:]
    Vpost = Vy_kN + hardening * (Vy_kN / delta_y_m) * (dpost - delta_y_m)
    return (np.concatenate([dasc, dpost]), np.concatenate([Vasc, Vpost]))


def _pushover_with_softening(
    Vy_kN:        float = 1000.0,
    delta_y_m:    float = 0.05,
    delta_peak_m: float = 0.20,
    delta_tail_m: float = 0.40,
    V_peak_kN:    float = 1200.0,
    V_tail_kN:    float = 600.0,
) -> tuple[np.ndarray, np.ndarray]:
    """Curva con rama ascendente, pico, y rama descendente > 20% drop."""
    d1 = np.linspace(0.0,         delta_y_m,    15)
    V1 = (Vy_kN / delta_y_m) * d1
    d2 = np.linspace(delta_y_m,   delta_peak_m, 25)[1:]
    V2 = Vy_kN + (V_peak_kN - Vy_kN) * (d2 - delta_y_m) / (delta_peak_m - delta_y_m)
    d3 = np.linspace(delta_peak_m, delta_tail_m, 25)[1:]
    V3 = V_peak_kN + (V_tail_kN - V_peak_kN) * (d3 - delta_peak_m) / (delta_tail_m - delta_peak_m)
    return (np.concatenate([d1, d2, d3]), np.concatenate([V1, V2, V3]))


def _elastic_spectrum(T_max: float = 4.0, n: int = 400) -> tuple[np.ndarray, np.ndarray]:
    """Espectro tipo plateau simple: Sa=Sa_plateau en Ts<=T<=Ts_fin, luego cae 1/T."""
    T = np.linspace(0.01, T_max, n)
    T0, Ts = 0.1, 0.5
    Sa_plateau = 1.0 * GRAV  # 1 g
    Sa = np.where(
        T < T0, Sa_plateau * (T / T0),
        np.where(T <= Ts, Sa_plateau, Sa_plateau * (Ts / T))
    )
    return T, Sa


# ──────────────────────────────────────────────────────────────────────────────
# Tests unitarios
# ──────────────────────────────────────────────────────────────────────────────

def test_mdof_to_sdof_divides_by_gamma_and_m_ast():
    """Sd = δ/Γ, Sa = V/(Γ·m*). Verificación directa."""
    d  = np.array([0.0, 0.05, 0.10])
    V  = np.array([0.0, 500.0, 1000.0])
    gamma_1 = 1.3
    m_ast   = 250.0  # ton
    Sd, Sa = mdof_to_sdof(d, V, gamma_1, m_ast)
    np.testing.assert_allclose(Sd, d / gamma_1, rtol=1e-12)
    np.testing.assert_allclose(Sa, V / (gamma_1 * m_ast), rtol=1e-12)


def test_mdof_to_sdof_rejects_nonpositive_gamma_or_mass():
    d = np.array([0.0, 1.0]); V = np.array([0.0, 1.0])
    with pytest.raises(ValueError):
        mdof_to_sdof(d, V, 0.0, 100.0)
    with pytest.raises(ValueError):
        mdof_to_sdof(d, V, 1.0, 0.0)


def test_truncate_detects_20pct_drop():
    """Con curva que baja al 50% del pico, idx_falla cae en la rama descendente."""
    d, V = _pushover_with_softening()
    Sd_u, Sa_u, idx, found = truncate_strength_drop(d, V)
    assert found is True
    assert Sa_u[-1] < 0.80 * Sa_u.max() + 1e-9
    # El punto justo anterior aún debe estar sobre 80%
    assert Sa_u[-2] >= 0.80 * Sa_u.max() - 1e-6


def test_truncate_no_drop_uses_full_curve():
    """Si no hay caída del 20%, usa toda la curva y marca found=False."""
    d, V = _bilinear_pushover()  # endurecimiento, nunca cae
    Sd_u, Sa_u, idx, found = truncate_strength_drop(d, V)
    assert found is False
    assert idx == len(d) - 1
    assert len(Sd_u) == len(d)


def test_bilinear_recovers_known_bilinear_curve():
    """Si la curva YA es bilineal, la idealización debe recuperar Vy, δy."""
    Vy_kN, delta_y = 1000.0, 0.05
    d, V = _bilinear_pushover(Vy_kN=Vy_kN, delta_y_m=delta_y, hardening=0.0)
    # Convertimos a SDOF con Γ=1, m*=100 → Sd=d, Sa=V/100
    gamma, m = 1.0, 100.0
    Sd, Sa = mdof_to_sdof(d, V, gamma, m)
    Sd_u, Sa_u, _, _ = truncate_strength_drop(Sd, Sa)
    # Sin softening, la curva no cruza 20% drop. Truncamos a mano para equal-energy razonable.
    K_star, Say, Sdy, T_star = bilinear_equal_energy(Sd_u, Sa_u)
    # Esperado: Say ≈ Vy/m = 10 m/s², Sdy ≈ δy = 0.05 m, K*=Say/Sdy
    assert Say == pytest.approx(Vy_kN / m, rel=0.05)
    assert Sdy == pytest.approx(delta_y, rel=0.1)
    assert T_star > 0


def test_corner_period_from_simple_spectrum():
    """Con el plateau simple [T0, Ts], Tc ≈ Ts (porque Sv_max cae en Ts)."""
    T, Sa = _elastic_spectrum()
    Tc = corner_period_newmark_hall(T, Sa)
    # Para espectro plateau+1/T, Sv crece lineal con T hasta Ts, luego constante.
    # Sv_max ocurre en T=Ts=0.5s con Sv=Sa_plat·Ts/(2π). Tc = 2π·Sv_max/Sa_max = Ts.
    assert Tc == pytest.approx(0.5, rel=0.03)


def test_n2_target_equal_displacement_for_long_period():
    """T* ≥ Tc → regla equal-displacement: Sd_target = Sde."""
    Tc = 0.5; T_star = 1.0
    Sae = 5.0; Say = 2.0
    Sd_target, R_mu, rule = n2_target_displacement(T_star, Tc, Sae, Say)
    Sde_esperado = Sae * (T_star / (2 * math.pi)) ** 2
    assert rule == "equal_displacement"
    assert Sd_target == pytest.approx(Sde_esperado)
    assert R_mu == pytest.approx(Sae / Say)


def test_n2_target_equal_energy_for_short_period():
    """T* < Tc → regla equal-energy: Sd_target > Sde."""
    Tc = 0.8; T_star = 0.3
    Sae = 10.0; Say = 2.5
    Sd_target, R_mu, rule = n2_target_displacement(T_star, Tc, Sae, Say)
    Sde = Sae * (T_star / (2 * math.pi)) ** 2
    assert rule == "equal_energy"
    assert R_mu == pytest.approx(Sae / Say)
    # Equal-energy predice amplificación respecto a Sde/Rμ
    assert Sd_target > Sde / R_mu


def test_run_n2_end_to_end_bilinear_building():
    """Pipeline completo con pushover softening + espectro simple."""
    d, V = _pushover_with_softening()
    T, Sa = _elastic_spectrum()
    res = run_n2(
        dtecho=d, Vbasal=V,
        gamma_1=1.3, m_ast=200.0,  # ton
        T_spec=T, Sa_spec_mps2=Sa,
    )
    # Sanity checks estructurales
    assert res.strength_drop_found is True
    assert res.T_star > 0 and res.T_star < 2.0
    assert res.Say > 0 and res.Sdy > 0
    assert res.Tc > 0
    assert res.rule in ("equal_displacement", "equal_energy")
    assert res.Sd_target > 0
    assert res.D_target == pytest.approx(res.gamma_1 * res.Sd_target)
    assert res.ductility >= 1.0
    # Longitudes coherentes para plot
    assert len(res.Sd_capacity) == len(res.Sa_capacity) == len(d)
    assert len(res.Sd_useful) == len(res.Sa_useful) == res.idx_falla + 1
    assert len(res.bilinear_sd) == 3


def test_run_n2_flags_collapse_when_demand_exceeds_capacity():
    """Si el espectro es muy agresivo respecto a la capacidad → is_collapse=True."""
    d, V = _pushover_with_softening(Vy_kN=200, V_peak_kN=250, V_tail_kN=100)
    T = np.linspace(0.01, 4.0, 200)
    Sa = 5.0 * GRAV * np.ones_like(T)  # 5 g plano, demanda enorme
    res = run_n2(
        dtecho=d, Vbasal=V,
        gamma_1=1.3, m_ast=50.0,
        T_spec=T, Sa_spec_mps2=Sa,
    )
    assert res.is_collapse is True
    assert any("Sd objetivo" in w for w in res.warnings)
