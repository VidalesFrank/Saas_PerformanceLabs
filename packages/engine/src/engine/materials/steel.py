"""Modelo de acero de refuerzo -> parametros para OpenSeesPy Steel02 (Menegotto-Pinto).

Unidades: N, mm, MPa.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SteelMaterialParams:
    """Parametros listos para `uniaxialMaterial('Steel02', tag, Fy, E0, b, R0, cR1, cR2)`."""

    fy: float          # esfuerzo de fluencia (MPa)
    E0: float           # modulo de elasticidad (MPa)
    b: float             # relacion de endurecimiento por deformacion (strain-hardening ratio)
    R0: float = 18.0      # parametros de transicion elastico-plastico de Menegotto-Pinto
    cR1: float = 0.925
    cR2: float = 0.15
    eps_rupture: float = 0.09  # deformacion unitaria de rotura, usada como limite de falla


def reinforcing_steel(
    fy: float = 420.0,
    E0: float = 200_000.0,
    b: float = 0.01,
    eps_rupture: float = 0.09,
) -> SteelMaterialParams:
    """Acero de refuerzo tipico (grado 60 / 420 MPa por defecto)."""
    return SteelMaterialParams(fy=fy, E0=E0, b=b, eps_rupture=eps_rupture)
