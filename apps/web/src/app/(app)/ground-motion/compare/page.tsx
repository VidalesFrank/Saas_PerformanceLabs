'use client'

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { AppHeader } from '@/components/app-header'
import { PageHero } from '@/components/ui/page-hero'
import { useRequireAuth } from '@/lib/use-require-auth'
import { baseLayout, gmPlotConfig, useGmTheme } from '@/lib/gm-plotly-theme'
import {
  COMPARE_PALETTE,
  colorFor,
  detectStationPairs,
  loadCompareBundles,
  shortLabel,
  type CompareRecordBundle,
  type StationPair,
} from '@/lib/ground-motion-compare'
import { computeRotD } from '@/lib/ground-motion-api'
import type { RotDResult } from '@/lib/ground-motion-types'
import ReferenceSpectraPanel, {
  defaultRefColor,
  type ReferenceSpectrum,
} from '@/components/ground-motion/ReferenceSpectraPanel'
import {
  exportCompareCSV,
  exportComparePDF,
  exportComparePNG,
} from '@/lib/compare-export'

declare const window: Window & { Plotly: any }

type SpecTab = 'Sa' | 'Sd' | 'Sv' | 'PSA' | 'PSV'
const TABS: { id: SpecTab; label: string; unit: string; tooltip: string }[] = [
  { id: 'Sa',  label: 'Sa',  unit: 'g',    tooltip: 'Aceleración espectral real' },
  { id: 'PSA', label: 'PSA', unit: 'g',    tooltip: 'Pseudo-aceleración' },
  { id: 'Sd',  label: 'Sd',  unit: 'cm',   tooltip: 'Desplazamiento espectral' },
  { id: 'Sv',  label: 'Sv',  unit: 'cm/s', tooltip: 'Velocidad espectral real' },
  { id: 'PSV', label: 'PSV', unit: 'cm/s', tooltip: 'Pseudo-velocidad' },
]

const G = 9.80665

// Construye el payload de RotD exportables: sólo los que están cargados y no ocultos.
function buildRotDExports(
  pairs: StationPair[],
  rotdByPair: Record<string, RotDResult>,
  rotdHidden: Set<string>,
) {
  return pairs
    .filter((p) => !!rotdByPair[p.id] && !rotdHidden.has(p.id))
    .map((p) => ({ pair: p, rotd: rotdByPair[p.id] }))
}

export default function GroundMotionComparePage() {
  return (
    <Suspense fallback={<FallbackLoading />}>
      <GroundMotionCompareContent />
    </Suspense>
  )
}

function FallbackLoading() {
  return (
    <div className="flex flex-col h-screen">
      <AppHeader crumb="Comparación de registros" />
      <div className="flex-1 flex items-center justify-center">
        <div className="text-sm text-[var(--text-muted)]">Cargando comparación…</div>
      </div>
    </div>
  )
}

function GroundMotionCompareContent() {
  useRequireAuth()
  const params = useSearchParams()
  const idsRaw = params.get('ids') ?? ''
  const ids = useMemo(
    () => idsRaw.split(',').map((s) => s.trim()).filter(Boolean),
    [idsRaw],
  )

  const [bundles, setBundles]       = useState<CompareRecordBundle[]>([])
  const [loadErrors, setLoadErrors] = useState<{ id: string; message: string }[]>([])
  const [isLoading, setIsLoading]   = useState(true)
  const [hiddenIds, setHiddenIds]   = useState<Set<string>>(new Set())
  const [tab, setTab]               = useState<SpecTab>('Sa')
  const [scale, setScale]           = useState<'linear' | 'log'>('log')
  const [normalizePGA, setNormalize] = useState(false)
  const [xi, setXi]                 = useState(0.05)
  const [TMax, setTMax]             = useState(4.0)          // T_max de cálculo (dispara re-fetch)
  const [viewTMin, setViewTMin]     = useState(0.01)
  const [viewTMax, setViewTMax]     = useState(4.0)
  const [refs, setRefs]             = useState<ReferenceSpectrum[]>([])
  const [hiddenRefs, setHiddenRefs] = useState<Set<string>>(new Set())

  // Overrides de color por el usuario (record ID → hex). Si no hay override, se usa la paleta por índice.
  const [recordColors, setRecordColors] = useState<Record<string, string>>({})
  const resolveRecordColor = (id: string, idx: number) =>
    recordColors[id] ?? colorFor(idx)
  const setRecordColor = (id: string, color: string) =>
    setRecordColors((prev) => ({ ...prev, [id]: color }))
  // Overrides de color por par RotD (opcional — por default hereda del H1)
  const [rotdColors, setRotdColors] = useState<Record<string, string>>({})
  const setRotdColor = (pairId: string, color: string) =>
    setRotdColors((prev) => ({ ...prev, [pairId]: color }))

  const resetColors = () => {
    setRecordColors({})
    setRotdColors({})
    setRefs((prev) => prev.map((r, i) => ({ ...r, color: defaultRefColor(i) })))
  }

  // RotD50 / RotD100 por par horizontal NS+EW
  const [rotdByPair, setRotdByPair] = useState<Record<string, RotDResult>>({})
  const [rotdLoading, setRotdLoading] = useState<Set<string>>(new Set())
  const [rotdError, setRotdError] = useState<Record<string, string>>({})
  const [rotdHidden, setRotdHidden] = useState<Set<string>>(new Set())  // ocultos del gráfico
  const [showRotD50, setShowRotD50] = useState(true)
  const [showRotD100, setShowRotD100] = useState(true)

  const chartRef = useRef<HTMLDivElement>(null)
  const theme    = useGmTheme()

  // ── Carga paralela al montar / cambiar parámetros ───────────────────────
  useEffect(() => {
    if (ids.length === 0) { setIsLoading(false); return }
    setIsLoading(true)
    loadCompareBundles(ids, { xi, T_max: TMax })
      .then((res) => {
        setBundles(res.bundles)
        setLoadErrors(res.errors)
      })
      .finally(() => setIsLoading(false))
  }, [idsRaw, xi, TMax])

  const pairs = useMemo(() => detectStationPairs(bundles), [bundles])

  // Invalidar RotD cuando cambian xi o T_max de cálculo
  useEffect(() => { setRotdByPair({}); setRotdError({}) }, [xi, TMax])

  // Si el rango visible excede el T_max de cálculo, bajarlo (nunca podemos mostrar
  // periodos que no se calcularon).
  useEffect(() => {
    if (viewTMax > TMax) setViewTMax(TMax)
  }, [TMax, viewTMax])

  async function requestRotD(pair: StationPair) {
    if (rotdByPair[pair.id] || rotdLoading.has(pair.id)) return
    setRotdLoading((s) => new Set(s).add(pair.id))
    setRotdError((e) => { const n = { ...e }; delete n[pair.id]; return n })
    try {
      const res = await computeRotD(pair.h1.id, pair.h2.id, {
        xi, T_max: TMax, n_points: 150, n_angles: 180,
      })
      setRotdByPair((prev) => ({ ...prev, [pair.id]: res }))
    } catch (err) {
      setRotdError((e) => ({ ...e, [pair.id]: err instanceof Error ? err.message : 'Error' }))
    } finally {
      setRotdLoading((s) => { const n = new Set(s); n.delete(pair.id); return n })
    }
  }
  const toggleRotDPair = (pair: StationPair) => {
    if (rotdByPair[pair.id]) {
      // Alternar visibilidad en el gráfico
      setRotdHidden((prev) => {
        const next = new Set(prev)
        if (next.has(pair.id)) next.delete(pair.id); else next.add(pair.id)
        return next
      })
    } else {
      requestRotD(pair)
    }
  }

  const toggleHidden = (id: string) => {
    setHiddenIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  const toggleHiddenRef = (id: string) => {
    setHiddenRefs((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  // ── Construcción de la gráfica ──────────────────────────────────────────
  useEffect(() => {
    if (!chartRef.current || typeof window === 'undefined' || !window.Plotly) return
    const traces: any[] = []
    const yUnit = tab === 'Sa' || tab === 'PSA' ? 'g' : tab === 'Sd' ? 'cm' : 'cm/s'

    bundles.forEach((b, idx) => {
      if (hiddenIds.has(b.id)) return
      const T = b.spectrum.T
      let y: number[]
      if (tab === 'Sa' || tab === 'PSA') y = (b.spectrum as any)[tab].map((v: number) => v / G)
      else if (tab === 'Sv' || tab === 'PSV') y = (b.spectrum as any)[tab].map((v: number) => v * 100)
      else y = b.spectrum.Sd.map((v) => v * 100)

      if (normalizePGA && (tab === 'Sa' || tab === 'PSA')) {
        const pga = b.intensity.pga_g || 1
        y = y.map((v) => v / pga)
      }

      traces.push({
        x: T, y,
        type: 'scatter', mode: 'lines',
        name: shortLabel(b.record),
        line: { color: resolveRecordColor(b.id, idx), width: 2.0, shape: 'spline' },
        hovertemplate: `<b>${shortLabel(b.record)}</b><br>T = %{x:.3f} s<br>${tab}${normalizePGA && (tab==='Sa'||tab==='PSA') ? '/PGA' : ''} = %{y:.4f}${normalizePGA && (tab==='Sa'||tab==='PSA') ? '' : ' '+yUnit}<extra></extra>`,
      })
    })

    // Referencias (NSR-10 / Microzonificación / CSV) — Sa en g directo
    refs.forEach((ref) => {
      if (hiddenRefs.has(ref.id)) return
      if (!(tab === 'Sa' || tab === 'Sd' || tab === 'Sv' || tab === 'PSA' || tab === 'PSV')) return
      const T = ref.puntos.map((p) => p.T)
      let y: number[]
      if (tab === 'Sa' || tab === 'PSA') y = ref.puntos.map((p) => p.Sa)
      else if (tab === 'Sd') y = ref.puntos.map((p) => p.Sd)
      else y = ref.puntos.map((p) => p.Sv)

      if (normalizePGA && (tab === 'Sa' || tab === 'PSA')) {
        // Normalización por PGA del propio espectro de referencia (Sa en T=0)
        const pga = y[0] || 1
        y = y.map((v) => v / pga)
      }

      traces.push({
        x: T, y,
        type: 'scatter', mode: 'lines',
        name: ref.label,
        line: { color: ref.color, width: 2.8, dash: 'dash' },
        hovertemplate: `<b>${ref.label}</b><br>T = %{x:.3f} s<br>${tab} = %{y:.4f}${normalizePGA && (tab==='Sa'||tab==='PSA') ? ' (norm.)' : ' '+yUnit}<extra></extra>`,
      })
    })

    // RotD50 / RotD100 — sólo aplica a Sa/PSA (son aceleraciones espectrales)
    if (tab === 'Sa' || tab === 'PSA') {
      pairs.forEach((p, idx) => {
        if (rotdHidden.has(p.id)) return
        const r = rotdByPair[p.id]
        if (!r) return
        const h1Idx = bundles.findIndex((b) => b.id === p.h1.id)
        const pairColor = rotdColors[p.id] ?? resolveRecordColor(p.h1.id, h1Idx >= 0 ? h1Idx : idx)
        const stationLabel = p.station

        const normPGA = (vals: number[]) => {
          if (!normalizePGA) return vals
          const pga = Math.max(vals[0] || 1e-9, 1e-9)
          return vals.map((v) => v / pga)
        }

        if (showRotD50) {
          traces.push({
            x: r.T,
            y: normPGA(r.RotD50.map((v: number) => v / G)),
            type: 'scatter', mode: 'lines',
            name: `RotD50 · ${stationLabel}`,
            line: { color: pairColor, width: 3.0, dash: 'dot' },
            hovertemplate: `<b>RotD50 · ${stationLabel}</b><br>T = %{x:.3f} s<br>Sa = %{y:.4f}${normalizePGA ? ' (norm.)' : ' g'}<extra></extra>`,
          })
        }
        if (showRotD100) {
          traces.push({
            x: r.T,
            y: normPGA(r.RotD100.map((v: number) => v / G)),
            type: 'scatter', mode: 'lines',
            name: `RotD100 · ${stationLabel}`,
            line: { color: pairColor, width: 3.4 },
            hovertemplate: `<b>RotD100 · ${stationLabel}</b><br>T = %{x:.3f} s<br>Sa = %{y:.4f}${normalizePGA ? ' (norm.)' : ' g'}<br>θ_max = %{customdata:.0f}°<extra></extra>`,
            customdata: r.angle_RotD100,
          })
        }
      })
    }

    if (traces.length === 0) {
      window.Plotly.purge(chartRef.current)
      return
    }

    const yTitle = normalizePGA && (tab === 'Sa' || tab === 'PSA')
      ? `${tab} / PGA (adim.)`
      : `${tab} (${yUnit})`

    window.Plotly.newPlot(
      chartRef.current,
      traces,
      baseLayout(theme, {
        margin: { l: 72, r: 24, t: 18, b: 56 },
        xaxis: {
          gridcolor: theme.grid, zerolinecolor: theme.zeroLine, linecolor: theme.gridStrong,
          showgrid: true, zeroline: false, ticks: 'outside', ticklen: 4, tickcolor: theme.gridStrong,
          tickfont: { size: 11, color: theme.textMuted },
          title: {
            text: '<b>Período T (s)</b>',
            font: { size: 13, color: theme.text, family: 'Inter, system-ui, sans-serif', weight: 700 },
          },
          type: scale === 'log' ? 'log' : 'linear',
          // Rango de vista (recorta en vivo sin recalcular). En log, Plotly espera log10 del valor.
          range: scale === 'log'
            ? [Math.log10(Math.max(viewTMin, 1e-6)), Math.log10(Math.max(viewTMax, viewTMin + 1e-6))]
            : [viewTMin, viewTMax],
          autorange: false,
        },
        yaxis: {
          gridcolor: theme.grid, zerolinecolor: theme.zeroLine, linecolor: theme.gridStrong,
          showgrid: true, zeroline: false, ticks: 'outside', ticklen: 4, tickcolor: theme.gridStrong,
          tickfont: { size: 11, color: theme.textMuted },
          title: {
            text: `<b>${yTitle}</b>`,
            font: { size: 13, color: theme.text, family: 'Inter, system-ui, sans-serif', weight: 700 },
          },
          type: scale === 'log' ? 'log' : 'linear',
        },
        legend: {
          orientation: 'h',
          y: 1.08, x: 0, xanchor: 'left',
          bgcolor: 'transparent',
          font: { size: 11, color: theme.text },
        },
        hovermode: 'closest',
      }),
      gmPlotConfig,
    )
  }, [bundles, refs, hiddenIds, hiddenRefs, tab, scale, normalizePGA, theme,
      pairs, rotdByPair, rotdHidden, showRotD50, showRotD100,
      viewTMin, viewTMax, recordColors, rotdColors])

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-screen">
      <AppHeader crumb="Comparación de registros" />
      <PageHero
        eyebrow={`Sismología · ${ids.length} registros seleccionados`}
        title="Comparación de espectros de respuesta"
        subtitle="Superposición multi-registro de Sa, Sd y Sv con referencias NSR-10, microzonificación oficial y espectros custom. Exportable."
        tone="blue"
        icon="seismograph"
        actions={
          <Link href="/ground-motion" className="pl-cta-ghost">
            ← Volver al catálogo
          </Link>
        }
      />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-7xl mx-auto px-6 py-6 space-y-5">
          {ids.length === 0 ? (
            <EmptyIds />
          ) : isLoading ? (
            <CompareSkeleton />
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-5">
              {/* Columna izquierda: gráficas + IMs */}
              <div className="space-y-5 min-w-0">
                {loadErrors.length > 0 && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                    <strong>{loadErrors.length}</strong> registro(s) no se pudieron cargar.
                  </div>
                )}

                {/* Toolbar de la gráfica */}
                <div className="pl-glass rounded-xl border border-[var(--panel-muted)]/40 p-3 flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-1">
                    {TABS.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => setTab(t.id)}
                        className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-all ${
                          tab === t.id
                            ? 'text-white shadow'
                            : 'bg-[var(--panel-muted)]/40 text-[var(--text-muted)] hover:text-[var(--text)] border border-[var(--panel-muted)]/50'
                        }`}
                        style={tab === t.id ? {
                          background: 'linear-gradient(135deg, #22d3ee 0%, #3b82f6 100%)',
                          boxShadow: '0 4px 14px -4px rgba(59,130,246,0.5)',
                        } : undefined}
                        title={t.tooltip}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                  <div className="h-5 w-px bg-[var(--panel-muted)]/60" />
                  <label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                    <span className="uppercase tracking-wider font-bold text-[10px]">Escala</span>
                    <select
                      value={scale}
                      onChange={(e) => setScale(e.target.value as 'linear' | 'log')}
                      className="bg-[var(--panel-muted)]/40 border border-[var(--panel-muted)]/50 rounded px-1.5 py-0.5 text-xs text-[var(--text)]"
                    >
                      <option value="log">log</option>
                      <option value="linear">lineal</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                    <span className="uppercase tracking-wider font-bold text-[10px]">ξ</span>
                    <select
                      value={xi}
                      onChange={(e) => setXi(Number(e.target.value))}
                      className="bg-[var(--panel-muted)]/40 border border-[var(--panel-muted)]/50 rounded px-1.5 py-0.5 text-xs text-[var(--text)]"
                    >
                      <option value="0.02">2%</option>
                      <option value="0.05">5%</option>
                      <option value="0.10">10%</option>
                      <option value="0.20">20%</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]"
                         title="T_max usado para calcular el espectro (cambiarlo re-calcula)">
                    <span className="uppercase tracking-wider font-bold text-[10px]">T calc</span>
                    <input
                      type="number" min={1} max={10} step={0.5}
                      value={TMax}
                      onChange={(e) => setTMax(Number(e.target.value) || 4)}
                      className="w-14 bg-[var(--panel-muted)]/40 border border-[var(--panel-muted)]/50 rounded px-1.5 py-0.5 text-xs text-[var(--text)]"
                    />
                    <span className="text-[10px] text-[var(--text-muted)]">s</span>
                  </label>
                  <div className="h-5 w-px bg-[var(--panel-muted)]/60" />
                  <div className="flex items-center gap-1.5"
                       title="Rango visible del eje T (sólo recorta, no recalcula)">
                    <span className="uppercase tracking-wider font-bold text-[10px] text-[var(--text-muted)]">Vista T</span>
                    <input
                      type="number" min={0.001} max={TMax} step={0.01}
                      value={viewTMin}
                      onChange={(e) => setViewTMin(Math.max(0.001, Number(e.target.value) || 0.01))}
                      className="w-14 bg-[var(--panel-muted)]/40 border border-[var(--panel-muted)]/50 rounded px-1.5 py-0.5 text-xs text-[var(--text)]"
                    />
                    <span className="text-[10px] text-[var(--text-muted)]">…</span>
                    <input
                      type="number" min={viewTMin + 0.01} max={TMax} step={0.1}
                      value={viewTMax}
                      onChange={(e) => setViewTMax(Math.min(TMax, Math.max(viewTMin + 0.01, Number(e.target.value) || 4)))}
                      className="w-14 bg-[var(--panel-muted)]/40 border border-[var(--panel-muted)]/50 rounded px-1.5 py-0.5 text-xs text-[var(--text)]"
                    />
                    <span className="text-[10px] text-[var(--text-muted)]">s</span>
                    <button
                      onClick={() => { setViewTMin(0.01); setViewTMax(TMax) }}
                      className="text-[9.5px] uppercase tracking-wider font-bold text-[var(--text-muted)] hover:text-cyan-500 transition-colors px-1.5 py-0.5 rounded border border-[var(--panel-muted)]/50"
                      title="Mostrar rango completo"
                    >
                      Reset
                    </button>
                  </div>
                  {(tab === 'Sa' || tab === 'PSA') && (
                    <label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                      <input
                        type="checkbox"
                        checked={normalizePGA}
                        onChange={(e) => setNormalize(e.target.checked)}
                        className="accent-cyan-500"
                      />
                      <span className="font-semibold">Normalizar por PGA</span>
                    </label>
                  )}
                  <div className="ml-auto flex items-center gap-1">
                    <ExportBtn onClick={() => exportCompareCSV(bundles, refs, tab, { xi, TMax }, buildRotDExports(pairs, rotdByPair, rotdHidden))}>CSV</ExportBtn>
                    <ExportBtn onClick={() => exportComparePNG(chartRef.current, tab)}>PNG</ExportBtn>
                    <ExportBtn onClick={() => exportComparePDF(chartRef.current, bundles, refs, tab, { xi, TMax, normalized: normalizePGA }, buildRotDExports(pairs, rotdByPair, rotdHidden))}>PDF</ExportBtn>
                  </div>
                </div>

                {/* Gráfica */}
                <div className="pl-glass rounded-xl border border-[var(--panel-muted)]/40 p-3">
                  <div ref={chartRef} className="w-full h-[520px]" />
                </div>

                {/* Leyenda de registros con toggle + color picker */}
                <div className="pl-glass rounded-xl border border-[var(--panel-muted)]/40 p-3">
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <div className="text-[10.5px] uppercase tracking-[0.14em] font-bold text-[var(--text-muted)]">
                      Registros ({bundles.length})
                    </div>
                    <button
                      onClick={resetColors}
                      className="text-[10px] uppercase tracking-wider font-bold text-[var(--text-muted)] hover:text-cyan-500 transition-colors"
                      title="Restablecer colores por defecto"
                    >
                      Restablecer colores
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {bundles.map((b, idx) => {
                      const hidden = hiddenIds.has(b.id)
                      const color = resolveRecordColor(b.id, idx)
                      return (
                        <div
                          key={b.id}
                          className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-semibold border transition-all ${
                            hidden ? 'opacity-40 border-dashed' : ''
                          }`}
                          style={{
                            background: `${color}15`,
                            borderColor: `${color}55`,
                            color,
                          }}
                        >
                          <label
                            className="relative inline-flex cursor-pointer"
                            title="Cambiar color"
                          >
                            <input
                              type="color"
                              value={color}
                              onChange={(e) => setRecordColor(b.id, e.target.value)}
                              className="absolute inset-0 h-full w-full opacity-0 cursor-pointer"
                            />
                            <span
                              className="h-2.5 w-2.5 rounded-full border border-white/20"
                              style={{ background: color, boxShadow: `0 0 6px ${color}` }}
                            />
                          </label>
                          <button
                            onClick={() => toggleHidden(b.id)}
                            className="cursor-pointer"
                            style={{ color }}
                          >
                            {shortLabel(b.record)}
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </div>

                {/* RotD50 / RotD100 por par NS+EW */}
                {pairs.length > 0 && (
                  <RotDPanel
                    pairs={pairs}
                    rotdByPair={rotdByPair}
                    rotdLoading={rotdLoading}
                    rotdError={rotdError}
                    rotdHidden={rotdHidden}
                    showRotD50={showRotD50}
                    showRotD100={showRotD100}
                    setShowRotD50={setShowRotD50}
                    setShowRotD100={setShowRotD100}
                    onToggle={toggleRotDPair}
                    bundles={bundles}
                    currentTab={tab}
                    colorFor={resolveRecordColor}
                    rotdColors={rotdColors}
                    setRotdColor={setRotdColor}
                  />
                )}

                {/* Tabla IMs */}
                <IntensityTable bundles={bundles} hiddenIds={hiddenIds} colorFor={resolveRecordColor} />
              </div>

              {/* Columna derecha: referencias */}
              <ReferenceSpectraPanel
                refs={refs}
                onChange={setRefs}
                hiddenRefs={hiddenRefs}
                onToggleHidden={toggleHiddenRef}
                TMax={TMax}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Tabla de medidas de intensidad ───────────────────────────────────────
function IntensityTable({
  bundles, hiddenIds, colorFor: colorForFn,
}: { bundles: CompareRecordBundle[]; hiddenIds: Set<string>; colorFor: (id: string, idx: number) => string }) {
  const visible = bundles.filter((b) => !hiddenIds.has(b.id))
  if (visible.length === 0) return null
  const fields: { key: keyof CompareRecordBundle['intensity']; label: string; unit: string; fmt: (v: number) => string }[] = [
    { key: 'pga_g',           label: 'PGA',        unit: 'g',     fmt: (v) => v.toFixed(4) },
    { key: 'pgv_cms',         label: 'PGV',        unit: 'cm/s',  fmt: (v) => v.toFixed(2) },
    { key: 'pgd_cm',          label: 'PGD',        unit: 'cm',    fmt: (v) => v.toFixed(2) },
    { key: 'arias_intensity_ms', label: 'Arias',    unit: 'm/s',   fmt: (v) => v.toFixed(3) },
    { key: 'cav_ms',          label: 'CAV',        unit: 'm/s',   fmt: (v) => v.toFixed(2) },
    { key: 'D5_95',           label: 'D5-95',      unit: 's',     fmt: (v) => v.toFixed(2) },
    { key: 'D5_75',           label: 'D5-75',      unit: 's',     fmt: (v) => v.toFixed(2) },
    { key: 'duration_record', label: 'Duración',   unit: 's',     fmt: (v) => v.toFixed(2) },
  ]
  return (
    <div className="pl-glass rounded-xl border border-[var(--panel-muted)]/40 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-[var(--panel-muted)]/40 flex items-center justify-between">
        <h3 className="text-sm font-bold text-[var(--text)] tracking-tight">Medidas de intensidad</h3>
        <span className="text-[10px] font-mono text-[var(--text-muted)]">
          {visible.length} registro{visible.length === 1 ? '' : 's'} visibles
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-bold">
              <th className="text-left px-3 py-2 sticky left-0 bg-[var(--panel-muted)]/30 backdrop-blur">Métrica</th>
              {visible.map((b, i) => {
                const globalIdx = bundles.findIndex((x) => x.id === b.id)
                const color = colorForFn(b.id, globalIdx)
                return (
                  <th key={b.id} className="text-right px-3 py-2 min-w-[110px]">
                    <div className="flex items-center justify-end gap-1.5">
                      <span
                        className="h-2 w-2 rounded-full flex-shrink-0"
                        style={{ background: color, boxShadow: `0 0 6px ${color}` }}
                      />
                      <span className="font-mono text-[10.5px] text-[var(--text)]" title={b.record.name}>
                        {shortLabel(b.record)}
                      </span>
                    </div>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f.label} className="border-t border-[var(--panel-muted)]/40">
                <td className="px-3 py-1.5 sticky left-0 bg-[var(--panel)]/60 backdrop-blur font-semibold text-[var(--text)]">
                  {f.label} <span className="text-[10px] font-mono text-[var(--text-muted)]">{f.unit}</span>
                </td>
                {visible.map((b) => (
                  <td key={b.id} className="px-3 py-1.5 text-right font-mono tabular-nums text-[var(--text)]">
                    {f.fmt(Number(b.intensity[f.key] ?? NaN))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function CompareSkeleton() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-5">
      <div className="space-y-5">
        <div className="pl-skeleton h-10 rounded-xl" />
        <div className="pl-skeleton h-[520px] rounded-xl" />
        <div className="pl-skeleton h-24 rounded-xl" />
      </div>
      <div className="pl-skeleton h-[700px] rounded-xl" />
    </div>
  )
}

// ── Panel RotD50/RotD100 por par horizontal ─────────────────────────────
function RotDPanel({
  pairs, rotdByPair, rotdLoading, rotdError, rotdHidden,
  showRotD50, showRotD100, setShowRotD50, setShowRotD100,
  onToggle, bundles, currentTab, colorFor: colorForFn,
  rotdColors, setRotdColor,
}: {
  pairs: StationPair[]
  rotdByPair: Record<string, RotDResult>
  rotdLoading: Set<string>
  rotdError: Record<string, string>
  rotdHidden: Set<string>
  showRotD50: boolean
  showRotD100: boolean
  setShowRotD50: (v: boolean) => void
  setShowRotD100: (v: boolean) => void
  onToggle: (pair: StationPair) => void
  bundles: CompareRecordBundle[]
  currentTab: SpecTab
  colorFor: (id: string, idx: number) => string
  rotdColors: Record<string, string>
  setRotdColor: (pairId: string, color: string) => void
}) {
  const applicable = currentTab === 'Sa' || currentTab === 'PSA'
  return (
    <div className="pl-glass rounded-xl border border-[var(--panel-muted)]/40 p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[10.5px] uppercase tracking-[0.14em] font-bold text-[var(--text-muted)]">
            Espectros rotacionalmente invariantes
          </div>
          <div className="text-sm font-bold text-[var(--text)] tracking-tight mt-0.5">
            RotD50 · RotD100 <span className="text-[11px] text-[var(--text-muted)] font-normal">(Boore 2010)</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
            <input type="checkbox" checked={showRotD50} onChange={(e) => setShowRotD50(e.target.checked)} className="accent-cyan-500" />
            <span className="font-semibold">RotD50</span>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
            <input type="checkbox" checked={showRotD100} onChange={(e) => setShowRotD100(e.target.checked)} className="accent-cyan-500" />
            <span className="font-semibold">RotD100</span>
          </label>
        </div>
      </div>

      {!applicable && (
        <div className="text-[11px] text-amber-600 dark:text-amber-400">
          RotD aplica sólo a <code>Sa</code> y <code>PSA</code>. Cambia la métrica para ver estos espectros en el gráfico.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {pairs.map((p) => {
          const loading = rotdLoading.has(p.id)
          const err = rotdError[p.id]
          const loaded = !!rotdByPair[p.id]
          const hidden = rotdHidden.has(p.id)
          const idx = bundles.findIndex((b) => b.id === p.h1.id)
          const fallbackColor = colorForFn(p.h1.id, idx >= 0 ? idx : 0)
          const color = rotdColors[p.id] ?? fallbackColor
          const active = loaded && !hidden
          return (
            <div
              key={p.id}
              role="button"
              tabIndex={0}
              aria-disabled={loading}
              onClick={() => !loading && onToggle(p)}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ' ') && !loading) {
                  e.preventDefault(); onToggle(p)
                }
              }}
              className={`group flex items-center gap-2 rounded-lg px-3 py-2 border transition-all text-left cursor-pointer ${
                active ? 'shadow-[0_0_14px_-6px]' : ''
              } ${loading ? 'opacity-60 cursor-wait' : 'hover:-translate-y-0.5'}`}
              style={{
                background: `${color}10`,
                borderColor: `${color}${active ? '99' : '45'}`,
                boxShadow: active ? `0 0 14px -6px ${color}aa` : undefined,
              }}
            >
              <label
                className="relative inline-flex cursor-pointer flex-shrink-0"
                title="Cambiar color del par (RotD50 y RotD100)"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setRotdColor(p.id, e.target.value)}
                  className="absolute inset-0 h-full w-full opacity-0 cursor-pointer"
                />
                <span
                  className="h-3 w-3 rounded-sm border border-white/20"
                  style={{ background: color, boxShadow: `0 0 6px ${color}` }}
                />
              </label>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-bold truncate" style={{ color }}>
                  {p.station}
                </div>
                <div className="text-[10px] text-[var(--text-muted)] font-mono truncate">
                  H1: {(p.h1.record.metadata_json?.component as string) || '—'} ·
                  H2: {(p.h2.record.metadata_json?.component as string) || '—'}
                  {loaded && rotdByPair[p.id].meta?.n_samples_used
                    ? ` · ${rotdByPair[p.id].meta.n_samples_used} pts`
                    : ''}
                </div>
                {err && <div className="text-[10px] text-rose-500 mt-0.5 truncate">{err}</div>}
              </div>
              <span className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded flex-shrink-0"
                    style={{
                      background: loading ? `${color}33` : loaded ? (hidden ? `${color}22` : `${color}44`) : 'transparent',
                      color,
                      border: `1px solid ${color}66`,
                    }}>
                {loading ? '…' : loaded ? (hidden ? 'Oculto' : 'ON') : 'Calcular'}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ExportBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="px-2 py-1 rounded-md text-[10.5px] font-bold uppercase tracking-wider
                 bg-[var(--panel-muted)]/40 text-[var(--text-muted)] border border-[var(--panel-muted)]/50
                 hover:text-cyan-500 hover:border-cyan-400/50 transition-all"
      title={`Exportar ${children}`}
    >
      {children}
    </button>
  )
}

function EmptyIds() {
  return (
    <div className="pl-glass rounded-2xl border border-[var(--panel-muted)]/40 p-8 text-center">
      <h2 className="text-lg font-bold text-[var(--text)]">Sin registros seleccionados</h2>
      <p className="text-sm text-[var(--text-muted)] mt-2 max-w-md mx-auto">
        Vuelve al catálogo, activa el modo <strong>Comparar registros</strong> y selecciona 2-8 acelerogramas.
      </p>
      <Link href="/ground-motion" className="pl-cta-primary mt-5 inline-flex">
        ← Volver al catálogo
      </Link>
    </div>
  )
}
