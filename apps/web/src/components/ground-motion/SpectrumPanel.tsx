'use client'

import { useEffect, useRef, useState } from 'react'
import { SpectrumMultiXiResult } from '@/lib/ground-motion-types'
import { computeSpectrum, exportSpectrum, spectrumAtPeriod, triggerDownload } from '@/lib/ground-motion-api'
import { GM_PALETTE, baseLayout, gmPlotConfig, useGmTheme } from '@/lib/gm-plotly-theme'
import { AccuracyBanner, ChartCard, EmptyState, ErrorBanner, FooterNote, SectionHeader, SegmentedControl } from './_visual'

declare const window: Window & { Plotly: any }

interface Props {
  recordId: string
  component?: string
  dt?: number   // Δt del registro (s) — para calcular ratio Δt/T y advertir en T cortos
}

type SpecTab = 'PSA' | 'Sd' | 'PSV' | 'Sa' | 'Sv'
const TABS: { id: SpecTab; label: string; desc: string }[] = [
  { id: 'PSA', label: 'PSA', desc: 'Pseudo-aceleración' },
  { id: 'Sa',  label: 'Sa',  desc: 'Aceleración real' },
  { id: 'Sd',  label: 'Sd',  desc: 'Desplazamiento' },
  { id: 'PSV', label: 'PSV', desc: 'Pseudo-velocidad' },
  { id: 'Sv',  label: 'Sv',  desc: 'Velocidad real' },
]

const XI_LABELS: Record<string, string> = {
  '0.0200': 'ξ = 2%',
  '0.0500': 'ξ = 5%',
  '0.1000': 'ξ = 10%',
  '0.2000': 'ξ = 20%',
}

const G = 9.80665

export default function SpectrumPanel({ recordId, component = '', dt }: Props) {
  const chartRef  = useRef<HTMLDivElement>(null)
  const [tab, setTab]             = useState<SpecTab>('PSA')
  const [result, setResult]       = useState<SpectrumMultiXiResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError]         = useState<string | null>(null)
  const [Tinspect, setTinspect]   = useState('1.0')
  const [inspectData, setInspect] = useState<Record<string, number> | null>(null)
  const [scale, setScale]         = useState<'linear' | 'log'>('log')
  const [exportingFmt, setExportingFmt] = useState<'xlsx' | 'txt' | null>(null)
  const [TMin, setTMin]           = useState<string>(() => {
    // Default a max(0.01, 20·Δt) para respetar dt/T ≤ 0.05
    if (dt && dt > 0) return Math.max(0.01, 20 * dt).toFixed(3)
    return '0.01'
  })
  const [TMax, setTMax]           = useState('4.0')
  const [nPoints, setNPoints]     = useState('150')
  const t = useGmTheme()

  const tMinNum = parseFloat(TMin) || 0.01
  const tMaxNum = parseFloat(TMax) || 4.0

  const compute = async () => {
    setIsLoading(true); setError(null)
    try {
      const res = await computeSpectrum(recordId, {
        component,
        xi_list: [0.02, 0.05, 0.10, 0.20],
        T_min: tMinNum,
        T_max: tMaxNum,
        n_points: parseInt(nPoints) || 150,
        multi_xi: true,
      }) as SpectrumMultiXiResult
      setResult(res)
      setInspect(null)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Error calculando espectro.')
    } finally {
      setIsLoading(false)
    }
  }

  const exportFile = async (fmt: 'xlsx' | 'txt') => {
    setExportingFmt(fmt); setError(null)
    try {
      const { blob, filename } = await exportSpectrum(recordId, {
        component,
        xi_list: [0.02, 0.05, 0.10, 0.20],
        T_min: tMinNum,
        T_max: tMaxNum,
        n_points: parseInt(nPoints) || 150,
      }, fmt)
      triggerDownload(blob, filename)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : `Error exportando ${fmt.toUpperCase()}.`)
    } finally {
      setExportingFmt(null)
    }
  }

  const inspectT = async () => {
    const T = parseFloat(Tinspect)
    if (!T || T <= 0) return
    try {
      const res = await spectrumAtPeriod(recordId, T, 0.05, component)
      setInspect({
        T: res.T, PSA_g: res.PSA / G, Sa_g: res.Sa / G,
        Sd_cm: res.Sd * 100, PSV_cms: res.PSV * 100, Sv_cms: res.Sv * 100,
      })
    } catch {}
  }

  // ── Gráfica ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!result || !chartRef.current || typeof window === 'undefined' || !window.Plotly) return

    const T = result.T

    const traces = Object.entries(result.spectra).map(([xi_str, spec]) => {
      let y: number[]
      if (tab === 'PSA' || tab === 'Sa') {
        y = (spec as any)[tab].map((v: number) => v / G)
      } else if (tab === 'PSV' || tab === 'Sv') {
        y = (spec as any)[tab].map((v: number) => v * 100)
      } else {
        y = (spec as any)['Sd'].map((v: number) => v * 100)
      }

      const color = GM_PALETTE.xi[xi_str] || '#94a3b8'
      const isRef = xi_str === '0.0500'

      return {
        x: T, y,
        type: 'scatter', mode: 'lines',
        name: XI_LABELS[xi_str] || xi_str,
        line: { color, width: isRef ? 2.6 : 1.6, shape: 'spline' },
        fill: isRef ? 'tozeroy' : 'none',
        fillcolor: isRef ? `${color}12` : undefined,
        hovertemplate: `<b>${XI_LABELS[xi_str]}</b><br>T = %{x:.3f} s<br>${tab} = %{y:.4f}<extra></extra>`,
      }
    })

    const yUnit = tab === 'PSA' || tab === 'Sa' ? 'g' : tab === 'Sd' ? 'cm' : 'cm/s'

    const shapes: Record<string, unknown>[] = []
    const annotations: Record<string, unknown>[] = []

    // Línea vertical del inspector
    if (inspectData) {
      const yInspect = tab === 'PSA' ? inspectData.PSA_g :
                       tab === 'Sa'  ? inspectData.Sa_g :
                       tab === 'Sd'  ? inspectData.Sd_cm :
                       tab === 'PSV' ? inspectData.PSV_cms :
                                       inspectData.Sv_cms
      shapes.push({
        type: 'line', xref: 'x', yref: 'paper',
        x0: inspectData.T, x1: inspectData.T, y0: 0, y1: 1,
        line: { color: GM_PALETTE.peak, width: 1.5, dash: 'dash' }, opacity: 0.65,
      })
      annotations.push({
        x: inspectData.T, y: yInspect, xref: 'x', yref: 'y',
        text: `<b>T* = ${inspectData.T.toFixed(3)} s</b><br>${tab} = ${yInspect.toFixed(4)} ${yUnit}`,
        showarrow: true, arrowhead: 0, arrowsize: 0.9, arrowwidth: 1.2,
        arrowcolor: GM_PALETTE.peak, ax: 32, ay: -34,
        bgcolor: t.hoverBg, bordercolor: GM_PALETTE.peak, borderwidth: 1, borderpad: 6,
        font: { size: 11, color: t.text, family: 'JetBrains Mono, ui-monospace, monospace' },
      })
      // Marker sobre la curva ξ=5%
      traces.push({
        x: [inspectData.T], y: [yInspect],
        type: 'scatter', mode: 'markers',
        name: 'inspector',
        marker: {
          color: GM_PALETTE.peak, size: 12, symbol: 'diamond',
          line: { color: t.hoverBg, width: 2 },
        },
        showlegend: false,
        hovertemplate: `T* = %{x:.3f} s<br>${tab} = %{y:.4f} ${yUnit}<extra></extra>`,
      } as any)
    }

    window.Plotly.newPlot(chartRef.current, traces, baseLayout(t, {
      margin: { l: 68, r: 28, t: 14, b: 52 },
      xaxis: {
        gridcolor: t.grid, zerolinecolor: t.zeroLine, linecolor: t.gridStrong,
        showgrid: true, zeroline: false, ticks: 'outside', ticklen: 4, tickcolor: t.gridStrong,
        tickfont: { size: 11, color: t.textMuted },
        title: { text: 'Período T (s)', font: { size: 12, color: t.text } },
        type: scale === 'log' ? 'log' : 'linear',
      },
      yaxis: {
        gridcolor: t.grid, zerolinecolor: t.zeroLine, linecolor: t.gridStrong,
        showgrid: true, zeroline: false, ticks: 'outside', ticklen: 4, tickcolor: t.gridStrong,
        tickfont: { size: 11, color: t.textMuted },
        title: { text: `${tab} (${yUnit})`, font: { size: 12, color: t.text } },
        type: scale === 'log' ? 'log' : 'linear',
      },
      legend: {
        bgcolor: 'transparent',
        x: 0.98, xanchor: 'right', y: 0.98,
        font: { size: 11, color: t.text },
      },
      shapes, annotations,
    }), gmPlotConfig)
  }, [result, tab, scale, inspectData, t.isDark])

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Espectro de Respuesta"
        subtitle="Espectros elásticos Sd, Sv, Sa, PSA, PSV para múltiples amortiguamientos (ξ = 2 · 5 · 10 · 20 %). Integración Newmark-β."
        chip="Newmark-β"
      />

      {/* Toolbar de configuración */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl px-5 py-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-[var(--muted)] block mb-1.5">
              T mín (s)
            </label>
            <input
              type="number" step="0.005" min="0.001" value={TMin}
              onChange={e => setTMin(e.target.value)}
              className="w-24 bg-[var(--surface-alt)] border border-[var(--border)] rounded-lg
                         px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
            />
          </div>
          <div>
            <label className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-[var(--muted)] block mb-1.5">
              T máx (s)
            </label>
            <input
              type="number" value={TMax} onChange={e => setTMax(e.target.value)}
              className="w-24 bg-[var(--surface-alt)] border border-[var(--border)] rounded-lg
                         px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
            />
          </div>
          <div>
            <label className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-[var(--muted)] block mb-1.5">
              Puntos
            </label>
            <input
              type="number" value={nPoints} onChange={e => setNPoints(e.target.value)}
              className="w-24 bg-[var(--surface-alt)] border border-[var(--border)] rounded-lg
                         px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
            />
          </div>
          <button
            onClick={compute}
            disabled={isLoading}
            className="px-5 py-2 bg-[var(--accent)] text-white rounded-lg text-sm font-semibold
                       disabled:opacity-50 hover:opacity-90 transition-opacity shadow-sm"
          >
            {isLoading ? 'Calculando…' : result ? 'Recalcular' : 'Calcular Espectro'}
          </button>

          {result && (
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={() => exportFile('xlsx')}
                disabled={exportingFmt !== null}
                title="Descargar Sa, Sd, Sv en Excel (una hoja por magnitud, columnas por amortiguamiento)"
                className="px-3 py-2 bg-[var(--surface-alt)] border border-[var(--border)] rounded-lg
                           text-xs font-semibold text-[var(--foreground)]
                           hover:border-[var(--accent)]/40 hover:bg-[var(--surface)] transition-colors
                           disabled:opacity-50"
              >
                {exportingFmt === 'xlsx' ? 'Exportando…' : 'Exportar Excel'}
              </button>
              <button
                onClick={() => exportFile('txt')}
                disabled={exportingFmt !== null}
                title="Descargar Sa, Sd, Sv en TXT tabular con encabezado"
                className="px-3 py-2 bg-[var(--surface-alt)] border border-[var(--border)] rounded-lg
                           text-xs font-semibold text-[var(--foreground)]
                           hover:border-[var(--accent)]/40 hover:bg-[var(--surface)] transition-colors
                           disabled:opacity-50"
              >
                {exportingFmt === 'txt' ? 'Exportando…' : 'Exportar TXT'}
              </button>
              <SegmentedControl<'linear' | 'log'>
                value={scale} onChange={setScale}
                options={[{ value: 'linear', label: 'lineal' }, { value: 'log', label: 'log' }]}
              />
            </div>
          )}
        </div>
        <AccuracyBanner dt={dt} tMin={tMinNum} />
      </div>

      {error && <ErrorBanner message={error} />}

      {result && (
        <>
          {/* Tabs de cantidad espectral */}
          <div className="flex flex-wrap gap-2">
            {TABS.map(({ id, label, desc }) => {
              const active = tab === id
              return (
                <button
                  key={id} onClick={() => setTab(id)}
                  className={`flex flex-col items-start gap-0.5 px-4 py-2 rounded-xl border transition-all
                    ${active
                      ? 'bg-[var(--accent)] text-white border-[var(--accent)] shadow-sm'
                      : 'bg-[var(--surface)] text-[var(--foreground)] border-[var(--border)] hover:border-[var(--accent)]/40'}`}
                >
                  <span className={`text-sm font-bold font-mono ${active ? 'text-white' : ''}`}>{label}</span>
                  <span className={`text-[10px] ${active ? 'text-white/80' : 'text-[var(--muted)]'}`}>{desc}</span>
                </button>
              )
            })}
          </div>

          {/* Gráfica principal */}
          <ChartCard title={`Espectro ${tab}`} unitBadge={tab === 'PSA' || tab === 'Sa' ? 'g' : tab === 'Sd' ? 'cm' : 'cm/s'}
                     accent={GM_PALETTE.xi['0.0500']}>
            <div ref={chartRef} style={{ height: 420 }} />
          </ChartCard>

          {/* Inspector de espectro */}
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl overflow-hidden shadow-sm">
            <div className="flex items-center gap-2.5 px-5 py-3 border-b border-[var(--border)]">
              <span className="w-1.5 h-4 rounded-sm" style={{ background: GM_PALETTE.peak }} />
              <h4 className="text-sm font-semibold text-[var(--foreground)]">Inspector espectral</h4>
              <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded ml-auto"
                    style={{ background: `${GM_PALETTE.peak}18`, color: GM_PALETTE.peak }}>
                ξ = 5%
              </span>
            </div>

            <div className="px-5 py-4">
              <div className="flex flex-wrap items-end gap-3 mb-4">
                <div>
                  <label className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-[var(--muted)] block mb-1.5">
                    Período de interés T* (s)
                  </label>
                  <input
                    type="number" step="0.01" min="0.01" value={Tinspect}
                    onChange={e => setTinspect(e.target.value)}
                    className="w-32 bg-[var(--surface-alt)] border border-[var(--border)] rounded-lg
                               px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
                  />
                </div>
                <button
                  onClick={inspectT}
                  className="px-4 py-2 bg-[var(--foreground)] text-[var(--surface)] rounded-lg text-sm font-semibold
                             hover:opacity-90 transition-opacity shadow-sm"
                >
                  Evaluar
                </button>
                {inspectData && (
                  <span className="text-[11px] text-[var(--muted)] italic">
                    Marcador rojo en la gráfica sobre ξ = 5%
                  </span>
                )}
              </div>

              {inspectData && (
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                  <InspectorCell label="PSA" value={inspectData.PSA_g.toFixed(4)} unit="g" accent={GM_PALETTE.xi['0.0500']} />
                  <InspectorCell label="Sa"  value={inspectData.Sa_g.toFixed(4)}  unit="g" accent={GM_PALETTE.acceleration} />
                  <InspectorCell label="Sd"  value={inspectData.Sd_cm.toFixed(3)} unit="cm" accent={GM_PALETTE.displacement} />
                  <InspectorCell label="PSV" value={inspectData.PSV_cms.toFixed(2)} unit="cm/s" accent="#8b5cf6" />
                  <InspectorCell label="Sv"  value={inspectData.Sv_cms.toFixed(2)} unit="cm/s" accent={GM_PALETTE.velocity} />
                </div>
              )}
            </div>
          </div>

          <FooterNote>
            <strong>Método:</strong> Newmark-β (β = ¼, γ = ½, aceleración promedio constante).&nbsp;
            <strong>PSA</strong> = ω² · Sd, <strong>PSV</strong> = ω · Sd.&nbsp;
            <strong>Sa</strong> y <strong>Sv</strong> son extremos reales de la historia de respuesta.
          </FooterNote>
        </>
      )}

      {!result && !isLoading && (
        <EmptyState
          icon="📈"
          title="Calcula el espectro de respuesta elástico"
          subtitle="Integración Newmark-β · Sd, Sv, Sa, PSA, PSV para ξ = 2, 5, 10 y 20%"
        />
      )}
    </div>
  )
}

function InspectorCell({ label, value, unit, accent }: {
  label: string; value: string; unit: string; accent: string
}) {
  return (
    <div className="bg-[var(--surface-alt)] rounded-lg px-3 py-2.5 border-l-2" style={{ borderLeftColor: accent }}>
      <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--muted)]">{label}</div>
      <div className="text-base font-bold font-mono mt-0.5 tabular-nums text-[var(--foreground)]">
        {value} <span className="text-[10px] font-normal text-[var(--muted)]">{unit}</span>
      </div>
    </div>
  )
}
