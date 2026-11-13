'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AppHeader } from '@/components/app-header'
import { PageHero } from '@/components/ui/page-hero'
import { useRequireAuth } from '@/lib/use-require-auth'
import type { GMRecord } from '@/lib/ground-motion-types'
import { deleteRecord, listRecords } from '@/lib/ground-motion-api'
import ImportWizard from '@/components/ground-motion/ImportWizard'

// ─────────────────────────────────────────────────────────────────────────────
// Agrupación jerárquica: campaña → región → estación → componente.
// Diseñado para manejar centenares de registros (p.ej. 201 del sismo
// de Colombia 10-ago-2026) + registros importados "a mano" sin campaña.
// ─────────────────────────────────────────────────────────────────────────────

type MetaField = string | number | null | undefined

function _str(md: GMRecord['metadata_json'], key: string): string | null {
  const v = md?.[key] as MetaField
  return v != null && v !== '' ? String(v) : null
}
function _num(md: GMRecord['metadata_json'], key: string): number | null {
  const v = md?.[key] as MetaField
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

const CAMPAIGN_FALLBACK = '__ad_hoc__'
const CAMPAIGN_FALLBACK_LABEL = 'Importados ad-hoc'
const REGION_FALLBACK = 'Sin región'

const REGION_COLOR: Record<string, string> = {
  CALI:      '#2563eb',
  MANIZALES: '#059669',
  PEREIRA:   '#d97706',
  SGC:       '#dc2626',
}

interface ComponentRow {
  record: GMRecord
  component: string          // NS | EW | V | ""
  pga_g: number | null
}
interface StationGroup {
  station: string
  region:  string
  soil:    string | null
  latitude: number | null
  longitude: number | null
  components: ComponentRow[]
}
interface RegionGroup {
  region: string
  color:  string
  stations: StationGroup[]
}
interface CampaignGroup {
  campaign: string
  label:    string
  eventDate: string | null
  regions:  RegionGroup[]
  total:    number
}

function groupRecords(records: GMRecord[]): CampaignGroup[] {
  const byCampaign = new Map<string, Map<string, Map<string, StationGroup>>>()
  const campaignLabels = new Map<string, string>()
  const campaignDates  = new Map<string, string>()

  for (const r of records) {
    const md = r.metadata_json || {}
    const campaign = _str(md, 'campaign') ?? CAMPAIGN_FALLBACK
    const label    = _str(md, 'campaign_label') ?? (campaign === CAMPAIGN_FALLBACK ? CAMPAIGN_FALLBACK_LABEL : campaign)
    const region   = _str(md, 'region')    ?? REGION_FALLBACK
    const station  = _str(md, 'station')   ?? r.name
    const component = (_str(md, 'component') ?? '').toUpperCase()
    campaignLabels.set(campaign, label)
    const edate = _str(md, 'event_date')
    if (edate && !campaignDates.has(campaign)) campaignDates.set(campaign, edate)

    const byRegion = byCampaign.get(campaign) ?? new Map()
    byCampaign.set(campaign, byRegion)
    const byStation = byRegion.get(region) ?? new Map()
    byRegion.set(region, byStation)

    const stg: StationGroup = byStation.get(station) ?? {
      station,
      region,
      soil:       _str(md, 'soil_class'),
      latitude:   _num(md, 'latitude'),
      longitude:  _num(md, 'longitude'),
      components: [],
    }
    stg.components.push({
      record: r,
      component,
      pga_g: null,  // cálculo on-demand opcional — el listado no bloquea por esto
    })
    byStation.set(station, stg)
  }

  const result: CampaignGroup[] = []
  for (const [campaign, byRegion] of byCampaign) {
    const regions: RegionGroup[] = []
    let total = 0
    for (const [region, byStation] of byRegion) {
      const stations = Array.from(byStation.values())
      stations.forEach((s) => {
        s.components.sort((a, b) => {
          const order = { NS: 0, EW: 1, V: 2, '': 3 } as Record<string, number>
          return (order[a.component] ?? 9) - (order[b.component] ?? 9)
        })
        total += s.components.length
      })
      stations.sort((a, b) => a.station.localeCompare(b.station, undefined, { numeric: true }))
      regions.push({
        region,
        color: REGION_COLOR[region] ?? '#64748b',
        stations,
      })
    }
    regions.sort((a, b) => a.region.localeCompare(b.region))
    result.push({
      campaign,
      label:     campaignLabels.get(campaign) ?? campaign,
      eventDate: campaignDates.get(campaign) ?? null,
      regions,
      total,
    })
  }
  // Ad-hoc al final
  result.sort((a, b) => {
    if (a.campaign === CAMPAIGN_FALLBACK) return 1
    if (b.campaign === CAMPAIGN_FALLBACK) return -1
    return a.campaign.localeCompare(b.campaign)
  })
  return result
}

export default function GroundMotionListPage() {
  useRequireAuth()
  const router = useRouter()

  const [records, setRecords]       = useState<GMRecord[]>([])
  const [isLoading, setIsLoading]   = useState(true)
  const [showWizard, setShowWizard] = useState(false)

  const [search, setSearch]         = useState('')
  const [activeCampaign, setActiveCampaign] = useState<string | 'all'>('all')
  const [activeRegion, setActiveRegion]     = useState<string | 'all'>('all')
  const [activeComponent, setActiveComponent] = useState<string | 'all'>('all')
  const [collapsedRegions, setCollapsedRegions] = useState<Set<string>>(new Set())

  useEffect(() => { loadRecords() }, [])

  async function loadRecords() {
    setIsLoading(true)
    try {
      const data = await listRecords()
      setRecords(data)
    } catch {}
    setIsLoading(false)
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`¿Eliminar el registro "${name}"?`)) return
    await deleteRecord(id)
    setRecords((prev) => prev.filter((r) => r.id !== id))
  }

  // ── Grupos + filtros ──────────────────────────────────────────────────────
  const grouped = useMemo(() => groupRecords(records), [records])

  const filtered: CampaignGroup[] = useMemo(() => {
    const q = search.trim().toLowerCase()
    return grouped
      .filter((c) => activeCampaign === 'all' || c.campaign === activeCampaign)
      .map((c) => ({
        ...c,
        regions: c.regions
          .filter((r) => activeRegion === 'all' || r.region === activeRegion)
          .map((r) => ({
            ...r,
            stations: r.stations
              .map((s) => ({
                ...s,
                components: s.components.filter((cmp) =>
                  activeComponent === 'all' || cmp.component === activeComponent,
                ),
              }))
              .filter((s) => s.components.length > 0)
              .filter((s) => {
                if (!q) return true
                return s.station.toLowerCase().includes(q)
                    || s.region.toLowerCase().includes(q)
                    || (s.soil ?? '').toLowerCase().includes(q)
                    || s.components.some((cmp) => cmp.record.name.toLowerCase().includes(q))
              }),
          }))
          .filter((r) => r.stations.length > 0),
      }))
      .filter((c) => c.regions.length > 0)
  }, [grouped, search, activeCampaign, activeRegion, activeComponent])

  const totalVisible = filtered.reduce(
    (acc, c) => acc + c.regions.reduce((a, r) => a + r.stations.reduce((x, s) => x + s.components.length, 0), 0),
    0,
  )

  // ── Opciones de filtro disponibles ────────────────────────────────────────
  const availableRegions = useMemo(() => {
    const src = activeCampaign === 'all'
      ? grouped.flatMap((c) => c.regions)
      : grouped.find((c) => c.campaign === activeCampaign)?.regions ?? []
    return Array.from(new Set(src.map((r) => r.region)))
  }, [grouped, activeCampaign])

  const availableComponents = useMemo(() => {
    const out = new Set<string>()
    for (const c of grouped) {
      if (activeCampaign !== 'all' && c.campaign !== activeCampaign) continue
      for (const r of c.regions) {
        if (activeRegion !== 'all' && r.region !== activeRegion) continue
        r.stations.forEach((s) => s.components.forEach((cmp) => out.add(cmp.component)))
      }
    }
    return Array.from(out).filter(Boolean).sort()
  }, [grouped, activeCampaign, activeRegion])

  // ── Wizard ────────────────────────────────────────────────────────────────
  if (showWizard) {
    return (
      <div className="flex flex-col h-screen">
        <AppHeader crumb="Análisis de Movimiento del Suelo" />
        <div className="flex-1 overflow-hidden flex flex-col">
          <div className="px-6 py-3 border-b border-[var(--border)] flex items-center gap-3">
            <button onClick={() => setShowWizard(false)} className="text-sm text-[var(--muted)] hover:text-[var(--foreground)]">
              ← Volver a registros
            </button>
            <h1 className="text-base font-semibold">Importar Acelerograma</h1>
          </div>
          <div className="flex-1 overflow-hidden">
            <ImportWizard
              onSuccess={(record) => {
                setShowWizard(false)
                router.push(`/ground-motion/${record.id}`)
              }}
              onCancel={() => setShowWizard(false)}
            />
          </div>
        </div>
      </div>
    )
  }

  const toggleRegion = (key: string) => {
    setCollapsedRegions((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-screen">
      <AppHeader crumb="Análisis de Movimiento del Suelo" />
      <PageHero
        eyebrow="Sismología · Acelerogramas"
        title="Análisis de Movimiento del Suelo"
        subtitle="Explora el catálogo de acelerogramas por campaña y región. Historia de tiempo, FFT, espectros de respuesta y medidas de intensidad (PGA, PGV, Arias, CAV, D5-95)."
        tone="blue"
        icon="seismograph"
        actions={
          <button
            onClick={() => setShowWizard(true)}
            className="pl-cta-primary"
            style={{ background: "linear-gradient(135deg, #3b82f6 0%, #6366f1 100%)" }}
          >
            <span className="text-base leading-none">+</span>
            Importar Registro
          </button>
        }
      />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-6 py-6 space-y-5">

          {/* Stats globales */}
          {!isLoading && records.length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatPill label="Registros totales" value={records.length} />
              <StatPill label="Campañas"
                value={grouped.filter((c) => c.campaign !== CAMPAIGN_FALLBACK).length
                     + (grouped.some((c) => c.campaign === CAMPAIGN_FALLBACK) ? 1 : 0)} />
              <StatPill label="Regiones"
                value={new Set(grouped.flatMap((c) => c.regions.map((r) => r.region))).size} />
              <StatPill label="Estaciones únicas"
                value={new Set(grouped.flatMap((c) => c.regions.flatMap((r) => r.stations.map((s) => s.station)))).size} />
            </div>
          )}

          {/* Filtros */}
          {!isLoading && records.length > 0 && (
            <div className="rounded-xl bg-[var(--surface-alt)] border border-[var(--border)] p-4 space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-center">
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Buscar por estación, región, suelo o nombre…"
                  className="w-full rounded-lg bg-[var(--surface)] px-4 py-2 text-sm border border-[var(--border)]"
                />
                <div className="text-xs text-[var(--muted)] font-mono whitespace-nowrap">
                  {totalVisible} / {records.length} registros
                </div>
              </div>

              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] uppercase tracking-wider text-[var(--muted)] mr-1">Campaña:</span>
                <Chip active={activeCampaign === 'all'} onClick={() => setActiveCampaign('all')}>Todas</Chip>
                {grouped.map((c) => (
                  <Chip key={c.campaign}
                    active={activeCampaign === c.campaign}
                    onClick={() => setActiveCampaign(c.campaign)}>
                    {c.label}
                    <span className="ml-1 text-[10px] opacity-75 font-mono">· {c.total}</span>
                  </Chip>
                ))}
              </div>

              {availableRegions.length > 1 && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[10px] uppercase tracking-wider text-[var(--muted)] mr-1">Región:</span>
                  <Chip active={activeRegion === 'all'} onClick={() => setActiveRegion('all')}>Todas</Chip>
                  {availableRegions.map((r) => (
                    <Chip key={r} active={activeRegion === r}
                      onClick={() => setActiveRegion(r)}
                      color={REGION_COLOR[r]}>
                      {r}
                    </Chip>
                  ))}
                </div>
              )}

              {availableComponents.length > 1 && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[10px] uppercase tracking-wider text-[var(--muted)] mr-1">Componente:</span>
                  <Chip active={activeComponent === 'all'} onClick={() => setActiveComponent('all')}>Todos</Chip>
                  {availableComponents.map((c) => (
                    <Chip key={c} active={activeComponent === c}
                      onClick={() => setActiveComponent(c)}>
                      {c}
                    </Chip>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Capacidades del módulo (solo cuando está vacío) */}
          {records.length === 0 && !isLoading && (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-4">
              {[
                { icon: '📥', title: 'Importación Universal', desc: 'TXT, CSV, XLS, XLSX. Detección automática de estructura.' },
                { icon: '📊', title: 'Historia de Tiempo', desc: 'Aceleración, velocidad y desplazamiento (integración numérica).' },
                { icon: '⚡', title: 'Medidas de Intensidad', desc: 'PGA, PGV, PGD, Arias, CAV, D5-95, RMS y más.' },
                { icon: '🔧', title: 'Procesamiento de Señal', desc: 'Corrección de línea base y filtrado Butterworth.' },
                { icon: '📈', title: 'Análisis Frecuencial', desc: 'Espectro de amplitud FFT y Welch PSD.' },
                { icon: '🌊', title: 'Espectro de Respuesta', desc: 'Sd, Sv, Sa, PSA, PSV — Newmark-β — múltiples ξ.' },
              ].map((c) => (
                <div key={c.title} className="bg-[var(--surface-alt)] rounded-xl p-4 border border-[var(--border)]">
                  <div className="text-2xl mb-2">{c.icon}</div>
                  <div className="text-sm font-semibold">{c.title}</div>
                  <div className="text-xs text-[var(--muted)] mt-1">{c.desc}</div>
                </div>
              ))}
            </div>
          )}

          {/* Estado vacío / loading */}
          {isLoading ? (
            <div className="text-center py-12 text-[var(--muted)]">Cargando registros…</div>
          ) : records.length === 0 ? (
            <div className="text-center py-16 flex flex-col items-center gap-4">
              <div className="w-16 h-16 rounded-full bg-[var(--surface-alt)] flex items-center justify-center text-3xl">📋</div>
              <div>
                <p className="font-medium text-[var(--foreground)]">Sin registros todavía</p>
                <p className="text-sm text-[var(--muted)] mt-1">Importa tu primer acelerograma para comenzar</p>
              </div>
              <button
                onClick={() => setShowWizard(true)}
                className="px-6 py-2.5 bg-[var(--accent)] text-white rounded-xl text-sm font-medium hover:opacity-90 transition-opacity">
                Importar Registro
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-10 text-[var(--muted)]">
              Ningún registro coincide con los filtros aplicados.
            </div>
          ) : (
            <div className="space-y-5">
              {filtered.map((c) => (
                <section key={c.campaign} className="space-y-3">
                  <header className="flex items-baseline justify-between gap-3 border-b border-[var(--border)] pb-2">
                    <div>
                      <h2 className="text-base font-bold text-[var(--foreground)]">
                        {c.label}
                      </h2>
                      <p className="text-xs text-[var(--muted)] font-mono">
                        {c.eventDate ?? '—'} · {c.total} componente{c.total === 1 ? '' : 's'}
                        {' · '}
                        {c.regions.length} región{c.regions.length === 1 ? '' : 'es'}
                      </p>
                    </div>
                  </header>

                  {c.regions.map((r) => {
                    const regionKey = `${c.campaign}/${r.region}`
                    const isCollapsed = collapsedRegions.has(regionKey)
                    const totalInRegion = r.stations.reduce((acc, s) => acc + s.components.length, 0)
                    return (
                      <div key={regionKey} className="rounded-xl bg-[var(--surface-alt)] border border-[var(--border)] overflow-hidden">
                        <button
                          onClick={() => toggleRegion(regionKey)}
                          className="w-full flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-[var(--surface)] transition-colors text-left">
                          <div className="flex items-center gap-3">
                            <span className="h-3 w-3 rounded-full flex-shrink-0" style={{ background: r.color }} />
                            <span className="text-sm font-semibold text-[var(--foreground)]">{r.region}</span>
                            <span className="text-xs text-[var(--muted)] font-mono">
                              {r.stations.length} estación{r.stations.length === 1 ? '' : 'es'} · {totalInRegion} componente{totalInRegion === 1 ? '' : 's'}
                            </span>
                          </div>
                          <span className="text-[var(--muted)] text-sm">{isCollapsed ? '▸' : '▾'}</span>
                        </button>

                        {!isCollapsed && (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 p-3 border-t border-[var(--border)]">
                            {r.stations.map((s) => (
                              <StationCard key={`${r.region}/${s.station}`}
                                station={s} regionColor={r.color}
                                onDelete={handleDelete} />
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Sub-componentes ─────────────────────────────────────────────────────────

function StatPill({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-[var(--surface-alt)] border border-[var(--border)] rounded-xl px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-[var(--muted)]">{label}</div>
      <div className="text-2xl font-mono font-bold mt-1 text-[var(--foreground)]">{value.toLocaleString()}</div>
    </div>
  )
}

function Chip({
  children, active, onClick, color,
}: {
  children: React.ReactNode
  active: boolean
  onClick: () => void
  color?: string
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 rounded-md text-xs font-medium transition ${
        active
          ? 'bg-[var(--accent)] text-white'
          : 'bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--foreground)] border border-[var(--border)]'
      }`}
      style={active && color ? { background: color, color: '#fff' } : undefined}>
      {children}
    </button>
  )
}

const COMP_COLOR: Record<string, string> = {
  NS: '#4f46e5',  // índigo
  EW: '#059669',  // esmeralda
  V:  '#64748b',  // gris
}

function StationCard({
  station, regionColor, onDelete,
}: {
  station: StationGroup
  regionColor: string
  onDelete: (id: string, name: string) => void
}) {
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-3 hover:border-[var(--accent)]/50 transition-colors">
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="font-mono font-bold text-sm text-[var(--foreground)] truncate" style={{ color: regionColor }}>
            {station.station}
          </span>
          {station.soil && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex-shrink-0">
              {station.soil}
            </span>
          )}
        </div>
        {station.latitude != null && station.longitude != null && (
          <span className="text-[10px] font-mono text-[var(--muted)] flex-shrink-0">
            {station.latitude.toFixed(2)}, {station.longitude.toFixed(2)}
          </span>
        )}
      </div>

      <div className="space-y-1">
        {station.components.map((cmp) => {
          const compLabel = cmp.component || '—'
          const color = COMP_COLOR[cmp.component] ?? '#94a3b8'
          const r = cmp.record
          const dur = r.duration ? `${r.duration.toFixed(1)} s` : null
          const fs  = r.dt ? `${(1 / r.dt).toFixed(0)} Hz` : null
          const npts = r.n_samples?.toLocaleString() ?? null
          return (
            <div key={r.id} className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--surface-alt)] transition-colors">
              <Link href={`/ground-motion/${r.id}`} className="flex items-center gap-2 flex-1 min-w-0">
                <span
                  className="font-mono text-[11px] font-bold px-1.5 py-0.5 rounded flex-shrink-0 w-7 text-center"
                  style={{ background: `${color}22`, color }}>
                  {compLabel}
                </span>
                <span className="text-xs text-[var(--foreground)] truncate font-mono">
                  {r.name}
                </span>
                <span className="text-[10px] text-[var(--muted)] font-mono ml-auto flex-shrink-0">
                  {[dur, fs, npts].filter(Boolean).join(' · ')}
                </span>
              </Link>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(r.id, r.name) }}
                className="p-1 text-[var(--muted)] hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity text-xs"
                title="Eliminar registro">
                ✕
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
