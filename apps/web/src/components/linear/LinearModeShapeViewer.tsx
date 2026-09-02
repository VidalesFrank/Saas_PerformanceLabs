"use client";

import { useEffect, useRef } from "react";
import type { ModalResult, ModeRow } from "@/lib/structural-types";
import { useTheme } from "@/lib/theme";
import { viewer3dTheme } from "@/lib/plotly-theme";

declare const Plotly: {
  newPlot:  (el: HTMLElement, data: unknown[], layout: unknown, config?: unknown) => void;
  restyle:  (el: HTMLElement, update: unknown, traces: number[]) => void;
  purge:    (el: HTMLElement) => void;
};

const MODE_COLORS = ["#818CF8", "#38BDF8", "#34D399"] as const; // indigo · sky · emerald

function modeLabel(row: ModeRow | undefined): string {
  if (!row) return "";
  if (row.Ux_pct >= 40) return "Traslación X";
  if (row.Uy_pct >= 40) return "Traslación Y";
  if (row.Rz_pct >= 40) return "Torsional";
  return "Mixto";
}

function computeScale(
  nodes: Record<string, [number, number, number]>,
  shapes: Record<string, [number, number, number]>,
): number {
  const pts = Object.values(nodes);
  if (!pts.length) return 1;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]), zs = pts.map((p) => p[2]);
  const extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const height = Math.max(...zs) - Math.min(...zs);
  const target = Math.max(height, extent) * 0.12;
  const maxAmp = Math.max(
    ...Object.values(shapes).map(([dx, dy, dz]) => Math.sqrt(dx * dx + dy * dy + dz * dz)),
    1e-12,
  );
  return target / maxAmp;
}

// ── Construcción de trazas ────────────────────────────────────────────────────

function makeUndeformed(
  nodes: Record<string, [number, number, number]>,
  elements: [number, number][],
): object {
  const x: (number | null)[] = [], y: (number | null)[] = [], z: (number | null)[] = [];
  for (const [ni, nj] of elements) {
    const pi = nodes[String(ni)], pj = nodes[String(nj)];
    if (!pi || !pj) continue;
    x.push(pi[0], pj[0], null); y.push(pi[1], pj[1], null); z.push(pi[2], pj[2], null);
  }
  return {
    type: "scatter3d", mode: "lines", x, y, z, name: "Estructura",
    line: { color: "#1e293b", width: 1.5 }, hoverinfo: "skip", showlegend: false,
  };
}

function makeDeformed(
  nodes: Record<string, [number, number, number]>,
  elements: [number, number][],
  shapes: Record<string, [number, number, number]>,
  amp: number,
  color: string,
): object {
  const x: (number | null)[] = [], y: (number | null)[] = [], z: (number | null)[] = [];
  for (const [ni, nj] of elements) {
    const pi = nodes[String(ni)], pj = nodes[String(nj)];
    const si = shapes[String(ni)] ?? [0, 0, 0];
    const sj = shapes[String(nj)] ?? [0, 0, 0];
    if (!pi || !pj) continue;
    x.push(pi[0] + amp * si[0], pj[0] + amp * sj[0], null);
    y.push(pi[1] + amp * si[1], pj[1] + amp * sj[1], null);
    z.push(pi[2] + amp * si[2], pj[2] + amp * sj[2], null);
  }
  return {
    type: "scatter3d", mode: "lines", x, y, z, name: "Forma modal",
    line: { color, width: 2.5 }, hoverinfo: "skip", showlegend: false,
  };
}

function modeLayout(isDark: boolean) {
  const t = viewer3dTheme(isDark);
  const axis = {
    color: t.axisColor, gridcolor: t.gridColor, showbackground: false,
    showticklabels: false, title: { text: "" },
  };
  return {
    scene: {
      xaxis: axis, yaxis: axis, zaxis: axis,
      bgcolor: "rgba(0,0,0,0)",
      camera: { eye: { x: 1.4, y: 1.4, z: 0.8 } },
      aspectmode: "data",
    },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor:  "rgba(0,0,0,0)",
    margin: { t: 0, r: 0, b: 0, l: 0 },
  };
}

// ── Componente ────────────────────────────────────────────────────────────────

interface Props { result: ModalResult; }

export function LinearModeShapeViewer({ result }: Props) {
  const { viewer, modes_table } = result;
  const { nodes, elements, mode_shapes } = viewer;
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const ref0 = useRef<HTMLDivElement>(null);
  const ref1 = useRef<HTMLDivElement>(null);
  const ref2 = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (typeof Plotly === "undefined") return;

    const panelRefs = [ref0, ref1, ref2];
    const modeKeys  = ["1", "2", "3"];
    const scales    = modeKeys.map((k) => computeScale(nodes, mode_shapes[k] ?? {}));

    const vt = viewer3dTheme(isDark);

    // Initialize panels
    modeKeys.forEach((k, i) => {
      const el = panelRefs[i].current;
      if (!el) return;
      const shapes = mode_shapes[k] ?? {};
      const undeformed = makeUndeformed(nodes, elements);
      // Override the undeformed line color to match theme
      (undeformed as Record<string, unknown>).line = { color: vt.sceneUndeformed, width: 1.5 };
      Plotly.newPlot(
        el,
        [undeformed, makeDeformed(nodes, elements, shapes, scales[i], MODE_COLORS[i])],
        { ...modeLayout(isDark), uirevision: `mode${k}` },
        { responsive: true, displayModeBar: false },
      );
    });

    // Animation loop — only restyle trace 1 (deformed)
    let phase = 0;
    function animate() {
      const sinAmp = Math.sin(phase);
      modeKeys.forEach((k, i) => {
        const el = panelRefs[i].current;
        if (!el) return;
        const shapes = mode_shapes[k] ?? {};
        const sc = scales[i] * sinAmp;
        const x: (number | null)[] = [], y: (number | null)[] = [], z: (number | null)[] = [];
        for (const [ni, nj] of elements) {
          const pi = nodes[String(ni)], pj = nodes[String(nj)];
          const si = shapes[String(ni)] ?? [0, 0, 0];
          const sj = shapes[String(nj)] ?? [0, 0, 0];
          if (!pi || !pj) continue;
          x.push(pi[0] + sc * si[0], pj[0] + sc * sj[0], null);
          y.push(pi[1] + sc * si[1], pj[1] + sc * sj[1], null);
          z.push(pi[2] + sc * si[2], pj[2] + sc * sj[2], null);
        }
        Plotly.restyle(el, { x: [x], y: [y], z: [z] }, [1]);
      });
      phase += 0.04;
      rafRef.current = requestAnimationFrame(animate);
    }
    rafRef.current = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(rafRef.current);
      panelRefs.forEach((r) => { if (r.current) Plotly.purge(r.current); });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, isDark]);

  const panelRefs = [ref0, ref1, ref2];
  const vt = viewer3dTheme(isDark);
  const textMuted = isDark ? "#64748b" : "#94a3b8";
  const textMain  = isDark ? "#e2e8f0" : "#101522";
  const badgeBg   = isDark ? "#1e293b" : "#eef0f5";
  const badgeText = isDark ? "#94a3b8" : "#545b6c";

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {([0, 1, 2] as const).map((i) => {
        const modeNum = i + 1;
        const row     = modes_table[i];
        const color   = MODE_COLORS[i];
        const hasModeData = !!mode_shapes[String(modeNum)];

        return (
          <div key={i} className="flex flex-col gap-2">
            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
                <span className="text-xs font-semibold" style={{ color: textMain }}>
                  Modo {modeNum}
                </span>
                {row && (
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                    style={{ background: badgeBg, color: badgeText }}
                  >
                    {modeLabel(row)}
                  </span>
                )}
              </div>
              {row && (
                <span className="text-[11px] font-mono" style={{ color: textMain }}>
                  {row.T.toFixed(3)} s
                </span>
              )}
            </div>

            {/* 3D Panel */}
            <div
              className="rounded-xl overflow-hidden"
              style={{
                height: 220,
                background: vt.containerBg,
                border: `1px solid ${vt.containerBorder}`,
                boxShadow: vt.containerShadow,
              }}
            >
              {hasModeData ? (
                <div ref={panelRefs[i]} style={{ width: "100%", height: "100%" }} />
              ) : (
                <div className="flex h-full items-center justify-center">
                  <span className="text-xs" style={{ color: textMuted }}>Sin datos</span>
                </div>
              )}
            </div>

            {/* Participación de masa */}
            {row && (
              <div className="flex gap-3 text-[10px] px-0.5" style={{ color: textMuted }}>
                <span>Ux <strong style={{ color: textMain }}>{row.Ux_pct.toFixed(1)}%</strong></span>
                <span>Uy <strong style={{ color: textMain }}>{row.Uy_pct.toFixed(1)}%</strong></span>
                <span>Rz <strong style={{ color: textMain }}>{row.Rz_pct.toFixed(1)}%</strong></span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
