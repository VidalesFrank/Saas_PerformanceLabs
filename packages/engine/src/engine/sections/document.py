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


@dataclass
class IShape:
    """Sección I (perfil) — 2 patines y 1 alma.

    Convención: y vertical, z horizontal. Origen en el centro geométrico.
    Alma centrada verticalmente. Patines simétricos por defecto (bf_top = bf_bot);
    puede rehacerse por T (fijar tf_bot=0) o C (asimétrica en z).

    Parámetros (todos en mm):
        d     : altura total de la sección
        bf_top: ancho patín superior
        tf_top: espesor patín superior
        bf_bot: ancho patín inferior (default = bf_top)
        tf_bot: espesor patín inferior (default = tf_top)
        tw    : espesor del alma
    """
    kind: Literal["ishape"] = "ishape"
    y: float = 0.0
    z: float = 0.0
    d: float = 500.0
    bf_top: float = 300.0
    tf_top: float = 40.0
    bf_bot: float = 300.0
    tf_bot: float = 40.0
    tw: float = 20.0

    def to_polygon(self) -> list[tuple[float, float]]:
        """Vértices CCW mirando desde +x hacia origen. Origen en el centroide."""
        d, bft, tft, bfb, tfb, tw = self.d, self.bf_top, self.tf_top, self.bf_bot, self.tf_bot, self.tw
        y_top    = self.y + d / 2
        y_bot    = self.y - d / 2
        y_web_top = y_top - tft
        y_web_bot = y_bot + tfb
        z0 = self.z
        # Recorrido: patín inferior (izq→der), sube por alma derecha, patín superior (der→izq), baja por alma izquierda
        verts = [
            (y_bot,      z0 - bfb / 2),
            (y_bot,      z0 + bfb / 2),
            (y_web_bot,  z0 + bfb / 2),
            (y_web_bot,  z0 + tw / 2),
            (y_web_top,  z0 + tw / 2),
            (y_web_top,  z0 + bft / 2),
            (y_top,      z0 + bft / 2),
            (y_top,      z0 - bft / 2),
            (y_web_top,  z0 - bft / 2),
            (y_web_top,  z0 - tw / 2),
            (y_web_bot,  z0 - tw / 2),
            (y_web_bot,  z0 - bfb / 2),
        ]
        return verts


@dataclass
class TShape:
    """Sección T — patín superior + alma. Origen en el centroide del rect envolvente."""
    kind: Literal["tshape"] = "tshape"
    y: float = 0.0
    z: float = 0.0
    d: float = 500.0
    bf: float = 300.0        # ancho patín
    tf: float = 100.0        # espesor patín
    tw: float = 20.0         # espesor alma

    def to_polygon(self) -> list[tuple[float, float]]:
        d, bf, tf, tw = self.d, self.bf, self.tf, self.tw
        y_top    = self.y + d / 2
        y_bot    = self.y - d / 2
        y_web_top = y_top - tf
        z0 = self.z
        verts = [
            (y_bot,      z0 - tw / 2),
            (y_bot,      z0 + tw / 2),
            (y_web_top,  z0 + tw / 2),
            (y_web_top,  z0 + bf / 2),
            (y_top,      z0 + bf / 2),
            (y_top,      z0 - bf / 2),
            (y_web_top,  z0 - bf / 2),
            (y_web_top,  z0 - tw / 2),
        ]
        return verts


@dataclass
class LShape:
    """Sección L — dos rectángulos ortogonales, patín vertical y horizontal.

    Parámetros:
        d   : altura total (vertical)
        bf  : ancho patín horizontal (base)
        tw  : espesor pierna vertical
        tf  : espesor patín horizontal
    Origen en el rincón inferior-izquierdo del bounding box.
    """
    kind: Literal["lshape"] = "lshape"
    y: float = 0.0             # coordenada del punto inferior-izquierdo
    z: float = 0.0
    d: float = 500.0
    bf: float = 500.0
    tw: float = 50.0
    tf: float = 50.0

    def to_polygon(self) -> list[tuple[float, float]]:
        y0, z0 = self.y, self.z
        d, bf, tw, tf = self.d, self.bf, self.tw, self.tf
        # Recorrido CCW empezando por rincón inferior-izquierdo
        verts = [
            (y0,           z0),
            (y0,           z0 + bf),
            (y0 + tf,      z0 + bf),
            (y0 + tf,      z0 + tw),
            (y0 + d,       z0 + tw),
            (y0 + d,       z0),
        ]
        return verts


@dataclass
class DoubleTShape:
    """Sección doble T (prefabricado típico) — 2 almas + patín superior.

    Muy común en losas prefabricadas de estacionamientos y bodegas.
    Parámetros: d altura total, bf ancho patín, tf espesor patín,
    tw espesor de cada alma, spacing centro-a-centro de almas.
    """
    kind: Literal["doubletshape"] = "doubletshape"
    y: float = 0.0
    z: float = 0.0
    d: float = 800.0
    bf: float = 2400.0
    tf: float = 100.0
    tw: float = 100.0
    spacing: float = 1200.0

    def to_polygon(self) -> list[tuple[float, float]]:
        """Contorno CCW simple. Requiere bf ≥ spacing + tw (patín envuelve almas)."""
        d, bf, tf, tw, s = self.d, self.bf, self.tf, self.tw, self.spacing
        y_top     = self.y + d / 2
        y_bot     = self.y - d / 2
        y_web_top = y_top - tf
        z0 = self.z
        z_L_out = z0 - s / 2 - tw / 2
        z_L_in  = z0 - s / 2 + tw / 2
        z_R_in  = z0 + s / 2 - tw / 2
        z_R_out = z0 + s / 2 + tw / 2
        z_p_R   = z0 + bf / 2
        z_p_L   = z0 - bf / 2
        verts = [
            (y_bot,      z_L_out),   # 1: inferior izq alma izq
            (y_bot,      z_L_in),    # 2: base alma izq
            (y_web_top,  z_L_in),    # 3: sube cara interior alma izq
            (y_web_top,  z_R_in),    # 4: cruza entre almas bajo patín
            (y_bot,      z_R_in),    # 5: baja cara interior alma der
            (y_bot,      z_R_out),   # 6: base alma der
            (y_web_top,  z_R_out),   # 7: sube cara exterior alma der
            (y_web_top,  z_p_R),     # 8: cruza cara inferior derecha patín
            (y_top,      z_p_R),     # 9: sube lateral derecho patín
            (y_top,      z_p_L),     # 10: cara superior patín
            (y_web_top,  z_p_L),     # 11: baja lateral izquierdo patín
            (y_web_top,  z_L_out),   # 12: cruza cara inferior izquierda patín
        ]
        return verts


RegionShape = RectShape | CircShape | PolygonShape | IShape | TShape | LShape | DoubleTShape


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
    """Definición de un concreto. Permite dos modelos constitutivos:

    - ``concrete01`` (default): Kent-Scott-Park con degradación lineal, sin
      resistencia a tensión. Rápido y suficiente para diagramas P-M/M-φ.
    - ``concrete02``: Yassin (1994) con **resistencia a tensión** + tension
      softening. Necesario para análisis cíclico y servicio (fisuración).
    """
    id: str = field(default_factory=_new_id)
    label: str = "Concreto"
    fpc: float = 28.0                # MPa — resistencia máxima a compresión
    eco: float = 0.002                # deformación unitaria en fpc
    model_kind: Literal["concrete01", "concrete02"] = "concrete01"
    # Params Concrete02 (opcionales, ignorados si model_kind == "concrete01"):
    ft: float | None = None          # MPa — resistencia a tensión (default 0.62·√f'c NSR-10 C.9.5.2.3)
    Ets: float | None = None         # MPa — tension softening slope (default Ec/10)
    lambda_c: float = 0.10           # ratio pendiente descarga / rigidez inicial


@dataclass
class SteelDef:
    """Definición de un acero de refuerzo. Tres modelos disponibles:

    - ``steel02`` (default): Menegotto-Pinto con Bauschinger. Recomendado para
      todo análisis con inversión de carga (sismo, cíclico).
    - ``steel01``: bilineal simple sin Bauschinger. Útil para diagramas
      monotónicos P-M / M-φ donde la histéresis no se usa.
    - ``prestressing``: acero de preesfuerzo. Se modela con Steel02 pero
      con parámetros ajustados (fpy fluencia, fpu última) y b menor.
    """
    id: str = field(default_factory=_new_id)
    label: str = "Acero"
    fy: float = 420.0                # MPa — fluencia (o fpy si es preesfuerzo)
    Es: float = 200_000.0             # MPa — módulo de elasticidad
    b: float = 0.01                    # razón de endurecimiento por deformación
    model_kind: Literal["steel02", "steel01", "prestressing"] = "steel02"
    # Params extra para preesfuerzo (opcionales):
    fpu: float | None = None          # MPa — tensión última (preesfuerzo típ. 1860)
    eps_ult: float | None = None     # deformación última


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
