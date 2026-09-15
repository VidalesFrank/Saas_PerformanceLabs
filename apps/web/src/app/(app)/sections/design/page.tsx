"use client";

import { useState } from "react";
import Link from "next/link";
import { ApiError } from "@/lib/api";
import { sectionEditorApi } from "@/lib/editor-api";
import type { DesignRequest, DesignResult, DesignCandidate } from "@/lib/editor-api";
import { useRequireAuth } from "@/lib/use-require-auth";
import { Button } from "@/components/ui/button";

type Kind    = "column_rect" | "column_circ";
type Duct    = "DMI" | "DMO" | "DES";

interface DemandRow {
  Pu_kN: number;
  Mux_kNm: number;
  Muy_kNm: number;
}

const EMPTY_DEMAND: DemandRow = { Pu_kN: 1500, Mux_kNm: 200, Muy_kNm: 0 };

// ── Página ─────────────────────────────────────────────────────────────────

export default function DesignColumnPage() {
  useRequireAuth();

  const [kind, setKind]         = useState<Kind>("column_rect");
  const [h, setH]               = useState("500");
  const [w, setW]               = useState("500");
  const [d, setD]               = useState("500");
  const [cover, setCover]       = useState("40");
  const [fpc, setFpc]           = useState("28");
  const [fy, setFy]             = useState("420");
  const [ductility, setDuct]    = useState<Duct>("DMO");
  const [rhoMin, setRhoMin]     = useState("0.01");
  const [rhoMax, setRhoMax]     = useState("0.06");

  const [demands, setDemands]   = useState<DemandRow[]>([{ ...EMPTY_DEMAND }]);
  const [result, setResult]     = useState<DesignResult | null>(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);

  function updateDemand(i: number, key: keyof DemandRow, val: number) {
    setDemands((prev) => prev.map((r, j) => (j === i ? { ...r, [key]: val } : r)));
  }

  async function run() {
    setLoading(true); setError(null); setResult(null);
    try {
      const req: DesignRequest = {
        geometry: {
          kind,
          height_mm: kind === "column_rect" ? parseFloat(h) : undefined,
          width_mm:  kind === "column_rect" ? parseFloat(w) : undefined,
          diameter_mm: kind === "column_circ" ? parseFloat(d) : undefined,
          cover_mm: parseFloat(cover),
          fpc_MPa: parseFloat(fpc),
          fy_MPa: parseFloat(fy),
        },
        demands: demands.map((r) => ({
          Pu_kN: r.Pu_kN,
          Mux_kNm: r.Mux_kNm,
          Muy_kNm: r.Muy_kNm,
        })),
        ductility,
        rho_min: parseFloat(rhoMin) || 0.01,
        rho_max: parseFloat(rhoMax) || 0.06,
        top_k: 6,
      };
      const r = await sectionEditorApi.designColumn(req);
      setResult(r);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function importCsv(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = String(ev.target?.result ?? "");
      const rows = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
      const parsed: DemandRow[] = [];
      for (const line of rows) {
        const parts = line.split(/[,;\t]/).map((p) => parseFloat(p.trim()));
        if (parts.length >= 1 && !isNaN(parts[0])) {
          parsed.push({
            Pu_kN: parts[0],
            Mux_kNm: parts[1] || 0,
            Muy_kNm: parts[2] || 0,
          });
        }
      }
      if (parsed.length > 0) setDemands((prev) => [...prev, ...parsed]);
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  return (
    <div className="min-h-screen bg-bg">
      <header className="border-b border-border bg-surface px-6 py-3">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <div className="flex items-center gap-3 text-sm">
            <Link href="/sections" className="text-text-muted hover:text-text">← Secciones</Link>
            <span className="text-border">|</span>
            <span className="font-medium text-text">Diseño paramétrico</span>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-6 py-6">
        <div className="mb-4">
          <h1 className="text-xl font-bold text-text">Diseño paramétrico de columnas RC</h1>
          <p className="text-xs text-text-muted mt-1">
            Ingresa geometría + demandas → el motor enumera armados candidatos y devuelve los más
            eficientes (menor ρ) que cumplen DCR ≤ 1 para todas las demandas. NSR-10 / ACI 318-19.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* Columna izq: entrada */}
          <div className="lg:col-span-1 flex flex-col gap-4">
            <div className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
              <h3 className="mb-3 text-sm font-semibold">Tipo y geometría</h3>
              <div className="grid grid-cols-2 gap-2 mb-3">
                {([["column_rect", "Rectangular"], ["column_circ", "Circular"]] as const).map(
                  ([k, label]) => (
                    <button key={k} onClick={() => setKind(k)}
                      className={`rounded-lg border py-2 text-xs font-semibold transition-all
                        ${kind === k ? "border-accent bg-accent/10 text-accent" : "border-border text-text-muted hover:text-text"}`}>
                      {label}
                    </button>
                  ),
                )}
              </div>
              {kind === "column_rect" ? (
                <div className="grid grid-cols-2 gap-3">
                  <NumField label="h (mm)"  value={h} onChange={setH} />
                  <NumField label="b (mm)"  value={w} onChange={setW} />
                </div>
              ) : (
                <NumField label="D (mm)"  value={d} onChange={setD} />
              )}
              <div className="grid grid-cols-3 gap-3 mt-3">
                <NumField label="cover"    value={cover} onChange={setCover} />
                <NumField label="f'c (MPa)" value={fpc} onChange={setFpc} />
                <NumField label="fy (MPa)"  value={fy} onChange={setFy} />
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
              <h3 className="mb-3 text-sm font-semibold">Ductilidad y cuantías</h3>
              <div className="grid grid-cols-3 gap-2 mb-3">
                {(["DMI", "DMO", "DES"] as Duct[]).map((duct) => (
                  <button key={duct} onClick={() => setDuct(duct)}
                    className={`rounded-lg border py-2 text-xs font-semibold transition-all
                      ${ductility === duct ? "border-accent bg-accent/10 text-accent" : "border-border text-text-muted hover:text-text"}`}>
                    {duct}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <NumField label="ρ mín"  value={rhoMin} onChange={setRhoMin} step={0.005} />
                <NumField label="ρ máx"  value={rhoMax} onChange={setRhoMax} step={0.005} />
              </div>
            </div>

            <Button onClick={run} disabled={loading || demands.length === 0}>
              {loading ? "Explorando armados…" : `Diseñar (${demands.length} demanda${demands.length !== 1 ? "s" : ""})`}
            </Button>
            {error && <p className="text-danger text-xs">{error}</p>}
          </div>

          {/* Columna centro/der: demandas + resultados */}
          <div className="lg:col-span-2 flex flex-col gap-4">
            {/* Tabla de demandas */}
            <div className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold">Combinaciones de demanda</h3>
                <div className="flex gap-2">
                  <button
                    onClick={() => setDemands((d) => [...d, { ...EMPTY_DEMAND }])}
                    className="rounded-lg bg-accent/15 px-2.5 py-1 text-xs text-accent hover:bg-accent/25"
                  >
                    + Agregar
                  </button>
                  <label className="cursor-pointer rounded-lg border border-border bg-surface-2 px-2.5 py-1 text-xs text-text-muted hover:text-text">
                    ⬆ Import CSV
                    <input type="file" accept=".csv,.txt" className="hidden" onChange={importCsv} />
                  </label>
                </div>
              </div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-text-muted border-b border-border">
                    <th className="text-left py-1.5 pr-3">#</th>
                    <th className="text-right pr-3">Pu (kN)</th>
                    <th className="text-right pr-3">Mux (kN·m)</th>
                    <th className="text-right pr-3">Muy (kN·m)</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {demands.map((row, i) => (
                    <tr key={i} className="border-b border-border/40">
                      <td className="py-1 pr-3 text-text-muted">{i + 1}</td>
                      <td className="pr-3"><DemInput value={row.Pu_kN} onChange={(v) => updateDemand(i, "Pu_kN", v)} /></td>
                      <td className="pr-3"><DemInput value={row.Mux_kNm} onChange={(v) => updateDemand(i, "Mux_kNm", v)} /></td>
                      <td className="pr-3"><DemInput value={row.Muy_kNm} onChange={(v) => updateDemand(i, "Muy_kNm", v)} /></td>
                      <td>
                        <button onClick={() => setDemands((prev) => prev.filter((_, j) => j !== i))}
                          className="text-danger/60 hover:text-danger text-xs px-1">×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-[10px] text-text-muted italic">
                CSV: cada línea con <code>Pu, Mux, Muy</code> (kN, kN·m). Líneas con # se ignoran.
              </p>
            </div>

            {/* Resultados */}
            {loading && (
              <div className="rounded-2xl border border-border bg-surface p-8 text-center">
                <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-border border-t-accent" />
                <p className="mt-3 text-sm text-text-muted">Barriendo armados en OpenSees (10-90 s)…</p>
              </div>
            )}

            {result && !loading && (
              <>
                <div className="grid grid-cols-3 gap-3">
                  <Stat label="Candidatos evaluados" value={result.n_candidates_evaluated} />
                  <Stat label="Válidos" value={result.n_valid} />
                  <Stat label="Estado" value={result.all_infeasible ? "Ninguno cumple" : `Top ${result.candidates.length}`} />
                </div>

                {result.all_infeasible && (
                  <div className="rounded-2xl border border-danger/40 bg-danger/5 p-4">
                    <p className="text-sm font-semibold text-danger">No hay armado que cumpla</p>
                    {result.notes.map((n, i) => (
                      <p key={i} className="mt-1 text-xs text-text-muted">{n}</p>
                    ))}
                  </div>
                )}

                {result.candidates.length > 0 && (
                  <div className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
                    <h4 className="mb-3 text-sm font-semibold">Top armados (más eficientes primero)</h4>
                    <div className="flex flex-col gap-2">
                      {result.candidates.map((c, i) => (
                        <CandidateCard key={i} candidate={c} rank={i + 1} demands={demands} />
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Componentes locales ─────────────────────────────────────────────────────

function NumField({ label, value, onChange, step = 1 }: {
  label: string; value: string; onChange: (v: string) => void; step?: number;
}) {
  return (
    <label className="text-[11px] text-text-muted">{label}
      <input type="number" step={step} value={value} onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm font-mono
                   focus:border-accent focus:outline-none" />
    </label>
  );
}

function DemInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <input type="number" value={value} onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      className="w-24 rounded border border-border bg-surface-2 px-2 py-1 text-right text-xs font-mono
                 focus:border-accent focus:outline-none" />
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 px-3 py-2">
      <p className="text-[10px] text-text-muted">{label}</p>
      <p className="font-mono text-sm font-semibold text-text">{value}</p>
    </div>
  );
}

function CandidateCard({ candidate: c, rank, demands }: {
  candidate: DesignCandidate; rank: number; demands: DemandRow[];
}) {
  const rankStyles = rank === 1
    ? "border-emerald-500/60 bg-emerald-500/5"
    : "border-border bg-surface-2";
  const rankBadge = rank === 1
    ? "bg-emerald-500 text-white"
    : "bg-surface border border-border text-text-muted";

  return (
    <div className={`rounded-xl border ${rankStyles} p-3`}>
      <div className="flex items-center gap-3 mb-2">
        <span className={`rounded-full ${rankBadge} px-2.5 py-0.5 text-xs font-bold`}>
          #{rank}
        </span>
        <span className="text-sm font-semibold text-text">
          {c.n_bars} barras {c.bar_size} ({c.layout})
        </span>
        {rank === 1 && <span className="text-xs text-emerald-500 font-semibold">✓ Recomendado</span>}
      </div>
      <div className="grid grid-cols-4 gap-2 text-xs">
        <Kv label="As" value={`${c.As_cm2.toFixed(1)} cm²`} />
        <Kv label="ρg" value={`${c.rho_g_pct.toFixed(2)} %`} />
        <Kv label="P0" value={`${c.P0_kN.toFixed(0)} kN`} />
        <Kv label="DCR máx" value={c.max_DCR.toFixed(3)} highlight={c.max_DCR > 0.9 ? "warning" : "ok"} />
      </div>
      {c.demand_DCRs.length > 1 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] text-text-muted">
            DCR por demanda ({c.demand_DCRs.length})
          </summary>
          <div className="mt-1 grid grid-cols-4 gap-1 text-[10px] font-mono">
            {c.demand_DCRs.map((dcr, i) => (
              <span key={i} className={dcr > 1 ? "text-danger" : dcr > 0.9 ? "text-amber-500" : "text-emerald-500"}>
                #{i+1}: {dcr.toFixed(2)}
              </span>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function Kv({ label, value, highlight }: { label: string; value: string; highlight?: "ok" | "warning" }) {
  const cls = highlight === "warning" ? "text-amber-500" : highlight === "ok" ? "text-emerald-500" : "text-text";
  return (
    <div>
      <p className="text-[10px] text-text-muted">{label}</p>
      <p className={`font-mono font-semibold ${cls}`}>{value}</p>
    </div>
  );
}
