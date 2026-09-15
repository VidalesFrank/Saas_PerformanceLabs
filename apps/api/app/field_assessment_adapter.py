"""Adaptador entre el contrato HTTP y el motor `engine.field_assessment`.

Convierte los payloads JSON planos que llegan del router a los dataclasses
del engine, ejecuta el cálculo (placard ATC-20 o triaje FEMA P-2018) y
serializa el resultado para persistir en la BD y responder al cliente.

Es el único punto que conoce ambos lados (HTTP + engine).
"""
from __future__ import annotations

from dataclasses import asdict
from typing import Any

from engine.field_assessment import (
    AccessCondition,
    ComponentDamage,
    ComponentInput,
    DamageLevel,
    Direction,
    HazardCheck,
    HazardResponse,
    HazardSeverity,
    HazardsInput,
    SafetyInput,
    StoryInput,
    StructuralSystem,
    evaluate_placard,
)
from engine.field_assessment.atc20 import Placard, PlacardResult
from engine.field_assessment.fema_p2018 import (
    ExceptionalFlags,
    ShortcutInput,
    TriageInput,
    TriageResult as EngineTriageResult,
    run_triage,
)
from engine.field_assessment.fema_p2018.table_6_6 import Band, DEFAULT_TABLE_6_6
from engine.field_assessment.schemas import Access


# ---------------------------------------------------------------------------
# Sub-flujo A: ATC-20 placard
# ---------------------------------------------------------------------------


def build_atc20_placard(
    hazards_json: dict | None,
    component_damage_json: dict | None,
    access_condition_json: dict | None,
    residual_drift_pct: float | None,
    manual_override: str | None = None,
    manual_override_reason: str = "",
) -> tuple[Placard, list[str], list[str]]:
    """Ejecuta el engine ATC-20 y retorna (placard, razones, restricciones)."""

    checks_raw = (hazards_json or {}).get("checks", []) if hazards_json else []
    checks = [
        HazardCheck(
            code=c["code"],
            response=HazardResponse(c.get("response", "no")),
            severity=HazardSeverity(c["severity"]) if c.get("severity") else None,
            note=c.get("note", ""),
        )
        for c in checks_raw
    ]

    damages_raw = (component_damage_json or {}).get("items", []) if component_damage_json else []
    damages = [
        ComponentDamage(
            component=d["component"],
            level=DamageLevel(d.get("level", "D0")),
            pct_affected=float(d.get("pct_affected", 0.0) or 0.0),
        )
        for d in damages_raw
    ]

    acc_raw = access_condition_json or {}
    access = AccessCondition(
        main_door=Access(acc_raw.get("main_door", "ok")),
        emergency_exits=Access(acc_raw.get("emergency_exits", "ok")),
        stairs=Access(acc_raw.get("stairs", "ok")),
        elevator_out_of_service=bool(acc_raw.get("elevator_out_of_service", False)),
    )

    safety = SafetyInput(
        hazards=HazardsInput(checks=checks),
        component_damage=damages,
        access=access,
        residual_drift_pct=residual_drift_pct,
        manual_override=manual_override,
        manual_override_reason=manual_override_reason,
    )
    r: PlacardResult = evaluate_placard(safety)
    return r.placard, r.reasons, r.restrictions


# ---------------------------------------------------------------------------
# Sub-flujo B: FEMA P-2018 triaje
# ---------------------------------------------------------------------------


def _bands_from_json(bands_json: list[dict] | None) -> tuple[Band, ...]:
    if not bands_json:
        return DEFAULT_TABLE_6_6
    return tuple(
        Band(ratio_low=float(b["ratio_low"]),
             ratio_high=float(b["ratio_high"]),
             rating=float(b["rating"]))
        for b in bands_json
    )


def _stories_from_json(stories_json: list[dict]) -> list[StoryInput]:
    result: list[StoryInput] = []
    for s in stories_json:
        comps = [
            ComponentInput(
                tag=str(c["tag"]),
                kind=str(c["kind"]),
                delta_D=float(c["delta_D"]),
                delta_C_base=float(c["delta_C_base"]),
                damage=DamageLevel(c.get("damage", "D0")),
            )
            for c in s.get("components", [])
        ]
        result.append(StoryInput(
            index=int(s["index"]),
            height_m=float(s["height_m"]),
            direction=Direction(s["direction"]),
            components=comps,
        ))
    return result


def build_fema_triage(
    structural_system: str,
    exceptional_flags_json: dict | None,
    stories_json: list[dict] | None,
    shortcut_json: dict | None,
    table_6_6_bands: list[dict] | None,
) -> EngineTriageResult:
    """Ejecuta el triaje FEMA P-2018 y retorna el resultado del engine."""

    ef = exceptional_flags_json or {}
    exceptional = ExceptionalFlags(
        no_asbuilt_docs=bool(ef.get("no_asbuilt_docs", False)),
        incomplete_load_path=bool(ef.get("incomplete_load_path", False)),
        discontinuous_walls=bool(ef.get("discontinuous_walls", False)),
        exceptionally_weak=bool(ef.get("exceptionally_weak", False)),
        extreme_torsion=bool(ef.get("extreme_torsion", False)),
        separation_mm=ef.get("separation_mm"),
        shorter_building_height_m=ef.get("shorter_building_height_m"),
        geotech_hazard=bool(ef.get("geotech_hazard", False)),
        notes=ef.get("notes"),
    )

    shortcut = None
    if shortcut_json:
        shortcut = ShortcutInput(
            area_walls_x_m2=shortcut_json.get("area_walls_x_m2"),
            area_walls_y_m2=shortcut_json.get("area_walls_y_m2"),
            seismic_weight_kN=shortcut_json.get("seismic_weight_kN"),
            wsi_threshold=float(shortcut_json.get("wsi_threshold", 30.0)),
            global_ratio_D_over_C=shortcut_json.get("global_ratio_D_over_C"),
            elastic_threshold=float(shortcut_json.get("elastic_threshold", 0.5)),
        )

    stories = _stories_from_json(stories_json or [])

    inp = TriageInput(
        structural_system=StructuralSystem(structural_system),
        exceptional=exceptional,
        stories=stories,
        shortcut=shortcut,
        table_6_6=_bands_from_json(table_6_6_bands),
    )
    return run_triage(inp)


def serialize_triage_stories(result: EngineTriageResult) -> list[dict[str, Any]]:
    """Convierte los StoryRating del engine a JSON serializable."""
    return [asdict(s) for s in result.stories]
