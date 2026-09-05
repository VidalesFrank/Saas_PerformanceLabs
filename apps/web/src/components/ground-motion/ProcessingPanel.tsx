'use client'

import { useEffect, useRef, useState } from 'react'
import { ProcessResult } from '@/lib/ground-motion-types'
import { processSignal } from '@/lib/ground-motion-api'

declare const window: Window & { Plotly: any }

interface Props {
  recordId: string
  component?: string
  onProcessed?: (result: ProcessResult) => void
}

export default function ProcessingPanel({ recordId, component = '', onProcessed }: Props) {
  const chartRef = useRef<HTMLDivElement>(null)

  const [mode, setMode]             = useState<'baseline' | 'filter'>('baseline')
  const [blMethod, setBlMethod]     = useState('linear')
  const [polyOrder, setPolyOrder]   = useState(2)
  const [filterType, setFilterType] = useState('bandpass')
  const [fcLow, setFcLow]           = useState('')
  const [fcHigh, setFcHigh]         = useState('')
  const [filterOrder, setFilterOrder] = useState(4)
  const [result, setResult]         = useState<ProcessResult | null>(null)
  const [isLoading, setIsLoading]   = useState(false)
  const [error, setError]           = useState<string | null>(null)

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

    const t  = result.t
    const G = 9.80665

    window.Plotly.newPlot(chartRef.current, [
      {
        x: t, y: result.a_original_ms2.map(v => v / G),
        type: 'scatter', mode: 'lines',
        name: 'Original',
        line: { color: '#94a3b8', width: 1, dash: 'dot' },
        opacity: 0.6,
      },
      {
        x: t, y: result.a_ms2.map(v => v / G),
        type: 'scatter', mode: 'lines',
        name: 'Procesada',
        line: { color: '#60a5fa', width: 1.5 },
      },
    ], {
      paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      font: { color: '#94a3b8', size: 11 },
      margin: { l: 60, r: 15, t: 15, b: 45 },
      xaxis: { title: 'Tiempo (s)', gridcolor: '#1e293b', showgrid: true, zeroline: false },
      yaxis: { title: 'Aceleración (g)', gridcolor: '#1e293b', showgrid: true, zeroline: true, zerolinecolor: '#334155' },
      legend: { bgcolor: 'transparent', x: 0.99, xanchor: 'right' },
    }, { responsive: true, displaylogo: false })
  }, [result])

  return (
    <div className="flex flex-col gap-5">
      {/* Pestañas de modo */}
      <div className="flex gap-2">
        <button onClick={() => setMode('baseline')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors
            ${mode === 'baseline' ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface-alt)] text-[var(--muted)] hover:text-[var(--foreground)]'}`}>
          Corrección de Línea Base
        </button>
        <button onClick={() => setMode('filter')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors
            ${mode === 'filter' ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface-alt)] text-[var(--muted)] hover:text-[var(--foreground)]'}`}>
          Filtro Digital
        </button>
      </div>

      {/* Opciones de línea base */}
      {mode === 'baseline' && (
        <div className="bg-[var(--surface-alt)] rounded-xl p-5 flex flex-col gap-4">
          <p className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">Método</p>
          <div className="flex gap-2 flex-wrap">
            {[
              { v: 'mean',       label: 'Remover media' },
              { v: 'linear',     label: 'Tendencia lineal' },
              { v: 'polynomial', label: 'Polinomial' },
            ].map(o => (
              <button key={o.v} onClick={() => setBlMethod(o.v)}
                className={`px-3 py-1.5 rounded-lg text-sm transition-colors
                  ${blMethod === o.v ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface)] border border-[var(--border)] text-[var(--muted)]'}`}>
                {o.label}
              </button>
            ))}
          </div>
          {blMethod === 'polynomial' && (
            <div>
              <label className="text-xs text-[var(--muted)] block mb-1">Orden del polinomio</label>
              <input type="number" min={2} max={8} value={polyOrder}
                onChange={e => setPolyOrder(parseInt(e.target.value))}
                className="w-24 bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm" />
            </div>
          )}
          <div className="text-xs text-[var(--muted)] bg-[var(--surface)]/50 rounded-lg px-3 py-2">
            {blMethod === 'mean'       && 'a_corr(t) = a(t) − media(a)  — Elimina el offset constante.'}
            {blMethod === 'linear'     && 'Ajusta a(t) = A + B·t y lo sustrae — Elimina tendencia lineal.'}
            {blMethod === 'polynomial' && `Ajusta un polinomio de grado ${polyOrder} y lo sustrae — Elimina tendencias curvas.`}
          </div>
        </div>
      )}

      {/* Opciones de filtro */}
      {mode === 'filter' && (
        <div className="bg-[var(--surface-alt)] rounded-xl p-5 flex flex-col gap-4">
          <p className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">Filtro Butterworth</p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-[var(--muted)] block mb-1">Tipo</label>
              <select value={filterType} onChange={e => setFilterType(e.target.value)}
                className="w-full bg-[var(--surface)] border border-[var(--border)] rounded-lg px-2 py-2 text-sm">
                <option value="lowpass">Paso bajo</option>
                <option value="highpass">Paso alto</option>
                <option value="bandpass">Paso banda</option>
                <option value="bandstop">Rechazo banda</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-[var(--muted)] block mb-1">Orden</label>
              <input type="number" min={1} max={10} value={filterOrder}
                onChange={e => setFilterOrder(parseInt(e.target.value))}
                className="w-full bg-[var(--surface)] border border-[var(--border)] rounded-lg px-2 py-2 text-sm" />
            </div>
            {(filterType !== 'lowpass') && (
              <div>
                <label className="text-xs text-[var(--muted)] block mb-1">f_bajo (Hz)</label>
                <input type="number" step="any" min="0" value={fcLow}
                  onChange={e => setFcLow(e.target.value)} placeholder="ej. 0.1"
                  className="w-full bg-[var(--surface)] border border-[var(--border)] rounded-lg px-2 py-2 text-sm" />
              </div>
            )}
            {(filterType !== 'highpass') && (
              <div>
                <label className="text-xs text-[var(--muted)] block mb-1">f_alto (Hz)</label>
                <input type="number" step="any" min="0" value={fcHigh}
                  onChange={e => setFcHigh(e.target.value)} placeholder="ej. 25"
                  className="w-full bg-[var(--surface)] border border-[var(--border)] rounded-lg px-2 py-2 text-sm" />
              </div>
            )}
          </div>
          <p className="text-xs text-[var(--muted)]">
            Filtrado de fase cero (sosfiltfilt) — sin distorsión de fase.
            Orden efectivo = 2× (paso directo + inverso).
          </p>
        </div>
      )}

      {/* Botones de acción */}
      <div className="flex gap-3">
        <button onClick={apply} disabled={isLoading}
          className="px-6 py-2 bg-[var(--accent)] text-white rounded-lg text-sm font-medium
                     disabled:opacity-50 hover:opacity-90 transition-opacity">
          {isLoading ? 'Aplicando…' : 'Aplicar'}
        </button>
        {result && (
          <button onClick={reset} disabled={isLoading}
            className="px-4 py-2 border border-[var(--border)] rounded-lg text-sm hover:bg-[var(--surface-alt)] transition-colors">
            Restaurar original
          </button>
        )}
      </div>

      {error && <p className="text-sm text-red-400 bg-red-500/10 px-3 py-2 rounded-lg">{error}</p>}

      {/* Gráfica de resultado */}
      {result && (
        <>
          <div className="bg-[var(--surface-alt)] rounded-xl p-1">
            <p className="text-xs font-medium text-[var(--muted)] px-3 pt-2">Original vs Procesada</p>
            <div ref={chartRef} style={{ height: 240 }} />
          </div>

          {/* Reporte */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {Object.entries(result.report)
              .filter(([k]) => typeof result.report[k] === 'number')
              .map(([key, val]) => (
                <div key={key} className="bg-[var(--surface-alt)] rounded-lg px-3 py-2">
                  <div className="text-xs text-[var(--muted)] truncate">{key.replace(/_/g, ' ')}</div>
                  <div className="text-sm font-mono font-semibold mt-0.5">
                    {typeof val === 'number' ? val.toExponential(4) : String(val)}
                  </div>
                </div>
              ))}
          </div>
        </>
      )}
    </div>
  )
}
