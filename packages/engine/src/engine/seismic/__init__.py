"""Modulo sismico NSR-10: espectros de diseno y parametros sismicos para Colombia."""

from .nsr10_data import MUNICIPIOS, MICROZONIFICACION, SOIL_TYPES, buscar_municipios, get_microzonificacion, zona_sismica
from .spectrum import compute_spectrum, compute_spectrum_from_params, get_site_factors, spectral_parameters

__all__ = [
    "MUNICIPIOS",
    "MICROZONIFICACION",
    "SOIL_TYPES",
    "buscar_municipios",
    "get_microzonificacion",
    "zona_sismica",
    "get_site_factors",
    "spectral_parameters",
    "compute_spectrum",
    "compute_spectrum_from_params",
]
