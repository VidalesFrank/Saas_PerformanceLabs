"""Tests de las formas paramétricas I, T, L, doble T.

Cada test compara el área y algunas propiedades (Iz) contra fórmulas cerradas
publicadas en manuales de perfiles (AISC, Popov, Ryder).
"""
import math

from engine.sections.document import (
    ConcreteDef, ConcreteRegion, SectionDocument,
    IShape, TShape, LShape, DoubleTShape,
)
from engine.sections.section_properties import compute_geometric_properties


def _doc_with(shape) -> SectionDocument:
    c = ConcreteDef(fpc=28.0)
    return SectionDocument(
        concrete_defs=[c],
        regions=[ConcreteRegion(shape=shape, concrete_id=c.id)],
    )


# ── I ──────────────────────────────────────────────────────────────────────

class TestIShape:
    def test_area_symmetric_I(self):
        # Sección I: 2 patines 300×40 + alma 500-2·40 = 420 × 20 = 8400
        # A = 2·(300·40) + 420·20 = 24000 + 8400 = 32400 mm²
        i = IShape(d=500, bf_top=300, tf_top=40, bf_bot=300, tf_bot=40, tw=20)
        p = compute_geometric_properties(_doc_with(i))
        A_teor = 2 * 300 * 40 + (500 - 2 * 40) * 20
        assert abs(p.gross_area - A_teor) / A_teor < 1e-9

    def test_symmetric_I_has_zero_Iyz(self):
        i = IShape(d=500, bf_top=300, tf_top=40, bf_bot=300, tf_bot=40, tw=20)
        p = compute_geometric_properties(_doc_with(i))
        assert abs(p.Iyz) < 1e-3

    def test_asymmetric_I_area_and_centroid(self):
        # I asimétrica (patín superior más grande) → centroide se corre arriba
        i = IShape(d=500, bf_top=400, tf_top=40, bf_bot=200, tf_bot=40, tw=20)
        p = compute_geometric_properties(_doc_with(i))
        A_teor = 400 * 40 + 200 * 40 + (500 - 80) * 20
        assert abs(p.gross_area - A_teor) / A_teor < 1e-9
        assert p.centroid_y > 0    # centroide sube porque el patín superior es más pesado

    def test_Iz_symmetric_I_matches_formula(self):
        # I = (2·bf·tf³/12 + 2·bf·tf·(d/2−tf/2)²) + (tw·hw³/12)
        i = IShape(d=500, bf_top=300, tf_top=40, bf_bot=300, tf_bot=40, tw=20)
        p = compute_geometric_properties(_doc_with(i))
        d, bf, tf, tw = 500, 300, 40, 20
        hw = d - 2 * tf
        # Contribución patines (con Steiner)
        I_flanges = 2 * (bf * tf ** 3 / 12 + bf * tf * ((d - tf) / 2) ** 2)
        I_web     = tw * hw ** 3 / 12
        Iz_teor = I_flanges + I_web
        assert abs(p.Iz - Iz_teor) / Iz_teor < 1e-6


# ── T ──────────────────────────────────────────────────────────────────────

class TestTShape:
    def test_area(self):
        # T: patín superior 300×80 + alma (500−80)·30 = 300·80 + 420·30 = 24000 + 12600 = 36600
        t = TShape(d=500, bf=300, tf=80, tw=30)
        p = compute_geometric_properties(_doc_with(t))
        A_teor = 300 * 80 + (500 - 80) * 30
        assert abs(p.gross_area - A_teor) / A_teor < 1e-9

    def test_centroid_offset(self):
        # T tiene centroide arriba (más área en el patín superior)
        t = TShape(d=500, bf=400, tf=100, tw=30)
        p = compute_geometric_properties(_doc_with(t))
        # Centroide teórico: y_c = (A_patin·y_patin + A_alma·y_alma) / A
        A_p, y_p = 400 * 100, 200
                                                            # centro del patín (y=+200 aprox)
        A_w, y_w = (500 - 100) * 30, -50                    # centro del alma
        y_c_teor = (A_p * y_p + A_w * y_w) / (A_p + A_w)
        assert abs(p.centroid_y - y_c_teor) < 5


# ── L ──────────────────────────────────────────────────────────────────────

class TestLShape:
    def test_area(self):
        # L: patín horizontal + pierna vertical (con corner overlap descontado)
        # A = tf·bf + (d−tf)·tw
        l = LShape(d=500, bf=500, tw=50, tf=50)
        p = compute_geometric_properties(_doc_with(l))
        A_teor = 50 * 500 + (500 - 50) * 50
        assert abs(p.gross_area - A_teor) / A_teor < 1e-9

    def test_L_has_nonzero_Iyz(self):
        # L asimétrica → Ixy ≠ 0
        l = LShape(d=500, bf=500, tw=50, tf=50)
        p = compute_geometric_properties(_doc_with(l))
        assert abs(p.Iyz) > 1e6

    def test_L_principal_axes_nonzero_angle(self):
        l = LShape(d=500, bf=500, tw=50, tf=50)
        p = compute_geometric_properties(_doc_with(l))
        assert abs(p.theta_p_deg) > 5


# ── Doble T ────────────────────────────────────────────────────────────────

class TestDoubleTShape:
    def test_area_typical_prefab(self):
        # Doble T 800×2400 con almas 100×700, spacing 1200
        # A = bf·tf + 2·tw·(d−tf) = 2400·100 + 2·100·700 = 240000 + 140000 = 380000
        dt = DoubleTShape(d=800, bf=2400, tf=100, tw=100, spacing=1200)
        p = compute_geometric_properties(_doc_with(dt))
        A_teor = 2400 * 100 + 2 * 100 * (800 - 100)
        assert abs(p.gross_area - A_teor) / A_teor < 1e-6

    def test_double_t_is_symmetric_z(self):
        # Simetría en z → Iyz ≈ 0
        dt = DoubleTShape(d=800, bf=2400, tf=100, tw=100, spacing=1200)
        p = compute_geometric_properties(_doc_with(dt))
        assert abs(p.Iyz) / dt.d ** 4 < 1e-6
