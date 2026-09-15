"""Ajuste de la capacidad de deriva por dano observado (FEMA P-2018, Seccion 3.5).

Cuando un componente presenta dano, su capacidad remanente de deriva antes
de la falla se reduce. El factor lambda_dano multiplica a delta_C_base
para dar delta_C_ajustada:

    delta_C = delta_C_base * lambda_dano(nivel_dano)

Los valores por defecto son la semilla acordada; se pueden sobreescribir
pasando otro dict a `damage_factor`.
"""

from __future__ import annotations

from ..schemas import DamageLevel


DEFAULT_DAMAGE_LAMBDA: dict[DamageLevel, float] = {
    DamageLevel.D0: 1.0,
    DamageLevel.D1: 0.9,
    DamageLevel.D2: 0.8,
    DamageLevel.D3: 0.6,
    DamageLevel.D4: 0.3,
    DamageLevel.D5: 0.0,  # colapso: capacidad nula
}


def damage_factor(
    level: DamageLevel,
    table: dict[DamageLevel, float] | None = None,
) -> float:
    """Devuelve lambda_dano segun el nivel EMS-98/HAZUS."""
    t = table or DEFAULT_DAMAGE_LAMBDA
    try:
        return t[level]
    except KeyError as exc:
        raise ValueError(f"Nivel de dano '{level}' no tiene factor definido.") from exc
