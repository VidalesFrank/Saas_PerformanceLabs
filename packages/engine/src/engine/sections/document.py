"""Modelo de datos canónico de una sección de concreto reforzado.

SectionDocument es el objeto central del Módulo 2 — Section Engineering.
Contiene la geometría completa, materiales y refuerzo necesarios para
cualquier análisis (P-M, M-φ, P-M-M, etc.).

Unidades internas: mm, N, MPa  (igual que el resto del motor).
Convención de ejes: y = dirección de flexión (vertical), z = perpendicular.
"""
from __future__ import annotations

import math
import uuid
from dataclasses import dataclass, field
from typing import Literal


def _new_id() -> str:
    return str(uuid.uuid4())[:8]


# ──────────────────────────────────────────────────────────────
# Formas de región (geometría nativa del editor)
# ──────────────────────────────────────────────────────────────

@dataclass
class RectShape:
    """Región rectangular (puede estar rotada)."""
    kind: Literal["rect"] = "rect"
    y: float = 0.0          # coordenada del centroide, mm
    z: float = 0.0
    height: float = 400.0   # dimensión en y, mm
    width: float = 400.0    # dimensión en z, mm
    angle_deg: float = 0.0  # rotación en grados (0 = sin rotar)

    def to_polygon(self) -> list[tuple[float, float]]:
        """Vértices del rectángulo como polígono, en sentido antihorario."""
        h2, w2 = self.height / 2, self.width / 2
        corners = [(-h2, -w2), (h2, -w2), (h2, w2), (-h2, w2)]
        if abs(self.angle_deg) > 1e-6:
            a = math.radians(self.angle_deg)
            c, s = math.cos(a), math.sin(a)
            corners = [(self.y + c * dy - s * dz, self.z + s * dy + c * dz)
                       for dy, dz in corners]
        else:
            corners = [(self.y + dy, self.z + dz) for dy, dz in corners]
        return corners


@dataclass
class CircShape:
    """Región circular (anillo sólido o hueco)."""
    kind: Literal["circ"] = "circ"
    y: float = 0.0          # centro, mm
    z: float = 0.0
    radius: float = 200.0   # radio exterior, mm
    radius_inner: float = 0.0  # radio interior (0 = sólido)


@dataclass
class PolygonShape:
    """Región definida por polígono arbitrario."""
    kind: Literal["poly"] = "poly"
    vertices: list[tuple[float, float]] = field(default_factory=list)  # (y, z) en mm


RegionShape = RectShape | CircShape | PolygonShape


# ──────────────────────────────────────────────────────────────
# Definiciones de confinamiento
# ──────────────────────────────────────────────────────────────

@dataclass
class RectConfinementDef:
    """Confinamiento por estribos rectangulares (Mander 1988)."""
    kind: Literal["rect"] = "rect"
    hoop_bar_size: str = "#3"   # tamaño de estribo
    spacing: float = 150.0      # espaciamiento c/c, mm
    legs_x: int = 2             # ramas que restringen dirección z
    legs_y: int = 2             # ramas que restringen dirección y
    fyh: float | None = None    # MPa; None → usar fy del acero principal


@dataclass
class CircConfinementDef:
    """Confinamiento por espiral o estribos circulares (Mander 1988)."""
    kind: Literal["circ"] = "circ"
    hoop_bar_size: str = "#3"
    spacing: float = 100.0
    is_spiral: bool = True
    fyh: float | None = None


ConfinementDef = RectConfinementDef | CircConfinementDef


# ──────────────────────────────────────────────────────────────
# Definiciones de materiales (biblioteca interna de la sección)
# ──────────────────────────────────────────────────────────────

@dataclass
class ConcreteDef:
    id: str = field(default_factory=_new_id)
    label: str = "Concreto"
    fpc: float = 28.0       # MPa — resistencia característica a compresión
    eco: float = 0.002      # deformación unitaria en resistencia máxima


@dataclass
class SteelDef:
    id: str = field(default_factory=_new_id)
    label: str = "Acero"
    fy: float = 420.0       # MPa — fluencia
    Es: float = 200_000.0   # MPa — módulo de elasticidad
    b: float = 0.01         # razón de endurecimiento por deformación


# ──────────────────────────────────────────────────────────────
# Regiones de concreto y barras
# ──────────────────────────────────────────────────────────────

@dataclass
class ConcreteRegion:
    """Una zona de concreto con geometría, material y confinamiento propios.

    Para secciones simples (columna rectangular):
    - Una región cubre toda la sección.
    - confinement define los estribos.
    - cover_to_bar define el recubrimiento (distancia cara → centroide barra).

    Para secciones compuestas (T, L, cajón):
    - Múltiples regiones, cada una con sus propios parámetros.
    - Las regiones con is_void=True son huecos (se restan del área).
    """
    id: str = field(default_factory=_new_id)
    label: str = "Región"
    shape: RegionShape = field(default_factory=RectShape)
    concrete_id: str = ""
    confinement: ConfinementDef | None = None
    cover_to_bar: float = 0.0   # mm — distancia cara exterior → centroide barra longitudinal
    is_void: bool = False
    # Para polígonos con confinamiento: polígono interior del núcleo
    core_polygon: list[tuple[float, float]] | None = None


@dataclass
class ReinforcementBar:
    """Barra individual de acero longitudinal."""
    id: str = field(default_factory=_new_id)
    y: float = 0.0          # mm — posición en eje de flexión
    z: float = 0.0          # mm — posición perpendicular
    bar_size: str = "#8"    # "#3" … "#11"
    steel_id: str = ""      # referencia a SteelDef.id


# ──────────────────────────────────────────────────────────────
# Documento de sección (objeto principal)
# ──────────────────────────────────────────────────────────────

@dataclass
class SectionDocument:
    """Representación completa de una sección de concreto reforzado.

    Este es el objeto que se persiste en la base de datos (como JSON) y que
    sirve de entrada a todos los análisis del Módulo 2.
    """
    schema_version: int = 1
    concrete_defs: list[ConcreteDef] = field(default_factory=list)
    steel_defs: list[SteelDef] = field(default_factory=list)
    regions: list[ConcreteRegion] = field(default_factory=list)
    bars: list[ReinforcementBar] = field(default_factory=list)

    # ── Propiedades derivadas ─────────────────────────────────────────────────

    @property
    def gross_area(self) -> float:
        """Área bruta de concreto (suma de regiones no-hueco)."""
        total = 0.0
        for r in self.regions:
            a = _region_area(r.shape)
            total += -a if r.is_void else a
        return max(total, 0.0)

    @property
    def steel_area(self) -> float:
        from engine.sections.reinforcement import BAR_AREAS_MM2
        return sum(BAR_AREAS_MM2.get(b.bar_size, 0.0) for b in self.bars)

    @property
    def depth(self) -> float:
        """Dimensión máxima en y (eje de flexión), en mm."""
        pts = _all_vertices(self)
        if not pts:
            return 0.0
        return max(p[0] for p in pts) - min(p[0] for p in pts)

    @property
    def width(self) -> float:
        """Dimensión máxima en z (perpendicular), en mm."""
        pts = _all_vertices(self)
        if not pts:
            return 0.0
        return max(p[1] for p in pts) - min(p[1] for p in pts)

    @property
    def centroid(self) -> tuple[float, float]:
        """Centroide geométrico (y, z) en mm."""
        total_a = 0.0
        cy_sum = cz_sum = 0.0
        for r in self.regions:
            a = _region_area(r.shape)
            cy, cz = _region_centroid(r.shape)
            sign = -1.0 if r.is_void else 1.0
            total_a += sign * a
            cy_sum += sign * a * cy
            cz_sum += sign * a * cz
        if abs(total_a) < 1e-9:
            return 0.0, 0.0
        return cy_sum / total_a, cz_sum / total_a

    def get_concrete_def(self, cid: str) -> ConcreteDef:
        for c in self.concrete_defs:
            if c.id == cid:
                return c
        raise KeyError(f"ConcreteDef no encontrado: {cid!r}")

    def get_steel_def(self, sid: str) -> SteelDef:
        for s in self.steel_defs:
            if s.id == sid:
                return s
        raise KeyError(f"SteelDef no encontrado: {sid!r}")

    def default_concrete(self) -> ConcreteDef | None:
        return self.concrete_defs[0] if self.concrete_defs else None

    def default_steel(self) -> SteelDef | None:
        return self.steel_defs[0] if self.steel_defs else None


# ──────────────────────────────────────────────────────────────
# Helpers de geometría
# ──────────────────────────────────────────────────────────────

def _polygon_area(poly: list[tuple[float, float]]) -> float:
    n = len(poly)
    if n < 3:
        return 0.0
    area = 0.0
    for i in range(n):
        y1, z1 = poly[i]
        y2, z2 = poly[(i + 1) % n]
        area += y1 * z2 - y2 * z1
    return abs(area) / 2.0


def _polygon_centroid(poly: list[tuple[float, float]]) -> tuple[float, float]:
    n = len(poly)
    if n < 3:
        return 0.0, 0.0
    area_s = 0.0
    cy = cz = 0.0
    for i in range(n):
        y1, z1 = poly[i]
        y2, z2 = poly[(i + 1) % n]
        cross = y1 * z2 - y2 * z1
        area_s += cross
        cy += (y1 + y2) * cross
        cz += (z1 + z2) * cross
    area_s /= 2.0
    if abs(area_s) < 1e-9:
        return 0.0, 0.0
    return cy / (6.0 * area_s), cz / (6.0 * area_s)


def _region_area(shape: RegionShape) -> float:
    if isinstance(shape, RectShape):
        return shape.height * shape.width
    if isinstance(shape, CircShape):
        return math.pi * (shape.radius**2 - shape.radius_inner**2)
    return _polygon_area(shape.vertices)


def _region_centroid(shape: RegionShape) -> tuple[float, float]:
    if isinstance(shape, RectShape):
        return shape.y, shape.z
    if isinstance(shape, CircShape):
        return shape.y, shape.z
    return _polygon_centroid(shape.vertices)


def _all_vertices(doc: SectionDocument) -> list[tuple[float, float]]:
    pts: list[tuple[float, float]] = []
    for r in doc.regions:
        if isinstance(r.shape, RectShape):
            pts.extend(r.shape.to_polygon())
        elif isinstance(r.shape, CircShape):
            # approximate with 16 points
            for i in range(16):
                a = 2 * math.pi * i / 16
                pts.append((r.shape.y + r.shape.radius * math.cos(a),
                             r.shape.z + r.shape.radius * math.sin(a)))
        else:
            pts.extend(r.shape.vertices)
    return pts
