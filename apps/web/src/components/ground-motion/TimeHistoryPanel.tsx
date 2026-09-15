'use client'

import { useEffect, useRef, useState } from 'react'
import { TimeseriesData } from '@/lib/ground-motion-types'
import { GM_PALETTE, baseLayout, gmPlotConfig, useGmTheme } from '@/lib/gm-plotly-theme'
import { ChartCard, FooterNote, KpiCard, SectionHeader } from './_visual'

declare const window: Window & { Plotly: any }

interface Props {
  data: TimeseriesData
  accUnit: string
}

const G = 9.80665

function toDisplayUnit(vals: number[], unit: string): number[] {
  if (unit === 'g')    return vals.map(v => v / G)
  if (unit === 'cm/s²' || unit === 'Gal') return vals.map(v => v * 100)
  return vals
}

function unitLabel(unit: string): string {
  const map: Record<string, string> = { g: 'g', 'm/s²': 'm/s²', 'cm/s²': 'cm/s²', Gal: 'Gal' }
  return map[unit] || 'm/s²'
}

export default function TimeHistoryPanel({ data, accUnit }: Props) {
  const accRef  = useRef<HTMLDivElement>(null)
  const velRef  = useRef<HTMLDivElement>(null)
  const dispRef = useRef<HTMLDivElement>(null)
  const [displayUnit, setDisplayUnit] = useState(accUnit || 'g')
  const t = useGmTheme()

  useEffect(() => {
    if (!accRef.current || !velRef.current || !dispRef.current) return
    if (typeof window === 'undefined' || !window.Plotly) return

    const time   = data.t
    const a_disp = toDisplayUnit(data.a_ms2, displayUnit)
    const v_cms  = data.v_ms.map(v => v * 100)
    const d_cm   = data.d_m.map(v => v * 100)
    const uAcc   = unitLabel(displayUnit)

    const t_pgv = findTimeOfPeak(v_cms, time)
    const t_pgd = findTimeOfPeak(d_cm, time)
    const pgv_signed = v_cms[time.indexOf(t_pgv)] ?? Math.sign(Math.max(...v_cms.map(Math.abs))) * Math.max(...v_cms.map(Math.abs))
    const pgd_signed = d_cm[time.indexOf(t_pgd)] ?? Math.sign(Math.max(...d_cm.map(Math.abs))) * Math.max(...d_cm.map(Math.abs))

    const a_pos = Math.max(...a_disp)
    const a_neg = Math.min(...a_disp)
    const pga_signed = Math.abs(a_pos) >= Math.abs(a_neg) ? a_pos : a_neg

    plotChannel(
      accRef.current, time, a_disp, uAcc, data.t_pga, pga_signed,
      GM_PALETTE.acceleration, GM_PALETTE.accelerationFill, 'a', t,
    )
    plotChannel(
      velRef.current, time, v_cms, 'cm/s', t_pgv, pgv_signed,
      GM_PALETTE.velocity, GM_PALETTE.velocityFill, 'v', t,
    )
    plotChannel(
      dispRef.current, time, d_cm, 'cm', t_pgd, pgd_signed,
      GM_PALETTE.displacement, GM_PALETTE.displacementFill, 'd', t,
    )
  }, [data, displayUnit, t.isDark])

  const pga_disp = toDisplayUnit([data.pga_ms2], displayUnit)[0]
  const uAcc     = unitLabel(displayUnit)

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <SectionHeader
        title="Historia de Tiempo"
        subtitle="Aceleración, velocidad y desplazamiento del suelo. Integración trapezoidal con corrección de tendencia."
        chip="a · v · d"
      />

      {/* KPI cards premium */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="PGA" value={pga_disp.toFixed(4)} unit={uAcc}
          sub={`t = ${data.t_pga.toFixed(3)} s`} accent={GM_PALETTE.acceleration} />
        <KpiCard label="PGV" value={(data.pgv_ms * 100).toFixed(3)} unit="cm/s"
          sub="pico absoluto" accent={GM_PALETTE.velocity} />
        <KpiCard label="PGD" value={(data.pgd_m * 100).toFixed(3)} unit="cm"
          sub="pico absoluto" accent={GM_PALETTE.displacement} />
        <KpiCard label="Duración" value={data.duration.toFixed(2)} unit="s"
          sub={`${data.a_ms2.length.toLocaleString()} pts`} accent="#0891b2" />
      </div>

      {/* Selector de unidad — pill toolbar */}
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">
          Unidad de aceleración
        </span>
        <div className="flex gap-1 bg-[var(--surface-alt)] rounded-lg p-1">
          {['g', 'm/s²', 'cm/s²'].map(u => (
            <button
              key={u}
              onClick={() => setDisplayUnit(u)}
              className={`px-3 py-1 rounded-md text-xs font-mono font-semibold transition-all
                ${displayUnit === u
                  ? 'bg-[var(--surface)] text-[var(--foreground)] shadow-sm ring-1 ring-[var(--border)]'
                  : 'text-[var(--muted)] hover:text-[var(--foreground)]'}`}
            >
              {u}
            </button>
          ))}
        </div>
      </div>

      {/* Gráficas premium */}
      <ChartCard title="Aceleración" unitBadge={uAcc} accent={GM_PALETTE.acceleration}>
        <div ref={accRef} style={{ height: 240 }} />
      </ChartCard>
      <ChartCard title="Velocidad" unitBadge="cm/s" accent={GM_PALETTE.velocity}>
        <div ref={velRef} style={{ height: 240 }} />
      </ChartCard>
      <ChartCard title="Desplazamiento" unitBadge="cm" accent={GM_PALETTE.displacement}>
        <div ref={dispRef} style={{ height: 240 }} />
      </ChartCard>

      <FooterNote>
        Velocidad y desplazamiento obtenidos por integración trapezoidal numérica con corrección de tendencia lineal.
      </FooterNote>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de trazado
// ─────────────────────────────────────────────────────────────────────────────

function findTimeOfPeak(y: number[], t: number[]): number {
  let idx = 0, best = 0
  for (let i = 0; i < y.length; i++) {
    const v = Math.abs(y[i])
    if (v > best) { best = v; idx = i }
  }
  return t[idx] ?? 0
}

function plotChannel(
  el: HTMLDivElement, x: number[], y: number[], unit: string,
  tPeak: number, yPeak: number, color: string, fillColor: string,
  symbol: 'a' | 'v' | 'd', t: ReturnType<typeof useGmTheme>,
) {
  const yMax = Math.max(...y)
  const yMin = Math.min(...y)
  const range = Math.max(Math.abs(yMax), Math.abs(yMin))

  window.Plotly.newPlot(el, [
    {
      x, y, type: 'scatter', mode: 'lines',
      name: 'Serie',
      line: { color, width: 1.3, shape: 'linear' },
      fill: 'tozeroy',
      fillcolor: fillColor,
      hovertemplate: `t = %{x:.3f} s<br>${symbol} = %{y:.4f} ${unit}<extra></extra>`,
      showlegend: false,
    },
    {
      x: [tPeak], y: [yPeak],
      type: 'scatter', mode: 'markers',
      name: 'Pico',
      marker: { color: GM_PALETTE.peak, size: 11, symbol: 'diamond',
                line: { color: t.hoverBg, width: 2 } },
      hovertemplate: `Pico<br>t = %{x:.3f} s<br>${symbol} = %{y:.4f} ${unit}<extra></extra>`,
      showlegend: false,
    },
  ], baseLayout(t, {
    margin: { l: 68, r: 28, t: 12, b: 46 },
    yaxis: {
      gridcolor: t.grid, zerolinecolor: t.zeroLine, linecolor: t.gridStrong,
      showgrid: true, zeroline: true, ticks: 'outside', ticklen: 4, tickcolor: t.gridStrong,
      tickfont: { size: 11, color: t.textMuted },
      title: { text: unit, font: { size: 12, color: t.text } },
      range: [-range * 1.15, range * 1.15],
    },
    xaxis: {
      gridcolor: t.grid, zerolinecolor: t.zeroLine, linecolor: t.gridStrong,
      showgrid: true, zeroline: false, ticks: 'outside', ticklen: 4, tickcolor: t.gridStrong,
      tickfont: { size: 11, color: t.textMuted },
      title: { text: 'Tiempo (s)', font: { size: 12, color: t.text } },
    },
    shapes: [
      // Línea vertical discontinua en el pico
      {
        type: 'line', xref: 'x', yref: 'y',
        x0: tPeak, x1: tPeak, y0: -range * 1.15, y1: range * 1.15,
        line: { color: GM_PALETTE.peak, width: 1, dash: 'dash' },
        opacity: 0.55,
      },
    ],
    annotations: [
      {
        x: tPeak, y: yPeak, xref: 'x', yref: 'y',
        text: `<b>${symbol.toUpperCase()} pico</b>  ${yPeak >= 0 ? '+' : ''}${yPeak.toFixed(4)} ${unit}`,
        showarrow: true, arrowhead: 0, arrowsize: 0.8, arrowwidth: 1,
        arrowcolor: GM_PALETTE.peak, ax: 40, ay: yPeak >= 0 ? -30 : 30,
        bgcolor: t.hoverBg, bordercolor: GM_PALETTE.peak, borderwidth: 1, borderpad: 4,
        font: { size: 10.5, color: t.text, family: 'JetBrains Mono, ui-monospace, monospace' },
      },
    ],
  }), gmPlotConfig)
}

