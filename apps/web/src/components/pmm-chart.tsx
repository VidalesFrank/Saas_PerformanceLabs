"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { PMMArcOut, PMMDemandOut, PMMPointOut } from "@/lib/types";

// ── helpers compartidos ───────────────────────────────────────────────────────

function mResultante(pt: PMMPointOut) {
  return Math.sqrt(pt.mx ** 2 + pt.my ** 2);
}

function interpM(pts: PMMPointOut[], pTarget: number): number {
  for (let i = 0; i < pts.length - 1; i++) {
    const pHi = pts[i].p, pLo = pts[i + 1].p;
    const mHi = mResultante(pts[i]), mLo = mResultante(pts[i + 1]);
    if (pLo <= pTarget && pTarget <= pHi) {
      const t = Math.abs(pHi - pLo) > 1e-9 ? (pTarget - pLo) / (pHi - pLo) : 0;
      return mLo + t * (mHi - mLo);
    }
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GRÁFICA 3D — Superficie P-M-M interactiva
// ═══════════════════════════════════════════════════════════════════════════════

const W3D = 620, H3D = 480;
const CX = W3D / 2, CY = H3D / 2 - 10;
const SCALE_P = 170;    // px por unidad normalizada de P
const SCALE_M = 200;    // px por unidad normalizada de M

interface Proj2D { x: number; y: number; depth: number }

function makeProjector(azimuth: number, elevation: number) {
  const ca = Math.cos(azimuth), sa = Math.sin(azimuth);
  const se = Math.sin(elevation), ce = Math.cos(elevation);
  return function project(mxN: number, pN: number, myN: number): Proj2D {
    // Rotación alrededor del eje P (vertical)
    const rx = mxN * ca - myN * sa;
    const rz = mxN * sa + myN * ca;
    // Proyección perspectiva simple con elevación
    const x = CX + rx * SCALE_M;
    const y = CY - pN * SCALE_P - rz * se * SCALE_M;
    const depth = rz * ce;   // profundidad para ordenar (painter)
    return { x, y, depth };
  };
}

interface PMMSurface3DProps {
  curves: PMMArcOut[];
  demands: PMMDemandOut[];
  pMaxKn: number;
  pMinKn: number;
  mMaxKnm: number;
}

export function PMMSurface3D({ curves, demands, pMaxKn, pMinKn, mMaxKnm }: PMMSurface3DProps) {
  const [azimuth, setAzimuth]     = useState(-Math.PI / 4);
  const [elevation, setElevation] = useState(Math.PI / 5);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Rango de normalización
  const pMid   = (pMaxKn + pMinKn) / 2;
  const pRange = Math.max(pMaxKn - pMinKn, 1);
  const mRange = Math.max(mMaxKnm, 1);

  const normP = (p: number) => (p - pMid) / pRange;
  const normM = (m: number) => m / mRange;

  const project = useMemo(() => makeProjector(azimuth, elevation), [azimuth, elevation]);

  // P levels únicos para los anillos horizontales (usa solo ~6 niveles intermedios)
  const pLevels = useMemo(() => {
    const pts = curves[0]?.points ?? [];
    // Solo los puntos internos (no los extremos de compresión/tensión pura)
    const inner = pts.slice(1, -1).map((p) => p.p);
    // Muestra ~5 anillos igualmente espaciados
    const step = Math.max(1, Math.floor(inner.length / 5));
    return inner.filter((_, i) => i % step === 0);
  }, [curves]);

  // Mouse drag handlers
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    drag.current = { x: e.clientX, y: e.clientY };
  }, []);
  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    setAzimuth((a) => a + dx * 0.008);
    setElevation((el) => Math.max(-Math.PI / 2.5, Math.min(Math.PI / 2, el - dy * 0.008)));
    drag.current = { x: e.clientX, y: e.clientY };
  }, []);
  const onMouseUp = useCallback(() => { drag.current = null; }, []);

  // Touch handlers
  const lastTouch = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0];
    lastTouch.current = { x: t.clientX, y: t.clientY };
  }, []);
  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!lastTouch.current) return;
    const t = e.touches[0];
    const dx = t.clientX - lastTouch.current.x;
    const dy = t.clientY - lastTouch.current.y;
    setAzimuth((a) => a + dx * 0.008);
    setElevation((el) => Math.max(-Math.PI / 2.5, Math.min(Math.PI / 2, el - dy * 0.008)));
    lastTouch.current = { x: t.clientX, y: t.clientY };
  }, []);
  const onTouchEnd = useCallback(() => { lastTouch.current = null; }, []);

  // ── Construir geometría 3D ─────────────────────────────────────────────────

  // Curvas verticales (por ángulo del eje neutro)
  const anglePaths = useMemo(() => {
    return curves.map((c) => {
      const pts2d = c.points.map((pt) =>
        project(normM(pt.mx), normP(pt.p), normM(pt.my))
      );
      const d = pts2d.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
      const avgDepth = pts2d.reduce((s, p) => s + p.depth, 0) / pts2d.length;
      return { d, depth: avgDepth, theta: c.theta_deg };
    });
  }, [curves, project, normM, normP]);

  // Anillos horizontales (sección Mx-My a cada nivel de P)
  const rings = useMemo(() => {
    return pLevels.map((pKn) => {
      const pts2d = curves.map((c) => {
        const m = interpM(c.points, pKn);
        const thetaRad = (c.theta_deg * Math.PI) / 180;
        const mx = m * Math.cos(thetaRad);
        const my = m * Math.sin(thetaRad);
        return project(normM(mx), normP(pKn), normM(my));
      });
      // cerrar el anillo
      const all = [...pts2d, pts2d[0]];
      const d = all.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
      const avgDepth = pts2d.reduce((s, p) => s + p.depth, 0) / pts2d.length;
      return { d, depth: avgDepth, pKn };
    });
  }, [pLevels, curves, project, normM, normP]);

  // Cara superior (compresión pura): polígono conectando el punto más alto de cada curva
  const topRing = useMemo(() => {
    const pts2d = curves.map((c) => {
      const top = c.points[0];
      return project(normM(top.mx), normP(top.p), normM(top.my));
    });
    const pMax2d = project(0, normP(pMaxKn), 0);
    // Triángulos desde el punto de compresión pura al anillo superior interno
    return { pts2d, center: pMax2d };
  }, [curves, project, normM, normP, pMaxKn]);

  // Cara inferior (tensión pura)
  const bottomCenter = useMemo(() =>
    project(0, normP(pMinKn), 0),
    [project, normP, pMinKn]
  );

  // Quads de la malla (painter's algorithm: ordenar por profundidad)
  const quads = useMemo(() => {
    const n = curves.length;
    const result: { d: string; depth: number; pFrac: number }[] = [];

    for (let i = 0; i < n; i++) {
      const c0 = curves[i].points;
      const c1 = curves[(i + 1) % n].points;
      const m = Math.min(c0.length, c1.length);

      for (let j = 0; j < m - 1; j++) {
        const p0 = project(normM(c0[j].mx), normP(c0[j].p), normM(c0[j].my));
        const p1 = project(normM(c1[j].mx), normP(c1[j].p), normM(c1[j].my));
        const p2 = project(normM(c1[j + 1].mx), normP(c1[j + 1].p), normM(c1[j + 1].my));
        const p3 = project(normM(c0[j + 1].mx), normP(c0[j + 1].p), normM(c0[j + 1].my));

        const depth = (p0.depth + p1.depth + p2.depth + p3.depth) / 4;
        const pFrac = (c0[j].p + c0[j + 1].p) / 2;
        const d = `M${p0.x.toFixed(1)},${p0.y.toFixed(1)} L${p1.x.toFixed(1)},${p1.y.toFixed(1)} L${p2.x.toFixed(1)},${p2.y.toFixed(1)} L${p3.x.toFixed(1)},${p3.y.toFixed(1)} Z`;
        result.push({ d, depth, pFrac });
      }
    }

    result.sort((a, b) => b.depth - a.depth);
    return result;
  }, [curves, project, normM, normP]);

  // Ejes
  const axes = useMemo(() => {
    const origin = project(0, 0, 0);
    const axP    = project(0, 0.65, 0);
    const axMx   = project(0.7, 0, 0);
    const axMy   = project(0, 0, 0.7);
    const axPN   = project(0, -0.65, 0);
    return { origin, axP, axMx, axMy, axPN };
  }, [project]);

  // Puntos de demanda en 3D
  const demandPts = useMemo(() =>
    demands.map((d) => {
      const pt = project(normM(d.mx_knm), normP(d.p_kn), normM(d.my_knm));
      const theta = Math.atan2(d.my_knm, d.mx_knm);
      const capPt = project(
        normM(d.m_capacity_knm * Math.cos(theta)),
        normP(d.p_kn),
        normM(d.m_capacity_knm * Math.sin(theta)),
      );
      return {
        ...pt,
        inside: d.inside,
        dcr: d.dcr,
        p: d.p_kn,
        mx: d.mx_knm,
        my: d.my_knm,
        mCap: d.m_capacity_knm,
        capPt,
        pAxisPt: project(0, normP(d.p_kn), 0),
        base: project(normM(d.mx_knm), normP(pMinKn * 1.1), normM(d.my_knm)),
      };
    }),
    [demands, project, normM, normP, pMinKn]
  );

  // Frac de P para colorear (0=tension, 1=compresion)
  const pFracColor = (pKn: number) => {
    const f = Math.max(0, Math.min(1, (pKn - pMinKn) / Math.max(pRange, 1)));
    // azul para compresion, naranja para tensión
    const r = Math.round(40 + (220 - 40) * (1 - f));
    const g = Math.round(80 + (130 - 80) * (1 - f));
    const b = Math.round(220 - (220 - 40) * (1 - f));
    return `rgb(${r},${g},${b})`;
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-text-muted">Arrastra para rotar la superficie</p>
        <button
          type="button"
          onClick={() => { setAzimuth(-Math.PI / 4); setElevation(Math.PI / 5); }}
          className="text-xs text-accent hover:underline"
        >
          Restablecer vista
        </button>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W3D} ${H3D}`}
        className="w-full rounded-lg border border-border bg-surface-2 cursor-grab active:cursor-grabbing"
        style={{ maxHeight: 480, touchAction: "none" }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {/* ── Caras rellenas (ordenadas por profundidad) ── */}
        {quads.map((q, i) => (
          <path
            key={i}
            d={q.d}
            fill={pFracColor(q.pFrac)}
            fillOpacity={0.12}
            stroke="none"
          />
        ))}

        {/* ── Anillos horizontales ── */}
        {rings.map((r, i) => (
          <path
            key={i}
            d={r.d}
            fill="none"
            stroke="var(--color-text-muted)"
            strokeWidth={0.8}
            opacity={0.5}
          />
        ))}

        {/* ── Curvas por ángulo del eje neutro ── */}
        {anglePaths.map((ap, i) => (
          <path
            key={i}
            d={ap.d}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth={1.2}
            opacity={0.7}
          />
        ))}

        {/* ── Punto de compresión pura ── */}
        <circle cx={topRing.center.x} cy={topRing.center.y} r={4} fill="var(--color-accent)" />

        {/* ── Punto de tensión pura ── */}
        <circle cx={bottomCenter.x} cy={bottomCenter.y} r={4} fill="var(--color-accent)" />

        {/* ── Líneas verticales del vértice superior a primer anillo ── */}
        {curves.map((c, i) => {
          const topPt = c.points[0];
          const p2d   = project(normM(topPt.mx), normP(topPt.p), normM(topPt.my));
          return (
            <line
              key={i}
              x1={topRing.center.x} y1={topRing.center.y}
              x2={p2d.x} y2={p2d.y}
              stroke="var(--color-accent)"
              strokeWidth={0.8}
              opacity={0.4}
            />
          );
        })}

        {/* ── Líneas del punto de tensión al último anillo ── */}
        {curves.map((c, i) => {
          const botPt = c.points[c.points.length - 1];
          const p2d   = project(normM(botPt.mx), normP(botPt.p), normM(botPt.my));
          return (
            <line
              key={i}
              x1={bottomCenter.x} y1={bottomCenter.y}
              x2={p2d.x} y2={p2d.y}
              stroke="var(--color-accent)"
              strokeWidth={0.8}
              opacity={0.4}
            />
          );
        })}

        {/* ── Ejes de referencia ── */}
        {/* Eje P (vertical) */}
        <line x1={axes.axPN.x} y1={axes.axPN.y} x2={axes.axP.x} y2={axes.axP.y}
          stroke="#22c55e" strokeWidth={1.2} opacity={0.7} />
        <text x={axes.axP.x + 4} y={axes.axP.y - 4} fontSize={10} fill="#22c55e">P (+)</text>
        <text x={axes.axPN.x + 4} y={axes.axPN.y + 12} fontSize={10} fill="#22c55e">P (−)</text>

        {/* Eje Mx */}
        <line x1={axes.origin.x} y1={axes.origin.y} x2={axes.axMx.x} y2={axes.axMx.y}
          stroke="#60a5fa" strokeWidth={1.2} opacity={0.7} />
        <text x={axes.axMx.x + 4} y={axes.axMx.y + 4} fontSize={10} fill="#60a5fa">Mx</text>

        {/* Eje My */}
        <line x1={axes.origin.x} y1={axes.origin.y} x2={axes.axMy.x} y2={axes.axMy.y}
          stroke="#f97316" strokeWidth={1.2} opacity={0.7} />
        <text x={axes.axMy.x + 4} y={axes.axMy.y + 4} fontSize={10} fill="#f97316">My</text>

        {/* ── Puntos de demanda ── */}
        {demandPts.map((d, i) => {
          const color = d.inside ? "#22c55e" : "#ef4444";
          return (
            <g key={i}>
              {/* Cue vertical de profundidad al plano inferior */}
              <line x1={d.x} y1={d.y} x2={d.base.x} y2={d.base.y}
                stroke={color} strokeWidth={1} strokeDasharray="3,2" opacity={0.35} />
              {/* Línea radial eje-P → punto de capacidad en la superficie */}
              {d.mCap > 0 && (
                <line x1={d.pAxisPt.x} y1={d.pAxisPt.y} x2={d.capPt.x} y2={d.capPt.y}
                  stroke={color} strokeWidth={1.5} strokeDasharray="5,3" opacity={0.75} />
              )}
              {/* Marca de capacidad en la superficie */}
              {d.mCap > 0 && (
                <circle cx={d.capPt.x} cy={d.capPt.y} r={5}
                  fill="none" stroke={color} strokeWidth={2} />
              )}
              {/* Halo semitransparente */}
              <circle cx={d.x} cy={d.y} r={12} fill={color} opacity={0.18} />
              {/* Punto de demanda */}
              <circle cx={d.x} cy={d.y} r={7} fill={color} stroke="white" strokeWidth={2} />
              {/* Etiqueta con fondo opaco */}
              <rect x={d.x + 10} y={d.y - 17} width={68} height={16} rx={3}
                fill="var(--color-surface)" opacity={0.92} stroke={color} strokeWidth={0.75} />
              <text x={d.x + 13} y={d.y - 5} fontSize={10} fontWeight={600} fill={color}>
                DCR {d.dcr === Infinity ? "∞" : d.dcr.toFixed(2)}
              </text>
            </g>
          );
        })}

        {/* ── Leyenda ── */}
        <rect x={W3D - 138} y={10} width={128} height={72} rx={4}
          fill="var(--color-surface)" fillOpacity={0.9} stroke="var(--color-border)" strokeWidth={1} />
        <line x1={W3D - 128} y1={24} x2={W3D - 108} y2={24} stroke="var(--color-accent)" strokeWidth={1.5} />
        <text x={W3D - 104} y={28} fontSize={9} fill="var(--color-text-muted)">Curva P-M por θ</text>
        <line x1={W3D - 128} y1={38} x2={W3D - 108} y2={38} stroke="var(--color-text-muted)" strokeWidth={0.8} />
        <text x={W3D - 104} y={42} fontSize={9} fill="var(--color-text-muted)">Sección Mx-My</text>
        <circle cx={W3D - 118} cy={54} r={5} fill="#22c55e" stroke="white" strokeWidth={1.5} />
        <text x={W3D - 110} y={58} fontSize={9} fill="var(--color-text-muted)">Demanda OK</text>
        <circle cx={W3D - 118} cy={68} r={5} fill="#ef4444" stroke="white" strokeWidth={1.5} />
        <text x={W3D - 110} y={72} fontSize={9} fill="var(--color-text-muted)">Demanda FALLA</text>
      </svg>

      {/* Texto con valores extremos */}
      <div className="flex justify-between text-[11px] text-text-muted">
        <span>P compresión: <span className="font-mono text-text">{pMaxKn.toFixed(0)} kN</span></span>
        <span>M máx: <span className="font-mono text-text">{mMaxKnm.toFixed(1)} kN·m</span></span>
        <span>P tensión: <span className="font-mono text-text">{pMinKn.toFixed(0)} kN</span></span>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// GRÁFICA 2D — Envolvente P-M_resultante (complementaria)
// ═══════════════════════════════════════════════════════════════════════════════

const PAD = { top: 20, right: 20, bottom: 48, left: 64 };

function toSvgX(v: number, min: number, max: number, w: number) {
  return PAD.left + ((v - min) / (max - min)) * w;
}
function toSvgY(v: number, min: number, max: number, h: number) {
  return PAD.top + h - ((v - min) / (max - min)) * h;
}

function envelopePoints(curves: PMMArcOut[]): { p: number; m: number }[] {
  const pSet = new Set<number>();
  curves.forEach((c) => c.points.forEach((pt) => pSet.add(pt.p)));
  const pLevels = Array.from(pSet).sort((a, b) => b - a);
  return pLevels.map((p) => ({
    p,
    m: Math.max(...curves.map((c) => interpM(c.points, p))),
  }));
}

interface PMMEnvelopeChartProps {
  curves: PMMArcOut[];
  demands: PMMDemandOut[];
}

export function PMMEnvelopeChart({ curves, demands }: PMMEnvelopeChartProps) {
  const W = 520, H = 360;
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const envelope = useMemo(() => envelopePoints(curves), [curves]);
  const mMax = Math.max(...curves.flatMap((c) => c.points.map(mResultante))) * 1.05 || 100;
  const pMax = Math.max(...curves.flatMap((c) => c.points.map((p) => p.p))) * 1.05 || 100;
  const pMin = Math.min(...curves.flatMap((c) => c.points.map((p) => p.p))) * 1.05 || -500;

  const sx = (m: number) => toSvgX(m, 0, mMax, chartW);
  const sy = (p: number) => toSvgY(p, pMin, pMax, chartH);

  const mTicks = Array.from({ length: 5 }, (_, i) => (mMax / 4) * i);
  const pTicks = Array.from({ length: 6 }, (_, i) => pMin + ((pMax - pMin) / 5) * i);

  const envPath = envelope
    .map((pt, i) => `${i === 0 ? "M" : "L"}${sx(pt.m).toFixed(1)},${sy(pt.p).toFixed(1)}`)
    .join(" ");

  const anglePaths = curves.map((c) =>
    c.points.map((pt, i) => `${i === 0 ? "M" : "L"}${sx(mResultante(pt)).toFixed(1)},${sy(pt.p).toFixed(1)}`).join(" ")
  );

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 360 }}>
      {mTicks.map((m) => (
        <line key={m} x1={sx(m)} y1={PAD.top} x2={sx(m)} y2={PAD.top + chartH}
          stroke="var(--color-border)" strokeWidth={1} />
      ))}
      {pTicks.map((p) => (
        <line key={p} x1={PAD.left} y1={sy(p)} x2={PAD.left + chartW} y2={sy(p)}
          stroke="var(--color-border)" strokeWidth={1} />
      ))}
      {anglePaths.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="var(--color-text-muted)" strokeWidth={1} opacity={0.3} />
      ))}
      <path d={envPath} fill="none" stroke="var(--color-accent)" strokeWidth={2.5} />
      {demands.map((d, i) => {
        const mDem = d.m_demand_knm;
        if (d.p_kn < pMin || d.p_kn > pMax) return null;
        return (
          <g key={i}>
            <circle cx={sx(mDem)} cy={sy(d.p_kn)} r={5} fill={d.inside ? "#22c55e" : "#ef4444"} />
            <text x={sx(mDem) + 7} y={sy(d.p_kn) + 4} fontSize={10} fill={d.inside ? "#22c55e" : "#ef4444"}>
              {d.dcr === Infinity ? "∞" : d.dcr.toFixed(2)}
            </text>
          </g>
        );
      })}
      <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + chartH}
        stroke="var(--color-text-muted)" strokeWidth={1.5} />
      <line x1={PAD.left} y1={PAD.top + chartH} x2={PAD.left + chartW} y2={PAD.top + chartH}
        stroke="var(--color-text-muted)" strokeWidth={1.5} />
      {mTicks.map((m) => (
        <text key={m} x={sx(m)} y={PAD.top + chartH + 16} textAnchor="middle" fontSize={10} fill="var(--color-text-muted)">
          {Math.round(m)}
        </text>
      ))}
      {pTicks.map((p) => (
        <text key={p} x={PAD.left - 8} y={sy(p) + 4} textAnchor="end" fontSize={10} fill="var(--color-text-muted)">
          {Math.round(p)}
        </text>
      ))}
      <text x={PAD.left + chartW / 2} y={H - 4} textAnchor="middle" fontSize={11} fill="var(--color-text-muted)">
        M resultante (kN·m)
      </text>
      <text transform={`translate(14,${PAD.top + chartH / 2}) rotate(-90)`}
        textAnchor="middle" fontSize={11} fill="var(--color-text-muted)">P (kN)</text>
    </svg>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// GRÁFICA 2D — Sección Mx-My a nivel de P dado
// ═══════════════════════════════════════════════════════════════════════════════

function crossSection(curves: PMMArcOut[], pKn: number): { mx: number; my: number }[] {
  return curves.map((c) => {
    const thetaRad = (c.theta_deg * Math.PI) / 180;
    const m = interpM(c.points, pKn);
    return { mx: m * Math.cos(thetaRad), my: m * Math.sin(thetaRad) };
  });
}

interface MxMyChartProps {
  curves: PMMArcOut[];
  pLevel: number;
  demands: PMMDemandOut[];
}

export function MxMyChart({ curves, pLevel, demands }: MxMyChartProps) {
  const W = 380, H = 380;
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const cs = useMemo(() => crossSection(curves, pLevel), [curves, pLevel]);
  const mRange = Math.max(...cs.flatMap((pt) => [Math.abs(pt.mx), Math.abs(pt.my)])) * 1.15 || 100;

  const sx = (v: number) => toSvgX(v, -mRange, mRange, chartW);
  const sy = (v: number) => toSvgY(v, -mRange, mRange, chartH);
  const cx0 = sx(0), cy0 = sy(0);

  const polyPts = [...cs, cs[0]].map((pt) => `${sx(pt.mx).toFixed(1)},${sy(pt.my).toFixed(1)}`).join(" ");

  const ticks = [-0.8, -0.4, 0, 0.4, 0.8].map((f) => Math.round(mRange * f));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 380 }}>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={sx(v)} y1={PAD.top} x2={sx(v)} y2={PAD.top + chartH}
            stroke="var(--color-border)" strokeWidth={1} />
          <line x1={PAD.left} y1={sy(v)} x2={PAD.left + chartW} y2={sy(v)}
            stroke="var(--color-border)" strokeWidth={1} />
        </g>
      ))}
      <polygon points={polyPts} fill="var(--color-accent)" fillOpacity={0.1}
        stroke="var(--color-accent)" strokeWidth={2} />
      {demands.map((d, i) => {
        const theta = Math.atan2(d.my_knm, d.mx_knm);
        const mCap = d.m_capacity_knm;
        return (
          <g key={i}>
            <line x1={cx0} y1={cy0} x2={sx(mCap * Math.cos(theta))} y2={sy(mCap * Math.sin(theta))}
              stroke={d.inside ? "#22c55e" : "#ef4444"} strokeWidth={1} strokeDasharray="4,3" opacity={0.6} />
            <circle cx={sx(d.mx_knm)} cy={sy(d.my_knm)} r={5} fill={d.inside ? "#22c55e" : "#ef4444"} />
            <circle cx={sx(mCap * Math.cos(theta))} cy={sy(mCap * Math.sin(theta))} r={4}
              fill="none" stroke={d.inside ? "#22c55e" : "#ef4444"} strokeWidth={1.5} />
            <text x={sx(d.mx_knm) + 7} y={sy(d.my_knm) - 4} fontSize={9}
              fill={d.inside ? "#22c55e" : "#ef4444"}>
              {d.dcr === Infinity ? "∞" : d.dcr.toFixed(2)}
            </text>
          </g>
        );
      })}
      <line x1={cx0 - 5} y1={cy0} x2={cx0 + 5} y2={cy0} stroke="var(--color-text-muted)" strokeWidth={1} />
      <line x1={cx0} y1={cy0 - 5} x2={cx0} y2={cy0 + 5} stroke="var(--color-text-muted)" strokeWidth={1} />
      <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + chartH}
        stroke="var(--color-text-muted)" strokeWidth={1.5} />
      <line x1={PAD.left} y1={PAD.top + chartH} x2={PAD.left + chartW} y2={PAD.top + chartH}
        stroke="var(--color-text-muted)" strokeWidth={1.5} />
      {ticks.map((v) => (
        <g key={v}>
          <text x={sx(v)} y={PAD.top + chartH + 16} textAnchor="middle" fontSize={9} fill="var(--color-text-muted)">{v}</text>
          <text x={PAD.left - 6} y={sy(v) + 4} textAnchor="end" fontSize={9} fill="var(--color-text-muted)">{v}</text>
        </g>
      ))}
      <text x={PAD.left + chartW / 2} y={H - 4} textAnchor="middle" fontSize={11} fill="var(--color-text-muted)">My (kN·m)</text>
      <text transform={`translate(14,${PAD.top + chartH / 2}) rotate(-90)`}
        textAnchor="middle" fontSize={11} fill="var(--color-text-muted)">Mx (kN·m)</text>
      <text x={PAD.left + chartW} y={PAD.top + 12} textAnchor="end" fontSize={10} fill="var(--color-text-muted)">
        P = {pLevel.toFixed(0)} kN
      </text>
    </svg>
  );
}

// ── Selector de P para la vista Mx-My ────────────────────────────────────────

interface MxMyPanelProps {
  curves: PMMArcOut[];
  demands: PMMDemandOut[];
  defaultP: number;
}

export function MxMyPanel({ curves, demands, defaultP }: MxMyPanelProps) {
  const [pLevel, setPLevel] = useState(defaultP);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <label className="text-xs text-text-muted whitespace-nowrap">P para sección (kN)</label>
        <input
          type="number"
          value={pLevel}
          onChange={(e) => setPLevel(+e.target.value)}
          className="w-28 rounded-md border border-border bg-surface-2 px-2 py-1 text-sm text-text"
        />
      </div>
      <MxMyChart curves={curves} pLevel={pLevel} demands={demands} />
    </div>
  );
}
