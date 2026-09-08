"""
Regresión: E2KParser no debe truncar losas (AREA FLOOR) de más de 4 vértices.

Contexto (2026-09-08): una losa ETABS con forma en L o con una abertura de
escalera/ascensor se exporta como un AREA con 5+ puntos. El parser tomaba
solo los primeros 4 (`pts[:4]`) y descartaba el resto en silencio. Los
vértices descartados quedaban sin ningún frame/shell conectado y sin
membresía de diafragma → 6 GDL libres y rigidez nula → matriz de rigidez
singular en el análisis modal (los 3 solvers eigen fallan, ~8 min después,
sin ninguna pista de la causa real).

Este test construye un .e2k mínimo con una losa pentagonal (5 vértices) y
verifica que los 5 puntos terminan como corners de al menos un shell — no
solo los primeros 4.
"""
import os
import sys
import tempfile

import pytest

sys.path.insert(
    0,
    os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "app", "engine", "building")),
)

from e2k_parser import E2KParser  # noqa: E402


_E2K_PENTAGON_FLOOR = """
$ STORIES - IN SEQUENCE FROM TOP
  STORY "Story1"  ELEV 3
  STORY "Base"  ELEV 0

$ POINT COORDINATES
  POINT "1"  0 0
  POINT "2"  4 0
  POINT "3"  4 4
  POINT "4"  2 6
  POINT "5"  0 4

$ POINT ASSIGNS
  POINTASSIGN  "1"  "Story1"  DIAPH "D1"
  POINTASSIGN  "2"  "Story1"  DIAPH "D1"
  POINTASSIGN  "3"  "Story1"  DIAPH "D1"
  POINTASSIGN  "4"  "Story1"  DIAPH "D1"
  POINTASSIGN  "5"  "Story1"  DIAPH "D1"

$ AREA CONNECTIVITIES
  AREA "F1"  FLOOR  5  "1"  "2"  "3"  "4"  "5"

$ AREA ASSIGNS
  AREAASSIGN  "F1"  "Story1"  SECTION "SLAB1"

$ SLAB PROPERTIES
  SHELLPROP  "SLAB1"  PROPTYPE "Slab"  MATERIAL "CONC1"  SLABTHICKNESS 0.2
"""


@pytest.fixture
def parsed_pentagon():
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".e2k", delete=False, encoding="latin-1"
    ) as f:
        f.write(_E2K_PENTAGON_FLOOR)
        path = f.name
    try:
        parser = E2KParser(path)
        parser.parse()
        yield parser
    finally:
        os.unlink(path)


def test_pentagon_floor_keeps_all_five_vertices(parsed_pentagon):
    """Los 5 puntos de la losa deben aparecer como corner de algún shell —
    no solo los 4 primeros (pts[:4])."""
    df_shells = parsed_pentagon._build_oe_shells()

    joint_label_of = {
        pt: label for (pt, story), label in parsed_pentagon._joint_label.items()
    }
    expected_labels = {joint_label_of[str(i)] for i in range(1, 6)}

    touched: set[int] = set()
    for _, row in df_shells.iterrows():
        for col in ("Joint 1", "Joint 2", "Joint 3", "Joint 4"):
            v = row[col]
            if v and v != 0:
                touched.add(int(v))

    missing = expected_labels - touched
    assert not missing, (
        f"Vértices de la losa pentagonal ausentes de todo shell: {missing} "
        "— el polígono se está truncando en vez de triangularse."
    )


def test_pentagon_floor_splits_into_multiple_triangles(parsed_pentagon):
    """Un pentágono (5 vértices) no cabe en un solo shell de 4 corners:
    debe generar más de una fila de shell para la misma Area Label."""
    df_shells = parsed_pentagon._build_oe_shells()
    assert len(df_shells) > 1
    assert set(df_shells["Area Label"]) == {"F1"}
    # Element Label debe ser único por fila (cada triángulo, su propio label).
    assert df_shells["Element Label"].is_unique


def test_pentagon_floor_mass_not_lost(parsed_pentagon):
    """La masa total de la losa (via _build_mass_summary) debe reflejar el
    área completa del pentágono, no solo la del primer cuadrilátero truncado."""
    df_joints = parsed_pentagon._build_oe_joints()
    df_shells = parsed_pentagon._build_oe_shells()
    df_mass = parsed_pentagon._build_mass_summary(df_joints, df_shells)

    assert len(df_mass) == 1
    # Pentágono (0,0)-(4,0)-(4,4)-(2,6)-(0,4): área real (shoelace) = 20 m².
    # thickness 0.2m, gamma 24 kN/m³ / 9.81 → masa propia ≈ 9.79 t.
    # Un cuadrilátero truncado (perdiendo el vértice 5) daría área menor.
    expected_area = 20.0
    thickness = 0.2
    gamma, g = 24.0, 9.81
    expected_mass = expected_area * thickness * gamma / g
    assert df_mass.iloc[0]["Mass X"] == pytest.approx(expected_mass, rel=0.02)


def test_no_false_degenerate_flag_from_triangulation(parsed_pentagon):
    """El relleno del 4° corner de cada triángulo debe usar 0 (marcador
    nulo reconocido en todo el pipeline), no repetir un joint real — si no,
    el validador marcaría cada triángulo como 'shell degenerado' aunque sea
    perfectamente válido."""
    df_shells = parsed_pentagon._build_oe_shells()
    for _, row in df_shells.iterrows():
        vals = [row[f"Joint {i}"] for i in range(1, 5)]
        non_zero = [v for v in vals if v]
        assert len(non_zero) == len(set(non_zero)), (
            f"Fila con corner repetido (no-cero) — se marcaría como "
            f"DEGENERATE_SHELL en la validación: {row.to_dict()}"
        )
