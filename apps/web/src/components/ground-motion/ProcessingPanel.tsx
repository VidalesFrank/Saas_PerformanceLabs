'use client'

import { useEffect, useRef, useState } from 'react'
import { ProcessResult } from '@/lib/ground-motion-types'
import { processSignal } from '@/lib/ground-motion-api'
import { GM_PALETTE, baseLayout, gmPlotConfig, useGmTheme } from '@/lib/gm-plotly-theme'
import { ChartCard, ErrorBanner, FooterNote, KpiCard, Section, SectionHeader } from './_visual'

declare const window: Window & { Plotly: any }

interface Props {
  recordId: string
  component?: string
  onProcessed?: (result: ProcessResult) => void
}

const G = 9.80665

const BL_METHODS = [
  { v: 'mean',       label: 'Remover media',   desc: 'a_corr(t) = a(t) − media(a). Elimina el offset constante.' },
  { v: 'linear',     label: 'Tendencia lineal', desc: 'Ajusta a(t) = A + B·t y lo sustrae. Elimina tendencia lineal.' },
  { v: 'polynomial', label: 'Polinomial',       desc: (n: number) => `Ajusta un polinomio de grado ${n} y lo sustrae. Elimina tendencias curvas.` },
] as const

export default function ProcessingPanel({ recordId, component = '', onProcessed }: Props) {
  const chartRef = useRef<HTMLDivElement>(null)
  const diffRef  = useRef<HTMLDivElement>(null)

  const [mode, setMode]             = useState<'baseline' | 'filter'>('baseline')
  const [blMethod, setBlMethod]     = useState('linear')
  const [polyOrder, setPolyOrder]   = useState(2)
  const [filterType, setFilterType] = useState('bandpass')
  const [fcLow, setFcLow]           = useState('0.1')
  const [fcHigh, setFcHigh]         = useState('25')
  const [filterOrder, setFilterOrder] = useState(4)
  const [result, setResult]         = useState<ProcessResult | null>(null)
  const [isLoading, setIsLoading]   = useState(false)
  const [error, setError]           = useState<string | null>(null)
  const t = useGmTheme()

  const apply = async () => {
    setIsLoading(true); setError(null)
    try {
      const params: Record<string, unknown> = {
        operation: mode,
        component,
        baseline_method: blMethod,
        polynomial_order: polyOrder,
        filter_type: filterType,
        fc_low: fcLow ? parseFloat(fcLow) : null,
        fc_high: fcHigh ? parseFloat(fcHigh) : null,
        filter_order: filterOrder,
      }
      const res = await processSignal(recordId, params as Parameters<typeof processSignal>[1])
      setResult(res)
      onProcessed?.(res)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Error procesando señal.')
    } finally {
      setIsLoading(false)
    }
  }

  const reset = async () => {
    setIsLoading(true); setError(null)
    try {
      const res = await processSignal(recordId, { operation: 'reset', component })
      setResult(res)
      onProcessed?.(res)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Error.')
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    if (!result || !chartRef.current || typeof window === 'undefined' || !window.Plotly) return

    const time = result.t
    const aOrig = result.a_original_ms2.map(v => v / G)
    const aProc = result.a_ms2.map(v => v / G)
    const diff  = aOrig.map((v, i) => aProc[i] - v)

    const rangeAll = Math.max(
      ...aOrig.map(Math.abs), ...aProc.map(Math.abs),
    )

    // ── Comparación superpuesta ──
    window.Plotly.newPlot(chartRef.current, [
      {
        x: time, y: aOrig,
        type: 'scatter', mode: 'lines',
        name: 'Original',
        line: { color: t.textMuted, width: 1.2, dash: 'dot' },
        opacity: 0.7,
        hovertemplate: 't = %{x:.3f} s<br>a = %{y:.4f} g<extra>Original</extra>',
      },
      {
        x: time, y: aProc,
        type: 'scatter', mode: 'lines',
        name: 'Procesada',
        line: { color: GM_PALETTE.acceleration, width: 1.6 },
        fill: 'tozeroy',
        fillcolor: GM_PALETTE.accelerationFill,
        hovertemplate: 't = %{x:.3f} s<br>a = %{y:.4f} g<extra>Procesada</extra>',
      },
    ], baseLayout(t, {
      margin: { l: 68, r: 28, t: 12, b: 46 },
      xaxis: {
        gridcolor: t.grid, zerolinecolor: t.zeroLine, linecolor: t.gridStrong,
        showgrid: true, zeroline: false, ticks: 'outside', ticklen: 4, tickcolor: t.gridStrong,
        tickfont: { size: 11, color: t.textMuted },
        title: { text: 'Tiempo (s)', font: { size: 12, color: t.text } },
      },
      yaxis: {
        gridcolor: t.grid, zerolinecolor: t.zeroLine, linecolor: t.gridStrong,
        showgrid: true, zeroline: true, ticks: 'outside', ticklen: 4, tickcolor: t.gridStrong,
        tickfont: { size: 11, color: t.textMuted },
        title: { text: 'Aceleración (g)', font: { size: 12, color: t.text } },
        range: [-rangeAll * 1.1, rangeAll * 1.1],
      },
      legend: {
        bgcolor: 'transparent',
        x: 0.98, xanchor: 'right', y: 0.98,
        font: { size: 11, color: t.text },
      },
    }), gmPlotConfig)

    // ── Diferencia (residuo removido) ──
    if (diffRef.current) {
      const diffMax = Math.max(...diff.map(Math.abs)) || 1
      window.Plotly.newPlot(diffRef.current, [
        {
          x: time, y: diff,
          type: 'scatter', mode: 'lines', fill: 'tozeroy',
          name: 'Δ = procesada − original',
          line: { color: GM_PALETTE.peak, width: 1.2 },
          fillcolor: 'rgba(239,68,68,0.08)',
          hovertemplate: 't = %{x:.3f} s<br>Δa = %{y:.4f} g<extra></extra>',
          showlegend: false,
        },
      ], baseLayout(t, {
        margin: { l: 68, r: 28, t: 12, b: 46 },
        xaxis: {
          gridcolor: t.grid, zerolinecolor: t.zeroLine, linecolor: t.gridStrong,
          showgrid: true, zeroline: false, ticks: 'outside', ticklen: 4, tickcolor: t.gridStrong,
          tickfont: { size: 11, color: t.textMuted },
          title: { text: 'Tiempo (s)', font: { size: 12, color: t.text } },
        },
        yaxis: {
          gridcolor: t.grid, zerolinecolor: t.zeroLine, linecolor: t.gridStrong,
          showgrid: true, zeroline: true, ticks: 'outside', ticklen: 4, tickcolor: t.gridStrong,
          tickfont: { size: 11, color: t.textMuted },
          title: { text: 'Δ aceleración (g)', font: { size: 12, color: t.text } },
          range: [-diffMax * 1.15, diffMax * 1.15],
        },
      }), gmPlotConfig)
    }
  }, [result, t.isDark])

  const opLabel = mode === 'baseline'
    ? `Línea base · ${BL_METHODS.find(m => m.v === blMethod)?.label}`
    : `Filtro Butterworth · ${filterType}`

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Procesamiento de Señal"
        subtitle="Corrección de línea base (media, lineal o polinómica) y filtrado digital Butterworth de fase cero (sosfiltfilt)."
        chip="Fase cero"
      />

      {/* Selector de modo — tarjetas grandes */}
      <div className="grid grid-cols-2 gap-3">
        <ModeCard
          active={mode === 'baseline'}
          onClick={() => setMode('baseline')}
          title="Corrección de Línea Base"
          desc="Elimina offset, tendencia lineal o curva del acelerograma."
          accent="#8b5cf6"
        />
        <ModeCard
          active={mode === 'filter'}
          onClick={() => setMode('filter')}
          title="Filtro Butterworth"
          desc="Paso bajo, paso alto, paso banda o rechazo de banda con fase cero."
          accent={GM_PALETTE.velocity}
        />
      </div>

      {/* Opciones de baseline */}
      {mode === 'baseline' && (
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl px-5 py-5 flex flex-col gap-4">
          <Section title="Método" hint="Selecciona la corrección a aplicar">
            <div className="flex gap-2 flex-wrap">
              {BL_METHODS.map(o => (
                <button
                  key={o.v} onClick={() => setBlMethod(o.v)}
                  className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all
                    ${blMethod === o.v
                      ? 'bg-[var(--accent)] text-white border border-[var(--accent)] shadow-sm'
                      : 'bg-[var(--surface-alt)] border border-[var(--border)] text-[var(--foreground)] hover:border-[var(--accent)]/40'}`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </Section>

          {blMethod === 'polynomial' && (
            <div>
              <label className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-[var(--muted)] block mb-1.5">
                Orden del polinomio
              </label>
              <input
                type="number" min={2} max={8} value={polyOrder}
                onChange={e => setPolyOrder(parseInt(e.target.value))}
                className="w-28 bg-[var(--surface-alt)] border border-[var(--border)] rounded-lg
                           px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
              />
            </div>
          )}

          <FormulaBox>
            {typeof BL_METHODS.find(m => m.v === blMethod)?.desc === 'function'
              ? (BL_METHODS.find(m => m.v === blMethod)!.desc as (n: number) => string)(polyOrder)
              : BL_METHODS.find(m => m.v === blMethod)?.desc as string}
          </FormulaBox>
        </div>
      )}

      {/* Opciones de filtro */}
      {mode === 'filter' && (
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl px-5 py-5 flex flex-col gap-4">
          <Section title="Parámetros del filtro" hint="Butterworth SOS fase cero">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div>
                <label className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-[var(--muted)] block mb-1.5">
                  Tipo
                </label>
                <select
                  value={filterType} onChange={e => setFilterType(e.target.value)}
                  className="w-full bg-[var(--surface-alt)] border border-[var(--border)] rounded-lg
                             px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
                >
                  <option value="lowpass">Paso bajo</option>
                  <option value="highpass">Paso alto</option>
                  <option value="bandpass">Paso banda</option>
                  <option value="bandstop">Rechazo banda</option>
                </select>
              </div>
              <div>
                <label className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-[var(--muted)] block mb-1.5">
                  Orden
                </label>
                <input
                  type="number" min={1} max={10} value={filterOrder}
                  onChange={e => setFilterOrder(parseInt(e.target.value))}
                  className="w-full bg-[var(--surface-alt)] border border-[var(--border)] rounded-lg
                             px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
                />
              </div>
              {filterType !== 'lowpass' && (
                <div>
                  <label className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-[var(--muted)] block mb-1.5">
                    f<sub>bajo</sub> (Hz)
                  </label>
                  <input
                    type="number" step="any" min="0" value={fcLow}
                    onChange={e => setFcLow(e.target.value)} placeholder="0.1"
                    className="w-full bg-[var(--surface-alt)] border border-[var(--border)] rounded-lg
                               px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
                  />
                </div>
              )}
              {filterType !== 'highpass' && (
                <div>
                  <label className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-[var(--muted)] block mb-1.5">
                    f<sub>alto</sub> (Hz)
                  </label>
                  <input
                    type="number" step="any" min="0" value={fcHigh}
                    onChange={e => setFcHigh(e.target.value)} placeholder="25"
                    className="w-full bg-[var(--surface-alt)] border border-[var(--border)] rounded-lg
                               px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
                  />
                </div>
              )}
            </div>
          </Section>

          <FormulaBox>
            Filtrado de fase cero (sosfiltfilt) — sin distorsión temporal.
            Orden efectivo = 2 × {filterOrder} = {filterOrder * 2} (paso directo + inverso).
          </FormulaBox>
        </div>
      )}

      {/* Botones de acción */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={apply} disabled={isLoading}
          className="px-6 py-2.5 bg-[var(--accent)] text-white rounded-lg text-sm font-semibold
                     disabled:opacity-50 hover:opacity-90 transition-opacity shadow-sm"
        >
          {isLoading ? 'Procesando…' : 'Aplicar ' + (mode === 'baseline' ? 'corrección' : 'filtro')}
        </button>
        {result && (
          <button
            onClick={reset} disabled={isLoading}
            className="px-4 py-2.5 bg-[var(--surface)] border border-[var(--border)] rounded-lg text-sm font-semibold
                       hover:bg-[var(--surface-alt)] transition-colors"
          >
            ↺ Restaurar original
          </button>
        )}
        {result && (
          <span className="ml-auto text-[11px] px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-500
                           border border-emerald-500/30 font-semibold">
            ✓ {opLabel}
          </span>
        )}
      </div>

      {error && <ErrorBanner message={error} />}

      {result && (
        <>
          {/* Reporte como KPIs */}
          {(() => {
            const numeric = Object.entries(result.report)
              .filter(([, v]) => typeof v === 'number') as [string, number][]
            if (numeric.length === 0) return null
            return (
              <Section title="Resumen del proceso" hint="Estadísticas comparativas">
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                  {numeric.map(([key, val]) => (
                    <KpiCard
                      key={key}
                      label={key.replace(/_/g, ' ')}
                      value={Math.abs(val) < 0.001 || Math.abs(val) > 1000
                        ? val.toExponential(3)
                        : val.toFixed(4)}
                      unit=""
                      accent={pickAccent(key)}
                    />
                  ))}
                </div>
              </Section>
            )
          })()}

          <ChartCard title="Comparación · Original vs Procesada" unitBadge="g"
                     accent={GM_PALETTE.acceleration}>
            <div ref={chartRef} style={{ height: 300 }} />
          </ChartCard>

          <ChartCard title="Residuo removido (Δ = procesada − original)" unitBadge="Δg"
                     accent={GM_PALETTE.peak}>
            <div ref={diffRef} style={{ height: 200 }} />
          </ChartCard>
        </>
      )}

      <FooterNote>
        <strong>Línea base:</strong> corrige tendencias no físicas de la aceleración.&nbsp;
        <strong>Butterworth:</strong> IIR con respuesta plana en banda de paso.&nbsp;
        La aplicación es acumulativa — puedes encadenar baseline + filtro. Usa <em>Restaurar</em> para volver al SI original.
      </FooterNote>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Componentes locales
// ─────────────────────────────────────────────────────────────────────────────

function ModeCard({
  active, onClick, title, desc, accent,
}: { active: boolean; onClick: () => void; title: string; desc: string; accent: string }) {
  return (
    <button
      onClick={onClick}
      className={`text-left rounded-2xl border-2 transition-all p-4
        ${active
          ? 'bg-[var(--surface)] shadow-sm'
          : 'bg-[var(--surface)] border-[var(--border)] opacity-70 hover:opacity-100'}`}
      style={active ? { borderColor: accent, boxShadow: `0 0 0 3px ${accent}22` } : {}}
    >
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 rounded-full" style={{ background: accent }} />
        <span className={`text-sm font-bold ${active ? '' : 'text-[var(--foreground)]'}`}
              style={active ? { color: accent } : {}}>
          {title}
        </span>
      </div>
      <p className="text-[12px] text-[var(--muted)] mt-1.5 leading-relaxed">{desc}</p>
    </button>
  )
}

function FormulaBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[12px] font-mono text-[var(--foreground)] bg-[var(--surface-alt)]
                    border border-[var(--border)] rounded-lg px-3.5 py-2.5 leading-relaxed">
      {children}
    </div>
  )
}

// Asigna color según naturaleza de la métrica del reporte.
function pickAccent(key: string): string {
  const k = key.toLowerCase()
  if (k.includes('rms'))               return GM_PALETTE.psd
  if (k.includes('pga') || k.includes('peak') || k.includes('max'))  return GM_PALETTE.acceleration
  if (k.includes('mean') || k.includes('bias')) return '#a855f7'
  if (k.includes('drift'))             return GM_PALETTE.peak
  if (k.includes('cutoff') || k.includes('freq')) return GM_PALETTE.fft
  return '#0891b2'
}
