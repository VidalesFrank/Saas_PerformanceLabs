// Helper compartido de theming/paleta/config Plotly para el módulo Ground Motion.
// Los layouts se adaptan al tema claro/oscuro del usuario (useTheme).

import { useTheme } from '@/lib/theme'

export const GM_PALETTE = {
  acceleration:     '#3b82f6',            // blue-500
  accelerationFill: 'rgba(59,130,246,0.10)',
  velocity:         '#10b981',            // emerald-500
  velocityFill:     'rgba(16,185,129,0.10)',
  displacement:     '#f59e0b',            // amber-500
  displacementFill: 'rgba(245,158,11,0.10)',
  peak:             '#ef4444',            // red-500 (PGA, PGV, PGD)
  peakSoft:         'rgba(239,68,68,0.85)',
  arias:            '#f59e0b',
  ariasFill:        'rgba(245,158,11,0.14)',
  d595:             '#ef4444',
  d595Band:         'rgba(239,68,68,0.06)',
  d575:             '#a855f7',
  fft:              '#8b5cf6',            // violet-500
  fftFill:          'rgba(139,92,246,0.10)',
  psd:              '#ec4899',            // pink-500
  xi: {
    '0.0200': '#0ea5e9',   // sky-500
    '0.0500': '#10b981',   // emerald-500 (referencia)
    '0.1000': '#f59e0b',   // amber-500
    '0.2000': '#ec4899',   // pink-500
  } as Record<string, string>,
} as const

export interface GmTheme {
  isDark: boolean
  text: string
  textMuted: string
  grid: string
  gridStrong: string
  zeroLine: string
  hoverBg: string
  hoverBorder: string
  surface: string
}

export function useGmTheme(): GmTheme {
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  return {
    isDark,
    text:        isDark ? '#e2e8f0' : '#1e293b',
    textMuted:   isDark ? '#94a3b8' : '#64748b',
    grid:        isDark ? 'rgba(148,163,184,0.10)' : 'rgba(15,23,42,0.06)',
    gridStrong:  isDark ? 'rgba(148,163,184,0.22)' : 'rgba(15,23,42,0.14)',
    zeroLine:    isDark ? 'rgba(148,163,184,0.40)' : 'rgba(15,23,42,0.28)',
    hoverBg:     isDark ? '#141b2e' : '#ffffff',
    hoverBorder: isDark ? '#334155' : '#e2e8f0',
    surface:     isDark ? '#141b2e' : '#ffffff',
  }
}

// Devuelve un layout Plotly base con los ejes/font/hoverlabel del tema actual.
export function baseLayout(t: GmTheme, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: {
      color: t.textMuted,
      size: 12,
      family: 'Inter, system-ui, -apple-system, sans-serif',
    },
    margin: { l: 68, r: 28, t: 24, b: 52 },
    hoverlabel: {
      bgcolor: t.hoverBg,
      bordercolor: t.hoverBorder,
      font: {
        family: 'JetBrains Mono, ui-monospace, monospace',
        size: 12,
        color: t.text,
      },
    },
    hovermode: 'closest',
    legend: {
      bgcolor: 'transparent',
      font: { size: 11, color: t.text },
      borderwidth: 0,
    },
    xaxis: {
      gridcolor: t.grid,
      zerolinecolor: t.zeroLine,
      linecolor: t.gridStrong,
      showgrid: true,
      zeroline: true,
      ticks: 'outside',
      ticklen: 4,
      tickcolor: t.gridStrong,
      tickfont: { size: 11, color: t.textMuted },
      title: { font: { size: 12, color: t.text } },
    },
    yaxis: {
      gridcolor: t.grid,
      zerolinecolor: t.zeroLine,
      linecolor: t.gridStrong,
      showgrid: true,
      zeroline: true,
      ticks: 'outside',
      ticklen: 4,
      tickcolor: t.gridStrong,
      tickfont: { size: 11, color: t.textMuted },
      title: { font: { size: 12, color: t.text } },
    },
    ...overrides,
  }
}

export const gmPlotConfig = {
  responsive: true,
  displaylogo: false,
  modeBarButtonsToRemove: [
    'lasso2d',
    'select2d',
    'autoScale2d',
    'hoverClosestCartesian',
    'hoverCompareCartesian',
    'toggleSpikelines',
  ],
  toImageButtonOptions: {
    format: 'png',
    filename: 'performance-labs-ground-motion',
    height: 900,
    width: 1600,
    scale: 2,
  },
}
