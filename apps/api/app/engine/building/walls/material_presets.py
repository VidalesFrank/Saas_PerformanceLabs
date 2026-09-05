"""
Material presets for RC wall models — PerformanceLabs wall analysis module.

Ported and adapted from RCW-3D/backend/material_presets.py.
All stress/stiffness values in kPa (kN/m²) to match OpenSees kN·m unit system.
MPa inputs are preserved in the public API for readability; conversion is internal.

Supported material kinds:
  ConcreteCM   — Chang-Mander concrete model (recommended for walls, E-SFI-MVLEM-3D)
  Concrete02   — Kent-Scott-Park with linear tension softening (simpler, MVLEM_3D)
  Hysteretic   — Multi-linear hysteretic steel (reinforcing bars, WWM)
  HystereticSM — As Hysteretic but with min/max strain tracking
  Elastic      — Linear elastic (coupling beams, verification models)

Colombian presets cover f'c ∈ {21, 28, 35, 42} MPa and fy ∈ {420, 490} MPa,
calibrated against NSR-10 Table C.10.15.3 and Carrillo-Alcocer (2012) test data.
"""
from __future__ import annotations

import math
from typing import Any, Literal

PRESETS_VERSION = "wrc-presets-v1.0"

# Tabulated rc factor for ConcreteCM from Carrillo-Alcocer (2012)
_CONCRETECM_STRENGTHS = (21, 28, 35, 42)
_RC_UNCONFINED        = (18.8, 22.6, 25.8, 28.8)
_RC_CONFINED          = (6.35, 7.25, 8.17, 9.0)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _ec_mpa(fc_mpa: float) -> float:
    return 4300.0 * math.sqrt(fc_mpa)


def _regularized_e20(
    fracture_energy: float,
    element_length_mm: float,
    integration_points: int,
    fc_mpa: float,
    ec_mpa: float,
    peak_strain: float,
) -> float:
    """Audited e20Lobatto2 from opseestools.col_materials."""
    lobatto = {3: 1 / 3, 4: 1 / 6, 5: 1 / 10, 6: 1 / 15}.get(integration_points, 0.2)
    il = element_length_mm / 2.0 * lobatto
    return fracture_energy / (0.6 * fc_mpa * il) - 0.8 * fc_mpa / ec_mpa + peak_strain


def _dhakal_envelope(
    fy_mpa: float, spacing_to_diameter: float
) -> tuple[list[list[float]], list[list[float]]]:
    """Audited Dhakal buckling envelope — parameter port from opseestools."""
    fu = 1.4 * fy_mpa
    fh = fy_mpa + 0.01
    ey = fy_mpa / 200_000.0
    eh, eu = 0.01, 0.1
    Es = fy_mpa / ey
    post_slope = -0.02 * Es

    def harden(e: float) -> float:
        if e <= eh:
            return fh
        if e >= eu:
            return fu
        return fh + (fu - fh) * (e - eh) / (eu - eh)

    eas = max((55.0 - 2.3 * math.sqrt(fy_mpa / 100.0) * spacing_to_diameter) * ey, 7.0 * ey)
    sL  = harden(eas)
    sas = max(0.75 * (1.1 - 0.016 * math.sqrt(fy_mpa / 100.0) * spacing_to_diameter) * sL, 0.2 * fy_mpa)
    su  = 0.2 * fy_mpa
    eu_d = (su - sas) / post_slope + eas
    positive = [
        [fy_mpa * 1000.0, ey], [fh * 1000.0, eh],
        [harden(0.05) * 1000.0, 0.05], [su * 1000.0, eu],
    ]
    negative = [
        [-fy_mpa * 1000.0, -ey], [-harden(0.004) * 1000.0, -0.004],
        [-sas * 1000.0, -eas], [-su * 1000.0, -eu_d],
    ]
    return positive, negative


def _provenance(source: str, inputs: dict) -> dict:
    return {"source": source, "inputs": inputs, "version": PRESETS_VERSION}


# ── ConcreteCM presets (kPa, m) ───────────────────────────────────────────────

def colombian_concretecm_presets() -> dict[str, dict[str, Any]]:
    """
    Eight locked ConcreteCM presets for Colombian practice.

    Stresses in kPa, strains dimensionless — ready for OpenSees kN·m system.
    rc tabulated from Carrillo & Alcocer (2012) wall test series.
    """
    presets: dict[str, dict[str, Any]] = {}
    for fc_mpa, rc_u, rc_c in zip(_CONCRETECM_STRENGTHS, _RC_UNCONFINED, _RC_CONFINED):
        ec_mpa       = _ec_mpa(fc_mpa)
        fc_conf_mpa  = 1.30 * fc_mpa
        eps_u        = 2.0 * fc_mpa     / ec_mpa
        eps_c        = 2.0 * fc_conf_mpa / ec_mpa

        for tag, strength, eps, rc, label in (
            ("unconfined", fc_mpa,      eps_u, rc_u, "sin confinar"),
            ("confined",   fc_conf_mpa, eps_c, rc_c, "confinado 1.3fc"),
        ):
            mid = f"concretecm_{fc_mpa}_{tag}"
            presets[mid] = {
                "id":   mid,
                "name": f"ConcreteCM {fc_mpa} MPa {label}",
                "kind": "ConcreteCM",
                "mode": "preset",
                # kPa (×1000 from MPa)
                "fpcc":     -strength * 1000.0,
                "epcc":     -eps,
                "Ec":        ec_mpa   * 1000.0,
                "rc":        rc,
                "xcrn":      1.04,
                "ft":        0.001 * fc_mpa * 1000.0,
                "et":        0.00008,
                "rt":        1.2,
                "xcrp":      100.0,
                "gapClose":  0,
                "unitWeight": 24.0,
                "provenance": _provenance(
                    "colombian-concretecm-v1",
                    {"fcMPa": fc_mpa, "confinement": tag},
                ),
            }
    return presets


# ── Concrete02 + HystereticSM set (MVLEM_3D basic) ───────────────────────────

def colombian_mvlem_basic_set(
    fc_mpa:   float  = 28.0,
    fy_mpa:   float  = 420.0,
    detailing: Literal["DMO", "PreCode", "DES"] = "DES",
    tension:  bool   = True,
    id_prefix: str   = "mvlem_basic",
) -> dict[str, dict[str, Any]]:
    """
    Concrete02 (unconfined + confined) + HystereticSM steel for MVLEM_3D.

    Parameters are derived from opseestools.col_materials using the Dhakal (2002)
    buckling envelope for the steel and a regularized concrete ultimate strain.
    """
    if fc_mpa <= 0 or fy_mpa <= 0:
        raise ValueError("fc and fy must be positive")
    confinement   = {"DMO": 1.25, "PreCode": 1.01, "DES": 1.30}[detailing]
    spacing_ratio = {"DMO": 8.0,  "PreCode": 20.0,  "DES": 6.0}[detailing]
    prov_inputs   = {"fcMPa": fc_mpa, "fyMPa": fy_mpa, "detailing": detailing, "tension": tension}

    def make_concrete(mat_id: str, name: str, strength_mpa: float, Gf: float) -> dict:
        ec     = _ec_mpa(strength_mpa)
        eps0   = 2.0 * strength_mpa / ec
        eps_cu = _regularized_e20(Gf, 3000.0, 5, strength_mpa, ec, eps0)
        return {
            "id": mat_id, "name": name, "kind": "Concrete02", "mode": "basic",
            "fpc":  -strength_mpa * 1000.0,
            "epsc0": -eps0,
            "fpcu": -0.2 * strength_mpa * 1000.0,
            "epsU": -eps_cu,
            "lamb":  0.1,
            "ft":   (0.1 * strength_mpa * 1000.0) if tension else 0.0,
            "Ets":  (0.1 * ec         * 1000.0) if tension else 0.0,
            "unitWeight": 24.0,
            "provenance": _provenance("opseestools.col_materials", prov_inputs),
        }

    uid = f"{id_prefix}_concrete_unconfined"
    cid = f"{id_prefix}_concrete_confined"
    sid = f"{id_prefix}_steel"
    positive, negative = _dhakal_envelope(fy_mpa, spacing_ratio)
    return {
        uid: make_concrete(uid, f"Basic {fc_mpa:g} MPa unconfined",  fc_mpa, fc_mpa),
        cid: make_concrete(cid, f"Basic {fc_mpa:g} MPa {detailing} confined", confinement * fc_mpa, 2.0 * confinement * fc_mpa),
        sid: {
            "id": sid, "name": f"Basic {fy_mpa:g} MPa {detailing} rebar", "kind": "HystereticSM", "mode": "basic",
            "positive": positive, "negative": negative,
            "pinchX": 1.0, "pinchY": 1.0, "damage1": 0.0, "damage2": 0.0, "beta": 0.0,
            "provenance": _provenance("opseestools.col_materials", prov_inputs),
        },
    }


# ── Named presets (bars & WWM) ────────────────────────────────────────────────

def reinforcing_bar_preset(fy_mpa: Literal[420, 490] = 420) -> dict[str, Any]:
    """Standard Hysteretic model for Colombian deformed bar (RC-WIAP calibration)."""
    fy = float(fy_mpa) * 1000.0   # kPa
    Es = 210_000_000.0             # kPa
    fu = 630_000.0 if fy_mpa == 420 else 735_000.0
    return {
        "id":   f"steel_bar_{fy_mpa}",
        "name": f"Barra corrugada {fy_mpa} MPa (RC-WIAP)",
        "kind": "Hysteretic",
        "mode": "preset",
        "positive": [[fy, fy / Es], [fu, 0.10], [0.05 * fy, 0.11]],
        "negative": [[-fy, -fy / Es], [-fu, -0.10], [-0.05 * fy, -0.11]],
        "pinchX":  1.0, "pinchY": 1.0,
        "damage1": 0.0, "damage2": 0.0, "beta": 0.0,
        "minStrain": -0.006, "maxStrain": 0.05,
        "provenance": _provenance("named-preset", {"name": "RC-WIAP bar", "fyMPa": fy_mpa}),
    }


def wwm_reinforcement_preset() -> dict[str, Any]:
    """Welded wire mesh Hysteretic model (RC-WIAP calibration)."""
    return {
        "id":   "steel_wwm_rc_wiap",
        "name": "Malla electrosoldada (RC-WIAP)",
        "kind": "Hysteretic",
        "mode": "preset",
        "positive": [[509_100.0, 0.00248], [691_500.0, 0.005], [734_440.0, 0.01]],
        "negative": [[-509_100.0, -0.00248], [-691_500.0, -0.005], [-734_440.0, -0.01]],
        "pinchX":  0.34, "pinchY": 0.56,
        "damage1": 0.038, "damage2": 0.07, "beta": 0.086,
        "minStrain": -0.006, "maxStrain": 0.0186,
        "provenance": _provenance("named-preset", {"name": "RC-WIAP WWM", "locked": True}),
    }


def elastic_wall_shear_material(
    material_id: str,
    fc_mpa:      float,
    wall_length: float,
    thickness:   float,
    alpha:       float = 1.0,
) -> dict[str, Any]:
    """Linear-elastic shear spring for coupling beams and verification models."""
    if min(fc_mpa, wall_length, thickness, alpha) <= 0:
        raise ValueError("All physical inputs must be positive")
    Gc_kpa    = _ec_mpa(fc_mpa) * 1000.0 / (2.0 * 1.2)
    stiffness = alpha * Gc_kpa * wall_length * thickness
    return {
        "id":        material_id,
        "name":      f"Resorte cortante elástico α={alpha:g}",
        "kind":      "Elastic",
        "mode":      "derived",
        "stiffness": stiffness,
        "provenance": _provenance(
            "elastic-wall-shear",
            {"fcMPa": fc_mpa, "wallLengthM": wall_length, "thicknessM": thickness, "alpha": alpha},
        ),
    }


# ── Default catalog ───────────────────────────────────────────────────────────

def default_material_catalog() -> dict[str, dict[str, Any]]:
    """
    Starter material catalog for a new wall project.

    Includes ConcreteCM 28 MPa (confined + unconfined) and two steel presets.
    The user can add more from the full preset list or define custom materials.
    """
    concretes = colombian_concretecm_presets()
    catalog: dict[str, dict[str, Any]] = {
        "concretecm_28_unconfined": concretes["concretecm_28_unconfined"],
        "concretecm_28_confined":   concretes["concretecm_28_confined"],
    }
    bar = reinforcing_bar_preset(420)
    wwm = wwm_reinforcement_preset()
    catalog[bar["id"]] = bar
    catalog[wwm["id"]] = wwm
    return catalog


def all_concretecm_presets_list() -> list[dict[str, Any]]:
    """Return all 8 ConcreteCM presets as a list for the UI picker."""
    return list(colombian_concretecm_presets().values())
