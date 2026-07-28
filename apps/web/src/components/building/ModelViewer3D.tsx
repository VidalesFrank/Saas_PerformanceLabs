"use client";

import { useEffect, useRef, useState } from "react";

interface Joint { global_x: number; global_y: number; global_z: number }
type El = Record<string, unknown>;

interface Props {
  archetypeData?: Record<string, unknown> | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Window { Plotly: any; }
}

type ViewMode = "lines" | "extruded";

export function ModelViewer3D({ archetypeData }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [plotlyReady, setPlotlyReady] = useState(false);
  const [viewMode, setViewMode]       = useState<ViewMode>("lines");
  const [showCols, setShowCols]       = useState(true);
  const [showBeams, setShowBeams]     = useState(true);
  const [showSlabs, setShowSlabs]     = useState(true);
  const [showNodes, setShowNodes]     = useState(false);
  const [activeStories, setActiveStories] = useState<string[]>([]);

  const modelData = archetypeData?.model_data as Record<string, unknown> | undefined;
  const stories   = modelData ? Object.keys(modelData) : [];

  // Sincronizar activeStories cuando llegan nuevos datos
  useEffect(() => {
    if (modelData) setActiveStories(Object.keys(modelData));
  }, [archetypeData]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cargar Plotly desde CDN (evita SSR)
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.Plotly) { setPlotlyReady(true); return; }
    const script = document.createElement("script");
    script.src = "https://cdn.plot.ly/plotly-2.35.2.min.js";
    script.onload = () => setPlotlyReady(true);
    document.head.appendChild(script);
  }, []);

  useEffect(() => {
    if (!plotlyReady || !containerRef.current || !modelData) return;
    renderModel();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plotlyReady, archetypeData, viewMode, showCols, showBeams, showSlabs, showNodes, activeStories]);

  function renderModel() {
    const Plotly = window.Plotly;
    if (!Plotly || !containerRef.current || !modelData) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const traces: any[] = [];

    // Compilar todos los joints del modelo (todos los pisos)
    const allJoints: Record<string, Joint> = {};
    for (const story of Object.keys(modelData)) {
      const s = modelData[story] as Record<string, unknown>;
      if (s.joints_data) {
        Object.entries(s.joints_data as Record<string, Joint>).forEach(([tag, j]) => {
          allJoints[String(Math.round(Number(tag)))] = j;
          allJoints[String(tag)] = j;
        });
      }
    }
    const getJ = (tag: unknown) =>
      allJoints[String(Math.round(Number(tag)))] || allJoints[String(tag)];

    for (const story of activeStories) {
      const s = modelData[story] as Record<string, unknown> | undefined;
      if (!s) continue;

      // ── COLUMNAS ──────────────────────────────────────────────────────────
      if (showCols && s.columns_data) {
        if (viewMode === "lines") {
          const x: (number | null)[] = [], y: (number | null)[] = [], z: (number | null)[] = [];
          Object.values(s.columns_data as Record<string, El>).forEach((col) => {
            const ji = getJ(col.joint_i), jj = getJ(col.joint_j);
            if (ji && jj) {
              x.push(ji.global_x, jj.global_x, null);
              y.push(ji.global_y, jj.global_y, null);
              z.push(ji.global_z, jj.global_z, null);
            }
          });
          if (x.length) traces.push({
            type: "scatter3d", mode: "lines", x, y, z,
            showlegend: false, hoverinfo: "none",
            line: { color: "#54643a", width: 5 },
          });
        } else {
          Object.values(s.columns_data as Record<string, El>).forEach((col) => {
            const ji = getJ(col.joint_i), jj = getJ(col.joint_j);
            if (!ji || !jj) return;
            const geo = col.geometry as Record<string, number> | undefined;
            const b = geo?.base   ?? 0.3;
            const h = geo?.height ?? 0.3;
            const tv = col.geometry_transformation_vector as [number, number, number] | undefined;
            const label = `${col.object_label ?? ""}<br>${col.design_section ?? ""}<br>b=${b}m h=${h}m`;
            traces.push(...makeBox(
              ji.global_x, ji.global_y, ji.global_z,
              jj.global_x, jj.global_y, jj.global_z,
              b, h, tv ?? [0, 1, 0], "#54643a", label,
            ));
          });
        }
      }

      // ── VIGAS ─────────────────────────────────────────────────────────────
      if (showBeams && s.beams_data) {
        if (viewMode === "lines") {
          const x: (number | null)[] = [], y: (number | null)[] = [], z: (number | null)[] = [];
          Object.values(s.beams_data as Record<string, El>).forEach((beam) => {
            const ji = getJ(beam.joint_i), jj = getJ(beam.joint_j);
            if (ji && jj) {
              x.push(ji.global_x, jj.global_x, null);
              y.push(ji.global_y, jj.global_y, null);
              z.push(ji.global_z, jj.global_z, null);
            }
          });
          if (x.length) traces.push({
            type: "scatter3d", mode: "lines", x, y, z,
            showlegend: false, hoverinfo: "none",
            line: { color: "#75b72a", width: 3 },
          });
        } else {
          Object.values(s.beams_data as Record<string, El>).forEach((beam) => {
            const ji = getJ(beam.joint_i), jj = getJ(beam.joint_j);
            if (!ji || !jj) return;
            const geo = beam.geometry as Record<string, number> | undefined;
            const b = geo?.base   ?? 0.3;
            const h = geo?.height ?? 0.4;
            const tv = beam.geometry_transformation_vector as [number, number, number] | undefined;
            const label = `${beam.object_label ?? ""}<br>${beam.design_section ?? ""}<br>b=${b}m h=${h}m`;
            traces.push(...makeBox(
              ji.global_x, ji.global_y, ji.global_z,
              jj.global_x, jj.global_y, jj.global_z,
              b, h, tv ?? [1, 0, 0], "#75b72a", label,
            ));
          });
        }
      }

      // ── LOSAS ─────────────────────────────────────────────────────────────
      if (showSlabs && s.slabs_data) {
        Object.values(s.slabs_data as Record<string, El>).forEach((slab) => {
          const joints = ([slab.joint_1, slab.joint_2, slab.joint_3, slab.joint_4] as unknown[])
            .filter(Boolean).map(getJ).filter(Boolean) as Joint[];
          if (joints.length >= 3) {
            const closed = [...joints, joints[0]];
            traces.push({
              type: "scatter3d", mode: "lines",
              x: closed.map(j => j!.global_x),
              y: closed.map(j => j!.global_y),
              z: closed.map(j => j!.global_z),
              line: { color: "#b7d38a", width: 1 },
              showlegend: false, hoverinfo: "none",
            });
          }
        });
      }

      // ── NODOS ─────────────────────────────────────────────────────────────
      if (showNodes && s.joints_data) {
        const nx: number[] = [], ny: number[] = [], nz: number[] = [], nt: string[] = [];
        Object.entries(s.joints_data as Record<string, Joint>).forEach(([tag, j]) => {
          nx.push(j.global_x); ny.push(j.global_y); nz.push(j.global_z);
          nt.push(`Nodo ${tag}<br>X:${j.global_x} Y:${j.global_y} Z:${j.global_z}`);
        });
        traces.push({
          type: "scatter3d", mode: "markers", x: nx, y: ny, z: nz,
          text: nt, hoverinfo: "text",
          marker: { size: 3, color: "#575756" },
          showlegend: false,
        });
      }
    }

    // Leyenda
    traces.push(
      { type: "scatter3d", mode: "lines", x: [null], y: [null], z: [null], name: "Columnas", line: { color: "#54643a", width: 4 }, showlegend: true },
      { type: "scatter3d", mode: "lines", x: [null], y: [null], z: [null], name: "Vigas",    line: { color: "#75b72a", width: 3 }, showlegend: true },
      { type: "scatter3d", mode: "lines", x: [null], y: [null], z: [null], name: "Losas",    line: { color: "#b7d38a", width: 1 }, showlegend: true },
    );

    Plotly.react(containerRef.current!, traces, {
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor:  "rgba(0,0,0,0)",
      margin: { l: 0, r: 0, t: 10, b: 0 },
      scene: {
        xaxis: { title: "X (m)", gridcolor: "#e8e8e8", zerolinecolor: "#ccc" },
        yaxis: { title: "Y (m)", gridcolor: "#e8e8e8", zerolinecolor: "#ccc" },
        zaxis: { title: "Z (m)", gridcolor: "#e8e8e8", zerolinecolor: "#ccc" },
        bgcolor: "rgba(248,248,247,0.4)",
        aspectmode: "data",
        camera: { eye: { x: 1.6, y: 1.6, z: 1.1 } },
      },
      legend: { x: 0.01, y: 0.99, bgcolor: "rgba(255,255,255,.85)", bordercolor: "#e0e0e0", borderwidth: 1, font: { size: 11 } },
      uirevision: "model",
    }, { responsive: true, displayModeBar: true, displaylogo: false, modeBarButtonsToRemove: ["sendDataToCloud", "select2d", "lasso2d"] });
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Fila de controles */}
      <div className="flex flex-wrap items-center gap-3">

        {/* Toggle líneas / extruido */}
        <div className="flex overflow-hidden rounded-md border border-border text-xs">
          {(["lines", "extruded"] as ViewMode[]).map((m) => (
            <button key={m} type="button" onClick={() => setViewMode(m)}
              className={`px-3 py-1.5 font-medium transition-colors ${
                viewMode === m ? "bg-accent text-white" : "text-text-muted hover:text-text"
              }`}>
              {m === "lines" ? "Líneas" : "Extruido"}
            </button>
          ))}
        </div>

        {/* Visibilidad de elementos */}
        {([
          ["Columnas", showCols,  setShowCols,  "#54643a"],
          ["Vigas",    showBeams, setShowBeams, "#75b72a"],
          ["Losas",    showSlabs, setShowSlabs, "#b7d38a"],
          ["Nodos",    showNodes, setShowNodes, "#575756"],
        ] as const).map(([label, active, setter, color]) => (
          <button key={label} type="button"
            onClick={() => (setter as React.Dispatch<React.SetStateAction<boolean>>)(!active)}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
              active ? "border-accent bg-accent/10 text-accent" : "border-border text-text-muted"
            }`}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: color, display: "inline-block", opacity: active ? 1 : 0.35 }} />
            {label}
          </button>
        ))}

        {/* Filtro de pisos */}
        {stories.length > 0 && (
          <div className="ml-auto flex flex-wrap items-center gap-2 text-xs">
            <span className="text-text-muted">Pisos:</span>
            <button type="button" className="font-semibold text-accent"
              onClick={() => setActiveStories(activeStories.length === stories.length ? [] : [...stories])}>
              {activeStories.length === stories.length ? "Ninguno" : "Todos"}
            </button>
            <div className="flex flex-wrap gap-1">
              {stories.map(s => (
                <button key={s} type="button"
                  onClick={() => setActiveStories(prev =>
                    prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]
                  )}
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium border transition-colors ${
                    activeStories.includes(s) ? "border-accent bg-accent text-white" : "border-border text-text-muted"
                  }`}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Etiqueta de modo */}
      <div className="text-[11px] text-text-muted">
        {viewMode === "extruded"
          ? "Secciones extruidas · dimensiones reales"
          : "Vista de líneas · eje centroidal"}
      </div>

      {/* Contenedor Plotly */}
      <div className="rounded-lg border border-border bg-surface" style={{ height: 580, position: "relative" }}>
        {!plotlyReady && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-text-muted">
            Cargando visor 3D...
          </div>
        )}
        <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      </div>
    </div>
  );
}

// ── Genera un prisma rectangular (mesh3d) para el modo extruido ───────────────
function makeBox(
  x1: number, y1: number, z1: number,
  x2: number, y2: number, z2: number,
  b: number, h: number,
  localY: [number, number, number],
  color: string,
  label: string,
): object[] {
  const ax = x2 - x1, ay = y2 - y1, az = z2 - z1;
  const L  = Math.sqrt(ax * ax + ay * ay + az * az);
  if (L < 1e-6) return [];

  // Eje local X del elemento
  const ex: [number, number, number] = [ax / L, ay / L, az / L];

  // Eje local Y — ortogonalizar respecto a ex (Gram-Schmidt)
  let ey: [number, number, number] = [...(localY ?? [0, 1, 0])];
  const dot = ey[0] * ex[0] + ey[1] * ex[1] + ey[2] * ex[2];
  ey = [ey[0] - dot * ex[0], ey[1] - dot * ex[1], ey[2] - dot * ex[2]];
  const lyLen = Math.sqrt(ey[0] ** 2 + ey[1] ** 2 + ey[2] ** 2);
  if (lyLen < 1e-6) {
    ey = ex[2] < 0.9 ? [0, 0, 1] : [0, 1, 0];
  } else {
    ey = [ey[0] / lyLen, ey[1] / lyLen, ey[2] / lyLen];
  }

  // Eje local Z (producto vectorial)
  const ez: [number, number, number] = [
    ey[1] * ex[2] - ey[2] * ex[1],
    ey[2] * ex[0] - ey[0] * ex[2],
    ey[0] * ex[1] - ey[1] * ex[0],
  ];

  // 8 vértices del prisma (4 en cara i + 4 en cara j)
  const hb = b / 2, hh = h / 2;
  const corners: [number, number][] = [[-hb, -hh], [hb, -hh], [hb, hh], [-hb, hh]];
  const pts = [
    ...corners.map(([u, v]) => [x1 + u * ey[0] + v * ez[0], y1 + u * ey[1] + v * ez[1], z1 + u * ey[2] + v * ez[2]]),
    ...corners.map(([u, v]) => [x2 + u * ey[0] + v * ez[0], y2 + u * ey[1] + v * ez[1], z2 + u * ey[2] + v * ez[2]]),
  ];

  const px = pts.map(p => p[0]), py = pts.map(p => p[1]), pz = pts.map(p => p[2]);

  // Triangulación de las 6 caras del prisma
  const i_ = [0, 0, 1, 1, 2, 2, 3, 3, 0, 0, 1, 2, 4, 4, 5, 6];
  const j_ = [1, 2, 2, 5, 3, 6, 0, 7, 1, 4, 5, 3, 5, 6, 6, 7];
  const k_ = [2, 5, 5, 6, 6, 7, 7, 4, 4, 5, 6, 7, 6, 7, 7, 4];

  return [{
    type: "mesh3d",
    x: px, y: py, z: pz,
    i: i_, j: j_, k: k_,
    color,
    opacity: 0.75,
    flatshading: true,
    hovertext: label,
    hoverinfo: "text",
    showlegend: false,
    lighting:      { ambient: 0.7, diffuse: 0.8, roughness: 0.5, specular: 0.2 },
    lightposition: { x: 1000, y: 1000, z: 2000 },
  }];
}
