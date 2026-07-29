"""Tests del diagrama de interacción P-M.

Columna de referencia: 400×400mm, 8-#8, f'c=28MPa, fy=420MPa, #3 c/150mm.
Valores verificados contra cálculo manual en CLAUDE.md.
"""
import math

from engine.analysis.interaction import compute_interaction_diagram
from engine.sections.document import (
    ConcreteDef, SteelDef, ConcreteRegion, ReinforcementBar,
    RectShape, SectionDocument, RectConfinementDef,
)
from engine.sections.compiler import compile as compile_doc


def _column_400x400_8bar8():
    """Construye la columna de referencia como SectionDocument."""
    cdef = ConcreteDef(id="c0", fpc=28.0)
    sdef = SteelDef(id="s0", fy=420.0)
    region = ConcreteRegion(
        id="r0", label="Columna",
        shape=RectShape(y=0, z=0, height=400, width=400),
        concrete_id="c0",
        confinement=RectConfinementDef(hoop_bar_size="#3", spacing=150, legs_x=2, legs_y=2, fyh=420),
        cover_to_bar=52.0,
    )
    # 8 barras #8: 3 arriba, 3 abajo, 1 izq (interior), 1 der (interior)
    bar_pos = [
        (148, 148), (148, 0), (148, -148),
        (-148, 148), (-148, 0), (-148, -148),
        (0, 148), (0, -148),
    ]
    bars = [ReinforcementBar(id=f"b{i}", y=y, z=z, bar_size="#8", steel_id="s0")
            for i, (y, z) in enumerate(bar_pos)]
    doc = SectionDocument(concrete_defs=[cdef], steel_defs=[sdef], regions=[region], bars=bars)
    return compile_doc(doc)


def test_interaction_diagram_pure_compression_and_tension_match_hand_calc():
    compiled = _column_400x400_8bar8()
    ast = compiled.steel_area
    ag  = compiled.gross_area
    fpc = compiled.fpc_nominal
    fy  = compiled.steel_params.fy

    diagram = compute_interaction_diagram(compiled, num_points=5)

    expected_p_max = 0.85 * fpc * (ag - ast) + fy * ast
    expected_p_min = -fy * ast

    assert math.isclose(diagram[0].P, expected_p_max, rel_tol=1e-9)
    assert diagram[0].M == 0.0
    assert math.isclose(diagram[-1].P, expected_p_min, rel_tol=1e-9)
    assert diagram[-1].M == 0.0


def test_interaction_diagram_shape_is_physically_reasonable():
    compiled = _column_400x400_8bar8()
    diagram = compute_interaction_diagram(compiled, num_points=7)

    assert all(p.M >= 0 for p in diagram)
    assert all(p.P <= diagram[0].P + 1 for p in diagram)
    assert all(p.P >= diagram[-1].P - 1 for p in diagram)
    # debe existir capacidad a momento real en algún punto intermedio
    assert max(p.M for p in diagram) > 50e6  # > 50 kN·m
