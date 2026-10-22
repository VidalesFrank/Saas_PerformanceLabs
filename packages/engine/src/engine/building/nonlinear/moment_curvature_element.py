"""
Momento–curvatura analítico por elemento (Fase 3).

Integrador de fibras puro-Python para sección rectangular de concreto reforzado.
No requiere OpenSees — se puede correr en tests unitarios y en el posproceso
(Fase 6) sin instanciar un modelo global.

Modelo constitutivo:
    - Concreto confinado (core): Popovics 1973 / Mander et al. 1988.
    - Concreto no confinado (cover): mismo modelo con fcc=fc, εcc=0.002, εcu_u=0.005.
    - Acero: bilineal con endurecimiento post-fluencia b=0.015. Fractura en ε=εsu.
    - Tracción del concreto: despreciada (post-fisuración).

Barre curvatura φ desde 0 hasta la rotura, capturando:
    - M(φ) completa
    - My, φy             (idealización bilineal equal-energy)
    - Mu, φu             (último — min(εcu/c, εsu/(d-c)))
    - φ en umbrales:
        εc_cover = 0.004            → descascaramiento (DS2)
        εs       = 0.015            → fluencia significativa
        εc_core  = 0.75·εcu         → exposición de refuerzo (DS3)
        εs       = 0.6·εsu
        εc_core  = εcu              → último (DS4)

Convención de signos:
    - Compresión positiva (ambos concreto y acero).
    - Momento positivo: comprime arriba, tracciona abajo.

Unidades: MPa, mm, N·mm → se convierten a kN·m a la salida.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import Optional

from .element_data import ElementData


# ─────────────────────────────────────────────────────────────────────────────
# Constitutivos
# ─────────────────────────────────────────────────────────────────────────────
def mander_stress(eps: float, fcc: float, eps_cc: float, eps_cu: float,
                  Ec: float) -> float:
    """Modelo Popovics-Mander para concreto confinado.

        σ = fcc · x · r / (r − 1 + x^r)
        x = ε / εcc
        r = Ec / (Ec − Esec), Esec = fcc/εcc

    Despreciamos tracción (ε<0) → σ=0.
    Más allá de εcu → σ=0 (fractura).
    """
    if eps <= 0.0:
        return 0.0
    if eps > eps_cu:
        return 0.0
    x = eps / eps_cc
    Esec = fcc / eps_cc
    denom = Ec - Esec
    if denom <= 0:
        r = 2.0           # fallback de seguridad
    else:
        r = Ec / denom
    r = max(r, 1.01)      # evita división por cero
    try:
        return fcc * x * r / (r - 1.0 + x ** r)
    except (OverflowError, ValueError):
        return 0.0


def steel_stress(eps: float, fy: float, Es: float, eps_su: float,
                 b: float = 0.015) -> float:
    """Acero bilineal con endurecimiento cinemático.

    σ(ε) = Es·ε                            si |ε| ≤ εy
         = sign(ε)·[fy + b·Es·(|ε|−εy)]    si εy < |ε| ≤ εsu
         = 0                               si |ε| > εsu  (fractura)
    """
    eps_y = fy / Es
    sgn = 1.0 if eps >= 0 else -1.0
    a   = abs(eps)
    if a > eps_su:
        return 0.0
    if a <= eps_y:
        return Es * eps
    return sgn * (fy + b * Es * (a - eps_y))


# ─────────────────────────────────────────────────────────────────────────────
# Datos de la sección (deriva de ElementData + confinement del spec)
# ─────────────────────────────────────────────────────────────────────────────
@dataclass
class SectionFibers:
    """Discretización de fibras y propiedades constitutivas.

    Convención: y medido desde la fibra extrema en compresión (arriba), hacia
    abajo. Las fibras de acero están identificadas por su posición y_s_mm.
    """
    b_mm:        float
    h_mm:        float
    cover_mm:    float
    # Core (confinado)
    fcc_MPa:     float
    eps_cc:      float
    eps_cu:      float
    Ec_core:     float
    # Cover (no confinado)
    fc_MPa:      float
    eps_co:      float = 0.002
    eps_cu_u:    float = 0.005
    Ec_cover:    float = 24_000.0
    # Acero: lista de (y_mm, As_mm2)
    bars:        list[tuple[float, float]] = field(default_factory=list)
    fy_MPa:      float = 420.0
    Es_MPa:      float = 200_000.0
    eps_su:      float = 0.10
    # Discretización
    n_fibers_y:  int   = 40


def _concrete_stress_at(y: float, c: float, phi: float, sec: SectionFibers,
                        is_core: bool) -> float:
    """Esfuerzo del concreto a profundidad y para curvatura φ y eje neutro c."""
    eps = phi * (c - y)
    if is_core:
        return mander_stress(eps, sec.fcc_MPa, sec.eps_cc, sec.eps_cu, sec.Ec_core)
    return mander_stress(eps, sec.fc_MPa, sec.eps_co, sec.eps_cu_u, sec.Ec_cover)


def section_forces(c: float, phi: float, sec: SectionFibers) -> tuple[float, float, float, float, float]:
    """Suma fuerzas y momento sobre la sección para un (c, φ) dados.

    Returns:
        (N_total_N, M_total_Nmm, eps_cover_top, eps_core_top, eps_steel_tension_bot)

        eps_cover_top: fibra extrema del cover (y=0)
        eps_core_top:  fibra extrema del core (y=cover_mm)
        eps_steel_bot: barra inferior (más traccionada) — negativa si tracción
    """
    # Integración por rectángulos — fibras horizontales uniformes en altura.
    dy = sec.h_mm / sec.n_fibers_y
    N_c = 0.0
    M_c = 0.0
    y_centroid = sec.h_mm / 2.0

    # Core: entre cover y h-cover. Cover: entre 0 y cover + entre h-cover y h.
    for i in range(sec.n_fibers_y):
        y_mid = (i + 0.5) * dy
        is_core = (sec.cover_mm < y_mid < sec.h_mm - sec.cover_mm)
        sigma = _concrete_stress_at(y_mid, c, phi, sec, is_core)
        if is_core:
            width = sec.b_mm - 2 * sec.cover_mm
        else:
            width = sec.b_mm
        dA = width * dy
        F  = sigma * dA
        N_c += F
        M_c += F * (y_centroid - y_mid)   # momento (+) hacia abajo si compresión arriba

    # Acero
    N_s = 0.0
    M_s = 0.0
    for y_s, As in sec.bars:
        eps_s = phi * (c - y_s)
        sigma = steel_stress(eps_s, sec.fy_MPa, sec.Es_MPa, sec.eps_su)
        # Restar área de concreto desplazado (correcto para compresión; en
        # tracción el término ya es despreciable porque sigma_c=0).
        y_c = max(sec.cover_mm + 1.0, min(sec.h_mm - sec.cover_mm - 1.0, y_s))
        is_core = sec.cover_mm < y_c < sec.h_mm - sec.cover_mm
        sigma_c_at_bar = _concrete_stress_at(y_s, c, phi, sec, is_core)
        F = (sigma - sigma_c_at_bar) * As
        N_s += F
        M_s += F * (y_centroid - y_s)

    N_total = N_c + N_s
    M_total = M_c + M_s

    eps_cover_top = phi * c                                   # y=0
    eps_core_top  = phi * (c - sec.cover_mm)                  # y=cover_mm (core)
    eps_steel_bot = phi * (c - max(y for y, _ in sec.bars)) if sec.bars else 0.0

    return N_total, M_total, eps_cover_top, eps_core_top, eps_steel_bot


def _solve_neutral_axis(phi: float, N_target_N: float, sec: SectionFibers,
                        tol_N: float = 500.0, max_iter: int = 50) -> Optional[float]:
    """Bisección sobre c (prof. eje neutro) para equilibrar la fuerza axial.

    tol_N en N (default 500 N ≈ 0.5 kN). Devuelve None si no converge.
    """
    c_lo = 0.01 * sec.h_mm
    c_hi = 5.0  * sec.h_mm         # permite "falla por tracción" con c pequeño
    N_lo, *_ = section_forces(c_lo, phi, sec)
    N_hi, *_ = section_forces(c_hi, phi, sec)
    # f(c) = N(c) − N_target: crece con c (más compresión al crecer el bloque).
    f_lo = N_lo - N_target_N
    f_hi = N_hi - N_target_N
    if f_lo * f_hi > 0:
        # No cambia de signo — la sección no equilibra el axial a esta φ
        return None

    for _ in range(max_iter):
        c_mid = 0.5 * (c_lo + c_hi)
        N_mid, *_ = section_forces(c_mid, phi, sec)
        f_mid = N_mid - N_target_N
        if abs(f_mid) < tol_N:
            return c_mid
        if f_lo * f_mid < 0:
            c_hi, f_hi = c_mid, f_mid
        else:
            c_lo, f_lo = c_mid, f_mid
    return c_mid


# ─────────────────────────────────────────────────────────────────────────────
# Resultado del M-φ
# ─────────────────────────────────────────────────────────────────────────────
@dataclass
class MomentCurvatureResult:
    phi_rad_per_m:        list[float]
    M_kNm:                list[float]
    # Idealización bilineal
    phi_y_rad_per_m:      float
    M_y_kNm:              float
    # Pico de capacidad (Mu "físico" en bilineal)
    phi_peak_rad_per_m:   float
    M_peak_kNm:           float
    # Último — φ donde una fibra crítica alcanza su deformación última
    # (eps_core = eps_cu del core, o eps_s = -eps_su).
    phi_u_rad_per_m:      float
    M_u_kNm:              float
    # Curvaturas asociadas a umbrales de deformación
    phi_eps_c_004:        Optional[float] = None   # εc_cover = 0.004 → DS2
    phi_eps_s_015:        Optional[float] = None   # εs = 0.015
    phi_075_eps_cu:       Optional[float] = None   # 0.75·εcu (core) → DS3
    phi_06_eps_su:        Optional[float] = None   # 0.6·εsu
    phi_eps_cu:           Optional[float] = None   # εcu (core) → DS4 físico
    # Metadata
    N_kN:                 float = 0.0
    c_at_yield_mm:        float = 0.0
    c_at_ultimate_mm:     float = 0.0
    notes:                list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


# ─────────────────────────────────────────────────────────────────────────────
# Idealización bilineal
# ─────────────────────────────────────────────────────────────────────────────
def _bilinear_idealization(phis: list[float], Ms: list[float]) -> tuple[float, float, int]:
    """Idealización bilineal "equal energy" ASCE 41-17 §10.3.

    My = momento donde la rigidez secante bajo la curva real deja de ser lineal.
    Convención simple: 75% del Mmax; luego φy = M_y / K_sec_tangente.

    Devuelve (phi_y, M_y, index_de_phi_y_en_vector_phis).
    """
    if not phis or not Ms:
        return 0.0, 0.0, 0
    M_max = max(Ms)
    M_y_target = 0.75 * M_max
    # Primer índice donde M alcanza M_y_target
    idx_y = next((i for i, m in enumerate(Ms) if m >= M_y_target), len(Ms) - 1)
    phi_y_raw = phis[idx_y]
    M_y_raw   = Ms[idx_y]
    # Extrapolación: línea desde origen hasta (phi_y_raw, M_y_raw), extendida
    # a M_max — phi_y_eff = phi_y_raw * M_max / M_y_raw
    if M_y_raw <= 0:
        return phi_y_raw, M_y_raw, idx_y
    phi_y_eff = phi_y_raw * M_max / M_y_raw
    return phi_y_eff, M_max, idx_y


# ─────────────────────────────────────────────────────────────────────────────
# Punto de entrada
# ─────────────────────────────────────────────────────────────────────────────
def _build_section_fibers(el: ElementData, spec_confinement: dict | None = None) -> SectionFibers:
    """Construye SectionFibers a partir del ElementData y, opcionalmente, de
    los parámetros de Mander ya calculados en el spec (confinement.end).
    """
    fc = el.materials.fc_MPa
    Ec_core_default = 5000.0 * math.sqrt(max(fc, 1.0))   # MPa

    if spec_confinement:
        fcc_MPa = float(spec_confinement.get("fcc_MPa", fc * 1.3))
        eps_cc  = float(spec_confinement.get("eps_cc",  0.004))
        eps_cu  = float(spec_confinement.get("eps_cu",  0.015))
    else:
        # Mander simplificado — K≈1.3 default
        fcc_MPa = fc * 1.3
        eps_cc  = 0.002 * 2.0        # ε_co·(1 + 5·(K-1)) con K=1.3
        eps_cu  = 0.015              # aproximación con ρs=0.008

    # Posiciones de las barras longitudinales — simplificación:
    #   top    → y = cover + db/2
    #   bot    → y = h − cover − db/2
    #   caras  → distribuidas uniformemente entre top y bot
    long = el.longitudinal
    cover_mm = el.geometry.cover_m * 1000.0
    db       = long.db_mm
    h_mm     = el.geometry.h_m * 1000.0

    bars: list[tuple[float, float]] = []
    if long.groups:
        g = long.groups
        y_top = cover_mm + db / 2.0
        y_bot = h_mm - cover_mm - db / 2.0
        # Esquinas: 4 en las 4 esquinas (asumir 2 arriba, 2 abajo)
        A_corner = (g.get("corners") or {}).get("As_cm2", 0.0) * 100.0 / 4.0  # cm² → mm², /4 barras
        bars.append((y_top, A_corner))     # top-left (misma coord y que top-right en 2D)
        bars.append((y_top, A_corner))
        bars.append((y_bot, A_corner))
        bars.append((y_bot, A_corner))
        # Caras — top y bot con sus propias barras intermedias
        n_tf = int((g.get("top_face") or {}).get("n_bars", 0))
        for _ in range(n_tf):
            A = (g.get("top_face") or {}).get("As_cm2", 0.0) * 100.0 / max(n_tf, 1)
            bars.append((y_top, A))
        n_bf = int((g.get("bot_face") or {}).get("n_bars", 0))
        for _ in range(n_bf):
            A = (g.get("bot_face") or {}).get("As_cm2", 0.0) * 100.0 / max(n_bf, 1)
            bars.append((y_bot, A))
        # Caras laterales: distribuidas uniformemente entre y_top y y_bot
        for key in ("left_face", "right_face"):
            n_lr = int((g.get(key) or {}).get("n_bars", 0))
            if n_lr <= 0:
                continue
            A = (g.get(key) or {}).get("As_cm2", 0.0) * 100.0 / n_lr
            for i in range(n_lr):
                y = y_top + (y_bot - y_top) * (i + 1) / (n_lr + 1)
                bars.append((y, A))
    else:
        # Legacy: reparto perimetral. Asumir mitad arriba, mitad abajo.
        n = max(long.n_bars, 2)
        As_each = (long.As_cm2 * 100.0) / n   # cm² → mm²
        n_top = n // 2
        n_bot = n - n_top
        y_top = cover_mm + db / 2.0
        y_bot = h_mm - cover_mm - db / 2.0
        for _ in range(n_top):
            bars.append((y_top, As_each))
        for _ in range(n_bot):
            bars.append((y_bot, As_each))

    return SectionFibers(
        b_mm      = el.geometry.b_m * 1000.0,
        h_mm      = h_mm,
        cover_mm  = cover_mm,
        fcc_MPa   = fcc_MPa,
        eps_cc    = eps_cc,
        eps_cu    = eps_cu,
        Ec_core   = Ec_core_default,
        fc_MPa    = fc,
        Ec_cover  = Ec_core_default,       # mismo módulo elástico base
        bars      = bars,
        fy_MPa    = el.materials.fy_MPa,
        Es_MPa    = el.materials.Es_MPa,
        eps_su    = el.materials.eps_su,
    )


def compute_moment_curvature(
    el:                ElementData,
    spec_confinement:  dict | None = None,
    phi_max:           float = 0.5,              # rad/m, 500 µrad/mm
    n_steps:           int   = 150,
) -> MomentCurvatureResult:
    """Punto de entrada principal. Devuelve M-φ y curvaturas de umbral.

    Args:
        el:                ElementData — provee N_grav, geometría, refuerzo.
        spec_confinement:  dict de spec.confinement.end — si None, usa Mander simplificado.
        phi_max:           curvatura máxima a barrer (rad/m). 0.5 rad/m es un
                           límite generoso; se corta antes si la sección falla.
        n_steps:           pasos del barrido.

    Returns:
        MomentCurvatureResult con M-φ completa + curvaturas de umbral.
    """
    sec = _build_section_fibers(el, spec_confinement)
    N_target_kN = el.axial.N_grav_kN
    N_target_N  = N_target_kN * 1000.0

    phi_max_per_mm = phi_max / 1000.0           # rad/m → rad/mm
    dphi = phi_max_per_mm / n_steps

    phis_m: list[float] = []
    Ms_kNm: list[float] = []
    phi_eps_c_004  = None
    phi_eps_s_015  = None
    phi_075_eps_cu = None
    phi_06_eps_su  = None
    phi_eps_cu     = None
    phi_u_phys     = None    # φ al cual una fibra crítica falla físicamente
    M_u_phys       = None    # momento asociado a φ_u_phys

    c_last: Optional[float] = None
    notes: list[str] = []

    for i in range(1, n_steps + 1):
        phi = dphi * i
        c = _solve_neutral_axis(phi, N_target_N, sec)
        if c is None:
            notes.append(f"No convergió a φ={phi * 1000:.4f} rad/m")
            break
        c_last = c
        _, M_Nmm, eps_cover_top, eps_core_top, eps_steel_bot = section_forces(c, phi, sec)
        phi_m   = phi * 1000.0          # rad/mm → rad/m
        M_kNm_v = M_Nmm / 1e6
        phis_m.append(phi_m)
        Ms_kNm.append(M_kNm_v)

        # Captura de umbrales — primer cruce de cada deformación
        if phi_eps_c_004 is None and eps_cover_top >= 0.004:
            phi_eps_c_004 = phi_m
        if phi_eps_s_015 is None and eps_steel_bot <= -0.015:
            phi_eps_s_015 = phi_m
        # Comparar contra el CORE (y=cover_mm), no contra el cover (y=0)
        if phi_075_eps_cu is None and eps_core_top >= 0.75 * sec.eps_cu:
            phi_075_eps_cu = phi_m
        if phi_06_eps_su is None and eps_steel_bot <= -0.6 * sec.eps_su:
            phi_06_eps_su = phi_m
        # Falla física: core alcanza εcu o acero alcanza εsu (lo que ocurra primero)
        if phi_u_phys is None and (
            eps_core_top >= sec.eps_cu or eps_steel_bot <= -sec.eps_su
        ):
            phi_u_phys = phi_m
            M_u_phys   = M_kNm_v
            if phi_eps_cu is None and eps_core_top >= sec.eps_cu:
                phi_eps_cu = phi_m

        # Corte del barrido: 20% drop desde el pico (criterio ASCE 41)
        if Ms_kNm and len(Ms_kNm) > 5:
            M_max_so_far = max(Ms_kNm)
            if M_kNm_v < 0.8 * M_max_so_far and phi_u_phys is not None:
                break

    if not Ms_kNm:
        return MomentCurvatureResult(
            phi_rad_per_m=[], M_kNm=[],
            phi_y_rad_per_m=0.0, M_y_kNm=0.0,
            phi_peak_rad_per_m=0.0, M_peak_kNm=0.0,
            phi_u_rad_per_m=0.0, M_u_kNm=0.0,
            N_kN=N_target_kN, notes=notes + ["M-φ vacío — no convergió"],
        )

    phi_y, M_y, _ = _bilinear_idealization(phis_m, Ms_kNm)

    # Pico de capacidad
    idx_peak   = Ms_kNm.index(max(Ms_kNm))
    phi_peak   = phis_m[idx_peak]
    M_peak     = Ms_kNm[idx_peak]

    # Último (físico): si no hubo falla por fibra, usar el último punto del barrido
    if phi_u_phys is None:
        phi_u_phys = phis_m[-1]
        M_u_phys   = Ms_kNm[-1]
        notes.append("φu determinado por fin del barrido (sin falla de fibra)")

    return MomentCurvatureResult(
        phi_rad_per_m      = phis_m,
        M_kNm              = Ms_kNm,
        phi_y_rad_per_m    = phi_y,
        M_y_kNm            = M_y,
        phi_peak_rad_per_m = phi_peak,
        M_peak_kNm         = M_peak,
        phi_u_rad_per_m    = phi_u_phys,
        M_u_kNm            = M_u_phys,
        phi_eps_c_004      = phi_eps_c_004,
        phi_eps_s_015      = phi_eps_s_015,
        phi_075_eps_cu     = phi_075_eps_cu,
        phi_06_eps_su      = phi_06_eps_su,
        phi_eps_cu         = phi_eps_cu,
        N_kN               = N_target_kN,
        c_at_ultimate_mm   = c_last or 0.0,
        notes              = notes,
    )
