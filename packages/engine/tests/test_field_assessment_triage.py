"""Tests end-to-end del orquestador de triaje FEMA P-2018."""

import pytest

from engine.field_assessment import (
    ComponentInput,
    DamageLevel,
    Direction,
    StoryInput,
    StructuralSystem,
)
from engine.field_assessment.fema_p2018 import (
    ExceptionalFlags,
    ShortcutInput,
    TriageDecision,
    TriageInput,
    decide,
    run_triage,
)


# --- Decision segun BR ---------------------------------------------------------


def test_decision_low_risk():
    d, _ = decide(0.10)
    assert d == TriageDecision.low_risk

    d2, _ = decide(0.30)  # limite superior inclusivo -> low_risk
    assert d2 == TriageDecision.low_risk


def test_decision_asce41_candidate():
    d, _ = decide(0.50)
    assert d == TriageDecision.asce41_candidate

    d2, _ = decide(0.69)
    assert d2 == TriageDecision.asce41_candidate


def test_decision_high_risk():
    d, _ = decide(0.70)  # limite inclusivo
    assert d == TriageDecision.high_risk

    d2, _ = decide(0.90)
    assert d2 == TriageDecision.high_risk


# --- Aplicabilidad ------------------------------------------------------------


def test_typology_not_covered_returns_not_applicable():
    r = run_triage(TriageInput(structural_system=StructuralSystem.urm))
    assert r.decision == TriageDecision.not_applicable
    assert r.building_rating == 0.0
    assert r.applicability_ok is False
    assert "no cubierto" in r.decision_reason


# --- Senales excepcionales -----------------------------------------------------


def test_exceptional_flag_forces_high_risk():
    r = run_triage(
        TriageInput(
            structural_system=StructuralSystem.rc_frame,
            exceptional=ExceptionalFlags(extreme_torsion=True),
        )
    )
    assert r.exceptional_active is True
    assert "extreme_torsion" in r.exceptional_flags
    assert r.building_rating >= 0.7
    assert r.decision == TriageDecision.high_risk


def test_geotech_hazard_forces_high_risk():
    r = run_triage(
        TriageInput(
            structural_system=StructuralSystem.rc_dual,
            exceptional=ExceptionalFlags(geotech_hazard=True),
        )
    )
    assert r.decision == TriageDecision.high_risk
    assert "geotech_hazard" in r.exceptional_flags


def test_pounding_forces_high_risk():
    r = run_triage(
        TriageInput(
            structural_system=StructuralSystem.rc_frame,
            exceptional=ExceptionalFlags(
                separation_mm=50.0, shorter_building_height_m=8.0,
            ),
        )
    )
    assert r.decision == TriageDecision.high_risk


# --- Atajos --------------------------------------------------------------------


def test_wsi_shortcut_returns_low_risk():
    r = run_triage(
        TriageInput(
            structural_system=StructuralSystem.rc_wall,
            shortcut=ShortcutInput(
                area_walls_x_m2=3.0,
                area_walls_y_m2=3.0,
                seismic_weight_kN=50.0,
            ),
        )
    )
    assert r.shortcut is not None
    assert r.shortcut.applied == "wsi"
    assert r.building_rating == 0.0
    assert r.decision == TriageDecision.low_risk


def test_shortcut_blocked_by_discontinuous_walls():
    """Si hay muros discontinuos NO se permite atajo -> igual se dispara excepcional."""
    r = run_triage(
        TriageInput(
            structural_system=StructuralSystem.rc_wall,
            exceptional=ExceptionalFlags(discontinuous_walls=True),
            shortcut=ShortcutInput(
                area_walls_x_m2=100.0,
                area_walls_y_m2=100.0,
                seismic_weight_kN=1.0,
            ),
        )
    )
    # discontinuos_walls dispara excepcional PRIMERO -> high_risk
    assert r.decision == TriageDecision.high_risk


def test_shortcut_blocked_by_torsion_when_no_other_flag():
    """Si SOLO hay torsion extrema (que ya es excepcional), va a high_risk."""
    r = run_triage(
        TriageInput(
            structural_system=StructuralSystem.rc_wall,
            exceptional=ExceptionalFlags(extreme_torsion=True),
            shortcut=ShortcutInput(
                area_walls_x_m2=100.0,
                area_walls_y_m2=100.0,
                seismic_weight_kN=1.0,
            ),
        )
    )
    assert r.decision == TriageDecision.high_risk


# --- Calculo detallado por piso ------------------------------------------------


def _story_all_healthy() -> StoryInput:
    """Piso de 12 columnas y 2 muros, todos con D0 y demanda muy baja."""
    comps = [
        ComponentInput(tag=f"C{i}", kind="column", delta_D=0.10, delta_C_base=2.0)
        for i in range(12)
    ] + [
        ComponentInput(tag=f"W{i}", kind="wall", delta_D=0.05, delta_C_base=1.5)
        for i in range(2)
    ]
    return StoryInput(index=1, height_m=3.0, direction=Direction.X, components=comps)


def _story_at_capacity() -> StoryInput:
    """Un piso donde delta_D = delta_C_base -> ratio = 1.0 -> rating 0.5."""
    return StoryInput(
        index=1,
        height_m=3.0,
        direction=Direction.X,
        components=[
            ComponentInput(tag="C1", kind="column", delta_D=2.0, delta_C_base=2.0),
        ],
    )


def _story_overloaded() -> StoryInput:
    """Piso con ratio muy alto (>=3.0) -> rating 0.93."""
    return StoryInput(
        index=1,
        height_m=3.0,
        direction=Direction.X,
        components=[
            ComponentInput(tag="C1", kind="column", delta_D=6.5, delta_C_base=2.0),
        ],
    )


def test_healthy_building_is_low_risk():
    r = run_triage(
        TriageInput(
            structural_system=StructuralSystem.rc_frame,
            stories=[_story_all_healthy()],
        )
    )
    assert r.building_rating <= 0.30
    assert r.decision == TriageDecision.low_risk
    assert len(r.stories) == 1
    assert r.stories[0].CR == 0.0  # ratio 0.05, < 0.25 -> banda 0
    assert r.stories[0].WR == 0.0


def test_at_capacity_building_is_asce41_candidate():
    r = run_triage(
        TriageInput(
            structural_system=StructuralSystem.rc_frame,
            stories=[_story_at_capacity()],
        )
    )
    assert r.building_rating == pytest.approx(0.5)
    assert r.decision == TriageDecision.asce41_candidate


def test_overloaded_building_is_high_risk():
    r = run_triage(
        TriageInput(
            structural_system=StructuralSystem.rc_frame,
            stories=[_story_overloaded()],
        )
    )
    assert r.building_rating == pytest.approx(0.93)
    assert r.decision == TriageDecision.high_risk


def test_damage_reduces_capacity_and_can_flip_decision():
    """Sin dano: BR = 0.5 (candidato). Con D2: capacidad baja 20%, ratio sube,
    BR sube a rating de banda [1.4, 1.8] = 0.7 -> high_risk."""
    # delta_D=2.0, delta_C_base=2.0/0.8 = 2.5 -> ratio_no_dmg = 0.8 -> rating ~= 0.4
    # con D2: delta_C = 2.5 * 0.8 = 2.0 -> ratio = 1.0 -> rating 0.5
    # Voy a hacer un caso mas fuerte: delta_D=1.5, delta_C_base=1.0
    # sin dano: ratio 1.5 -> banda 1.4-1.8 -> rating 0.7 -> high_risk YA
    # con D3: delta_C = 0.6 -> ratio 2.5 -> banda 1.8-2.5 -> rating 0.8

    # Empiezo con caso "sin dano = candidato": ratio = 1.0
    healthy = TriageInput(
        structural_system=StructuralSystem.rc_frame,
        stories=[
            StoryInput(
                index=1, height_m=3.0, direction=Direction.X,
                components=[ComponentInput(tag="C1", kind="column",
                                           delta_D=1.0, delta_C_base=1.0)],
            )
        ],
    )
    r_healthy = run_triage(healthy)
    assert r_healthy.building_rating == pytest.approx(0.5)
    assert r_healthy.decision == TriageDecision.asce41_candidate

    # Con dano D3: capacidad baja 40% -> ratio 1.67 -> banda [1.4,1.8] -> rating 0.7
    damaged = TriageInput(
        structural_system=StructuralSystem.rc_frame,
        stories=[
            StoryInput(
                index=1, height_m=3.0, direction=Direction.X,
                components=[ComponentInput(tag="C1", kind="column",
                                           delta_D=1.0, delta_C_base=1.0,
                                           damage=DamageLevel.D3)],
            )
        ],
    )
    r_damaged = run_triage(damaged)
    assert r_damaged.building_rating == pytest.approx(0.7)
    assert r_damaged.decision == TriageDecision.high_risk


def test_d5_collapsed_component_yields_max_rating():
    """Un componente D5 (colapso) fuerza rating 0.93 para ese componente."""
    r = run_triage(
        TriageInput(
            structural_system=StructuralSystem.rc_frame,
            stories=[
                StoryInput(
                    index=1, height_m=3.0, direction=Direction.X,
                    components=[
                        ComponentInput(tag="C1", kind="column",
                                       delta_D=0.5, delta_C_base=2.0,
                                       damage=DamageLevel.D5),
                    ],
                )
            ],
        )
    )
    assert r.building_rating == pytest.approx(0.93)
    assert r.decision == TriageDecision.high_risk


def test_building_rating_is_max_across_stories_and_directions():
    """BR = max(SR) sobre pisos y direcciones."""
    good_x = StoryInput(
        index=1, height_m=3.0, direction=Direction.X,
        components=[ComponentInput(tag="C1", kind="column",
                                   delta_D=0.1, delta_C_base=2.0)],
    )
    bad_y = StoryInput(
        index=1, height_m=3.0, direction=Direction.Y,
        components=[ComponentInput(tag="C1", kind="column",
                                   delta_D=1.5, delta_C_base=1.0)],  # ratio 1.5 -> 0.7
    )
    r = run_triage(
        TriageInput(
            structural_system=StructuralSystem.rc_frame,
            stories=[good_x, bad_y],
        )
    )
    assert r.building_rating == pytest.approx(0.7)
    assert r.decision == TriageDecision.high_risk


def test_stories_json_serializable():
    """El resultado con StoryRating[] debe ser convertible a JSON facil desde el router."""
    r = run_triage(
        TriageInput(
            structural_system=StructuralSystem.rc_frame,
            stories=[_story_at_capacity()],
        )
    )
    # Los ComponentRating y StoryRating son dataclasses -> asdict funciona
    from dataclasses import asdict
    payload = [asdict(s) for s in r.stories]
    assert isinstance(payload, list)
    assert payload[0]["components"][0]["ratio"] == pytest.approx(1.0)
