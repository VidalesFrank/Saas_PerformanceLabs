"use client";

import type { ModalResult, ModeRow } from "@/lib/structural-types";

interface Props {
  result: ModalResult;
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col rounded-lg border border-border bg-surface-2 px-4 py-3 min-w-[100px]">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">{label}</span>
      <span className="mt-1 text-lg font-bold text-text">{value}</span>
      {sub && <span className="text-[10px] text-text-muted mt-0.5">{sub}</span>}
    </div>
  );
}

function participationBar(pct: number, color: string) {
  const w = Math.min(100, Math.max(0, pct));
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-border overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${w}%`, background: color }} />
      </div>
      <span className="text-[11px] tabular-nums text-text-muted w-10 text-right">
        {pct.toFixed(1)}%
      </span>
    </div>
  );
}

export function ModalResultsTable({ result }: Props) {
  const { T1, T1_x, T1_y, num_modes, modes_table } = result;

  const cumUx = modes_table[modes_table.length - 1]?.Ux_cum ?? 0;
  const cumUy = modes_table[modes_table.length - 1]?.Uy_cum ?? 0;

  return (
    <div className="flex flex-col gap-5">

      {/* Resumen */}
      <div className="flex flex-wrap gap-3">
        <StatCard label="T₁ (fund.)" value={`${T1.toFixed(3)} s`} sub="Período fundamental" />
        <StatCard label="T₁_x"       value={`${T1_x.toFixed(3)} s`} sub="Translación X dominante" />
        <StatCard label="T₁_y"       value={`${T1_y.toFixed(3)} s`} sub="Translación Y dominante" />
        <StatCard label="N° modos"   value={String(num_modes)} sub="Calculados" />
        <StatCard label="∑Masa X"    value={`${cumUx.toFixed(1)}%`} sub="Participación acumulada" />
        <StatCard label="∑Masa Y"    value={`${cumUy.toFixed(1)}%`} sub="Participación acumulada" />
      </div>

      {/* Tabla de modos */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-surface-2">
              {["Modo", "T (s)", "Ux (%)", "Uy (%)", "Rz (%)", "∑Ux (%)", "∑Uy (%)", "∑Rz (%)"].map((h) => (
                <th key={h} className="px-3 py-2 text-left font-semibold text-text-muted whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {modes_table.map((row: ModeRow) => {
              const isDomX = row.Ux_pct >= 20;
              const isDomY = row.Uy_pct >= 20;
              return (
                <tr
                  key={row.mode}
                  className={[
                    "border-b border-border last:border-0 transition-colors",
                    isDomX || isDomY ? "bg-accent/5" : "hover:bg-surface-2",
                  ].join(" ")}
                >
                  <td className="px-3 py-2 font-medium text-text">{row.mode}</td>
                  <td className="px-3 py-2 tabular-nums text-text">{row.T.toFixed(4)}</td>
                  <td className="px-3 py-2 w-28">
                    {participationBar(row.Ux_pct, "var(--color-accent)")}
                  </td>
                  <td className="px-3 py-2 w-28">
                    {participationBar(row.Uy_pct, "var(--color-success)")}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-text-muted">{row.Rz_pct.toFixed(1)}%</td>
                  <td className="px-3 py-2 tabular-nums text-text-muted">{row.Ux_cum.toFixed(1)}%</td>
                  <td className="px-3 py-2 tabular-nums text-text-muted">{row.Uy_cum.toFixed(1)}%</td>
                  <td className="px-3 py-2 tabular-nums text-text-muted">{row.Rz_cum.toFixed(1)}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
