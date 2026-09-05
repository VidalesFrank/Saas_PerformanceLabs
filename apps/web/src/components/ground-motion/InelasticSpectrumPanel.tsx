'use client'

import { useEffect, useRef, useState } from 'react'

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
}

const MU_COLORS: Record<string, string> = {
  '1.0': '#94a3b8',
  '1.5': '#60a5fa',
  '2.0': '#34d399',
  '3.0': '#f59e0b',
  '4.0': '#f472b6',
  '6.0': '#a78bfa',
}

type ViewTab = 'Sa' | 'Sd' | 'R'

const G = 9.80665

export default function InelasticSpectrumPanel({ recordId, component = '' }: Props) {
  const chartRef  = useRef<HTMLDivElement>(null)
  const [result, setResult]       = useState<InelasticResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError]         = useState<string | null>(null)
  const [tab, setTab]             = useState<ViewTab>('Sa')
  const [scale, setScale]         = useState<'linear' | 'log'>('log')
  const [TMax, setTMax]           = useState('4.0')
  const [nPoints, setNPoints]     = useState('80')
  const [xi, setXi]               = useState('0.05')

  const compute = async () => {
    setIsLoading(true); setError(null)
    try {
      const token = localStorage.getItem('access_token')
      const body = {
        xi: parseFloat(xi) || 0.05,
        mu_list: [1.0, 1.5, 2.0, 3.0, 4.0, 6.0],
        T_min: 0.01,
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

  useEffect(() => {
    if (!result || !chartRef.current || typeof window === 'undefined' || !window.Plotly) return

    const T = result.T

    const traces: any[] = []

    // Elastic reference always visible
    const elKey = '1.0'
    const elSpec = result.spectra[elKey]

    if (tab === 'R') {
      // R vs T: skip mu=1 (R=1 everywhere), show mu>1
      Object.entries(result.spectra).forEach(([mu_str, spec]) => {
        const mu = parseFloat(mu_str)
        if (mu === 1.0) return
        traces.push({
          x: T, y: spec.R,
          type: 'scatter', mode: 'lines',
          name: `μ = ${mu}`,
          line: { color: MU_COLORS[mu_str] || '#94a3b8', width: 2 },
        })
      })
    } else {
      Object.entries(result.spectra).forEach(([mu_str, spec]) => {
        const mu = parseFloat(mu_str)
        const y = tab === 'Sa'
          ? spec.Sa_inel.map(v => v / G)
          : spec.Sd_inel.map(v => v * 100)

        traces.push({
          x: T, y,
          type: 'scatter', mode: 'lines',
          name: mu === 1.0 ? 'Elástico' : `μ = ${mu}`,
          line: {
            color: MU_COLORS[mu_str] || '#94a3b8',
            width: mu === 1.0 ? 2 : 1.5,
            dash:  mu === 1.0 ? 'dash' : 'solid',
          },
        })
      })
    }

    const yTitle = tab === 'Sa' ? 'Sa (g)' : tab === 'Sd' ? 'Sd (cm)' : 'R = Sa_el / Sa_inel'

    window.Plotly.newPlot(chartRef.current, traces, {
      paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      font: { color: '#94a3b8', size: 11 },
      margin: { l: 60, r: 20, t: 15, b: 45 },
      xaxis: {
        title: 'Período T (s)', gridcolor: '#1e293b', showgrid: true,
        type: scale === 'log' ? 'log' : 'linear', zeroline: false,
      },
      yaxis: {
        title: yTitle, gridcolor: '#1e293b', showgrid: true,
        type: (tab === 'Sa' && scale === 'log') ? 'log' : 'linear', zeroline: false,
      },
      legend: { bgcolor: 'transparent', x: 0.98, xanchor: 'right', y: 0.98 },
    }, { responsive: true, displaylogo: false })
  }, [result, tab, scale])

  // R-μ-T summary at a specific period
  const [Tinspect, setTinspect] = useState('1.0')
  const inspectData = (() => {
    if (!result) return null
    const T_target = parseFloat(Tinspect)
    if (!T_target) return null
    const idx = result.T.reduce((best, t, i) =>
      Math.abs(t - T_target) < Math.abs(result.T[best] - T_target) ? i : best, 0)
    return Object.entries(result.spectra).map(([mu_str, spec]) => ({
      mu: parseFloat(mu_str),
      Sa: spec.Sa_inel[idx] / G,
      Sd: spec.Sd_inel[idx] * 100,
      R:  spec.R[idx],
    }))
  })()

  return (
    <div className="flex flex-col gap-4">
      {/* Controles */}
      <div className="flex flex-wrap gap-3 items-end">
        <div>
          <label className="text-xs text-[var(--muted)] block mb-1">ξ (amortiguamiento)</label>
          <select value={xi} onChange={e => setXi(e.target.value)}
            className="w-28 bg-[var(--surface)] border border-[var(--border)] rounded-lg px-2 py-1.5 text-sm">
            <option value="0.02">2%</option>
            <option value="0.05">5%</option>
            <option value="0.10">10%</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-[var(--muted)] block mb-1">T máx (s)</label>
          <input type="number" value={TMax} onChange={e => setTMax(e.target.value)}
            className="w-20 bg-[var(--surface)] border border-[var(--border)] rounded-lg px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label className="text-xs text-[var(--muted)] block mb-1">Puntos</label>
          <input type="number" value={nPoints} onChange={e => setNPoints(e.target.value)}
            className="w-20 bg-[var(--surface)] border border-[var(--border)] rounded-lg px-2 py-1.5 text-sm" />
        </div>
        <button onClick={compute} disabled={isLoading}
          className="px-5 py-2 bg-[var(--accent)] text-white rounded-lg text-sm font-medium
                     disabled:opacity-50 hover:opacity-90 transition-opacity">
          {isLoading ? 'Calculando…' : 'Calcular Espectros Inelásticos'}
        </button>
        {result && (
          <div className="flex gap-1 ml-auto">
            {(['linear', 'log'] as const).map(s => (
              <button key={s} onClick={() => setScale(s)}
                className={`px-3 py-1.5 rounded-lg text-xs transition-colors
                  ${scale === s ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface-alt)] text-[var(--muted)]'}`}>
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && <p className="text-sm text-red-400 bg-red-500/10 px-3 py-2 rounded-lg">{error}</p>}

      {result && (
        <>
          {/* Pestañas de vista */}
          <div className="flex gap-1">
            {(['Sa', 'Sd', 'R'] as ViewTab[]).map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors
                  ${tab === t ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface-alt)] text-[var(--muted)] hover:text-[var(--foreground)]'}`}>
                {t === 'R' ? 'R-μ-T' : t}
              </button>
            ))}
          </div>

          {/* Chart */}
          <div className="bg-[var(--surface-alt)] rounded-xl p-1">
            <div ref={chartRef} style={{ height: 360 }} />
          </div>

          {/* Leyenda */}
          <div className="flex flex-wrap gap-3">
            {Object.entries(MU_COLORS).map(([mu_str, color]) => (
              <div key={mu_str} className="flex items-center gap-1.5 text-xs">
                <span style={{ width: 20, height: 2, background: color, display: 'inline-block', borderRadius: 1 }} />
                <span className="text-[var(--muted)]">{mu_str === '1.0' ? 'Elástico' : `μ = ${mu_str}`}</span>
              </div>
            ))}
          </div>

          {/* Inspector R-μ-T */}
          <div className="bg-[var(--surface-alt)] rounded-xl px-5 py-4">
            <p className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider mb-3">
              Inspector R-μ-T
            </p>
            <div className="flex gap-3 items-end mb-3">
              <div>
                <label className="text-xs text-[var(--muted)] block mb-1">Período T (s)</label>
                <input type="number" step="0.05" min="0.01" value={Tinspect}
                  onChange={e => setTinspect(e.target.value)}
                  className="w-28 bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm" />
              </div>
            </div>
            {inspectData && (
              <div className="overflow-x-auto">
                <table className="text-xs w-full">
                  <thead>
                    <tr className="text-[var(--muted)] border-b border-[var(--border)]">
                      <th className="text-left py-1.5 pr-6">μ objetivo</th>
                      <th className="text-right pr-6">Sa_inel (g)</th>
                      <th className="text-right pr-6">Sd_inel (cm)</th>
                      <th className="text-right">R = Sa_el/Sa_in</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inspectData.map(row => (
                      <tr key={row.mu}
                        className={`border-b border-[var(--border)]/30 ${row.mu === 1.0 ? 'text-[var(--muted)]' : ''}`}>
                        <td className="py-1.5 pr-6 font-mono font-semibold">
                          {row.mu === 1.0 ? 'Elástico' : row.mu.toFixed(1)}
                        </td>
                        <td className="text-right pr-6 font-mono">{row.Sa.toFixed(4)}</td>
                        <td className="text-right pr-6 font-mono">{row.Sd.toFixed(3)}</td>
                        <td className="text-right font-mono">{row.R.toFixed(3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Nota del método */}
          <p className="text-xs text-[var(--muted)]">
            Espectros de ductilidad constante — SDOF elasto-perfectamente plástico (EPP), Newmark-β
            (β=¼, γ=½). Bisección sobre la fuerza de fluencia fy para μ = 1.5, 2, 3, 4, 6.
            R = PSA_elástico / Sa_inelástico. ξ = {(result.xi * 100).toFixed(0)}%.
          </p>
        </>
      )}

      {!result && !isLoading && (
        <div className="flex flex-col items-center justify-center py-12 text-[var(--muted)]">
          <p className="text-sm">
            Haz clic en <strong>Calcular Espectros Inelásticos</strong> para obtener los espectros de ductilidad constante.
          </p>
          <p className="text-xs mt-1">
            SDOF EPP bilineal — μ = 1 (elástico), 1.5, 2, 3, 4, 6
          </p>
        </div>
      )}
    </div>
  )
}
