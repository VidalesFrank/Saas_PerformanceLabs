"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ApiError } from "@/lib/api";
import { sectionEditorApi } from "@/lib/editor-api";
import type { InteractionResult, MomentCurvatureResult, PMMSurfaceResult, PMMDemand, PMMDemandResult, NSR10Result, NSR10CheckItem } from "@/lib/editor-api";
import type { SectionRecord } from "@/lib/section-document";
import { sectionGrossArea, sectionSteelArea } from "@/lib/section-document";
import { useRequireAuth } from "@/lib/use-require-auth";
import { Button } from "@/components/ui/button";
import { InteractionChart } from "@/components/interaction-chart";
import { PMMSurface3D, PMMEnvelopeChart, MxMyPanel } from "@/components/pmm-chart";
import { MomentCurvatureChart } from "@/components/section-editor/MomentCurvatureChart";
import type { InteractionPoint, PMMArcOut, PMMDemandOut } from "@/lib/types";

type Tab = "pm" | "mc" | "pmm" | "nsr10";

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

// ── Stat box ────────────────────────────────────────────────────────────────

function Stat({ label, value, unit }: { label: string; value: string | number; unit?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 px-3 py-2">
      <p className="text-[10px] text-text-muted">{label}</p>
      <p className="font-mono text-sm font-semibold text-text">
        {typeof value === "number" ? value.toLocaleString("es-CO", { maximumFractionDigits: 2 }) : value}
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

// ── Exportar CSV ──────────────────────────────────────────────────────────

function downloadCsv(rows: string[], filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/csv" }));
  a.download = filename;
  a.click();
}

// ── Tab P-M ────────────────────────────────────────────────────────────────

function PMTab({ sectionId, sectionName }: { sectionId: string; sectionName: string }) {
  const [numPoints, setNumPoints] = useState(20);
  const [thetaDeg, setThetaDeg] = useState(0);
  const [result, setResult] = useState<InteractionResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true); setError(null);
    try { setResult(await sectionEditorApi.interaction(sectionId, numPoints, thetaDeg)); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Error en análisis"); }
    finally { setLoading(false); }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-border bg-surface p-4">
        <div>
          <p className="mb-1 text-xs text-text-muted">Número de puntos</p>
          <input type="number" value={numPoints} min={5} max={50}
            onChange={(e) => setNumPoints(+e.target.value)}
            className="w-24 rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-text
              focus:border-accent focus:outline-none" />
        </div>
        <div>
          <p className="mb-1 text-xs text-text-muted">Ángulo θ (°)</p>
          <div className="flex items-center gap-2">
            <input type="number" value={thetaDeg} min={0} max={360} step={15}
              onChange={(e) => setThetaDeg(+e.target.value)}
              className="w-20 rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-text
                focus:border-accent focus:outline-none" />
            <div className="flex gap-1">
              {[0, 45, 90].map((a) => (
                <button key={a} onClick={() => setThetaDeg(a)}
                  className={`rounded px-2 py-1 text-[10px] ${thetaDeg === a ? "bg-accent text-[#04141a]" : "bg-surface-2 text-text-muted hover:text-text"}`}>
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

      {loading && <Spinner />}
      {result && !loading && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="P máx (compresión)" value={result.p_max_kn.toFixed(1)} unit="kN" />
            <Stat label="P mín (tensión)" value={result.p_min_kn.toFixed(1)} unit="kN" />
            <Stat label="M máx" value={result.m_max_knm.toFixed(1)} unit="kN·m" />
            <Stat label="Puntos calculados" value={result.points.length} />
          </div>
          <div className="rounded-xl border border-border bg-surface p-4">
            <InteractionChart points={toPMPoints(result.points)} />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => window.print()}>
              Imprimir / PDF
            </Button>
            <Button variant="secondary" onClick={() => downloadCsv(
              ["p_kn,m_knm", ...result.points.map((p) => `${p.p_kn},${p.m_knm}`)],
              `PM_${sectionName}.csv`
            )}>
              Exportar CSV
            </Button>
          </div>
        </>
      )}
      {!result && !loading && (
        <div className="rounded-xl border border-border bg-surface p-8 text-center text-text-muted">
          <p className="text-4xl mb-3">⊘</p>
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

function MCTab({ sectionId, sectionName }: { sectionId: string; sectionName: string }) {
  const [axialKn, setAxialKn] = useState(0);
  const [numIncr, setNumIncr] = useState(120);
  const [thetaDeg, setThetaDeg] = useState(0);
  const [runs, setRuns] = useState<MCRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true); setError(null);
    try {
      const res = await sectionEditorApi.momentCurvature(sectionId, axialKn, numIncr, 8.0, thetaDeg);
      const color = MC_COLORS[runs.length % MC_COLORS.length];
      setRuns((prev) => [...prev, { axialKn, result: res, color }]);
    }
    catch (e) { setError(e instanceof ApiError ? e.message : "Error en análisis"); }
    finally { setLoading(false); }
  }

  const latest = runs[runs.length - 1]?.result ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-border bg-surface p-4">
        <div>
          <p className="mb-1 text-xs text-text-muted">Carga axial P (kN)</p>
          <input type="number" value={axialKn}
            onChange={(e) => setAxialKn(+e.target.value)}
            className="w-28 rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-text
              focus:border-accent focus:outline-none" />
        </div>
        <div>
          <p className="mb-1 text-xs text-text-muted">Incrementos</p>
          <input type="number" value={numIncr} min={20} max={500}
            onChange={(e) => setNumIncr(+e.target.value)}
            className="w-24 rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-text
              focus:border-accent focus:outline-none" />
        </div>
        <div>
          <p className="mb-1 text-xs text-text-muted">Ángulo θ (°)</p>
          <div className="flex items-center gap-2">
            <input type="number" value={thetaDeg} min={0} max={360} step={15}
              onChange={(e) => setThetaDeg(+e.target.value)}
              className="w-20 rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-text
                focus:border-accent focus:outline-none" />
            <div className="flex gap-1">
              {[0, 90].map((a) => (
                <button key={a} onClick={() => setThetaDeg(a)}
                  className={`rounded px-2 py-1 text-[10px] ${thetaDeg === a ? "bg-accent text-[#04141a]" : "bg-surface-2 text-text-muted hover:text-text"}`}>
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

      {/* Leyenda de curvas */}
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
            {/* Mostrar última curva con el componente existente */}
            <MomentCurvatureChart result={latest} />
          </div>

          {/* Tabla comparativa si hay varias curvas */}
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
                      <td className="px-3 py-2 text-text font-semibold">{r.result.ductility.toFixed(2)}</td>
                      <td className="px-3 py-2 text-text">{(r.result.ei_secant_kNm2 / 1000).toFixed(0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => window.print()}>
              Imprimir / PDF
            </Button>
            <Button variant="secondary" onClick={() => downloadCsv(
              ["phi_1_m,moment_kNm", ...latest.curve.map((p) => `${p.phi},${p.moment}`)],
              `MC_${sectionName}_P${latest.axial_load_kn.toFixed(0)}kN.csv`
            )}>
              Exportar CSV
            </Button>
          </div>
        </>
      )}
      {runs.length === 0 && !loading && (
        <div className="rounded-xl border border-border bg-surface p-8 text-center text-text-muted">
          <p className="text-4xl mb-3">⊘</p>
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
        <button onClick={onRemove} className="text-danger/50 hover:text-danger text-xs">×</button>
      </td>
    </tr>
  );
}

function PMMTab({ sectionId, sectionName, pMaxRef }: { sectionId: string; sectionName: string; pMaxRef: number }) {
  const [numAngles, setNumAngles] = useState(12);
  const [numPoints, setNumPoints] = useState(12);
  const [demands, setDemands] = useState<PMMDemand[]>([]);
  const [result, setResult] = useState<PMMSurfaceResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true); setError(null);
    try { setResult(await sectionEditorApi.pmm(sectionId, numAngles, numPoints, demands)); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Error en análisis"); }
    finally { setLoading(false); }
  }

  function addDemand() {
    setDemands((d) => [...d, { ...EMPTY_DEMAND }]);
  }

  function updateDemand(i: number, d: PMMDemand) {
    setDemands((prev) => prev.map((x, j) => j === i ? d : x));
  }

  function removeDemand(i: number) {
    setDemands((prev) => prev.filter((_, j) => j !== i));
  }

  const curves = result ? toPMMArc(result.curves) : [];
  const demandResults = result ? toPMMDemands(result.demands_out) : [];

  return (
    <div className="flex flex-col gap-4">
      {/* Parámetros */}
      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-border bg-surface p-4">
        <div>
          <p className="mb-1 text-xs text-text-muted">Ángulos (meridianos)</p>
          <input type="number" value={numAngles} min={4} max={36}
            onChange={(e) => setNumAngles(+e.target.value)}
            className="w-24 rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-text
              focus:border-accent focus:outline-none" />
        </div>
        <div>
          <p className="mb-1 text-xs text-text-muted">Puntos por meridiano</p>
          <input type="number" value={numPoints} min={5} max={30}
            onChange={(e) => setNumPoints(+e.target.value)}
            className="w-24 rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-text
              focus:border-accent focus:outline-none" />
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

      {/* Tabla de demandas */}
      <div className="rounded-xl border border-border bg-surface overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <p className="text-xs font-semibold text-text">
            Verificación de demandas
            <span className="ml-2 font-normal text-text-muted">
              (se incluyen al calcular P-M-M)
            </span>
          </p>
          <button
            onClick={addDemand}
            className="rounded-lg bg-accent/15 px-2.5 py-1 text-xs text-accent hover:bg-accent/25"
          >
            + Agregar demanda
          </button>
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
                    <th key={h} className="px-2 py-2 text-left font-medium text-text-muted whitespace-nowrap">{h}</th>
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
                    onRemove={() => removeDemand(i)}
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
              curves={curves} demands={demandResults as unknown as PMMDemandOut[]}
              pMaxKn={result.p_max_kn} pMinKn={result.p_min_kn}
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
              <MxMyPanel curves={curves} demands={demandResults as unknown as PMMDemandOut[]} defaultP={result.p_max_kn * 0.4} />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => window.print()}>
              Imprimir / PDF
            </Button>
            {demands.length > 0 && result.demands_out.length > 0 && (
              <Button variant="secondary" onClick={() => downloadCsv(
                ["p_kn,mx_knm,my_knm,m_demand_knm,m_capacity_knm,dcr,inside",
                  ...result.demands_out.map((d) =>
                    `${d.p_kn},${d.mx_knm},${d.my_knm},${d.m_demand_knm},${d.m_capacity_knm},${d.dcr},${d.inside}`)],
                `PMM_demandas_${sectionName}.csv`
              )}>
                Exportar demandas CSV
              </Button>
            )}
          </div>
        </>
      )}
      {!result && !loading && (
        <div className="rounded-xl border border-border bg-surface p-8 text-center text-text-muted">
          <p className="text-4xl mb-3">⊘</p>
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

const STATUS_CONFIG = {
  ok:      { label: "OK",        bg: "bg-success/10",  border: "border-success/30",  text: "text-success",    icon: "✓" },
  fail:    { label: "NO CUMPLE", bg: "bg-danger/10",   border: "border-danger/30",   text: "text-danger",     icon: "✗" },
  warning: { label: "REVISAR",   bg: "bg-warning/10",  border: "border-warning/30",  text: "text-warning",    icon: "!" },
  info:    { label: "INFO",      bg: "bg-surface-2",   border: "border-border",      text: "text-text-muted", icon: "i" },
} as const;

function NSR10Tab({ sectionId }: { sectionId: string }) {
  const [elementType, setElementType] = useState<string>("columna");
  const [ductility, setDuctility]     = useState<string>("DMO");
  const [result, setResult]           = useState<NSR10Result | null>(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState<string | null>(null);

  async function run() {
    setLoading(true); setError(null);
    try { setResult(await sectionEditorApi.nsr10(sectionId, elementType, ductility)); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Error en verificación"); }
    finally { setLoading(false); }
  }

  const summary = result?.summary;
  const allOk = summary && summary.fail === 0 && summary.warning === 0;

  return (
    <div className="flex flex-col gap-4">
      {/* Controles */}
      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-border bg-surface p-4">
        <div>
          <p className="mb-1 text-xs text-text-muted">Tipo de elemento</p>
          <div className="flex gap-1">
            {ELEMENT_TYPES.map((et) => (
              <button
                key={et.value}
                onClick={() => setElementType(et.value)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors
                  ${elementType === et.value
                    ? "bg-accent text-[#04141a]"
                    : "bg-surface-2 text-text-muted hover:text-text border border-border"}`}
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
                key={d.value}
                onClick={() => setDuctility(d.value)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors
                  ${ductility === d.value
                    ? "bg-accent text-[#04141a]"
                    : "bg-surface-2 text-text-muted hover:text-text border border-border"}`}
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
          {/* Resumen */}
          <div className={`flex items-center gap-4 rounded-xl border px-5 py-4
            ${allOk ? "border-success/30 bg-success/8" : summary && summary.fail > 0 ? "border-danger/30 bg-danger/8" : "border-warning/30 bg-warning/8"}`}>
            <span className={`text-3xl font-bold ${allOk ? "text-success" : summary && summary.fail > 0 ? "text-danger" : "text-warning"}`}>
              {allOk ? "✓" : summary && summary.fail > 0 ? "✗" : "!"}
            </span>
            <div className="flex-1">
              <p className={`font-semibold ${allOk ? "text-success" : summary && summary.fail > 0 ? "text-danger" : "text-warning"}`}>
                {allOk ? "Cumple todos los criterios NSR-10"
                  : summary && summary.fail > 0 ? `No cumple ${summary.fail} criterio(s)`
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

          {/* Tabla de verificaciones */}
          <div className="rounded-xl border border-border bg-surface overflow-hidden">
            <div className="border-b border-border px-4 py-2.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                Verificaciones NSR-10 — {result.element_type} · {result.ductility}
              </p>
            </div>
            <div className="divide-y divide-border">
              {result.checks.map((c: NSR10CheckItem, i: number) => {
                const cfg = STATUS_CONFIG[c.status];
                const showValues = c.status !== "info" && c.unit !== "—";
                return (
                  <div key={i} className={`flex items-start gap-3 px-4 py-3 ${cfg.bg}`}>
                    {/* Icono de estado */}
                    <div className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full
                      text-[10px] font-bold border ${cfg.border} ${cfg.text}`}>
                      {cfg.icon}
                    </div>
                    {/* Contenido */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className="font-mono text-[10px] text-text-muted">{c.article}</span>
                        <span className="text-sm text-text">{c.description}</span>
                      </div>
                      {showValues && (
                        <div className="mt-1 flex flex-wrap gap-3 text-xs">
                          <span className="text-text-muted">
                            Calculado: <span className={`font-mono font-semibold ${cfg.text}`}>
                              {c.demand.toFixed(c.unit === "%" ? 3 : c.unit === "mm" ? 1 : 0)} {c.unit}
                            </span>
                          </span>
                          {c.limit > 0 && (
                            <span className="text-text-muted">
                              Límite: <span className="font-mono">{c.limit.toFixed(c.unit === "%" ? 3 : c.unit === "mm" ? 1 : 0)} {c.unit}</span>
                            </span>
                          )}
                        </div>
                      )}
                      {c.note && (
                        <p className="mt-0.5 text-[11px] italic text-text-muted">{c.note}</p>
                      )}
                    </div>
                    {/* Badge de estado */}
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold border ${cfg.border} ${cfg.text}`}>
                      {cfg.label}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {!result && !loading && (
        <div className="rounded-xl border border-border bg-surface p-10 text-center text-text-muted">
          <p className="text-4xl mb-3">⊘</p>
          <p className="text-sm">Selecciona el tipo de elemento y categoría de ductilidad, luego presiona "Verificar NSR-10".</p>
          <p className="mt-1 text-xs">Los criterios aplicables cambiarán según tu selección.</p>
        </div>
      )}
    </div>
  );
}

// ── Página principal ────────────────────────────────────────────────────────

const TAB_LABELS: Record<Tab, string> = {
  pm: "Diagrama P-M",
  mc: "Curva M-φ",
  pmm: "Superficie P-M-M",
  nsr10: "NSR-10",
};

export default function AnalyzePage() {
  useRequireAuth();
  const { id } = useParams<{ id: string }>();
  const [record, setRecord] = useState<SectionRecord | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("pm");

  useEffect(() => {
    if (!id) return;
    sectionEditorApi.get(id)
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
  const ag = doc ? sectionGrossArea(doc) : 0;
  const as_ = doc ? sectionSteelArea(doc) : 0;
  const rho = ag > 0 ? (as_ / ag) * 100 : 0;
  const sectionName = record?.name ?? "section";

  return (
    <div className="min-h-screen bg-bg">
      {/* Header */}
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
            {(doc?.regions.length === 0) && (
              <div className="w-full rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                La sección no tiene regiones — agrega geometría en el editor antes de analizar.
              </div>
            )}
          </div>
        )}

        {/* Tabs */}
        <div className="mb-4 flex gap-1 rounded-xl border border-border bg-surface p-1 print:hidden">
          {(["pm", "mc", "pmm", "nsr10"] as Tab[]).map((t) => (
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

        {/* Título para impresión */}
        <div className="hidden print:block mb-4">
          <h2 className="text-lg font-bold">{TAB_LABELS[activeTab]} — {sectionName}</h2>
        </div>

        {id && activeTab === "pm"    && <PMTab    sectionId={id} sectionName={sectionName} />}
        {id && activeTab === "mc"    && <MCTab    sectionId={id} sectionName={sectionName} />}
        {id && activeTab === "pmm"   && <PMMTab   sectionId={id} sectionName={sectionName} pMaxRef={0} />}
        {id && activeTab === "nsr10" && <NSR10Tab sectionId={id} />}
      </div>
    </div>
  );
}
