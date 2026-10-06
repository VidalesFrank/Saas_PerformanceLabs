"use client";

import { useMemo, useState } from "react";
import type { HingeRecord, HingeDamageLevel } from "@/lib/structural-types";

const DAMAGE_COLOR: Record<HingeDamageLevel, string> = {
  none:     "#64748b",
  near_io:  "#38bdf8",
  io:       "#22c55e",
  ls:       "#eab308",
  cp:       "#f97316",
  collapse: "#ef4444",
};
const LABEL: Record<HingeDamageLevel, string> = {
  none: "Elástico", near_io: "~IO", io: "IO", ls: "LS", cp: "CP", collapse: "Colapso",
};

interface Props {
  hinges:          HingeRecord[];
  onSelectHinge?:  (fid: string, end: "i" | "j") => void;
  selectedFid?:    string | null;
  initialMax?:     number;
}

export default function CriticalElementsPanel({
  hinges, onSelectHinge, selectedFid = null, initialMax = 20,
}: Props) {
  const [kindFilter, setKindFilter] = useState<"all" | "column" | "beam">("all");
  const [levelFilter, setLevelFilter] = useState<"all" | HingeDamageLevel>("all");
  const [max, setMax] = useState<number>(initialMax);

  const filtered = useMemo(() => {
    return hinges
      .filter((h) =>
        (kindFilter === "all"  || h.kind === kindFilter) &&
        (levelFilter === "all" || h.damage_level === levelFilter)
      )
      .sort((a, b) => b.dcr - a.dcr);
  }, [hinges, kindFilter, levelFilter]);

  const shown = filtered.slice(0, max);
  const maxDcr = filtered[0]?.dcr ?? 1.0;

  const counts = useMemo(() => {
    const c = { none: 0, near_io: 0, io: 0, ls: 0, cp: 0, collapse: 0 } as Record<HingeDamageLevel, number>;
    for (const h of hinges) c[h.damage_level] = (c[h.damage_level] ?? 0) + 1;
    return c;
  }, [hinges]);

  if (!hinges.length) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-xs text-[var(--text-muted)]">
        Sin datos de rótulas plásticas. Corre el pushover para generarlos.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col gap-3">
      {/* Resumen por nivel */}
      <div className="flex flex-wrap gap-2">
        {(["io", "ls", "cp", "collapse"] as HingeDamageLevel[]).map((lvl) => (
          <button
            key={lvl}
            onClick={() => setLevelFilter(levelFilter === lvl ? "all" : lvl)}
            className={[
              "px-2.5 py-1 rounded text-[11px] font-semibold border transition-colors",
              levelFilter === lvl ? "ring-2 ring-offset-1" : "",
            ].join(" ")}
            style={{
              background: `${DAMAGE_COLOR[lvl]}22`,
              borderColor: DAMAGE_COLOR[lvl],
              color: DAMAGE_COLOR[lvl],
            }}
          >
            {LABEL[lvl]}: {counts[lvl]}
          </button>
        ))}
        <button
          onClick={() => setLevelFilter("all")}
          className={[
            "px-2.5 py-1 rounded text-[11px] font-semibold border transition-colors ml-2",
            levelFilter === "all"
              ? "bg-[var(--accent)] text-white border-[var(--accent)]"
              : "bg-[var(--surface-2)] border-[var(--border)] text-[var(--text-muted)]",
          ].join(" ")}
        >
          Todos
        </button>

        <div className="ml-auto flex gap-1">
          {(["all", "column", "beam"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setKindFilter(k)}
              className={[
                "px-2.5 py-1 rounded text-[11px] font-medium transition-colors",
                kindFilter === k
                  ? "bg-[var(--accent)] text-white"
                  : "bg-[var(--surface-2)] text-[var(--text-muted)]",
              ].join(" ")}
            >
              {k === "all" ? "Todos" : k === "column" ? "Columnas" : "Vigas"}
            </button>
          ))}
        </div>
      </div>

      {/* Lista */}
      <div className="flex flex-col gap-1">
        {shown.length === 0 && (
          <p className="text-xs text-[var(--text-muted)] italic p-2">
            Sin elementos con los filtros actuales.
          </p>
        )}
        {shown.map((h) => {
          const sel = selectedFid === h.fid;
          const w = Math.max(2, Math.min(100, 100 * (h.dcr / Math.max(maxDcr, 0.1))));
          return (
            <button
              key={`${h.fid}-${h.end}`}
              onClick={() => onSelectHinge?.(h.fid, h.end)}
              className={[
                "flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors",
                sel ? "bg-[var(--accent)]/10 ring-1 ring-[var(--accent)]" : "hover:bg-[var(--surface-2)]",
              ].join(" ")}
            >
              <span
                className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                style={{ background: DAMAGE_COLOR[h.damage_level], boxShadow: `0 0 4px ${DAMAGE_COLOR[h.damage_level]}` }}
              />
              <span className="w-16 text-[11px] font-mono text-[var(--text)]">
                {h.kind === "column" ? "Col" : "Vig"} {h.fid}
              </span>
              <span className="w-10 text-[10px] font-mono text-[var(--text-muted)]">
                ext {h.end.toUpperCase()}
              </span>
              <span className="w-16 text-[10px] text-[var(--text-muted)]">
                {h.story}
              </span>
              <div className="flex-1 h-1.5 bg-[var(--surface-2)] rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${w}%`, background: DAMAGE_COLOR[h.damage_level] }}
                />
              </div>
              <span className="w-12 text-[11px] text-right font-mono text-[var(--text)]">
                {h.dcr.toFixed(2)}
              </span>
              <span className="w-14 text-[10px] text-right font-semibold" style={{ color: DAMAGE_COLOR[h.damage_level] }}>
                {LABEL[h.damage_level]}
              </span>
            </button>
          );
        })}
      </div>

      {filtered.length > max && (
        <button
          onClick={() => setMax((m) => m + 20)}
          className="self-start text-[11px] text-[var(--accent)] hover:underline"
        >
          Cargar más ({filtered.length - max} restantes)
        </button>
      )}
    </div>
  );
}
