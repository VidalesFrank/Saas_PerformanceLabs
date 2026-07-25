"""Modulo sismico NSR-10: espectros de diseno y parametros sismicos para Colombia."""

from .nsr10_data import MUNICIPIOS, SOIL_TYPES, buscar_municipios, zona_sismica
from .spectrum import compute_spectrum, get_site_factors, spectral_parameters

__all__ = [
    "MUNICIPIOS",
    "SOIL_TYPES",
    "buscar_municipios",
    "zona_sismica",
    "get_site_factors",
    "spectral_parameters",
    "compute_spectrum",
]
