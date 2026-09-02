"""
Diseño completo de columnas rectangulares — NSR-10 / ACI 318.

Produce un resultado detallado (ColumnDesignResult) que incluye:
  - demandas por combinación y envolvente
  - curva P-M completa para visualización (20+ puntos)
  - refuerzo longitudinal propuesto (barras seleccionadas)
  - diseño de estribos con zonas de confinamiento
  - chequeos normativos individuales

La función verify_custom() permite re-verificar con un refuerzo
editado manualmente por el ingeniero.

Unidades: kN, kN·m, m, cm², MPa.
"""
from __future__ import annotations

import math

from .combinations import NSR10_COMBINATIONS
from .column_check import parse_section, pm_capacity, check_pm
from .rebar_selector import (
    select_column_bars,
    verify_column_arrangement,
    bar_area_mm2,
    bar_diam_mm,
)


# ── Constantes NSR-10 ─────────────────────────────────────────────────────────

_RHO_MIN     = 0.01   # C.10.9.1
_RHO_MAX     = 0.08   # C.10.9.1
_ES          = 200_000.0  # MPa
_EPS_CU      = 0.003      # deformación última del concreto


# ── Curva P-M analítica (múltiples puntos) ────────────────────────────────────

def pm_curve_points(
    b_m: float,
    h_m: float,
    fc_MPa: float,
    As_cm2: float,
    fy_MPa: float = 420.0,
    cover_m: float = 0.040,
    n_points: int = 30,
) -> dict:
    """
    Genera la envolvente P-M completa con ~85 puntos distribuidos en tres zonas:
    - Zona 1: compresión dominante (log-espaciado, desde 4h hasta c_bal)
    - Zona 2: transición φ (denso lineal, c_bal → c_phi)  ← zona crítica
    - Zona 3: tensión controlada (lineal, c_phi → c_min)

    Convención de signos:  Pn > 0 = compresión,  Ts > 0 = tensión en acero.
    Fórmula correcta: Pn = Cc + Cs - Ts  (tensión RESTA, no suma).
    """
    b     = b_m  * 1000.0
    h     = h_m  * 1000.0
    cov   = cover_m * 1000.0
    Ag    = b * h
    Ast   = As_cm2 * 100.0          # mm²
    Ast_s = Ast / 2.0               # acero en cada cara

    d  = h - cov                    # dist. al acero de tensión (mm)
    dp = cov                        # dist. al acero de compresión (mm)

    if fc_MPa <= 28.0:
        beta1 = 0.85
    else:
        beta1 = max(0.65, 0.85 - 0.05 * (fc_MPa - 28.0) / 7.0)

    eps_y = fy_MPa / _ES

    # Profundidades clave del eje neutro
    c_bal = d * _EPS_CU / (_EPS_CU + eps_y)    # εt = εy  (punto de balance)
    c_phi = d * _EPS_CU / (_EPS_CU + 0.005)    # εt = 0.005  (inicio φ=0.90)

    # Límite de compresión máxima NSR-10 C.22.4.2.1 (tied columns)
    phi_Pn_max = 0.65 * 0.80 * (0.85 * fc_MPa * Ag + fy_MPa * Ast) / 1000.0

    # ── Generar valores de c ───────────────────────────────────────────────────
    c_vals: list[float] = []

    # Zona 1: desde 4h hasta c_bal — log-espaciado (21 puntos)
    n1 = 20
    c_hi = 4.0 * h
    for i in range(n1 + 1):
        t = i / n1
        c = c_hi * math.exp(math.log(c_bal / c_hi) * t)
        c_vals.append(c)

    # Zona 2: de c_bal a c_phi — lineal denso (34 puntos, excluye c_bal)
    n2 = 34
    for i in range(1, n2 + 1):
        c = c_bal + (c_phi - c_bal) * i / n2
        c_vals.append(c)

    # Zona 3: de c_phi a 2mm — lineal (28 puntos, excluye c_phi)
    n3 = 28
    for i in range(1, n3 + 1):
        c = c_phi + (2.0 - c_phi) * i / n3
        c_vals.append(c)

    # ── Calcular fuerzas para cada c ──────────────────────────────────────────
    P_kN:  list[float] = []
    M_kNm: list[float] = []

    for c in c_vals:
        a = min(beta1 * c, h)

        # Deformaciones unitarias
        eps_t  = _EPS_CU * (d  - c) / c   # acero de tensión  (+ = tensión)
        eps_cp = _EPS_CU * (c  - dp) / c  # acero de compresión (+ = compresión)

        # Tensiones (MPa)
        fs_t  = max(-fy_MPa, min(fy_MPa, _ES * eps_t))   # + = tensión
        fs_cp = max(-fy_MPa, min(fy_MPa, _ES * eps_cp))  # + = compresión

        # Fuerzas internas (N)
        Cc = 0.85 * fc_MPa * a * b                   # concreto comprimido
        Cs = Ast_s * (fs_cp - 0.85 * fc_MPa)         # acero comprimido (neto)
        Ts = Ast_s * fs_t                             # acero en tensión (+ = tensión)

        Pn = Cc + Cs - Ts   # tensión en Ts RESTA la carga axial

        Mn = (Cc * (h / 2.0 - a  / 2.0)
              + Cs * (h / 2.0 - dp)
              + Ts * (d - h / 2.0))
        Mn = abs(Mn)

        # Factor φ según deformación del acero de tensión
        if eps_t >= 0.005:
            phi = 0.90
        elif eps_t <= eps_y:
            phi = 0.65
        else:
            phi = 0.65 + (eps_t - eps_y) / (0.005 - eps_y) * 0.25

        phi_Pn = phi * Pn / 1000.0       # kN
        phi_Mn = phi * Mn / 1e6          # kN·m

        phi_Pn = min(phi_Pn, phi_Pn_max)

        P_kN.append(round(phi_Pn, 1))
        M_kNm.append(round(phi_Mn, 1))

    # Punto de compresión pura (M=0, P=φPn_max)
    P_kN.insert(0, round(phi_Pn_max, 1))
    M_kNm.insert(0, 0.0)

    # Punto de tensión pura (M=0, P=−φ·fy·Ast)
    P_kN.append(round(0.90 * (-fy_MPa * Ast) / 1000.0, 1))
    M_kNm.append(0.0)

    # Ordenar por P descendente (preserva forma de la curva)
    pairs = sorted(zip(P_kN, M_kNm), key=lambda t: -t[0])
    P_kN  = [p for p, _ in pairs]
    M_kNm = [m for _, m in pairs]

    return {"P_kN": P_kN, "M_kNm": M_kNm}


# ── Diseño de estribos ────────────────────────────────────────────────────────

def design_column_stirrups(
    b_m: float,
    h_m: float,
    L_m: float,
    long_bar_label: str,
    long_bar_n: int,
    fc_MPa: float,
    fy_MPa: float = 420.0,
    energy_dissipation: str = "DMO",
    tie_bar_label: str = "#3",
) -> dict:
    """
    Diseña el refuerzo transversal (estribos) de una columna.

    Aplica requisitos NSR-10 Título C.18 según nivel de ductilidad:
      - DMI / sin clasificar: requisitos mínimos ACI 318 C.9.7
      - DMO (C.18.4.3): zona de confinamiento en extremos
      - DES (C.18.7.5): requisitos más exigentes de confinamiento
    """
    b_mm   = b_m * 1000.0
    h_mm   = h_m * 1000.0
    L_mm   = L_m * 1000.0
    h_clr  = L_mm           # longitud libre (conservador: sin descontar profundidad de viga)

    db_long = bar_diam_mm(long_bar_label)  # diámetro barra longitudinal
    db_tie  = bar_diam_mm(tie_bar_label)   # diámetro estribo
    Av_tie  = bar_area_mm2(tie_bar_label)  # área de una rama

    ed = energy_dissipation.upper()

    warnings: list[str] = []

    # ── Longitud de confinamiento (zona de nudo) ──────────────────────────────
    if ed in ("DES", "DES_ESP"):
        # NSR-10 C.18.7.5.1
        Lc_mm = max(max(b_mm, h_mm), h_clr / 6.0, 450.0)
    elif ed == "DMO":
        # NSR-10 C.18.4.3.1
        Lc_mm = max(max(b_mm, h_mm), h_clr / 6.0, 450.0)
    else:
        # Mínimo ACI: 1.5 × dimensión mayor
        Lc_mm = max(b_mm, h_mm) * 1.5

    Lc_mm = min(Lc_mm, L_mm / 2.0)

    # ── Espaciado en zona de confinamiento ────────────────────────────────────
    if ed in ("DES", "DES_ESP"):
        # NSR-10 C.18.7.5.3
        s_max_conf = min(
            6.0 * db_long,
            150.0,
            min(b_mm, h_mm) / 4.0,
        )
    elif ed == "DMO":
        # NSR-10 C.18.4.3.2
        s_max_conf = min(
            8.0  * db_long,
            24.0 * db_tie,
            min(b_mm, h_mm) / 2.0,
            300.0,
        )
    else:
        s_max_conf = min(16.0 * db_long, 48.0 * db_tie, min(b_mm, h_mm))

    s_conf = max(50.0, s_max_conf)   # no menor a 50 mm constructivo
    s_conf = round(s_conf / 10.0) * 10.0   # redondear a 10 mm

    # ── Espaciado fuera de zona de confinamiento ──────────────────────────────
    if ed in ("DES", "DES_ESP", "DMO"):
        s_general = min(
            16.0 * db_long,
            48.0 * db_tie,
            min(b_mm, h_mm),
            300.0,
        )
    else:
        s_general = min(16.0 * db_long, 48.0 * db_tie, min(b_mm, h_mm))

    s_general = round(s_general / 10.0) * 10.0

    # ── Número de ramas ───────────────────────────────────────────────────────
    # Al menos 2 en cada dirección; 1 intermedio cada ≈ 300 mm
    n_legs_b = 2 + max(0, int((b_mm - 2 * 50) / 300))
    n_legs_h = 2 + max(0, int((h_mm - 2 * 50) / 300))

    # Cortante que resiste el concreto con estribos (verificación rápida)
    # Vc = 0.17·√fc·b·d / 1000 kN; se reporta como referencia
    d_mm  = max(b_mm, h_mm) - 65.0    # peralte efectivo estimado
    Vc_kN = 0.75 * 0.17 * math.sqrt(fc_MPa) * min(b_mm, h_mm) * d_mm / 1000.0

    # Advertencias
    if s_conf > 150.0 and ed in ("DES", "DES_ESP"):
        warnings.append("Espaciado de confinamiento podría exceder 150 mm. Verifique NSR-10 C.18.7.5.3.")

    return {
        "tie_bar_label":    tie_bar_label,
        "tie_diam_mm":      db_tie,
        "n_legs_b":         n_legs_b,
        "n_legs_h":         n_legs_h,
        "s_confined_mm":    round(s_conf),
        "s_general_mm":     round(s_general),
        "L_confinement_mm": round(Lc_mm),
        "phi_Vc_kN":        round(Vc_kN, 1),
        "energy_dissipation": energy_dissipation,
        "warnings":         warnings,
    }


# ── Chequeos normativos ───────────────────────────────────────────────────────

def column_checks(
    Pu_kN: float,
    Mu2_kNm: float,
    Mu3_kNm: float,
    Vu2_kN: float,
    Vu3_kN: float,
    b_m: float,
    h_m: float,
    fc_MPa: float,
    As_placed_cm2: float,
    As_req_cm2: float,
    fy_MPa: float = 420.0,
    cover_m: float = 0.040,
    governing_combo: str = "—",
    pm_cap: dict | None = None,
) -> dict:
    """
    Ejecuta todos los chequeos normativos para una columna con refuerzo colocado.

    pm_cap: resultado de pm_capacity() — se reutiliza si ya fue calculado.
    """
    b_mm = b_m * 1000.0
    h_mm = h_m * 1000.0
    Ag   = b_mm * h_mm
    As   = As_placed_cm2 * 100.0    # mm²
    rho  = As / Ag

    # Capacidad PM con el acero colocado
    if pm_cap is None:
        pm_cap = pm_capacity(b_m, h_m, fc_MPa, rho=rho, fy_MPa=fy_MPa, cover_m=cover_m)

    # Interacción P-M biaxial (método carga contorno — Bresler simplificado)
    # Para uniaxial: solo M2 (se puede extender a biaxial)
    Mu_res = math.sqrt(Mu2_kNm ** 2 + Mu3_kNm ** 2)  # momento resultante
    pm_result = check_pm(Pu_kN, Mu_res, pm_cap)

    # Cortante en cada dirección
    d_mm  = max(b_mm, h_mm) - cover_m * 1000.0
    phi_v = 0.75
    Vc    = 0.17 * math.sqrt(fc_MPa) * min(b_mm, h_mm) * d_mm / 1000.0
    phi_Vc = phi_v * Vc
    Vu_max = max(abs(Vu2_kN), abs(Vu3_kN))
    shear_ok = Vu_max <= phi_Vc * 2   # con estribos mínimos se puede doblar Vc aprox

    # Cuantías
    rho_min_ok = rho >= _RHO_MIN
    rho_max_ok = rho <= _RHO_MAX

    # Acero requerido vs colocado
    As_ok = As_placed_cm2 >= As_req_cm2 * 0.98  # 2% tolerancia numérica

    checks: dict = {
        "pm_interaction": {
            "ok":    pm_result["ok"],
            "dcr":   pm_result["dcr"],
            "Mu_cap_kNm": pm_result.get("Mu_cap_kNm", 0.0),
            "combo": governing_combo,
            "ref":   "NSR-10 C.10 / ACI 318 §22.4",
        },
        "rho_min": {
            "ok":      rho_min_ok,
            "rho_pct": round(rho * 100, 2),
            "limit_pct": 1.0,
            "ref":     "NSR-10 C.10.9.1",
        },
        "rho_max": {
            "ok":      rho_max_ok,
            "rho_pct": round(rho * 100, 2),
            "limit_pct": 8.0,
            "ref":     "NSR-10 C.10.9.1",
        },
        "as_placed": {
            "ok":        As_ok,
            "As_req_cm2": round(As_req_cm2, 2),
            "As_placed_cm2": round(As_placed_cm2, 2),
            "ref":       "NSR-10 C.10 / ACI 318",
        },
        "shear": {
            "ok":      shear_ok,
            "Vu_kN":   round(Vu_max, 1),
            "phi_Vc_kN": round(phi_Vc, 1),
            "dcr":     round(Vu_max / max(phi_Vc * 2, 0.1), 3),
            "ref":     "NSR-10 C.22.5 / ACI 318 §22.5",
        },
    }

    overall_ok = all(v["ok"] for v in checks.values())
    max_dcr    = max(
        checks["pm_interaction"]["dcr"],
        checks["shear"]["dcr"],
        (1.0 if not rho_min_ok else 0.0),
        (1.0 if not rho_max_ok else 0.0),
    )

    return {
        "checks":     checks,
        "overall_ok": overall_ok,
        "max_dcr":    round(max_dcr, 3),
    }


# ── Clase principal ───────────────────────────────────────────────────────────

class ColumnDesigner:
    """
    Diseñador completo de columna rectangular.

    Uso:
        designer = ColumnDesigner(frame_id, frame_data, demands_by_combo, params)
        result   = designer.design()
    """

    def __init__(
        self,
        frame_id: str,
        frame_data: dict,
        joints: dict,
        demands_by_combo: list[dict],
        seismic_params: dict,
        cover_m: float = 0.040,
        fy_MPa: float  = 420.0,
    ):
        self.frame_id         = frame_id
        self.frame_data       = frame_data
        self.joints           = joints
        self.demands_by_combo = demands_by_combo   # [{combo_id, Pu, Mu2, Mu3, Vu2, Vu3}]
        self.seismic_params   = seismic_params
        self.cover_m          = cover_m
        self.fy_MPa           = fy_MPa

    # ── Geometría ─────────────────────────────────────────────────────────────

    def _geometry(self) -> dict:
        sec_name = self.frame_data.get("section", "")
        sec_data = self.seismic_params.get("sections", {}).get(sec_name, {})

        b_m = sec_data.get("b_m", 0.0)
        h_m = sec_data.get("h_m", 0.0)
        if b_m == 0 or h_m == 0:
            from .column_check import parse_section
            parsed = parse_section(sec_name)
            if parsed:
                b_m = parsed["b_m"]
                h_m = parsed["h_m"]
            else:
                b_m, h_m = 0.30, 0.30

        # f'c desde material
        fc_MPa = 21.0
        mat_name = sec_data.get("material", "")
        mats = self.seismic_params.get("materials", {})
        if mat_name and mat_name in mats:
            fc_MPa = mats[mat_name].get("fpc_mpa", 21.0) or 21.0
        elif sec_data.get("fc_MPa"):
            fc_MPa = sec_data["fc_MPa"]
        else:
            from .column_check import parse_section
            parsed = parse_section(sec_name)
            if parsed:
                fc_MPa = parsed.get("fc_MPa", 21.0)

        # Longitud
        ji = self.joints.get(str(self.frame_data.get("joint_i", "")), {})
        jj = self.joints.get(str(self.frame_data.get("joint_j", "")), {})
        dz = jj.get("z", 0.0) - ji.get("z", 0.0)
        L_m = abs(dz) if abs(dz) > 0.1 else 3.0

        return {
            "b_m":      round(b_m, 4),
            "h_m":      round(h_m, 4),
            "fc_MPa":   fc_MPa,
            "L_m":      round(L_m, 3),
            "section":  sec_name,
        }

    # ── Envolvente de demandas ────────────────────────────────────────────────

    def _envelope(self) -> dict:
        """Determina la demanda gobernante a través de todas las combinaciones."""
        worst_combo   = "—"
        worst_mu      = 0.0
        worst_pu      = 0.0
        worst_mu2     = 0.0
        worst_mu3     = 0.0
        worst_vu2     = 0.0
        worst_vu3     = 0.0

        for d in self.demands_by_combo:
            mu  = math.sqrt(d.get("Mu2_kNm", 0.0)**2 + d.get("Mu3_kNm", 0.0)**2)
            pu  = d.get("Pu_kN", 0.0)
            if mu > worst_mu or (mu == worst_mu and pu > worst_pu):
                worst_mu    = mu
                worst_pu    = pu
                worst_mu2   = d.get("Mu2_kNm", 0.0)
                worst_mu3   = d.get("Mu3_kNm", 0.0)
                worst_vu2   = d.get("Vu2_kN",  0.0)
                worst_vu3   = d.get("Vu3_kN",  0.0)
                worst_combo = d.get("combo_id", "—")

        return {
            "Pu_kN":   round(worst_pu,  1),
            "Mu2_kNm": round(worst_mu2, 1),
            "Mu3_kNm": round(worst_mu3, 1),
            "Mu_res_kNm": round(worst_mu, 1),
            "Vu2_kN":  round(worst_vu2, 1),
            "Vu3_kN":  round(worst_vu3, 1),
            "combo":   worst_combo,
        }

    # ── Diseño ────────────────────────────────────────────────────────────────

    def design(self) -> dict:
        """Ejecuta el diseño completo. Retorna ColumnDesignResult."""
        geo      = self._geometry()
        envelope = self._envelope()

        b_m      = geo["b_m"]
        h_m      = geo["h_m"]
        fc_MPa   = geo["fc_MPa"]
        L_m      = geo["L_m"]
        Pu       = envelope["Pu_kN"]
        Mu_res   = envelope["Mu_res_kNm"]
        Mu2      = envelope["Mu2_kNm"]
        Mu3      = envelope["Mu3_kNm"]
        Vu2      = envelope["Vu2_kN"]
        Vu3      = envelope["Vu3_kN"]
        combo    = envelope["combo"]
        cov      = self.cover_m
        fy       = self.fy_MPa

        Ag = (b_m * 1000) * (h_m * 1000)

        # ── Capacidad con ρ=1% (para orientar el diseño) ──────────────────────
        cap_ref = pm_capacity(b_m, h_m, fc_MPa, rho=0.01, fy_MPa=fy, cover_m=cov)
        chk_ref = check_pm(Pu, Mu_res, cap_ref)

        # ── Acero longitudinal requerido ──────────────────────────────────────
        As_req_cm2 = _required_long_steel(Pu, Mu_res, b_m, h_m, fc_MPa, fy, cov)

        # ── Selección de barras ───────────────────────────────────────────────
        bars = select_column_bars(
            As_req_cm2 = As_req_cm2,
            b_m        = b_m,
            h_m        = h_m,
            cover_m    = cov,
            fy_MPa     = fy,
            fc_MPa     = fc_MPa,
        )

        # ── Curva P-M con el acero colocado ──────────────────────────────────
        pm_curve = pm_curve_points(
            b_m      = b_m,
            h_m      = h_m,
            fc_MPa   = fc_MPa,
            As_cm2   = bars["As_placed_cm2"],
            fy_MPa   = fy,
            cover_m  = cov,
        )

        # ── Capacidad con el acero propuesto ─────────────────────────────────
        rho_placed = bars["As_placed_cm2"] * 100 / Ag
        cap_placed = pm_capacity(b_m, h_m, fc_MPa, rho=rho_placed, fy_MPa=fy, cover_m=cov)
        chk_placed = check_pm(Pu, Mu_res, cap_placed)

        # ── Estribos ─────────────────────────────────────────────────────────
        ed = self.seismic_params.get("energy_dissipation", "DMO")
        stirrups = design_column_stirrups(
            b_m           = b_m,
            h_m           = h_m,
            L_m           = L_m,
            long_bar_label= bars["bar_label"],
            long_bar_n    = bars["n_bars"],
            fc_MPa        = fc_MPa,
            fy_MPa        = fy,
            energy_dissipation = ed,
        )

        # ── Chequeos ──────────────────────────────────────────────────────────
        chk_result = column_checks(
            Pu_kN         = Pu,
            Mu2_kNm       = Mu2,
            Mu3_kNm       = Mu3,
            Vu2_kN        = Vu2,
            Vu3_kN        = Vu3,
            b_m           = b_m,
            h_m           = h_m,
            fc_MPa        = fc_MPa,
            As_placed_cm2 = bars["As_placed_cm2"],
            As_req_cm2    = As_req_cm2,
            fy_MPa        = fy,
            cover_m       = cov,
            governing_combo = combo,
            pm_cap        = cap_placed,
        )

        # ── Advertencias globales ─────────────────────────────────────────────
        all_warnings = list(bars["warnings"]) + list(stirrups["warnings"])
        all_errors   = list(bars["errors"])

        story = self.frame_data.get("story", "—")

        return {
            # Identificación
            "frame_id":    self.frame_id,
            "story":       story,
            "section":     geo["section"],
            "element_type": "column",

            # Geometría
            "geometry": {
                "b_m":   b_m,
                "h_m":   h_m,
                "L_m":   L_m,
                "fc_MPa": fc_MPa,
                "fy_MPa": fy,
                "cover_m": cov,
                "Ag_cm2": round(Ag / 100, 1),
            },

            # Demandas
            "demands": {
                "governing": envelope,
                "by_combination": self.demands_by_combo,
            },

            # Acero requerido
            "required_reinforcement": {
                "As_long_cm2": round(As_req_cm2, 2),
                "rho_req_pct": round(As_req_cm2 * 100 / Ag, 2),
            },

            # Refuerzo propuesto (generado automáticamente)
            "proposed_reinforcement": {
                "longitudinal": bars,
                "transverse":   stirrups,
            },

            # Refuerzo definitivo (inicialmente igual al propuesto; el usuario puede modificarlo)
            "final_reinforcement": None,
            "user_modified": False,

            # Verificaciones con refuerzo propuesto
            "checks":     chk_result["checks"],
            "overall_ok": chk_result["overall_ok"],
            "max_dcr":    chk_result["max_dcr"],

            # Curva P-M para visualización
            "pm_curve":   pm_curve,

            # Capacidad con refuerzo propuesto
            "capacity": {
                "phi_Pn_max_kN": cap_placed["phi_Pn_max_kN"],
                "phi_Mn_kNm":    cap_placed["phi_Mn_kNm"],
                "phi_Pb_kN":     cap_placed["phi_Pb_kN"],
                "phi_Mb_kNm":    cap_placed["phi_Mb_kNm"],
                "phi_Pt_kN":     cap_placed["phi_Pt_kN"],
                "dcr":           chk_placed["dcr"],
                "ok":            chk_placed["ok"],
            },

            "warnings": all_warnings,
            "errors":   all_errors,
        }

    def verify_custom(self, reinforcement: dict) -> dict:
        """
        Re-verifica la columna con refuerzo editado manualmente por el ingeniero.

        reinforcement debe contener al menos:
          longitudinal: {n_bars, bar_label}
          transverse: {tie_bar_label, s_confined_mm, s_general_mm}
        """
        geo      = self._geometry()
        envelope = self._envelope()

        b_m, h_m, fc_MPa, L_m = geo["b_m"], geo["h_m"], geo["fc_MPa"], geo["L_m"]
        cov = self.cover_m
        fy  = self.fy_MPa
        Ag  = (b_m * 1000) * (h_m * 1000)

        long_r = reinforcement.get("longitudinal", {})
        n      = long_r.get("n_bars", 8)
        label  = long_r.get("bar_label", "#6")

        # Verificar disposición
        arr = verify_column_arrangement(
            bar_label  = label,
            n_bars     = n,
            b_m        = b_m,
            h_m        = h_m,
            cover_m    = cov,
        )

        As_placed = arr["As_placed_cm2"]
        rho = As_placed * 100 / Ag

        # Curva P-M actualizada
        pm_curve = pm_curve_points(b_m, h_m, fc_MPa, As_placed, fy, cov)

        # Capacidad actualizada
        cap = pm_capacity(b_m, h_m, fc_MPa, rho=rho/100, fy_MPa=fy, cover_m=cov)

        # Requerimiento con ρ=1% base
        As_req = _required_long_steel(
            envelope["Pu_kN"], envelope["Mu_res_kNm"],
            b_m, h_m, fc_MPa, fy, cov
        )

        # Chequeos
        chk = column_checks(
            Pu_kN         = envelope["Pu_kN"],
            Mu2_kNm       = envelope["Mu2_kNm"],
            Mu3_kNm       = envelope["Mu3_kNm"],
            Vu2_kN        = envelope["Vu2_kN"],
            Vu3_kN        = envelope["Vu3_kN"],
            b_m           = b_m,
            h_m           = h_m,
            fc_MPa        = fc_MPa,
            As_placed_cm2 = As_placed,
            As_req_cm2    = As_req,
            fy_MPa        = fy,
            cover_m       = cov,
            governing_combo = envelope["combo"],
            pm_cap        = cap,
        )

        pm_chk = check_pm(envelope["Pu_kN"], envelope["Mu_res_kNm"], cap)

        return {
            "arrangement":   arr,
            "As_placed_cm2": As_placed,
            "rho_pct":       round(rho, 2),
            "checks":        chk["checks"],
            "overall_ok":    chk["overall_ok"],
            "max_dcr":       chk["max_dcr"],
            "pm_curve":      pm_curve,
            "capacity": {
                "phi_Pn_max_kN": cap["phi_Pn_max_kN"],
                "phi_Mn_kNm":    cap["phi_Mn_kNm"],
                "dcr":           pm_chk["dcr"],
                "ok":            pm_chk["ok"],
            },
            "warnings": arr["warnings"],
            "errors":   arr["errors"],
        }


# ── Helpers internos ─────────────────────────────────────────────────────────

def _required_long_steel(
    Pu_kN: float,
    Mu_kNm: float,
    b_m: float,
    h_m: float,
    fc_MPa: float,
    fy_MPa: float,
    cover_m: float,
) -> float:
    """
    Estima el área de acero longitudinal requerida iterando sobre ρ.

    Parte de ρ=1% y aumenta hasta que la sección resiste (Pu, Mu).
    Retorna As_req en cm².
    """
    b_mm = b_m * 1000.0
    h_mm = h_m * 1000.0
    Ag   = b_mm * h_mm

    for rho in [i * 0.005 for i in range(2, 17)]:   # 1%, 1.5%, ..., 8%
        rho_use = min(rho, _RHO_MAX)
        cap = pm_capacity(b_m, h_m, fc_MPa, rho=rho_use, fy_MPa=fy_MPa, cover_m=cover_m)
        chk = check_pm(Pu_kN, Mu_kNm, cap)
        if chk["ok"]:
            return round(rho_use * Ag / 100.0, 2)

    # No converge: devolver el máximo permitido
    return round(_RHO_MAX * Ag / 100.0, 2)
