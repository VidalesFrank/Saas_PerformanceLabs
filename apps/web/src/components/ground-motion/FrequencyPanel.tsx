'use client'

import { useEffect, useRef } from 'react'
import { FFTResult } from '@/lib/ground-motion-types'
import { GM_PALETTE, baseLayout, gmPlotConfig, useGmTheme } from '@/lib/gm-plotly-theme'
import { ChartCard, FooterNote, KpiCard, SectionHeader } from './_visual'

declare const window: Window & { Plotly: any }

interface Props { data: FFTResult }

// Devuelve los índices de los N picos locales más altos (separados por > minGapHz).
function findTopPeaks(freq: number[], amp: number[], n = 3, minGapHz = 0.5): number[] {
  const peaks: { idx: number; amp: number }[] = []
  for (let i = 2; i < amp.length - 2; i++) {
    if (amp[i] > amp[i - 1] && amp[i] > amp[i + 1] && amp[i] > amp[i - 2] && amp[i] > amp[i + 2]) {
      peaks.push({ idx: i, amp: amp[i] })
    }
  }
  peaks.sort((a, b) => b.amp - a.amp)
  const selected: number[] = []
  for (const p of peaks) {
    if (selected.every(idx => Math.abs(freq[idx] - freq[p.idx]) >= minGapHz)) {
      selected.push(p.idx)
      if (selected.length >= n) break
    }
  }
  return selected
}

export default function FrequencyPanel({ data }: Props) {
  const fftRef = useRef<HTMLDivElement>(null)
  const psdRef = useRef<HTMLDivElement>(null)
  const t = useGmTheme()

  useEffect(() => {
    if (!fftRef.current || !psdRef.current || typeof window === 'undefined' || !window.Plotly) return

    // ── FFT ───────────────────────────────────────────────────────────────────
    const fftFreq = data.fft.freq
    const fftAmp  = data.fft.amplitude
    const maxAmp  = Math.max(...fftAmp)

    const topIdx = findTopPeaks(fftFreq, fftAmp, 3, Math.max(0.3, data.nyquist / 40))
    const peakColors = [GM_PALETTE.peak, '#f97316', '#eab308']

    const peakTraces = topIdx.map((idx, k) => ({
      x: [fftFreq[idx]], y: [fftAmp[idx]],
      type: 'scatter', mode: 'markers',
      name: `#${k + 1}: ${fftFreq[idx].toFixed(3)} Hz`,
      marker: {
        color: peakColors[k], size: 11, symbol: 'diamond',
        line: { color: t.hoverBg, width: 2 },
      },
      hovertemplate: `<b>Pico #${k + 1}</b><br>f = %{x:.3f} Hz<br>T = ${(1 / fftFreq[idx]).toFixed(3)} s<br>A = %{y:.4e}<extra></extra>`,
    }))

    const peakShapes = topIdx.map((idx, k) => ({
      type: 'line', xref: 'x', yref: 'y',
      x0: fftFreq[idx], x1: fftFreq[idx], y0: 0, y1: fftAmp[idx],
      line: { color: peakColors[k], width: 1, dash: 'dash' },
      opacity: 0.55,
    }))

    window.Plotly.newPlot(fftRef.current, [
      {
        x: fftFreq, y: fftAmp,
        type: 'scatter', mode: 'lines', fill: 'tozeroy',
        name: 'Amplitud',
        line: { color: GM_PALETTE.fft, width: 1.6, shape: 'spline' },
        fillcolor: GM_PALETTE.fftFill,
        hovertemplate: 'f = %{x:.3f} Hz<br>A = %{y:.4e}<extra></extra>',
        showlegend: false,
      },
      ...peakTraces,
    ], baseLayout(t, {
      margin: { l: 68, r: 28, t: 12, b: 46 },
      xaxis: {
        gridcolor: t.grid, zerolinecolor: t.zeroLine, linecolor: t.gridStrong,
        showgrid: true, zeroline: false, ticks: 'outside', ticklen: 4, tickcolor: t.gridStrong,
        tickfont: { size: 11, color: t.textMuted },
        title: { text: 'Frecuencia (Hz)', font: { size: 12, color: t.text } },
        range: [0, data.nyquist],
      },
      yaxis: {
        gridcolor: t.grid, zerolinecolor: t.zeroLine, linecolor: t.gridStrong,
        showgrid: true, zeroline: false, ticks: 'outside', ticklen: 4, tickcolor: t.gridStrong,
        tickfont: { size: 11, color: t.textMuted },
        title: { text: 'Amplitud (m/s²)', font: { size: 12, color: t.text } },
        range: [0, maxAmp * 1.1],
      },
      legend: {
        bgcolor: 'transparent',
        x: 0.98, xanchor: 'right', y: 0.98,
        font: { size: 11, color: t.text },
      },
      shapes: peakShapes,
    }), gmPlotConfig)

    // ── PSD Welch ─────────────────────────────────────────────────────────────
    window.Plotly.newPlot(psdRef.current, [
      {
        x: data.psd.freq, y: data.psd.psd,
        type: 'scatter', mode: 'lines', fill: 'tozeroy',
        name: 'PSD (Welch)',
        line: { color: GM_PALETTE.psd, width: 1.6, shape: 'spline' },
        fillcolor: 'rgba(236,72,153,0.10)',
        hovertemplate: 'f = %{x:.3f} Hz<br>PSD = %{y:.4e}<extra></extra>',
        showlegend: false,
      },
    ], baseLayout(t, {
      margin: { l: 78, r: 28, t: 12, b: 46 },
      xaxis: {
        gridcolor: t.grid, zerolinecolor: t.zeroLine, linecolor: t.gridStrong,
        showgrid: true, zeroline: false, ticks: 'outside', ticklen: 4, tickcolor: t.gridStrong,
        tickfont: { size: 11, color: t.textMuted },
        title: { text: 'Frecuencia (Hz)', font: { size: 12, color: t.text } },
        range: [0, data.nyquist],
      },
      yaxis: {
        gridcolor: t.grid, zerolinecolor: t.zeroLine, linecolor: t.gridStrong,
        showgrid: true, zeroline: false, ticks: 'outside', ticklen: 4, tickcolor: t.gridStrong,
        tickfont: { size: 11, color: t.textMuted },
        title: { text: 'PSD (m²/s⁴ / Hz)', font: { size: 12, color: t.text } },
        type: 'log',
      },
    }), gmPlotConfig)
  }, [data, t.isDark])

  const T_dom = data.fft.dominant_period_s === Infinity ? '∞' : data.fft.dominant_period_s.toFixed(3)

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Análisis en Frecuencia"
        subtitle="Espectro de amplitud de Fourier (FFT unilateral) y Densidad Espectral de Potencia con el método de Welch."
        chip="FFT · Welch"
      />

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="Frec. dominante" value={data.fft.dominant_freq_hz.toFixed(3)} unit="Hz"
                 sub={`T = ${T_dom} s`} accent={GM_PALETTE.fft} />
        <KpiCard label="Período dominante" value={T_dom} unit="s"
                 sub="del pico FFT" accent="#a855f7" />
        <KpiCard label="Frec. de Nyquist" value={data.nyquist.toFixed(1)} unit="Hz"
                 sub="fs / 2" accent={GM_PALETTE.psd} />
        <KpiCard label="Muestras" value={data.n_samples.toLocaleString()} unit="pts"
                 sub={`Δf = ${(1 / (data.n_samples * data.dt)).toFixed(4)} Hz`} accent="#0891b2" />
      </div>

      <ChartCard title="Espectro de Amplitud de Fourier" unitBadge="FFT" accent={GM_PALETTE.fft}>
        <div ref={fftRef} style={{ height: 300 }} />
      </ChartCard>

      <ChartCard title="Densidad Espectral de Potencia (Welch)" unitBadge="PSD · log" accent={GM_PALETTE.psd}>
        <div ref={psdRef} style={{ height: 280 }} />
      </ChartCard>

      <FooterNote>
        <strong>FFT:</strong> espectro unilateral normalizado por N.&nbsp;
        <strong>PSD:</strong> método de Welch con segmentos solapados.&nbsp;
        Resolución frecuencial Δf = 1/duración.&nbsp;
        Frecuencia máxima = Nyquist = fs/2 = <strong>{data.nyquist.toFixed(1)} Hz</strong>.&nbsp;
        Marcadores rojo/naranja/amarillo = 3 armónicos dominantes.
      </FooterNote>
    </div>
  )
}
