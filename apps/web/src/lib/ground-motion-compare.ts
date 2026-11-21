// Helpers específicos del panel de comparación multi-registro.
// Bajada paralela de spectrum + intensity por registro.

import { computeIntensity, computeSpectrum, getRecord } from './ground-motion-api'
import type {
  GMRecord,
  IntensityMeasures,
  SpectrumResult,
} from './ground-motion-types'

export interface CompareRecordBundle {
  id: string
  record: GMRecord
  spectrum: SpectrumResult
  intensity: IntensityMeasures
  error?: string
}

export interface CompareLoadResult {
  bundles: CompareRecordBundle[]
  errors: { id: string; message: string }[]
}

// Carga paralela de n registros con sus espectros e intensidades. Falla suave:
// un registro roto no impide mostrar el resto.
export async function loadCompareBundles(
  ids: string[],
  spectrumParams: {
    xi?: number
    T_min?: number
    T_max?: number
    n_points?: number
  } = {},
): Promise<CompareLoadResult> {
  const xi = spectrumParams.xi ?? 0.05
  const T_min = spectrumParams.T_min ?? 0.01
  const T_max = spectrumParams.T_max ?? 4.0
  const n_points = spectrumParams.n_points ?? 150

  const results = await Promise.allSettled(
    ids.map(async (id): Promise<CompareRecordBundle> => {
      const [record, spectrumRaw, intensity] = await Promise.all([
        getRecord(id),
        computeSpectrum(id, { xi, T_min, T_max, n_points, multi_xi: false }),
        computeIntensity(id),
      ])
      // multi_xi:false → SpectrumResult; defensa por si viene multi
      const spectrum = ('spectra' in spectrumRaw)
        ? _flattenMulti(spectrumRaw as unknown as { T: number[]; spectra: Record<string, { Sa: number[]; Sd: number[]; Sv: number[]; PSA: number[]; PSV: number[] }>; component: string; record_name: string }, xi)
        : (spectrumRaw as SpectrumResult)
      return { id, record, spectrum, intensity }
    }),
  )

  const bundles: CompareRecordBundle[] = []
  const errors: { id: string; message: string }[] = []
  results.forEach((res, i) => {
    if (res.status === 'fulfilled') bundles.push(res.value)
    else errors.push({ id: ids[i], message: res.reason?.message ?? 'Error desconocido' })
  })
  return { bundles, errors }
}

function _flattenMulti(
  multi: { T: number[]; spectra: Record<string, { Sa: number[]; Sd: number[]; Sv: number[]; PSA: number[]; PSV: number[] }>; component: string; record_name: string },
  xi: number,
): SpectrumResult {
  const key = xi.toFixed(4)
  const spec = multi.spectra[key] || Object.values(multi.spectra)[0]
  return {
    T: multi.T,
    Sa: spec.Sa, Sd: spec.Sd, Sv: spec.Sv, PSA: spec.PSA, PSV: spec.PSV,
    xi,
    component: multi.component,
    record_name: multi.record_name,
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Detección de pares NS+EW para RotD50/RotD100
// ──────────────────────────────────────────────────────────────────────────
export interface StationPair {
  id: string                 // station|h1Id|h2Id — único, estable
  station: string
  h1: CompareRecordBundle    // componente H1 (NS por convención)
  h2: CompareRecordBundle    // componente H2 (EW por convención)
}

const H_COMPONENTS = ['NS', 'EW'] as const
const H1_PREF = ['NS', 'N', 'H1', 'X']
const H2_PREF = ['EW', 'E', 'H2', 'Y']

function _comp(b: CompareRecordBundle): string {
  const md = b.record.metadata_json || {}
  return ((md.component as string) || '').toUpperCase().trim()
}
function _station(b: CompareRecordBundle): string {
  const md = b.record.metadata_json || {}
  return (md.station as string) || b.record.name
}

// Agrupa bundles por estación y detecta pares horizontales ortogonales.
export function detectStationPairs(bundles: CompareRecordBundle[]): StationPair[] {
  const byStation = new Map<string, CompareRecordBundle[]>()
  for (const b of bundles) {
    const key = _station(b)
    if (!byStation.has(key)) byStation.set(key, [])
    byStation.get(key)!.push(b)
  }
  const pairs: StationPair[] = []
  for (const [station, group] of byStation) {
    if (group.length < 2) continue
    const h1 = group.find((b) => H1_PREF.includes(_comp(b)))
    const h2 = group.find((b) => H2_PREF.includes(_comp(b)))
    if (h1 && h2 && h1.id !== h2.id) {
      pairs.push({
        id: `${station}|${h1.id}|${h2.id}`,
        station,
        h1,
        h2,
      })
    }
  }
  return pairs
}

// Paleta cíclica para hasta 8 registros — tonos saturados, legibles sobre tema claro/oscuro.
export const COMPARE_PALETTE = [
  '#3b82f6', // blue
  '#ef4444', // red
  '#10b981', // emerald
  '#f59e0b', // amber
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#14b8a6', // teal
  '#f97316', // orange
] as const

export function colorFor(index: number): string {
  return COMPARE_PALETTE[index % COMPARE_PALETTE.length]
}

// Etiqueta corta para leyenda / chip: "ESTACION-NS"
export function shortLabel(record: GMRecord): string {
  const md = record.metadata_json || {}
  const station = (md.station as string) || ''
  const component = ((md.component as string) || '').toUpperCase()
  if (station && component) return `${station}-${component}`
  if (station) return station
  return record.name
}
