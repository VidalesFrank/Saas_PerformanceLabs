'use client'

import { useCallback, useRef, useState } from 'react'
import {
  AccUnit,
  ColumnMappingIn,
  ColumnQuantity,
  DetectedStructure,
  GMRecord,
  WizardStep,
} from '@/lib/ground-motion-types'
import { createRecord, detectFileStructure } from '@/lib/ground-motion-api'

interface Props {
  onSuccess: (record: GMRecord) => void
  onCancel?: () => void
}

const QUANTITY_OPTIONS: { value: ColumnQuantity; label: string }[] = [
  { value: 'acceleration', label: 'Aceleración' },
  { value: 'time',         label: 'Tiempo' },
  { value: 'velocity',     label: 'Velocidad' },
  { value: 'displacement', label: 'Desplazamiento' },
  { value: 'ignore',       label: 'Ignorar' },
]

const ACC_UNITS: { value: AccUnit; label: string }[] = [
  { value: 'g',     label: 'g  (gravedad estándar)' },
  { value: 'm/s²',  label: 'm/s²  (SI)' },
  { value: 'cm/s²', label: 'cm/s²' },
  { value: 'Gal',   label: 'Gal  (= cm/s²)' },
  { value: 'mm/s²', label: 'mm/s²' },
]

const COMPONENT_OPTIONS = ['', 'H1', 'H2', 'V', 'NS', 'EW', 'X', 'Y', 'Z']

export default function ImportWizard({ onSuccess, onCancel }: Props) {
  const [step, setStep]               = useState<WizardStep>(1)
  const [file, setFile]               = useState<File | null>(null)
  const [detected, setDetected]       = useState<DetectedStructure | null>(null)
  const [mappings, setMappings]       = useState<ColumnMappingIn[]>([])
  const [flatten, setFlatten]         = useState(false)
  const [dt, setDt]                   = useState('')
  const [useDt, setUseDt]             = useState(true)
  const [fs, setFs]                   = useState('')
  const [recordName, setRecordName]   = useState('')
  const [metadata, setMetadata]       = useState({ earthquake: '', station: '', component: '', notes: '' })
  const [showMeta, setShowMeta]       = useState(false)
  const [error, setError]             = useState<string | null>(null)
  const [isLoading, setIsLoading]     = useState(false)
  const [isDragging, setIsDragging]   = useState(false)
  const fileInputRef                  = useRef<HTMLInputElement>(null)

  // ── Paso 1: Cargar ────────────────────────────────────────────────────────

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setIsDragging(false)
    const f = e.dataTransfer.files[0]
    if (f) handleFile(f)
  }, [])

  const handleFile = async (f: File) => {
    setFile(f)
    setRecordName(f.name.replace(/\.[^.]+$/, ''))
    setError(null)
    setIsLoading(true)
    try {
      const d = await detectFileStructure(f)
      setDetected(d)
      // Inicializar mappings por defecto
      const initial: ColumnMappingIn[] = d.columns.map((c) => ({
        col_index: c.index,
        quantity:  d.n_cols === 1 ? 'acceleration' : (c.is_monotonic_increasing ? 'time' : 'acceleration'),
        unit:      'g',
        component: '',
        name:      c.header,
      }))
      setMappings(initial)
      setFlatten(d.wrapped_series_hint)
      setStep(2)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error analizando el archivo.')
    } finally {
      setIsLoading(false)
    }
  }

  // ── Paso 2: Mapeo de datos ────────────────────────────────────────────────

  const updateMapping = (idx: number, field: keyof ColumnMappingIn, value: string) => {
    setMappings(prev => prev.map((m, i) => i === idx ? { ...m, [field]: value } : m))
  }

  const hasAccChannel    = mappings.some(m => m.quantity === 'acceleration')
  const hasTimeChannel   = mappings.some(m => m.quantity === 'time')
  // En modo "serie continua envuelta" no se admite columna de tiempo — el
  // Δt siempre se da directamente (o viene del NPTS/DT del encabezado).
  const needsDt          = flatten || (!hasTimeChannel && hasAccChannel)

  const activeMappings   = mappings.filter(m => m.quantity !== 'ignore')
  const flattenQuantitiesOk = !flatten || new Set(activeMappings.map(m => m.quantity)).size <= 1
  const flattenUnitsOk      = !flatten || new Set(activeMappings.map(m => m.unit)).size <= 1
  const flattenValid        = !flatten || (!hasTimeChannel && flattenQuantitiesOk && flattenUnitsOk)

  // ── Paso 3: Muestreo y unidades ───────────────────────────────────────────

  const computedDt = () => {
    if (useDt) return parseFloat(dt) || null
    const fsVal = parseFloat(fs)
    return fsVal > 0 ? 1.0 / fsVal : null
  }

  const computedFs = () => {
    if (!useDt) return parseFloat(fs) || null
    const dtVal = parseFloat(dt)
    return dtVal > 0 ? 1.0 / dtVal : null
  }

  const nyquist = () => {
    const fsVal = computedFs()
    return fsVal ? fsVal / 2 : null
  }

  // En modo "serie continua envuelta" las muestras reales son n_rows * n_cols
  // (o el NPTS del encabezado si está disponible), no n_rows.
  const effectiveNSamples = () => {
    if (!detected) return 0
    if (!flatten) return detected.n_rows
    const npts = detected.header_metadata.npts
    const total = detected.n_rows * detected.n_cols
    return typeof npts === 'number' && npts > 0 && npts <= total ? npts : total
  }

  const dtValue = computedDt()
  const durPreview = dtValue && detected
    ? ((effectiveNSamples() - 1) * dtValue).toFixed(3) + ' s'
    : '—'

  // ── Paso 4: Validación y creación ─────────────────────────────────────────

  const handleCreate = async () => {
    setIsLoading(true); setError(null)
    try {
      const dtFinal = needsDt ? computedDt() : null
      const record = await createRecord(file!, {
        name:            recordName,
        column_mappings: mappings.filter(m => m.quantity !== 'ignore'),
        dt:              dtFinal,
        metadata,
        flatten,
      })
      onSuccess(record)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error creando el registro.')
    } finally {
      setIsLoading(false)
    }
  }

  // ── Barra de pasos ────────────────────────────────────────────────────────

  const STEPS = ['Cargar', 'Mapeo', 'Muestreo', 'Validar']

  return (
    <div className="flex flex-col min-h-0 h-full">
      {/* Stepper */}
      <div className="flex items-center gap-0 px-8 pt-6 pb-4 border-b border-[var(--border)]">
        {STEPS.map((label, i) => {
          const n = (i + 1) as WizardStep
          const active = step === n
          const done   = step > n
          return (
            <div key={n} className="flex items-center">
              <div className="flex items-center gap-2">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors
                  ${done   ? 'bg-[var(--accent)] text-white' :
                    active ? 'bg-[var(--accent)] text-white ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--surface)]' :
                              'bg-[var(--surface-alt)] text-[var(--muted)]'}`}>
                  {done ? '✓' : n}
                </div>
                <span className={`text-xs font-medium ${active ? 'text-[var(--foreground)]' : 'text-[var(--muted)]'}`}>
                  {label}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <div className={`w-12 h-px mx-3 ${done ? 'bg-[var(--accent)]' : 'bg-[var(--border)]'}`} />
              )}
            </div>
          )
        })}
      </div>

      {/* Contenido */}
      <div className="flex-1 overflow-y-auto px-8 py-6">

        {/* ── PASO 1: Cargar ────────────────────────────────────────────── */}
        {step === 1 && (
          <div className="max-w-xl mx-auto flex flex-col gap-6">
            <div>
              <h2 className="text-lg font-semibold text-[var(--foreground)]">Importar Registro de Movimiento del Suelo</h2>
              <p className="text-sm text-[var(--muted)] mt-1">
                Formatos soportados: TXT, CSV, XLS, XLSX. La estructura del archivo se analizará automáticamente.
              </p>
            </div>

            <div
              className={`border-2 border-dashed rounded-xl p-12 flex flex-col items-center gap-4 cursor-pointer transition-colors
                ${isDragging ? 'border-[var(--accent)] bg-[var(--accent)]/5' : 'border-[var(--border)] hover:border-[var(--accent)]/50'}`}
              onDrop={handleDrop}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
              onDragLeave={() => setIsDragging(false)}
              onClick={() => fileInputRef.current?.click()}
            >
              <div className="w-14 h-14 rounded-full bg-[var(--surface-alt)] flex items-center justify-center text-2xl">
                📂
              </div>
              <div className="text-center">
                <p className="font-medium text-[var(--foreground)]">Arrastra tu acelerograma aquí</p>
                <p className="text-sm text-[var(--muted)] mt-1">o haz clic para buscar</p>
              </div>
              <p className="text-xs text-[var(--muted)]">TXT · CSV · XLS · XLSX</p>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept=".txt,.csv,.xls,.xlsx"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
            />

            {isLoading && (
              <p className="text-sm text-[var(--accent)] text-center animate-pulse">Analizando estructura del archivo…</p>
            )}
            {error && <p className="text-sm text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">{error}</p>}
          </div>
        )}

        {/* ── PASO 2: Mapeo de datos ────────────────────────────────────── */}
        {step === 2 && detected && (
          <div className="flex flex-col gap-5">
            <div>
              <h2 className="text-lg font-semibold">Mapeo de Columnas</h2>
              <p className="text-sm text-[var(--muted)] mt-1">
                Asigna el significado físico de cada columna. Performance Labs detectó la estructura —
                confirma qué representa cada columna.
              </p>
            </div>

            {/* Resumen del archivo */}
            <div className="grid grid-cols-4 gap-3">
              {[
                ['Archivo', detected.filename],
                ['Filas', detected.n_rows.toLocaleString()],
                ['Columnas', detected.n_cols.toString()],
                ['Formato', detected.file_format.toUpperCase()],
              ].map(([label, value]) => (
                <div key={label} className="bg-[var(--surface-alt)] rounded-lg px-4 py-3">
                  <div className="text-xs text-[var(--muted)]">{label}</div>
                  <div className="text-sm font-semibold mt-0.5 truncate">{value}</div>
                </div>
              ))}
            </div>

            {/* Metadata detectada */}
            {Object.keys(detected.header_metadata).length > 0 && (
              <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-4 py-3">
                <p className="text-xs font-medium text-blue-400 mb-1">Detectado en encabezado del archivo:</p>
                <div className="flex gap-4 text-sm">
                  {detected.header_metadata.dt !== undefined && (
                    <span>Δt = <strong>{detected.header_metadata.dt} s</strong></span>
                  )}
                  {detected.header_metadata.npts !== undefined && (
                    <span>NPTS = <strong>{detected.header_metadata.npts}</strong></span>
                  )}
                </div>
              </div>
            )}

            {/* Advertencias */}
            {detected.warnings.length > 0 && (
              <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-3">
                {detected.warnings.map((w, i) => (
                  <p key={i} className="text-xs text-amber-400">⚠ {w}</p>
                ))}
              </div>
            )}

            {/* Serie continua envuelta en columnas (formato PEER/NGA) */}
            {detected.n_cols > 1 && (
              <label className={`flex items-start gap-3 rounded-lg px-4 py-3 cursor-pointer border transition-colors
                ${flatten ? 'bg-[var(--accent)]/10 border-[var(--accent)]/40' : 'border-[var(--border)] hover:border-[var(--accent)]/30'}`}>
                <input
                  type="checkbox"
                  checked={flatten}
                  onChange={(e) => setFlatten(e.target.checked)}
                  className="mt-0.5"
                />
                <span className="text-sm">
                  <span className="font-medium">Es UNA sola serie continua repartida en {detected.n_cols} columnas por línea</span>
                  <span className="block text-xs text-[var(--muted)] mt-0.5">
                    Formato típico de acelerogramas reales (PEER/NGA, FEMA P-695): no son {detected.n_cols} canales
                    independientes, sino un único registro de aceleración escrito {detected.n_cols} valores por línea.
                    {detected.wrapped_series_hint && ' Performance Labs detectó este patrón automáticamente.'}
                    {' '}Requiere Δt (no admite columna de tiempo).
                  </span>
                </span>
              </label>
            )}

            {/* Tabla de mapeo de columnas */}
            <div className="border border-[var(--border)] rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-[var(--surface-alt)] text-left">
                    <th className="px-4 py-3 text-xs font-medium text-[var(--muted)]">Columna</th>
                    <th className="px-4 py-3 text-xs font-medium text-[var(--muted)]">Comportamiento detectado</th>
                    <th className="px-4 py-3 text-xs font-medium text-[var(--muted)]">Vista previa</th>
                    <th className="px-4 py-3 text-xs font-medium text-[var(--muted)]">Asignar como</th>
                    <th className="px-4 py-3 text-xs font-medium text-[var(--muted)]">Unidad</th>
                    <th className="px-4 py-3 text-xs font-medium text-[var(--muted)]">Componente</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {detected.columns.map((col, idx) => {
                    const m = mappings[idx]
                    const behaviorLabel = col.is_monotonic_increasing
                      ? `Monótona${col.delta_stats?.regular ? ' / Δ≈' + col.delta_stats.mean.toFixed(4) : ''}`
                      : col.is_oscillatory ? 'Oscilatoria' : 'Desconocida'

                    return (
                      <tr key={idx} className="hover:bg-[var(--surface-alt)]/50 transition-colors">
                        <td className="px-4 py-3 font-medium">{col.header}</td>
                        <td className="px-4 py-3 text-[var(--muted)]">
                          <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full
                            ${col.is_monotonic_increasing ? 'bg-blue-500/10 text-blue-400' :
                              col.is_oscillatory          ? 'bg-emerald-500/10 text-emerald-400' :
                                                            'bg-[var(--surface-alt)] text-[var(--muted)]'}`}>
                            {behaviorLabel}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">
                          {col.preview.slice(0, 3).map(v => v.toExponential(2)).join(', ')}…
                        </td>
                        <td className="px-4 py-3">
                          <select
                            value={m?.quantity || 'ignore'}
                            onChange={(e) => updateMapping(idx, 'quantity', e.target.value)}
                            className="bg-[var(--surface)] border border-[var(--border)] rounded-lg px-2 py-1.5 text-sm"
                          >
                            {QUANTITY_OPTIONS.map(o => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </select>
                        </td>
                        <td className="px-4 py-3">
                          {m?.quantity === 'acceleration' && (
                            <select
                              value={m.unit}
                              onChange={(e) => updateMapping(idx, 'unit', e.target.value)}
                              className="bg-[var(--surface)] border border-[var(--border)] rounded-lg px-2 py-1.5 text-sm"
                            >
                              {ACC_UNITS.map(u => (
                                <option key={u.value} value={u.value}>{u.label}</option>
                              ))}
                            </select>
                          )}
                          {m?.quantity === 'time' && (
                            <select
                              value={m.unit}
                              onChange={(e) => updateMapping(idx, 'unit', e.target.value)}
                              className="bg-[var(--surface)] border border-[var(--border)] rounded-lg px-2 py-1.5 text-sm"
                            >
                              <option value="s">s (segundos)</option>
                              <option value="ms">ms (milisegundos)</option>
                            </select>
                          )}
                          {(m?.quantity === 'ignore' || m?.quantity === 'velocity' || m?.quantity === 'displacement') && (
                            <span className="text-xs text-[var(--muted)]">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {m?.quantity === 'acceleration' && (
                            <select
                              value={m.component}
                              onChange={(e) => updateMapping(idx, 'component', e.target.value)}
                              className="bg-[var(--surface)] border border-[var(--border)] rounded-lg px-2 py-1.5 text-sm"
                            >
                              {COMPONENT_OPTIONS.map(c => (
                                <option key={c} value={c}>{c || '(predeterminado)'}</option>
                              ))}
                            </select>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Vista previa de datos */}
            <details className="border border-[var(--border)] rounded-xl">
              <summary className="px-4 py-3 text-sm font-medium cursor-pointer hover:bg-[var(--surface-alt)] rounded-xl">
                Vista previa de datos (primeras filas)
              </summary>
              <div className="overflow-x-auto px-4 pb-3">
                <table className="text-xs font-mono">
                  <thead>
                    <tr className="text-[var(--muted)]">
                      <th className="pr-4 py-1">Fila</th>
                      {detected.columns.map(c => <th key={c.index} className="pr-8 py-1">{c.header}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {detected.preview_rows.map((row, ri) => (
                      <tr key={ri}>
                        <td className="pr-4 text-[var(--muted)]">{ri + 1}</td>
                        {row.map((v, ci) => (
                          <td key={ci} className="pr-8">{v !== null ? v.toExponential(4) : '—'}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>

            {!hasAccChannel && (
              <p className="text-sm text-red-400 bg-red-500/10 px-3 py-2 rounded-lg">
                Asigna al menos una columna como <strong>Aceleración</strong> para continuar.
              </p>
            )}
          </div>
        )}

        {/* ── PASO 3: Muestreo ─────────────────────────────────────────── */}
        {step === 3 && (
          <div className="max-w-lg mx-auto flex flex-col gap-6">
            <div>
              <h2 className="text-lg font-semibold">Muestreo e Información del Registro</h2>
              <p className="text-sm text-[var(--muted)] mt-1">
                {needsDt
                  ? 'No se detectó columna de tiempo. Ingresa el paso de tiempo o la frecuencia de muestreo.'
                  : 'Columna de tiempo detectada. Verifica la información a continuación.'}
              </p>
            </div>

            {/* Δt / fs */}
            {needsDt && (
              <div className="bg-[var(--surface-alt)] rounded-xl p-5 flex flex-col gap-4">
                <p className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">Muestreo</p>

                {/* Toggle Δt / fs */}
                <div className="flex gap-2">
                  <button
                    onClick={() => setUseDt(true)}
                    className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors
                      ${useDt ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface)] border border-[var(--border)]'}`}
                  >
                    Paso de tiempo Δt
                  </button>
                  <button
                    onClick={() => setUseDt(false)}
                    className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors
                      ${!useDt ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface)] border border-[var(--border)]'}`}
                  >
                    Frec. de muestreo fs
                  </button>
                </div>

                {useDt ? (
                  <div>
                    <label className="text-xs text-[var(--muted)] block mb-1">Paso de tiempo Δt (segundos)</label>
                    <div className="flex gap-2 items-center">
                      <input
                        type="number"
                        step="any"
                        min="0"
                        value={dt}
                        onChange={(e) => { setDt(e.target.value); setFs(e.target.value ? String(1 / parseFloat(e.target.value)) : '') }}
                        placeholder="ej. 0.01"
                        className="flex-1 bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm"
                      />
                      <span className="text-sm text-[var(--muted)]">s</span>
                    </div>
                  </div>
                ) : (
                  <div>
                    <label className="text-xs text-[var(--muted)] block mb-1">Frecuencia de muestreo fs (Hz)</label>
                    <div className="flex gap-2 items-center">
                      <input
                        type="number"
                        step="any"
                        min="0"
                        value={fs}
                        onChange={(e) => { setFs(e.target.value); setDt(e.target.value ? String(1 / parseFloat(e.target.value)) : '') }}
                        placeholder="ej. 100"
                        className="flex-1 bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm"
                      />
                      <span className="text-sm text-[var(--muted)]">Hz</span>
                    </div>
                  </div>
                )}

                {/* Vista previa de estadísticas */}
                {computedDt() && (
                  <div className="grid grid-cols-2 gap-3 mt-1">
                    {[
                      ['Δt', computedDt()!.toFixed(5) + ' s'],
                      ['fs', (computedFs() ?? 0).toFixed(2) + ' Hz'],
                      ['Nyquist', (nyquist() ?? 0).toFixed(2) + ' Hz'],
                      ['Duración', durPreview],
                      ['Muestras', detected ? effectiveNSamples().toLocaleString() : '—'],
                    ].map(([k, v]) => (
                      <div key={k} className="bg-[var(--surface)] rounded-lg px-3 py-2">
                        <div className="text-xs text-[var(--muted)]">{k}</div>
                        <div className="text-sm font-mono font-semibold">{v}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Nombre del registro */}
            <div>
              <label className="text-xs text-[var(--muted)] block mb-1">Nombre del registro</label>
              <input
                type="text"
                value={recordName}
                onChange={(e) => setRecordName(e.target.value)}
                placeholder="ej. GM01 — Estación ABC, N-S"
                className="w-full bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm"
              />
            </div>

            {/* Metadatos avanzados */}
            <div>
              <button
                onClick={() => setShowMeta(v => !v)}
                className="text-sm text-[var(--accent)] hover:underline"
              >
                {showMeta ? '▲ Ocultar' : '▼ Metadatos avanzados (opcional)'}
              </button>
              {showMeta && (
                <div className="grid grid-cols-2 gap-3 mt-3">
                  {(Object.keys(metadata) as (keyof typeof metadata)[]).map(key => (
                    <div key={key}>
                      <label className="text-xs text-[var(--muted)] block mb-1 capitalize">{key}</label>
                      <input
                        type="text"
                        value={metadata[key]}
                        onChange={(e) => setMetadata(prev => ({ ...prev, [key]: e.target.value }))}
                        className="w-full bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm"
                        placeholder={key === 'earthquake' ? 'Northridge 1994' :
                                     key === 'station'    ? 'SCE-078' :
                                     key === 'component'  ? 'N-S' : ''}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── PASO 4: Validación ────────────────────────────────────────── */}
        {step === 4 && detected && (
          <div className="max-w-2xl mx-auto flex flex-col gap-5">
            <div>
              <h2 className="text-lg font-semibold">Listo para importar</h2>
              <p className="text-sm text-[var(--muted)] mt-1">
                Revisa la configuración antes de crear el registro de movimiento del suelo.
              </p>
            </div>

            <div className="bg-[var(--surface-alt)] rounded-xl p-5 grid grid-cols-3 gap-y-4">
              <Kv label="Nombre"       value={recordName || detected.filename} />
              <Kv label="Archivo"      value={detected.filename} />
              <Kv label="Formato"      value={detected.file_format.toUpperCase()} />
              <Kv label="Muestras"     value={effectiveNSamples().toLocaleString()} />
              <Kv label="Modo"         value={flatten ? `Serie continua (${detected.n_cols} col/línea)` : 'Canales independientes'} />
              <Kv label="Δt"           value={needsDt
                ? (computedDt() ? computedDt()!.toFixed(5) + ' s' : '—')
                : (detected.header_metadata.dt ? detected.header_metadata.dt + ' s' : '(de columna tiempo)')} />
              <Kv label="Duración"     value={durPreview} />
              <Kv label="fs"           value={computedFs() ? computedFs()!.toFixed(2) + ' Hz' : '—'} />
              <Kv label="Nyquist"      value={nyquist() ? nyquist()!.toFixed(2) + ' Hz' : '—'} />
              <Kv label="Componentes"  value={mappings.filter(m => m.quantity === 'acceleration').map(m => m.component || 'predeterminado').join(', ') || '—'} />
            </div>

            {/* Canales mapeados */}
            <div>
              <p className="text-xs font-medium text-[var(--muted)] mb-2 uppercase tracking-wider">Mapeo de canales</p>
              <div className="flex flex-wrap gap-2">
                {mappings.filter(m => m.quantity !== 'ignore').map((m, i) => (
                  <span key={i} className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full bg-[var(--surface-alt)] border border-[var(--border)]">
                    <span className="font-mono">{detected.columns[m.col_index]?.header}</span>
                    <span className="text-[var(--muted)]">→</span>
                    <span className="font-medium">{m.quantity}</span>
                    <span className="text-[var(--accent)]">[{m.unit}]</span>
                    {m.component && <span className="text-[var(--muted)]">/ {m.component}</span>}
                  </span>
                ))}
              </div>
            </div>

            {/* Verificaciones */}
            <div className="border border-[var(--border)] rounded-xl overflow-hidden">
              <div className="px-4 py-2 bg-[var(--surface-alt)] text-xs font-medium text-[var(--muted)]">
                Verificaciones previas a la importación
              </div>
              {[
                [hasAccChannel, 'Canal de aceleración definido'],
                [needsDt ? !!computedDt() : true, 'Paso de tiempo definido'],
                [needsDt ? (computedDt() ?? 0) > 0 : true, 'Δt > 0'],
                [detected.n_rows > 0, `Filas de datos: ${detected.n_rows.toLocaleString()}`],
                ...(flatten ? [
                  [!hasTimeChannel, 'Sin columna de tiempo (requerido en modo serie continua)'] as [boolean, string],
                  [flattenQuantitiesOk && flattenUnitsOk, 'Todas las columnas comparten magnitud y unidad'] as [boolean, string],
                ] : []),
                [detected.warnings.length === 0, detected.warnings.length === 0 ? 'Sin advertencias' : `${detected.warnings.length} advertencia(s)`],
              ].map(([ok, label], i) => (
                <div key={i} className={`flex items-center gap-3 px-4 py-2.5 text-sm border-t border-[var(--border)]
                  ${ok ? '' : 'bg-red-500/5'}`}>
                  <span className={ok ? 'text-emerald-400' : 'text-red-400'}>{ok ? '✓' : '✕'}</span>
                  <span className={ok ? '' : 'text-red-400'}>{String(label)}</span>
                </div>
              ))}
            </div>

            {error && (
              <p className="text-sm text-red-400 bg-red-500/10 px-4 py-3 rounded-lg">{error}</p>
            )}
          </div>
        )}
      </div>

      {/* Footer / navegación */}
      <div className="flex items-center justify-between px-8 py-4 border-t border-[var(--border)]">
        <button
          onClick={() => { if (step > 1) setStep((step - 1) as WizardStep); else onCancel?.() }}
          className="px-4 py-2 rounded-lg text-sm border border-[var(--border)] hover:bg-[var(--surface-alt)] transition-colors"
        >
          {step === 1 ? 'Cancelar' : '← Atrás'}
        </button>

        <div className="flex gap-3">
          {step < 4 ? (
            <button
              disabled={
                (step === 2 && (!hasAccChannel || !flattenValid)) ||
                (step === 3 && needsDt && !computedDt())
              }
              onClick={() => setStep((step + 1) as WizardStep)}
              className="px-6 py-2 rounded-lg text-sm font-medium bg-[var(--accent)] text-white
                         disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
            >
              Siguiente →
            </button>
          ) : (
            <button
              disabled={isLoading || !hasAccChannel || !flattenValid || (needsDt && !computedDt())}
              onClick={handleCreate}
              className="px-8 py-2 rounded-lg text-sm font-medium bg-[var(--accent)] text-white
                         disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
            >
              {isLoading ? 'Creando…' : 'Crear Registro de Movimiento del Suelo'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function Kv({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-[var(--muted)]">{label}</div>
      <div className="text-sm font-semibold mt-0.5 font-mono truncate">{value}</div>
    </div>
  )
}
