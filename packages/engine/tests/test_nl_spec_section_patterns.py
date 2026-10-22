"""
Tests para la nueva prioridad de refuerzo en NLSpecBuilder:
  user_reinforcement (override individual)
    > section_patterns (as-built por sección)
      > col_detail / beam_detail (diseño automático)
        > defaults NSR-10 ρ=1%
"""
from engine.building.nonlinear import (
    NLSpecBuilder,
    validate_frame_reinforcement,
)


def _tiny_canonical() -> dict:
    """Un canonical minimalista: 2 columnas y 1 viga, 2 pisos."""
    return {
        "materials": {
            "C25": {"type": "concrete", "fpc_mpa": 25.0},
            "S42": {"type": "steel", "fy_mpa": 420.0},
        },
        "sections": {
            "C40x40": {"b_m": 0.40, "h_m": 0.40, "material": "C25"},
            "V30x40": {"b_m": 0.30, "h_m": 0.40, "material": "C25"},
        },
        "joints": {
            "1": {"x": 0.0, "y": 0.0, "z": 0.0},
            "2": {"x": 0.0, "y": 0.0, "z": 3.0},
            "3": {"x": 5.0, "y": 0.0, "z": 3.0},
            "4": {"x": 5.0, "y": 0.0, "z": 0.0},
        },
        "stories": {
            "story-1": {"elevation_m": 3.0},
        },
        "frames": {
            "col-1": {"element_type": "column", "section": "C40x40",
                      "joint_i": "1", "joint_j": "2", "story": "story-1"},
            "col-2": {"element_type": "column", "section": "C40x40",
                      "joint_i": "4", "joint_j": "3", "story": "story-1"},
            "beam-1": {"element_type": "beam", "section": "V30x40",
                       "joint_i": "2", "joint_j": "3", "story": "story-1"},
        },
    }


def test_section_pattern_applies_to_all_columns_without_design():
    canonical = _tiny_canonical()
    # Sin diseño automático y sin overrides individuales. Patrón as-built:
    # columnas tipo C40x40 → 12-#8, estribos #4 @ 100.
    section_patterns = {
        "column:C40x40": {
            "mode": "manual",
            "longitudinal": {"n_bars": 12, "bar_label": "#8", "As_cm2": 61.2},
            "transverse":   {"tie_bar_label": "#4", "n_legs_b": 3, "n_legs_h": 3,
                             "s_confined_mm": 100, "s_general_mm": 200},
            "pattern_label": "Cols tipo 1",
        }
    }

    builder = NLSpecBuilder(
        canonical          = canonical,
        col_detail         = {},
        beam_detail        = {},
        user_reinforcement = {},
        section_patterns   = section_patterns,
        energy_dissipation = "DMO",
    )
    spec = builder.build()
    cols = spec["elements"]["columns"]
    assert set(cols.keys()) == {"col-1", "col-2"}
    for cid, c in cols.items():
        long_r = c["reinforcement"]["longitudinal"]
        tran_r = c["reinforcement"]["transverse"]
        assert long_r["n_bars"]    == 12, f"{cid}: n_bars"
        assert long_r["bar_label"] == "#8", f"{cid}: bar_label"
        assert tran_r["tie_bar_label"] == "#4", f"{cid}: tie_bar_label"
        assert tran_r["s_confined_mm"] == 100
        assert c["has_design"] is True


def test_user_override_beats_section_pattern():
    canonical = _tiny_canonical()
    section_patterns = {
        "column:C40x40": {
            "mode": "manual",
            "longitudinal": {"n_bars": 8, "bar_label": "#6", "As_cm2": 22.8},
            "transverse":   {"tie_bar_label": "#3", "n_legs_b": 2, "n_legs_h": 2,
                             "s_confined_mm": 150, "s_general_mm": 300},
        }
    }
    # col-1 tiene override individual que debe ganar
    user_r = {
        "col-1": {
            "reinforcement": {
                "longitudinal": {"n_bars": 16, "bar_label": "#9", "As_cm2": 103.0},
                "transverse":   {"tie_bar_label": "#4", "n_legs_b": 4, "n_legs_h": 4,
                                 "s_confined_mm": 80, "s_general_mm": 150},
            }
        }
    }

    builder = NLSpecBuilder(
        canonical          = canonical,
        col_detail         = {},
        beam_detail        = {},
        user_reinforcement = user_r,
        section_patterns   = section_patterns,
    )
    spec = builder.build()
    cols = spec["elements"]["columns"]

    # col-1 → override (16-#9)
    assert cols["col-1"]["reinforcement"]["longitudinal"]["n_bars"]    == 16
    assert cols["col-1"]["reinforcement"]["longitudinal"]["bar_label"] == "#9"
    assert cols["col-1"]["reinforcement"]["transverse"]["s_confined_mm"] == 80
    # col-2 → patrón de sección (8-#6)
    assert cols["col-2"]["reinforcement"]["longitudinal"]["n_bars"]    == 8
    assert cols["col-2"]["reinforcement"]["longitudinal"]["bar_label"] == "#6"
    assert cols["col-2"]["reinforcement"]["transverse"]["s_confined_mm"] == 150


def test_section_pattern_auto_mode_is_ignored():
    """Un patrón con mode=auto NO debe aplicar — equivale a borrar el patrón."""
    canonical = _tiny_canonical()
    section_patterns = {
        "column:C40x40": {
            "mode": "auto",   # ignorado
            "longitudinal": {"n_bars": 12, "bar_label": "#8", "As_cm2": 61.2},
        }
    }
    builder = NLSpecBuilder(
        canonical          = canonical,
        col_detail         = {},
        beam_detail        = {},
        section_patterns   = section_patterns,
    )
    spec = builder.build()
    for c in spec["elements"]["columns"].values():
        # Debe caer a defaults ρ=1% con #5
        assert c["reinforcement"]["longitudinal"]["bar_label"] == "#5"
        assert c["has_design"] is False


def test_beam_section_pattern():
    canonical = _tiny_canonical()
    section_patterns = {
        "beam:V30x40": {
            "mode": "manual",
            "zones": {
                "end_i": {"top": {"n_bars": 3, "bar_label": "#6", "As_cm2": 8.55},
                          "bot": {"n_bars": 2, "bar_label": "#5", "As_cm2": 4.00}},
                "mid":   {"top": {"n_bars": 2, "bar_label": "#5", "As_cm2": 4.00},
                          "bot": {"n_bars": 2, "bar_label": "#5", "As_cm2": 4.00}},
                "end_j": {"top": {"n_bars": 3, "bar_label": "#6", "As_cm2": 8.55},
                          "bot": {"n_bars": 2, "bar_label": "#5", "As_cm2": 4.00}},
            },
            "shear": {
                "tie_bar_label": "#3", "n_legs": 2,
                "s_confined_mm": 80, "s_central_mm": 150,
                "L_confinement_mm": 800,
            },
        }
    }
    builder = NLSpecBuilder(canonical=canonical, col_detail={}, beam_detail={},
                            section_patterns=section_patterns)
    spec = builder.build()
    beam = spec["elements"]["beams"]["beam-1"]
    assert beam["reinforcement"]["zones"]["end_i"]["top"]["n_bars"] == 3
    assert beam["reinforcement"]["zones"]["end_i"]["top"]["bar_label"] == "#6"
    assert beam["reinforcement"]["shear"]["s_confined_mm"] == 80
    assert beam["has_design"] is True


def test_validator_column_ok():
    r = {
        "longitudinal": {"n_bars": 8, "bar_label": "#8", "As_cm2": 40.8},
        "transverse":   {"tie_bar_label": "#3", "n_legs_b": 3, "n_legs_h": 3,
                         "s_confined_mm": 100, "s_general_mm": 200},
    }
    res = validate_frame_reinforcement("column", r, {"b_m": 0.4, "h_m": 0.4}, "DMO")
    assert res["nsr10_ok"] is True
    assert res["n_errors"] == 0


def test_column_granular_groups_mixed_diameters():
    """4 esquinas #8 + top/bot 2·#6 + lados 1·#5 → total 10 barras, 3 diámetros."""
    canonical = _tiny_canonical()
    section_patterns = {
        "column:C40x40": {
            "mode": "manual",
            "longitudinal": {
                "corners":    {"bar_label": "#8"},
                "top_face":   {"n_bars": 2, "bar_label": "#6"},
                "bot_face":   {"n_bars": 2, "bar_label": "#6"},
                "left_face":  {"n_bars": 1, "bar_label": "#5"},
                "right_face": {"n_bars": 1, "bar_label": "#5"},
            },
            "transverse": {"tie_bar_label": "#3", "n_legs_b": 3, "n_legs_h": 3,
                           "s_confined_mm": 100, "s_general_mm": 200},
        }
    }
    builder = NLSpecBuilder(canonical=canonical, col_detail={}, beam_detail={},
                            section_patterns=section_patterns)
    spec = builder.build()
    for cid in ("col-1", "col-2"):
        l = spec["elements"]["columns"][cid]["reinforcement"]["longitudinal"]
        assert l["n_bars"] == 10, f"{cid}: n_bars"
        groups = l["groups"]
        assert groups["corners"]["n_bars"]    == 4
        assert groups["corners"]["bar_label"] == "#8"
        assert groups["top_face"]["n_bars"]   == 2
        assert groups["top_face"]["bar_label"] == "#6"
        assert groups["left_face"]["bar_label"] == "#5"
        # As total ≈ 4·5.07 + 4·2.87 + 2·1.99 = 35.7
        assert 35.0 < l["As_cm2"] < 36.5, f"As_cm2 fuera de rango: {l['As_cm2']}"
        # El dominante es el que suma más barras — top+bot aportan 4·#6
        # pero corners son 4·#8. Empate 4-vs-4: la lógica elige el de mayor
        # diámetro (dominant = #8).
        assert l["bar_label"] == "#8"


def test_column_granular_groups_nested_under_groups_key():
    """Regresión: el router/UI envía {longitudinal: {groups: {...}, n_bars, bar_label}}
    con las 5 claves anidadas bajo 'groups'. El builder debe aplanar.

    Pre-fix: entraba al path legacy y aplastaba todos los diámetros al dominante.
    """
    canonical = _tiny_canonical()
    section_patterns = {
        "column:C40x40": {
            "mode": "manual",
            "longitudinal": {
                "n_bars":    12,
                "bar_label": "#6",     # el agregado dice #6 — pero las caras son #5
                "As_cm2":    27.35,
                "groups": {
                    "corners":    {"bar_label": "#6", "n_bars": 4, "As_cm2": 11.46},
                    "top_face":   {"bar_label": "#5", "n_bars": 2, "As_cm2": 3.97},
                    "bot_face":   {"bar_label": "#5", "n_bars": 2, "As_cm2": 3.97},
                    "left_face":  {"bar_label": "#5", "n_bars": 2, "As_cm2": 3.97},
                    "right_face": {"bar_label": "#5", "n_bars": 2, "As_cm2": 3.97},
                },
            },
            "transverse": {"tie_bar_label": "#3", "n_legs_b": 2, "n_legs_h": 2,
                           "s_confined_mm": 100, "s_general_mm": 200},
        }
    }
    builder = NLSpecBuilder(canonical=canonical, col_detail={}, beam_detail={},
                            section_patterns=section_patterns)
    spec = builder.build()
    for cid in ("col-1", "col-2"):
        g = spec["elements"]["columns"][cid]["reinforcement"]["longitudinal"]["groups"]
        # Caras DEBEN mantener su diámetro #5 (no haber sido sobreescritas)
        assert g["top_face"]["bar_label"]   == "#5", f"{cid}: top_face bar_label"
        assert g["bot_face"]["bar_label"]   == "#5", f"{cid}: bot_face bar_label"
        assert g["left_face"]["bar_label"]  == "#5", f"{cid}: left_face bar_label"
        assert g["right_face"]["bar_label"] == "#5", f"{cid}: right_face bar_label"
        assert g["corners"]["bar_label"]    == "#6"
        # Total As: 4·2.86 + 8·1.99 ≈ 27.4
        As_total = spec["elements"]["columns"][cid]["reinforcement"]["longitudinal"]["As_cm2"]
        assert 26.5 < As_total < 28.5, f"As_cm2 fuera de rango: {As_total}"


def test_column_legacy_schema_still_works():
    """Schema viejo {n_bars, bar_label} debe seguir funcionando y expandirse a groups."""
    canonical = _tiny_canonical()
    section_patterns = {
        "column:C40x40": {
            "mode": "manual",
            "longitudinal": {"n_bars": 12, "bar_label": "#8", "As_cm2": 61.2},
            "transverse":   {"tie_bar_label": "#4", "n_legs_b": 3, "n_legs_h": 3,
                             "s_confined_mm": 100, "s_general_mm": 200},
        }
    }
    builder = NLSpecBuilder(canonical=canonical, col_detail={}, beam_detail={},
                            section_patterns=section_patterns)
    spec = builder.build()
    l = spec["elements"]["columns"]["col-1"]["reinforcement"]["longitudinal"]
    assert l["n_bars"] == 12
    assert "groups" in l                         # expandido a granular
    assert l["groups"]["corners"]["n_bars"] == 4
    # 8 restantes deben repartirse 2 top + 2 bot + 2 left + 2 right
    total_face = sum(l["groups"][k]["n_bars"]
                     for k in ("top_face", "bot_face", "left_face", "right_face"))
    assert total_face == 8


def test_validator_column_low_rho_triggers_warning():
    r = {
        "longitudinal": {"n_bars": 4, "bar_label": "#5", "As_cm2": 8.0},
        "transverse":   {"tie_bar_label": "#3", "n_legs_b": 2, "n_legs_h": 2,
                         "s_confined_mm": 100, "s_general_mm": 200},
    }
    res = validate_frame_reinforcement("column", r, {"b_m": 0.4, "h_m": 0.4}, "DES")
    codes = {w["code"] for w in res["warnings"]}
    assert "RHO_LT_MIN" in codes
    assert res["nsr10_ok"] is False
    assert res["n_errors"] == 0  # bajo ρ es warning, no error que impida guardar
