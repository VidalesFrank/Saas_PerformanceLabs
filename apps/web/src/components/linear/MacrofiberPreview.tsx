"use client";

import type { MacroFiber, MacroFiberRegion } from "@/lib/wall-types";
import { regionLabel } from "@/lib/wall-types";

interface Props {
  fibers:         MacroFiber[];
  selectedIndex?: number | null;
  onSelect?:      (index: number) => void;
  totalWidthM:    number;
}

// Distinct colors for left boundary, web, and right boundary
const REGION_BG: Record<MacroFiberRegion, string> = {
  boundary_left:  "#3b7dd8",   // blue
  web:            "#4a9e5c",   // green
  boundary_right: "#c06030",   // amber-brown (distinct from left)
};

const REGION_BG_DIM: Record<MacroFiberRegion, string> = {
  boundary_left:  "#3b7dd844",
  web:            "#4a9e5c44",
  boundary_right: "#c0603044",
};

function fiberHasMissingMaterial(mf: MacroFiber): boolean {
  return !mf.concrete_name || !mf.steel_v_name;
}

export default function MacrofiberPreview({ fibers, selectedIndex, onSelect, totalWidthM }: Props) {
  if (fibers.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-[var(--border)] py-10 text-center space-y-1">
        <p className="text-sm text-[var(--text-secondary)]">No macrofibers defined.</p>
        <p className="text-xs text-[var(--text-muted)]">Generate a discretization first.</p>
      </div>
    );
  }

  const total = fibers.reduce((s, f) => s + f.width_m, 0) || totalWidthM || 1;

  // Collapse consecutive fibers by region for header labels
  const regions: { region: MacroFiberRegion; start: number; end: number }[] = [];
  fibers.forEach((mf) => {
    const last = regions[regions.length - 1];
    if (last && last.region === mf.region) {
      last.end = mf.index;
    } else {
      regions.push({ region: mf.region, start: mf.index, end: mf.index });
    }
  });

  const anyMissing = fibers.some(fiberHasMissingMaterial);

  return (
    <div className="space-y-2">
      {/* Warning banner if any fiber has missing materials */}
      {anyMissing && (
        <div className="flex items-center gap-2 rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2 text-xs text-amber-400">
          <span>⚠</span>
          <span>Some fibers have missing material assignments — run Validate for details.</span>
        </div>
      )}

      {/* Region header labels */}
      <div className="flex text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        {regions.map((r) => {
          const rFibers = fibers.filter((f) => f.region === r.region && f.index >= r.start && f.index <= r.end);
          const pct = (rFibers.reduce((s, f) => s + f.width_m, 0) / total) * 100;
          return (
            <div key={`${r.region}-${r.start}`} style={{ width: `${pct}%` }} className="text-center truncate px-1">
              <span style={{ color: REGION_BG[r.region] }}>{regionLabel(r.region)}</span>
            </div>
          );
        })}
      </div>

      {/* Fiber bars */}
      <div className="flex h-16 rounded-lg overflow-hidden border border-[var(--border)]">
        {fibers.map((mf) => {
          const pct      = (mf.width_m / total) * 100;
          const isSelected = selectedIndex === mf.index;
          const hasMissing = fiberHasMissingMaterial(mf);
          const bg = isSelected ? REGION_BG[mf.region] : REGION_BG_DIM[mf.region];

          return (
            <button
              key={mf.index}
              type="button"
              onClick={() => onSelect?.(mf.index)}
              style={{ width: `${pct}%`, backgroundColor: bg }}
              className={[
                "relative flex flex-col items-center justify-center transition-all overflow-hidden",
                "border-r border-black/10 last:border-r-0",
                onSelect ? "cursor-pointer hover:brightness-125" : "cursor-default",
                isSelected ? "ring-2 ring-inset ring-white/80" : "",
              ].join(" ")}
              title={`MF${mf.index} · ${regionLabel(mf.region)} · ${(mf.width_m * 1000).toFixed(0)} mm${hasMissing ? " · ⚠ Missing material" : ""}`}
            >
              {hasMissing && (
                <span className="absolute top-0.5 right-0.5 text-[8px] text-amber-300">⚠</span>
              )}
              <span className="text-[9px] font-bold text-white/90 truncate leading-none">
                MF{mf.index}
              </span>
              {pct > 7 && (
                <span className="text-[8px] text-white/70 leading-none mt-0.5">
                  {(mf.width_m * 1000).toFixed(0)}mm
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-4 text-[10px] text-[var(--text-muted)] pt-0.5">
        {regions.map((r) => (
          <span key={`${r.region}-legend`} className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: REGION_BG[r.region] }} />
            <span style={{ color: REGION_BG[r.region] }}>{regionLabel(r.region)}</span>
            <span>MF{r.start}{r.start !== r.end ? `–MF${r.end}` : ""}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
