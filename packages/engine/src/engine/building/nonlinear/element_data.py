"""
ElementData — datos consolidados por elemento (viga/columna) para el
cálculo de umbrales de daño basados en elemento.

Alimenta Fases 2–5 del plan:
    Fase 2  — modo de falla (flexión / flexión-cortante / cortante)
    Fase 3  — momento–curvatura M–φ con εcu Mander
    Fase 4  — capacidad de rotación (Mecánico A, EC8-3 B, Haselton C)
    Fase 5  — estados de daño DS1-DS4 + fragilidad lognormal

Pobla sus campos a partir del nonlinear_model.json (producido por
NLSpecBuilder) y, opcionalmente, de dos entradas adicionales:
    - axial_from_gravity.json  (producido por run_gravity, Fase 1.2)
    - observations.csv         (observaciones de campo + completitud)

Convención de unidades (SI):
    Longitudes      → m internamente, mm en campos *_mm
    Esfuerzos       → MPa
    Fuerzas         → kN  (compresión POSITIVA en N_grav_kN)
    Cuantías        → adimensional
    Rotaciones      → rad

Referencias (ver docstring del campo para la ecuación):
    ACI 318-19 §25.7  (cuantías transversales)
    NSR-10 C.21       (requisitos DES / DMO)
    Mander 1988       (confinamiento)
    Paulay-Priestley  (Lp mecánica)
    Haselton 2008     (parámetros IMK, PEER 2007/03)
"""

from __future__ import annotations

import csv
import json
import math
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal, Optional

# ─────────────────────────────────────────────────────────────────────────────
# Catálogo local de barras — duplicado desde nl_spec_builder para evitar
# dependencia circular. Mantener sincronizado.
# ─────────────────────────────────────────────────────────────────────────────
_BAR_DIAM_MM: dict[str, float] = {
    "#3":  9.5,  "#4": 12.7,  "#5": 15.9,  "#6": 19.1,  "#7": 22.2,
    "#8": 25.4,  "#9": 28.7,  "#10": 32.3, "#11": 35.8,
}


def _db(label: str, default: float = 15.9) -> float:
    return _BAR_DIAM_MM.get(str(label).strip(), default)


def _area_mm2(label: str) -> float:
    d = _db(label)
    return math.pi * d * d / 4.0


# Tipos de enumeración simples (no Enum real para serialización trivial a JSON)
LpMethod   = Literal["measured", "paulay_priestley", "priestley_2007", "atc_32"]
HookType   = Literal["90deg", "135deg", "unknown"]
HingeModel = Literal["imk", "fibras"]


# ─────────────────────────────────────────────────────────────────────────────
# Sub-dataclasses — un bloque por eje temático
# ─────────────────────────────────────────────────────────────────────────────
@dataclass
class Geometry:
    """Dimensiones y luces del elemento (unidades mixtas m/mm según el campo)."""
    b_m:        float          # ancho de sección
    h_m:        float          # altura de sección
    cover_m:    float          # recubrimiento al estribo
    d_mm:       float          # peralte efectivo = h − cover − db_tie − db_long/2
    L_m:        float          # longitud total entre nodos
    Ln_m:       float          # luz libre (aprox L_m, override en viga con nudo real)
    Ls_m:       float          # luz de cortante — doble curvatura: Ln/2

    @property
    def Ag_m2(self) -> float:
        return self.b_m * self.h_m

    @property
    def Ag_mm2(self) -> float:
        return self.b_m * 1000.0 * self.h_m * 1000.0


@dataclass
class Materials:
    """Propiedades mecánicas de concreto y acero."""
    fc_MPa:   float           # resistencia a compresión
    fy_MPa:   float           # fluencia acero longitudinal
    fu_MPa:   float           # última acero longitudinal
    eps_su:   float           # deformación última acero (0.10 default A615 Gr60)
    fyh_MPa:  float           # fluencia acero transversal (default = fy)
    Es_MPa:   float = 200_000.0


@dataclass
class LongitudinalReinf:
    """Refuerzo longitudinal — agregado + opcional granular por grupos (columnas)
    o por zonas (vigas)."""
    As_cm2:         float
    n_bars:         int
    bar_label:      str
    db_mm:          float
    rho:            float     # As / (b·h) adim
    rho_prima:      float     # columnas simétricas: As/2/(b·h). Vigas: As_top vs As_bot.
    As_prima_cm2:   float = 0.0
    # Granularidad opcional
    groups: Optional[dict] = None  # columnas: {corners, top_face, bot_face, left_face, right_face}
    zones:  Optional[dict] = None  # vigas:    {end_i, mid, end_j} × {top, bot}


@dataclass
class TransverseReinf:
    """Refuerzo transversal — convención Mander: n_legs_b ∥ b, n_legs_h ∥ h."""
    tie_bar_label:  str
    db_tie_mm:      float
    n_legs_b:       int        # ramas paralelas al eje b (resisten corte en h)
    n_legs_h:       int        # ramas paralelas al eje h (resisten corte en b)
    s_confined_mm:  float      # separación en zona crítica (extremos)
    s_general_mm:   float      # separación en zona central
    A_tie_mm2:      float      # área de UNA rama
    rho_sh_b:       float      # ACI 318-19 §25.7.2: n_legs_h·A_tie / (b·s)
    rho_sh_h:       float      # idem para dirección h
    rho_sh:         float      # min(rho_sh_b, rho_sh_h) — gobernante
    rho_s_vol:      float      # cuantía volumétrica Mander (del spec.confinement)
    hook_type:      HookType   # 90deg / 135deg / unknown — observación de campo


@dataclass
class AxialState:
    """Carga axial — N_grav es gravedad; N_min/max se actualizan en pushover.

    Convención: COMPRESIÓN POSITIVA.
    """
    N_grav_kN:  float = 0.0
    N_min_kN:   Optional[float] = None   # mínima durante sismo (más tracción)
    N_max_kN:   Optional[float] = None   # máxima (más compresión)
    nu:         float = 0.0              # N_grav / (Ag · f'c), adim

    def recompute_nu(self, geo: Geometry, mat: Materials) -> None:
        Ag_mm2 = geo.Ag_mm2
        fc_MPa = mat.fc_MPa
        self.nu = (self.N_grav_kN * 1000.0) / (Ag_mm2 * fc_MPa) if Ag_mm2 * fc_MPa > 0 else 0.0


@dataclass
class Detailing:
    """Banderas de detallado NSR-10 / ASCE 41 relevantes para Fase 2."""
    splice_in_hinge:    bool  = False   # empalme en zona de rótula → penaliza
    s_over_db_long:     float = 0.0     # pandeo si > 6
    rho_sh_meets_DES:   bool  = False   # ACI 318 §18.7.5
    rho_sh_meets_DMO:   bool  = False   # NSR-10 C.21
    # NSR-10 C.21.5 — para elementos del sistema resistente a sismo
    compliance_level:   Literal["DES", "DMO", "DMI", "no_sismico", "unknown"] = "unknown"


@dataclass
class FieldObservations:
    """Datos observados en campo que overridean cálculos empíricos.

    L_p_measured_mm > 0 activa el método mecánico (A) para la capacidad de
    rotación de ESTE elemento, independientemente del método seleccionado por
    el proyecto. Ver Fase 4 — rotation_capacity.
    """
    L_p_measured_mm:  Optional[float] = None
    L_p_method:       LpMethod = "paulay_priestley"
    damage_notes:     Optional[str] = None
    photo_path:       Optional[str] = None


@dataclass
class ElementData:
    """Datos consolidados de un elemento viga/columna.

    Un objeto por elemento (frame_id). Alimenta todos los módulos de Fases 2-5.
    Puede serializarse a JSON para persistencia o inspección manual.
    """
    fid:             str
    kind:            Literal["column", "beam"]
    story:           str
    section_name:    str
    node_i:          str
    node_j:          str

    geometry:        Geometry
    materials:       Materials
    longitudinal:    LongitudinalReinf
    transverse:      TransverseReinf
    axial:           AxialState
    detailing:       Detailing
    field:           FieldObservations = field(default_factory=FieldObservations)

    # Metadatos no serializados por to_dict() — útiles para debug
    has_design:      bool = True

    def to_dict(self) -> dict:
        """Serializa a dict JSON-friendly."""
        return asdict(self)


# ─────────────────────────────────────────────────────────────────────────────
# Pobladores desde spec
# ─────────────────────────────────────────────────────────────────────────────
def _materials_from_spec(spec: dict, mat_concrete: str = "") -> Materials:
    """Extrae materiales del spec.

    Si mat_concrete está vacío, usa el primer concreto disponible.
    fu/eps_su siguen defaults A615 Gr60 si no están en el spec.
    """
    mats     = spec.get("materials", {})
    concrete = mats.get("concrete", {})
    steel    = mats.get("steel", {})

    # Concreto — buscar por nombre o tomar el primero
    fc = 21.0
    if mat_concrete and mat_concrete in concrete:
        fc = float(concrete[mat_concrete].get("fc_MPa", 21.0))
    elif concrete:
        fc = float(next(iter(concrete.values())).get("fc_MPa", 21.0))

    # Acero — tomar el primero disponible
    fy = 420.0
    fu = 630.0
    if steel:
        s0 = next(iter(steel.values()))
        fy = float(s0.get("fy_MPa", 420.0))
        fu = float(s0.get("fu_MPa", 1.5 * fy))

    return Materials(
        fc_MPa  = fc,
        fy_MPa  = fy,
        fu_MPa  = fu,
        eps_su  = 0.10,   # A615 Gr60 típica
        fyh_MPa = fy,
    )


def _geometry_from_column(ele: dict, db_long_mm: float, db_tie_mm: float) -> Geometry:
    g = ele.get("geometry", {})
    b = float(g.get("b_m", 0.30))
    h = float(g.get("h_m", 0.30))
    cover_m = float(g.get("cover_m", 0.040))
    L = float(g.get("L_m", 3.0))
    d_mm = (h - cover_m) * 1000.0 - db_tie_mm - db_long_mm / 2.0
    return Geometry(
        b_m=b, h_m=h, cover_m=cover_m,
        d_mm=max(d_mm, 50.0),
        L_m=L, Ln_m=L, Ls_m=L / 2.0,
    )


def _geometry_from_beam(ele: dict, db_long_mm: float, db_tie_mm: float) -> Geometry:
    g = ele.get("geometry", {})
    b = float(g.get("b_m", 0.30))
    h = float(g.get("h_m", 0.40))
    cover_m = float(g.get("cover_m", 0.040))
    L = float(ele.get("length_m", g.get("L_m", 4.0)))
    d_mm = (h - cover_m) * 1000.0 - db_tie_mm - db_long_mm / 2.0
    return Geometry(
        b_m=b, h_m=h, cover_m=cover_m,
        d_mm=max(d_mm, 50.0),
        L_m=L, Ln_m=L, Ls_m=L / 2.0,
    )


def _column_longitudinal(reinf: dict, b_m: float, h_m: float) -> LongitudinalReinf:
    lr = reinf.get("longitudinal", {})
    As_cm2 = float(lr.get("As_cm2", 0.0))
    n      = int(lr.get("n_bars", 0))
    label  = str(lr.get("bar_label", "#5"))
    db     = _db(label)
    Ag_cm2 = (b_m * 100.0) * (h_m * 100.0)
    rho    = As_cm2 / Ag_cm2 if Ag_cm2 > 0 else 0.0
    return LongitudinalReinf(
        As_cm2=As_cm2, n_bars=n, bar_label=label, db_mm=db,
        rho=rho, rho_prima=rho / 2.0,       # columna simétrica → ρ' ≈ ρ/2
        As_prima_cm2=As_cm2 / 2.0,
        groups=lr.get("groups"),
    )


def _beam_longitudinal(reinf: dict, b_m: float, h_m: float) -> LongitudinalReinf:
    """Para vigas: As y A's se toman de la zona end_i (zona crítica de la rótula
    plástica negativa). ρ y ρ' se calculan sobre b·d.
    """
    zones = reinf.get("zones", {})
    end_i = zones.get("end_i", {})
    top   = end_i.get("top", {})
    bot   = end_i.get("bot", {})

    label_top = str(top.get("bar_label", "#5"))
    label_bot = str(bot.get("bar_label", "#5"))
    n_top     = int(top.get("n_bars", 2))
    n_bot     = int(bot.get("n_bars", 2))
    As_top    = n_top * _area_mm2(label_top) / 100.0   # mm² → cm²
    As_bot    = n_bot * _area_mm2(label_bot) / 100.0

    # Rótula plástica negativa: As_top = tracción, As_bot = compresión.
    As_tens = As_top
    As_comp = As_bot
    # Promedio ponderado de db — representativo para el pandeo
    db_rep = (n_top * _db(label_top) + n_bot * _db(label_bot)) / max(n_top + n_bot, 1)
    label_rep = label_top if n_top >= n_bot else label_bot

    Ag_cm2 = (b_m * 100.0) * (h_m * 100.0)
    rho       = As_tens / Ag_cm2 if Ag_cm2 > 0 else 0.0
    rho_prima = As_comp / Ag_cm2 if Ag_cm2 > 0 else 0.0

    return LongitudinalReinf(
        As_cm2=As_tens, n_bars=n_top, bar_label=label_rep, db_mm=db_rep,
        rho=rho, rho_prima=rho_prima,
        As_prima_cm2=As_comp,
        zones=zones,
    )


def _column_transverse(reinf: dict, confinement: dict, b_m: float, h_m: float) -> TransverseReinf:
    tr = reinf.get("transverse", {})
    label   = str(tr.get("tie_bar_label", "#3"))
    db      = _db(label, default=9.5)
    nb      = int(tr.get("n_legs_b", 2))
    nh      = int(tr.get("n_legs_h", 2))
    s_c     = float(tr.get("s_confined_mm", 100.0))
    s_g     = float(tr.get("s_general_mm", 200.0))
    A_tie   = _area_mm2(label)

    # ACI 318-19 §25.7.2 — cuantía transversal por dirección.
    # ρ_sh en dirección b: ramas paralelas a h cruzan ancho b.
    # A_sh_dir_b = n_legs_h · A_tie  (ramas ∥ h, resisten corte en dir b)
    b_mm = b_m * 1000.0
    h_mm = h_m * 1000.0
    rho_sh_b = (nh * A_tie) / (b_mm * s_c) if (b_mm * s_c) > 0 else 0.0
    rho_sh_h = (nb * A_tie) / (h_mm * s_c) if (h_mm * s_c) > 0 else 0.0

    # ρ_s volumétrica — ya precalculada por Mander en confinement.end
    end = confinement.get("end", {}) or {}
    rho_s_vol = float(end.get("rho_s", end.get("rho_s_total", 0.0)))

    return TransverseReinf(
        tie_bar_label=label, db_tie_mm=db,
        n_legs_b=nb, n_legs_h=nh,
        s_confined_mm=s_c, s_general_mm=s_g,
        A_tie_mm2=A_tie,
        rho_sh_b=rho_sh_b, rho_sh_h=rho_sh_h,
        rho_sh=min(rho_sh_b, rho_sh_h),
        rho_s_vol=rho_s_vol,
        hook_type="unknown",   # se sobreescribe con observations.csv
    )


def _beam_transverse(reinf: dict, confinement: dict, b_m: float, h_m: float) -> TransverseReinf:
    sh = reinf.get("shear", {})
    label  = str(sh.get("tie_bar_label", "#3"))
    db     = _db(label, default=9.5)
    n_legs = int(sh.get("n_legs", 2))
    s_c    = float(sh.get("s_confined_mm", 100.0))
    s_g    = float(sh.get("s_central_mm",   200.0))
    A_tie  = _area_mm2(label)

    # Viga: el estribo cerrado típico tiene 2 ramas en cada dirección; cross-ties
    # adicionales suben n_legs > 2. La ramas en dir "h" (vertical) resisten
    # el corte vertical característico de vigas.
    b_mm = b_m * 1000.0
    h_mm = h_m * 1000.0
    rho_sh_h = (n_legs * A_tie) / (b_mm * s_c) if (b_mm * s_c) > 0 else 0.0
    rho_sh_b = (2 * A_tie) / (h_mm * s_c) if (h_mm * s_c) > 0 else 0.0

    end = confinement.get("end", {}) or {}
    rho_s_vol = float(end.get("rho_s", end.get("rho_s_total", 0.0)))

    return TransverseReinf(
        tie_bar_label=label, db_tie_mm=db,
        n_legs_b=2, n_legs_h=n_legs,
        s_confined_mm=s_c, s_general_mm=s_g,
        A_tie_mm2=A_tie,
        rho_sh_b=rho_sh_b, rho_sh_h=rho_sh_h,
        rho_sh=min(rho_sh_b, rho_sh_h),
        rho_s_vol=rho_s_vol,
        hook_type="unknown",
    )


def _detailing_from(spec: dict, trans: TransverseReinf, long: LongitudinalReinf,
                    mat: Materials) -> Detailing:
    """Chequeos NSR-10 C.21 básicos — más completos en Fase 2."""
    s_over_db = trans.s_confined_mm / max(long.db_mm, 1.0)

    # DES (ACI 318-19 §18.7.5.4): ρ_sh ≥ 0.09·f'c/fyh
    rho_min_DES = 0.09 * mat.fc_MPa / max(mat.fyh_MPa, 1.0)
    # DMO (NSR-10 C.21.3.5.3 / ACI §18.4.3): más laxo ≈ 0.5 × DES
    rho_min_DMO = 0.5 * rho_min_DES

    ed = str(spec.get("general", {}).get("energy_dissipation", "DMO")).upper()
    level: Literal["DES", "DMO", "DMI", "no_sismico", "unknown"] = (
        "DES" if ed == "DES" else ("DMO" if ed == "DMO" else "DMI" if ed == "DMI" else "unknown")
    )

    return Detailing(
        splice_in_hinge  = False,                      # editable vía CSV
        s_over_db_long   = s_over_db,
        rho_sh_meets_DES = trans.rho_sh >= rho_min_DES,
        rho_sh_meets_DMO = trans.rho_sh >= rho_min_DMO,
        compliance_level = level,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Punto de entrada
# ─────────────────────────────────────────────────────────────────────────────
def elements_from_spec(
    spec: dict,
    axial_json: Optional[dict] = None,
    observations: Optional[dict[str, dict]] = None,
) -> dict[str, ElementData]:
    """Pobla un ElementData por cada columna y viga del spec.

    Args:
        spec:           nonlinear_model.json cargado como dict.
        axial_json:     opcional — {fid: {N_grav_kN, N_min_kN?, N_max_kN?}}
                        producido por extract_axial_from_gravity().
        observations:   opcional — {fid: {L_p_measured_mm?, hook_type?,
                                          splice_in_hinge?, damage_notes?,
                                          photo_path?, fu_MPa?, eps_su?}}
                        cargado desde observations.csv.

    Returns:
        {fid: ElementData}
    """
    out: dict[str, ElementData] = {}
    axial_json  = axial_json or {}
    observations = observations or {}

    section_types = spec.get("section_types", {})

    # Columnas
    for fid, ele in spec.get("elements", {}).get("columns", {}).items():
        _populate_one(fid, ele, "column", spec, section_types,
                      axial_json, observations, out)

    # Vigas
    for fid, ele in spec.get("elements", {}).get("beams", {}).items():
        _populate_one(fid, ele, "beam", spec, section_types,
                      axial_json, observations, out)

    return out


def _populate_one(
    fid:          str,
    ele:          dict,
    kind:         Literal["column", "beam"],
    spec:         dict,
    section_types: dict,
    axial_json:   dict,
    observations: dict,
    out:          dict,
) -> None:
    reinf = ele.get("reinforcement", {})
    conf  = ele.get("confinement", {})
    sec_name = str(ele.get("section", ""))
    sec_meta = section_types.get(sec_name, {})
    mat_concrete = str(sec_meta.get("material_concrete", ""))

    mat = _materials_from_spec(spec, mat_concrete)

    # Diámetros representativos para calcular d (peralte efectivo)
    if kind == "column":
        label_long = str(reinf.get("longitudinal", {}).get("bar_label", "#5"))
        label_tie  = str(reinf.get("transverse",   {}).get("tie_bar_label", "#3"))
        db_long = _db(label_long)
        db_tie  = _db(label_tie, default=9.5)
        geo = _geometry_from_column(ele, db_long, db_tie)
        long_r = _column_longitudinal(reinf, geo.b_m, geo.h_m)
        tran_r = _column_transverse(reinf, conf, geo.b_m, geo.h_m)
    else:
        zones = reinf.get("zones", {})
        label_long = str(zones.get("end_i", {}).get("top", {}).get("bar_label", "#5"))
        label_tie  = str(reinf.get("shear",   {}).get("tie_bar_label", "#3"))
        db_long = _db(label_long)
        db_tie  = _db(label_tie, default=9.5)
        geo = _geometry_from_beam(ele, db_long, db_tie)
        long_r = _beam_longitudinal(reinf, geo.b_m, geo.h_m)
        tran_r = _beam_transverse(reinf, conf, geo.b_m, geo.h_m)

    # Observaciones de campo pueden overridear fu/eps_su (acero envejecido, etc.)
    obs = observations.get(fid, {}) if observations else {}
    if "fu_MPa" in obs and obs["fu_MPa"]:
        mat.fu_MPa = float(obs["fu_MPa"])
    if "eps_su" in obs and obs["eps_su"]:
        mat.eps_su = float(obs["eps_su"])

    detailing = _detailing_from(spec, tran_r, long_r, mat)
    if "splice_in_hinge" in obs:
        detailing.splice_in_hinge = bool(obs["splice_in_hinge"])
    if "hook_type" in obs and obs["hook_type"] in ("90deg", "135deg", "unknown"):
        tran_r.hook_type = obs["hook_type"]       # type: ignore[assignment]

    axial = AxialState()
    ax_entry = axial_json.get(fid, {})
    if ax_entry:
        axial.N_grav_kN = float(ax_entry.get("N_grav_kN", 0.0))
        if "N_min_kN" in ax_entry:
            axial.N_min_kN = float(ax_entry["N_min_kN"])
        if "N_max_kN" in ax_entry:
            axial.N_max_kN = float(ax_entry["N_max_kN"])
    axial.recompute_nu(geo, mat)

    fobs = FieldObservations(
        L_p_measured_mm = float(obs["L_p_measured_mm"]) if obs.get("L_p_measured_mm") else None,
        L_p_method      = (obs.get("L_p_method") or
                           ("measured" if obs.get("L_p_measured_mm") else "paulay_priestley")),
        damage_notes    = obs.get("damage_notes"),
        photo_path      = obs.get("photo_path"),
    )

    out[fid] = ElementData(
        fid           = fid,
        kind          = kind,
        story         = str(ele.get("story", "")),
        section_name  = sec_name,
        node_i        = str(ele.get("node_i", "")),
        node_j        = str(ele.get("node_j", "")),
        geometry      = geo,
        materials     = mat,
        longitudinal  = long_r,
        transverse    = tran_r,
        axial         = axial,
        detailing     = detailing,
        field         = fobs,
        has_design    = bool(ele.get("has_design", True)),
    )


# ─────────────────────────────────────────────────────────────────────────────
# CSV loader para completitud + observaciones
# ─────────────────────────────────────────────────────────────────────────────
_OBS_COLUMNS = {
    "fid":              str,
    "L_p_measured_mm":  float,
    "L_p_method":       str,
    "hook_type":        str,
    "splice_in_hinge":  bool,
    "fu_MPa":           float,
    "eps_su":           float,
    "damage_notes":     str,
    "photo_path":       str,
}


def load_observations_csv(path: Path | str) -> dict[str, dict]:
    """Lee observations.csv con columnas opcionales (ver _OBS_COLUMNS).

    Formato esperado — fid obligatorio, resto opcional. Celdas vacías se omiten.

        fid,L_p_measured_mm,hook_type,splice_in_hinge,fu_MPa,eps_su,damage_notes
        C-B2-1,350,135deg,FALSE,,,"fisura 2mm en cara sur"
        C-A1-2,,90deg,TRUE,,,
    """
    path = Path(path)
    if not path.exists():
        return {}

    out: dict[str, dict] = {}
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            fid = (row.get("fid") or "").strip()
            if not fid:
                continue
            entry: dict[str, Any] = {}
            for col, typ in _OBS_COLUMNS.items():
                if col == "fid":
                    continue
                raw = (row.get(col) or "").strip()
                if not raw:
                    continue
                try:
                    if typ is float:
                        entry[col] = float(raw)
                    elif typ is bool:
                        entry[col] = raw.lower() in ("true", "1", "yes", "y", "si", "sí")
                    else:
                        entry[col] = raw
                except (ValueError, TypeError):
                    continue
            out[fid] = entry
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Lectura del extractor de axial
# ─────────────────────────────────────────────────────────────────────────────
def load_axial_from_gravity(path: Path | str) -> dict[str, dict]:
    """Lee axial_from_gravity.json (producido por run_gravity extendido)."""
    path = Path(path)
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
