"""
DataValidator — Módulo 1: Constructor de Modelos Estructurales.

Valida la integridad de las tablas ETABS antes de construir el modelo canónico.
Opera sobre el diccionario raw_data que produce _load_raw_data() desde el XLSX.

Errores CRÍTICOS  → impiden construir el modelo.
ADVERTENCIAS      → el modelo se construye bajo responsabilidad del usuario.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Literal

import numpy as np
import pandas as pd


# ── Tipos de resultado ────────────────────────────────────────────────────────

@dataclass
class ValidationIssue:
    code: str
    severity: Literal["critical", "warning"]
    message: str
    location: str = ""
    details: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "code": self.code,
            "severity": self.severity,
            "message": self.message,
            "location": self.location,
            "details": self.details,
        }


@dataclass
class ModelSummary:
    n_stories: int = 0
    n_joints: int = 0
    n_frames: int = 0
    n_shells: int = 0
    n_sections: int = 0
    n_materials: int = 0
    story_names: list[str] = field(default_factory=list)
    total_height_m: float = 0.0

    def to_dict(self) -> dict:
        return {
            "n_stories": self.n_stories,
            "n_joints": self.n_joints,
            "n_frames": self.n_frames,
            "n_shells": self.n_shells,
            "n_sections": self.n_sections,
            "n_materials": self.n_materials,
            "story_names": self.story_names,
            "total_height_m": self.total_height_m,
        }


@dataclass
class ValidationReport:
    issues: list[ValidationIssue] = field(default_factory=list)
    model_summary: ModelSummary | None = None
    load_patterns: list[str] = field(default_factory=list)

    @property
    def critical(self) -> list[ValidationIssue]:
        return [i for i in self.issues if i.severity == "critical"]

    @property
    def warnings(self) -> list[ValidationIssue]:
        return [i for i in self.issues if i.severity == "warning"]

    @property
    def has_critical(self) -> bool:
        return bool(self.critical)

    @property
    def validation_status(self) -> str:
        if self.has_critical:
            return "has_errors"
        if self.warnings:
            return "has_warnings"
        return "ok"

    def to_dict(self) -> dict:
        return {
            "validation_status": self.validation_status,
            "has_critical": self.has_critical,
            "n_critical": len(self.critical),
            "n_warnings": len(self.warnings),
            "issues": [i.to_dict() for i in self.issues],
            "model_summary": self.model_summary.to_dict() if self.model_summary else None,
            "load_patterns": self.load_patterns,
        }


# ── Keys del raw_data ────────────────────────────────────────────────────────

_K_JOINTS    = 'TABLE:  "OBJECTS AND ELEMENTS - JOINTS"'
_K_FRAMES    = 'TABLE:  "OBJECTS AND ELEMENTS - FRAMES"'
_K_SHELLS    = 'TABLE:  "OBJECTS AND ELEMENTS - SHELLS"'
_K_MATERIALS = 'TABLE:  "MATERIAL PROPERTIES - CONCRETE"'
_K_RESTRAINTS = 'TABLE:  "JOINT ASSIGNMENTS - RESTRAINTS"'
_K_FR_SECS   = 'TABLE:  "FRAME SECTIONS"'
_K_FR_ASSIGN = 'TABLE:  "FRAME ASSIGNMENTS - SECTIONS"'
_K_SH_ASSIGN = 'TABLE:  "SHELL ASSIGNMENTS - SECTIONS"'
_K_SH_SLAB   = 'TABLE:  "SHELL SECTIONS - SLAB"'
_K_SH_LOADS  = 'TABLE:  "SHELL LOADS - UNIFORM"'
_K_MASS      = 'TABLE:  "MASS SUMMARY BY DIAPHRAGM"'

_REQUIRED_SHEETS = [
    "Objects and Elements - Joints",
    "Objects and Elements - Frames",
    "Objects and Elements - Shells",
    "Material Properties - Concrete",
    "Joint Assignments - Restraints",
    "Frame Sections",
    "Frame Assignments - Sections",
    "Shell Assignments - Sections",
    "Shell Sections - Slab",
    "Shell Loads - Uniform",
    "Mass Summary by Diaphragm",
]


# ── Validador ─────────────────────────────────────────────────────────────────

class DataValidator:
    """
    Valida las tablas ETABS exportadas antes de construir el modelo canónico.

    Uso:
        report = DataValidator().validate(raw_data, sheet_names)
    """

    def validate(self, raw_data: dict, sheet_names: list[str]) -> ValidationReport:
        issues: list[ValidationIssue] = []

        # Paso 1: hojas requeridas
        issues += self._check_required_sheets(sheet_names)

        # Si faltan hojas críticas, no tiene sentido seguir
        if issues:
            return ValidationReport(issues=issues)

        joints_df    = raw_data.get(_K_JOINTS)
        frames_df    = raw_data.get(_K_FRAMES)
        shells_df    = raw_data.get(_K_SHELLS)
        mats_df      = raw_data.get(_K_MATERIALS)
        restraints_df = raw_data.get(_K_RESTRAINTS)
        fr_secs_df   = raw_data.get(_K_FR_SECS)
        fr_assign_df = raw_data.get(_K_FR_ASSIGN)
        sh_assign_df = raw_data.get(_K_SH_ASSIGN)
        mass_df      = raw_data.get(_K_MASS)
        sh_loads_df  = raw_data.get(_K_SH_LOADS)

        # Paso 2: tablas vacías
        issues += self._check_not_empty(joints_df, "Objects and Elements - Joints", _K_JOINTS)
        issues += self._check_not_empty(frames_df, "Objects and Elements - Frames", _K_FRAMES)
        issues += self._check_not_empty(mats_df, "Material Properties - Concrete", _K_MATERIALS)
        issues += self._check_not_empty(fr_secs_df, "Frame Sections", _K_FR_SECS)

        if any(i.severity == "critical" for i in issues):
            return ValidationReport(issues=issues)

        # Paso 3: validar joints
        issues += self._check_joints(joints_df)

        # Paso 4: validar frames
        issues += self._check_frames(frames_df, joints_df)

        # Paso 5: validar shells
        if isinstance(shells_df, pd.DataFrame) and len(shells_df):
            issues += self._check_shells(shells_df, joints_df)

        # Paso 6: secciones y materiales
        issues += self._check_sections_materials(fr_secs_df, mats_df)

        # Paso 7: asignaciones de sección a frames
        if isinstance(fr_assign_df, pd.DataFrame) and len(fr_assign_df):
            issues += self._check_frame_section_assignments(fr_assign_df, fr_secs_df, frames_df)

        # Paso 8: restricciones (apoyos)
        issues += self._check_restraints(restraints_df)

        # Paso 9: masas por diafragma
        if isinstance(mass_df, pd.DataFrame):
            issues += self._check_mass(mass_df, joints_df)

        # Paso 10: patrones de carga
        load_patterns: list[str] = []
        if isinstance(sh_loads_df, pd.DataFrame) and len(sh_loads_df):
            load_patterns = self._extract_all_load_patterns(sh_loads_df)
            issues += self._check_load_patterns(sh_loads_df, load_patterns)

        # Construir resumen del modelo
        summary = self._build_summary(joints_df, frames_df, shells_df, fr_secs_df, mats_df)

        return ValidationReport(issues=issues, model_summary=summary, load_patterns=load_patterns)

    # ── Checks individuales ───────────────────────────────────────────────────

    def _check_required_sheets(self, sheet_names: list[str]) -> list[ValidationIssue]:
        issues = []
        present = set(sheet_names)
        for sheet in _REQUIRED_SHEETS:
            if sheet not in present:
                issues.append(ValidationIssue(
                    code="MISSING_SHEET",
                    severity="critical",
                    message=f"Hoja obligatoria faltante: '{sheet}'",
                    location="Archivo XLSX",
                    details={"sheet": sheet},
                ))
        return issues

    def _check_not_empty(self, df, sheet_name: str, key: str) -> list[ValidationIssue]:
        if not isinstance(df, pd.DataFrame) or len(df) == 0:
            return [ValidationIssue(
                code="EMPTY_TABLE",
                severity="critical",
                message=f"La tabla '{sheet_name}' está vacía o no fue leída correctamente.",
                location=sheet_name,
            )]
        return []

    def _check_joints(self, df: pd.DataFrame) -> list[ValidationIssue]:
        issues = []

        # Coordenadas inválidas (NaN o no numéricas)
        for coord in ("Global X", "Global Y", "Global Z"):
            if coord not in df.columns:
                continue
            numeric = pd.to_numeric(df[coord], errors="coerce")
            bad = df[numeric.isna()]
            if len(bad):
                labels = bad.get("Element Label", bad.index).tolist()[:5]
                issues.append(ValidationIssue(
                    code="INVALID_COORD",
                    severity="critical",
                    message=f"Nodos con coordenada {coord} inválida o nula.",
                    location="Objects and Elements - Joints",
                    details={"joints": [str(l) for l in labels], "coord": coord},
                ))

        # Nodos duplicados (mismo X, Y, Z)
        if all(c in df.columns for c in ("Global X", "Global Y", "Global Z")):
            coords = df[["Global X", "Global Y", "Global Z"]].apply(pd.to_numeric, errors="coerce")
            rounded = coords.round(4)
            dups = rounded[rounded.duplicated(keep=False)]
            if len(dups):
                n = len(dups)
                issues.append(ValidationIssue(
                    code="DUP_NODE",
                    severity="critical",
                    message=f"{n} nodo(s) comparten la misma posición geométrica (posibles duplicados).",
                    location="Objects and Elements - Joints",
                    details={"count": n},
                ))

        # Nodos sin Story asignado
        if "Story" in df.columns:
            no_story = df[df["Story"].isna() | (df["Story"].astype(str).str.strip() == "")]
            if len(no_story):
                issues.append(ValidationIssue(
                    code="NODE_NO_STORY",
                    severity="warning",
                    message=f"{len(no_story)} nodo(s) sin Story asignado.",
                    location="Objects and Elements - Joints",
                    details={"count": len(no_story)},
                ))

        return issues

    def _check_frames(self, frames_df: pd.DataFrame, joints_df: pd.DataFrame) -> list[ValidationIssue]:
        issues = []

        # Columnas requeridas
        for col in ("Joint I", "Joint J"):
            if col not in frames_df.columns:
                issues.append(ValidationIssue(
                    code="MISSING_COLUMN",
                    severity="critical",
                    message=f"Falta la columna '{col}' en Objects and Elements - Frames.",
                    location="Objects and Elements - Frames",
                ))
                return issues

        # Joints existentes
        if "Element Label" in joints_df.columns:
            valid_joints = set(pd.to_numeric(joints_df["Element Label"], errors="coerce").dropna().astype(int))
            for col in ("Joint I", "Joint J"):
                refs = pd.to_numeric(frames_df[col], errors="coerce").dropna().astype(int)
                orphans = refs[~refs.isin(valid_joints)].unique()
                if len(orphans):
                    issues.append(ValidationIssue(
                        code="ORPHAN_FRAME",
                        severity="critical",
                        message=f"{len(orphans)} elemento(s) frame referencian el nodo {col} inexistente.",
                        location="Objects and Elements - Frames",
                        details={"missing_joints": [int(j) for j in orphans[:10]]},
                    ))

        # Elementos muy cortos (advertencia)
        if all(c in joints_df.columns for c in ("Element Label", "Global X", "Global Y", "Global Z")):
            jcoords = joints_df.copy()
            jcoords["Element Label"] = pd.to_numeric(jcoords["Element Label"], errors="coerce")
            for col in ("Global X", "Global Y", "Global Z"):
                jcoords[col] = pd.to_numeric(jcoords[col], errors="coerce")
            jcoords = jcoords.dropna(subset=["Element Label", "Global X", "Global Y", "Global Z"])
            coord_map = {int(r["Element Label"]): (r["Global X"], r["Global Y"], r["Global Z"])
                         for _, r in jcoords.iterrows()}

            short = []
            for _, row in frames_df.iterrows():
                ji = int(pd.to_numeric(row.get("Joint I", np.nan), errors="coerce") or 0)
                jj = int(pd.to_numeric(row.get("Joint J", np.nan), errors="coerce") or 0)
                if ji in coord_map and jj in coord_map:
                    xi, yi, zi = coord_map[ji]
                    xj, yj, zj = coord_map[jj]
                    L = math.sqrt((xj-xi)**2 + (yj-yi)**2 + (zj-zi)**2)
                    if 0 < L < 0.10:
                        short.append((row.get("Element Label", "?"), round(L, 4)))
            if short:
                issues.append(ValidationIssue(
                    code="SHORT_ELEMENT",
                    severity="warning",
                    message=f"{len(short)} elemento(s) con longitud < 10 cm. Verifique el modelo.",
                    location="Objects and Elements - Frames",
                    details={"elements": [str(e) for e, _ in short[:5]]},
                ))

        return issues

    def _check_shells(self, shells_df: pd.DataFrame, joints_df: pd.DataFrame) -> list[ValidationIssue]:
        issues = []

        if "Element Label" not in joints_df.columns:
            return issues

        valid_joints = set(pd.to_numeric(joints_df["Element Label"], errors="coerce").dropna().astype(int))
        joint_cols = ["Joint 1", "Joint 2", "Joint 3", "Joint 4"]
        available = [c for c in joint_cols if c in shells_df.columns]

        orphan_count = 0
        for col in available:
            refs = pd.to_numeric(shells_df[col], errors="coerce").dropna().astype(int)
            orphans = refs[~refs.isin(valid_joints)]
            orphan_count += len(orphans)

        if orphan_count:
            issues.append(ValidationIssue(
                code="ORPHAN_SHELL",
                severity="critical",
                message=f"{orphan_count} referencia(s) a nodos inexistentes en elementos shell.",
                location="Objects and Elements - Shells",
                details={"count": orphan_count},
            ))

        # Shells degenerados (nodos repetidos)
        if len(available) == 4:
            def has_degen(row):
                vals = [pd.to_numeric(row[c], errors="coerce") for c in available]
                non_nan = [v for v in vals if not (isinstance(v, float) and math.isnan(v))]
                return len(non_nan) != len(set(non_nan))
            degen = shells_df[shells_df.apply(has_degen, axis=1)]
            if len(degen):
                issues.append(ValidationIssue(
                    code="DEGENERATE_SHELL",
                    severity="warning",
                    message=f"{len(degen)} shell(s) con nodos repetidos (triángulos o degenerados).",
                    location="Objects and Elements - Shells",
                    details={"count": len(degen)},
                ))

        return issues

    def _check_sections_materials(self, secs_df: pd.DataFrame, mats_df: pd.DataFrame) -> list[ValidationIssue]:
        issues = []

        if "Material" not in secs_df.columns or "Name" not in mats_df.columns:
            return issues

        defined_mats = set(mats_df["Name"].dropna().astype(str).str.strip())
        used_mats = set(secs_df["Material"].dropna().astype(str).str.strip())
        undefined = used_mats - defined_mats
        if undefined:
            issues.append(ValidationIssue(
                code="UNDEFINED_MATERIAL",
                severity="critical",
                message=f"Material(es) referenciado(s) en secciones pero no definido(s): {sorted(undefined)}",
                location="Frame Sections",
                details={"materials": sorted(undefined)},
            ))

        return issues

    def _check_frame_section_assignments(
        self, assign_df: pd.DataFrame, secs_df: pd.DataFrame, frames_df: pd.DataFrame
    ) -> list[ValidationIssue]:
        issues = []

        # La columna puede llamarse "Section" (E17) o "Analysis Section" (E23 adaptado)
        sec_col = next((c for c in ("Section", "Analysis Section") if c in assign_df.columns), None)
        if sec_col is None:
            return issues

        defined_secs = set()
        if isinstance(secs_df, pd.DataFrame) and "Name" in secs_df.columns:
            defined_secs = set(secs_df["Name"].dropna().astype(str).str.strip())

        # Secciones asignadas pero no definidas
        assigned_secs = set(assign_df[sec_col].dropna().astype(str).str.strip())
        undefined = assigned_secs - defined_secs
        if undefined:
            issues.append(ValidationIssue(
                code="UNDEFINED_SECTION",
                severity="critical",
                message=f"Sección(es) asignada(s) a frames pero no definida(s) en Frame Sections: {sorted(undefined)}",
                location="Frame Assignments - Sections",
                details={"sections": sorted(undefined)},
            ))

        # Secciones definidas pero nunca usadas (advertencia)
        unused = defined_secs - assigned_secs
        if unused:
            issues.append(ValidationIssue(
                code="UNUSED_SECTION",
                severity="warning",
                message=f"{len(unused)} sección(es) definida(s) pero nunca asignada(s) a frames.",
                location="Frame Sections",
                details={"sections": sorted(unused)[:10]},
            ))

        return issues

    def _check_restraints(self, df) -> list[ValidationIssue]:
        if not isinstance(df, pd.DataFrame) or len(df) == 0:
            return [ValidationIssue(
                code="NO_RESTRAINTS",
                severity="critical",
                message="No se encontraron restricciones (apoyos) en el modelo. El edificio no tiene base definida.",
                location="Joint Assignments - Restraints",
            )]
        return []

    def _check_mass(self, mass_df: pd.DataFrame, joints_df: pd.DataFrame) -> list[ValidationIssue]:
        issues = []
        if "Mass X" not in mass_df.columns:
            return issues

        zero_mass = mass_df[pd.to_numeric(mass_df["Mass X"], errors="coerce").fillna(0) == 0]
        if len(zero_mass) and len(zero_mass) < len(mass_df):
            issues.append(ValidationIssue(
                code="MISSING_MASS",
                severity="warning",
                message=f"{len(zero_mass)} piso(s) con masa cero o no definida.",
                location="Mass Summary by Diaphragm",
                details={"stories": zero_mass.get("Story", pd.Series()).tolist()[:5]},
            ))

        return issues

    def _extract_all_load_patterns(self, loads_df: pd.DataFrame) -> list[str]:
        if "Load Pattern" not in loads_df.columns:
            return []
        return sorted(loads_df["Load Pattern"].dropna().astype(str).str.strip().unique().tolist())

    def _check_load_patterns(self, loads_df: pd.DataFrame, patterns_list: list[str]) -> list[ValidationIssue]:
        issues = []
        if not patterns_list:
            return issues

        patterns = set(patterns_list)
        patterns_upper = {p.upper() for p in patterns}
        common_dead = {"DEAD", "CM", "D", "SDL", "SW", "CARGA MUERTA", "MUERTA"}
        common_live = {"LIVE", "CV", "L", "CARGA VIVA", "VIVA"}

        has_dead = bool(patterns_upper & common_dead)
        has_live = bool(patterns_upper & common_live)

        if not has_dead or not has_live:
            issues.append(ValidationIssue(
                code="LOAD_PATTERN_MAPPING_REQUIRED",
                severity="warning",
                message=(
                    "Los nombres de los patrones de carga no coinciden con los nombres estándar "
                    "(DEAD/CM/LIVE/CV). Selecciona cuál corresponde a carga muerta y carga viva "
                    "en la sección de patrones de carga."
                ),
                location="Shell Loads - Uniform",
                details={"found_patterns": sorted(patterns)},
            ))

        return issues

    def _build_summary(self, joints_df, frames_df, shells_df, secs_df, mats_df) -> ModelSummary:
        summary = ModelSummary()

        if isinstance(joints_df, pd.DataFrame):
            # Solo joints reales (tipo Joint)
            if "Object Type" in joints_df.columns:
                real_joints = joints_df[joints_df["Object Type"] == "Joint"]
            else:
                real_joints = joints_df
            summary.n_joints = len(real_joints)

            if "Story" in joints_df.columns and "Global Z" in joints_df.columns:
                try:
                    story_elevs = (
                        joints_df[["Story", "Global Z"]]
                        .dropna()
                        .copy()
                    )
                    story_elevs["Global Z"] = pd.to_numeric(story_elevs["Global Z"], errors="coerce")
                    story_max = story_elevs.groupby("Story")["Global Z"].max().sort_values()
                    summary.story_names = list(story_max.index)
                    summary.n_stories = len(summary.story_names)
                    zvals = story_max.values
                    if len(zvals) >= 2:
                        summary.total_height_m = float(round(zvals[-1] - zvals[0], 3))
                except Exception:
                    pass

        if isinstance(frames_df, pd.DataFrame):
            summary.n_frames = len(frames_df)

        if isinstance(shells_df, pd.DataFrame):
            summary.n_shells = len(shells_df)

        if isinstance(secs_df, pd.DataFrame) and "Name" in secs_df.columns:
            summary.n_sections = secs_df["Name"].nunique()

        if isinstance(mats_df, pd.DataFrame) and "Name" in mats_df.columns:
            summary.n_materials = mats_df["Name"].nunique()

        return summary
