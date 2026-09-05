'use client'

import { useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Script from 'next/script'
import { AppHeader } from '@/components/app-header'
import { useRequireAuth } from '@/lib/use-require-auth'
import {
  FFTResult,
  GMRecord,
  IntensityMeasures,
  TimeseriesData,
} from '@/lib/ground-motion-types'
import {
  computeFFT,
  computeIntensity,
  getRecord,
  getTimeseries,
} from '@/lib/ground-motion-api'
import TimeHistoryPanel from '@/components/ground-motion/TimeHistoryPanel'
import IntensityPanel from '@/components/ground-motion/IntensityPanel'
import FrequencyPanel from '@/components/ground-motion/FrequencyPanel'
import ProcessingPanel from '@/components/ground-motion/ProcessingPanel'
import SpectrumPanel from '@/components/ground-motion/SpectrumPanel'
import InelasticSpectrumPanel from '@/components/ground-motion/InelasticSpectrumPanel'

type Tab = 'overview' | 'timeseries' | 'processing' | 'frequency' | 'intensity' | 'spectrum' | 'inelastic'

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'overview',   label: 'Resumen',          icon: '◎' },
  { id: 'timeseries', label: 'Historia de Tiempo', icon: '≈' },
  { id: 'processing', label: 'Procesamiento',      icon: '⚙' },
  { id: 'frequency',  label: 'Frecuencia',          icon: '∫' },
  { id: 'intensity',  label: 'Intensidad',          icon: '⚡' },
  { id: 'spectrum',   label: 'Espectro',            icon: '📈' },
  { id: 'inelastic',  label: 'Inelástico',          icon: '⤴' },
]

export default function GroundMotionDetailPage() {
  useRequireAuth()
  const params = useParams()
  const id     = params.id as string

  const [record, setRecord]       = useState<GMRecord | null>(null)
  const [tab, setTab]             = useState<Tab>('overview')
  const [tsData, setTsData]       = useState<TimeseriesData | null>(null)
  const [imData, setImData]       = useState<IntensityMeasures | null>(null)
  const [fftData, setFftData]     = useState<FFTResult | null>(null)
  const [isLoading, setIsLoading] = useState<Record<string, boolean>>({})
  const [error, setError]         = useState<string | null>(null)
  const [plotlyReady, setPlotlyReady] = useState(false)

  const G = 9.80665

  // ── Cargar registro ───────────────────────────────────────────────────────

  useEffect(() => {
    getRecord(id).then(setRecord).catch(e => setError(e.message))
  }, [id])

  // ── Cargar datos por pestaña ──────────────────────────────────────────────

  useEffect(() => {
    if (!record || !plotlyReady) return

    if (tab === 'timeseries' && !tsData) loadTimeseries()
    if (tab === 'intensity'  && !imData) loadIntensity()
    if (tab === 'frequency'  && !fftData) loadFFT()
    // El espectro se carga por botón (lazy)
  }, [tab, record, plotlyReady])

  const setLoading = (key: string, v: boolean) =>
    setIsLoading(prev => ({ ...prev, [key]: v }))

  const loadTimeseries = async () => {
    setLoading('ts', true)
    try {
      const d = await getTimeseries(id)
      setTsData(d)
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Error') }
    setLoading('ts', false)
  }

  const loadIntensity = async () => {
    setLoading('im', true)
    try {
      const d = await computeIntensity(id)
      setImData(d)
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Error') }
    setLoading('im', false)
  }

  const loadFFT = async () => {
    setLoading('fft', true)
    try {
      const d = await computeFFT(id)
      setFftData(d)
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Error') }
    setLoading('fft', false)
  }

  if (!record && !error) {
    return (
      <div className="flex flex-col h-screen">
        <AppHeader crumb="Análisis de Movimiento del Suelo" />
        <div className="flex-1 flex items-center justify-center text-[var(--muted)]">Cargando…</div>
      </div>
    )
  }

  if (error && !record) {
    return (
      <div className="flex flex-col h-screen">
        <AppHeader crumb="Análisis de Movimiento del Suelo" />
        <div className="flex-1 flex items-center justify-center text-red-400">{error}</div>
      </div>
    )
  }

  const pga_g_str = (tsData?.pga_ms2 ? (tsData.pga_ms2 / G).toFixed(4) + ' g' :
                     imData           ? imData.pga_g.toFixed(4) + ' g' : '—')

  return (
    <>
      <Script
        src="https://cdn.plot.ly/plotly-2.35.2.min.js"
        strategy="beforeInteractive"
        onLoad={() => setPlotlyReady(true)}
      />

      <div className="flex flex-col h-screen">
        <AppHeader crumb="Análisis de Movimiento del Suelo" />

        <div className="flex flex-1 min-h-0">
          {/* ── Barra lateral ─────────────────────────────────────────────── */}
          <aside className="w-52 flex-shrink-0 border-r border-[var(--border)] flex flex-col bg-[var(--surface)]">
            {/* Info del registro */}
            <div className="px-4 py-4 border-b border-[var(--border)]">
              <p className="text-xs text-[var(--muted)] mb-0.5">Registro</p>
              <p className="text-sm font-semibold leading-tight truncate">{record!.name}</p>
              <p className="text-xs text-[var(--muted)] mt-1 truncate">{record!.source_file}</p>
            </div>

            {/* Estadísticas rápidas */}
            <div className="px-4 py-3 border-b border-[var(--border)] flex flex-col gap-1.5">
              <SidebarStat label="Δt" value={record!.dt ? record!.dt.toFixed(5) + ' s' : '—'} />
              <SidebarStat label="Muestras" value={record!.n_samples?.toLocaleString() ?? '—'} />
              <SidebarStat label="Duración" value={record!.duration ? record!.duration.toFixed(2) + ' s' : '—'} />
              <SidebarStat label="fs" value={record!.dt ? (1 / record!.dt).toFixed(1) + ' Hz' : '—'} />
              <SidebarStat label="Nyquist" value={record!.dt ? (0.5 / record!.dt).toFixed(1) + ' Hz' : '—'} />
              <SidebarStat label="Unidad" value={record!.acc_unit_original ?? '—'} />
              {pga_g_str !== '—' && <SidebarStat label="PGA" value={pga_g_str} accent />}
            </div>

            {/* Navegación */}
            <nav className="flex-1 px-2 py-2">
              {TABS.map(t => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm mb-0.5 transition-colors text-left
                    ${tab === t.id
                      ? 'bg-[var(--accent)]/10 text-[var(--accent)] font-medium'
                      : 'text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--surface-alt)]'}`}
                >
                  <span className="text-base w-5 text-center">{t.icon}</span>
                  {t.label}
                </button>
              ))}
            </nav>

            {/* Metadatos */}
            {Object.keys(record!.metadata_json || {}).length > 0 && (
              <div className="px-4 py-3 border-t border-[var(--border)]">
                <p className="text-xs text-[var(--muted)] font-medium mb-2">Metadatos</p>
                {Object.entries(record!.metadata_json || {})
                  .filter(([, v]) => v)
                  .map(([k, v]) => (
                    <div key={k} className="flex gap-1 text-xs mb-1">
                      <span className="text-[var(--muted)] capitalize flex-shrink-0">{k}:</span>
                      <span className="truncate">{String(v)}</span>
                    </div>
                  ))}
              </div>
            )}
          </aside>

          {/* ── Contenido principal ───────────────────────────────────────── */}
          <main className="flex-1 overflow-y-auto px-6 py-6">

            {/* ── Resumen ────────────────────────────────────────────────── */}
            {tab === 'overview' && (
              <div className="flex flex-col gap-6 max-w-3xl">
                <div>
                  <h2 className="text-xl font-bold">{record!.name}</h2>
                  <p className="text-sm text-[var(--muted)] mt-1">{record!.source_file}</p>
                </div>

                {/* KPIs rápidos */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {[
                    { label: 'Muestras',  value: record!.n_samples?.toLocaleString() ?? '—', unit: 'pts' },
                    { label: 'Δt',        value: record!.dt?.toFixed(5) ?? '—',              unit: 's'   },
                    { label: 'Duración',  value: record!.duration?.toFixed(3) ?? '—',        unit: 's'   },
                    { label: 'Nyquist',   value: record!.dt ? (0.5 / record!.dt).toFixed(1) : '—', unit: 'Hz' },
                  ].map(k => (
                    <div key={k.label} className="bg-[var(--surface-alt)] rounded-xl px-4 py-3">
                      <div className="text-xs text-[var(--muted)]">{k.label}</div>
                      <div className="text-xl font-bold font-mono mt-1">{k.value}</div>
                      <div className="text-xs text-[var(--muted)]">{k.unit}</div>
                    </div>
                  ))}
                </div>

                {/* Guía de flujo */}
                <div className="bg-[var(--surface-alt)] rounded-xl p-5">
                  <p className="text-sm font-semibold mb-3">Flujo de trabajo sugerido</p>
                  <ol className="flex flex-col gap-2">
                    {[
                      { tab: 'timeseries', label: 'Revisar historia de tiempo (a, v, d)' },
                      { tab: 'processing', label: 'Aplicar corrección de línea base y/o filtrado' },
                      { tab: 'frequency',  label: 'Analizar contenido frecuencial (FFT)' },
                      { tab: 'intensity',  label: 'Calcular medidas de intensidad (PGA, Arias, CAV, D5-95)' },
                      { tab: 'spectrum',   label: 'Calcular espectro de respuesta elástico (Newmark-β)' },
                      { tab: 'inelastic',  label: 'Calcular espectros inelásticos — ductilidad constante (EPP)' },
                    ].map((step, i) => (
                      <li key={i}
                        onClick={() => setTab(step.tab as Tab)}
                        className="flex items-center gap-3 cursor-pointer hover:text-[var(--accent)] transition-colors group">
                        <span className="w-6 h-6 rounded-full bg-[var(--surface)] flex items-center justify-center text-xs font-bold flex-shrink-0
                                         group-hover:bg-[var(--accent)] group-hover:text-white transition-colors">
                          {i + 1}
                        </span>
                        <span className="text-sm">{step.label}</span>
                      </li>
                    ))}
                  </ol>
                </div>

                {/* Info del registro */}
                <div className="text-xs text-[var(--muted)] grid grid-cols-2 gap-2">
                  <div>Creado: {new Date(record!.created_at).toLocaleDateString('es-CO')}</div>
                  <div>ID: <span className="font-mono">{record!.id.slice(0, 8)}…</span></div>
                </div>
              </div>
            )}

            {/* ── Historia de Tiempo ─────────────────────────────────────── */}
            {tab === 'timeseries' && (
              <div>
                <h2 className="text-lg font-semibold mb-4">Historia de Tiempo</h2>
                {isLoading.ts ? (
                  <Loading text="Calculando velocidad y desplazamiento…" />
                ) : tsData ? (
                  <TimeHistoryPanel data={tsData} accUnit={record!.acc_unit_original ?? 'g'} />
                ) : (
                  <button onClick={loadTimeseries}
                    className="px-6 py-2.5 bg-[var(--accent)] text-white rounded-xl text-sm font-medium hover:opacity-90">
                    Cargar Historia de Tiempo
                  </button>
                )}
              </div>
            )}

            {/* ── Procesamiento ──────────────────────────────────────────── */}
            {tab === 'processing' && (
              <div>
                <h2 className="text-lg font-semibold mb-4">Procesamiento de Señal</h2>
                <ProcessingPanel
                  recordId={id}
                  component=""
                  onProcessed={(res) => {
                    // Actualizar historia de tiempo tras procesamiento
                    if (tsData) {
                      setTsData(prev => prev ? {
                        ...prev,
                        a_ms2: res.a_ms2,
                        v_ms:  res.v_ms,
                        d_m:   res.d_m,
                        pga_ms2: Math.max(...res.a_ms2.map(Math.abs)),
                      } : null)
                    }
                  }}
                />
              </div>
            )}

            {/* ── Frecuencia ─────────────────────────────────────────────── */}
            {tab === 'frequency' && (
              <div>
                <h2 className="text-lg font-semibold mb-4">Análisis Frecuencial</h2>
                {isLoading.fft ? (
                  <Loading text="Calculando FFT…" />
                ) : fftData ? (
                  <FrequencyPanel data={fftData} />
                ) : (
                  <button onClick={loadFFT}
                    className="px-6 py-2.5 bg-[var(--accent)] text-white rounded-xl text-sm font-medium hover:opacity-90">
                    Calcular FFT
                  </button>
                )}
              </div>
            )}

            {/* ── Intensidad ─────────────────────────────────────────────── */}
            {tab === 'intensity' && (
              <div>
                <h2 className="text-lg font-semibold mb-4">Medidas de Intensidad</h2>
                {isLoading.im ? (
                  <Loading text="Calculando medidas de intensidad…" />
                ) : imData ? (
                  <IntensityPanel data={imData} />
                ) : (
                  <button onClick={loadIntensity}
                    className="px-6 py-2.5 bg-[var(--accent)] text-white rounded-xl text-sm font-medium hover:opacity-90">
                    Calcular Medidas de Intensidad
                  </button>
                )}
              </div>
            )}

            {/* ── Espectro ───────────────────────────────────────────────── */}
            {tab === 'spectrum' && (
              <div>
                <h2 className="text-lg font-semibold mb-4">Espectro de Respuesta Elástico</h2>
                {plotlyReady && <SpectrumPanel recordId={id} component="" />}
              </div>
            )}

            {/* ── Inelástico ─────────────────────────────────────────────── */}
            {tab === 'inelastic' && (
              <div>
                <h2 className="text-lg font-semibold mb-1">Espectros de Respuesta Inelástica</h2>
                <p className="text-xs text-[var(--muted)] mb-4">
                  Espectros de ductilidad constante — SDOF EPP, Newmark-β — μ = 1.5, 2, 3, 4, 6
                </p>
                {plotlyReady && <InelasticSpectrumPanel recordId={id} component="" />}
              </div>
            )}
          </main>
        </div>
      </div>
    </>
  )
}

function SidebarStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-[var(--muted)]">{label}</span>
      <span className={`text-xs font-mono font-semibold ${accent ? 'text-[var(--accent)]' : ''}`}>{value}</span>
    </div>
  )
}

function Loading({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-[var(--muted)]">
      <div className="w-8 h-8 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin mb-3" />
      <p className="text-sm">{text}</p>
    </div>
  )
}
