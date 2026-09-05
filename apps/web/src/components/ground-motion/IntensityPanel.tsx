'use client'

import { useEffect, useRef } from 'react'
import { IntensityMeasures } from '@/lib/ground-motion-types'

declare const window: Window & { Plotly: any }

interface Props {
  data: IntensityMeasures
}

export default function IntensityPanel({ data }: Props) {
  const ariasCumRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ariasCumRef.current || typeof window === 'undefined' || !window.Plotly) return

    const t    = data.t
    const ia   = data.ia_cumulative_normalized.map(v => v * 100)

    window.Plotly.newPlot(ariasCumRef.current, [
      {
        x: t, y: ia,
        type: 'scatter', mode: 'lines', fill: 'tozeroy',
        name: 'Ia acum. norm. (%)',
        line: { color: '#f59e0b', width: 2 },
        fillcolor: 'rgba(245,158,11,0.1)',
      },
      // Marcadores D5-95
      {
        x: [data.D5_95_t_start, data.D5_95_t_end],
        y: [5, 95],
        type: 'scatter', mode: 'markers+lines',
        name: `D5-95 = ${data.D5_95.toFixed(2)} s`,
        marker: { color: '#f87171', size: 8 },
        line: { color: '#f87171', dash: 'dot', width: 1.5 },
      },
      {
        x: [data.D5_75_t_start, data.D5_75_t_end],
        y: [5, 75],
        type: 'scatter', mode: 'markers+lines',
        name: `D5-75 = ${data.D5_75.toFixed(2)} s`,
        marker: { color: '#a78bfa', size: 8 },
        line: { color: '#a78bfa', dash: 'dot', width: 1.5 },
      },
    ], {
      paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      font: { color: '#94a3b8', size: 11 },
      margin: { l: 55, r: 15, t: 15, b: 40 },
      xaxis: { title: 'Tiempo (s)', gridcolor: '#1e293b', showgrid: true, zeroline: false },
      yaxis: { title: 'Ia acum. (%)', gridcolor: '#1e293b', showgrid: true, range: [0, 102], zeroline: false },
      legend: { bgcolor: 'transparent', x: 0.01, y: 0.99 },
    }, { responsive: true, displaylogo: false })
  }, [data])

  const G = 9.80665

  return (
    <div className="flex flex-col gap-5">
      {/* Valores pico */}
      <section>
        <h3 className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider mb-3">Valores Pico</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <IMCard label="PGA" value={data.pga_g.toFixed(4)} unit="g"
                  sub={`+${(data.pga_pos_ms2 / G).toFixed(4)} / ${(data.pga_neg_ms2 / G).toFixed(4)} g`}
                  tooltip="Aceleración máxima del suelo — máximo de la aceleración absoluta." color="blue" />
          <IMCard label="PGV" value={data.pgv_cms.toFixed(3)} unit="cm/s"
                  sub={`t_PGV = ${data.t_pgv.toFixed(2)} s`}
                  tooltip="Velocidad máxima del suelo." color="emerald" />
          <IMCard label="PGD" value={data.pgd_cm.toFixed(3)} unit="cm"
                  sub={`t_PGD = ${data.t_pgd.toFixed(2)} s`}
                  tooltip="Desplazamiento máximo del suelo." color="pink" />
        </div>
      </section>

      {/* Basadas en energía */}
      <section>
        <h3 className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider mb-3">Medidas Basadas en Energía</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <IMCard label="Intensidad de Arias" value={data.arias_intensity_ms.toFixed(4)} unit="m/s"
                  sub={`${data.arias_intensity_cms.toFixed(3)} cm/s`}
                  tooltip="Ia = (π/2g) ∫a²(t)dt — Relacionada con la energía sísmica." color="amber" />
          <IMCard label="CAV" value={data.cav_ms.toFixed(3)} unit="m/s"
                  sub="∫|a(t)|dt"
                  tooltip="Velocidad Absoluta Acumulada." color="orange" />
          <IMCard label="PGV/PGA" value={data.pgv_pga_ratio.toFixed(4)} unit="s"
                  sub="Período predominante aproximado"
                  tooltip="Relación PGV/PGA relacionada con el período dominante." color="violet" />
        </div>
      </section>

      {/* Duración significativa */}
      <section>
        <h3 className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider mb-3">Duración Significativa</h3>
        <div className="grid grid-cols-2 gap-3 mb-4">
          <IMCard label="D5-95" value={data.D5_95.toFixed(2)} unit="s"
                  sub={`${data.D5_95_t_start.toFixed(2)} → ${data.D5_95_t_end.toFixed(2)} s`}
                  tooltip="Duración entre el 5% y 95% de la Intensidad de Arias." color="red" />
          <IMCard label="D5-75" value={data.D5_75.toFixed(2)} unit="s"
                  sub={`${data.D5_75_t_start.toFixed(2)} → ${data.D5_75_t_end.toFixed(2)} s`}
                  tooltip="Duración entre el 5% y 75% de la Intensidad de Arias." color="purple" />
        </div>

        {/* Gráfica de Arias acumulada */}
        <div className="bg-[var(--surface-alt)] rounded-xl p-1">
          <p className="text-xs font-medium text-[var(--muted)] px-3 pt-2">Intensidad de Arias Acumulada</p>
          <div ref={ariasCumRef} style={{ height: 220 }} />
        </div>
      </section>

      {/* RMS */}
      <section>
        <h3 className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider mb-3">Valores RMS</h3>
        <div className="grid grid-cols-3 gap-3">
          <IMCard label="RMS Acc" value={data.rms_acc_g.toFixed(4)} unit="g"
                  sub={`${data.rms_acc_ms2.toFixed(4)} m/s²`}
                  tooltip="Aceleración cuadrática media (RMS)." color="blue" />
          <IMCard label="RMS Vel" value={(data.rms_vel_ms * 100).toFixed(3)} unit="cm/s"
                  tooltip="Velocidad cuadrática media (RMS)." color="emerald" />
          <IMCard label="RMS Disp" value={(data.rms_disp_m * 100).toFixed(3)} unit="cm"
                  tooltip="Desplazamiento cuadrático medio (RMS)." color="pink" />
        </div>
      </section>

      {/* Nota del método */}
      <p className="text-xs text-[var(--muted)]">
        Intensidad de Arias: Ia = (π/2g) × ∫a²(t)dt  |  CAV = ∫|a(t)|dt  |
        D5-95 calculada desde la Ia normalizada acumulada al 5% y 95%.
      </p>
    </div>
  )
}

function IMCard({
  label, value, unit, sub, tooltip, color,
}: {
  label: string; value: string; unit: string; sub?: string; tooltip?: string; color?: string
}) {
  const colorMap: Record<string, string> = {
    blue: 'text-blue-400', emerald: 'text-emerald-400', pink: 'text-pink-400',
    amber: 'text-amber-400', orange: 'text-orange-400', red: 'text-red-400',
    violet: 'text-violet-400', purple: 'text-purple-400', orange2: 'text-orange-400',
  }
  const cls = colorMap[color || ''] || 'text-[var(--foreground)]'

  return (
    <div className="bg-[var(--surface-alt)] rounded-xl px-4 py-3 relative group" title={tooltip}>
      <div className="flex items-start justify-between">
        <div className="text-xs text-[var(--muted)]">{label}</div>
        {tooltip && <span className="text-xs text-[var(--muted)] opacity-50 group-hover:opacity-100">ℹ</span>}
      </div>
      <div className={`text-2xl font-bold font-mono mt-1 ${cls}`}>{value}</div>
      <div className="text-xs text-[var(--muted)]">{unit}</div>
      {sub && <div className="text-xs text-[var(--muted)] mt-1 truncate">{sub}</div>}
    </div>
  )
}
