"""Tests del ajuste de capacidad por dano observado (FEMA P-2018 Seccion 3.5)."""

import pytest

from engine.field_assessment import DamageLevel
from engine.field_assessment.fema_p2018 import DEFAULT_DAMAGE_LAMBDA, damage_factor


def test_default_lambdas_match_agreed_seeds():
    """Los factores por defecto acordados: 1.0/0.9/0.8/0.6/0.3/0.0 para D0..D5."""
    expected = {
        DamageLevel.D0: 1.0,
        DamageLevel.D1: 0.9,
        DamageLevel.D2: 0.8,
        DamageLevel.D3: 0.6,
        DamageLevel.D4: 0.3,
        DamageLevel.D5: 0.0,
    }
    assert DEFAULT_DAMAGE_LAMBDA == expected


def test_damage_factor_monotonic():
    """Mas dano -> menor capacidad remanente."""
    lambdas = [damage_factor(lvl) for lvl in DamageLevel]
    for i in range(1, len(lambdas)):
        assert lambdas[i] <= lambdas[i - 1]


def test_d5_zeros_capacity():
    """D5 = colapso -> capacidad nula."""
    assert damage_factor(DamageLevel.D5) == 0.0


def test_d0_preserves_capacity():
    """D0 = sin dano -> capacidad intacta."""
    assert damage_factor(DamageLevel.D0) == 1.0


def test_custom_table_override():
    """El usuario puede pasar su propio dict de factores."""
    custom = {
        DamageLevel.D0: 1.0,
        DamageLevel.D1: 0.95,
        DamageLevel.D2: 0.85,
        DamageLevel.D3: 0.7,
        DamageLevel.D4: 0.4,
        DamageLevel.D5: 0.1,
    }
    assert damage_factor(DamageLevel.D3, custom) == 0.7
    assert damage_factor(DamageLevel.D5, custom) == 0.1


def test_missing_key_raises():
    """Un nivel no presente en la tabla custom debe explotar limpiamente."""
    partial = {DamageLevel.D0: 1.0}
    with pytest.raises(ValueError, match="factor definido"):
        damage_factor(DamageLevel.D3, partial)
