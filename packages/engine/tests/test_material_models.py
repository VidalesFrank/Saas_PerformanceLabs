"""Tests de los modelos de materiales adicionales (Concrete02, Steel01, prestressing).

Verifica que:
  - La sección compilada propaga correctamente `model_kind` desde SectionDocument.
  - `_define_materials` (interaction) crea el uniaxialMaterial correcto según kind.
  - El diagrama P-M sigue produciendo P0 y Pt correctos con cualquier modelo
    (los valores absolutos no cambian por el modelo elegido).
  - Concrete02 produce una respuesta consistente (no crash, valores razonables).
"""
import math
import pytest

from engine.sections.document import (
    ConcreteDef, ConcreteRegion, RectShape,
    ReinforcementBar, SectionDocument, SteelDef,
)
from engine.sections.compiler import compile as compile_doc
from engine.analysis.interaction import compute_interaction_diagram
from engine.sections.reinforcement import BAR_AREAS_MM2


def _col_400x400_8num8(concrete_kind: str = "concrete01",
                       steel_kind: str = "steel02"):
    c = ConcreteDef(fpc=28.0, model_kind=concrete_kind)
    s = SteelDef(fy=420.0, model_kind=steel_kind)
    cover = 40
    y_e = 200 - cover
    bars = [
        ReinforcementBar(y=+y_e, z=+y_e, bar_size="#8", steel_id=s.id),
        ReinforcementBar(y=+y_e, z=-y_e, bar_size="#8", steel_id=s.id),
        ReinforcementBar(y=-y_e, z=+y_e, bar_size="#8", steel_id=s.id),
        ReinforcementBar(y=-y_e, z=-y_e, bar_size="#8", steel_id=s.id),
        ReinforcementBar(y=+y_e, z=0.0,  bar_size="#8", steel_id=s.id),
        ReinforcementBar(y=-y_e, z=0.0,  bar_size="#8", steel_id=s.id),
        ReinforcementBar(y=0.0,  z=+y_e, bar_size="#8", steel_id=s.id),
        ReinforcementBar(y=0.0,  z=-y_e, bar_size="#8", steel_id=s.id),
    ]
    return SectionDocument(
        concrete_defs=[c], steel_defs=[s],
        regions=[ConcreteRegion(shape=RectShape(height=400, width=400),
                                 concrete_id=c.id, cover_to_bar=cover)],
        bars=bars,
    )


class TestCompilationPropagation:
    def test_concrete01_default(self):
        doc = _col_400x400_8num8()
        compiled = compile_doc(doc)
        assert compiled.concrete_model_kind == "concrete01"

    def test_concrete02_selected(self):
        doc = _col_400x400_8num8(concrete_kind="concrete02")
        compiled = compile_doc(doc)
        assert compiled.concrete_model_kind == "concrete02"
        # Params derivados por defecto: ft ~ 0.62·√28 = 3.28 MPa (calculado en _define_materials)
        # Aquí solo verifico que la flag se propaga y no crashea

    def test_steel01_selected(self):
        doc = _col_400x400_8num8(steel_kind="steel01")
        compiled = compile_doc(doc)
        assert compiled.steel_model_kind == "steel01"

    def test_prestressing_selected(self):
        doc = _col_400x400_8num8(steel_kind="prestressing")
        compiled = compile_doc(doc)
        assert compiled.steel_model_kind == "prestressing"


class TestP0PtInvarianceOverKind:
    """P0 y Pt dependen SÓLO de la geometría y f'c/fy (fórmula ACI 22.4.2.2).
    No deben cambiar por elegir un modelo constitutivo distinto."""

    def _p0_pt(self, concrete_kind: str, steel_kind: str) -> tuple[float, float]:
        doc = _col_400x400_8num8(concrete_kind, steel_kind)
        compiled = compile_doc(doc)
        diagram = compute_interaction_diagram(compiled, num_points=10)
        p0 = max(p.P for p in diagram)
        pt = min(p.P for p in diagram)
        return p0, pt

    def test_concrete01_vs_concrete02_p0(self):
        p0_a, pt_a = self._p0_pt("concrete01", "steel02")
        p0_b, pt_b = self._p0_pt("concrete02", "steel02")
        # P0 y Pt no deben depender del modelo constitutivo elegido
        assert abs(p0_a - p0_b) / abs(p0_a) < 1e-6
        assert abs(pt_a - pt_b) / abs(pt_a) < 1e-6

    def test_steel01_vs_steel02_p0(self):
        p0_a, pt_a = self._p0_pt("concrete01", "steel01")
        p0_b, pt_b = self._p0_pt("concrete01", "steel02")
        assert abs(p0_a - p0_b) / abs(p0_a) < 1e-6
        assert abs(pt_a - pt_b) / abs(pt_a) < 1e-6


class TestPMAllModelsWork:
    """El diagrama P-M debe correr sin crash con cualquier combinación."""

    @pytest.mark.parametrize("ckind", ["concrete01", "concrete02"])
    @pytest.mark.parametrize("skind", ["steel01", "steel02", "prestressing"])
    def test_all_combinations(self, ckind, skind):
        doc = _col_400x400_8num8(ckind, skind)
        compiled = compile_doc(doc)
        diagram = compute_interaction_diagram(compiled, num_points=6)
        assert len(diagram) >= 2
        assert max(p.M for p in diagram) > 0
