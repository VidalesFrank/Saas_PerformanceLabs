'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  computeEspectroMicrozonificacion,
  computeEspectroNSR10,
  getAllMunicipios,
  getMicrozonificacion,
  getMicrozonificacionList,
  getSoilTypes,
  getUseGroups,
} from '@/lib/seismic-api'
import type {
  MicrozonificacionInfo,
  MunicipioInfo,
  PuntoEspectro,
  SoilTypeInfo,
  UseGroup,
  UseGroupInfo,
} from '@/lib/seismic-types'

// ──────────────────────────────────────────────────────────────────────────
// Tipo público consumido por la página /ground-motion/compare
// ──────────────────────────────────────────────────────────────────────────
export interface ReferenceSpectrum {
  id: string                    // uuid local
  kind: 'nsr10' | 'microzon' | 'csv'
  label: string                 // texto para la leyenda
  color: string
  puntos: PuntoEspectro[]       // Sa (g), Sd (cm), Sv (cm/s)
}

type Tab = 'nsr10' | 'microzon' | 'csv'

export const REF_PALETTE = ['#ef4444', '#8b5cf6', '#14b8a6', '#f97316', '#0ea5e9', '#eab308', '#a855f7']

export function defaultRefColor(index: number): string {
  return REF_PALETTE[index % REF_PALETTE.length]
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return Math.random().toString(36).slice(2, 10)
}

function nextColor(refs: ReferenceSpectrum[]): string {
  return defaultRefColor(refs.length)
}

interface Props {
  refs: ReferenceSpectrum[]
  onChange: (next: ReferenceSpectrum[]) => void
  hiddenRefs: Set<string>
  onToggleHidden: (id: string) => void
  TMax: number
}

export default function ReferenceSpectraPanel({
  refs, onChange, hiddenRefs, onToggleHidden, TMax,
}: Props) {
  const [tab, setTab] = useState<Tab>('nsr10')

  return (
    <aside className="pl-glass rounded-xl border border-[var(--panel-muted)]/40 overflow-hidden flex flex-col self-start sticky top-4">
      <header className="px-4 py-3 border-b border-[var(--panel-muted)]/40">
        <div className="text-[10.5px] uppercase tracking-[0.14em] font-bold text-[var(--text-muted)]">
          Overlay
        </div>
        <h3 className="text-sm font-bold text-[var(--text)] tracking-tight mt-0.5">
          Espectros de referencia
        </h3>
        <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
          Superpone diseño NSR-10, microzonificación oficial o CSV custom.
        </p>
      </header>

      {/* Tabs */}
      <div className="flex border-b border-[var(--panel-muted)]/40 px-1.5 pt-1.5 gap-1">
        <TabBtn active={tab === 'nsr10'} onClick={() => setTab('nsr10')}>NSR-10</TabBtn>
        <TabBtn active={tab === 'microzon'} onClick={() => setTab('microzon')}>Microzonif.</TabBtn>
        <TabBtn active={tab === 'csv'} onClick={() => setTab('csv')}>CSV</TabBtn>
      </div>

      <div className="p-3 space-y-3">
        {tab === 'nsr10' && (
          <NSR10Picker TMax={TMax} refs={refs} onAdd={(r) => onChange([...refs, r])} />
        )}
        {tab === 'microzon' && (
          <MicrozonPicker TMax={TMax} refs={refs} onAdd={(r) => onChange([...refs, r])} />
        )}
        {tab === 'csv' && (
          <CSVPicker refs={refs} onAdd={(r) => onChange([...refs, r])} />
        )}
      </div>

      {/* Lista de referencias activas */}
      {refs.length > 0 && (
        <div className="border-t border-[var(--panel-muted)]/40 p-3">
          <div className="text-[10.5px] uppercase tracking-[0.14em] font-bold text-[var(--text-muted)] mb-2">
            Referencias activas ({refs.length})
          </div>
          <div className="space-y-1.5">
            {refs.map((r) => {
              const hidden = hiddenRefs.has(r.id)
              return (
                <div
                  key={r.id}
                  className={`group flex items-center gap-2 rounded-md px-2 py-1.5 border transition-all ${
                    hidden ? 'opacity-50 border-dashed' : ''
                  }`}
                  style={{
                    background: `${r.color}10`,
                    borderColor: `${r.color}55`,
                  }}
                >
                  <button
                    onClick={() => onToggleHidden(r.id)}
                    className="h-2.5 w-2.5 rounded-full flex-shrink-0"
                    style={{
                      background: hidden ? 'transparent' : r.color,
                      border: `1.5px solid ${r.color}`,
                      boxShadow: hidden ? 'none' : `0 0 6px ${r.color}`,
                    }}
                    title={hidden ? 'Mostrar' : 'Ocultar'}
                  />
                  <label
                    className="relative inline-flex cursor-pointer flex-shrink-0"
                    title="Cambiar color"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="color"
                      value={r.color}
                      onChange={(e) =>
                        onChange(refs.map((x) => x.id === r.id ? { ...x, color: e.target.value } : x))
                      }
                      className="absolute inset-0 h-full w-full opacity-0 cursor-pointer"
                    />
                    <span
                      className="h-3 w-3 rounded-sm border border-[var(--panel-muted)]/60"
                      style={{ background: r.color }}
                    />
                  </label>
                  <span className="text-xs font-semibold flex-1 min-w-0 truncate" style={{ color: r.color }}>
                    {r.label}
                  </span>
                  <span className="text-[9px] font-mono uppercase tracking-wider px-1 py-0.5 rounded"
                        style={{ background: `${r.color}22`, color: r.color }}>
                    {r.kind === 'nsr10' ? 'NSR' : r.kind === 'microzon' ? 'μZ' : 'CSV'}
                  </span>
                  <button
                    onClick={() => onChange(refs.filter((x) => x.id !== r.id))}
                    className="text-[var(--text-muted)] hover:text-rose-500 opacity-0 group-hover:opacity-100 transition-opacity text-xs"
                    title="Eliminar"
                  >
                    ✕
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </aside>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Selector NSR-10
// ──────────────────────────────────────────────────────────────────────────
function NSR10Picker({
  TMax, refs, onAdd,
}: { TMax: number; refs: ReferenceSpectrum[]; onAdd: (r: ReferenceSpectrum) => void }) {
  const [municipios, setMunicipios] = useState<MunicipioInfo[]>([])
  const [soilTypes, setSoilTypes]   = useState<SoilTypeInfo[]>([])
  const [useGroups, setUseGroups]   = useState<UseGroupInfo[]>([])
  const [query, setQuery]           = useState('')
  const [municipioId, setMunicipioId] = useState<string>('')
  const [soil, setSoil]             = useState<string>('D')
  const [grp, setGrp]               = useState<UseGroup>('I')
  const [busy, setBusy]             = useState(false)
  const [err, setErr]               = useState<string | null>(null)

  useEffect(() => {
    getAllMunicipios().then(setMunicipios).catch(() => {})
    getSoilTypes().then(setSoilTypes).catch(() => {})
    getUseGroups().then(setUseGroups).catch(() => {})
  }, [])

  const filtered = useMemo(() => {
    if (!query.trim()) return municipios.slice(0, 50)
    const q = query.toLowerCase()
    return municipios
      .filter((m) => m.nombre.toLowerCase().includes(q) || m.departamento.toLowerCase().includes(q))
      .slice(0, 50)
  }, [query, municipios])

  const selected = useMemo(
    () => municipios.find((m) => m.id === municipioId),
    [municipios, municipioId],
  )

  async function handleAdd() {
    if (!municipioId) { setErr('Selecciona un municipio.'); return }
    setErr(null); setBusy(true)
    try {
      const res = await computeEspectroNSR10({
        municipio_id: municipioId,
        soil_type: soil,
        T_max: TMax,
        use_group: grp,
      })
      const mun = selected?.nombre ?? municipioId
      onAdd({
        id: newId(),
        kind: 'nsr10',
        label: `NSR-10 · ${mun} · Suelo ${soil} · G${grp}`,
        color: nextColor(refs),
        puntos: res.puntos,
      })
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Error calculando el espectro')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2.5">
      <div>
        <FieldLabel>Municipio</FieldLabel>
        <input
          type="text"
          placeholder="Buscar municipio…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-md bg-[var(--panel-muted)]/40 border border-[var(--panel-muted)]/50 px-2 py-1 text-xs text-[var(--text)] focus:outline-none focus:border-cyan-400"
        />
        <div className="mt-1 max-h-32 overflow-y-auto rounded-md border border-[var(--panel-muted)]/40 divide-y divide-[var(--panel-muted)]/30 bg-[var(--panel-muted)]/20">
          {filtered.length === 0 ? (
            <div className="px-2 py-1.5 text-[11px] text-[var(--text-muted)]">Sin resultados</div>
          ) : filtered.map((m) => (
            <button
              key={m.id}
              onClick={() => setMunicipioId(m.id)}
              className={`w-full text-left px-2 py-1 text-[11px] transition-colors ${
                municipioId === m.id
                  ? 'bg-cyan-500/20 text-cyan-600 dark:text-cyan-300 font-semibold'
                  : 'text-[var(--text)] hover:bg-[var(--panel-muted)]/40'
              }`}
            >
              <span className="font-mono">{m.nombre}</span>
              <span className="text-[var(--text-muted)]"> · {m.departamento} · Aa={m.Aa}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <FieldLabel>Suelo</FieldLabel>
          <select
            value={soil}
            onChange={(e) => setSoil(e.target.value)}
            className="w-full rounded-md bg-[var(--panel-muted)]/40 border border-[var(--panel-muted)]/50 px-2 py-1 text-xs text-[var(--text)]"
          >
            {soilTypes.map((s) => (
              <option key={s.id} value={s.id}>{s.id} — {s.nombre.split('—')[1]?.trim() ?? s.nombre}</option>
            ))}
          </select>
        </div>
        <div>
          <FieldLabel>Grupo uso</FieldLabel>
          <select
            value={grp}
            onChange={(e) => setGrp(e.target.value as UseGroup)}
            className="w-full rounded-md bg-[var(--panel-muted)]/40 border border-[var(--panel-muted)]/50 px-2 py-1 text-xs text-[var(--text)]"
          >
            {useGroups.map((g) => (
              <option key={g.id} value={g.id}>{g.id} — I={g.I}</option>
            ))}
          </select>
        </div>
      </div>

      {err && <div className="text-[11px] text-rose-500">{err}</div>}

      <button
        onClick={handleAdd}
        disabled={!municipioId || busy}
        className="w-full pl-cta-primary disabled:opacity-40 disabled:cursor-not-allowed justify-center"
        style={{ padding: '7px 14px', fontSize: '12px' }}
      >
        {busy ? 'Calculando…' : '+ Agregar al gráfico'}
      </button>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Selector Microzonificación
// ──────────────────────────────────────────────────────────────────────────
function MicrozonPicker({
  TMax, refs, onAdd,
}: { TMax: number; refs: ReferenceSpectrum[]; onAdd: (r: ReferenceSpectrum) => void }) {
  const [cityIds, setCityIds] = useState<string[]>([])
  const [cityId, setCityId]   = useState<string>('')
  const [info, setInfo]       = useState<MicrozonificacionInfo | null>(null)
  const [zonaId, setZonaId]   = useState<string>('')
  const [useGroups, setUseGroups] = useState<UseGroupInfo[]>([])
  const [grp, setGrp]         = useState<UseGroup>('I')
  const [busy, setBusy]       = useState(false)
  const [err, setErr]         = useState<string | null>(null)

  useEffect(() => {
    getMicrozonificacionList().then(setCityIds).catch(() => {})
    getUseGroups().then(setUseGroups).catch(() => {})
  }, [])

  useEffect(() => {
    if (!cityId) { setInfo(null); setZonaId(''); return }
    getMicrozonificacion(cityId).then((d) => {
      setInfo(d); setZonaId(d.zonas[0]?.id ?? '')
    }).catch(() => {})
  }, [cityId])

  async function handleAdd() {
    if (!cityId || !zonaId || !info) { setErr('Selecciona ciudad y zona.'); return }
    setErr(null); setBusy(true)
    try {
      const res = await computeEspectroMicrozonificacion({
        municipio_id: cityId,
        zona_id: zonaId,
        T_max: TMax,
        use_group: grp,
      })
      const zona = info.zonas.find((z) => z.id === zonaId)
      onAdd({
        id: newId(),
        kind: 'microzon',
        label: `μZ · ${info.nombre} · ${res.zona_nombre.replace(/^Zona\s+\w+\s+—\s+/, '')} · G${grp}`,
        color: zona?.color ?? nextColor(refs),
        puntos: res.puntos,
      })
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Error calculando el espectro')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2.5">
      <div>
        <FieldLabel>Ciudad</FieldLabel>
        <select
          value={cityId}
          onChange={(e) => setCityId(e.target.value)}
          className="w-full rounded-md bg-[var(--panel-muted)]/40 border border-[var(--panel-muted)]/50 px-2 py-1 text-xs text-[var(--text)]"
        >
          <option value="">— Selecciona —</option>
          {cityIds.map((id) => (
            <option key={id} value={id}>
              {id.charAt(0).toUpperCase() + id.slice(1)}
            </option>
          ))}
        </select>
      </div>

      {info && (
        <>
          <div className="text-[10.5px] text-[var(--text-muted)] italic leading-snug">
            {info.estudio}
          </div>
          <div>
            <FieldLabel>Zona</FieldLabel>
            <div className="space-y-1 max-h-48 overflow-y-auto rounded-md border border-[var(--panel-muted)]/40 p-1 bg-[var(--panel-muted)]/20">
              {info.zonas.map((z) => (
                <button
                  key={z.id}
                  onClick={() => setZonaId(z.id)}
                  className={`w-full text-left px-2 py-1 rounded transition-colors text-[11px] flex items-center gap-2 ${
                    zonaId === z.id
                      ? 'bg-[var(--panel-muted)]/60 font-semibold'
                      : 'hover:bg-[var(--panel-muted)]/30'
                  }`}
                >
                  <span
                    className="h-2 w-2 rounded-full flex-shrink-0"
                    style={{ background: z.color, boxShadow: `0 0 6px ${z.color}` }}
                  />
                  <span className="flex-1 min-w-0 truncate" style={{ color: zonaId === z.id ? z.color : undefined }}>
                    {z.nombre}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <FieldLabel>Grupo uso</FieldLabel>
            <select
              value={grp}
              onChange={(e) => setGrp(e.target.value as UseGroup)}
              className="w-full rounded-md bg-[var(--panel-muted)]/40 border border-[var(--panel-muted)]/50 px-2 py-1 text-xs text-[var(--text)]"
            >
              {useGroups.map((g) => (
                <option key={g.id} value={g.id}>{g.id} — I={g.I}</option>
              ))}
            </select>
          </div>
        </>
      )}

      {err && <div className="text-[11px] text-rose-500">{err}</div>}

      <button
        onClick={handleAdd}
        disabled={!cityId || !zonaId || busy}
        className="w-full pl-cta-primary disabled:opacity-40 disabled:cursor-not-allowed justify-center"
        style={{ padding: '7px 14px', fontSize: '12px' }}
      >
        {busy ? 'Calculando…' : '+ Agregar al gráfico'}
      </button>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Importador CSV ad-hoc — columnas T [s], Sa [g] (y opc. Sd, Sv)
// ──────────────────────────────────────────────────────────────────────────
function CSVPicker({
  refs, onAdd,
}: { refs: ReferenceSpectrum[]; onAdd: (r: ReferenceSpectrum) => void }) {
  const [label, setLabel] = useState('Custom')
  const [err, setErr]     = useState<string | null>(null)
  const [preview, setPreview] = useState<PuntoEspectro[] | null>(null)

  function handleFile(file: File) {
    setErr(null); setPreview(null)
    file.text().then((text) => {
      try {
        const puntos = parseCSVSpectrum(text)
        if (puntos.length < 3) throw new Error('El CSV debe tener al menos 3 filas (T, Sa).')
        setPreview(puntos)
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Error al parsear CSV')
      }
    })
  }

  function handleAdd() {
    if (!preview) return
    onAdd({
      id: newId(),
      kind: 'csv',
      label: label.trim() || 'Custom',
      color: nextColor(refs),
      puntos: preview,
    })
    setPreview(null); setLabel('Custom')
  }

  return (
    <div className="space-y-2.5">
      <div>
        <FieldLabel>Etiqueta</FieldLabel>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Ej: Microzonif. estudio local"
          className="w-full rounded-md bg-[var(--panel-muted)]/40 border border-[var(--panel-muted)]/50 px-2 py-1 text-xs text-[var(--text)]"
        />
      </div>
      <label className="block">
        <FieldLabel>Archivo CSV</FieldLabel>
        <div className="rounded-md border border-dashed border-[var(--panel-muted)]/60 px-3 py-4 text-center bg-[var(--panel-muted)]/20 hover:bg-[var(--panel-muted)]/40 transition-colors cursor-pointer">
          <input
            type="file"
            accept=".csv,.txt"
            onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
            className="hidden"
          />
          <div className="text-xs text-[var(--text)] font-semibold">Click para subir</div>
          <div className="text-[10.5px] text-[var(--text-muted)] mt-1">
            Columnas: <code className="font-mono">T, Sa</code> (opc. Sd, Sv). Separador coma o tab.
          </div>
        </div>
      </label>

      {err && <div className="text-[11px] text-rose-500">{err}</div>}

      {preview && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-2 text-[11px] space-y-1">
          <div className="font-bold text-emerald-700 dark:text-emerald-300">
            Preview OK · {preview.length} puntos
          </div>
          <div className="font-mono text-[10.5px] text-[var(--text-muted)]">
            T ∈ [{preview[0].T.toFixed(3)}, {preview[preview.length - 1].T.toFixed(3)}] s ·
            Sa_max = {Math.max(...preview.map((p) => p.Sa)).toFixed(3)} g
          </div>
          <button
            onClick={handleAdd}
            className="mt-1 w-full pl-cta-primary justify-center"
            style={{ padding: '6px 12px', fontSize: '11.5px' }}
          >
            + Agregar al gráfico
          </button>
        </div>
      )}
    </div>
  )
}

function parseCSVSpectrum(text: string): PuntoEspectro[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const out: PuntoEspectro[] = []
  let headerSkipped = false
  for (const line of lines) {
    if (line.startsWith('#')) continue
    const parts = line.split(/[,\t;]+/).map((p) => p.trim())
    if (parts.length < 2) continue
    const T = parseFloat(parts[0])
    const Sa = parseFloat(parts[1])
    if (!Number.isFinite(T) || !Number.isFinite(Sa)) {
      if (!headerSkipped) { headerSkipped = true; continue }
      continue
    }
    if (T < 0 || Sa < 0) continue
    const Sd = parts.length > 2 && Number.isFinite(parseFloat(parts[2])) ? parseFloat(parts[2]) : NaN
    const Sv = parts.length > 3 && Number.isFinite(parseFloat(parts[3])) ? parseFloat(parts[3]) : NaN
    out.push({ T, Sa, Sd: Number.isNaN(Sd) ? 0 : Sd, Sv: Number.isNaN(Sv) ? 0 : Sv })
  }
  out.sort((a, b) => a.T - b.T)
  return out
}

// ──────────────────────────────────────────────────────────────────────────
// Utilitarios visuales
// ──────────────────────────────────────────────────────────────────────────
function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.1em] rounded-t-md transition-all ${
        active
          ? 'text-cyan-600 dark:text-cyan-300 border-b-2 border-cyan-400'
          : 'text-[var(--text-muted)] hover:text-[var(--text)] border-b-2 border-transparent'
      }`}
    >
      {children}
    </button>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[9.5px] uppercase tracking-[0.14em] font-bold text-[var(--text-muted)] mb-1">
      {children}
    </div>
  )
}
