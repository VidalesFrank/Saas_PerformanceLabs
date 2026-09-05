"""Conversiones de unidades para registros sísmicos.

Unidad interna de trabajo: m/s² (SI).
Todos los valores de aceleración se convierten a m/s² antes de cualquier análisis.
Los datos originales se conservan siempre en raw_values.
"""

from __future__ import annotations

import numpy as np

# ── Factores de conversión a m/s² ────────────────────────────────────────────

G_STD = 9.80665  # m/s² — aceleración estándar de la gravedad (ISO 80000-3)

# Unidades de aceleración soportadas → factor multiplicador para obtener m/s²
ACC_TO_MS2: dict[str, float] = {
    "g":      G_STD,       # 1 g = 9.80665 m/s²
    "m/s2":   1.0,         # ya es SI
    "m/s²":   1.0,
    "cm/s2":  0.01,        # 1 cm/s² = 0.01 m/s²
    "cm/s²":  0.01,
    "gal":    0.01,        # 1 Gal = 1 cm/s² = 0.01 m/s²
    "Gal":    0.01,
    "mm/s2":  0.001,
    "mm/s²":  0.001,
    "in/s2":  0.0254,      # 1 in/s² = 0.0254 m/s²
    "in/s²":  0.0254,
}

# Unidades de velocidad → m/s
VEL_TO_MS: dict[str, float] = {
    "m/s":   1.0,
    "cm/s":  0.01,
    "mm/s":  0.001,
    "in/s":  0.0254,
}

# Unidades de desplazamiento → m
DISP_TO_M: dict[str, float] = {
    "m":    1.0,
    "cm":   0.01,
    "mm":   0.001,
    "in":   0.0254,
    "ft":   0.3048,
}

# Unidades de tiempo → s
TIME_TO_S: dict[str, float] = {
    "s":   1.0,
    "ms":  1e-3,
    "us":  1e-6,
    "min": 60.0,
}

# Labels amigables para mostrar en la UI
ACC_LABELS: dict[str, str] = {
    "g":      "g",
    "m/s2":   "m/s²",
    "m/s²":   "m/s²",
    "cm/s2":  "cm/s²",
    "cm/s²":  "cm/s²",
    "gal":    "Gal",
    "Gal":    "Gal",
    "mm/s2":  "mm/s²",
    "mm/s²":  "mm/s²",
    "in/s2":  "in/s²",
    "in/s²":  "in/s²",
}

# ── Funciones de conversión ───────────────────────────────────────────────────

def acc_to_ms2(values: np.ndarray, unit: str) -> np.ndarray:
    """Convierte aceleración desde la unidad especificada a m/s²."""
    key = unit.strip()
    factor = ACC_TO_MS2.get(key)
    if factor is None:
        # Buscar sin distinción de mayúsculas/minúsculas
        key_lower = key.lower()
        for k, v in ACC_TO_MS2.items():
            if k.lower() == key_lower:
                factor = v
                break
    if factor is None:
        raise ValueError(
            f"Unidad de aceleración no reconocida: '{unit}'. "
            f"Opciones: {list(ACC_TO_MS2.keys())}"
        )
    return values * factor


def acc_from_ms2(values_ms2: np.ndarray, unit: str) -> np.ndarray:
    """Convierte de m/s² a la unidad especificada (para visualización)."""
    key = unit.strip()
    factor = ACC_TO_MS2.get(key)
    if factor is None:
        key_lower = key.lower()
        for k, v in ACC_TO_MS2.items():
            if k.lower() == key_lower:
                factor = v
                break
    if factor is None:
        raise ValueError(f"Unidad de aceleración no reconocida: '{unit}'.")
    return values_ms2 / factor


def normalize_acc_unit(unit: str) -> str:
    """Retorna la clave canónica de la unidad de aceleración."""
    unit_map = {
        "g": "g",
        "m/s2": "m/s²", "m/s²": "m/s²",
        "cm/s2": "cm/s²", "cm/s²": "cm/s²",
        "gal": "Gal", "Gal": "Gal",
        "mm/s2": "mm/s²", "mm/s²": "mm/s²",
    }
    return unit_map.get(unit.strip(), unit.strip())


def pga_in_unit(pga_ms2: float, unit: str) -> float:
    """Retorna el PGA en la unidad solicitada dado el PGA en m/s²."""
    return float(acc_from_ms2(np.array([pga_ms2]), unit)[0])
