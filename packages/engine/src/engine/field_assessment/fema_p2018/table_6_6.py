"""Tabla 6-6 (condensada) del protocolo FEMA P-2018.

La tabla mapea la relacion demanda/capacidad de deriva a un rating [0,1]
mediante bandas. `interp_rating` interpola linealmente el centro de cada
banda; en los huecos entre bandas conecta linealmente los centros consecutivos.
Fuera del rango (<0.25 o >3.0) se usan los extremos (0.0 y 0.93).

Este modulo esta pensado para ser reemplazable: `DEFAULT_TABLE_6_6` es solo
la semilla; el usuario puede construir su propia lista de Band con los datos
completos de FEMA P-2018 si lo desea.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

import numpy as np


@dataclass(frozen=True)
class Band:
    """Banda [ratio_low, ratio_high] -> rating (CR o WR)."""

    ratio_low: float
    ratio_high: float
    rating: float

    @property
    def center(self) -> float:
        return 0.5 * (self.ratio_low + self.ratio_high)


DEFAULT_TABLE_6_6: tuple[Band, ...] = (
    Band(0.00, 0.25, 0.00),
    Band(0.50, 0.70, 0.30),
    Band(0.90, 1.10, 0.50),
    Band(1.40, 1.80, 0.70),
    Band(1.80, 2.50, 0.80),
    Band(3.00, 10.0, 0.93),
)


def interp_rating(ratio: float, bands: Sequence[Band] = DEFAULT_TABLE_6_6) -> float:
    """Rating [0,1] a partir de la razon delta_D / delta_C.

    Reglas:
      * Si `ratio` cae dentro de una banda, el rating es constante = banda.rating.
      * Si `ratio` cae entre dos bandas, interpola linealmente entre los
        centros de las bandas adyacentes.
      * Fuera del rango, usa los extremos (banda mas baja / mas alta).

    Se asume que `bands` esta ordenada por ratio_low.
    """
    if not bands:
        raise ValueError("La lista de bandas no puede estar vacia.")

    sorted_bands = sorted(bands, key=lambda b: b.ratio_low)

    if ratio <= sorted_bands[0].ratio_low:
        return sorted_bands[0].rating
    if ratio >= sorted_bands[-1].ratio_high:
        return sorted_bands[-1].rating

    # Buscar la banda que lo contiene.
    for b in sorted_bands:
        if b.ratio_low <= ratio <= b.ratio_high:
            return b.rating

    # Cae en un hueco entre dos bandas: interpolar entre centros.
    for i in range(len(sorted_bands) - 1):
        left, right = sorted_bands[i], sorted_bands[i + 1]
        if left.ratio_high < ratio < right.ratio_low:
            xp = [left.center, right.center]
            fp = [left.rating, right.rating]
            return float(np.interp(ratio, xp, fp))

    # No deberia llegar aqui, pero por seguridad.
    return sorted_bands[-1].rating
