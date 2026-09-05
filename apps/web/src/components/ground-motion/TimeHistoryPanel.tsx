'use client'

import { useEffect, useRef, useState } from 'react'
import { TimeseriesData } from '@/lib/ground-motion-types'

declare const window: Window & { Plotly: any }

interface Props {
  data: TimeseriesData
  accUnit: string
}

const G = 9.80665

function toDisplayUnit(vals: number[], unit: string): number[] {
  if (unit === 'g')    return vals.map(v => v / G)
  if (unit === 'cm/s²' || unit === 'Gal') return vals.map(v => v * 100)
  return vals  // m/s²
}

function unitLabel(unit: string): string {
  const map: Record<string, string> = {
    'g': 'g', 'm/s²': 'm/s²', 'cm/s²': 'cm/s²', 'Gal': 'Gal'
  }
  return map[unit] || 'm/s²'
}

export default function TimeHistoryPanel({ data, accUnit }: Props) {
  const accRef  = useRef<HTMLDivElement>(null)
  const velRef  = useRef<HTMLDivElement>(null)
  const dispRef = useRef<HTMLDivElement>(null)
  const [displayUnit, setDisplayUnit] = useState(accUnit || 'g')

  useEffect(() => {
    if (!accRef.current || !velRef.current || !dispRef.current) return
    if (typeof window === 'undefined' || !window.Plotly) return

    const t    = data.t
    const a_ms2 = data.a_ms2
    const a_disp = toDisplayUnit(a_ms2, displayUnit)
    const v_cms  = data.v_ms.map(v => v * 100)   // m/s → cm/s
    const d_cm   = data.d_m.map(v => v * 100)    // m → cm

    const pga_disp = Math.max(...a_disp.map(Math.abs))
    const pgv_cms  = data.pgv_ms * 100
    const pgd_cm   = data.pgd_m * 100

    const layout_base = {
      paper_bgcolor: 'transparent',
      plot_bgcolor: 'transparent',
      font: { color: '#94a3b8', size: 11 },
      margin: { l: 60, r: 20, t: 20, b: 40 },
      xaxis: { gridcolor: '#1e293b', showgrid: true, title: 'Tiempo (s)', zeroline: false },
      showlegend: true,
      legend: { x: 1, xanchor: 'right', y: 1, bgcolor: 'transparent', font: { size: 10 } },
    }

    const config = { responsive: true, displaylogo: false }

    // Aceleración
    const a_pos = Math.max(...a_disp)
    const a_neg = Math.min(...a_disp)

    window.Plotly.newPlot(accRef.current, [
      {
        x: t, y: a_disp, type: 'scatter', mode: 'lines',
        name: `Aceleración (${unitLabel(displayUnit)})`,
        line: { color: '#60a5fa', width: 1 },
      },
      {
        x: [data.t_pga], y: [a_pos > Math.abs(a_neg) ? a_pos : a_neg],
        type: 'scatter', mode: 'markers',
        name: `PGA = ${pga_disp.toFixed(4)} ${unitLabel(displayUnit)}`,
        marker: { color: '#f59e0b', size: 8, symbol: 'diamond' },
      },
    ], {
      ...layout_base,
      yaxis: { gridcolor: '#1e293b', showgrid: true, title: unitLabel(displayUnit), zeroline: true, zerolinecolor: '#334155' },
      annotations: [
        { x: 0.01, y: 0.95, xref: 'paper', yref: 'paper', text: `PGA+ = +${a_pos.toFixed(4)}  PGA− = ${a_neg.toFixed(4)} ${unitLabel(displayUnit)}`, showarrow: false, font: { size: 10, color: '#f59e0b' }, xanchor: 'left' }
      ]
    }, config)

    // Velocidad
    window.Plotly.newPlot(velRef.current, [
      {
        x: t, y: v_cms, type: 'scatter', mode: 'lines',
        name: 'Velocidad (cm/s)',
        line: { color: '#34d399', width: 1 },
      },
    ], {
      ...layout_base,
      yaxis: { gridcolor: '#1e293b', showgrid: true, title: 'cm/s', zeroline: true, zerolinecolor: '#334155' },
      annotations: [
        { x: 0.01, y: 0.95, xref: 'paper', yref: 'paper', text: `PGV = ${pgv_cms.toFixed(3)} cm/s`, showarrow: false, font: { size: 10, color: '#34d399' }, xanchor: 'left' }
      ]
    }, config)

    // Desplazamiento
    window.Plotly.newPlot(dispRef.current, [
      {
        x: t, y: d_cm, type: 'scatter', mode: 'lines',
        name: 'Desplazamiento (cm)',
        line: { color: '#f472b6', width: 1 },
      },
    ], {
      ...layout_base,
      yaxis: { gridcolor: '#1e293b', showgrid: true, title: 'cm', zeroline: true, zerolinecolor: '#334155' },
      annotations: [
        { x: 0.01, y: 0.95, xref: 'paper', yref: 'paper', text: `PGD = ${pgd_cm.toFixed(3)} cm`, showarrow: false, font: { size: 10, color: '#f472b6' }, xanchor: 'left' }
      ]
    }, config)
  }, [data, displayUnit])

  return (
    <div className="flex flex-col gap-4">
      {/* KPIs principales */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="PGA" value={`${toDisplayUnit([data.pga_ms2], displayUnit)[0].toFixed(4)}`} unit={unitLabel(displayUnit)} color="blue" />
        <Kpi label="PGV" value={(data.pgv_ms * 100).toFixed(3)} unit="cm/s" color="emerald" />
        <Kpi label="PGD" value={(data.pgd_m * 100).toFixed(3)} unit="cm" color="pink" />
        <Kpi label="Duración" value={data.duration.toFixed(2)} unit="s" color="amber" />
      </div>

      {/* Selector de unidad */}
      <div className="flex items-center gap-3">
        <span className="text-xs text-[var(--muted)]">Unidad:</span>
        {['g', 'm/s²', 'cm/s²'].map(u => (
          <button
            key={u}
            onClick={() => setDisplayUnit(u)}
            className={`px-3 py-1 rounded-lg text-xs font-mono transition-colors
              ${displayUnit === u ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface-alt)] text-[var(--muted)] hover:text-[var(--foreground)]'}`}
          >
            {u}
          </button>
        ))}
      </div>

      {/* Gráficas */}
      <div className="bg-[var(--surface-alt)] rounded-xl p-1">
        <p className="text-xs font-medium text-[var(--muted)] px-3 pt-2">Aceleración</p>
        <div ref={accRef} style={{ height: 180 }} />
      </div>
      <div className="bg-[var(--surface-alt)] rounded-xl p-1">
        <p className="text-xs font-medium text-[var(--muted)] px-3 pt-2">Velocidad</p>
        <div ref={velRef} style={{ height: 180 }} />
      </div>
      <div className="bg-[var(--surface-alt)] rounded-xl p-1">
        <p className="text-xs font-medium text-[var(--muted)] px-3 pt-2">Desplazamiento</p>
        <div ref={dispRef} style={{ height: 180 }} />
      </div>

      {/* Nota */}
      <p className="text-xs text-[var(--muted)]">
        Velocidad y desplazamiento obtenidos por integración trapezoidal numérica con corrección de tendencia lineal.
      </p>
    </div>
  )
}

function Kpi({ label, value, unit, color }: { label: string; value: string; unit: string; color: string }) {
  const colors: Record<string, string> = {
    blue: 'text-blue-400', emerald: 'text-emerald-400', pink: 'text-pink-400', amber: 'text-amber-400'
  }
  return (
    <div className="bg-[var(--surface-alt)] rounded-xl px-4 py-3">
      <div className="text-xs text-[var(--muted)]">{label}</div>
      <div className={`text-xl font-bold font-mono mt-1 ${colors[color] || 'text-[var(--foreground)]'}`}>{value}</div>
      <div className="text-xs text-[var(--muted)]">{unit}</div>
    </div>
  )
}
