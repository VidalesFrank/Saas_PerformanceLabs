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
import { regionColor, soilTone, SOIL_TONE_CLASS } from '@/lib/region-colors'

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
        color: regionColor(region),
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

const MAX_COMPARE = 8
const MIN_COMPARE = 2

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

  // Modo comparación — permite seleccionar 2-8 registros para abrir /ground-motion/compare
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        if (next.size >= MAX_COMPARE) return prev
        next.add(id)
      }
      return next
    })
  }
  const clearSelection = () => setSelectedIds(new Set())
  const exitSelectMode = () => { setSelectMode(false); clearSelection() }
  const enterSelectMode = () => { setSelectMode(true) }
  const goCompare = () => {
    if (selectedIds.size < MIN_COMPARE) return
    const ids = Array.from(selectedIds).join(',')
    router.push(`/ground-motion/compare?ids=${encodeURIComponent(ids)}`)
  }

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
          <div className="flex items-center gap-2">
            {selectMode ? (
              <button
                onClick={exitSelectMode}
                className="pl-cta-ghost"
              >
                Cancelar selección
              </button>
            ) : (
              <button
                onClick={enterSelectMode}
                className="pl-cta-ghost"
                title="Selecciona 2-8 registros para comparar sus espectros"
              >
                <span className="text-base leading-none">⇆</span>
                Comparar registros
              </button>
            )}
            <button
              onClick={() => setShowWizard(true)}
              className="pl-cta-primary"
              style={{ background: "linear-gradient(135deg, #3b82f6 0%, #6366f1 100%)" }}
            >
              <span className="text-base leading-none">+</span>
              Importar Registro
            </button>
          </div>
        }
      />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-6 py-6 space-y-5">

          {isLoading ? (
            <GroundMotionSkeleton />
          ) : records.length === 0 ? (
            <EmptyStateTech onImport={() => setShowWizard(true)} />
          ) : (
            <>
              {/* Stats globales */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatPill idx={0} label="Registros totales" value={records.length} />
                <StatPill idx={1} label="Campañas"
                  value={grouped.filter((c) => c.campaign !== CAMPAIGN_FALLBACK).length
                       + (grouped.some((c) => c.campaign === CAMPAIGN_FALLBACK) ? 1 : 0)} />
                <StatPill idx={2} label="Regiones"
                  value={new Set(grouped.flatMap((c) => c.regions.map((r) => r.region))).size} />
                <StatPill idx={3} label="Estaciones únicas"
                  value={new Set(grouped.flatMap((c) => c.regions.flatMap((r) => r.stations.map((s) => s.station)))).size} />
              </div>

              {/* Filtros */}
              <div className="pl-glass rounded-xl border border-[var(--panel-muted)]/40 p-4 space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-center">
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Buscar por estación, región, suelo o nombre…"
                    className="w-full rounded-lg bg-[var(--panel-muted)]/40 px-4 py-2 text-sm text-[var(--text)] border border-[var(--panel-muted)]/50 focus:border-[var(--color-accent)]/60 focus:outline-none transition-colors"
                  />
                  <div className="text-xs text-[var(--text-muted)] font-mono whitespace-nowrap">
                    <span className="font-semibold text-[var(--text)]">{totalVisible}</span>
                    {" / "}
                    {records.length} registros
                  </div>
                </div>

                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-bold mr-1">Campaña:</span>
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
                    <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-bold mr-1">Región:</span>
                    <Chip active={activeRegion === 'all'} onClick={() => setActiveRegion('all')}>Todas</Chip>
                    {availableRegions.map((r) => (
                      <Chip key={r} active={activeRegion === r}
                        onClick={() => setActiveRegion(r)}
                        color={regionColor(r)}>
                        {r}
                      </Chip>
                    ))}
                  </div>
                )}

                {availableComponents.length > 1 && (
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-bold mr-1">Componente:</span>
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

              {/* Lista */}
              {filtered.length === 0 ? (
                <div className="text-center py-10 text-[var(--text-muted)] text-sm">
                  Ningún registro coincide con los filtros aplicados.
                </div>
              ) : (
                <div className="space-y-6">
                  {filtered.map((c) => (
                    <section key={c.campaign} className="space-y-3">
                      <CampaignHeader label={c.label} eventDate={c.eventDate}
                        totalComponents={c.total} nRegions={c.regions.length} />

                      {c.regions.map((r) => {
                        const regionKey = `${c.campaign}/${r.region}`
                        const isCollapsed = collapsedRegions.has(regionKey)
                        const totalInRegion = r.stations.reduce((acc, s) => acc + s.components.length, 0)
                        return (
                          <div key={regionKey} className="pl-glass rounded-xl border border-[var(--panel-muted)]/40 overflow-hidden">
                            <button
                              onClick={() => toggleRegion(regionKey)}
                              className="w-full flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-[var(--panel-muted)]/30 transition-colors text-left">
                              <div className="flex items-center gap-3">
                                <span
                                  className="h-2.5 w-2.5 rounded-full flex-shrink-0"
                                  style={{ background: r.color, boxShadow: `0 0 8px ${r.color}` }}
                                />
                                <span className="text-sm font-bold text-[var(--text)] tracking-tight">{r.region}</span>
                                <span className="text-xs text-[var(--text-muted)] font-mono">
                                  {r.stations.length} estación{r.stations.length === 1 ? '' : 'es'} · {totalInRegion} componente{totalInRegion === 1 ? '' : 's'}
                                </span>
                              </div>
                              <span className="text-[var(--text-muted)] text-sm transition-transform" style={{ transform: isCollapsed ? 'rotate(0deg)' : 'rotate(90deg)' }}>▸</span>
                            </button>

                            {!isCollapsed && (
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 p-3 border-t border-[var(--panel-muted)]/40">
                                {r.stations.map((s) => (
                                  <StationCard key={`${r.region}/${s.station}`}
                                    station={s} regionColor={r.color}
                                    onDelete={handleDelete}
                                    selectMode={selectMode}
                                    selectedIds={selectedIds}
                                    onToggleSelect={toggleSelected} />
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
            </>
          )}
        </div>
      </div>

      {/* Barra flotante de comparación */}
      {selectMode && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 pl-glass rounded-xl border border-[var(--panel-muted)]/50 shadow-2xl px-4 py-3 flex items-center gap-4 min-w-[320px]">
          <div className="flex flex-col leading-tight">
            <span className="text-[10.5px] uppercase tracking-[0.14em] font-bold text-[var(--text-muted)]">
              Comparación
            </span>
            <span className="text-sm font-bold text-[var(--text)] font-mono">
              {selectedIds.size} / {MAX_COMPARE} registros
              {selectedIds.size < MIN_COMPARE && (
                <span className="ml-2 text-[11px] font-normal text-amber-500">
                  mín. {MIN_COMPARE}
                </span>
              )}
            </span>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            {selectedIds.size > 0 && (
              <button
                onClick={clearSelection}
                className="text-xs text-[var(--text-muted)] hover:text-[var(--text)] px-2 py-1"
              >
                Limpiar
              </button>
            )}
            <button
              onClick={goCompare}
              disabled={selectedIds.size < MIN_COMPARE}
              className="pl-cta-primary disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                background: selectedIds.size >= MIN_COMPARE
                  ? "linear-gradient(135deg, #22d3ee 0%, #3b82f6 100%)"
                  : undefined,
                padding: "8px 16px",
                fontSize: "12.5px",
              }}
            >
              Comparar ({selectedIds.size})
              <span className="text-base leading-none">→</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Sub-componentes ─────────────────────────────────────────────────────────

const STAT_ACCENT = ["#22d3ee", "#3b82f6", "#10b981", "#f59e0b", "#8b5cf6"];

function StatPill({ label, value, idx = 0 }: { label: string; value: number; idx?: number }) {
  const accent = STAT_ACCENT[idx % STAT_ACCENT.length];
  return (
    <div
      className="pl-glass rounded-xl px-4 py-3 border border-[var(--panel-muted)]/40 relative overflow-hidden transition-transform hover:-translate-y-0.5"
      style={{
        background: `linear-gradient(135deg, ${accent}15 0%, transparent 70%)`,
      }}
    >
      {/* Barra lateral de acento */}
      <span
        className="absolute left-0 top-0 h-full w-0.5"
        style={{ background: accent, boxShadow: `0 0 10px ${accent}80` }}
      />
      <div className="text-[10px] uppercase tracking-wider font-bold text-[var(--text-muted)]">{label}</div>
      <div className="text-2xl font-mono font-bold mt-1 text-[var(--text)]">{value.toLocaleString()}</div>
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
  const activeStyle = active && color
    ? {
        background: `linear-gradient(135deg, ${color} 0%, ${color}cc 100%)`,
        color: "#ffffff",
        boxShadow: `0 4px 14px -4px ${color}99`,
      }
    : undefined;
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-all ${
        active
          ? "text-white shadow"
          : "bg-[var(--panel-muted)]/40 text-[var(--text-muted)] hover:text-[var(--text)] border border-[var(--panel-muted)]/50 hover:border-[var(--color-accent)]/40"
      }`}
      style={activeStyle ?? (active ? {
        background: "linear-gradient(135deg, #22d3ee 0%, #3b82f6 100%)",
        color: "#ffffff",
        boxShadow: "0 4px 14px -4px rgba(59,130,246,0.5)",
      } : undefined)}>
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
  station, regionColor, onDelete, selectMode, selectedIds, onToggleSelect,
}: {
  station: StationGroup
  regionColor: string
  onDelete: (id: string, name: string) => void
  selectMode: boolean
  selectedIds: Set<string>
  onToggleSelect: (id: string) => void
}) {
  return (
    <div className="pl-glass rounded-lg p-3 border border-[var(--panel-muted)]/40 hover:border-[var(--color-accent)]/60 hover:shadow-[0_6px_20px_-8px_rgba(99,102,241,0.25)] hover:-translate-y-0.5 transition-all duration-150">
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="font-mono font-bold text-sm truncate" style={{ color: regionColor }}>
            {station.station}
          </span>
          {station.soil && (
            <span
              className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded border flex-shrink-0 uppercase tracking-wider ${
                SOIL_TONE_CLASS[soilTone(station.soil)]
              }`}
              title={`Suelo NSR-10 tipo ${station.soil}`}
            >
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
          const isSelected = selectedIds.has(r.id)
          const badge = (
            <>
              <span
                className="font-mono text-[11px] font-extrabold px-1.5 py-0.5 rounded flex-shrink-0 w-7 text-center border"
                style={{
                  background: `${color}1f`,
                  color,
                  borderColor: `${color}55`,
                  boxShadow: `0 0 8px ${color}33, inset 0 1px 0 ${color}22`,
                }}>
                {compLabel}
              </span>
              <span className="text-xs text-[var(--text)] truncate font-mono">
                {r.name}
              </span>
              <span className="text-[10px] text-[var(--text-muted)] font-mono ml-auto flex-shrink-0">
                {[dur, fs, npts].filter(Boolean).join(' · ')}
              </span>
            </>
          )
          return (
            <div
              key={r.id}
              className={`group flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors ${
                selectMode
                  ? isSelected
                    ? 'bg-cyan-500/10 ring-1 ring-cyan-400/50'
                    : 'hover:bg-[var(--panel-muted)]/40 cursor-pointer'
                  : 'hover:bg-[var(--panel-muted)]/40'
              }`}
              onClick={selectMode ? () => onToggleSelect(r.id) : undefined}
            >
              {selectMode && (
                <span
                  className={`inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border transition-all ${
                    isSelected
                      ? 'bg-cyan-500 border-cyan-400 text-white shadow-[0_0_10px_rgba(34,211,238,0.55)]'
                      : 'bg-transparent border-[var(--panel-muted)]/70'
                  }`}
                  aria-checked={isSelected}
                  role="checkbox"
                >
                  {isSelected && <span className="text-[10px] font-bold leading-none">✓</span>}
                </span>
              )}
              {selectMode ? (
                <div className="flex items-center gap-2 flex-1 min-w-0">{badge}</div>
              ) : (
                <Link href={`/ground-motion/${r.id}`} className="flex items-center gap-2 flex-1 min-w-0">
                  {badge}
                </Link>
              )}
              {!selectMode && (
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(r.id, r.name) }}
                  className="p-1 text-[var(--text-muted)] hover:text-rose-400 opacity-0 group-hover:opacity-100 transition-opacity text-xs"
                  title="Eliminar registro">
                  ✕
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Header premium por campaña ───────────────────────────────────────────
function CampaignHeader({
  label, eventDate, totalComponents, nRegions,
}: {
  label: string
  eventDate: string | null
  totalComponents: number
  nRegions: number
}) {
  return (
    <header className="relative pb-3">
      <div className="inline-flex items-center gap-1.5 rounded-full border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-violet-600 dark:text-violet-300 mb-1.5">
        <span className="h-1 w-1 rounded-full bg-violet-500" style={{ boxShadow: '0 0 6px #8b5cf6' }} />
        Campaña sísmica{eventDate ? ` · ${eventDate}` : ''}
      </div>
      <h2 className="text-xl font-extrabold text-[var(--text)] tracking-tight leading-tight">
        {label}
      </h2>
      <div className="flex flex-wrap items-center gap-2 mt-1.5 text-[11px] text-[var(--text-muted)]">
        <span className="inline-flex items-center gap-1 rounded-md bg-[var(--panel-muted)]/50 border border-[var(--panel-muted)] px-1.5 py-0.5 font-mono">
          <span className="font-bold text-[var(--text)]">{nRegions}</span>
          región{nRegions === 1 ? '' : 'es'}
        </span>
        <span className="inline-flex items-center gap-1 rounded-md bg-[var(--panel-muted)]/50 border border-[var(--panel-muted)] px-1.5 py-0.5 font-mono">
          <span className="font-bold text-[var(--text)]">{totalComponents}</span>
          componente{totalComponents === 1 ? '' : 's'}
        </span>
      </div>
      {/* Línea separadora con gradient subtle */}
      <span
        className="absolute left-0 right-0 bottom-0 h-px"
        style={{ background: 'linear-gradient(90deg, rgba(139,92,246,0.4) 0%, rgba(139,92,246,0.05) 25%, transparent 60%)' }}
      />
    </header>
  )
}

// ─── Skeleton estructural mientras carga ──────────────────────────────────
function GroundMotionSkeleton() {
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="pl-glass rounded-xl p-4 border border-[var(--panel-muted)]/40 space-y-2">
            <div className="pl-skeleton h-2.5 w-24" />
            <div className="pl-skeleton h-7 w-16" />
          </div>
        ))}
      </div>
      <div className="pl-glass rounded-xl border border-[var(--panel-muted)]/40 p-4 space-y-3">
        <div className="pl-skeleton h-9 w-full" />
        <div className="flex gap-1.5">
          {Array.from({ length: 5 }).map((_, i) => <div key={i} className="pl-skeleton h-6 w-20" />)}
        </div>
      </div>
      {Array.from({ length: 2 }).map((_, i) => (
        <section key={i} className="space-y-3">
          <div className="pl-skeleton h-6 w-64" />
          <div className="pl-glass rounded-xl p-3 border border-[var(--panel-muted)]/40 space-y-2">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {Array.from({ length: 4 }).map((_, j) => <div key={j} className="pl-skeleton h-20 w-full" />)}
            </div>
          </div>
        </section>
      ))}
    </>
  )
}

// ─── Empty state tech (sin emojis) ────────────────────────────────────────
function EmptyStateTech({ onImport }: { onImport: () => void }) {
  const CAPACITIES = [
    { title: 'Importación universal', desc: 'TXT · CSV · XLS · XLSX · AT2 · PEER NGA. Detección automática de estructura y unidades.', tone: '#22d3ee' },
    { title: 'Historia de tiempo',    desc: 'Aceleración, velocidad y desplazamiento — integración numérica Newmark-β.',               tone: '#3b82f6' },
    { title: 'Medidas de intensidad', desc: 'PGA · PGV · PGD · Arias · CAV · D5-95 · RMS · Housner.',                                  tone: '#10b981' },
    { title: 'Procesamiento de señal',desc: 'Corrección de línea base y filtrado Butterworth paso-alto / paso-banda.',                 tone: '#f59e0b' },
    { title: 'Análisis frecuencial',  desc: 'Espectro de amplitud FFT · Welch PSD · respuesta en el dominio de frecuencia.',           tone: '#8b5cf6' },
    { title: 'Espectro de respuesta', desc: 'Sd · Sv · Sa · PSA · PSV — amortiguamientos ξ múltiples (2 %, 5 %, 10 %, 20 %).',         tone: '#ec4899' },
  ]
  return (
    <div className="space-y-6">
      <div className="pl-glass rounded-2xl p-8 border border-[var(--panel-muted)]/40 relative overflow-hidden">
        <div
          className="absolute -top-20 -right-20 h-64 w-64 rounded-full opacity-30 pointer-events-none"
          style={{ background: 'radial-gradient(circle, rgba(34,211,238,0.4) 0%, transparent 70%)' }}
        />
        <div className="relative">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-[0.14em] text-cyan-600 dark:text-cyan-300 mb-3">
            <span className="h-1 w-1 rounded-full bg-cyan-400" style={{ boxShadow: '0 0 8px rgba(34,211,238,0.8)' }} />
            Catálogo vacío · importa tu primer acelerograma
          </div>
          <h2 className="text-2xl md:text-3xl font-extrabold tracking-tight text-[var(--text)] max-w-2xl">
            Convierte un acelerograma crudo en{' '}
            <span
              style={{
                background: 'linear-gradient(135deg, #22d3ee 0%, #6366f1 50%, #a855f7 100%)',
                WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
              }}
            >
              un análisis forense completo
            </span>
          </h2>
          <p className="mt-3 text-sm text-[var(--text-muted)] max-w-2xl leading-relaxed">
            Soporta formatos universales (TXT, CSV, XLS, XLSX, AT2 PEER/CEER). Procesa,
            calcula intensidades, extrae espectros de respuesta y los deja listos para
            el pipeline IDA / NLRHA / NLTH.
          </p>
          <button onClick={onImport} className="pl-cta-primary mt-5">
            <span className="text-base leading-none">+</span>
            Importar primer registro
          </button>
        </div>
      </div>

      <div>
        <div className="text-[10.5px] uppercase tracking-[0.14em] font-bold text-[var(--text-muted)] mb-2">
          Capacidades del módulo
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {CAPACITIES.map((c) => (
            <div
              key={c.title}
              className="pl-glass rounded-xl p-4 border border-[var(--panel-muted)]/40 relative overflow-hidden transition-transform hover:-translate-y-0.5"
              style={{ background: `linear-gradient(135deg, ${c.tone}10 0%, transparent 70%)` }}
            >
              <span
                className="absolute left-0 top-0 h-full w-0.5"
                style={{ background: c.tone, boxShadow: `0 0 10px ${c.tone}80` }}
              />
              <div className="text-sm font-bold text-[var(--text)]">{c.title}</div>
              <div className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">{c.desc}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
