'use client'

import { useEffect, useRef, useState } from 'react'
import { GM_PALETTE, baseLayout, gmPlotConfig, useGmTheme } from '@/lib/gm-plotly-theme'
import { AccuracyBanner, ChartCard, EmptyState, ErrorBanner, FooterNote, SectionHeader, SegmentedControl } from './_visual'

declare const window: Window & { Plotly: any }

interface InelasticResult {
  T: number[]
  Sa_elastic: number[]
  spectra: Record<string, { Sa_inel: number[]; Sd_inel: number[]; R: number[] }>
  xi: number
  mu_list: number[]
}

interface Props {
  recordId: string
  component?: string
  dt?: number
}

const MU_COLORS: Record<string, string> = {
  '1.0': '#94a3b8',   // slate-400 (elástico, referencia)
  '1.5': '#0ea5e9',   // sky-500
  '2.0': '#10b981',   // emerald-500
  '3.0': '#f59e0b',   // amber-500
  '4.0': '#ec4899',   // pink-500
  '6.0': '#a855f7',   // violet-500
}

type ViewTab = 'Sa' | 'Sd' | 'R'

const TABS: { id: ViewTab; label: string; desc: string }[] = [
  { id: 'Sa', label: 'Sa',    desc: 'Aceleración inelástica' },
  { id: 'Sd', label: 'Sd',    desc: 'Desplazamiento inelástico' },
  { id: 'R',  label: 'R-μ-T', desc: 'Factor de reducción' },
]

const G = 9.80665

export default function InelasticSpectrumPanel({ recordId, component = '', dt }: Props) {
  const chartRef = useRef<HTMLDivElement>(null)
  const [result, setResult]       = useState<InelasticResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError]         = useState<string | null>(null)
  const [tab, setTab]             = useState<ViewTab>('Sa')
  const [scale, setScale]         = useState<'linear' | 'log'>('log')
  const [TMin, setTMin]           = useState<string>(() => {
    if (dt && dt > 0) return Math.max(0.01, 20 * dt).toFixed(3)
    return '0.01'
  })
  const [TMax, setTMax]           = useState('4.0')
  const [nPoints, setNPoints]     = useState('80')
  const [xi, setXi]               = useState('0.05')
  const [Tinspect, setTinspect]   = useState('1.0')
  const t = useGmTheme()

  const tMinNum = parseFloat(TMin) || 0.01

  const compute = async () => {
    setIsLoading(true); setError(null)
    try {
      const token = localStorage.getItem('pl_token')
      const body = {
        xi: parseFloat(xi) || 0.05,
        mu_list: [1.0, 1.5, 2.0, 3.0, 4.0, 6.0],
        T_min: tMinNum,
        T_max: parseFloat(TMax) || 4.0,
        n_points: parseInt(nPoints) || 80,
        component,
      }
      const res = await fetch(`/api/v1/ground-motion/records/${recordId}/inelastic-spectrum`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error((await res.json()).detail || 'Error computing inelastic spectrum')
      setResult(await res.json())
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Error')
    } finally {
      setIsLoading(false)
    }
  }

  // ── Datos del inspector R-μ-T al periodo T* ────────────────────────────────
  const inspectData = (() => {
    if (!result) return null
    const T_target = parseFloat(Tinspect)
    if (!T_target || T_target <= 0) return null
    const idx = result.T.reduce((best, tval, i) =>
      Math.abs(tval - T_target) < Math.abs(result.T[best] - T_target) ? i : best, 0)
    return {
      T_actual: result.T[idx],
      idx,
      rows: Object.entries(result.spectra).map(([mu_str, spec]) => ({
        mu: parseFloat(mu_str),
        Sa: spec.Sa_inel[idx] / G,
        Sd: spec.Sd_inel[idx] * 100,
        R:  spec.R[idx],
        color: MU_COLORS[mu_str] || '#94a3b8',
      })),
    }
  })()

  useEffect(() => {
    if (!result || !chartRef.current || typeof window === 'undefined' || !window.Plotly) return

    const T = result.T
    const traces: any[] = []

    if (tab === 'R') {
      Object.entries(result.spectra).forEach(([mu_str, spec]) => {
        const mu = parseFloat(mu_str)
        if (mu === 1.0) return
        traces.push({
          x: T, y: spec.R,
          type: 'scatter', mode: 'lines',
          name: `μ = ${mu}`,
          line: { color: MU_COLORS[mu_str], width: 2.2, shape: 'spline' },
          hovertemplate: `<b>μ = ${mu}</b><br>T = %{x:.3f} s<br>R = %{y:.3f}<extra></extra>`,
        })
      })
    } else {
      Object.entries(result.spectra).forEach(([mu_str, spec]) => {
        const mu = parseFloat(mu_str)
        const y = tab === 'Sa'
          ? spec.Sa_inel.map(v => v / G)
          : spec.Sd_inel.map(v => v * 100)
        const isEl = mu === 1.0

        traces.push({
          x: T, y,
          type: 'scatter', mode: 'lines',
          name: isEl ? 'Elástico (μ=1)' : `μ = ${mu}`,
          line: {
            color: MU_COLORS[mu_str],
            width: isEl ? 2.4 : 1.8,
            dash: isEl ? 'dash' : 'solid',
            shape: 'spline',
          },
          fill: isEl ? 'tozeroy' : 'none',
          fillcolor: isEl ? 'rgba(148,163,184,0.08)' : undefined,
          hovertemplate: `<b>${isEl ? 'Elástico' : 'μ = ' + mu}</b><br>T = %{x:.3f} s<br>${tab} = %{y:.4f}<extra></extra>`,
        })
      })
    }

    const yTitle = tab === 'Sa' ? 'Sa (g)' : tab === 'Sd' ? 'Sd (cm)' : 'R = Sa_el / Sa_inel'

    // Línea vertical del inspector
    const shapes: Record<string, unknown>[] = []
    const annotations: Record<string, unknown>[] = []
    if (inspectData) {
      shapes.push({
        type: 'line', xref: 'x', yref: 'paper',
        x0: inspectData.T_actual, x1: inspectData.T_actual, y0: 0, y1: 1,
        line: { color: GM_PALETTE.peak, width: 1.5, dash: 'dash' }, opacity: 0.65,
      })
      annotations.push({
        x: inspectData.T_actual, y: 1, xref: 'x', yref: 'paper',
        text: `<b>T* = ${inspectData.T_actual.toFixed(3)} s</b>`,
        showarrow: false, yanchor: 'bottom',
        bgcolor: t.hoverBg, bordercolor: GM_PALETTE.peak, borderwidth: 1, borderpad: 4,
        font: { size: 11, color: t.text, family: 'JetBrains Mono, ui-monospace, monospace' },
      })
    }

    window.Plotly.newPlot(chartRef.current, traces, baseLayout(t, {
      margin: { l: 68, r: 28, t: 26, b: 52 },
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
        title: { text: yTitle, font: { size: 12, color: t.text } },
        type: (tab === 'Sa' && scale === 'log') ? 'log' : 'linear',
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
        title="Espectros de Respuesta Inelástica"
        subtitle="Espectros de ductilidad constante con oscilador SDOF elasto-perfectamente plástico (EPP). Bisección sobre fy para μ = 1.5, 2, 3, 4, 6."
        chip="EPP · μ constante"
      />

      {/* Toolbar de configuración */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl px-5 py-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-[var(--muted)] block mb-1.5">
              Amortiguamiento ξ
            </label>
            <select
              value={xi} onChange={e => setXi(e.target.value)}
              className="w-28 bg-[var(--surface-alt)] border border-[var(--border)] rounded-lg
                         px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
            >
              <option value="0.02">2%</option>
              <option value="0.05">5%</option>
              <option value="0.10">10%</option>
            </select>
          </div>
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
            onClick={compute} disabled={isLoading}
            className="px-5 py-2 bg-[var(--accent)] text-white rounded-lg text-sm font-semibold
                       disabled:opacity-50 hover:opacity-90 transition-opacity shadow-sm"
          >
            {isLoading ? 'Calculando…' : result ? 'Recalcular' : 'Calcular espectros inelásticos'}
          </button>

          {result && (
            <div className="ml-auto">
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
          {/* Tabs de vista */}
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
                  <span className="text-sm font-bold font-mono">{label}</span>
                  <span className={`text-[10px] ${active ? 'text-white/80' : 'text-[var(--muted)]'}`}>{desc}</span>
                </button>
              )
            })}
          </div>

          {/* Leyenda ductilidad */}
          <MuLegend />

          <ChartCard
            title={`Espectros ${tab === 'R' ? 'R-μ-T (factor de reducción)' : tab}`}
            unitBadge={tab === 'Sa' ? 'g' : tab === 'Sd' ? 'cm' : 'R'}
            accent={GM_PALETTE.xi['0.0500']}
          >
            <div ref={chartRef} style={{ height: 420 }} />
          </ChartCard>

          {/* Inspector R-μ-T */}
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl overflow-hidden shadow-sm">
            <div className="flex items-center gap-2.5 px-5 py-3 border-b border-[var(--border)]">
              <span className="w-1.5 h-4 rounded-sm" style={{ background: GM_PALETTE.peak }} />
              <h4 className="text-sm font-semibold text-[var(--foreground)]">Inspector R-μ-T</h4>
              {inspectData && (
                <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded ml-auto"
                      style={{ background: `${GM_PALETTE.peak}18`, color: GM_PALETTE.peak }}>
                  T* = {inspectData.T_actual.toFixed(3)} s
                </span>
              )}
            </div>

            <div className="px-5 py-4">
              <div className="flex flex-wrap items-end gap-3 mb-4">
                <div>
                  <label className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-[var(--muted)] block mb-1.5">
                    Período de interés T (s)
                  </label>
                  <input
                    type="number" step="0.05" min="0.01" value={Tinspect}
                    onChange={e => setTinspect(e.target.value)}
                    className="w-32 bg-[var(--surface-alt)] border border-[var(--border)] rounded-lg
                               px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
                  />
                </div>
                <span className="text-[11px] text-[var(--muted)] italic pb-2">
                  Los valores se leen del punto más cercano en la malla del espectro.
                </span>
              </div>

              {inspectData && (
                <div className="overflow-hidden rounded-lg border border-[var(--border)]">
                  <table className="text-xs w-full">
                    <thead>
                      <tr className="bg-[var(--surface-alt)]">
                        <th className="text-left py-2.5 pl-4 pr-6 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--muted)]">
                          μ objetivo
                        </th>
                        <th className="text-right pr-6 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--muted)]">
                          Sa<sub>inel</sub> (g)
                        </th>
                        <th className="text-right pr-6 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--muted)]">
                          Sd<sub>inel</sub> (cm)
                        </th>
                        <th className="text-right pr-4 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--muted)]">
                          R = Sa<sub>el</sub>/Sa<sub>in</sub>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {inspectData.rows.map(row => (
                        <tr key={row.mu}
                          className={`border-t border-[var(--border)]/50 hover:bg-[var(--surface-alt)]/50 transition-colors
                            ${row.mu === 1.0 ? 'italic' : ''}`}
                        >
                          <td className="py-2 pl-4 pr-6 font-mono font-semibold">
                            <div className="flex items-center gap-2">
                              <span className="w-2.5 h-2.5 rounded-full" style={{ background: row.color }} />
                              {row.mu === 1.0 ? 'Elástico' : `μ = ${row.mu.toFixed(1)}`}
                            </div>
                          </td>
                          <td className="text-right pr-6 font-mono tabular-nums text-[var(--foreground)]">{row.Sa.toFixed(4)}</td>
                          <td className="text-right pr-6 font-mono tabular-nums text-[var(--foreground)]">{row.Sd.toFixed(3)}</td>
                          <td className="text-right pr-4 font-mono tabular-nums font-semibold"
                              style={{ color: row.mu > 1 ? GM_PALETTE.peak : undefined }}>
                            {row.R.toFixed(3)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <FooterNote>
            <strong>Modelo:</strong> SDOF elasto-perfectamente plástico (α=0).&nbsp;
            <strong>Método:</strong> Newmark-β (β=¼, γ=½) con bisección sobre f<sub>y</sub> para μ = 1.5, 2, 3, 4, 6.&nbsp;
            <strong>R</strong> = PSA<sub>elástico</sub> / Sa<sub>inelástico</sub>.&nbsp;
            ξ = {(result.xi * 100).toFixed(0)}%.
          </FooterNote>
        </>
      )}

      {!result && !isLoading && (
        <EmptyState
          icon="⤴"
          title="Calcula los espectros de ductilidad constante"
          subtitle="SDOF EPP bilineal · μ = 1 (elástico), 1.5, 2, 3, 4, 6"
        />
      )}
    </div>
  )
}

// ── Leyenda de códigos de color por ductilidad ──────────────────────────────
function MuLegend() {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px]">
      <span className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-[var(--muted)]">
        Ductilidad
      </span>
      {Object.entries(MU_COLORS).map(([mu_str, color]) => (
        <span key={mu_str}
              className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-[var(--surface-alt)]
                         border border-[var(--border)]">
          <span style={{ width: 10, height: 10, background: color, borderRadius: 999, display: 'inline-block' }} />
          <span className="font-mono font-semibold text-[var(--foreground)]">
            {mu_str === '1.0' ? 'Elástico' : `μ = ${mu_str}`}
          </span>
        </span>
      ))}
    </div>
  )
}
