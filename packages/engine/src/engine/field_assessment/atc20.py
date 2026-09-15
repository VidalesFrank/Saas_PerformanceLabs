"""Sub-flujo A: placard ATC-20 / AIS-IDIGER.

Determina la ocupabilidad del edificio en 3 niveles:

  * INSPECCIONADO (verde)   -> ocupable
  * USO RESTRINGIDO (amarillo) -> acceso limitado
  * INSEGURO (rojo)         -> no ocupar

Reglas iniciales - calibradas contra el enunciado, pendientes de ajustar
contra la ficha AIS-IDIGER oficial de Bogota. La logica es un cascada de
disparadores: cualquier condicion de un nivel superior domina.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from .schemas import (
    Access,
    AccessCondition,
    ComponentDamage,
    DamageLevel,
    HazardResponse,
    HazardSeverity,
    HazardsInput,
    SafetyInput,
)


class Placard(str, Enum):
    green = "green"       # INSPECCIONADO
    yellow = "yellow"     # USO RESTRINGIDO
    red = "red"           # INSEGURO


@dataclass
class PlacardResult:
    placard: Placard
    reasons: list[str]
    restrictions: list[str]


# Peligros que disparan rojo si estan marcados "yes".
_RED_HAZARDS = {
    "collapse":            "Colapso total o parcial reportado.",
    "geotech_active":      "Amenaza geotecnica activa (deslizamiento / hundimiento / licuacion).",
    "utility_leak":        "Escape peligroso de gas / agua / electricidad.",
    "victims_trapped":     "Presencia de victimas o personas atrapadas.",
}

# Peligros con severidad 'severe' que disparan rojo, moderada que dispara amarillo.
_HAZARDS_BY_SEVERITY = {
    "tilt":                "Inclinacion global o de piso",
    "column_wall_failure": "Falla en columnas o muros portantes",
    "foundation_failure":  "Falla en cimentacion",
    "beam_failure":        "Falla en vigas o conexiones",
}

# Peligros con severidad 'severe' amarillo, moderada amarillo, ligera nada.
_HAZARDS_YELLOW = {
    "falling_finishes":  "Caida de acabados o cielorrasos",
    "external_falling":  "Caida potencial de elementos externos",
    "adjacent_damage":   "Edificio contiguo danado (riesgo de pounding)",
    "blocked_access":    "Bloqueo de accesos o salidas de emergencia",
}


def _damage_map(damages: list[ComponentDamage]) -> dict[str, DamageLevel]:
    """Reduce la lista de danos a un mapa componente -> peor nivel observado."""
    order = {d: i for i, d in enumerate(DamageLevel)}
    result: dict[str, DamageLevel] = {}
    for cd in damages:
        prev = result.get(cd.component)
        if prev is None or order[cd.level] > order[prev]:
            result[cd.component] = cd.level
    return result


def _worst_of(placards: list[Placard]) -> Placard:
    """Rojo domina, luego amarillo, luego verde."""
    if Placard.red in placards:
        return Placard.red
    if Placard.yellow in placards:
        return Placard.yellow
    return Placard.green


def evaluate_placard(inp: SafetyInput) -> PlacardResult:
    """Aplica el arbol de reglas y devuelve placard + trazabilidad."""

    reasons: list[str] = []
    restrictions: list[str] = []
    triggered: list[Placard] = [Placard.green]

    hazards = inp.hazards
    damage_map = _damage_map(inp.component_damage)

    # --- 1) Peligros que fuerzan rojo -------------------------------------
    for code, msg in _RED_HAZARDS.items():
        h = hazards.get(code)
        if h and h.response == HazardResponse.yes:
            triggered.append(Placard.red)
            reasons.append(msg)

    # --- 2) Peligros con escala de severidad ------------------------------
    for code, label in _HAZARDS_BY_SEVERITY.items():
        h = hazards.get(code)
        if not h or h.response != HazardResponse.yes:
            continue
        sev = h.severity or HazardSeverity.moderate
        if sev == HazardSeverity.severe:
            triggered.append(Placard.red)
            reasons.append(f"{label}: severidad severa.")
        elif sev == HazardSeverity.moderate:
            triggered.append(Placard.yellow)
            reasons.append(f"{label}: severidad moderada.")
        else:  # ligera
            triggered.append(Placard.yellow)
            reasons.append(f"{label}: severidad ligera.")

    # --- 3) Peligros que a lo sumo suben a amarillo -----------------------
    for code, label in _HAZARDS_YELLOW.items():
        h = hazards.get(code)
        if h and h.response == HazardResponse.yes:
            triggered.append(Placard.yellow)
            reasons.append(f"{label}.")

    # --- 4) Dano estructural por componente -------------------------------
    for comp in ("columns", "shear_walls"):
        lvl = damage_map.get(comp)
        if lvl in (DamageLevel.D4, DamageLevel.D5):
            triggered.append(Placard.red)
            reasons.append(f"Dano {lvl.value} en {comp}.")
        elif lvl == DamageLevel.D3:
            triggered.append(Placard.yellow)
            reasons.append(f"Dano {lvl.value} en {comp}.")

    # Componentes no primarios: solo D4/D5 disparan rojo por perdida de soporte
    for comp in ("beams", "foundation", "slab"):
        lvl = damage_map.get(comp)
        if lvl in (DamageLevel.D4, DamageLevel.D5):
            triggered.append(Placard.red)
            reasons.append(f"Dano {lvl.value} en {comp}.")
        elif lvl == DamageLevel.D3:
            triggered.append(Placard.yellow)
            reasons.append(f"Dano {lvl.value} en {comp}.")

    # Escaleras y tabiqueria: rojo solo si colapso; severo -> amarillo
    for comp in ("stairs", "partition_walls", "roof"):
        lvl = damage_map.get(comp)
        if lvl == DamageLevel.D5:
            triggered.append(Placard.red)
            reasons.append(f"Colapso ({lvl.value}) en {comp}.")
        elif lvl in (DamageLevel.D3, DamageLevel.D4):
            triggered.append(Placard.yellow)
            reasons.append(f"Dano {lvl.value} en {comp}.")

    # --- 5) Deriva residual --------------------------------------------------
    d = inp.residual_drift_pct
    if d is not None:
        if d > 3.0:
            triggered.append(Placard.red)
            reasons.append(f"Deriva residual {d:.2f} % > 3 %.")
        elif d >= 1.0:
            triggered.append(Placard.yellow)
            reasons.append(f"Deriva residual {d:.2f} % en rango 1-3 %.")

    # --- 6) Accesos y no estructurales ---------------------------------------
    acc = inp.access
    if acc.emergency_exits == Access.collapsed:
        triggered.append(Placard.red)
        reasons.append("Salidas de emergencia colapsadas.")
    elif acc.emergency_exits == Access.damaged:
        triggered.append(Placard.yellow)
        reasons.append("Salidas de emergencia danadas.")
    if acc.stairs == Access.collapsed:
        triggered.append(Placard.red)
        reasons.append("Escaleras colapsadas.")
    elif acc.stairs == Access.damaged:
        triggered.append(Placard.yellow)
        reasons.append("Escaleras danadas.")
    if acc.main_door in (Access.obstructed, Access.damaged):
        triggered.append(Placard.yellow)
        reasons.append("Puerta principal con restriccion.")

    # --- 7) Override manual: solo puede escalar, nunca bajar ---------------
    if inp.manual_override:
        manual = Placard(inp.manual_override)
        promoted = _worst_of([_worst_of(triggered), manual])
        if promoted != _worst_of(triggered):
            reasons.append(
                f"Override manual del inspector: {manual.value} "
                f"({inp.manual_override_reason or 'sin justificacion'})."
            )
            triggered.append(manual)

    placard = _worst_of(triggered)

    # --- 8) Restricciones sugeridas segun el placard -----------------------
    if placard == Placard.red:
        restrictions = [
            "No ingresar al edificio.",
            "Requiere inspeccion detallada (ATC-20 Detailed) antes de cualquier uso.",
            "Coordinar apuntalamiento o demolicion parcial segun corresponda.",
        ]
    elif placard == Placard.yellow:
        restrictions = [
            "Acceso restringido: solo personal autorizado con proteccion.",
            "No permitir ocupacion continua.",
            "Programar inspeccion detallada y reparaciones prioritarias.",
        ]
    else:
        restrictions = [
            "Uso normal permitido.",
            "Documentar hallazgos menores para mantenimiento rutinario.",
        ]

    return PlacardResult(placard=placard, reasons=reasons, restrictions=restrictions)
