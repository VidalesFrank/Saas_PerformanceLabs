"""Tests del placard ATC-20 / AIS-IDIGER (sub-flujo A)."""

import pytest

from engine.field_assessment import (
    AccessCondition,
    ComponentDamage,
    DamageLevel,
    HazardCheck,
    HazardResponse,
    HazardSeverity,
    HazardsInput,
    SafetyInput,
)
from engine.field_assessment.atc20 import Placard, evaluate_placard
from engine.field_assessment.schemas import Access


def _empty_hazards() -> HazardsInput:
    return HazardsInput(checks=[])


def _no_damage() -> list[ComponentDamage]:
    return []


def _clean_access() -> AccessCondition:
    return AccessCondition()


def test_no_hazards_no_damage_returns_green():
    r = evaluate_placard(
        SafetyInput(
            hazards=_empty_hazards(),
            component_damage=_no_damage(),
            access=_clean_access(),
        )
    )
    assert r.placard == Placard.green


def test_collapse_forces_red():
    r = evaluate_placard(
        SafetyInput(
            hazards=HazardsInput(
                checks=[HazardCheck(code="collapse", response=HazardResponse.yes)]
            ),
            component_damage=_no_damage(),
            access=_clean_access(),
        )
    )
    assert r.placard == Placard.red
    assert any("colapso" in x.lower() for x in r.reasons)


def test_geotech_active_forces_red():
    r = evaluate_placard(
        SafetyInput(
            hazards=HazardsInput(
                checks=[HazardCheck(code="geotech_active", response=HazardResponse.yes)]
            ),
            component_damage=_no_damage(),
            access=_clean_access(),
        )
    )
    assert r.placard == Placard.red


def test_column_wall_failure_severe_is_red():
    r = evaluate_placard(
        SafetyInput(
            hazards=HazardsInput(
                checks=[
                    HazardCheck(
                        code="column_wall_failure",
                        response=HazardResponse.yes,
                        severity=HazardSeverity.severe,
                    )
                ]
            ),
            component_damage=_no_damage(),
            access=_clean_access(),
        )
    )
    assert r.placard == Placard.red


def test_column_wall_failure_moderate_is_yellow():
    r = evaluate_placard(
        SafetyInput(
            hazards=HazardsInput(
                checks=[
                    HazardCheck(
                        code="column_wall_failure",
                        response=HazardResponse.yes,
                        severity=HazardSeverity.moderate,
                    )
                ]
            ),
            component_damage=_no_damage(),
            access=_clean_access(),
        )
    )
    assert r.placard == Placard.yellow


def test_falling_finishes_is_yellow_only():
    r = evaluate_placard(
        SafetyInput(
            hazards=HazardsInput(
                checks=[HazardCheck(code="falling_finishes", response=HazardResponse.yes)]
            ),
            component_damage=_no_damage(),
            access=_clean_access(),
        )
    )
    assert r.placard == Placard.yellow


def test_d4_columns_is_red():
    r = evaluate_placard(
        SafetyInput(
            hazards=_empty_hazards(),
            component_damage=[ComponentDamage(component="columns", level=DamageLevel.D4)],
            access=_clean_access(),
        )
    )
    assert r.placard == Placard.red


def test_d3_columns_is_yellow():
    r = evaluate_placard(
        SafetyInput(
            hazards=_empty_hazards(),
            component_damage=[ComponentDamage(component="columns", level=DamageLevel.D3)],
            access=_clean_access(),
        )
    )
    assert r.placard == Placard.yellow


def test_d5_shear_walls_is_red():
    r = evaluate_placard(
        SafetyInput(
            hazards=_empty_hazards(),
            component_damage=[ComponentDamage(component="shear_walls", level=DamageLevel.D5)],
            access=_clean_access(),
        )
    )
    assert r.placard == Placard.red


def test_d3_partition_walls_is_yellow_not_red():
    """Tabiqueria D3 = amarillo (no es estructural primario)."""
    r = evaluate_placard(
        SafetyInput(
            hazards=_empty_hazards(),
            component_damage=[
                ComponentDamage(component="partition_walls", level=DamageLevel.D3)
            ],
            access=_clean_access(),
        )
    )
    assert r.placard == Placard.yellow


def test_residual_drift_over_3pct_is_red():
    r = evaluate_placard(
        SafetyInput(
            hazards=_empty_hazards(),
            component_damage=_no_damage(),
            access=_clean_access(),
            residual_drift_pct=3.5,
        )
    )
    assert r.placard == Placard.red


def test_residual_drift_between_1_and_3pct_is_yellow():
    r = evaluate_placard(
        SafetyInput(
            hazards=_empty_hazards(),
            component_damage=_no_damage(),
            access=_clean_access(),
            residual_drift_pct=1.8,
        )
    )
    assert r.placard == Placard.yellow


def test_residual_drift_below_1pct_stays_green():
    r = evaluate_placard(
        SafetyInput(
            hazards=_empty_hazards(),
            component_damage=_no_damage(),
            access=_clean_access(),
            residual_drift_pct=0.4,
        )
    )
    assert r.placard == Placard.green


def test_emergency_exits_collapsed_is_red():
    r = evaluate_placard(
        SafetyInput(
            hazards=_empty_hazards(),
            component_damage=_no_damage(),
            access=AccessCondition(emergency_exits=Access.collapsed),
        )
    )
    assert r.placard == Placard.red


def test_stairs_damaged_is_yellow():
    r = evaluate_placard(
        SafetyInput(
            hazards=_empty_hazards(),
            component_damage=_no_damage(),
            access=AccessCondition(stairs=Access.damaged),
        )
    )
    assert r.placard == Placard.yellow


def test_manual_override_can_escalate_only():
    """El override sube (verde -> amarillo/rojo) pero nunca baja."""
    # Sin danos, green base
    base = SafetyInput(
        hazards=_empty_hazards(),
        component_damage=_no_damage(),
        access=_clean_access(),
    )
    r_up = evaluate_placard(
        SafetyInput(**{**base.__dict__, "manual_override": "red", "manual_override_reason": "riesgo tanque agua"})
    )
    assert r_up.placard == Placard.red

    # Con dano D4 (rojo base), override "yellow" no lo baja
    with_d4 = SafetyInput(
        hazards=_empty_hazards(),
        component_damage=[ComponentDamage(component="columns", level=DamageLevel.D4)],
        access=_clean_access(),
        manual_override="yellow",
    )
    r_down = evaluate_placard(with_d4)
    assert r_down.placard == Placard.red   # sigue rojo, override no bajo


def test_restrictions_populated_for_red():
    r = evaluate_placard(
        SafetyInput(
            hazards=HazardsInput(
                checks=[HazardCheck(code="collapse", response=HazardResponse.yes)]
            ),
            component_damage=_no_damage(),
            access=_clean_access(),
        )
    )
    assert r.restrictions
    assert any("No ingresar" in x for x in r.restrictions)


def test_worst_of_hazards_dominates():
    """Mezcla de amarillos y un rojo: gana el rojo."""
    r = evaluate_placard(
        SafetyInput(
            hazards=HazardsInput(
                checks=[
                    HazardCheck(code="falling_finishes", response=HazardResponse.yes),
                    HazardCheck(code="external_falling", response=HazardResponse.yes),
                    HazardCheck(code="collapse", response=HazardResponse.yes),
                ]
            ),
            component_damage=_no_damage(),
            access=_clean_access(),
        )
    )
    assert r.placard == Placard.red
