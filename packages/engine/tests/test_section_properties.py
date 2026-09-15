"""Tests de propiedades geométricas contra fórmulas cerradas conocidas.

Casos validados:
  - Rectángulo 400×600: A, Iy, Iz, Zp, S
  - Cuadrado 400×400: simetría (Iy = Iz, Zpy = Zpz)
  - Círculo sólido D=500: fórmulas exactas
  - Círculo hueco D=500 di=200: anillo
  - Rectángulo trasladado y no centrado en origen (verifica centroide + Steiner)
  - Sección L (asimétrica): Iyz ≠ 0, ejes principales
  - Sección con barras: contribución de As al momento

Fórmulas de referencia:
  Rectángulo b×h:
    A = b·h
    Iz = b·h³/12  (respecto al eje z centroidal)
    Iy = h·b³/12
    Sz = b·h²/6, Zpz = b·h²/4
    Factor de forma = Zpz/Sz = 3/2 = 1.5

  Círculo D:
    A = π·D²/4
    Iy = Iz = π·D⁴/64
    Sy = Sz = π·D³/32
    Zpy = Zpz = D³/6
    Factor de forma = (D³/6) / (π·D³/32) = 16/(3π) ≈ 1.698
"""
import math
import pytest

from engine.sections.document import (
    CircShape, ConcreteDef, ConcreteRegion, PolygonShape,
    RectShape, ReinforcementBar, SectionDocument, SteelDef,
)
from engine.sections.section_properties import compute_geometric_properties


# ── Helpers ──────────────────────────────────────────────────────────────────

def _rect_section(width: float, height: float, y: float = 0.0, z: float = 0.0) -> SectionDocument:
    """Sección rectangular sin barras."""
    c = ConcreteDef(fpc=28.0)
    return SectionDocument(
        concrete_defs=[c],
        regions=[ConcreteRegion(
            shape=RectShape(y=y, z=z, height=height, width=width),
            concrete_id=c.id,
        )],
    )


def _circ_section(D: float, di: float = 0.0) -> SectionDocument:
    c = ConcreteDef(fpc=28.0)
    return SectionDocument(
        concrete_defs=[c],
        regions=[ConcreteRegion(
            shape=CircShape(radius=D / 2, radius_inner=di / 2),
            concrete_id=c.id,
        )],
    )


# ── Tests: rectángulo centrado ──────────────────────────────────────────────

class TestRectangle:
    def test_area_400x600(self):
        doc = _rect_section(width=400, height=600)
        p = compute_geometric_properties(doc)
        assert abs(p.gross_area - 400 * 600) / (400 * 600) < 1e-10

    def test_centroid_at_origin(self):
        doc = _rect_section(width=400, height=600)
        p = compute_geometric_properties(doc)
        assert abs(p.centroid_y) < 1e-8
        assert abs(p.centroid_z) < 1e-8

    def test_Iz_400x600(self):
        # Iz (flexión sobre y) = b·h³/12 = 400·600³/12
        doc = _rect_section(width=400, height=600)
        p = compute_geometric_properties(doc)
        Iz_teor = 400 * 600 ** 3 / 12
        assert abs(p.Iz - Iz_teor) / Iz_teor < 1e-10

    def test_Iy_400x600(self):
        # Iy = h·b³/12 = 600·400³/12
        doc = _rect_section(width=400, height=600)
        p = compute_geometric_properties(doc)
        Iy_teor = 600 * 400 ** 3 / 12
        assert abs(p.Iy - Iy_teor) / Iy_teor < 1e-10

    def test_Sz_400x600(self):
        # S = b·h²/6
        doc = _rect_section(width=400, height=600)
        p = compute_geometric_properties(doc)
        S_teor = 400 * 600 ** 2 / 6
        assert abs(p.Sz_pos - S_teor) / S_teor < 1e-8
        assert abs(p.Sz_neg - S_teor) / S_teor < 1e-8

    def test_Zpz_400x600(self):
        # Zpz = b·h²/4 = 400·600²/4
        doc = _rect_section(width=400, height=600)
        p = compute_geometric_properties(doc)
        Zpz_teor = 400 * 600 ** 2 / 4
        assert abs(p.Zpz - Zpz_teor) / Zpz_teor < 1e-3

    def test_form_factor_15_for_rect(self):
        # Zp/S = 3/2 para rectángulo
        doc = _rect_section(width=300, height=500)
        p = compute_geometric_properties(doc)
        assert abs(p.fs_z - 1.5) < 0.005

    def test_Iyz_zero_for_symmetric(self):
        # Rectángulo centrado: Iyz = 0 por simetría
        doc = _rect_section(width=400, height=600)
        p = compute_geometric_properties(doc)
        assert abs(p.Iyz) / (400 * 600 ** 2) < 1e-10

    def test_theta_principal_zero(self):
        doc = _rect_section(width=400, height=600)
        p = compute_geometric_properties(doc)
        assert abs(p.theta_p_deg) < 1e-6


# ── Tests: cuadrado (simetría) ───────────────────────────────────────────────

class TestSquare:
    def test_Iy_equals_Iz(self):
        doc = _rect_section(width=400, height=400)
        p = compute_geometric_properties(doc)
        assert abs(p.Iy - p.Iz) / p.Iy < 1e-10

    def test_Zpy_equals_Zpz(self):
        doc = _rect_section(width=400, height=400)
        p = compute_geometric_properties(doc)
        assert abs(p.Zpy - p.Zpz) / p.Zpy < 1e-3

    def test_rx_equals_ry(self):
        doc = _rect_section(width=400, height=400)
        p = compute_geometric_properties(doc)
        assert abs(p.ry - p.rz) / p.ry < 1e-10


# ── Tests: círculo sólido ────────────────────────────────────────────────────

class TestCircleSolid:
    def test_area_D500(self):
        doc = _circ_section(D=500)
        p = compute_geometric_properties(doc)
        A_teor = math.pi * 500 ** 2 / 4
        assert abs(p.gross_area - A_teor) / A_teor < 1e-10

    def test_Iy_equals_Iz_D500(self):
        doc = _circ_section(D=500)
        p = compute_geometric_properties(doc)
        I_teor = math.pi * 500 ** 4 / 64
        assert abs(p.Iy - I_teor) / I_teor < 1e-10
        assert abs(p.Iz - I_teor) / I_teor < 1e-10

    def test_Sz_D500(self):
        doc = _circ_section(D=500)
        p = compute_geometric_properties(doc)
        S_teor = math.pi * 500 ** 3 / 32
        assert abs(p.Sz_pos - S_teor) / S_teor < 1e-8

    def test_Zpz_D500(self):
        # Zp = D³/6 para círculo sólido
        doc = _circ_section(D=500)
        p = compute_geometric_properties(doc)
        Zp_teor = 500 ** 3 / 6
        # Círculo discretizado con 64 lados → error ~0.5%
        assert abs(p.Zpz - Zp_teor) / Zp_teor < 0.01

    def test_form_factor_circle(self):
        # Zp/S = 16/(3π) ≈ 1.698 para círculo sólido
        doc = _circ_section(D=500)
        p = compute_geometric_properties(doc)
        fs_teor = 16.0 / (3.0 * math.pi)
        assert abs(p.fs_z - fs_teor) / fs_teor < 0.02


# ── Tests: círculo hueco (anillo) ────────────────────────────────────────────

class TestCircleHollow:
    def test_area_ring(self):
        doc = _circ_section(D=500, di=200)
        p = compute_geometric_properties(doc)
        A_teor = math.pi * (500 ** 2 - 200 ** 2) / 4
        assert abs(p.gross_area - A_teor) / A_teor < 1e-10

    def test_Iz_ring(self):
        doc = _circ_section(D=500, di=200)
        p = compute_geometric_properties(doc)
        I_teor = math.pi * (500 ** 4 - 200 ** 4) / 64
        assert abs(p.Iz - I_teor) / I_teor < 1e-10


# ── Tests: rectángulo trasladado (Steiner) ──────────────────────────────────

class TestSteinerTranslation:
    def test_centroid_at_offset(self):
        # Rectángulo con centro en (100, 200): centroide debe ser (100, 200)
        doc = _rect_section(width=300, height=400, y=100, z=200)
        p = compute_geometric_properties(doc)
        assert abs(p.centroid_y - 100) < 1e-6
        assert abs(p.centroid_z - 200) < 1e-6

    def test_Iz_at_offset_invariant(self):
        # Iz centroidal debe ser el mismo con o sin traslación
        doc1 = _rect_section(width=300, height=400)
        doc2 = _rect_section(width=300, height=400, y=1500, z=-700)  # muy trasladada
        p1 = compute_geometric_properties(doc1)
        p2 = compute_geometric_properties(doc2)
        assert abs(p1.Iz - p2.Iz) / p1.Iz < 1e-8


# ── Tests: sección L (asimétrica, ejes principales) ─────────────────────────

class TestLShape:
    def _l_shape_doc(self) -> SectionDocument:
        # Sección L: 400×400 externa − hueco 300×300 en esquina superior derecha
        # Rectángulo grande centrado en (0, 0), 400×400
        # Hueco: 300×300 centrado en (50, 50) — esto deja una L
        c = ConcreteDef(fpc=28.0)
        return SectionDocument(
            concrete_defs=[c],
            regions=[
                ConcreteRegion(shape=RectShape(y=0, z=0, height=400, width=400), concrete_id=c.id),
                ConcreteRegion(shape=RectShape(y=50, z=50, height=300, width=300), concrete_id=c.id, is_void=True),
            ],
        )

    def test_area_L(self):
        p = compute_geometric_properties(self._l_shape_doc())
        A_teor = 400 * 400 - 300 * 300
        assert abs(p.gross_area - A_teor) / A_teor < 1e-10

    def test_L_has_Iyz_nonzero(self):
        p = compute_geometric_properties(self._l_shape_doc())
        # L asimétrica → producto de inercia distinto de 0
        assert abs(p.Iyz) > 1e6

    def test_L_principal_axes(self):
        # Los ejes principales de la L 400/300 deben rotar ~45° (por simetría diagonal)
        p = compute_geometric_properties(self._l_shape_doc())
        # No tiene que ser exactamente 45° (L asimétrica), pero sí sensiblemente lejos de 0
        assert 10 < abs(p.theta_p_deg) < 80


# ── Tests: sección con barras (ρg y contribución al I) ──────────────────────

class TestBars:
    def test_rho_g_400x400_8_num8(self):
        # Columna 400×400 con 8 barras #8 (Ab = 510 mm²) → ρg = 4080 / 160000 = 2.55 %
        c = ConcreteDef(fpc=28.0)
        s = SteelDef(fy=420.0)
        cover = 40
        # 8 barras: 4 esquinas + 4 medios lados
        y_e = 200 - cover
        bars = [
            ReinforcementBar(y= y_e, z= y_e, bar_size="#8", steel_id=s.id),
            ReinforcementBar(y= y_e, z=-y_e, bar_size="#8", steel_id=s.id),
            ReinforcementBar(y=-y_e, z= y_e, bar_size="#8", steel_id=s.id),
            ReinforcementBar(y=-y_e, z=-y_e, bar_size="#8", steel_id=s.id),
            ReinforcementBar(y= y_e, z=0.0, bar_size="#8", steel_id=s.id),
            ReinforcementBar(y=-y_e, z=0.0, bar_size="#8", steel_id=s.id),
            ReinforcementBar(y=0.0, z= y_e, bar_size="#8", steel_id=s.id),
            ReinforcementBar(y=0.0, z=-y_e, bar_size="#8", steel_id=s.id),
        ]
        doc = SectionDocument(
            concrete_defs=[c], steel_defs=[s],
            regions=[ConcreteRegion(shape=RectShape(height=400, width=400), concrete_id=c.id)],
            bars=bars,
        )
        p = compute_geometric_properties(doc)
        assert abs(p.steel_area - 8 * 510) < 1
        assert 0.024 < p.rho_g < 0.027

    def test_bars_contribute_to_Iz(self):
        # Sin barras vs con barras a distancia extrema: Iz debe crecer
        c = ConcreteDef(fpc=28.0)
        s = SteelDef(fy=420.0)
        doc_a = SectionDocument(
            concrete_defs=[c],
            regions=[ConcreteRegion(shape=RectShape(height=400, width=400), concrete_id=c.id)],
        )
        doc_b = SectionDocument(
            concrete_defs=[c], steel_defs=[s],
            regions=[ConcreteRegion(shape=RectShape(height=400, width=400), concrete_id=c.id)],
            bars=[
                ReinforcementBar(y= 160, z= 160, bar_size="#10", steel_id=s.id),
                ReinforcementBar(y=-160, z=-160, bar_size="#10", steel_id=s.id),
                ReinforcementBar(y= 160, z=-160, bar_size="#10", steel_id=s.id),
                ReinforcementBar(y=-160, z= 160, bar_size="#10", steel_id=s.id),
            ],
        )
        pa = compute_geometric_properties(doc_a)
        pb = compute_geometric_properties(doc_b)
        assert pb.Iz > pa.Iz


# ── Test: sección vacía ──────────────────────────────────────────────────────

def test_empty_section():
    doc = SectionDocument()
    p = compute_geometric_properties(doc)
    assert p.gross_area == 0.0
    assert p.Iz == 0.0
    assert p.Zpz == 0.0
