"use client";
/**
 * DriftProfileChart — perfil de deriva en altura por paso del pushover.
 *
 * Lee `data.frames[frameIdx].disp` + `data.element_lines` (para mapear
 * nodos → pisos) + `data.stories_z` y calcula el perfil de deriva de
 * entrepiso.  Se actualiza en vivo al cambiar `frameIdx` desde el visor 3D.
 *
 * Convención: drift_i = (δ_i − δ_{i-1}) / (z_i − z_{i-1}) · 100%.
 * Dirección del pushover decide qué componente del desplazamiento usar.
 */
import { useEffect, useMemo, useRef } from "react";

import type { NLFramePushoverHistory } from "@/lib/structural-types";

interface Props {
  data:        NLFramePushoverHistory;
  frameIdx:    number;
  direction:   string;    // "X" | "Y" | "-X" | "-Y"
  height?:     number;
}

interface ProfilePoint {
  story:     string;
  z_m:       number;
  disp_m:    number;
  drift_pct: number;
}

function computeProfile(data: NLFramePushoverHistory,
                        frameIdx: number,
                        direction: string): ProfilePoint[] {
  const dirIdx = direction.toUpperCase().endsWith("Y") ? 1 : 0;
  const sign   = direction.startsWith("-") ? -1 : 1;
  const frame  = data.frames[frameIdx];
  if (!frame) return [];

  // Mapa nodo → story (del element_lines)
  const nodeToStory: Record<string, string> = {};
  for (const el of data.element_lines ?? []) {
    if (el.node_i != null && el.story) nodeToStory[String(el.node_i)] = el.story;
    if (el.node_j != null && el.story) nodeToStory[String(el.node_j)] = el.story;
  }

  // Promedio de desplazamiento (del CM, aproximado por promedio de nodos del story)
  const sums: Record<string, number> = {};
  const counts: Record<string, number> = {};
  for (const [tag, disp] of Object.entries(frame.disp ?? {})) {
    const story = nodeToStory[tag];
    if (!story || !Array.isArray(disp)) continue;
    sums[story]   = (sums[story]   ?? 0) + sign * (disp[dirIdx] ?? 0);
    counts[story] = (counts[story] ?? 0) + 1;
  }
  const avg: Record<string, number> = {};
  for (const s of Object.keys(sums)) {
    avg[s] = sums[s] / Math.max(counts[s], 1);
  }

  // Ordenar pisos por z ascendente
  const storiesZ = data.stories_z ?? {};
  const stories = Object.entries(storiesZ)
                        .map(([name, z]) => ({ name, z: Number(z) }))
                        .sort((a, b) => a.z - b.z);

  const out: ProfilePoint[] = [];
  for (let i = 0; i < stories.length; i++) {
    const { name, z } = stories[i];
    const disp = avg[name] ?? 0;
    if (i === 0) {
      // Base — asume δ=0 y drift=0 (apoyo fijo)
      out.push({ story: name, z_m: z, disp_m: 0, drift_pct: 0 });
      continue;
    }
    const prev = out[i - 1];
    const dh   = z - prev.z_m;
    const drift = dh > 0 ? ((disp - prev.disp_m) / dh) * 100 : 0;
    out.push({ story: name, z_m: z, disp_m: disp, drift_pct: drift });
  }
  return out;
}

export default function DriftProfileChart({
  data, frameIdx, direction, height = 320,
}: Props) {
  const divRef = useRef<HTMLDivElement>(null);
  const profile = useMemo(
    () => computeProfile(data, frameIdx, direction),
    [data, frameIdx, direction],
  );

  // Rango X estable — máx drift absoluto en TODA la historia (no por frame)
  const xMax = useMemo(() => {
    let m = 0;
    const total = data.frames.length;
    const sample = Math.min(total, 20);  // sub-muestreo para velocidad
    const stride = Math.max(1, Math.floor(total / sample));
    for (let i = 0; i < total; i += stride) {
      const p = computeProfile(data, i, direction);
      for (const pt of p) {
        if (Math.abs(pt.drift_pct) > m) m = Math.abs(pt.drift_pct);
      }
    }
    return Math.max(m * 1.1, 0.5);
  }, [data, direction]);

  useEffect(() => {
    if (!divRef.current || profile.length === 0) return;
    const Plotly = (window as unknown as { Plotly?: {
      newPlot: (...a: unknown[]) => void;
      react:   (...a: unknown[]) => void;
      purge:   (el: Element) => void;
    } }).Plotly;
    if (!Plotly) return;

    const drifts = profile.map(p => p.drift_pct);
    const zs     = profile.map(p => p.z_m);
    const names  = profile.map(p => p.story);

    const traces = [
      {
        type: "scatter", mode: "lines+markers",
        x: drifts, y: zs,
        line: { color: "#2563eb", width: 2 },
        marker: { size: 8, color: "#2563eb",
                   line: { color: "#1d4ed8", width: 1 } },
        hovertemplate: "<b>%{text}</b><br>drift=%{x:.3f}%<br>z=%{y:.2f} m<extra></extra>",
        text: names,
        name: "Deriva de entrepiso",
      },
    ];

    const layout = {
      paper_bgcolor: "transparent",
      plot_bgcolor:  "transparent",
      margin: { t: 10, r: 10, b: 40, l: 55 },
      font:   { size: 11 },
      xaxis: {
        title: { text: "Deriva (%)" },
        gridcolor: "var(--border)",
        range: [0, xMax],
        zeroline: true,
      },
      yaxis: {
        title: { text: "Altura (m)" },
        gridcolor: "var(--border)",
        tickmode: "array",
        tickvals: zs,
        ticktext: names,
      },
      shapes: [
        // Línea de referencia: límite NSR-10 de deriva (1%)
        {
          type: "line",
          x0: 1.0, x1: 1.0, y0: 0, y1: zs[zs.length - 1],
          line: { color: "#f59e0b", width: 1.5, dash: "dash" },
        },
      ],
      annotations: [
        {
          x: 1.0, y: zs[zs.length - 1],
          xanchor: "left", yanchor: "top",
          text: "límite NSR-10 (1%)",
          font: { size: 9, color: "#b45309" },
          showarrow: false,
        },
      ],
      showlegend: false,
    };

    Plotly.react(divRef.current, traces, layout,
                  { responsive: true, displayModeBar: false });
  }, [profile, xMax]);

  if (profile.length === 0) {
    return (
      <div className="flex items-center justify-center pl-glass rounded-xl"
           style={{ height }}>
        <p className="text-xs text-[var(--text-muted)]">
          Sin datos de perfil para este frame.
        </p>
      </div>
    );
  }

  const maxDrift = Math.max(...profile.map(p => Math.abs(p.drift_pct)));

  return (
    <div className="pl-glass rounded-xl p-3">
      <div className="flex items-baseline justify-between mb-2">
        <p className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
          Perfil de deriva · Frame {frameIdx + 1} / {data.frames.length}
        </p>
        <span className="text-[10px] text-[var(--text-muted)] font-mono">
          máx {maxDrift.toFixed(3)}%
        </span>
      </div>
      <div ref={divRef} style={{ height }} />
    </div>
  );
}
