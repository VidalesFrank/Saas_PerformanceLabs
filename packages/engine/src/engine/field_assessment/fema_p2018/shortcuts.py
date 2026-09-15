"""Atajos de riesgo bajo FEMA P-2018 - sin necesidad de calculo detallado.

Dos atajos:

  * Wall Strength Index (WSI): sistemas muro/dual regulares.
    WSI = (area_muros / peso_sismico) * factor, comparado contra umbral.
    Implementacion inicial: WSI = area_muros_min_dir [m^2] * 1000 / peso [kN].
    Si supera `wsi_threshold` (por defecto 30 m^2*g/kN), califica como bajo.
    El umbral es configurable y debe calibrarse contra Tabla 3-2 de FEMA P-2018.

  * Elastico global: si el usuario aporta una relacion global
    delta_D_global / delta_C_global menor a `elastic_threshold`
    (por defecto 0.5), el edificio se considera esencialmente elastico.

Ambos atajos requieren que NO existan las senales de irregularidad torsional
extrema (#5) ni muros discontinuos (#3) - el orquestador de triaje se
encarga de esa verificacion antes de invocarlos.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class ShortcutInput:
    """Datos para evaluar los dos atajos."""

    # WSI
    area_walls_x_m2: float | None = None
    area_walls_y_m2: float | None = None
    seismic_weight_kN: float | None = None
    wsi_threshold: float = 30.0
    # Elastico global
    global_ratio_D_over_C: float | None = None
    elastic_threshold: float = 0.5


@dataclass
class ShortcutResult:
    """Resultado de aplicar los atajos."""

    applied: str | None       # "wsi" | "elastic_global" | None
    is_low_risk: bool
    wsi_value: float | None
    global_ratio: float | None
    note: str


def _wsi(inp: ShortcutInput) -> float | None:
    ax = inp.area_walls_x_m2
    ay = inp.area_walls_y_m2
    w = inp.seismic_weight_kN
    if ax is None or ay is None or w is None or w <= 0:
        return None
    area_min = min(ax, ay)
    return area_min * 1000.0 / w


def apply_shortcuts(inp: ShortcutInput) -> ShortcutResult:
    """Evalua ambos atajos y retorna el primero que califique como bajo."""

    wsi = _wsi(inp)
    if wsi is not None and wsi >= inp.wsi_threshold:
        return ShortcutResult(
            applied="wsi",
            is_low_risk=True,
            wsi_value=wsi,
            global_ratio=inp.global_ratio_D_over_C,
            note=(
                f"Wall Strength Index = {wsi:.2f} >= umbral "
                f"{inp.wsi_threshold:.2f}. Sistema muro/dual con capacidad sobrada."
            ),
        )

    r = inp.global_ratio_D_over_C
    if r is not None and r < inp.elastic_threshold:
        return ShortcutResult(
            applied="elastic_global",
            is_low_risk=True,
            wsi_value=wsi,
            global_ratio=r,
            note=(
                f"delta_D_global/delta_C_global = {r:.2f} < {inp.elastic_threshold:.2f}. "
                "Edificio esencialmente elastico."
            ),
        )

    return ShortcutResult(
        applied=None,
        is_low_risk=False,
        wsi_value=wsi,
        global_ratio=r,
        note="Ningun atajo aplica; proceder con calculo detallado por piso.",
    )
