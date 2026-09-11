"""
SpectralAnalyzer — Módulo 1: Análisis Espectral RSA (CQC / SRSS).

Dado el modelo canónico, los resultados modales y los parámetros sísmicos NSR-10,
calcula fuerzas sísmicas de diseño, cortantes y derivas por piso.

Unidades de trabajo: kN, m, s, t (toneladas métricas = kN·s²/m)

Algoritmo:
  1. Interpolar Sa(T_i) en el espectro de diseño NSR-10/R.
  2. Calcular cortante modal por dirección con la masa efectiva participante.
  3. Distribuir fuerzas por piso usando las formas modales en los nodos CM.
  4. Combinar modos con CQC o SRSS.
  5. Calcular cortantes y desplazamientos por piso; derivar derivas.
"""
from __future__ import annotations

import math

import numpy as np

# Tag base para nodos CM (debe coincidir con ops_builder.py)
_CM_OFFSET = 10_000_000


# ── Interpolación de espectro ─────────────────────────────────────────────────

def _sa_at_period(T: float, puntos: list[dict]) -> float:
    """Interpola Sa (en g) del espectro NSR-10 en el período T."""
    Ts = [p["T"] for p in puntos]
    Sas = [p["Sa"] for p in puntos]
    return float(np.interp(T, Ts, Sas))


# ── Coeficiente de correlación CQC ───────────────────────────────────────────

def _rho_cqc(Ti: float, Tj: float, xi: float) -> float:
    """Coeficiente de correlación modal CQC (Wilson, Der Kiureghian, Bayo 1981)."""
    if Ti <= 0 or Tj <= 0:
        return 1.0 if Ti == Tj else 0.0
    beta = min(Ti, Tj) / max(Ti, Tj)   # ≤ 1
    xi2 = xi ** 2
    num = 8.0 * xi2 * (1.0 + beta) * beta ** 1.5
    den = (1.0 - beta**2)**2 + 4.0 * xi2 * beta * (1.0 + beta)**2
    return num / den if den > 1e-12 else 1.0


def _cqc_combine(values: np.ndarray, periods: list[float], xi: float) -> np.ndarray:
    """
    CQC de un array de respuestas modales.
    values[j, i] = respuesta en el piso j para el modo i.
    Retorna array[j] con la respuesta CQC combinada.
    """
    n_stories, n_modes = values.shape
    result = np.zeros(n_stories)
    for i in range(n_modes):
        for k in range(n_modes):
            rho = _rho_cqc(periods[i], periods[k], xi)
            result += rho * values[:, i] * values[:, k]
    return np.sqrt(np.maximum(result, 0.0))


def _srss_combine(values: np.ndarray) -> np.ndarray:
    """SRSS de respuestas modales. values[j, i] → result[j]."""
    return np.sqrt(np.sum(values**2, axis=1))


# ── Análisis principal ────────────────────────────────────────────────────────

class SpectralAnalyzer:
    """
    Análisis espectral RSA para edificios 3D con diafragma rígido.

    Parámetros (params dict):
        Aa, Av         : aceleraciones NSR-10 (g)
        soil_type      : A/B/C/D/E
        R              : factor de reducción
        importance_factor (I) : factor de importancia
        damping_ratio  : amortiguamiento (default 0.05)
        combination_method : "CQC" | "SRSS"
    """

    def __init__(self, model: dict, modal_results: dict, params: dict):
        self._model  = model
        self._modal  = modal_results
        self._params = params

    def analyze(self) -> dict:
        from engine.seismic.spectrum import compute_spectrum

        params = self._params
        Aa          = float(params.get("Aa", 0.15))
        Av          = float(params.get("Av", 0.15))
        soil_type   = str(params.get("soil_type", "D"))
        R           = float(params.get("R", 5.0))
        I           = float(params.get("importance_factor", 1.0))
        xi          = float(params.get("damping_ratio", 0.05))
        method      = str(params.get("combination_method", "CQC")).upper()

        # ── 1. Espectro elástico NSR-10 ──────────────────────────────────────
        spec_data = compute_spectrum(Aa, Av, soil_type, T_max=4.0, n_points=300)
        puntos     = spec_data["puntos"]
        sp         = spec_data["params"]   # SDs, SD1, T0, Ts, TL, Fa, Fv

        # ── 2. Datos modales ─────────────────────────────────────────────────
        modes_table  = self._modal.get("modes_table", [])
        mode_shapes  = self._modal.get("viewer", {}).get("mode_shapes", {})
        n_modes_avail = len(modes_table)

        if n_modes_avail == 0:
            raise ValueError("No hay resultados modales disponibles.")

        # ── 3. Datos del modelo canónico ──────────────────────────────────────
        masses_dict = self._model.get("masses", {})
        stories_dict = self._model.get("stories", {})

        # Construir lista de pisos ordenados por elevación (base → techo)
        stories_sorted = sorted(
            stories_dict.items(),
            key=lambda kv: kv[1].get("elevation_m", 0.0)
        )

        # Mapeo story_name → masa y tag CM
        story_masses: dict[str, dict] = {}
        for idx, (mass_key, md) in enumerate(masses_dict.items()):
            sname = str(md.get("story", mass_key))
            story_masses[sname] = {
                "mass_x": float(md.get("mass_x_t", 0.0)),
                "mass_y": float(md.get("mass_y_t", 0.0)),
                "cm_tag": str(_CM_OFFSET + idx + 1),  # coincide con ops_builder.py
                "z":      float(md.get("z_m", 0.0)),
            }

        # Pisos en orden (bottom → top)
        ordered_stories = [name for name, _ in stories_sorted if name in story_masses]

        if not ordered_stories:
            raise ValueError("No se encontraron pisos con masa asignada en el modelo.")

        n_stories = len(ordered_stories)
        M_slab    = sum(story_masses[s]["mass_x"] for s in ordered_stories)   # tonnes (solo losas)

        # Masa de muros: auto-peso muros (γ=24 kN/m³) que OpenSees incluye en nodos CM
        # pero que e2k_parser NO incluye en la tabla MASS SUMMARY (solo losas/floor).
        # Se calcula igual que LinearOPSBuilder._wall_mass_per_cm_story().
        GAMMA_kN_m3 = 24.0
        G_m_s2      = 9.81
        shells_dict = self._model.get("shells", {})
        joints_dict = self._model.get("joints", {})
        M_walls = 0.0
        for sd_w in shells_dict.values():
            if sd_w.get("element_type") != "wall":
                continue
            jl = sd_w.get("joints", [])
            if len(jl) != 4:
                continue
            t   = float(sd_w.get("thickness_m", 0.0))
            zb  = float(joints_dict.get(jl[0], {}).get("z", 0.0))
            zt  = float(joints_dict.get(jl[3], {}).get("z", 0.0))
            hwall = abs(zt - zb)
            if hwall < 1e-6:
                continue
            xb0 = float(joints_dict.get(jl[0], {}).get("x", 0.0))
            yb0 = float(joints_dict.get(jl[0], {}).get("y", 0.0))
            xb1 = float(joints_dict.get(jl[1], {}).get("x", 0.0))
            yb1 = float(joints_dict.get(jl[1], {}).get("y", 0.0))
            width = math.sqrt((xb1 - xb0)**2 + (yb1 - yb0)**2)
            if width < 1e-6:
                continue
            M_walls += t * width * hwall * GAMMA_kN_m3 / G_m_s2   # tonnes

        M_total = M_slab + M_walls
        W_total = M_total * G_m_s2  # kN

        print(f"[spectral] M_slab={M_slab:.2f}t  M_walls={M_walls:.2f}t  W_total={W_total:.1f}kN")

        # ── 4. Formas modales en nodos CM ──────────────────────────────────────
        # shape_x[j, i] = componente X de la forma modal del modo i en el piso j
        shape_x = np.zeros((n_stories, n_modes_avail))
        shape_y = np.zeros((n_stories, n_modes_avail))

        for i, row in enumerate(modes_table):
            mode_str = str(row["mode"])
            mode_data = mode_shapes.get(mode_str, {})
            for j, sname in enumerate(ordered_stories):
                sm = story_masses[sname]
                ev = mode_data.get(sm["cm_tag"], [0.0, 0.0, 0.0])
                shape_x[j, i] = float(ev[0]) if len(ev) > 0 else 0.0
                shape_y[j, i] = float(ev[1]) if len(ev) > 1 else 0.0

        # ── 5. Cortantes modales — dos espectros separados ────────────────────
        # NSR-10 A.6.2: fuerzas de diseño (reducidas por R) y derivas (elásticas) son
        # cálculos distintos. Las derivas se verifican con la fuerza sísmica completa
        # (espectro elástico, sin reducir por R) sin factor Cd adicional (A.6.2.1).
        periods = [row["T"] for row in modes_table]

        Vb_modal_x        = np.zeros(n_modes_avail)   # diseño: Sa × I/R
        Vb_modal_y        = np.zeros(n_modes_avail)
        Vb_modal_x_elastic = np.zeros(n_modes_avail)  # deriva: Sa elástico completo
        Vb_modal_y_elastic = np.zeros(n_modes_avail)

        for i, row in enumerate(modes_table):
            Ti = periods[i]
            Sa_el = _sa_at_period(Ti, puntos)          # espectro elástico [g]
            Sa_ds = Sa_el * I / R                       # espectro de diseño

            ux_pct = row.get("Ux_pct", 0.0) / 100.0
            uy_pct = row.get("Uy_pct", 0.0) / 100.0

            Vb_modal_x[i]         = ux_pct * W_total * Sa_ds
            Vb_modal_y[i]         = uy_pct * W_total * Sa_ds
            Vb_modal_x_elastic[i] = ux_pct * W_total * Sa_el
            Vb_modal_y_elastic[i] = uy_pct * W_total * Sa_el

        print(f"[spectral] T1x={periods[0]:.4f}s  Ux1={modes_table[0].get('Ux_pct',0):.1f}%  "
              f"Vb1x_diseno={Vb_modal_x[0]:.1f}kN  Vb1x_deriva={Vb_modal_x_elastic[0]:.1f}kN")

        # ── 6. Fuerzas por piso y modo ─────────────────────────────────────────
        masses_x = np.array([story_masses[s]["mass_x"] for s in ordered_stories])
        masses_y = np.array([story_masses[s]["mass_y"] for s in ordered_stories])

        # Fuerza de diseño (para dimensionamiento de secciones y cortantes NSR-10)
        force_x = np.zeros((n_stories, n_modes_avail))
        force_y = np.zeros((n_stories, n_modes_avail))

        # Fuerza elástica (para cálculo de derivas NSR-10 A.6.2.1)
        force_x_el = np.zeros((n_stories, n_modes_avail))
        force_y_el = np.zeros((n_stories, n_modes_avail))

        for i in range(n_modes_avail):
            wx = masses_x * shape_x[:, i]
            wy = masses_y * shape_y[:, i]
            Lx = np.sum(wx)
            Ly = np.sum(wy)
            if abs(Lx) > 1e-9:
                force_x[:, i]    = Vb_modal_x[i]         * wx / Lx
                force_x_el[:, i] = Vb_modal_x_elastic[i] * wx / Lx
            if abs(Ly) > 1e-9:
                force_y[:, i]    = Vb_modal_y[i]         * wy / Ly
                force_y_el[:, i] = Vb_modal_y_elastic[i] * wy / Ly

        # ── 7. Combinación modal ───────────────────────────────────────────────
        if method == "CQC":
            fx_combined = _cqc_combine(force_x, periods, xi)
            fy_combined = _cqc_combine(force_y, periods, xi)

            Vb_cqc_x = math.sqrt(sum(
                _rho_cqc(periods[i], periods[k], xi) * Vb_modal_x[i] * Vb_modal_x[k]
                for i in range(n_modes_avail) for k in range(n_modes_avail)
            ))
            Vb_cqc_y = math.sqrt(sum(
                _rho_cqc(periods[i], periods[k], xi) * Vb_modal_y[i] * Vb_modal_y[k]
                for i in range(n_modes_avail) for k in range(n_modes_avail)
            ))
        else:
            fx_combined = _srss_combine(force_x)
            fy_combined = _srss_combine(force_y)
            Vb_cqc_x = float(np.sqrt(np.sum(Vb_modal_x**2)))
            Vb_cqc_y = float(np.sqrt(np.sum(Vb_modal_y**2)))

        # ── 8. Cortantes de piso (acumulados de techo a base) ─────────────────
        shear_x_modal = np.zeros((n_stories, n_modes_avail))
        shear_y_modal = np.zeros((n_stories, n_modes_avail))
        for j in range(n_stories - 1, -1, -1):
            if j == n_stories - 1:
                shear_x_modal[j, :] = force_x[j, :]
                shear_y_modal[j, :] = force_y[j, :]
            else:
                shear_x_modal[j, :] = shear_x_modal[j + 1, :] + force_x[j, :]
                shear_y_modal[j, :] = shear_y_modal[j + 1, :] + force_y[j, :]

        if method == "CQC":
            shear_x = _cqc_combine(shear_x_modal, periods, xi)
            shear_y = _cqc_combine(shear_y_modal, periods, xi)
        else:
            shear_x = _srss_combine(shear_x_modal)
            shear_y = _srss_combine(shear_y_modal)

        # ── 9. Desplazamientos elásticos para derivas (NSR-10 A.6.2.1) ────────
        # δ_e = F_elástica × T²/(4π² × m)  [m]
        # Derivas = Δδ_e / h  (sin factor Cd; se usa el espectro elástico completo)
        disp_x_el_modal = np.zeros((n_stories, n_modes_avail))
        disp_y_el_modal = np.zeros((n_stories, n_modes_avail))

        for i in range(n_modes_avail):
            Ti = periods[i]
            Ti2_4pi2 = Ti**2 / (4.0 * math.pi**2)
            for j in range(n_stories):
                mx = story_masses[ordered_stories[j]]["mass_x"]
                my = story_masses[ordered_stories[j]]["mass_y"]
                if mx > 1e-9:
                    disp_x_el_modal[j, i] = force_x_el[j, i] * Ti2_4pi2 / mx
                if my > 1e-9:
                    disp_y_el_modal[j, i] = force_y_el[j, i] * Ti2_4pi2 / my

        if method == "CQC":
            disp_x = _cqc_combine(disp_x_el_modal, periods, xi)
            disp_y = _cqc_combine(disp_y_el_modal, periods, xi)
        else:
            disp_x = _srss_combine(disp_x_el_modal)
            disp_y = _srss_combine(disp_y_el_modal)

        # ── 10. Derivas de entrepiso NSR-10 A.6.2.1 ───────────────────────────
        # Δ_i = (δ_e_i - δ_e_{i-1}) / h_i  [adimensional]
        # Límite NSR-10 Tabla A.6.4-1: 1% para muros RC, 2% para pórticos
        story_drifts = []
        for j, sname in enumerate(ordered_stories):
            h_j    = float(stories_dict[sname].get("height_m", 0.0))
            u_j_x  = float(disp_x[j])
            u_j_y  = float(disp_y[j])
            u_prev_x = float(disp_x[j - 1]) if j > 0 else 0.0
            u_prev_y = float(disp_y[j - 1]) if j > 0 else 0.0
            delta_x = (u_j_x - u_prev_x) / h_j if h_j > 1e-6 else 0.0
            delta_y = (u_j_y - u_prev_y) / h_j if h_j > 1e-6 else 0.0
            story_drifts.append({
                "story":       sname,
                "height_m":   round(h_j, 3),
                "drift_x_pct": round(delta_x * 100, 4),
                "drift_y_pct": round(delta_y * 100, 4),
                "disp_x_m":   round(u_j_x, 5),
                "disp_y_m":   round(u_j_y, 5),
            })

        # ── 10. Masa participante acumulada ───────────────────────────────────
        mass_part_x = float(modes_table[-1].get("Ux_cum", 0.0)) if modes_table else 0.0
        mass_part_y = float(modes_table[-1].get("Uy_cum", 0.0)) if modes_table else 0.0

        # ── 11. Empaquetar resultado ──────────────────────────────────────────
        spectrum_curve = {
            "T":  [p["T"]  for p in puntos],
            "Sa": [p["Sa"] for p in puntos],
            "Sd": [p["Sd"] for p in puntos],
            "Sv": [p["Sv"] for p in puntos],
        }

        spectral_params = {
            "SDs": sp["SDs"], "SD1": sp["SD1"],
            "T0": sp["T0"],   "Ts": sp["Ts"],   "TL": sp["TL"],
            "Fa": sp["Fa"],   "Fv": sp["Fv"],
        }

        story_forces_x = {
            sname: round(float(fx_combined[j]), 2)
            for j, sname in enumerate(ordered_stories)
        }
        story_forces_y = {
            sname: round(float(fy_combined[j]), 2)
            for j, sname in enumerate(ordered_stories)
        }
        story_shears_x = {
            sname: round(float(shear_x[j]), 2)
            for j, sname in enumerate(ordered_stories)
        }
        story_shears_y = {
            sname: round(float(shear_y[j]), 2)
            for j, sname in enumerate(ordered_stories)
        }

        return {
            "spectrum":           spectrum_curve,
            "spectral_params":    spectral_params,
            "story_drifts":       story_drifts,
            "story_forces_x":     story_forces_x,
            "story_forces_y":     story_forces_y,
            "story_shears_x":     story_shears_x,
            "story_shears_y":     story_shears_y,
            "combination_method": method,
            "n_modes_used":       n_modes_avail,
            "mass_participation_x": round(mass_part_x, 2),
            "mass_participation_y": round(mass_part_y, 2),
            # Extras para FHE
            "_W_kN":          round(W_total, 2),
            "_Vb_modal_x_kN": round(Vb_cqc_x, 2),
            "_Vb_modal_y_kN": round(Vb_cqc_y, 2),
            "_spectral_params": spectral_params,
        }
