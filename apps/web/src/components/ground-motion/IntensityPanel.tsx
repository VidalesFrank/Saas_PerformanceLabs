'use client'

import { useEffect, useRef } from 'react'
import { IntensityMeasures } from '@/lib/ground-motion-types'
import { GM_PALETTE, baseLayout, gmPlotConfig, useGmTheme } from '@/lib/gm-plotly-theme'
import { ChartCard, FooterNote, KpiCard, Section, SectionHeader } from './_visual'

declare const window: Window & { Plotly: any }

interface Props {
  data: IntensityMeasures
}

const G = 9.80665

export default function IntensityPanel({ data }: Props) {
  const ariasCumRef = useRef<HTMLDivElement>(null)
  const t = useGmTheme()

  useEffect(() => {
    if (!ariasCumRef.current || typeof window === 'undefined' || !window.Plotly) return

    const time = data.t
    const ia   = data.ia_cumulative_normalized.map(v => v * 100)

    const tMax = time[time.length - 1] || 0

    window.Plotly.newPlot(ariasCumRef.current, [
      // Curva Arias acumulada
      {
        x: time, y: ia,
        type: 'scatter', mode: 'lines', fill: 'tozeroy',
        name: 'Ia acumulada normalizada',
        line: { color: GM_PALETTE.arias, width: 2.2, shape: 'spline' },
        fillcolor: GM_PALETTE.ariasFill,
        hovertemplate: 't = %{x:.3f} s<br>Ia = %{y:.2f}%<extra></extra>',
      },
      // Marcadores extremos D5-95
      {
        x: [data.D5_95_t_start, data.D5_95_t_end], y: [5, 95],
        type: 'scatter', mode: 'markers',
        name: `D5-95 = ${data.D5_95.toFixed(2)} s`,
        marker: {
          color: GM_PALETTE.d595, size: 12, symbol: 'diamond',
          line: { color: t.hoverBg, width: 2 },
        },
        hovertemplate: '%{text}<br>t = %{x:.3f} s · Ia = %{y}%<extra></extra>',
        text: ['inicio 5%', 'fin 95%'],
      },
      // Marcadores D5-75
      {
        x: [data.D5_75_t_start, data.D5_75_t_end], y: [5, 75],
        type: 'scatter', mode: 'markers',
        name: `D5-75 = ${data.D5_75.toFixed(2)} s`,
        marker: {
          color: GM_PALETTE.d575, size: 10, symbol: 'circle-open-dot',
          line: { color: GM_PALETTE.d575, width: 2 },
        },
        hovertemplate: '%{text}<br>t = %{x:.3f} s · Ia = %{y}%<extra></extra>',
        text: ['inicio 5%', 'fin 75%'],
      },
    ], baseLayout(t, {
      margin: { l: 60, r: 24, t: 14, b: 46 },
      xaxis: {
        gridcolor: t.grid, zerolinecolor: t.zeroLine, linecolor: t.gridStrong,
        showgrid: true, zeroline: false, ticks: 'outside', ticklen: 4, tickcolor: t.gridStrong,
        tickfont: { size: 11, color: t.textMuted },
        title: { text: 'Tiempo (s)', font: { size: 12, color: t.text } },
        range: [0, tMax * 1.02],
      },
      yaxis: {
        gridcolor: t.grid, zerolinecolor: t.zeroLine, linecolor: t.gridStrong,
        showgrid: true, zeroline: false, ticks: 'outside', ticklen: 4, tickcolor: t.gridStrong,
        tickfont: { size: 11, color: t.textMuted },
        title: { text: 'Ia acumulada (%)', font: { size: 12, color: t.text } },
        range: [0, 105],
      },
      shapes: [
        // Banda sombreada D5-95
        {
          type: 'rect', xref: 'x', yref: 'paper',
          x0: data.D5_95_t_start, x1: data.D5_95_t_end, y0: 0, y1: 1,
          fillcolor: GM_PALETTE.d595Band, line: { width: 0 }, layer: 'below',
        },
        // Líneas horizontales guía
        { type: 'line', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 5,  y1: 5,
          line: { color: t.textMuted, width: 1, dash: 'dot' }, opacity: 0.45 },
        { type: 'line', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 75, y1: 75,
          line: { color: GM_PALETTE.d575, width: 1, dash: 'dot' }, opacity: 0.45 },
        { type: 'line', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 95, y1: 95,
          line: { color: GM_PALETTE.d595, width: 1, dash: 'dot' }, opacity: 0.45 },
        // Verticales D5-95
        { type: 'line', xref: 'x', yref: 'paper',
          x0: data.D5_95_t_start, x1: data.D5_95_t_start, y0: 0, y1: 1,
          line: { color: GM_PALETTE.d595, width: 1, dash: 'dash' }, opacity: 0.55 },
        { type: 'line', xref: 'x', yref: 'paper',
          x0: data.D5_95_t_end, x1: data.D5_95_t_end, y0: 0, y1: 1,
          line: { color: GM_PALETTE.d595, width: 1, dash: 'dash' }, opacity: 0.55 },
      ],
      legend: {
        bgcolor: 'transparent',
        x: 0.98, xanchor: 'right', y: 0.02, yanchor: 'bottom',
        font: { size: 11, color: t.text },
      },
    }), gmPlotConfig)
  }, [data, t.isDark])

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Medidas de Intensidad Sísmica"
        subtitle="Parámetros pico, energía cumulativa (Arias, CAV) y duración significativa. La duración D5-95 es el estándar Trifunac & Brady (1975)."
        chip="IM · Arias · CAV"
      />

      {/* Valores pico */}
      <Section title="Valores Pico" hint="Máximos absolutos del suelo">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <KpiCard
            label="PGA" value={data.pga_g.toFixed(4)} unit="g"
            sub={`+${(data.pga_pos_ms2 / G).toFixed(4)} · ${(data.pga_neg_ms2 / G).toFixed(4)}`}
            accent={GM_PALETTE.acceleration} tooltip="Peak Ground Acceleration"
          />
          <KpiCard
            label="PGV" value={data.pgv_cms.toFixed(3)} unit="cm/s"
            sub={`t = ${data.t_pgv.toFixed(2)} s`}
            accent={GM_PALETTE.velocity} tooltip="Peak Ground Velocity"
          />
          <KpiCard
            label="PGD" value={data.pgd_cm.toFixed(3)} unit="cm"
            sub={`t = ${data.t_pgd.toFixed(2)} s`}
            accent={GM_PALETTE.displacement} tooltip="Peak Ground Displacement"
          />
        </div>
      </Section>

      {/* Medidas basadas en energía */}
      <Section title="Medidas Basadas en Energía" hint="Contenido energético integral">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <KpiCard
            label="Intensidad de Arias" value={data.arias_intensity_ms.toFixed(4)} unit="m/s"
            sub={`${data.arias_intensity_cms.toFixed(3)} cm/s`}
            accent={GM_PALETTE.arias} tooltip="Ia = (π/2g) · ∫ a²(t) dt"
          />
          <KpiCard
            label="CAV" value={data.cav_ms.toFixed(3)} unit="m/s"
            sub="∫ |a(t)| dt"
            accent="#f97316" tooltip="Cumulative Absolute Velocity"
          />
          <KpiCard
            label="PGV/PGA" value={data.pgv_pga_ratio.toFixed(4)} unit="s"
            sub="período dominante aprox."
            accent="#a855f7" tooltip="Estimador del período dominante"
          />
        </div>
      </Section>

      {/* Duración significativa */}
      <Section title="Duración Significativa" hint="Trifunac & Brady 1975">
        <div className="grid grid-cols-2 gap-3 mb-4">
          <KpiCard
            label="D5-95" value={data.D5_95.toFixed(2)} unit="s"
            sub={`${data.D5_95_t_start.toFixed(2)} → ${data.D5_95_t_end.toFixed(2)} s`}
            accent={GM_PALETTE.d595} tooltip="Rango entre 5% y 95% de Ia acumulada"
          />
          <KpiCard
            label="D5-75" value={data.D5_75.toFixed(2)} unit="s"
            sub={`${data.D5_75_t_start.toFixed(2)} → ${data.D5_75_t_end.toFixed(2)} s`}
            accent={GM_PALETTE.d575} tooltip="Rango entre 5% y 75% de Ia acumulada"
          />
        </div>

        <ChartCard title="Intensidad de Arias Acumulada" unitBadge="Ia %" accent={GM_PALETTE.arias}>
          <div ref={ariasCumRef} style={{ height: 320 }} />
        </ChartCard>
      </Section>

      {/* RMS */}
      <Section title="Valores Cuadráticos Medios (RMS)" hint="Amplitud efectiva de la señal">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <KpiCard
            label="RMS Acc" value={data.rms_acc_g.toFixed(4)} unit="g"
            sub={`${data.rms_acc_ms2.toFixed(4)} m/s²`}
            accent={GM_PALETTE.acceleration} tooltip="Root-Mean-Square de la aceleración"
          />
          <KpiCard
            label="RMS Vel" value={(data.rms_vel_ms * 100).toFixed(3)} unit="cm/s"
            accent={GM_PALETTE.velocity} tooltip="Root-Mean-Square de la velocidad"
          />
          <KpiCard
            label="RMS Disp" value={(data.rms_disp_m * 100).toFixed(3)} unit="cm"
            accent={GM_PALETTE.displacement} tooltip="Root-Mean-Square del desplazamiento"
          />
        </div>
      </Section>

      <FooterNote>
        <strong>Ia</strong> = (π/2g) · ∫ a²(t) dt (Arias 1970)&nbsp; · &nbsp;
        <strong>CAV</strong> = ∫ |a(t)| dt (EPRI 1988)&nbsp; · &nbsp;
        <strong>D5-95</strong> derivada de la Ia normalizada acumulada al 5% y 95%.
      </FooterNote>
    </div>
  )
}

