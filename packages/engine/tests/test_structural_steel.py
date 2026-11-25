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
        # `list_shapes()` ahora cubre AISC + europeos (DIN). PTE/PHR son
        # parametricos y NO aparecen. Verificamos que el filtro por tipo
        # funciona y que los prefijos estan bien.
        w_names     = list_shapes(ShapeType.W)
        hss_names   = list_shapes(ShapeType.HSS_RECT)
        pipe_names  = list_shapes(ShapeType.PIPE)
        ipe_names   = list_shapes(ShapeType.IPE)
        hea_names   = list_shapes(ShapeType.HEA)
        all_names   = list_shapes()

        assert all(n.startswith("W")   for n in w_names)
        assert all(n.startswith("HSS") for n in hss_names)
        assert all(n.startswith("PIPE") for n in pipe_names)
        assert all(n.startswith("IPE-") for n in ipe_names)
        assert all(n.startswith("HEA-") for n in hea_names)
        # Total es >= AISC original + los europeos que agregamos.
        assert len(all_names) >= len(AISC_V15_SHAPES) + len(ipe_names) + len(hea_names)

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


# ─────────────────────────────────────────────────────────────────────────────
# Catalogos europeos (IPE / HEA / HEB / HEM)
# ─────────────────────────────────────────────────────────────────────────────

class TestEuropeanCatalog:

    def test_ipe300_dimensiones_din(self):
        """IPE-300 segun DIN 1025-5: h=300, b=150, tw=7.1, tf=10.7, m=42.2 kg/m."""
        s = get_shape("IPE-300")
        assert s.type == ShapeType.IPE
        assert s.d  == 300.0
        assert s.bf == 150.0
        assert abs(s.tw - 7.1)  < 0.01
        assert abs(s.tf - 10.7) < 0.01
        assert abs(s.weight_kgm - 42.2) < 0.5
        # Ix (eje fuerte) ≈ 8356 cm^4 = 8356e4 mm^4
        assert abs(s.Ix - 8356e4) / 8356e4 < 0.01

    def test_hea200_dimensiones_din(self):
        """HEA-200: h=190, b=200, A=53.83 cm², m=42.3 kg/m."""
        s = get_shape("HEA-200")
        assert s.type == ShapeType.HEA
        assert s.d  == 190.0
        assert s.bf == 200.0
        assert abs(s.A - 5383.0) / 5383.0 < 0.01
        assert abs(s.weight_kgm - 42.3) < 0.3

    def test_heb300_pesado(self):
        """HEB-300 es columna estandar: h=b=300, 117 kg/m."""
        s = get_shape("HEB-300")
        assert s.type == ShapeType.HEB
        assert s.d == 300.0 and s.bf == 300.0
        assert abs(s.weight_kgm - 117.0) < 1.0

    def test_hem_se_cargan(self):
        """La serie HEM 100..600 esta disponible."""
        for tag in (100, 200, 300, 400, 600):
            s = get_shape(f"HEM-{tag}")
            assert s.type == ShapeType.HEM

    def test_normalizacion_nombres_europeos(self):
        """Acepta `IPE300`, `IPE 300`, `ipe-300`, etc."""
        a = get_shape("IPE-300")
        b = get_shape("IPE300")
        c = get_shape("ipe 300")
        d = get_shape("ipe-300")
        assert a is b is c is d

    def test_ipe_patches_usan_w_logic(self):
        """IPE/HEA/HEB/HEM reusan la discretizacion de perfil I (3 patches)."""
        sec = make_steel_section("IPE-300", "A992")
        patches = sec.patches(mat_tag=1)
        assert len(patches) == 3  # flange sup, flange inf, alma

    def test_hea_patches_usan_w_logic(self):
        sec = make_steel_section("HEA-200", "A992")
        patches = sec.patches(mat_tag=1)
        assert len(patches) == 3


# ─────────────────────────────────────────────────────────────────────────────
# PTE y PHR parametricos (espesor libre)
# ─────────────────────────────────────────────────────────────────────────────

class TestParametricTubes:

    def test_pte_200x100x5_propiedades(self):
        """PTE-200x100x5: tubo rect. hueco con pared constante t=5 mm.

        A = 200*100 - 190*90 = 20000 - 17100 = 2900 mm².
        Mass = 7850 * 2900e-6 = 22.77 kg/m.
        Ix (eje fuerte, perpendicular a d=200): mayor por canto.
        """
        from engine.sections.steel_shapes import make_pte

        p = make_pte(200.0, 100.0, 5.0)
        assert p.type == ShapeType.PTE
        assert p.name == "PTE-200x100x5"
        assert p.d == 200.0 and p.bf == 100.0 and p.t_des == 5.0
        assert abs(p.A - 2900.0) < 1.0
        assert abs(p.weight_kgm - 22.77) < 0.1
        # Eje fuerte Ix > eje debil Iy (d > b).
        assert p.Ix > p.Iy
        # Zx > Sx (plastico > elastico, siempre).
        assert p.Zx > p.Sx

    def test_phr_100x3_propiedades(self):
        """PHR-100x3: tubo circular hueco OD=100, t=3 mm."""
        from engine.sections.steel_shapes import make_phr
        import math as m

        p = make_phr(100.0, 3.0)
        assert p.type == ShapeType.PHR
        assert p.name == "PHR-100x3"
        assert p.OD == 100.0 and p.t_des == 3.0
        # A = pi/4 * (100^2 - 94^2) = pi/4 * (10000 - 8836) = pi/4 * 1164
        A_expected = m.pi * (100.0**2 - 94.0**2) / 4.0
        assert abs(p.A - A_expected) < 0.1
        # J = 2 * I para seccion circular
        assert abs(p.J - 2.0 * p.Ix) / p.J < 1e-6
        # Ix == Iy por simetria axial
        assert abs(p.Ix - p.Iy) < 1e-6

    def test_phr_decimal_thickness(self):
        """PHR acepta espesor 2.5 mm (default Perfitec)."""
        from engine.sections.steel_shapes import make_phr
        p = make_phr(75.0, 2.5)
        assert p.name == "PHR-75x2.5"
        assert p.t_des == 2.5

    def test_pte_rechaza_espesor_invalido(self):
        """PTE con 2t >= lado menor se rechaza."""
        from engine.sections.steel_shapes import make_pte
        with pytest.raises(ValueError, match="espesor"):
            make_pte(100.0, 50.0, 30.0)  # 2*30 = 60 > 50

    def test_phr_rechaza_espesor_invalido(self):
        """PHR con 2t >= OD se rechaza."""
        from engine.sections.steel_shapes import make_phr
        with pytest.raises(ValueError, match="espesor"):
            make_phr(50.0, 30.0)

    def test_pte_patches_son_hss_rect(self):
        """PTE reusa la discretizacion HSS rect (4 strips perimetrales)."""
        from engine.sections.steel_section import make_pte_section
        sec = make_pte_section(200.0, 100.0, 5.0)
        patches = sec.patches(mat_tag=1)
        assert len(patches) == 4

    def test_phr_patches_son_pipe(self):
        """PHR reusa la discretizacion Pipe (1 patch circular anular)."""
        from engine.sections.steel_section import make_phr_section
        sec = make_phr_section(100.0, 3.0)
        patches = sec.patches(mat_tag=1)
        assert len(patches) == 1

    def test_pte_section_capacidades(self):
        """Mp y Py de PTE deben ser positivos y plausibles (fy A500GrC = 345 MPa)."""
        from engine.sections.steel_section import make_pte_section
        sec = make_pte_section(200.0, 100.0, 5.0, grade="A500GrC-Rect")
        assert sec.Py > 0 and sec.Mp_x > 0
        # Py = A * fy → 2900 mm² * 345 MPa = 1000.5 kN
        assert abs(sec.Py - 2900.0 * 345.0) / sec.Py < 0.01
