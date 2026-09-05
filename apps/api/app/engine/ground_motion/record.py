"""Estructura de datos interna para registros de movimiento del suelo.

GroundMotionRecord es el objeto normalizado que resulta de la importación.
Independiente del formato de origen (TXT, CSV, XLSX).
Los datos originales se conservan siempre en raw_values — nunca se modifican.
Las transformaciones producen nuevas copias.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import numpy as np


@dataclass
class ProcessingStep:
    """Registro de una operación aplicada a un canal de señal."""
    operation: str          # 'baseline_mean' | 'baseline_linear' | 'filter_butterworth' | ...
    params: dict            # parámetros usados
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    description: str = ""


@dataclass
class SignalChannel:
    """Canal individual de señal (aceleración, velocidad, desplazamiento, etc.).

    raw_values siempre contiene los datos originales del archivo, sin modificaciones.
    processed_values es la copia de trabajo que puede ser transformada.
    values_si contiene raw_values convertido a unidades SI (m/s², m/s, m).
    """
    name: str                           # etiqueta del canal (ej: 'ACC_H1', 'Time')
    quantity: str                       # 'acceleration' | 'velocity' | 'displacement' | 'time' | 'other'
    component: str = ""                 # 'H1' | 'H2' | 'V' | 'NS' | 'EW' | 'X' | 'Y' | 'Z' | ''
    original_unit: str = ""            # unidad tal como viene del archivo (ej: 'g', 'cm/s²')
    si_unit: str = ""                  # unidad SI correspondiente ('m/s²', 'm/s', 'm', 's')
    raw_values: np.ndarray = field(default_factory=lambda: np.array([]))
    values_si: np.ndarray = field(default_factory=lambda: np.array([]))
    processed_values: np.ndarray | None = None  # resultado del último procesamiento
    processing_history: list[ProcessingStep] = field(default_factory=list)

    def effective_values_si(self) -> np.ndarray:
        """Retorna processed_values si existe, si no values_si."""
        if self.processed_values is not None:
            return self.processed_values
        return self.values_si


@dataclass
class GroundMotionRecord:
    """Registro de movimiento del suelo normalizado.

    Creado por el importador después de que el usuario define la estructura del archivo.
    El campo `id` es asignado por la API al persistir en BD.
    """

    # ── Identificación ────────────────────────────────────────────────────────
    id: str = ""
    name: str = ""
    source_file: str = ""               # nombre original del archivo
    source_format: str = ""             # 'txt' | 'csv' | 'xlsx'

    # ── Tiempo ───────────────────────────────────────────────────────────────
    dt: float = 0.0                     # intervalo de tiempo (s)
    n_samples: int = 0                  # número de muestras
    duration: float = 0.0              # (n_samples - 1) * dt  [s]
    fs: float = 0.0                    # frecuencia de muestreo (Hz)
    nyquist: float = 0.0               # fs / 2 (Hz)
    time: np.ndarray = field(default_factory=lambda: np.array([]))

    # ── Señales ───────────────────────────────────────────────────────────────
    channels: list[SignalChannel] = field(default_factory=list)

    # ── Metadata del evento (opcional, proporcionada por usuario) ─────────────
    metadata: dict = field(default_factory=dict)
    # Keys útiles: earthquake, station, component, magnitude, distance,
    #              soil_type, source, notes, year

    # ── Historial de procesamiento global ────────────────────────────────────
    processing_log: list[ProcessingStep] = field(default_factory=list)

    # ── Timestamps ───────────────────────────────────────────────────────────
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )

    # ── Propiedades derivadas ─────────────────────────────────────────────────

    def get_acceleration_channel(self, component: str = "") -> SignalChannel | None:
        """Retorna el primer canal de aceleración que coincida con el componente."""
        for ch in self.channels:
            if ch.quantity == "acceleration":
                if not component or ch.component.upper() == component.upper():
                    return ch
        return None

    def acceleration_ms2(self, component: str = "") -> np.ndarray | None:
        """Aceleración efectiva (procesada si existe, si no SI) en m/s²."""
        ch = self.get_acceleration_channel(component)
        if ch is None:
            return None
        return ch.effective_values_si()

    def acceleration_components(self) -> list[SignalChannel]:
        """Lista todos los canales de aceleración."""
        return [ch for ch in self.channels if ch.quantity == "acceleration"]

    def build_time_vector(self) -> None:
        """Reconstruye el vector de tiempo a partir de dt y n_samples."""
        if self.dt > 0 and self.n_samples > 0:
            self.time = np.arange(self.n_samples) * self.dt
            self.duration = float((self.n_samples - 1) * self.dt)
            self.fs = 1.0 / self.dt
            self.nyquist = self.fs / 2.0

    def to_summary_dict(self) -> dict[str, Any]:
        """Resumen ligero para guardar en BD (sin arrays numpy)."""
        acc_ch = self.get_acceleration_channel()
        pga_ms2 = float(np.max(np.abs(acc_ch.effective_values_si()))) if acc_ch is not None else None

        return {
            "name": self.name,
            "source_file": self.source_file,
            "dt": self.dt,
            "n_samples": self.n_samples,
            "duration": self.duration,
            "fs": self.fs,
            "nyquist": self.nyquist,
            "n_channels": len(self.channels),
            "components": [ch.component for ch in self.channels],
            "acc_units_original": [ch.original_unit for ch in self.acceleration_components()],
            "pga_ms2": pga_ms2,
            "metadata": self.metadata,
        }

    def timeseries_to_dict(self, component: str = "") -> dict[str, Any]:
        """Serializa las series de tiempo para enviar al frontend (listas, no arrays)."""
        acc_ch = self.get_acceleration_channel(component)
        if acc_ch is None:
            return {}

        a = acc_ch.effective_values_si()
        t = self.time.tolist() if len(self.time) > 0 else (np.arange(len(a)) * self.dt).tolist()

        return {
            "t": t,
            "a_ms2": a.tolist(),
            "a_raw": acc_ch.raw_values.tolist(),
            "a_unit_original": acc_ch.original_unit,
            "component": acc_ch.component,
            "dt": self.dt,
            "n_samples": self.n_samples,
            "duration": self.duration,
            "fs": self.fs,
            "nyquist": self.nyquist,
            "pga_ms2": float(np.max(np.abs(a))),
            "pga_pos_ms2": float(np.max(a)),
            "pga_neg_ms2": float(np.min(a)),
            "t_pga": float(t[int(np.argmax(np.abs(a)))]),
        }
