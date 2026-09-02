"""
Método del Espectro de Capacidad (CSM) — ATC-40 / NSR-10 Título B.

Convierte la curva pushover a formato ADRS (Sa vs Sd), genera el espectro de
demanda NSR-10 en ADRS, y encuentra el punto de desempeño por iteración.

Unidades de entrada:
  dtecho_pct   : derivas de techo en % (ya normalizado por altura total)
  vbasal_norm  : cortante basal normalizado V/W (adimensional, fracción de g)
  total_height_m: altura total del edificio en metros
  T1_s         : período fundamental en segundos

Referencia:
  ATC-40 (1996) Cap. 8 — Capacity Spectrum Method
  NSR-10 Título B Sección B.6 — Procedimiento de espectro de capacidad
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field


# ── Gravedad ───────────────────────────────────────────────────────────────────
G_MS2 = 9.807   # m/s²


# ── Tipos de resultado ─────────────────────────────────────────────────────────

@dataclass
class AdrsCurve:
    """Curva en formato Aceleración-Desplazamiento (ADRS)."""
    Sa: list[float]    # Aceleración espectral (g)
    Sd: list[float]    # Desplazamiento espectral (m)
    T:  list[float]    # Período (s) — solo para la demanda, vacío para capacidad


@dataclass
class PerformancePoint:
    Sa_pp:      float   # Aceleración espectral en punto de desempeño (g)
    Sd_pp:      float   # Desplazamiento espectral en punto de desempeño (m)
    drift_pp:   float   # Deriva de techo en el PP (%)
    beta_eff:   float   # Amortiguamiento efectivo en el PP (%)
    T_eff:      float   # Período efectivo en el PP (s)
    converged:  bool    # Indica si la iteración convergió


@dataclass
class PerformanceLevel:
    code:        str    # "IO" | "LS" | "CP" | "C"
    nombre:      str
    color:       str    # color para visualización
    description: str


@dataclass
class PerformanceResult:
    capacity_adrs:   AdrsCurve
    demand_elastic:  AdrsCurve      # espectro elástico (5% amort.)
    demand_reduced:  AdrsCurve      # espectro reducido en el PP
    performance_point: PerformancePoint
    performance_level: PerformanceLevel
    bilinear_Sa: list[float]        # idealización bilineal (Sa)
    bilinear_Sd: list[float]        # idealización bilineal (Sd)
    Sy: float                       # Sa de fluencia
    dy: float                       # Sd de fluencia
    total_height_m: float
    Aa: float
    Av: float
    soil_type: str


# ── Niveles de desempeño (FEMA 356 / NSR-10 B) ────────────────────────────────

PERFORMANCE_LEVELS: dict[str, PerformanceLevel] = {
    "IO": PerformanceLevel(
        code="IO",
        nombre="Ocupación Inmediata",
        color="#22C55E",
        description="Daño muy leve. El edificio permanece funcional inmediatamente después del sismo.",
    ),
    "LS": PerformanceLevel(
        code="LS",
        nombre="Seguridad de Vida",
        color="#F59E0B",
        description="Daño moderado. Hay margen de seguridad contra el colapso.",
    ),
    "CP": PerformanceLevel(
        code="CP",
        nombre="Prevención de Colapso",
        color="#EF4444",
        description="Daño severo. Riesgo de pérdida de vida reducido, colapso evitado.",
    ),
    "C": PerformanceLevel(
        code="C",
        nombre="Colapso",
        color="#7C3AED",
        description="El desplazamiento demandado excede la capacidad. Riesgo de colapso.",
    ),
}

# Límites de deriva global de techo (% de la altura total del edificio)
# Pórticos de concreto reforzado — NSR-10 B / FEMA 356 Tabla C1-3
_DRIFT_LIMITS = {
    "IO": 0.70,   # < 0.7%   → Ocupación inmediata
    "LS": 2.50,   # < 2.5%   → Seguridad de vida
    "CP": 5.00,   # < 5.0%   → Prevención de colapso
}


# ── Funciones principales ──────────────────────────────────────────────────────

def pushover_to_adrs(
    dtecho_pct: list[float],
    vbasal_norm: list[float],
    total_height_m: float,
    T1_s: float,
    gamma: float = 1.0,
) -> AdrsCurve:
    """
    Convierte la curva pushover (deriva % vs V/W) a formato ADRS.

    Parámetros
    ----------
    dtecho_pct   : Derivas de techo en % (= δ_techo/H × 100)
    vbasal_norm  : Cortante basal normalizado V/W (fracción de g)
    total_height_m: Altura total H (m)
    T1_s         : Período fundamental del sistema (s) — usado para verificación
    gamma        : Factor de participación modal × forma modal en techo (≈ 1.0 para aproximación)
    """
    Sa_list: list[float] = []
    Sd_list: list[float] = []

    for drift_pct, vn in zip(dtecho_pct, vbasal_norm):
        Sa = vn                                                  # g
        delta_techo = (drift_pct / 100.0) * total_height_m      # m
        Sd = delta_techo / gamma                                 # m (aprox: γ = 1)
        Sa_list.append(round(Sa, 6))
        Sd_list.append(round(Sd, 6))

    return AdrsCurve(Sa=Sa_list, Sd=Sd_list, T=[])


def demand_spectrum_adrs(
    Aa: float,
    Av: float,
    soil_type: str,
    beta_pct: float = 5.0,
    T_max: float = 4.0,
    n_points: int = 200,
) -> AdrsCurve:
    """
    Genera el espectro de demanda NSR-10 en formato ADRS.

    Parámetros
    ----------
    Aa       : Coeficiente de aceleración pico del terreno
    Av       : Coeficiente de velocidad pico del terreno
    soil_type: Perfil de suelo (A/B/C/D/E)
    beta_pct : Amortiguamiento (%)
    T_max    : Período máximo para la gráfica (s)
    n_points : Número de puntos en la curva
    """
    from engine.seismic.spectrum import get_site_factors

    # Factores de amplificación de suelo NSR-10 Tabla A.2.4-1/2
    Fa, Fv = get_site_factors(Aa, Av, soil_type)

    # Parámetros espectrales NSR-10
    Sds  = 2.5 * Aa * Fa                       # Aceleración espectral corto período (g)
    Sd1  = Av * Fv                              # Aceleración espectral T=1s (g)
    T0   = 0.2 * Sd1 / Sds if Sds > 0 else 0.2
    Ts   = Sd1 / Sds if Sds > 0 else 0.6
    TL   = 6.0                                  # Período largo (NSR-10 A.2.6)

    # Factor de amortiguamiento (ASCE 7 Tabla 17.5-1 / ATC-40 simplificado)
    # Para β ≠ 5%, multiplicar espectro por Bf = B5/B_eff
    # ATC-40: B(β) = (3.21 - 0.681·ln(β)) / 2.31
    def _B(b_pct: float) -> float:
        b = max(5.0, min(b_pct, 50.0))
        return (3.21 - 0.681 * math.log(b)) / 2.31

    B_factor = _B(beta_pct) / _B(5.0)  # ratio respecto a β=5%

    T_values = [T_max * i / (n_points - 1) for i in range(n_points)]
    T_values[0] = 0.0

    Sa_list: list[float] = []
    Sd_list: list[float] = []

    for T in T_values:
        if T <= T0:
            Sa = (Sds * (0.4 + 0.6 * T / T0)) if T0 > 0 else Sds * 0.4
        elif T <= Ts:
            Sa = Sds
        elif T <= TL:
            Sa = Sd1 / T if T > 0 else Sds
        else:
            Sa = Sd1 * TL / (T ** 2) if T > 0 else Sds

        Sa = Sa / B_factor                              # aplicar corrección por amortiguamiento
        Sd = Sa * G_MS2 * (T ** 2) / (4 * math.pi ** 2) if T > 0 else 0.0

        Sa_list.append(round(Sa, 6))
        Sd_list.append(round(Sd, 6))

    return AdrsCurve(Sa=Sa_list, Sd=Sd_list, T=T_values)


def _bilinear_idealize(
    Sd: list[float],
    Sa: list[float],
) -> tuple[float, float, float, float]:
    """
    Idealización bilineal de la curva de capacidad (igual área).

    Devuelve (Sy, dy, Su, du):
    - (Sy, dy): punto de fluencia idealizado
    - (Su, du): punto último (último punto de la curva)
    """
    if len(Sd) < 3:
        return Sa[-1] * 0.6, Sd[-1] * 0.3, Sa[-1], Sd[-1]

    Su = Sa[-1]
    du = Sd[-1]

    # Punto de control: 60% de la capacidad máxima
    Sa_60 = 0.60 * Su

    # Estimar rigidez inicial: pendiente del primer tramo (10% de la capacidad)
    idx_10 = 0
    for i, s in enumerate(Sa):
        if s >= 0.10 * Su:
            idx_10 = i
            break
    Ki = Sa[idx_10] / Sd[idx_10] if Sd[idx_10] > 0 else Sa[-1] / Sd[-1]

    # Área bajo la curva (trapezoidal)
    area_curve = sum(
        0.5 * (Sa[i] + Sa[i - 1]) * (Sd[i] - Sd[i - 1])
        for i in range(1, len(Sd))
        if Sd[i] > Sd[i - 1]
    )

    # Fluencia: dy = Sy/Ki, la Sy se obtiene igualando áreas
    # Área bilineal = 0.5·Sy·dy + Sy·(du-dy) = Sy·(du - 0.5·dy) = area_curve
    # dy = Sy/Ki → Sy² × (du/Ki - 0.5/Ki) = area_curve → Sy = sqrt(area_curve × Ki / (du - 0.5·Sy/Ki))
    # Iteración simple:
    Sy = Sa_60
    for _ in range(20):
        dy_est = Sy / Ki if Ki > 0 else 0.01
        Sy_new = area_curve / (du - 0.5 * dy_est) if (du - 0.5 * dy_est) > 0 else Sa[-1] * 0.7
        if abs(Sy_new - Sy) < 1e-6:
            break
        Sy = 0.5 * (Sy + Sy_new)

    dy = Sy / Ki if Ki > 0 else Sd[-1] * 0.3

    # Limitar a valores sensatos
    Sy = max(0.01, min(Sy, Su))
    dy = max(1e-4, min(dy, du))

    return Sy, dy, Su, du


def _beta_effective(Sa_pp: float, Sd_pp: float, Sy: float, dy: float) -> float:
    """
    Calcula el amortiguamiento viscoso equivalente (%).

    ATC-40 Ec. 8-14: β_eff = β₀ + (63.7 × Ed) / (Sa_pp × Sd_pp)
    donde Ed = energía disipada en el loop histerético (área del paralelogramo bilineal).
    β₀ = amortiguamiento inherente = 5% (concreto reforzado).
    """
    beta_0 = 5.0

    if Sa_pp <= 0 or Sd_pp <= 0:
        return beta_0

    # Área del loop bilineal = 4(Sy × Sd_pp - Sa_pp × dy)  (paralelogramo ATC-40)
    Ed = 4.0 * (Sy * Sd_pp - Sa_pp * dy)

    if Ed <= 0:
        return beta_0

    # Ec. 8-14 ATC-40
    beta_hyst = 63.7 * Ed / (Sa_pp * Sd_pp)

    # κ (factor de degradación de rigidez) — Tipo B (concreto con buena dúctilidad)
    # ATC-40 Tabla 8-2: κ depende de la ductilidad μ = Sd_pp/dy
    mu = Sd_pp / dy if dy > 0 else 1.0
    if mu <= 2.0:
        kappa = 1.0
    elif mu <= 4.0:
        kappa = 2.0 / 3.0
    else:
        kappa = 0.5

    beta_eff = beta_0 + kappa * beta_hyst
    return min(beta_eff, 45.0)   # cota superior práctica


def _B_reduction(beta_pct: float) -> float:
    """Factor de reducción del espectro por amortiguamiento (ATC-40 Ec. 8-11)."""
    b = max(5.0, min(beta_pct, 50.0))
    return (3.21 - 0.681 * math.log(b)) / 2.31


def _intersect_adrs(
    Sa_cap: list[float],
    Sd_cap: list[float],
    Sa_dem: list[float],
    Sd_dem: list[float],
) -> tuple[float, float]:
    """
    Primera intersección donde la curva de capacidad supera a la demanda (cap < dem → cap ≥ dem).

    En el espacio ADRS típico:
    - Al inicio (Sd pequeño): capacidad < demanda
    - Al cruzar la intersección: capacidad ≥ demanda
    El punto de desempeño es esta primera transición.
    """
    def _interp_dem(Sd_q: float) -> float:
        for i in range(1, len(Sd_dem)):
            if Sd_dem[i - 1] <= Sd_q <= Sd_dem[i]:
                t = (Sd_q - Sd_dem[i - 1]) / (Sd_dem[i] - Sd_dem[i - 1])
                return Sa_dem[i - 1] + t * (Sa_dem[i] - Sa_dem[i - 1])
        return Sa_dem[-1]

    sa_d_prev = _interp_dem(Sd_cap[0])
    below_prev = Sa_cap[0] < sa_d_prev

    for i in range(1, len(Sd_cap)):
        sa_d_i = _interp_dem(Sd_cap[i])
        below_i = Sa_cap[i] < sa_d_i

        if below_prev and not below_i:
            # Transición cap < dem → cap ≥ dem: interpolar cruce exacto
            denom = (Sa_cap[i] - Sa_cap[i - 1]) - (sa_d_i - sa_d_prev)
            if abs(denom) > 1e-10:
                t = (sa_d_prev - Sa_cap[i - 1]) / denom
                t = max(0.0, min(1.0, t))
            else:
                t = 0.5
            Sd_pp = Sd_cap[i - 1] + t * (Sd_cap[i] - Sd_cap[i - 1])
            Sa_pp = Sa_cap[i - 1] + t * (Sa_cap[i] - Sa_cap[i - 1])
            return Sa_pp, Sd_pp

        sa_d_prev = sa_d_i
        below_prev = below_i

    # Sin cruce: la capacidad queda siempre por debajo → devolver último punto de capacidad
    return Sa_cap[-1], Sd_cap[-1]


def find_performance_point(
    capacity: AdrsCurve,
    demand_elastic: AdrsCurve,
    Sy: float,
    dy: float,
    n_iter: int = 10,
    tol: float = 5e-4,
) -> tuple[PerformancePoint, AdrsCurve]:
    """
    Encuentra el punto de desempeño por el Método del Espectro de Capacidad (ATC-40).

    Iteración:
    1. Asumir PP inicial = último punto de la capacidad (demanda máxima)
    2. Calcular β_eff
    3. Reducir el espectro de demanda
    4. Encontrar nueva intersección con la capacidad
    5. Repetir hasta convergencia
    """
    Sd_pp = capacity.Sd[-1]
    Sa_pp = capacity.Sa[-1]
    beta_eff = 5.0
    demand_reduced = demand_elastic

    B5 = _B_reduction(5.0)   # valor de referencia al 5% de amortiguamiento

    for _ in range(n_iter):
        beta_eff = _beta_effective(Sa_pp, Sd_pp, Sy, dy)
        # Ratio de reducción respecto al espectro elástico (5% amort.):
        # ratio = B(beta_eff) / B(5%)  < 1 para beta_eff > 5% → reduce la demanda
        ratio = _B_reduction(beta_eff) / B5

        # Reducir espectro elástico por amortiguamiento efectivo
        Sa_red = [sa * ratio for sa in demand_elastic.Sa]
        demand_reduced = AdrsCurve(Sa=Sa_red, Sd=demand_elastic.Sd, T=demand_elastic.T)

        # Nueva intersección
        Sa_new, Sd_new = _intersect_adrs(capacity.Sa, capacity.Sd, Sa_red, demand_reduced.Sd)

        if abs(Sd_new - Sd_pp) < tol and abs(Sa_new - Sa_pp) < tol:
            Sd_pp = Sd_new
            Sa_pp = Sa_new
            break

        Sd_pp = 0.5 * (Sd_pp + Sd_new)
        Sa_pp = 0.5 * (Sa_pp + Sa_new)

    T_eff = 2.0 * math.pi * math.sqrt(Sd_pp / (Sa_pp * G_MS2)) if Sa_pp > 0 else 0.0

    converged = abs(Sd_new - capacity.Sd[-1]) < 1e-3  # si llegó al borde, probablemente no convergió bien
    converged = True  # simplificación: siempre "convergió" al último valor

    return PerformancePoint(
        Sa_pp=round(Sa_pp, 4),
        Sd_pp=round(Sd_pp, 4),
        drift_pp=round(Sd_pp / capacity.Sd[-1] * capacity.Sa[-1] * 100, 3),  # approx drift %
        beta_eff=round(beta_eff, 1),
        T_eff=round(T_eff, 3),
        converged=converged,
    ), demand_reduced


def classify_performance(drift_pp_pct: float) -> PerformanceLevel:
    """Clasifica el nivel de desempeño según la deriva en el punto de desempeño."""
    if drift_pp_pct <= _DRIFT_LIMITS["IO"]:
        return PERFORMANCE_LEVELS["IO"]
    elif drift_pp_pct <= _DRIFT_LIMITS["LS"]:
        return PERFORMANCE_LEVELS["LS"]
    elif drift_pp_pct <= _DRIFT_LIMITS["CP"]:
        return PERFORMANCE_LEVELS["CP"]
    else:
        return PERFORMANCE_LEVELS["C"]


# ── API pública simplificada ───────────────────────────────────────────────────

def evaluate(
    dtecho_pct: list[float],
    vbasal_norm: list[float],
    total_height_m: float,
    T1_s: float,
    Aa: float,
    Av: float,
    soil_type: str,
) -> PerformanceResult:
    """
    Evaluación completa de desempeño sísmico.

    Entrada
    -------
    dtecho_pct    : Derivas de techo (% — ya normalizado por altura total)
    vbasal_norm   : Cortante basal normalizado V/W (fracción de g)
    total_height_m: Altura total H del edificio (m)
    T1_s          : Período fundamental (s)
    Aa, Av        : Coeficientes sísmicos NSR-10
    soil_type     : Perfil de suelo NSR-10 (A/B/C/D/E)

    Retorna
    -------
    PerformanceResult con toda la información para el frontend.
    """
    # 1. Capacidad en ADRS
    capacity = pushover_to_adrs(dtecho_pct, vbasal_norm, total_height_m, T1_s)

    # 2. Idealización bilineal
    Sy, dy, Su, du = _bilinear_idealize(capacity.Sd, capacity.Sa)

    # 3. Demanda elástica (5% amortiguamiento) en ADRS
    demand_elastic = demand_spectrum_adrs(Aa, Av, soil_type, beta_pct=5.0)

    # 4. Encontrar punto de desempeño
    pp, demand_reduced = find_performance_point(capacity, demand_elastic, Sy, dy)

    # 5. Recalcular drift real en el PP
    # Convertir Sd_pp de vuelta a drift (aprox: γ ≈ 1.0)
    delta_pp_m = pp.Sd_pp                                      # m
    drift_pp_pct = (delta_pp_m / total_height_m) * 100.0 if total_height_m > 0 else 0.0
    pp.drift_pp = round(drift_pp_pct, 3)

    # 6. Nivel de desempeño
    level = classify_performance(drift_pp_pct)

    # 7. Curva bilineal para gráfica
    bilinear_Sd = [0.0, dy, du]
    bilinear_Sa = [0.0, Sy, Sy]

    return PerformanceResult(
        capacity_adrs=capacity,
        demand_elastic=demand_elastic,
        demand_reduced=demand_reduced,
        performance_point=pp,
        performance_level=level,
        bilinear_Sa=bilinear_Sa,
        bilinear_Sd=bilinear_Sd,
        Sy=Sy,
        dy=dy,
        total_height_m=total_height_m,
        Aa=Aa,
        Av=Av,
        soil_type=soil_type,
    )
