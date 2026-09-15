"""Tests del análisis cíclico M-φ.

Valida:
  - Generación de historial ATC-24 (número de puntos, amplitudes)
  - Ejecución sin crash del análisis con Concrete02 + Steel02
  - Métricas de ciclo dan valores razonables
  - Amortiguamiento equivalente ξ_eq crece con la ductilidad
"""
import math
import pytest

from engine.sections.document import (
    ConcreteDef, ConcreteRegion, RectShape,
    ReinforcementBar, SectionDocument, SteelDef,
    RectConfinementDef,
)
from engine.sections.compiler import compile as compile_doc
from engine.sections.reinforcement import BAR_AREAS_MM2
from engine.analysis.cyclic import (
    generate_atc24_history, generate_sinusoidal_history,
    compute_cyclic_moment_curvature,
)


def _col_400x400_cyclic():
    """Columna 400×400 con Concrete02 + Steel02 (memoria histerética)."""
    c = ConcreteDef(fpc=28.0, model_kind="concrete02")
    s = SteelDef(fy=420.0, model_kind="steel02")
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
    conf = RectConfinementDef(hoop_bar_size="#3", spacing=100, legs_x=3, legs_y=3)
    return SectionDocument(
        concrete_defs=[c], steel_defs=[s],
        regions=[ConcreteRegion(
            shape=RectShape(height=400, width=400),
            concrete_id=c.id, confinement=conf, cover_to_bar=cover,
        )],
        bars=bars,
    )


# ── Test: generación de historia ────────────────────────────────────────────

class TestATC24:
    def test_length(self):
        # 8 niveles × 2 ciclos × 20 pasos + 1 (inicial) = 321
        h = generate_atc24_history(phi_yield=1e-5)
        assert len(h) == 8 * 2 * 20 + 1

    def test_starts_at_zero(self):
        h = generate_atc24_history(phi_yield=1e-5)
        assert h[0] == 0.0

    def test_max_amplitude(self):
        # Con ductilidades hasta 8 y phi_y=1e-5 → phi_max = 8e-5
        h = generate_atc24_history(phi_yield=1e-5)
        assert abs(max(h) - 8e-5) < 1e-15

    def test_symmetric(self):
        h = generate_atc24_history(phi_yield=1e-5)
        assert abs(max(h) + min(h)) < 1e-14


class TestSinusoidal:
    def test_zero_start(self):
        h = generate_sinusoidal_history(phi_max=1e-5, n_cycles=3)
        assert abs(h[0]) < 1e-15

    def test_decay_reduces_amplitude(self):
        h_no = generate_sinusoidal_history(phi_max=1e-5, n_cycles=5, decay=0.0)
        h_dc = generate_sinusoidal_history(phi_max=1e-5, n_cycles=5, decay=0.5)
        # Con decay, la amplitud del último ciclo es menor que la del primero
        assert max(h_dc[-40:]) < 0.6 * max(h_no[-40:])


# ── Test: análisis cíclico ──────────────────────────────────────────────────

class TestCyclicAnalysis:
    def test_runs_without_crash(self):
        doc = _col_400x400_cyclic()
        compiled = compile_doc(doc)
        # Historial corto para el test
        h = generate_atc24_history(
            phi_yield=1e-5, ductilities=[0.5, 1.0], cycles_per_step=1, steps_per_cycle=8,
        )
        r = compute_cyclic_moment_curvature(compiled, h, axial_load_n=200e3)
        assert len(r.curve) > 0

    def test_energy_positive(self):
        doc = _col_400x400_cyclic()
        compiled = compile_doc(doc)
        h = generate_atc24_history(
            phi_yield=1e-5, ductilities=[2.0], cycles_per_step=2, steps_per_cycle=12,
        )
        r = compute_cyclic_moment_curvature(compiled, h, axial_load_n=200e3)
        # Ductilidad 2 → hay fluencia → energía disipada debe ser > 0
        assert r.total_energy_dis > 0

    def test_cycles_detected(self):
        doc = _col_400x400_cyclic()
        compiled = compile_doc(doc)
        # 3 ciclos completos sinusoidales
        h = generate_sinusoidal_history(phi_max=1.5e-5, n_cycles=3, steps_per_cycle=30)
        r = compute_cyclic_moment_curvature(compiled, h)
        # Al menos 1 ciclo detectado (depende del cruce por cero)
        assert len(r.cycles) >= 1


class TestSaturationOfXiEq:
    """A ductilidad más alta, ξ_eq debe crecer (más disipación)."""
    def test_xi_grows_with_ductility(self):
        doc = _col_400x400_cyclic()
        compiled = compile_doc(doc)
        # Ductilidad baja
        h1 = generate_atc24_history(
            phi_yield=1e-5, ductilities=[1.0], cycles_per_step=2, steps_per_cycle=16,
        )
        r1 = compute_cyclic_moment_curvature(compiled, h1)
        # Ductilidad alta
        h2 = generate_atc24_history(
            phi_yield=1e-5, ductilities=[4.0], cycles_per_step=2, steps_per_cycle=16,
        )
        r2 = compute_cyclic_moment_curvature(compiled, h2)
        # ξ_eq del ciclo alto debe ser mayor que del ciclo bajo
        if r1.cycles and r2.cycles:
            xi_low  = max((c.xi_eq_pct for c in r1.cycles), default=0.0)
            xi_high = max((c.xi_eq_pct for c in r2.cycles), default=0.0)
            assert xi_high > xi_low
