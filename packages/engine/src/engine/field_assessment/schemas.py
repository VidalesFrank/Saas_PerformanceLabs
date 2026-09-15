"""Dataclasses puros del modulo Fase 0.

Los enums usan `str` como base para poder viajar como strings en JSON sin
serializadores custom. Los dataclasses no importan nada de web/DB.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


# ---------------------------------------------------------------------------
# Enumeraciones basicas
# ---------------------------------------------------------------------------


class StructuralSystem(str, Enum):
    """Sistema estructural principal. Los primeros cuatro son los cubiertos
    por el triaje FEMA P-2018 v1; el resto queda como 'no cubierto'."""

    rc_frame = "rc_frame"                # portico de concreto
    rc_wall = "rc_wall"                  # muros de carga de concreto
    rc_dual = "rc_dual"                  # dual portico-muro
    rc_infill = "rc_infill"              # portico con relleno de mamposteria
    masonry_confined = "masonry_confined"
    urm = "urm"                          # mamposteria no reforzada
    steel = "steel"
    wood = "wood"
    tilt_up = "tilt_up"
    lift_slab = "lift_slab"
    other = "other"


class Occupancy(str, Enum):
    I = "I"
    II = "II"
    III = "III"
    IV = "IV"


class DamageLevel(str, Enum):
    """Escala EMS-98 / HAZUS de dano por componente."""

    D0 = "D0"  # sin dano
    D1 = "D1"  # ligero (grietas capilares)
    D2 = "D2"  # moderado (grietas hasta 3 mm)
    D3 = "D3"  # severo (grietas > 3 mm, refuerzo expuesto)
    D4 = "D4"  # muy severo (falla parcial)
    D5 = "D5"  # colapso


class HazardResponse(str, Enum):
    yes = "yes"
    no = "no"
    na = "na"


class HazardSeverity(str, Enum):
    light = "light"
    moderate = "moderate"
    severe = "severe"


class Direction(str, Enum):
    X = "X"
    Y = "Y"


class Access(str, Enum):
    ok = "ok"
    obstructed = "obstructed"
    damaged = "damaged"
    collapsed = "collapsed"


# ---------------------------------------------------------------------------
# Sub-flujo A: entradas del engine para el placard ATC-20
# ---------------------------------------------------------------------------


# Codigos de los 14 peligros visibles - referenciados desde el frontend.
HAZARD_CODES = (
    "collapse",              # 1  colapso total o parcial
    "tilt",                  # 2  inclinacion global o de piso
    "column_wall_failure",   # 3  falla en columnas/muros portantes
    "beam_failure",          # 4  falla en vigas o conexiones
    "foundation_failure",    # 5  falla en cimentacion
    "residual_drift",        # 6  deriva residual visible (no en checklist, va aparte)
    "falling_finishes",      # 7  caida de acabados/cielorrasos
    "external_falling",      # 8  caida de elementos externos
    "adjacent_damage",       # 9  edificio contiguo danado
    "utility_leak",          # 10 escape de gas/agua/electricidad
    "blocked_access",        # 11 bloqueo de accesos/salidas de emergencia
    "geotech_active",        # 12 amenaza geotecnica activada
    "victims_trapped",       # 13 personas atrapadas o victimas visibles
    "other",                 # 14 otros peligros
)


@dataclass
class HazardCheck:
    """Una fila del checklist de peligros visibles."""

    code: str
    response: HazardResponse
    severity: HazardSeverity | None = None
    note: str = ""


@dataclass
class HazardsInput:
    checks: list[HazardCheck] = field(default_factory=list)

    def get(self, code: str) -> HazardCheck | None:
        for c in self.checks:
            if c.code == code:
                return c
        return None


# Componentes evaluables en la matriz de dano.
COMPONENT_CODES = (
    "columns",
    "beams",
    "shear_walls",
    "partition_walls",
    "slab",
    "foundation",
    "stairs",
    "roof",
)


@dataclass
class ComponentDamage:
    """Dano observado en un componente estructural o no estructural."""

    component: str            # codigo de COMPONENT_CODES
    level: DamageLevel
    pct_affected: float = 0.0  # porcentaje de elementos afectados (0-100)


@dataclass
class AccessCondition:
    main_door: Access = Access.ok
    emergency_exits: Access = Access.ok
    stairs: Access = Access.ok
    elevator_out_of_service: bool = False


@dataclass
class SafetyInput:
    """Entrada completa del sub-flujo A."""

    hazards: HazardsInput
    component_damage: list[ComponentDamage]
    access: AccessCondition
    residual_drift_pct: float | None = None
    manual_override: str | None = None  # "yellow" o "red" para escalar manualmente
    manual_override_reason: str = ""


# ---------------------------------------------------------------------------
# Sub-flujo B: entradas del engine para el triaje FEMA P-2018
# ---------------------------------------------------------------------------


@dataclass
class ComponentInput:
    """Componente de un piso (columna o muro) para el calculo CR/WR."""

    tag: str
    kind: str                  # "column" | "wall"
    delta_D: float             # demanda de deriva (%)
    delta_C_base: float        # capacidad de deriva base (%)
    damage: DamageLevel = DamageLevel.D0


@dataclass
class StoryInput:
    """Piso (indice desde 1 en la base) en una direccion dada."""

    index: int
    height_m: float
    direction: Direction
    components: list[ComponentInput]

    @property
    def Nc(self) -> int:
        return sum(1 for c in self.components if c.kind == "column")

    @property
    def Nw(self) -> int:
        return sum(1 for c in self.components if c.kind == "wall")
