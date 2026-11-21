"""Modelo de acero estructural (perfiles AISC / NSR-10 F.2).

A diferencia de `steel.py` (acero de refuerzo para RC, Steel02 Menegotto-Pinto),
este modulo representa el acero de los perfiles laminados o tubulares: W, HSS,
Pipe, L, C, etc. Parametros listos para `uniaxialMaterial('Steel02', ...)` o
`uniaxialMaterial('Steel4', ...)` segun el nivel de refinamiento deseado.

Unidades: N, mm, MPa.

Referencias:
    - AISC 360-16 Tabla 2.4-1 "Available ASTM Material Standards for Hot-Rolled
      Structural Shapes and Plates"
    - NSR-10 F.2.2 "Aceros estructurales"
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class StructuralSteelParams:
    """Parametros de acero estructural para OpenSees Steel02.

    Attributes:
        grade:          etiqueta de la especificacion (p.ej. "A992", "A572Gr50").
        fy:             esfuerzo minimo de fluencia especificado [MPa].
        fu:             esfuerzo minimo de tension especificado [MPa].
        E0:             modulo de elasticidad [MPa]. Por convencion 200 000 MPa.
        G:              modulo de cortante [MPa]. Por convencion 77 000 MPa.
        b:              relacion de endurecimiento por deformacion (Steel02).
        eps_rupture:    deformacion unitaria de rotura (criterio de falla por fibra).
        poisson:        relacion de Poisson (0.3 por convencion).
        R0, cR1, cR2:   parametros de transicion elastico-plastico de Menegotto-Pinto.
    """

    grade: str
    fy: float
    fu: float
    E0: float = 200_000.0
    G: float = 77_000.0
    b: float = 0.003
    eps_rupture: float = 0.20
    poisson: float = 0.30
    R0: float = 20.0
    cR1: float = 0.925
    cR2: float = 0.15

    @property
    def eps_y(self) -> float:
        """Deformacion unitaria de fluencia nominal."""
        return self.fy / self.E0


# ─────────────────────────────────────────────────────────────────────────────
# Grados comunes (valores nominales ASTM / AISC Tabla 2.4-1)
# ─────────────────────────────────────────────────────────────────────────────

def steel_a36() -> StructuralSteelParams:
    """ASTM A36 — acero estructural generico. fy=250 MPa, fu=400 MPa."""
    return StructuralSteelParams(grade="A36", fy=250.0, fu=400.0)


def steel_a572_gr50() -> StructuralSteelParams:
    """ASTM A572 Gr.50 — perfiles laminados HSLA. fy=345 MPa, fu=450 MPa."""
    return StructuralSteelParams(grade="A572Gr50", fy=345.0, fu=450.0)


def steel_a992() -> StructuralSteelParams:
    """ASTM A992 — acero preferido para W-shapes AISC. fy=345 MPa, fu=450 MPa."""
    return StructuralSteelParams(grade="A992", fy=345.0, fu=450.0)


def steel_a500_gr_b_round() -> StructuralSteelParams:
    """ASTM A500 Gr.B round HSS — fy=290 MPa, fu=400 MPa."""
    return StructuralSteelParams(grade="A500GrB-Round", fy=290.0, fu=400.0)


def steel_a500_gr_c_rect() -> StructuralSteelParams:
    """ASTM A500 Gr.C rectangular HSS — fy=345 MPa, fu=427 MPa."""
    return StructuralSteelParams(grade="A500GrC-Rect", fy=345.0, fu=427.0)


def steel_a913_gr65() -> StructuralSteelParams:
    """ASTM A913 Gr.65 — perfiles pesados (jumbo). fy=448 MPa, fu=552 MPa."""
    return StructuralSteelParams(grade="A913Gr65", fy=448.0, fu=552.0)


GRADE_PRESETS: dict[str, StructuralSteelParams] = {
    "A36":             steel_a36(),
    "A572Gr50":        steel_a572_gr50(),
    "A992":            steel_a992(),
    "A500GrB-Round":   steel_a500_gr_b_round(),
    "A500GrC-Rect":    steel_a500_gr_c_rect(),
    "A913Gr65":        steel_a913_gr65(),
}


def get_grade(grade: str) -> StructuralSteelParams:
    """Lookup por etiqueta; eleva KeyError si el grado no esta registrado."""
    if grade not in GRADE_PRESETS:
        raise KeyError(
            f"Grado de acero '{grade}' no registrado. Opciones: {sorted(GRADE_PRESETS)}"
        )
    return GRADE_PRESETS[grade]
