"""Conversiones de unidades centralizadas para la API de PerformanceLabs.

Unidades internas del motor: N, mm, MPa.
Unidades de la API (usuario): kN, kN·m, 1/m.
"""


class UnitConverter:
    # ── Fuerza ────────────────────────────────────────────────────────────────
    @staticmethod
    def kn_to_n(kn: float) -> float:
        return kn * 1_000.0

    @staticmethod
    def n_to_kn(n: float) -> float:
        return n / 1_000.0

    # ── Momento ───────────────────────────────────────────────────────────────
    @staticmethod
    def knm_to_nmm(knm: float) -> float:
        return knm * 1_000_000.0

    @staticmethod
    def nmm_to_knm(nmm: float) -> float:
        return nmm / 1_000_000.0

    # ── Curvatura ─────────────────────────────────────────────────────────────
    @staticmethod
    def phi_mm_to_m(phi_per_mm: float) -> float:
        """1/mm → 1/m"""
        return phi_per_mm * 1_000.0

    @staticmethod
    def phi_m_to_mm(phi_per_m: float) -> float:
        """1/m → 1/mm"""
        return phi_per_m / 1_000.0

    # ── Rigidez ───────────────────────────────────────────────────────────────
    @staticmethod
    def nmm2_to_knm2(nmm2: float) -> float:
        """N·mm² → kN·m²"""
        return nmm2 / 1_000_000_000.0
