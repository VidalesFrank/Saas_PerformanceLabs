"use client";

/**
 * Panel NLRHA — Verificación NSR-10 / ASCE 7-22 Cap 16.
 *
 * A diferencia del IDA (barrido Sa para investigación), el NLRHA escala
 * los N pares seleccionados a UN único Sa objetivo = Sa_NSR-10(T1, ciudad,
 * suelo) × I × MCE_mult y verifica cumplimiento de Δ ≤ 1 % (A.6.4.2).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  structuralAnalysisApi, femaLibraryApi, localCatalogApi,
} from "@/lib/structural-api";
import type {
  FEMAPair, LocalPair, LocalCampaign,
  NLRHALaunchRequest, NLRHAResult, IDAProgress, IDAJobSummary,
  NLRHAStoryVerification,
} from "@/lib/structural-types";
import { usePlotly } from "@/lib/use-plotly";
import { plotlyLayoutPremium, plotlyAxisPremium, plotlyConfigPremium } from "@/lib/plotly-theme";
import { SummaryChip, type ChipTone } from "@/components/ui/summary-chip";

interface Props {
  projectId: string;
}

type SoilType = "A" | "B" | "C" | "D" | "E";
type UseGroup = "I" | "II" | "III" | "IV";

const USE_GROUP_LABEL: Record<UseGroup, string> = {
  I:   "Grupo I · ocupación normal",
  II:  "Grupo II · comunidad alta",
  III: "Grupo III · atención comunidad (hospitales…)",
  IV:  "Grupo IV · indispensables (bomberos…)",
};

const USE_GROUP_I_FACTOR: Record<UseGroup, number> = { I: 1.0, II: 1.0, III: 1.25, IV: 1.5 };

export default function NLRHAPanel({ projectId }: Props) {
  const plotlyReady = usePlotly();

  // ── Catálogo FEMA + T1 modal ────────────────────────────────────────────
  const [catalog, setCatalog]             = useState<FEMAPair[] | null>(null);
  const [catalogError, setCatalogError]   = useState<string | null>(null);
  const [T1, setT1]                       = useState<number>(0);

  // Fuente de registros: FEMA o campaña local
  const [catalogSource, setCatalogSource] = useState<string>("fema");
  const [localCampaigns, setLocalCampaigns] = useState<LocalCampaign[]>([]);
  const [regionFilter, setRegionFilter]   = useState<Set<string>>(new Set());
  const [soilFilter, setSoilFilter]       = useState<Set<string>>(new Set());

  // ── Parámetros NSR-10 ───────────────────────────────────────────────────
  const [Aa, setAa]                       = useState<number>(0.25);
  const [Av, setAv]                       = useState<number>(0.25);
  const [soilType, setSoilType]           = useState<SoilType>("D");
  const [useGroup, setUseGroup]           = useState<UseGroup>("II");
  const [mceMultiplier, setMceMultiplier] = useState<number>(1.0);
  const [system, setSystem]               = useState<"frames" | "walls">("frames");

  // ── Selección de pares ──────────────────────────────────────────────────
  const [selectedPairs, setSelectedPairs] = useState<Set<number>>(new Set());

  // ── Estado del job ──────────────────────────────────────────────────────
  const [jobId, setJobId]                 = useState<string | null>(null);
  const [progress, setProgress]           = useState<IDAProgress | null>(null);
  const [result, setResult]               = useState<NLRHAResult | null>(null);
  const [jobs, setJobs]                   = useState<IDAJobSummary[]>([]);
  const [launching, setLaunching]         = useState(false);
  const [error, setError]                 = useState<string | null>(null);

  const driftRef = useRef<HTMLDivElement | null>(null);

  // ── Load campañas locales + T1 + último result al montar ────────────────
  useEffect(() => {
    (async () => {
      try {
        const lc = await localCatalogApi.listCampaigns();
        setLocalCampaigns(lc.campaigns);
      } catch { /* ok si no hay campañas */ }
      try {
        const m = await structuralAnalysisApi.getModalResult(projectId);
        const t = m.T1 ?? m.T1_x ?? m.T1_y;
        if (typeof t === "number" && t > 0) setT1(t);
      } catch { /* ignore */ }
      try {
        const js = await structuralAnalysisApi.listNLRHAJobs(projectId);
        setJobs(js);
        if (js.find((j) => j.status === "success")) {
          try { setResult(await structuralAnalysisApi.getNLRHAResult(projectId)); }
          catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    })();
  }, [projectId]);

  // ── Catálogo según fuente activa ─────────────────────────────────────────
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

  // ── Polling de progreso ─────────────────────────────────────────────────
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const p = await structuralAnalysisApi.getIDAProgress(projectId, jobId);
        if (cancelled) return;
        setProgress(p);
        if (p.status === "success") {
          const r = await structuralAnalysisApi.getNLRHAResult(projectId);
          if (!cancelled) {
            setResult(r);
            setJobId(null);
            structuralAnalysisApi.listNLRHAJobs(projectId).then(setJobs).catch(() => {});
          }
        } else if (p.status === "failed" || p.status === "cancelled") {
          setJobId(null);
          structuralAnalysisApi.listNLRHAJobs(projectId).then(setJobs).catch(() => {});
        }
      } catch (e) {
        console.warn("[NLRHA] poll failed:", e);
      }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [projectId, jobId]);

  // ── Helpers selección ───────────────────────────────────────────────────
  const togglePair = (pairId: number) => {
    setSelectedPairs((prev) => {
      const next = new Set(prev);
      if (next.has(pairId)) next.delete(pairId); else next.add(pairId);
      return next;
    });
  };
  const presetAll = () => catalog && setSelectedPairs(new Set(catalog.map((p) => p.pair)));
  const presetASCE = () => catalog && setSelectedPairs(new Set(catalog.slice(0, 11).map((p) => p.pair)));
  const presetNSR  = () => catalog && setSelectedPairs(new Set(catalog.slice(0, 7).map((p) => p.pair)));
  const clearAll   = () => setSelectedPairs(new Set());

  const launch = useCallback(async () => {
    setError(null);
    setLaunching(true);
    try {
      const body: NLRHALaunchRequest = {
        pair_ids:      [...selectedPairs].sort((a, b) => a - b),
        Aa, Av, soil_type: soilType, use_group: useGroup,
        T1_s:          T1,
        mce_multiplier: mceMultiplier,
        system,
        catalog_source: catalogSource,
      };
      const r = await structuralAnalysisApi.launchNLRHA(projectId, body);
      setJobId(r.job_id);
      setResult(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLaunching(false);
    }
  }, [projectId, selectedPairs, Aa, Av, soilType, useGroup, T1, mceMultiplier, system]);

  // ── Plot envolvente de deriva por piso ──────────────────────────────────
  // Capas (de atrás a adelante): banda P16-P84 · líneas per-par (dispersión) ·
  // P50 bold · P84 punteada · × colapsos · límite NSR-10.
  useEffect(() => {
    if (!result || !plotlyReady || !driftRef.current) return;
    const verif = result.nsr10_verification;
    if (!verif || !verif.stories.length) return;

    const Plotly = (window as unknown as { Plotly: {
      newPlot: (el: HTMLElement, traces: unknown[], layout: unknown, config: unknown) => void;
    } }).Plotly;

    const stories = verif.stories;
    const z = stories.map((s) => s.story);
    const p50 = stories.map((s) => s.drift_p50_pct);
    const p84 = stories.map((s) => s.drift_p84_pct);

    // Perfil P16 (envolvente entre pares) viene del IDAResult subyacente.
    const profile = result.stats_per_level[0]?.drift_profile;
    const p16 = profile?.p16 ?? [];
    const hasP16 = p16.length === z.length;

    // Envolvente max(x, y) por piso para cada par + marker de colapso.
    type PairCurve = { pid: number; envelope: number[]; collapsed: boolean };
    const pairCurves: PairCurve[] = [];
    const collapseX: number[] = [];
    const collapseY: number[] = [];
    const collapsePids: number[] = [];
    for (const pid of Object.keys(result.curves)) {
      const pt = result.curves[pid][0];
      if (!pt) continue;
      const xs = pt.max_drift_by_story_x_pct ?? [];
      const ys = pt.max_drift_by_story_y_pct ?? [];
      const n  = Math.min(z.length, Math.max(xs.length, ys.length));
      if (n === 0) continue;
      const envelope: number[] = [];
      let worstVal = 0, worstStory = z[0];
      for (let i = 0; i < n; i++) {
        const v = Math.max(xs[i] ?? 0, ys[i] ?? 0);
        envelope.push(v);
        if (v > worstVal) { worstVal = v; worstStory = z[i]; }
      }
      const collapsed = pt.collapsed === true;
      pairCurves.push({ pid: Number(pid), envelope, collapsed });
      if (collapsed && worstVal > 0) {
        collapseX.push(worstVal);
        collapseY.push(worstStory);
        collapsePids.push(Number(pid));
      }
    }

    const traces: unknown[] = [];

    // Capa 1: banda P16-P84 (si P16 disponible).
    if (hasP16) {
      traces.push({
        type: "scatter", mode: "lines",
        x: p84, y: z,
        line: { color: "rgba(0,0,0,0)", width: 0 },
        showlegend: false, hoverinfo: "skip",
      });
      traces.push({
        type: "scatter", mode: "lines",
        x: p16, y: z,
        line: { color: "rgba(0,0,0,0)", width: 0 },
        fill: "tonextx", fillcolor: "rgba(99,102,241,0.14)",
        name: "banda P16-P84", showlegend: true, hoverinfo: "skip",
      });
    }

    // Capa 2: líneas delgadas por par (dispersión real).
    pairCurves.forEach((pc) => {
      traces.push({
        type: "scatter", mode: "lines",
        x: pc.envelope, y: z.slice(0, pc.envelope.length),
        line: {
          color: pc.collapsed ? "rgba(220,38,38,0.45)" : "rgba(100,116,139,0.35)",
          width: 1,
        },
        showlegend: false,
        hovertemplate: `par #${pc.pid}${pc.collapsed ? " · colapsó" : ""} · piso %{y} · Δ = %{x:.2f} %<extra></extra>`,
      });
    });

    // Capa 3: P50 bold.
    traces.push({
      type: "scatter", mode: "lines+markers",
      x: p50, y: z, name: "deriva P50 (promedio)",
      line: { color: "#4f46e5", width: 2.8 },
      marker: { size: 7, color: "#4f46e5" },
      hovertemplate: "<b>Piso %{y}</b><br>P50 = %{x:.2f} %<extra></extra>",
    });

    // Capa 4: P84 punteada.
    traces.push({
      type: "scatter", mode: "lines+markers",
      x: p84, y: z, name: "deriva P84 (envolvente)",
      line: { color: "#8b5cf6", width: 1.8, dash: "dot" },
      marker: { size: 6, color: "#8b5cf6" },
      hovertemplate: "<b>Piso %{y}</b><br>P84 = %{x:.2f} %<extra></extra>",
    });

    // Capa 5: × markers en pares colapsados (si hay).
    if (collapseX.length > 0) {
      traces.push({
        type: "scatter", mode: "markers",
        x: collapseX, y: collapseY,
        marker: { symbol: "x", size: 14, color: "#dc2626", line: { width: 2 } },
        name: `× colapso (${collapseX.length})`,
        customdata: collapsePids,
        hovertemplate: "× par #%{customdata} colapsado · piso %{y} · Δ = %{x:.2f} %<extra></extra>",
      });
    }

    // Capa 6: línea del límite NSR-10.
    traces.push({
      type: "scatter", mode: "lines",
      x: [verif.limit_mean_pct, verif.limit_mean_pct],
      y: [z[0] - 0.5, z[z.length - 1] + 0.5],
      name: `NSR-10 A.6.4.2 · Δ ≤ ${verif.limit_mean_pct} %`,
      line: { color: "#dc2626", width: 2, dash: "dash" },
      hoverinfo: "skip",
    });

    const xRange = Math.max(
      verif.limit_max_pct * 1.4,
      Math.max(...p84) * 1.15,
      ...collapseX.map((v) => v * 1.1),
    );

    Plotly.newPlot(driftRef.current, traces, {
      ...plotlyLayoutPremium({ showLegend: true, legendTop: false }),
      xaxis: plotlyAxisPremium({ title: "Deriva de entrepiso (%)", range: [0, xRange] }),
      yaxis: plotlyAxisPremium({ title: "Piso" }),
    }, plotlyConfigPremium);
  }, [result, plotlyReady]);

  // ── Verdict memo ────────────────────────────────────────────────────────
  const verdict = useMemo(() => {
    if (!result) return null;
    return result.nsr10_verification;
  }, [result]);

  // ── Pares colapsados con metadatos del catálogo + piso crítico + Δ máx ──
  const collapsedPairs = useMemo(() => {
    if (!result) return [];
    const rows: {
      pid: number; earthquake: string; year: number | string; station: string;
      worstStory: number | null; worstDrift: number;
    }[] = [];
    for (const pidStr of Object.keys(result.curves)) {
      const pt = result.curves[pidStr][0];
      if (!pt || pt.collapsed !== true) continue;
      const pid = Number(pidStr);
      const xs = pt.max_drift_by_story_x_pct ?? [];
      const ys = pt.max_drift_by_story_y_pct ?? [];
      let worstVal = 0;
      let worstStory: number | null = null;
      const n = Math.max(xs.length, ys.length);
      for (let i = 0; i < n; i++) {
        const v = Math.max(xs[i] ?? 0, ys[i] ?? 0);
        if (v > worstVal) { worstVal = v; worstStory = i + 1; }
      }
      const meta = catalog?.find((c) => c.pair === pid);
      rows.push({
        pid,
        earthquake: meta?.earthquake ?? "—",
        year:       meta?.year ?? "—",
        station:    meta?.station ?? "—",
        worstStory, worstDrift: worstVal,
      });
    }
    return rows.sort((a, b) => b.worstDrift - a.worstDrift);
  }, [result, catalog]);

  // ── Export CSV del reporte NSR-10 ────────────────────────────────────────
  const exportCsv = useCallback(() => {
    if (!result || !verdict) return;
    const m = result.nlrha_meta;
    const nowIso = new Date().toISOString();
    const lines: string[] = [];
    const push = (s: string) => lines.push(s);
    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    push("NLRHA — Verificación NSR-10 A.6.4.2");
    push(`Project ID,${esc(projectId)}`);
    push(`Generated,${nowIso}`);
    push("");
    push("Parámetros NSR-10");
    push(`Aa,${Aa}`);
    push(`Av,${Av}`);
    push(`Soil type,${soilType}`);
    push(`Use group,${useGroup}`);
    push(`Importance factor I,${USE_GROUP_I_FACTOR[useGroup]}`);
    push(`MCE multiplier,${mceMultiplier}`);
    push(`T1 (s),${T1}`);
    push(`System,${system}`);
    push("");
    push("Demanda sísmica");
    push(`Sa NSR-10 at T1 (g),${m?.sa_nsr10_T1_g ?? ""}`);
    push(`Sa objetivo escalado (g),${m?.sa_target_g ?? ""}`);
    if (m?.spectral_params) {
      push(`SDs (g),${m.spectral_params.SDs}`);
      push(`SD1 (g),${m.spectral_params.SD1}`);
      push(`T0 (s),${m.spectral_params.T0}`);
      push(`Ts (s),${m.spectral_params.Ts}`);
      push(`Fa,${m.spectral_params.Fa}`);
      push(`Fv,${m.spectral_params.Fv}`);
    }
    push("");
    push("Ejecución");
    push(`Pares ejecutados,${verdict.n_pairs ?? ""}`);
    push(`Pares colapsados,${verdict.n_collapsed ?? 0}`);
    push(`Límite P50 (%),${verdict.limit_mean_pct}`);
    push(`Límite P84 (%),${verdict.limit_max_pct}`);
    push(`Veredicto,${verdict.overall.toUpperCase()}`);
    push("");
    push("Verificación por piso");
    push("Piso,Deriva P50 (%),Deriva P84 (%),Ratio vs límite,Cumple");
    for (const s of verdict.stories) {
      push(`${s.story},${s.drift_p50_pct.toFixed(4)},${s.drift_p84_pct.toFixed(4)},${s.ratio_vs_limit.toFixed(3)},${s.ok ? "SI" : "NO"}`);
    }
    if (collapsedPairs.length > 0) {
      push("");
      push(`Pares colapsados (${collapsedPairs.length})`);
      push("Pair ID,Terremoto,Año,Estación,Piso crítico,Deriva máx (%)");
      for (const r of collapsedPairs) {
        push(`${r.pid},${esc(r.earthquake)},${esc(r.year)},${esc(r.station)},${r.worstStory ?? ""},${r.worstDrift.toFixed(3)}`);
      }
    }

    // UTF-8 con BOM para que Excel lea tildes correctamente.
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    const stamp = nowIso.replace(/[:.]/g, "-").slice(0, 19);
    a.href = url;
    a.download = `nlrha_nsr10_${projectId}_${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [result, verdict, collapsedPairs, projectId, Aa, Av, soilType, useGroup, mceMultiplier, T1, system]);

  const nTotal = selectedPairs.size;
  const insufficientPairs = selectedPairs.size < 3;

  return (
    <div className="space-y-5">
      {/* ── Header ────────────────────────────────────────────────────── */}
      <header className="space-y-1">
        <div className="inline-flex items-center gap-1.5 rounded-full bg-violet-500/15 border border-violet-500/30 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-violet-600 dark:text-violet-300 mb-1.5">
          <span className="h-1 w-1 rounded-full bg-violet-500" style={{ boxShadow: "0 0 5px #8b5cf6" }} />
          NLRHA · Verificación NSR-10
        </div>
        <h2 className="text-lg font-semibold text-[var(--text)]">
          NLRHA — Verificación NSR-10 / ASCE 7-22 Cap. 16
        </h2>
        <p className="text-sm text-[var(--text-muted)]">
          Análisis cronológico no lineal del edificio bajo N pares escalados al
          <b> Sa de código</b> (NSR-10 A.2.6). Verifica <b>Δ ≤ 1 %</b> promedio
          y Δ ≤ 1.5 % envolvente (A.6.4.2 / ASCE 7-22 §16.4).
        </p>
      </header>

      {/* ── Strip pre-análisis — checklist visual del estado del form ─────── */}
      {(() => {
        const nPairs = selectedPairs.size;
        let pairsTone: ChipTone;
        let pairsHint: string;
        if (nPairs < 3)        { pairsTone = "rose";    pairsHint = "NSR-10 pide ≥ 3"; }
        else if (nPairs < 7)   { pairsTone = "amber";   pairsHint = "mínimo NSR-10 A.5.4.6"; }
        else if (nPairs < 11)  { pairsTone = "emerald"; pairsHint = "NSR-10 ✓ · ASCE prefiere 11"; }
        else                   { pairsTone = "emerald"; pairsHint = "ASCE 7-22 §16 ✓"; }

        const t1Tone: ChipTone = T1 > 0 ? "indigo" : "rose";
        const t1Hint = T1 > 0 ? "cargado del análisis modal" : "requerido · correr modal primero";

        return (
          <div className="flex flex-wrap gap-2 rounded-lg border border-[var(--panel-muted)]/40 bg-[var(--panel-muted)]/25 p-2">
            <SummaryChip
              label="Pares seleccionados"
              value={`${nPairs}`}
              hint={pairsHint}
              tone={pairsTone}
            />
            <SummaryChip
              label="T₁ · período fundamental"
              value={T1 > 0 ? `${T1.toFixed(3)} s` : "—"}
              hint={t1Hint}
              tone={t1Tone}
            />
            <SummaryChip
              label="Nivel sísmico"
              value={mceMultiplier === 1.5 ? "MCE_R" : "SDE"}
              hint={`×${mceMultiplier.toFixed(1)} sobre Sa NSR-10`}
              tone="indigo"
            />
            <SummaryChip
              label="Grupo de uso"
              value={`${useGroup} · I = ${USE_GROUP_I_FACTOR[useGroup].toFixed(2)}`}
              hint={useGroup === "I" || useGroup === "II" ? "ocupación normal" : "edificación esencial"}
              tone={useGroup === "III" || useGroup === "IV" ? "amber" : "neutral"}
            />
            <SummaryChip
              label="Criterio de aceptación"
              value="Δ ≤ 1.0 %"
              hint="P50 · NSR-10 A.6.4.2"
              tone="neutral"
            />
          </div>
        );
      })()}

      {/* ── Configuración NSR-10 ──────────────────────────────────────── */}
      <section className="pl-glass-soft rounded-xl p-5 space-y-4">
        <h3 className="text-sm font-semibold text-[var(--text)]">Parámetros de código</h3>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <NumField label="Aa (A.2.3)"    value={Aa} onChange={setAa} min={0.05} max={0.5} step={0.01} />
          <NumField label="Av (A.2.3)"    value={Av} onChange={setAv} min={0.05} max={0.5} step={0.01} />
          <div>
            <label className="text-xs text-[var(--text-muted)] mb-1 block">Perfil de suelo</label>
            <select value={soilType} onChange={(e) => setSoilType(e.target.value as SoilType)}
              className="w-full rounded-md bg-[var(--panel-muted)] px-3 py-2 text-sm text-[var(--text)]">
              {(["A", "B", "C", "D", "E"] as const).map((s) => (
                <option key={s} value={s}>Tipo {s}</option>
              ))}
            </select>
          </div>
          <div className="md:col-span-2">
            <label className="text-xs text-[var(--text-muted)] mb-1 block">
              Grupo de uso (A.2.5.1) · I = {USE_GROUP_I_FACTOR[useGroup].toFixed(2)}
            </label>
            <select value={useGroup} onChange={(e) => setUseGroup(e.target.value as UseGroup)}
              className="w-full rounded-md bg-[var(--panel-muted)] px-3 py-2 text-sm text-[var(--text)]">
              {(["I","II","III","IV"] as UseGroup[]).map((u) => (
                <option key={u} value={u}>{USE_GROUP_LABEL[u]}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-2 border-t border-[var(--panel-muted)]/40">
          <NumField label="T₁ (s)" value={T1} onChange={setT1} min={0.05} max={10} step={0.01} />
          <div>
            <label className="text-xs text-[var(--text-muted)] mb-1 block">Nivel sísmico</label>
            <div className="flex gap-1">
              {[
                { v: 1.0, label: "SDE (1.0×)" },
                { v: 1.5, label: "MCE_R (1.5×)" },
              ].map((o) => (
                <button key={o.v}
                  onClick={() => setMceMultiplier(o.v)}
                  className={`flex-1 px-2 py-1.5 rounded text-xs font-medium ${
                    mceMultiplier === o.v ? "bg-indigo-600 text-white" : "bg-[var(--panel-muted)] text-[var(--text-muted)]"
                  }`}
                >{o.label}</button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-xs text-[var(--text-muted)] mb-1 block">Sistema</label>
            <div className="flex gap-1">
              {(["frames","walls"] as const).map((s) => (
                <button key={s}
                  onClick={() => setSystem(s)}
                  className={`flex-1 px-2 py-1.5 rounded text-xs font-medium ${
                    system === s ? "bg-indigo-600 text-white" : "bg-[var(--panel-muted)] text-[var(--text-muted)]"
                  }`}
                >{s === "frames" ? "Pórticos" : "Muros"}</button>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── Selección de catálogo ─────────────────────────────────────── */}
      <section className="pl-glass-soft rounded-xl p-5 space-y-3">
        <div className="flex items-baseline justify-between flex-wrap gap-2">
          <h3 className="text-sm font-semibold text-[var(--text)]">Catálogo de registros</h3>
          <div className="flex gap-1 flex-wrap">
            <button onClick={() => setCatalogSource("fema")}
              className={`px-3 py-1.5 text-xs rounded-md font-medium transition ${
                catalogSource === "fema"
                  ? "bg-indigo-600 text-white shadow"
                  : "bg-[var(--panel-muted)] text-[var(--text-muted)] hover:bg-[var(--surface-2)]"
              }`}>FEMA P-695 · 22 pares</button>
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

      {/* ── Selección de pares ────────────────────────────────────────── */}
      <section className="pl-glass-soft rounded-xl p-5 space-y-3">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-[var(--text)]">
            Pares {catalogSource === "fema" ? "FEMA P-695" : "catálogo local"} ({selectedPairs.size} seleccionados)
          </h3>
          <div className="flex gap-1 flex-wrap">
            {catalogSource === "fema" && (
              <>
                <button onClick={presetNSR}
                  className="px-2.5 py-1 text-xs rounded bg-[var(--panel-muted)] hover:bg-indigo-500/20 text-[var(--text)]"
                  title="Mínimo NSR-10 A.5.4.6">7 (NSR-10)</button>
                <button onClick={presetASCE}
                  className="px-2.5 py-1 text-xs rounded bg-[var(--panel-muted)] hover:bg-indigo-500/20 text-[var(--text)]"
                  title="Mínimo ASCE 7-22 §16.2.3.1">11 (ASCE 7-22)</button>
                <button onClick={presetAll}
                  className="px-2.5 py-1 text-xs rounded bg-[var(--panel-muted)] hover:bg-indigo-500/20 text-[var(--text)]">
                  Los 22
                </button>
              </>
            )}
            <button onClick={clearAll}
              className="px-2.5 py-1 text-xs rounded bg-[var(--panel-muted)] hover:bg-[var(--surface-2)] text-[var(--text-muted)]">
              Limpiar
            </button>
          </div>
        </div>

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
          <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5 max-h-80 overflow-y-auto pr-2">
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
                    }`}>
                    <input type="checkbox" checked={selectedPairs.has(pair.pair)}
                      onChange={() => togglePair(pair.pair)} className="h-3.5 w-3.5" />
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
                  </label>
                );
              })}
          </div>
        )}
      </section>

      {/* ── Lanzar ─────────────────────────────────────────────────────── */}
      <div className="flex items-baseline gap-4 flex-wrap">
        <button
          type="button"
          onClick={launch}
          disabled={launching || !!jobId || insufficientPairs || T1 <= 0 || !catalog}
          className="rounded-md bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-semibold px-5 py-2.5"
        >
          {launching ? "Lanzando…" : jobId ? "NLRHA en curso…" : `Lanzar verificación (${nTotal} pares)`}
        </button>
        {insufficientPairs && (
          <span className="text-xs text-amber-600 dark:text-amber-400">
            NSR-10 A.5.4.6: requiere ≥ 3 pares.
          </span>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/5 p-3 text-sm text-rose-700 dark:text-rose-300">
          {error}
        </div>
      )}

      {/* ── Progreso ───────────────────────────────────────────────────── */}
      {jobId && progress && (
        <section className="pl-glass rounded-xl p-5 space-y-3">
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-semibold text-[var(--text)]">Progreso</h3>
            <span className="text-xs font-mono text-[var(--text-muted)]">
              {progress.n_done} / {progress.n_total} ({progress.pct.toFixed(1)} %)
            </span>
          </div>
          <div className="h-2 rounded-full bg-[var(--panel-muted)] overflow-hidden">
            <div className="h-full rounded-full bg-indigo-500 transition-all duration-500"
                 style={{ width: `${Math.min(100, progress.pct)}%` }} />
          </div>
        </section>
      )}

      {/* ── Resultado ──────────────────────────────────────────────────── */}
      {result && verdict && (
        <>
          <VerdictCard result={result} verdict={verdict} />

          <section className="pl-glass rounded-xl p-5 space-y-3">
            <h3 className="text-sm font-semibold text-[var(--text)]">
              Envolvente de deriva de entrepiso vs límite NSR-10 A.6.4.2
            </h3>
            <div ref={driftRef} style={{ width: "100%", height: 420 }} />
            <p className="text-[11px] text-[var(--text-muted)]">
              Líneas grises finas: envolvente max(X,Y) de cada par individual (dispersión real).
              Banda sombreada: P16–P84 entre pares. P50 (índigo sólida): mediana comparada
              contra el límite. P84 (violeta punteada): envolvente alta. Línea roja: Δ ≤ {verdict.limit_mean_pct} % (NSR-10 A.6.4.2).
              {verdict.n_collapsed != null && verdict.n_collapsed > 0 && (
                <> <span className="text-rose-600 dark:text-rose-400 font-semibold">Marcadores × rojos:</span> pares colapsados en su piso más dañado.</>
              )}
            </p>
          </section>

          {collapsedPairs.length > 0 && (
            <CollapsedPairsPanel rows={collapsedPairs} />
          )}

          <StoryVerificationTable verdict={verdict} onExportCsv={exportCsv} />
        </>
      )}

      {/* ── Historial ──────────────────────────────────────────────────── */}
      {jobs.length > 0 && (
        <section className="pl-glass-soft rounded-xl p-4 space-y-2">
          <h4 className="text-xs uppercase tracking-wider font-semibold text-[var(--text-muted)]">
            Historial NLRHA ({jobs.length})
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
                  {j.params?.pair_ids?.length ?? "?"} pares
                </span>
                <span className="ml-auto text-[var(--text-muted)] uppercase">{j.status}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-componentes
// ─────────────────────────────────────────────────────────────────────────────

function NumField({
  label, value, onChange, min, max, step,
}: {
  label: string; value: number; onChange: (v: number) => void;
  min?: number; max?: number; step?: number;
}) {
  return (
    <div>
      <label className="text-xs text-[var(--text-muted)] mb-1 block">{label}</label>
      <input type="number" value={value}
        min={min} max={max} step={step}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        className="w-full rounded-md bg-[var(--panel-muted)] px-3 py-2 text-sm font-mono text-[var(--text)]"
      />
    </div>
  );
}

function VerdictCard({
  result, verdict,
}: {
  result: NLRHAResult;
  verdict: NLRHAResult["nsr10_verification"];
}) {
  const meta = result.nlrha_meta;
  const pass = verdict.overall === "pass";
  const bgClass = pass
    ? "from-emerald-500/20 via-emerald-500/5 to-transparent border-emerald-500/40"
    : "from-rose-500/20 via-rose-500/5 to-transparent border-rose-500/40";
  const nStoriesFail = verdict.stories.filter((s) => !s.ok).length;
  const worstStory = [...verdict.stories].sort((a, b) => b.drift_p50_pct - a.drift_p50_pct)[0];

  return (
    <div className={`pl-glass rounded-2xl p-6 bg-gradient-to-br ${bgClass} border`}>
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-semibold">
            Verificación NSR-10 A.6.4.2
          </div>
          <div className={`text-4xl font-bold mt-1 ${
            pass ? "text-emerald-500" : "text-rose-500"
          }`}>
            {pass ? "✓ CUMPLE" : "✗ NO CUMPLE"}
          </div>
          <div className="text-xs text-[var(--text-muted)] mt-2 max-w-xl">
            {pass
              ? `Las derivas promedio y envolvente de los ${verdict.n_pairs ?? "?"} pares están dentro del límite del código (Δ ≤ ${verdict.limit_mean_pct} %).`
              : `${nStoriesFail} de ${verdict.stories.length} entrepisos excede el límite NSR-10 — revisar refuerzo o redimensionar.`
            }
          </div>
        </div>
        {meta && (
          <div className="text-right text-xs space-y-0.5">
            <div className="text-[10px] uppercase text-[var(--text-muted)]">Sa objetivo (escalado)</div>
            <div className="text-2xl font-mono font-semibold text-indigo-500">
              {meta.sa_target_g?.toFixed(3) ?? "—"} g
            </div>
            <div className="text-[10px] text-[var(--text-muted)] font-mono">
              Sa<sub>NSR-10</sub>(T₁) = {meta.sa_nsr10_T1_g?.toFixed(3) ?? "—"} g ·
              I = {meta.importance_factor?.toFixed(2) ?? "—"} ·
              {meta.mce_multiplier === 1.5 ? " MCE_R" : " SDE"}
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-5 pt-4 border-t border-[var(--panel-muted)]/40">
        <Kpi label="Pares analizados" value={`${verdict.n_pairs ?? "—"}`}
             hint={`de ${result.n_pairs} ejecutados`} />
        <Kpi label="Pares colapsados"
             value={`${verdict.n_collapsed ?? 0}`}
             hint={verdict.n_collapsed && verdict.n_collapsed > 0
                   ? "¡Revisar modelo o diseño!"
                   : "sin colapsos detectados"}
             color={verdict.n_collapsed ? "text-rose-500" : "text-emerald-500"} />
        <Kpi label="Entrepisos fuera"
             value={`${nStoriesFail} / ${verdict.stories.length}`}
             color={nStoriesFail === 0 ? "text-emerald-500" : "text-rose-500"} />
        <Kpi label="Peor piso (P50)"
             value={worstStory ? `${worstStory.drift_p50_pct.toFixed(2)} %` : "—"}
             hint={worstStory ? `piso ${worstStory.story}` : ""}
             color={worstStory && worstStory.drift_p50_pct > verdict.limit_mean_pct
                    ? "text-rose-500" : "text-amber-500"} />
      </div>

      {meta?.spectral_params && (
        <div className="mt-4 pt-3 border-t border-[var(--panel-muted)]/40 text-[10px] text-[var(--text-muted)] font-mono grid grid-cols-2 md:grid-cols-4 gap-2">
          <span>SDs = {meta.spectral_params.SDs.toFixed(3)} g</span>
          <span>SD1 = {meta.spectral_params.SD1.toFixed(3)} g</span>
          <span>T0 = {meta.spectral_params.T0.toFixed(3)} s · Ts = {meta.spectral_params.Ts.toFixed(3)} s</span>
          <span>Fa = {meta.spectral_params.Fa.toFixed(2)} · Fv = {meta.spectral_params.Fv.toFixed(2)}</span>
        </div>
      )}
    </div>
  );
}

function Kpi({
  label, value, hint, color,
}: { label: string; value: string; hint?: string; color?: string }) {
  return (
    <div className="rounded-lg bg-[var(--panel-muted)]/40 p-3">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{label}</div>
      <div className={`text-xl font-mono font-semibold ${color ?? "text-[var(--text)]"} mt-0.5`}>{value}</div>
      {hint && <div className="text-[10px] text-[var(--text-muted)] mt-0.5">{hint}</div>}
    </div>
  );
}

function StoryVerificationTable({
  verdict, onExportCsv,
}: {
  verdict:     NLRHAResult["nsr10_verification"];
  onExportCsv?: () => void;
}) {
  const nFail = verdict.stories.filter((s) => !s.ok).length;
  return (
    <section className="pl-glass-soft rounded-xl p-4 space-y-2">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h4 className="text-xs uppercase tracking-wider font-semibold text-[var(--text-muted)]">
          Tabla de verificación por entrepiso
        </h4>
        <div className="flex items-center gap-3">
          <div className="text-[10px] text-[var(--text-muted)]">
            {nFail === 0 ? (
              <span className="text-emerald-600 dark:text-emerald-400 font-semibold">
                ✓ {verdict.stories.length} entrepisos cumplen
              </span>
            ) : (
              <span className="text-rose-600 dark:text-rose-400 font-semibold">
                ✗ {nFail} / {verdict.stories.length} entrepisos exceden el límite
              </span>
            )}
          </div>
          {onExportCsv && (
            <button
              onClick={onExportCsv}
              className="inline-flex items-center gap-1.5 rounded-md border border-indigo-500/40 bg-indigo-500/10 px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-300 hover:bg-indigo-500/20 transition"
              title="Descargar reporte NSR-10 completo como CSV"
            >
              <span className="text-xs leading-none">⬇</span>
              Exportar CSV
            </button>
          )}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-separate" style={{ borderSpacing: 0 }}>
          <thead>
            <tr className="bg-[var(--panel-muted)]/50 text-[var(--text-muted)] uppercase tracking-wider">
              <th className="px-3 py-2 text-left w-2"></th>
              <th className="px-3 py-2 text-right">Piso</th>
              <th className="px-3 py-2 text-right">Deriva P50 [%]</th>
              <th className="px-3 py-2 text-right">Deriva P84 [%]</th>
              <th className="px-3 py-2 text-right">Ratio vs 1 %</th>
              <th className="px-3 py-2 text-right">Cumple</th>
            </tr>
          </thead>
          <tbody>
            {verdict.stories.map((s: NLRHAStoryVerification) => (
              <tr key={s.story}
                className={`border-t border-[var(--panel-muted)]/30 ${
                  s.ok ? "" : "bg-rose-500/5"
                }`}>
                <td
                  className="px-0 py-1.5"
                  style={{
                    borderLeft: `4px solid ${s.ok ? "#10b981" : "#ef4444"}`,
                    boxShadow: s.ok ? "none" : "inset 0 0 0 999px rgba(239,68,68,0.04)",
                  }}
                />
                <td className="px-3 py-1.5 text-right font-mono">{s.story}</td>
                <td className={`px-3 py-1.5 text-right font-mono font-semibold ${
                  s.drift_p50_pct <= verdict.limit_mean_pct ? "text-emerald-600 dark:text-emerald-400"
                  : "text-rose-600 dark:text-rose-400"
                }`}>
                  {s.drift_p50_pct.toFixed(3)}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-[var(--text-muted)]">
                  {s.drift_p84_pct.toFixed(3)}
                </td>
                <td className={`px-3 py-1.5 text-right font-mono font-semibold ${
                  s.ratio_vs_limit <= 1.0 ? "text-emerald-600 dark:text-emerald-400"
                  : s.ratio_vs_limit <= 1.3 ? "text-amber-600 dark:text-amber-400"
                  : "text-rose-600 dark:text-rose-400"
                }`}>
                  {s.ratio_vs_limit.toFixed(2)}×
                </td>
                <td className="px-3 py-1.5 text-right">
                  {s.ok ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 border border-emerald-500/40 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-600 dark:text-emerald-300">
                      ✓ OK
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/15 border border-rose-500/40 px-2 py-0.5 text-[10px] font-bold uppercase text-rose-600 dark:text-rose-300">
                      ✗ FAIL
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Panel dedicado a listar pares colapsados ───────────────────────────────
function CollapsedPairsPanel({
  rows,
}: {
  rows: {
    pid: number; earthquake: string; year: number | string; station: string;
    worstStory: number | null; worstDrift: number;
  }[];
}) {
  return (
    <section className="pl-glass rounded-xl p-5 space-y-3 border border-rose-500/30 bg-gradient-to-br from-rose-500/8 via-transparent to-transparent">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-semibold text-rose-600 dark:text-rose-300">
          ⚠ Pares colapsados ({rows.length})
        </h3>
        <span className="text-[11px] text-[var(--text-muted)] italic">
          ordenados por deriva pico descendente
        </span>
      </div>
      <p className="text-[11px] text-[var(--text-muted)]">
        Estos registros llevaron al modelo a colapso durante la integración paso a paso.
        Revisa el diseño de refuerzo (vigas / columnas / muros) de los pisos críticos listados
        o la calibración del modelo (secciones fisuradas, amortiguamiento, masas).
      </p>
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))" }}
      >
        {rows.map((r) => (
          <div
            key={r.pid}
            className="rounded-md border border-rose-500/30 bg-rose-500/5 p-2.5 text-xs"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-mono font-bold text-rose-600 dark:text-rose-300">
                par #{r.pid}
              </span>
              <span className="font-mono text-[10px] text-[var(--text-muted)]">
                {r.earthquake} ({r.year})
              </span>
            </div>
            <div className="text-[10.5px] text-[var(--text-muted)] mt-0.5 truncate" title={r.station}>
              {r.station}
            </div>
            <div className="mt-1.5 pt-1.5 border-t border-rose-500/20 flex items-baseline justify-between gap-2">
              <span className="text-[10px] uppercase text-[var(--text-muted)] tracking-wider">
                piso crítico
              </span>
              <span className="font-mono font-semibold text-[var(--text)]">
                {r.worstStory ?? "—"}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[10px] uppercase text-[var(--text-muted)] tracking-wider">
                Δ máx
              </span>
              <span className="font-mono font-bold text-rose-600 dark:text-rose-300">
                {r.worstDrift.toFixed(2)} %
              </span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
