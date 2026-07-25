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

interface FactoredPoint {
  pKn: number;
  mKnm: number;
  x: number;
  y: number;
}

export interface LoadCombination {
  puKn: number;
  muKnm: number;
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

/**
 * Compute phi factor for each nominal point using a linear interpolation between
 * phi_compression (at max P) and 0.90 (at min P / pure tension), per ACI 318-19.
 */
function computePhiFactors(chartPoints: ChartPoint[], isSpiral: boolean): number[] {
  if (chartPoints.length === 0) return [];
  const phiCompression = isSpiral ? 0.75 : 0.65;
  const phiTension = 0.90;
  const pValues = chartPoints.map((cp) => cp.pKn);
  const pMax = Math.max(...pValues);
  const pMin = Math.min(...pValues);
  const pRange = pMax - pMin;
  if (pRange === 0) return chartPoints.map(() => phiCompression);
  return chartPoints.map((cp) => {
    // t goes from 0 (at pMax / pure compression) to 1 (at pMin / pure tension)
    const t = (pMax - cp.pKn) / pRange;
    return phiCompression + t * (phiTension - phiCompression);
  });
}

/**
 * Point-in-polygon test using ray casting (horizontal ray to the right).
 * polygon: array of {x, y} in SVG coordinates.
 */
function pointInPolygon(px: number, py: number, polygon: { x: number; y: number }[]): boolean {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersect =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Find intersection of a ray from origin (in data space) through (muTarget, puTarget)
 * with the factored curve, and return the distance ratio (capacity/demand).
 * Returns null if no intersection found.
 */
function computeCDRatio(
  puKn: number,
  muKnm: number,
  factoredPoints: FactoredPoint[],
): number | null {
  // Ray from origin (0,0) in data space toward (muKnm, puKn)
  // Parametric: (t*muKnm, t*puKn), t>0
  // We find intersections with each segment of the factored curve
  if (muKnm === 0 && puKn === 0) return null;
  const demandDist = Math.sqrt(muKnm * muKnm + puKn * puKn);

  let bestT: number | null = null;

  for (let i = 0; i < factoredPoints.length - 1; i++) {
    const p1 = factoredPoints[i];
    const p2 = factoredPoints[i + 1];

    // Segment: p1 + s*(p2-p1), s in [0,1]
    // Ray: t*(muKnm, puKn), t >= 0
    // p1.mKnm + s*(p2.mKnm - p1.mKnm) = t*muKnm
    // p1.pKn  + s*(p2.pKn  - p1.pKn)  = t*puKn
    const dm = p2.mKnm - p1.mKnm;
    const dp = p2.pKn - p1.pKn;

    // Solve: s*dm - t*muKnm = -p1.mKnm
    //        s*dp - t*puKn  = -p1.pKn
    const det = dm * (-puKn) - dp * (-muKnm);
    if (Math.abs(det) < 1e-10) continue;

    const s = ((-p1.mKnm) * (-puKn) - (-p1.pKn) * (-muKnm)) / det;
    const t = (dm * (-p1.pKn) - dp * (-p1.mKnm)) / det;

    if (s >= 0 && s <= 1 && t >= 0) {
      if (bestT === null || t < bestT) bestT = t;
    }
  }

  if (bestT === null) return null;
  // capacity distance = bestT * demandDist, demand distance = 1 * demandDist
  return bestT; // C/D ratio
}

export interface InteractionChartProps {
  points: InteractionPoint[];
  isSpiral?: boolean;
  loadCombinations?: LoadCombination[];
}

export function InteractionChart({
  points,
  isSpiral = false,
  loadCombinations = [],
}: InteractionChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [hoverLoadIdx, setHoverLoadIdx] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

  const {
    chartPoints,
    factoredPoints,
    phiFactors,
    nominalPath,
    factoredPath,
    xTicks,
    yTicks,
    xScale,
    yScale,
    zeroY,
  } = useMemo(() => {
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

    const phis = computePhiFactors(chartPoints, isSpiral);

    const factoredPoints: FactoredPoint[] = chartPoints.map((cp, i) => {
      const phi = phis[i];
      const fPKn = phi * cp.pKn;
      const fMKnm = phi * cp.mKnm;
      return {
        pKn: fPKn,
        mKnm: fMKnm,
        x: xScale(fMKnm),
        y: yScale(fPKn),
      };
    });

    const nominalPath = chartPoints.map((cp, i) => `${i === 0 ? "M" : "L"}${cp.x},${cp.y}`).join(" ");
    const factoredPath = factoredPoints.map((fp, i) => `${i === 0 ? "M" : "L"}${fp.x},${fp.y}`).join(" ");

    return {
      chartPoints,
      factoredPoints,
      phiFactors: phis,
      nominalPath,
      factoredPath,
      xTicks: niceTicks(0, mMax, 5),
      yTicks: niceTicks(pMin, pMax, 6),
      xScale,
      yScale,
      zeroY: yScale(0),
    };
  }, [points, isSpiral]);

  // Compute load combination markers
  const loadMarkers = useMemo(() => {
    if (factoredPoints.length === 0) return [];
    const polygon = factoredPoints.map((fp) => ({ x: fp.x, y: fp.y }));
    return loadCombinations.map((lc) => {
      const svgX = xScale(lc.muKnm);
      const svgY = yScale(lc.puKn);
      const inside = pointInPolygon(svgX, svgY, polygon);
      const cdRatio = computeCDRatio(lc.puKn, lc.muKnm, factoredPoints);
      return { ...lc, x: svgX, y: svgY, inside, cdRatio };
    });
  }, [loadCombinations, factoredPoints, xScale, yScale]);

  const hovered = hoverIdx !== null ? chartPoints[hoverIdx] : null;
  const hoveredFact = hoverIdx !== null ? factoredPoints[hoverIdx] : null;
  const hoveredPhi = hoverIdx !== null ? phiFactors[hoverIdx] : null;

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
    setHoverLoadIdx(null);
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

          {/* Factored curve (phi*P-M) — dashed warning color */}
          <path
            d={factoredPath}
            fill="none"
            stroke="var(--color-warning)"
            strokeWidth={2}
            strokeDasharray="6,3"
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {/* Nominal curve — solid accent color, drawn on top */}
          <path
            d={nominalPath}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth={2.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {/* Load combination markers */}
          {loadMarkers.map((lm, i) => (
            <g key={`lc-${i}`}>
              <circle
                cx={lm.x}
                cy={lm.y}
                r={7}
                fill={lm.inside ? "var(--color-success)" : "var(--color-danger)"}
                fillOpacity={0.2}
                stroke={lm.inside ? "var(--color-success)" : "var(--color-danger)"}
                strokeWidth={2}
                style={{ cursor: "pointer" }}
                onPointerEnter={() => { setHoverLoadIdx(i); setHoverIdx(null); }}
                onPointerLeave={() => setHoverLoadIdx(null)}
              />
              <text
                x={lm.x}
                y={lm.y + 4}
                textAnchor="middle"
                fill={lm.inside ? "var(--color-success)" : "var(--color-danger)"}
                fontSize={9}
                fontWeight="bold"
                style={{ pointerEvents: "none" }}
              >
                {i + 1}
              </text>
            </g>
          ))}

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
              {hoveredFact && (
                <circle cx={hoveredFact.x} cy={hoveredFact.y} r={4} fill="var(--color-warning)" stroke="var(--color-surface)" strokeWidth={2} />
              )}
            </>
          )}

          <text x={MARGIN.left} y={16} fill="var(--color-text-muted)">
            P (kN)
          </text>
          <text x={WIDTH - MARGIN.right} y={HEIGHT - 6} textAnchor="end" fill="var(--color-text-muted)">
            M (kN·m)
          </text>

          {/* Legend */}
          <g transform={`translate(${MARGIN.left + 8}, ${MARGIN.top + 8})`}>
            <rect x={0} y={0} width={190} height={42} rx={4} fill="var(--color-surface)" fillOpacity={0.85} stroke="var(--color-border)" strokeWidth={1} />
            <line x1={8} y1={13} x2={26} y2={13} stroke="var(--color-accent)" strokeWidth={2.5} />
            <text x={32} y={17} fill="var(--color-text)" fontSize={10}>Nominal</text>
            <line x1={8} y1={29} x2={26} y2={29} stroke="var(--color-warning)" strokeWidth={2} strokeDasharray="6,3" />
            <text x={32} y={33} fill="var(--color-text)" fontSize={10}>&#x03C6;&#xB7;P-M (ACI 318-19)</text>
          </g>

          {/* Interactive overlay (behind load markers, so markers can capture events) */}
          <rect
            x={MARGIN.left}
            y={MARGIN.top}
            width={WIDTH - MARGIN.left - MARGIN.right}
            height={HEIGHT - MARGIN.top - MARGIN.bottom}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHoverIdx(null)}
            style={{ pointerEvents: "all" }}
          />
        </svg>

        {/* Curve hover tooltip */}
        {hovered && (
          <div
            className="pointer-events-none absolute rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-md"
            style={{
              left: Math.min(hovered.x + 12, WIDTH - 160),
              top: Math.max(hovered.y - 60, 4),
            }}
          >
            <div className="flex items-center gap-2">
              <span className="inline-block h-0.5 w-3" style={{ background: "var(--color-accent)" }} />
              <span className="font-mono font-semibold" style={{ color: "var(--color-text)" }}>
                M = {hovered.mKnm.toFixed(1)} kN·m
              </span>
            </div>
            <div className="mt-0.5 font-mono" style={{ color: "var(--color-text-muted)" }}>
              P = {hovered.pKn.toFixed(1)} kN
            </div>
            {hoveredFact && hoveredPhi !== null && (
              <>
                <div className="mt-1.5 border-t border-border pt-1.5 flex items-center gap-2">
                  <span className="inline-block h-0.5 w-3" style={{ background: "var(--color-warning)" }} />
                  <span className="font-mono font-semibold" style={{ color: "var(--color-warning)" }}>
                    &phi;M = {hoveredFact.mKnm.toFixed(1)} kN·m
                  </span>
                </div>
                <div className="font-mono" style={{ color: "var(--color-warning)" }}>
                  &phi;P = {hoveredFact.pKn.toFixed(1)} kN &nbsp;(&phi; = {hoveredPhi.toFixed(2)})
                </div>
              </>
            )}
          </div>
        )}

        {/* Load combination hover tooltip */}
        {hoverLoadIdx !== null && loadMarkers[hoverLoadIdx] && (
          <div
            className="pointer-events-none absolute rounded-md border px-3 py-2 text-xs shadow-md"
            style={{
              left: Math.min(loadMarkers[hoverLoadIdx].x + 12, WIDTH - 160),
              top: Math.max(loadMarkers[hoverLoadIdx].y - 70, 4),
              background: "var(--color-surface)",
              borderColor: loadMarkers[hoverLoadIdx].inside ? "var(--color-success)" : "var(--color-danger)",
            }}
          >
            <div className="font-semibold" style={{ color: loadMarkers[hoverLoadIdx].inside ? "var(--color-success)" : "var(--color-danger)" }}>
              Comb. {hoverLoadIdx + 1} — {loadMarkers[hoverLoadIdx].inside ? "OK" : "NG"}
            </div>
            <div className="mt-0.5 font-mono" style={{ color: "var(--color-text)" }}>
              Pu = {loadMarkers[hoverLoadIdx].puKn.toFixed(1)} kN
            </div>
            <div className="font-mono" style={{ color: "var(--color-text)" }}>
              Mu = {loadMarkers[hoverLoadIdx].muKnm.toFixed(1)} kN·m
            </div>
            {loadMarkers[hoverLoadIdx].cdRatio !== null && (
              <div className="mt-0.5 font-mono font-semibold" style={{ color: loadMarkers[hoverLoadIdx].inside ? "var(--color-success)" : "var(--color-danger)" }}>
                C/D = {loadMarkers[hoverLoadIdx].cdRatio!.toFixed(2)}
              </div>
            )}
          </div>
        )}
      </div>

      <button
        onClick={() => setShowTable((s) => !s)}
        className="mt-3 text-xs font-medium"
        style={{ color: "var(--color-accent)" }}
      >
        {showTable ? "Ocultar tabla" : "Ver tabla de valores"}
      </button>

      {showTable && (
        <div className="mt-3 max-h-64 overflow-y-auto rounded-md border border-border">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-surface-2 font-mono uppercase tracking-wide text-text-muted">
              <tr>
                <th className="px-3 py-2">P nominal (kN)</th>
                <th className="px-3 py-2">M nominal (kN·m)</th>
                <th className="px-3 py-2">&phi;</th>
                <th className="px-3 py-2">&phi;P (kN)</th>
                <th className="px-3 py-2">&phi;M (kN·m)</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {chartPoints.map((cp, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="px-3 py-1.5">{cp.pKn.toFixed(1)}</td>
                  <td className="px-3 py-1.5">{cp.mKnm.toFixed(1)}</td>
                  <td className="px-3 py-1.5">{phiFactors[i].toFixed(2)}</td>
                  <td className="px-3 py-1.5">{factoredPoints[i].pKn.toFixed(1)}</td>
                  <td className="px-3 py-1.5">{factoredPoints[i].mKnm.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
