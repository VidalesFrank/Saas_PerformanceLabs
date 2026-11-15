"use client";

/** Chip compacto con label en caps + valor mono + hint opcional. Semaforizado
 * por `tone`. Pensado para strips resumen arriba de paneles técnicos (IDA Ola C,
 * NLRHA, pushover, etc.). */

export type ChipTone = "indigo" | "emerald" | "amber" | "rose" | "neutral";

export const CHIP_CLASS: Record<ChipTone, string> = {
  indigo:  "bg-indigo-500/15 border-indigo-500/40 text-indigo-600 dark:text-indigo-300",
  emerald: "bg-emerald-500/15 border-emerald-500/40 text-emerald-600 dark:text-emerald-300",
  amber:   "bg-amber-500/15 border-amber-500/40 text-amber-600 dark:text-amber-300",
  rose:    "bg-rose-500/15 border-rose-500/40 text-rose-600 dark:text-rose-300",
  neutral: "bg-[var(--panel-muted)]/50 border-[var(--panel-muted)] text-[var(--text-muted)]",
};

export function SummaryChip({
  label, value, hint, tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: ChipTone;
}) {
  return (
    <div className={`flex flex-col rounded-md border px-2.5 py-1.5 min-w-[9rem] ${CHIP_CLASS[tone]}`}>
      <div className="text-[9.5px] uppercase tracking-wider font-bold opacity-80">{label}</div>
      <div className="font-mono font-bold text-sm leading-tight">{value}</div>
      {hint && <div className="text-[9.5px] opacity-75 leading-tight">{hint}</div>}
    </div>
  );
}
