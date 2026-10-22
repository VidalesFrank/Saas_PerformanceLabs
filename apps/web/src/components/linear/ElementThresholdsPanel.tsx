"use client";
/**
 * ElementThresholdsPanel — Fase 7 UI.
 *
 * Dashboard de umbrales de daño calculados por elemento (Fases 1-6 del backend).
 * Permite:
 *   - Elegir método de rotación (Mecánico / EC8-3 / Haselton).
 *   - Elegir modo de umbrales (FEMA / elemento / ambos).
 *   - Ajustar β_global y β_poor_detailing.
 *   - Editar el catálogo DS1-DS4 (nombres y acciones de reparación).
 *   - Subir observations.csv (Lp medida, hooks, etc.).
 *   - Ver tabla por elemento con θ_IO / θ_LS / θ_CP + fragilidades + banderas.
 *   - Exportar la tabla a CSV.
 */
import { useEffect, useMemo, useState } from "react";

import {
  DamageStateConfig,
  ElementDemandResult,
  ElementThresholdResult,
  ElementThresholdRow,
  RotationMethod,
  UmbralesMode,
  elementThresholdsApi,
} from "@/lib/structural-api";

interface Props {
  projectId: string;
}

const FLAG_LABELS: Record<string, string> = {
  HOOK_90:          "Gancho 90°",
  SPLICE_IN_HINGE:  "Empalme en rótula",
  S_OVER_DB_GT_6:   "s/db > 6",
  RHO_SH_LT_DMO:    "ρ_sh < DMO",
  RHO_SH_LT_DES:    "ρ_sh < DES",
  LOW_CONFINEMENT:  "Bajo confinamiento",
  HIGH_AXIAL:       "ν > 0.5",
};

const FAILURE_COLORS: Record<string, string> = {
  flexion:          "bg-green-100 text-green-800",
  flexion_cortante: "bg-amber-100 text-amber-800",
  cortante:         "bg-red-100 text-red-800",
};

export default function ElementThresholdsPanel({ projectId }: Props) {
  const [metodoRotacion, setMetodoRotacion] = useState<RotationMethod>("haselton");
  const [metodoUmbrales, setMetodoUmbrales] = useState<UmbralesMode>("ambos");
  const [betaGlobal, setBetaGlobal]         = useState(0.40);
  const [betaPoor, setBetaPoor]             = useState(0.60);
  const [catalog, setCatalog]               = useState<DamageStateConfig[]>([]);
  const [result, setResult]                 = useState<ElementThresholdResult | null>(null);
  const [demand, setDemand]                 = useState<ElementDemandResult | null>(null);
  const [loading, setLoading]               = useState(false);
  const [error, setError]                   = useState<string | null>(null);
  const [filterKind, setFilterKind]         = useState<"all" | "column" | "beam">("all");
  const [filterStory, setFilterStory]       = useState<string>("all");
  const [showDSEditor, setShowDSEditor]     = useState(false);

  // Carga inicial: catálogo DS + último resultado persistido + demanda
  useEffect(() => {
    elementThresholdsApi.getDSCatalog(projectId).then(setCatalog).catch(() => {});
    elementThresholdsApi.get(projectId).then(setResult).catch(() => {});
    elementThresholdsApi.getElementDemand(projectId).then(setDemand).catch(() => {});
  }, [projectId]);

  async function handleCompute() {
    setLoading(true);
    setError(null);
    try {
      const [r, d] = await Promise.all([
        elementThresholdsApi.compute(projectId, {
          metodo_rotacion:     metodoRotacion,
          metodo_umbrales:     metodoUmbrales,
          beta_global:         betaGlobal,
          beta_poor_detailing: betaPoor,
          ds_catalog:          catalog.length > 0 ? catalog : undefined,
        }),
        elementThresholdsApi.getElementDemand(projectId).catch(() => null),
      ]);
      setResult(r);
      if (d) setDemand(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function handleUploadObs(file: File) {
    try {
      const r = await elementThresholdsApi.uploadFieldObservations(projectId, file);
      alert(`Observaciones cargadas: ${r.n_elements} elementos`);
    } catch (e) {
      alert(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleSaveCatalog() {
    try {
      await elementThresholdsApi.putDSCatalog(projectId, catalog);
      setShowDSEditor(false);
    } catch (e) {
      alert(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const stories = useMemo(() => {
    if (!result) return [];
    return Array.from(new Set(result.rows.map(r => r.story))).sort();
  }, [result]);

  // ─── Combina capacity + demand → fila enriquecida ──────────────────────
  const enrichedRows = useMemo(() => {
    if (!result) return [];
    return result.rows.map(r => {
      const d = demand?.by_fid[r.fid];
      const theta_demand = d?.theta_p_max ?? 0;
      const dcr          = r.theta_CP > 0 ? theta_demand / r.theta_CP : 0;

      // DS más probable usando fragilidad lognormal
      const frag = result.fragilities[r.fid];
      let mostLikelyDS = "DS0";
      if (theta_demand > 0 && frag) {
        const ids = Object.keys(frag.medians);
        const pExceed: Record<string, number> = {};
        for (const dsid of ids) {
          const med  = frag.medians[dsid];
          const beta = frag.betas[dsid];
          pExceed[dsid] = (med > 0 && beta > 0)
            ? 0.5 * (1 + erf(Math.log(theta_demand / med) / (beta * Math.SQRT2)))
            : 0;
        }
        // P(DS=DSi) = P(≥DSi) - P(≥DSi+1)
        const probs: Record<string, number> = {
          DS0: Math.max(0, 1 - (pExceed[ids[0]] ?? 0)),
        };
        for (let i = 0; i < ids.length; i++) {
          const nxt = i + 1 < ids.length ? pExceed[ids[i + 1]] : 0;
          probs[ids[i]] = Math.max(0, pExceed[ids[i]] - nxt);
        }
        mostLikelyDS = Object.entries(probs)
                              .reduce((a, b) => a[1] >= b[1] ? a : b)[0];
      }
      return {
        row:              r,
        theta_demand,
        dcr,
        mostLikelyDS,
        source:           d?.source ?? null,
      };
    });
  }, [result, demand]);

  const nFailed = useMemo(
    () => enrichedRows.filter(e => e.dcr > 1.0).length,
    [enrichedRows],
  );

  const filteredRows = useMemo(() => {
    return enrichedRows.filter(e => {
      if (filterKind !== "all" && e.row.kind !== filterKind) return false;
      if (filterStory !== "all" && e.row.story !== filterStory) return false;
      return true;
    });
  }, [enrichedRows, filterKind, filterStory]);

  function exportCSV() {
    if (!result) return;
    const cols = ["fid", "kind", "story", "section", "failure_mode", "asce_condition",
                  "flags", "Vp_kN", "Vn_kN", "Vp_over_Vn",
                  "M_peak_kNm", "method", "Lp_mm", "Lp_source",
                  "theta_y", "theta_IO", "theta_LS", "theta_CP", "theta_u",
                  "has_measured_Lp"];
    const extraCols = ["theta_p_demand", "D/C_CP", "most_likely_DS", "demand_source"];
    const lines = [[...cols, ...extraCols].join(",")];
    for (const e of filteredRows) {
      const row = cols.map(c => {
        const v = (e.row as unknown as Record<string, unknown>)[c];
        if (Array.isArray(v)) return `"${v.join("|")}"`;
        if (typeof v === "number") return v.toFixed(5);
        return String(v ?? "");
      });
      row.push(e.theta_demand.toFixed(5));
      row.push(e.dcr.toFixed(3));
      row.push(e.mostLikelyDS);
      row.push(e.source ?? "");
      lines.push(row.join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `element_thresholds_${projectId.slice(0, 8)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-4 p-4 bg-white rounded-lg border border-slate-200">
      {/* Header: parámetros + acciones */}
      <div className="flex flex-wrap items-end gap-4 border-b border-slate-200 pb-3">
        <div className="flex flex-col">
          <label className="text-xs text-slate-500 mb-1">Método rotación</label>
          <select
            value={metodoRotacion}
            onChange={e => setMetodoRotacion(e.target.value as RotationMethod)}
            className="border border-slate-300 rounded px-2 py-1 text-sm"
          >
            <option value="haselton">Haselton 2008 (IMK)</option>
            <option value="ec8_3">Eurocódigo 8-3</option>
            <option value="mecanico">Mecánico (Paulay-Priestley)</option>
          </select>
        </div>

        <div className="flex flex-col">
          <label className="text-xs text-slate-500 mb-1">Modo umbrales</label>
          <select
            value={metodoUmbrales}
            onChange={e => setMetodoUmbrales(e.target.value as UmbralesMode)}
            className="border border-slate-300 rounded px-2 py-1 text-sm"
          >
            <option value="FEMA">FEMA / ASCE 41 (hardcoded)</option>
            <option value="elemento">Por elemento (calculado)</option>
            <option value="ambos">Ambos (comparar)</option>
          </select>
        </div>

        <div className="flex flex-col">
          <label className="text-xs text-slate-500 mb-1">β global</label>
          <input
            type="number" step="0.05" min="0.1" max="1.0"
            value={betaGlobal}
            onChange={e => setBetaGlobal(parseFloat(e.target.value))}
            className="border border-slate-300 rounded px-2 py-1 text-sm w-20"
          />
        </div>

        <div className="flex flex-col">
          <label className="text-xs text-slate-500 mb-1">β detallado deficiente</label>
          <input
            type="number" step="0.05" min="0.1" max="1.0"
            value={betaPoor}
            onChange={e => setBetaPoor(parseFloat(e.target.value))}
            className="border border-slate-300 rounded px-2 py-1 text-sm w-20"
          />
        </div>

        <button
          onClick={handleCompute}
          disabled={loading}
          className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white px-4 py-2 rounded text-sm font-medium"
        >
          {loading ? "Calculando…" : "Calcular umbrales"}
        </button>

        <label className="bg-slate-200 hover:bg-slate-300 text-slate-800 px-3 py-2 rounded text-sm cursor-pointer">
          Subir observations.csv
          <input
            type="file"
            accept=".csv"
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) handleUploadObs(f);
            }}
          />
        </label>

        <button
          onClick={() => setShowDSEditor(!showDSEditor)}
          className="bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-2 rounded text-sm"
        >
          Editar DS…
        </button>
      </div>

      {/* Editor del catálogo DS */}
      {showDSEditor && (
        <div className="border border-slate-300 rounded p-3 bg-slate-50">
          <h3 className="text-sm font-semibold mb-2">Catálogo de estados de daño</h3>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-500">
                <th className="text-left py-1">ID</th>
                <th className="text-left py-1">Nombre</th>
                <th className="text-left py-1">Fuente umbral</th>
                <th className="text-left py-1">Acción reparación</th>
                <th className="text-left py-1">β override</th>
              </tr>
            </thead>
            <tbody>
              {catalog.map((d, idx) => (
                <tr key={d.id} className="border-t border-slate-200">
                  <td className="py-1 font-mono">{d.id}</td>
                  <td className="py-1">
                    <input
                      value={d.name}
                      onChange={e => {
                        const c = [...catalog];
                        c[idx] = { ...c[idx], name: e.target.value };
                        setCatalog(c);
                      }}
                      className="border border-slate-300 rounded px-1 py-0.5 w-full"
                    />
                  </td>
                  <td className="py-1 font-mono text-slate-500">{d.threshold_source}</td>
                  <td className="py-1">
                    <input
                      value={d.repair_action}
                      onChange={e => {
                        const c = [...catalog];
                        c[idx] = { ...c[idx], repair_action: e.target.value };
                        setCatalog(c);
                      }}
                      className="border border-slate-300 rounded px-1 py-0.5 w-full"
                    />
                  </td>
                  <td className="py-1">
                    <input
                      type="number" step="0.05" min="0.1" max="1.0"
                      value={d.beta_override ?? ""}
                      placeholder="auto"
                      onChange={e => {
                        const c = [...catalog];
                        c[idx] = {
                          ...c[idx],
                          beta_override: e.target.value ? parseFloat(e.target.value) : null,
                        };
                        setCatalog(c);
                      }}
                      className="border border-slate-300 rounded px-1 py-0.5 w-16"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            onClick={handleSaveCatalog}
            className="mt-2 bg-green-600 hover:bg-green-700 text-white px-3 py-1 rounded text-xs"
          >
            Guardar catálogo
          </button>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm p-2 rounded">
          {error}
        </div>
      )}

      {result && (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-6 gap-3">
            <KPI label="Elementos" value={result.n_elements} color="bg-slate-50" />
            <KPI label="Lp medida" value={result.n_with_lp_measured} color="bg-blue-50" />
            <KPI label="Detall. deficiente" value={result.n_poor_detailing} color="bg-amber-50" />
            <KPI label={demand ? `D/C>1 (${demand.source})` : "D/C>1"}
                 value={demand ? nFailed : "—"}
                 color={nFailed > 0 ? "bg-red-50" : "bg-slate-50"} />
            <KPI label="Método rotación" value={result.metodo_rotacion} color="bg-indigo-50" />
            <KPI label="Modo umbrales" value={result.metodo_umbrales} color="bg-emerald-50" />
          </div>

          {!demand || demand.source === "none" ? (
            <div className="bg-blue-50 border border-blue-200 text-blue-800 text-xs p-2 rounded">
              Aún no hay análisis dinámico ni pushover corrido para este proyecto —
              se muestran sólo las capacidades por elemento. Lanza un pushover o
              NLTHA para ver demanda y D/C.
            </div>
          ) : null}

          {result.warnings.length > 0 && (
            <details className="bg-amber-50 border border-amber-200 rounded p-2 text-xs">
              <summary className="font-semibold cursor-pointer">
                {result.warnings.length} advertencias
              </summary>
              <ul className="mt-1 list-disc list-inside">
                {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </details>
          )}

          {/* Filtros + exportar */}
          <div className="flex items-center gap-3 border-t border-b border-slate-200 py-2">
            <select
              value={filterKind}
              onChange={e => setFilterKind(e.target.value as typeof filterKind)}
              className="border border-slate-300 rounded px-2 py-1 text-xs"
            >
              <option value="all">Todos</option>
              <option value="column">Columnas</option>
              <option value="beam">Vigas</option>
            </select>

            <select
              value={filterStory}
              onChange={e => setFilterStory(e.target.value)}
              className="border border-slate-300 rounded px-2 py-1 text-xs"
            >
              <option value="all">Todos los pisos</option>
              {stories.map(s => <option key={s} value={s}>{s}</option>)}
            </select>

            <div className="flex-1" />

            <button
              onClick={exportCSV}
              className="bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-1 rounded text-xs"
            >
              Exportar CSV ({filteredRows.length})
            </button>
          </div>

          {/* Tabla por elemento */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-600 sticky top-0">
                <tr>
                  <th className="text-left px-2 py-1">fid</th>
                  <th className="text-left px-2 py-1">Tipo</th>
                  <th className="text-left px-2 py-1">Piso</th>
                  <th className="text-left px-2 py-1">Sección</th>
                  <th className="text-left px-2 py-1">Modo</th>
                  <th className="text-right px-2 py-1">Vp/Vn</th>
                  <th className="text-right px-2 py-1">Lp (mm)</th>
                  <th className="text-right px-2 py-1">θ_y</th>
                  <th className="text-right px-2 py-1">θ_IO</th>
                  <th className="text-right px-2 py-1">θ_LS</th>
                  <th className="text-right px-2 py-1">θ_CP</th>
                  <th className="text-right px-2 py-1">θ_u</th>
                  <th className="text-right px-2 py-1 bg-blue-50">Demanda θ_p</th>
                  <th className="text-right px-2 py-1 bg-blue-50">D/C_CP</th>
                  <th className="text-left px-2 py-1 bg-blue-50">DS prob.</th>
                  <th className="text-left px-2 py-1">Banderas</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map(e => (
                  <ElementRow key={e.row.fid} enriched={e} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!result && !loading && (
        <div className="text-sm text-slate-500 text-center py-8">
          Aún no se han calculado umbrales por elemento.<br />
          Haz clic en <strong>Calcular umbrales</strong>.
        </div>
      )}

      {/* Fuentes y validación — explícitos para que el usuario los vea */}
      <SourcesAndBenchmarks />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Fuentes y benchmarks explícitos — Fase 8 (punto 4 del plan)
// Mostrar coeficientes de Haselton, dispersiones σ_LN, y los 3 ensayos PEER
// de referencia para que el usuario los vea, los pueda cotejar y, en versiones
// futuras, los pueda calibrar contra sus propios ensayos.
// ─────────────────────────────────────────────────────────────────────────────
function SourcesAndBenchmarks() {
  const [open, setOpen] = useState(false);
  return (
    <details
      open={open}
      onToggle={e => setOpen((e.target as HTMLDetailsElement).open)}
      className="border border-slate-200 rounded bg-slate-50 text-sm"
    >
      <summary className="cursor-pointer px-3 py-2 font-semibold text-slate-700">
        Fuentes, coeficientes y ensayos de referencia (PEER)
      </summary>
      <div className="px-4 py-3 flex flex-col gap-4 text-xs text-slate-700">
        <section>
          <h4 className="font-semibold text-sm mb-1">
            Haselton et al. (2008) — Ecuaciones IMK para columnas RC
          </h4>
          <p className="text-[11px] text-slate-600 mb-2">
            PEER Report 2007/03 — calibradas contra 255 columnas de la
            PEER Structural Performance Database. Rango de validez:{" "}
            ν ∈ [0, 0.70], ρ<sub>sh</sub> ∈ [0.001, 0.025],
            f'c ∈ [20, 120 MPa].
          </p>
          <div className="font-mono text-[11px] bg-white border border-slate-200 rounded p-2 overflow-x-auto">
            <div>θ_cap,pl = 0.12·(1 + 0.4·a_sl)·(0.2)^ν·(0.02 + 40·ρ_sh)^0.52·(0.56)^(0.01·c·f'c)</div>
            <div>θ_pc    = min(0.10, 0.76·(0.031)^ν·(0.02 + 40·ρ_sh)^1.02)</div>
            <div>λ       = 30·(0.3)^ν            (deterioro cíclico, c=1.0)</div>
            <div>Mc/My   = 1.25·(0.89)^ν·(0.91)^(0.01·c·f'c)</div>
          </div>
          <div className="mt-2 grid grid-cols-4 gap-2 text-[11px]">
            <SigmaBadge label="σ_LN θ_cap,pl" v="0.60" />
            <SigmaBadge label="σ_LN θ_pc"     v="0.72" />
            <SigmaBadge label="σ_LN λ"        v="0.49" />
            <SigmaBadge label="σ_LN Mc/My"    v="0.10" />
          </div>
          <p className="text-[10px] text-slate-500 mt-2">
            Unidades: f'c, fy en MPa (c_units = 1.0).
            s<sub>n</sub> = (s/db)·√(f_y / 690 MPa).
            a_sl = 1 si hay slip de barras longitudinales modelado.
          </p>
        </section>

        <section>
          <h4 className="font-semibold text-sm mb-1">
            Ensayos de la PEER Column Database — benchmarks validados
          </h4>
          <table className="w-full text-[11px] bg-white border border-slate-200 rounded">
            <thead className="bg-slate-100">
              <tr>
                <th className="text-left px-2 py-1">Ensayo</th>
                <th className="text-right px-2 py-1">ν</th>
                <th className="text-right px-2 py-1">ρ_sh</th>
                <th className="text-right px-2 py-1">s/db</th>
                <th className="text-right px-2 py-1">θ_cap,pl calc.</th>
                <th className="text-left px-2 py-1">Observación</th>
              </tr>
            </thead>
            <tbody>
              <BenchmarkRow name="Saatcioglu-Ozcebe B1 (1989)"
                            nu={0.0} rho_sh={0.011} s_db={4.0}
                            theta_min={0.06} theta_max={0.12}
                            obs="Columna muy confinada, dúctil" />
              <BenchmarkRow name="Sezen 2CLH18 (2000)"
                            nu={0.15} rho_sh={0.0017} s_db={8.0}
                            theta_min={0.01} theta_max={0.04}
                            obs="Columna existente mal detallada" />
              <BenchmarkRow name="Lynn 3SLH18 (1996)"
                            nu={0.09} rho_sh={0.0015} s_db={10.0}
                            theta_min={0.01} theta_max={0.035}
                            obs="Ganchos a 90°, rotura ~0.025 rad" />
            </tbody>
          </table>
          <p className="text-[10px] text-slate-500 mt-2">
            Los rangos "θ_cap,pl calc." son los valores que las ecuaciones de
            Haselton 2008 producen para estos parámetros. Los valores medidos
            en laboratorio están publicados en los papers originales (acceso
            vía PEER Center https://nisee.berkeley.edu/spd/). Si tus
            ensayos propios dan rotaciones significativamente diferentes,
            considera subir la Lp observada (botón 📏 en el panel de
            refuerzo) para forzar el método mecánico en esos elementos.
          </p>
        </section>

        <section>
          <h4 className="font-semibold text-sm mb-1">
            Otros métodos y referencias
          </h4>
          <ul className="text-[11px] space-y-1 list-disc list-inside text-slate-600">
            <li><b>Mander et al. (1988)</b> — confinamiento (f'cc, ε<sub>cc</sub>, ε<sub>cu</sub>).</li>
            <li><b>Paulay &amp; Priestley (1992)</b> — Lp = max(0.08·Ls + 0.022·fy·db, 0.044·fy·db).</li>
            <li><b>EC8-3 (2005) Anexo A</b> — θ<sub>um</sub> empírico; reducciones por detallado deficiente.</li>
            <li><b>Sezen &amp; Moehle (2004)</b> — Vn para columnas existentes, degrada con μ.</li>
            <li><b>Elwood &amp; Moehle (2003)</b> — drift de pérdida de capacidad por cortante.</li>
            <li><b>ASCE 41-17 §10.3.3</b> — clasificación i–iv por Vp/Vn + detallado.</li>
          </ul>
        </section>
      </div>
    </details>
  );
}

function SigmaBadge({ label, v }: { label: string; v: string }) {
  return (
    <div className="bg-indigo-50 border border-indigo-100 rounded px-2 py-1 text-[10px]">
      <div className="text-slate-500">{label}</div>
      <div className="font-mono text-indigo-900 text-sm">{v}</div>
    </div>
  );
}

function BenchmarkRow({ name, nu, rho_sh, s_db, theta_min, theta_max, obs }: {
  name: string; nu: number; rho_sh: number; s_db: number;
  theta_min: number; theta_max: number; obs: string;
}) {
  return (
    <tr className="border-t border-slate-200">
      <td className="px-2 py-1 font-mono">{name}</td>
      <td className="px-2 py-1 text-right font-mono">{nu.toFixed(2)}</td>
      <td className="px-2 py-1 text-right font-mono">{rho_sh.toFixed(4)}</td>
      <td className="px-2 py-1 text-right font-mono">{s_db.toFixed(1)}</td>
      <td className="px-2 py-1 text-right font-mono">
        {theta_min.toFixed(3)} – {theta_max.toFixed(3)}
      </td>
      <td className="px-2 py-1 text-slate-500">{obs}</td>
    </tr>
  );
}

function KPI({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div className={`${color} rounded px-3 py-2`}>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-lg font-semibold text-slate-800">{value}</div>
    </div>
  );
}

interface EnrichedRow {
  row:          ElementThresholdRow;
  theta_demand: number;
  dcr:          number;
  mostLikelyDS: string;
  source:       string | null;
}

const DS_COLORS: Record<string, string> = {
  DS0: "bg-slate-100 text-slate-600",
  DS1: "bg-green-100 text-green-800",
  DS2: "bg-yellow-100 text-yellow-800",
  DS3: "bg-orange-100 text-orange-800",
  DS4: "bg-red-100 text-red-800",
};

function ElementRow({ enriched }: { enriched: EnrichedRow }) {
  const { row, theta_demand, dcr, mostLikelyDS, source } = enriched;
  const modeColor = FAILURE_COLORS[row.failure_mode] ?? "bg-slate-100 text-slate-700";
  const dsColor   = DS_COLORS[mostLikelyDS] ?? DS_COLORS.DS0;
  const dcrClass  = dcr > 1.0 ? "bg-red-50"
                 : dcr > 0.7 ? "bg-orange-50"
                 : dcr > 0.0 ? "bg-slate-50"
                 : "";
  return (
    <tr className={`border-t border-slate-100 hover:bg-slate-50 ${dcrClass}`}>
      <td className="px-2 py-1 font-mono">
        {row.fid}
        {row.has_measured_Lp && (
          <span className="ml-1 text-blue-600" title="Lp medida en campo">📏</span>
        )}
      </td>
      <td className="px-2 py-1">{row.kind === "column" ? "Col" : "Viga"}</td>
      <td className="px-2 py-1">{row.story}</td>
      <td className="px-2 py-1">{row.section}</td>
      <td className="px-2 py-1">
        <span className={`inline-block px-2 py-0.5 rounded text-[10px] ${modeColor}`}>
          {row.failure_mode}
        </span>
      </td>
      <td className="px-2 py-1 text-right font-mono">{row.Vp_over_Vn.toFixed(2)}</td>
      <td className="px-2 py-1 text-right font-mono">
        {row.Lp_mm.toFixed(0)}
        <span className="text-slate-400 text-[9px] ml-1">
          {row.Lp_source === "measured" ? "obs" : row.Lp_source.slice(0, 2)}
        </span>
      </td>
      <td className="px-2 py-1 text-right font-mono">{row.theta_y.toFixed(4)}</td>
      <td className="px-2 py-1 text-right font-mono">{row.theta_IO.toFixed(4)}</td>
      <td className="px-2 py-1 text-right font-mono">{row.theta_LS.toFixed(4)}</td>
      <td className="px-2 py-1 text-right font-mono">{row.theta_CP.toFixed(4)}</td>
      <td className="px-2 py-1 text-right font-mono">{row.theta_u.toFixed(4)}</td>
      <td className="px-2 py-1 text-right font-mono"
          title={source ? `fuente: ${source}` : "sin demanda"}>
        {theta_demand > 0 ? theta_demand.toFixed(4) : "—"}
      </td>
      <td className={`px-2 py-1 text-right font-mono font-semibold
                      ${dcr > 1.0 ? "text-red-700" : dcr > 0.7 ? "text-orange-700" : ""}`}>
        {theta_demand > 0 ? dcr.toFixed(2) : "—"}
      </td>
      <td className="px-2 py-1">
        <span className={`inline-block px-2 py-0.5 rounded text-[10px] ${dsColor}`}>
          {mostLikelyDS}
        </span>
      </td>
      <td className="px-2 py-1">
        <div className="flex flex-wrap gap-1">
          {row.flags.map(f => (
            <span key={f}
              className="px-1.5 py-0.5 rounded bg-red-50 text-red-700 text-[9px]"
              title={FLAG_LABELS[f] ?? f}
            >
              {FLAG_LABELS[f] ?? f}
            </span>
          ))}
        </div>
      </td>
    </tr>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// erf — aproximación numérica (Abramowitz & Stegun 7.1.26)
// ─────────────────────────────────────────────────────────────────────────────
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;
  const t  = 1 / (1 + p * ax);
  const y  = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}
