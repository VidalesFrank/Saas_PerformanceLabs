"use client";

/**
 * Selector de registros FEMA P-695 Far-Field (22 pares × 2 componentes).
 *
 * Flujo:
 *   1. Al montar carga el catálogo con espectros precomputados.
 *   2. Tabla con filtros (magnitud, distancia, año).
 *   3. Al clic en un par: preview de ambos canales H1/H2 + espectro de
 *      respuesta con marcadores T1 del edificio + Sa objetivo.
 *   4. Panel de escalado con 3 modos: manual, Sa objetivo en T1, NSR-10.
 *   5. Botón "Usar este par" → llama al backend para copiar al workspace y
 *      devuelve uploadX/Y listos para lanzar NLTH.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { structuralAnalysisApi, femaLibraryApi } from "@/lib/structural-api";
import type {
  FEMALibraryCatalog, FEMAPair, FEMASelectResult, NLTHUploadResult,
} from "@/lib/structural-types";
import { usePlotly } from "@/lib/use-plotly";
import { plotlyLayoutPremium, plotlyConfigPremium } from "@/lib/plotly-theme";

type ScaleMode = "manual" | "sa_target" | "nsr10";

interface Props {
  projectId: string;
  T1_x?: number | null;             // T1 del modal del edificio (s)
  T1_y?: number | null;
  nsr10Available?: boolean;         // si hay spectral_results para modo nsr10
  onPairApplied: (
    uploadX: NLTHUploadResult, uploadY: NLTHUploadResult,
    scaleInfo: FEMASelectResult,
  ) => void;
}

export function FEMALibrarySelector({
  projectId, T1_x, T1_y, nsr10Available, onPairApplied,
}: Props) {
  const plotlyReady = usePlotly();
  const [catalog, setCatalog]       = useState<FEMALibraryCatalog | null>(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);
  const [selectedPair, setSelectedPair] = useState<number | null>(null);
  const [filterMw, setFilterMw]     = useState<number>(0);
  const [filterRrup, setFilterRrup] = useState<number>(100);
  const [applying, setApplying]     = useState(false);

  // Escalado
  const [scaleMode, setScaleMode]   = useState<ScaleMode>("manual");
  const [scaleManual, setScaleManual] = useState<number>(1.0);
  const T1   = T1_x ?? T1_y ?? 0;
  const [T1Input, setT1Input]       = useState<number>(T1);
  const [saTarget, setSaTarget]     = useState<number>(0.5);

  // Refs de plots
  const h1Ref       = useRef<HTMLDivElement>(null);
  const h2Ref       = useRef<HTMLDivElement>(null);
  const spectrumRef = useRef<HTMLDivElement>(null);

  // Preview timeseries del par seleccionado (se carga al seleccionar)
  const [previewH1, setPreviewH1] = useState<{ t: number[]; a: number[]; dt: number; pga: number } | null>(null);
  const [previewH2, setPreviewH2] = useState<{ t: number[]; a: number[]; dt: number; pga: number } | null>(null);

  // Cargar catálogo al montar
  useEffect(() => {
    let cancelled = false;
    femaLibraryApi.listPairs()
      .then((cat) => { if (!cancelled) setCatalog(cat); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Error cargando catálogo FEMA."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Actualizar T1 input cuando el prop cambie (al terminar un modal, por ejemplo)
  useEffect(() => { if (T1 > 0) setT1Input(T1); }, [T1]);

  // Al seleccionar un par, cargar previews
  useEffect(() => {
    if (!selectedPair || !catalog) return;
    const pair = catalog.pairs.find((p) => p.pair === selectedPair);
    if (!pair) return;
    const [gm1, gm2] = pair.files;
    let cancelled = false;
    Promise.all([
      femaLibraryApi.getRecordPreview(gm1),
      femaLibraryApi.getRecordPreview(gm2),
    ]).then(([p1, p2]) => {
      if (cancelled) return;
      setPreviewH1(p1); setPreviewH2(p2);
    }).catch(() => { /* silent */ });
    return () => { cancelled = true; };
  }, [selectedPair, catalog]);

  // Plots — H1
  useEffect(() => {
    if (!plotlyReady || !h1Ref.current || !previewH1) return;
    const Plotly = (window as unknown as { Plotly: { newPlot: (...a: unknown[]) => void; purge: (el: Element) => void } }).Plotly;
    const layout = plotlyLayoutPremium({ xTitle: "t (s)", yTitle: "a (g)" });
    Plotly.newPlot(h1Ref.current, [{
      x: previewH1.t, y: previewH1.a,
      type: "scatter", mode: "lines",
      line: { color: "#2563eb", width: 1.5 },
      hovertemplate: "t=%{x:.2f}s · a=%{y:.4f}g<extra></extra>",
    }], layout, { ...plotlyConfigPremium, displayModeBar: false });
    return () => { if (h1Ref.current) Plotly.purge(h1Ref.current); };
  }, [plotlyReady, previewH1]);

  // Plots — H2
  useEffect(() => {
    if (!plotlyReady || !h2Ref.current || !previewH2) return;
    const Plotly = (window as unknown as { Plotly: { newPlot: (...a: unknown[]) => void; purge: (el: Element) => void } }).Plotly;
    const layout = plotlyLayoutPremium({ xTitle: "t (s)", yTitle: "a (g)" });
    Plotly.newPlot(h2Ref.current, [{
      x: previewH2.t, y: previewH2.a,
      type: "scatter", mode: "lines",
      line: { color: "#16a34a", width: 1.5 },
      hovertemplate: "t=%{x:.2f}s · a=%{y:.4f}g<extra></extra>",
    }], layout, { ...plotlyConfigPremium, displayModeBar: false });
    return () => { if (h2Ref.current) Plotly.purge(h2Ref.current); };
  }, [plotlyReady, previewH2]);

  // Plot espectro del par seleccionado + línea vertical en T1
  const selectedPairData = useMemo(() => {
    if (!catalog || !selectedPair) return null;
    return catalog.pairs.find((p) => p.pair === selectedPair) ?? null;
  }, [catalog, selectedPair]);

  useEffect(() => {
    if (!plotlyReady || !spectrumRef.current) return;
    const Plotly = (window as unknown as { Plotly: { newPlot: (...a: unknown[]) => void; purge: (el: Element) => void } }).Plotly;
    if (!selectedPairData || !selectedPairData.spectra) {
      Plotly.purge(spectrumRef.current);
      return;
    }
    const s = selectedPairData.spectra;
    const [gm1, gm2] = selectedPairData.files;
    const traces: Record<string, unknown>[] = [
      { x: s.periods, y: s[gm1.toLowerCase()], type: "scatter", mode: "lines",
        line: { color: "#2563eb", width: 1.5, dash: "dot" }, name: `${gm1} (H1)` },
      { x: s.periods, y: s[gm2.toLowerCase()], type: "scatter", mode: "lines",
        line: { color: "#16a34a", width: 1.5, dash: "dot" }, name: `${gm2} (H2)` },
      { x: s.periods, y: s.geomean, type: "scatter", mode: "lines",
        line: { color: "#0e7fa8", width: 2.5 }, name: "Geomean √(H1·H2)" },
    ];
    const shapes: Record<string, unknown>[] = [];
    const annotations: Record<string, unknown>[] = [];
    if (T1Input > 0) {
      shapes.push({
        type: "line", x0: T1Input, x1: T1Input, yref: "paper", y0: 0, y1: 1,
        line: { color: "#dc2626", width: 1.5, dash: "dash" },
      });
      annotations.push({
        x: T1Input, yref: "paper", y: 0.98, xanchor: "left", yanchor: "top",
        text: `T₁ = ${T1Input.toFixed(3)} s`, showarrow: false,
        font: { size: 10, color: "#dc2626", weight: 600 },
        bgcolor: "rgba(255,255,255,0.85)", bordercolor: "#dc2626",
        borderwidth: 1, borderpad: 3, xshift: 4,
      });
    }
    const layout = {
      ...plotlyLayoutPremium({
        xTitle: "Periodo T (s)", yTitle: "Sa (g)",
        showLegend: true, legendTop: true,
      }),
      shapes, annotations,
    };
    Plotly.newPlot(spectrumRef.current, traces, layout, plotlyConfigPremium);
    return () => { if (spectrumRef.current) Plotly.purge(spectrumRef.current); };
  }, [plotlyReady, selectedPairData, T1Input]);

  // Filtro
  const filteredPairs = useMemo(() => {
    if (!catalog) return [];
    return catalog.pairs.filter((p) =>
      p.mw >= filterMw && p.rrup_km <= filterRrup,
    );
  }, [catalog, filterMw, filterRrup]);

  // Aplicar el par seleccionado al proyecto
  const applyPair = useCallback(async () => {
    if (!selectedPair) return;
    setApplying(true);
    setError(null);
    try {
      const body: Parameters<typeof structuralAnalysisApi.selectFEMAPair>[1] = {
        pair_id:    selectedPair,
        scale_mode: scaleMode,
      };
      if (scaleMode === "manual") {
        body.scale_manual = scaleManual;
      } else if (scaleMode === "sa_target") {
        if (!T1Input || T1Input <= 0) {
          throw new Error("T1 inválido para modo 'Sa objetivo'.");
        }
        body.T1_s        = T1Input;
        body.sa_target_g = saTarget;
      } else if (scaleMode === "nsr10") {
        if (T1Input > 0) body.T1_s = T1Input;
      }
      const res = await structuralAnalysisApi.selectFEMAPair(projectId, body);
      onPairApplied(res.upload_x, res.upload_y, res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error aplicando el par.");
    } finally {
      setApplying(false);
    }
  }, [selectedPair, scaleMode, scaleManual, T1Input, saTarget, projectId, onPairApplied]);

  if (loading) {
    return <div className="text-sm text-[var(--text-muted)]">Cargando catálogo FEMA P-695…</div>;
  }
  if (error && !catalog) {
    return <div className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800">{error}</div>;
  }
  if (!catalog) return null;

  if (!catalog.available) {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        La biblioteca FEMA P-695 no está disponible en el servidor
        (archivos GM01…GM44 no presentes). Contacta al administrador.
      </div>
    );
  }

  const applyDisabled = !selectedPair || applying
    || (scaleMode === "sa_target" && (!T1Input || T1Input <= 0 || saTarget <= 0))
    || (scaleMode === "nsr10"     && !nsr10Available);

  return (
    <div className="space-y-4">
      {/* Filtros */}
      <div className="flex flex-wrap gap-3 items-end">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
            Mw mínimo
          </span>
          <input type="number" step="0.1" min={0} value={filterMw}
            onChange={(e) => setFilterMw(Number(e.target.value))}
            className="w-24 px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-2)] text-sm font-mono" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
            Rrup máximo (km)
          </span>
          <input type="number" step="1" min={0} value={filterRrup}
            onChange={(e) => setFilterRrup(Number(e.target.value))}
            className="w-24 px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-2)] text-sm font-mono" />
        </label>
        <span className="text-xs text-[var(--text-muted)] ml-auto">
          {filteredPairs.length} / 22 pares
        </span>
      </div>

      {/* Tabla */}
      <div className="pl-glass rounded-xl overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-2)_60%,transparent)]">
              <th className="px-2 py-1.5 text-left font-semibold">#</th>
              <th className="px-2 py-1.5 text-left font-semibold">Sismo</th>
              <th className="px-2 py-1.5 text-right font-semibold">Año</th>
              <th className="px-2 py-1.5 text-right font-semibold">Mw</th>
              <th className="px-2 py-1.5 text-left font-semibold">Estación</th>
              <th className="px-2 py-1.5 text-right font-semibold">R_rup (km)</th>
              <th className="px-2 py-1.5 text-right font-semibold">PGA H1 (g)</th>
              <th className="px-2 py-1.5 text-right font-semibold">PGA H2 (g)</th>
              <th className="px-2 py-1.5 text-right font-semibold">Dur. (s)</th>
            </tr>
          </thead>
          <tbody>
            {filteredPairs.map((p) => {
              const active = p.pair === selectedPair;
              return (
                <tr key={p.pair}
                    onClick={() => setSelectedPair(p.pair)}
                    className={`cursor-pointer transition-colors ${
                      active
                        ? "bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent)] font-medium"
                        : "hover:bg-[color-mix(in_srgb,var(--surface-2)_70%,transparent)]"
                    }`}>
                  <td className="px-2 py-1 font-mono">{p.pair}</td>
                  <td className="px-2 py-1">{p.earthquake}</td>
                  <td className="px-2 py-1 text-right font-mono">{p.year}</td>
                  <td className="px-2 py-1 text-right font-mono">{p.mw}</td>
                  <td className="px-2 py-1 truncate max-w-[180px]" title={p.station}>{p.station}</td>
                  <td className="px-2 py-1 text-right font-mono">{p.rrup_km.toFixed(1)}</td>
                  <td className="px-2 py-1 text-right font-mono">
                    {p.pga[0]?.toFixed(3) ?? "—"}
                  </td>
                  <td className="px-2 py-1 text-right font-mono">
                    {p.pga[1]?.toFixed(3) ?? "—"}
                  </td>
                  <td className="px-2 py-1 text-right font-mono">
                    {p.duration_s[0]?.toFixed(0) ?? "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Preview + espectro del par seleccionado */}
      {selectedPairData && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="pl-glass rounded-xl p-3">
              <p className="text-xs font-semibold text-[var(--text-muted)] mb-1 uppercase tracking-wider">
                {selectedPairData.files[0]} (H1 → X)
              </p>
              <div ref={h1Ref} style={{ height: 160 }} className="rounded" />
            </div>
            <div className="pl-glass rounded-xl p-3">
              <p className="text-xs font-semibold text-[var(--text-muted)] mb-1 uppercase tracking-wider">
                {selectedPairData.files[1]} (H2 → Y)
              </p>
              <div ref={h2Ref} style={{ height: 160 }} className="rounded" />
            </div>
          </div>

          <div className="pl-glass rounded-xl p-3">
            <p className="text-xs font-semibold text-[var(--text-muted)] mb-1 uppercase tracking-wider">
              Espectro de respuesta Sa(T) · 5 % ξ · media geométrica FEMA P-695
            </p>
            <div ref={spectrumRef} style={{ height: 220 }} className="rounded" />
          </div>
        </>
      )}

      {/* Escalado */}
      <div className="pl-glass rounded-xl p-4 space-y-3">
        <p className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
          Escalado del par
        </p>
        <div className="flex gap-1 flex-wrap">
          <ScaleModeButton value="manual"    label="Factor manual"
            active={scaleMode === "manual"}   onClick={() => setScaleMode("manual")} />
          <ScaleModeButton value="sa_target" label="A Sa objetivo en T₁"
            active={scaleMode === "sa_target"} onClick={() => setScaleMode("sa_target")} />
          <ScaleModeButton value="nsr10"     label="Al espectro NSR-10"
            active={scaleMode === "nsr10"}    onClick={() => setScaleMode("nsr10")}
            disabled={!nsr10Available}
            title={!nsr10Available ? "Requiere análisis espectral previo" : undefined} />
        </div>

        {scaleMode === "manual" && (
          <div className="flex items-end gap-3 flex-wrap">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                Factor de escala
              </span>
              <input type="number" step="0.1" min={0.1} max={10} value={scaleManual}
                onChange={(e) => setScaleManual(Number(e.target.value))}
                className="w-28 px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-2)] text-sm font-mono" />
            </label>
            <span className="text-[11px] text-[var(--text-muted)]">
              Las aceleraciones del registro se multiplican por este factor antes de aplicarlas al edificio.
            </span>
          </div>
        )}

        {scaleMode === "sa_target" && (
          <div className="flex items-end gap-3 flex-wrap">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                T₁ edificio (s)
              </span>
              <input type="number" step="0.01" min={0.01} value={T1Input || ""}
                onChange={(e) => setT1Input(Number(e.target.value))}
                className="w-24 px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-2)] text-sm font-mono" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                Sa objetivo (g)
              </span>
              <input type="number" step="0.05" min={0.01} value={saTarget}
                onChange={(e) => setSaTarget(Number(e.target.value))}
                className="w-24 px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-2)] text-sm font-mono" />
            </label>
            {selectedPairData?.spectra && (
              <span className="text-[11px] text-[var(--text-muted)]">
                Backend calculará: <span className="font-mono">scale = {saTarget.toFixed(3)} g / Sa_geomean(T₁)</span>
              </span>
            )}
          </div>
        )}

        {scaleMode === "nsr10" && (
          <div className="text-[11px] text-[var(--text-muted)]">
            {nsr10Available
              ? <>Se usará el espectro NSR-10 del proyecto. Sa objetivo = Sa_NSR10(T₁ = {T1Input.toFixed(3)} s).</>
              : <span className="text-amber-700">Corre el análisis espectral del proyecto antes para habilitar este modo.</span>}
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800">{error}</div>
      )}

      <div className="flex justify-end">
        <button
          onClick={applyPair}
          disabled={applyDisabled}
          className="px-4 py-2 rounded-md text-sm font-semibold bg-[var(--accent)] text-white disabled:opacity-40 hover:opacity-90 transition-opacity"
        >
          {applying ? "Aplicando…"
            : selectedPair ? `Usar par ${selectedPair} en el proyecto`
            : "Selecciona un par"}
        </button>
      </div>
    </div>
  );
}

function ScaleModeButton({
  label, active, onClick, disabled, title,
}: {
  value: ScaleMode; label: string; active: boolean;
  onClick: () => void; disabled?: boolean; title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
        active
          ? "bg-[var(--accent)] text-white border-[var(--accent)]"
          : "bg-[var(--surface-2)] text-[var(--text-muted)] border-[var(--border)] hover:bg-[var(--surface)] hover:text-[var(--text)]"
      } disabled:opacity-40 disabled:cursor-not-allowed`}
    >
      {label}
    </button>
  );
}
