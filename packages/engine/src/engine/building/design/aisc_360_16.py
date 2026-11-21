"""Verificacion de miembros metalicos — AISC 360-16 (compatible NSR-10 F.2).

Implementa los capitulos:
    E — Compresion pura (pandeo por flexion)
    F — Flexion (incluye LTB)
    H — Combinada axial + flexion biaxial (ecuaciones H1-1a / H1-1b)

Unidades internas: N, mm, MPa (consistente con el resto del engine). Las
funciones de alto nivel retornan tambien kN, kN·m para reporte.

Convencion de ejes AISC: x = fuerte (profundidad d), y = debil (ancho bf).
En nuestras secciones: `shape.Ix` corresponde al eje fuerte; `shape.Iy` al debil.

Referencia: AISC 360-16 "Specification for Structural Steel Buildings".
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from engine.materials.structural_steel import StructuralSteelParams
from engine.sections.steel_section import SteelFrameSection
from engine.sections.steel_shapes import ShapeType


# ─────────────────────────────────────────────────────────────────────────────
# Factores de resistencia AISC LRFD (NSR-10 F.2 adopta los mismos)
# ─────────────────────────────────────────────────────────────────────────────

PHI_C = 0.90   # compresion (AISC E1)
PHI_B = 0.90   # flexion    (AISC F1)
PHI_T = 0.90   # tension fluencia (AISC D2)


# ─────────────────────────────────────────────────────────────────────────────
# Chapter E — Compresion por pandeo flexional (AISC E3)
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class CompressionResult:
    Pn_N:       float       # resistencia nominal en N
    Pn_kN:      float
    phi_Pn_kN:  float       # resistencia de diseño
    Fcr_MPa:    float       # tension critica
    Fe_MPa:     float       # tension de Euler
    lam:        float       # esbeltez KL/r efectiva
    lam_lim:    float       # 4.71 sqrt(E/Fy)
    mode:       str         # "inelastic" | "elastic"


def compression_strength(
    section: SteelFrameSection, K_times_L_mm: float, axis: str = "weak",
) -> CompressionResult:
    """Calcula Pn para compresion por pandeo flexional (AISC E3).

    Args:
        section:   SteelFrameSection (perfil + grado).
        K_times_L_mm: Longitud efectiva KL en mm (K · L, factor K ya aplicado).
        axis: "weak" (ry, pandeo sobre eje débil — comun) o "strong" (rx).

    Pn = Fcr · Ag  con:
        λ = KL/r
        Fe = π² E / λ²   (E3-4)
        Si λ ≤ 4.71 √(E/Fy):   Fcr = (0.658^(Fy/Fe)) · Fy   (E3-2, inelastico)
        Si λ > 4.71 √(E/Fy):   Fcr = 0.877 · Fe             (E3-3, elastico)
    """
    E  = section.material.E0
    Fy = section.material.fy
    Ag = section.shape.A
    rx = section.shape.rx
    ry = section.shape.ry

    r = ry if axis == "weak" else rx
    if r <= 0:
        raise ValueError(f"Radio de giro {axis} <= 0 para {section.shape.name}")

    lam = K_times_L_mm / r
    Fe  = math.pi ** 2 * E / (lam ** 2)
    lam_lim = 4.71 * math.sqrt(E / Fy)

    if lam <= lam_lim:
        Fcr = (0.658 ** (Fy / Fe)) * Fy
        mode = "inelastic"
    else:
        Fcr = 0.877 * Fe
        mode = "elastic"

    Pn = Fcr * Ag
    return CompressionResult(
        Pn_N=Pn, Pn_kN=Pn / 1000.0, phi_Pn_kN=PHI_C * Pn / 1000.0,
        Fcr_MPa=Fcr, Fe_MPa=Fe, lam=lam, lam_lim=lam_lim, mode=mode,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Chapter F — Flexion (AISC F2 para W-shapes compactos sobre eje fuerte)
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class FlexureResult:
    Mn_Nmm:    float      # resistencia nominal en N·mm
    Mn_kNm:    float
    phi_Mn_kNm: float
    region:    str        # "plastic" | "inelastic_LTB" | "elastic_LTB"
    Mp_kNm:    float
    Lp_mm:     float
    Lr_mm:     float
    Cb:        float


def flexural_strength_strong_axis(
    section: SteelFrameSection, Lb_mm: float, Cb: float = 1.0,
) -> FlexureResult:
    """Resistencia a flexion sobre eje fuerte (AISC F2 — W-shape compacto).

    Tres zonas según longitud no arriostrada Lb:
        Lb ≤ Lp:   Mn = Mp = Zx · fy       (plastico, no LTB)      F2-1
        Lp < Lb ≤ Lr:
            Mn = Cb · [Mp − (Mp − 0.7·fy·Sx) · (Lb − Lp)/(Lr − Lp)] ≤ Mp  F2-2 (LTB inelastico)
        Lb > Lr:
            Mn = Fcr · Sx ≤ Mp
            Fcr = (Cb·π²·E / (Lb/rts)²) · sqrt(1 + 0.078·(J·c/(Sx·ho))·(Lb/rts)²)   F2-3, F2-4 (LTB elastico)

    Simplificacion: rts y ho se aproximan desde d, bf, tf, tw. Adecuado para
    la mayoria de W-shapes (rts² ≈ sqrt(Iy · Cw) / Sx; c=1 para doubly symmetric).

    Args:
        section: SteelFrameSection (perfil + grado).
        Lb_mm:   Longitud no arriostrada lateralmente (mm).
        Cb:      Factor de modificación por diagrama de momentos (default 1.0 =
                 conservador uniforme). AISC F1-1: Cb = 12.5·Mmax / (2.5·Mmax +
                 3·MA + 4·MB + 3·MC). Usar 1.0 cuando no se conoce la
                 distribucion.
    """
    s = section.shape
    if s.type != ShapeType.W:
        raise NotImplementedError(
            "flexural_strength_strong_axis solo soporta W-shapes por ahora"
        )

    E  = section.material.E0
    Fy = section.material.fy

    Mp = s.Zx * Fy            # momento plastico N·mm
    Lp = 1.76 * s.ry * math.sqrt(E / Fy)   # F2-5

    # rts = sqrt(sqrt(Iy·Cw)/Sx). Cw ≈ Iy·ho²/4 para I doblemente simetrico.
    # ho = d - tf (distancia centroides de flanges).
    ho = s.d - s.tf
    Cw = s.Iy * ho ** 2 / 4.0       # F2-aproximacion I doubly symmetric
    rts = math.sqrt(math.sqrt(s.Iy * Cw) / s.Sx) if s.Sx > 0 else s.ry

    # Lr = 1.95 rts (E / 0.7fy) · sqrt((J·c/(Sx·ho)) + sqrt((J·c/(Sx·ho))² + 6.76·(0.7fy/E)²))   F2-6
    c = 1.0
    jsh = (s.J * c) / (s.Sx * ho) if s.Sx > 0 and ho > 0 else 0.0
    kterm = 0.7 * Fy / E
    try:
        Lr = (1.95 * rts * (E / (0.7 * Fy))
              * math.sqrt(jsh + math.sqrt(jsh ** 2 + 6.76 * kterm ** 2)))
    except (ValueError, ZeroDivisionError):
        Lr = 10 * Lp     # fallback conservador

    if Lb_mm <= Lp:
        Mn = Mp
        region = "plastic"
    elif Lb_mm <= Lr:
        Mn = Cb * (Mp - (Mp - 0.7 * Fy * s.Sx) * (Lb_mm - Lp) / (Lr - Lp))
        Mn = min(Mn, Mp)
        region = "inelastic_LTB"
    else:
        # F2-3, F2-4
        if rts > 0:
            Fcr = ((Cb * math.pi ** 2 * E) / ((Lb_mm / rts) ** 2)
                   * math.sqrt(1.0 + 0.078 * jsh * (Lb_mm / rts) ** 2))
        else:
            Fcr = 0.0
        Mn = min(Fcr * s.Sx, Mp)
        region = "elastic_LTB"

    return FlexureResult(
        Mn_Nmm=Mn, Mn_kNm=Mn / 1e6, phi_Mn_kNm=PHI_B * Mn / 1e6,
        region=region, Mp_kNm=Mp / 1e6,
        Lp_mm=Lp, Lr_mm=Lr, Cb=Cb,
    )


def flexural_strength_weak_axis(section: SteelFrameSection) -> FlexureResult:
    """Resistencia a flexion sobre eje debil (AISC F6 — W-shape).

    Para eje debil no hay LTB: Mn = Mp = Zy·fy ≤ 1.6·fy·Sy  (F6-1).
    """
    s = section.shape
    if s.type != ShapeType.W:
        raise NotImplementedError("solo W-shapes por ahora")
    Fy = section.material.fy
    Mp = s.Zy * Fy
    Mn = min(Mp, 1.6 * Fy * s.Sy)
    return FlexureResult(
        Mn_Nmm=Mn, Mn_kNm=Mn / 1e6, phi_Mn_kNm=PHI_B * Mn / 1e6,
        region="plastic", Mp_kNm=Mp / 1e6,
        Lp_mm=float("inf"), Lr_mm=float("inf"), Cb=1.0,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Chapter H — Interaccion axial + flexion biaxial (AISC H1)
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class CombinedResult:
    DC:        float          # D/C ratio (≤ 1.0 = OK)
    ok:        bool
    equation:  str            # "H1-1a" | "H1-1b"
    Pr_Pc:     float
    Mrx_Mcx:   float
    Mry_Mcy:   float


def combined_check(
    Pr_kN:   float,     # demanda axial requerida (kN, >0 compresion)
    Mrx_kNm: float,     # demanda flexion eje fuerte (kN·m)
    Mry_kNm: float,     # demanda flexion eje debil (kN·m)
    Pc_kN:   float,     # phi_Pn disponible
    Mcx_kNm: float,     # phi_Mnx disponible
    Mcy_kNm: float,     # phi_Mny disponible
) -> CombinedResult:
    """Verificacion combinada AISC 360-16 H1 — ecuaciones H1-1a / H1-1b.

    Si Pr/Pc ≥ 0.2:    DC = Pr/Pc + (8/9)·(Mrx/Mcx + Mry/Mcy)       (H1-1a)
    Si Pr/Pc <  0.2:   DC = Pr/(2·Pc) + (Mrx/Mcx + Mry/Mcy)         (H1-1b)
    """
    if Pc_kN <= 0:
        raise ValueError("Pc_kN debe ser > 0")

    Pr_Pc = abs(Pr_kN) / Pc_kN
    Mrx_Mcx = (abs(Mrx_kNm) / Mcx_kNm) if Mcx_kNm > 0 else 0.0
    Mry_Mcy = (abs(Mry_kNm) / Mcy_kNm) if Mcy_kNm > 0 else 0.0

    if Pr_Pc >= 0.2:
        DC = Pr_Pc + (8.0 / 9.0) * (Mrx_Mcx + Mry_Mcy)
        eq = "H1-1a"
    else:
        DC = 0.5 * Pr_Pc + (Mrx_Mcx + Mry_Mcy)
        eq = "H1-1b"

    return CombinedResult(
        DC=DC, ok=(DC <= 1.0), equation=eq,
        Pr_Pc=Pr_Pc, Mrx_Mcx=Mrx_Mcx, Mry_Mcy=Mry_Mcy,
    )


# ─────────────────────────────────────────────────────────────────────────────
# API de alto nivel: verificar un miembro completo
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class MemberCheck:
    """Resumen de verificacion de un miembro de acero bajo demanda P, Mx, My."""
    section_name:  str
    grade:         str
    compression:   CompressionResult
    flexure_x:     FlexureResult
    flexure_y:     FlexureResult
    combined:      CombinedResult


def check_steel_member(
    section:     SteelFrameSection,
    L_mm:        float,         # longitud del miembro
    K:           float = 1.0,   # factor de longitud efectiva (K·L)
    Lb_mm:      float | None = None,   # None → asume = L_mm (conservador)
    Cb:          float = 1.0,
    Pr_kN:       float = 0.0,
    Mrx_kNm:     float = 0.0,
    Mry_kNm:     float = 0.0,
    axis_compression: str = "weak",
) -> MemberCheck:
    """Verifica un miembro metalico bajo combinacion axial + flexion biaxial.

    Reune Chapters E, F y H en un solo resumen para reporte D/C.
    """
    if Lb_mm is None:
        Lb_mm = L_mm

    compression = compression_strength(section, K * L_mm, axis=axis_compression)
    flex_x = flexural_strength_strong_axis(section, Lb_mm, Cb=Cb)
    flex_y = flexural_strength_weak_axis(section)
    combined = combined_check(
        Pr_kN=Pr_kN, Mrx_kNm=Mrx_kNm, Mry_kNm=Mry_kNm,
        Pc_kN=compression.phi_Pn_kN,
        Mcx_kNm=flex_x.phi_Mn_kNm,
        Mcy_kNm=flex_y.phi_Mn_kNm,
    )
    return MemberCheck(
        section_name=section.shape.name,
        grade=section.material.grade,
        compression=compression,
        flexure_x=flex_x,
        flexure_y=flex_y,
        combined=combined,
    )
