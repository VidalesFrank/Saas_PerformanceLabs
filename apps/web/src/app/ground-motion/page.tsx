'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AppHeader } from '@/components/app-header'
import { useRequireAuth } from '@/lib/use-require-auth'
import { GMRecord } from '@/lib/ground-motion-types'
import { deleteRecord, listRecords } from '@/lib/ground-motion-api'
import ImportWizard from '@/components/ground-motion/ImportWizard'

export default function GroundMotionListPage() {
  useRequireAuth()
  const router = useRouter()

  const [records, setRecords]     = useState<GMRecord[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [showWizard, setShowWizard] = useState(false)

  useEffect(() => {
    loadRecords()
  }, [])

  const loadRecords = async () => {
    setIsLoading(true)
    try {
      const data = await listRecords()
      setRecords(data)
    } catch {}
    setIsLoading(false)
  }

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`¿Eliminar el registro "${name}"?`)) return
    await deleteRecord(id)
    setRecords(prev => prev.filter(r => r.id !== id))
  }

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

  return (
    <div className="flex flex-col h-screen">
      <AppHeader crumb="Análisis de Movimiento del Suelo" />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-6 py-8">
          {/* Encabezado */}
          <div className="flex items-start justify-between mb-8">
            <div>
              <h1 className="text-2xl font-bold text-[var(--foreground)]">Análisis de Movimiento del Suelo</h1>
              <p className="text-sm text-[var(--muted)] mt-1">
                Importa, procesa y analiza registros sísmicos de aceleración.
                Calcula espectros de respuesta, medidas de intensidad, contenido frecuencial y respuesta SDOF.
              </p>
            </div>
            <button
              onClick={() => setShowWizard(true)}
              className="px-5 py-2.5 bg-[var(--accent)] text-white rounded-xl text-sm font-medium
                         hover:opacity-90 transition-opacity flex items-center gap-2"
            >
              <span>+</span> Importar Registro
            </button>
          </div>

          {/* Capacidades del módulo */}
          {records.length === 0 && !isLoading && (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-8">
              {[
                { icon: '📥', title: 'Importación Universal', desc: 'TXT, CSV, XLS, XLSX. Detección automática de estructura y mapeo flexible de columnas.' },
                { icon: '📊', title: 'Historia de Tiempo', desc: 'Aceleración, velocidad y desplazamiento (integración numérica).' },
                { icon: '⚡', title: 'Medidas de Intensidad', desc: 'PGA, PGV, PGD, Arias, CAV, D5-95, RMS y más.' },
                { icon: '🔧', title: 'Procesamiento de Señal', desc: 'Corrección de línea base y filtrado Butterworth (fase cero).' },
                { icon: '📈', title: 'Análisis Frecuencial', desc: 'Espectro de amplitud FFT y Densidad Espectral de Potencia (Welch).' },
                { icon: '🌊', title: 'Espectro de Respuesta', desc: 'Espectros elásticos Sd, Sv, Sa, PSA, PSV — Newmark-β — múltiples ξ.' },
              ].map(c => (
                <div key={c.title} className="bg-[var(--surface-alt)] rounded-xl p-4 border border-[var(--border)]">
                  <div className="text-2xl mb-2">{c.icon}</div>
                  <div className="text-sm font-semibold">{c.title}</div>
                  <div className="text-xs text-[var(--muted)] mt-1">{c.desc}</div>
                </div>
              ))}
            </div>
          )}

          {/* Lista de registros */}
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
                className="px-6 py-2.5 bg-[var(--accent)] text-white rounded-xl text-sm font-medium hover:opacity-90 transition-opacity"
              >
                Importar Registro
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {records.map(r => (
                <div key={r.id}
                  className="bg-[var(--surface-alt)] border border-[var(--border)] rounded-xl px-5 py-4
                             flex items-center gap-4 hover:border-[var(--accent)]/40 transition-colors group">
                  <Link href={`/ground-motion/${r.id}`} className="flex-1 flex items-center gap-4 min-w-0">
                    <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-400 text-lg flex-shrink-0">
                      ≈
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold truncate group-hover:text-[var(--accent)] transition-colors">
                        {r.name}
                      </p>
                      <p className="text-xs text-[var(--muted)] mt-0.5 truncate">
                        {r.source_file}
                      </p>
                    </div>
                    <div className="hidden md:grid grid-cols-4 gap-6 text-right flex-shrink-0">
                      <Stat label="Δt" value={r.dt ? r.dt.toFixed(4) + ' s' : '—'} />
                      <Stat label="Muestras" value={r.n_samples?.toLocaleString() ?? '—'} />
                      <Stat label="Duración" value={r.duration ? r.duration.toFixed(2) + ' s' : '—'} />
                      <Stat label="Unidad" value={r.acc_unit_original ?? '—'} />
                    </div>
                  </Link>
                  <button
                    onClick={() => handleDelete(r.id, r.name)}
                    className="p-2 text-[var(--muted)] hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
                    title="Eliminar registro"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-[var(--muted)]">{label}</div>
      <div className="text-sm font-mono font-semibold">{value}</div>
    </div>
  )
}
