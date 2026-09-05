'use client'

import { useEffect, useRef } from 'react'
import { FFTResult } from '@/lib/ground-motion-types'

declare const window: Window & { Plotly: any }

interface Props { data: FFTResult }

export default function FrequencyPanel({ data }: Props) {
  const fftRef = useRef<HTMLDivElement>(null)
  const psdRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!fftRef.current || !psdRef.current || typeof window === 'undefined' || !window.Plotly) return

    const cfg = { responsive: true, displaylogo: false }
    const baseLayout = {
      paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      font: { color: '#94a3b8', size: 11 },
      margin: { l: 60, r: 20, t: 20, b: 45 },
      legend: { bgcolor: 'transparent' },
    }

    // Espectro de amplitud FFT
    const fftFreq = data.fft.freq
    const fftAmp  = data.fft.amplitude

    window.Plotly.newPlot(fftRef.current, [
      {
        x: fftFreq, y: fftAmp,
        type: 'scatter', mode: 'lines', fill: 'tozeroy',
        name: 'Amplitud',
        line: { color: '#60a5fa', width: 1.5 },
        fillcolor: 'rgba(96,165,250,0.1)',
      },
      {
        x: [data.fft.dominant_freq_hz, data.fft.dominant_freq_hz],
        y: [0, Math.max(...fftAmp)],
        type: 'scatter', mode: 'lines',
        name: `f_dom = ${data.fft.dominant_freq_hz.toFixed(3)} Hz`,
        line: { color: '#f59e0b', width: 1.5, dash: 'dash' },
      },
    ], {
      ...baseLayout,
      xaxis: { title: 'Frecuencia (Hz)', gridcolor: '#1e293b', showgrid: true, zeroline: false },
      yaxis: { title: 'Amplitud (m/s²)', gridcolor: '#1e293b', showgrid: true, zeroline: false },
    }, cfg)

    // PSD (Welch)
    window.Plotly.newPlot(psdRef.current, [
      {
        x: data.psd.freq, y: data.psd.psd,
        type: 'scatter', mode: 'lines', fill: 'tozeroy',
        name: 'PSD (Welch)',
        line: { color: '#a78bfa', width: 1.5 },
        fillcolor: 'rgba(167,139,250,0.1)',
      },
    ], {
      ...baseLayout,
      xaxis: { title: 'Frecuencia (Hz)', gridcolor: '#1e293b', showgrid: true, zeroline: false },
      yaxis: { title: 'PSD (m²/s⁴ / Hz)', gridcolor: '#1e293b', showgrid: true, zeroline: false, type: 'log' },
    }, cfg)
  }, [data])

  return (
    <div className="flex flex-col gap-4">
      {/* Resumen */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Frec. dominante" value={data.fft.dominant_freq_hz.toFixed(3)} unit="Hz" />
        <Kpi label="Período dominante" value={data.fft.dominant_period_s === Infinity ? '∞' : data.fft.dominant_period_s.toFixed(3)} unit="s" />
        <Kpi label="Frec. de Nyquist" value={data.nyquist.toFixed(1)} unit="Hz" />
        <Kpi label="Muestras" value={data.n_samples.toLocaleString()} unit="pts" />
      </div>

      {/* Gráfica FFT */}
      <div className="bg-[var(--surface-alt)] rounded-xl p-1">
        <p className="text-xs font-medium text-[var(--muted)] px-3 pt-2">Espectro de Amplitud de Fourier</p>
        <div ref={fftRef} style={{ height: 240 }} />
      </div>

      {/* Gráfica PSD */}
      <div className="bg-[var(--surface-alt)] rounded-xl p-1">
        <p className="text-xs font-medium text-[var(--muted)] px-3 pt-2">Densidad Espectral de Potencia — Welch</p>
        <div ref={psdRef} style={{ height: 220 }} />
      </div>

      <p className="text-xs text-[var(--muted)]">
        FFT: espectro de amplitud unilateral (normalizado por N). PSD: método de Welch con segmentos solapados.
        Resolución frecuencial Δf = 1/duración. Frecuencia máxima = Nyquist = fs/2 = {data.nyquist.toFixed(1)} Hz.
      </p>
    </div>
  )
}

function Kpi({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="bg-[var(--surface-alt)] rounded-xl px-4 py-3">
      <div className="text-xs text-[var(--muted)]">{label}</div>
      <div className="text-xl font-bold font-mono mt-1">{value}</div>
      <div className="text-xs text-[var(--muted)]">{unit}</div>
    </div>
  )
}
