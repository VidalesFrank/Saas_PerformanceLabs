from engine.materials.concrete import (
    CircConfinement,
    RectConfinement,
    mander_confined_circ,
    mander_confined_rect,
    unconfined_concrete,
)
from engine.materials.steel import reinforcing_steel


def test_unconfined_concrete_defaults():
    c = unconfined_concrete(28.0)
    assert c.fpc == 28.0
    assert c.epsc0 == 0.002
    assert c.fpcu == 0.2 * 28.0


def test_mander_confined_rect_increases_strength_and_ductility():
    conf = RectConfinement(
        bc=320, dc=320, s=150, hoop_bar_diameter=9.5,
        num_legs_x=2, num_legs_y=2, leg_area=71.0,
        clear_bar_spacings=[155.0] * 4, rho_cc=4080 / 102400,
    )
    core = mander_confined_rect(28.0, fyh=420.0, confinement=conf)
    assert core.fpc > 28.0
    assert core.epsc0 > 0.002
    assert core.epsU > 0.006


def test_mander_confined_circ_increases_strength_and_ductility():
    conf = CircConfinement(ds=420, s=100, hoop_bar_diameter=9.5, bar_area=71.0, rho_cc=0.02, is_spiral=True)
    core = mander_confined_circ(28.0, fyh=420.0, confinement=conf)
    assert core.fpc > 28.0
    assert core.epsc0 > 0.002


def test_reinforcing_steel_defaults():
    s = reinforcing_steel()
    assert s.fy == 420.0
    assert s.E0 == 200_000.0
