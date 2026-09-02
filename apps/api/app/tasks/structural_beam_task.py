"""
Tarea Celery — Módulo 1: Diseño completo de vigas rectangulares (NSR-10 B.3.4 + ACI 318).

Produce dos archivos:
  - beam_design_results.json   (resumen por viga, compatible con versión anterior)
  - beam_design_detail.json    (detalle completo: zonas, barras, cortante, chequeos)

Requiere:
  - structural_model.json  (canonical_model_path)
  - spectral_results.json  (results/spectral_results.json)
  - parameters_json["combinations"] — IDs seleccionados por el usuario
"""
import json
import math
import os
import traceback

from app.tasks.celery_app import celery_app
from app.tasks.structural_helpers import (
    get_db_session, mark_running, mark_success, mark_failed,
)


@celery_app.task(name="app.tasks.structural_beam_task.run_design_beams", bind=True)
def run_design_beams(
    self,
    job_id: str,
    project_id: str,
    input_file: str | None,
    e2k_file: str | None = None,
    parameters_dict: dict | None = None,
    extra_params: dict | None = None,
):
    """Diseño de vigas por envolvente de combinaciones NSR-10."""
    db = get_db_session()
    try:
        mark_running(db, job_id)

        from app.models import StructuralProject
        from engine.building.design.combinations import NSR10_COMBINATIONS, DEFAULT_SELECTED_IDS
        from engine.building.design.beam_check import (
            parse_beam_section, beam_span,
            distribute_gravity_beams, distribute_seismic_beams, check_beam,
        )
        from engine.building.design.beam_designer import BeamDesigner, classify_beam_topology

        # ── 1. Cargar proyecto y archivos ─────────────────────────────────────
        project = db.get(StructuralProject, project_id)
        if not project or not project.canonical_model_path:
            raise FileNotFoundError("Modelo canónico no disponible.")

        canonical_path = project.canonical_model_path
        work_dir       = os.path.dirname(os.path.dirname(canonical_path))
        spectral_path  = os.path.join(work_dir, "results", "spectral_results.json")

        if not os.path.exists(spectral_path):
            raise FileNotFoundError("Resultados espectrales no encontrados.")

        with open(canonical_path, "r", encoding="utf-8") as f:
            model = json.load(f)
        with open(spectral_path, "r", encoding="utf-8") as f:
            spectral = json.load(f)

        params = parameters_dict or (json.loads(project.parameters_json) if project.parameters_json else {})

        # ── 2. Combinaciones seleccionadas ────────────────────────────────────
        selected_ids = params.get("combinations", DEFAULT_SELECTED_IDS)
        combo_map    = {c["id"]: c for c in NSR10_COMBINATIONS}
        combinations = [combo_map[cid] for cid in selected_ids if cid in combo_map]
        print(f"[beam_design] {len(combinations)} combinaciones activas")

        # ── 3. Estructuras del modelo ─────────────────────────────────────────
        frames_raw  = model.get("frames", {})
        joints_raw  = model.get("joints", {})
        stories_raw = model.get("stories", {})
        masses_raw  = model.get("masses", {})
        sections    = model.get("sections", {})
        materials   = model.get("materials", {})

        stories_sorted = sorted(
            stories_raw.items(),
            key=lambda kv: kv[1].get("elevation_m", 0.0)
        )
        story_order = [name for name, _ in stories_sorted]

        story_heights_m: dict[str, float] = {
            name: float(data.get("height_m", 3.0))
            for name, data in stories_sorted
        }

        story_masses_t: dict[str, float] = {}
        for md in masses_raw.values():
            sname = str(md.get("story", ""))
            if sname:
                story_masses_t[sname] = story_masses_t.get(sname, 0.0) + float(md.get("mass_x_t", 0.0))

        columns_by_story:  dict[str, list[str]] = {s: [] for s in story_order}
        beams_by_story:    dict[str, list[str]] = {s: [] for s in story_order}
        beam_lengths:      dict[str, float]     = {}
        beam_section_map:  dict[str, str]       = {}
        col_joints:        set[str]             = set()   # joints con columnas

        for fid, fd in frames_raw.items():
            story = fd.get("story", "")
            if fd.get("element_type") == "column":
                if story in columns_by_story:
                    columns_by_story[story].append(fid)
                col_joints.add(str(fd.get("joint_i", "")))
                col_joints.add(str(fd.get("joint_j", "")))
            elif fd.get("element_type") == "beam":
                if story in beams_by_story:
                    beams_by_story[story].append(fid)
                L = beam_span(joints_raw, fd.get("joint_i", ""), fd.get("joint_j", ""))
                beam_lengths[fid]     = L
                beam_section_map[fid] = fd.get("section", "")

        # Clasificar vigas por topología
        beam_classifications: dict[str, str] = {}
        for fid in beam_section_map:
            fd = frames_raw.get(fid, {})
            beam_classifications[fid] = classify_beam_topology(fd, col_joints)

        n_seismic   = sum(1 for c in beam_classifications.values() if c == "seismic_primary")
        n_secondary = sum(1 for c in beam_classifications.values() if c == "secondary")
        total_beams = sum(len(v) for v in beams_by_story.values())
        print(f"[beam_design] {total_beams} vigas en {len(story_order)} pisos")
        print(f"[beam_design] Clasificación: {n_seismic} sismorresistentes, {n_secondary} secundarias")

        if total_beams == 0:
            raise ValueError("No se encontraron vigas en el modelo.")

        # ── 4. Demandas ───────────────────────────────────────────────────────
        gravity_demands = distribute_gravity_beams(
            story_masses_t, beams_by_story, beam_lengths, story_order
        )

        story_shears_x: dict[str, float] = spectral.get("story_shears_x", {})
        story_shears_y: dict[str, float] = spectral.get("story_shears_y", {})

        seismic_mu_x = distribute_seismic_beams(
            story_shears_x, columns_by_story, beams_by_story, story_heights_m, story_order
        )
        seismic_mu_y = distribute_seismic_beams(
            story_shears_y, columns_by_story, beams_by_story, story_heights_m, story_order
        )

        # ── 5. Contexto sísmico ───────────────────────────────────────────────
        seismic_params_ctx = {
            "sections":          sections,
            "materials":         materials,
            "energy_dissipation": params.get("energy_dissipation", "DMO"),
        }

        # ── 6. Envolvente y diseño por viga ───────────────────────────────────
        beam_results: list[dict] = []
        beam_detail:  list[dict] = []

        # Combinaciones solo gravitacionales (G1, G2) para elementos secundarios
        gravity_only_combos = [c for c in combinations if c["id"] in ("G1", "G2")]
        if not gravity_only_combos:
            gravity_only_combos = [c for c in NSR10_COMBINATIONS if c["id"] in ("G1", "G2")]

        for fid in beam_section_map:
            classification = beam_classifications.get(fid, "seismic_primary")
            active_combos  = combinations if classification == "seismic_primary" else gravity_only_combos

            g_dem  = gravity_demands.get(fid, {
                "Mu_neg_kNm": 0.0, "Mu_pos_kNm": 0.0, "Vu_kN": 0.0,
                "w_kNm": 0.0, "L_m": 3.0
            })
            mu_g   = g_dem["Mu_neg_kNm"]
            vu_g   = g_dem["Vu_kN"]
            mu_ex  = seismic_mu_x.get(fid, 0.0)
            mu_ey  = seismic_mu_y.get(fid, 0.0)
            L_m    = g_dem["L_m"]

            # Envolvente global usando solo las combos activas para esta viga
            worst_mu_neg, worst_mu_pos, worst_vu = 0.0, 0.0, 0.0
            worst_combo = "G1"

            demands_by_combo: list[dict] = []

            for combo in active_combos:
                f      = combo["factors"]
                mu_neg = abs(f["CM"] * mu_g + max(abs(f["Ex"] * mu_ex), abs(f["Ey"] * mu_ey)))
                mu_pos = abs(f["CM"] * g_dem["Mu_pos_kNm"])
                vu     = abs(f["CM"] * vu_g + abs(f["Ex"]) * mu_ex / max(L_m / 2.0, 0.1))

                demands_by_combo.append({
                    "combo_id":    combo["id"],
                    "Mu_neg_kNm":  round(mu_neg, 1),
                    "Mu_pos_kNm":  round(mu_pos, 1),
                    "Vu_kN":       round(vu, 1),
                })

                if mu_neg > worst_mu_neg:
                    worst_mu_neg = mu_neg
                    worst_mu_pos = mu_pos
                    worst_vu     = max(vu, worst_vu)
                    worst_combo  = combo["id"]

            # Sección de la viga
            sec_name = beam_section_map[fid]
            sec_data = sections.get(sec_name, {})
            b_m  = sec_data.get("b_m", 0.0) or 0.0
            h_m  = sec_data.get("h_m", 0.0) or 0.0
            if b_m == 0.0 or h_m == 0.0:
                parsed = parse_beam_section(sec_name)
                if parsed:
                    b_m, h_m, fc_m = parsed["b_m"], parsed["h_m"], parsed["fc_MPa"]
                else:
                    b_m, h_m, fc_m = 0.30, 0.40, 21.0
            else:
                mat_name = sec_data.get("material", "")
                mat_data = materials.get(mat_name, {})
                fc_m = mat_data.get("fpc_mpa", 21.0) or 21.0

            # ── Resumen compatible v1 ────────────────────────────────────────
            from engine.building.design.beam_check import check_beam
            chk_v1 = check_beam(worst_mu_neg, worst_mu_pos, worst_vu, b_m, h_m, fc_m)

            story_of_beam = next(
                (s for s, bs in beams_by_story.items() if fid in bs), "—"
            )

            summary = {
                "id":           fid,
                "story":        story_of_beam,
                "section":      sec_name,
                "b_m":          round(b_m, 3),
                "h_m":          round(h_m, 3),
                "L_m":          round(L_m, 3),
                "fc_MPa":       fc_m,
                "w_kNm":        g_dem["w_kNm"],
                "combo":        worst_combo,
                **chk_v1,
                "has_detail":   False,
            }
            beam_results.append(summary)

            # ── Diseño completo con BeamDesigner ────────────────────────────
            # Demandas por zona (I, centro, J) — estimación a partir de la envolvente
            # Nota: con portal method se tiene un solo valor por piso
            # Se distribuye: extremos usan el 100% de Mu_neg, centro usa Mu_pos
            demands_by_zone = {
                "end_i": {
                    "Mu_neg_kNm": worst_mu_neg,
                    "Mu_pos_kNm": worst_mu_pos * 0.25,
                    "Vu_kN":      worst_vu,
                    "combo_id":   worst_combo,
                },
                "mid": {
                    "Mu_neg_kNm": worst_mu_neg * 0.20,   # momento negativo en centro (pequeño)
                    "Mu_pos_kNm": worst_mu_pos,
                    "Vu_kN":      worst_vu * 0.40,
                    "combo_id":   worst_combo,
                },
                "end_j": {
                    "Mu_neg_kNm": worst_mu_neg,
                    "Mu_pos_kNm": worst_mu_pos * 0.25,
                    "Vu_kN":      worst_vu,
                    "combo_id":   worst_combo,
                },
            }

            frame_data_ctx = {**frames_raw.get(fid, {}), "section": sec_name}
            try:
                designer = BeamDesigner(
                    frame_id           = fid,
                    frame_data         = frame_data_ctx,
                    joints             = joints_raw,
                    demands_by_zone    = demands_by_zone,
                    demands_by_combo   = demands_by_combo,
                    seismic_params     = seismic_params_ctx,
                    cover_m            = 0.040,
                    fy_MPa             = 420.0,
                    col_joints         = col_joints,
                    combinations_used  = [c["id"] for c in active_combos],
                )
                detail = designer.design()
                summary["has_detail"] = True
                summary["dcr"]  = detail["max_dcr"]
                summary["ok"]   = detail["overall_ok"]
                beam_detail.append(detail)
            except Exception as e_design:
                print(f"[beam_design] WARN: BeamDesigner falló para {fid}: {e_design}")

        # ── 7. Resumen ────────────────────────────────────────────────────────
        ok_count = sum(1 for b in beam_results if b["ok"])
        ng_count = len(beam_results) - ok_count
        max_dcr  = max((b["dcr"] for b in beam_results), default=0.0)

        story_idx = {s: i for i, s in enumerate(story_order)}
        beam_results.sort(
            key=lambda b: (story_idx.get(b["story"], 9999), -b["dcr"])
        )
        beam_detail.sort(
            key=lambda b: (story_idx.get(b["story"], 9999), -b["max_dcr"])
        )

        result = {
            "n_beams":            len(beam_results),
            "n_ok":               ok_count,
            "n_ng":               ng_count,
            "max_dcr":            round(max_dcr, 3),
            "fy_MPa":             420.0,
            "stirrup_bar":        "#3 (d=9.5mm, Av=71mm², 2 ramas)",
            "n_combinations":     len(combinations),
            "n_seismic_beams":    n_seismic,
            "n_secondary_beams":  n_secondary,
            "beams":              beam_results,
            "notes": [
                "Clasificación: topológica — sismorresistente si extremos conectan a columnas.",
                "Vigas sismorresistentes: todas las combinaciones seleccionadas (G1, G2, S1-S8).",
                "Vigas secundarias/gravitacionales: solo combinaciones G1 y G2.",
                "Carga gravitacional: distribución uniforme sobre las vigas de cada piso.",
                "Momento sísmico: método del pórtico — Mu_sís = V_piso / N_cols × h/2.",
                "Ver beam_design_detail.json para barras propuestas, zonas de cortante y chequeos.",
            ],
        }

        # ── 8. Guardar resultados ─────────────────────────────────────────────
        results_dir = os.path.join(work_dir, "results")
        os.makedirs(results_dir, exist_ok=True)

        result_path = os.path.join(results_dir, "beam_design_results.json")
        with open(result_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)

        detail_path = os.path.join(results_dir, "beam_design_detail.json")
        with open(detail_path, "w", encoding="utf-8") as f:
            json.dump({
                "n_beams":    len(beam_detail),
                "beams":      beam_detail,
                "story_order": story_order,
            }, f, ensure_ascii=False, indent=2)

        print(f"[beam_design] {ok_count} OK / {ng_count} NG | max DCR = {max_dcr:.3f}")
        print(f"[beam_design] Detalle → {detail_path}")

        summary_out = {
            "n_beams": len(beam_results), "n_ok": ok_count,
            "n_ng": ng_count, "max_dcr": round(max_dcr, 3),
        }
        mark_success(db, job_id, result_path, summary=summary_out)
        return {"status": "success", **summary_out}

    except Exception as exc:
        mark_failed(db, job_id, traceback.format_exc())
        raise self.retry(exc=exc, max_retries=0)
    finally:
        db.close()
