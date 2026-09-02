"""
Diseño completo de vigas rectangulares — NSR-10 / ACI 318.

Produce un BeamDesignResult que incluye:
  - clasificación del elemento (sismorresistente / secundario)
  - demandas por zona (extremo I, centro, extremo J)
  - diseño de flexión por zona con barras propuestas
  - diseño de cortante con zonas de confinamiento
  - chequeos normativos individuales
  - soporte para re-verificación con refuerzo editado

Unidades: kN, kN·m, m, cm², MPa.
"""
from __future__ import annotations

import math

from .beam_check import design_flexure, design_shear
from .rebar_selector import select_beam_bars, verify_beam_arrangement

# ── Constantes ────────────────────────────────────────────────────────────────

_B_MIN_SEISMIC_CM = 20.0   # ancho mínimo para viga sismorresistente (NSR-10 C.18.6.2)
_MIN_N_BARS       = 2      # mínimo 2 barras continuas por cara (NSR-10 C.18.6.3)


# ── Clasificación del elemento ────────────────────────────────────────────────

def classify_beam(b_m: float) -> str:
    """Clasificación por ancho — solo como fallback cuando no hay info topológica."""
    return "seismic_primary" if b_m * 100.0 >= _B_MIN_SEISMIC_CM else "secondary"


def classify_beam_topology(
    frame_data: dict,
    col_joints: "set[str]",
) -> str:
    """
    Clasifica una viga por conectividad topológica del modelo.

    Regla: si al menos UN extremo de la viga se conecta directamente a un nodo
    de columna, se considera sismorresistente (parte del sistema de pórticos).
    Si ningún extremo tiene columna, es secundaria/gravitacional.

    col_joints: conjunto pre-computado de IDs de joints que tienen columnas.
    """
    ji = str(frame_data.get("joint_i", ""))
    jj = str(frame_data.get("joint_j", ""))
    if ji in col_joints or jj in col_joints:
        return "seismic_primary"
    return "secondary"


# ── Diseño de cortante por zonas ──────────────────────────────────────────────

def design_beam_shear_zones(
    Vu_end_kN: float,
    Vu_mid_kN: float,
    b_m: float,
    h_m: float,
    fc_MPa: float,
    fy_MPa: float = 420.0,
    cover_m: float = 0.040,
    classification: str = "seismic_primary",
    energy_dissipation: str = "DMO",
    tie_bar_label: str = "#3",
    n_legs: int = 2,
) -> dict:
    """
    Diseña los estribos de la viga con dos zonas:
      - zona_confinada: longitud 2h desde cada apoyo (NSR-10 C.18.6.4)
      - zona_central:   tramo entre zonas de confinamiento

    Retorna espaciados, longitudes de zona y capacidades.
    """
    h_mm  = h_m * 1000.0
    b_mm  = b_m * 1000.0
    d_mm  = h_mm - cover_m * 1000.0

    from .rebar_selector import bar_area_mm2, bar_diam_mm
    db_tie = bar_diam_mm(tie_bar_label)
    Av_tie = bar_area_mm2(tie_bar_label) * n_legs   # área total en 1 estribo

    phi   = 0.75
    Vc    = 0.17 * math.sqrt(fc_MPa) * b_mm * d_mm / 1000.0   # kN
    phi_Vc = phi * Vc

    # ── Zona de confinamiento (extremos) ──────────────────────────────────────
    Vu_end = abs(Vu_end_kN)

    if Vu_end <= phi_Vc:
        Vs_req_conf = 0.0
        s_conf_req  = 9999.0
    else:
        Vs_req_conf = Vu_end / phi - Vc
        s_conf_req  = Av_tie * fy_MPa * d_mm / (Vs_req_conf * 1000.0)

    ed = energy_dissipation.upper()
    cl = classification

    if cl == "seismic_primary":
        if ed in ("DES", "DES_ESP"):
            # NSR-10 C.18.6.4.4
            # Buscar diam barra long (aprox #5 → 15.9 mm)
            s_max_conf = min(d_mm / 4.0, 6.0 * 15.9, 150.0)
        else:  # DMO: NSR-10 C.18.4.2.4
            s_max_conf = min(d_mm / 4.0, 8.0 * 15.9, 24.0 * db_tie, 300.0)
    else:
        s_max_conf = min(d_mm / 2.0, 600.0)

    s_conf = min(s_conf_req, s_max_conf)
    s_conf = max(50.0, s_conf)
    s_conf = round(s_conf / 10.0) * 10.0

    # ── Zona central ──────────────────────────────────────────────────────────
    Vu_mid = abs(Vu_mid_kN)

    if Vu_mid <= phi_Vc:
        Vs_req_mid = 0.0
        s_mid_req  = 9999.0
    else:
        Vs_req_mid = Vu_mid / phi - Vc
        s_mid_req  = Av_tie * fy_MPa * d_mm / (Vs_req_mid * 1000.0)

    s_max_mid = min(d_mm / 2.0, 600.0)
    s_mid     = min(s_mid_req, s_max_mid)
    s_mid     = max(50.0, s_mid)
    s_mid     = round(s_mid / 10.0) * 10.0

    # ── Longitud de zona de confinamiento ─────────────────────────────────────
    L_conf_mm = 2.0 * h_mm   # NSR-10 C.18.6.4.1

    # Capacidad de cortante con estribos propuestos
    phi_Vs_conf = phi * Av_tie * fy_MPa * d_mm / (s_conf * 1000.0)
    phi_Vs_mid  = phi * Av_tie * fy_MPa * d_mm / (s_mid  * 1000.0)

    dcr_shear_end = Vu_end / max(phi_Vc + phi_Vs_conf, 0.1)
    dcr_shear_mid = Vu_mid / max(phi_Vc + phi_Vs_mid,  0.1)

    return {
        "tie_bar_label":   tie_bar_label,
        "tie_diam_mm":     db_tie,
        "n_legs":          n_legs,
        "phi_Vc_kN":       round(phi_Vc,  1),
        # Zona confinada
        "zone_end": {
            "s_mm":        round(s_conf),
            "L_mm":        round(L_conf_mm),
            "phi_Vn_kN":   round(phi_Vc + phi_Vs_conf, 1),
            "dcr":         round(dcr_shear_end, 3),
            "ok":          dcr_shear_end <= 1.0,
        },
        # Zona central
        "zone_mid": {
            "s_mm":        round(s_mid),
            "phi_Vn_kN":   round(phi_Vc + phi_Vs_mid, 1),
            "dcr":         round(dcr_shear_mid, 3),
            "ok":          dcr_shear_mid <= 1.0,
        },
        "Vu_end_kN":  round(Vu_end, 1),
        "Vu_mid_kN":  round(Vu_mid, 1),
    }


# ── Chequeos de viga ──────────────────────────────────────────────────────────

def beam_checks(
    zones_flex:  dict,   # {"end_i": flex_result, "mid": ..., "end_j": ...}
    shear:       dict,   # resultado de design_beam_shear_zones
    classification: str,
    b_m: float,
    h_m: float,
    fc_MPa: float,
    fy_MPa: float = 420.0,
    cover_m: float = 0.040,
) -> dict:
    """Agrupa todos los chequeos en un dict estandarizado."""

    def _zone_ok(z: dict) -> bool:
        return z.get("ok_flex", False) and not z.get("section_fail", False)

    As_max = zones_flex["end_i"]["As_max_cm2"]
    As_min = zones_flex["end_i"]["As_min_cm2"]

    # Chequeo ancho mínimo sismorresistente
    b_cm = b_m * 100.0
    width_ok = b_cm >= _B_MIN_SEISMIC_CM if classification == "seismic_primary" else True

    checks = {
        "flexure_end_i": {
            "ok":  _zone_ok(zones_flex["end_i"]),
            "dcr": zones_flex["end_i"].get("dcr_flex", 0.0),
            "ref": "NSR-10 C.9 / ACI 318 §9.5",
        },
        "flexure_mid": {
            "ok":  _zone_ok(zones_flex["mid"]),
            "dcr": zones_flex["mid"].get("dcr_flex", 0.0),
            "ref": "NSR-10 C.9 / ACI 318 §9.5",
        },
        "flexure_end_j": {
            "ok":  _zone_ok(zones_flex["end_j"]),
            "dcr": zones_flex["end_j"].get("dcr_flex", 0.0),
            "ref": "NSR-10 C.9 / ACI 318 §9.5",
        },
        "shear_end": {
            "ok":  shear["zone_end"]["ok"],
            "dcr": shear["zone_end"]["dcr"],
            "ref": "NSR-10 C.22.5 / ACI 318 §22.5",
        },
        "shear_mid": {
            "ok":  shear["zone_mid"]["ok"],
            "dcr": shear["zone_mid"]["dcr"],
            "ref": "NSR-10 C.22.5 / ACI 318 §22.5",
        },
        "rho_min": {
            "ok":        all(
                z.get("As_req_cm2", 0) >= z.get("As_min_cm2", 0) - 0.01
                for z in zones_flex.values()
            ),
            "As_min_cm2": round(As_min, 2),
            "ref":        "NSR-10 C.9.6.1 / ACI 318 §9.6.1",
        },
        "rho_max": {
            "ok":         all(
                z.get("As_req_cm2", 0) <= z.get("As_max_cm2", 999)
                for z in zones_flex.values()
            ),
            "As_max_cm2": round(As_max, 2),
            "ref":        "NSR-10 C.9.7.3.3 / ACI 318 §9.7.3.3",
        },
        "seismic_width": {
            "ok":       width_ok,
            "b_cm":     round(b_cm, 1),
            "min_b_cm": _B_MIN_SEISMIC_CM,
            "ref":      "NSR-10 C.18.6.2.1",
        },
    }

    overall_ok = all(v["ok"] for v in checks.values())
    max_dcr    = max(
        v.get("dcr", 0.0) for v in checks.values()
        if isinstance(v.get("dcr"), (int, float))
    )

    return {
        "checks":     checks,
        "overall_ok": overall_ok,
        "max_dcr":    round(max_dcr, 3),
    }


# ── Helpers de diseño ────────────────────────────────────────────────────────

_DB_STIRRUP_MM = 9.5   # #3 estribo

def _compute_d_eff(bar_label: str, layers: int, n_bars: int,
                   h_mm: float, cov_mm: float) -> float:
    """Profundidad efectiva real al centroide del acero de tensión."""
    from .rebar_selector import bar_diam_mm
    db = bar_diam_mm(bar_label)
    d1 = h_mm - cov_mm - _DB_STIRRUP_MM - db / 2.0
    if layers < 2 or n_bars <= 2:
        return max(d1, h_mm * 0.5)
    # Segunda capa: separación libre ≥ max(db, 25mm)
    s_clear = max(db, 25.0)
    d2 = d1 - db - s_clear
    n2 = max(2, n_bars // 3)        # estimación de barras en capa 2
    n1 = n_bars - n2
    d_eff = (n1 * d1 + n2 * d2) / n_bars
    return max(d_eff, h_mm * 0.4)


def _phi_mn_placed(As_cm2: float, bar_label: str, layers: int, n_bars: int,
                   b_mm: float, h_mm: float, cov_mm: float,
                   fc_MPa: float, fy_MPa: float) -> tuple[float, float]:
    """Retorna (phi_Mn_kNm, d_eff_mm) con barras colocadas y d real."""
    d_eff = _compute_d_eff(bar_label, layers, n_bars, h_mm, cov_mm)
    As_mm2 = As_cm2 * 100.0
    a = As_mm2 * fy_MPa / (0.85 * fc_MPa * b_mm)
    phi_Mn = 0.90 * As_mm2 * fy_MPa * (d_eff - a / 2.0) / 1e6
    return max(phi_Mn, 0.0), d_eff


def _select_and_verify(
    As_target: float,
    Mu_kNm: float,
    b_m: float,
    h_m: float,
    cover_m: float,
    fc_MPa: float,
    fy_MPa: float,
    As_max_cm2: float,
    max_iter: int = 4,
) -> "tuple[dict, dict]":
    """
    Selecciona barras para una cara de viga y verifica la capacidad real (d_eff).
    Si DCR > 1.0, aumenta As y repite hasta max_iter veces.
    """
    b_mm   = b_m * 1000.0
    h_mm   = h_m * 1000.0
    cov_mm = cover_m * 1000.0

    As_try = max(As_target, 0.1)
    bars   = select_beam_bars(As_try, b_m, h_m, cover_m, fy_MPa=fy_MPa, fc_MPa=fc_MPa)

    at_max = False
    for _ in range(max_iter):
        phi_Mn, d_eff = _phi_mn_placed(
            bars["As_placed_cm2"], bars["bar_label"], bars.get("layers", 1),
            bars["n_bars"], b_mm, h_mm, cov_mm, fc_MPa, fy_MPa,
        )
        dcr = Mu_kNm / phi_Mn if (phi_Mn > 0.01 and Mu_kNm > 0.01) else 0.0
        if dcr <= 1.002:   # tolerancia numérica
            break
        # Aumentar acero: escalar As por DCR + margen
        As_new = bars["As_placed_cm2"] * (dcr + 0.05)
        if As_new > As_max_cm2:
            at_max = True
            break
        bars = select_beam_bars(As_new, b_m, h_m, cover_m, fy_MPa=fy_MPa, fc_MPa=fc_MPa)

    verify = {
        "phi_Mn_kNm":  round(phi_Mn, 1),
        "d_eff_mm":    round(d_eff, 1),
        "dcr":         round(dcr, 3),
        "ok":          dcr <= 1.0,
        "at_max_steel": at_max,
    }
    return bars, verify


# ── Clase principal ───────────────────────────────────────────────────────────

class BeamDesigner:
    """
    Diseñador completo de viga rectangular.

    demands_by_zone: {
      "end_i":  {"Mu_neg_kNm", "Mu_pos_kNm", "Vu_kN", "combo_id"},
      "mid":    {...},
      "end_j":  {...},
    }
    """

    def __init__(
        self,
        frame_id:        str,
        frame_data:      dict,
        joints:          dict,
        demands_by_zone: dict,
        demands_by_combo: list[dict],
        seismic_params:  dict,
        cover_m:         float = 0.040,
        fy_MPa:          float = 420.0,
        col_joints:      "set[str] | None" = None,
        combinations_used: "list[str] | None" = None,
    ):
        self.frame_id           = frame_id
        self.frame_data         = frame_data
        self.joints             = joints
        self.demands_by_zone    = demands_by_zone
        self.demands_by_combo   = demands_by_combo
        self.seismic_params     = seismic_params
        self.cover_m            = cover_m
        self.fy_MPa             = fy_MPa
        self.col_joints         = col_joints or set()
        self.combinations_used  = combinations_used or []
        # Clasificación topológica al construir (fallback a width si no hay col_joints)
        if col_joints is not None:
            self._classification = classify_beam_topology(frame_data, col_joints)
        else:
            from .beam_check import parse_beam_section
            sec = seismic_params.get("sections", {}).get(frame_data.get("section", ""), {})
            b_m = sec.get("b_m", 0.30)
            self._classification = classify_beam(b_m)

    # ── Geometría ─────────────────────────────────────────────────────────────

    def _geometry(self) -> dict:
        sec_name = self.frame_data.get("section", "")
        secs     = self.seismic_params.get("sections", {})
        sec_data = secs.get(sec_name, {})

        b_m = sec_data.get("b_m", 0.0)
        h_m = sec_data.get("h_m", 0.0)
        if b_m == 0 or h_m == 0:
            from .beam_check import parse_beam_section
            parsed = parse_beam_section(sec_name)
            if parsed:
                b_m, h_m = parsed["b_m"], parsed["h_m"]
            else:
                b_m, h_m = 0.30, 0.40

        fc_MPa = 21.0
        mat_name = sec_data.get("material", "")
        mats = self.seismic_params.get("materials", {})
        if mat_name and mat_name in mats:
            fc_MPa = mats[mat_name].get("fpc_mpa", 21.0) or 21.0
        elif sec_data.get("fc_MPa"):
            fc_MPa = sec_data["fc_MPa"]
        else:
            from .beam_check import parse_beam_section
            parsed = parse_beam_section(sec_name)
            if parsed:
                fc_MPa = parsed.get("fc_MPa", 21.0)

        # Longitud en planta
        ji = self.joints.get(str(self.frame_data.get("joint_i", "")), {})
        jj = self.joints.get(str(self.frame_data.get("joint_j", "")), {})
        dx = jj.get("x", 0.0) - ji.get("x", 0.0)
        dy = jj.get("y", 0.0) - ji.get("y", 0.0)
        L  = math.sqrt(dx*dx + dy*dy)
        L_m = L if L > 0.1 else 3.0

        return {
            "b_m":    round(b_m, 4),
            "h_m":    round(h_m, 4),
            "L_m":    round(L_m, 3),
            "fc_MPa": fc_MPa,
            "fy_MPa": self.fy_MPa,
            "cover_m": self.cover_m,
            "section": sec_name,
        }

    # ── Diseño ────────────────────────────────────────────────────────────────

    def design(self) -> dict:
        """Diseño completo. Retorna BeamDesignResult."""
        geo = self._geometry()
        b_m, h_m, L_m = geo["b_m"], geo["h_m"], geo["L_m"]
        fc  = geo["fc_MPa"]
        fy  = geo["fy_MPa"]
        cov = geo["cover_m"]

        classification = self._classification
        ed = self.seismic_params.get("energy_dissipation", "DMO")

        # ── Flexión por zona ──────────────────────────────────────────────────
        zones_input = {
            "end_i":  self.demands_by_zone.get("end_i",  {}),
            "mid":    self.demands_by_zone.get("mid",    {}),
            "end_j":  self.demands_by_zone.get("end_j",  {}),
        }

        zones_flex: dict[str, dict] = {}
        zones_bars: dict[str, dict] = {}

        for zone_name, dem in zones_input.items():
            Mu_neg = abs(dem.get("Mu_neg_kNm", 0.0))
            Mu_pos = abs(dem.get("Mu_pos_kNm", 0.0))
            Mu_max = max(Mu_neg, Mu_pos)

            # Usar cover_eff para design: añade ~20 mm para estribo + mitad de barra
            # Esto garantiza que As_req cubra la capacidad real con la profundidad efectiva
            cov_eff = cov + 0.020
            flex = design_flexure(Mu_max, b_m, h_m, fc, fy, cov_eff)
            zones_flex[zone_name] = {
                "Mu_neg_kNm":  round(Mu_neg, 1),
                "Mu_pos_kNm":  round(Mu_pos, 1),
                "combo":       dem.get("combo_id", "—"),
                **flex,
            }

            # Selección de barras para esta zona
            As_top = max(flex["As_req_cm2"] if Mu_neg >= Mu_pos else flex["As_min_cm2"],
                         flex["As_min_cm2"])
            As_bot = max(flex["As_req_cm2"] if Mu_pos >  Mu_neg else flex["As_min_cm2"] * 0.5,
                         flex["As_min_cm2"] * 0.5)

            # Requis. sísmica: As_pos ≥ As_neg/2 (NSR-10 C.18.6.3)
            if classification == "seismic_primary":
                As_neg_all = zones_flex.get("end_i", {}).get("As_req_cm2", As_top)
                As_bot_min_seismic = max(As_neg_all / 2.0, flex["As_min_cm2"])
                As_bot = max(As_bot, As_bot_min_seismic)

            # Selección + verificación real + iteración si DCR > 1.0
            bars_top, verify_top = _select_and_verify(
                As_top, Mu_max, b_m, h_m, cov, fc, fy, flex["As_max_cm2"]
            )
            Mu_bot = Mu_pos if Mu_pos > Mu_neg else Mu_max * 0.5
            bars_bot, verify_bot = _select_and_verify(
                As_bot, Mu_bot, b_m, h_m, cov, fc, fy, flex["As_max_cm2"]
            )

            # Actualizar zonas_flex con la capacidad real (d_eff de barras colocadas)
            zones_flex[zone_name]["phi_Mn_kNm"]     = verify_top["phi_Mn_kNm"]
            zones_flex[zone_name]["d_eff_mm"]        = verify_top["d_eff_mm"]
            zones_flex[zone_name]["dcr_flex"]        = verify_top["dcr"]
            zones_flex[zone_name]["ok_flex"]         = verify_top["dcr"] <= 1.0
            zones_flex[zone_name]["design_status"]   = (
                flex.get("design_status", "OK")
                if verify_top["dcr"] <= 1.0
                else ("SECTION_INSUFFICIENT" if verify_top.get("at_max_steel") else "WARNING")
            )

            zones_bars[zone_name] = {
                "top": bars_top,
                "bot": bars_bot,
                "As_top_req_cm2": round(As_top, 2),
                "As_bot_req_cm2": round(As_bot, 2),
                "verify_top": verify_top,
                "verify_bot": verify_bot,
            }

        # ── Cortante ─────────────────────────────────────────────────────────
        Vu_end = max(
            abs(zones_input["end_i"].get("Vu_kN", 0.0)),
            abs(zones_input["end_j"].get("Vu_kN", 0.0)),
        )
        Vu_mid = abs(zones_input["mid"].get("Vu_kN", 0.0))

        shear = design_beam_shear_zones(
            Vu_end_kN      = Vu_end,
            Vu_mid_kN      = Vu_mid,
            b_m            = b_m,
            h_m            = h_m,
            fc_MPa         = fc,
            fy_MPa         = fy,
            cover_m        = cov,
            classification = classification,
            energy_dissipation = ed,
        )

        # ── Chequeos ──────────────────────────────────────────────────────────
        chk = beam_checks(
            zones_flex     = zones_flex,
            shear          = shear,
            classification = classification,
            b_m            = b_m,
            h_m            = h_m,
            fc_MPa         = fc,
            fy_MPa         = fy,
            cover_m        = cov,
        )

        # ── Refuerzo propuesto simplificado ───────────────────────────────────
        # Barras continuas superiores: máximo de extremos
        As_top_i   = zones_bars["end_i"]["top"]["As_placed_cm2"]
        As_top_j   = zones_bars["end_j"]["top"]["As_placed_cm2"]
        As_top_max = max(As_top_i, As_top_j)

        # Barra continua inferior: mínimo de zonas
        As_bot_mid = zones_bars["mid"]["bot"]["As_placed_cm2"]

        # Refuerzo adicional extremos
        extra_bars_i = _compute_extra(
            zones_bars["end_i"]["top"]["As_placed_cm2"],
            zones_bars["mid"]["top"]["As_placed_cm2"],
            b_m, h_m, cov, fy, fc
        )
        extra_bars_j = _compute_extra(
            zones_bars["end_j"]["top"]["As_placed_cm2"],
            zones_bars["mid"]["top"]["As_placed_cm2"],
            b_m, h_m, cov, fy, fc
        )

        story = self.frame_data.get("story", "—")
        warnings_all: list[str] = []
        errors_all:   list[str] = []

        if classification == "secondary":
            warnings_all.append(
                "Elemento clasificado como SECUNDARIO/GRAVITACIONAL por conectividad topológica. "
                "Diseñado solo con combinaciones gravitacionales. No se aplican requisitos sísmicos C.18.6."
            )

        # Determinar design_status global
        has_insufficient = any(
            z.get("design_status") == "SECTION_INSUFFICIENT"
            for zone in zones_flex.values()
            for z in [zone]
        )
        has_section_fail = any(
            zone.get("section_fail", False) for zone in zones_flex.values()
        )
        if has_section_fail:
            overall_design_status = "SECTION_INSUFFICIENT"
        elif has_insufficient:
            overall_design_status = "SECTION_INSUFFICIENT"
        elif not chk["overall_ok"]:
            # Falla por cuantía o cortante, pero no por insuficiencia de sección
            overall_design_status = "WARNING" if chk["max_dcr"] <= 1.1 else "SECTION_INSUFFICIENT"
        else:
            overall_design_status = "OK"

        for zone in zones_bars.values():
            warnings_all.extend(zone["top"].get("warnings", []))
            warnings_all.extend(zone["bot"].get("warnings", []))
            errors_all.extend(zone["top"].get("errors", []))
            errors_all.extend(zone["bot"].get("errors", []))

        seismic_participation = "sismorresistente" if classification == "seismic_primary" else "gravitacional"

        return {
            # Identificación
            "frame_id":             self.frame_id,
            "story":                story,
            "section":              geo["section"],
            "element_type":         "beam",
            "classification":       classification,
            "seismic_participation": seismic_participation,
            "combinations_used":    self.combinations_used,
            "design_status":        overall_design_status,

            # Geometría
            "geometry": {
                "b_m":    b_m,
                "h_m":    h_m,
                "L_m":    L_m,
                "fc_MPa": fc,
                "fy_MPa": fy,
                "cover_m": cov,
                "b_cm":    round(b_m * 100, 1),
                "h_cm":    round(h_m * 100, 1),
            },

            # Demandas
            "demands": {
                "by_zone":       zones_flex,
                "by_combination": self.demands_by_combo,
                "Vu_end_kN":     round(Vu_end, 1),
                "Vu_mid_kN":     round(Vu_mid, 1),
            },

            # Refuerzo requerido y propuesto por zona
            "reinforcement_by_zone": zones_bars,

            # Propuesta simplificada de armado
            "proposed_reinforcement": {
                "top_continuous": {
                    "label":     "Superior corrida",
                    "n_bars":    zones_bars["mid"]["top"]["n_bars"],
                    "bar_label": zones_bars["mid"]["top"]["bar_label"],
                    "As_cm2":    zones_bars["mid"]["top"]["As_placed_cm2"],
                },
                "top_extra_i": {
                    "label":     "Superior adicional extremo I",
                    **extra_bars_i,
                    "L_m":       round(geo["L_m"] * 0.33, 2),
                },
                "top_extra_j": {
                    "label":     "Superior adicional extremo J",
                    **extra_bars_j,
                    "L_m":       round(geo["L_m"] * 0.33, 2),
                },
                "bot_continuous": {
                    "label":     "Inferior corrido",
                    "n_bars":    zones_bars["mid"]["bot"]["n_bars"],
                    "bar_label": zones_bars["mid"]["bot"]["bar_label"],
                    "As_cm2":    zones_bars["mid"]["bot"]["As_placed_cm2"],
                },
                "stirrups": {
                    "zone_end": {
                        "bar_label": shear["tie_bar_label"],
                        "n_legs":    shear["n_legs"],
                        "s_mm":      shear["zone_end"]["s_mm"],
                        "L_m":       round(2.0 * h_m, 2),
                    },
                    "zone_mid": {
                        "bar_label": shear["tie_bar_label"],
                        "n_legs":    shear["n_legs"],
                        "s_mm":      shear["zone_mid"]["s_mm"],
                    },
                },
            },

            "shear_design":   shear,
            "final_reinforcement": None,
            "user_modified":  False,

            # Verificaciones
            "checks":     chk["checks"],
            "overall_ok": chk["overall_ok"],
            "max_dcr":    chk["max_dcr"],

            "warnings": list(set(warnings_all)),
            "errors":   list(set(errors_all)),
        }

    def verify_custom(self, reinforcement: dict) -> dict:
        """
        Re-verifica la viga con refuerzo editado manualmente por el ingeniero.

        reinforcement estructura:
          {
            "top_bars": {"n_bars": int, "bar_label": str},
            "bot_bars": {"n_bars": int, "bar_label": str},
            "stirrups": {
              "zone_end": {"bar_label": str, "n_legs": int, "s_mm": float},
              "zone_mid": {"bar_label": str, "n_legs": int, "s_mm": float},
            }
          }
        """
        geo = self._geometry()
        b_m, h_m = geo["b_m"], geo["h_m"]
        fc, fy, cov = geo["fc_MPa"], geo["fy_MPa"], geo["cover_m"]

        top_r  = reinforcement.get("top_bars", {})
        bot_r  = reinforcement.get("bot_bars", {})
        stir_r = reinforcement.get("stirrups", {})

        top_arr = verify_beam_arrangement(
            top_r.get("bar_label", "#5"),
            top_r.get("n_bars", 2),
            b_m, cov,
        )
        bot_arr = verify_beam_arrangement(
            bot_r.get("bar_label", "#5"),
            bot_r.get("n_bars", 2),
            b_m, cov,
        )

        # Re-calcular flexión con el acero colocado
        zones_flex: dict[str, dict] = {}
        for zone_name, dem in self.demands_by_zone.items():
            Mu_neg = abs(dem.get("Mu_neg_kNm", 0.0))
            Mu_pos = abs(dem.get("Mu_pos_kNm", 0.0))
            Mu_max = max(Mu_neg, Mu_pos)

            flex_req = design_flexure(Mu_max, b_m, h_m, fc, fy, cov)
            zones_flex[zone_name] = {
                "Mu_neg_kNm":  round(Mu_neg, 1),
                "Mu_pos_kNm":  round(Mu_pos, 1),
                **flex_req,
            }

        # Cortante con estribos del usuario
        se = stir_r.get("zone_end", {})
        sm = stir_r.get("zone_mid", {})

        Vu_end = max(
            abs(self.demands_by_zone.get("end_i", {}).get("Vu_kN", 0.0)),
            abs(self.demands_by_zone.get("end_j", {}).get("Vu_kN", 0.0)),
        )
        Vu_mid = abs(self.demands_by_zone.get("mid", {}).get("Vu_kN", 0.0))

        shear = design_beam_shear_zones(
            Vu_end_kN  = Vu_end,
            Vu_mid_kN  = Vu_mid,
            b_m        = b_m,
            h_m        = h_m,
            fc_MPa     = fc,
            fy_MPa     = fy,
            cover_m    = cov,
            tie_bar_label = se.get("bar_label", "#3"),
            n_legs        = se.get("n_legs", 2),
        )

        chk = beam_checks(
            zones_flex     = zones_flex,
            shear          = shear,
            classification = self._classification,
            b_m            = b_m,
            h_m            = h_m,
            fc_MPa         = fc,
            fy_MPa         = fy,
            cover_m        = cov,
        )

        warnings_all = top_arr["warnings"] + bot_arr["warnings"]
        errors_all   = top_arr["errors"]   + bot_arr["errors"]

        return {
            "top_arrangement":    top_arr,
            "bot_arrangement":    bot_arr,
            "shear_design":       shear,
            "checks":             chk["checks"],
            "overall_ok":         chk["overall_ok"],
            "max_dcr":            chk["max_dcr"],
            "seismic_participation": "sismorresistente" if self._classification == "seismic_primary" else "gravitacional",
            "warnings":           list(set(warnings_all)),
            "errors":             list(set(errors_all)),
        }


# ── Helpers ───────────────────────────────────────────────────────────────────

def _compute_extra(
    As_required: float,
    As_continuous: float,
    b_m: float,
    h_m: float,
    cover_m: float,
    fy_MPa: float,
    fc_MPa: float,
) -> dict:
    """Calcula barras adicionales de extremo respecto a barras continuas de centro."""
    As_extra = max(0.0, As_required - As_continuous)
    if As_extra < 0.5:
        return {"n_bars": 0, "bar_label": "—", "As_cm2": 0.0}
    bars = select_beam_bars(As_extra, b_m, h_m, cover_m, fy_MPa=fy_MPa, fc_MPa=fc_MPa)
    return {
        "n_bars":    bars["n_bars"],
        "bar_label": bars["bar_label"],
        "As_cm2":    bars["As_placed_cm2"],
    }
