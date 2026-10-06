"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { structuralAnalysisApi } from "@/lib/structural-api";
import { getToken } from "@/lib/auth";
import type {
  NLFramePushoverResult, NLFramePushoverDirResult, HingeRecord,
} from "@/lib/structural-types";
import NLFramePushoverLauncher    from "./NLFramePushoverLauncher";
import FrameDeformedShape3D       from "./FrameDeformedShape3D";
import CriticalElementsPanel      from "./CriticalElementsPanel";
import FrameElementResponseCurve  from "./FrameElementResponseCurve";

interface Props {
  projectId: string;
}

export default function NLFramePushoverPanel({ projectId }: Props) {
  const [result, setResult]       = useState<NLFramePushoverResult | null>(null);
  const [loading, setLoading]     = useState<boolean>(true);
  const [error, setError]         = useState<string | null>(null);
  const [defDir, setDefDir]       = useState<"X" | "Y">("X");
  const [selected, setSelected]   = useState<{ fid: string; end: "i" | "j" } | null>(null);

  const fetchResult = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await structuralAnalysisApi.getNLFramePushover(projectId);
      setResult(r);
      // Auto-selecciona dirección válida
      if (r.pushover_X?.status === "success" || r.pushover_X?.status === "partial") setDefDir("X");
      else if (r.pushover_Y?.status === "success" || r.pushover_Y?.status === "partial") setDefDir("Y");
    } catch (e) {
      // 404 → sin resultado aún (es normal antes de correr)
      if ((e instanceof Error ? e.message : String(e)).match(/no.*hay/i)) {
        setResult(null);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { fetchResult(); }, [fetchResult]);

  const dirResult: NLFramePushoverDirResult | undefined =
    defDir === "X" ? result?.pushover_X : result?.pushover_Y;

  const hinges: HingeRecord[] = dirResult?.damage?.hinges ?? [];

  function handleSelectHinge(fid: string, end: "i" | "j") {
    setSelected({ fid, end });
    setTimeout(() => {
      document.getElementById("element-response-section")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
  }

  async function handleDownloadXlsx() {
    try {
      const token = getToken();
      const url = structuralAnalysisApi.nlFramePushoverXlsxUrl(projectId);
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const blobUrl = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `pushover_porticos_${projectId.slice(0, 8)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => window.URL.revokeObjectURL(blobUrl), 500);
    } catch (e) {
      alert(`No se pudo descargar el XLSX: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Launcher siempre visible */}
      <NLFramePushoverLauncher
        projectId={projectId}
        onCompleted={() => fetchResult()}
      />

      {loading && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 flex items-center justify-center">
          <p className="text-xs text-[var(--text-muted)] animate-pulse">
            Cargando resultados…
          </p>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-300 bg-red-50 p-4">
          <p className="text-xs text-red-700">{error}</p>
        </div>
      )}

      {!loading && !result && !error && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6">
          <p className="text-sm text-[var(--text-muted)] text-center">
            Aún no hay resultados de pushover. Configura y lanza un análisis arriba.
          </p>
        </div>
      )}

      {result && (
        <>
          {/* Si todas las direcciones fallaron, mostrar banner explicativo */}
          {Object.values(result.summary).every((s) =>
            s.status === "failed" || (s.converged_steps ?? 0) === 0
          ) && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 flex flex-col gap-2">
              <p className="text-sm font-semibold text-amber-800">
                El pushover no convergió en ninguna dirección.
              </p>
              <p className="text-xs text-amber-700">
                Causas probables: el modelo no lineal falló al ensamblarse
                (secciones Fiber inválidas, nodos faltantes), o la gravedad no
                convergió por un modelo mal condicionado. Revisa los logs del
                worker para el error específico.
              </p>
              <div className="text-[10px] font-mono text-amber-900 bg-amber-100 rounded px-2 py-1">
                {Object.entries(result.summary).map(([d, s]) =>
                  `Dir ${d}: ${s.status} (${s.converged_steps ?? 0}/${s.total_steps ?? 0} pasos)`
                ).join(" · ")}
              </div>
            </div>
          )}

          {/* Barra de acciones (export) */}
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={handleDownloadXlsx}
              className="px-3 py-1.5 rounded-md text-xs font-semibold bg-[var(--surface-2)] text-[var(--text)] border border-[var(--border)] hover:bg-[var(--surface)] transition-colors"
              title="Descarga XLSX con resumen, curvas pushover, rótulas por nivel de daño y metadata"
            >
              ⬇ Exportar XLSX
            </button>
          </div>

          {/* Resumen por dirección */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {(["X", "Y"] as const).map((dir) => {
              const s = result.summary[dir];
              if (!s) return null;
              const pct = s.total_steps > 0 ? (s.converged_steps / s.total_steps) * 100 : 0;
              const col = s.status === "success" ? "#22c55e"
                        : s.status === "partial" ? "#f59e0b" : "#ef4444";
              return (
                <div key={dir} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold">Dirección {dir}</span>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded"
                          style={{ background: `${col}22`, color: col }}>
                      {s.status} · {s.pattern_type}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-y-1 text-xs">
                    <span className="text-[var(--text-muted)]">Deriva máx.</span>
                    <span className="text-right font-mono">{(s.max_drift_pct ?? 0).toFixed(3)}%</span>
                    <span className="text-[var(--text-muted)]">Vb máx.</span>
                    <span className="text-right font-mono">{(s.max_base_shear_kN ?? 0).toFixed(1)} kN</span>
                    <span className="text-[var(--text-muted)]">Pasos conv.</span>
                    <span className="text-right font-mono">{s.converged_steps} / {s.total_steps}</span>
                    <span className="text-[var(--text-muted)]">Rótulas &gt; LS</span>
                    <span className="text-right font-mono">{s.n_critical_hinges ?? 0}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-[var(--surface-2)] overflow-hidden">
                    <div className="h-full rounded-full"
                         style={{ width: `${pct}%`, background: col }} />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Curvas pushover */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {result.pushover_X && <PushoverChart dir="X" data={result.pushover_X} color="#3b82f6" />}
            {result.pushover_Y && <PushoverChart dir="Y" data={result.pushover_Y} color="#22c55e" />}
          </div>

          {/* Visor 3D con rótulas */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-semibold uppercase tracking-wider">
                Deformada 3D con rótulas plásticas (ASCE 41)
              </h3>
              <div className="flex items-center gap-1">
                {(["X", "Y"] as const).map((d) => {
                  const dr = d === "X" ? result.pushover_X : result.pushover_Y;
                  const enabled = dr?.status === "success" || dr?.status === "partial";
                  return (
                    <button
                      key={d}
                      onClick={() => enabled && setDefDir(d)}
                      disabled={!enabled}
                      className={[
                        "px-2.5 py-1 rounded text-[11px] font-medium transition-colors",
                        defDir === d
                          ? "bg-[var(--accent)] text-white"
                          : enabled
                          ? "bg-[var(--surface-2)] text-[var(--text-muted)] hover:text-[var(--text)]"
                          : "bg-[var(--surface-2)] text-[var(--text-muted)] opacity-40 cursor-not-allowed",
                      ].join(" ")}
                    >
                      Dir {d}
                    </button>
                  );
                })}
              </div>
            </div>
            <FrameDeformedShape3D
              projectId={projectId}
              direction={defDir}
              height={520}
              onSelectHinge={handleSelectHinge}
              selectedFid={selected?.fid ?? null}
            />
            <p className="text-[10px] text-[var(--text-muted)] italic">
              Click en cualquier rótula del 3D o en la tabla inferior para ver
              su curva local y detalles.
            </p>
          </div>

          {/* Elemento seleccionado */}
          {selected && (
            <div id="element-response-section" className="flex flex-col gap-2 scroll-mt-4">
              <FrameElementResponseCurve
                projectId={projectId}
                direction={defDir}
                fid={selected.fid}
                end={selected.end}
                onClose={() => setSelected(null)}
              />
            </div>
          )}

          {/* Ranking de rótulas */}
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold uppercase tracking-wider">
              Rótulas plásticas críticas — Dir {defDir}
            </h3>
            <CriticalElementsPanel
              hinges={hinges}
              onSelectHinge={handleSelectHinge}
              selectedFid={selected?.fid ?? null}
            />
          </div>
        </>
      )}
    </div>
  );
}


function PushoverChart({
  dir, data, color,
}: {
  dir: string;
  data: { steps: Array<{ drift_pct: number; base_shear_kN: number }>; summary?: Record<string, number>; converged_steps: number };
  color: string;
}) {
  const divRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!divRef.current || !data.steps || data.steps.length === 0) return;
    const Plotly = (window as unknown as { Plotly?: {
      newPlot: (...a: unknown[]) => void;
      purge:   (el: Element) => void;
    } }).Plotly;
    if (!Plotly) return;

    const drifts = data.steps.map((s) => s.drift_pct);
    const shears = data.steps.map((s) => s.base_shear_kN);

    Plotly.newPlot(
      divRef.current,
      [{
        x: drifts, y: shears,
        type: "scatter", mode: "lines",
        line: { color, width: 2 },
        hovertemplate: "Deriva: %{x:.3f}%<br>Vb: %{y:.1f} kN<extra></extra>",
      }],
      {
        paper_bgcolor: "transparent", plot_bgcolor: "transparent",
        font: { size: 11 }, margin: { t: 10, r: 10, b: 50, l: 60 },
        xaxis: { title: { text: "Deriva de techo (%)" }, gridcolor: "var(--border)" },
        yaxis: { title: { text: "Cortante basal (kN)" }, gridcolor: "var(--border)" },
        showlegend: false,
      },
      { responsive: true, displayModeBar: false },
    );

    return () => { if (divRef.current) Plotly.purge(divRef.current); };
  }, [data, color]);

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <p className="text-xs font-semibold text-[var(--text-muted)] mb-3 uppercase tracking-wider">
        Curva Pushover — Dir {dir}
      </p>
      {data.steps && data.steps.length > 0 ? (
        <div ref={divRef} style={{ height: 260 }} />
      ) : (
        <div className="flex items-center justify-center h-[260px] text-xs text-[var(--text-muted)]">
          Sin pasos convergidos
        </div>
      )}
      <p className="text-[10px] text-[var(--text-muted)] mt-2 text-center">
        {data.converged_steps} pasos ·
        {" "}deriva máx {(data.summary?.max_drift_pct ?? 0).toFixed(3)}% ·
        {" "}Vb máx {(data.summary?.max_base_shear_kN ?? 0).toFixed(1)} kN
      </p>
    </div>
  );
}
