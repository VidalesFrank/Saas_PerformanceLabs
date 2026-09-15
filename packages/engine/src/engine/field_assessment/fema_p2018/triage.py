"""Orquestador del triaje FEMA P-2018.

Flujo:

  1. Verificar aplicabilidad (tipologia estructural cubierta).
  2. Verificar senales excepcionales + amenaza geotecnica.
     -> Si alguna activa, BR = max(rating_maximo, disparador). Salir.
  3. (Opcional) intentar atajos WSI / elastico global.
     -> Si algun atajo califica como bajo, BR = 0.0. Salir.
  4. Calcular por piso: para cada componente,
     ratio = delta_D / (delta_C_base * lambda_dano)
     rating = interp_rating(ratio, tabla_6_6)
     SR = max(rating de columnas y muros del piso)
  5. BR = max(SR) sobre todos los pisos y direcciones.
  6. Traducir BR a decision final (low_risk / asce41_candidate / high_risk).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Sequence

from ..schemas import ComponentInput, StoryInput, StructuralSystem
from .damage_adj import DEFAULT_DAMAGE_LAMBDA, damage_factor
from .exceptional import ExceptionalFlags, check_exceptional, check_typology_covered
from .shortcuts import ShortcutInput, ShortcutResult, apply_shortcuts
from .table_6_6 import Band, DEFAULT_TABLE_6_6, interp_rating


# Rating minimo que se asigna cuando disparan las senales excepcionales.
_EXCEPTIONAL_FORCED_BR = 0.93


class TriageDecision(str, Enum):
    low_risk = "low_risk"                 # BR <= 0.30
    asce41_candidate = "asce41_candidate"  # 0.30 < BR < 0.70
    high_risk = "high_risk"                # BR >= 0.70
    not_applicable = "not_applicable"      # tipologia no cubierta


@dataclass
class TriageInput:
    """Entrada completa del triaje."""

    structural_system: StructuralSystem
    exceptional: ExceptionalFlags = field(default_factory=ExceptionalFlags)
    stories: list[StoryInput] = field(default_factory=list)
    shortcut: ShortcutInput | None = None
    table_6_6: Sequence[Band] = DEFAULT_TABLE_6_6
    damage_lambda: dict | None = None  # opcional, sobreescribe DEFAULT_DAMAGE_LAMBDA


@dataclass
class ComponentRating:
    tag: str
    kind: str                # "column" | "wall"
    delta_D: float
    delta_C_base: float
    damage: str
    lambda_damage: float
    delta_C_adj: float
    ratio: float
    rating: float


@dataclass
class StoryRating:
    index: int
    direction: str
    Nc: int
    Nw: int
    components: list[ComponentRating]
    CR: float                # max rating de columnas
    WR: float                # max rating de muros
    SR: float                # max(CR, WR)


@dataclass
class TriageResult:
    building_rating: float
    decision: TriageDecision
    decision_reason: str
    applicability_ok: bool
    exceptional_active: bool
    exceptional_flags: list[str]
    shortcut: ShortcutResult | None
    stories: list[StoryRating]


def _rate_component(
    c: ComponentInput,
    table: Sequence[Band],
    damage_lambda: dict | None,
) -> ComponentRating:
    lam = damage_factor(c.damage, damage_lambda)
    delta_c_adj = c.delta_C_base * lam
    if delta_c_adj <= 0:
        # Componente colapsado (D5) o sin capacidad -> rating maximo.
        ratio = float("inf")
        rating = 0.93
    else:
        ratio = c.delta_D / delta_c_adj
        rating = interp_rating(ratio, table)
    return ComponentRating(
        tag=c.tag,
        kind=c.kind,
        delta_D=c.delta_D,
        delta_C_base=c.delta_C_base,
        damage=c.damage.value,
        lambda_damage=lam,
        delta_C_adj=delta_c_adj,
        ratio=ratio,
        rating=rating,
    )


def _rate_story(
    s: StoryInput,
    table: Sequence[Band],
    damage_lambda: dict | None,
) -> StoryRating:
    rated = [_rate_component(c, table, damage_lambda) for c in s.components]
    col_ratings = [r.rating for r in rated if r.kind == "column"]
    wall_ratings = [r.rating for r in rated if r.kind == "wall"]
    cr = max(col_ratings) if col_ratings else 0.0
    wr = max(wall_ratings) if wall_ratings else 0.0
    sr = max(cr, wr)
    return StoryRating(
        index=s.index,
        direction=s.direction.value,
        Nc=s.Nc,
        Nw=s.Nw,
        components=rated,
        CR=cr,
        WR=wr,
        SR=sr,
    )


def decide(building_rating: float) -> tuple[TriageDecision, str]:
    """Traduce BR a decision + razon legible."""
    if building_rating <= 0.30:
        return (
            TriageDecision.low_risk,
            f"BR = {building_rating:.2f} <= 0.30. Riesgo bajo: documentar y monitorear.",
        )
    if building_rating < 0.70:
        return (
            TriageDecision.asce41_candidate,
            f"BR = {building_rating:.2f} en rango (0.30, 0.70). "
            "Candidato a estudio de vulnerabilidad ASCE 41.",
        )
    return (
        TriageDecision.high_risk,
        f"BR = {building_rating:.2f} >= 0.70. Riesgo excepcionalmente alto / precolapso.",
    )


def run_triage(inp: TriageInput) -> TriageResult:
    """Ejecuta el flujo completo del triaje."""

    # 1) Aplicabilidad por tipologia
    typ = check_typology_covered(inp.structural_system)
    if not typ.covered:
        return TriageResult(
            building_rating=0.0,
            decision=TriageDecision.not_applicable,
            decision_reason=typ.reason,
            applicability_ok=False,
            exceptional_active=False,
            exceptional_flags=[],
            shortcut=None,
            stories=[],
        )

    # 2) Senales excepcionales + geotecnia
    exc = check_exceptional(inp.exceptional)
    if exc.is_exceptional:
        br = _EXCEPTIONAL_FORCED_BR
        decision, reason = decide(br)
        return TriageResult(
            building_rating=br,
            decision=decision,
            decision_reason=(
                "Senales de riesgo excepcional activas: "
                + "; ".join(exc.reasons)
                + f". BR forzado a {br:.2f}. {reason}"
            ),
            applicability_ok=True,
            exceptional_active=True,
            exceptional_flags=exc.active_flags,
            shortcut=None,
            stories=[],
        )

    # 3) Atajos (WSI / elastico), solo si no hay muros discontinuos ni torsion extrema
    shortcut_result: ShortcutResult | None = None
    if inp.shortcut is not None:
        can_use_shortcut = not (
            inp.exceptional.discontinuous_walls or inp.exceptional.extreme_torsion
        )
        if can_use_shortcut:
            shortcut_result = apply_shortcuts(inp.shortcut)
            if shortcut_result.is_low_risk:
                br = 0.0
                decision, reason = decide(br)
                return TriageResult(
                    building_rating=br,
                    decision=decision,
                    decision_reason=f"{shortcut_result.note} {reason}",
                    applicability_ok=True,
                    exceptional_active=False,
                    exceptional_flags=[],
                    shortcut=shortcut_result,
                    stories=[],
                )

    # 4) Calculo detallado por piso
    story_ratings = [
        _rate_story(s, inp.table_6_6, inp.damage_lambda) for s in inp.stories
    ]

    # 5) BR = max SR
    if story_ratings:
        br = max(sr.SR for sr in story_ratings)
    else:
        br = 0.0

    decision, reason = decide(br)
    return TriageResult(
        building_rating=br,
        decision=decision,
        decision_reason=reason,
        applicability_ok=True,
        exceptional_active=False,
        exceptional_flags=[],
        shortcut=shortcut_result,
        stories=story_ratings,
    )
