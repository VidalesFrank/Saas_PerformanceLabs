// Componentes visuales compartidos por los paneles de Ground Motion.
// Mantiene un lenguaje visual coherente: cabeceras, KPI cards, wrappers
// de gráficas Plotly y notas al pie.

import type { ReactNode } from 'react'

// ── Cabecera de un panel ─────────────────────────────────────────────────────
export function SectionHeader({
  title, subtitle, chip,
}: { title: string; subtitle: string; chip?: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h2 className="text-lg font-bold text-[var(--foreground)] tracking-tight">{title}</h2>
        <p className="text-sm text-[var(--muted)] mt-0.5 max-w-2xl">{subtitle}</p>
      </div>
      {chip && (
        <span className="hidden md:inline-flex items-center px-3 py-1 rounded-full
          bg-[var(--surface-alt)] border border-[var(--border)]
          text-[11px] font-mono font-semibold text-[var(--muted)] tracking-wider whitespace-nowrap">
          {chip}
        </span>
      )}
    </div>
  )
}

// ── Cabecera de una sub-sección dentro del panel ─────────────────────────────
export function Section({
  title, hint, children,
}: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section>
      <div className="flex items-baseline gap-2 mb-3">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--foreground)]">
          {title}
        </h3>
        {hint && <span className="text-[11px] text-[var(--muted)] italic">— {hint}</span>}
      </div>
      {children}
    </section>
  )
}

// ── KPI card premium con barra izquierda de color y chip de unidad ──────────
export function KpiCard({
  label, value, unit, sub, accent, tooltip,
}: {
  label: string
  value: string
  unit: string
  sub?: string
  accent: string
  tooltip?: string
}) {
  return (
    <div
      className="relative bg-[var(--surface)] border border-[var(--border)] rounded-xl
                 px-4 py-3.5 overflow-hidden transition-all
                 hover:-translate-y-0.5 hover:shadow-lg"
      style={{ boxShadow: `inset 3px 0 0 0 ${accent}` }}
      title={tooltip}
    >
      <div className="flex items-start justify-between">
        <span className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-[var(--muted)]">
          {label}
        </span>
        <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded"
              style={{ background: `${accent}18`, color: accent }}>
          {unit}
        </span>
      </div>
      <div className="text-[26px] font-bold font-mono mt-1.5 leading-none tabular-nums text-[var(--foreground)]">
        {value}
      </div>
      {sub && <div className="text-[11px] text-[var(--muted)] mt-2 truncate font-mono">{sub}</div>}
    </div>
  )
}

// ── Wrapper de gráfica con cabecera y chip de unidad ────────────────────────
export function ChartCard({
  title, unitBadge, accent, children,
}: { title: string; unitBadge?: string; accent: string; children: ReactNode }) {
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl overflow-hidden
                    shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border)]">
        <div className="flex items-center gap-2.5">
          <span className="w-1.5 h-4 rounded-sm" style={{ background: accent }} />
          <h4 className="text-sm font-semibold text-[var(--foreground)]">{title}</h4>
        </div>
        {unitBadge && (
          <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded"
                style={{ background: `${accent}18`, color: accent }}>
            {unitBadge}
          </span>
        )}
      </div>
      <div className="p-2">{children}</div>
    </div>
  )
}

// ── Nota al pie con línea de acento ─────────────────────────────────────────
export function FooterNote({ children }: { children: ReactNode }) {
  return (
    <p className="text-[11.5px] text-[var(--muted)] leading-relaxed
                  bg-[var(--surface-alt)] border-l-2 border-[var(--border)] pl-3 py-2 rounded-r-md">
      {children}
    </p>
  )
}

// ── Empty state (para paneles con cálculo bajo demanda) ─────────────────────
export function EmptyState({
  icon, title, subtitle,
}: { icon: string; title: string; subtitle: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3
                    bg-[var(--surface-alt)] border border-dashed border-[var(--border)] rounded-2xl">
      <div className="w-14 h-14 rounded-full bg-[var(--surface)] border border-[var(--border)]
                      flex items-center justify-center text-2xl">{icon}</div>
      <div className="text-center">
        <p className="text-sm font-semibold text-[var(--foreground)]">{title}</p>
        <p className="text-xs text-[var(--muted)] mt-1">{subtitle}</p>
      </div>
    </div>
  )
}

// ── Segmented control (pill toolbar) ────────────────────────────────────────
export function SegmentedControl<T extends string>({
  value, onChange, options,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
}) {
  return (
    <div className="flex gap-1 bg-[var(--surface-alt)] rounded-lg p-1">
      {options.map(o => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`px-3 py-1 rounded-md text-xs font-semibold transition-all
            ${value === o.value
              ? 'bg-[var(--surface)] text-[var(--foreground)] shadow-sm ring-1 ring-[var(--border)]'
              : 'text-[var(--muted)] hover:text-[var(--foreground)]'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ── Error banner ────────────────────────────────────────────────────────────
export function ErrorBanner({ message }: { message: string }) {
  return (
    <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 px-3 py-2 rounded-lg">
      {message}
    </p>
  )
}

// ── Warning de precisión Δt/T (Newmark-β) ──────────────────────────────────
// El método Newmark aceleración promedio es O(Δt²). Para Δt/T > 0.1 el error
// en el pico Sd puede superar 5-7%. Se recomienda Δt/T ≤ 0.05 → T_min ≥ 20·Δt.
// Este banner alerta al usuario cuando su T_min queda por debajo de este umbral.
export function AccuracyBanner({
  dt, tMin, tolPct = 5,
}: { dt?: number | null; tMin: number; tolPct?: number }) {
  if (!dt || dt <= 0 || tMin <= 0) return null

  const tSafe   = 20 * dt        // dt/T = 0.05 → error < 1%
  const tWarn   = 10 * dt        // dt/T = 0.10 → error ≈ 5-7%
  const ratio   = dt / tMin
  const level: 'safe' | 'warn' | 'danger' =
    tMin >= tSafe ? 'safe' : tMin >= tWarn ? 'warn' : 'danger'

  if (level === 'safe') {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg
                      bg-emerald-500/10 border border-emerald-500/25">
        <span className="text-emerald-500 text-xs font-bold">✓</span>
        <span className="text-[11.5px] text-[var(--muted)]">
          Δt = <strong className="font-mono text-[var(--foreground)]">{dt.toFixed(4)} s</strong>,
          T_min = <strong className="font-mono text-[var(--foreground)]">{tMin.toFixed(3)} s</strong> —
          ratio Δt/T = <strong className="font-mono">{ratio.toFixed(3)}</strong> ≤ 0.05.
          Precisión Newmark-β {'<'} 1% en el pico.
        </span>
      </div>
    )
  }

  const isDanger = level === 'danger'
  const color = isDanger ? 'red' : 'amber'
  const errorEst = isDanger ? '> 10%' : `~ ${tolPct}–7%`
  const cls = isDanger
    ? 'bg-red-500/10 border-red-500/30 text-red-400'
    : 'bg-amber-500/10 border-amber-500/30 text-amber-500'

  return (
    <div className={`flex items-start gap-2 px-3 py-2.5 rounded-lg border ${cls}`}>
      <span className={`text-${color}-500 text-xs font-bold pt-0.5`}>⚠</span>
      <div className="text-[11.5px] leading-relaxed text-[var(--muted)]">
        <span className={`font-bold text-${color}-500`}>
          {isDanger ? 'Precisión reducida' : 'Precisión limitada en T corto'}
        </span>
        {' — '}
        Δt del registro = <strong className="font-mono text-[var(--foreground)]">{dt.toFixed(4)} s</strong>,
        T_min elegido = <strong className="font-mono text-[var(--foreground)]">{tMin.toFixed(3)} s</strong>.
        Ratio Δt/T = <strong className="font-mono">{ratio.toFixed(3)}</strong>
        {isDanger ? ' > 0.10' : ' entre 0.05 y 0.10'} → error estimado en Sd(T_min) {errorEst}.
        Recomendado: T_min ≥ <strong className="font-mono text-[var(--foreground)]">{tSafe.toFixed(3)} s</strong> (20·Δt).
      </div>
    </div>
  )
}
