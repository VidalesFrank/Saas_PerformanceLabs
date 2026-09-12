"""
Servicio de variantes de diseño de muros RC.

Una variante es un conjunto de overrides sobre el diseño base (wall_design_results.json)
que permiten proponer cambios a pieres específicos sin destruir el baseline.

Cada variante se persiste en `results/wall_design_variants.json` y puede ser
analizada con un pushover no lineal completo comparable al baseline.

Campos de override soportados por pier:
  - be_n_bars    (int)    número de barras del elemento de borde
  - be_db_mm     (float)  diámetro de barras EBE (mm)
  - rho_v_pct    (float)  cuantía vertical del alma (%)
  - rho_h_pct    (float)  cuantía horizontal del alma (%)
  - fc_mpa       (float)  resistencia del concreto (MPa, opcional)
  - fy_mpa       (float)  resistencia del acero (MPa, opcional)
  - notes        (str)    comentario libre
"""
from __future__ import annotations

import copy
import json
import os
from datetime import datetime, timezone
from pathlib import Path

_VARIANTS_FILE = "wall_design_variants.json"


# ── Modelo de datos ──────────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _variant_id() -> str:
    return "v_" + datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S_%f")[:-3]


def _key(pier: str, story: str) -> str:
    return f"{pier}|{story}"


def _empty_store() -> dict:
    return {"variants": []}


# ── Persistencia ─────────────────────────────────────────────────────────────

def _path(work_dir: str) -> str:
    return os.path.join(work_dir, "results", _VARIANTS_FILE)


def load_variants(work_dir: str) -> dict:
    p = _path(work_dir)
    if not os.path.exists(p):
        return _empty_store()
    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
        if "variants" not in data:
            data["variants"] = []
        return data
    except (json.JSONDecodeError, OSError):
        return _empty_store()


def save_variants(work_dir: str, data: dict) -> None:
    p = Path(_path(work_dir))
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(p)


# ── Operaciones CRUD ──────────────────────────────────────────────────────────

def list_variants(work_dir: str) -> list[dict]:
    return load_variants(work_dir).get("variants", [])


def get_variant(work_dir: str, variant_id: str) -> dict | None:
    return next(
        (v for v in list_variants(work_dir) if v["variant_id"] == variant_id),
        None,
    )


def create_variant(
    work_dir:    str,
    name:        str,
    description: str = "",
    based_on:    str = "baseline",
) -> dict:
    """Crea una variante vacía (sin overrides todavía) y la persiste."""
    data = load_variants(work_dir)
    variant = {
        "variant_id":  _variant_id(),
        "created_at":  _now_iso(),
        "updated_at":  _now_iso(),
        "name":        name.strip() or "Sin nombre",
        "description": description,
        "based_on":    based_on,
        "overrides":   {},
        "status":      "draft",
        "analysis_job_id":    None,
        "analysis_result_path": None,
    }
    data["variants"].append(variant)
    save_variants(work_dir, data)
    return variant


def update_variant(
    work_dir:    str,
    variant_id:  str,
    updates:     dict,
) -> dict:
    """
    Actualiza campos de una variante. Los `overrides` en updates se hacen MERGE
    con los existentes (no reemplazan). Para eliminar un override, envíalo como
    `{pier|story: null}`.
    """
    data = load_variants(work_dir)
    variant = next((v for v in data["variants"] if v["variant_id"] == variant_id), None)
    if variant is None:
        raise KeyError(f"Variante {variant_id} no encontrada")

    for field in ("name", "description"):
        if field in updates:
            variant[field] = updates[field]

    if "overrides" in updates:
        incoming = updates["overrides"] or {}
        for k, v in incoming.items():
            if v is None:
                variant["overrides"].pop(k, None)
            else:
                variant["overrides"][k] = {
                    **variant["overrides"].get(k, {}),
                    **v,
                }

    variant["updated_at"] = _now_iso()
    # Si se cambiaron overrides, el análisis previo queda invalidado
    if "overrides" in updates and variant.get("status") == "analyzed":
        variant["status"] = "draft"
        variant["analysis_job_id"] = None
        variant["analysis_result_path"] = None

    save_variants(work_dir, data)
    return variant


def delete_variant(work_dir: str, variant_id: str) -> bool:
    data = load_variants(work_dir)
    before = len(data["variants"])
    data["variants"] = [v for v in data["variants"] if v["variant_id"] != variant_id]
    save_variants(work_dir, data)
    return len(data["variants"]) < before


# ── Aplicación de overrides al diseño base ────────────────────────────────────

def apply_overrides(baseline_designs: list[dict], overrides: dict) -> list[dict]:
    """
    Aplica overrides sobre las filas de diseño baseline y devuelve una NUEVA lista.
    No modifica el input.

    Campos soportados por override:
      be_n_bars, be_db_mm, rho_v_pct, rho_h_pct, fc_mpa (opcional), fy_mpa (opcional)
    """
    out: list[dict] = []
    for row in baseline_designs:
        k  = _key(row["pier"], row["story"])
        ov = overrides.get(k)
        if not ov:
            out.append(dict(row))
            continue
        new_row = dict(row)
        for field in ("be_n_bars", "be_db_mm", "rho_v_pct", "rho_h_pct", "fc_mpa", "fy_mpa"):
            if field in ov and ov[field] is not None:
                new_row[field] = ov[field]
        # Recalcular DCR estimado si cambió refuerzo — dejar en manos del re-análisis.
        # Aquí solo actualizamos los campos crudos.
        out.append(new_row)
    return out


def estimate_capacity_delta(
    baseline_row: dict,
    override:     dict,
) -> dict:
    """
    Preview rápida (sin OpenSees) del impacto teórico del override en la capacidad.
    Devuelve deltas relativos aproximados de φMn y φVn para el frontend.

    Aproximaciones:
      - φMn escala con (As_be_new / As_be_baseline)^0.85 (dominado por barras EBE)
      - φVn escala linealmente con rho_h nueva/baseline (aproximación NSR-10 C.21.9)
    """
    import math

    Δmn_pct = 0.0
    Δvn_pct = 0.0

    n0 = float(baseline_row.get("be_n_bars", 0) or 0)
    d0 = float(baseline_row.get("be_db_mm", 0) or 0)
    n1 = float(override.get("be_n_bars", n0))
    d1 = float(override.get("be_db_mm", d0))
    if n0 > 0 and d0 > 0:
        as0 = n0 * math.pi * (d0/2)**2
        as1 = n1 * math.pi * (d1/2)**2
        Δmn_pct = ((as1/as0) ** 0.85 - 1.0) * 100.0

    rh0 = float(baseline_row.get("rho_h_pct", 0) or 0)
    rh1 = float(override.get("rho_h_pct", rh0))
    if rh0 > 0:
        Δvn_pct = (rh1 / rh0 - 1.0) * 100.0

    return {
        "delta_phi_Mn_pct": round(Δmn_pct, 1),
        "delta_phi_Vn_pct": round(Δvn_pct, 1),
    }
