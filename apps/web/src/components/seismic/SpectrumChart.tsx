"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

export function interpolateSpectrum(
  puntos: PuntoEspectro[],
  T: number,
  type: "Sa" | "Sd" | "Sv",
): number | null {
  if (!puntos.length || T < 0) return null;
  for (let i = 0; i < puntos.length - 1; i++) {
    if (puntos[i].T <= T && T <= puntos[i + 1].T) {
      const dt = puntos[i + 1].T - puntos[i].T;
      const frac = dt === 0 ? 0 : (T - puntos[i].T) / dt;
      return puntos[i][type] + frac * (puntos[i + 1][type] - puntos[i][type]);
    }
  }
  return null;
}

export function SpectrumChart({
  puntos,
  params,
  spectralType,
  seriesExtra = null,
  tAnalisis = null,
}: {
  puntos: PuntoEspectro[];
  params: ParametrosEspectro;
  spectralType: SpectralType;
  seriesExtra?: {
    puntos: PuntoEspectro[];
    params: { T0: number; Ts: number; TL: number };
    label: string;
    color: string;
  } | null;
  tAnalisis?: number | null;
}) {
  const [hoverT, setHoverT] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [svgClientWidth, setSvgClientWidth] = useState(WIDTH);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) => setSvgClientWidth(entry.contentRect.width));
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const computed = useMemo(() => {
    const vals = puntos.map((p) => ({ T: p.T, Y: p[spectralType] }));
    const extraVals = seriesExtra ? seriesExtra.puntos.map((p) => ({ T: p.T, Y: p[spectralType] })) : null;
    const T_max = Math.max(...vals.map((v) => v.T));
    const extraY_max = extraVals ? Math.max(...extraVals.map((v) => v.Y)) : 0;
    const Y_max = Math.max(Math.max(...vals.map((v) => v.Y)), extraY_max) * 1.15 || 1;

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

      // Segunda curva — microzonificación
      extraPathD: extraVals
        ? extraVals
            .map((v, i) => `${i === 0 ? "M" : "L"}${xScale(v.T).toFixed(2)},${yScale(v.Y).toFixed(2)}`)
            .join(" ")
        : null,
      extraPeriodLines: seriesExtra
        ? [
            { T: seriesExtra.params.T0, label: "T₀'" },
            { T: seriesExtra.params.Ts, label: "Ts'" },
          ].filter((pl) => pl.T > 0 && pl.T < T_max)
        : [],

      // Ta — marcador del período de análisis
      taPoint: (() => {
        if (tAnalisis == null || tAnalisis <= 0 || tAnalisis > T_max) return null;
        const val = interpolateSpectrum(puntos, tAnalisis, spectralType);
        if (val === null) return null;
        return { x: xScale(tAnalisis), y: yScale(val), val };
      })(),
      taPointExtra: (() => {
        if (tAnalisis == null || tAnalisis <= 0 || tAnalisis > T_max || !seriesExtra) return null;
        const val = interpolateSpectrum(seriesExtra.puntos, tAnalisis, spectralType);
        if (val === null) return null;
        return { x: xScale(tAnalisis), y: yScale(val), val };
      })(),
    };
  }, [puntos, params, spectralType, hoverT, seriesExtra, tAnalisis]);

  const { vals, T_max, xScale, yScale, pathD, fillD, xTicks, yTicks, innerW, innerH, hoverPt, zoneX, periodLines, extraPathD, extraPeriodLines, taPoint, taPointExtra } = computed;

  function onPointerMove(e: React.PointerEvent<SVGRectElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * WIDTH;
    const T = ((svgX - MARGIN.left) / innerW) * T_max;
    setHoverT(Math.max(0, Math.min(T_max, T)));
  }

  const hovered = hoverPt;
  const scale = svgClientWidth / WIDTH;

  return (
    <div className="relative select-none">
      <svg
        ref={svgRef}
        width="100%"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="font-mono text-[11px]"
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

        {/* Spectrum curve — NSR-10 genérico */}
        <path
          d={pathD}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth={2.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          clipPath={`url(#clip-${spectralType})`}
        />

        {/* Segunda curva — microzonificación */}
        {extraPathD && seriesExtra && (
          <path
            d={extraPathD}
            fill="none"
            stroke={seriesExtra.color}
            strokeWidth={2}
            strokeDasharray="7,4"
            strokeLinejoin="round"
            strokeLinecap="round"
            clipPath={`url(#clip-${spectralType})`}
            opacity={0.9}
          />
        )}

        {/* Líneas de período de la segunda curva */}
        {seriesExtra && extraPeriodLines.map(({ T, label }) => (
          <g key={`epl-${T}`}>
            <line
              x1={xScale(T)} x2={xScale(T)}
              y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom}
              stroke={seriesExtra.color} strokeWidth={1}
              strokeDasharray="3,3" opacity={0.4}
            />
            <text
              x={xScale(T)} y={HEIGHT - MARGIN.bottom + 42}
              textAnchor="middle" fill={seriesExtra.color} fontSize={9} fontWeight="600"
            >
              {label}
            </text>
          </g>
        ))}

        {/* Ta — período de análisis del edificio */}
        {taPoint && (
          <>
            <line
              x1={taPoint.x} x2={taPoint.x}
              y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom}
              stroke="var(--color-danger)" strokeWidth={1.5}
              opacity={0.85}
            />
            <circle
              cx={taPoint.x} cy={taPoint.y} r={6}
              fill="var(--color-danger)"
              stroke="var(--color-surface)" strokeWidth={2}
            />
            {taPointExtra && (
              <circle
                cx={taPointExtra.x} cy={taPointExtra.y} r={5}
                fill={seriesExtra!.color}
                stroke="var(--color-surface)" strokeWidth={2}
              />
            )}
            <text
              x={taPoint.x} y={HEIGHT - MARGIN.bottom + 30}
              textAnchor="middle" fill="var(--color-danger)" fontSize={10} fontWeight="700"
            >
              Ta
            </text>
          </>
        )}

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

        {/* Leyenda de series cuando hay comparación */}
        {seriesExtra && (
          <g>
            <rect
              x={MARGIN.left + innerW - 188} y={MARGIN.top + 8}
              width={183} height={38} rx={4}
              fill="var(--color-surface)" stroke="var(--color-border)" strokeWidth={1}
              opacity={0.95}
            />
            <line
              x1={MARGIN.left + innerW - 180} y1={MARGIN.top + 21}
              x2={MARGIN.left + innerW - 164} y2={MARGIN.top + 21}
              stroke="var(--color-accent)" strokeWidth={2.5}
            />
            <text
              x={MARGIN.left + innerW - 159} y={MARGIN.top + 24}
              fill="var(--color-text)" fontSize={9}
            >
              NSR-10 (genérico)
            </text>
            <line
              x1={MARGIN.left + innerW - 180} y1={MARGIN.top + 35}
              x2={MARGIN.left + innerW - 164} y2={MARGIN.top + 35}
              stroke={seriesExtra.color} strokeWidth={2} strokeDasharray="7,4"
            />
            <text
              x={MARGIN.left + innerW - 159} y={MARGIN.top + 38}
              fill="var(--color-text)" fontSize={9}
            >
              {seriesExtra.label}
            </text>
          </g>
        )}

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
            left: Math.min(hovered.x * scale + 14, svgClientWidth - 160),
            top: Math.max(hovered.y * scale - 52, 8),
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
