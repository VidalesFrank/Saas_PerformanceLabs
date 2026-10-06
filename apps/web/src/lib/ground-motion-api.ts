// Cliente de API para el módulo Ground Motion Analysis

import {
  CreateRecordRequest,
  DetectedStructure,
  FFTResult,
  GMRecord,
  IntensityMeasures,
  ProcessResult,
  SpectrumAtPeriodResult,
  SpectrumMultiXiResult,
  SpectrumResult,
  TimeseriesData,
} from './ground-motion-types'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'
const BASE = `${API_URL}/api/v1/ground-motion`

function authHeader(): Record<string, string> {
  if (typeof window === 'undefined') return {}
  const token = localStorage.getItem('pl_token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = await res.json()
      msg = body.detail || body.message || msg
    } catch {}
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}

// ── Detección de estructura ────────────────────────────────────────────────

export async function detectFileStructure(file: File): Promise<DetectedStructure> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${BASE}/detect`, { method: 'POST', body: form })
  return handleResponse<DetectedStructure>(res)
}

// ── Registros ──────────────────────────────────────────────────────────────

export async function createRecord(file: File, config: CreateRecordRequest): Promise<GMRecord> {
  const form = new FormData()
  form.append('file', file)
  form.append('config', JSON.stringify(config))
  const res = await fetch(`${BASE}/records`, {
    method: 'POST',
    headers: authHeader(),
    body: form,
  })
  return handleResponse<GMRecord>(res)
}

export async function listRecords(): Promise<GMRecord[]> {
  const res = await fetch(`${BASE}/records`, { headers: { ...authHeader() } })
  return handleResponse<GMRecord[]>(res)
}

export async function getRecord(id: string): Promise<GMRecord> {
  const res = await fetch(`${BASE}/records/${id}`, { headers: { ...authHeader() } })
  return handleResponse<GMRecord>(res)
}

export async function deleteRecord(id: string): Promise<void> {
  const res = await fetch(`${BASE}/records/${id}`, {
    method: 'DELETE',
    headers: authHeader(),
  })
  if (!res.ok && res.status !== 204) {
    throw new Error(`Error eliminando registro: HTTP ${res.status}`)
  }
}

// ── Historia de tiempo ─────────────────────────────────────────────────────

export async function getTimeseries(
  id: string,
  component = '',
  opts: { maxPoints?: number; full?: boolean } = {},
): Promise<TimeseriesData> {
  const qs = new URLSearchParams()
  if (component) qs.set('component', component)
  if (opts.maxPoints !== undefined) qs.set('max_points', String(opts.maxPoints))
  if (opts.full) qs.set('full', 'true')
  const url = `${BASE}/records/${id}/timeseries${qs.toString() ? '?' + qs.toString() : ''}`
  const res = await fetch(url, { headers: { ...authHeader() } })
  return handleResponse<TimeseriesData>(res)
}

// ── Procesamiento ──────────────────────────────────────────────────────────

export async function processSignal(
  id: string,
  params: {
    operation: string
    component?: string
    baseline_method?: string
    polynomial_order?: number
    filter_type?: string
    fc_low?: number | null
    fc_high?: number | null
    filter_order?: number
  }
): Promise<ProcessResult> {
  const res = await fetch(`${BASE}/records/${id}/process`, {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  return handleResponse<ProcessResult>(res)
}

// ── Intensidad sísmica ─────────────────────────────────────────────────────

export async function computeIntensity(id: string, component = ''): Promise<IntensityMeasures> {
  const url = `${BASE}/records/${id}/intensity${component ? `?component=${component}` : ''}`
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeader(),
  })
  return handleResponse<IntensityMeasures>(res)
}

// ── FFT ────────────────────────────────────────────────────────────────────

export async function computeFFT(id: string, component = ''): Promise<FFTResult> {
  const url = `${BASE}/records/${id}/fft${component ? `?component=${component}` : ''}`
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeader(),
  })
  return handleResponse<FFTResult>(res)
}

// ── Espectro de respuesta ──────────────────────────────────────────────────

export async function computeSpectrum(
  id: string,
  params: {
    component?: string
    xi?: number
    xi_list?: number[]
    T_min?: number
    T_max?: number
    n_points?: number
    multi_xi?: boolean
  }
): Promise<SpectrumResult | SpectrumMultiXiResult> {
  const res = await fetch(`${BASE}/records/${id}/spectrum`, {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  return handleResponse<SpectrumResult | SpectrumMultiXiResult>(res)
}

export async function exportSpectrum(
  id: string,
  params: {
    component?: string
    xi_list?: number[]
    T_min?: number
    T_max?: number
    n_points?: number
  },
  format: 'xlsx' | 'txt',
): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch(`${BASE}/records/${id}/spectrum/export?format=${format}`, {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...params, multi_xi: true }),
  })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = await res.json()
      msg = body.detail || body.message || msg
    } catch {}
    throw new Error(msg)
  }
  // Content-Disposition suele venir como: attachment; filename="foo.xlsx"
  const dispo = res.headers.get('Content-Disposition') || ''
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(dispo)
  const filename = match ? decodeURIComponent(match[1]) : `espectros.${format}`
  const blob = await res.blob()
  return { blob, filename }
}

export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function spectrumAtPeriod(
  id: string,
  T: number,
  xi = 0.05,
  component = ''
): Promise<SpectrumAtPeriodResult> {
  const res = await fetch(`${BASE}/records/${id}/spectrum/at-period`, {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ T, xi, component }),
  })
  return handleResponse<SpectrumAtPeriodResult>(res)
}

// ── Helpers de formateo ────────────────────────────────────────────────────

export function formatPGA(pga_ms2: number, unit: string): string {
  const G = 9.80665
  switch (unit) {
    case 'g':    return `${(pga_ms2 / G).toFixed(4)} g`
    case 'cm/s²': return `${(pga_ms2 * 100).toFixed(3)} cm/s²`
    case 'Gal':  return `${(pga_ms2 * 100).toFixed(3)} Gal`
    default:     return `${pga_ms2.toFixed(4)} m/s²`
  }
}

export function formatDuration(seconds: number): string {
  return `${seconds.toFixed(3)} s`
}

export function formatDt(dt: number): string {
  return `${dt.toFixed(4)} s`
}
