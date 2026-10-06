"""
NLSpecBuilder — Módulo 1: Generador de especificación del modelo no lineal.

Lee el modelo canónico (structural_model.json) y los resultados de diseño
(design_columns_detail.json, beam_design_detail.json, reinforcement.json)
y produce un JSON autocontenido y portable: nonlinear_model.json.

Este JSON puede:
  - Descargarse y guardarse como archivo del proyecto
  - Cargarse en el mismo módulo para continuar trabajo
  - Alimentar directamente al OPSModelBuilder del Módulo 3

Unidades: kN, m, MPa.
"""
from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime, timezone
from typing import Any

from .mander import (
    confinement_to_dict,
    default_confinement,
    mander_rect_confinement,
)


# Diámetros nominales ASTM / NSR-10 (mm) — duplicado local para evitar depender
# del designer en el pipeline no lineal.
_BAR_DIAM_MM: dict[str, float] = {
    "#3":  9.5,  "#4": 12.7,  "#5": 15.9,  "#6": 19.1,  "#7": 22.2,
    "#8": 25.4,  "#9": 28.7,  "#10": 32.3, "#11": 35.8,
}


def _bar_diam(label: str, default: float = 15.9) -> float:
    return _BAR_DIAM_MM.get(str(label).strip(), default)


def _compute_digest(*objs: Any) -> str:
    h = hashlib.sha256()
    for o in objs:
        h.update(json.dumps(o, sort_keys=True, ensure_ascii=False).encode())
    return h.hexdigest()


def _to_float(v: Any, default: float = 0.0) -> float:
    try:
        r = float(v)
        return r if math.isfinite(r) else default
    except (TypeError, ValueError):
        return default


def _vec3_norm(v: list[float]) -> list[float]:
    L = math.sqrt(sum(x * x for x in v))
    return [x / L for x in v] if L > 1e-9 else [1.0, 0.0, 0.0]


def _geom_transf_vec(ji: dict, jj: dict) -> list[float]:
    """
    Vector vecxz para geomTransf de OpenSees.
    Columnas (dz dominante): vecxz = [1, 0, 0]
    Vigas  (dx/dy dominante): vecxz = [0, 0, 1]
    """
    dx = jj.get("x", 0.0) - ji.get("x", 0.0)
    dy = jj.get("y", 0.0) - ji.get("y", 0.0)
    dz = jj.get("z", 0.0) - ji.get("z", 0.0)
    horiz = math.sqrt(dx * dx + dy * dy)
    if abs(dz) > horiz:      # columna
        return [1.0, 0.0, 0.0]
    return [0.0, 0.0, 1.0]  # viga


# ── Constantes físicas ─────────────────────────────────────────────────────────

_G = 9.81   # m/s²


class NLSpecBuilder:
    """
    Uso:
        builder = NLSpecBuilder(canonical, col_detail, beam_detail,
                                user_reinforcement, energy_dissipation)
        spec = builder.build()
    """

    def __init__(
        self,
        canonical:          dict,
        col_detail:         dict,
        beam_detail:        dict,
        user_reinforcement: dict | None = None,
        energy_dissipation: str = "DMO",
        project_id:         str = "",
    ):
        self._m          = canonical
        self._col        = col_detail
        self._bm         = beam_detail
        self._user_r     = user_reinforcement or {}
        self._ed         = energy_dissipation.upper()
        self._project_id = project_id

        # Índices rápidos para búsqueda
        self._col_idx: dict[str, dict] = {
            c["frame_id"]: c
            for c in self._col.get("columns", [])
            if isinstance(c, dict) and "frame_id" in c
        }
        self._bm_idx: dict[str, dict] = {
            b["frame_id"]: b
            for b in self._bm.get("beams", [])
            if isinstance(b, dict) and "frame_id" in b
        }

    # ── Punto de entrada ───────────────────────────────────────────────────────

    def build(self) -> dict:
        materials     = self._build_materials()
        section_types = self._build_section_types()
        nodes         = self._build_nodes()
        stories       = dict(self._m.get("stories", {}))
        masses        = self._build_masses()
        col_elements  = self._build_columns()
        bm_elements   = self._build_beams()
        validation    = self._validate(col_elements, bm_elements)

        digest = _compute_digest(
            self._m.get("joints",    {}),
            self._m.get("frames",    {}),
            self._m.get("sections",  {}),
            self._m.get("materials", {}),
            self._col_idx,
            self._bm_idx,
        )

        n_col_d = sum(1 for e in col_elements.values() if e.get("has_design"))
        n_bm_d  = sum(1 for e in bm_elements.values()  if e.get("has_design"))

        return {
            "schema_version": "1.0",
            "metadata": {
                "project_id":          self._project_id,
                "generated_at":        datetime.now(timezone.utc).isoformat(),
                "source_digest":       digest,
                "n_stories":           len(stories),
                "n_columns":           len(col_elements),
                "n_beams":             len(bm_elements),
                "n_columns_designed":  n_col_d,
                "n_beams_designed":    n_bm_d,
                "energy_dissipation":  self._ed,
                "structure_system":    "RCMRF",
                "units":               "kN_m_MPa",
            },
            "general": {
                "energy_dissipation": self._ed,
                "integration_points": 5,
                "fiber_mesh": {"core_y": 8, "core_z": 8, "cover_y": 4, "cover_z": 4},
            },
            "materials":     materials,
            "section_types": section_types,
            "stories":       stories,
            "masses":        masses,
            "nodes":         nodes,
            "elements": {
                "columns": col_elements,
                "beams":   bm_elements,
            },
            "validation": validation,
        }

    # ── Materiales ─────────────────────────────────────────────────────────────

    def _build_materials(self) -> dict:
        raw_mats = self._m.get("materials", {})
        concrete: dict[str, dict] = {}
        steel:    dict[str, dict] = {}

        for name, md in raw_mats.items():
            fpc = _to_float(md.get("fpc_mpa") or md.get("fc_MPa"), 21.0)
            Ec  = round(4700.0 * math.sqrt(fpc) * 1000.0, 0)  # kN/m²
            mat_type = str(md.get("type", "")).lower()

            if "concrete" in mat_type or "concreto" in mat_type or fpc > 0:
                concrete[name] = {
                    "fc_MPa":  round(fpc, 1),
                    "Ec_kPa":  Ec,
                    "Ec_MPa":  round(Ec / 1000.0, 0),
                    "G_kPa":   round(Ec / (2.0 * 1.2), 0),  # G = Ec/(2(1+ν)), ν=0.2
                    "energy_dissipation": self._ed,
                }
            else:
                fy = _to_float(md.get("fy_mpa") or md.get("fy_MPa"), 420.0)
                steel[name] = {
                    "fy_MPa": round(fy, 1),
                    "Es_MPa": 200_000.0,
                    "fu_MPa": round(fy * 1.5, 0),
                }

        # Si no se encontraron materiales, insertar defaults
        if not concrete:
            concrete["C21"] = {"fc_MPa": 21.0, "Ec_kPa": 19_593_000.0,
                                "Ec_MPa": 19593.0, "G_kPa": 8_163_750.0,
                                "energy_dissipation": self._ed}
        if not steel:
            steel["A420"] = {"fy_MPa": 420.0, "Es_MPa": 200_000.0, "fu_MPa": 630.0}

        return {"concrete": concrete, "steel": steel}

    # ── Tipos de sección (geometría pura, sin refuerzo) ───────────────────────

    def _build_section_types(self) -> dict:
        raw_secs = self._m.get("sections", {})
        raw_mats = self._m.get("materials", {})
        result: dict[str, dict] = {}

        for name, sd in raw_secs.items():
            b   = _to_float(sd.get("b_m") or sd.get("width_m"),  0.30)
            h   = _to_float(sd.get("h_m") or sd.get("height_m"), 0.30)
            mat = str(sd.get("material", ""))
            sec_type = str(sd.get("type", "")).lower()
            kind = "column" if "column" in sec_type or b == h else "beam"

            fpc = 21.0
            if mat and mat in raw_mats:
                fpc = _to_float(raw_mats[mat].get("fpc_mpa") or raw_mats[mat].get("fc_MPa"), 21.0)

            result[name] = {
                "kind":     kind,
                "b_m":      round(b, 4),
                "h_m":      round(h, 4),
                "fc_MPa":   fpc,
                "fy_MPa":   420.0,
                "material_concrete": mat,
                "area_m2":  round(b * h, 6),
                "I33_m4":   round(b * h ** 3 / 12.0, 8),
                "I22_m4":   round(h * b ** 3 / 12.0, 8),
            }
        return result

    # ── Nodos ─────────────────────────────────────────────────────────────────

    def _build_nodes(self) -> dict:
        raw = self._m.get("joints", {})
        result: dict[str, dict] = {}
        for jid, jd in raw.items():
            result[str(jid)] = {
                "x":            round(_to_float(jd.get("x")), 4),
                "y":            round(_to_float(jd.get("y")), 4),
                "z":            round(_to_float(jd.get("z")), 4),
                "story":        str(jd.get("story", "")),
                "is_restrained": bool(jd.get("is_restrained", False)),
            }
        return result

    # ── Masas ─────────────────────────────────────────────────────────────────

    def _build_masses(self) -> dict:
        raw = self._m.get("masses", {})
        result: dict[str, dict] = {}
        for k, md in raw.items():
            result[k] = {
                "story":    str(md.get("story", "")),
                "mass_x_t": round(_to_float(md.get("mass_x_t")), 4),
                "mass_y_t": round(_to_float(md.get("mass_y_t")), 4),
                "mass_rz":  round(_to_float(md.get("mass_rz_tm2")), 4),
                "x_cm_m":   round(_to_float(md.get("x_cm_m")), 4),
                "y_cm_m":   round(_to_float(md.get("y_cm_m")), 4),
                "z_m":      round(_to_float(md.get("z_m")), 4),
                "W_kN":     round(_to_float(md.get("mass_x_t")) * _G, 1),
            }
        return result

    # ── Columnas ──────────────────────────────────────────────────────────────

    def _build_columns(self) -> dict:
        frames  = self._m.get("frames", {})
        joints  = self._m.get("joints", {})
        result: dict[str, dict] = {}

        for fid, fd in frames.items():
            if fd.get("element_type") != "column":
                continue

            ji_d = joints.get(str(fd.get("joint_i", "")), {})
            jj_d = joints.get(str(fd.get("joint_j", "")), {})

            dz = abs(_to_float(jj_d.get("z")) - _to_float(ji_d.get("z")))
            L  = dz if dz > 0.1 else 3.0

            sec  = str(fd.get("section", ""))
            sec_d = self._m.get("sections", {}).get(sec, {})
            mat  = str(sec_d.get("material", ""))
            mats = self._m.get("materials", {})
            fpc  = _to_float(
                (mats.get(mat) or {}).get("fpc_mpa") or
                (mats.get(mat) or {}).get("fc_MPa"), 21.0
            )
            b = _to_float(sec_d.get("b_m"), 0.30)
            h = _to_float(sec_d.get("h_m"), 0.30)

            # Refuerzo: prioridad → user_reinforcement > col_detail > defaults
            design   = self._col_idx.get(fid)
            user_ovr = self._user_r.get(fid)

            reinf, has_design = self._column_reinforcement(
                fid, design, user_ovr, b, h, L, fpc
            )

            # Mander: confinamiento en zona de rótula (s_confined) y zona central
            # (s_general). Las columnas típicamente plastifican en los extremos.
            confinement = self._column_confinement(reinf, b, h, fpc, has_design)

            result[str(fid)] = {
                "node_i":          str(fd.get("joint_i", "")),
                "node_j":          str(fd.get("joint_j", "")),
                "story":           str(fd.get("story", "")),
                "section":         sec,
                "geom_transf_vec": _geom_transf_vec(ji_d, jj_d),
                "geometry": {
                    "b_m":     round(b, 4),
                    "h_m":     round(h, 4),
                    "L_m":     round(L, 3),
                    "fc_MPa":  fpc,
                    "fy_MPa":  420.0,
                    "cover_m": 0.040,
                },
                "reinforcement": reinf,
                "confinement":   confinement,
                "has_design":    has_design,
            }

        return result

    def _column_confinement(
        self,
        reinf:       dict,
        b_m:         float,
        h_m:         float,
        fc_MPa:      float,
        has_design:  bool,
        cover_m:     float = 0.040,
        fy_tie_MPa:  float = 420.0,
    ) -> dict:
        """
        Calcula el confinamiento Mander para la zona de rótula (extremos) y la
        zona central de la columna, a partir del armado del diseño.

        Si no hay diseño (defaults), usa K=1.3 de respaldo.
        """
        if not has_design:
            d_end = default_confinement(fc_MPa)
            d_mid = default_confinement(fc_MPa)
            return {
                "end": confinement_to_dict(d_end),
                "mid": confinement_to_dict(d_mid),
            }

        long_r = reinf.get("longitudinal", {})
        tran   = reinf.get("transverse", {})

        n_bars    = int(long_r.get("n_bars", 8))
        db_long   = _bar_diam(long_r.get("bar_label", "#5"))
        db_tie    = _bar_diam(tran.get("tie_bar_label", "#3"), default=9.5)
        n_legs_b  = int(tran.get("n_legs_b", 2))
        n_legs_h  = int(tran.get("n_legs_h", 2))
        s_conf    = float(tran.get("s_confined_mm", 100.0))
        s_general = float(tran.get("s_general_mm", 200.0))

        end = mander_rect_confinement(
            b_m         = b_m,
            h_m         = h_m,
            cover_m     = cover_m,
            fc_MPa      = fc_MPa,
            fy_tie_MPa  = fy_tie_MPa,
            db_tie_mm   = db_tie,
            s_mm        = s_conf,
            n_legs_b    = n_legs_b,
            n_legs_h    = n_legs_h,
            n_long_bars = n_bars,
            db_long_mm  = db_long,
            source      = "designed",
        )
        mid = mander_rect_confinement(
            b_m         = b_m,
            h_m         = h_m,
            cover_m     = cover_m,
            fc_MPa      = fc_MPa,
            fy_tie_MPa  = fy_tie_MPa,
            db_tie_mm   = db_tie,
            s_mm        = s_general,
            n_legs_b    = n_legs_b,
            n_legs_h    = n_legs_h,
            n_long_bars = n_bars,
            db_long_mm  = db_long,
            source      = "designed",
        )
        return {
            "end": confinement_to_dict(end),
            "mid": confinement_to_dict(mid),
        }

    def _column_reinforcement(
        self,
        fid: str,
        design: dict | None,
        user_ovr: dict | None,
        b: float,
        h: float,
        L: float,
        fc: float,
    ) -> tuple[dict, bool]:
        # Usar override del usuario si existe
        if user_ovr:
            long_r  = user_ovr.get("longitudinal", {})
            trans_r = user_ovr.get("transverse", {})
            return {
                "longitudinal": {
                    "n_bars":    int(long_r.get("n_bars", 8)),
                    "bar_label": str(long_r.get("bar_label", "#6")),
                    "As_cm2":    round(_to_float(long_r.get("As_placed_cm2", 15.8)), 2),
                },
                "transverse": {
                    "tie_bar_label":     str(trans_r.get("tie_bar_label", "#3")),
                    "n_legs_b":          int(trans_r.get("n_legs_b", 2)),
                    "n_legs_h":          int(trans_r.get("n_legs_h", 2)),
                    "s_confined_mm":     int(trans_r.get("s_confined_mm", 100)),
                    "s_general_mm":      int(trans_r.get("s_general_mm", 200)),
                    "L_confinement_mm":  int(trans_r.get("L_confinement_mm",
                                             max(b, h) * 1000)),
                    "energy_dissipation": self._ed,
                },
            }, True

        # Usar resultado del designer
        if design:
            pr   = design.get("final_reinforcement") or design.get("proposed_reinforcement", {})
            long = pr.get("longitudinal", {})
            tran = pr.get("transverse", {})
            return {
                "longitudinal": {
                    "n_bars":    int(long.get("n_bars", 8)),
                    "bar_label": str(long.get("bar_label", "#6")),
                    "As_cm2":    round(_to_float(long.get("As_placed_cm2", 0)), 2),
                },
                "transverse": {
                    "tie_bar_label":     str(tran.get("tie_bar_label", "#3")),
                    "n_legs_b":          int(tran.get("n_legs_b", 2)),
                    "n_legs_h":          int(tran.get("n_legs_h", 2)),
                    "s_confined_mm":     int(tran.get("s_confined_mm", 100)),
                    "s_general_mm":      int(tran.get("s_general_mm", 200)),
                    "L_confinement_mm":  int(tran.get("L_confinement_mm",
                                             max(b, h) * 1000)),
                    "energy_dissipation": self._ed,
                },
            }, True

        # Sin diseño: defaults mínimos NSR-10 ρ=1%
        Ag_cm2 = (b * 100) * (h * 100)
        As_def = max(Ag_cm2 * 0.01, 10.0)
        n_def  = max(4, int(As_def / 2.85))   # ~#5 barras
        return {
            "longitudinal": {
                "n_bars":    n_def,
                "bar_label": "#5",
                "As_cm2":    round(As_def, 2),
            },
            "transverse": {
                "tie_bar_label":     "#3",
                "n_legs_b":          2,
                "n_legs_h":          2,
                "s_confined_mm":     100,
                "s_general_mm":      200,
                "L_confinement_mm":  int(max(b, h) * 1000),
                "energy_dissipation": self._ed,
            },
        }, False

    # ── Vigas ──────────────────────────────────────────────────────────────────

    def _build_beams(self) -> dict:
        frames = self._m.get("frames", {})
        joints = self._m.get("joints", {})
        result: dict[str, dict] = {}

        for fid, fd in frames.items():
            if fd.get("element_type") != "beam":
                continue

            ji_d = joints.get(str(fd.get("joint_i", "")), {})
            jj_d = joints.get(str(fd.get("joint_j", "")), {})
            dx   = _to_float(jj_d.get("x")) - _to_float(ji_d.get("x"))
            dy   = _to_float(jj_d.get("y")) - _to_float(ji_d.get("y"))
            L    = math.sqrt(dx * dx + dy * dy)
            L    = L if L > 0.1 else 3.0

            sec  = str(fd.get("section", ""))
            sec_d = self._m.get("sections", {}).get(sec, {})
            mat  = str(sec_d.get("material", ""))
            mats = self._m.get("materials", {})
            fpc  = _to_float(
                (mats.get(mat) or {}).get("fpc_mpa") or
                (mats.get(mat) or {}).get("fc_MPa"), 21.0
            )
            b = _to_float(sec_d.get("b_m"), 0.30)
            h = _to_float(sec_d.get("h_m"), 0.40)

            design   = self._bm_idx.get(fid)
            user_ovr = self._user_r.get(fid)

            reinf, has_design = self._beam_reinforcement(
                fid, design, user_ovr, b, h, L, fpc
            )

            confinement = self._beam_confinement(reinf, b, h, fpc, has_design)

            result[str(fid)] = {
                "node_i":          str(fd.get("joint_i", "")),
                "node_j":          str(fd.get("joint_j", "")),
                "story":           str(fd.get("story", "")),
                "section":         sec,
                "geom_transf_vec": _geom_transf_vec(ji_d, jj_d),
                "length_m":        round(L, 3),
                "geometry": {
                    "b_m":     round(b, 4),
                    "h_m":     round(h, 4),
                    "L_m":     round(L, 3),
                    "fc_MPa":  fpc,
                    "fy_MPa":  420.0,
                    "cover_m": 0.040,
                },
                "reinforcement": reinf,
                "confinement":   confinement,
                "has_design":    has_design,
            }

        return result

    def _beam_confinement(
        self,
        reinf:       dict,
        b_m:         float,
        h_m:         float,
        fc_MPa:      float,
        has_design:  bool,
        cover_m:     float = 0.040,
        fy_tie_MPa:  float = 420.0,
    ) -> dict:
        """
        Confinamiento Mander para vigas: zona de rótula en extremos
        (s_confined, L=2h) y zona central (s_central).

        Para el conteo de barras perimetrales se suma top+bot de la zona end_i
        (zona crítica donde se forma la rótula plástica negativa).
        """
        if not has_design:
            d_end = default_confinement(fc_MPa)
            d_mid = default_confinement(fc_MPa)
            return {
                "end": confinement_to_dict(d_end),
                "mid": confinement_to_dict(d_mid),
            }

        shear  = reinf.get("shear", {})
        zones  = reinf.get("zones", {})
        end_i  = zones.get("end_i", {})
        mid_z  = zones.get("mid",   {})

        top_i = end_i.get("top", {})
        bot_i = end_i.get("bot", {})
        top_m = mid_z.get("top", {})
        bot_m = mid_z.get("bot", {})

        # Total de barras perimetrales (top + bot). Promedio ponderado del
        # diámetro para asumir un db_long representativo.
        n_top = int(top_i.get("n_bars", 2))
        n_bot = int(bot_i.get("n_bars", 2))
        n_bars_end = max(n_top + n_bot, 4)
        n_top_m = int(top_m.get("n_bars", 2))
        n_bot_m = int(bot_m.get("n_bars", 2))
        n_bars_mid = max(n_top_m + n_bot_m, 4)

        db_top = _bar_diam(top_i.get("bar_label", "#5"))
        db_bot = _bar_diam(bot_i.get("bar_label", "#5"))
        db_long = (n_top * db_top + n_bot * db_bot) / max(n_top + n_bot, 1)

        db_tie    = _bar_diam(shear.get("tie_bar_label", "#3"), default=9.5)
        n_legs    = int(shear.get("n_legs", 2))
        # En vigas los estribos típicamente tienen 2 ramas en cada dirección
        # (estribo cerrado simple). Si hay más de 2 legs reportados, se asumen
        # ramas intermedias (grapas) distribuidas en ambas direcciones.
        n_legs_b = n_legs                 # ramas verticales (atan h)
        n_legs_h = max(2, n_legs // 2)    # ramas horizontales (atan b)
        s_conf   = float(shear.get("s_confined_mm", 100.0))
        s_mid    = float(shear.get("s_central_mm",   200.0))

        end = mander_rect_confinement(
            b_m         = b_m,
            h_m         = h_m,
            cover_m     = cover_m,
            fc_MPa      = fc_MPa,
            fy_tie_MPa  = fy_tie_MPa,
            db_tie_mm   = db_tie,
            s_mm        = s_conf,
            n_legs_b    = n_legs_b,
            n_legs_h    = n_legs_h,
            n_long_bars = n_bars_end,
            db_long_mm  = db_long,
            source      = "designed",
        )
        mid = mander_rect_confinement(
            b_m         = b_m,
            h_m         = h_m,
            cover_m     = cover_m,
            fc_MPa      = fc_MPa,
            fy_tie_MPa  = fy_tie_MPa,
            db_tie_mm   = db_tie,
            s_mm        = s_mid,
            n_legs_b    = n_legs_b,
            n_legs_h    = n_legs_h,
            n_long_bars = n_bars_mid,
            db_long_mm  = db_long,
            source      = "designed",
        )
        return {
            "end": confinement_to_dict(end),
            "mid": confinement_to_dict(mid),
        }

    def _beam_reinforcement(
        self,
        fid: str,
        design: dict | None,
        user_ovr: dict | None,
        b: float,
        h: float,
        L: float,
        fc: float,
    ) -> tuple[dict, bool]:
        # Override manual del usuario
        if user_ovr:
            return self._beam_reinf_from_user(user_ovr, b, h), True

        if design:
            return self._beam_reinf_from_design(design, b, h), True

        # Defaults mínimos NSR-10
        return self._beam_reinf_defaults(b, h), False

    def _beam_reinf_from_design(self, d: dict, b: float, h: float) -> dict:
        rbz = d.get("reinforcement_by_zone", {})
        sh  = d.get("shear_design") or d.get("proposed_reinforcement", {}).get("stirrups", {})

        def _zone(z: str) -> dict:
            zd = rbz.get(z, {})
            top = zd.get("top", {})
            bot = zd.get("bot", {})
            return {
                "top": {
                    "n_bars":    int(top.get("n_bars", 2)),
                    "bar_label": str(top.get("bar_label", "#5")),
                    "As_cm2":    round(_to_float(top.get("As_placed_cm2", 0)), 2),
                },
                "bot": {
                    "n_bars":    int(bot.get("n_bars", 2)),
                    "bar_label": str(bot.get("bar_label", "#5")),
                    "As_cm2":    round(_to_float(bot.get("As_placed_cm2", 0)), 2),
                },
            }

        # Estribos desde shear_design (estructura real) o proposed_reinforcement.stirrups
        tie_label = str(sh.get("tie_bar_label", "#3"))
        n_legs    = int(sh.get("n_legs", 2))
        ze = sh.get("zone_end", sh.get("zone_end", {}))
        zm = sh.get("zone_mid", sh.get("zone_mid", {}))
        s_conf   = int(_to_float(ze.get("s_mm", 100)))
        s_central = int(_to_float(zm.get("s_mm", 200)))
        L_conf   = int(2.0 * h * 1000)  # 2h desde cada apoyo

        return {
            "zones": {
                "end_i": _zone("end_i"),
                "mid":   _zone("mid"),
                "end_j": _zone("end_j"),
            },
            "shear": {
                "tie_bar_label":    tie_label,
                "n_legs":           n_legs,
                "s_confined_mm":    s_conf,
                "s_central_mm":     s_central,
                "L_confinement_mm": L_conf,
                "energy_dissipation": self._ed,
            },
        }

    def _beam_reinf_from_user(self, u: dict, b: float, h: float) -> dict:
        def _zone(z: dict) -> dict:
            top = z.get("top", {})
            bot = z.get("bot", {})
            return {
                "top": {"n_bars": int(top.get("n_bars", 2)),
                        "bar_label": str(top.get("bar_label", "#5")),
                        "As_cm2": round(_to_float(top.get("As_cm2", 0)), 2)},
                "bot": {"n_bars": int(bot.get("n_bars", 2)),
                        "bar_label": str(bot.get("bar_label", "#5")),
                        "As_cm2": round(_to_float(bot.get("As_cm2", 0)), 2)},
            }
        zones = u.get("zones", {})
        sh    = u.get("shear", {})
        return {
            "zones": {
                "end_i": _zone(zones.get("end_i", {})),
                "mid":   _zone(zones.get("mid",   {})),
                "end_j": _zone(zones.get("end_j", {})),
            },
            "shear": {
                "tie_bar_label":    str(sh.get("tie_bar_label", "#3")),
                "n_legs":           int(sh.get("n_legs", 2)),
                "s_confined_mm":    int(sh.get("s_confined_mm", 100)),
                "s_central_mm":     int(sh.get("s_central_mm", 200)),
                "L_confinement_mm": int(sh.get("L_confinement_mm", 2 * h * 1000)),
                "energy_dissipation": self._ed,
            },
        }

    def _beam_reinf_defaults(self, b: float, h: float) -> dict:
        # Mínimo NSR-10 C.18.6.3
        As_min = max(0.25 * math.sqrt(21.0) * b * 100 * h * 100 / 420.0, 1.4 * b * 100 * h * 100 / 420.0)
        As_min = round(max(As_min, 2.0), 2)
        def _z() -> dict:
            return {
                "top": {"n_bars": 2, "bar_label": "#5", "As_cm2": As_min},
                "bot": {"n_bars": 2, "bar_label": "#5", "As_cm2": As_min},
            }
        return {
            "zones": {"end_i": _z(), "mid": _z(), "end_j": _z()},
            "shear": {
                "tie_bar_label": "#3", "n_legs": 2,
                "s_confined_mm": 100, "s_central_mm": 200,
                "L_confinement_mm": int(2 * h * 1000),
                "energy_dissipation": self._ed,
            },
        }

    # ── Validación ─────────────────────────────────────────────────────────────

    def _validate(self, cols: dict, beams: dict) -> dict:
        n_col_nd = sum(1 for e in cols.values()  if not e.get("has_design"))
        n_bm_nd  = sum(1 for e in beams.values() if not e.get("has_design"))
        warnings: list[str] = []

        if n_col_nd > 0:
            warnings.append(
                f"{n_col_nd} columna(s) sin diseño detallado — se usó refuerzo mínimo NSR-10 ρ=1%."
            )
        if n_bm_nd > 0:
            warnings.append(
                f"{n_bm_nd} viga(s) sin diseño detallado — se usó refuerzo mínimo NSR-10."
            )
        if not cols and not beams:
            warnings.append("No se encontraron elementos frame en el modelo canónico.")

        return {
            "n_columns_no_design":  n_col_nd,
            "n_beams_no_design":    n_bm_nd,
            "n_warnings":           len(warnings),
            "ready_for_analysis":   len(warnings) == 0,
            "warnings":             warnings,
        }
