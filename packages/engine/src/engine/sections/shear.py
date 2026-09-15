"""Diseño y verificación por cortante — NSR-10 Título C.11 y ACI 318-19 §22.5.

Motor puro en unidades internas SI: N, mm, MPa.

Salidas: dataclass `ShearCheck` con Vc, Vs, φVn, DCR, espaciamiento máximo,
Av mínimo requerido, artículos de referencia por línea de cálculo y notas.

Códigos soportados:
  - "NSR-10"      (Reglamento Colombiano de Construcción Sismo Resistente, 2010)
  - "ACI 318-19"  (Building Code Requirements for Structural Concrete)

Ambos calculan lo mismo en el 80% de los casos; difieren principalmente en Vc
para elementos sin refuerzo transversal mínimo (ACI 318-19 introdujo un factor
de tamaño λs y dependencia de ρw^(1/3) que NSR-10 no tiene).

Los factores φ = 0.75 son idénticos (NSR-10 C.9.3.2.3, ACI 318-19 §21.2.1b).
El límite Vs ≤ 0.66·√f'c·bw·d es idéntico (C.11.4.7.9, ACI §22.5.1.2).

Convenciones:
  - Nu positivo en compresión (ambos códigos).
  - Todas las salidas en N (dividir por 1000 para kN en UI).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Literal


CodeName    = Literal["NSR-10", "ACI 318-19"]
ElementKind = Literal["beam", "column", "wall"]
Ductility   = Literal["DMI", "DMO", "DES"]   # NSR-10; para ACI mapear OMF→DMI, IMF→DMO, SMF→DES

PHI_SHEAR   = 0.75    # C.9.3.2.3  /  ACI §21.2.1(b)


# ─────────────────────────────────────────────────────────────────────────────
# Estructuras de entrada / salida
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class ShearDemand:
    """Cortante y cargas concurrentes de diseño."""
    Vu_N:  float             # cortante último
    Nu_N:  float = 0.0       # carga axial concurrente (+ compresión, − tracción)
    Mu_Nmm: float = 0.0      # momento concurrente


@dataclass
class TransverseReinforcement:
    """Refuerzo transversal (estribos)."""
    Av_mm2:  float           # área total de ramas perpendiculares al cortante
    s_mm:    float           # espaciamiento longitudinal
    fyt_MPa: float           # fluencia del acero transversal


@dataclass
class ShearGeometry:
    """Geometría relevante para cortante."""
    bw_mm: float             # ancho del alma
    d_mm:  float             # canto útil (centro barra tracción → fibra extrema comprimida)
    Ag_mm2: float            # área bruta de concreto
    h_mm:  float             # altura total (opcional, para muros lw)
    lw_mm: float = 0.0       # longitud del muro (0 = no aplica)


@dataclass
class ShearCheck:
    """Resultado del chequeo de cortante en un elemento."""
    code:         str
    element:      str
    ductility:    str
    # Componentes
    Vc_N:         float
    Vs_N:         float
    Vn_N:         float
    phi_Vn_N:     float
    Vu_N:         float
    DCR:          float
    status:       str        # "ok" | "warning" | "fail" | "no-transverse"
    # Espaciamientos y refuerzo mínimo
    s_max_mm:     float
    Av_min_mm2:   float
    # Referencias por línea
    articles:     dict[str, str] = field(default_factory=dict)
    notes:        list[str]      = field(default_factory=list)


# ─────────────────────────────────────────────────────────────────────────────
# Factor lambda para concreto ligero (ambos códigos)
# ─────────────────────────────────────────────────────────────────────────────

def lambda_normal() -> float:
    return 1.0

def lambda_sand_lightweight() -> float:
    return 0.85

def lambda_all_lightweight() -> float:
    return 0.75


# ─────────────────────────────────────────────────────────────────────────────
# Vc — NSR-10 C.11.2
# ─────────────────────────────────────────────────────────────────────────────

def _vc_nsr10(
    element: ElementKind,
    fpc: float, bw: float, d: float, Ag: float,
    Nu: float,
    lam: float,
) -> tuple[float, str]:
    """Retorna (Vc [N], artículo)."""
    if fpc <= 0 or bw <= 0 or d <= 0:
        return 0.0, "C.11.2"

    sqrt_fpc = math.sqrt(fpc)

    if element == "column":
        # C.11.2.1.2 con Nu (compresión: aumenta Vc)
        if Nu >= 0:
            Vc = 0.17 * (1.0 + Nu / (14.0 * Ag)) * lam * sqrt_fpc * bw * d
            return max(Vc, 0.0), "C.11.2.1.2"
        else:
            # Tracción — C.11.2.1.3
            Vc = 0.17 * (1.0 + 0.29 * Nu / Ag) * lam * sqrt_fpc * bw * d
            return max(Vc, 0.0), "C.11.2.1.3"

    if element == "wall":
        # C.11.10.5 simplificado
        Vc = 0.17 * lam * sqrt_fpc * bw * d
        return Vc, "C.11.10.5"

    # Viga u otros → C.11.2.1.1
    Vc = 0.17 * lam * sqrt_fpc * bw * d
    return Vc, "C.11.2.1.1"


# ─────────────────────────────────────────────────────────────────────────────
# Vc — ACI 318-19 §22.5.5
# ─────────────────────────────────────────────────────────────────────────────

def _lambda_s(d_mm: float) -> float:
    """Size effect factor ACI 22.5.5.1.3 (SI): λs = √(2/(1 + 0.004·d)) ≤ 1.0."""
    return min(math.sqrt(2.0 / (1.0 + 0.004 * d_mm)), 1.0)


def _vc_aci318_19(
    element: ElementKind,
    fpc: float, bw: float, d: float, Ag: float,
    Nu: float,
    rho_w: float,
    lam: float,
    has_min_shear_reinf: bool,
) -> tuple[float, str]:
    """Retorna (Vc [N], artículo) para ACI 318-19 §22.5.5.1 (SI, MPa/mm/N).

    Nu positivo = compresión (mismo convenio que NSR-10). Rho_w = As/(bw·d).
    """
    if fpc <= 0 or bw <= 0 or d <= 0:
        return 0.0, "22.5.5"

    sqrt_fpc = math.sqrt(fpc)

    if element == "wall":
        # Muros por §11.5.4.6 (fórmula simplificada similar a NSR-10)
        Vc = 0.17 * lam * sqrt_fpc * bw * d
        return Vc, "11.5.4.6"

    # Nueva formulación 2019 — Tabla 22.5.5.1
    axial_term = Nu / (6.0 * Ag) if Ag > 0 else 0.0

    if has_min_shear_reinf:
        # (a) o (b): la que dé mayor Vc para el diseñador; usaremos (b) que aprovecha ρw
        # y ≥ (a). Nota: código dice "el mayor de (a) o (b)".
        rho_w_safe = max(rho_w, 1e-6)
        Vc_b = (0.66 * lam * (rho_w_safe ** (1.0/3.0)) * sqrt_fpc + axial_term) * bw * d
        Vc_a = (0.17 * lam * sqrt_fpc + axial_term) * bw * d
        Vc = max(Vc_a, Vc_b)
        return max(Vc, 0.0), "22.5.5.1(a-b)"

    # Sin refuerzo mínimo → aplica size effect λs (c)
    lam_s = _lambda_s(d)
    rho_w_safe = max(rho_w, 1e-6)
    Vc_c = (0.66 * lam_s * lam * (rho_w_safe ** (1.0/3.0)) * sqrt_fpc + axial_term) * bw * d
    return max(Vc_c, 0.0), "22.5.5.1(c)"


# ─────────────────────────────────────────────────────────────────────────────
# Vs — común a ambos códigos (misma fórmula)
# ─────────────────────────────────────────────────────────────────────────────

def _vs(Av: float, fyt: float, d: float, s: float) -> float:
    if Av <= 0 or fyt <= 0 or d <= 0 or s <= 0:
        return 0.0
    return Av * fyt * d / s


def _vs_max(fpc: float, bw: float, d: float) -> float:
    """Vs máximo permitido — 0.66·√f'c·bw·d (C.11.4.7.9 / ACI 22.5.1.2)."""
    return 0.66 * math.sqrt(fpc) * bw * d


# ─────────────────────────────────────────────────────────────────────────────
# Espaciamiento máximo — común (C.11.4.5.1 / ACI 9.7.6.2.2)
# ─────────────────────────────────────────────────────────────────────────────

def _s_max_general(Vs: float, fpc: float, bw: float, d: float) -> float:
    """s ≤ min(d/2, 600 mm) si Vs ≤ 0.33·√f'c·bw·d, si no d/4 y 300 mm."""
    threshold = 0.33 * math.sqrt(fpc) * bw * d
    if Vs <= threshold:
        return min(d / 2.0, 600.0)
    return min(d / 4.0, 300.0)


def _s_max_confined(element: ElementKind, ductility: Ductility, code: CodeName,
                    d: float, db_long: float, dim_min: float) -> float | None:
    """Separación máxima en zona confinada por requisitos sísmicos.

    Retorna None si el elemento/ductilidad no requiere zona confinada.
    """
    if ductility == "DMI":
        return None
    if element == "beam":
        if ductility == "DMO":
            # C.21.3.4.2 vigas DMO: min(d/4, 8·db, 24·db_est, 300)
            return min(d / 4.0, 8.0 * db_long, 300.0)   # db_est se compara aparte
        if ductility == "DES":
            # C.21.5.3.2 vigas DES en 2h desde apoyo: min(d/4, 6·db, 150)
            return min(d / 4.0, 6.0 * db_long, 150.0)
    if element == "column":
        if ductility == "DMO":
            # C.21.4.4.3 columnas DMO en Lo
            return min(dim_min / 4.0, 8.0 * db_long, 300.0)
        if ductility == "DES":
            # C.21.6.4.3 columnas DES en Lo
            return min(dim_min / 4.0, 6.0 * db_long, 150.0)
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Refuerzo transversal mínimo Av,min
# ─────────────────────────────────────────────────────────────────────────────

def _av_min(fpc: float, bw: float, s: float, fyt: float) -> float:
    """Av,min = max(0.062·√f'c·bw·s/fyt, 0.35·bw·s/fyt) [mm²].

    NSR-10 C.11.4.6.3 / ACI 318-19 §9.6.3.4 (idénticas).
    """
    if bw <= 0 or s <= 0 or fyt <= 0:
        return 0.0
    a = 0.062 * math.sqrt(max(fpc, 0)) * bw * s / fyt
    b = 0.35 * bw * s / fyt
    return max(a, b)


# ─────────────────────────────────────────────────────────────────────────────
# Función pública principal
# ─────────────────────────────────────────────────────────────────────────────

def compute_shear_check(
    code:      CodeName,
    element:   ElementKind,
    ductility: Ductility,
    fpc_MPa:   float,
    geom:      ShearGeometry,
    demand:    ShearDemand,
    rho_w:     float = 0.01,      # cuantía longitudinal (ACI 22.5.5.1)
    lam:       float = 1.0,        # factor concreto ligero
    transverse: TransverseReinforcement | None = None,
    db_long_mm: float = 25.4,     # db barra longitudinal para espaciamiento sísmico
    dim_min_mm: float | None = None,
) -> ShearCheck:
    """Chequeo completo de cortante en un elemento.

    Args:
        code:       "NSR-10" o "ACI 318-19".
        element:    "beam", "column" o "wall".
        ductility:  "DMI" | "DMO" | "DES".
        fpc_MPa:    resistencia del concreto en MPa.
        geom:       ancho de alma bw, canto útil d, área bruta Ag, altura h.
        demand:     Vu, Nu, Mu de la combinación de carga.
        rho_w:      cuantía longitudinal As/(bw·d) — solo usa ACI.
        lam:        factor de concreto ligero (1.0 normal, 0.85 arena, 0.75 todo).
        transverse: refuerzo transversal (opcional; None = sin estribos).
        db_long_mm: diámetro de barra longitudinal (para separación sísmica).
        dim_min_mm: dimensión menor de la columna (para espaciamiento sísmico columnas).
    """
    bw = geom.bw_mm
    d  = geom.d_mm
    Ag = geom.Ag_mm2
    Nu = demand.Nu_N
    Vu = demand.Vu_N

    dim_min = dim_min_mm if dim_min_mm is not None else bw

    # ── Vc según código ──
    has_min = (transverse is not None
               and transverse.Av_mm2 >= _av_min(fpc_MPa, bw, transverse.s_mm, transverse.fyt_MPa))
    if code == "NSR-10":
        Vc, art_vc = _vc_nsr10(element, fpc_MPa, bw, d, Ag, Nu, lam)
    else:
        Vc, art_vc = _vc_aci318_19(element, fpc_MPa, bw, d, Ag, Nu, rho_w, lam, has_min)

    # ── Vs ──
    if transverse:
        Vs = _vs(transverse.Av_mm2, transverse.fyt_MPa, d, transverse.s_mm)
    else:
        Vs = 0.0

    # ── Aplicar Vs máximo ──
    Vs_lim = _vs_max(fpc_MPa, bw, d)
    Vs_capped = min(Vs, Vs_lim)

    # ── Sumar y aplicar φ ──
    Vn     = Vc + Vs_capped
    phi_Vn = PHI_SHEAR * Vn

    DCR = Vu / phi_Vn if phi_Vn > 0 else float("inf")

    # ── Espaciamiento máximo ──
    s_max_gen = _s_max_general(Vs_capped, fpc_MPa, bw, d)
    s_max_seis = _s_max_confined(element, ductility, code, d, db_long_mm, dim_min)
    s_max_total = s_max_gen if s_max_seis is None else min(s_max_gen, s_max_seis)

    # ── Av,min para el s actual ──
    Av_min = _av_min(fpc_MPa, bw,
                     transverse.s_mm if transverse else s_max_total,
                     transverse.fyt_MPa if transverse else 420.0)

    # ── Notas y estado ──
    notes: list[str] = []
    status = "ok"

    if transverse is None:
        # Sin refuerzo transversal — φVc debería exceder Vu, o requiere Av,min
        phi_Vc = PHI_SHEAR * Vc
        if Vu > phi_Vc:
            status = "no-transverse"
            notes.append(f"Vu = {Vu/1000:.1f} kN excede φVc = {phi_Vc/1000:.1f} kN → requiere estribos.")
    else:
        if DCR > 1.0:
            status = "fail"
            notes.append(f"DCR = {DCR:.2f} > 1.0 — la sección no resiste Vu.")
        elif DCR > 0.90:
            status = "warning"
            notes.append(f"DCR = {DCR:.2f} — muy cercano al límite; considerar aumentar refuerzo.")
        if Vs > Vs_lim:
            status = "fail"
            notes.append(f"Vs solicitado ({Vs/1000:.1f} kN) supera Vs,máx = 0.66·√f'c·bw·d "
                         f"({Vs_lim/1000:.1f} kN). Aumentar sección o f'c.")
        if transverse.s_mm > s_max_total:
            note_art = ("C.11.4.5" if code == "NSR-10" else "9.7.6.2.2")
            if s_max_seis is not None and transverse.s_mm > s_max_seis:
                note_art += " + sísmico"
            notes.append(f"Espaciamiento s = {transverse.s_mm:.0f} mm excede s_máx = "
                         f"{s_max_total:.0f} mm ({note_art}).")
            if status == "ok":
                status = "warning"
        if transverse.Av_mm2 < Av_min:
            notes.append(f"Av = {transverse.Av_mm2:.0f} mm² < Av,min = {Av_min:.0f} mm² "
                         f"(C.11.4.6.3 / ACI 9.6.3.4).")
            if status == "ok":
                status = "warning"

    articles = {
        "Vc":     art_vc,
        "Vs":     "C.11.4.7.2" if code == "NSR-10" else "22.5.10.5.3",
        "phi":    "C.9.3.2.3"  if code == "NSR-10" else "21.2.1(b)",
        "s_max":  "C.11.4.5"   if code == "NSR-10" else "9.7.6.2.2",
        "Av_min": "C.11.4.6.3" if code == "NSR-10" else "9.6.3.4",
        "Vs_max": "C.11.4.7.9" if code == "NSR-10" else "22.5.1.2",
    }
    if s_max_seis is not None:
        articles["s_max_seismic"] = _seismic_article(element, ductility)

    return ShearCheck(
        code=code, element=element, ductility=ductility,
        Vc_N=Vc, Vs_N=Vs_capped, Vn_N=Vn, phi_Vn_N=phi_Vn,
        Vu_N=Vu, DCR=DCR, status=status,
        s_max_mm=s_max_total, Av_min_mm2=Av_min,
        articles=articles, notes=notes,
    )


def _seismic_article(element: ElementKind, ductility: Ductility) -> str:
    if element == "beam":
        return "C.21.3.4.2" if ductility == "DMO" else "C.21.5.3.2"
    if element == "column":
        return "C.21.4.4.3" if ductility == "DMO" else "C.21.6.4.3"
    return "C.21.9.4"
