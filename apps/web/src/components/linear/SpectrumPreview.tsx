"use client";

import { useMemo, useRef, useState, useEffect } from "react";

// ── Chart constants ───────────────────────────────────────────────────────────

const WIDTH  = 560;
const HEIGHT = 300;
const MARGIN = { top: 38, right: 24, bottom: 46, left: 62 };

const ZONE_FILL = {
  rampa:  "rgba(180,83,9,0.07)",
  meseta: "rgba(8,127,91,0.09)",
  caida:  "rgba(14,127,168,0.08)",
  larga:  "rgba(84,91,108,0.06)",
};

const ZONE_LABELS: Record<string, string> = { rampa: "Rampa", meseta: "Meseta", caida: "Caída" };

// ── Types ─────────────────────────────────────────────────────────────────────

interface SpectrumPoint { T: number; Sa: number; Sd: number; Sv: number; }
interface SpectrumParams { SDs: number; SD1: number; T0: number; Ts: number; TL: number; Fa: number; Fv: number; }
interface SpectrumData   { params: SpectrumParams; puntos: SpectrumPoint[]; zona_sismica?: string; }
interface Props           { data: SpectrumData; loading?: boolean; }

// ── Helpers ───────────────────────────────────────────────────────────────────

function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) return [min];
  const step = (max - min) / count;
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.abs(step) || 1)));
  const niceStep  = Math.ceil(step / magnitude) * magnitude;
  const ticks: number[] = [];
  let t = Math.floor(min / niceStep) * niceStep;
  for (; t <= max + niceStep * 0.01; t += niceStep)
    ticks.push(parseFloat(t.toFixed(6)));
  return ticks;
}

// ── StatPill ──────────────────────────────────────────────────────────────────

function StatPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-border bg-surface-2 px-3 py-2 min-w-[68px]">
      <span className="text-[10px] text-text-muted uppercase tracking-wide">{label}</span>
      <span className="text-sm font-bold text-text mt-0.5">{value}</span>
    </div>
  );
}

// ── SpectrumPreview ───────────────────────────────────────────────────────────

export function SpectrumPreview({ data, loading }: Props) {
  const [hoverT, setHoverT] = useState<number | null>(null);
  const svgRef              = useRef<SVGSVGElement>(null);
  const [svgW, setSvgW]     = useState(WIDTH);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) => setSvgW(entry.contentRect.width));
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const computed = useMemo(() => {
    if (!data?.puntos?.length) return null;

    const vals   = data.puntos.map((p) => ({ T: p.T, Sa: p.Sa }));
    const T_max  = Math.max(...vals.map((v) => v.T));
    const Sa_max = Math.max(...vals.map((v) => v.Sa)) * 1.15 || 1;

    const innerW = WIDTH  - MARGIN.left - MARGIN.right;
    const innerH = HEIGHT - MARGIN.top  - MARGIN.bottom;

    const xScale = (T: number)  => MARGIN.left + (T  / T_max)  * innerW;
    const yScale = (sa: number) => MARGIN.top  + innerH - (sa / Sa_max) * innerH;

    const { T0, Ts, TL } = data.params;

    const pathD = vals
      .map((v, i) => `${i === 0 ? "M" : "L"}${xScale(v.T).toFixed(2)},${yScale(v.Sa).toFixed(2)}`)
      .join(" ");

    const bottomY = yScale(0);
    const fillD   = pathD
      + ` L${xScale(T_max).toFixed(2)},${bottomY.toFixed(2)}`
      + ` L${xScale(0).toFixed(2)},${bottomY.toFixed(2)} Z`;

    const xTicks = niceTicks(0, T_max, 6).filter((t) => t >= 0 && t <= T_max);
    const yTicks = niceTicks(0, Sa_max, 5).filter((t) => t >= 0 && t <= Sa_max * 1.01);

    let hoverPt: { T: number; Sa: number; x: number; y: number } | null = null;
    if (hoverT !== null) {
      const nearest = vals.reduce((best, v) =>
        Math.abs(v.T - hoverT) < Math.abs(best.T - hoverT) ? v : best
      );
      hoverPt = { T: nearest.T, Sa: nearest.Sa, x: xScale(nearest.T), y: yScale(nearest.Sa) };
    }

    return {
      T_max, Sa_max, innerW, innerH,
      xScale, yScale, pathD, fillD,
      xTicks, yTicks, hoverPt,
      periodLines: [
        { T: T0, label: "T₀", color: "rgba(99,102,241,0.75)" },
        { T: Ts, label: "Ts", color: "rgba(245,158,11,0.75)" },
        ...(T_max >= TL ? [{ T: TL, label: "TL", color: "rgba(239,68,68,0.65)" }] : []),
      ].filter((pl) => pl.T > 0 && pl.T < T_max),
      zoneX: {
        rampa:  { x1: xScale(0),                   x2: xScale(Math.min(T0, T_max)) },
        meseta: { x1: xScale(Math.min(T0, T_max)), x2: xScale(Math.min(Ts, T_max)) },
        caida:  { x1: xScale(Math.min(Ts, T_max)), x2: xScale(Math.min(TL, T_max)) },
        larga:  T_max > TL ? { x1: xScale(TL), x2: xScale(T_max) } : null,
      } as Record<string, { x1: number; x2: number } | null>,
    };
  }, [data, hoverT]);

  function onPointerMove(e: React.PointerEvent<SVGRectElement>) {
    if (!computed) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * WIDTH;
    const T    = ((svgX - MARGIN.left) / computed.innerW) * computed.T_max;
    setHoverT(Math.max(0, Math.min(computed.T_max, T)));
  }

  // ── Loading state ────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center rounded-lg border border-border bg-surface-2">
        <p className="text-sm text-text-muted animate-pulse">Calculando espectro…</p>
      </div>
    );
  }

  if (!data || !computed) return null;

  const { params, zona_sismica } = data;
  const {
    xScale, yScale, pathD, fillD, xTicks, yTicks,
    innerW, innerH, hoverPt, periodLines, zoneX,
  } = computed;
  const scale = svgW / WIDTH;

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4">

      {/* Parámetros espectrales */}
      <div className="flex flex-wrap gap-2">
        <StatPill label="SDs" value={`${params.SDs.toFixed(3)} g`} />
        <StatPill label="SD1" value={`${params.SD1.toFixed(3)} g`} />
        <StatPill label="T₀"  value={`${params.T0.toFixed(3)} s`} />
        <StatPill label="Ts"  value={`${params.Ts.toFixed(3)} s`} />
        <StatPill label="TL"  value={`${params.TL.toFixed(1)} s`} />
        <StatPill label="Fa"  value={params.Fa.toFixed(2)} />
        <StatPill label="Fv"  value={params.Fv.toFixed(2)} />
        {zona_sismica && <StatPill label="Zona" value={zona_sismica} />}
      </div>

      {/* Gráfica SVG */}
      <div className="relative select-none rounded-lg border border-border bg-surface overflow-hidden">
        <svg
          ref={svgRef}
          width="100%"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="font-mono text-[11px]"
        >
          <defs>
            <linearGradient id="sp-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="var(--color-accent)" stopOpacity="0.25" />
              <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0.03" />
            </linearGradient>
            <clipPath id="sp-clip">
              <rect x={MARGIN.left} y={MARGIN.top} width={innerW} height={innerH} />
            </clipPath>
          </defs>

          {/* Zone background bands */}
          {(["rampa", "meseta", "caida", "larga"] as const).map((zone) => {
            const z = zoneX[zone];
            if (!z || z.x2 <= z.x1) return null;
            return (
              <rect key={zone} x={z.x1} y={MARGIN.top}
                width={z.x2 - z.x1} height={innerH}
                fill={ZONE_FILL[zone]} />
            );
          })}

          {/* Zone labels at top */}
          {(["rampa", "meseta", "caida"] as const).map((zone) => {
            const z = zoneX[zone];
            if (!z || z.x2 - z.x1 < 32) return null;
            return (
              <text key={zone} x={(z.x1 + z.x2) / 2} y={MARGIN.top - 7}
                textAnchor="middle" fill="var(--color-text-muted)"
                fontSize={8} letterSpacing="0.05em">
                {ZONE_LABELS[zone].toUpperCase()}
              </text>
            );
          })}

          {/* Y grid + tick labels */}
          {yTicks.map((t) => (
            <g key={`y-${t}`}>
              <line x1={MARGIN.left} x2={WIDTH - MARGIN.right}
                y1={yScale(t)} y2={yScale(t)}
                stroke="var(--color-border)" strokeWidth={1} />
              <text x={MARGIN.left - 8} y={yScale(t) + 4}
                textAnchor="end" fill="var(--color-text-muted)">
                {t % 1 === 0 ? t : +t.toFixed(3)}
              </text>
            </g>
          ))}

          {/* X grid + tick labels */}
          {xTicks.filter((t) => t > 0).map((t) => (
            <g key={`x-${t}`}>
              <line x1={xScale(t)} x2={xScale(t)}
                y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom}
                stroke="var(--color-border)" strokeWidth={1} />
              <text x={xScale(t)} y={HEIGHT - MARGIN.bottom + 14}
                textAnchor="middle" fill="var(--color-text-muted)">
                {t}
              </text>
            </g>
          ))}

          {/* Period lines T₀, Ts, TL */}
          {periodLines.map(({ T, label, color }) => (
            <g key={`pl-${T}`}>
              <line x1={xScale(T)} x2={xScale(T)}
                y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom}
                stroke={color} strokeWidth={1.2} strokeDasharray="4,3" />
              <text x={xScale(T)} y={HEIGHT - MARGIN.bottom + 28}
                textAnchor="middle" fill={color} fontSize={10} fontWeight="600">
                {label}
              </text>
            </g>
          ))}

          {/* Gradient fill */}
          <path d={fillD} fill="url(#sp-grad)" clipPath="url(#sp-clip)" />

          {/* Spectrum curve */}
          <path d={pathD} fill="none"
            stroke="var(--color-accent)" strokeWidth={2.5}
            strokeLinejoin="round" strokeLinecap="round"
            clipPath="url(#sp-clip)" />

          {/* Hover crosshair */}
          {hoverPt && (
            <>
              <line x1={hoverPt.x} x2={hoverPt.x}
                y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom}
                stroke="var(--color-text-muted)" strokeWidth={1} strokeDasharray="3,3" />
              <line x1={MARGIN.left} x2={WIDTH - MARGIN.right}
                y1={hoverPt.y} y2={hoverPt.y}
                stroke="var(--color-text-muted)" strokeWidth={1} strokeDasharray="3,3" opacity={0.4} />
              <circle cx={hoverPt.x} cy={hoverPt.y} r={5}
                fill="var(--color-accent)" stroke="var(--color-surface)" strokeWidth={2} />
            </>
          )}

          {/* Chart border */}
          <rect x={MARGIN.left} y={MARGIN.top} width={innerW} height={innerH}
            fill="none" stroke="var(--color-border)" strokeWidth={1} />

          {/* Axis labels */}
          <text
            x={MARGIN.left - 46} y={MARGIN.top + innerH / 2}
            textAnchor="middle" fill="var(--color-text-muted)" fontSize={11}
            transform={`rotate(-90, ${MARGIN.left - 46}, ${MARGIN.top + innerH / 2})`}>
            Sa (g)
          </text>
          <text x={MARGIN.left + innerW / 2} y={HEIGHT - 4}
            textAnchor="middle" fill="var(--color-text-muted)" fontSize={11}>
            Período T (s)
          </text>

          {/* Transparent hit area for hover */}
          <rect x={MARGIN.left} y={MARGIN.top} width={innerW} height={innerH}
            fill="transparent"
            onPointerMove={onPointerMove}
            onPointerLeave={() => setHoverT(null)} />
        </svg>

        {/* Tooltip */}
        {hoverPt && (
          <div
            className="pointer-events-none absolute rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-lg"
            style={{
              left: Math.min(hoverPt.x * scale + 12, svgW - 130),
              top:  Math.max(hoverPt.y * scale - 48, 6),
            }}
          >
            <div className="font-mono text-text">
              T = <span className="font-semibold">{hoverPt.T.toFixed(3)}</span> s
            </div>
            <div className="mt-0.5 font-mono text-text">
              Sa = <span className="font-semibold">{hoverPt.Sa.toFixed(4)}</span> g
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
