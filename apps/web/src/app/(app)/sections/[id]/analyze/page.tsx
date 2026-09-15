"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ApiError } from "@/lib/api";
import { sectionEditorApi } from "@/lib/editor-api";
import type {
  InteractionResult,
  MomentCurvatureResult,
  PMMSurfaceResult,
  PMMDemand,
  PMMDemandResult,
  NSR10Result,
  NSR10CheckItem,
} from "@/lib/editor-api";
import type { SectionRecord, SectionDocument } from "@/lib/section-document";
import { exportPMPDF, exportMCPDF, exportPMMPDF, exportNSR10PDF } from "@/lib/pdf-report";
import { sectionGrossArea, sectionSteelArea, sectionDepth, sectionWidth } from "@/lib/section-document";
import { useRequireAuth } from "@/lib/use-require-auth";
import { Button } from "@/components/ui/button";
import { InteractionChart } from "@/components/interaction-chart";
import { PMMSurface3D, PMMEnvelopeChart, MxMyPanel } from "@/components/pmm-chart";
import { MomentCurvatureChart } from "@/components/section-editor/MomentCurvatureChart";
import type { InteractionPoint, PMMArcOut, PMMDemandOut } from "@/lib/types";

type Tab = "props" | "pm" | "mc" | "pmm" | "shear" | "ductility" | "cyclic" | "service" | "nsr10" | "diagnostico";

// ── Conversión de unidades ──────────────────────────────────────────────────

function toPMPoints(pts: InteractionResult["points"]): InteractionPoint[] {
  return pts.map((p) => ({ P: p.p_kn * 1_000, M: p.m_knm * 1_000_000 }));
}

function toPMMArc(curves: PMMSurfaceResult["curves"]): PMMArcOut[] {
  return curves as unknown as PMMArcOut[];
}

function toPMMDemands(ds: PMMDemandResult[]): PMMDemandOut[] {
  return ds as unknown as PMMDemandOut[];
}

// ── Componentes auxiliares ──────────────────────────────────────────────────

function Stat({ label, value, unit }: { label: string; value: string | number; unit?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 px-3 py-2">
      <p className="text-[10px] text-text-muted">{label}</p>
      <p className="font-mono text-sm font-semibold text-text">
        {typeof value === "number"
          ? value.toLocaleString("es-CO", { maximumFractionDigits: 2 })
          : value}
        {unit && <span className="ml-1 text-[10px] font-normal text-text-muted">{unit}</span>}
      </p>
    </div>
  );
}

function Spinner() {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-text-muted">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-accent" />
      <p className="text-xs">Corriendo análisis en OpenSees…</p>
    </div>
  );
}

function downloadCsv(rows: string[], filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/csv" }));
  a.download = filename;
  a.click();
}

// ── Tab P-M ────────────────────────────────────────────────────────────────

interface PMDemand { puKn: number; muKnm: number; }

function PMTab({
  sectionId,
  sectionName,
  onResult,
}: {
  sectionId: string;
  sectionName: string;
  onResult?: (r: InteractionResult) => void;
}) {
  const [numPoints, setNumPoints] = useState(40);
  const [thetaDeg, setThetaDeg] = useState(0);
  const [result, setResult] = useState<InteractionResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [demands, setDemands] = useState<PMDemand[]>([]);

  async function run() {
    setLoading(true); setError(null);
    try {
      const r = await sectionEditorApi.interaction(sectionId, numPoints, thetaDeg);
      setResult(r);
      onResult?.(r);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Error en análisis");
    } finally {
      setLoading(false);
    }
  }

  function updateDemand(i: number, key: keyof PMDemand, value: number) {
    setDemands((prev) => prev.map((x, j) => (j === i ? { ...x, [key]: value } : x)));
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Parámetros de cálculo */}
      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-border bg-surface p-4">
        <div>
          <p className="mb-1 text-xs text-text-muted">Número de puntos</p>
          <input
            type="number" value={numPoints} min={5} max={80}
            onChange={(e) => setNumPoints(+e.target.value)}
            className="w-24 rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-text
              focus:border-accent focus:outline-none"
          />
        </div>
        <div>
          <p className="mb-1 text-xs text-text-muted">Ángulo θ (°)</p>
          <div className="flex items-center gap-2">
            <input
              type="number" value={thetaDeg} min={0} max={360} step={15}
              onChange={(e) => setThetaDeg(+e.target.value)}
              className="w-20 rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-text
                focus:border-accent focus:outline-none"
            />
            <div className="flex gap-1">
              {[0, 45, 90].map((a) => (
                <button
                  key={a} onClick={() => setThetaDeg(a)}
                  className={`rounded px-2 py-1 text-[10px] ${thetaDeg === a ? "bg-accent text-[#04141a]" : "bg-surface-2 text-text-muted hover:text-text"}`}
                >
                  {a}°
                </button>
              ))}
            </div>
          </div>
          <p className="mt-0.5 text-[10px] text-text-muted">0°=eje fuerte · 90°=eje débil</p>
        </div>
        <Button onClick={run} disabled={loading}>
          {loading ? "Calculando…" : "Calcular diagrama P-M"}
        </Button>
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>

      {/* Combinaciones de demanda Pu / Mu */}
      <div className="rounded-xl border border-border bg-surface overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <p className="text-xs font-semibold text-text">
            Combinaciones de diseño
            <span className="ml-2 font-normal text-text-muted">
              Pu / Mu — se grafican sobre el diagrama con verificación C/D
            </span>
          </p>
          <button
            onClick={() => setDemands((d) => [...d, { puKn: 0, muKnm: 0 }])}
            className="rounded-lg bg-accent/15 px-2.5 py-1 text-xs text-accent hover:bg-accent/25"
          >
            + Agregar
          </button>
        </div>
        {demands.length === 0 ? (
          <p className="px-4 py-3 text-xs text-text-muted">
            Sin demandas. Agrega combinaciones Pu/Mu para verificar la sección.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {demands.map((d, i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-2.5">
                <span className="w-5 text-xs font-medium text-text-muted">{i + 1}</span>
                <div>
                  <p className="mb-0.5 text-[10px] text-text-muted">Pu (kN)</p>
                  <input
                    type="number" value={d.puKn}
                    onChange={(e) => updateDemand(i, "puKn", parseFloat(e.target.value) || 0)}
                    className="w-28 rounded border border-border bg-surface-2 px-2 py-1 text-xs text-text
                      focus:border-accent focus:outline-none"
                  />
                </div>
                <div>
                  <p className="mb-0.5 text-[10px] text-text-muted">Mu (kN·m)</p>
                  <input
                    type="number" value={d.muKnm}
                    onChange={(e) => updateDemand(i, "muKnm", parseFloat(e.target.value) || 0)}
                    className="w-28 rounded border border-border bg-surface-2 px-2 py-1 text-xs text-text
                      focus:border-accent focus:outline-none"
                  />
                </div>
                <button
                  onClick={() => setDemands((prev) => prev.filter((_, j) => j !== i))}
                  className="mt-4 text-base leading-none text-danger/50 hover:text-danger"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {loading && <Spinner />}

      {result && !loading && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="P máx (compresión)" value={result.p_max_kn.toFixed(1)} unit="kN" />
            <Stat label="P mín (tensión)" value={result.p_min_kn.toFixed(1)} unit="kN" />
            <Stat label="M máx" value={result.m_max_knm.toFixed(1)} unit="kN·m" />
            <Stat label="Puntos calculados" value={result.points.length} />
          </div>

          {result.key_points?.balanced && (
            <div className="grid grid-cols-3 gap-3">
              <Stat
                label="Punto balanceado — P"
                value={result.key_points.balanced.p_kn.toFixed(1)}
                unit="kN"
              />
              <Stat
                label="Punto balanceado — M"
                value={result.key_points.balanced.m_knm.toFixed(1)}
                unit="kN·m"
              />
              <Stat
                label="Flexión pura — M₀"
                value={(result.key_points.pure_flexure?.m_knm ?? 0).toFixed(1)}
                unit="kN·m"
              />
            </div>
          )}

          <div className="rounded-xl border border-border bg-surface p-4">
            <InteractionChart
              points={toPMPoints(result.points)}
              loadCombinations={demands.map((d) => ({ puKn: d.puKn, muKnm: d.muKnm }))}
              keyPoints={result.key_points}
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button
              variant="secondary" disabled={exporting}
              onClick={async () => {
                setExporting(true);
                try { await exportPMPDF(sectionName, result, thetaDeg); }
                finally { setExporting(false); }
              }}
            >
              {exporting ? "Generando PDF…" : "Exportar PDF"}
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                downloadCsv(
                  ["p_kn,m_knm", ...result.points.map((p) => `${p.p_kn},${p.m_knm}`)],
                  `PM_${sectionName}.csv`
                )
              }
            >
              Exportar CSV
            </Button>
          </div>
        </>
      )}

      {!result && !loading && (
        <div className="rounded-xl border border-border bg-surface p-8 text-center text-text-muted">
          <p className="mb-3 text-4xl">⊘</p>
          <p className="text-sm">Presiona "Calcular" para generar el diagrama de interacción P-M.</p>
        </div>
      )}
    </div>
  );
}

// ── Tab M-φ ────────────────────────────────────────────────────────────────

interface MCRun {
  axialKn: number;
  result: MomentCurvatureResult;
  color: string;
}

const MC_COLORS = ["#2dd4e8", "#f59e0b", "#a78bfa", "#34d399", "#f87171"];

function MCTab({
  sectionId,
  sectionName,
  onResult,
}: {
  sectionId: string;
  sectionName: string;
  onResult?: (r: MomentCurvatureResult) => void;
}) {
  const [axialKn, setAxialKn] = useState(0);
  const [numIncr, setNumIncr] = useState(120);
  const [thetaDeg, setThetaDeg] = useState(0);
  const [runs, setRuns] = useState<MCRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  async function run() {
    setLoading(true); setError(null);
    try {
      const res = await sectionEditorApi.momentCurvature(sectionId, axialKn, numIncr, 8.0, thetaDeg);
      const color = MC_COLORS[runs.length % MC_COLORS.length];
      setRuns((prev) => [...prev, { axialKn, result: res, color }]);
      onResult?.(res);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Error en análisis");
    } finally {
      setLoading(false);
    }
  }

  const latest = runs[runs.length - 1]?.result ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-border bg-surface p-4">
        <div>
          <p className="mb-1 text-xs text-text-muted">Carga axial P (kN)</p>
          <input
            type="number" value={axialKn}
            onChange={(e) => setAxialKn(+e.target.value)}
            className="w-28 rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-text
              focus:border-accent focus:outline-none"
          />
        </div>
        <div>
          <p className="mb-1 text-xs text-text-muted">Incrementos</p>
          <input
            type="number" value={numIncr} min={20} max={500}
            onChange={(e) => setNumIncr(+e.target.value)}
            className="w-24 rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-text
              focus:border-accent focus:outline-none"
          />
        </div>
        <div>
          <p className="mb-1 text-xs text-text-muted">Ángulo θ (°)</p>
          <div className="flex items-center gap-2">
            <input
              type="number" value={thetaDeg} min={0} max={360} step={15}
              onChange={(e) => setThetaDeg(+e.target.value)}
              className="w-20 rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-text
                focus:border-accent focus:outline-none"
            />
            <div className="flex gap-1">
              {[0, 90].map((a) => (
                <button
                  key={a} onClick={() => setThetaDeg(a)}
                  className={`rounded px-2 py-1 text-[10px] ${thetaDeg === a ? "bg-accent text-[#04141a]" : "bg-surface-2 text-text-muted hover:text-text"}`}
                >
                  {a}°
                </button>
              ))}
            </div>
          </div>
          <p className="mt-0.5 text-[10px] text-text-muted">0°=eje fuerte · 90°=eje débil</p>
        </div>
        <Button onClick={run} disabled={loading}>
          {loading ? "Calculando…" : runs.length === 0 ? "Calcular M-φ" : "+ Agregar curva"}
        </Button>
        {runs.length > 0 && (
          <button onClick={() => setRuns([])} className="text-xs text-danger/70 hover:text-danger">
            Limpiar
          </button>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>

      {runs.length > 1 && (
        <div className="flex flex-wrap gap-3">
          {runs.map((r, i) => (
            <div key={i} className="flex items-center gap-1.5 text-xs">
              <span className="inline-block h-2 w-6 rounded-full" style={{ background: r.color }} />
              <span className="text-text-muted">P = {r.axialKn} kN</span>
            </div>
          ))}
        </div>
      )}

      {loading && <Spinner />}

      {latest && !loading && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Ductilidad μφ" value={latest.ductility.toFixed(2)} />
            <Stat label="Mmax" value={latest.moment_max.toFixed(1)} unit="kN·m" />
            <Stat label="φy" value={latest.phi_yield.toFixed(4)} unit="1/m" />
            <Stat label="φu" value={latest.phi_ultimate.toFixed(4)} unit="1/m" />
            <Stat label="EI secante" value={(latest.ei_secant_kNm2 / 1000).toFixed(0)} unit="MN·m²" />
            <Stat label="Falla alcanzada" value={latest.failure_reached ? "Sí" : "No"} />
            <Stat label="Carga axial" value={latest.axial_load_kn.toFixed(0)} unit="kN" />
            <Stat label="Mu" value={latest.moment_ultimate.toFixed(1)} unit="kN·m" />
          </div>
          <div className="rounded-xl border border-border bg-surface p-4">
            <MomentCurvatureChart result={latest} />
          </div>

          {runs.length > 1 && (
            <div className="rounded-xl border border-border bg-surface overflow-hidden">
              <table className="w-full text-xs">
                <thead className="border-b border-border bg-surface-2">
                  <tr>
                    {["P (kN)", "Mmax (kN·m)", "φy (1/m)", "φu (1/m)", "μφ", "EI (MN·m²)"].map((h) => (
                      <th key={h} className="px-3 py-2 text-left font-medium text-text-muted">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r, i) => (
                    <tr key={i} className="border-b border-border last:border-0">
                      <td className="px-3 py-2 font-medium" style={{ color: r.color }}>
                        {r.result.axial_load_kn.toFixed(0)}
                      </td>
                      <td className="px-3 py-2 text-text">{r.result.moment_max.toFixed(1)}</td>
                      <td className="px-3 py-2 text-text">{r.result.phi_yield.toFixed(4)}</td>
                      <td className="px-3 py-2 text-text">{r.result.phi_ultimate.toFixed(4)}</td>
                      <td className="px-3 py-2 font-semibold text-text">{r.result.ductility.toFixed(2)}</td>
                      <td className="px-3 py-2 text-text">{(r.result.ei_secant_kNm2 / 1000).toFixed(0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button
              variant="secondary" disabled={exporting}
              onClick={async () => {
                setExporting(true);
                try { await exportMCPDF(sectionName, runs.map((r) => ({ axialKn: r.axialKn, result: r.result }))); }
                finally { setExporting(false); }
              }}
            >
              {exporting ? "Generando PDF…" : "Exportar PDF"}
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                downloadCsv(
                  ["phi_1_m,moment_kNm", ...latest.curve.map((p) => `${p.phi},${p.moment}`)],
                  `MC_${sectionName}_P${latest.axial_load_kn.toFixed(0)}kN.csv`
                )
              }
            >
              Exportar CSV
            </Button>
          </div>
        </>
      )}

      {runs.length === 0 && !loading && (
        <div className="rounded-xl border border-border bg-surface p-8 text-center text-text-muted">
          <p className="mb-3 text-4xl">⊘</p>
          <p className="text-sm">Define la carga axial y presiona "Calcular" para generar la curva M-φ.</p>
          <p className="mt-1 text-xs">Puedes superponer varias curvas a distintas cargas axiales.</p>
        </div>
      )}
    </div>
  );
}

// ── Tab P-M-M ──────────────────────────────────────────────────────────────

const EMPTY_DEMAND: PMMDemand = { p_kn: 0, mx_knm: 0, my_knm: 0 };

function DemandRow({
  demand, result, index, onChange, onRemove,
}: {
  demand: PMMDemand;
  result?: PMMDemandResult;
  index: number;
  onChange: (d: PMMDemand) => void;
  onRemove: () => void;
}) {
  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-2 py-1.5 text-xs text-text-muted">{index + 1}</td>
      {(["p_kn", "mx_knm", "my_knm"] as const).map((k) => (
        <td key={k} className="px-1 py-1">
          <input
            type="number"
            value={demand[k]}
            onChange={(e) => onChange({ ...demand, [k]: parseFloat(e.target.value) || 0 })}
            className="w-24 rounded border border-border bg-surface-2 px-1.5 py-0.5 text-xs text-text
              focus:border-accent focus:outline-none"
          />
        </td>
      ))}
      {result ? (
        <>
          <td className="px-2 py-1.5 text-xs text-text">{result.m_demand_knm.toFixed(1)}</td>
          <td className="px-2 py-1.5 text-xs text-text">{result.m_capacity_knm.toFixed(1)}</td>
          <td className={`px-2 py-1.5 text-xs font-semibold ${result.dcr <= 1 ? "text-success" : "text-danger"}`}>
            {result.dcr === Infinity ? "∞" : result.dcr.toFixed(3)}
          </td>
          <td className="px-2 py-1.5">
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${result.inside ? "bg-success/15 text-success" : "bg-danger/15 text-danger"}`}>
              {result.inside ? "OK" : "Falla"}
            </span>
          </td>
        </>
      ) : (
        <td colSpan={4} className="px-2 py-1.5 text-[10px] text-text-muted">— sin calcular —</td>
      )}
      <td className="px-2 py-1.5">
        <button onClick={onRemove} className="text-xs text-danger/50 hover:text-danger">×</button>
      </td>
    </tr>
  );
}

function PMMTab({
  sectionId,
  sectionName,
  pMaxRef,
}: {
  sectionId: string;
  sectionName: string;
  pMaxRef: number;
}) {
  const [numAngles, setNumAngles] = useState(12);
  const [numPoints, setNumPoints] = useState(12);
  const [demands, setDemands] = useState<PMMDemand[]>([]);
  const [result, setResult] = useState<PMMSurfaceResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  async function run() {
    setLoading(true); setError(null);
    try { setResult(await sectionEditorApi.pmm(sectionId, numAngles, numPoints, demands)); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Error en análisis"); }
    finally { setLoading(false); }
  }

  function updateDemand(i: number, d: PMMDemand) {
    setDemands((prev) => prev.map((x, j) => (j === i ? d : x)));
  }

  const curves = result ? toPMMArc(result.curves) : [];
  const demandResults = result ? toPMMDemands(result.demands_out) : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-border bg-surface p-4">
        <div>
          <p className="mb-1 text-xs text-text-muted">Ángulos (meridianos)</p>
          <input
            type="number" value={numAngles} min={4} max={36}
            onChange={(e) => setNumAngles(+e.target.value)}
            className="w-24 rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-text
              focus:border-accent focus:outline-none"
          />
        </div>
        <div>
          <p className="mb-1 text-xs text-text-muted">Puntos por meridiano</p>
          <input
            type="number" value={numPoints} min={5} max={30}
            onChange={(e) => setNumPoints(+e.target.value)}
            className="w-24 rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-text
              focus:border-accent focus:outline-none"
          />
        </div>
        <div className="flex flex-col text-xs text-text-muted">
          <span>Puntos totales ≈ {numAngles * numPoints}</span>
          <span className="text-[10px]">Más puntos = más preciso pero más lento</span>
        </div>
        <Button onClick={run} disabled={loading}>
          {loading ? "Calculando superficie…" : "Calcular P-M-M"}
        </Button>
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>

      <div className="rounded-xl border border-border bg-surface overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
          <p className="text-xs font-semibold text-text">
            Verificación de demandas
            <span className="ml-2 font-normal text-text-muted">(se incluyen al calcular P-M-M)</span>
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setDemands((d) => [...d, { ...EMPTY_DEMAND }])}
              className="rounded-lg bg-accent/15 px-2.5 py-1 text-xs text-accent hover:bg-accent/25"
            >
              + Agregar
            </button>
            <label className="cursor-pointer rounded-lg bg-surface-2 border border-border px-2.5 py-1 text-xs text-text-muted hover:text-text">
              ⬆ Importar CSV
              <input
                type="file" accept=".csv,.txt" className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = (ev) => {
                    const text = String(ev.target?.result ?? "");
                    const rows = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
                    const parsed: PMMDemand[] = [];
                    for (const line of rows) {
                      const parts = line.split(/[,;\t]/).map((p) => parseFloat(p.trim()));
                      if (parts.length >= 3 && parts.every((v) => !isNaN(v))) {
                        parsed.push({ p_kn: parts[0], mx_knm: parts[1], my_knm: parts[2] });
                      }
                    }
                    if (parsed.length > 0) setDemands((d) => [...d, ...parsed]);
                  };
                  reader.readAsText(file);
                  e.target.value = "";  // reset para permitir reimportar
                }}
              />
            </label>
            {result && demands.length > 0 && (
              <button
                onClick={() => {
                  const header = "# P (kN), Mx (kN·m), My (kN·m), M_demanda (kN·m), M_capacidad (kN·m), DCR, Estado";
                  const lines = demands.map((d, i) => {
                    const r = demandResults[i];
                    const dcr = r ? r.dcr.toFixed(4) : "";
                    const est = r ? (r.inside ? "OK" : "FAIL") : "";
                    const mdem = r ? r.m_demand_knm.toFixed(3) : "";
                    const mcap = r ? r.m_capacity_knm.toFixed(3) : "";
                    return `${d.p_kn},${d.mx_knm},${d.my_knm},${mdem},${mcap},${dcr},${est}`;
                  });
                  downloadCsv([header, ...lines], `${sectionName || "pmm"}_demands.csv`);
                }}
                className="rounded-lg bg-surface-2 border border-border px-2.5 py-1 text-xs text-text-muted hover:text-text"
              >
                ⬇ Exportar CSV
              </button>
            )}
            {demands.length > 0 && (
              <button
                onClick={() => { if (confirm(`Eliminar ${demands.length} combinaciones?`)) setDemands([]); }}
                className="rounded-lg bg-danger/10 border border-danger/30 px-2.5 py-1 text-xs text-danger hover:bg-danger/20"
              >
                Limpiar
              </button>
            )}
          </div>
        </div>
        {demands.length === 0 ? (
          <p className="px-4 py-3 text-xs text-text-muted">
            Sin demandas. Agrega combinaciones P, Mx, My para verificar DCR.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-surface-2">
                <tr>
                  {["#", "P (kN)", "Mx (kN·m)", "My (kN·m)", "M demanda", "M capacidad", "DCR", "Estado", ""].map((h) => (
                    <th key={h} className="whitespace-nowrap px-2 py-2 text-left font-medium text-text-muted">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {demands.map((d, i) => (
                  <DemandRow
                    key={i}
                    demand={d}
                    result={demandResults[i]}
                    index={i}
                    onChange={(nd) => updateDemand(i, nd)}
                    onRemove={() => setDemands((prev) => prev.filter((_, j) => j !== i))}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {loading && <Spinner />}

      {result && !loading && (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="P máx (compresión)" value={result.p_max_kn.toFixed(1)} unit="kN" />
            <Stat label="P mín (tensión)" value={result.p_min_kn.toFixed(1)} unit="kN" />
            <Stat label="M máx" value={result.m_max_knm.toFixed(1)} unit="kN·m" />
          </div>
          <div className="rounded-xl border border-border bg-surface p-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
              Superficie P-M-M (arrastrar para rotar)
            </p>
            <PMMSurface3D
              curves={curves}
              demands={demandResults as unknown as PMMDemandOut[]}
              pMaxKn={result.p_max_kn}
              pMinKn={result.p_min_kn}
              mMaxKnm={result.m_max_knm}
            />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-border bg-surface p-4">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Envolvente P-M</p>
              <PMMEnvelopeChart curves={curves} demands={demandResults as unknown as PMMDemandOut[]} />
            </div>
            <div className="rounded-xl border border-border bg-surface p-4">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
                Sección Mx-My a nivel P
              </p>
              <MxMyPanel
                curves={curves}
                demands={demandResults as unknown as PMMDemandOut[]}
                defaultP={result.p_max_kn * 0.4}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary" disabled={exporting}
              onClick={async () => {
                setExporting(true);
                try { await exportPMMPDF(sectionName, result); }
                finally { setExporting(false); }
              }}
            >
              {exporting ? "Generando PDF…" : "Exportar PDF"}
            </Button>
            {demands.length > 0 && result.demands_out.length > 0 && (
              <Button
                variant="secondary"
                onClick={() =>
                  downloadCsv(
                    [
                      "p_kn,mx_knm,my_knm,m_demand_knm,m_capacity_knm,dcr,inside",
                      ...result.demands_out.map(
                        (d) => `${d.p_kn},${d.mx_knm},${d.my_knm},${d.m_demand_knm},${d.m_capacity_knm},${d.dcr},${d.inside}`
                      ),
                    ],
                    `PMM_demandas_${sectionName}.csv`
                  )
                }
              >
                Exportar demandas CSV
              </Button>
            )}
          </div>
        </>
      )}

      {!result && !loading && (
        <div className="rounded-xl border border-border bg-surface p-8 text-center text-text-muted">
          <p className="mb-3 text-4xl">⊘</p>
          <p className="text-sm">Define los parámetros y presiona "Calcular" para generar la superficie P-M-M biaxial.</p>
          <p className="mt-1 text-xs">Advertencia: análisis intensivo, puede tomar 1-3 minutos.</p>
        </div>
      )}
    </div>
  );
}

// ── Tab NSR-10 ─────────────────────────────────────────────────────────────

const ELEMENT_TYPES = [
  { value: "columna", label: "Columna" },
  { value: "viga",    label: "Viga" },
  { value: "muro",    label: "Muro / Placa" },
] as const;

const DUCTILITY_OPTIONS = [
  { value: "DMI", label: "DMI — Ductilidad Mínima" },
  { value: "DMO", label: "DMO — Ductilidad Moderada" },
  { value: "DES", label: "DES — Ductilidad Especial" },
] as const;

const NSR_STATUS_CONFIG = {
  ok:      { label: "OK",        bg: "bg-success/10",  border: "border-success/30",  text: "text-success",    icon: "✓" },
  fail:    { label: "NO CUMPLE", bg: "bg-danger/10",   border: "border-danger/30",   text: "text-danger",     icon: "✗" },
  warning: { label: "REVISAR",   bg: "bg-warning/10",  border: "border-warning/30",  text: "text-warning",    icon: "!" },
  info:    { label: "INFO",      bg: "bg-surface-2",   border: "border-border",      text: "text-text-muted", icon: "i" },
} as const;

function NSR10Tab({
  sectionId,
  sectionName,
  onResult,
}: {
  sectionId: string;
  sectionName: string;
  onResult?: (r: NSR10Result) => void;
}) {
  const [elementType, setElementType] = useState<string>("columna");
  const [ductility, setDuctility]     = useState<string>("DMO");
  const [result, setResult]           = useState<NSR10Result | null>(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [exporting, setExporting]     = useState(false);

  async function run() {
    setLoading(true); setError(null);
    try {
      const r = await sectionEditorApi.nsr10(sectionId, elementType, ductility);
      setResult(r);
      onResult?.(r);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Error en verificación");
    } finally {
      setLoading(false);
    }
  }

  const summary = result?.summary;
  const allOk = summary && summary.fail === 0 && summary.warning === 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-border bg-surface p-4">
        <div>
          <p className="mb-1 text-xs text-text-muted">Tipo de elemento</p>
          <div className="flex gap-1">
            {ELEMENT_TYPES.map((et) => (
              <button
                key={et.value} onClick={() => setElementType(et.value)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors
                  ${elementType === et.value
                    ? "bg-accent text-[#04141a]"
                    : "border border-border bg-surface-2 text-text-muted hover:text-text"}`}
              >
                {et.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-1 text-xs text-text-muted">Categoría de ductilidad</p>
          <div className="flex gap-1">
            {DUCTILITY_OPTIONS.map((d) => (
              <button
                key={d.value} onClick={() => setDuctility(d.value)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors
                  ${ductility === d.value
                    ? "bg-accent text-[#04141a]"
                    : "border border-border bg-surface-2 text-text-muted hover:text-text"}`}
              >
                {d.value}
              </button>
            ))}
          </div>
          <p className="mt-0.5 text-[10px] text-text-muted">
            {ductility === "DMI" && "NSR-10 Cap. C — Sin requisitos sísmicos especiales"}
            {ductility === "DMO" && "NSR-10 C.21.3 — Pórticos / muros de ductilidad moderada"}
            {ductility === "DES" && "NSR-10 C.21.5/21.6/21.9 — Máxima ductilidad, zona de amenaza alta"}
          </p>
        </div>
        <Button onClick={run} disabled={loading}>
          {loading ? "Verificando…" : "Verificar NSR-10"}
        </Button>
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>

      {loading && <Spinner />}

      {result && !loading && (
        <>
          <div className={`flex items-center gap-4 rounded-xl border px-5 py-4
            ${allOk
              ? "border-success/30 bg-success/8"
              : summary && summary.fail > 0
                ? "border-danger/30 bg-danger/8"
                : "border-warning/30 bg-warning/8"}`}>
            <span className={`text-3xl font-bold ${allOk ? "text-success" : summary && summary.fail > 0 ? "text-danger" : "text-warning"}`}>
              {allOk ? "✓" : summary && summary.fail > 0 ? "✗" : "!"}
            </span>
            <div className="flex-1">
              <p className={`font-semibold ${allOk ? "text-success" : summary && summary.fail > 0 ? "text-danger" : "text-warning"}`}>
                {allOk
                  ? "Cumple todos los criterios NSR-10"
                  : summary && summary.fail > 0
                    ? `No cumple ${summary.fail} criterio(s)`
                    : `${summary?.warning ?? 0} criterio(s) a revisar`}
              </p>
              <p className="text-xs text-text-muted">
                {result.element_type.charAt(0).toUpperCase() + result.element_type.slice(1)} · {result.ductility}
                {" · "}{summary?.ok} de {summary?.total} verificaciones OK
              </p>
            </div>
            <div className="flex gap-3 text-center text-xs">
              <div>
                <p className="font-mono text-lg font-bold text-success">{summary?.ok}</p>
                <p className="text-text-muted">OK</p>
              </div>
              <div>
                <p className="font-mono text-lg font-bold text-danger">{summary?.fail}</p>
                <p className="text-text-muted">Falla</p>
              </div>
              <div>
                <p className="font-mono text-lg font-bold text-warning">{summary?.warning}</p>
                <p className="text-text-muted">Revisar</p>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-surface overflow-hidden">
            <div className="border-b border-border px-4 py-2.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                Verificaciones NSR-10 — {result.element_type} · {result.ductility}
              </p>
            </div>
            <div className="divide-y divide-border">
              {result.checks.map((c: NSR10CheckItem, i: number) => {
                const cfg = NSR_STATUS_CONFIG[c.status];
                const showValues = c.status !== "info" && c.unit !== "—";
                return (
                  <div key={i} className={`flex items-start gap-3 px-4 py-3 ${cfg.bg}`}>
                    <div className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full
                      border text-[10px] font-bold ${cfg.border} ${cfg.text}`}>
                      {cfg.icon}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="font-mono text-[10px] text-text-muted">{c.article}</span>
                        <span className="text-sm text-text">{c.description}</span>
                      </div>
                      {showValues && (
                        <div className="mt-1 flex flex-wrap gap-3 text-xs">
                          <span className="text-text-muted">
                            Calculado:{" "}
                            <span className={`font-mono font-semibold ${cfg.text}`}>
                              {c.demand.toFixed(c.unit === "%" ? 3 : c.unit === "mm" ? 1 : 0)} {c.unit}
                            </span>
                          </span>
                          {c.limit > 0 && (
                            <span className="text-text-muted">
                              Límite:{" "}
                              <span className="font-mono">
                                {c.limit.toFixed(c.unit === "%" ? 3 : c.unit === "mm" ? 1 : 0)} {c.unit}
                              </span>
                            </span>
                          )}
                        </div>
                      )}
                      {c.note && (
                        <p className="mt-0.5 text-[11px] italic text-text-muted">{c.note}</p>
                      )}
                    </div>
                    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold ${cfg.border} ${cfg.text}`}>
                      {cfg.label}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex justify-end">
            <Button
              variant="secondary" disabled={exporting}
              onClick={async () => {
                setExporting(true);
                try { await exportNSR10PDF(sectionName, result); }
                finally { setExporting(false); }
              }}
            >
              {exporting ? "Generando PDF…" : "Exportar PDF"}
            </Button>
          </div>
        </>
      )}

      {!result && !loading && (
        <div className="rounded-xl border border-border bg-surface p-10 text-center text-text-muted">
          <p className="mb-3 text-4xl">⊘</p>
          <p className="text-sm">Selecciona el tipo de elemento y categoría de ductilidad, luego presiona "Verificar NSR-10".</p>
          <p className="mt-1 text-xs">Los criterios aplicables cambiarán según tu selección.</p>
        </div>
      )}
    </div>
  );
}

// ── Tab Diagnóstico ────────────────────────────────────────────────────────

type IndicatorStatus = "ok" | "warn" | "fail" | "pending";

const INDICATOR_STYLE: Record<IndicatorStatus, { border: string; bg: string; icon: string; iconColor: string }> = {
  ok:      { border: "border-success/30", bg: "bg-success/8",  icon: "✓", iconColor: "text-success"    },
  warn:    { border: "border-warning/30", bg: "bg-warning/8",  icon: "!",  iconColor: "text-warning"   },
  fail:    { border: "border-danger/30",  bg: "bg-danger/8",   icon: "✗", iconColor: "text-danger"     },
  pending: { border: "border-border",     bg: "bg-surface-2",  icon: "—", iconColor: "text-text-muted" },
};

function IndicatorCard({
  title,
  status,
  mainValue,
  detail,
}: {
  title: string;
  status: IndicatorStatus;
  mainValue: string;
  detail: string;
}) {
  const s = INDICATOR_STYLE[status];
  return (
    <div className={`rounded-xl border p-4 ${s.border} ${s.bg}`}>
      <p className="mb-3 text-[10px] font-bold uppercase tracking-widest text-text-muted">{title}</p>
      <div className="mb-2 flex items-center gap-2">
        <span className={`text-2xl font-bold ${s.iconColor}`}>{s.icon}</span>
        <span className={`font-mono text-sm font-semibold ${s.iconColor}`}>{mainValue}</span>
      </div>
      <p className="text-[11px] leading-relaxed text-text-muted">{detail}</p>
    </div>
  );
}

function DiagnosticoTab({
  doc,
  ag,
  rho,
  pmResult,
  mcLastResult,
  nsr10Result,
}: {
  doc: SectionDocument | null;
  ag: number;
  rho: number;
  pmResult: InteractionResult | null;
  mcLastResult: MomentCurvatureResult | null;
  nsr10Result: NSR10Result | null;
}) {
  const fpc  = doc?.concrete_defs[0]?.fpc ?? null;
  const fy   = doc?.steel_defs[0]?.fy ?? null;
  const h    = doc ? sectionDepth(doc) : 0;
  const b    = doc ? sectionWidth(doc) : 0;
  const nBars = doc?.bars.length ?? 0;

  // ── Indicadores ────────────────────────────────────────────────────────

  // CUANTÍA
  const rhoStatus: IndicatorStatus =
    rho >= 1 && rho <= 8 ? "ok" : rho >= 0.5 && rho < 1 ? "warn" : !doc ? "pending" : "fail";
  const rhoValue  = doc ? `ρ = ${rho.toFixed(2)} %` : "—";
  const rhoDetail = doc
    ? rho < 0.5 ? "Cuantía muy baja — riesgo de falla frágil. Aumentar refuerzo."
    : rho < 1   ? "Cuantía inferior al mínimo (ρ_min = 1%, NSR-10 C.10.9.1)."
    : rho > 8   ? "Cuantía excede el máximo (ρ_max = 8%). Reducir As o ampliar sección."
    : rho > 6   ? "Cuantía alta. Verificar constructibilidad y compactación del concreto."
    :             `Cuantía dentro de rango normal [1% – 8%] — NSR-10 C.10.9.1`
    : "Sin sección definida.";

  // RESISTENCIA
  const resistenciaStatus: IndicatorStatus = pmResult ? "ok" : "pending";
  const resistenciaValue  = pmResult ? `Pn = ${pmResult.p_max_kn.toFixed(0)} kN` : "—";
  const resistenciaDetail = pmResult
    ? `Mn,max = ${pmResult.m_max_knm.toFixed(0)} kN·m` +
      (pmResult.key_points?.balanced
        ? ` · Punto bal: (${pmResult.key_points.balanced.m_knm.toFixed(0)} kN·m, ${pmResult.key_points.balanced.p_kn.toFixed(0)} kN)`
        : "")
    : "Calcular Diagrama P-M para obtener la capacidad nominal de la sección.";

  // DUCTILIDAD
  const mu = mcLastResult?.ductility ?? null;
  const ductilStatus: IndicatorStatus =
    mu === null ? "pending" : mu >= 4 ? "ok" : mu >= 2 ? "warn" : "fail";
  const ductilValue = mu !== null ? `μφ = ${mu.toFixed(2)}` : "—";
  const ductilDetail =
    mu === null ? "Calcular Curva M-φ para evaluar la ductilidad en curvatura."
    : mu >= 6   ? "Ductilidad muy alta — apto DES zona de amenaza alta."
    : mu >= 4   ? "Ductilidad alta — cumple DMO/DES."
    : mu >= 2   ? "Ductilidad moderada — revisar requisitos de categoría (DMO/DES)."
    :             "Ductilidad baja — revisar espaciamiento y tipo de estribos.";

  // NSR-10
  const nsr10Status: IndicatorStatus =
    nsr10Result === null ? "pending"
    : nsr10Result.summary.fail > 0  ? "fail"
    : nsr10Result.summary.warning > 0 ? "warn"
    : "ok";
  const nsr10Value = nsr10Result
    ? `${nsr10Result.summary.ok}/${nsr10Result.summary.total} OK`
    : "—";
  const nsr10Detail = nsr10Result
    ? `${nsr10Result.element_type} · ${nsr10Result.ductility} — ` +
      (nsr10Result.summary.fail > 0
        ? `${nsr10Result.summary.fail} falla(s) — ver pestaña NSR-10`
        : nsr10Result.summary.warning > 0
          ? `${nsr10Result.summary.warning} advertencia(s)`
          : "Todos los criterios cumplen")
    : "Ejecutar verificación NSR-10 para revisar cumplimiento normativo.";

  // ── Recomendaciones automáticas ────────────────────────────────────────

  const recs: { level: "ok" | "warn" | "fail" | "info"; text: string }[] = [];

  if (!doc) {
    recs.push({ level: "info", text: "Agrega geometría y barras de refuerzo en el editor para comenzar el análisis." });
  } else {
    if (rho < 0.5)
      recs.push({ level: "fail", text: `Cuantía muy baja (ρ = ${rho.toFixed(2)}%) — riesgo de falla frágil. Agregar barras de refuerzo.` });
    else if (rho < 1)
      recs.push({ level: "warn", text: `Cuantía inferior al mínimo NSR-10 (ρ = ${rho.toFixed(2)}% < 1%). Aumentar área de acero.` });
    if (rho > 8)
      recs.push({ level: "fail", text: `Cuantía excesiva (ρ = ${rho.toFixed(2)}% > 8%). Reducir As o aumentar la sección transversal.` });
    else if (rho > 6)
      recs.push({ level: "warn", text: `Cuantía alta (ρ = ${rho.toFixed(2)}%). Verificar constructibilidad y espacio libre entre barras.` });

    if (mu !== null && mu < 2)
      recs.push({ level: "fail", text: `Ductilidad muy baja (μφ = ${mu.toFixed(2)}). Revisar confinamiento: disminuir espaciamiento de estribos y/o agregar ganchos suplementarios.` });
    else if (mu !== null && mu < 3)
      recs.push({ level: "warn", text: `Ductilidad moderada (μφ = ${mu.toFixed(2)}). Verificar que cumple los requisitos de la categoría de ductilidad seleccionada.` });

    if (nsr10Result && nsr10Result.summary.fail > 0)
      recs.push({ level: "fail", text: `${nsr10Result.summary.fail} verificación(es) NSR-10 no cumplen. Revisar tabla en la pestaña NSR-10.` });
    else if (nsr10Result && nsr10Result.summary.warning > 0)
      recs.push({ level: "warn", text: `${nsr10Result.summary.warning} criterio(s) NSR-10 requieren revisión adicional.` });

    if (recs.length === 0) {
      if (pmResult || mcLastResult || nsr10Result) {
        recs.push({ level: "ok", text: "Todos los análisis disponibles sin observaciones. Sección conforme con los criterios evaluados." });
      } else {
        recs.push({ level: "info", text: "Ejecuta los análisis P-M, M-φ y NSR-10 para obtener un diagnóstico completo de la sección." });
      }
    }
  }

  const REC_STYLE = {
    ok:   { border: "border-success/25", bg: "bg-success/6",  icon: "✓", text: "text-success"    },
    warn: { border: "border-warning/25", bg: "bg-warning/6",  icon: "!",  text: "text-warning"   },
    fail: { border: "border-danger/25",  bg: "bg-danger/6",   icon: "✗", text: "text-danger"     },
    info: { border: "border-border",     bg: "bg-surface-2",  icon: "→", text: "text-text-muted" },
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Propiedades geométricas */}
      {doc && (
        <div className="rounded-xl border border-border bg-surface p-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
            Propiedades geométricas y materiales
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {h > 0 && <Stat label="Altura h" value={(h).toFixed(0)} unit="mm" />}
            {b > 0 && <Stat label="Ancho b" value={(b).toFixed(0)} unit="mm" />}
            <Stat label="Ag" value={(ag / 1e6).toFixed(4)} unit="m²" />
            <Stat label="ρ (cuantía)" value={rho.toFixed(2)} unit="%" />
            <Stat label="Barras" value={nBars} />
            {fpc && <Stat label="f'c" value={fpc} unit="MPa" />}
            {fy  && <Stat label="fy"  value={fy}  unit="MPa" />}
          </div>
        </div>
      )}

      {/* Indicadores de calidad */}
      <div>
        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
          Indicadores de calidad
        </p>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <IndicatorCard title="Cuantía" status={rhoStatus} mainValue={rhoValue} detail={rhoDetail} />
          <IndicatorCard title="Resistencia" status={resistenciaStatus} mainValue={resistenciaValue} detail={resistenciaDetail} />
          <IndicatorCard title="Ductilidad" status={ductilStatus} mainValue={ductilValue} detail={ductilDetail} />
          <IndicatorCard title="NSR-10" status={nsr10Status} mainValue={nsr10Value} detail={nsr10Detail} />
        </div>
      </div>

      {/* Recomendaciones */}
      <div>
        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
          Diagnóstico e recomendaciones
        </p>
        <div className="flex flex-col gap-2">
          {recs.map((r, i) => {
            const s = REC_STYLE[r.level];
            return (
              <div key={i} className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${s.border} ${s.bg}`}>
                <span className={`mt-0.5 shrink-0 text-sm font-bold ${s.text}`}>{s.icon}</span>
                <p className={`text-sm ${s.text}`}>{r.text}</p>
              </div>
            );
          })}
        </div>
      </div>

      {(!pmResult || !mcLastResult || !nsr10Result) && doc && (
        <p className="text-center text-xs text-text-muted">
          Diagnóstico parcial — faltan análisis:{" "}
          {[!pmResult && "P-M", !mcLastResult && "M-φ", !nsr10Result && "NSR-10"]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
    </div>
  );
}

// ── Tab Propiedades geométricas ─────────────────────────────────────────────

function PropRow({ label, value, unit, mono = true, hint }: {
  label: string; value: string | number; unit?: string; mono?: boolean; hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between border-b border-border/60 py-1.5">
      <span className="text-[11px] text-text-muted flex items-center gap-1.5">
        {label}
        {hint && <span title={hint} className="opacity-60 cursor-help">ⓘ</span>}
      </span>
      <span className={`${mono ? "font-mono" : ""} text-xs font-semibold text-text tabular-nums`}>
        {typeof value === "number"
          ? value.toLocaleString("es-CO", { maximumFractionDigits: 3 })
          : value}
        {unit && <span className="ml-1 text-[10px] font-normal text-text-muted">{unit}</span>}
      </span>
    </div>
  );
}

function PropSection({ title, accent, children }: { title: string; accent: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-surface overflow-hidden shadow-sm">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
        <span className="w-1.5 h-4 rounded-sm" style={{ background: accent }} />
        <h3 className="text-sm font-semibold text-text">{title}</h3>
      </div>
      <div className="px-4 py-2">{children}</div>
    </section>
  );
}

function PropsTab({ sectionId }: { sectionId: string }) {
  const [data, setData]         = useState<import("@/lib/editor-api").GeometricPropertiesResult | null>(null);
  const [error, setError]       = useState<string | null>(null);
  const [loading, setLoading]   = useState(true);

  useEffect(() => {
    setLoading(true);
    sectionEditorApi
      .geometricProperties(sectionId)
      .then((r) => { setData(r); setError(null); })
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [sectionId]);

  if (loading) return <Spinner />;
  if (error)   return <p className="text-danger text-sm">{error}</p>;
  if (!data)   return null;
  const p = data.engineering;

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      <PropSection title="Áreas y refuerzo" accent="#0891b2">
        <PropRow label="Ag — área bruta"    value={p.gross_area_cm2}  unit="cm²" />
        <PropRow label="An — área neta"     value={p.net_area_cm2}    unit="cm²" hint="An = Ag − As" />
        <PropRow label="As — total barras"  value={p.steel_area_cm2}  unit="cm²" />
        <PropRow label="ρg — cuantía"       value={p.rho_g_pct}       unit="%" hint="ρg = As / Ag" />
      </PropSection>

      <PropSection title="Centroide y envolvente" accent="#8b5cf6">
        <PropRow label="yc"       value={p.centroid_y_cm} unit="cm" hint="Centroide en dirección de flexión y" />
        <PropRow label="zc"       value={p.centroid_z_cm} unit="cm" />
        <PropRow label="h — altura"  value={p.depth_cm}   unit="cm" hint="Dimensión total en y" />
        <PropRow label="b — ancho"   value={p.width_cm}   unit="cm" hint="Dimensión total en z" />
      </PropSection>

      <PropSection title="Momentos de inercia" accent="#10b981">
        <PropRow label="Iy" value={p.Iy_cm4}  unit="cm⁴" hint="Momento respecto al eje y (flexión sobre z)" />
        <PropRow label="Iz" value={p.Iz_cm4}  unit="cm⁴" hint="Momento respecto al eje z (flexión sobre y)" />
        <PropRow label="Iyz" value={p.Iyz_cm4} unit="cm⁴" hint="Producto de inercia (0 si simétrica)" />
      </PropSection>

      <PropSection title="Módulos elásticos" accent="#f59e0b">
        <PropRow label="Sz⁺ (fibra y_max)" value={p.Sz_pos_cm3} unit="cm³" />
        <PropRow label="Sz⁻ (fibra y_min)" value={p.Sz_neg_cm3} unit="cm³" />
        <PropRow label="Sy⁺ (fibra z_max)" value={p.Sy_pos_cm3} unit="cm³" />
        <PropRow label="Sy⁻ (fibra z_min)" value={p.Sy_neg_cm3} unit="cm³" />
      </PropSection>

      <PropSection title="Módulos plásticos" accent="#ec4899">
        <PropRow label="Zpz (flex. sobre y)" value={p.Zpz_cm3} unit="cm³" hint="Fully-yielded, partición A/2" />
        <PropRow label="Zpy (flex. sobre z)" value={p.Zpy_cm3} unit="cm³" />
        <PropRow label="fsz — factor forma z" value={p.fs_z}   unit=""    hint="Zpz / Sz_promedio · rect=1.5 · circ≈1.7" />
        <PropRow label="fsy — factor forma y" value={p.fs_y}   unit="" />
      </PropSection>

      <PropSection title="Radios de giro" accent="#0369a1">
        <PropRow label="ry" value={p.ry_cm} unit="cm" hint="ry = √(Iy/Ag)" />
        <PropRow label="rz" value={p.rz_cm} unit="cm" hint="rz = √(Iz/Ag)" />
      </PropSection>

      <PropSection title="Ejes principales" accent="#dc2626">
        <PropRow label="I₁ (máximo)" value={p.I1_cm4} unit="cm⁴" hint="Autovalor mayor del tensor de inercia" />
        <PropRow label="I₂ (mínimo)" value={p.I2_cm4} unit="cm⁴" />
        <PropRow label="θp (rotación)" value={p.theta_p_deg} unit="°" hint="Ángulo del eje principal 1 respecto a y" />
      </PropSection>

      <PropSection title="Método" accent="#6b7280">
        <p className="py-2 text-[11px] text-text-muted leading-relaxed">
          Integrales cerradas sobre polígonos (Green/Bird 2005) para rectángulos y polígonos.
          Círculos con hueco: fórmulas exactas + Steiner. Barras contribuyen como áreas
          concentradas (As · d²) al centroide. Módulo plástico Zp por bisección del PNA en
          la sección homogénea. Validado con 27 tests contra fórmulas cerradas conocidas.
        </p>
      </PropSection>
    </div>
  );
}

// ── Tab Cortante ────────────────────────────────────────────────────────────

function ShearTab({ sectionId }: { sectionId: string }) {
  type Code    = "NSR-10" | "ACI 318-19";
  type Elem    = "beam" | "column" | "wall";
  type Duct    = "DMI" | "DMO" | "DES";

  const [code, setCode]           = useState<Code>("NSR-10");
  const [element, setElement]     = useState<Elem>("beam");
  const [ductility, setDuctility] = useState<Duct>("DMI");
  const [vu, setVu]               = useState("150");
  const [nu, setNu]               = useState("0");
  const [av, setAv]               = useState("142");    // 2 ramas #3 = 2·71 = 142 mm²
  const [s, setS]                 = useState("150");
  const [fyt, setFyt]             = useState("420");
  const [rhoW, setRhoW]           = useState("0.010");
  const [dbLong, setDbLong]       = useState("25.4");
  const [d, setD]                 = useState("");
  const [bw, setBw]               = useState("");
  const [result, setResult]       = useState<import("@/lib/editor-api").ShearCheckResult | null>(null);
  const [error, setError]         = useState<string | null>(null);
  const [loading, setLoading]     = useState(false);

  const run = async () => {
    setLoading(true); setError(null);
    try {
      const r = await sectionEditorApi.shearCheck(sectionId, {
        code, element, ductility,
        Vu_kN: parseFloat(vu) || 0,
        Nu_kN: parseFloat(nu) || 0,
        Av_mm2: av.trim() ? parseFloat(av) : null,
        s_mm: parseFloat(s) || 150,
        fyt_MPa: parseFloat(fyt) || 420,
        rho_w: parseFloat(rhoW) || 0.01,
        db_long_mm: parseFloat(dbLong) || 25.4,
        d_mm: d.trim() ? parseFloat(d) : null,
        bw_mm: bw.trim() ? parseFloat(bw) : null,
      });
      setResult(r);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const badgeCls = (st: string) => (
    st === "ok"     ? "bg-emerald-500/15 text-emerald-500 border-emerald-500/30" :
    st === "warning"? "bg-amber-500/15 text-amber-500 border-amber-500/30" :
                      "bg-danger/15 text-danger border-danger/30"
  );

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      {/* Panel de configuración */}
      <div className="lg:col-span-1 flex flex-col gap-4">
        <div className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold">Código y ductilidad</h3>
          <div className="grid grid-cols-2 gap-2">
            {(["NSR-10", "ACI 318-19"] as Code[]).map((c) => (
              <button key={c} onClick={() => setCode(c)}
                className={`rounded-lg border py-2 text-xs font-semibold transition-all
                  ${code === c ? "border-accent bg-accent/10 text-accent" : "border-border text-text-muted hover:text-text"}`}>
                {c}
              </button>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {(["beam", "column", "wall"] as Elem[]).map((el) => (
              <button key={el} onClick={() => setElement(el)}
                className={`rounded-lg border py-2 text-xs font-semibold transition-all
                  ${element === el ? "border-accent bg-accent/10 text-accent" : "border-border text-text-muted hover:text-text"}`}>
                {el === "beam" ? "Viga" : el === "column" ? "Columna" : "Muro"}
              </button>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {(["DMI", "DMO", "DES"] as Duct[]).map((d) => (
              <button key={d} onClick={() => setDuctility(d)}
                className={`rounded-lg border py-2 text-xs font-semibold transition-all
                  ${ductility === d ? "border-accent bg-accent/10 text-accent" : "border-border text-text-muted hover:text-text"}`}>
                {d}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold">Demanda</h3>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-[11px] text-text-muted">Vu (kN)
              <input value={vu} onChange={(e) => setVu(e.target.value)} type="number"
                className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm font-mono" />
            </label>
            <label className="text-[11px] text-text-muted">Nu (kN, + comp.)
              <input value={nu} onChange={(e) => setNu(e.target.value)} type="number"
                className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm font-mono" />
            </label>
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold">Refuerzo transversal</h3>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-[11px] text-text-muted">Av total (mm²)
              <input value={av} onChange={(e) => setAv(e.target.value)} type="number"
                placeholder="vacío = sin"
                className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm font-mono" />
            </label>
            <label className="text-[11px] text-text-muted">s (mm)
              <input value={s} onChange={(e) => setS(e.target.value)} type="number"
                className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm font-mono" />
            </label>
            <label className="text-[11px] text-text-muted">fyt (MPa)
              <input value={fyt} onChange={(e) => setFyt(e.target.value)} type="number"
                className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm font-mono" />
            </label>
            <label className="text-[11px] text-text-muted">db_long (mm)
              <input value={dbLong} onChange={(e) => setDbLong(e.target.value)} type="number"
                className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm font-mono" />
            </label>
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold">Avanzado (opcional)</h3>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-[11px] text-text-muted">d (mm)
              <input value={d} onChange={(e) => setD(e.target.value)} type="number"
                placeholder="auto"
                className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm font-mono" />
            </label>
            <label className="text-[11px] text-text-muted">bw (mm)
              <input value={bw} onChange={(e) => setBw(e.target.value)} type="number"
                placeholder="auto"
                className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm font-mono" />
            </label>
            {code === "ACI 318-19" && (
              <label className="text-[11px] text-text-muted col-span-2">ρw = As/(bw·d) (ACI 22.5.5)
                <input value={rhoW} onChange={(e) => setRhoW(e.target.value)} type="number" step="0.001"
                  className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm font-mono" />
              </label>
            )}
          </div>
        </div>

        <Button onClick={run} disabled={loading}>
          {loading ? "Calculando…" : "Verificar cortante"}
        </Button>
        {error && <p className="text-danger text-xs">{error}</p>}
      </div>

      {/* Panel de resultados */}
      <div className="lg:col-span-2 flex flex-col gap-4">
        {!result && (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-surface-2 py-16">
            <p className="text-sm text-text-muted">Configura la demanda y refuerzo, luego pulsa <strong>Verificar cortante</strong>.</p>
            <p className="mt-1 text-xs text-text-muted">Motor validado contra fórmulas exactas de NSR-10 C.11 y ACI 318-19 §22.5.</p>
          </div>
        )}

        {result && (
          <>
            <div className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
              <div className="flex items-baseline justify-between">
                <h3 className="text-lg font-bold">Resultado — {result.code}</h3>
                <span className={`rounded-full border px-3 py-1 text-xs font-bold uppercase ${badgeCls(result.status)}`}>
                  {result.status === "ok" ? "Cumple" :
                   result.status === "warning" ? "Advertencia" :
                   result.status === "no-transverse" ? "Sin refuerzo" : "No cumple"}
                </span>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3">
                <Stat label="Vc"     value={result.components.Vc_kN.toFixed(1)}     unit="kN" />
                <Stat label="Vs"     value={result.components.Vs_kN.toFixed(1)}     unit="kN" />
                <Stat label="Vn"     value={result.components.Vn_kN.toFixed(1)}     unit="kN" />
                <Stat label="φVn"    value={result.components.phi_Vn_kN.toFixed(1)} unit="kN" />
                <Stat label="Vu"     value={result.components.Vu_kN.toFixed(1)}     unit="kN" />
                <Stat label="DCR"    value={result.components.DCR.toFixed(3)} />
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
              <h4 className="mb-3 text-sm font-semibold">Detallado</h4>
              <div className="grid grid-cols-2 gap-3">
                <Stat label="s máx admisible" value={result.detailing.s_max_mm.toFixed(0)} unit="mm" />
                <Stat label="Av,mín requerido" value={result.detailing.Av_min_mm2.toFixed(0)} unit="mm²" />
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
              <h4 className="mb-3 text-sm font-semibold">Referencias del código</h4>
              <div className="grid grid-cols-2 gap-1.5 text-xs md:grid-cols-3">
                {Object.entries(result.articles).map(([k, v]) => (
                  <div key={k} className="flex items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-2 py-1">
                    <span className="text-text-muted">{k}:</span>
                    <span className="font-mono font-semibold text-text">{v}</span>
                  </div>
                ))}
              </div>
            </div>

            {result.notes.length > 0 && (
              <div className="rounded-2xl border border-amber-500/40 bg-amber-500/5 p-4">
                <h4 className="mb-2 text-sm font-semibold text-amber-500">Notas del diseño</h4>
                <ul className="list-disc pl-5 text-xs text-text-muted space-y-1">
                  {result.notes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Tab Ductilidad ──────────────────────────────────────────────────────────

function DuctilityTab({ sectionId }: { sectionId: string }) {
  const [pKn, setPKn]         = useState("0");
  const [L, setL]             = useState("3000");
  const [db, setDb]           = useState("25.4");
  const [fuFy, setFuFy]       = useState("1.35");
  const [method, setMethod]   = useState<"priestley_2007" | "paulay_priestley" | "baker" | "atc_32">("priestley_2007");
  const [result, setResult]   = useState<import("@/lib/editor-api").DuctilityResult | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true); setError(null);
    try {
      const r = await sectionEditorApi.ductility(sectionId, {
        axial_load_kn: parseFloat(pKn) || 0,
        member_length_mm: parseFloat(L) || 3000,
        db_long_mm: parseFloat(db) || 25.4,
        Lp_method: method,
        fu_over_fy: parseFloat(fuFy) || 1.35,
      });
      setResult(r);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      {/* Panel de entrada */}
      <div className="lg:col-span-1 flex flex-col gap-4">
        <div className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold">Parámetros del análisis</h3>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-[11px] text-text-muted">P axial (kN, + comp.)
              <input value={pKn} onChange={(e) => setPKn(e.target.value)} type="number"
                className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm font-mono" />
            </label>
            <label className="text-[11px] text-text-muted">L miembro (mm)
              <input value={L} onChange={(e) => setL(e.target.value)} type="number"
                className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm font-mono" />
            </label>
            <label className="text-[11px] text-text-muted">db longitudinal (mm)
              <input value={db} onChange={(e) => setDb(e.target.value)} type="number"
                className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm font-mono" />
            </label>
            <label className="text-[11px] text-text-muted">fu/fy
              <input value={fuFy} onChange={(e) => setFuFy(e.target.value)} type="number" step="0.05"
                className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm font-mono" />
            </label>
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold">Método para Lp</h3>
          <div className="flex flex-col gap-1.5 text-xs">
            {([
              ["priestley_2007", "Priestley 2007 (recomendado)"],
              ["paulay_priestley", "Paulay & Priestley 1992"],
              ["baker", "Baker 1956 (0.5·d)"],
              ["atc_32", "ATC-32 / Caltrans"],
            ] as const).map(([v, label]) => (
              <button key={v} onClick={() => setMethod(v)}
                className={`rounded-lg border py-2 text-left px-3 transition-all
                  ${method === v ? "border-accent bg-accent/10 text-accent font-semibold" : "border-border text-text-muted hover:text-text"}`}>
                {label}
              </button>
            ))}
          </div>
        </div>

        <Button onClick={run} disabled={loading}>
          {loading ? "Analizando…" : "Calcular ductilidad"}
        </Button>
        {error && <p className="text-danger text-xs">{error}</p>}
      </div>

      {/* Resultados */}
      <div className="lg:col-span-2 flex flex-col gap-4">
        {!result && (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-surface-2 py-16">
            <p className="text-sm text-text-muted">
              Configura carga axial y longitud del miembro y pulsa <strong>Calcular ductilidad</strong>.
            </p>
            <p className="mt-1 text-xs text-text-muted">
              Motor implementa idealización bilineal Priestley + Lp por 4 métodos + μΔ + energía.
            </p>
          </div>
        )}

        {result && (
          <>
            {/* KPI cards */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="μφ (curvatura)"   value={result.ductility.mu_phi.toFixed(2)} />
              <Stat label="μΔ (desplaz.)"     value={result.ductility.mu_delta.toFixed(2)} />
              <Stat label="Lp"                value={result.plastic_hinge.Lp_mm.toFixed(0)} unit="mm" />
              <Stat label="Lp/L"              value={(result.plastic_hinge.Lp_over_L * 100).toFixed(1)} unit="%" />
              <Stat label="φy idealizado"     value={result.bilinear.phi_yield_ideal_1_per_m.toFixed(4)} unit="1/m" />
              <Stat label="φu"                value={result.bilinear.phi_ultimate_1_per_m.toFixed(4)} unit="1/m" />
              <Stat label="My idealizado"     value={result.bilinear.moment_yield_ideal_kNm.toFixed(1)} unit="kN·m" />
              <Stat label="Energía disipada" value={result.energy.capacity_kNm_per_m.toFixed(1)} unit="kN" />
            </div>

            {/* Referencia del método */}
            <div className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
              <p className="text-[11px] text-text-muted uppercase tracking-wider font-bold">Método Lp usado</p>
              <p className="mt-1 text-sm font-mono text-text">{result.plastic_hinge.method}</p>
            </div>

            {/* Curva M-φ con bilineal superpuesta */}
            <MPhiWithBilinear result={result} />

            {result.notes.length > 0 && (
              <div className="rounded-2xl border border-amber-500/40 bg-amber-500/5 p-4">
                <h4 className="mb-2 text-sm font-semibold text-amber-500">Notas del análisis</h4>
                <ul className="list-disc pl-5 text-xs text-text-muted space-y-1">
                  {result.notes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// SVG minimalista para la curva M-φ con la aproximación bilineal superpuesta
function MPhiWithBilinear({ result }: { result: import("@/lib/editor-api").DuctilityResult }) {
  if (!result.curve.length) return null;

  const W = 640, H = 320, pad = { l: 60, r: 20, t: 20, b: 44 };
  const phi_max = Math.max(...result.curve.map((p) => p.phi_1_per_m));
  const m_max = Math.max(...result.curve.map((p) => p.moment_kNm));
  const sx = (v: number) => pad.l + (v / phi_max) * (W - pad.l - pad.r);
  const sy = (v: number) => H - pad.b - (v / m_max) * (H - pad.t - pad.b);

  const curvePath = result.curve
    .map((p, i) => `${i === 0 ? "M" : "L"} ${sx(p.phi_1_per_m).toFixed(1)} ${sy(p.moment_kNm).toFixed(1)}`)
    .join(" ");

  const phi_y = result.bilinear.phi_yield_ideal_1_per_m;
  const my = result.bilinear.moment_yield_ideal_kNm;
  const phi_u = result.bilinear.phi_ultimate_1_per_m;

  return (
    <div className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
      <h4 className="mb-2 text-sm font-semibold">Curva M-φ con idealización bilineal Priestley</h4>
      <svg width={W} height={H} className="max-w-full">
        {/* ejes */}
        <line x1={pad.l} y1={H - pad.b} x2={W - pad.r} y2={H - pad.b} stroke="var(--color-border)" />
        <line x1={pad.l} y1={pad.t} x2={pad.l} y2={H - pad.b} stroke="var(--color-border)" />
        {/* grid */}
        {[0.25, 0.5, 0.75, 1.0].map((f) => (
          <g key={f}>
            <line x1={pad.l} y1={sy(f * m_max)} x2={W - pad.r} y2={sy(f * m_max)}
              stroke="var(--color-border)" strokeOpacity="0.3" strokeDasharray="3 4" />
            <text x={pad.l - 6} y={sy(f * m_max) + 3} fontSize="10" fill="var(--color-text-muted)" textAnchor="end">
              {(f * m_max).toFixed(0)}
            </text>
          </g>
        ))}
        {/* curva real */}
        <path d={curvePath} fill="none" stroke="var(--color-accent)" strokeWidth="1.8" />
        {/* bilineal: origen → (φy, My) → (φu, My) */}
        <polyline
          points={`${sx(0)},${sy(0)} ${sx(phi_y)},${sy(my)} ${sx(phi_u)},${sy(my)}`}
          fill="none" stroke="#ef4444" strokeWidth="1.5" strokeDasharray="6 4"
        />
        {/* marcadores */}
        <circle cx={sx(phi_y)} cy={sy(my)} r="4" fill="#ef4444" />
        <circle cx={sx(phi_u)} cy={sy(my)} r="4" fill="#ef4444" />
        <text x={sx(phi_y) + 8} y={sy(my) - 8} fontSize="11" fill="#ef4444" fontWeight="600">
          (φy, My) ideal
        </text>
        <text x={sx(phi_u) - 8} y={sy(my) - 8} fontSize="11" fill="#ef4444" fontWeight="600" textAnchor="end">
          φu
        </text>
        {/* labels */}
        <text x={(pad.l + W - pad.r) / 2} y={H - 8} fontSize="11" fill="var(--color-text-muted)" textAnchor="middle">
          Curvatura φ (1/m)
        </text>
        <text x={16} y={(pad.t + H - pad.b) / 2} fontSize="11" fill="var(--color-text-muted)"
          transform={`rotate(-90 16 ${(pad.t + H - pad.b) / 2})`} textAnchor="middle">
          Momento M (kN·m)
        </text>
      </svg>
      <div className="mt-2 flex gap-4 text-[11px]">
        <span className="text-accent">━ Curva real M-φ</span>
        <span className="text-danger">╌╌ Idealización bilineal Priestley 2007</span>
      </div>
    </div>
  );
}

// ── Tab Cíclico (histéresis M-φ) ───────────────────────────────────────────

function CyclicTab({ sectionId }: { sectionId: string }) {
  type Proto = "atc_24" | "sinusoidal";
  const [proto, setProto]       = useState<Proto>("atc_24");
  const [pKn, setPKn]           = useState("0");
  const [phiY, setPhiY]         = useState("0.05");
  const [phiMax, setPhiMax]     = useState("0.10");
  const [cps, setCps]           = useState("2");
  const [nc, setNc]             = useState("5");
  const [decay, setDecay]       = useState("0");
  const [duct, setDuct]         = useState("0.5, 1, 2, 3, 4");
  const [result, setResult]     = useState<import("@/lib/editor-api").CyclicResult | null>(null);
  const [error, setError]       = useState<string | null>(null);
  const [loading, setLoading]   = useState(false);

  const run = async () => {
    setLoading(true); setError(null);
    try {
      const req: import("@/lib/editor-api").CyclicRequest = {
        axial_load_kn: parseFloat(pKn) || 0,
        protocol: proto,
        steps_per_cycle: 20,
      };
      if (proto === "atc_24") {
        req.phi_yield_1_per_m = parseFloat(phiY) || 0.05;
        req.cycles_per_step = parseInt(cps) || 2;
        req.ductilities = duct.split(",").map((v) => parseFloat(v.trim())).filter((v) => v > 0);
      } else {
        req.phi_max_1_per_m = parseFloat(phiMax) || 0.05;
        req.n_cycles = parseInt(nc) || 5;
        req.decay = parseFloat(decay) || 0;
      }
      const r = await sectionEditorApi.cyclic(sectionId, req);
      setResult(r);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      {/* Configuración */}
      <div className="lg:col-span-1 flex flex-col gap-4">
        <div className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold">Protocolo de carga</h3>
          <div className="grid grid-cols-2 gap-2">
            {(["atc_24", "sinusoidal"] as Proto[]).map((p) => (
              <button key={p} onClick={() => setProto(p)}
                className={`rounded-lg border py-2 text-xs font-semibold transition-all
                  ${proto === p ? "border-accent bg-accent/10 text-accent" : "border-border text-text-muted hover:text-text"}`}>
                {p === "atc_24" ? "ATC-24 escalones" : "Senoidal"}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold">Parámetros</h3>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-[11px] text-text-muted">P axial (kN, + comp.)
              <input value={pKn} onChange={(e) => setPKn(e.target.value)} type="number"
                className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm font-mono" />
            </label>
            {proto === "atc_24" && (
              <>
                <label className="text-[11px] text-text-muted">φy (1/m, ref.)
                  <input value={phiY} onChange={(e) => setPhiY(e.target.value)} type="number" step="0.01"
                    className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm font-mono" />
                </label>
                <label className="text-[11px] text-text-muted col-span-2">Ductilidades objetivo
                  <input value={duct} onChange={(e) => setDuct(e.target.value)}
                    placeholder="0.5, 1, 2, 3, 4"
                    className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm font-mono" />
                </label>
                <label className="text-[11px] text-text-muted">Ciclos por nivel
                  <input value={cps} onChange={(e) => setCps(e.target.value)} type="number" min="1"
                    className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm font-mono" />
                </label>
              </>
            )}
            {proto === "sinusoidal" && (
              <>
                <label className="text-[11px] text-text-muted">φmax (1/m)
                  <input value={phiMax} onChange={(e) => setPhiMax(e.target.value)} type="number" step="0.01"
                    className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm font-mono" />
                </label>
                <label className="text-[11px] text-text-muted">Nº ciclos
                  <input value={nc} onChange={(e) => setNc(e.target.value)} type="number" min="1"
                    className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm font-mono" />
                </label>
                <label className="text-[11px] text-text-muted">Decay (0=constante)
                  <input value={decay} onChange={(e) => setDecay(e.target.value)} type="number" step="0.1" min="0"
                    className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm font-mono" />
                </label>
              </>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-amber-500/40 bg-amber-500/5 p-4">
          <p className="text-xs text-amber-500 font-semibold">Requisitos del modelo</p>
          <p className="mt-1 text-[11px] text-text-muted leading-relaxed">
            La sección debe usar <strong>Concrete02</strong> y <strong>Steel02</strong> (memoria histerética).
            Configúralo en el editor → Materiales.
          </p>
        </div>

        <Button onClick={run} disabled={loading}>
          {loading ? "Analizando…" : "Ejecutar análisis cíclico"}
        </Button>
        {error && <p className="text-danger text-xs">{error}</p>}
      </div>

      {/* Resultados */}
      <div className="lg:col-span-2 flex flex-col gap-4">
        {!result && (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-surface-2 py-16">
            <p className="text-sm text-text-muted">Configura protocolo y parámetros, pulsa <strong>Ejecutar análisis cíclico</strong>.</p>
          </div>
        )}

        {result && (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Puntos historia" value={result.n_points} />
              <Stat label="Ciclos detectados" value={result.n_cycles} />
              <Stat label="Energía total disipada" value={result.total_energy_dis_kN.toFixed(3)} unit="kN" />
              <Stat label="Protocolo" value={result.protocol} />
            </div>

            <HysteresisChart curve={result.curve} />

            {result.cycles.length > 0 && (
              <div className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
                <h4 className="mb-3 text-sm font-semibold">Métricas por ciclo</h4>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-text-muted border-b border-border">
                        <th className="text-left py-1.5 pr-3">#</th>
                        <th className="text-right pr-3">M+ (kN·m)</th>
                        <th className="text-right pr-3">M− (kN·m)</th>
                        <th className="text-right pr-3">φ+ (1/m)</th>
                        <th className="text-right pr-3">φ− (1/m)</th>
                        <th className="text-right pr-3">ξ_eq (%)</th>
                        <th className="text-right pr-3">Ed (kN)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.cycles.map((c, i) => (
                        <tr key={i} className="border-b border-border/40 font-mono">
                          <td className="py-1 pr-3">{i + 1}</td>
                          <td className="text-right pr-3 tabular-nums">{c.peak_pos_M_kNm.toFixed(1)}</td>
                          <td className="text-right pr-3 tabular-nums">{c.peak_neg_M_kNm.toFixed(1)}</td>
                          <td className="text-right pr-3 tabular-nums">{(c.peak_pos_phi_1_per_m * 1000).toFixed(3)}</td>
                          <td className="text-right pr-3 tabular-nums">{(c.peak_neg_phi_1_per_m * 1000).toFixed(3)}</td>
                          <td className="text-right pr-3 tabular-nums text-accent">{c.xi_eq_pct.toFixed(1)}</td>
                          <td className="text-right pr-3 tabular-nums">{c.Ed_kNm2.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {result.notes.length > 0 && (
              <div className="rounded-2xl border border-amber-500/40 bg-amber-500/5 p-4">
                <h4 className="mb-2 text-sm font-semibold text-amber-500">Notas</h4>
                <ul className="list-disc pl-5 text-xs text-text-muted space-y-1">
                  {result.notes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function HysteresisChart({ curve }: { curve: { phi_1_per_m: number; moment_kNm: number }[] }) {
  if (!curve.length) return null;
  const W = 720, H = 420, pad = { l: 60, r: 20, t: 20, b: 46 };
  const phis = curve.map((c) => c.phi_1_per_m * 1000);  // 1/m → ×1000 → 1/km para visualizar
  const moms = curve.map((c) => c.moment_kNm);
  const phi_max = Math.max(Math.abs(Math.max(...phis)), Math.abs(Math.min(...phis)));
  const m_max   = Math.max(Math.abs(Math.max(...moms)), Math.abs(Math.min(...moms)));
  const sx = (v: number) => pad.l + (W - pad.l - pad.r) / 2 + (v / phi_max) * (W - pad.l - pad.r) / 2;
  const sy = (v: number) => pad.t + (H - pad.t - pad.b) / 2 - (v / m_max) * (H - pad.t - pad.b) / 2;

  const path = curve.map((p, i) => `${i === 0 ? "M" : "L"} ${sx(p.phi_1_per_m * 1000).toFixed(1)} ${sy(p.moment_kNm).toFixed(1)}`).join(" ");

  return (
    <div className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
      <h4 className="mb-2 text-sm font-semibold">Lazos histeréticos M-φ</h4>
      <svg width={W} height={H} className="max-w-full">
        {/* Ejes cruzados */}
        <line x1={pad.l} y1={sy(0)} x2={W - pad.r} y2={sy(0)} stroke="var(--color-border)" />
        <line x1={sx(0)} y1={pad.t} x2={sx(0)} y2={H - pad.b} stroke="var(--color-border)" />
        {/* Ticks y grid */}
        {[-1, -0.5, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={pad.l} y1={sy(f * m_max)} x2={W - pad.r} y2={sy(f * m_max)}
              stroke="var(--color-border)" strokeOpacity="0.2" strokeDasharray="2 4" />
            <text x={pad.l - 6} y={sy(f * m_max) + 3} fontSize="10" fill="var(--color-text-muted)" textAnchor="end">
              {(f * m_max).toFixed(0)}
            </text>
            <line x1={sx(f * phi_max)} y1={pad.t} x2={sx(f * phi_max)} y2={H - pad.b}
              stroke="var(--color-border)" strokeOpacity="0.2" strokeDasharray="2 4" />
            <text x={sx(f * phi_max)} y={H - pad.b + 14} fontSize="10" fill="var(--color-text-muted)" textAnchor="middle">
              {(f * phi_max).toFixed(2)}
            </text>
          </g>
        ))}
        {/* Curva histerética */}
        <path d={path} fill="none" stroke="var(--color-accent)" strokeWidth="1.3" strokeOpacity="0.85" />
        {/* Labels */}
        <text x={(pad.l + W - pad.r) / 2} y={H - 8} fontSize="11" fill="var(--color-text-muted)" textAnchor="middle">
          Curvatura φ (1/km)
        </text>
        <text x={16} y={(pad.t + H - pad.b) / 2} fontSize="11" fill="var(--color-text-muted)"
          transform={`rotate(-90 16 ${(pad.t + H - pad.b) / 2})`} textAnchor="middle">
          Momento M (kN·m)
        </text>
      </svg>
    </div>
  );
}

// ── Tab Servicio (fisuración) ──────────────────────────────────────────────

function ServiceTab({ sectionId }: { sectionId: string }) {
  type Elem = "beam" | "column" | "wall" | "slab_2d" | "diaphragm";
  const [ma, setMa]                 = useState("0");
  const [elem, setElem]             = useState<Elem>("beam");
  const [wallCracked, setWallCracked] = useState(false);
  const [result, setResult]         = useState<import("@/lib/editor-api").ServiceabilityResult | null>(null);
  const [error, setError]           = useState<string | null>(null);
  const [loading, setLoading]       = useState(false);

  const run = async () => {
    setLoading(true); setError(null);
    try {
      const r = await sectionEditorApi.serviceability(sectionId, {
        Ma_kNm: parseFloat(ma) || 0,
        element_kind: elem,
        wall_cracked: wallCracked,
      });
      setResult(r);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      {/* Entrada */}
      <div className="lg:col-span-1 flex flex-col gap-4">
        <div className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold">Tipo de elemento</h3>
          <div className="grid grid-cols-2 gap-1.5">
            {([
              ["beam", "Viga"],
              ["column", "Columna"],
              ["wall", "Muro"],
              ["slab_2d", "Losa 2D"],
              ["diaphragm", "Diafragma"],
            ] as const).map(([v, label]) => (
              <button key={v} onClick={() => setElem(v)}
                className={`rounded-lg border py-2 text-xs font-semibold transition-all
                  ${elem === v ? "border-accent bg-accent/10 text-accent" : "border-border text-text-muted hover:text-text"}`}>
                {label}
              </button>
            ))}
          </div>
          {elem === "wall" && (
            <label className="mt-3 flex items-center gap-2 text-xs cursor-pointer">
              <input type="checkbox" checked={wallCracked}
                onChange={(e) => setWallCracked(e.target.checked)} />
              Muro considerado fisurado (0.35·Ig vs 0.70·Ig)
            </label>
          )}
        </div>

        <div className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold">Momento aplicado</h3>
          <label className="text-[11px] text-text-muted">Ma (kN·m)
            <input value={ma} onChange={(e) => setMa(e.target.value)} type="number"
              className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm font-mono" />
          </label>
          <p className="mt-2 text-[11px] text-text-muted italic">
            Se usa para calcular Ie de Branson (interpola entre Ig e Icr).
            Ma = 0 → sin Branson.
          </p>
        </div>

        <Button onClick={run} disabled={loading}>
          {loading ? "Calculando…" : "Analizar servicio"}
        </Button>
        {error && <p className="text-danger text-xs">{error}</p>}
      </div>

      {/* Resultados */}
      <div className="lg:col-span-2 flex flex-col gap-4">
        {!result && (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-surface-2 py-16">
            <p className="text-sm text-text-muted">Configura Ma y tipo, pulsa <strong>Analizar servicio</strong>.</p>
            <p className="mt-1 text-xs text-text-muted">Calcula Mcr, Icr (sección transformada), Ie (Branson) y recomendación NSR-10 A.5.3.</p>
          </div>
        )}

        {result && (
          <>
            {/* Cracking */}
            <section>
              <h4 className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-text">Fisuración</h4>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Stat label="fr" value={result.materials.fr_MPa.toFixed(3)} unit="MPa" />
                <Stat label="Mcr (+)" value={result.cracking.Mcr_kNm.toFixed(1)} unit="kN·m" />
                <Stat label="Mcr (−)" value={result.cracking.Mcr_neg_kNm.toFixed(1)} unit="kN·m" />
                <Stat label="yt" value={result.cracking.yt_mm.toFixed(0)} unit="mm" />
              </div>
            </section>

            {/* Inercias */}
            <section>
              <h4 className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-text">Inercias</h4>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                <Stat label="Ig (bruta)" value={result.cracking.Ig_cm4.toFixed(0)} unit="cm⁴" />
                <Stat label="Icr (fisurada)" value={result.cracked_section.Icr_cm4.toFixed(0)} unit="cm⁴" />
                <Stat label="Ie (Branson)" value={result.effective.Ie_cm4.toFixed(0)} unit="cm⁴" />
                <Stat label="Icr/Ig" value={(result.cracked_section.Icr_cm4/result.cracking.Ig_cm4*100).toFixed(1)} unit="%" />
                <Stat label="Ie/Ig" value={(result.effective.Ie_cm4/result.cracking.Ig_cm4*100).toFixed(1)} unit="%" />
                <Stat label="c (fibra→eje neutro)" value={result.cracked_section.c_neutral_mm.toFixed(0)} unit="mm" />
              </div>
            </section>

            {/* NSR-10 A.5.3 */}
            <section>
              <h4 className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-text">Recomendación NSR-10 A.5.3 (análisis sísmico)</h4>
              <div className="rounded-2xl border border-accent/30 bg-accent/5 p-4">
                <p className="text-xs text-text-muted mb-2">
                  Para análisis elástico modal/espectral, NSR-10 A.5.3 recomienda usar:
                </p>
                <div className="grid grid-cols-3 gap-3">
                  <Stat label={`Ie/Ig (${result.nsr10_A53.element_kind})`}
                    value={(result.nsr10_A53.Ie_over_Ig * 100).toFixed(0)} unit="%" />
                  <Stat label="Ie recomendada" value={result.nsr10_A53.Ie_recommended_cm4.toFixed(0)} unit="cm⁴" />
                  <Stat label="EI recomendada" value={(result.materials.Ec_MPa * result.nsr10_A53.Ie_recommended_cm4 * 1e4 / 1e12).toFixed(2)} unit="MN·m²" />
                </div>
              </div>
            </section>

            {/* Curvaturas y materiales */}
            <section>
              <h4 className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-text">Materiales derivados</h4>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Stat label="Ec" value={result.materials.Ec_MPa.toFixed(0)} unit="MPa" />
                <Stat label="Es" value={result.materials.Es_MPa.toFixed(0)} unit="MPa" />
                <Stat label="n = Es/Ec" value={result.materials.n.toFixed(2)} />
                {result.input.Ma_kNm !== 0 && (
                  <Stat label="φ servicio" value={result.effective.phi_service_1_per_km.toFixed(4)} unit="1/km" />
                )}
              </div>
            </section>

            {result.notes.length > 0 && (
              <div className="rounded-2xl border border-amber-500/40 bg-amber-500/5 p-4">
                <h4 className="mb-2 text-sm font-semibold text-amber-500">Notas del análisis</h4>
                <ul className="list-disc pl-5 text-xs text-text-muted space-y-1">
                  {result.notes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Página principal ────────────────────────────────────────────────────────

const TAB_LABELS: Record<Tab, string> = {
  props:       "Propiedades",
  pm:          "Diagrama P-M",
  mc:          "Curva M-φ",
  pmm:         "Superficie P-M-M",
  shear:       "Cortante",
  ductility:   "Ductilidad",
  cyclic:      "Cíclico",
  service:     "Servicio",
  nsr10:       "NSR-10",
  diagnostico: "Diagnóstico",
};

export default function AnalyzePage() {
  useRequireAuth();
  const { id } = useParams<{ id: string }>();
  const [record, setRecord]       = useState<SectionRecord | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("pm");

  // Resultados levantados para el tab Diagnóstico
  const [pmResult, setPmResult]         = useState<InteractionResult | null>(null);
  const [mcLastResult, setMcLastResult] = useState<MomentCurvatureResult | null>(null);
  const [nsr10Result, setNsr10Result]   = useState<NSR10Result | null>(null);

  useEffect(() => {
    if (!id) return;
    sectionEditorApi
      .get(id)
      .then(setRecord)
      .catch((e) => setLoadError(e instanceof ApiError ? e.message : "Error al cargar"));
  }, [id]);

  if (loadError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-bg">
        <p className="text-danger">{loadError}</p>
        <Link href="/sections"><Button variant="secondary">Volver</Button></Link>
      </div>
    );
  }

  const doc = record?.document ?? null;
  const ag  = doc ? sectionGrossArea(doc) : 0;
  const as_ = doc ? sectionSteelArea(doc) : 0;
  const rho = ag > 0 ? (as_ / ag) * 100 : 0;
  const sectionName = record?.name ?? "section";

  return (
    <div className="min-h-screen bg-bg">
      <header className="border-b border-border bg-surface px-6 py-3 print:hidden">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <div className="flex items-center gap-3 text-sm">
            <Link href="/sections" className="text-text-muted hover:text-text">← Secciones</Link>
            <span className="text-border">|</span>
            <Link href={`/sections/${id}/editor`} className="text-text-muted hover:text-text">
              {record?.name ?? "…"}
            </Link>
            <span className="text-border">|</span>
            <span className="font-medium text-text">Análisis</span>
          </div>
          <Link href={`/sections/${id}/editor`}>
            <Button variant="secondary" className="text-xs">← Volver al editor</Button>
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-6 py-6">
        {/* Resumen de sección */}
        {record && (
          <div className="mb-6 flex flex-wrap items-center gap-4 rounded-xl border border-border bg-surface px-4 py-3">
            <div className="flex-1">
              <h1 className="font-semibold text-text">{record.name}</h1>
              <p className="text-xs text-text-muted">
                {doc?.regions.length ?? 0} región(es) · {doc?.bars.length ?? 0} barras
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Stat label="Ag" value={(ag / 1e6).toFixed(4)} unit="m²" />
              <Stat label="As" value={as_.toFixed(0)} unit="mm²" />
              <Stat label="ρ" value={rho.toFixed(2)} unit="%" />
            </div>
            {doc?.regions.length === 0 && (
              <div className="w-full rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                La sección no tiene regiones — agrega geometría en el editor antes de analizar.
              </div>
            )}
          </div>
        )}

        {/* Tabs */}
        <div className="mb-4 flex gap-1 rounded-xl border border-border bg-surface p-1 print:hidden">
          {(["props", "pm", "mc", "pmm", "shear", "ductility", "cyclic", "service", "nsr10", "diagnostico"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              className={`flex-1 rounded-lg py-2 text-sm font-medium transition-colors
                ${activeTab === t ? "bg-accent text-[#04141a] shadow-sm" : "text-text-muted hover:text-text"}`}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>

        <div className="hidden print:mb-4 print:block">
          <h2 className="text-lg font-bold">{TAB_LABELS[activeTab]} — {sectionName}</h2>
        </div>

        {id && activeTab === "props" && (
          <PropsTab sectionId={id} />
        )}
        {id && activeTab === "pm" && (
          <PMTab sectionId={id} sectionName={sectionName} onResult={setPmResult} />
        )}
        {id && activeTab === "mc" && (
          <MCTab sectionId={id} sectionName={sectionName} onResult={setMcLastResult} />
        )}
        {id && activeTab === "pmm" && (
          <PMMTab sectionId={id} sectionName={sectionName} pMaxRef={0} />
        )}
        {id && activeTab === "shear" && (
          <ShearTab sectionId={id} />
        )}
        {id && activeTab === "ductility" && (
          <DuctilityTab sectionId={id} />
        )}
        {id && activeTab === "cyclic" && (
          <CyclicTab sectionId={id} />
        )}
        {id && activeTab === "service" && (
          <ServiceTab sectionId={id} />
        )}
        {id && activeTab === "nsr10" && (
          <NSR10Tab sectionId={id} sectionName={sectionName} onResult={setNsr10Result} />
        )}
        {activeTab === "diagnostico" && (
          <DiagnosticoTab
            doc={doc}
            ag={ag}
            rho={rho}
            pmResult={pmResult}
            mcLastResult={mcLastResult}
            nsr10Result={nsr10Result}
          />
        )}
      </div>
    </div>
  );
}
