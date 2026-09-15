"""Diseño paramétrico inverso de columnas RC.

Dado la geometría de la columna y una lista de demandas (Pu, Mux, Muy),
enumera candidatos de armado longitudinal y devuelve los que cumplen con
DCR ≤ 1.0 en todas las demandas, ordenados por menor cuantía (más eficientes).

Estrategia:
  1. Enumeración de configuraciones típicas por tipo de sección
     · Rectangular: barras perimetrales con n×n distribución
     · Circular:    n barras en anillo uniforme
  2. Combinar con tamaños de barra #5 a #11
  3. Filtrar por cuantía admisible NSR-10:
     · ρ_min = 0.01  (C.10.9.1)
     · ρ_max = 0.06  (DES/DMO) o 0.08 (DMI)
  4. Filtrar por número mínimo de barras:
     · Circular: 6 (C.10.9.3)
     · Rectangular: 4 (C.10.9.2)
  5. Para cada candidato válido:
     a. Construir SectionDocument temporal
     b. Compilar → superficie P-M al ángulo de la demanda dominante
     c. Interpolar capacidad al nivel P de cada demanda
     d. DCR = √(Mx²+My²) / M_cap ; si TODAS DCR ≤ 1 → candidato viable
  6. Devolver top-K ordenado por ρ ascendente (menor cuantía primero).

Optimización: para acelerar el barrido, se calcula P-M al ángulo específico
de la demanda (no toda la superficie), lo cual reduce el análisis a ~1 seg
por candidato (vs. 15+ seg de PMM completo).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Literal

import numpy as np

from engine.sections.document import (
    CircShape, ConcreteDef, ConcreteRegion, RectShape,
    ReinforcementBar, SectionDocument, SteelDef,
    RectConfinementDef, CircConfinementDef,
)
from engine.sections.compiler import compile as compile_doc
from engine.analysis.interaction import compute_interaction_diagram
from engine.sections.reinforcement import BAR_AREAS_MM2


ElementKind = Literal["column_rect", "column_circ"]
Ductility   = Literal["DMI", "DMO", "DES"]


# ─────────────────────────────────────────────────────────────────────────────
# Entrada / salida
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class DesignDemand:
    """Un punto de demanda: Pu, Mux, Muy en unidades de análisis (N, N·mm)."""
    Pu_N: float
    Mux_Nmm: float = 0.0
    Muy_Nmm: float = 0.0


@dataclass(frozen=True)
class ColumnGeometry:
    """Geometría de la columna a diseñar."""
    kind: ElementKind
    # Rectangular
    height_mm: float = 0.0
    width_mm:  float = 0.0
    # Circular
    diameter_mm: float = 0.0
    # Común
    cover_mm:  float = 40.0
    fpc_MPa:   float = 28.0
    fy_MPa:    float = 420.0


@dataclass
class DesignCandidate:
    """Un armado propuesto con su evaluación."""
    # Identificación
    n_bars:       int
    bar_size:     str
    layout:       str            # "perimeter_NxN" | "ring_N"
    n_bars_y:     int             # solo rectangular
    n_bars_z:     int
    # Propiedades derivadas
    As_mm2:       float
    rho_g:        float           # As / Ag
    # Verificación
    max_DCR:      float           # sobre TODAS las demandas
    worst_demand_idx: int
    demand_DCRs:  list[float]     # DCR para cada demanda de entrada
    all_pass:     bool
    p0_kN:        float
    # Meta
    notes:        list[str] = field(default_factory=list)


@dataclass
class DesignResult:
    n_candidates_evaluated: int
    n_valid:                int
    top_candidates:         list[DesignCandidate]   # ordenado por ρ ascendente (más eficientes primero)
    all_infeasible:         bool                     # True si ninguno cumple
    notes:                  list[str] = field(default_factory=list)


# ─────────────────────────────────────────────────────────────────────────────
# Enumeración de candidatos
# ─────────────────────────────────────────────────────────────────────────────

_STANDARD_BAR_SIZES: list[str] = ["#5", "#6", "#7", "#8", "#9", "#10", "#11"]

# Configuraciones rectangulares típicas (n_bars_y × n_bars_z)
# Total = 2·n_y + 2·(n_z − 2) = 2·n_y + 2·n_z − 4
_RECT_LAYOUTS: list[tuple[int, int]] = [
    (2, 2),   # 4 esquinas
    (3, 2),   # 6 barras
    (2, 3),   # 6 barras (rotada)
    (3, 3),   # 8 barras (perímetro)
    (4, 3),   # 10 barras
    (3, 4),   # 10 barras
    (4, 4),   # 12 barras
    (5, 4),   # 14 barras
    (4, 5),   # 14 barras
    (5, 5),   # 16 barras
]

# Configuraciones circulares — número de barras en anillo
_CIRC_LAYOUTS: list[int] = [6, 8, 10, 12, 14, 16, 20, 24]


def _rect_bars_count(n_y: int, n_z: int) -> int:
    return 2 * n_y + 2 * n_z - 4


def _bars_for_rect(n_y: int, n_z: int, h: float, w: float, cover: float,
                   size: str, steel_id: str) -> list[ReinforcementBar]:
    """Genera las coordenadas de barras perimetrales para columna rectangular."""
    y_out = h / 2 - cover
    z_out = w / 2 - cover
    bars: list[ReinforcementBar] = []
    # Cara superior (y = +y_out)
    for i in range(n_y):
        z = -z_out + i * (2 * z_out) / (n_y - 1) if n_y > 1 else 0.0
        bars.append(ReinforcementBar(y=y_out, z=z, bar_size=size, steel_id=steel_id))
    # Cara inferior (y = -y_out)
    for i in range(n_y):
        z = -z_out + i * (2 * z_out) / (n_y - 1) if n_y > 1 else 0.0
        bars.append(ReinforcementBar(y=-y_out, z=z, bar_size=size, steel_id=steel_id))
    # Cara derecha (z = +z_out), sin esquinas
    for i in range(1, n_z - 1):
        y = -y_out + i * (2 * y_out) / (n_z - 1)
        bars.append(ReinforcementBar(y=y, z=z_out, bar_size=size, steel_id=steel_id))
    # Cara izquierda (z = -z_out), sin esquinas
    for i in range(1, n_z - 1):
        y = -y_out + i * (2 * y_out) / (n_z - 1)
        bars.append(ReinforcementBar(y=y, z=-z_out, bar_size=size, steel_id=steel_id))
    return bars


def _bars_for_circ(n_bars: int, D: float, cover: float,
                   size: str, steel_id: str) -> list[ReinforcementBar]:
    """Barras en anillo uniforme para columna circular."""
    R = D / 2 - cover
    bars: list[ReinforcementBar] = []
    for i in range(n_bars):
        theta = 2 * math.pi * i / n_bars
        bars.append(ReinforcementBar(
            y=R * math.cos(theta), z=R * math.sin(theta),
            bar_size=size, steel_id=steel_id,
        ))
    return bars


# ─────────────────────────────────────────────────────────────────────────────
# Evaluación de un candidato
# ─────────────────────────────────────────────────────────────────────────────

def _build_doc(geom: ColumnGeometry, bars: list[ReinforcementBar]) -> SectionDocument:
    c = ConcreteDef(fpc=geom.fpc_MPa)
    s = SteelDef(fy=geom.fy_MPa)
    # Asignar los IDs correctos
    for b in bars:
        object.__setattr__(b, "steel_id", s.id) if False else None
    bars_final = [
        ReinforcementBar(y=b.y, z=b.z, bar_size=b.bar_size, steel_id=s.id)
        for b in bars
    ]

    if geom.kind == "column_rect":
        conf = RectConfinementDef()
        region = ConcreteRegion(
            shape=RectShape(height=geom.height_mm, width=geom.width_mm),
            concrete_id=c.id, confinement=conf, cover_to_bar=geom.cover_mm,
        )
    else:
        conf = CircConfinementDef()
        region = ConcreteRegion(
            shape=CircShape(radius=geom.diameter_mm / 2),
            concrete_id=c.id, confinement=conf, cover_to_bar=geom.cover_mm,
        )
    return SectionDocument(concrete_defs=[c], steel_defs=[s],
                            regions=[region], bars=bars_final)


def _demand_angle_deg(demand: DesignDemand) -> float:
    """Ángulo del vector demanda (Mx, My) en grados. 0° = eje fuerte pura."""
    if abs(demand.Muy_Nmm) < 1e-9 and abs(demand.Mux_Nmm) < 1e-9:
        return 0.0
    return math.degrees(math.atan2(demand.Muy_Nmm, demand.Mux_Nmm))


def _interp_pm_capacity(diagram: list, P_target: float) -> float:
    """Interpola M capacidad al P_target en el diagrama P-M ordenado."""
    if not diagram:
        return 0.0
    # Diagrama viene ordenado por P descendente (max compresión → tracción pura)
    # o mezclado — ordenar por P
    pts = sorted(diagram, key=lambda p: p.P, reverse=True)
    for i in range(len(pts) - 1):
        p_hi, p_lo = pts[i].P, pts[i + 1].P
        if p_lo <= P_target <= p_hi:
            t = (P_target - p_lo) / (p_hi - p_lo) if abs(p_hi - p_lo) > 1e-9 else 0.0
            return pts[i + 1].M + t * (pts[i].M - pts[i + 1].M)
    # Fuera de rango
    return 0.0


def _evaluate_candidate(
    geom:      ColumnGeometry,
    bars:      list[ReinforcementBar],
    demands:   list[DesignDemand],
    n_y:       int, n_z: int, size: str, layout: str,
) -> DesignCandidate:
    """Evalúa un candidato: construye, compila, corre P-M al ángulo dominante,
    interpola capacidad al P de cada demanda y computa DCR.

    Optimización: si todas las demandas tienen el mismo ángulo (o ~similar),
    corre un solo P-M. Si hay diversidad, corre P-M para cada ángulo único.
    """
    # As y ρ
    As = sum(BAR_AREAS_MM2.get(b.bar_size, 0.0) for b in bars)
    Ag = (geom.height_mm * geom.width_mm) if geom.kind == "column_rect" else \
         (math.pi * (geom.diameter_mm / 2) ** 2)
    rho = As / Ag if Ag > 0 else 0.0

    doc = _build_doc(geom, bars)
    try:
        compiled = compile_doc(doc)
    except Exception:
        return DesignCandidate(
            n_bars=len(bars), bar_size=size, layout=layout, n_bars_y=n_y, n_bars_z=n_z,
            As_mm2=As, rho_g=rho,
            max_DCR=float("inf"), worst_demand_idx=-1, demand_DCRs=[],
            all_pass=False, p0_kN=0.0,
            notes=["Error al compilar"],
        )

    # P0 (compresión pura) — filtrado rápido
    P0 = 0.85 * geom.fpc_MPa * (Ag - As) + geom.fy_MPa * As

    # Verificar demandas — agrupar por ángulo único
    unique_angles: dict[float, list[int]] = {}
    for i, d in enumerate(demands):
        ang = _demand_angle_deg(d)
        # Redondear a 5° para agrupar demandas cercanas
        key = round(ang / 5.0) * 5.0
        unique_angles.setdefault(key, []).append(i)

    dcrs = [float("nan")] * len(demands)
    for angle_deg, idxs in unique_angles.items():
        try:
            diagram = compute_interaction_diagram(compiled, num_points=12, theta_deg=angle_deg)
        except Exception:
            for i in idxs:
                dcrs[i] = float("inf")
            continue
        for i in idxs:
            d = demands[i]
            M_dem = math.sqrt(d.Mux_Nmm ** 2 + d.Muy_Nmm ** 2)
            # Verificar que P esté en rango
            p_max_diag = max(p.P for p in diagram)
            p_min_diag = min(p.P for p in diagram)
            if d.Pu_N > p_max_diag or d.Pu_N < p_min_diag:
                dcrs[i] = float("inf")
                continue
            M_cap = _interp_pm_capacity(diagram, d.Pu_N)
            dcrs[i] = M_dem / M_cap if M_cap > 1e-9 else float("inf")

    finite = [d for d in dcrs if math.isfinite(d)]
    max_dcr = max(dcrs) if dcrs else float("inf")
    idx_worst = dcrs.index(max_dcr) if finite else -1
    all_pass = all(math.isfinite(d) and d <= 1.0 for d in dcrs) if dcrs else False

    return DesignCandidate(
        n_bars=len(bars), bar_size=size, layout=layout,
        n_bars_y=n_y, n_bars_z=n_z,
        As_mm2=As, rho_g=rho,
        max_DCR=max_dcr, worst_demand_idx=idx_worst,
        demand_DCRs=dcrs, all_pass=all_pass,
        p0_kN=P0 / 1000.0,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Función pública
# ─────────────────────────────────────────────────────────────────────────────

def design_column(
    geom:      ColumnGeometry,
    demands:   list[DesignDemand],
    ductility: Ductility = "DMO",
    top_k:     int = 5,
    rho_min:   float = 0.01,
    rho_max:   float | None = None,
) -> DesignResult:
    """Diseña una columna RC buscando el armado más eficiente que cumple demandas.

    Args:
        geom:      geometría (rect o circ) + materiales.
        demands:   lista de puntos (Pu, Mux, Muy) que deben cumplir DCR ≤ 1.
        ductility: "DMI" | "DMO" | "DES" (afecta ρ_max NSR-10).
        top_k:     número máximo de candidatos válidos a retornar.
        rho_min:   cuantía mínima NSR-10 C.10.9.1 (default 0.01).
        rho_max:   cuantía máxima; None = 0.08 (DMI) o 0.06 (DMO/DES).
    """
    if not demands:
        return DesignResult(0, 0, [], True, notes=["Sin demandas de entrada."])

    if rho_max is None:
        rho_max = 0.08 if ductility == "DMI" else 0.06

    Ag = (geom.height_mm * geom.width_mm) if geom.kind == "column_rect" else \
         (math.pi * (geom.diameter_mm / 2) ** 2)

    # Enumeración de candidatos
    candidates: list[DesignCandidate] = []
    n_eval = 0

    if geom.kind == "column_rect":
        for n_y, n_z in _RECT_LAYOUTS:
            n_bars = _rect_bars_count(n_y, n_z)
            if n_bars < 4:   # C.10.9.2
                continue
            for size in _STANDARD_BAR_SIZES:
                area = BAR_AREAS_MM2[size]
                As = n_bars * area
                rho = As / Ag
                if rho < rho_min or rho > rho_max:
                    continue
                n_eval += 1
                bars = _bars_for_rect(n_y, n_z, geom.height_mm, geom.width_mm,
                                       geom.cover_mm, size, "steel")
                cand = _evaluate_candidate(geom, bars, demands, n_y, n_z, size,
                                            f"perimeter_{n_y}x{n_z}")
                candidates.append(cand)

    elif geom.kind == "column_circ":
        for n_bars in _CIRC_LAYOUTS:
            if n_bars < 6:   # C.10.9.3
                continue
            for size in _STANDARD_BAR_SIZES:
                area = BAR_AREAS_MM2[size]
                As = n_bars * area
                rho = As / Ag
                if rho < rho_min or rho > rho_max:
                    continue
                n_eval += 1
                bars = _bars_for_circ(n_bars, geom.diameter_mm, geom.cover_mm, size, "steel")
                cand = _evaluate_candidate(geom, bars, demands, 0, 0, size,
                                            f"ring_{n_bars}")
                candidates.append(cand)
    else:
        return DesignResult(0, 0, [], True, notes=[f"Tipo de geometría no soportado: {geom.kind!r}"])

    # Filtrar válidos y ordenar por ρ ascendente
    valid = [c for c in candidates if c.all_pass]
    valid.sort(key=lambda c: c.rho_g)
    top = valid[:top_k]

    all_infeasible = len(valid) == 0
    notes: list[str] = []
    if all_infeasible:
        # Encontrar el "menos malo" para dar información
        candidates_sorted = sorted(candidates, key=lambda c: c.max_DCR)
        if candidates_sorted:
            best_dcr = candidates_sorted[0].max_DCR
            if math.isfinite(best_dcr):
                notes.append(f"Ningún candidato cumple. El menos crítico tiene DCR = {best_dcr:.2f}. "
                             "Considera aumentar la sección o reducir demandas.")
            else:
                notes.append("Ningún candidato cumple: las demandas exceden capacidad para todo armado "
                             "dentro del rango ρ ∈ [0.01, 0.06]. Aumentar sección.")

    return DesignResult(
        n_candidates_evaluated=n_eval,
        n_valid=len(valid),
        top_candidates=top,
        all_infeasible=all_infeasible,
        notes=notes,
    )
