"use client";

import { useEffect, useRef, useState } from "react";
import type { ModelGeometry } from "@/lib/structural-types";

// ── Colores ───────────────────────────────────────────────────────────────────
const COLOR_COLUMN = "#54a3ff";
const COLOR_BEAM   = "#34d399";
const COLOR_BASE   = "#f87171";
const COLOR_JOINT  = "#94a3b8";

// ── Construcción de trazas Plotly ────────────────────────────────────────────

function buildTraces(geometry: ModelGeometry) {
  const { joints, frames } = geometry;

  const colX: (number | null)[] = [], colY: (number | null)[] = [], colZ: (number | null)[] = [];
  const beamX: (number | null)[] = [], beamY: (number | null)[] = [], beamZ: (number | null)[] = [];

  for (const fd of Object.values(frames)) {
    const ji = joints[fd.joint_i];
    const jj = joints[fd.joint_j];
    if (!ji || !jj) continue;
    const isCol = fd.element_type === "column";
    const xs = isCol ? colX : beamX;
    const ys = isCol ? colY : beamY;
    const zs = isCol ? colZ : beamZ;
    xs.push(ji.x, jj.x, null);
    ys.push(ji.y, jj.y, null);
    zs.push(ji.z, jj.z, null);
  }

  const baseX: number[] = [], baseY: number[] = [], baseZ: number[] = [];
  const nodeX: number[] = [], nodeY: number[] = [], nodeZ: number[] = [];
  const nodeTxt: string[] = [];

  for (const [lbl, jd] of Object.entries(joints)) {
    if (jd.is_restrained) {
      baseX.push(jd.x); baseY.push(jd.y); baseZ.push(jd.z);
    } else {
      nodeX.push(jd.x); nodeY.push(jd.y); nodeZ.push(jd.z);
      nodeTxt.push(`${lbl} | ${jd.story}<br>x=${jd.x.toFixed(2)} y=${jd.y.toFixed(2)} z=${jd.z.toFixed(2)}`);
    }
  }

  return [
    { type: "scatter3d", mode: "lines", x: colX, y: colY, z: colZ, name: "Columnas",
      line: { color: COLOR_COLUMN, width: 3 }, hoverinfo: "skip" },
    { type: "scatter3d", mode: "lines", x: beamX, y: beamY, z: beamZ, name: "Vigas",
      line: { color: COLOR_BEAM, width: 2 }, hoverinfo: "skip" },
    { type: "scatter3d", mode: "markers", x: nodeX, y: nodeY, z: nodeZ, text: nodeTxt,
      name: "Nodos", marker: { color: COLOR_JOINT, size: 2.5, opacity: 0.7 },
      hovertemplate: "%{text}<extra></extra>" },
    { type: "scatter3d", mode: "markers", x: baseX, y: baseY, z: baseZ, name: "Apoyos",
      marker: { color: COLOR_BASE, size: 5, symbol: "square", opacity: 0.9 }, hoverinfo: "skip" },
  ];
}

function makeLayout() {
  return {
    scene: {
      xaxis: { title: "X (m)", color: "#94a3b8", gridcolor: "#334155", showbackground: false },
      yaxis: { title: "Y (m)", color: "#94a3b8", gridcolor: "#334155", showbackground: false },
      zaxis: { title: "Z (m)", color: "#94a3b8", gridcolor: "#334155", showbackground: false },
      bgcolor: "rgba(0,0,0,0)",
      camera: { eye: { x: 1.6, y: 1.6, z: 0.8 } },
      aspectmode: "data",
    },
    paper_bgcolor: "rgba(0,0,0,0)",
    margin: { t: 0, r: 0, b: 0, l: 0 },
    legend: { x: 0.01, y: 0.99, bgcolor: "rgba(0,0,0,0.3)", font: { color: "#94a3b8", size: 11 } },
    font: { color: "#94a3b8" },
  };
}

function makeConfig() {
  return {
    responsive: true, displayModeBar: true, displaylogo: false,
    modeBarButtonsToRemove: ["toImage", "sendDataToCloud"],
  };
}

// ── Componente ────────────────────────────────────────────────────────────────

interface Props {
  geometry: ModelGeometry;
}

export function LinearModelViewer3D({ geometry }: Props) {
  const containerRef   = useRef<HTMLDivElement>(null);
  const [plotlyReady, setPlotlyReady] = useState(false);
  const [showColumns, setShowColumns] = useState(true);
  const [showBeams, setShowBeams]     = useState(true);
  const [showNodes, setShowNodes]     = useState(false);

  const { n_joints, n_frames, n_stories, stories } = geometry;
  const totalHeight = Object.values(stories).reduce(
    (max, s) => Math.max(max, s.elevation_m), 0
  );

  // Cargar Plotly desde CDN
  useEffect(() => {
    if (typeof window === "undefined") return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((window as any).Plotly) { setPlotlyReady(true); return; }
    const script = document.createElement("script");
    script.src = "https://cdn.plot.ly/plotly-2.35.2.min.js";
    script.onload = () => setPlotlyReady(true);
    document.head.appendChild(script);
  }, []);

  // Renderizar cuando Plotly esté listo o cambie la geometría o toggles
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Plotly = (window as any).Plotly;
    if (!plotlyReady || !containerRef.current || !Plotly) return;
    const el = containerRef.current;

    const traces = buildTraces(geometry);
    const vis = [showColumns, showBeams, showNodes, true];
    const data = traces.map((t, i) => ({ ...t, visible: vis[i] }));

    Plotly.newPlot(el, data, makeLayout(), makeConfig());
    return () => { if (Plotly) Plotly.purge(el); };
  }, [plotlyReady, geometry, showColumns, showBeams, showNodes]);

  function ToggleBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
    return (
      <button
        onClick={onClick}
        className={[
          "px-3 py-1.5 rounded-md text-xs font-medium border transition-colors",
          active
            ? "border-accent bg-accent/10 text-accent"
            : "border-border bg-surface-2 text-text-muted hover:text-text",
        ].join(" ")}
      >
        {children}
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Stats + controles */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex gap-4 text-xs text-text-muted">
          <span><strong className="text-text">{n_stories}</strong> pisos</span>
          <span><strong className="text-text">{n_joints}</strong> nodos</span>
          <span><strong className="text-text">{n_frames}</strong> elementos</span>
          <span><strong className="text-text">{totalHeight.toFixed(1)} m</strong> altura</span>
        </div>
        <div className="flex gap-1.5">
          <ToggleBtn active={showColumns} onClick={() => setShowColumns((v) => !v)}>
            <span style={{ color: COLOR_COLUMN }}>■</span> Columnas
          </ToggleBtn>
          <ToggleBtn active={showBeams} onClick={() => setShowBeams((v) => !v)}>
            <span style={{ color: COLOR_BEAM }}>■</span> Vigas
          </ToggleBtn>
          <ToggleBtn active={showNodes} onClick={() => setShowNodes((v) => !v)}>
            Nodos
          </ToggleBtn>
        </div>
      </div>

      {/* Visor */}
      <div
        className="rounded-lg border border-border bg-surface overflow-hidden"
        style={{ height: Math.min(600, Math.max(380, n_stories * 45 + 120)) }}
      >
        {!plotlyReady ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-text-muted animate-pulse">Cargando visualizador 3D...</p>
          </div>
        ) : (
          <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
        )}
      </div>

      <p className="text-[10px] text-text-muted">
        Arrastra para rotar · Scroll para zoom · Doble clic para resetear vista
      </p>
    </div>
  );
}
