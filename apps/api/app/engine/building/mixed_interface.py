"""Detector de interfaces concreto↔acero en un modelo estructural canónico.

Caso de uso principal: edificio de pórticos RC con cubierta metálica (cerchas,
rafters, columnas secundarias de acero) — necesitamos identificar los joints
donde la cubierta apoya sobre la estructura RC para:

    1. Visualizar esos puntos con un marcador en el 3D viewer.
    2. Proponer un tipo de conexión default (pinned para cerchas sobre placa
       de apoyo, rigid para columna continua con placa base anclada).
    3. Avisar si el modelo tiene elementos de acero sin `release` definido,
       lo que indica una conexión asumida rígida (verificar vs detalle real).

El detector opera sobre el canonical (`structural_model.json`):

    {
      "materials": { "<name>": {"type": "concrete"|"steel", ...}, ... },
      "sections":  { "<name>": {"material": "<mat>", "shape": "...", ...}, ... },
      "frames":    { "<id>":   {"section": "<sec>", "joint_i": "N1",
                                "joint_j": "N2", "release": "", ...}, ... },
      "joints":    { "<lbl>":  {"x": ..., "y": ..., "z": ...}, ... }
    }

Funciona en pure-Python (sin numpy/opensees) para ser usable tanto desde el
router HTTP como desde tests.
"""
from __future__ import annotations

from typing import Any, Literal

MaterialKind = Literal["concrete", "steel", "unknown"]


def classify_section(sec: dict, materials: dict) -> MaterialKind:
    """Devuelve 'concrete' | 'steel' | 'unknown' según el material/shape.

    Prioriza:
        1. `shape == "steel"`  o  `aisc_type` presente (seccion creada via
           /model/steel-sections o importada como perfil AISC/DIN).
        2. Material referenciado tiene `type == "steel"` o flag `_IsSteel`.
        3. Todo lo demás se considera concreto si tiene `fpc_mpa` > 0, o
           desconocido.
    """
    if not isinstance(sec, dict):
        return "unknown"

    shape = str(sec.get("shape", "") or sec.get("shape_type", "")).lower()
    if shape == "steel" or sec.get("aisc_type"):
        return "steel"

    mat_name = sec.get("material") or ""
    mat = materials.get(mat_name, {}) if isinstance(materials, dict) else {}
    mat_type = str(mat.get("type", "")).lower() if isinstance(mat, dict) else ""
    if mat_type == "steel" or mat.get("_IsSteel"):
        return "steel"
    if mat_type == "concrete" or float(mat.get("fpc_mpa", 0) or 0) > 0:
        return "concrete"
    # Heurística final: si la sección tiene fy pero no fpc, es acero.
    if not mat.get("fpc_mpa") and mat.get("fy_mpa"):
        return "steel"
    return "unknown"


def detect_mixed_interfaces(canonical: dict) -> list[dict]:
    """Enumera los joints donde convergen frames de concreto y de acero.

    Para cada interfaz devuelve una entrada:

        {
            "joint_id":        "N42",
            "x": 12.0, "y": 8.0, "z": 9.80,
            "concrete_frames": ["C1", "C2"],   # ids de frames concrete incidentes
            "steel_frames":    ["R5", "R6"],   # ids de frames steel incidentes
            "is_roof_support": True,           # heurística: concrete debajo, steel arriba
            "elev_m": 9.80,
        }

    `is_roof_support` es True si al menos un frame concrete entra al joint
    desde abajo (joint es el extremo j y el frame es vertical ascendente, o
    joint es el extremo i y el frame es vertical descendente) y al menos un
    frame steel sale del joint hacia arriba (orientación opuesta).
    """
    sections = canonical.get("sections", {}) or {}
    materials = canonical.get("materials", {}) or {}
    frames = canonical.get("frames", {}) or {}
    joints = canonical.get("joints", {}) or {}

    # Clasificar secciones una sola vez.
    sec_kind: dict[str, MaterialKind] = {
        name: classify_section(sec, materials) for name, sec in sections.items()
    }

    # Para cada joint, listar frames incidentes clasificados.
    joint_concrete: dict[str, list[str]] = {}
    joint_steel: dict[str, list[str]] = {}
    joint_steel_above: dict[str, bool] = {}       # steel sale hacia arriba
    joint_concrete_below: dict[str, bool] = {}    # concrete entra desde abajo

    def _z(lbl: str) -> float:
        j = joints.get(lbl, {})
        try:
            return float(j.get("z", 0.0))
        except (TypeError, ValueError):
            return 0.0

    for fid, fd in frames.items():
        if not isinstance(fd, dict):
            continue
        sec_name = fd.get("section", "")
        kind = sec_kind.get(sec_name, "unknown")
        if kind == "unknown":
            continue
        ji = fd.get("joint_i", "")
        jj = fd.get("joint_j", "")
        if not ji or not jj:
            continue

        zi = _z(ji)
        zj = _z(jj)
        dz = zj - zi

        # Convención: dz_at = z(other) - z(jlbl). Positivo = other está arriba
        # del joint jlbl; negativo = other está abajo.
        for jlbl, dz_at in [(ji, dz), (jj, -dz)]:
            if kind == "concrete":
                joint_concrete.setdefault(jlbl, []).append(fid)
                # "Concrete entra desde abajo al joint" = el otro extremo del
                # elemento concrete está por debajo de jlbl.
                if dz_at < -1e-6:
                    joint_concrete_below[jlbl] = True
            elif kind == "steel":
                joint_steel.setdefault(jlbl, []).append(fid)
                # "Steel sale hacia arriba desde el joint" = el otro extremo
                # está por encima de jlbl.
                if dz_at > 1e-6:
                    joint_steel_above[jlbl] = True

    interfaces: list[dict] = []
    for jlbl in sorted(set(joint_concrete) & set(joint_steel)):
        j = joints.get(jlbl, {})
        interfaces.append({
            "joint_id":        jlbl,
            "x":               float(j.get("x", 0.0) or 0.0),
            "y":               float(j.get("y", 0.0) or 0.0),
            "z":               float(j.get("z", 0.0) or 0.0),
            "elev_m":          float(j.get("z", 0.0) or 0.0),
            "concrete_frames": joint_concrete[jlbl],
            "steel_frames":    joint_steel[jlbl],
            "is_roof_support": bool(
                joint_concrete_below.get(jlbl, False)
                and joint_steel_above.get(jlbl, False)
            ),
        })
    return interfaces


def summarize_interfaces(interfaces: list[dict]) -> dict:
    """Resumen estadístico para el banner de la UI."""
    total = len(interfaces)
    roof = sum(1 for i in interfaces if i.get("is_roof_support"))
    mid  = total - roof
    return {
        "total":           total,
        "roof_supports":   roof,
        "mid_transitions": mid,
    }
