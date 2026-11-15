"use client";

/**
 * Panel IDA — Incremental Dynamic Analysis sobre biblioteca FEMA P-695.
 *
 * Flujo:
 *   1. Usuario multi-selecciona N pares del catálogo (checkboxes)
 *   2. Define grid de Sa (min, max, n_niveles, spacing)
 *   3. Lee T1 del modal result (o lo ingresa manualmente)
 *   4. Lanza — backend encola N × M jobs Celery en paralelo
 *   5. Polling 5s: n_done/n_total + pct
 *   6. Al terminar: curvas IDA superpuestas + banda percentil 16/50/84 + colapsos
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { structuralAnalysisApi, femaLibraryApi, localCatalogApi } from "@/lib/structural-api";
import type {
  FEMAPair, LocalPair, LocalCampaign,
  IDALaunchRequest, IDAResult, IDAProgress, IDAJobSummary,
  IDAStatsPerLevel, IDACurvePoint, IDAProfilePercentiles,
} from "@/lib/structural-types";
import { usePlotly } from "@/lib/use-plotly";
import { plotlyLayoutPremium, plotlyAxisPremium, plotlyConfigPremium } from "@/lib/plotly-theme";
import { SummaryChip } from "@/components/ui/summary-chip";

interface Props {
  projectId: string;
}

// Paleta para hasta 22 pares (los 22 FEMA P-695)
const PAIR_COLORS = [
  "#4f46e5","#0ea5e9","#10b981","#f59e0b","#ef4444","#8b5cf6",
  "#ec4899","#14b8a6","#f97316","#22c55e","#06b6d4","#a855f7",
  "#eab308","#dc2626","#2563eb","#059669","#d97706","#7c3aed",
  "#db2777","#0891b2","#65a30d","#be123c",
];

export default function IDAPanel({ projectId }: Props) {
  const plotlyReady = usePlotly();

  const [catalog, setCatalog] = useState<FEMAPair[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  // Fuente del catálogo: "fema" (default, 22 pares P-695) o clave de campaña
  // local, p.ej. "colombia_2026_08_10" (99 pares NS+EW del sismo 10-ago-2026).
  const [catalogSource, setCatalogSource] = useState<string>("fema");
  const [localCampaigns, setLocalCampaigns] = useState<LocalCampaign[]>([]);
  const [regionFilter, setRegionFilter] = useState<Set<string>>(new Set());
  const [soilFilter, setSoilFilter]     = useState<Set<string>>(new Set());

  const [selectedPairs, setSelectedPairs] = useState<Set<number>>(new Set());
  const [saMin, setSaMin]       = useState<number>(0.1);
  const [saMax, setSaMax]       = useState<number>(2.0);
  const [nLevels, setNLevels]   = useState<number>(8);
  const [spacing, setSpacing]   = useState<"linear" | "log">("linear");
  const [T1, setT1]             = useState<number>(0);
  const [system, setSystem]     = useState<"frames" | "walls">("frames");

  const [jobId, setJobId]       = useState<string | null>(null);
  const [progress, setProgress] = useState<IDAProgress | null>(null);
  const [result, setResult]     = useState<IDAResult | null>(null);
  const [jobs, setJobs]         = useState<IDAJobSummary[]>([]);
  const [launching, setLaunching] = useState(false);
  const [error, setError]       = useState<string | null>(null);

  // Ola C — estado compartido entre radiografía, heatmap y mini-espectro.
  // levelIdx: nivel Sa activo; selectedPairForSpectrum: par para el mini-espectro.
  const [levelIdx, setLevelIdx] = useState<number>(0);
  const [selectedPairForSpectrum, setSelectedPairForSpectrum] = useState<number | null>(null);

  const idaRef = useRef<HTMLDivElement | null>(null);
  const bandRef = useRef<HTMLDivElement | null>(null);

  // Al llegar un resultado nuevo: posicionar levelIdx en el último nivel (más daño)
  // y limpiar el par seleccionado para que el componente autoseleccione el peor.
  useEffect(() => {
    if (result && result.stats_per_level.length > 0) {
      setLevelIdx(result.stats_per_level.length - 1);
      setSelectedPairForSpectrum(null);
    }
  }, [result]);

  // ── Cargar campañas locales + T1 + historial al montar ──────────────────
  useEffect(() => {
    (async () => {
      try {
        const lc = await localCatalogApi.listCampaigns();
        setLocalCampaigns(lc.campaigns);
      } catch { /* backend viejo o sin campañas; no es crítico */ }
      try {
        const m = await structuralAnalysisApi.getModalResult(projectId);
        const t = m.T1 ?? m.T1_x ?? m.T1_y;
        if (typeof t === "number" && t > 0) setT1(t);
      } catch { /* ignore */ }
      try {
        const js = await structuralAnalysisApi.listIDAJobs(projectId);
        setJobs(js);
        const lastOK = js.find((j) => j.status === "success");
        if (lastOK) {
          try { setResult(await structuralAnalysisApi.getIDAResult(projectId)); }
          catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    })();
  }, [projectId]);

  // ── Cargar catálogo según fuente activa ──────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setCatalog(null);
    setCatalogError(null);
    setSelectedPairs(new Set());
    setRegionFilter(new Set());
    setSoilFilter(new Set());
    (async () => {
      try {
        if (catalogSource === "fema") {
          const c = await femaLibraryApi.listPairs();
          if (!cancelled) setCatalog(c.pairs);
        } else {
          const c = await localCatalogApi.getCatalog(catalogSource);
          if (!cancelled) setCatalog(c.pairs as unknown as FEMAPair[]);
        }
      } catch (e) {
        if (!cancelled) setCatalogError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [catalogSource]);

  // ── Polling de progreso cuando hay un job en curso ──────────────────────
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const p = await structuralAnalysisApi.getIDAProgress(projectId, jobId);
        if (cancelled) return;
        setProgress(p);
        if (p.status === "success") {
          const r = await structuralAnalysisApi.getIDAResult(projectId);
          if (!cancelled) {
            setResult(r);
            setJobId(null);
            // refresh jobs list
            structuralAnalysisApi.listIDAJobs(projectId).then(setJobs).catch(() => {});
          }
        } else if (p.status === "failed" || p.status === "cancelled") {
          setJobId(null);
          structuralAnalysisApi.listIDAJobs(projectId).then(setJobs).catch(() => {});
        }
      } catch (e) {
        console.warn("[IDA] poll failed:", e);
      }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [projectId, jobId]);

  const toggle = (pairId: number) => {
    setSelectedPairs((prev) => {
      const next = new Set(prev);
      if (next.has(pairId)) next.delete(pairId); else next.add(pairId);
      return next;
    });
  };
  const selectAll = () => {
    if (!catalog) return;
    setSelectedPairs(new Set(catalog.map((p) => p.pair)));
  };
  const clearAll = () => setSelectedPairs(new Set());

  const launch = async () => {
    setError(null);
    setLaunching(true);
    try {
      const body: IDALaunchRequest = {
        pair_ids: [...selectedPairs].sort((a, b) => a - b),
        sa_min:   saMin,
        sa_max:   saMax,
        n_levels: nLevels,
        T1_s:     T1,
        system,
        spacing,
        catalog_source: catalogSource,
      };
      const r = await structuralAnalysisApi.launchIDA(projectId, body);
      setJobId(r.job_id);
      setResult(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLaunching(false);
    }
  };

  const nTotal = selectedPairs.size * nLevels;

  // ── Plot IDA curves (todos los pares + banda percentil) ─────────────────
  useEffect(() => {
    if (!result || !plotlyReady || !idaRef.current) return;
    const Plotly = (window as unknown as { Plotly: {
      newPlot: (el: HTMLElement, traces: unknown[], layout: unknown, config: unknown) => void;
    } }).Plotly;

    const traces: unknown[] = [];
    const pairIds = Object.keys(result.curves);
    pairIds.forEach((pid, idx) => {
      const pts = result.curves[pid];
      const xs = pts.filter((p) => p.max_drift_pct != null).map((p) => p.max_drift_pct as number);
      const ys = pts.filter((p) => p.max_drift_pct != null).map((p) => p.Sa_g);
      const pair = catalog?.find((c) => c.pair === Number(pid));
      const label = pair ? `#${pid} ${pair.earthquake}` : `par ${pid}`;
      traces.push({
        type: "scatter", mode: "lines+markers",
        x: xs, y: ys,
        name: label,
        line: { color: PAIR_COLORS[idx % PAIR_COLORS.length], width: 1.5 },
        marker: { size: 5, color: PAIR_COLORS[idx % PAIR_COLORS.length] },
        hovertemplate: `<b>${label}</b><br>Sa=%{y:.2f}g · deriva=%{x:.2f}%<extra></extra>`,
      });
      // Colapsos como "X" grandes
      const colX = pts.filter((p) => p.collapsed).map((p) => p.max_drift_pct ?? 10);
      const colY = pts.filter((p) => p.collapsed).map((p) => p.Sa_g);
      if (colX.length > 0) {
        traces.push({
          type: "scatter", mode: "markers",
          x: colX, y: colY,
          showlegend: false,
          marker: { symbol: "x", size: 10, color: PAIR_COLORS[idx % PAIR_COLORS.length], line: { width: 2 } },
          hovertemplate: `<b>COLAPSO</b><br>Sa=%{y:.2f}g<extra></extra>`,
        });
      }
    });

    Plotly.newPlot(idaRef.current, traces, {
      ...plotlyLayoutPremium({ showLegend: true, legendTop: false }),
      xaxis: plotlyAxisPremium({ title: "Deriva máxima de entrepiso (%)", range: [0, 10] }),
      yaxis: plotlyAxisPremium({ title: "Sa(T₁)   [g]", range: [0, result.meta.sa_max * 1.1] }),
    }, plotlyConfigPremium);
  }, [result, plotlyReady, catalog]);

  // ── Plot banda percentil (16/50/84) ──────────────────────────────────────
  useEffect(() => {
    if (!result || !plotlyReady || !bandRef.current) return;
    const Plotly = (window as unknown as { Plotly: {
      newPlot: (el: HTMLElement, traces: unknown[], layout: unknown, config: unknown) => void;
    } }).Plotly;

    const stats = result.stats_per_level;
    const sa = stats.map((s) => s.Sa_g);

    const traces = [
      // Banda sombreada 16–84
      {
        type: "scatter", mode: "lines",
        x: stats.map((s) => s.drift_p84),
        y: sa,
        showlegend: false,
        line: { color: "rgba(99,102,241,0)" },
        hoverinfo: "skip",
      },
      {
        type: "scatter", mode: "lines",
        x: stats.map((s) => s.drift_p16),
        y: sa,
        name: "banda P16–P84",
        fill: "tonextx",
        fillcolor: "rgba(99,102,241,0.18)",
        line: { color: "rgba(99,102,241,0)" },
        hoverinfo: "skip",
      },
      // Mediana
      {
        type: "scatter", mode: "lines+markers",
        x: stats.map((s) => s.drift_p50),
        y: sa,
        name: "mediana P50",
        line: { color: "#4f46e5", width: 2.5 },
        marker: { size: 6, color: "#4f46e5" },
        hovertemplate: "<b>mediana</b><br>Sa=%{y:.2f}g · deriva=%{x:.2f}%<extra></extra>",
      },
      // Fracción colapsada como ejes secundario: barras en cada nivel
      {
        type: "scatter", mode: "markers",
        x: stats.map((s) => (s.collapse_frac >= 0.5 ? s.drift_p50 : null)),
        y: sa,
        name: "≥50 % pares colapsan",
        marker: { symbol: "diamond", size: 11, color: "#dc2626",
                  line: { color: "#fff", width: 1.5 } },
        hovertemplate: "<b>Sa mediana colapso</b><br>Sa=%{y:.2f}g<extra></extra>",
      },
    ];

    Plotly.newPlot(bandRef.current, traces, {
      ...plotlyLayoutPremium({
        xTitle: "Deriva máxima de entrepiso (%)",
        yTitle: "Sa(T₁)   [g]",
        showLegend: true,
        legendTop: false,
      }),
    }, plotlyConfigPremium);
  }, [result, plotlyReady]);

  // ── Opción "colapso por fracción vs Sa" ──────────────────────────────────
  const fragilityData = useMemo(() => {
    if (!result) return null;
    return result.stats_per_level.map((s) => ({
      Sa: s.Sa_g, frac: s.collapse_frac, n_col: s.n_collapsed, n_tot: s.n_total,
    }));
  }, [result]);

  return (
    <div className="space-y-5">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="space-y-1">
        <h2 className="text-lg font-semibold text-[var(--text)]">
          IDA — Incremental Dynamic Analysis
        </h2>
        <p className="text-sm text-[var(--text-muted)]">
          Lanza N pares FEMA P-695 × M niveles de Sa(T₁) en paralelo para construir
          curvas IM-EDP, bandas de dispersión 16/50/84 y encontrar la Sa mediana
          de colapso (fracción de pares que colapsan ≥ 50 %).
        </p>
      </header>

      {/* ── Config y lanzamiento ───────────────────────────────────────── */}
      <section className="pl-glass-soft rounded-xl p-5 space-y-4">
        <h3 className="text-sm font-semibold text-[var(--text)]">Configuración</h3>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          <Field label="T₁ (s)" value={String(T1 || "")} onChange={(v) => setT1(Number(v) || 0)} />
          <Field label="Sa mín (g)" value={String(saMin)} onChange={(v) => setSaMin(Number(v) || 0.1)} />
          <Field label="Sa máx (g)" value={String(saMax)} onChange={(v) => setSaMax(Number(v) || 2)} />
          <Field label="niveles" value={String(nLevels)} onChange={(v) => setNLevels(Math.max(2, Number(v) || 8))} />
          <div>
            <label className="text-xs text-[var(--text-muted)] mb-1 block">Espaciado</label>
            <select
              value={spacing}
              onChange={(e) => setSpacing(e.target.value as "linear" | "log")}
              className="w-full rounded-md bg-[var(--panel-muted)] px-3 py-2 text-sm text-[var(--text)]"
            >
              <option value="linear">lineal</option>
              <option value="log">logarítmico</option>
            </select>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-[var(--text-muted)]">Sistema</span>
          {(["frames", "walls"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSystem(s)}
              className={`px-3 py-1 rounded text-xs font-medium ${
                system === s ? "bg-indigo-600 text-white" : "bg-[var(--panel-muted)] text-[var(--text-muted)]"
              }`}
            >
              {s === "frames" ? "Pórticos" : "Muros"}
            </button>
          ))}
        </div>
      </section>

      {/* ── Selección de catálogo (FEMA vs campañas locales) ──────────── */}
      <section className="pl-glass-soft rounded-xl p-5 space-y-3">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <h3 className="text-sm font-semibold text-[var(--text)]">Catálogo de registros</h3>
          <div className="flex gap-1">
            <button onClick={() => setCatalogSource("fema")}
              className={`px-3 py-1.5 text-xs rounded-md font-medium transition ${
                catalogSource === "fema"
                  ? "bg-indigo-600 text-white shadow"
                  : "bg-[var(--panel-muted)] text-[var(--text-muted)] hover:bg-[var(--surface-2)]"
              }`}>
              FEMA P-695 · 22 pares
            </button>
            {localCampaigns.map((c) => (
              <button key={c.campaign}
                onClick={() => setCatalogSource(c.campaign)}
                className={`px-3 py-1.5 text-xs rounded-md font-medium transition ${
                  catalogSource === c.campaign
                    ? "bg-indigo-600 text-white shadow"
                    : "bg-[var(--panel-muted)] text-[var(--text-muted)] hover:bg-[var(--surface-2)]"
                }`}
                title={`${c.n_records} registros · ${c.event_date ?? "s/f"}`}>
                {c.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ── Selección de pares ─────────────────────────────────────────── */}
      <section className="pl-glass-soft rounded-xl p-5 space-y-3">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-[var(--text)]">
            Pares {catalogSource === "fema" ? "FEMA P-695 Far-Field" : "catálogo local"} ({selectedPairs.size} seleccionados)
          </h3>
          <div className="flex gap-1">
            <button onClick={selectAll}
              className="px-2.5 py-1 text-xs rounded bg-[var(--panel-muted)] hover:bg-[var(--surface-2)] text-[var(--text)]">
              Seleccionar todos
            </button>
            <button onClick={clearAll}
              className="px-2.5 py-1 text-xs rounded bg-[var(--panel-muted)] hover:bg-[var(--surface-2)] text-[var(--text-muted)]">
              Limpiar
            </button>
          </div>
        </div>

        {/* Filtros solo para catálogo local */}
        {catalogSource !== "fema" && catalog && (() => {
          const localPairs = catalog as unknown as LocalPair[];
          const regions = Array.from(new Set(localPairs.map((p) => p.region).filter(Boolean))).sort();
          const soils = Array.from(new Set(
            localPairs.map((p) => p.soil_class).filter((s): s is string => !!s),
          )).sort();
          const toggleFilter = (set: Set<string>, setFn: (s: Set<string>) => void, v: string) => {
            const nxt = new Set(set);
            if (nxt.has(v)) nxt.delete(v); else nxt.add(v);
            setFn(nxt);
          };
          return (
            <div className="space-y-2 pb-2 border-b border-[var(--panel-muted)]/40">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] uppercase text-[var(--text-muted)] tracking-wider">Región:</span>
                {regions.map((r) => (
                  <button key={r}
                    onClick={() => toggleFilter(regionFilter, setRegionFilter, r)}
                    className={`px-2 py-0.5 rounded text-[11px] font-mono ${
                      regionFilter.has(r) || regionFilter.size === 0
                        ? "bg-indigo-500/20 text-indigo-700 dark:text-indigo-300"
                        : "bg-[var(--panel-muted)] text-[var(--text-muted)]"
                    }`}>{r}</button>
                ))}
                <span className="text-[10px] uppercase text-[var(--text-muted)] tracking-wider ml-4">Suelo:</span>
                {soils.map((s) => (
                  <button key={s}
                    onClick={() => toggleFilter(soilFilter, setSoilFilter, s)}
                    className={`px-2 py-0.5 rounded text-[11px] font-mono ${
                      soilFilter.has(s) || soilFilter.size === 0
                        ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300"
                        : "bg-[var(--panel-muted)] text-[var(--text-muted)]"
                    }`}>{s}</button>
                ))}
              </div>
              <div className="text-[10px] italic text-[var(--text-muted)]">
                Click para filtrar · sin selección = todos visibles.
              </div>
            </div>
          );
        })()}

        {catalogError && (
          <div className="rounded-lg border border-rose-500/40 bg-rose-500/5 p-3 text-xs text-rose-700 dark:text-rose-300">
            Error cargando catálogo: {catalogError}
          </div>
        )}

        {!catalog ? (
          <div className="text-sm text-[var(--text-muted)]">Cargando catálogo…</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5 max-h-96 overflow-y-auto pr-2">
            {catalog
              .filter((pair) => {
                if (catalogSource === "fema") return true;
                const lp = pair as unknown as LocalPair;
                if (regionFilter.size > 0 && !regionFilter.has(lp.region)) return false;
                if (soilFilter.size > 0 && lp.soil_class && !soilFilter.has(lp.soil_class)) return false;
                return true;
              })
              .map((pair) => {
                const lp = catalogSource !== "fema" ? (pair as unknown as LocalPair) : null;
                return (
                  <label key={pair.pair}
                    className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-xs cursor-pointer transition ${
                      selectedPairs.has(pair.pair)
                        ? "bg-indigo-500/10 border border-indigo-500/30"
                        : "bg-[var(--panel-muted)] hover:bg-[var(--surface-2)]"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedPairs.has(pair.pair)}
                      onChange={() => toggle(pair.pair)}
                      className="h-3.5 w-3.5"
                    />
                    <span className="font-mono text-[var(--text-muted)]">#{pair.pair}</span>
                    <span className="font-semibold text-[var(--text)]">
                      {lp ? lp.station : pair.earthquake}
                    </span>
                    {lp ? (
                      <>
                        <span className="text-[var(--text-muted)]">· {lp.region}</span>
                        {lp.soil_class && <span className="text-emerald-500 font-mono">· {lp.soil_class}</span>}
                      </>
                    ) : (
                      <span className="text-[var(--text-muted)]">· Mw {pair.mw}</span>
                    )}
                    <span className="text-[var(--text-muted)] truncate flex-1 text-right">
                      {lp ? `PGA ${(pair.pga?.[0] ?? 0).toFixed(2)}/${(pair.pga?.[1] ?? 0).toFixed(2)}g` : pair.station}
                    </span>
                  </label>
                );
              })}
          </div>
        )}
      </section>

      {/* ── Lanzar ─────────────────────────────────────────────────────── */}
      <div className="flex items-baseline gap-4">
        <button
          type="button"
          onClick={launch}
          disabled={launching || !!jobId || selectedPairs.size === 0 || T1 <= 0 || !catalog}
          className="rounded-md bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-semibold px-5 py-2.5"
        >
          {launching ? "Lanzando…" : jobId ? "IDA en curso…" : `Lanzar IDA (${nTotal} análisis)`}
        </button>
        <span className="text-xs text-[var(--text-muted)]">
          {selectedPairs.size} pares × {nLevels} niveles = {nTotal} NLTHAs livianos en paralelo
        </span>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/5 p-3 text-sm text-rose-700 dark:text-rose-300">
          {error}
        </div>
      )}

      {/* ── Progreso en vivo ───────────────────────────────────────────── */}
      {jobId && progress && (
        <section className="pl-glass rounded-xl p-5 space-y-3">
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-semibold text-[var(--text)]">
              Progreso del IDA
            </h3>
            <span className="text-xs font-mono text-[var(--text-muted)]">
              {progress.n_done} / {progress.n_total} ({progress.pct.toFixed(1)} %)
            </span>
          </div>
          <div className="h-2 rounded-full bg-[var(--panel-muted)] overflow-hidden">
            <div className="h-full rounded-full bg-indigo-500 transition-all duration-500"
                 style={{ width: `${Math.min(100, progress.pct)}%` }} />
          </div>
          <div className="text-[11px] text-[var(--text-muted)] italic">
            Status: <span className="font-mono">{progress.status}</span>
            {" · "}
            Los análisis corren en paralelo. Al terminar, el agregador consolida
            automáticamente las curvas y las muestra aquí.
          </div>
        </section>
      )}

      {/* ── Resultado ──────────────────────────────────────────────────── */}
      {result && (
        <>
          <SummaryCard result={result} />

          <section className="pl-glass rounded-xl p-5 space-y-3">
            <h3 className="text-sm font-semibold text-[var(--text)]">
              Curvas IDA (una por par) — Sa(T₁) vs deriva máxima de piso
            </h3>
            <div ref={idaRef} style={{ width: "100%", height: 480 }} />
            <p className="text-[11px] text-[var(--text-muted)]">
              Las curvas muestran un edificio cada vez más dañado al escalar Sa(T₁).
              La pendiente infinita (horizontal) indica el "flatline" IDA — deriva
              crece ilimitadamente, el edificio colapsa. Los <strong>×</strong> marcan
              colapso por abort del motor (Vb cayó al menos 75 %) o deriva ≥ 10 %.
            </p>
          </section>

          <section className="pl-glass rounded-xl p-5 space-y-3">
            <h3 className="text-sm font-semibold text-[var(--text)]">
              Banda percentil 16/50/84 + Sa mediana de colapso
            </h3>
            <div ref={bandRef} style={{ width: "100%", height: 420 }} />
            <p className="text-[11px] text-[var(--text-muted)]">
              La banda sombreada representa la dispersión de registros a cada
              nivel de Sa. El diamante rojo marca el nivel donde ≥ 50 % de los
              pares colapsan — la <strong>Sa mediana de colapso</strong>, métrica
              central de FEMA P-695 §6.3.
            </p>
          </section>

          {/* ── Sección forense (Ola C): heatmap + tablas + mini-espectro ─ */}
          <ForensicAnalysisSection
            result={result}
            catalog={catalog}
            T1={T1 || result.meta.T1_s}
            levelIdx={levelIdx}
            setLevelIdx={setLevelIdx}
            selectedPairId={selectedPairForSpectrum}
            setSelectedPairId={setSelectedPairForSpectrum}
          />

          {/* ── Radiografía post-sismo por nivel Sa (Ola B) ──────────────── */}
          <PostQuakeRadiography
            result={result}
            levelIdx={levelIdx}
            setLevelIdx={setLevelIdx}
          />

          {fragilityData && (
            <section className="pl-glass-soft rounded-xl p-4">
              <h4 className="text-xs uppercase tracking-wider font-semibold text-[var(--text-muted)] mb-2">
                Fracción colapsada por nivel
              </h4>
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-[var(--panel-muted)]/50 text-[var(--text-muted)] uppercase tracking-wider">
                    <th className="px-3 py-2 text-right">Sa(T₁) [g]</th>
                    <th className="px-3 py-2 text-right">colapsados / total</th>
                    <th className="px-3 py-2 text-right">fracción</th>
                    <th className="px-3 py-2 text-right">deriva P50 [%]</th>
                    <th className="px-3 py-2 text-right">θ col P50 [mrad]</th>
                  </tr>
                </thead>
                <tbody>
                  {result.stats_per_level.map((s) => (
                    <tr key={s.level_index} className="border-t border-[var(--panel-muted)]/30">
                      <td className="px-3 py-1.5 text-right font-mono">{s.Sa_g.toFixed(2)}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{s.n_collapsed} / {s.n_total}</td>
                      <td className={`px-3 py-1.5 text-right font-mono font-semibold ${
                        s.collapse_frac >= 0.5 ? "text-rose-600 dark:text-rose-400"
                        : s.collapse_frac > 0  ? "text-amber-600 dark:text-amber-400"
                        : "text-emerald-600 dark:text-emerald-400"
                      }`}>
                        {(s.collapse_frac * 100).toFixed(0)} %
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono">{s.drift_p50.toFixed(2)}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{(s.theta_col_p50 * 1000).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}

      {/* ── Historial de jobs ──────────────────────────────────────────── */}
      {jobs.length > 0 && (
        <section className="pl-glass-soft rounded-xl p-4 space-y-2">
          <h4 className="text-xs uppercase tracking-wider font-semibold text-[var(--text-muted)]">
            Historial de IDAs ({jobs.length})
          </h4>
          <div className="space-y-1">
            {jobs.slice(0, 10).map((j) => (
              <div key={j.job_id}
                className="flex items-baseline gap-3 text-xs rounded-md px-3 py-1.5 bg-[var(--panel-muted)]/40">
                <span className={`inline-block w-2 h-2 rounded-full ${
                  j.status === "success"   ? "bg-emerald-500"
                  : j.status === "running" ? "bg-indigo-500"
                  : j.status === "failed"  ? "bg-rose-500"
                  : "bg-[var(--text-muted)]"
                }`} />
                <span className="font-mono text-[var(--text-muted)]">
                  {j.created_at?.slice(0, 16)?.replace("T", " ") ?? "—"}
                </span>
                <span className="text-[var(--text)]">
                  {j.params?.pair_ids?.length ?? "?"} pares × {j.params?.n_levels ?? "?"} niveles
                </span>
                {j.result_summary && (
                  <>
                    <span className="text-[var(--text-muted)]">
                      · {j.result_summary.n_collapsed} colapsados
                    </span>
                    {j.result_summary.sa_median_collapse_g != null && (
                      <span className="text-rose-500 font-mono">
                        · Sa50 = {j.result_summary.sa_median_collapse_g.toFixed(2)} g
                      </span>
                    )}
                  </>
                )}
                <span className="ml-auto text-[var(--text-muted)] uppercase">{j.status}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Field({
  label, value, onChange,
}: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="text-xs text-[var(--text-muted)] mb-1 block">{label}</label>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md bg-[var(--panel-muted)] px-3 py-2 text-sm font-mono text-[var(--text)]"
      />
    </div>
  );
}

function SummaryCard({ result }: { result: IDAResult }) {
  const saMedian = result.sa_median_collapse_g;

  // Picks forenses adicionales: peor residual, peor piso, etc.
  // Buscamos entre todos los niveles el máximo P50 de residual y de deriva pico.
  let maxResidualP50 = 0;
  let worstLevelSa = 0;
  let totalCollapsed = 0;
  let maxDriftP50 = 0;
  for (const s of result.stats_per_level) {
    if ((s.residual_p50 ?? 0) > maxResidualP50) {
      maxResidualP50 = s.residual_p50 ?? 0;
      worstLevelSa = s.Sa_g;
    }
    if (s.drift_p50 > maxDriftP50) maxDriftP50 = s.drift_p50;
    totalCollapsed += s.n_collapsed;
  }
  const residualColor =
    maxResidualP50 >= 0.5 ? "text-rose-500" :
    maxResidualP50 >= 0.2 ? "text-amber-500" : "text-emerald-500";

  return (
    <div className="pl-glass rounded-2xl p-5 space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-[var(--text-muted)]">
            IDA completado · {result.n_pairs} pares × {result.n_levels} niveles
          </div>
          <div className="text-xs text-[var(--text-muted)] font-mono mt-0.5">
            T₁ = {result.meta.T1_s.toFixed(3)} s · Sa ∈ [{result.meta.sa_min}, {result.meta.sa_max}] g ·
            {" "}espaciado {result.meta.spacing}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase text-[var(--text-muted)]">Sa mediana colapso</div>
          <div className={`text-3xl font-mono font-semibold ${
            saMedian == null ? "text-[var(--text-muted)]"
            : saMedian < 0.5 ? "text-rose-500"
            : saMedian < 1.0 ? "text-amber-500"
            : "text-emerald-500"
          }`}>
            {saMedian == null ? "—" : `${saMedian.toFixed(2)} g`}
          </div>
        </div>
      </div>

      {/* KPIs forenses — surgen de los perfiles cosechados en Ola A */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-3 border-t border-[var(--panel-muted)]/40">
        <KpiTile
          label="Deriva pico P50"
          value={`${maxDriftP50.toFixed(2)} %`}
          hint="Mediana entre pares, nivel más alto"
          color={maxDriftP50 >= 2.0 ? "text-rose-500"
               : maxDriftP50 >= 1.0 ? "text-amber-500"
               : "text-emerald-500"}
        />
        <KpiTile
          label="Deriva residual P50"
          value={`${maxResidualP50.toFixed(2)} %`}
          hint={worstLevelSa > 0 ? `peor nivel Sa=${worstLevelSa.toFixed(2)}g` : "—"}
          color={residualColor}
          footer={maxResidualP50 >= 0.5 ? "FEMA P-58: no reparable" : "FEMA P-58: reparable"}
        />
        <KpiTile
          label="Casos colapsados"
          value={`${totalCollapsed} / ${result.n_pairs * result.n_levels}`}
          hint={`${((totalCollapsed / (result.n_pairs * result.n_levels)) * 100).toFixed(0)}% del catálogo`}
          color={totalCollapsed === 0 ? "text-emerald-500"
               : totalCollapsed < result.n_pairs ? "text-amber-500"
               : "text-rose-500"}
        />
        <KpiTile
          label="Piso crítico (global)"
          value={result.most_critical_story_idx != null
            ? `nivel ${result.most_critical_story_idx + 1}`
            : "—"}
          hint={result.stories_z && result.most_critical_story_idx != null
            ? `z ≈ ${result.stories_z[result.most_critical_story_idx]?.toFixed(1)} m`
            : "donde más se concentra el daño"}
          color="text-indigo-500"
        />
      </div>
    </div>
  );
}

function KpiTile({
  label, value, hint, color, footer,
}: {
  label:  string;
  value:  string;
  hint?:  string;
  color?: string;
  footer?: string;
}) {
  return (
    <div className="rounded-lg bg-[var(--panel-muted)]/40 p-3">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{label}</div>
      <div className={`text-xl font-mono font-semibold ${color ?? "text-[var(--text)]"} mt-0.5`}>{value}</div>
      {hint && (
        <div className="text-[10px] text-[var(--text-muted)] mt-0.5">{hint}</div>
      )}
      {footer && (
        <div className="text-[10px] italic text-[var(--text-muted)] mt-1">{footer}</div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Radiografía post-sismo — perfiles por piso (Ola B)
// ─────────────────────────────────────────────────────────────────────────────

const HINGE_COLORS = {
  io:       "#22c55e",   // verde — Operacional
  ls:       "#eab308",   // ámbar — Seguridad de vida
  cp:       "#f97316",   // naranja — Prevención de colapso
  collapse: "#dc2626",   // rojo
};

function PostQuakeRadiography({
  result, levelIdx, setLevelIdx,
}: {
  result:      IDAResult;
  levelIdx:    number;
  setLevelIdx: (i: number) => void;
}) {
  const plotlyReady = usePlotly();

  const driftRef  = useRef<HTMLDivElement | null>(null);
  const accelRef  = useRef<HTMLDivElement | null>(null);
  const dispRef   = useRef<HTMLDivElement | null>(null);
  const damageRef = useRef<HTMLDivElement | null>(null);

  const level: IDAStatsPerLevel | undefined = result.stats_per_level[levelIdx];
  const stories_z = result.stories_z ?? [];
  const n_stories = result.n_stories ?? stories_z.length;

  // Para la deriva por entrepiso usamos la altura promedio del entrepiso como
  // eje Y (más honesto que el nivel-número). Si no hay stories_z, caemos a 1..N.
  const storyHeights = useMemo(() => {
    if (stories_z.length === n_stories && n_stories > 0) {
      // deriva en entrepiso i va entre z[i-1] y z[i]; usamos el punto medio.
      return stories_z.map((z, i) => {
        const z0 = i === 0 ? 0 : stories_z[i - 1];
        return (z + z0) / 2;
      });
    }
    return Array.from({ length: n_stories }, (_, i) => i + 1);
  }, [stories_z, n_stories]);

  // ── Agregar hinges por piso promediando entre todos los pares ────────────
  // Para el nivel seleccionado, sumamos hinges_by_story de todos los pares
  // y dividimos por n_pairs para obtener el daño "esperado" por piso.
  const damageByStory = useMemo(() => {
    const byStory: Record<string, {
      io: number; ls: number; cp: number; collapse: number;
      total: number; order: number;
    }> = {};
    const pairIds = Object.keys(result.curves);
    for (const pid of pairIds) {
      const pt: IDACurvePoint | undefined = result.curves[pid][levelIdx];
      if (!pt || !pt.hinges_by_story) continue;
      for (const [story, counts] of Object.entries(pt.hinges_by_story)) {
        const row = byStory[story] ?? {
          io: 0, ls: 0, cp: 0, collapse: 0, total: 0,
          order: Object.keys(byStory).length,
        };
        row.io       += counts.io;
        row.ls       += counts.ls;
        row.cp       += counts.cp;
        row.collapse += counts.collapse;
        row.total    += counts.total;
        byStory[story] = row;
      }
    }
    // Promediar por n_pares (daño esperado por par)
    const n = pairIds.length || 1;
    const rows = Object.entries(byStory).map(([story, v]) => ({
      story,
      io:       v.io / n,
      ls:       v.ls / n,
      cp:       v.cp / n,
      collapse: v.collapse / n,
      total:    v.total / n,
      order:    v.order,
    }));
    rows.sort((a, b) => a.story.localeCompare(b.story, undefined, { numeric: true }));
    return rows;
  }, [result.curves, levelIdx]);

  // ── Gráfico 1: Perfil de deriva por piso (anclado en base) ───────────────
  useEffect(() => {
    if (!level || !plotlyReady || !driftRef.current) return;
    const Plotly = (window as unknown as { Plotly: {
      newPlot: (el: HTMLElement, traces: unknown[], layout: unknown, config: unknown) => void;
    } }).Plotly;

    const prof = level.drift_profile;
    // Anclamos en la base (z=0, deriva=0) para ver el perfil completo.
    const y = [0, ...storyHeights];
    const traces: unknown[] = [];
    if (prof && prof.p50.length === n_stories) {
      // Banda P16–P84 (sombreada)
      traces.push({
        type: "scatter", mode: "lines",
        x: [0, ...prof.p84], y, name: "P84",
        line: { color: "rgba(99,102,241,0)" }, showlegend: false, hoverinfo: "skip",
      });
      traces.push({
        type: "scatter", mode: "lines",
        x: [0, ...prof.p16], y, name: "banda P16–P84",
        fill: "tonextx", fillcolor: "rgba(99,102,241,0.18)",
        line: { color: "rgba(99,102,241,0)" }, hoverinfo: "skip",
      });
      // Mediana P50
      traces.push({
        type: "scatter", mode: "lines+markers",
        x: [0, ...prof.p50], y,
        name: "mediana P50",
        line: { color: "#4f46e5", width: 2.5 },
        marker: { size: 7, color: "#4f46e5" },
        hovertemplate: "<b>Deriva P50</b><br>z = %{y:.2f} m<br>deriva = %{x:.3f} %<extra></extra>",
      });
    }
    // Línea NSR-10 A.6.4.2 (1% deriva de servicio para ptCs regulares)
    const yMax = Math.max(...y, 1);
    traces.push({
      type: "scatter", mode: "lines",
      x: [1.0, 1.0], y: [0, yMax * 1.05],
      name: "NSR-10 Δ ≤ 1 %",
      line: { color: "#dc2626", width: 1.5, dash: "dash" },
      hoverinfo: "skip",
    });

    Plotly.newPlot(driftRef.current, traces, {
      ...plotlyLayoutPremium({ showLegend: true, legendTop: false }),
      xaxis: plotlyAxisPremium({ title: "Deriva de entrepiso (%)", range: [0, Math.max((prof?.p84.reduce((a,b) => Math.max(a,b), 0) ?? 0) * 1.3, 1.5)] }),
      yaxis: plotlyAxisPremium({ title: "Altura (m)" }),
    }, plotlyConfigPremium);
  }, [level, plotlyReady, storyHeights, n_stories]);

  // ── Gráfico 2: Perfil de aceleración absoluta por piso ───────────────────
  useEffect(() => {
    if (!level || !plotlyReady || !accelRef.current) return;
    const Plotly = (window as unknown as { Plotly: {
      newPlot: (el: HTMLElement, traces: unknown[], layout: unknown, config: unknown) => void;
    } }).Plotly;

    const prof = level.accel_profile;
    const y = storyHeights;
    const traces: unknown[] = [];
    if (prof && prof.p50.length === n_stories) {
      traces.push({
        type: "scatter", mode: "lines",
        x: prof.p84, y, name: "P84",
        line: { color: "rgba(14,165,233,0)" }, showlegend: false, hoverinfo: "skip",
      });
      traces.push({
        type: "scatter", mode: "lines",
        x: prof.p16, y, name: "banda P16–P84",
        fill: "tonextx", fillcolor: "rgba(14,165,233,0.18)",
        line: { color: "rgba(14,165,233,0)" }, hoverinfo: "skip",
      });
      traces.push({
        type: "scatter", mode: "lines+markers",
        x: prof.p50, y,
        name: "mediana P50",
        line: { color: "#0ea5e9", width: 2.5 },
        marker: { size: 7, color: "#0ea5e9" },
        hovertemplate: "<b>Aceleración abs P50</b><br>piso %{pointIndex} @ z=%{y:.1f}m<br>a=%{x:.2f} m/s²<extra></extra>",
      });
    }
    // PGA del nivel (como línea vertical para comparar amplificación)
    const pga_mps2 = (level.pga_p50_g ?? 0) * 9.81;
    if (pga_mps2 > 0) {
      const yMax = Math.max(...y, 1);
      traces.push({
        type: "scatter", mode: "lines",
        x: [pga_mps2, pga_mps2], y: [0, yMax * 1.05],
        name: `PGA = ${level.pga_p50_g?.toFixed(2)} g`,
        line: { color: "#64748b", width: 1.5, dash: "dot" },
        hoverinfo: "skip",
      });
    }

    Plotly.newPlot(accelRef.current, traces, {
      ...plotlyLayoutPremium({ showLegend: true, legendTop: false }),
      xaxis: plotlyAxisPremium({ title: "Aceleración absoluta (m/s²)" }),
      yaxis: plotlyAxisPremium({ title: "Altura (m)" }),
    }, plotlyConfigPremium);
  }, [level, plotlyReady, storyHeights, n_stories]);

  // ── Gráfico 3: Perfil de desplazamiento por piso (unidades m, base en 0) ─
  useEffect(() => {
    if (!level || !plotlyReady || !dispRef.current) return;
    const Plotly = (window as unknown as { Plotly: {
      newPlot: (el: HTMLElement, traces: unknown[], layout: unknown, config: unknown) => void;
    } }).Plotly;

    const prof = level.disp_profile;
    // Anclamos la deformada en la base (z=0, u=0) para que se vea completa.
    const y = [0, ...storyHeights];
    const traces: unknown[] = [];
    if (prof && prof.p50.length === n_stories) {
      traces.push({
        type: "scatter", mode: "lines",
        x: [0, ...prof.p84], y, name: "P84",
        line: { color: "rgba(16,185,129,0)" }, showlegend: false, hoverinfo: "skip",
      });
      traces.push({
        type: "scatter", mode: "lines",
        x: [0, ...prof.p16], y, name: "banda P16–P84",
        fill: "tonextx", fillcolor: "rgba(16,185,129,0.18)",
        line: { color: "rgba(16,185,129,0)" }, hoverinfo: "skip",
      });
      traces.push({
        type: "scatter", mode: "lines+markers",
        x: [0, ...prof.p50], y,
        name: "mediana P50",
        line: { color: "#10b981", width: 2.5 },
        marker: { size: 7, color: "#10b981" },
        hovertemplate: "<b>Desplazamiento P50</b><br>z = %{y:.2f} m<br>u = %{x:.4f} m<extra></extra>",
      });
    }

    Plotly.newPlot(dispRef.current, traces, {
      ...plotlyLayoutPremium({ showLegend: true, legendTop: false }),
      xaxis: plotlyAxisPremium({ title: "Desplazamiento lateral (m)" }),
      yaxis: plotlyAxisPremium({ title: "Altura (m)" }),
    }, plotlyConfigPremium);
  }, [level, plotlyReady, storyHeights, n_stories]);

  // ── Gráfico 4: Distribución de rótulas plásticas por piso ────────────────
  useEffect(() => {
    if (!plotlyReady || !damageRef.current || damageByStory.length === 0) return;
    const Plotly = (window as unknown as { Plotly: {
      newPlot: (el: HTMLElement, traces: unknown[], layout: unknown, config: unknown) => void;
    } }).Plotly;

    const stories = damageByStory.map((d) => d.story);
    const traces = [
      {
        type: "bar", orientation: "h",
        x: damageByStory.map((d) => d.io),
        y: stories, name: "IO · Operacional",
        marker: { color: HINGE_COLORS.io },
        hovertemplate: "<b>IO</b><br>piso %{y}<br>n = %{x:.1f} (prom. por par)<extra></extra>",
      },
      {
        type: "bar", orientation: "h",
        x: damageByStory.map((d) => d.ls),
        y: stories, name: "LS · Seguridad vida",
        marker: { color: HINGE_COLORS.ls },
        hovertemplate: "<b>LS</b><br>piso %{y}<br>n = %{x:.1f}<extra></extra>",
      },
      {
        type: "bar", orientation: "h",
        x: damageByStory.map((d) => d.cp),
        y: stories, name: "CP · Prev. colapso",
        marker: { color: HINGE_COLORS.cp },
        hovertemplate: "<b>CP</b><br>piso %{y}<br>n = %{x:.1f}<extra></extra>",
      },
      {
        type: "bar", orientation: "h",
        x: damageByStory.map((d) => d.collapse),
        y: stories, name: "Colapso",
        marker: { color: HINGE_COLORS.collapse },
        hovertemplate: "<b>COLAPSO</b><br>piso %{y}<br>n = %{x:.1f}<extra></extra>",
      },
    ];

    Plotly.newPlot(damageRef.current, traces, {
      ...plotlyLayoutPremium({ showLegend: true, legendTop: false }),
      barmode: "stack",
      xaxis: plotlyAxisPremium({ title: "Rótulas plásticas por piso (promedio entre pares)" }),
      yaxis: plotlyAxisPremium({ title: "Piso" }),
    }, plotlyConfigPremium);
  }, [damageByStory, plotlyReady]);

  if (!level) {
    return null;
  }

  // Residual del nivel seleccionado para mostrar como KPI del encabezado
  const residualPct = level.residual_p50 ?? 0;
  const residualColor =
    residualPct >= 0.5 ? "text-rose-500" :
    residualPct >= 0.2 ? "text-amber-500" : "text-emerald-500";

  return (
    <section className="pl-glass rounded-xl p-5 space-y-4">
      <header className="flex flex-col md:flex-row md:items-baseline md:justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text)]">
            Radiografía post-sismo — perfiles por piso
          </h3>
          <p className="text-[11px] text-[var(--text-muted)]">
            Para cada nivel Sa, cómo quedó el edificio: dónde se concentró la
            deriva, qué pisos aceleraron más, y la distribución de rótulas
            plásticas. Mediana + banda P16–P84 entre los {result.n_pairs} pares.
          </p>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase text-[var(--text-muted)]">
            Deriva residual P50 (nivel {levelIdx + 1})
          </div>
          <div className={`text-2xl font-mono font-semibold ${residualColor}`}>
            {residualPct.toFixed(2)} %
          </div>
          <div className="text-[10px] italic text-[var(--text-muted)]">
            {residualPct >= 0.5 ? "FEMA P-58: probablemente no reparable"
             : residualPct >= 0.2 ? "atención: residual significativa"
             : "sin residual significativa"}
          </div>
        </div>
      </header>

      {/* Selector de nivel Sa */}
      <div className="flex flex-wrap gap-1.5 items-center">
        <span className="text-xs text-[var(--text-muted)] mr-2">Nivel Sa:</span>
        {result.stats_per_level.map((s, idx) => (
          <button
            key={idx}
            onClick={() => setLevelIdx(idx)}
            className={`px-2.5 py-1 rounded text-xs font-mono transition ${
              idx === levelIdx
                ? "bg-indigo-600 text-white shadow"
                : "bg-[var(--panel-muted)] text-[var(--text-muted)] hover:bg-[var(--surface-2)]"
            }`}
            title={`Sa(T₁) = ${s.Sa_g.toFixed(3)} g · ${s.n_collapsed}/${s.n_total} pares colapsados`}
          >
            {s.Sa_g.toFixed(2)}g
            {s.n_collapsed > 0 && (
              <span className="ml-1 text-[9px] opacity-80">
                ×{s.n_collapsed}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Grid 2x2 con los 4 perfiles */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="space-y-1">
          <h4 className="text-xs uppercase tracking-wider font-semibold text-[var(--text-muted)]">
            Perfil de deriva de entrepiso (%)
          </h4>
          <div ref={driftRef} style={{ width: "100%", height: 340 }} />
        </div>
        <div className="space-y-1">
          <h4 className="text-xs uppercase tracking-wider font-semibold text-[var(--text-muted)]">
            Aceleración absoluta por piso (m/s²)
          </h4>
          <div ref={accelRef} style={{ width: "100%", height: 340 }} />
        </div>
        <div className="space-y-1">
          <h4 className="text-xs uppercase tracking-wider font-semibold text-[var(--text-muted)]">
            Desplazamiento lateral por piso (m) — deformada completa
          </h4>
          <div ref={dispRef} style={{ width: "100%", height: 340 }} />
        </div>
        <div className="space-y-1">
          <h4 className="text-xs uppercase tracking-wider font-semibold text-[var(--text-muted)]">
            Rótulas plásticas por piso (apiladas IO/LS/CP/colapso)
          </h4>
          <div ref={damageRef} style={{ width: "100%", height: 340 }} />
        </div>
      </div>

      <div className="text-[11px] text-[var(--text-muted)] italic">
        <strong>Lectura rápida:</strong> el piso con la banda más corrida hacia
        la derecha en el perfil de deriva es el <em>piso crítico</em>, donde el
        daño se concentra; una banda ancha indica fuerte dispersión entre
        registros. La aceleración absoluta sirve para evaluar anclajes de
        contenido no estructural (NSR-10 A.9). Las rótulas en CP/colapso
        marcan elementos que necesitan intervención prioritaria.
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Ola C — Análisis forense panorámico: heatmap piso × Sa, tabla piso crítico,
// peores pares por EDP del nivel seleccionado y mini-espectro del par escogido
// (natural vs escalado). Lee los perfiles ya cosechados en Ola A.
// ─────────────────────────────────────────────────────────────────────────────

/** Interpolación lineal en Sa(T) para el par (periodos ya ordenados). */
function interpSaAt(periods: number[], sa: number[], T: number): number {
  const n = periods.length;
  if (n === 0 || sa.length !== n) return 0;
  if (T <= periods[0])   return sa[0];
  if (T >= periods[n-1]) return sa[n-1];
  for (let i = 1; i < n; i++) {
    if (T <= periods[i]) {
      const t0 = periods[i-1], t1 = periods[i];
      const s0 = sa[i-1],      s1 = sa[i];
      return s0 + (s1 - s0) * (T - t0) / (t1 - t0);
    }
  }
  return sa[n-1];
}

/** Aproximación Abramowitz-Stegun 26.2.17 a la CDF normal estándar. */
function normCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-(z * z) / 2);
  const p = d * t * ((((1.330274429 * t - 1.821255978) * t + 1.781477937) * t - 0.356563782) * t + 0.319381530);
  return z > 0 ? 1 - p : p;
}

/** P(X > x) para X ~ lognormal estimada desde P16/P50/P84:
 *  μ_ln = ln(P50), σ_ln = (ln(P84) − ln(P16)) / 2. Fallback binario si σ ≈ 0. */
function lognormalProbExceeds(p16: number, p50: number, p84: number, x: number): number {
  const FLOOR = 1e-4;
  const p16s = Math.max(p16, FLOOR);
  const p50s = Math.max(p50, FLOOR);
  const p84s = Math.max(p84, FLOOR);
  const sigma = (Math.log(p84s) - Math.log(p16s)) / 2;
  if (!isFinite(sigma) || sigma <= 1e-6) {
    return p50 >= x ? 1 : 0;
  }
  const z = (Math.log(x) - Math.log(p50s)) / sigma;
  return 1 - normCdf(z);
}

function ForensicAnalysisSection({
  result, catalog, T1, levelIdx, setLevelIdx,
  selectedPairId, setSelectedPairId,
}: {
  result:            IDAResult;
  catalog:           FEMAPair[] | null;
  T1:                number;
  levelIdx:          number;
  setLevelIdx:       (i: number) => void;
  selectedPairId:    number | null;
  setSelectedPairId: (pid: number | null) => void;
}) {
  const plotlyReady = usePlotly();
  const cascadeRefs  = useRef<(HTMLDivElement | null)[]>([]);
  const fragilityRef = useRef<HTMLDivElement | null>(null);
  const spectrumRef  = useRef<HTMLDivElement | null>(null);

  const stories_z = result.stories_z ?? [];
  const n_stories = result.n_stories ?? stories_z.length;
  const storyLabels = useMemo(
    () => Array.from({ length: n_stories }, (_, i) => `P${String(i + 1).padStart(2, "0")}`),
    [n_stories],
  );
  const level = result.stats_per_level[levelIdx];

  // Rango X compartido entre los mini-perfiles — misma escala para que el ojo
  // compare la progresión de daño de un Sa al siguiente.
  const xMaxGlobal = useMemo(() => {
    let m = 0;
    for (const lvl of result.stats_per_level) {
      const p = lvl.drift_profile;
      if (!p) continue;
      for (const v of p.p84) if (v > m) m = v;
    }
    return Math.max(2.5, m * 1.05);
  }, [result.stats_per_level]);

  // ── 2. Piso crítico por nivel ────────────────────────────────────────────
  const criticalByLevel = useMemo(() => {
    return result.stats_per_level.map((s) => {
      const prof = s.drift_profile;
      if (!prof || prof.p50.length === 0) {
        return { sa: s.Sa_g, story: null as number | null, drift: null as number | null,
                 collapse: s.collapse_frac, residual: s.residual_p50 ?? null };
      }
      let maxDrift = -Infinity;
      let maxStory = 0;
      for (let i = 0; i < prof.p50.length; i++) {
        if (prof.p50[i] > maxDrift) { maxDrift = prof.p50[i]; maxStory = i; }
      }
      return {
        sa:       s.Sa_g,
        story:    maxStory + 1,
        drift:    maxDrift,
        collapse: s.collapse_frac,
        residual: s.residual_p50 ?? null,
      };
    });
  }, [result.stats_per_level]);

  // ── 3. Peores pares del nivel actual ─────────────────────────────────────
  const worstPairs = useMemo(() => {
    const rows = Object.keys(result.curves).map((pid) => {
      const pt: IDACurvePoint | undefined = result.curves[pid][levelIdx];
      if (!pt) return null;
      const meta = catalog?.find((c) => c.pair === Number(pid));
      const pga =
        pt.pga_vector_g != null ? pt.pga_vector_g
        : Math.max(pt.pga_x_g ?? 0, pt.pga_y_g ?? 0);
      return {
        pairId:         Number(pid),
        earthquake:     meta?.earthquake ?? "—",
        year:           meta?.year ?? null,
        station:        meta?.station ?? "—",
        pga_g:          pga,
        drift_pct:      pt.max_drift_pct ?? 0,
        residual_pct:   pt.residual_drift_pct ?? 0,
        critical_story: pt.critical_story_idx != null ? pt.critical_story_idx + 1 : null,
        collapsed:      !!pt.collapsed,
      };
    }).filter((r): r is NonNullable<typeof r> => r !== null);
    rows.sort((a, b) => b.drift_pct - a.drift_pct);
    return rows;
  }, [result.curves, levelIdx, catalog]);

  // Autoseleccionar el peor par del nivel cuando cambia la lista
  useEffect(() => {
    if (worstPairs.length === 0) return;
    if (selectedPairId == null || !worstPairs.some((r) => r.pairId === selectedPairId)) {
      setSelectedPairId(worstPairs[0].pairId);
    }
  }, [worstPairs, selectedPairId, setSelectedPairId]);

  // ── Plot 1: cascada small multiples — un mini-perfil por nivel Sa ────────
  useEffect(() => {
    if (!plotlyReady || n_stories === 0) return;
    const Plotly = (window as unknown as { Plotly: {
      newPlot: (el: HTMLElement, traces: unknown[], layout: unknown, config: unknown) => void;
    } }).Plotly;

    result.stats_per_level.forEach((lvl, idx) => {
      const el = cascadeRefs.current[idx];
      const profile: IDAProfilePercentiles | undefined = lvl.drift_profile;
      if (!el || !profile) return;

      const stories = Array.from({ length: n_stories }, (_, i) => i + 1);
      const isActive = idx === levelIdx;

      // Piso crítico por P50 (coincide con la tabla "piso crítico por nivel").
      let maxP50 = -Infinity;
      let critStory = 1;
      for (let i = 0; i < profile.p50.length; i++) {
        if (profile.p50[i] > maxP50) { maxP50 = profile.p50[i]; critStory = i + 1; }
      }

      const traces: unknown[] = [
        // Banda P16-P84: traza invisible superior + inferior con fill tonextx.
        { type: "scatter", mode: "lines", x: profile.p84, y: stories,
          line: { color: "rgba(0,0,0,0)", width: 0 },
          showlegend: false, hoverinfo: "skip" },
        { type: "scatter", mode: "lines", x: profile.p16, y: stories,
          line: { color: "rgba(0,0,0,0)", width: 0 },
          fill: "tonextx", fillcolor: "rgba(99,102,241,0.18)",
          showlegend: false, hoverinfo: "skip" },
        // Mediana P50.
        { type: "scatter", mode: "lines+markers", x: profile.p50, y: stories,
          line: { color: "#4f46e5", width: 2.2 },
          marker: { size: 4, color: "#4f46e5" },
          hovertemplate: "Piso %{y} · P50 = %{x:.2f}%<extra></extra>",
          showlegend: false },
        // Piso crítico (anillo rojo).
        { type: "scatter", mode: "markers", x: [maxP50], y: [critStory],
          marker: { symbol: "circle-open", size: 14, color: "#ef4444", line: { width: 2 } },
          hovertemplate: `piso crítico ${critStory} · Δ = ${maxP50.toFixed(2)}%<extra></extra>`,
          showlegend: false },
      ];

      // Umbrales NSR-10 / ASCE 41 verticales (IO · LS · CP).
      const shapes: unknown[] = [
        { type: "line", xref: "x", yref: "paper", x0: 0.5, x1: 0.5, y0: 0, y1: 1,
          line: { color: "#10b981", width: 1, dash: "dot" } },
        { type: "line", xref: "x", yref: "paper", x0: 1.0, x1: 1.0, y0: 0, y1: 1,
          line: { color: "#f59e0b", width: 1, dash: "dot" } },
        { type: "line", xref: "x", yref: "paper", x0: 2.0, x1: 2.0, y0: 0, y1: 1,
          line: { color: "#ef4444", width: 1, dash: "dot" } },
      ];

      const dtickStories = Math.max(1, Math.round(n_stories / 8));

      Plotly.newPlot(el, traces, {
        ...plotlyLayoutPremium({ showLegend: false }),
        xaxis: plotlyAxisPremium({ title: "Δ [%]", range: [0, xMaxGlobal] }),
        yaxis: {
          ...plotlyAxisPremium({
            title: idx === 0 ? "Piso" : "",
            range: [0.5, n_stories + 0.5],
          }),
          dtick: dtickStories,
        },
        shapes,
        margin: { l: idx === 0 ? 46 : 28, r: 10, t: 34, b: 42 },
        title: {
          text: `Sa=${lvl.Sa_g.toFixed(2)}g · col ${(lvl.collapse_frac * 100).toFixed(0)}%`,
          font: { size: 10.5, color: isActive ? "#6366f1" : "#64748b" },
          x: 0.5, xref: "paper",
        },
      }, plotlyConfigPremium);
    });
  }, [plotlyReady, result.stats_per_level, n_stories, levelIdx, xMaxGlobal]);

  // ── Plot 2: fragility heatmap — P(Δ > LS = 1 %) por piso × Sa ────────────
  useEffect(() => {
    if (!plotlyReady || !fragilityRef.current || n_stories === 0) return;
    const Plotly = (window as unknown as { Plotly: {
      newPlot: (el: HTMLElement, traces: unknown[], layout: unknown, config: unknown) => void;
    } }).Plotly;

    const LS = 1.0;
    const zFrag: (number | null)[][] = [];
    for (let s = 0; s < n_stories; s++) {
      const row: (number | null)[] = [];
      for (const lvl of result.stats_per_level) {
        const p: IDAProfilePercentiles | undefined = lvl.drift_profile;
        if (!p || p.p50.length <= s) { row.push(null); continue; }
        row.push(lognormalProbExceeds(p.p16[s], p.p50[s], p.p84[s], LS));
      }
      zFrag.push(row);
    }

    const sa = result.stats_per_level.map((s) => s.Sa_g);
    const selSa = level?.Sa_g;
    const shapes: unknown[] = [];
    if (selSa != null) {
      shapes.push({
        type: "line", xref: "x", yref: "paper",
        x0: selSa, x1: selSa, y0: 0, y1: 1,
        line: { color: "#6366f1", width: 3 },
      });
    }

    Plotly.newPlot(fragilityRef.current, [
      {
        type: "heatmap",
        z: zFrag, x: sa, y: storyLabels,
        zmin: 0, zmax: 1,
        colorscale: [
          [0.00, "#065f46"],
          [0.10, "#10b981"],
          [0.30, "#eab308"],
          [0.60, "#f97316"],
          [1.00, "#7f1d1d"],
        ],
        colorbar: { title: { text: "P(Δ > LS)" }, thickness: 14, len: 0.85, x: 1.02, tickformat: ".0%" },
        hovertemplate: "<b>%{y}</b> · Sa=%{x:.2f}g<br>P(Δ > 1%) = %{z:.0%}<extra></extra>",
      },
      {
        type: "contour",
        z: zFrag, x: sa, y: storyLabels,
        contours: {
          showlabels: true, labelfont: { color: "#ffffff", size: 10 },
          start: 0.1, end: 0.9, size: 0.4, coloring: "none",
        },
        line: { color: "#ffffff", width: 1.5, dash: "dot" },
        showscale: false, hoverinfo: "skip",
      },
    ], {
      ...plotlyLayoutPremium({ showLegend: false }),
      xaxis: plotlyAxisPremium({ title: "Sa(T₁) [g]" }),
      yaxis: plotlyAxisPremium({ title: "Piso" }),
      shapes,
      margin: { l: 70, r: 100, t: 20, b: 55 },
    }, plotlyConfigPremium);
  }, [plotlyReady, result.stats_per_level, n_stories, level, storyLabels]);

  // ── Plot mini-espectro par seleccionado ──────────────────────────────────
  useEffect(() => {
    if (!plotlyReady || !spectrumRef.current) return;
    if (selectedPairId == null || !catalog || !level) return;
    const pair = catalog.find((c) => c.pair === selectedPairId);
    if (!pair || !pair.spectra) return;

    const Plotly = (window as unknown as { Plotly: {
      newPlot: (el: HTMLElement, traces: unknown[], layout: unknown, config: unknown) => void;
    } }).Plotly;

    const periods = pair.spectra.periods;
    const geomean = pair.spectra.geomean;
    const [h1key, h2key] = pair.files.map((f) => f.toLowerCase());
    const h1 = (pair.spectra[h1key] ?? []) as number[];
    const h2 = (pair.spectra[h2key] ?? []) as number[];

    const T1_val = T1 > 0 ? T1 : result.meta.T1_s;
    const saT1  = interpSaAt(periods, geomean, T1_val);
    const scale = saT1 > 0 ? level.Sa_g / saT1 : 1.0;
    const scaledGeomean = geomean.map((s) => s * scale);
    const yMax = Math.max(
      ...h1, ...h2, ...geomean, ...scaledGeomean, level.Sa_g,
    ) * 1.08;

    const traces: unknown[] = [
      { type: "scatter", mode: "lines", x: periods, y: h1,
        name: `${pair.files[0]} (H1)`,
        line: { color: "#94a3b8", width: 1.3, dash: "dot" },
        hovertemplate: "H1 · T=%{x:.2f}s · Sa=%{y:.3f}g<extra></extra>",
      },
      { type: "scatter", mode: "lines", x: periods, y: h2,
        name: `${pair.files[1]} (H2)`,
        line: { color: "#cbd5e1", width: 1.3, dash: "dot" },
        hovertemplate: "H2 · T=%{x:.2f}s · Sa=%{y:.3f}g<extra></extra>",
      },
      { type: "scatter", mode: "lines", x: periods, y: geomean,
        name: "geomean natural",
        line: { color: "#64748b", width: 2.0 },
        hovertemplate: "geomean · T=%{x:.2f}s · Sa=%{y:.3f}g<extra></extra>",
      },
      { type: "scatter", mode: "lines+markers", x: periods, y: scaledGeomean,
        name: `geomean escalado · Sa objetivo ${level.Sa_g.toFixed(2)}g (×${scale.toFixed(2)})`,
        line: { color: "#4f46e5", width: 2.6 },
        marker: { size: 5, color: "#4f46e5" },
        hovertemplate: "escalado · T=%{x:.2f}s · Sa=%{y:.3f}g<extra></extra>",
      },
      // Marcador en T₁ del edificio sobre la curva escalada
      { type: "scatter", mode: "markers", x: [T1_val], y: [level.Sa_g],
        name: `T₁ = ${T1_val.toFixed(3)}s`,
        marker: { symbol: "star", size: 14, color: "#ef4444",
                  line: { color: "#fff", width: 1.5 } },
        hovertemplate: `<b>T₁ = ${T1_val.toFixed(3)}s</b><br>Sa objetivo = ${level.Sa_g.toFixed(3)}g<extra></extra>`,
      },
    ];

    Plotly.newPlot(spectrumRef.current, traces, {
      ...plotlyLayoutPremium({ showLegend: true, legendTop: false }),
      xaxis: { ...plotlyAxisPremium({ title: "Período T (s)", range: [Math.log10(0.05), Math.log10(4)] }), type: "log" },
      yaxis: plotlyAxisPremium({ title: "Sa (g)", range: [0, yMax] }),
      shapes: [{
        type: "line", xref: "x", yref: "paper",
        x0: T1_val, x1: T1_val, y0: 0, y1: 1,
        line: { color: "#ef4444", width: 1.5, dash: "dash" },
      }],
    }, plotlyConfigPremium);
  }, [plotlyReady, selectedPairId, catalog, level, T1, result.meta.T1_s]);

  if (!level || n_stories === 0) return null;

  return (
    <section className="pl-glass rounded-xl p-5 space-y-5">
      <header className="flex flex-col md:flex-row md:items-baseline md:justify-between gap-2">
        <div>
          <div className="inline-flex items-center gap-1.5 rounded-full bg-violet-500/15 border border-violet-500/30 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-violet-600 dark:text-violet-300 mb-1.5">
            <span className="h-1 w-1 rounded-full bg-violet-500" style={{ boxShadow: "0 0 5px #8b5cf6" }} />
            Ola C · Forense
          </div>
          <h3 className="text-sm font-semibold text-[var(--text)]">
            Análisis forense · dónde duele y qué registro lo causa
          </h3>
          <p className="text-[11px] text-[var(--text-muted)]">
            Cascada de perfiles por piso (un mini-gráfico por nivel Sa) con banda
            P16–P84 y umbrales NSR-10 / ASCE 41 (IO · LS · CP); debajo, un mapa de
            probabilidad P(Δ &gt; LS) sintetiza el riesgo. Las tablas identifican el
            piso crítico y los pares más agresivos; el mini-espectro muestra el par
            seleccionado escalado al Sa objetivo.
          </p>
        </div>
      </header>

      {/* ── Strip resumen del nivel Sa activo ───────────────────────────── */}
      {(() => {
        const critical = criticalByLevel[levelIdx];
        if (!critical) return null;
        const driftTone =
          critical.drift == null ? "neutral" :
          critical.drift >= 2.0  ? "rose" :
          critical.drift >= 1.0  ? "amber" : "emerald";
        const residualTone =
          critical.residual == null ? "neutral" :
          critical.residual >= 0.5  ? "rose" :
          critical.residual >= 0.2  ? "amber" : "emerald";
        const collapseTone =
          level.collapse_frac >= 0.5 ? "rose" :
          level.collapse_frac >= 0.1 ? "amber" : "emerald";
        return (
          <div className="flex flex-wrap gap-2 rounded-lg border border-[var(--panel-muted)]/40 bg-[var(--panel-muted)]/25 p-2">
            <SummaryChip
              label="Sa activo"
              value={`${level.Sa_g.toFixed(2)} g`}
              hint={`nivel ${levelIdx + 1} de ${result.stats_per_level.length}`}
              tone="indigo"
            />
            <SummaryChip
              label="Deriva P50 máx"
              value={critical.drift != null ? `${critical.drift.toFixed(2)} %` : "—"}
              hint={critical.story != null ? `piso crítico ${critical.story}` : undefined}
              tone={driftTone}
            />
            <SummaryChip
              label="Residual P50"
              value={critical.residual != null ? `${critical.residual.toFixed(2)} %` : "—"}
              hint="deformación permanente"
              tone={residualTone}
            />
            <SummaryChip
              label="% colapso"
              value={`${(level.collapse_frac * 100).toFixed(0)} %`}
              hint={`${level.n_collapsed} / ${level.n_total} pares`}
              tone={collapseTone}
            />
          </div>
        );
      })()}

      {/* ── 1. Cascada small multiples ──────────────────────────────────── */}
      <div className="space-y-2">
        <div className="flex items-baseline justify-between flex-wrap gap-2">
          <h4 className="text-xs uppercase tracking-wider font-semibold text-[var(--text-muted)]">
            Perfiles de deriva por piso · banda P16–P84 · por nivel Sa
          </h4>
          <div className="flex gap-3 text-[10px] text-[var(--text-muted)]">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: "#10b981" }} />
              IO 0.5 %
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: "#f59e0b" }} />
              LS 1.0 %
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: "#ef4444" }} />
              CP 2.0 %
            </span>
            <span className="inline-flex items-center gap-1.5 ml-2">
              <span className="h-2 w-5" style={{ background: "rgba(99,102,241,0.3)" }} />
              banda P16–P84
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full border-2" style={{ borderColor: "#ef4444" }} />
              piso crítico
            </span>
          </div>
        </div>
        <div
          className="grid gap-2"
          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}
        >
          {result.stats_per_level.map((lvl, idx) => (
            <div
              key={idx}
              onClick={() => setLevelIdx(idx)}
              className={`cursor-pointer rounded-md border transition ${
                idx === levelIdx
                  ? "border-indigo-400/60 bg-indigo-500/5 ring-1 ring-indigo-400/30"
                  : "border-[var(--panel-muted)]/30 hover:border-indigo-400/30 hover:bg-indigo-500/5"
              }`}
              title={`Sa = ${lvl.Sa_g.toFixed(2)} g · clic para fijar este nivel`}
            >
              <div
                ref={(el) => { cascadeRefs.current[idx] = el; }}
                style={{ width: "100%", height: 230 }}
              />
            </div>
          ))}
        </div>
      </div>

      {/* ── 2. Fragility heatmap — P(Δ > LS) ──────────────────────────── */}
      <div className="space-y-1">
        <h4 className="text-xs uppercase tracking-wider font-semibold text-[var(--text-muted)]">
          Mapa de probabilidad de excedencia — P(Δ &gt; LS = 1 %)
        </h4>
        <div ref={fragilityRef} style={{ width: "100%", height: 300 }} />
        <div className="text-[10px] italic text-[var(--text-muted)]">
          Calculado desde los percentiles P16/P50/P84 asumiendo distribución
          lognormal de la deriva entre pares (β = [ln(P84) − ln(P16)] / 2).
          Isolíneas blancas en 10 %, 50 %, 90 % delimitan zonas de riesgo. La
          vertical índigo marca el nivel Sa seleccionado.
        </div>
      </div>

      {/* ── Dos tablas lado a lado ──────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Piso crítico por nivel */}
        <div className="pl-glass-soft rounded-lg p-3 space-y-2">
          <h4 className="text-xs uppercase tracking-wider font-semibold text-[var(--text-muted)]">
            Piso crítico por nivel Sa
          </h4>
          <div className="overflow-y-auto max-h-80">
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] bg-[var(--panel-muted)]/50 sticky top-0">
                <tr>
                  <th className="px-2 py-1.5 text-right">Sa [g]</th>
                  <th className="px-2 py-1.5 text-right">piso</th>
                  <th className="px-2 py-1.5 text-right">deriva P50 [%]</th>
                  <th className="px-2 py-1.5 text-right">residual P50 [%]</th>
                  <th className="px-2 py-1.5 text-right">colapso</th>
                </tr>
              </thead>
              <tbody>
                {criticalByLevel.map((r, i) => {
                  const active = i === levelIdx;
                  const driftColor =
                    r.drift == null              ? "text-[var(--text-muted)]" :
                    r.drift >= 2.0               ? "text-rose-500" :
                    r.drift >= 1.0               ? "text-amber-500" :
                                                   "text-emerald-500";
                  return (
                    <tr key={i}
                      onClick={() => setLevelIdx(i)}
                      className={`cursor-pointer border-t border-[var(--panel-muted)]/30 hover:bg-indigo-500/10 transition ${
                        active ? "bg-indigo-500/20 ring-1 ring-indigo-400/40" : ""
                      }`}
                      title="Clic para ver este nivel en los paneles"
                    >
                      <td className="px-2 py-1 text-right font-mono">{r.sa.toFixed(2)}</td>
                      <td className="px-2 py-1 text-right font-mono">{r.story ?? "—"}</td>
                      <td className={`px-2 py-1 text-right font-mono font-semibold ${driftColor}`}>
                        {r.drift != null ? r.drift.toFixed(2) : "—"}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">
                        {r.residual != null ? r.residual.toFixed(2) : "—"}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">
                        {(r.collapse * 100).toFixed(0)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="text-[10px] italic text-[var(--text-muted)]">
            Clic en una fila para fijar ese nivel Sa en el resto del panel.
          </div>
        </div>

        {/* Peores pares del nivel activo */}
        <div className="pl-glass-soft rounded-lg p-3 space-y-2">
          <h4 className="text-xs uppercase tracking-wider font-semibold text-[var(--text-muted)]">
            Peores pares — Sa = {level.Sa_g.toFixed(2)} g
          </h4>
          <div className="overflow-y-auto max-h-80">
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] bg-[var(--panel-muted)]/50 sticky top-0">
                <tr>
                  <th className="px-2 py-1.5 text-left">par</th>
                  <th className="px-2 py-1.5 text-right">PGA [g]</th>
                  <th className="px-2 py-1.5 text-right">deriva [%]</th>
                  <th className="px-2 py-1.5 text-right">resid. [%]</th>
                  <th className="px-2 py-1.5 text-right">piso</th>
                  <th className="px-2 py-1.5 text-right">estado</th>
                </tr>
              </thead>
              <tbody>
                {worstPairs.slice(0, 15).map((r) => {
                  const active = r.pairId === selectedPairId;
                  return (
                    <tr key={r.pairId}
                      onClick={() => setSelectedPairId(r.pairId)}
                      className={`cursor-pointer border-t border-[var(--panel-muted)]/30 hover:bg-indigo-500/10 transition ${
                        active ? "bg-indigo-500/20 ring-1 ring-indigo-400/40" : ""
                      }`}
                      title="Clic para ver el espectro de este par"
                    >
                      <td className="px-2 py-1 text-left">
                        <span className="font-mono text-[var(--text-muted)]">#{r.pairId}</span>
                        {" "}
                        <span className="text-[var(--text)]">{r.earthquake}</span>
                      </td>
                      <td className="px-2 py-1 text-right font-mono">{r.pga_g.toFixed(2)}</td>
                      <td className={`px-2 py-1 text-right font-mono font-semibold ${
                        r.drift_pct >= 2.0 ? "text-rose-500" :
                        r.drift_pct >= 1.0 ? "text-amber-500" : "text-emerald-500"
                      }`}>
                        {r.drift_pct.toFixed(2)}
                      </td>
                      <td className={`px-2 py-1 text-right font-mono ${
                        r.residual_pct >= 0.5 ? "text-rose-500" :
                        r.residual_pct >= 0.2 ? "text-amber-500" : "text-[var(--text-muted)]"
                      }`}>
                        {r.residual_pct.toFixed(2)}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">
                        {r.critical_story ?? "—"}
                      </td>
                      <td className="px-2 py-1 text-right">
                        {r.collapsed ? (
                          <span className="font-mono text-rose-500 font-semibold">COL</span>
                        ) : (
                          <span className="font-mono text-emerald-500">OK</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="text-[10px] italic text-[var(--text-muted)]">
            Ordenado por deriva pico descendente · clic en una fila para ver su
            espectro escalado.
          </div>
        </div>
      </div>

      {/* ── Mini-espectro del par seleccionado ──────────────────────────── */}
      <div className="space-y-1">
        <div className="flex items-baseline justify-between">
          <h4 className="text-xs uppercase tracking-wider font-semibold text-[var(--text-muted)]">
            Espectro de respuesta — par {selectedPairId != null ? `#${selectedPairId}` : "—"}
            {catalog && selectedPairId != null && (() => {
              const p = catalog.find((c) => c.pair === selectedPairId);
              return p ? (
                <span className="ml-2 normal-case tracking-normal font-normal text-[var(--text)]">
                  {p.earthquake} ({p.year}) · {p.station} · Mw {p.mw} · R<sub>rup</sub>={p.rrup_km} km
                </span>
              ) : null;
            })()}
          </h4>
        </div>
        <div ref={spectrumRef} style={{ width: "100%", height: 320 }} />
        <div className="text-[10px] italic text-[var(--text-muted)]">
          Línea entrecortada roja: período fundamental del edificio T₁.
          Curva índigo: espectro geomean escalado al nivel Sa seleccionado
          (FEMA P-695 §6.2 — mismo factor a ambas componentes para preservar
          la asimetría H1/H2).
        </div>
      </div>
    </section>
  );
}

