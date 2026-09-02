"""
Tarea Celery — Módulo 1: Diseño completo de columnas (NSR-10 B.3.4).

Produce dos archivos:
  - design_columns_results.json   (resumen por columna, compatible con versión anterior)
  - design_columns_detail.json    (detalle completo: curva P-M, barras, estribos, chequeos)

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


@celery_app.task(name="app.tasks.structural_design_task.run_design_columns", bind=True)
def run_design_columns(
    self,
    job_id: str,
    project_id: str,
    input_file: str | None,
    e2k_file: str | None = None,
    parameters_dict: dict | None = None,
    extra_params: dict | None = None,
):
    """Diseño completo de columnas por envolvente de combinaciones NSR-10."""
    db = get_db_session()
    try:
        mark_running(db, job_id)

        from app.models import StructuralProject
        from engine.building.design.combinations import NSR10_COMBINATIONS, DEFAULT_SELECTED_IDS
        from engine.building.design.column_check import (
            parse_section, pm_capacity, check_pm,
            distribute_gravity, distribute_seismic_moment,
        )
        from engine.building.design.column_designer import ColumnDesigner

        # ── 1. Cargar proyecto y archivos ─────────────────────────────────────
        project = db.get(StructuralProject, project_id)
        if not project or not project.canonical_model_path:
            raise FileNotFoundError("Modelo canónico no disponible.")
        if not os.path.exists(project.canonical_model_path):
            raise FileNotFoundError(f"structural_model.json no encontrado: {project.canonical_model_path}")

        canonical_path = project.canonical_model_path
        work_dir       = os.path.dirname(os.path.dirname(canonical_path))
        spectral_path  = os.path.join(work_dir, "results", "spectral_results.json")

        if not os.path.exists(spectral_path):
            raise FileNotFoundError(
                "Resultados espectrales no encontrados. Ejecuta primero el análisis espectral."
            )

        with open(canonical_path, "r", encoding="utf-8") as f:
            model = json.load(f)
        with open(spectral_path, "r", encoding="utf-8") as f:
            spectral = json.load(f)

        params = parameters_dict or (json.loads(project.parameters_json) if project.parameters_json else {})

        # ── 2. Combinaciones seleccionadas ────────────────────────────────────
        selected_ids = params.get("combinations", DEFAULT_SELECTED_IDS)
        combo_map    = {c["id"]: c for c in NSR10_COMBINATIONS}
        combinations = [combo_map[cid] for cid in selected_ids if cid in combo_map]
        print(f"[design_col] {len(combinations)} combinaciones activas")

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

        columns_by_story: dict[str, list[str]] = {s: [] for s in story_order}
        column_sections:  dict[str, str]        = {}

        for fid, fd in frames_raw.items():
            if fd.get("element_type") == "column":
                story = fd.get("story", "")
                if story in columns_by_story:
                    columns_by_story[story].append(fid)
                column_sections[fid] = fd.get("section", "")

        total_cols = sum(len(v) for v in columns_by_story.values())
        print(f"[design_col] {total_cols} columnas en {len(story_order)} pisos")

        # ── 4. Cargas de gravedad ─────────────────────────────────────────────
        gravity_pu = distribute_gravity(story_masses_t, columns_by_story, story_order)

        # ── 5. Momentos sísmicos por dirección (portal method) ────────────────
        story_shears_x: dict[str, float] = spectral.get("story_shears_x", {})
        story_shears_y: dict[str, float] = spectral.get("story_shears_y", {})

        seismic_mu_x = distribute_seismic_moment(
            story_shears_x, columns_by_story, story_heights_m, story_order
        )
        seismic_mu_y = distribute_seismic_moment(
            story_shears_y, columns_by_story, story_heights_m, story_order
        )

        # ── 6. Diseño por columna ─────────────────────────────────────────────
        # Parámetros sísmicos para el designer
        seismic_params_ctx = {
            "sections":          sections,
            "materials":         materials,
            "energy_dissipation": params.get("energy_dissipation", "DMO"),
        }

        column_results: list[dict] = []   # resumen (compatible v1)
        column_detail:  list[dict] = []   # detalle completo (nuevo)

        for fid in column_sections:
            pu_g  = gravity_pu.get(fid, 0.0)
            mu_x  = seismic_mu_x.get(fid, 0.0)
            mu_y  = seismic_mu_y.get(fid, 0.0)

            # Demandas por combinación
            demands_by_combo: list[dict] = []
            worst_pu, worst_mu = 0.0, 0.0
            worst_combo = "G1"

            for combo in combinations:
                f   = combo["factors"]
                pu  = f["CM"] * pu_g
                mu2 = abs(f["Ex"] * mu_x)   # dirección 2 (X)
                mu3 = abs(f["Ey"] * mu_y)   # dirección 3 (Y)
                mu  = math.sqrt(mu2**2 + mu3**2)

                demands_by_combo.append({
                    "combo_id": combo["id"],
                    "Pu_kN":   round(pu,  1),
                    "Mu2_kNm": round(mu2, 1),
                    "Mu3_kNm": round(mu3, 1),
                    "Mu_res_kNm": round(mu, 1),
                    "Vu2_kN":  0.0,
                    "Vu3_kN":  0.0,
                })

                if mu > worst_mu or (mu == worst_mu and pu > worst_pu):
                    worst_mu    = mu
                    worst_pu    = pu
                    worst_combo = combo["id"]

            # Dimensiones de la sección
            sec_name = column_sections[fid]
            sec_dims = sections.get(sec_name, {})
            b_m = sec_dims.get("b_m", 0.0)
            h_m = sec_dims.get("h_m", 0.0)
            if b_m == 0 or h_m == 0:
                parsed = parse_section(sec_name)
                if parsed:
                    b_m, h_m = parsed["b_m"], parsed["h_m"]
                    fc_m = parsed.get("fc_MPa", 21.0)
                else:
                    b_m, h_m, fc_m = 0.30, 0.30, 21.0
            else:
                mat_name = sec_dims.get("material", "")
                mat_data = materials.get(mat_name, {})
                fc_m = mat_data.get("fpc_mpa", 21.0) or 21.0

            # ── Diseño completo con ColumnDesigner ──────────────────────────
            frame_data_ctx = {**frames_raw.get(fid, {}), "section": sec_name}
            try:
                designer = ColumnDesigner(
                    frame_id         = fid,
                    frame_data       = frame_data_ctx,
                    joints           = joints_raw,
                    demands_by_combo = demands_by_combo,
                    seismic_params   = seismic_params_ctx,
                    cover_m          = 0.040,
                    fy_MPa           = 420.0,
                )
                detail = designer.design()
            except Exception as e_design:
                print(f"[design_col] WARN: ColumnDesigner falló para {fid}: {e_design}")
                detail = None

            # ── Resumen compatible v1 ────────────────────────────────────────
            cap = pm_capacity(b_m, h_m, fc_m, rho=0.01)
            chk = check_pm(worst_pu, worst_mu, cap)

            story_of_col = next(
                (s for s, cols in columns_by_story.items() if fid in cols), "—"
            )

            summary = {
                "id":           fid,
                "story":        story_of_col,
                "section":      sec_name,
                "b_m":          round(b_m, 4),
                "h_m":          round(h_m, 4),
                "fc_MPa":       fc_m,
                "Pu_kN":        round(worst_pu, 1),
                "Mu_kNm":       round(worst_mu, 1),
                "combo":        worst_combo,
                "phi_Pn_kN":    cap["phi_Pn_max_kN"],
                "phi_Mn_kNm":   cap["phi_Mn_kNm"],
                "Ag_m2":        cap["Ag_m2"],
                "Ast_cm2":      cap["Ast_cm2"],
                "rho_pct":      cap["rho_pct"],
                "dcr":          chk["dcr"],
                "ok":           chk["ok"],
                "Mu_cap_kNm":   chk["Mu_cap_kNm"],
                # Campos adicionales v2
                "has_detail":   detail is not None,
            }

            column_results.append(summary)
            if detail:
                # Usar el DCR del detalle (con refuerzo real) si es mejor
                summary["dcr"]    = detail["max_dcr"]
                summary["ok"]     = detail["overall_ok"]
                summary["has_detail"] = True
                column_detail.append(detail)

        # ── 7. Resumen ────────────────────────────────────────────────────────
        ok_count  = sum(1 for c in column_results if c["ok"])
        ng_count  = len(column_results) - ok_count
        max_dcr   = max((c["dcr"] for c in column_results), default=0.0)

        story_idx = {s: i for i, s in enumerate(story_order)}
        column_results.sort(
            key=lambda c: (story_idx.get(c["story"], 9999), -c["dcr"])
        )
        column_detail.sort(
            key=lambda c: (story_idx.get(c["story"], 9999), -c["max_dcr"])
        )

        result = {
            "n_columns":     len(column_results),
            "n_ok":          ok_count,
            "n_ng":          ng_count,
            "max_dcr":       round(max_dcr, 3),
            "rho_assumed":   1.0,
            "fy_MPa":        420.0,
            "n_combinations": len(combinations),
            "columns":       column_results,
            "notes": [
                "ρ = 1.0 % base (NSR-10 C.10.9.1). El diseño detallado usa refuerzo real calculado.",
                "Axial de gravedad: distribución igual entre columnas de cada piso.",
                "Momento sísmico: método del pórtico (punto de inflexión a media altura).",
                "Fuerzas sísmicas E del RSA ya incorporan el factor de reducción R.",
                "Ver design_columns_detail.json para curvas P-M, barras y chequeos por elemento.",
            ],
        }

        # ── 8. Guardar resultados ─────────────────────────────────────────────
        results_dir = os.path.join(work_dir, "results")
        os.makedirs(results_dir, exist_ok=True)

        result_path = os.path.join(results_dir, "design_columns_results.json")
        with open(result_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)

        detail_path = os.path.join(results_dir, "design_columns_detail.json")
        with open(detail_path, "w", encoding="utf-8") as f:
            json.dump({
                "n_columns":  len(column_detail),
                "columns":    column_detail,
                "story_order": story_order,
            }, f, ensure_ascii=False, indent=2)

        print(f"[design_col] {ok_count} OK / {ng_count} NG | max DCR = {max_dcr:.3f}")
        print(f"[design_col] Detalle → {detail_path}")

        summary_out = {
            "n_columns":  len(column_results),
            "n_ok":       ok_count,
            "n_ng":       ng_count,
            "max_dcr":    round(max_dcr, 3),
        }
        mark_success(db, job_id, result_path, summary=summary_out)
        return {"status": "success", **summary_out}

    except Exception as exc:
        mark_failed(db, job_id, traceback.format_exc())
        raise self.retry(exc=exc, max_retries=0)
    finally:
        db.close()
