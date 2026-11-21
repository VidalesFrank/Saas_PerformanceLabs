// Export del panel de comparación multi-registro: CSV, PNG y PDF.

import type { CompareRecordBundle, StationPair } from './ground-motion-compare'
import type { RotDResult } from './ground-motion-types'
import type { ReferenceSpectrum } from '@/components/ground-motion/ReferenceSpectraPanel'
import { shortLabel } from './ground-motion-compare'

const G = 9.80665

declare const window: Window & { Plotly: any }

type SpecTab = 'Sa' | 'Sd' | 'Sv' | 'PSA' | 'PSV'

// ──────────────────────────────────────────────────────────────────────────
// Interpolación lineal a grilla común.
// ──────────────────────────────────────────────────────────────────────────
function interp(Tsrc: number[], Ysrc: number[], Ttgt: number[]): number[] {
  const out = new Array<number>(Ttgt.length)
  let j = 0
  for (let i = 0; i < Ttgt.length; i++) {
    const t = Ttgt[i]
    while (j < Tsrc.length - 2 && Tsrc[j + 1] < t) j++
    if (t <= Tsrc[0]) { out[i] = Ysrc[0]; continue }
    if (t >= Tsrc[Tsrc.length - 1]) { out[i] = Ysrc[Ysrc.length - 1]; continue }
    const t0 = Tsrc[j], t1 = Tsrc[j + 1]
    const y0 = Ysrc[j], y1 = Ysrc[j + 1]
    const f = (t - t0) / (t1 - t0)
    out[i] = y0 + f * (y1 - y0)
  }
  return out
}

function yOfRecord(b: CompareRecordBundle, tab: SpecTab): number[] {
  if (tab === 'Sa' || tab === 'PSA') return (b.spectrum as any)[tab].map((v: number) => v / G)
  if (tab === 'Sv' || tab === 'PSV') return (b.spectrum as any)[tab].map((v: number) => v * 100)
  return b.spectrum.Sd.map((v) => v * 100)
}

function yOfRef(ref: ReferenceSpectrum, tab: SpecTab): number[] {
  if (tab === 'Sa' || tab === 'PSA') return ref.puntos.map((p) => p.Sa)
  if (tab === 'Sd') return ref.puntos.map((p) => p.Sd)
  return ref.puntos.map((p) => p.Sv)
}

function unitOf(tab: SpecTab): string {
  return tab === 'Sa' || tab === 'PSA' ? 'g' : tab === 'Sd' ? 'cm' : 'cm/s'
}

// ──────────────────────────────────────────────────────────────────────────
// CSV — tabla IMs + espectros alineados a grilla común
// ──────────────────────────────────────────────────────────────────────────
interface RotDExport {
  pair: StationPair
  rotd: RotDResult
}

export function exportCompareCSV(
  bundles: CompareRecordBundle[],
  refs: ReferenceSpectrum[],
  tab: SpecTab,
  opts: { xi: number; TMax: number },
  rotdExports: RotDExport[] = [],
): void {
  if (bundles.length === 0) return
  const Tgrid = bundles[0].spectrum.T
  const unit = unitOf(tab)

  const header: string[] = [
    `# Comparación de registros · PerformanceLabs`,
    `# Métrica: ${tab} (${unit})  ξ=${(opts.xi * 100).toFixed(1)}%  T_max=${opts.TMax}s`,
    `# Registros: ${bundles.length}  Referencias: ${refs.length}`,
    `#`,
    `# Medidas de intensidad`,
    `#`,
    [
      'Métrica',
      ...bundles.map((b) => shortLabel(b.record)),
    ].join(','),
  ]

  const imFields: { key: keyof CompareRecordBundle['intensity']; label: string; unit: string }[] = [
    { key: 'pga_g',              label: 'PGA (g)',            unit: 'g' },
    { key: 'pgv_cms',            label: 'PGV (cm/s)',         unit: 'cm/s' },
    { key: 'pgd_cm',             label: 'PGD (cm)',           unit: 'cm' },
    { key: 'arias_intensity_ms', label: 'Arias (m/s)',        unit: 'm/s' },
    { key: 'cav_ms',             label: 'CAV (m/s)',          unit: 'm/s' },
    { key: 'D5_95',              label: 'D5-95 (s)',          unit: 's' },
    { key: 'D5_75',              label: 'D5-75 (s)',          unit: 's' },
    { key: 'duration_record',    label: 'Duración (s)',       unit: 's' },
  ]

  for (const f of imFields) {
    header.push([
      f.label,
      ...bundles.map((b) => String((b.intensity[f.key] ?? '')).replace(',', '.')),
    ].join(','))
  }

  header.push('#')
  header.push(`# Espectros ${tab} (${unit}) — grilla común interpolada`)
  if (rotdExports.length > 0 && (tab === 'Sa' || tab === 'PSA')) {
    header.push(`# RotD50/RotD100 incluidos (Sa en ${unit})`)
  }
  header.push('#')
  const rotdHeaderCols: string[] = []
  if (tab === 'Sa' || tab === 'PSA') {
    rotdExports.forEach((e) => {
      rotdHeaderCols.push(`RotD50 ${e.pair.station}`, `RotD100 ${e.pair.station}`)
    })
  }
  header.push([
    'T (s)',
    ...bundles.map((b) => shortLabel(b.record)),
    ...refs.map((r) => `REF: ${r.label}`),
    ...rotdHeaderCols,
  ].join(','))

  const columns: number[][] = [
    ...bundles.map((b) => interp(b.spectrum.T, yOfRecord(b, tab), Tgrid)),
    ...refs.map((r) => interp(r.puntos.map((p) => p.T), yOfRef(r, tab), Tgrid)),
  ]
  // RotD a Tgrid — Sa_RotD viene en m/s², convertir a g
  if (tab === 'Sa' || tab === 'PSA') {
    rotdExports.forEach((e) => {
      const SaD50 = e.rotd.RotD50.map((v) => v / G)
      const SaD100 = e.rotd.RotD100.map((v) => v / G)
      columns.push(interp(e.rotd.T, SaD50, Tgrid))
      columns.push(interp(e.rotd.T, SaD100, Tgrid))
    })
  }

  const rows: string[] = []
  for (let i = 0; i < Tgrid.length; i++) {
    const cells = [Tgrid[i].toFixed(4), ...columns.map((c) => c[i].toFixed(6))]
    rows.push(cells.join(','))
  }

  const blob = new Blob([header.join('\n') + '\n' + rows.join('\n')], {
    type: 'text/csv;charset=utf-8',
  })
  downloadBlob(blob, `comparacion-espectros-${tab.toLowerCase()}.csv`)
}

// ──────────────────────────────────────────────────────────────────────────
// PNG — snapshot del gráfico vía Plotly
// ──────────────────────────────────────────────────────────────────────────
export async function exportComparePNG(chartEl: HTMLElement | null, tab: SpecTab): Promise<void> {
  if (!chartEl || typeof window === 'undefined' || !window.Plotly) return
  await window.Plotly.downloadImage(chartEl, {
    format: 'png',
    filename: `comparacion-${tab.toLowerCase()}`,
    height: 900,
    width: 1600,
    scale: 2,
  })
}

// ──────────────────────────────────────────────────────────────────────────
// PDF — header + imagen del gráfico + tabla IMs + listado de referencias
// ──────────────────────────────────────────────────────────────────────────
export async function exportComparePDF(
  chartEl: HTMLElement | null,
  bundles: CompareRecordBundle[],
  refs: ReferenceSpectrum[],
  tab: SpecTab,
  opts: { xi: number; TMax: number; normalized: boolean },
  rotdExports: RotDExport[] = [],
): Promise<void> {
  if (!chartEl || typeof window === 'undefined' || !window.Plotly) return
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const margin = 14
  let y = 14

  doc.setFontSize(14)
  doc.setFont('helvetica', 'bold')
  doc.text('Comparación de espectros de respuesta', margin, y); y += 6
  doc.setFontSize(9); doc.setFont('helvetica', 'normal')
  doc.text(
    `Métrica: ${tab} · ξ=${(opts.xi * 100).toFixed(1)}% · T_max=${opts.TMax}s` +
    (opts.normalized && (tab === 'Sa' || tab === 'PSA') ? ' · normalizado por PGA' : '') +
    ` · ${bundles.length} registros · ${refs.length} referencias`,
    margin, y,
  ); y += 6

  // Imagen del gráfico — PNG en memoria desde Plotly
  const pngUrl = await window.Plotly.toImage(chartEl, {
    format: 'png', height: 700, width: 1400, scale: 2,
  }) as string
  const imgW = W - 2 * margin
  const imgH = imgW * (700 / 1400)
  doc.addImage(pngUrl, 'PNG', margin, y, imgW, imgH)
  y += imgH + 6

  // Tabla IMs (si cabe en la página, si no → nueva página)
  if (y + 40 > H - margin) { doc.addPage(); y = 14 }

  doc.setFontSize(10); doc.setFont('helvetica', 'bold')
  doc.text('Medidas de intensidad', margin, y); y += 5

  const imFields = [
    ['PGA', 'g',    (b: CompareRecordBundle) => b.intensity.pga_g.toFixed(4)],
    ['PGV', 'cm/s', (b: CompareRecordBundle) => b.intensity.pgv_cms.toFixed(2)],
    ['PGD', 'cm',   (b: CompareRecordBundle) => b.intensity.pgd_cm.toFixed(2)],
    ['Arias', 'm/s',(b: CompareRecordBundle) => b.intensity.arias_intensity_ms.toFixed(3)],
    ['CAV', 'm/s',  (b: CompareRecordBundle) => b.intensity.cav_ms.toFixed(2)],
    ['D5-95', 's',  (b: CompareRecordBundle) => b.intensity.D5_95.toFixed(2)],
    ['Duración', 's', (b: CompareRecordBundle) => b.intensity.duration_record.toFixed(2)],
  ] as const

  const colW = Math.min(28, (W - margin - 40) / bundles.length)
  doc.setFontSize(8); doc.setFont('helvetica', 'bold')
  doc.text('Métrica', margin, y)
  bundles.forEach((b, i) => {
    const label = shortLabel(b.record)
    doc.text(label.length > 14 ? label.slice(0, 13) + '…' : label, margin + 32 + i * colW, y, { align: 'left' })
  })
  y += 4
  doc.setDrawColor(180); doc.line(margin, y - 1, W - margin, y - 1)

  doc.setFont('helvetica', 'normal')
  for (const [label, unit, fmt] of imFields) {
    doc.text(`${label} (${unit})`, margin, y)
    bundles.forEach((b, i) => doc.text(String(fmt(b)), margin + 32 + i * colW, y))
    y += 4
    if (y > H - margin) { doc.addPage(); y = 14 }
  }

  // Lista de RotD exportados (si aplica al tab actual)
  if (rotdExports.length > 0 && (tab === 'Sa' || tab === 'PSA')) {
    y += 3
    if (y + 10 + rotdExports.length * 4 > H - margin) { doc.addPage(); y = 14 }
    doc.setFontSize(10); doc.setFont('helvetica', 'bold')
    doc.text('RotD50 / RotD100 (Boore 2010)', margin, y); y += 5
    doc.setFontSize(8); doc.setFont('helvetica', 'normal')
    for (const e of rotdExports) {
      const Rmax50 = Math.max(...e.rotd.RotD50) / G
      const Rmax100 = Math.max(...e.rotd.RotD100) / G
      doc.text(
        `• ${e.pair.station} · peak RotD50=${Rmax50.toFixed(3)}g · peak RotD100=${Rmax100.toFixed(3)}g · n_θ=${e.rotd.n_angles}`,
        margin, y,
      )
      y += 4
      if (y > H - margin) { doc.addPage(); y = 14 }
    }
  }

  // Lista de referencias
  if (refs.length > 0) {
    y += 3
    if (y + 10 + refs.length * 4 > H - margin) { doc.addPage(); y = 14 }
    doc.setFontSize(10); doc.setFont('helvetica', 'bold')
    doc.text('Espectros de referencia', margin, y); y += 5
    doc.setFontSize(8); doc.setFont('helvetica', 'normal')
    for (const r of refs) {
      doc.setFillColor(r.color)
      doc.rect(margin, y - 3, 3, 3, 'F')
      doc.text(`[${r.kind.toUpperCase()}] ${r.label}`, margin + 5, y)
      y += 4
      if (y > H - margin) { doc.addPage(); y = 14 }
    }
  }

  doc.save(`comparacion-${tab.toLowerCase()}.pdf`)
}

// ──────────────────────────────────────────────────────────────────────────
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
