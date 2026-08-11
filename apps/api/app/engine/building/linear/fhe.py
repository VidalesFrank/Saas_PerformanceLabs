"""
FHEChecker — Módulo 1: Verificación de Fuerza Horizontal Equivalente (NSR-10 A.4.2).

Compara el cortante basal del análisis modal espectral con el cortante mínimo
reglamentario NSR-10 y calcula los factores de escala necesarios.

Criterio NSR-10 A.4.2.2:
  Cs = Sa(T1) × I / R   →   Vb_min = Cs_min × W

  Mínimos:
    Cs_min ≥ 0.044 × SDs × I   (NSR-10 A.4.2.2a)
    Cs_min ≥ 0.01               (NSR-10 A.4.2.2b, mínimo absoluto)
    Si S1 ≥ 0.6g: Cs_min ≥ 0.5×S1×I/R  (zona sísmica alta)
"""
from __future__ import annotations


class FHEChecker:
    """Verifica el cortante basal mínimo NSR-10 y calcula factores de escala."""

    def check(
        self,
        W_kN: float,
        Vb_modal_x_kN: float,
        Vb_modal_y_kN: float,
        spectral_params: dict,
        seismic_params: dict,
    ) -> dict:
        """
        Retorna el reporte FHE con factores de escala.

        Args:
            W_kN:           Peso sísmico total (kN)
            Vb_modal_x_kN:  Cortante basal modal CQC en X (kN)
            Vb_modal_y_kN:  Cortante basal modal CQC en Y (kN)
            spectral_params: {SDs, SD1, T0, Ts, TL, Fa, Fv} del espectro NSR-10
            seismic_params:  dict de SeismicParameters del proyecto
        """
        SDs = float(spectral_params.get("SDs", 0.0))
        SD1 = float(spectral_params.get("SD1", 0.0))   # Sa en T=1s ≈ S1 × Fv
        R   = float(seismic_params.get("R", 5.0))
        I   = float(seismic_params.get("importance_factor", 1.0))
        Aa  = float(seismic_params.get("Aa", 0.15))

        # ── Cs mínimo NSR-10 A.4.2.2 ─────────────────────────────────────────
        Cs_min = max(
            0.044 * SDs * I,    # A.4.2.2a
            0.01,               # A.4.2.2b (mínimo absoluto)
        )

        # Para zona sísmica alta (Aa ≥ 0.5g, equivalente S1 ≥ 0.6g aprox.)
        S1_approx = SD1 / float(spectral_params.get("Fv", 1.5))
        if S1_approx >= 0.6:
            Cs_min_alta = 0.5 * S1_approx * I / R
            Cs_min = max(Cs_min, Cs_min_alta)

        # ── Cortantes mínimos ─────────────────────────────────────────────────
        Vb_min_kN = Cs_min * W_kN

        # NSR-10 aplica la misma verificación en ambas direcciones horizontales
        Vb_min_x_kN = Vb_min_kN
        Vb_min_y_kN = Vb_min_kN

        # ── Factores de escala ────────────────────────────────────────────────
        scale_x = Vb_min_x_kN / Vb_modal_x_kN if Vb_modal_x_kN > 1e-6 else 1.0
        scale_y = Vb_min_y_kN / Vb_modal_y_kN if Vb_modal_y_kN > 1e-6 else 1.0

        # Solo se escala si el modal está por debajo del mínimo (escala > 1)
        scaled_x = scale_x > 1.0
        scaled_y = scale_y > 1.0
        scale_x  = scale_x if scaled_x else 1.0
        scale_y  = scale_y if scaled_y else 1.0

        Vb_final_x_kN = Vb_modal_x_kN * scale_x
        Vb_final_y_kN = Vb_modal_y_kN * scale_y

        # Cs efectivo usado (el mayor de ambas direcciones)
        Cs_used_x = Vb_final_x_kN / W_kN if W_kN > 1e-6 else 0.0
        Cs_used_y = Vb_final_y_kN / W_kN if W_kN > 1e-6 else 0.0
        Cs_used   = max(Cs_used_x, Cs_used_y)

        return {
            "W_kN":            round(W_kN, 1),
            "Cs_min":          round(Cs_min, 5),
            "Cs_used":         round(Cs_used, 5),
            "Vb_modal_x_kN":   round(Vb_modal_x_kN, 1),
            "Vb_modal_y_kN":   round(Vb_modal_y_kN, 1),
            "Vb_min_x_kN":     round(Vb_min_x_kN, 1),
            "Vb_min_y_kN":     round(Vb_min_y_kN, 1),
            "scale_x":         round(scale_x, 4),
            "scale_y":         round(scale_y, 4),
            "scaled_x":        scaled_x,
            "scaled_y":        scaled_y,
            "Vb_final_x_kN":   round(Vb_final_x_kN, 1),
            "Vb_final_y_kN":   round(Vb_final_y_kN, 1),
        }
