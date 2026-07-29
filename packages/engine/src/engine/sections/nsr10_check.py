"""Verificación NSR-10 Capítulo C — Secciones de concreto reforzado.

Cubre columnas, vigas y muros para categorías DMI, DMO y DES.
Retorna lista de NSR10Check ordenada por severidad.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Literal

from engine.sections.compiler import CompiledFiberSection


@dataclass
class NSR10Check:
    article: str                                          # ej. "C.10.9.1"
    description: str                                      # texto del criterio
    demand: float                                         # valor calculado
    limit: float                                          # límite NSR-10
    unit: str                                             # "%" | "mm" | "barras" | "—"
    status: Literal["ok", "fail", "warning", "info"]
    note: str = ""                                        # detalle adicional


# ── Checks comunes a todos los elementos ─────────────────────────────────────

def _cover_check(cover_mm: float, min_cover: float, article: str = "C.7.7.1") -> NSR10Check:
    return NSR10Check(
        article=article,
        description=f"Recubrimiento mínimo ≥ {min_cover:.0f} mm",
        demand=cover_mm,
        limit=min_cover,
        unit="mm",
        status="ok" if cover_mm >= min_cover else "fail",
    )


# ── COLUMNA ───────────────────────────────────────────────────────────────────

def _checks_columna(
    compiled: CompiledFiberSection,
    n_bars: int,
    cover_mm: float,
    ductility: str,
    shape_kind: str,
) -> list[NSR10Check]:
    results: list[NSR10Check] = []
    fy  = compiled.steel_params.fy   # MPa
    fpc = compiled.fpc_nominal        # MPa
    rho = compiled.steel_area / compiled.gross_area

    rho_min = 0.01
    # ρ_max según categoría NSR-10
    rho_max = 0.08 if ductility == "DMI" else 0.06

    results.append(NSR10Check(
        article="C.10.9.1",
        description="Cuantía mínima ρg ≥ 1.0%",
        demand=rho * 100,
        limit=rho_min * 100,
        unit="%",
        status="ok" if rho >= rho_min else "fail",
    ))
    results.append(NSR10Check(
        article="C.10.9.1" if ductility == "DMI" else ("C.21.3.5" if ductility == "DMO" else "C.21.6.3.1"),
        description=f"Cuantía máxima ρg ≤ {rho_max*100:.0f}%",
        demand=rho * 100,
        limit=rho_max * 100,
        unit="%",
        status="ok" if rho <= rho_max else "fail",
    ))

    # Número mínimo de barras
    min_bars = 6 if shape_kind == "circ" else 4
    bar_article = "C.10.9.3" if shape_kind == "circ" else "C.10.9.2"
    results.append(NSR10Check(
        article=bar_article,
        description=f"Mínimo {min_bars} barras longitudinales ({'circ.' if shape_kind == 'circ' else 'rect.'})",
        demand=float(n_bars),
        limit=float(min_bars),
        unit="barras",
        status="ok" if n_bars >= min_bars else "fail",
    ))

    # Recubrimiento — NSR-10 C.7.7.1 (exposición normal)
    results.append(_cover_check(cover_mm, 40.0))

    # Resistencia mínima del concreto por sismo
    if ductility in ("DMO", "DES"):
        fpc_min = 21.0  # MPa — NSR-10 C.21.1.4.3
        results.append(NSR10Check(
            article="C.21.1.4.3",
            description="f'c ≥ 21 MPa para elementos sísmicos",
            demand=fpc,
            limit=fpc_min,
            unit="MPa",
            status="ok" if fpc >= fpc_min else "fail",
        ))

    if ductility == "DES":
        results.append(NSR10Check(
            article="C.21.6.2.2",
            description="DES — Verificar columna fuerte / viga débil en pórtico",
            demand=0.0,
            limit=0.0,
            unit="—",
            status="info",
            note="Requiere análisis del pórtico completo. No verificable a nivel de sección aislada.",
        ))

    return results


# ── VIGA ──────────────────────────────────────────────────────────────────────

def _checks_viga(
    compiled: CompiledFiberSection,
    n_bars: int,
    cover_mm: float,
    ductility: str,
) -> list[NSR10Check]:
    results: list[NSR10Check] = []
    fy  = compiled.steel_params.fy
    fpc = compiled.fpc_nominal
    rho = compiled.steel_area / compiled.gross_area

    # Cuantía mínima — NSR-10 C.10.5.1
    rho_min = max(0.25 * math.sqrt(fpc) / fy, 1.4 / fy)
    results.append(NSR10Check(
        article="C.10.5.1",
        description="ρ ≥ max(0.25√f'c/fy, 1.4/fy)",
        demand=rho * 100,
        limit=rho_min * 100,
        unit="%",
        status="ok" if rho >= rho_min else "fail",
        note=f"Límite = max({0.25*math.sqrt(fpc)/fy*100:.3f}%, {1.4/fy*100:.3f}%)",
    ))

    # Mínimo de barras
    results.append(NSR10Check(
        article="C.10.5",
        description="Mínimo 2 barras longitudinales continuas",
        demand=float(n_bars),
        limit=2.0,
        unit="barras",
        status="ok" if n_bars >= 2 else "fail",
    ))

    # Recubrimiento
    results.append(_cover_check(cover_mm, 40.0))

    # Resistencia mínima concreto sismo
    if ductility in ("DMO", "DES"):
        fpc_min = 21.0
        results.append(NSR10Check(
            article="C.21.1.4.3",
            description="f'c ≥ 21 MPa para elementos sísmicos",
            demand=fpc,
            limit=fpc_min,
            unit="MPa",
            status="ok" if fpc >= fpc_min else "fail",
        ))

    if ductility in ("DMO", "DES"):
        rho_max = 0.025
        art = "C.21.5.2.1" if ductility == "DES" else "C.21.3.3"
        results.append(NSR10Check(
            article=art,
            description=f"{'DES' if ductility=='DES' else 'DMO'} — cuantía máxima ≤ 2.5%",
            demand=rho * 100,
            limit=rho_max * 100,
            unit="%",
            status="ok" if rho <= rho_max else "fail",
            note="ρ calculado como As_total/Ag (aproximación; idealmente usar As+/(b·d))",
        ))

    if ductility == "DES":
        results.append(NSR10Check(
            article="C.21.5.2.2",
            description="DES — ≥ 2 barras continuas en toda la longitud (arriba y abajo)",
            demand=float(n_bars),
            limit=2.0,
            unit="barras",
            status="warning" if n_bars < 4 else "ok",
            note="Verificar distribución top/bottom en el armado real.",
        ))
        results.append(NSR10Check(
            article="C.21.5.1.1",
            description="DES — viga debe clasificarse como elemento a flexión (Pu ≤ 0.1·Ag·f'c)",
            demand=0.0,
            limit=0.0,
            unit="—",
            status="info",
            note="Requiere la carga axial de diseño Pu. Verificar en combinación de cargas.",
        ))

    return results


# ── MURO ──────────────────────────────────────────────────────────────────────

def _checks_muro(
    compiled: CompiledFiberSection,
    n_bars: int,
    cover_mm: float,
    ductility: str,
) -> list[NSR10Check]:
    results: list[NSR10Check] = []
    fy  = compiled.steel_params.fy
    fpc = compiled.fpc_nominal
    rho = compiled.steel_area / compiled.gross_area

    # Cuantías mínimas C.14.3 (muros no sísmicos / DMI)
    rho_v_min = 0.0012 if fy >= 420 else 0.0015
    rho_h_min = 0.0020 if fy >= 420 else 0.0025

    results.append(NSR10Check(
        article="C.14.3.2",
        description=f"Refuerzo vertical mínimo ρv ≥ {rho_v_min*100:.2f}%",
        demand=rho * 100,
        limit=rho_v_min * 100,
        unit="%",
        status="ok" if rho >= rho_v_min else "fail",
        note="ρv calculado sobre sección transversal del muro.",
    ))
    results.append(NSR10Check(
        article="C.14.3.3",
        description=f"Refuerzo horizontal mínimo ρh ≥ {rho_h_min*100:.2f}%",
        demand=rho * 100,
        limit=rho_h_min * 100,
        unit="%",
        status="ok" if rho >= rho_h_min else "warning",
        note="ρh debe verificarse con el refuerzo horizontal de la sección longitudinal del muro.",
    ))

    # Recubrimiento para muros — C.7.7.1(c)
    results.append(_cover_check(cover_mm, 20.0, article="C.7.7.1(c)"))

    if ductility in ("DMO", "DES"):
        fpc_min = 21.0
        results.append(NSR10Check(
            article="C.21.1.4.3",
            description="f'c ≥ 21 MPa para elementos sísmicos",
            demand=fpc,
            limit=fpc_min,
            unit="MPa",
            status="ok" if fpc >= fpc_min else "fail",
        ))
        rho_min_seis = 0.0025
        results.append(NSR10Check(
            article="C.21.9.2.1",
            description=f"{'DES' if ductility=='DES' else 'DMO'} — muro estructural ρv ≥ 0.25% y ρh ≥ 0.25%",
            demand=rho * 100,
            limit=rho_min_seis * 100,
            unit="%",
            status="ok" if rho >= rho_min_seis else "fail",
        ))

    if ductility == "DES":
        results.append(NSR10Check(
            article="C.21.9.6",
            description="DES — verificar necesidad de elementos de borde (boundary elements)",
            demand=0.0,
            limit=0.0,
            unit="—",
            status="info",
            note="Requiere demanda de compresión y desplazamiento lateral para evaluar C.21.9.6.2 y C.21.9.6.3.",
        ))

    return results


# ── Función pública ───────────────────────────────────────────────────────────

def compute_nsr10_check(
    compiled: CompiledFiberSection,
    element_type: str,      # "columna" | "viga" | "muro"
    ductility: str,         # "DMI" | "DMO" | "DES"
    n_bars: int,
    cover_mm: float,
    shape_kind: str = "rect",
) -> list[NSR10Check]:
    """Verifica criterios NSR-10 según tipo de elemento y categoría de ductilidad."""
    et = element_type.lower()
    du = ductility.upper()
    if et == "columna":
        return _checks_columna(compiled, n_bars, cover_mm, du, shape_kind)
    elif et == "viga":
        return _checks_viga(compiled, n_bars, cover_mm, du)
    elif et == "muro":
        return _checks_muro(compiled, n_bars, cover_mm, du)
    raise ValueError(f"element_type desconocido: {element_type!r}")
