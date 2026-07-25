"use client";

import { useMemo, useState } from "react";
import type { InteractionPoint } from "@/lib/types";

const WIDTH = 640;
const HEIGHT = 420;
const MARGIN = { top: 24, right: 24, bottom: 44, left: 64 };

interface ChartPoint {
  pKn: number;
  mKnm: number;
  x: number;
  y: number;
}

function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) return [min];
  const step = (max - min) / count;
  const magnitude = Math.pow(10, Math.floor(Math.log10(step)));
  const niceStep = Math.ceil(step / magnitude) * magnitude;
  const ticks: number[] = [];
  let t = Math.ceil(min / niceStep) * niceStep;
  for (; t <= max; t += niceStep) ticks.push(Math.round(t));
  return ticks;
}

export function InteractionChart({ points }: { points: InteractionPoint[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

  const { chartPoints, path, xTicks, yTicks, xScale, yScale, zeroY } = useMemo(() => {
    const data = points.map((p) => ({ pKn: p.P / 1000, mKnm: p.M / 1e6 }));
    const mMax = Math.max(...data.map((d) => d.mKnm), 1) * 1.12;
    const pMax = Math.max(...data.map((d) => d.pKn)) * 1.08;
    const pMin = Math.min(...data.map((d) => d.pKn), 0) * 1.08;

    const innerW = WIDTH - MARGIN.left - MARGIN.right;
    const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;

    const xScale = (m: number) => MARGIN.left + (m / mMax) * innerW;
    const yScale = (p: number) => MARGIN.top + innerH - ((p - pMin) / (pMax - pMin)) * innerH;

    const chartPoints: ChartPoint[] = data.map((d) => ({
      pKn: d.pKn,
      mKnm: d.mKnm,
      x: xScale(d.mKnm),
      y: yScale(d.pKn),
    }));

    const path = chartPoints.map((cp, i) => `${i === 0 ? "M" : "L"}${cp.x},${cp.y}`).join(" ");

    return {
      chartPoints,
      path,
      xTicks: niceTicks(0, mMax, 5),
      yTicks: niceTicks(pMin, pMax, 6),
      xScale,
      yScale,
      zeroY: yScale(0),
    };
  }, [points]);

  const hovered = hoverIdx !== null ? chartPoints[hoverIdx] : null;

  function onMove(e: React.PointerEvent<SVGRectElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * WIDTH;
    let nearest = 0;
    let best = Infinity;
    chartPoints.forEach((cp, i) => {
      const d = Math.abs(cp.x - svgX);
      if (d < best) {
        best = d;
        nearest = i;
      }
    });
    setHoverIdx(nearest);
  }

  return (
    <div>
      <div className="relative">
        <svg
          width={WIDTH}
          height={HEIGHT}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="max-w-full font-mono text-[11px]"
        >
          {yTicks.map((t) => (
            <g key={`y-${t}`}>
              <line
                x1={MARGIN.left}
                x2={WIDTH - MARGIN.right}
                y1={yScale(t)}
                y2={yScale(t)}
                stroke="var(--color-border)"
                strokeWidth={1}
              />
              <text x={MARGIN.left - 10} y={yScale(t) + 4} textAnchor="end" fill="var(--color-text-muted)">
                {t.toLocaleString()}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <g key={`x-${t}`}>
              <text
                x={xScale(t)}
                y={HEIGHT - MARGIN.bottom + 18}
                textAnchor="middle"
                fill="var(--color-text-muted)"
              >
                {t.toLocaleString()}
              </text>
            </g>
          ))}

          <line
            x1={MARGIN.left}
            x2={WIDTH - MARGIN.right}
            y1={zeroY}
            y2={zeroY}
            stroke="var(--color-text-muted)"
            strokeWidth={1}
            opacity={0.5}
          />

          <path d={path} fill="none" stroke="var(--color-accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

          {hovered && (
            <>
              <line
                x1={hovered.x}
                x2={hovered.x}
                y1={MARGIN.top}
                y2={HEIGHT - MARGIN.bottom}
                stroke="var(--color-text-muted)"
                strokeWidth={1}
                strokeDasharray="3,3"
              />
              <circle cx={hovered.x} cy={hovered.y} r={5} fill="var(--color-accent)" stroke="var(--color-surface)" strokeWidth={2} />
            </>
          )}

          <text x={MARGIN.left} y={16} fill="var(--color-text-muted)">
            P (kN)
          </text>
          <text x={WIDTH - MARGIN.right} y={HEIGHT - 6} textAnchor="end" fill="var(--color-text-muted)">
            M (kN·m)
          </text>

          <rect
            x={MARGIN.left}
            y={MARGIN.top}
            width={WIDTH - MARGIN.left - MARGIN.right}
            height={HEIGHT - MARGIN.top - MARGIN.bottom}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHoverIdx(null)}
          />
        </svg>

        {hovered && (
          <div
            className="pointer-events-none absolute rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-md"
            style={{
              left: Math.min(hovered.x + 12, WIDTH - 140),
              top: Math.max(hovered.y - 44, 4),
            }}
          >
            <div className="flex items-center gap-2">
              <span className="inline-block h-0.5 w-3 bg-accent" />
              <span className="font-mono font-semibold text-text">{hovered.mKnm.toFixed(1)} kN·m</span>
            </div>
            <div className="mt-0.5 font-mono text-text-muted">P = {hovered.pKn.toFixed(1)} kN</div>
          </div>
        )}
      </div>

      <button
        onClick={() => setShowTable((s) => !s)}
        className="mt-3 text-xs font-medium text-accent hover:underline"
      >
        {showTable ? "Ocultar tabla" : "Ver tabla de valores"}
      </button>

      {showTable && (
        <div className="mt-3 max-h-64 overflow-y-auto rounded-md border border-border">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-surface-2 font-mono uppercase tracking-wide text-text-muted">
              <tr>
                <th className="px-3 py-2">P (kN)</th>
                <th className="px-3 py-2">M (kN·m)</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {chartPoints.map((cp, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="px-3 py-1.5">{cp.pKn.toFixed(1)}</td>
                  <td className="px-3 py-1.5">{cp.mKnm.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
