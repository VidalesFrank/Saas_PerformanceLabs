import math

from engine.analysis.interaction import compute_interaction_diagram
from engine.materials.concrete import RectConfinement, mander_confined_rect, unconfined_concrete
from engine.materials.steel import reinforcing_steel
from engine.sections.geometry import RectangularSection
from engine.sections.reinforcement import bar_area, rect_perimeter_bars, total_steel_area


def _column_400x400_8bar8():
    fpc, fy = 28.0, 420.0
    sec = RectangularSection(width=400, height=400, cover=40, nf_core=(8, 8), nf_cover=(8, 2))
    bars = rect_perimeter_bars(
        sec, cover_to_bar_centroid=52, n_bars_y=3, n_bars_z=3, area_per_bar=bar_area("#8"), mat_tag=0
    )
    cover_params = unconfined_concrete(fpc)
    conf = RectConfinement(
        bc=320, dc=320, s=150, hoop_bar_diameter=9.5, num_legs_x=2, num_legs_y=2,
        leg_area=71.0, clear_bar_spacings=[155.0] * 4, rho_cc=total_steel_area(bars) / 102_400,
    )
    core_params = mander_confined_rect(fpc, fyh=420.0, confinement=conf)
    steel_params = reinforcing_steel(fy=fy)
    return sec, bars, core_params, cover_params, steel_params


def test_interaction_diagram_pure_compression_and_tension_match_hand_calc():
    sec, bars, core, cover, steel = _column_400x400_8bar8()
    ast = total_steel_area(bars)
    ag = sec.gross_area

    diagram = compute_interaction_diagram(sec, bars, core, cover, steel, depth_for_curvature=400, num_points=5)

    expected_p_max = 0.85 * cover.fpc * (ag - ast) + steel.fy * ast
    expected_p_min = -steel.fy * ast

    assert math.isclose(diagram[0].P, expected_p_max, rel_tol=1e-9)
    assert diagram[0].M == 0.0
    assert math.isclose(diagram[-1].P, expected_p_min, rel_tol=1e-9)
    assert diagram[-1].M == 0.0


def test_interaction_diagram_shape_is_physically_reasonable():
    sec, bars, core, cover, steel = _column_400x400_8bar8()
    diagram = compute_interaction_diagram(sec, bars, core, cover, steel, depth_for_curvature=400, num_points=7)

    assert all(p.M >= 0 for p in diagram)
    assert all(p.P <= diagram[0].P + 1 for p in diagram)  # ningun punto excede la compresion pura
    assert all(p.P >= diagram[-1].P - 1 for p in diagram)  # ningun punto excede la tension pura
    # debe existir capacidad a momento real en algun punto intermedio (el solver convergio)
    assert max(p.M for p in diagram) > 50e6  # > 50 kN*m
