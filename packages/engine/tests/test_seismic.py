"""Tests del motor NSR-10: factores de sitio y espectro de diseno.

Caso de referencia: Bogota D.C. / Medellin, suelo D.
  Aa = 0.15 g, Av = 0.20 g
  Breakpoints de tabla: [0.10, 0.20, 0.30, 0.40, 0.50]
  Fa = interp(0.15, [0.10,0.20], [1.6,1.4]) = 1.50
  Fv = directo en break 0.20                = 2.00
  SDs = 2.5 * 0.15 * 1.50 = 0.5625 g
  SD1 = 0.20 * 2.00        = 0.40 g
  Ts  = 0.40 / 0.5625      = 0.7111 s
  T0  = 0.2 * 0.7111       = 0.1422 s
"""
import math
import pytest
from engine.seismic import compute_spectrum, get_site_factors, spectral_parameters


def test_bogota_suelo_D_site_factors():
    """Fa=1.5 y Fv=2.0 para Aa=0.15, Av=0.20, suelo D (verificado contra NSR-10)."""
    Fa, Fv = get_site_factors(Aa=0.15, Av=0.20, soil_type="D")
    assert abs(Fa - 1.5) < 1e-9
    assert abs(Fv - 2.0) < 1e-9


def test_bogota_suelo_D_spectral_params():
    Fa, Fv = get_site_factors(0.15, 0.20, "D")
    p = spectral_parameters(0.15, 0.20, Fa, Fv)
    SDs_expected = 2.5 * 0.15 * 1.5   # 0.5625
    SD1_expected = 0.20 * 2.0          # 0.40
    assert abs(p["SDs"] - SDs_expected) < 1e-6
    assert abs(p["SD1"] - SD1_expected) < 1e-6
    assert abs(p["Ts"] - SD1_expected / SDs_expected) < 1e-6
    assert abs(p["T0"] - 0.2 * SD1_expected / SDs_expected) < 1e-6
    assert p["TL"] == 4.0


def test_spectrum_plateau_value():
    """En T0 < T <= Ts, Sa debe ser exactamente SDs."""
    result = compute_spectrum(0.15, 0.20, "D")
    p = result["params"]
    T0, Ts, SDs = p["T0"], p["Ts"], p["SDs"]

    T_mid = (T0 + Ts) / 2
    pt = next(x for x in result["puntos"] if abs(x["T"] - T_mid) < 0.01)
    assert abs(pt["Sa"] - SDs) < 0.001


def test_spectrum_shape_monotone_after_peak():
    """Sa debe decrecer monotonamente para T > Ts."""
    result = compute_spectrum(0.20, 0.25, "C")
    Ts = result["params"]["Ts"]
    pts_after = [p for p in result["puntos"] if p["T"] > Ts + 0.01]
    Sa_vals = [p["Sa"] for p in pts_after]
    for i in range(1, len(Sa_vals)):
        assert Sa_vals[i] <= Sa_vals[i - 1] + 1e-8, (
            f"Sa no monotonico: {Sa_vals[i-1]:.4f} → {Sa_vals[i]:.4f} (i={i})"
        )


def test_spectrum_at_T0_continuity():
    """Sa debe ser continuo en T0: la rampa y la meseta coinciden en T=T0."""
    result = compute_spectrum(0.25, 0.25, "C")
    p = result["params"]
    T0 = p["T0"]
    # Puntos justo antes y justo despues de T0
    antes = next(x for x in result["puntos"] if abs(x["T"] - T0 * 0.999) < 0.005)
    despues = next(x for x in result["puntos"] if abs(x["T"] - T0 * 1.001) < 0.005)
    assert abs(antes["Sa"] - despues["Sa"]) < 0.01


def test_suelo_A_minimal_amplification():
    """Suelo tipo A: Fa=0.8, Fv=0.8 en todas las zonas."""
    for Aa in [0.05, 0.15, 0.30]:
        Fa, Fv = get_site_factors(Aa, Aa, "A")
        assert abs(Fa - 0.8) < 1e-9
        assert abs(Fv - 0.8) < 1e-9


def test_suelo_B_unitary():
    """Suelo tipo B: Fa=1.0, Fv=1.0."""
    Fa, Fv = get_site_factors(0.25, 0.25, "B")
    assert Fa == 1.0
    assert Fv == 1.0


def test_suelo_F_raises():
    """Suelo tipo F debe lanzar ValueError (estudio especifico requerido)."""
    with pytest.raises(ValueError, match="estudio de sitio"):
        get_site_factors(0.15, 0.20, "F")


def test_sd_sv_physical_consistency():
    """Sd = Sa*g*T²/(4π²) y Sv = Sa*g*T/(2π) deben ser consistentes con Sa."""
    g = 980.665
    result = compute_spectrum(0.20, 0.20, "D")
    for pt in result["puntos"]:
        T, Sa = pt["T"], pt["Sa"]
        if T > 0:
            Sd_expected = Sa * g * T**2 / (4 * math.pi**2)
            Sv_expected = Sa * g * T / (2 * math.pi)
            assert abs(pt["Sd"] - Sd_expected) < 0.01, f"Sd erroneo en T={T}"
            assert abs(pt["Sv"] - Sv_expected) < 0.01, f"Sv erroneo en T={T}"


def test_zona_sismica_classification():
    from engine.seismic import zona_sismica
    assert zona_sismica(0.05) == "baja"
    assert zona_sismica(0.10) == "baja"
    assert zona_sismica(0.15) == "intermedia"
    assert zona_sismica(0.20) == "intermedia"
    assert zona_sismica(0.25) == "alta"
    assert zona_sismica(0.40) == "alta"
