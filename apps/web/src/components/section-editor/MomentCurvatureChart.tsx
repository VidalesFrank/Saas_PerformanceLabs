"use client";

import type { MomentCurvatureResult } from "@/lib/editor-api";

const PAD = { top: 28, right: 28, bottom: 56, left: 72 };
const W = 680;
const H = 360;

interface Props {
  result: MomentCurvatureResult;
}

export function MomentCurvatureChart({ result }: Props) {
  const { curve, phi_yield, moment_yield, phi_max, moment_max, phi_ultimate, moment_ultimate } = result;
  if (!curve.length) return <p className="text-sm text-text-muted">Sin datos.</p>;

  const phiMax  = Math.max(...curve.map((p) => p.phi)) * 1.05;
  const momMax  = Math.max(...curve.map((p) => p.moment)) * 1.12;
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top  - PAD.bottom;

  const sx = (v: number) => PAD.left + (v / phiMax) * iw;
  const sy = (v: number) => PAD.top  + ih - (v / momMax) * ih;

  const polyline = curve.map((p) => `${sx(p.phi)},${sy(p.moment)}`).join(" ");
  const bilineal = [
    `${sx(0)},${sy(0)}`,
    `${sx(phi_yield)},${sy(moment_max)}`,
    `${sx(phi_ultimate)},${sy(moment_max)}`,
  ].join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ fontFamily: "monospace" }}>
      <rect x={PAD.left} y={PAD.top} width={iw} height={ih}
        fill="none" stroke="var(--color-border)" strokeWidth={1} />

      {/* Grid X */}
      {Array.from({ length: 6 }, (_, i) => {
        const x = PAD.left + (i / 5) * iw;
        const val = (i / 5) * phiMax;
        return (
          <g key={i}>
            <line x1={x} y1={PAD.top} x2={x} y2={PAD.top + ih}
              stroke="var(--color-border)" strokeWidth={0.5} />
            <text x={x} y={PAD.top + ih + 16} textAnchor="middle"
              fontSize={9} fill="var(--color-text-muted)">{val.toFixed(4)}</text>
          </g>
        );
      })}

      {/* Grid Y */}
      {Array.from({ length: 6 }, (_, i) => {
        const y = PAD.top + ih - (i / 5) * ih;
        const val = (i / 5) * momMax;
        return (
          <g key={i}>
            <line x1={PAD.left} y1={y} x2={PAD.left + iw} y2={y}
              stroke="var(--color-border)" strokeWidth={0.5} />
            <text x={PAD.left - 6} y={y + 4} textAnchor="end"
              fontSize={9} fill="var(--color-text-muted)">{val.toFixed(0)}</text>
          </g>
        );
      })}

      {/* Bilineal idealizada */}
      <polyline points={bilineal} fill="none" stroke="var(--color-accent)"
        strokeWidth={1.5} strokeDasharray="6,4" opacity={0.55} />

      {/* Curva real */}
      <polyline points={polyline} fill="none" stroke="var(--color-accent)"
        strokeWidth={2.5} strokeLinejoin="round" />

      {/* Fluencia */}
      <line x1={sx(phi_yield)} y1={PAD.top} x2={sx(phi_yield)} y2={sy(moment_yield)}
        stroke="var(--color-success)" strokeWidth={1.5} strokeDasharray="5,3" />
      <line x1={PAD.left} y1={sy(moment_yield)} x2={sx(phi_yield)} y2={sy(moment_yield)}
        stroke="var(--color-success)" strokeWidth={1.5} strokeDasharray="5,3" />
      <circle cx={sx(phi_yield)} cy={sy(moment_yield)} r={4.5} fill="var(--color-success)" />
      <text x={sx(phi_yield) + 7} y={sy(moment_yield) - 7} fontSize={9}
        fill="var(--color-success)" fontWeight="600">
        φy={phi_yield.toFixed(4)} My={moment_yield.toFixed(0)} kN·m
      </text>

      {/* Mmax */}
      <line x1={sx(phi_max)} y1={PAD.top} x2={sx(phi_max)} y2={sy(moment_max)}
        stroke="var(--color-warning)" strokeWidth={1.5} strokeDasharray="5,3" />
      <line x1={PAD.left} y1={sy(moment_max)} x2={sx(phi_max)} y2={sy(moment_max)}
        stroke="var(--color-warning)" strokeWidth={1.5} strokeDasharray="5,3" />
      <circle cx={sx(phi_max)} cy={sy(moment_max)} r={4.5} fill="var(--color-warning)" />
      <text x={sx(phi_max) + 7} y={sy(moment_max) - 7} fontSize={9}
        fill="var(--color-warning)" fontWeight="600">
        φmax={phi_max.toFixed(4)} Mmax={moment_max.toFixed(0)} kN·m
      </text>

      {/* φu */}
      <line x1={sx(phi_ultimate)} y1={PAD.top} x2={sx(phi_ultimate)} y2={sy(moment_ultimate)}
        stroke="var(--color-danger)" strokeWidth={1.5} strokeDasharray="5,3" />
      <circle cx={sx(phi_ultimate)} cy={sy(moment_ultimate)} r={4.5} fill="var(--color-danger)" />
      <text x={sx(phi_ultimate) + 7} y={sy(moment_ultimate) - 7} fontSize={9}
        fill="var(--color-danger)" fontWeight="600">
        φu={phi_ultimate.toFixed(4)} Mu={moment_ultimate.toFixed(0)} kN·m
      </text>

      {/* Ejes */}
      <text x={PAD.left + iw / 2} y={H - 6} textAnchor="middle"
        fontSize={11} fill="var(--color-text-muted)">Curvatura φ (1/m)</text>
      <text x={0} y={0} textAnchor="middle" fontSize={11} fill="var(--color-text-muted)"
        transform={`translate(14, ${PAD.top + ih / 2}) rotate(-90)`}>
        Momento M (kN·m)
      </text>
    </svg>
  );
}
