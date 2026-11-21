"""Tests del modulo de acero estructural: materiales, perfiles y seccion."""
from __future__ import annotations

import math

import pytest

from engine.materials.structural_steel import (
    GRADE_PRESETS,
    StructuralSteelParams,
    get_grade,
    steel_a36,
    steel_a992,
)
from engine.sections.steel_section import SteelFrameSection, make_steel_section
from engine.sections.steel_shapes import (
    AISC_V15_SHAPES,
    IN2_TO_MM2,
    IN3_TO_MM3,
    IN4_TO_MM4,
    IN_TO_MM,
    ShapeType,
    SteelShape,
    get_shape,
    list_shapes,
)


# ─────────────────────────────────────────────────────────────────────────────
# Materiales
# ─────────────────────────────────────────────────────────────────────────────

class TestStructuralSteelMaterials:

    def test_a36_defaults(self):
        m = steel_a36()
        assert m.grade == "A36"
        assert m.fy == 250.0
        assert m.fu == 400.0
        assert m.E0 == 200_000.0
        assert m.G  == 77_000.0

    def test_a992_defaults(self):
        m = steel_a992()
        assert m.grade == "A992"
        assert m.fy == 345.0
        assert m.fu == 450.0

    def test_eps_y_derived(self):
        """eps_y = fy / E0; para A992: 345/200000 = 0.001725."""
        m = steel_a992()
        assert m.eps_y == pytest.approx(345.0 / 200_000.0, rel=1e-6)

    def test_all_grades_registered(self):
        expected = {"A36", "A572Gr50", "A992",
                    "A500GrB-Round", "A500GrC-Rect", "A913Gr65"}
        assert expected == set(GRADE_PRESETS)

    def test_get_grade_lookup(self):
        m = get_grade("A992")
        assert isinstance(m, StructuralSteelParams)
        assert m.fy == 345.0

    def test_get_grade_unknown_raises(self):
        with pytest.raises(KeyError, match="A999"):
            get_grade("A999")


# ─────────────────────────────────────────────────────────────────────────────
# Catalogo de perfiles AISC
# ─────────────────────────────────────────────────────────────────────────────

class TestAISCCatalog:

    def test_w24x55_properties_match_aisc_v15(self):
        """W24X55 — referencia AISC v15.0: A=16.2in^2, Ix=1350in^4, Zx=134in^3.
        Verificamos que la conversion a SI preserva los valores con <0.1 %."""
        s = get_shape("W24X55")
        assert s.type == ShapeType.W
        assert s.A  == pytest.approx(16.2 * IN2_TO_MM2, rel=1e-6)
        assert s.Ix == pytest.approx(1350.0 * IN4_TO_MM4, rel=1e-6)
        assert s.Zx == pytest.approx(134.0 * IN3_TO_MM3, rel=1e-6)
        assert s.Sx == pytest.approx(114.0 * IN3_TO_MM3, rel=1e-6)
        assert s.d  == pytest.approx(23.6 * IN_TO_MM, rel=1e-6)
        assert s.bf == pytest.approx(7.005 * IN_TO_MM, rel=1e-6)

    def test_w14x90_strong_axis_col(self):
        """W14X90 — columna comun. Verifica bf grande (~d) para respuesta biaxial."""
        s = get_shape("W14X90")
        # W14X90 es "column-type" (bf ~ d), inercias similares
        assert s.Iy / s.Ix > 0.3  # Iy/Ix altamente biaxial para columnas W14

    def test_hss8x8x1_2_square(self):
        """HSS8X8X1/2: Ix == Iy, Zx == Zy, J grande."""
        s = get_shape("HSS8X8X1/2")
        assert s.type == ShapeType.HSS_RECT
        assert s.Ix == pytest.approx(s.Iy, rel=1e-9)
        assert s.Zx == pytest.approx(s.Zy, rel=1e-9)
        assert s.J  >  s.Ix  # HSS tiene J grande vs W

    def test_pipe8std_round(self):
        """PIPE8STD: Ix==Iy, OD definido, radio equivalente."""
        s = get_shape("PIPE8STD")
        assert s.type == ShapeType.PIPE
        assert s.Ix == pytest.approx(s.Iy, rel=1e-9)
        assert s.OD > 0

    def test_lookup_case_insensitive(self):
        s1 = get_shape("W24X55")
        s2 = get_shape("w24x55")
        s3 = get_shape(" w24 x 55 ".replace(" ", ""))
        assert s1 is s2 is s3

    def test_list_filters_by_type(self):
        all_names   = list_shapes()
        w_names     = list_shapes(ShapeType.W)
        hss_names   = list_shapes(ShapeType.HSS_RECT)
        pipe_names  = list_shapes(ShapeType.PIPE)
        assert len(all_names) == len(AISC_V15_SHAPES)
        assert all(n.startswith("W") for n in w_names)
        assert all(n.startswith("HSS") for n in hss_names)
        assert all(n.startswith("PIPE") for n in pipe_names)
        assert len(w_names) + len(hss_names) + len(pipe_names) == len(all_names)

    def test_unknown_shape_raises_with_suggestion(self):
        with pytest.raises(KeyError, match="catalogo"):
            get_shape("W999X999")


# ─────────────────────────────────────────────────────────────────────────────
# SteelFrameSection (perfil + grado)
# ─────────────────────────────────────────────────────────────────────────────

class TestSteelFrameSection:

    def test_w24x55_a992_composition(self):
        sec = make_steel_section("W24X55", "A992")
        assert isinstance(sec, SteelFrameSection)
        assert sec.name == "W24X55-A992"
        assert sec.A  == get_shape("W24X55").A
        assert sec.Iz == get_shape("W24X55").Ix  # mapeo Ix(AISC) -> Iz(OpenSees)
        assert sec.Iy == get_shape("W24X55").Iy
        assert sec.E  == 200_000.0

    def test_moment_capacity_w24x55(self):
        """Mp,x = Zx · fy. Para W24X55/A992: Mp = 134in^3 · 50ksi = 6700 kip-in
        = 757 kN·m aprox. En N·mm: ~7.57e8."""
        sec = make_steel_section("W24X55", "A992")
        Mp_kNm = sec.Mp_x / 1e6  # N·mm -> kN·m
        # Esperado ~ 757 kN·m con tolerancia de redondeos de las propiedades AISC
        assert 740.0 < Mp_kNm < 770.0

    def test_yield_force_py(self):
        """Py = A · fy. W24X55/A992: 16.2in^2 · 50ksi = 810 kip = 3603 kN."""
        sec = make_steel_section("W24X55", "A992")
        Py_kN = sec.Py / 1e3
        assert 3550.0 < Py_kN < 3650.0

    def test_hss_with_a500_gr_c(self):
        sec = make_steel_section("HSS8X8X1/2", "A500GrC-Rect")
        assert sec.material.grade == "A500GrC-Rect"
        assert sec.material.fy == 345.0
        # En HSS cuadrado Mp_x == Mp_y
        assert sec.Mp_x == pytest.approx(sec.Mp_y, rel=1e-9)

    def test_default_grade_is_a992(self):
        sec = make_steel_section("W18X35")  # grado omitido
        assert sec.material.grade == "A992"

    def test_biaxial_capacity_ratio(self):
        """Para W14X90 (column-type), Mp_y/Mp_x debe ser > 0.4 (perfil rechoncho)."""
        sec = make_steel_section("W14X90", "A992")
        ratio = sec.Mp_y / sec.Mp_x
        assert 0.4 < ratio < 0.7


# ─────────────────────────────────────────────────────────────────────────────
# Fiber patches (discretizacion OpenSees)
# ─────────────────────────────────────────────────────────────────────────────

class TestFiberPatches:

    def test_w_shape_three_patches(self):
        """W-shape produce 3 patches: top flange, bottom flange, web."""
        sec = make_steel_section("W24X55", "A992")
        patches = sec.patches(mat_tag=1)
        assert len(patches) == 3
        # Todos los patches usan el mismo material
        assert all(p.mat_tag == 1 for p in patches)
        # Area total de patches ≈ area bruta de la seccion (tolerancia ~1%)
        area_sum = 0.0
        for p in patches:
            dy = p.y2 - p.y1
            dz = p.z2 - p.z1
            area_sum += dy * dz
        # La discretizacion simplificada no modela los radios de fillet
        # web-aleta (k-area AISC), que contribuyen ~1-2% del area bruta en
        # perfiles W tipicos. Tolerancia 3%.
        assert abs(area_sum - sec.A) / sec.A < 0.03

    def test_w_shape_patches_symmetric(self):
        """Flange sup e inf de W-shape son simetricos respecto a z=0."""
        sec = make_steel_section("W18X50", "A992")
        patches = sec.patches(mat_tag=1)
        top, bot, web = patches
        # Top y bot tienen misma altura (tf) y mismo ancho (bf)
        assert abs((top.y2 - top.y1) - (bot.y2 - bot.y1)) < 1e-6
        assert abs((top.z2 - top.z1) - (bot.z2 - bot.z1)) < 1e-6
        # Simetria vertical
        assert abs(top.y1 + bot.y2) < 1e-6
        assert abs(top.y2 + bot.y1) < 1e-6
        # Web mas angosto que los flanges
        web_width = web.z2 - web.z1
        flange_width = top.z2 - top.z1
        assert web_width < flange_width

    def test_hss_rect_four_patches(self):
        """HSS rectangular produce 4 strips formando el perimetro hueco."""
        sec = make_steel_section("HSS8X8X1/2", "A500GrC-Rect")
        patches = sec.patches(mat_tag=1)
        assert len(patches) == 4
        # Area total ≈ area bruta (con solape aceptable en las esquinas)
        area_sum = sum((p.y2 - p.y1) * (p.z2 - p.z1) for p in patches)
        # Con mi modelo: strips superior/inferior cubren todo el ancho (bf),
        # y strips laterales solo cubren la zona interna. Debe aproximar A.
        assert abs(area_sum - sec.A) / sec.A < 0.10  # tolerancia 10% por simplificacion

    def test_hss_square_symmetry(self):
        """HSS 8x8 (cuadrado) tiene patches simetricos en y y z."""
        sec = make_steel_section("HSS8X8X1/2", "A500GrC-Rect")
        patches = sec.patches(mat_tag=1)
        top, bot, left, right = patches
        assert abs((top.y2 - top.y1) - (bot.y2 - bot.y1)) < 1e-6
        assert abs((left.z2 - left.z1) - (right.z2 - right.z1)) < 1e-6
        # Simetria vertical (top vs bottom) y horizontal (left vs right)
        assert abs(top.y1 + bot.y2) < 1e-6
        assert abs(left.z1 + right.z2) < 1e-6

    def test_pipe_circular_patch(self):
        """Pipe (HSS redondo) produce 1 patch circular anular."""
        sec = make_steel_section("PIPE8STD", "A500GrB-Round")
        patches = sec.patches(mat_tag=1)
        assert len(patches) == 1
        p = patches[0]
        # r_ext > r_int
        assert p.r_ext > p.r_int > 0
        # Centro en origen
        assert p.y_center == 0.0 and p.z_center == 0.0
        # Area ≈ pi*(r_ext^2 - r_int^2)
        import math
        a_expected = math.pi * (p.r_ext**2 - p.r_int**2)
        assert abs(a_expected - sec.A) / sec.A < 0.02

    def test_mat_tag_propagates(self):
        """El mat_tag pasado se usa en todos los patches."""
        sec = make_steel_section("W24X55", "A992")
        for tag in (1, 7, 42):
            patches = sec.patches(mat_tag=tag)
            assert all(p.mat_tag == tag for p in patches)

    def test_discretization_fiber_counts(self):
        """Los conteos de fibras por default son razonables (>=1)."""
        sec = make_steel_section("W24X55", "A992")
        patches = sec.patches(mat_tag=1)
        for p in patches:
            assert p.nf_y >= 1 and p.nf_z >= 1
