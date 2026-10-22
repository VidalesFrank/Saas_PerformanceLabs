"""
Validador NSR-10 "soft" del refuerzo definido por el usuario.

A diferencia de los `designer.verify_custom()` (que necesitan demandas), este
validador aplica solo reglas constructivas del refuerzo (NSR-10 C.21 para
elementos del sistema sismo-resistente). No bloquea: devuelve una lista de
avisos (warnings) con nivel `info | warning | error`.

Pensado para edificios existentes donde la verdad de obra puede incumplir
NSR-10. El usuario puede guardar igual; los warnings quedan registrados.

Entradas:
    element_type: "column" | "beam"
    reinforcement: dict en el schema del NLSpecBuilder (longitudinal + transverse
                   para columnas; zones+shear para vigas)
    geometry: {b_m, h_m}
    ed: "DMI" | "DMO" | "DES"

Salida:
    list[{level, code, message}]
"""
from __future__ import annotations

import math

_BAR_DIAM_MM: dict[str, float] = {
    "#3":  9.5,  "#4": 12.7,  "#5": 15.9,  "#6": 19.1,  "#7": 22.2,
    "#8": 25.4,  "#9": 28.7,  "#10": 32.3, "#11": 35.8,
}
_BAR_AREA_CM2: dict[str, float] = {
    label: round(math.pi * (d / 10.0) ** 2 / 4.0, 3)
    for label, d in _BAR_DIAM_MM.items()
}


def _db_mm(label: str, default: float = 15.9) -> float:
    return _BAR_DIAM_MM.get(str(label).strip(), default)


def _As_cm2(label: str, n_bars: int) -> float:
    return _BAR_AREA_CM2.get(str(label).strip(), 2.0) * max(int(n_bars), 0)


def _warn(level: str, code: str, message: str) -> dict:
    return {"level": level, "code": code, "message": message}


# ── Columnas ──────────────────────────────────────────────────────────────────

def validate_column_reinforcement(
    reinforcement: dict,
    geometry: dict,
    ed: str = "DMO",
) -> list[dict]:
    """
    Reglas aplicadas:
    - ρ ∈ [1%, 4%] (NSR-10 C.21.6.3.1 — DES; C.10.9.1 — general).
    - Separación de estribos s ≤ min(6·db_long, 150 mm) en zona confinada
      para DES (C.21.6.4.3). Para DMO: ≤ min(8·db_long, 200 mm).
    - db_tie ≥ #3 (9.5 mm) para columnas con db_long ≤ #10 (NSR-10 C.7.10.5.1).
    - n_bars ≥ 4 (rectangular, estribo cerrado).
    - cover ≥ 40 mm (C.7.7).
    """
    warnings: list[dict] = []
    long_r = reinforcement.get("longitudinal", {})
    tran_r = reinforcement.get("transverse", {})

    b = float(geometry.get("b_m", 0.3))
    h = float(geometry.get("h_m", 0.3))
    Ag_cm2 = b * h * 1e4

    # Soporta schema granular (groups con corners/top_face/bot_face/left_face/right_face)
    # y legacy ({n_bars, bar_label}).
    groups = long_r.get("groups")
    if isinstance(groups, dict) and groups:
        n_bars    = sum(int((groups.get(k) or {}).get("n_bars", 0))
                        for k in ("corners", "top_face", "bot_face", "left_face", "right_face"))
        As_cm2    = sum(float((groups.get(k) or {}).get("As_cm2", 0))
                        for k in ("corners", "top_face", "bot_face", "left_face", "right_face"))
        if not As_cm2:
            As_cm2 = sum(_As_cm2(str((groups.get(k) or {}).get("bar_label", "#5")),
                                 int((groups.get(k) or {}).get("n_bars", 0)))
                         for k in ("corners", "top_face", "bot_face", "left_face", "right_face"))
        # db_long representativo = mayor diámetro presente (más común para checks)
        db_long = max([_db_mm(str((groups.get(k) or {}).get("bar_label", "#3")))
                       for k in ("corners", "top_face", "bot_face", "left_face", "right_face")
                       if int((groups.get(k) or {}).get("n_bars", 0)) > 0] or [15.9])
        bar_label = f"#máx={db_long:.1f}mm"
    else:
        n_bars    = int(long_r.get("n_bars", 0))
        bar_label = str(long_r.get("bar_label", "#5"))
        db_long   = _db_mm(bar_label)
        As_cm2    = float(long_r.get("As_cm2", 0)) or _As_cm2(bar_label, n_bars)
    rho       = As_cm2 / Ag_cm2 if Ag_cm2 > 0 else 0.0

    # ρ_min = 1% (ductilidad DES: C.21.6.3.1; general: C.10.9.1)
    if rho < 0.01 - 1e-6:
        warnings.append(_warn(
            "warning", "RHO_LT_MIN",
            f"Cuantía longitudinal ρ = {rho * 100:.2f}% < 1.0% (NSR-10 C.10.9.1 / C.21.6.3.1).",
        ))
    # ρ_max = 4% (C.10.9.1); 6% en DES solo si no cruzan empalmes (C.21.6.3.1)
    if rho > 0.04 + 1e-6:
        warnings.append(_warn(
            "warning", "RHO_GT_MAX",
            f"Cuantía longitudinal ρ = {rho * 100:.2f}% > 4.0% (NSR-10 C.10.9.1). "
            "DES permite hasta 6% sin empalmes.",
        ))
    if n_bars < 4:
        warnings.append(_warn(
            "error", "NBARS_LT_4",
            f"Columna rectangular requiere mínimo 4 barras longitudinales (actual: {n_bars}).",
        ))

    # Estribos: separación en zona de confinamiento
    tie_label = str(tran_r.get("tie_bar_label", "#3"))
    db_tie    = _db_mm(tie_label, default=9.5)
    s_conf    = float(tran_r.get("s_confined_mm", 0))
    s_gen     = float(tran_r.get("s_general_mm", 0))
    n_legs_b  = int(tran_r.get("n_legs_b", 2))
    n_legs_h  = int(tran_r.get("n_legs_h", 2))

    ed_u = ed.upper()
    s_conf_max = min(6.0 * db_long, 150.0) if ed_u == "DES" else min(8.0 * db_long, 200.0)
    if s_conf > s_conf_max + 1e-3:
        warnings.append(_warn(
            "warning", "S_CONF_GT_MAX",
            f"Separación de estribos en zona de confinamiento s = {s_conf:.0f} mm > "
            f"{s_conf_max:.0f} mm (NSR-10 C.21.6.4.3 para {ed_u}: min(k·db_long, {int(s_conf_max)} mm) "
            f"con db_long = #{bar_label[1:] if bar_label.startswith('#') else bar_label}).",
        ))

    # Separación zona general: ≤ 16·db_long y ≤ b (NSR-10 C.7.10.5.2)
    s_gen_max = min(16.0 * db_long, b * 1000)
    if s_gen > s_gen_max + 1e-3:
        warnings.append(_warn(
            "info", "S_GEN_GT_MAX",
            f"Separación general de estribos s = {s_gen:.0f} mm > {s_gen_max:.0f} mm "
            f"(NSR-10 C.7.10.5.2: min(16·db_long, b)).",
        ))

    # db_tie: NSR-10 C.7.10.5.1 → #3 si db_long ≤ #10, #4 si db_long = #11
    if bar_label == "#11" and tie_label == "#3":
        warnings.append(_warn(
            "warning", "DB_TIE_LT_MIN",
            "Para barras longitudinales #11, el estribo debe ser mínimo #4 (NSR-10 C.7.10.5.1).",
        ))

    # Ramas mínimas: 2 por dirección
    if n_legs_b < 2 or n_legs_h < 2:
        warnings.append(_warn(
            "error", "LEGS_LT_2",
            f"El estribo requiere mínimo 2 ramas en cada dirección (actual: b={n_legs_b}, h={n_legs_h}).",
        ))

    return warnings


# ── Vigas ─────────────────────────────────────────────────────────────────────

def validate_beam_reinforcement(
    reinforcement: dict,
    geometry: dict,
    ed: str = "DMO",
) -> list[dict]:
    """
    Reglas aplicadas (NSR-10 C.21.5 — flexión DES / C.10.5 — general):
    - As_min = max(0.25√f'c / fy, 1.4 / fy) · b · d  (C.10.5.1)
    - ρ ≤ 2.5% en vigas de pórticos sismo-resistentes (C.21.5.2.1 DES).
    - Mínimo 2 barras continuas top y bot (C.21.5.2.1 / C.10.5.3).
    - Separación de estribos en zona confinada (DES): ≤ min(d/4, 8·db_long, 24·db_tie, 150mm).
      Para DMO: ≤ d/4, s ≤ 200mm aproximado.
    """
    warnings: list[dict] = []
    zones = reinforcement.get("zones", {})
    shear = reinforcement.get("shear", {})

    b = float(geometry.get("b_m", 0.3))
    h = float(geometry.get("h_m", 0.5))
    d_m = max(h - 0.05, 0.3)                 # peralte efectivo aproximado
    fc = float(geometry.get("fc_MPa", 21.0))
    fy = float(geometry.get("fy_MPa", 420.0))

    As_min = max(
        0.25 * math.sqrt(fc) * b * d_m * 1e4 / fy,
        1.4 * b * d_m * 1e4 / fy,
    )
    As_max = 0.025 * b * d_m * 1e4   # ρ=2.5%

    ed_u = ed.upper()

    for zone_name in ("end_i", "mid", "end_j"):
        z = zones.get(zone_name, {})
        for face in ("top", "bot"):
            fr = z.get(face, {})
            n  = int(fr.get("n_bars", 0))
            lbl = str(fr.get("bar_label", "#5"))
            As = float(fr.get("As_cm2", 0)) or _As_cm2(lbl, n)
            if n < 2:
                warnings.append(_warn(
                    "error", "ZONE_NBARS_LT_2",
                    f"{zone_name}·{face}: mínimo 2 barras continuas (actual: {n}) "
                    "(NSR-10 C.21.5.2.1).",
                ))
            if As < As_min - 0.1:
                warnings.append(_warn(
                    "warning", "ZONE_AS_LT_MIN",
                    f"{zone_name}·{face}: As = {As:.2f} cm² < As_min = {As_min:.2f} cm² "
                    "(NSR-10 C.10.5.1).",
                ))
            if As > As_max + 0.1:
                warnings.append(_warn(
                    "warning", "ZONE_RHO_GT_MAX",
                    f"{zone_name}·{face}: ρ = {As / (b * d_m * 1e4) * 100:.2f}% > 2.5% "
                    "(NSR-10 C.21.5.2.1 vigas DES).",
                ))

    # Diámetro longitudinal representativo = max db en end_i (zona crítica)
    end_i = zones.get("end_i", {})
    db_long = max(
        _db_mm(end_i.get("top", {}).get("bar_label", "#5")),
        _db_mm(end_i.get("bot", {}).get("bar_label", "#5")),
    )

    tie_label = str(shear.get("tie_bar_label", "#3"))
    db_tie    = _db_mm(tie_label, default=9.5)
    s_conf    = float(shear.get("s_confined_mm", 0))
    s_cent    = float(shear.get("s_central_mm", 0))
    n_legs    = int(shear.get("n_legs", 2))

    if n_legs < 2:
        warnings.append(_warn(
            "error", "SHEAR_LEGS_LT_2",
            f"El estribo de la viga requiere mínimo 2 ramas (actual: {n_legs}).",
        ))

    # Separación zona confinada
    if ed_u == "DES":
        s_conf_max = min(d_m * 1000 / 4.0, 8.0 * db_long, 24.0 * db_tie, 150.0)
    else:  # DMO / DMI
        s_conf_max = min(d_m * 1000 / 4.0, 200.0)
    if s_conf > s_conf_max + 1e-3:
        warnings.append(_warn(
            "warning", "S_CONF_GT_MAX",
            f"Separación confinada s = {s_conf:.0f} mm > {s_conf_max:.0f} mm "
            f"(NSR-10 C.21.5.3.2 / C.11.4.5 para {ed_u}).",
        ))

    # Separación zona central
    s_cent_max = d_m * 1000 / 2.0
    if s_cent > s_cent_max + 1e-3:
        warnings.append(_warn(
            "info", "S_CENT_GT_MAX",
            f"Separación central s = {s_cent:.0f} mm > d/2 = {s_cent_max:.0f} mm "
            "(NSR-10 C.11.4.5).",
        ))

    return warnings


def validate_frame_reinforcement(
    element_type: str,
    reinforcement: dict,
    geometry: dict,
    ed: str = "DMO",
) -> dict:
    """
    Punto de entrada unificado para columnas y vigas. Devuelve:
        {
          "warnings": list[{level, code, message}],
          "n_errors":   int,
          "n_warnings": int,
          "n_info":     int,
          "nsr10_ok":   bool,
        }
    """
    et = str(element_type).lower()
    if et == "column":
        ws = validate_column_reinforcement(reinforcement, geometry, ed)
    elif et == "beam":
        ws = validate_beam_reinforcement(reinforcement, geometry, ed)
    else:
        ws = [_warn("error", "UNKNOWN_TYPE", f"element_type desconocido: {element_type!r}")]

    n_err  = sum(1 for w in ws if w["level"] == "error")
    n_warn = sum(1 for w in ws if w["level"] == "warning")
    n_info = sum(1 for w in ws if w["level"] == "info")
    return {
        "warnings":   ws,
        "n_errors":   n_err,
        "n_warnings": n_warn,
        "n_info":     n_info,
        "nsr10_ok":   n_err == 0 and n_warn == 0,
    }
