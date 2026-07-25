"""Geometria de secciones -> especificaciones declarativas de patches/layers de fibra.

Este modulo NO importa OpenSeesPy: solo calcula geometria (dimensiones de nucleo,
coordenadas de parches). La traduccion a llamadas reales `ops.patch(...)` /
`ops.layer(...)` vive en `engine.analysis.interaction`, que es el unico punto del
motor que toca OpenSees. Asi la geometria se puede probar de forma aislada.

Convencion de ejes locales: y = eje de flexion (eje fuerte analizado, vertical),
z = eje perpendicular (horizontal). Origen en el centroide de la seccion bruta.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field


@dataclass(frozen=True)
class RectPatchSpec:
    mat_tag: int
    nf_y: int
    nf_z: int
    y1: float
    z1: float
    y2: float
    z2: float


@dataclass(frozen=True)
class CircPatchSpec:
    mat_tag: int
    nf_circ: int
    nf_rad: int
    y_center: float
    z_center: float
    r_int: float
    r_ext: float
    ang: tuple[float, float] = (0.0, 360.0)


@dataclass(frozen=True)
class PointFiberSpec:
    """Fibra individual explicita (fibras de concreto en PolygonSection y todas las barras)."""

    mat_tag: int
    y: float
    z: float
    area: float


class RectangularSection:
    """Seccion rectangular (o cuadrada si width == height). y = altura, z = ancho."""

    def __init__(
        self,
        width: float,
        height: float,
        cover: float,
        nf_core: tuple[int, int] = (16, 16),
        nf_cover: tuple[int, int] = (16, 4),
    ):
        self.width = width
        self.height = height
        self.cover = cover
        self.nf_core = nf_core
        self.nf_cover = nf_cover

    @property
    def gross_area(self) -> float:
        return self.width * self.height

    @property
    def core_width(self) -> float:
        return self.width - 2 * self.cover

    @property
    def core_height(self) -> float:
        return self.height - 2 * self.cover

    @property
    def core_area(self) -> float:
        return self.core_width * self.core_height

    def patches(self, core_mat_tag: int, cover_mat_tag: int) -> tuple[RectPatchSpec, list[RectPatchSpec]]:
        hh, hw = self.height / 2, self.width / 2
        ch, cw = self.core_height / 2, self.core_width / 2

        core = RectPatchSpec(core_mat_tag, self.nf_core[0], self.nf_core[1], -ch, -cw, ch, cw)
        cover_patches = [
            RectPatchSpec(cover_mat_tag, self.nf_cover[1], self.nf_core[1], ch, -cw, hh, cw),    # franja superior
            RectPatchSpec(cover_mat_tag, self.nf_cover[1], self.nf_core[1], -hh, -cw, -ch, cw),  # franja inferior
            RectPatchSpec(cover_mat_tag, self.nf_core[0], self.nf_cover[1], -hh, cw, hh, hw),    # franja derecha (incl. esquinas)
            RectPatchSpec(cover_mat_tag, self.nf_core[0], self.nf_cover[1], -hh, -hw, hh, -cw),  # franja izquierda (incl. esquinas)
        ]
        return core, cover_patches


class CircularSection:
    """Seccion circular. y, z = ejes horizontales del plano de la seccion."""

    def __init__(
        self,
        diameter: float,
        cover: float,
        nf_circ: int = 24,
        nf_rad_core: int = 12,
        nf_rad_cover: int = 4,
    ):
        self.diameter = diameter
        self.cover = cover
        self.nf_circ = nf_circ
        self.nf_rad_core = nf_rad_core
        self.nf_rad_cover = nf_rad_cover

    @property
    def gross_area(self) -> float:
        return math.pi * (self.diameter / 2) ** 2

    @property
    def core_diameter(self) -> float:
        return self.diameter - 2 * self.cover

    @property
    def core_area(self) -> float:
        return math.pi * (self.core_diameter / 2) ** 2

    def patches(self, core_mat_tag: int, cover_mat_tag: int) -> tuple[CircPatchSpec, list[CircPatchSpec]]:
        core = CircPatchSpec(core_mat_tag, self.nf_circ, self.nf_rad_core, 0.0, 0.0, 0.0, self.core_diameter / 2)
        cover_patches = [
            CircPatchSpec(cover_mat_tag, self.nf_circ, self.nf_rad_cover, 0.0, 0.0,
                          self.core_diameter / 2, self.diameter / 2)
        ]
        return core, cover_patches


class PolygonSection:
    """Seccion de forma especial (poligono arbitrario, convexo o no).

    Discretiza el poligono en una malla rectangular regular y clasifica cada celda
    dentro/fuera con un test punto-en-poligono (ray casting), generando fibras
    explicitas en vez de patches nativos de OpenSees (que no soportan poligonos
    arbitrarios). Simplificacion v1: un solo material para todo el poligono (sin
    separacion nucleo/recubrimiento); si se requiere confinamiento diferenciado,
    pasar tambien `core_vertices` para un poligono interior de nucleo.
    """

    def __init__(self, vertices: list[tuple[float, float]], core_vertices: list[tuple[float, float]] | None = None,
                 mesh_size: float = 10.0):
        self.vertices = vertices
        self.core_vertices = core_vertices
        self.mesh_size = mesh_size

    @staticmethod
    def _point_in_polygon(y: float, z: float, poly: list[tuple[float, float]]) -> bool:
        inside = False
        n = len(poly)
        y1, z1 = poly[-1]
        for i in range(n):
            y2, z2 = poly[i]
            if ((z1 > z) != (z2 > z)) and (y < (y2 - y1) * (z - z1) / (z2 - z1) + y1):
                inside = not inside
            y1, z1 = y2, z2
        return inside

    @staticmethod
    def _polygon_area(poly: list[tuple[float, float]]) -> float:
        area = 0.0
        n = len(poly)
        for i in range(n):
            y1, z1 = poly[i]
            y2, z2 = poly[(i + 1) % n]
            area += y1 * z2 - y2 * z1
        return abs(area) / 2

    @property
    def gross_area(self) -> float:
        return self._polygon_area(self.vertices)

    @property
    def core_area(self) -> float:
        return self._polygon_area(self.core_vertices) if self.core_vertices else self.gross_area

    def fibers(self, core_mat_tag: int, cover_mat_tag: int) -> list[PointFiberSpec]:
        ys = [p[0] for p in self.vertices]
        zs = [p[1] for p in self.vertices]
        y_min, y_max = min(ys), max(ys)
        z_min, z_max = min(zs), max(zs)

        cell = self.mesh_size
        cell_area = cell * cell
        fibers: list[PointFiberSpec] = []

        y = y_min + cell / 2
        while y < y_max:
            z = z_min + cell / 2
            while z < z_max:
                if self._point_in_polygon(y, z, self.vertices):
                    mat_tag = core_mat_tag
                    if self.core_vertices and not self._point_in_polygon(y, z, self.core_vertices):
                        mat_tag = cover_mat_tag
                    fibers.append(PointFiberSpec(mat_tag, y, z, cell_area))
                z += cell
            y += cell
        return fibers
