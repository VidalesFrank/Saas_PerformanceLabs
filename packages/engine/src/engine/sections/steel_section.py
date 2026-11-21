"""Seccion metalica (perfil AISC + grado de acero) — envoltura para el motor.

Reune un `SteelShape` del catalogo y un `StructuralSteelParams` para producir
una seccion con propiedades listas para:
    1. Elemento elastico (elasticBeamColumn) — basta con A, Iy, Iz, J, E, G.
    2. Rotula bilineal concentrada (lumped plasticity) — Zx, Zy, fy, Mp.
    3. Fiber section (distribuida) — patches W/HSS/Pipe discretizados.

Esta clase NO importa OpenSeesPy: solo produce la especificacion. La traduccion
a `ops.element/section/fiber` vive en el adaptador OpenSees del edificio.

Unidades consistentes con el resto del motor: N, mm, MPa.
"""
from __future__ import annotations

from dataclasses import dataclass

from engine.materials.structural_steel import StructuralSteelParams, get_grade
from engine.sections.geometry import CircPatchSpec, RectPatchSpec
from engine.sections.steel_shapes import (
    AISC_V15_SHAPES, SteelShape, ShapeType, get_shape,
)


@dataclass(frozen=True)
class SteelFrameSection:
    """Seccion de miembro en acero (perfil + grado).

    Las propiedades estan expuestas a nivel de instancia (no via el shape
    envuelto) para que el adaptador OpenSees pueda consumirlas directamente
    sin saber de donde vienen.
    """

    shape: SteelShape
    material: StructuralSteelParams

    # ── Identidad ──────────────────────────────────────────────────────────
    @property
    def name(self) -> str:
        return f"{self.shape.name}-{self.material.grade}"

    @property
    def type(self) -> ShapeType:
        return self.shape.type

    # ── Propiedades para OpenSees elasticBeamColumn ────────────────────────
    @property
    def A(self) -> float:
        """Area bruta [mm^2]."""
        return self.shape.A

    @property
    def Iy(self) -> float:
        """Inercia eje debil [mm^4] (en ejes locales OpenSees: Iy)."""
        return self.shape.Iy

    @property
    def Iz(self) -> float:
        """Inercia eje fuerte [mm^4] (en ejes locales OpenSees: Iz).

        Nota de convencion: AISC usa Ix = fuerte, Iy = debil. OpenSees usa
        Iz = eje perpendicular al eje local z (fuerte en vigas), Iy = debil.
        Aqui mapeamos Ix(AISC) -> Iz(OpenSees), Iy(AISC) -> Iy(OpenSees).
        """
        return self.shape.Ix

    @property
    def J(self) -> float:
        """Constante torsional [mm^4]."""
        return self.shape.J

    @property
    def E(self) -> float:
        """Modulo de elasticidad del material [MPa]."""
        return self.material.E0

    @property
    def G(self) -> float:
        """Modulo de cortante del material [MPa]."""
        return self.material.G

    # ── Propiedades para disenno NSR-10 F.2 / AISC 360-16 ──────────────────
    @property
    def Zx(self) -> float:
        """Modulo plastico eje fuerte [mm^3]."""
        return self.shape.Zx

    @property
    def Zy(self) -> float:
        """Modulo plastico eje debil [mm^3]."""
        return self.shape.Zy

    @property
    def Sx(self) -> float:
        """Modulo elastico eje fuerte [mm^3]."""
        return self.shape.Sx

    @property
    def Sy(self) -> float:
        """Modulo elastico eje debil [mm^3]."""
        return self.shape.Sy

    @property
    def Mp_x(self) -> float:
        """Momento plastico eje fuerte [N·mm] = Zx · fy (AISC F2.1)."""
        return self.shape.Zx * self.material.fy

    @property
    def Mp_y(self) -> float:
        """Momento plastico eje debil [N·mm] = Zy · fy."""
        return self.shape.Zy * self.material.fy

    @property
    def My_x(self) -> float:
        """Momento de fluencia elastico eje fuerte [N·mm] = Sx · fy."""
        return self.shape.Sx * self.material.fy

    @property
    def My_y(self) -> float:
        """Momento de fluencia elastico eje debil [N·mm] = Sy · fy."""
        return self.shape.Sy * self.material.fy

    @property
    def Py(self) -> float:
        """Fuerza axial de fluencia [N] = A · fy (AISC D2)."""
        return self.shape.A * self.material.fy

    # ── Discretizacion en fibras (OpenSees fiber section) ──────────────────
    def patches(
        self, mat_tag: int, *,
        nf_flange_width: int = 16, nf_flange_thick: int = 2,
        nf_web_depth:    int = 16, nf_web_thick:    int = 2,
        nf_hss_long:     int = 8,  nf_hss_thick:    int = 1,
        nf_circ:         int = 24, nf_rad:          int = 3,
    ) -> list[RectPatchSpec] | list[CircPatchSpec]:
        """Discretiza la seccion metalica en patches de fibra OpenSees.

        Convencion: eje y = depth (strong), eje z = width (weak). Origen en el
        centroide. Un solo material (homogeneo) con `mat_tag`.

        Para W-shape (I): 2 flanges + web. Para HSS rectangular: 4 strips
        formando el perimetro hueco. Para Pipe: patch circular anular.

        Para L, C, WT, S/M/HP, 2L: no soportado todavia — falla con ValueError.
        """
        s = self.shape
        if s.type == ShapeType.W:
            return self._w_patches(mat_tag, nf_flange_width, nf_flange_thick,
                                   nf_web_depth, nf_web_thick)
        if s.type == ShapeType.HSS_RECT:
            return self._hss_rect_patches(mat_tag, nf_hss_long, nf_hss_thick)
        if s.type in (ShapeType.HSS_ROUND, ShapeType.PIPE):
            return self._pipe_patches(mat_tag, nf_circ, nf_rad)
        raise ValueError(
            f"Discretizacion en fibras no soportada para tipo '{s.type.value}'"
        )

    def _w_patches(
        self, mat: int, nfw: int, nft: int, nwd: int, nwt: int,
    ) -> list[RectPatchSpec]:
        d, bf, tf, tw = self.shape.d, self.shape.bf, self.shape.tf, self.shape.tw
        hd, hb = d / 2.0, bf / 2.0
        hw_core = (d - 2 * tf) / 2.0
        htw = tw / 2.0
        # y = depth (strong), z = width (weak). Signature RectPatchSpec:
        # (mat, nf_y, nf_z, y1, z1, y2, z2)
        return [
            # Flange superior
            RectPatchSpec(mat, nft, nfw, hw_core,  -hb, hd,      hb),
            # Flange inferior
            RectPatchSpec(mat, nft, nfw, -hd,     -hb, -hw_core, hb),
            # Alma
            RectPatchSpec(mat, nwd, nwt, -hw_core, -htw, hw_core, htw),
        ]

    def _hss_rect_patches(
        self, mat: int, nfl: int, nft: int,
    ) -> list[RectPatchSpec]:
        d, bf = self.shape.d, self.shape.bf   # lado largo (y), lado corto (z)
        t = self.shape.t_des
        hd, hb = d / 2.0, bf / 2.0
        hd_in = hd - t
        hb_in = hb - t
        return [
            # Strip superior (horizontal): y ∈ (hd-t, hd)
            RectPatchSpec(mat, nft, nfl, hd_in,  -hb, hd,    hb),
            # Strip inferior: y ∈ (-hd, -hd+t)
            RectPatchSpec(mat, nft, nfl, -hd,    -hb, -hd_in, hb),
            # Strip izquierdo (vertical): z ∈ (-hb, -hb+t)
            RectPatchSpec(mat, nfl, nft, -hd_in, -hb, hd_in,  -hb_in),
            # Strip derecho: z ∈ (hb-t, hb)
            RectPatchSpec(mat, nfl, nft, -hd_in, hb_in, hd_in, hb),
        ]

    def _pipe_patches(
        self, mat: int, nf_circ: int, nf_rad: int,
    ) -> list[CircPatchSpec]:
        OD = self.shape.OD
        t  = self.shape.t_des
        r_ext = OD / 2.0
        r_int = r_ext - t
        return [
            CircPatchSpec(mat, nf_circ, nf_rad, 0.0, 0.0, r_int, r_ext),
        ]


# ─────────────────────────────────────────────────────────────────────────────
# Fabricas
# ─────────────────────────────────────────────────────────────────────────────

def make_steel_section(shape_name: str, grade: str = "A992") -> SteelFrameSection:
    """Combina un perfil del catalogo AISC con un grado de acero.

    Ejemplos:
        make_steel_section("W24X55")               # W24x55 en A992
        make_steel_section("HSS8X8X1/2", "A500GrC-Rect")
    """
    return SteelFrameSection(shape=get_shape(shape_name), material=get_grade(grade))


def available_shapes(shape_type: ShapeType | None = None) -> list[str]:
    """Pass-through conveniente para la UI."""
    if shape_type is None:
        return sorted(AISC_V15_SHAPES)
    return sorted(k for k, s in AISC_V15_SHAPES.items() if s.type == shape_type)
