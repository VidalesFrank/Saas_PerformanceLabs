"""Esquemas de datos para diseño de muros RC — NSR-10 / ACI 318-25."""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import List, Literal, Optional

DuctilityLevel = Literal["DMO", "DES"]
DesignMode = Literal["auto", "manual"]

# Base de datos de barras estándar (diámetro mm → área mm²)
BAR_DB: dict[float, float] = {
    9.5:  71.0,    # #3
    12.7: 129.0,   # #4
    15.9: 199.0,   # #5
    19.1: 284.0,   # #6
    22.2: 387.0,   # #7
    25.4: 510.0,   # #8
    32.3: 819.0,   # #10
    35.8: 1006.0,  # #11
    12.0: 113.0,   # 12mm métrico
    16.0: 201.0,   # 16mm métrico
    19.0: 284.0,   # 19mm métrico
    25.0: 491.0,   # 25mm métrico
    32.0: 804.0,   # 32mm métrico
}

STANDARD_DIAMETERS_MM = sorted(BAR_DB.keys())


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
    """Refuerzo de una zona de borde."""
    n_bars: int             # número de barras longitudinales
    db_mm: float            # diámetro barra longitudinal (mm)
    cover_mm: float         # recubrimiento libre (mm)
    tie_db_mm: float        # diámetro estribo (mm)
    tie_spacing_mm: float   # espaciado estribos (mm)
    length_m: float         # longitud del elemento de borde (m)
    n_legs_b: int = 2       # patas del estribo en dirección b (espesor)
    n_legs_h: int = 2       # patas del estribo en dirección h (longitud EBE)

    @property
    def As_mm2(self) -> float:
        return self.n_bars * bar_area(self.db_mm)


@dataclass
class WebZoneReinf:
    """Refuerzo del alma (zona intermedia) del muro."""
    vert_db_mm: float          # diámetro barra vertical (mm)
    vert_spacing_mm: float     # espaciado barra vertical (mm)
    horiz_db_mm: float         # diámetro barra horizontal (mm)
    horiz_spacing_mm: float    # espaciado barra horizontal (mm)
    n_curtains: int = 2        # cortinas de refuerzo (1 o 2)

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
        Devuelve lista de barras con posición x (m desde fibra izquierda).
        Convenio: x=0 en extremo izquierdo.
        """
        bars = []
        # BE izquierdo
        be_l = self.be_left
        n = be_l.n_bars
        lc = be_l.length_m
        cov = be_l.cover_mm / 1000 + be_l.tie_db_mm / 1000 / 2
        if n > 1:
            spacing = (lc - 2 * cov) / (n - 1)
        else:
            spacing = 0
        for i in range(n):
            bars.append({"x": cov + i * spacing, "As": bar_area(be_l.db_mm)})

        # BE derecho (simétrico o no)
        be_r = self.be_right if not self.symmetric else self.be_left
        n = be_r.n_bars
        lc = be_r.length_m
        cov = be_r.cover_mm / 1000 + be_r.tie_db_mm / 1000 / 2
        if n > 1:
            spacing = (lc - 2 * cov) / (n - 1)
        else:
            spacing = 0
        for i in range(n):
            bars.append({"x": lw_m - lc + cov + i * spacing, "As": bar_area(be_r.db_mm)})

        # Alma (web) - barras verticales distribuidas
        web = self.web
        be_llen = self.be_left.length_m
        be_rlen = be_r.length_m
        web_start = be_llen
        web_end = lw_m - be_rlen
        web_len = web_end - web_start
        if web_len > 0:
            n_web = max(int(web_len / (web.vert_spacing_mm / 1000)) - 1, 0)
            if n_web > 0:
                sp_web = web_len / (n_web + 1)
                for i in range(1, n_web + 1):
                    bars.append({"x": web_start + i * sp_web, "As": bar_area(web.vert_db_mm) * web.n_curtains / 2})
                    # n_curtains / 2 porque contamos ambos lados y cada bar is one row

        return sorted(bars, key=lambda b: b["x"])


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
