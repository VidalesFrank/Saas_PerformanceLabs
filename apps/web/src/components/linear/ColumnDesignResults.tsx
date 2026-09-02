"use client";

import type { ColumnDesignResult, ColumnCheckRow } from "@/lib/structural-types";

// ── Sub-componentes ───────────────────────────────────────────────────────────

function SummaryCard({
  label, value, sub, color,
}: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 px-4 py-3 flex flex-col gap-0.5">
      <span className="text-[10px] text-text-muted uppercase tracking-wide">{label}</span>
      <span className="text-xl font-bold font-mono" style={color ? { color } : undefined}>
        {value}
      </span>
      {sub && <span className="text-[10px] text-text-muted">{sub}</span>}
    </div>
  );
}

function DcrBar({ dcr }: { dcr: number }) {
  const pct   = Math.min(dcr * 100, 130);   // cap at 130 % for display
  const color = dcr > 1.0
    ? "var(--color-danger)"
    : dcr > 0.85
    ? "var(--color-warning)"
    : "var(--color-success)";
  return (
    <div className="flex items-center gap-2 min-w-[80px]">
      <div className="flex-1 h-1.5 rounded-full bg-border overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <span
        className="text-[11px] font-mono font-semibold w-[42px] text-right"
        style={{ color }}
      >
        {dcr.toFixed(2)}
      </span>
    </div>
  );
}

function StatusBadge({ ok }: { ok: boolean }) {
  return (
    <span
      className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-bold"
      style={{
        background: ok ? "var(--color-success)22" : "var(--color-danger)22",
        color:      ok ? "var(--color-success)"   : "var(--color-danger)",
      }}
    >
      {ok ? "OK" : "NG"}
    </span>
  );
}

function ComboChip({ id }: { id: string }) {
  const isG = id.startsWith("G");
  const isX = id.startsWith("S") && ["S1","S2","S5","S6"].includes(id);
  const color = isG
    ? "var(--color-success)"
    : isX
    ? "var(--color-accent)"
    : "var(--color-warning)";
  return (
    <span
      className="inline-flex items-center rounded px-1 py-0.5 text-[9px] font-bold font-mono"
      style={{ background: `${color}22`, color }}
    >
      {id}
    </span>
  );
}

// ── Tabla de columnas ─────────────────────────────────────────────────────────

function ColumnTable({ columns }: { columns: ColumnCheckRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr className="border-b border-border bg-surface-2 text-left text-text-muted">
            <th className="px-3 py-2 font-medium">Piso</th>
            <th className="px-3 py-2 font-medium">Columna</th>
            <th className="px-3 py-2 font-medium">Sección</th>
            <th className="px-3 py-2 font-medium text-right">Pu (kN)</th>
            <th className="px-3 py-2 font-medium text-right">Mu (kN·m)</th>
            <th className="px-3 py-2 font-medium text-right">φPn (kN)</th>
            <th className="px-3 py-2 font-medium text-right">φMn (kN·m)</th>
            <th className="px-3 py-2 font-medium">Combo</th>
            <th className="px-3 py-2 font-medium min-w-[110px]">DCR</th>
            <th className="px-3 py-2 font-medium">Estado</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {columns.map((col) => (
            <tr
              key={col.id}
              className={[
                "transition-colors hover:bg-surface-2",
                !col.ok ? "bg-[var(--color-danger)]/5" : "",
              ].join(" ")}
            >
              <td className="px-3 py-2 text-text-muted font-mono">{col.story}</td>
              <td className="px-3 py-2 font-mono text-text">{col.id}</td>
              <td className="px-3 py-2 text-text-muted max-w-[160px] truncate" title={col.section}>
                <span className="font-mono">{col.b_m.toFixed(2)}×{col.h_m.toFixed(2)}</span>
                <span className="opacity-60 ml-1">({col.fc_MPa} MPa)</span>
              </td>
              <td className="px-3 py-2 text-right font-mono text-text">{col.Pu_kN.toFixed(0)}</td>
              <td className="px-3 py-2 text-right font-mono text-text">{col.Mu_kNm.toFixed(1)}</td>
              <td className="px-3 py-2 text-right font-mono text-text-muted">{col.phi_Pn_kN.toFixed(0)}</td>
              <td className="px-3 py-2 text-right font-mono text-text-muted">{col.phi_Mn_kNm.toFixed(1)}</td>
              <td className="px-3 py-2"><ComboChip id={col.combo} /></td>
              <td className="px-3 py-2"><DcrBar dcr={col.dcr} /></td>
              <td className="px-3 py-2"><StatusBadge ok={col.ok} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Componente principal ──────────────────────────────────────────────────────

interface Props {
  result: ColumnDesignResult;
}

export function ColumnDesignResults({ result }: Props) {
  const overallOk = result.n_ng === 0;
  const pctOk     = result.n_columns > 0
    ? Math.round((result.n_ok / result.n_columns) * 100)
    : 100;

  return (
    <div className="flex flex-col gap-5">

      {/* ── Resumen ───────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryCard
          label="Estado global"
          value={overallOk ? "CUMPLE" : "REQUIERE AJUSTE"}
          sub={`${result.n_ok} OK / ${result.n_ng} NG`}
          color={overallOk ? "var(--color-success)" : "var(--color-danger)"}
        />
        <SummaryCard
          label="DCR máximo"
          value={result.max_dcr.toFixed(2)}
          sub="Relación demanda/capacidad"
          color={result.max_dcr > 1.0 ? "var(--color-danger)" : result.max_dcr > 0.85 ? "var(--color-warning)" : "var(--color-success)"}
        />
        <SummaryCard
          label="Columnas verificadas"
          value={`${result.n_columns}`}
          sub={`${pctOk}% dentro de capacidad`}
        />
        <SummaryCard
          label="Combinaciones"
          value={`${result.n_combinations}`}
          sub={`NSR-10 B.3.4 · ρ=${result.rho_assumed.toFixed(1)}% · fy=${result.fy_MPa} MPa`}
        />
      </div>

      {/* ── Alerta global ────────────────────────────────────────────────── */}
      {!overallOk && (
        <div
          className="rounded-lg border px-4 py-3 text-sm"
          style={{
            borderColor: "var(--color-danger)",
            background: "var(--color-danger)0d",
            color: "var(--color-danger)",
          }}
        >
          <strong>{result.n_ng} columna{result.n_ng > 1 ? "s" : ""}</strong> supera
          {result.n_ng > 1 ? "n" : ""} la capacidad P-M con ρ = {result.rho_assumed}%.
          Incremente el refuerzo o revise las dimensiones de sección.
        </div>
      )}

      {/* ── Tabla de resultados ───────────────────────────────────────────── */}
      <div className="rounded-lg border border-border overflow-hidden">
        <ColumnTable columns={result.columns} />
      </div>

      {/* ── Notas metodológicas ──────────────────────────────────────────── */}
      <div className="rounded-lg border border-border bg-surface-2 px-4 py-3">
        <p className="text-[10px] font-semibold text-text-muted uppercase tracking-wide mb-2">
          Metodología y limitaciones
        </p>
        <ul className="flex flex-col gap-1">
          {result.notes.map((note, i) => (
            <li key={i} className="text-[11px] text-text-muted flex gap-2">
              <span className="text-accent flex-shrink-0">·</span>
              {note}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
