"""
Revisión de elemento de borde confinado (EBE) para muros RC.
NSR-10 C.21.9.6 (DES) / C.21.4.4 (DMO)
ACI 318-25 §18.10.6

Métodos:
  A — Basado en deformación (§18.10.6.2): requiere δu/hw
  B — Basado en esfuerzo (§18.10.6.3): solo fuerzas del análisis lineal
"""
from __future__ import annotations
import math
from typing import Optional
from .wall_design_schemas import BoundaryElementResult

# Umbrales σ para requerir EBE
SIGMA_THRESHOLD_DES = 0.20  # f'c (ACI 318-25 §18.10.6.3)
SIGMA_THRESHOLD_DMO = 0.15  # f'c (NSR-10 C.21.4, más conservador)


def extreme_fiber_stress_mpa(
    Pu_kN: float, Mu_kNm: float,
    lw_m: float, tw_m: float,
) -> float:
    """
    Esfuerzo en la fibra más comprimida (elástico lineal, MPa).
    σ = Pu/Ag + Mu·(lw/2)/I
    """
    Ag = lw_m * tw_m          # m²
    I  = tw_m * lw_m**3 / 12  # m⁴
    # Convertir a MPa: kN/m² × 1e-3 = MPa
    sigma = (Pu_kN / Ag + Mu_kNm * (lw_m / 2) / I) * 1e-3  # MPa
    return sigma


def _ebe_length_stress(c_m: float, lw_m: float) -> float:
    """Longitud EBE por método de esfuerzo: max(0.15lw, c/2)."""
    return max(0.15 * lw_m, c_m / 2.0)


def _ebe_length_displacement(c_m: float, lw_m: float) -> float:
    """Longitud EBE por método de desplazamiento: max(c - 0.1lw, c/2)."""
    return max(c_m - 0.1 * lw_m, c_m / 2.0)


def check_boundary_element(
    Pu_kN: float, Mu_kNm: float,
    lw_m: float, tw_m: float, hw_m: float,
    fc_mpa: float,
    c_m: float,                        # eje neutro (de neutral_axis.py)
    ductility: str = "DES",
    delta_u_hw: Optional[float] = None,  # deriva de diseño δu/hw (adimensional)
) -> BoundaryElementResult:
    """
    Determina si se requiere EBE y calcula su longitud.

    Para DES: aplica método A (desplazamiento) si se provee delta_u_hw,
              de lo contrario aplica método B (esfuerzo).
    Para DMO: solo método B con umbral reducido.
    """
    sigma = extreme_fiber_stress_mpa(Pu_kN, Mu_kNm, lw_m, tw_m)
    threshold = SIGMA_THRESHOLD_DES * fc_mpa if ductility == "DES" else SIGMA_THRESHOLD_DMO * fc_mpa

    # ── Método A — Desplazamiento (solo DES, requiere δu/hw) ──────────────────
    if ductility == "DES" and delta_u_hw is not None and delta_u_hw > 0:
        # ACI 318-25 Eq. 18.10.6.2: EBE requerido si c ≥ lw/(600×(δu/hw))
        c_limit = lw_m / (600.0 * delta_u_hw)
        required = c_m >= c_limit
        lc = _ebe_length_displacement(c_m, lw_m) if required else 0.0
        return BoundaryElementResult(
            required=required,
            method="displacement",
            lc_m=max(lc, 0.0),
            c_m=c_m,
            sigma_max_mpa=sigma,
            threshold_mpa=threshold,
            c_limit_m=c_limit,
            drift_ratio=delta_u_hw,
            ductility=ductility,
            message=(
                "c = {:.3f} m {} c_límite = {:.3f} m  "
                "[lw/(600·δu/hw) = {:.2f}/(600×{:.4f})]".format(
                    c_m, ">=" if required else "<", c_limit, lw_m, delta_u_hw
                )
            ),
        )

    # ── Método B — Esfuerzo ───────────────────────────────────────────────────
    required = sigma > threshold
    lc = _ebe_length_stress(c_m, lw_m) if required else 0.0

    return BoundaryElementResult(
        required=required,
        method="stress",
        lc_m=max(lc, 0.0),
        c_m=c_m,
        sigma_max_mpa=sigma,
        threshold_mpa=threshold,
        c_limit_m=None,
        drift_ratio=delta_u_hw,
        ductility=ductility,
        message=(
            "σ_máx = {:.2f} MPa {} {:.2f} MPa ({}·f'c)".format(
                sigma,
                ">" if required else "≤",
                threshold,
                "0.20" if ductility == "DES" else "0.15",
            )
        ),
    )
