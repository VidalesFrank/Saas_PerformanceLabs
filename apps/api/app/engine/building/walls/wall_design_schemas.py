"""Esquemas de datos para diseño de muros RC — NSR-10 / ACI 318-25."""
from __future__ import annotations
import math
from dataclasses import dataclass, field
from typing import List, Literal, Optional

DuctilityLevel = Literal["DMO", "DES"]
DesignMode = Literal["auto", "manual"]

# Base de datos de barras comerciales (mm → área mm²).
# Colombia: catálogo estándar ASTM A615 usado en obra = #2, #3, #4, #5, #6, #7, #8, #10.
# #9 y #11 no son comerciales en el mercado local y se excluyen.
BAR_DB: dict[float, float] = {
    6.4:  32.0,    # #2  (¼")
    9.5:  71.0,    # #3  (⅜")
    12.7: 129.0,   # #4  (½")
    15.9: 199.0,   # #5  (⅝")
    19.1: 284.0,   # #6  (¾")
    22.2: 387.0,   # #7  (⅞")
    25.4: 510.0,   # #8  (1")
    32.3: 819.0,   # #10 (1¼")
    # Métricas — sólo lookup interno para import (no picker de UI)
    12.0: 113.0,
    16.0: 201.0,
    19.0: 284.0,
    25.0: 491.0,
    32.0: 804.0,
}

STANDARD_DIAMETERS_MM = sorted(BAR_DB.keys())

# Umbral geométrico de cortinas: tw ≤ este valor → 1 cortina, > → 2 cortinas.
# Regla constructiva: en muros de 15 cm no cabe malla en 2 capas con recubrimiento.
TW_SINGLE_CURTAIN_M = 0.15


def curtains_for_tw(tw_m: float) -> int:
    """Cortinas de refuerzo permitidas por espesor del muro (regla geométrica)."""
    return 1 if tw_m <= TW_SINGLE_CURTAIN_M else 2


def bar_area(db_mm: float) -> float:
    """Área de una barra dada su diámetro en mm."""
    if db_mm in BAR_DB:
        return BAR_DB[db_mm]
    import math
    return math.pi * db_mm**2 / 4.0


@dataclass
class WallDemandCombo:
    """Combinación de carga de diseño para un muro."""
    label: str
    Pu_kN: float      # Axial (+ = compresión)
    Vu_kN: float      # Cortante (siempre positivo, envolvente)
    Mu_kNm: float     # Momento (siempre positivo, envolvente)
    is_seismic: bool = True


@dataclass
class BoundaryZoneReinf:
    """
    Refuerzo de una zona de borde (EBE).

    n_bars     : barras longitudinales por CORTINA. Un valor de 0 codifica
                 "sin EBE": el motor no genera zona de borde, el refuerzo del
                 alma se distribuye a lo largo de todo lw. En ese caso length_m
                 también debe ser 0.
    n_curtains : SIN default — debe fijarse por regla geométrica del espesor
                 (`curtains_for_tw`). Un pipeline que lo omita rompe con
                 muros delgados.
    As_total   = n_bars × n_curtains × área(db).
    """
    n_bars: int             # barras longitudinales por cortina (0 = sin EBE)
    db_mm: float            # diámetro barra longitudinal (mm)
    cover_mm: float         # recubrimiento libre a la cara (mm)
    tie_db_mm: float        # diámetro estribo (mm)
    tie_spacing_mm: float   # espaciado estribos (mm)
    length_m: float         # longitud del elemento de borde (m; 0 = sin EBE)
    n_curtains: int = 1     # placeholder — override obligatorio con curtains_for_tw(tw)
    n_legs_b: int = 2       # patas del estribo en dirección b (espesor)
    n_legs_h: int = 2       # patas del estribo en dirección h (longitud EBE)

    @property
    def As_mm2(self) -> float:
        return self.n_bars * self.n_curtains * bar_area(self.db_mm)

    @property
    def is_empty(self) -> bool:
        """True cuando no hay EBE (muro con refuerzo distribuido en todo lw)."""
        return self.n_bars <= 0 or self.length_m <= 0.0


@dataclass
class WebZoneReinf:
    """Refuerzo del alma (zona intermedia) del muro."""
    vert_db_mm: float          # diámetro barra vertical (mm)
    vert_spacing_mm: float     # espaciado barra vertical (mm)
    horiz_db_mm: float         # diámetro barra horizontal (mm)
    horiz_spacing_mm: float    # espaciado barra horizontal (mm)
    n_curtains: int = 1        # placeholder — override obligatorio con curtains_for_tw(tw)

    @property
    def rho_v(self) -> float:
        """Cuantía vertical del alma."""
        return self.n_curtains * bar_area(self.vert_db_mm) / (self.vert_spacing_mm * 1000)  # ÷ tw pero sin tw aquí

    def rho_v_with_tw(self, tw_m: float) -> float:
        As_per_m = self.n_curtains * bar_area(self.vert_db_mm) / (self.vert_spacing_mm / 1000)  # mm²/m
        return As_per_m / (tw_m * 1e6)  # mm²/m ÷ mm²/m

    def rho_h_with_tw(self, tw_m: float) -> float:
        As_per_m = self.n_curtains * bar_area(self.horiz_db_mm) / (self.horiz_spacing_mm / 1000)
        return As_per_m / (tw_m * 1e6)


@dataclass
class WallReinforcement:
    """Refuerzo completo de un muro rectangular."""
    be_left: BoundaryZoneReinf
    web: WebZoneReinf
    be_right: BoundaryZoneReinf
    symmetric: bool = True

    def all_bars(self, lw_m: float, tw_m: float, cover_mm: float = 40.0) -> List[dict]:
        """
        Lista de barras con posición (x, y) en la sección plana del muro.
          x : m desde el extremo izquierdo (a lo largo de lw)
          y : m desde la cara inferior (a lo largo de tw); útil para 2 cortinas
        Convenio: (0,0) en la esquina inferior-izquierda.

        Si el muro no tiene EBE (be_left.is_empty y be_right.is_empty), el
        refuerzo del alma se distribuye a lo largo de todo lw con recubrimiento
        de borde igual al del alma.
        """
        bars: List[dict] = []

        def _emit_be_bars(zone: "BoundaryZoneReinf", x_offset: float) -> None:
            n     = zone.n_bars
            lc    = zone.length_m
            n_cur = max(1, zone.n_curtains)
            cov_side = zone.cover_mm / 1000 + zone.tie_db_mm / 1000 + zone.db_mm / 2000
            cov_face = zone.cover_mm / 1000 + zone.tie_db_mm / 1000 + zone.db_mm / 2000
            if n > 1:
                spacing_x = (lc - 2 * cov_side) / (n - 1)
            else:
                spacing_x = 0.0
            if n_cur == 1:
                y_positions = [tw_m / 2]                          # 1 cortina centrada
            else:
                y_positions = [cov_face, tw_m - cov_face]          # 2 cortinas
            area_bar = bar_area(zone.db_mm)
            for cy in y_positions:
                for i in range(n):
                    bars.append({
                        "x":    x_offset + cov_side + i * spacing_x,
                        "y":    cy,
                        "As":   area_bar,
                        "db":   zone.db_mm,
                        "zone": "boundary",
                    })

        be_r = self.be_right if not self.symmetric else self.be_left
        has_ebe = not (self.be_left.is_empty and be_r.is_empty)

        # Emitir BEs solo si el muro tiene EBE real
        if has_ebe:
            if not self.be_left.is_empty:
                _emit_be_bars(self.be_left, x_offset=0.0)
            if not be_r.is_empty:
                _emit_be_bars(be_r, x_offset=lw_m - be_r.length_m)

        # Rango del alma: todo lw si no hay EBE, si no entre los BE.
        web = self.web
        if has_ebe:
            web_start = self.be_left.length_m if not self.be_left.is_empty else 0.0
            web_end   = (lw_m - be_r.length_m) if not be_r.is_empty else lw_m
        else:
            cov_end   = 0.04  # 40 mm recubrimiento típico en extremos sin EBE
            web_start = cov_end
            web_end   = lw_m - cov_end
        web_len = web_end - web_start
        if web_len > 0:
            sp_target = max(web.vert_spacing_mm / 1000, 1e-6)
            # n_intervals garantiza que sp_efectivo = web_len/n_intervals ≤ sp_target.
            # Piso: 2 barras si no hay EBE (muros distribuidos), 1 si hay EBE.
            n_intervals = max(1, math.ceil(web_len / sp_target))
            min_bars    = 2 if not has_ebe else 1
            n_web       = max(min_bars, n_intervals - 1)
            sp_web      = web_len / (n_web + 1)
            area_v = bar_area(web.vert_db_mm)
            n_cur  = max(1, web.n_curtains)
            cov_face_web = 0.025  # 25 mm típico para malla web
            if n_cur == 1:
                y_positions = [tw_m / 2]
            else:
                y_positions = [cov_face_web, tw_m - cov_face_web]
            for cy in y_positions:
                for i in range(1, n_web + 1):
                    bars.append({
                        "x":    web_start + i * sp_web,
                        "y":    cy,
                        "As":   area_v,
                        "db":   web.vert_db_mm,
                        "zone": "web",
                    })

        return sorted(bars, key=lambda b: (b["x"], b["y"]))


@dataclass
class NeutralAxisResult:
    c_m: float
    a_m: float
    beta1: float
    Pn_kN: float
    Mn_kNm: float
    phi_flexure: float
    phiPn_kN: float
    phiMn_kNm: float
    steel_strains: List[float]
    epsilon_cu: float = 0.003
    ok: bool = True
    message: str = ""


@dataclass
class BoundaryElementResult:
    required: bool
    method: str            # "stress" | "displacement" | "none"
    lc_m: float            # longitud EBE calculada (m)
    c_m: float             # eje neutro (m)
    sigma_max_mpa: float   # esfuerzo máximo fibra extrema (MPa)
    threshold_mpa: float   # umbral para requerir EBE
    c_limit_m: Optional[float] = None   # límite eje neutro (método deformación)
    drift_ratio: Optional[float] = None
    ductility: str = "DES"
    message: str = ""


@dataclass
class ShearDesignResult:
    hw_lw: float
    alpha_c: float
    Acv_m2: float
    Vn_max_kN: float       # Vn con rho_t diseñado
    phi_Vn_kN: float
    Vu_kN: float
    rho_t_required: float  # cuantía horizontal requerida
    rho_t_provided: float  # cuantía horizontal provista
    rho_v_provided: float  # cuantía vertical provista
    Vn_limit_kN: float     # límite máximo Vn = 0.83√f'c Acv (kN)
    ok_shear: bool
    ok_rho_t_min: bool
    ok_rho_v_min: bool
    ok_vn_limit: bool
    phi: float = 0.75


@dataclass
class CodeCheck:
    article: str           # "NSR-10 C.21.9.2" etc.
    description: str
    demand: float
    capacity: float
    unit: str
    ok: bool
    dcr: float             # demand/capacity ratio


@dataclass
class InteractionDiagram:
    Pn_kN: List[float]
    Mn_kNm: List[float]
    phiPn_kN: List[float]
    phiMn_kNm: List[float]


@dataclass
class WallDesignResult:
    reinforcement: WallReinforcement
    neutral_axis: NeutralAxisResult          # combinación gobernante
    boundary_element: BoundaryElementResult
    shear: ShearDesignResult
    interaction: InteractionDiagram
    demand_points: List[dict]               # [{label, Pu, Mu, inside}]
    checks: List[CodeCheck]
    is_ok: bool
    governing_combo_label: str
    summary: dict
