"""
MasonryMaterialDef — Material de mampostería para infills.

Relaciones Em vs fm por tipo de ladrillo:
  - "VP" (perforación vertical, ladrillo hueco vertical): Em = 775 · fm
    Fuente: Guerrero, H. et al. (2022). "Experimental characterisation of
    Mexican confined masonry walls with vertically hollow bricks."
  - "HP" (perforación horizontal, ladrillo hueco horizontal): Em = 622 · fm
    Fuente: Borah, B. et al. (2021). "Assessment of stress-strain behaviour
    of masonry with horizontally perforated bricks under uniaxial compression."
  - "custom": el usuario provee Em explícitamente (útil para parámetros de
    NSR-10 D.5.4 o resultados de laboratorio propios).

Modelo constitutivo: Concrete01 (uniaxial) en OpenSees.
Unidades del engine caller: MPa (se convierten a kPa al crear el material
en el builder, para consistencia con el resto del NLWallOPSBuilder que
opera en m/kN/kPa).
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class MasonryMaterialDef:
    """
    Definición inmutable de un material de mampostería.

    Attributes:
        name: Identificador legible (ej. "Mamp_5MPa_VP").
        fm_mpa: Resistencia a compresión de la mampostería (MPa).
        brick_type: "VP" | "HP" | "custom".
        Em_mpa: Módulo de elasticidad (MPa). Si es None y brick_type ∈ {VP,HP}
                se calcula automáticamente. Obligatorio si brick_type == "custom".
    """
    name: str
    fm_mpa: float
    brick_type: str = "VP"
    Em_mpa: float | None = None

    def resolved_Em_mpa(self) -> float:
        """Retorna Em resuelto (calculado si no está explícito)."""
        if self.Em_mpa is not None and self.Em_mpa > 0:
            return float(self.Em_mpa)
        bt = (self.brick_type or "VP").upper()
        if bt == "VP":
            return 775.0 * float(self.fm_mpa)
        if bt == "HP":
            return 622.0 * float(self.fm_mpa)
        raise ValueError(
            f"brick_type={self.brick_type!r} requiere Em_mpa explícito"
        )

    @property
    def cache_key(self) -> str:
        Em = self.resolved_Em_mpa()
        return f"MASONRY|{self.name}|{self.fm_mpa}|{self.brick_type}|{Em}"


def masonry_concrete01_params(
    m: MasonryMaterialDef,
) -> tuple[float, float, float, float]:
    """
    Calcula los 4 parámetros de Concrete01 para un material de mampostería.

    Retorna (fpc_mpa, epsc0, fpcu_mpa, epsU), todos con SIGNO NEGATIVO
    (convención OpenSees: compresión negativa).

    Curva:
      - Rama ascendente hasta (fm, e0) donde e0 = 2·fm/Em (Kent-Park simplificado).
      - Rama descendente hasta (fmu, emu) donde fmu = 0.01·fm y emu = 2·e0.

    El puntal es solo-compresión (Concrete01 no tiene resistencia a tracción),
    lo cual es correcto para el modelo de puntal equivalente.
    """
    fm = float(m.fm_mpa)
    Em = m.resolved_Em_mpa()
    if fm <= 0 or Em <= 0:
        raise ValueError(f"fm y Em deben ser positivos (fm={fm}, Em={Em})")
    e0  = 2.0 * fm / Em          # deformación al pico
    fmu = 0.01 * fm              # resistencia residual (1% del pico)
    emu = 2.0 * e0               # deformación última
    return (-fm, -e0, -fmu, -emu)
