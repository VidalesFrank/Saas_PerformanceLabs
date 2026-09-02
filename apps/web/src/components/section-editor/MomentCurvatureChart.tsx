"use client";

import type { MomentCurvatureResult } from "@/lib/editor-api";

const PAD = { top: 36, right: 28, bottom: 60, left: 76 };
const W = 700;
const H = 380;

interface Props {
  result: MomentCurvatureResult;
  color?: string;
}

export function MomentCurvatureChart({ result, color = "var(--color-accent)" }: Props) {
  const { curve, phi_yield, moment_yield, phi_max, moment_max, phi_ultimate, moment_ultimate, axial_load_kn } = result;
  if (!curve.length) return <p className="text-sm text-text-muted">Sin datos.</p>;

  const phiMax  = Math.max(...curve.map((p) => p.phi)) * 1.07;
  const momMax  = Math.max(...curve.map((p) => p.moment)) * 1.18;
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top  - PAD.bottom;

  const sx = (v: number) => PAD.left + (v / phiMax) * iw;
  const sy = (v: number) => PAD.top  + ih - (v / momMax) * ih;

  const polyline = curve.map((p) => `${sx(p.phi)},${sy(p.moment)}`).join(" ");

  // Bilineal igual-energía (Paulay & Priestley / ASCE 41):
  // Pendiente elástica = Mmax / φy → el punto de "fluencia idealizada" está en (φy, Mmax)
  // La meseta horizontal va de (φy, Mmax) a (φu, Mmax).
  const bilineal = [
    `${sx(0)},${sy(0)}`,
    `${sx(phi_yield)},${sy(moment_max)}`,
    `${sx(phi_ultimate)},${sy(moment_max)}`,
  ].join(" ");

  const ductility = phi_yield > 0 ? (phi_ultimate / phi_yield) : 0;

  // Grid ticks
  const nGridX = 6;
  const nGridY = 6;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ fontFamily: "monospace" }}>
      {/* Título P */}
      <text x={PAD.left + iw / 2} y={PAD.top - 14} textAnchor="middle"
        fontSize={11} fontWeight="600" fill="var(--color-text)">
        Momento–Curvatura · P = {axial_load_kn.toFixed(0)} kN
        <tspan fill="var(--color-text-muted)" fontWeight="400"> · μφ = {ductility.toFixed(2)}</tspan>
      </text>

      {/* Marco del gráfico */}
      <rect x={PAD.left} y={PAD.top} width={iw} height={ih}
        fill="none" stroke="var(--color-border)" strokeWidth={1} />

      {/* Grid X */}
      {Array.from({ length: nGridX }, (_, i) => {
        const x = PAD.left + (i / (nGridX - 1)) * iw;
        const val = (i / (nGridX - 1)) * phiMax;
        return (
          <g key={`gx-${i}`}>
            <line x1={x} y1={PAD.top} x2={x} y2={PAD.top + ih}
              stroke="var(--color-border)" strokeWidth={i === 0 ? 0 : 0.5} />
            <text x={x} y={PAD.top + ih + 18} textAnchor="middle"
              fontSize={9} fill="var(--color-text-muted)">{val.toFixed(4)}</text>
          </g>
        );
      })}

      {/* Grid Y */}
      {Array.from({ length: nGridY }, (_, i) => {
        const y = PAD.top + ih - (i / (nGridY - 1)) * ih;
        const val = (i / (nGridY - 1)) * momMax;
        return (
          <g key={`gy-${i}`}>
            <line x1={PAD.left} y1={y} x2={PAD.left + iw} y2={y}
              stroke="var(--color-border)" strokeWidth={i === 0 ? 0 : 0.5} />
            <text x={PAD.left - 8} y={y + 4} textAnchor="end"
              fontSize={9} fill="var(--color-text-muted)">{val.toFixed(0)}</text>
          </g>
        );
      })}

      {/* Bilineal idealizada (línea de puntos color neutro) */}
      <polyline points={bilineal} fill="none" stroke="var(--color-text-muted)"
        strokeWidth={1.5} strokeDasharray="8,4" opacity={0.55} />

      {/* Curva real */}
      <polyline points={polyline} fill="none" stroke={color}
        strokeWidth={2.5} strokeLinejoin="round" />

      {/* ── Punto de fluencia φy, Mmax (en la bilineal) ─── */}
      <line x1={sx(phi_yield)} y1={PAD.top} x2={sx(phi_yield)} y2={sy(moment_max)}
        stroke="var(--color-success)" strokeWidth={1.5} strokeDasharray="5,3" opacity={0.7} />
      <line x1={PAD.left} y1={sy(moment_max)} x2={sx(phi_yield)} y2={sy(moment_max)}
        stroke="var(--color-success)" strokeWidth={1.5} strokeDasharray="5,3" opacity={0.7} />
      {/* Punto bilineal yield: (φy, Mmax) */}
      <circle cx={sx(phi_yield)} cy={sy(moment_max)} r={5} fill="var(--color-success)" />
      <text x={sx(phi_yield) + 8} y={sy(moment_max) - 8} fontSize={9}
        fill="var(--color-success)" fontWeight="600">
        φy = {phi_yield.toFixed(4)} / M = {moment_max.toFixed(0)} kN·m
      </text>
      {/* Referencia My real en curva (valor interpolado, menor que Mmax) */}
      {Math.abs(moment_yield - moment_max) > 1 && (
        <>
          <circle cx={sx(phi_yield)} cy={sy(moment_yield)} r={3.5}
            fill="none" stroke="var(--color-success)" strokeWidth={1.5} strokeDasharray="2,2" />
          <text x={sx(phi_yield) + 8} y={sy(moment_yield) + 12} fontSize={8}
            fill="var(--color-success)" opacity={0.7}>
            M(φy) = {moment_yield.toFixed(0)} kN·m
          </text>
        </>
      )}

      {/* ── Momento máximo φmax, Mmax ─── */}
      <line x1={sx(phi_max)} y1={PAD.top} x2={sx(phi_max)} y2={sy(moment_max)}
        stroke="var(--color-warning)" strokeWidth={1.5} strokeDasharray="5,3" opacity={0.7} />
      <circle cx={sx(phi_max)} cy={sy(moment_max)} r={5} fill="var(--color-warning)" />
      <text x={sx(phi_max) + 8} y={sy(moment_max) + 14} fontSize={9}
        fill="var(--color-warning)" fontWeight="600">
        φmax = {phi_max.toFixed(4)} / Mmax = {moment_max.toFixed(0)}
      </text>

      {/* ── Curvatura última φu ─── */}
      <line x1={sx(phi_ultimate)} y1={PAD.top} x2={sx(phi_ultimate)} y2={sy(moment_ultimate)}
        stroke="var(--color-danger)" strokeWidth={1.5} strokeDasharray="5,3" opacity={0.7} />
      <circle cx={sx(phi_ultimate)} cy={sy(moment_ultimate)} r={5} fill="var(--color-danger)" />
      <text x={sx(phi_ultimate) - 8} y={sy(moment_ultimate) - 8} fontSize={9}
        fill="var(--color-danger)" fontWeight="600" textAnchor="end">
        φu = {phi_ultimate.toFixed(4)}
      </text>

      {/* Eje X — etiqueta */}
      <text x={PAD.left + iw / 2} y={H - 8} textAnchor="middle"
        fontSize={11} fill="var(--color-text-muted)">Curvatura φ (1/m)</text>

      {/* Eje Y — etiqueta */}
      <text x={0} y={0} textAnchor="middle" fontSize={11} fill="var(--color-text-muted)"
        transform={`translate(16, ${PAD.top + ih / 2}) rotate(-90)`}>
        Momento M (kN·m)
      </text>

      {/* Leyenda */}
      <g transform={`translate(${PAD.left + iw - 190}, ${PAD.top + 8})`}>
        <rect x={0} y={0} width={186} height={50} rx={4}
          fill="var(--color-surface)" fillOpacity={0.9} stroke="var(--color-border)" strokeWidth={1} />
        <line x1={8} y1={14} x2={28} y2={14} stroke={color} strokeWidth={2.5} />
        <text x={34} y={18} fontSize={9} fill="var(--color-text)">Curva real</text>
        <line x1={8} y1={30} x2={28} y2={30} stroke="var(--color-text-muted)" strokeWidth={1.5} strokeDasharray="8,4" opacity={0.6} />
        <text x={34} y={34} fontSize={9} fill="var(--color-text)">Bilineal (igual-energía)</text>
        <text x={8} y={46} fontSize={8} fill="var(--color-text-muted)">φy basada en Paulay &amp; Priestley / ASCE 41</text>
      </g>
    </svg>
  );
}
