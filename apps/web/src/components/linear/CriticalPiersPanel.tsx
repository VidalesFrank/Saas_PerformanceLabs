"use client";

/**
 * CriticalPiersPanel — Ranking de pieres por índice de daño Park-Ang.
 *
 * Muestra los pieres con mayor DI descendente por dirección (X o Y). Cada fila
 * incluye barra de nivel de daño coloreada (verde→amarillo→rojo) para lectura
 * rápida del estado del edificio.
 */
import { useMemo, useState } from "react";
import type { NLPushoverResult, DamageLevel } from "@/lib/structural-types";

interface Props {
  result: NLPushoverResult;
}

interface PierDamageRow {
  pier:         string;
  story:        string;
  drift_pct:    number;
  di_base:      number;
  di_effective: number;
  max_dcr:      number;
  ebe_required: boolean;
  damage_level: DamageLevel;
}

const DAMAGE_COLOR: Record<DamageLevel, string> = {
  none:     "#22c55e",
  minor:    "#a3e635",
  moderate: "#eab308",
  severe:   "#f97316",
  collapse: "#ef4444",
};

const DAMAGE_LABEL_ES: Record<DamageLevel, string> = {
  none:     "Sin daño",
  minor:    "Menor",
  moderate: "Moderado",
  severe:   "Severo",
  collapse: "Colapso",
};

export default function CriticalPiersPanel({ result }: Props) {
  const [direction, setDirection] = useState<"X" | "Y" | "max">("max");
  const [levelFilter, setLevelFilter] = useState<DamageLevel | "all">("all");
  const [showN, setShowN] = useState(20);

  // Recopila daño por dirección desde el result
  const damageByDir = useMemo(() => {
    const out: Record<"X" | "Y", PierDamageRow[]> = { X: [], Y: [] };
    (["X", "Y"] as const).forEach((d) => {
      const dir = d === "X" ? result.pushover_X : result.pushover_Y;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = ((dir as any)?.damage?.pier_damage ?? []) as PierDamageRow[];
      out[d] = rows;
    });
    return out;
  }, [result]);

  // Combina X e Y tomando el máximo DI por (pier, story)
  const displayed = useMemo(() => {
    let rows: PierDamageRow[] = [];
    if (direction === "max") {
      const map = new Map<string, PierDamageRow>();
      for (const r of damageByDir.X) map.set(`${r.pier}|${r.story}`, r);
      for (const r of damageByDir.Y) {
        const k = `${r.pier}|${r.story}`;
        const prev = map.get(k);
        if (!prev || r.di_effective > prev.di_effective) map.set(k, r);
      }
      rows = [...map.values()];
    } else {
      rows = damageByDir[direction];
    }
    if (levelFilter !== "all") rows = rows.filter((r) => r.damage_level === levelFilter);
    rows.sort((a, b) => b.di_effective - a.di_effective);
    return rows.slice(0, showN);
  }, [direction, damageByDir, levelFilter, showN]);

  const nCritical = useMemo(() => {
    const rows = direction === "X" ? damageByDir.X : direction === "Y" ? damageByDir.Y : [...damageByDir.X, ...damageByDir.Y];
    return {
      severe:   rows.filter((r) => r.damage_level === "severe").length,
      collapse: rows.filter((r) => r.damage_level === "collapse").length,
      moderate: rows.filter((r) => r.damage_level === "moderate").length,
    };
  }, [direction, damageByDir]);

  const barPct = (di: number) => Math.min(100, (di / 1.0) * 100);

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--border)] bg-[var(--surface-2)] flex items-center gap-3 flex-wrap">
        <span className="text-xs font-semibold text-[var(--text)] uppercase tracking-wider">Pieres Críticos — Park-Ang</span>

        <div className="flex items-center gap-1 ml-4">
          {(["max", "X", "Y"] as const).map((d) => (
            <button
              key={d}
              onClick={() => setDirection(d)}
              className={[
                "px-2 py-1 rounded text-[11px] font-medium transition-colors",
                direction === d
                  ? "bg-[var(--accent)] text-white"
                  : "bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]",
              ].join(" ")}
            >
              {d === "max" ? "Máx X/Y" : `Dir ${d}`}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 ml-2">
          {(["all", "collapse", "severe", "moderate", "minor", "none"] as const).map((lvl) => (
            <button
              key={lvl}
              onClick={() => setLevelFilter(lvl)}
              className={[
                "px-1.5 py-1 rounded text-[10px] font-medium transition-colors",
                levelFilter === lvl
                  ? "bg-[var(--surface)] text-[var(--text)] border border-[var(--border)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text)]",
              ].join(" ")}
            >
              {lvl === "all" ? "Todos" : DAMAGE_LABEL_ES[lvl as DamageLevel]}
            </button>
          ))}
        </div>

        <span className="ml-auto text-[11px] text-[var(--text-muted)]">
          {nCritical.collapse > 0 && <span className="text-red-600 font-semibold mr-2">Colapso: {nCritical.collapse}</span>}
          {nCritical.severe   > 0 && <span className="text-orange-600 font-semibold mr-2">Severo: {nCritical.severe}</span>}
          {nCritical.moderate > 0 && <span className="text-yellow-600 font-semibold mr-2">Moderado: {nCritical.moderate}</span>}
          {displayed.length} mostrados
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-[var(--border)] bg-[var(--surface-2)]">
            <tr>
              <th className="px-3 py-2 text-left text-[11px] font-semibold text-[var(--text-muted)]">#</th>
              <th className="px-3 py-2 text-left text-[11px] font-semibold text-[var(--text-muted)]">Pier</th>
              <th className="px-3 py-2 text-left text-[11px] font-semibold text-[var(--text-muted)]">Historia</th>
              <th className="px-3 py-2 text-right text-[11px] font-semibold text-[var(--text-muted)]">DI</th>
              <th className="px-3 py-2 text-left text-[11px] font-semibold text-[var(--text-muted)] w-56">Nivel</th>
              <th className="px-3 py-2 text-right text-[11px] font-semibold text-[var(--text-muted)]">Deriva %</th>
              <th className="px-3 py-2 text-right text-[11px] font-semibold text-[var(--text-muted)]">DCR</th>
              <th className="px-3 py-2 text-center text-[11px] font-semibold text-[var(--text-muted)]">EBE</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {displayed.map((r, i) => {
              const color = DAMAGE_COLOR[r.damage_level];
              return (
                <tr key={`${r.pier}-${r.story}-${i}`} className="hover:bg-[var(--surface-2)]">
                  <td className="px-3 py-1.5 text-xs text-[var(--text-muted)] font-mono">{i + 1}</td>
                  <td className="px-3 py-1.5 font-mono text-xs font-medium text-[var(--text)]">{r.pier}</td>
                  <td className="px-3 py-1.5 text-xs text-[var(--text-muted)]">{r.story}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-xs font-semibold" style={{ color }}>
                    {r.di_effective.toFixed(3)}
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-2 rounded-full bg-[var(--surface-2)] overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${barPct(r.di_effective)}%`, background: color }} />
                      </div>
                      <span className="text-[10px] font-semibold" style={{ color }}>
                        {DAMAGE_LABEL_ES[r.damage_level]}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-xs text-[var(--text)]">{r.drift_pct.toFixed(3)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-xs text-[var(--text)]">{r.max_dcr.toFixed(2)}</td>
                  <td className="px-3 py-1.5 text-center">
                    {r.ebe_required
                      ? <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-100 text-purple-700">EBE</span>
                      : <span className="text-[11px] text-[var(--text-muted)]">—</span>
                    }
                  </td>
                </tr>
              );
            })}
            {displayed.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-6 text-center text-xs text-[var(--text-muted)]">Sin datos de daño para los filtros seleccionados.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {displayed.length >= showN && (
        <div className="px-4 py-2 border-t border-[var(--border)] flex justify-center bg-[var(--surface-2)]">
          <button
            onClick={() => setShowN((n) => n + 20)}
            className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)] font-medium"
          >
            Mostrar 20 más ↓
          </button>
        </div>
      )}
    </div>
  );
}
