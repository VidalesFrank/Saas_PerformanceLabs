"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { structuralAnalysisApi, elementThresholdsApi } from "@/lib/structural-api";
import type { ElementDemandResult } from "@/lib/structural-api";
import { getToken } from "@/lib/auth";
import type {
  NLFramePushoverResult, NLFramePushoverDirResult, HingeRecord,
  HingeThresholds, NLFramePushoverHistory, LocalEventsPayload, LocalEvent,
} from "@/lib/structural-types";
import NLFramePushoverLauncher    from "./NLFramePushoverLauncher";
import { AnalysisHealthBanner }    from "./AnalysisHealthBanner";
import { usePlotly }                from "@/lib/use-plotly";
import { plotlyLayoutPremium, plotlyConfigPremium } from "@/lib/plotly-theme";
import FrameDeformedShape3D       from "./FrameDeformedShape3D";
import DriftProfileChart          from "./DriftProfileChart";
import CriticalElementsPanel      from "./CriticalElementsPanel";
import FrameElementResponseCurve  from "./FrameElementResponseCurve";
import HingeThresholdsPanel, {
  ASCE41_DMO, classifyWithThresholds, effectiveThresholds,
} from "./HingeThresholdsPanel";
import N2PerformancePanel          from "./N2PerformancePanel";
import LocalEventsPanel, {
  EVENT_STYLE,
} from "./LocalEventsPanel";
import RepairPlanPanel          from "./RepairPlanPanel";
import GlobalStatusPanel, {
  VB_DROP_THRESHOLD,
} from "./GlobalStatusPanel";
import { useBuildingWeightKN }     from "./use-building-weight";

type VbUnit = "kN" | "ratio";

interface Props {
  projectId:     string;
  /** Oculta el launcher interno — útil cuando el padre ya trae uno unificado. */
  hideLauncher?: boolean;
}

export default function NLFramePushoverPanel({ projectId, hideLauncher = false }: Props) {
  const [result, setResult]       = useState<NLFramePushoverResult | null>(null);
  const [loading, setLoading]     = useState<boolean>(true);
  const [error, setError]         = useState<string | null>(null);
  const [defDir, setDefDir]       = useState<"X" | "Y">("X");
  const [selected, setSelected]   = useState<{ fid: string; end: "i" | "j" } | null>(null);
  const [thresholds, setThresholds] = useState<HingeThresholds>(ASCE41_DMO);
  /** Rótulas enriquecidas con theta_p_hist (vienen del endpoint history del visor). */
  const [history, setHistory]     = useState<NLFramePushoverHistory | null>(null);
  const [vbUnit, setVbUnit]       = useState<VbUnit>("kN");
  /** Frame actual sincronizado desde el visor 3D. Permite marcar paso en la
   *  curva pushover y actualizar el perfil de deriva. */
  const [frameIdx, setFrameIdx]   = useState<number>(0);
  const [playing, setPlaying]     = useState<boolean>(false);
  const [demand, setDemand]       = useState<ElementDemandResult | null>(null);
  const [showDamageOverlay, setShowDamageOverlay] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    elementThresholdsApi.getElementDemand(projectId)
      .then(d => { if (!cancelled) setDemand(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [projectId]);

  const handleFrameChange = useCallback((idx: number, isPlaying: boolean) => {
    setFrameIdx(idx);
    setPlaying(isPlaying);
  }, []);

  // ── Primer colapso: paso donde al menos 1 rótula entra en nivel "collapse".
  // Se calcula sobre el history (hinges con theta_p_hist) para la dirección
  // activa. Usado para advertencia visual en la curva y en el banner.
  const firstCollapseInfo = useMemo(() => {
    if (!history || history.frames.length === 0) {
      return { step: null as number | null, drift: null as number | null,
               nCollapsed: 0, nTotal: 0 };
    }
    const hinges = history.hinge_damage ?? [];
    let firstFrame = Infinity;
    let nCollapsed = 0;
    for (const h of hinges) {
      if (h.damage_level === "collapse") nCollapsed += 1;
      // Buscar el primer frame donde θ_p_hist superó θ_CP·1.5 (colapso)
      const hist = Array.isArray(h.theta_p_hist) ? h.theta_p_hist : null;
      const thetaCP = Number(h.theta_CP ?? 0);
      if (hist && thetaCP > 0) {
        const limit = 1.5 * thetaCP;
        for (let i = 0; i < hist.length; i++) {
          if (hist[i] >= limit) {
            if (i < firstFrame) firstFrame = i;
            break;
          }
        }
      }
    }
    if (firstFrame === Infinity) {
      return { step: null, drift: null, nCollapsed, nTotal: hinges.length };
    }
    const drift = history.frames[firstFrame]?.drift_pct ?? null;
    return { step: firstFrame, drift, nCollapsed, nTotal: hinges.length };
  }, [history]);

  // Mapea frameIdx del visor al step de la curva pushover (misma lógica que stepForFrame)
  const stepForFrameFromCurve = (nSteps: number, frameIdxInHistory: number) => {
    if (!history || history.frames.length <= 1 || nSteps <= 1) return 0;
    const ratio = frameIdxInHistory / (history.frames.length - 1);
    return Math.round(ratio * (nSteps - 1));
  };

  // Mapear frameIdx (del visor, 0..n_frames-1) al step index de la curva
  // pushover (0..n_steps-1). La curva tiene stride=1 pero el history puede
  // submuestrearse; usamos el ratio del largo de los arrays.
  const stepForFrame = (nSteps: number) => {
    if (!history || history.frames.length <= 1 || nSteps <= 1) return 0;
    const ratio = frameIdx / (history.frames.length - 1);
    return Math.round(ratio * (nSteps - 1));
  };
  const W_kN = useBuildingWeightKN(projectId);

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

  // Al cambiar de dirección, limpia el history (el visor refetchará y notificará).
  useEffect(() => { setHistory(null); }, [defDir]);

  const dirResult: NLFramePushoverDirResult | undefined =
    defDir === "X" ? result?.pushover_X : result?.pushover_Y;

  // Hinges del endpoint history (tienen theta_p_hist y campos base). Si aún
  // no cargó, caemos al dirResult.damage.hinges para no romper el ranking.
  const rawHinges: HingeRecord[] =
    history?.hinge_damage ?? dirResult?.damage?.hinges ?? [];

  /** Reclasifica cada rótula según los umbrales actuales usando θ_p MÁXIMO. */
  const hinges: HingeRecord[] = useMemo(() => {
    return rawHinges.map((h) => {
      const { IO, LS, CP } = effectiveThresholds(h, thresholds);
      const level  = classifyWithThresholds(h.theta_p_max, IO, LS, CP);
      const dcr    = CP > 0 ? h.theta_p_max / CP : 0;
      return {
        ...h,
        damage_level: level,
        dcr:          +dcr.toFixed(3),
        theta_IO:     +IO.toFixed(6),
        theta_LS:     +LS.toFixed(6),
        theta_CP:     +CP.toFixed(6),
      };
    });
  }, [rawHinges, thresholds]);

  /** Conteos derivados para el resumen por dirección (reclasificado). */
  const nCriticalByDir = useMemo(() => {
    const out: Record<"X" | "Y", number> = { X: 0, Y: 0 };
    for (const h of hinges) {
      // Sólo cuenta críticos (≥ LS) de la dirección activa; el summary original
      // trae pre-calculado el de la otra, lo dejamos como viene.
      if (h.damage_level === "ls" || h.damage_level === "cp" || h.damage_level === "collapse") {
        out[defDir]++;
      }
    }
    return out;
  }, [hinges, defDir]);

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
      {/* Launcher sólo visible cuando el padre no inyecta uno unificado */}
      {!hideLauncher && (
        <NLFramePushoverLauncher
          projectId={projectId}
          onCompleted={() => fetchResult()}
        />
      )}

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
              const dirDetail = dir === "X" ? result.pushover_X : result.pushover_Y;
              return (
                <div key={dir} className="pl-glass rounded-xl p-4 flex flex-col gap-2">
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
                    <span className="text-right font-mono">
                      {dir === defDir && history
                        ? nCriticalByDir[dir]
                        : (s.n_critical_hinges ?? 0)}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-[var(--surface-2)] overflow-hidden">
                    <div className="h-full rounded-full"
                         style={{ width: `${pct}%`, background: col }} />
                  </div>
                  {dirDetail?.health && <AnalysisHealthBanner health={dirDetail.health} projectId={projectId} />}
                </div>
              );
            })}
          </div>

          {/* Curvas pushover */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h3 className="text-sm font-semibold uppercase tracking-wider">Curvas Pushover</h3>
            <div className="flex items-center gap-3 flex-wrap">
              <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)] cursor-pointer select-none">
                <input type="checkbox"
                       checked={showDamageOverlay}
                       onChange={e => setShowDamageOverlay(e.target.checked)}
                       className="accent-[var(--accent)] w-3.5 h-3.5" />
                <span>Pintar estados de daño</span>
              </label>
              <VbUnitToggle
                value={vbUnit}
                onChange={setVbUnit}
                wAvailable={W_kN !== null && W_kN > 0}
                wKN={W_kN}
              />
            </div>
          </div>
          {/* Advertencia visual si hay elementos colapsados */}
          {firstCollapseInfo.nCollapsed > 0 && (
            <div className="rounded-lg border-l-4 border-red-600 bg-red-50 p-3 flex gap-3 items-start">
              <span className="text-xl">⚠</span>
              <div className="flex-1 text-xs text-red-900">
                <p className="font-semibold mb-1">
                  Modelo con elementos en colapso — interpretar derivas con cautela
                </p>
                <p>
                  Este pushover alcanzó estados <b>más allá del colapso realista</b>:{" "}
                  <b>{firstCollapseInfo.nCollapsed} rótulas</b> de{" "}
                  <b>{firstCollapseInfo.nTotal}</b> superaron 1.5·θ_CP (nivel ASCE 41 "collapse").
                  {firstCollapseInfo.drift !== null && (
                    <> El <b>primer colapso ocurrió a drift ≈ {firstCollapseInfo.drift.toFixed(3)}%</b> —
                    los puntos de la curva pushover más allá de esa deriva son solo
                    convergencia numérica, no capacidad real del edificio.</>
                  )}
                </p>
                <p className="mt-1 text-red-700">
                  Materiales con <code className="bg-red-100 px-1 rounded">MinMax wrapper</code> activos:
                  Concrete02 crush en 1.2·εcu, Steel02 fractura en ±εsu. Nuevos pushovers tras
                  este cambio reflejarán el colapso con pérdida real de convergencia.
                </p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {result.pushover_X && (
              <PushoverChart dir="X" data={result.pushover_X}
                             color="#3b82f6" vbUnit={vbUnit} wKN={W_kN}
                             currentStep={defDir === "X"
                                            ? stepForFrame(result.pushover_X.steps?.length ?? 0)
                                            : null}
                             playing={defDir === "X" && playing}
                             firstCollapseStep={defDir === "X" && firstCollapseInfo.step !== null
                                                  ? stepForFrameFromCurve(result.pushover_X.steps?.length ?? 0,
                                                                           firstCollapseInfo.step)
                                                  : null}
                             events={result.pushover_X.events ?? null}
                             showDamageOverlay={showDamageOverlay} />
            )}
            {result.pushover_Y && (
              <PushoverChart dir="Y" data={result.pushover_Y}
                             color="#22c55e" vbUnit={vbUnit} wKN={W_kN}
                             currentStep={defDir === "Y"
                                            ? stepForFrame(result.pushover_Y.steps?.length ?? 0)
                                            : null}
                             playing={defDir === "Y" && playing}
                             firstCollapseStep={defDir === "Y" && firstCollapseInfo.step !== null
                                                  ? stepForFrameFromCurve(result.pushover_Y.steps?.length ?? 0,
                                                                           firstCollapseInfo.step)
                                                  : null}
                             events={result.pushover_Y.events ?? null}
                             showDamageOverlay={showDamageOverlay} />
            )}
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
            <div className="grid grid-cols-1 xl:grid-cols-[1fr_minmax(0,360px)] gap-4">
              <FrameDeformedShape3D
                projectId={projectId}
                direction={defDir}
                height={520}
                onSelectHinge={handleSelectHinge}
                selectedFid={selected?.fid ?? null}
                thresholds={thresholds}
                onDataLoaded={setHistory}
                onFrameChange={handleFrameChange}
              />
              {history && history.frames.length > 0 && (
                <DriftProfileChart
                  data={history}
                  frameIdx={Math.min(frameIdx, history.frames.length - 1)}
                  direction={defDir}
                  height={520}
                />
              )}
            </div>
            <p className="text-[10px] text-[var(--text-muted)] italic">
              Click en cualquier rótula del 3D o en la tabla inferior para ver
              su curva local y detalles. Las rótulas aparecen progresivamente
              conforme cada extremo cruza su umbral IO en cada frame. El perfil
              de la derecha se actualiza en vivo con el frame actual, y el paso
              se marca en la curva pushover arriba.
            </p>
          </div>

          {/* Estado global del edificio: 3 criterios de colapso global */}
          {(() => {
            const dr = defDir === "X" ? result.pushover_X : result.pushover_Y;
            if (!dr) return null;
            return <GlobalStatusPanel data={dr} direction={defDir} />;
          })()}

          {/* Panel de umbrales ASCE 41 ajustables */}
          <HingeThresholdsPanel
            value={thresholds}
            onChange={setThresholds}
            hinges={hinges}
          />

          {/* Eventos locales (Bloque B) — entre umbrales y punto de desempeño */}
          {(() => {
            const dir = defDir;
            const dr  = dir === "X" ? result.pushover_X : result.pushover_Y;
            if (!dr) return null;
            const merged: LocalEventsPayload | null =
              dr.events ?? null;
            const steps = dr.steps ?? [];
            const stepToDrift = (step: number) =>
              (step >= 0 && step < steps.length) ? steps[step].drift_pct : null;
            return (
              <LocalEventsPanel
                events={merged}
                context="pushover"
                stepToDrift={stepToDrift}
              />
            );
          })()}

          {/* Plan de reparación (Bloque C) — entre eventos y punto de desempeño */}
          {(() => {
            const evX = result.pushover_X?.events?.events ?? [];
            const evY = result.pushover_Y?.events?.events ?? [];
            const allEvents: LocalEvent[] = [...evX, ...evY];
            const elementLines =
              result.pushover_X?.element_lines ??
              result.pushover_Y?.element_lines ?? [];
            return (
              <RepairPlanPanel
                events={allEvents}
                demand={demand}
                elementLines={elementLines}
              />
            );
          })()}

          {/* Punto de desempeño N2 */}
          <N2PerformancePanel projectId={projectId} direction={defDir} />

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
  dir, data, color, vbUnit = "kN", wKN, currentStep = null, playing = false,
  firstCollapseStep = null, events = null, showDamageOverlay = true,
}: {
  dir: string;
  data: { steps: Array<{ drift_pct: number; base_shear_kN: number }>; summary?: Record<string, number>; converged_steps: number };
  color: string;
  vbUnit?: VbUnit;
  wKN?:    number | null;
  /** Índice del frame actual en la deformada — marca un punto en la curva.
   *  null = sin marcador (vista estática). */
  currentStep?: number | null;
  /** Si se está reproduciendo el pushover (anima la deformada).
   *  Si se pausa, el marcador se queda fijo (pin). */
  playing?: boolean;
  /** Paso donde ocurre el primer colapso de un elemento. Se marca con línea
   *  vertical punteada para advertir al usuario del límite realista. */
  firstCollapseStep?: number | null;
  /** Eventos locales — colorean la curva por el estado de daño dominante. */
  events?: LocalEventsPayload | null;
  /** Oculta los segmentos coloreados por estado de daño (curva limpia). */
  showDamageOverlay?: boolean;
}) {
  const divRef = useRef<HTMLDivElement>(null);
  const plotlyReady = usePlotly();

  useEffect(() => {
    if (!plotlyReady || !divRef.current || !data.steps || data.steps.length === 0) return;
    const Plotly = (window as unknown as { Plotly?: {
      newPlot: (...a: unknown[]) => void;
      react:   (...a: unknown[]) => void;
      purge:   (el: Element) => void;
    } }).Plotly;
    if (!Plotly) return;

    // Mostramos siempre |Vb| — convención estándar en pushover (SAP, ETABS,
    // OpenSees-Navigator). El engine guarda el valor signado para diagnóstico,
    // pero signos negativos al final de la curva son artefactos de MinMax
    // post-colapso cuando las reacciones residuales oscilan y no representan
    // la respuesta física real del edificio (verificado 2026-11-04).
    const vbFullKN = data.steps.map((s) => Math.abs(s.base_shear_kN));

    // Cortar la curva en el punto de colapso: Vb ≤ 25 % del pico durante 2
    // pasos consecutivos = 75 % de pérdida de resistencia. Mismo criterio
    // que el motor (Ola 4) — pero aplicado también sobre análisis previos
    // que se corrieron antes de la detección automática del motor.
    const COLLAPSE_FRAC  = 0.25;
    const COLLAPSE_STEPS = 2;
    const PEAK_MIN_KN    = 50;
    let cutIdx = data.steps.length;
    {
      let vbPeak = 0;
      let streak = 0;
      for (let i = 0; i < vbFullKN.length; i++) {
        if (vbFullKN[i] > vbPeak) vbPeak = vbFullKN[i];
        if (vbPeak > PEAK_MIN_KN) {
          if (vbFullKN[i] <= COLLAPSE_FRAC * vbPeak) {
            streak += 1;
            if (streak >= COLLAPSE_STEPS) { cutIdx = i + 1; break; }
          } else {
            streak = 0;
          }
        }
      }
    }
    const drifts   = data.steps.slice(0, cutIdx).map((s) => s.drift_pct);
    const shearsKN = vbFullKN.slice(0, cutIdx);
    const useRatio = vbUnit === "ratio" && wKN && wKN > 0;
    const y        = useRatio ? shearsKN.map((v) => v / (wKN as number)) : shearsKN;
    const yLabel   = useRatio ? "Vb / W" : "Cortante basal (kN)";
    const hover    = useRatio
      ? "Deriva: %{x:.3f}%<br>Vb/W: %{y:.3f}<extra></extra>"
      : "Deriva: %{x:.3f}%<br>Vb: %{y:.1f} kN<extra></extra>";

    type Trace = Record<string, unknown>;
    const traces: Trace[] = [];
    const shapes: Record<string, unknown>[] = [];
    const annotations: Record<string, unknown>[] = [];

    const hasEvents = showDamageOverlay && events &&
                      events.status === "success" && events.events.length > 0;
    const trimmedByCollapse = cutIdx < data.steps.length;

    // Curva base — línea gruesa con smoothing ligero, área debajo semi-transparente
    traces.push({
      x: drifts, y,
      type: "scatter", mode: "lines",
      line: { color, width: 2.5, shape: "spline", smoothing: 0.4 },
      fill: "tozeroy",
      fillcolor: `${color}14`,   // ~8% opacidad del color de la dirección
      hovertemplate: hover,
      name: `Pushover ${dir}`,
      showlegend: false,
    });

    // Marcador de corte por colapso del edificio (si aplica).
    if (trimmedByCollapse && drifts.length > 0) {
      const xC = drifts[drifts.length - 1];
      const yC = y[y.length - 1];
      traces.push({
        x: [xC], y: [yC],
        type: "scatter", mode: "markers+text",
        marker: { size: 14, color: "#991b1b", symbol: "x-thin",
                   line: { color: "#991b1b", width: 3 } },
        text: ["Colapso"], textposition: "top center",
        textfont: { size: 10, color: "#991b1b", weight: 600 },
        hovertemplate:
          `<b>Colapso del edificio</b>` +
          `<br>Vb cayó al 25 % del pico (75 % de pérdida)` +
          `<br>Deriva: ${xC.toFixed(3)}%<extra></extra>`,
        name: "Colapso",
        showlegend: false,
      });
    }

    // Marcadores de estados de daño globales — primer paso en que ANY
    // elemento alcanza cada tipo de evento. Un marcador por estado.
    if (hasEvents) {
      type MarkerCfg = {
        type: string; label: string; color: string; symbol: string;
      };
      // Orden de severidad creciente (en la gráfica aparecerán en orden
      // natural de drift ya que son monotónicos acumulativos).
      const markerCfgs: MarkerCfg[] = [
        { type: "first_yield_bar", label: "Fluencia del acero",
          color: EVENT_STYLE.first_yield_bar.color, symbol: "circle" },
        { type: "cover_crush",     label: "Spalling del recubrimiento",
          color: EVENT_STYLE.cover_crush.color,     symbol: "square" },
        { type: "core_crush",      label: "Aplastamiento del núcleo",
          color: EVENT_STYLE.core_crush.color,      symbol: "diamond" },
        { type: "bar_buckling",    label: "Pandeo del refuerzo",
          color: EVENT_STYLE.bar_buckling.color,    symbol: "hexagon" },
        { type: "bar_fracture",    label: "Fractura del refuerzo",
          color: EVENT_STYLE.bar_fracture.color,    symbol: "x" },
      ];

      // Primer paso donde ocurre cada tipo (mínimo sobre todos los elementos)
      const firstStepByType: Record<string, number> = {};
      for (const ev of events!.events) {
        const prev = firstStepByType[ev.type];
        if (prev === undefined || ev.step < prev) {
          firstStepByType[ev.type] = ev.step;
        }
      }
      // Conteo total por tipo (hover-info en el marcador)
      const countByType: Record<string, number> = {};
      for (const ev of events!.events) {
        countByType[ev.type] = (countByType[ev.type] ?? 0) + 1;
      }

      for (const cfg of markerCfgs) {
        const step = firstStepByType[cfg.type];
        if (step === undefined || step < 0 || step >= drifts.length) continue;
        const xM = drifts[step];
        const yM = y[step];
        const n  = countByType[cfg.type] ?? 1;
        traces.push({
          x: [xM], y: [yM],
          type: "scatter", mode: "markers",
          marker: {
            size: 14, color: cfg.color, symbol: cfg.symbol,
            line: { color: "white", width: 2 },
          },
          hovertemplate:
            `<b>${cfg.label}</b><br>Primera ocurrencia: paso ${step}` +
            `<br>Deriva: ${xM.toFixed(3)}%<br>Vb: %{y:.1f}` +
            (useRatio ? "" : " kN") +
            `<br>Total elementos afectados: ${n}<extra></extra>`,
          name: cfg.label,
          legendgroup: `state-${cfg.type}`,
          showlegend: true,
        });
      }
    }

    // Primer post-CP: marcador triangular (nivel ASCE 41 por rotación —
    // indicador LOCAL, no colapso del edificio).
    if (showDamageOverlay && firstCollapseStep !== null &&
        firstCollapseStep >= 0 && firstCollapseStep < drifts.length) {
      const xFC = drifts[firstCollapseStep];
      const yFC = y[firstCollapseStep];
      traces.push({
        x: [xFC], y: [yFC],
        type: "scatter", mode: "markers",
        marker: { size: 14, color: "#b91c1c", symbol: "triangle-down",
                   line: { color: "white", width: 2 } },
        hovertemplate:
          `<b>Primera rótula Post-CP (ASCE 41)</b>` +
          `<br>Indicador LOCAL (θ_p ≥ 1.5·θ_CP), no colapso del edificio` +
          `<br>Paso ${firstCollapseStep} · Deriva: ${xFC.toFixed(3)}%<extra></extra>`,
        name: "1ª rótula Post-CP",
        legendgroup: "post-cp-local",
        showlegend: true,
      });
    }

    // Caída de Vb post-pico: cuando Vb/Vb_pico < 0.80 (criterio GLOBAL de
    // colapso ATC-40 / FEMA 356). Dos marcadores: pico y punto de caída.
    // Usamos los arrays ya cortados en el punto de colapso para que todos los
    // índices apunten a valores válidos.
    if (showDamageOverlay && shearsKN.length > 0) {
      let peakIdx = 0;
      for (let i = 1; i < shearsKN.length; i++) {
        if (shearsKN[i] > shearsKN[peakIdx]) peakIdx = i;
      }
      let dropIdx = -1;
      const vbPeak = shearsKN[peakIdx];
      if (vbPeak > 0) {
        for (let i = peakIdx + 1; i < shearsKN.length; i++) {
          if (shearsKN[i] / vbPeak < VB_DROP_THRESHOLD) { dropIdx = i; break; }
        }
      }
      if (dropIdx > 0) {
        traces.push({
          x: [drifts[dropIdx]], y: [y[dropIdx]],
          type: "scatter", mode: "markers",
          marker: { size: 16, color: "#dc2626", symbol: "star",
                     line: { color: "white", width: 2 } },
          hovertemplate:
            `<b>Caída de Vb &gt; 20 % post-pico</b>` +
            `<br>Criterio GLOBAL de colapso (ATC-40)` +
            `<br>Vb/Vb_pico = ${(shearsKN[dropIdx] / vbPeak).toFixed(2)}` +
            `<br>Paso ${dropIdx} · Deriva: ${drifts[dropIdx].toFixed(3)}%<extra></extra>`,
          name: "Caída Vb (colapso global)",
          legendgroup: "vb-drop",
          showlegend: true,
        });
      }
    }

    if (currentStep !== null && drifts.length > 0) {
      const idx = Math.min(Math.max(currentStep, 0), drifts.length - 1);
      const xCur = drifts[idx];
      const yCur = y[idx];
      traces.push({
        x: [xCur], y: [yCur],
        type: "scatter", mode: "markers",
        marker: {
          size: 14,
          color: playing ? "#f97316" : "#ef4444",   // naranja mientras anima, rojo cuando pausa
          symbol: playing ? "circle" : "star",
          line:   { color: "#1e293b", width: 1.5 },
        },
        hovertemplate: useRatio
          ? "Paso actual<br>Deriva: %{x:.3f}%<br>Vb/W: %{y:.3f}<extra></extra>"
          : "Paso actual<br>Deriva: %{x:.3f}%<br>Vb: %{y:.1f} kN<extra></extra>",
        name: playing ? "Paso en reproducción" : "Paso pausado (pin)",
        showlegend: false,
      });
      // Línea vertical de guía
      shapes.push({
        type: "line",
        x0: xCur, x1: xCur, y0: 0, y1: Math.max(...y) * 1.05,
        line: { color: playing ? "#f97316" : "#ef4444",
                 width: 1, dash: "dot" },
      });
      annotations.push({
        x: xCur, y: Math.max(...y) * 1.05,
        xanchor: "left", yanchor: "top",
        text: `${xCur.toFixed(3)}%`,
        font: { size: 10, color: playing ? "#c2410c" : "#b91c1c" },
        showarrow: false,
      });
    }

    const baseLayout = plotlyLayoutPremium({
      xTitle: "Deriva de techo (%)",
      yTitle: yLabel,
      showLegend: !!hasEvents,
      legendTop: false,
    });
    Plotly.react(
      divRef.current,
      traces,
      { ...baseLayout, shapes, annotations },
      { ...plotlyConfigPremium, displayModeBar: false },
    );

    return () => { if (divRef.current) Plotly.purge(divRef.current); };
  }, [plotlyReady, data, color, vbUnit, wKN, currentStep, playing, firstCollapseStep, events, showDamageOverlay]);

  return (
    <div className="pl-glass rounded-xl p-4">
      <p className="text-xs font-semibold text-[var(--text-muted)] mb-3 uppercase tracking-wider">
        Curva Pushover — Dir {dir}
      </p>
      {data.steps && data.steps.length > 0 ? (
        <div ref={divRef} style={{ height: showDamageOverlay ? 320 : 260 }} />
      ) : (
        <div className="flex items-center justify-center h-[260px] text-xs text-[var(--text-muted)]">
          Sin pasos convergidos
        </div>
      )}
      <p className="text-[10px] text-[var(--text-muted)] mt-2 text-center">
        {data.converged_steps} pasos ·
        {" "}deriva máx {(data.summary?.max_drift_pct ?? 0).toFixed(3)}% ·
        {" "}Vb máx {(data.summary?.max_base_shear_kN ?? 0).toFixed(1)} kN
        {vbUnit === "ratio" && wKN && wKN > 0 && (
          <> · Vb/W máx {((data.summary?.max_base_shear_kN ?? 0) / wKN).toFixed(3)}</>
        )}
      </p>
    </div>
  );
}

function VbUnitToggle({
  value, onChange, wAvailable, wKN,
}: {
  value:      VbUnit;
  onChange:   (v: VbUnit) => void;
  wAvailable: boolean;
  wKN:        number | null;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">
        {wAvailable && wKN ? `W = ${wKN.toFixed(0)} kN` : "W no disponible"}
      </span>
      <div className="inline-flex rounded-md border border-[var(--border)] overflow-hidden text-[11px] font-medium">
        {(["kN", "ratio"] as const).map((u) => {
          const disabled = u === "ratio" && !wAvailable;
          return (
            <button
              key={u}
              onClick={() => !disabled && onChange(u)}
              disabled={disabled}
              className={`px-2 py-1 transition-colors ${
                value === u
                  ? "bg-[var(--accent)] text-white"
                  : "bg-[var(--surface-2)] text-[var(--text-muted)] hover:text-[var(--text)]"
              } ${disabled ? "opacity-40 cursor-not-allowed" : ""}`}
              title={
                disabled
                  ? "Requiere masas definidas en el canonical. Valida el modelo primero."
                  : u === "ratio" ? "Normalizar por peso del edificio" : "Mostrar en kN"
              }
            >
              {u === "kN" ? "kN" : "Vb/W"}
            </button>
          );
        })}
      </div>
    </div>
  );
}
