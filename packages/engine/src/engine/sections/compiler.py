"""Compilador: SectionDocument → CompiledFiberSection.

Convierte el modelo de datos del editor (SectionDocument) a la representación
interna necesaria para OpenSees (CompiledFiberSection). Este es el único punto
donde la geometría abstracta se transforma en patches y fibras concretas.

Convención de material tags:
  - Concreto: 1, 2, 3, ...  (un tag por cada (region, tipo=core|cover))
  - Acero base  : primer tag libre después del último concreto
  - Acero MinMax: acero_tag + 1
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from engine.materials.concrete import (
    ConcreteMaterialParams,
    CircConfinement,
    ConfinedConcreteReport,
    RectConfinement,
    mander_confined_circ_report,
    mander_confined_rect_report,
    unconfined_concrete,
)
from engine.materials.steel import SteelMaterialParams, reinforcing_steel
from engine.sections.document import (
    CircConfinementDef,
    CircShape,
    ConcreteRegion,
    PolygonShape,
    RectConfinementDef,
    RectShape,
    ReinforcementBar,
    SectionDocument,
)
from engine.sections.geometry import (
    CircPatchSpec,
    CircularSection,
    PointFiberSpec,
    PolygonSection,
    RectPatchSpec,
    RectangularSection,
)
from engine.sections.reinforcement import BAR_AREAS_MM2

# Diámetros nominales de barras en mm (ASTM A615)
BAR_DIAMETERS_MM: dict[str, float] = {
    "#3": 9.525, "#4": 12.70, "#5": 15.875, "#6": 19.05, "#7": 22.225,
    "#8": 25.40, "#9": 28.65, "#10": 32.26, "#11": 35.81,
}


# ─────────────────────────────────────────────────────────────────────────────
# Tipo de salida del compilador
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class CompiledFiberSection:
    """Sección compilada lista para análisis en OpenSees.

    Separamos patches (eficientes) de fibras explícitas (para PMM rotation).
    """
    # Materiales — (tag, params); orden importa para _define_materials
    concrete_materials: list[tuple[int, ConcreteMaterialParams]]
    steel_params: SteelMaterialParams
    steel_tag: int
    steel_wrapped_tag: int

    # Para análisis PM / M-φ: usa patches de OpenSees donde es posible
    rect_patches: list[RectPatchSpec]
    circ_patches: list[CircPatchSpec]
    point_fibers: list[PointFiberSpec]   # concreto discretizado (regiones polígono)
    bar_fibers: list[PointFiberSpec]     # barras de acero (mat_tag = steel_wrapped_tag)

    # Para análisis PMM: todas las fibras discretizadas (permite rotación)
    all_concrete_fibers: list[PointFiberSpec]
    all_bar_fibers: list[PointFiberSpec]

    # Propiedades de análisis
    depth_for_curvature: float    # mm
    gross_area: float             # mm²
    steel_area: float             # mm²
    fpc_nominal: float            # MPa — f'c sin confinar, para fórmula ACI P_max

    # Hints de simetría para optimización PMM
    is_doubly_symmetric: bool = False
    is_isotropic: bool = False

    # Reportes Mander por región (para UI)
    mander_reports: dict[str, ConfinedConcreteReport | None] = field(default_factory=dict)


# ─────────────────────────────────────────────────────────────────────────────
# Función principal
# ─────────────────────────────────────────────────────────────────────────────

def compile(doc: SectionDocument) -> CompiledFiberSection:
    """Compila un SectionDocument en CompiledFiberSection para OpenSees."""
    if not doc.regions:
        raise ValueError("SectionDocument sin regiones: no se puede compilar.")
    if not doc.steel_defs:
        raise ValueError("SectionDocument sin SteelDef: se necesita al menos uno.")

    steel_def = doc.default_steel()
    assert steel_def is not None
    steel_params = reinforcing_steel(fy=steel_def.fy, E0=steel_def.Es, b=steel_def.b)

    # Asignar tags de concreto secuencialmente
    next_tag = 1
    concrete_materials: list[tuple[int, ConcreteMaterialParams]] = []
    mander_reports: dict[str, ConfinedConcreteReport | None] = {}

    rect_patches: list[RectPatchSpec] = []
    circ_patches: list[CircPatchSpec] = []
    point_fibers: list[PointFiberSpec] = []
    all_concrete_fibers: list[PointFiberSpec] = []

    for region in doc.regions:
        if region.is_void:
            continue
        if not region.concrete_id and not doc.concrete_defs:
            raise ValueError(f"Región '{region.label}' no tiene concrete_id y el documento no tiene ConcreteDef.")

        cdef = doc.get_concrete_def(region.concrete_id) if region.concrete_id else doc.default_concrete()
        assert cdef is not None

        fyh = _fyh(region, steel_def.fy)

        if region.confinement is not None:
            # Región con confinamiento: 2 materiales (core + cover)
            core_tag, cover_tag = next_tag, next_tag + 1
            next_tag += 2

            report, cover_params = _compile_confined_material(
                cdef, region, doc.bars, fyh
            )
            core_params = report.params
            mander_reports[region.id] = report

            concrete_materials.append((core_tag, core_params))
            concrete_materials.append((cover_tag, cover_params))

            rp, cp, pf, acf = _compile_confined_region(
                region, core_tag, cover_tag
            )
            rect_patches.extend(rp)
            circ_patches.extend(cp)
            point_fibers.extend(pf)
            all_concrete_fibers.extend(acf)
        else:
            # Región sin confinamiento: 1 material (concreto no confinado)
            mat_tag = next_tag
            next_tag += 1

            unc_params = unconfined_concrete(cdef.fpc, eco=cdef.eco)
            concrete_materials.append((mat_tag, unc_params))
            mander_reports[region.id] = None

            rp, cp, pf, acf = _compile_unconfined_region(region, mat_tag)
            rect_patches.extend(rp)
            circ_patches.extend(cp)
            point_fibers.extend(pf)
            all_concrete_fibers.extend(acf)

    steel_tag = next_tag
    steel_wrapped_tag = next_tag + 1

    # Compilar barras
    bar_fibers = _compile_bars(doc.bars, steel_wrapped_tag)
    all_bar_fibers = list(bar_fibers)

    # Propiedades de sección
    gross_area = doc.gross_area
    steel_area = doc.steel_area
    depth = doc.depth or 1.0

    # f'c nominal = f'c de la primera región con confinamiento (o primera región)
    fpc_nominal = _nominal_fpc(doc)

    # Hints de simetría
    is_isotropic, is_doubly_sym = _detect_symmetry(doc)

    return CompiledFiberSection(
        concrete_materials=concrete_materials,
        steel_params=steel_params,
        steel_tag=steel_tag,
        steel_wrapped_tag=steel_wrapped_tag,
        rect_patches=rect_patches,
        circ_patches=circ_patches,
        point_fibers=point_fibers,
        bar_fibers=bar_fibers,
        all_concrete_fibers=all_concrete_fibers,
        all_bar_fibers=all_bar_fibers,
        depth_for_curvature=depth,
        gross_area=gross_area,
        steel_area=steel_area,
        fpc_nominal=fpc_nominal,
        is_doubly_symmetric=is_doubly_sym,
        is_isotropic=is_isotropic,
        mander_reports=mander_reports,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Compilación de materiales
# ─────────────────────────────────────────────────────────────────────────────

def _fyh(region: ConcreteRegion, default_fy: float) -> float:
    if region.confinement is None:
        return default_fy
    fyh = region.confinement.fyh
    return fyh if fyh is not None else default_fy


def _compile_confined_material(
    cdef, region: ConcreteRegion, all_bars: list[ReinforcementBar], fyh: float
) -> tuple[ConfinedConcreteReport, ConcreteMaterialParams]:
    """Calcula parámetros Mander para una región confinada."""
    conf = region.confinement
    cover = region.cover_to_bar

    if isinstance(conf, RectConfinementDef):
        s = region.shape
        if isinstance(s, RectShape):
            width, height = s.width, s.height
        else:
            # Aproximar para otros shapes
            from engine.sections.document import _region_area
            a = _region_area(s)
            width = height = math.sqrt(a)

        hoop_d = BAR_DIAMETERS_MM.get(conf.hoop_bar_size, 9.525)
        hoop_a = BAR_AREAS_MM2.get(conf.hoop_bar_size, 71.0)
        bc = width - 2.0 * cover
        dc = height - 2.0 * cover

        bars_in = _bars_in_rect_region(all_bars, s if isinstance(s, RectShape) else None, cover)
        clear_spacings = _rect_clear_spacings(bars_in, bc, dc)

        ast = sum(BAR_AREAS_MM2.get(b.bar_size, 0.0) for b in bars_in)
        core_area = max(bc * dc, 1.0)
        rho_cc = ast / core_area

        rect_conf = RectConfinement(
            bc=max(bc, 1.0), dc=max(dc, 1.0),
            s=conf.spacing, hoop_bar_diameter=hoop_d,
            num_legs_x=conf.legs_x, num_legs_y=conf.legs_y,
            leg_area=hoop_a,
            clear_bar_spacings=clear_spacings,
            rho_cc=rho_cc,
        )
        report = mander_confined_rect_report(cdef.fpc, fyh, rect_conf, eco=cdef.eco)

    elif isinstance(conf, CircConfinementDef):
        s = region.shape
        if isinstance(s, CircShape):
            diameter = 2.0 * s.radius
        else:
            diameter = math.sqrt(4.0 * region.shape.width * region.shape.height / math.pi) if hasattr(region.shape, 'width') else 400.0

        hoop_d = BAR_DIAMETERS_MM.get(conf.hoop_bar_size, 9.525)
        hoop_a = BAR_AREAS_MM2.get(conf.hoop_bar_size, 71.0)
        ds = diameter - 2.0 * cover

        bars_in = _bars_in_circ_region(all_bars, s if isinstance(s, CircShape) else None, cover)
        ast = sum(BAR_AREAS_MM2.get(b.bar_size, 0.0) for b in bars_in)
        core_area = max(math.pi * (ds / 2) ** 2, 1.0)
        rho_cc = ast / core_area

        circ_conf = CircConfinement(
            ds=max(ds, 1.0), s=conf.spacing,
            hoop_bar_diameter=hoop_d, bar_area=hoop_a,
            rho_cc=rho_cc, is_spiral=conf.is_spiral,
        )
        report = mander_confined_circ_report(cdef.fpc, fyh, circ_conf, eco=cdef.eco)
    else:
        raise TypeError(f"ConfinementDef desconocido: {type(conf)}")

    cover_params = unconfined_concrete(cdef.fpc, eco=cdef.eco)
    return report, cover_params


# ─────────────────────────────────────────────────────────────────────────────
# Compilación de regiones → patches + fibras
# ─────────────────────────────────────────────────────────────────────────────

def _compile_confined_region(
    region: ConcreteRegion,
    core_tag: int,
    cover_tag: int,
) -> tuple[list[RectPatchSpec], list[CircPatchSpec], list[PointFiberSpec], list[PointFiberSpec]]:
    """Produce patches/fibras para una región confinada (core + cover)."""
    s = region.shape
    cover = region.cover_to_bar
    all_concrete_fibers: list[PointFiberSpec] = []

    if isinstance(s, RectShape) and abs(s.angle_deg) < 1e-6:
        sect = RectangularSection(width=s.width, height=s.height, cover=cover)
        core_patch, cover_patches = sect.patches(core_tag, cover_tag)
        rp = [_translate_rect_patch(core_patch, s.y, s.z)]
        for cp in cover_patches:
            rp.append(_translate_rect_patch(cp, s.y, s.z))
        for p in rp:
            all_concrete_fibers.extend(disc_rect(p))
        return rp, [], [], all_concrete_fibers

    if isinstance(s, CircShape):
        sect = CircularSection(diameter=2.0 * s.radius, cover=cover)
        core_patch, cover_patches = sect.patches(core_tag, cover_tag)
        cp_list = [_translate_circ_patch(core_patch, s.y, s.z)]
        for cp in cover_patches:
            cp_list.append(_translate_circ_patch(cp, s.y, s.z))
        for p in cp_list:
            all_concrete_fibers.extend(disc_circ(p))
        return [], cp_list, [], all_concrete_fibers

    outer = s.vertices if isinstance(s, PolygonShape) else s.to_polygon()
    core_verts = region.core_polygon
    poly_sect = PolygonSection(outer, core_vertices=core_verts)
    fibers = poly_sect.fibers(core_tag, cover_tag)
    return [], [], fibers, list(fibers)


def _compile_unconfined_region(
    region: ConcreteRegion,
    mat_tag: int,
) -> tuple[list[RectPatchSpec], list[CircPatchSpec], list[PointFiberSpec], list[PointFiberSpec]]:
    """Produce patches/fibras para una región sin confinamiento."""
    s = region.shape
    all_concrete_fibers: list[PointFiberSpec] = []

    if isinstance(s, RectShape) and abs(s.angle_deg) < 1e-6:
        h2, w2 = s.height / 2, s.width / 2
        patch = RectPatchSpec(mat_tag, 16, 16,
                              s.y - h2, s.z - w2,
                              s.y + h2, s.z + w2)
        all_concrete_fibers.extend(disc_rect(patch))
        return [patch], [], [], all_concrete_fibers

    if isinstance(s, CircShape):
        patch = CircPatchSpec(mat_tag, 24, 8,
                              s.y, s.z,
                              s.radius_inner, s.radius)
        all_concrete_fibers.extend(disc_circ(patch))
        return [], [patch], [], all_concrete_fibers

    verts = s.vertices if isinstance(s, PolygonShape) else s.to_polygon()
    poly = PolygonSection(verts)
    fibers = poly.fibers(mat_tag, mat_tag)
    return [], [], fibers, list(fibers)


def _compile_bars(bars: list[ReinforcementBar], steel_tag: int) -> list[PointFiberSpec]:
    return [
        PointFiberSpec(steel_tag, b.y, b.z, BAR_AREAS_MM2.get(b.bar_size, 0.0))
        for b in bars
    ]


# ─────────────────────────────────────────────────────────────────────────────
# Helpers de barras para Mander
# ─────────────────────────────────────────────────────────────────────────────

def _bars_in_rect_region(
    all_bars: list[ReinforcementBar],
    shape: RectShape | None,
    cover: float,
) -> list[ReinforcementBar]:
    """Barras que están dentro de la región rectangular."""
    if shape is None:
        return list(all_bars)
    h2 = shape.height / 2 + 1.0
    w2 = shape.width / 2 + 1.0
    return [b for b in all_bars
            if shape.y - h2 <= b.y <= shape.y + h2
            and shape.z - w2 <= b.z <= shape.z + w2]


def _bars_in_circ_region(
    all_bars: list[ReinforcementBar],
    shape: CircShape | None,
    cover: float,
) -> list[ReinforcementBar]:
    if shape is None:
        return list(all_bars)
    r = shape.radius + 1.0
    return [b for b in all_bars
            if math.hypot(b.y - shape.y, b.z - shape.z) <= r]


def _rect_clear_spacings(
    bars: list[ReinforcementBar],
    bc: float,
    dc: float,
) -> list[float]:
    """Calcula wi (separaciones libres entre barras para ke Mander) desde posiciones reales.

    Si no hay barras, usa estimación uniforme.
    """
    if not bars:
        return [bc / 3.0, dc / 3.0]

    # Agrupar por cara aproximada usando coordenada dominante
    half_bc, half_dc = bc / 2, dc / 2
    top    = sorted([b for b in bars if b.y >  half_bc * 0.8], key=lambda b: b.z)
    bottom = sorted([b for b in bars if b.y < -half_bc * 0.8], key=lambda b: b.z)
    left   = sorted([b for b in bars if b.z < -half_dc * 0.8], key=lambda b: b.y)
    right  = sorted([b for b in bars if b.z >  half_dc * 0.8], key=lambda b: b.y)

    spacings: list[float] = []
    for face_bars in (top, bottom, left, right):
        if len(face_bars) >= 2:
            coords = [b.z if face_bars in (top, bottom) else b.y for b in face_bars]
            for i in range(len(coords) - 1):
                d = abs(coords[i + 1] - coords[i])
                # descontar diámetros de barra aproximados
                db = BAR_DIAMETERS_MM.get(face_bars[i].bar_size, 25.4)
                spacings.append(max(d - db, 10.0))

    if not spacings:
        spacings = [bc / 3.0, dc / 3.0]

    return spacings


# ─────────────────────────────────────────────────────────────────────────────
# Discretización de patches → fibras individuales (para PMM rotation)
# Estas funciones son la fuente canónica; pmm_surface.py las importa de aquí.
# ─────────────────────────────────────────────────────────────────────────────

def disc_rect(patch: RectPatchSpec) -> list[PointFiberSpec]:
    """Discretiza un patch rectangular en fibras uniformes."""
    dy = (patch.y2 - patch.y1) / patch.nf_y
    dz = (patch.z2 - patch.z1) / patch.nf_z
    area = abs(dy * dz)
    return [
        PointFiberSpec(patch.mat_tag,
                       patch.y1 + (i + 0.5) * dy,
                       patch.z1 + (j + 0.5) * dz,
                       area)
        for i in range(patch.nf_y)
        for j in range(patch.nf_z)
    ]


def disc_circ(patch: CircPatchSpec) -> list[PointFiberSpec]:
    """Discretiza un patch circular en fibras."""
    ang_s = math.radians(patch.ang[0])
    ang_e = math.radians(patch.ang[1])
    d_ang = (ang_e - ang_s) / patch.nf_circ
    dr = (patch.r_ext - patch.r_int) / patch.nf_rad
    fibers: list[PointFiberSpec] = []
    for k_r in range(patch.nf_rad):
        r_in = patch.r_int + k_r * dr
        r_out = patch.r_int + (k_r + 1) * dr
        r_mid = (r_in + r_out) / 2
        area = 0.5 * (r_out ** 2 - r_in ** 2) * d_ang
        for k_c in range(patch.nf_circ):
            ang = ang_s + (k_c + 0.5) * d_ang
            fibers.append(PointFiberSpec(
                patch.mat_tag,
                patch.y_center + r_mid * math.cos(ang),
                patch.z_center + r_mid * math.sin(ang),
                area,
            ))
    return fibers


# ─────────────────────────────────────────────────────────────────────────────
# Helpers de traslación de patches
# ─────────────────────────────────────────────────────────────────────────────

def _translate_rect_patch(p: RectPatchSpec, dy: float, dz: float) -> RectPatchSpec:
    return RectPatchSpec(p.mat_tag, p.nf_y, p.nf_z,
                         p.y1 + dy, p.z1 + dz, p.y2 + dy, p.z2 + dz)


def _translate_circ_patch(p: CircPatchSpec, dy: float, dz: float) -> CircPatchSpec:
    return CircPatchSpec(p.mat_tag, p.nf_circ, p.nf_rad,
                         p.y_center + dy, p.z_center + dz,
                         p.r_int, p.r_ext, p.ang)


# ─────────────────────────────────────────────────────────────────────────────
# Helpers de simetría
# ─────────────────────────────────────────────────────────────────────────────

def _nominal_fpc(doc: SectionDocument) -> float:
    """f'c sin confinar: primer ConcreteDef, o 28 MPa por defecto."""
    cdef = doc.default_concrete()
    return cdef.fpc if cdef else 28.0


def _detect_symmetry(doc: SectionDocument) -> tuple[bool, bool]:
    """Retorna (is_isotropic, is_doubly_symmetric) para optimización PMM."""
    non_void = [r for r in doc.regions if not r.is_void]
    if not non_void:
        return False, False

    # Isotropía: una sola región circular centrada en el origen
    if (len(non_void) == 1
            and isinstance(non_void[0].shape, CircShape)
            and abs(non_void[0].shape.y) < 1.0
            and abs(non_void[0].shape.z) < 1.0):
        return True, True

    # Doble simetría: todas las regiones son RectShape sin rotación, centradas en origen
    all_rect = all(isinstance(r.shape, RectShape)
                   and abs(r.shape.angle_deg) < 1e-6
                   and abs(r.shape.y) < 1.0
                   and abs(r.shape.z) < 1.0
                   for r in non_void)
    return False, all_rect


# ─────────────────────────────────────────────────────────────────────────────
# Fábrica de compatibilidad: construir SectionDocument desde parámetros legacy
# ─────────────────────────────────────────────────────────────────────────────

def document_from_legacy(
    shape_type: str,
    geometry: dict,
    materials: dict,
    reinforcement: dict,
    cover: float,
) -> SectionDocument:
    """Construye un SectionDocument desde el formato JSON legacy (v1 API).

    Permite que los endpoints /api/v1/sections sigan funcionando sin cambios
    mientras internamente se usa el nuevo modelo.
    """
    from engine.sections.document import (
        ConcreteDef, SteelDef, ConcreteRegion, ReinforcementBar,
        RectShape, CircShape, PolygonShape, SectionDocument,
        RectConfinementDef, CircConfinementDef,
    )

    fpc = materials["fpc"]
    fy = materials["fy"]
    Es = materials.get("es", 200_000.0)

    cdef = ConcreteDef(id="c0", label=f"f'c {fpc} MPa", fpc=fpc)
    sdef = SteelDef(id="s0", label=f"fy {fy} MPa", fy=fy, Es=Es)

    hoop_spacing = materials.get("hoop_spacing")
    hoop_bar_diameter = materials.get("hoop_bar_diameter")
    hoop_legs_x = materials.get("hoop_legs_x", 2)
    hoop_legs_y = materials.get("hoop_legs_y", 2)
    is_spiral = materials.get("is_spiral", True)

    # Determinar hoop_bar_size desde diámetro (busca el más cercano)
    hoop_bar_size = "#3"
    if hoop_bar_diameter:
        best = min(BAR_DIAMETERS_MM.items(), key=lambda kv: abs(kv[1] - hoop_bar_diameter))
        hoop_bar_size = best[0]

    # Crear confinamiento
    confinement = None
    if hoop_spacing and hoop_spacing > 0:
        if shape_type in ("rectangular", "square"):
            confinement = RectConfinementDef(
                hoop_bar_size=hoop_bar_size,
                spacing=hoop_spacing,
                legs_x=hoop_legs_x,
                legs_y=hoop_legs_y,
                fyh=fy,
            )
        elif shape_type == "circular":
            confinement = CircConfinementDef(
                hoop_bar_size=hoop_bar_size,
                spacing=hoop_spacing,
                is_spiral=is_spiral,
                fyh=fy,
            )

    # Crear región principal
    if shape_type in ("rectangular", "square"):
        w, h = geometry["width"], geometry["height"]
        shape = RectShape(y=0.0, z=0.0, height=h, width=w)
    elif shape_type == "circular":
        d = geometry["diameter"]
        shape = CircShape(y=0.0, z=0.0, radius=d / 2)
    else:  # special / polygon
        verts = [tuple(v) for v in geometry["vertices"]]
        shape = PolygonShape(vertices=verts)
        core_v = geometry.get("core_vertices")
        core_polygon = [tuple(v) for v in core_v] if core_v else None

    region = ConcreteRegion(
        id="r0",
        label="Sección",
        shape=shape,
        concrete_id="c0",
        confinement=confinement,
        cover_to_bar=cover,
        core_polygon=core_polygon if shape_type == "special" else None,
    )

    # Barras de acero
    bar_id = reinforcement.get("bar_id", "#8")
    bars: list[ReinforcementBar] = []

    if shape_type in ("rectangular", "square"):
        w, h = geometry["width"], geometry["height"]
        ctb = reinforcement.get("cover_to_bar_centroid", cover)
        n_y = reinforcement.get("n_bars_y", 3)
        n_z = reinforcement.get("n_bars_z", 3)
        hh, hw = h / 2, w / 2
        y_out, z_out = hh - ctb, hw - ctb
        # Cara superior e inferior
        for i in range(n_y):
            z = -z_out + i * (2 * z_out) / (n_y - 1) if n_y > 1 else 0.0
            bars.append(ReinforcementBar(y=y_out, z=z, bar_size=bar_id, steel_id="s0"))
            bars.append(ReinforcementBar(y=-y_out, z=z, bar_size=bar_id, steel_id="s0"))
        # Caras laterales (sin contar esquinas)
        for i in range(1, n_z - 1):
            y = -y_out + i * (2 * y_out) / (n_z - 1)
            bars.append(ReinforcementBar(y=y, z=z_out, bar_size=bar_id, steel_id="s0"))
            bars.append(ReinforcementBar(y=y, z=-z_out, bar_size=bar_id, steel_id="s0"))

    elif shape_type == "circular":
        import math
        d = geometry["diameter"]
        n = reinforcement.get("n_bars", 8)
        ctb = reinforcement.get("cover_to_bar_centroid", cover)
        r = d / 2 - ctb
        for i in range(n):
            theta = 2 * math.pi * i / n
            bars.append(ReinforcementBar(
                y=r * math.cos(theta), z=r * math.sin(theta),
                bar_size=bar_id, steel_id="s0",
            ))

    elif shape_type == "special":
        explicit_bars = reinforcement.get("bars") or []
        for y, z in explicit_bars:
            bars.append(ReinforcementBar(y=y, z=z, bar_size=bar_id, steel_id="s0"))

    return SectionDocument(
        concrete_defs=[cdef],
        steel_defs=[sdef],
        regions=[region],
        bars=bars,
    )
