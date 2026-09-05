'use client'

import { useEffect, useRef, useState } from 'react'
import { SpectrumMultiXiResult, SpectrumResult } from '@/lib/ground-motion-types'
import { computeSpectrum, spectrumAtPeriod } from '@/lib/ground-motion-api'

declare const window: Window & { Plotly: any }

interface Props {
  recordId: string
  component?: string
}

type SpecTab = 'PSA' | 'Sd' | 'PSV' | 'Sa' | 'Sv'
const TABS: SpecTab[] = ['PSA', 'Sa', 'Sd', 'PSV', 'Sv']

const XI_COLORS: Record<string, string> = {
  '0.0200': '#60a5fa',
  '0.0500': '#34d399',
  '0.1000': '#f472b6',
  '0.2000': '#f59e0b',
}
const XI_LABELS: Record<string, string> = {
  '0.0200': 'ξ = 2%',
  '0.0500': 'ξ = 5%',
  '0.1000': 'ξ = 10%',
  '0.2000': 'ξ = 20%',
}

export default function SpectrumPanel({ recordId, component = '' }: Props) {
  const chartRef    = useRef<HTMLDivElement>(null)
  const [tab, setTab]               = useState<SpecTab>('PSA')
  const [result, setResult]         = useState<SpectrumMultiXiResult | null>(null)
  const [isLoading, setIsLoading]   = useState(false)
  const [error, setError]           = useState<string | null>(null)
  const [Tinspect, setTinspect]     = useState('1.0')
  const [inspectData, setInspect]   = useState<Record<string, number> | null>(null)
  const [scale, setScale]           = useState<'linear' | 'log'>('log')
  const [TMax, setTMax]             = useState('4.0')
  const [nPoints, setNPoints]       = useState('150')

  const compute = async () => {
    setIsLoading(true); setError(null)
    try {
      const res = await computeSpectrum(recordId, {
        component,
        xi_list: [0.02, 0.05, 0.10, 0.20],
        T_min: 0.01,
        T_max: parseFloat(TMax) || 4.0,
        n_points: parseInt(nPoints) || 150,
        multi_xi: true,
      }) as SpectrumMultiXiResult
      setResult(res)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Error calculando espectro.')
    } finally {
      setIsLoading(false)
    }
  }

  const inspectT = async () => {
    const T = parseFloat(Tinspect)
    if (!T || T <= 0) return
    try {
      const res = await spectrumAtPeriod(recordId, T, 0.05, component)
      setInspect({
        T: res.T, PSA_g: res.PSA / 9.80665, Sa_g: res.Sa / 9.80665,
        Sd_cm: res.Sd * 100, PSV_cms: res.PSV * 100, Sv_cms: res.Sv * 100,
      })
    } catch {}
  }

  // Gráfica
  useEffect(() => {
    if (!result || !chartRef.current || typeof window === 'undefined' || !window.Plotly) return

    const T = result.T
    const G = 9.80665

    const traces = Object.entries(result.spectra).map(([xi_str, spec]) => {
      let y: number[]
      if (tab === 'PSA' || tab === 'Sa') {
        y = (spec as any)[tab === 'PSA' ? 'PSA' : 'Sa'].map((v: number) => v / G)
      } else if (tab === 'PSV' || tab === 'Sv') {
        y = (spec as any)[tab === 'PSV' ? 'PSV' : 'Sv'].map((v: number) => v * 100)
      } else {
        y = (spec as any)['Sd'].map((v: number) => v * 100)
      }

      return {
        x: T, y,
        type: 'scatter', mode: 'lines',
        name: XI_LABELS[xi_str] || xi_str,
        line: { color: XI_COLORS[xi_str] || '#94a3b8', width: 2 },
      }
    })

    const yUnit = tab === 'PSA' || tab === 'Sa' ? 'g' :
                  tab === 'Sd'                  ? 'cm' : 'cm/s'

    window.Plotly.newPlot(chartRef.current, traces, {
      paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      font: { color: '#94a3b8', size: 11 },
      margin: { l: 60, r: 20, t: 15, b: 45 },
      xaxis: {
        title: 'Período T (s)', gridcolor: '#1e293b', showgrid: true,
        type: scale === 'log' ? 'log' : 'linear', zeroline: false,
      },
      yaxis: {
        title: `${tab} (${yUnit})`, gridcolor: '#1e293b', showgrid: true,
        type: scale === 'log' ? 'log' : 'linear', zeroline: false,
      },
      legend: { bgcolor: 'transparent', x: 0.98, xanchor: 'right', y: 0.98 },
    }, { responsive: true, displaylogo: false })
  }, [result, tab, scale])

  return (
    <div className="flex flex-col gap-4">
      {/* Controles */}
      <div className="flex flex-wrap gap-3 items-end">
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
        <button
          onClick={compute}
          disabled={isLoading}
          className="px-5 py-2 bg-[var(--accent)] text-white rounded-lg text-sm font-medium
                     disabled:opacity-50 hover:opacity-90 transition-opacity"
        >
          {isLoading ? 'Calculando…' : 'Calcular Espectro'}
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
          {/* Pestañas */}
          <div className="flex gap-1">
            {TABS.map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors
                  ${tab === t ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface-alt)] text-[var(--muted)] hover:text-[var(--foreground)]'}`}>
                {t}
              </button>
            ))}
          </div>

          {/* Gráfica */}
          <div className="bg-[var(--surface-alt)] rounded-xl p-1">
            <div ref={chartRef} style={{ height: 340 }} />
          </div>

          {/* Inspector de espectro */}
          <div className="bg-[var(--surface-alt)] rounded-xl px-5 py-4">
            <p className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider mb-3">
              Inspector de Espectro
            </p>
            <div className="flex gap-3 items-end">
              <div>
                <label className="text-xs text-[var(--muted)] block mb-1">Período T (s)</label>
                <input
                  type="number" step="0.01" min="0.01" value={Tinspect}
                  onChange={e => setTinspect(e.target.value)}
                  className="w-28 bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <button onClick={inspectT}
                className="px-4 py-2 bg-[var(--surface)] border border-[var(--border)] rounded-lg text-sm hover:bg-[var(--surface-alt)] transition-colors">
                Evaluar
              </button>
              {inspectData && (
                <div className="flex flex-wrap gap-4 text-sm">
                  <Kv label="PSA" value={`${inspectData.PSA_g.toFixed(4)} g`} />
                  <Kv label="Sa" value={`${inspectData.Sa_g.toFixed(4)} g`} />
                  <Kv label="Sd" value={`${inspectData.Sd_cm.toFixed(3)} cm`} />
                  <Kv label="PSV" value={`${inspectData.PSV_cms.toFixed(3)} cm/s`} />
                  <Kv label="Sv" value={`${inspectData.Sv_cms.toFixed(3)} cm/s`} />
                </div>
              )}
            </div>
          </div>

          {/* Nota del método */}
          <p className="text-xs text-[var(--muted)]">
            Espectro de respuesta elástico — método Newmark-β (β=¼, γ=½, aceleración promedio constante).
            PSA = ω²·Sd, PSV = ω·Sd. Sa y Sv son valores espectrales reales de la historia de respuesta.
            ξ = 2%, 5%, 10%, 20%.
          </p>
        </>
      )}

      {!result && !isLoading && (
        <div className="flex flex-col items-center justify-center py-12 text-[var(--muted)]">
          <p className="text-sm">Haz clic en <strong>Calcular Espectro</strong> para obtener el espectro de respuesta elástico.</p>
          <p className="text-xs mt-1">Integración Newmark-β — Sd, Sv, Sa, PSA, PSV para ξ = 2%, 5%, 10%, 20%</p>
        </div>
      )}
    </div>
  )
}

function Kv({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-xs text-[var(--muted)]">{label} </span>
      <span className="font-mono font-semibold">{value}</span>
    </div>
  )
}
