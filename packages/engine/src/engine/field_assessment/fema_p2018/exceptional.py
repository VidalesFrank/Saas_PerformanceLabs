"""Senales de 'riesgo excepcionalmente alto' - FEMA P-2018.

Dos verificaciones independientes:

  1. `check_typology_covered`: el triaje v1 solo aplica a concreto reforzado
     (portico, muro, dual, con relleno mamposteria). Otros sistemas retornan
     `covered=False` con motivo, y el triaje se bloquea (no calcula BR).

  2. `check_exceptional`: seis banderas + amenaza geotecnica. Si cualquiera
     esta activa, el BR se fuerza a "riesgo excepcionalmente alto" sin
     calcular por piso.

La verificacion #6 (pounding) es calculada aqui: si la separacion entre
edificios es menor al 1.5 % de la altura del edificio mas bajo.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..schemas import StructuralSystem


# Sistemas cubiertos por el triaje FEMA P-2018 v1.
_COVERED_SYSTEMS: frozenset[StructuralSystem] = frozenset(
    {
        StructuralSystem.rc_frame,
        StructuralSystem.rc_wall,
        StructuralSystem.rc_dual,
        StructuralSystem.rc_infill,
    }
)


@dataclass
class TypologyCheck:
    covered: bool
    reason: str


def check_typology_covered(system: StructuralSystem) -> TypologyCheck:
    """El triaje solo aplica a RC. Otros sistemas quedan fuera de alcance v1."""
    if system in _COVERED_SYSTEMS:
        return TypologyCheck(covered=True, reason="Sistema cubierto por FEMA P-2018 v1.")
    return TypologyCheck(
        covered=False,
        reason=(
            f"Sistema estructural '{system.value}' no cubierto por esta version. "
            "El triaje FEMA P-2018 v1 solo aplica a concreto reforzado "
            "(portico, muro, dual, con relleno mamposteria). Se requiere estudio aparte."
        ),
    )


@dataclass
class ExceptionalFlags:
    """Las seis senales + amenaza geotecnica del sitio."""

    no_asbuilt_docs: bool = False               # #1
    incomplete_load_path: bool = False          # #2
    discontinuous_walls: bool = False           # #3
    exceptionally_weak: bool = False            # #4
    extreme_torsion: bool = False               # #5
    # #6 - pounding: se calcula desde separacion / altura
    separation_mm: float | None = None
    shorter_building_height_m: float | None = None
    # Amenaza geotecnica del sitio (bloquea el calculo detallado)
    geotech_hazard: bool = False

    notes: dict[str, str] | None = None

    def pounding_active(self) -> bool:
        """True si la junta es menor al 1.5 % de la altura del edificio mas bajo."""
        if self.separation_mm is None or self.shorter_building_height_m is None:
            return False
        if self.shorter_building_height_m <= 0:
            return False
        # 1.5 % de la altura en mm
        min_separation_mm = 0.015 * self.shorter_building_height_m * 1000.0
        return self.separation_mm < min_separation_mm


@dataclass
class ExceptionalCheck:
    is_exceptional: bool
    active_flags: list[str]
    reasons: list[str]


def check_exceptional(flags: ExceptionalFlags) -> ExceptionalCheck:
    """Evalua las seis senales + geotecnia. Cualquiera activa fuerza BR alto."""

    active: list[str] = []
    reasons: list[str] = []

    if flags.no_asbuilt_docs:
        active.append("no_asbuilt_docs")
        reasons.append("Sin informacion as-built confiable (Senal 1).")
    if flags.incomplete_load_path:
        active.append("incomplete_load_path")
        reasons.append("Trayectoria de carga incompleta (Senal 2).")
    if flags.discontinuous_walls:
        active.append("discontinuous_walls")
        reasons.append("Muros discontinuos sobre columnas o vigas (Senal 3).")
    if flags.exceptionally_weak:
        active.append("exceptionally_weak")
        reasons.append("Edificio excepcionalmente debil (Senal 4).")
    if flags.extreme_torsion:
        active.append("extreme_torsion")
        reasons.append("Torsion extrema (Senal 5).")
    if flags.pounding_active():
        active.append("pounding")
        sep = flags.separation_mm
        h = flags.shorter_building_height_m
        reasons.append(
            f"Pounding: separacion {sep:.0f} mm < 1.5 % x altura {h:.1f} m "
            f"= {0.015 * (h or 0) * 1000:.0f} mm (Senal 6)."
        )
    if flags.geotech_hazard:
        active.append("geotech_hazard")
        reasons.append("Sitio con amenaza geotecnica activa.")

    return ExceptionalCheck(
        is_exceptional=bool(active),
        active_flags=active,
        reasons=reasons,
    )
