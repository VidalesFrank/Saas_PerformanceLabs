"use client";

import { useMemo, useState } from "react";
import type { ParametrosEspectro, PuntoEspectro } from "@/lib/seismic-types";

const WIDTH = 620;
const HEIGHT = 360;
const MARGIN = { top: 44, right: 36, bottom: 52, left: 72 };

type SpectralType = "Sa" | "Sd" | "Sv";

const AXIS_LABEL: Record<SpectralType, string> = {
  Sa: "Sa (g)",
  Sd: "Sd (cm)",
  Sv: "Sv (cm/s)",
};

const ZONE_FILL = {
  rampa: "rgba(180,83,9,0.07)",
  meseta: "rgba(8,127,91,0.09)",
  caida: "rgba(14,127,168,0.08)",
  larga: "rgba(84,91,108,0.06)",
};

function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) return [min];
  const step = (max - min) / count;
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.abs(step) || 1)));
  const niceStep = Math.ceil(step / magnitude) * magnitude;
  const ticks: number[] = [];
  let t = Math.floor(min / niceStep) * niceStep;
  for (; t <= max + niceStep * 0.01; t += niceStep) {
    ticks.push(parseFloat(t.toFixed(6)));
  }
  return ticks;
}

export function SpectrumChart({
  puntos,
  params,
  spectralType,
}: {
  puntos: PuntoEspectro[];
  params: ParametrosEspectro;
  spectralType: SpectralType;
}) {
  const [hoverT, setHoverT] = useState<number | null>(null);

  const computed = useMemo(() => {
    const vals = puntos.map((p) => ({ T: p.T, Y: p[spectralType] }));
    const T_max = Math.max(...vals.map((v) => v.T));
    const Y_max = Math.max(...vals.map((v) => v.Y)) * 1.15 || 1;

    const innerW = WIDTH - MARGIN.left - MARGIN.right;
    const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;

    const xScale = (T: number) => MARGIN.left + (T / T_max) * innerW;
    const yScale = (y: number) => MARGIN.top + innerH - (y / Y_max) * innerH;

    const { T0, Ts, TL } = params;

    // SVG polyline path
    const pathD = vals
      .map((v, i) => `${i === 0 ? "M" : "L"}${xScale(v.T).toFixed(2)},${yScale(v.Y).toFixed(2)}`)
      .join(" ");

    // Fill path (close to x-axis)
    const bottomY = yScale(0);
    const fillD =
      pathD +
      ` L${xScale(T_max).toFixed(2)},${bottomY.toFixed(2)} L${xScale(0).toFixed(2)},${bottomY.toFixed(2)} Z`;

    const xTicks = niceTicks(0, T_max, 6).filter((t) => t >= 0 && t <= T_max);
    const yTicks = niceTicks(0, Y_max, 5).filter((t) => t >= 0 && t <= Y_max * 1.01);

    // Hover point
    let hoverPt = null;
    if (hoverT !== null) {
      const nearest = vals.reduce((best, v) =>
        Math.abs(v.T - hoverT) < Math.abs(best.T - hoverT) ? v : best
      );
      hoverPt = { T: nearest.T, Y: nearest.Y, x: xScale(nearest.T), y: yScale(nearest.Y) };
    }

    return {
      vals,
      T_max,
      Y_max,
      xScale,
      yScale,
      pathD,
      fillD,
      xTicks,
      yTicks,
      innerW,
      innerH,
      hoverPt,
      zoneX: {
        rampa: { x1: xScale(0), x2: xScale(Math.min(T0, T_max)) },
        meseta: { x1: xScale(Math.min(T0, T_max)), x2: xScale(Math.min(Ts, T_max)) },
        caida: { x1: xScale(Math.min(Ts, T_max)), x2: xScale(Math.min(TL, T_max)) },
        larga: T_max > TL ? { x1: xScale(TL), x2: xScale(T_max) } : null,
      },
      periodLines: [
        { T: T0, label: "T₀" },
        { T: Ts, label: "Ts" },
        ...(T_max >= TL ? [{ T: TL, label: "TL" }] : []),
      ].filter((pl) => pl.T > 0 && pl.T < T_max),
    };
  }, [puntos, params, spectralType, hoverT]);

  const { vals, T_max, xScale, yScale, pathD, fillD, xTicks, yTicks, innerW, innerH, hoverPt, zoneX, periodLines } = computed;

  function onPointerMove(e: React.PointerEvent<SVGRectElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * WIDTH;
    const T = ((svgX - MARGIN.left) / innerW) * T_max;
    setHoverT(Math.max(0, Math.min(T_max, T)));
  }

  const hovered = hoverPt;

  return (
    <div className="relative select-none">
      <svg
        width={WIDTH}
        height={HEIGHT}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="max-w-full font-mono text-[11px]"
      >
        <defs>
          <linearGradient id={`spec-grad-${spectralType}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.25" />
            <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0.03" />
          </linearGradient>
          <clipPath id={`clip-${spectralType}`}>
            <rect x={MARGIN.left} y={MARGIN.top} width={innerW} height={innerH} />
          </clipPath>
        </defs>

        {/* Zone background bands */}
        {(["rampa", "meseta", "caida", "larga"] as const).map((zone) => {
          const z = zoneX[zone];
          if (!z || z.x2 <= z.x1) return null;
          return (
            <rect
              key={zone}
              x={z.x1}
              y={MARGIN.top}
              width={z.x2 - z.x1}
              height={innerH}
              fill={ZONE_FILL[zone]}
            />
          );
        })}

        {/* Zone labels at top */}
        {[
          { zone: "rampa" as const, label: "Rampa" },
          { zone: "meseta" as const, label: "Meseta" },
          { zone: "caida" as const, label: "Caída" },
        ].map(({ zone, label }) => {
          const z = zoneX[zone];
          if (!z || z.x2 - z.x1 < 30) return null;
          return (
            <text
              key={zone}
              x={(z.x1 + z.x2) / 2}
              y={MARGIN.top - 6}
              textAnchor="middle"
              fill="var(--color-text-muted)"
              fontSize={9}
              letterSpacing="0.05em"
            >
              {label.toUpperCase()}
            </text>
          );
        })}

        {/* Y grid + labels */}
        {yTicks.map((t) => (
          <g key={`y-${t}`}>
            <line
              x1={MARGIN.left} x2={WIDTH - MARGIN.right}
              y1={yScale(t)} y2={yScale(t)}
              stroke="var(--color-border)" strokeWidth={1}
            />
            <text
              x={MARGIN.left - 8} y={yScale(t) + 4}
              textAnchor="end" fill="var(--color-text-muted)"
            >
              {t < 0.001 && t > 0 ? t.toExponential(1) : t % 1 === 0 ? t : +t.toFixed(3)}
            </text>
          </g>
        ))}

        {/* X grid + labels */}
        {xTicks.filter((t) => t > 0).map((t) => (
          <g key={`x-${t}`}>
            <line
              x1={xScale(t)} x2={xScale(t)}
              y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom}
              stroke="var(--color-border)" strokeWidth={1}
            />
            <text
              x={xScale(t)} y={HEIGHT - MARGIN.bottom + 16}
              textAnchor="middle" fill="var(--color-text-muted)"
            >
              {t}
            </text>
          </g>
        ))}

        {/* Key period vertical lines */}
        {periodLines.map(({ T, label }) => (
          <g key={`pl-${T}`}>
            <line
              x1={xScale(T)} x2={xScale(T)}
              y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom}
              stroke="var(--color-accent)" strokeWidth={1}
              strokeDasharray="4,3" opacity={0.5}
            />
            <text
              x={xScale(T)} y={HEIGHT - MARGIN.bottom + 30}
              textAnchor="middle" fill="var(--color-accent)" fontSize={10} fontWeight="600"
            >
              {label}
            </text>
          </g>
        ))}

        {/* Fill */}
        <path d={fillD} fill={`url(#spec-grad-${spectralType})`} clipPath={`url(#clip-${spectralType})`} />

        {/* Spectrum curve */}
        <path
          d={pathD}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth={2.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          clipPath={`url(#clip-${spectralType})`}
        />

        {/* Hover crosshair */}
        {hovered && (
          <>
            <line
              x1={hovered.x} x2={hovered.x}
              y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom}
              stroke="var(--color-text-muted)" strokeWidth={1} strokeDasharray="3,3"
            />
            <line
              x1={MARGIN.left} x2={WIDTH - MARGIN.right}
              y1={hovered.y} y2={hovered.y}
              stroke="var(--color-text-muted)" strokeWidth={1} strokeDasharray="3,3" opacity={0.4}
            />
            <circle
              cx={hovered.x} cy={hovered.y} r={5}
              fill="var(--color-accent)"
              stroke="var(--color-surface)" strokeWidth={2}
            />
          </>
        )}

        {/* Chart border */}
        <rect
          x={MARGIN.left} y={MARGIN.top}
          width={innerW} height={innerH}
          fill="none" stroke="var(--color-border)" strokeWidth={1}
        />

        {/* Axis labels */}
        <text
          x={MARGIN.left - 54} y={MARGIN.top + innerH / 2}
          textAnchor="middle" fill="var(--color-text-muted)" fontSize={11}
          transform={`rotate(-90, ${MARGIN.left - 54}, ${MARGIN.top + innerH / 2})`}
        >
          {AXIS_LABEL[spectralType]}
        </text>
        <text
          x={MARGIN.left + innerW / 2} y={HEIGHT - 4}
          textAnchor="middle" fill="var(--color-text-muted)" fontSize={11}
        >
          Período T (s)
        </text>

        {/* Hit area */}
        <rect
          x={MARGIN.left} y={MARGIN.top}
          width={innerW} height={innerH}
          fill="transparent"
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHoverT(null)}
        />
      </svg>

      {/* Tooltip */}
      {hovered && (
        <div
          className="pointer-events-none absolute rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-lg"
          style={{
            left: Math.min(hovered.x + 14, WIDTH - 160),
            top: Math.max(hovered.y - 52, 8),
          }}
        >
          <div className="mb-1 flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-full bg-accent" />
            <span className="font-semibold text-text">{AXIS_LABEL[spectralType]}</span>
          </div>
          <div className="font-mono text-text">
            T = <span className="font-semibold">{hovered.T.toFixed(3)}</span> s
          </div>
          <div className="mt-0.5 font-mono text-text">
            {spectralType} = <span className="font-semibold">
              {spectralType === "Sa" ? hovered.Y.toFixed(4) : hovered.Y.toFixed(2)}
            </span>{" "}
            {spectralType === "Sa" ? "g" : spectralType === "Sd" ? "cm" : "cm/s"}
          </div>
        </div>
      )}
    </div>
  );
}
