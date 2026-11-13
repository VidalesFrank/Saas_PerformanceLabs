"use client";

/**
 * Catálogo del sismo de San José del Palmar (Colombia · 10-ago-2026).
 *
 * Reporte técnico tipo "paper" inspirado en el documento de referencia del
 * área técnica: hero + 5 KPI cards + tabla integral + mapa de estaciones +
 * plots por estación (acelerogramas H1/H2 + espectro de respuesta).
 *
 * Fuentes:
 *   GET /api/v1/local-catalog/catalog?campaign=colombia_2026_08_10
 *   GET /api/v1/local-catalog/record/{name}/preview
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { AppHeader } from "@/components/app-header";
import { localCatalogApi } from "@/lib/structural-api";
import type { LocalCatalog, LocalPair, LocalRecordPreview } from "@/lib/structural-types";
import { usePlotly } from "@/lib/use-plotly";
import { plotlyLayoutPremium, plotlyAxisPremium, plotlyConfigPremium } from "@/lib/plotly-theme";

const CAMPAIGN = "colombia_2026_08_10";

// Mapa Leaflet client-only (evita SSR + problemas de window).
const StationsMap = dynamic(() => import("@/components/catalog/StationsMap"), {
  ssr: false,
  loading: () => (
    <div className="h-full w-full flex items-center justify-center text-sm text-[var(--text-muted)]">
      Cargando mapa…
    </div>
  ),
});

type LoadStatus = "idle" | "loading" | "ok" | "error";

export default function ColombiaCatalogPage() {
  const plotlyReady = usePlotly();

  const [catalog, setCatalog] = useState<LocalCatalog | null>(null);
  const [status, setStatus]   = useState<LoadStatus>("idle");
  const [error, setError]     = useState<string | null>(null);

  const [selectedStation, setSelectedStation] = useState<string | null>(null);
  const [previewH1, setPreviewH1] = useState<LocalRecordPreview | null>(null);
  const [previewH2, setPreviewH2] = useState<LocalRecordPreview | null>(null);

  const [sortBy, setSortBy] = useState<"pga" | "sa">("pga");

  const accelH1Ref = useRef<HTMLDivElement | null>(null);
  const accelH2Ref = useRef<HTMLDivElement | null>(null);
  const spectrumRef = useRef<HTMLDivElement | null>(null);

  // ── Load catálogo ─────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    (async () => {
      try {
        const cat = await localCatalogApi.getCatalog(CAMPAIGN);
        if (!cancelled) {
          setCatalog(cat);
          setStatus("ok");
          // Auto-seleccionar estación con mayor PGA
          const best = [...cat.pairs].sort((a, b) => {
            const pa = Math.max(a.pga?.[0] ?? 0, a.pga?.[1] ?? 0);
            const pb = Math.max(b.pga?.[0] ?? 0, b.pga?.[1] ?? 0);
            return pb - pa;
          })[0];
          if (best) setSelectedStation(best.station);
        }
      } catch (e) {
        if (!cancelled) {
          setStatus("error");
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const selectedPair = useMemo(
    () => catalog?.pairs.find((p) => p.station === selectedStation) ?? null,
    [catalog, selectedStation],
  );

  // ── Load preview (H1 + H2) al cambiar estación ────────────────────────────
  useEffect(() => {
    if (!selectedPair) return;
    let cancelled = false;
    setPreviewH1(null);
    setPreviewH2(null);
    (async () => {
      try {
        const [h1, h2] = await Promise.all([
          localCatalogApi.getRecordPreview(selectedPair.files[0], 800, CAMPAIGN),
          localCatalogApi.getRecordPreview(selectedPair.files[1], 800, CAMPAIGN),
        ]);
        if (!cancelled) { setPreviewH1(h1); setPreviewH2(h2); }
      } catch (e) {
        console.warn("[catalog] preview fail:", e);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedPair]);

  // ── KPIs globales del catálogo ────────────────────────────────────────────
  const kpis = useMemo(() => {
    if (!catalog) return null;
    type Peak = { value: number; station: string; component: string; region: string; soil: string | null };
    const empty: Peak = { value: 0, station: "—", component: "—", region: "—", soil: null };
    let pgaPeak = empty;
    let saPeak  = empty;
    let saPeakT = 0;

    for (const p of catalog.pairs) {
      [0, 1].forEach((i) => {
        const pg = p.pga?.[i];
        if (pg != null && pg > pgaPeak.value) {
          pgaPeak = {
            value: pg,
            station: p.station,
            component: i === 0 ? "NS" : "EW",
            region: p.region,
            soil: p.soil_class,
          };
        }
      });
      if (p.spectra && p.spectra.geomean && p.spectra.periods) {
        for (let k = 0; k < p.spectra.geomean.length; k++) {
          const sa = p.spectra.geomean[k];
          if (sa > saPeak.value) {
            saPeak = { value: sa, station: p.station, component: "geomean",
                       region: p.region, soil: p.soil_class };
            saPeakT = p.spectra.periods[k];
          }
        }
      }
    }

    // Duración máxima (como proxy de D5-95 sin FFT)
    let durMax = 0;
    for (const p of catalog.pairs) {
      const d = Math.max(p.duration_s?.[0] ?? 0, p.duration_s?.[1] ?? 0);
      if (d > durMax) durMax = d;
    }
    // Total de estaciones únicas con al menos 1 par válido
    const stations = new Set(catalog.pairs.map((p) => p.station));
    const regions  = new Set(catalog.pairs.map((p) => p.region));

    return { pgaPeak, saPeak, saPeakT, durMax, nStations: stations.size, nRegions: regions.size, nPairs: catalog.pairs.length };
  }, [catalog]);

  // ── Tabla ordenable ───────────────────────────────────────────────────────
  type TableRow = {
    station: string; region: string; soil: string | null;
    pga_ns: number | null; pga_ew: number | null;
    duration_s: number | null;
    sa_max: number | null; sa_max_T: number | null;
  };
  const tableRows: TableRow[] = useMemo(() => {
    if (!catalog) return [];
    const rows: TableRow[] = catalog.pairs.map((p) => {
      let saMax = 0;
      let saMaxT = 0;
      if (p.spectra?.geomean && p.spectra.periods) {
        for (let i = 0; i < p.spectra.geomean.length; i++) {
          if (p.spectra.geomean[i] > saMax) {
            saMax = p.spectra.geomean[i];
            saMaxT = p.spectra.periods[i];
          }
        }
      }
      return {
        station:   p.station,
        region:    p.region,
        soil:      p.soil_class,
        pga_ns:    p.pga?.[0] ?? null,
        pga_ew:    p.pga?.[1] ?? null,
        duration_s: Math.max(p.duration_s?.[0] ?? 0, p.duration_s?.[1] ?? 0) || null,
        sa_max:    saMax || null,
        sa_max_T:  saMaxT || null,
      };
    });
    const peak = (r: TableRow) => Math.max(r.pga_ns ?? 0, r.pga_ew ?? 0);
    rows.sort((a, b) => sortBy === "pga"
      ? peak(b) - peak(a)
      : (b.sa_max ?? 0) - (a.sa_max ?? 0),
    );
    return rows;
  }, [catalog, sortBy]);

  // ── Plot acelerograma helper ──────────────────────────────────────────────
  const plotAccel = useCallback((
    el: HTMLDivElement | null, prev: LocalRecordPreview | null,
    component: string, color: string,
  ) => {
    if (!el || !prev || !plotlyReady) return;
    const Plotly = (window as unknown as { Plotly: {
      newPlot: (el: HTMLElement, traces: unknown[], layout: unknown, config: unknown) => void;
    } }).Plotly;
    Plotly.newPlot(el, [{
      type: "scatter", mode: "lines",
      x: prev.t, y: prev.a,
      line: { color, width: 1.2 },
      hovertemplate: `${component} · t=%{x:.2f}s · a=%{y:.4f}g<extra></extra>`,
    }], {
      ...plotlyLayoutPremium({ showLegend: false }),
      xaxis: plotlyAxisPremium({ title: "Tiempo (s)" }),
      yaxis: plotlyAxisPremium({ title: "Aceleración (g)" }),
      margin: { l: 55, r: 20, t: 10, b: 45 },
    }, plotlyConfigPremium);
  }, [plotlyReady]);

  useEffect(() => { plotAccel(accelH1Ref.current, previewH1, "H1 (NS)", "#4f46e5"); }, [plotAccel, previewH1]);
  useEffect(() => { plotAccel(accelH2Ref.current, previewH2, "H2 (EW)", "#059669"); }, [plotAccel, previewH2]);

  // ── Plot espectro Sa(T) ───────────────────────────────────────────────────
  useEffect(() => {
    if (!spectrumRef.current || !selectedPair?.spectra || !plotlyReady) return;
    const spec = selectedPair.spectra;
    const [h1Key, h2Key] = selectedPair.files.map((f) => f.toLowerCase());
    const Plotly = (window as unknown as { Plotly: {
      newPlot: (el: HTMLElement, traces: unknown[], layout: unknown, config: unknown) => void;
    } }).Plotly;
    const traces: unknown[] = [
      { type: "scatter", mode: "lines", x: spec.periods, y: spec[h1Key] ?? [],
        name: "H1 (NS)", line: { color: "#4f46e5", width: 1.8 } },
      { type: "scatter", mode: "lines", x: spec.periods, y: spec[h2Key] ?? [],
        name: "H2 (EW)", line: { color: "#059669", width: 1.8 } },
      { type: "scatter", mode: "lines", x: spec.periods, y: spec.geomean,
        name: "geomean", line: { color: "#ea580c", width: 2.5, dash: "dot" } },
    ];
    Plotly.newPlot(spectrumRef.current, traces, {
      ...plotlyLayoutPremium({ showLegend: true, legendTop: false }),
      xaxis: { ...plotlyAxisPremium({ title: "Período T (s)", range: [Math.log10(0.05), Math.log10(4)] }), type: "log" },
      yaxis: plotlyAxisPremium({ title: "Sa (g)" }),
      margin: { l: 60, r: 20, t: 10, b: 45 },
    }, plotlyConfigPremium);
  }, [selectedPair, plotlyReady]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-screen">
      <AppHeader crumb="Catálogo · Sismo Colombia 10-ago-2026" />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">

          {/* ── Hero ───────────────────────────────────────────────────── */}
          <section className="pl-glass rounded-2xl p-6 bg-gradient-to-br from-orange-500/15 via-rose-500/5 to-transparent border border-orange-500/30">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-orange-500/20 text-orange-700 dark:text-orange-300 text-[11px] font-semibold uppercase tracking-wider mb-3">
              Reporte técnico · catálogo sísmico
            </div>
            <h1 className="text-3xl font-extrabold text-[var(--text)] tracking-tight">
              Sismo San José del Palmar
            </h1>
            <p className="text-sm text-[var(--text-muted)] mt-1">10 de agosto de 2026 · Colombia</p>
            <p className="text-sm text-[var(--text)] mt-4 max-w-3xl">
              Catálogo integral de acelerogramas horizontales (NS y EW) registrados por las redes
              acelerográficas de <b>Cali</b>, <b>Manizales</b>, <b>Pereira</b> y la Red Nacional <b>SGC</b>.
              Los pares se integran al pipeline de análisis dinámico no lineal (IDA / NLRHA) para
              verificación NSR-10 con registros locales.
            </p>
            {kpis && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-5 pt-5 border-t border-[var(--panel-muted)]/40">
                <HeroStat label="Estaciones"     value={`${kpis.nStations}`} hint={`${kpis.nRegions} regiones`} />
                <HeroStat label="Pares NS+EW"    value={`${kpis.nPairs}`}    hint="horizontales válidos" />
                <HeroStat label="Duración máx."  value={`${kpis.durMax.toFixed(0)} s`} hint="registro más largo" />
                <HeroStat label="Dominio"        value="T ∈ [0.05, 4] s"     hint="ξ = 5 %" />
              </div>
            )}
          </section>

          {/* ── KPI cards ──────────────────────────────────────────────── */}
          {kpis && (
            <section className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
              <KpiCard
                color="rose" title="PGA máximo registrado"
                value={`${kpis.pgaPeak.value.toFixed(3)} g`}
                subtitle={`${kpis.pgaPeak.station} · ${kpis.pgaPeak.component} · ${kpis.pgaPeak.region} · suelo ${kpis.pgaPeak.soil ?? "s/d"}`}
              />
              <KpiCard
                color="purple" title="Sa máx. espectral (geomean)"
                value={`${kpis.saPeak.value.toFixed(3)} g`}
                subtitle={`${kpis.saPeak.station} · T = ${kpis.saPeakT.toFixed(2)} s · ξ = 5 %`}
              />
              <KpiCard
                color="emerald" title="Duración máxima (registro)"
                value={`${kpis.durMax.toFixed(1)} s`}
                subtitle="proxy de contenido energético"
              />
              <KpiCard
                color="amber" title="Cobertura regional"
                value={`${kpis.nRegions} regiones`}
                subtitle={`${kpis.nStations} estaciones · ${kpis.nPairs} pares horizontales`}
              />
            </section>
          )}

          {status === "loading" && (
            <div className="pl-glass-soft rounded-xl p-6 text-sm text-[var(--text-muted)]">
              Cargando catálogo del sismo (espectros 5 % ξ por par)…
            </div>
          )}
          {status === "error" && (
            <div className="rounded-xl border border-rose-500/40 bg-rose-500/5 p-4 text-sm text-rose-700 dark:text-rose-300">
              Error cargando catálogo: {error}
            </div>
          )}

          {/* ── Mapa + plots de estación seleccionada ──────────────────── */}
          {catalog && (
            <section className="grid grid-cols-1 lg:grid-cols-5 gap-4">
              <div className="lg:col-span-2 pl-glass rounded-xl p-4 space-y-3">
                <h3 className="text-sm font-semibold text-[var(--text)]">
                  Mapa de estaciones ({catalog.pairs.length})
                </h3>
                <div className="rounded-lg overflow-hidden border border-[var(--panel-muted)]/40" style={{ height: 420 }}>
                  <StationsMap
                    pairs={catalog.pairs}
                    selectedStation={selectedStation}
                    onSelect={setSelectedStation}
                  />
                </div>
                <div className="flex gap-3 text-[11px] text-[var(--text-muted)]">
                  <LegendDot color="#2563eb" label="CALI" />
                  <LegendDot color="#059669" label="MANIZALES" />
                  <LegendDot color="#d97706" label="PEREIRA" />
                  <LegendDot color="#dc2626" label="SGC" />
                </div>
              </div>

              <div className="lg:col-span-3 pl-glass rounded-xl p-4 space-y-3">
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <h3 className="text-sm font-semibold text-[var(--text)]">
                    Estación: <span className="font-mono text-indigo-600 dark:text-indigo-400">{selectedPair?.station ?? "—"}</span>
                    {selectedPair && (
                      <span className="text-xs text-[var(--text-muted)] font-normal ml-2">
                        {selectedPair.region} · suelo {selectedPair.soil_class ?? "s/d"} ·
                        {" "}PGA: NS {selectedPair.pga?.[0]?.toFixed(3)}g, EW {selectedPair.pga?.[1]?.toFixed(3)}g
                      </span>
                    )}
                  </h3>
                  <select
                    value={selectedStation ?? ""}
                    onChange={(e) => setSelectedStation(e.target.value || null)}
                    className="rounded-md bg-[var(--panel-muted)] px-3 py-1 text-xs text-[var(--text)]">
                    {catalog.pairs.map((p) => (
                      <option key={p.station} value={p.station}>
                        {p.station} · {p.region}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <div className="text-[10px] uppercase text-[var(--text-muted)] tracking-wider">Acelerograma H1 (NS)</div>
                    <div ref={accelH1Ref} style={{ width: "100%", height: 180 }} />
                  </div>
                  <div className="space-y-1">
                    <div className="text-[10px] uppercase text-[var(--text-muted)] tracking-wider">Acelerograma H2 (EW)</div>
                    <div ref={accelH2Ref} style={{ width: "100%", height: 180 }} />
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="text-[10px] uppercase text-[var(--text-muted)] tracking-wider">
                    Espectro de respuesta Sa(T) · ξ = 5 % · H1 + H2 + geomean (FEMA P-695 §6.2)
                  </div>
                  <div ref={spectrumRef} style={{ width: "100%", height: 260 }} />
                </div>
              </div>
            </section>
          )}

          {/* ── Tabla integral ─────────────────────────────────────────── */}
          {catalog && (
            <section className="pl-glass rounded-xl p-5 space-y-3">
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <div>
                  <h3 className="text-sm font-semibold text-[var(--text)]">
                    Tabla integral de parámetros sísmicos
                  </h3>
                  <p className="text-[11px] text-[var(--text-muted)]">
                    Picos y espectro máximo por par (NS/EW). Click en el encabezado para ordenar.
                  </p>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => setSortBy("pga")}
                    className={`px-2.5 py-1 text-xs rounded font-medium ${
                      sortBy === "pga" ? "bg-indigo-600 text-white" : "bg-[var(--panel-muted)] text-[var(--text-muted)]"
                    }`}>
                    Ordenar por PGA
                  </button>
                  <button onClick={() => setSortBy("sa")}
                    className={`px-2.5 py-1 text-xs rounded font-medium ${
                      sortBy === "sa" ? "bg-indigo-600 text-white" : "bg-[var(--panel-muted)] text-[var(--text-muted)]"
                    }`}>
                    Ordenar por Sa máx
                  </button>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] bg-[var(--panel-muted)]/50 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left">Estación</th>
                      <th className="px-3 py-2 text-left">Región</th>
                      <th className="px-3 py-2 text-left">Suelo</th>
                      <th className="px-3 py-2 text-right">PGA NS [g]</th>
                      <th className="px-3 py-2 text-right">PGA EW [g]</th>
                      <th className="px-3 py-2 text-right">Dur [s]</th>
                      <th className="px-3 py-2 text-right">Sa máx [g]</th>
                      <th className="px-3 py-2 text-right">T(Sa) [s]</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map((r, idx) => {
                      const top3 = idx < 3;
                      const sel = r.station === selectedStation;
                      return (
                        <tr key={r.station}
                          onClick={() => setSelectedStation(r.station)}
                          className={`cursor-pointer border-t border-[var(--panel-muted)]/30 hover:bg-indigo-500/10 transition ${
                            sel ? "bg-indigo-500/15 ring-1 ring-indigo-400/40"
                            : top3 ? "bg-amber-500/5" : ""
                          }`}>
                          <td className="px-3 py-1.5 font-mono font-semibold text-[var(--text)]">
                            {top3 && <span className="inline-block w-5 text-amber-500">★</span>}
                            {r.station}
                          </td>
                          <td className="px-3 py-1.5 text-[var(--text-muted)]">{r.region}</td>
                          <td className="px-3 py-1.5 font-mono">{r.soil ?? "—"}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{r.pga_ns != null ? r.pga_ns.toFixed(3) : "—"}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{r.pga_ew != null ? r.pga_ew.toFixed(3) : "—"}</td>
                          <td className="px-3 py-1.5 text-right font-mono text-[var(--text-muted)]">{r.duration_s?.toFixed(1) ?? "—"}</td>
                          <td className={`px-3 py-1.5 text-right font-mono font-semibold ${
                            r.sa_max && r.sa_max > 0.5 ? "text-rose-500"
                            : r.sa_max && r.sa_max > 0.3 ? "text-amber-500"
                            : "text-emerald-500"
                          }`}>
                            {r.sa_max != null ? r.sa_max.toFixed(3) : "—"}
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono text-[var(--text-muted)]">
                            {r.sa_max_T != null ? r.sa_max_T.toFixed(2) : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="text-[11px] italic text-[var(--text-muted)]">
                ★ Top 3 por {sortBy === "pga" ? "PGA" : "Sa máximo"}. Sa calculado como
                geomean H1/H2, amortiguamiento 5 %, Newmark β = 1/4. Todos los pares están
                disponibles para selección en los módulos <code>IDA</code> y <code>NLRHA</code>
                vía la pestaña <code>Colombia · 10-ago-2026</code>.
              </div>
            </section>
          )}

        </div>
      </div>
    </div>
  );
}

// ── Sub-componentes ──────────────────────────────────────────────────────────

function HeroStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-semibold">{label}</div>
      <div className="text-lg font-mono font-semibold text-[var(--text)] mt-0.5">{value}</div>
      {hint && <div className="text-[10px] text-[var(--text-muted)]">{hint}</div>}
    </div>
  );
}

const KPI_COLOR: Record<string, string> = {
  rose:    "from-rose-500/25 to-transparent border-rose-500/40 text-rose-500",
  purple:  "from-purple-500/25 to-transparent border-purple-500/40 text-purple-500",
  emerald: "from-emerald-500/25 to-transparent border-emerald-500/40 text-emerald-500",
  amber:   "from-amber-500/25 to-transparent border-amber-500/40 text-amber-500",
  cyan:    "from-cyan-500/25 to-transparent border-cyan-500/40 text-cyan-500",
};
function KpiCard({
  color, title, value, subtitle,
}: { color: string; title: string; value: string; subtitle: string }) {
  const parts = KPI_COLOR[color]?.split(" ") ?? [];
  const txtClass = parts.find((c) => c.startsWith("text-")) ?? "text-[var(--text)]";
  const gradient = parts.filter((c) => !c.startsWith("text-")).join(" ");
  return (
    <div className={`pl-glass rounded-xl p-4 bg-gradient-to-br ${gradient} border`}>
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-semibold">{title}</div>
      <div className={`text-2xl font-mono font-bold mt-1 ${txtClass}`}>{value}</div>
      <div className="text-[11px] text-[var(--text-muted)] mt-1.5">{subtitle}</div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}
