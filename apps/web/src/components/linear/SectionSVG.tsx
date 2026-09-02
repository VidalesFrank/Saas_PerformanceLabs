"use client";

import type { BarPosition } from "@/lib/structural-types";

interface SectionSVGProps {
  b_m: number;          // ancho en metros
  h_m: number;          // alto en metros
  cover_m: number;      // recubrimiento en metros
  diam_mm: number;      // diámetro de barra longitudinal en mm
  bar_positions: BarPosition[];  // posiciones en mm desde centroide
  tie_diam_mm?: number; // diámetro del estribo en mm
  showDimensions?: boolean;
  size?: number;        // tamaño del SVG en px (cuadrado)
}

export default function SectionSVG({
  b_m,
  h_m,
  cover_m,
  diam_mm,
  bar_positions,
  tie_diam_mm = 9.5,
  showDimensions = true,
  size = 260,
}: SectionSVGProps) {
  const b_mm   = b_m * 1000;
  const h_mm   = h_m * 1000;
  const cov_mm = cover_m * 1000;

  // Área de dibujo con márgenes para dimensiones
  const margin = showDimensions ? 36 : 10;
  const drawW  = size - margin * 2;
  const drawH  = size - margin * 2;

  // Escala: la sección debe caber en el área de dibujo
  const scaleX = drawW / b_mm;
  const scaleY = drawH / h_mm;
  const scale  = Math.min(scaleX, scaleY) * 0.85;  // 85% del área

  // Centro del SVG en píxeles
  const cx = size / 2;
  const cy = size / 2;

  // Dimensiones en píxeles
  const bPx  = b_mm * scale;
  const hPx  = h_mm * scale;
  const covPx = cov_mm * scale;
  const dPx   = diam_mm * scale;
  const tiePx = tie_diam_mm * scale;

  // Esquinas del concreto
  const concrX = cx - bPx / 2;
  const concrY = cy - hPx / 2;

  // Estribo (offset por recubrimiento)
  const tieX = concrX + covPx;
  const tieY = concrY + covPx;
  const tieW = bPx - 2 * covPx;
  const tieH = hPx - 2 * covPx;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{ fontFamily: "monospace", userSelect: "none" }}
    >
      {/* Concreto */}
      <rect
        x={concrX}
        y={concrY}
        width={bPx}
        height={hPx}
        fill="#e8e0d0"
        stroke="#555"
        strokeWidth={1.5}
      />

      {/* Estribo */}
      <rect
        x={tieX}
        y={tieY}
        width={tieW}
        height={tieH}
        fill="none"
        stroke="#444"
        strokeWidth={Math.max(tiePx, 1.0)}
        strokeLinejoin="round"
      />

      {/* Barras longitudinales */}
      {bar_positions.map((pos, i) => {
        const bx = cx + pos.x * scale;
        const by = cy - pos.y * scale;  // y del SVG invertido
        const r  = Math.max(dPx / 2, 2.5);
        return (
          <g key={i}>
            <circle cx={bx} cy={by} r={r} fill="#1a1a1a" />
            <circle cx={bx} cy={by} r={r * 0.35} fill="#888" />
          </g>
        );
      })}

      {/* Centroide (cruz pequeña) */}
      <line x1={cx - 5} y1={cy} x2={cx + 5} y2={cy} stroke="#aaa" strokeWidth={0.8} />
      <line x1={cx} y1={cy - 5} x2={cx} y2={cy + 5} stroke="#aaa" strokeWidth={0.8} />

      {/* Dimensiones */}
      {showDimensions && (
        <>
          {/* Ancho (b) — abajo */}
          <line
            x1={concrX} y1={concrY + hPx + 18}
            x2={concrX + bPx} y2={concrY + hPx + 18}
            stroke="#666" strokeWidth={0.8}
          />
          <line x1={concrX} y1={concrY + hPx + 13} x2={concrX} y2={concrY + hPx + 23}
            stroke="#666" strokeWidth={0.8} />
          <line x1={concrX + bPx} y1={concrY + hPx + 13} x2={concrX + bPx} y2={concrY + hPx + 23}
            stroke="#666" strokeWidth={0.8} />
          <text
            x={cx} y={concrY + hPx + 30}
            textAnchor="middle" fontSize={9} fill="#555"
          >
            b = {(b_m * 100).toFixed(0)} cm
          </text>

          {/* Alto (h) — derecha */}
          <line
            x1={concrX + bPx + 18} y1={concrY}
            x2={concrX + bPx + 18} y2={concrY + hPx}
            stroke="#666" strokeWidth={0.8}
          />
          <line x1={concrX + bPx + 13} y1={concrY} x2={concrX + bPx + 23} y2={concrY}
            stroke="#666" strokeWidth={0.8} />
          <line x1={concrX + bPx + 13} y1={concrY + hPx} x2={concrX + bPx + 23} y2={concrY + hPx}
            stroke="#666" strokeWidth={0.8} />
          <text
            x={concrX + bPx + 28} y={cy + 3}
            textAnchor="start" fontSize={9} fill="#555"
            transform={`rotate(-90, ${concrX + bPx + 28}, ${cy})`}
          >
            h = {(h_m * 100).toFixed(0)} cm
          </text>

          {/* Recubrimiento */}
          <text x={tieX + 2} y={tieY - 3} fontSize={8} fill="#888">
            r={(cover_m * 100).toFixed(0)} cm
          </text>
        </>
      )}
    </svg>
  );
}
