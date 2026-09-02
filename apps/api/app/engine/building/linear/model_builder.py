"""
CanonicalModelBuilder — Módulo 1: Constructor de Modelos Estructurales.

Transforma las tablas ETABS (raw_data) en el modelo canónico JSON del proyecto.
Este JSON es la fuente de verdad para todos los análisis posteriores:
  modal, espectral, diseño, modelo no lineal.

Unidades de salida: metros (m), kN, MPa.
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd


# ── Keys del raw_data ─────────────────────────────────────────────────────────

_K_JOINTS     = 'TABLE:  "OBJECTS AND ELEMENTS - JOINTS"'
_K_FRAMES     = 'TABLE:  "OBJECTS AND ELEMENTS - FRAMES"'
_K_SHELLS     = 'TABLE:  "OBJECTS AND ELEMENTS - SHELLS"'
_K_MATERIALS  = 'TABLE:  "MATERIAL PROPERTIES - CONCRETE"'
_K_RESTRAINTS = 'TABLE:  "JOINT ASSIGNMENTS - RESTRAINTS"'
_K_FR_SECS    = 'TABLE:  "FRAME SECTIONS"'
_K_FR_ASSIGN  = 'TABLE:  "FRAME ASSIGNMENTS - SECTIONS"'
_K_SH_ASSIGN  = 'TABLE:  "SHELL ASSIGNMENTS - SECTIONS"'
_K_SH_SLAB    = 'TABLE:  "SHELL SECTIONS - SLAB"'
_K_SH_WALL    = 'TABLE:  "SHELL SECTIONS - WALL"'
_K_SH_LOADS   = 'TABLE:  "SHELL LOADS - UNIFORM"'
_K_MASS       = 'TABLE:  "MASS SUMMARY BY DIAPHRAGM"'


def _to_float(val, default: float = 0.0) -> float:
    try:
        v = float(val)
        return v if math.isfinite(v) else default
    except (TypeError, ValueError):
        return default


def _to_int(val, default: int = 0) -> int:
    try:
        return int(float(val))
    except (TypeError, ValueError):
        return default


def _safe_str(val, default: str = "") -> str:
    if val is None or (isinstance(val, float) and math.isnan(val)):
        return default
    return str(val).strip()


# ── Builder principal ─────────────────────────────────────────────────────────

class CanonicalModelBuilder:
    """
    Construye el diccionario del modelo canónico desde raw_data de ETABS.

    Uso:
        builder = CanonicalModelBuilder(raw_data)
        model = builder.build()
    """

    def __init__(self, raw_data: dict):
        self._rd = raw_data

    def build(self) -> dict:
        joints, stories, restraints = self._build_joints()
        materials = self._build_materials()
        sections  = self._build_sections(materials)
        frames    = self._build_frames(sections, joints)
        shells    = self._build_shells()
        masses    = self._build_masses(joints)
        load_patterns = self._extract_load_patterns()

        total_h = 0.0
        if stories:
            z_vals = [s["elevation_m"] for s in stories.values()]
            total_h = round(max(z_vals) - min(z_vals), 3) if len(z_vals) > 1 else 0.0

        return {
            "schema_version": "1.0",
            "metadata": {
                "n_stories":    len(stories),
                "n_joints":     len(joints),
                "n_frames":     len(frames),
                "n_shells":     len(shells),
                "n_sections":   len(sections),
                "n_materials":  len(materials),
                "story_names":  sorted(stories.keys(), key=lambda s: stories[s]["elevation_m"]),
                "total_height_m": total_h,
                "load_patterns": load_patterns,
            },
            "stories":    stories,
            "joints":     joints,
            "restraints": restraints,
            "materials":  materials,
            "sections":   sections,
            "frames":     frames,
            "shells":     shells,
            "masses":     masses,
            "analysis_results": {
                "modal":    None,
                "spectral": None,
                "design":   None,
                "nonlinear_model": None,
            },
        }

    # ── Joints y pisos ────────────────────────────────────────────────────────

    def _build_joints(self) -> tuple[dict, dict, dict]:
        df = self._rd.get(_K_JOINTS)
        if not isinstance(df, pd.DataFrame) or len(df) == 0:
            return {}, {}, {}

        joints: dict[str, dict] = {}
        restraints_raw = self._rd.get(_K_RESTRAINTS)
        restrained_joints: set[str] = set()

        if isinstance(restraints_raw, pd.DataFrame) and len(restraints_raw) > 0:
            r = restraints_raw.copy()
            # El campo puede llamarse "Unique Name" en ETABS
            label_col = "Unique Name" if "Unique Name" in r.columns else "Element Label"
            for _, row in r.iterrows():
                jid = _safe_str(row.get(label_col))
                dofs = [
                    1 if _safe_str(row.get(d, "No")).lower() == "yes" else 0
                    for d in ("UX", "UY", "UZ", "RX", "RY", "RZ")
                ]
                if any(dofs):
                    restrained_joints.add(jid)

        # Calcular la altura de cada piso como la Z máxima de sus nodos
        story_z: dict[str, list[float]] = {}

        for _, row in df.iterrows():
            obj_type = _safe_str(row.get("Object Type", "Joint"))
            if obj_type and obj_type.lower() not in ("joint", ""):
                continue  # skip non-joint rows

            label = _safe_str(row.get("Element Label"))
            if not label:
                continue

            x = _to_float(row.get("Global X"))
            y = _to_float(row.get("Global Y"))
            z = _to_float(row.get("Global Z"))
            story = _safe_str(row.get("Story", ""))

            joints[label] = {
                "x": x, "y": y, "z": z,
                "story": story,
                "is_restrained": label in restrained_joints,
            }

            if story:
                story_z.setdefault(story, []).append(z)

        # Construir diccionario de pisos con su elevación media
        stories: dict[str, dict] = {}
        for sname, zs in story_z.items():
            elev = round(float(np.mean(zs)), 4)
            stories[sname] = {"elevation_m": elev, "height_m": 0.0}

        # Calcular altura entre pisos
        sorted_stories = sorted(stories.items(), key=lambda kv: kv[1]["elevation_m"])
        for i in range(1, len(sorted_stories)):
            name, data = sorted_stories[i]
            prev_elev = sorted_stories[i - 1][1]["elevation_m"]
            stories[name]["height_m"] = round(data["elevation_m"] - prev_elev, 4)

        # Restricciones
        restraints: dict[str, list[int]] = {}
        if isinstance(restraints_raw, pd.DataFrame) and len(restraints_raw) > 0:
            r = restraints_raw.copy()
            label_col = "Unique Name" if "Unique Name" in r.columns else "Element Label"
            for _, row in r.iterrows():
                jid = _safe_str(row.get(label_col))
                dofs = [
                    1 if _safe_str(row.get(d, "No")).lower() == "yes" else 0
                    for d in ("UX", "UY", "UZ", "RX", "RY", "RZ")
                ]
                restraints[jid] = dofs

        return joints, stories, restraints

    # ── Materiales ────────────────────────────────────────────────────────────

    def _build_materials(self) -> dict[str, dict]:
        df = self._rd.get(_K_MATERIALS)
        if not isinstance(df, pd.DataFrame) or len(df) == 0:
            return {}

        materials: dict[str, dict] = {}
        for _, row in df.iterrows():
            name = _safe_str(row.get("Name", ""))
            if not name:
                continue
            fpc = _to_float(row.get("Fc"))           # MPa
            G   = _to_float(row.get("G"))             # MPa
            E   = _to_float(row.get("E")) or _to_float(row.get("Ec"))  # MPa
            if E == 0.0 and fpc > 0:
                E = round(4700 * math.sqrt(fpc), 1)  # ACI 318: Ec = 4700√f'c (MPa)
            materials[name] = {
                "type":    "concrete",
                "fpc_mpa": round(fpc, 2),
                "E_mpa":   round(E, 1),
                "G_mpa":   round(G, 1) if G else round(E / 2.4, 1),
            }

        return materials

    # ── Secciones de marco ────────────────────────────────────────────────────

    def _build_sections(self, materials: dict) -> dict[str, dict]:
        df = self._rd.get(_K_FR_SECS)
        if not isinstance(df, pd.DataFrame) or len(df) == 0:
            return {}

        sections: dict[str, dict] = {}
        for _, row in df.iterrows():
            name = _safe_str(row.get("Name", ""))
            if not name:
                continue
            mat    = _safe_str(row.get("Material", ""))
            shape  = _safe_str(row.get("Shape", "Rectangular"))
            t3     = _to_float(row.get("t3"))      # altura / profundidad (m)
            t2     = _to_float(row.get("t2"))      # ancho (m)
            area   = _to_float(row.get("Area"))    # m² (normalizado por _load_raw_data)
            i33    = _to_float(row.get("I33"))     # m⁴ (normalizado por _load_raw_data)
            i22    = _to_float(row.get("I22"))     # m⁴ (normalizado por _load_raw_data)
            j      = _to_float(row.get("J"))       # m⁴ (normalizado por _load_raw_data)

            # Calcular área e inercias si no vienen en el archivo
            if t3 > 0 and t2 > 0:
                if area == 0:
                    area = t3 * t2
                if i33 == 0:
                    i33 = t2 * t3**3 / 12.0
                if i22 == 0:
                    i22 = t3 * t2**3 / 12.0

            E = materials.get(mat, {}).get("E_mpa", 0.0)
            G = materials.get(mat, {}).get("G_mpa", 0.0)

            sections[name] = {
                "material": mat,
                "shape":    shape,
                "h_m":      round(t3, 4),
                "b_m":      round(t2, 4),
                "A_m2":     round(area, 6),
                "I33_m4":   round(i33, 8),
                "I22_m4":   round(i22, 8),
                "J_m4":     round(j, 8),
                "E_mpa":    E,
                "G_mpa":    G,
            }

        return sections

    # ── Elementos frame ───────────────────────────────────────────────────────

    def _build_frames(self, sections: dict, joints: dict | None = None) -> dict[str, dict]:
        frames_df = self._rd.get(_K_FRAMES)
        assign_df = self._rd.get(_K_FR_ASSIGN)

        if not isinstance(frames_df, pd.DataFrame) or len(frames_df) == 0:
            return {}

        # Mapa de asignaciones: label → section_name
        # E17 nativo usa "Element Label" que coincide con frames "Element Label".
        # E23 adaptado usa "Label" (obj label como "B525") que coincide con frames "Object Label".
        # "Unique Name" en E23 adaptado es un ID interno diferente al Element Label.
        sec_map: dict[str, str] = {}
        if isinstance(assign_df, pd.DataFrame) and len(assign_df) > 0:
            if "Element Label" in assign_df.columns:
                lc = "Element Label"
            elif "Label" in assign_df.columns:
                lc = "Label"
            else:
                lc = "Unique Name"
            for _, r in assign_df.iterrows():
                lbl = _safe_str(r.get(lc))
                # E17 nativo: "Section"; E23 adaptado: "Analysis Section"
                sec = _safe_str(r.get("Section") or r.get("Analysis Section") or "")
                if lbl and sec:
                    sec_map[lbl] = sec

        jcoords = joints or {}

        frames: dict[str, dict] = {}
        for _, row in frames_df.iterrows():
            label    = _safe_str(row.get("Element Label", ""))
            # Filtrar elementos internos ETABS (@LC-* son conectores de diafragma)
            if label.startswith("@"):
                continue
            obj_type  = _safe_str(row.get("Object Type", ""))
            story     = _safe_str(row.get("Story", ""))
            ji        = _safe_str(row.get("Joint I", ""))
            jj        = _safe_str(row.get("Joint J", ""))
            obj_label = _safe_str(row.get("Object Label", label))

            # Clasificación: ETABS E23 usa "Frame" para todo.
            # Primero intentamos el campo "Object Type" (funciona con E17 nativo).
            # Si no es concluyente, usamos geometría: columna si dz > distancia_horizontal.
            if obj_type.lower() == "column":
                element_type = "column"
            elif obj_type.lower() in ("beam", "brace"):
                element_type = "beam"
            else:
                # Fallback geométrico con coordenadas de nodos
                ji_data = jcoords.get(ji, {})
                jj_data = jcoords.get(jj, {})
                dz  = abs(jj_data.get("z", 0.0) - ji_data.get("z", 0.0))
                dxy = math.sqrt(
                    (jj_data.get("x", 0.0) - ji_data.get("x", 0.0)) ** 2 +
                    (jj_data.get("y", 0.0) - ji_data.get("y", 0.0)) ** 2
                )
                element_type = "column" if dz > dxy else "beam"

            # Sección (busca por label del elemento primero, luego por object label)
            section = sec_map.get(label) or sec_map.get(obj_label) or ""

            frames[label] = {
                "joint_i":      ji,
                "joint_j":      jj,
                "section":      section,
                "element_type": element_type,
                "story":        story,
                "object_label": obj_label,
            }

        return frames

    # ── Elementos shell ───────────────────────────────────────────────────────

    def _build_shells(self) -> dict[str, dict]:
        shells_df = self._rd.get(_K_SHELLS)
        assign_df = self._rd.get(_K_SH_ASSIGN)
        slab_df   = self._rd.get(_K_SH_SLAB)
        wall_df   = self._rd.get(_K_SH_WALL)

        if not isinstance(shells_df, pd.DataFrame) or len(shells_df) == 0:
            return {}

        # Mapa de asignaciones: element_label → section
        sec_map: dict[str, str] = {}
        if isinstance(assign_df, pd.DataFrame) and len(assign_df) > 0:
            lc = "Unique Name" if "Unique Name" in assign_df.columns else "Element Label"
            for _, r in assign_df.iterrows():
                lbl = _safe_str(r.get(lc))
                sec = _safe_str(r.get("Section", ""))
                if lbl and sec:
                    sec_map[lbl] = sec

        # Espesores por sección
        thickness_map: dict[str, float] = {}
        for df in (slab_df, wall_df):
            if isinstance(df, pd.DataFrame) and "Name" in df.columns:
                thk_col = next((c for c in df.columns if "Thick" in c), None)
                if thk_col:
                    for _, r in df.iterrows():
                        n = _safe_str(r.get("Name", ""))
                        if n:
                            thickness_map[n] = _to_float(r.get(thk_col))

        shells: dict[str, dict] = {}
        for _, row in shells_df.iterrows():
            label    = _safe_str(row.get("Element Label", ""))
            area_type = _safe_str(row.get("Area Type", "Floor"))
            story    = _safe_str(row.get("Story", ""))
            area_label = _safe_str(row.get("Area Label", label))

            joints = [
                _safe_str(row.get(c, ""))
                for c in ("Joint 1", "Joint 2", "Joint 3", "Joint 4")
            ]
            joints = [j for j in joints if j]

            section = sec_map.get(label) or sec_map.get(area_label) or ""
            element_type = "slab" if area_type.lower() == "floor" else "wall"

            shells[label] = {
                "joints":        joints,
                "section":       section,
                "element_type":  element_type,
                "story":         story,
                "area_label":    area_label,
                "thickness_m":   thickness_map.get(section, 0.0),
            }

        return shells

    # ── Masas por piso ────────────────────────────────────────────────────────

    def _build_masses(self, joints: dict) -> dict[str, dict]:
        df = self._rd.get(_K_MASS)
        if not isinstance(df, pd.DataFrame) or len(df) == 0:
            return {}

        masses: dict[str, dict] = {}
        for _, row in df.iterrows():
            story   = _safe_str(row.get("Story", ""))
            mass_x  = _to_float(row.get("Mass X"))
            mass_y  = _to_float(row.get("Mass Y"))
            mass_rz = _to_float(row.get("Mass Moment of Inertia"))
            xc      = _to_float(row.get("X Mass Center"))
            yc      = _to_float(row.get("Y Mass Center"))

            # Buscar la Z del piso en los joints
            zc = 0.0
            story_joints = [(jd["x"], jd["y"], jd["z"]) for jd in joints.values()
                           if jd.get("story") == story]
            if story_joints:
                zc = float(np.mean([z for _, _, z in story_joints]))

            key = f"mass_{story}"
            masses[key] = {
                "story":        story,
                "mass_x_t":     round(mass_x / 1000.0, 6),   # kg → ton (kN·s²/m)
                "mass_y_t":     round(mass_y / 1000.0, 6),   # kg → ton
                "mass_rz_tm2":  round(mass_rz, 4),            # ton·m² (ya en unidades correctas)
                "x_cm_m":       round(xc, 4),
                "y_cm_m":       round(yc, 4),
                "z_m":          round(zc, 4),
            }

        return masses

    # ── Patrones de carga ────────────────────────────────────────────────────

    def _extract_load_patterns(self) -> list[str]:
        df = self._rd.get(_K_SH_LOADS)
        if not isinstance(df, pd.DataFrame) or "Load Pattern" not in df.columns:
            return []
        return sorted(df["Load Pattern"].dropna().astype(str).unique().tolist())
