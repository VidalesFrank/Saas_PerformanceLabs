"""Sub-flujo B: Triaje FEMA P-2018 (ATC-78).

Calculo del Building Rating (BR):

  Column/Wall Rating (CR, WR)  -->  Story Rating (SR)  -->  Building Rating (BR)

CR/WR se obtienen interpolando la Tabla 6-6 del protocolo sobre la relacion
demanda/capacidad de deriva (delta_D / delta_C_ajustada). La capacidad se
ajusta por el nivel de dano observado (Seccion 3.5).

BR = max(SR) sobre todos los pisos y direcciones.

Decision final:
  BR <= 0.30           -> riesgo bajo (documentar y monitorear)
  0.30 < BR < 0.70     -> candidato a estudio ASCE 41
  BR >= 0.70           -> riesgo excepcionalmente alto (precolapso)
"""

from __future__ import annotations

from .damage_adj import DEFAULT_DAMAGE_LAMBDA, damage_factor
from .exceptional import ExceptionalFlags, check_exceptional, check_typology_covered
from .shortcuts import ShortcutInput, ShortcutResult, apply_shortcuts
from .table_6_6 import DEFAULT_TABLE_6_6, Band, interp_rating
from .triage import TriageDecision, TriageInput, TriageResult, decide, run_triage

__all__ = [
    "Band",
    "DEFAULT_DAMAGE_LAMBDA",
    "DEFAULT_TABLE_6_6",
    "ExceptionalFlags",
    "ShortcutInput",
    "ShortcutResult",
    "TriageDecision",
    "TriageInput",
    "TriageResult",
    "apply_shortcuts",
    "check_exceptional",
    "check_typology_covered",
    "damage_factor",
    "decide",
    "interp_rating",
    "run_triage",
]
