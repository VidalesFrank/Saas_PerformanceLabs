"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { ModelGeometry } from "@/lib/structural-types";
import type { ElementClickInfo, ColorMode, ViewerTypeFilter } from "@/lib/structural-types";
import { useTheme } from "@/lib/theme";
import { viewer3dTheme } from "@/lib/plotly-theme";

// ── Paleta de colores ──────────────────────────────────────────────────────────
const C_COL_LINE = "#818CF8";   // indigo-400  columnas (líneas)
const C_BM_LINE  = "#38BDF8";   // sky-400     vigas (líneas)
const C_COL_EXT  = "#4F46E5";   // indigo-600  columnas extruidas
const C_BM_EXT   = "#0284C7";   // sky-700     vigas extruidas
const C_SUPPORT  = "#FBBF24";   // amber-400   apoyos
const C_NODE     = "#475569";   // slate-600   nodos
const C_SELECT   = "#F59E0B";   // amber-500   selección activa
const C_DIM      = "#334155";   // slate-700   elementos atenuados (no seleccionados)

const SECTION_PALETTE = [
  "#6366F1","#06B6D4","#10B981","#F59E0B","#EF4444",
  "#8B5CF6","#EC4899","#14B8A6","#F97316","#84CC16",
  "#3B82F6","#E11D48","#059669","#D97706","#7C3AED",
  "#0891B2","#65A30D","#DC2626","#7C2D12","#1D4ED8",
];

const STORY_PALETTE = [
  "#818CF8","#6EE7B7","#FCD34D","#F87171","#A78BFA",
  "#34D399","#FBBF24","#F472B6","#60A5FA","#4ADE80",
  "#FB923C","#A3E635","#E879F9","#38BDF8","#FB7185",
];

// ── Helpers geométricos ────────────────────────────────────────────────────────
function parseSectionDims(name: string): { b: number; h: number } {
  // Patrón "AxB" con separador x/X/×: "40x60", "C40X60", "V30x50"
  const m2 = name.match(/(\d+\.?\d*)\s*[xX×]\s*(\d+\.?\d*)/);
  if (m2) {
    const b = parseFloat(m2[1]), h = parseFloat(m2[2]);
    return { b: b / 100, h: h / 100 };   // ETABS usa cm (30x50 → 0.30×0.50 m)
  }
  // Número al final: "C30" → 30 cm, "B450" → 450 mm ≈ 45 cm
  const m1 = name.match(/(\d+\.?\d*)$/);
  if (m1) {
    const v = parseFloat(m1[1]);
    if (v >= 10) return { b: v / 100, h: v / 100 };
  }
  return { b: 0.3, h: 0.3 };
}

type V3 = [number, number, number];
function norm3(v: V3): V3 { const L=Math.sqrt(v[0]**2+v[1]**2+v[2]**2); return L>1e-9?[v[0]/L,v[1]/L,v[2]/L]:[1,0,0]; }
function cross3(a: V3,b: V3): V3 { return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]; }
function localAxes(p0: V3,p1: V3): {ay:V3;az:V3} {
  const ax=norm3([p1[0]-p0[0],p1[1]-p0[1],p1[2]-p0[2]]);
  const up:V3=Math.abs(ax[2])>0.9?[1,0,0]:[0,0,1];
  const ay=norm3(cross3(up,ax)); const az=cross3(ax,ay);
  return {ay,az};
}

function appendBox(p0:V3,p1:V3,b:number,h:number,offset:number,
  vx:number[],vy:number[],vz:number[],vi:number[],vj:number[],vk:number[]) {
  const {ay,az}=localAxes(p0,p1);
  const bh=b/2,hh=h/2;
  const corners:[number,number][]=[[-bh,-hh],[bh,-hh],[bh,hh],[-bh,hh]];
  for(const pt of [p0,p1]) for(const [oy,oz] of corners) {
    vx.push(pt[0]+oy*ay[0]+oz*az[0]);
    vy.push(pt[1]+oy*ay[1]+oz*az[1]);
    vz.push(pt[2]+oy*ay[2]+oz*az[2]);
  }
  vi.push(offset+0,offset+0,offset+4,offset+4);
  vj.push(offset+1,offset+2,offset+5,offset+6);
  vk.push(offset+2,offset+3,offset+6,offset+7);
  for(const [a,b2,c,d] of ([[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]] as [number,number,number,number][])) {
    vi.push(offset+a,offset+a); vj.push(offset+b2,offset+c); vk.push(offset+c,offset+d);
  }
}

const LIGHTING = { ambient:0.55, diffuse:0.9, roughness:0.25, specular:0.65, fresnel:0.2 };
const LIGHTPOS  = { x:2000, y:2000, z:5000 };

// ── Opciones del viewer ────────────────────────────────────────────────────────
export interface ViewerOptions {
  colorMode?: ColorMode;
  storyFilter?: string | null;
  typeFilter?: ViewerTypeFilter;
  isolationMode?: boolean;
  selectedIds?: Set<string>;
  modelSections?: Record<string, { material?: string }>;
  sectionFilter?: string | null;
  materialFilter?: string | null;
}

// ── Construcción de trazas con customdata para selección ───────────────────────

interface TraceGroup {
  xs: (number|null)[];
  ys: (number|null)[];
  zs: (number|null)[];
  customdata: (ElementClickInfo|null)[];
  color: string;
  width: number;
  name: string;
}

function getFrameColor(
  frameId: string,
  fd: { element_type: string; story: string; section: string },
  opts: ViewerOptions,
  allSections: string[],
  allStories: string[],
  selectedIds: Set<string>,
  isExtruded = false,
): string {
  if (selectedIds.has(frameId)) return C_SELECT;
  const { colorMode = "type", isolationMode = false } = opts;
  if (isolationMode && selectedIds.size > 0) return C_DIM;
  if (opts.sectionFilter && fd.section !== opts.sectionFilter) return C_DIM;
  if (opts.materialFilter && opts.modelSections?.[fd.section]?.material !== opts.materialFilter) return C_DIM;

  if (colorMode === "section") {
    const idx = allSections.indexOf(fd.section);
    return SECTION_PALETTE[Math.max(0, idx) % SECTION_PALETTE.length];
  }
  if (colorMode === "story") {
    const idx = allStories.indexOf(fd.story);
    return STORY_PALETTE[Math.max(0, idx) % STORY_PALETTE.length];
  }
  // by type (default) — líneas vs. extruido usan colores distintos para mejor contraste
  if (isExtruded) return fd.element_type === "column" ? C_COL_EXT : C_BM_EXT;
  return fd.element_type === "column" ? C_COL_LINE : C_BM_LINE;
}

function buildLinesInteractive(
  geometry: ModelGeometry,
  opts: ViewerOptions,
): object[] {
  const { joints, frames } = geometry;
  const { storyFilter, typeFilter, isolationMode, selectedIds = new Set() } = opts;

  const allSections = [...new Set(Object.values(frames).map(f => f.section).filter(Boolean))];
  const allStories = Object.keys(geometry.stories).sort(
    (a, b) => (geometry.stories[a]?.elevation_m ?? 0) - (geometry.stories[b]?.elevation_m ?? 0)
  );

  // Agrupar por color para minimizar número de trazas
  const groups = new Map<string, TraceGroup>();

  const getOrCreateGroup = (color: string, name: string, width: number): TraceGroup => {
    if (!groups.has(color)) {
      groups.set(color, { xs: [], ys: [], zs: [], customdata: [], color, width, name });
    }
    return groups.get(color)!;
  };

  for (const [fid, fd] of Object.entries(frames)) {
    const isCol = fd.element_type === "column";
    const isBeam = fd.element_type === "beam";

    if (typeFilter?.columns === false && isCol) continue;
    if (typeFilter?.beams === false && isBeam) continue;
    if (storyFilter && storyFilter !== "all" && fd.story !== storyFilter) continue;
    if (isolationMode && selectedIds.size > 0 && !selectedIds.has(fid)) continue;

    const ji = joints[fd.joint_i];
    const jj = joints[fd.joint_j];
    if (!ji || !jj) continue;

    const color = getFrameColor(fid, fd, opts, allSections, allStories, selectedIds);
    const width = selectedIds.has(fid) ? 6 : (isCol ? 3 : 2);
    const name = isCol ? "Columnas" : "Vigas";
    const grp = getOrCreateGroup(color, name, width);

    const info: ElementClickInfo = {
      id: fid,
      element_type: fd.element_type as "column" | "beam",
      story: fd.story,
      section: fd.section,
      object_label: (fd as { object_label?: string }).object_label,
    };

    grp.xs.push(ji.x, jj.x, null);
    grp.ys.push(ji.y, jj.y, null);
    grp.zs.push(ji.z, jj.z, null);
    grp.customdata.push(info, info, null);
  }

  const hoverTpl =
    "<b>%{customdata.element_type}</b> · %{customdata.id}<br>" +
    "Piso: %{customdata.story}<br>" +
    "Sección: %{customdata.section}" +
    "<extra></extra>";

  return Array.from(groups.values()).map(g => ({
    type: "scatter3d",
    mode: "lines",
    x: g.xs, y: g.ys, z: g.zs,
    customdata: g.customdata,
    name: g.name,
    line: { color: g.color, width: g.width },
    hovertemplate: hoverTpl,
    showlegend: false,
  }));
}

function buildExtrudedInteractive(geometry: ModelGeometry, opts: ViewerOptions): object[] {
  const { joints, frames } = geometry;
  const { storyFilter, typeFilter, isolationMode, selectedIds = new Set() } = opts;
  const allSections = [...new Set(Object.values(frames).map(f => f.section).filter(Boolean))];
  const allStories = Object.keys(geometry.stories).sort(
    (a, b) => (geometry.stories[a]?.elevation_m ?? 0) - (geometry.stories[b]?.elevation_m ?? 0)
  );

  const colsByColor = new Map<string, { vx:number[];vy:number[];vz:number[];vi:number[];vj:number[];vk:number[];n:number }>();
  const bmsByColor  = new Map<string, { vx:number[];vy:number[];vz:number[];vi:number[];vj:number[];vk:number[];n:number }>();

  for (const [fid, fd] of Object.entries(frames)) {
    const isCol = fd.element_type === "column";
    if (typeFilter?.columns === false && isCol) continue;
    if (typeFilter?.beams === false && !isCol) continue;
    if (storyFilter && storyFilter !== "all" && fd.story !== storyFilter) continue;
    if (isolationMode && selectedIds.size > 0 && !selectedIds.has(fid)) continue;

    const ji = joints[fd.joint_i], jj = joints[fd.joint_j];
    if (!ji || !jj) continue;

    const { b, h } = parseSectionDims(fd.section || "");
    const color = getFrameColor(fid, fd, opts, allSections, allStories, selectedIds, true);
    const map = isCol ? colsByColor : bmsByColor;
    if (!map.has(color)) map.set(color, { vx:[],vy:[],vz:[],vi:[],vj:[],vk:[],n:0 });
    const grp = map.get(color)!;
    appendBox([ji.x,ji.y,ji.z],[jj.x,jj.y,jj.z], b, h, grp.n*8, grp.vx,grp.vy,grp.vz,grp.vi,grp.vj,grp.vk);
    grp.n++;
  }

  const traces: object[] = [];
  const mkMesh = (map: typeof colsByColor) => {
    for (const [color, g] of map) {
      if (g.n === 0) continue;
      traces.push({
        type:"mesh3d", x:g.vx,y:g.vy,z:g.vz,i:g.vi,j:g.vj,k:g.vk,
        color, flatshading:true, lighting:LIGHTING, lightposition:LIGHTPOS,
        hovertemplate:"<extra></extra>", showscale:false, opacity:1.0,
        showlegend:false,
      });
    }
  };
  mkMesh(colsByColor);
  mkMesh(bmsByColor);
  return traces;
}

// Trace legendario (un punto por grupo, invisible, solo para la leyenda)
function buildLegendTraces(opts: ViewerOptions): object[] {
  const { colorMode = "type" } = opts;
  if (colorMode === "type") {
    return [
      { type:"scatter3d", mode:"lines", x:[null],y:[null],z:[null], name:"Columnas",
        line:{ color:C_COL_LINE, width:3 }, showlegend:true },
      { type:"scatter3d", mode:"lines", x:[null],y:[null],z:[null], name:"Vigas",
        line:{ color:C_BM_LINE, width:2 }, showlegend:true },
    ];
  }
  return [];
}

function buildSupports(geometry: ModelGeometry): object {
  const sx:number[]=[], sy:number[]=[], sz:number[]=[];
  for (const jd of Object.values(geometry.joints))
    if (jd.is_restrained) { sx.push(jd.x); sy.push(jd.y); sz.push(jd.z); }
  return { type:"scatter3d", mode:"markers", x:sx,y:sy,z:sz, name:"Apoyos",
    marker:{ color:C_SUPPORT, size:6, symbol:"diamond" }, hoverinfo:"skip", showlegend:true };
}

function buildNodes(geometry: ModelGeometry): object {
  const nx:number[]=[], ny:number[]=[], nz:number[]=[], txt:string[]=[];
  for (const [lbl,jd] of Object.entries(geometry.joints)) if (!jd.is_restrained) {
    nx.push(jd.x); ny.push(jd.y); nz.push(jd.z);
    txt.push(`${lbl} | ${jd.story}<br>x=${jd.x.toFixed(2)} y=${jd.y.toFixed(2)} z=${jd.z.toFixed(2)}`);
  }
  return { type:"scatter3d", mode:"markers", x:nx,y:ny,z:nz, text:txt, name:"Nodos",
    marker:{ color:C_NODE, size:2, opacity:0.7 }, hovertemplate:"%{text}<extra></extra>", showlegend:false };
}

function makeLayout(isDark: boolean) {
  const t = viewer3dTheme(isDark);
  const axis = { color:t.axisColor, gridcolor:t.gridColor, zerolinecolor:t.gridColor, showbackground:false };
  return {
    scene: {
      xaxis:{ title:"X (m)", ...axis },
      yaxis:{ title:"Y (m)", ...axis },
      zaxis:{ title:"Z (m)", ...axis },
      bgcolor:"rgba(0,0,0,0)",
      camera:{ eye:{ x:1.6, y:1.6, z:0.8 } },
      aspectmode:"data",
    },
    paper_bgcolor:"rgba(0,0,0,0)",
    plot_bgcolor:"rgba(0,0,0,0)",
    margin:{ t:0, r:0, b:0, l:0 },
    legend:{ x:0.01,y:0.99, bgcolor:t.legendBg, bordercolor:t.legendBorder,
      borderwidth:1, font:{ color:t.axisColor, size:11 } },
    font:{ color:t.axisColor },
    uirevision:"static",
  };
}

// ── Props del componente ───────────────────────────────────────────────────────

type ViewMode = "lines" | "extruded";

interface Props {
  geometry: ModelGeometry;
  // Selección (opcionales — para uso en el editor interactivo)
  selectedIds?: Set<string>;
  onClickElement?: (id: string, info: ElementClickInfo) => void;
  // Filtros y visualización
  colorMode?: ColorMode;
  storyFilter?: string | null;
  typeFilter?: ViewerTypeFilter;
  isolationMode?: boolean;
  modelSections?: Record<string, { material?: string }>;
  // Control del visor desde el padre (si undefined, el componente lo maneja internamente)
  externalViewMode?: ViewMode;
  onViewModeChange?: (mode: ViewMode) => void;
  hideControls?: boolean;   // ocultar controles internos (el padre los muestra)
  height?: number | string;
  sectionFilter?: string | null;
  materialFilter?: string | null;
  zoomBbox?: { xMin: number; xMax: number; yMin: number; yMax: number; zMin: number; zMax: number } | null;
}

// ── Componente ─────────────────────────────────────────────────────────────────

export function LinearModelViewer3D({
  geometry,
  selectedIds = new Set(),
  onClickElement,
  colorMode = "type",
  storyFilter = null,
  typeFilter = { columns: true, beams: true, walls: false, slabs: false },
  isolationMode = false,
  modelSections,
  externalViewMode,
  onViewModeChange,
  hideControls = false,
  height,
  sectionFilter = null,
  materialFilter = null,
  zoomBbox = null,
}: Props) {
  const containerRef    = useRef<HTMLDivElement>(null);
  const prevViewModeRef = useRef<ViewMode | null>(null);  // para detectar cambio de tipo de traza
  const [plotlyReady, setPlotlyReady] = useState(false);
  const [viewModeInternal, setViewModeInternal] = useState<ViewMode>("lines");
  const [showNodes, setShowNodes] = useState(false);
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const viewMode = externalViewMode ?? viewModeInternal;
  const setViewMode = (m: ViewMode) => {
    setViewModeInternal(m);
    onViewModeChange?.(m);
  };

  const { n_joints, n_frames, n_stories, stories } = geometry;
  const totalHeight = Object.values(stories).reduce((mx, s) => Math.max(mx, s.elevation_m), 0);

  // ── Cargar Plotly desde CDN ─────────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((window as any).Plotly) { setPlotlyReady(true); return; }
    const s = document.createElement("script");
    s.src = "https://cdn.plot.ly/plotly-2.35.2.min.js";
    s.onload = () => setPlotlyReady(true);
    document.head.appendChild(s);
  }, []);

  // ── Render Plotly ───────────────────────────────────────────────────────────
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Plotly = (window as any)?.Plotly;
    if (!plotlyReady || !containerRef.current || !Plotly) return;
    const el = containerRef.current;

    const opts: ViewerOptions = { colorMode, storyFilter, typeFilter, isolationMode, selectedIds, modelSections, sectionFilter, materialFilter };
    const dataTraces = viewMode === "lines"
      ? buildLinesInteractive(geometry, opts)
      : buildExtrudedInteractive(geometry, opts);

    const traces = [
      ...buildLegendTraces(opts),
      ...dataTraces,
      buildSupports(geometry),
      ...(showNodes ? [buildNodes(geometry)] : []),
    ];

    const config = {
      responsive: true,
      displayModeBar: true,
      displaylogo: false,
      modeBarButtonsToRemove: ["toImage", "sendDataToCloud"],
    };
    const layout = makeLayout(isDark);

    // Cuando el tipo de traza cambia (líneas ↔ extruido) Plotly.react puede fallar
    // silenciosamente porque el contexto WebGL ya está configurado para el tipo anterior.
    // Solucion: purgar y reinicializar cuando cambia viewMode.
    const modeChanged = prevViewModeRef.current !== viewMode;
    prevViewModeRef.current = viewMode;

    if (modeChanged) {
      try { Plotly.purge(el); } catch { /* silencioso */ }
      Plotly.newPlot(el, traces, layout, config);
    } else {
      Plotly.react(el, traces, layout, config);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plotlyReady, geometry, viewMode, showNodes, isDark, colorMode, storyFilter, typeFilter, isolationMode, selectedIds, sectionFilter, materialFilter, modelSections]);

  // ── Registrar eventos de clic (una sola vez tras plotlyReady) ──────────────
  const onClickRef = useRef(onClickElement);
  onClickRef.current = onClickElement;

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Plotly = (window as any)?.Plotly;
    if (!plotlyReady || !containerRef.current || !Plotly || !onClickElement) return;
    const el = containerRef.current;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (data: any) => {
      const pt = data?.points?.[0];
      if (!pt) return;
      const info = pt.customdata as ElementClickInfo | null;
      if (info?.id) {
        onClickRef.current?.(info.id, info);
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (el as any).on("plotly_click", handler);
    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      try { (el as any).removeAllListeners?.("plotly_click"); } catch { /* silencioso */ }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plotlyReady, onClickElement]);

  // ── Zoom to bounding box ───────────────────────────────────────────────────
  useEffect(() => {
    if (!zoomBbox || !plotlyReady || !containerRef.current) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Plotly = (window as any)?.Plotly;
    if (!Plotly) return;
    const pad = Math.max(
      (zoomBbox.xMax - zoomBbox.xMin) * 0.4,
      (zoomBbox.yMax - zoomBbox.yMin) * 0.4,
      (zoomBbox.zMax - zoomBbox.zMin) * 0.4,
      3,
    );
    Plotly.relayout(containerRef.current, {
      "scene.xaxis.range": [zoomBbox.xMin - pad, zoomBbox.xMax + pad],
      "scene.yaxis.range": [zoomBbox.yMin - pad, zoomBbox.yMax + pad],
      "scene.zaxis.range": [zoomBbox.zMin - pad, zoomBbox.zMax + pad],
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomBbox, plotlyReady]);

  // ── ResizeObserver — detecta cambios de tamaño del contenedor ─────────────
  useEffect(() => {
    if (!plotlyReady || !containerRef.current) return;
    const el = containerRef.current;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Plotly = (window as any)?.Plotly;
    if (!Plotly) return;

    const ro = new ResizeObserver(() => {
      try { Plotly.Plots.resize(el); } catch { /* silencioso */ }
    });
    const parent = el.parentElement;
    if (parent) ro.observe(parent);
    return () => ro.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plotlyReady]);

  // ── Cleanup al desmontar ───────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Plotly = (window as any)?.Plotly;
      if (containerRef.current && Plotly) {
        try { Plotly.purge(containerRef.current); } catch { /* silencioso */ }
      }
    };
  }, []);

  const vt = viewer3dTheme(isDark);
  const btnBase = "px-3 py-1 text-xs font-medium transition-colors";
  const btnOn   = "bg-indigo-500/25 text-indigo-300 border-indigo-500/60";
  const btnOff  = isDark
    ? "bg-slate-800/60 text-slate-400 border-slate-700 hover:text-slate-200 hover:border-slate-500"
    : "bg-white/60 text-slate-500 border-slate-300 hover:text-slate-700 hover:border-slate-400";

  const viewerHeight = height ?? Math.min(620, Math.max(380, n_stories * 48 + 120));

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* ── Stats + controles ─────────────────────────────────────────────── */}
      {!hideControls && (
        <div className="flex items-center justify-between flex-wrap gap-2 flex-shrink-0">
          <div className="flex gap-4 text-xs" style={{ color: vt.axisColor }}>
            <span><strong style={{ color: isDark ? "#e2e8f0" : "#1e293b" }}>{n_stories}</strong> pisos</span>
            <span><strong style={{ color: isDark ? "#e2e8f0" : "#1e293b" }}>{n_joints}</strong> nodos</span>
            <span><strong style={{ color: isDark ? "#e2e8f0" : "#1e293b" }}>{n_frames}</strong> frames</span>
            <span><strong style={{ color: isDark ? "#e2e8f0" : "#1e293b" }}>{totalHeight.toFixed(1)} m</strong></span>
          </div>
          <div className="flex gap-2 items-center">
            <div className="flex rounded-lg overflow-hidden" style={{ border:`1px solid ${vt.containerBorder}` }}>
              <button onClick={() => setViewMode("lines")}
                className={`${btnBase} rounded-l-lg ${viewMode==="lines"?btnOn:btnOff}`}
                style={{ borderRight:`1px solid ${vt.containerBorder}` }}>
                Líneas
              </button>
              <button onClick={() => setViewMode("extruded")}
                className={`${btnBase} rounded-r-lg ${viewMode==="extruded"?btnOn:btnOff}`}>
                Extruido
              </button>
            </div>
            <button onClick={() => setShowNodes(v=>!v)}
              className={`${btnBase} border rounded-lg ${showNodes?btnOn:btnOff}`}>
              Nodos
            </button>
          </div>
        </div>
      )}

      {/* ── Viewport 3D ───────────────────────────────────────────────────── */}
      <div className="rounded-xl overflow-hidden flex-1 min-h-0"
        style={{
          height: hideControls ? undefined : viewerHeight,
          background: vt.containerBg,
          boxShadow: vt.containerShadow,
          border: `1px solid ${vt.containerBorder}`,
          cursor: onClickElement ? "crosshair" : "default",
        }}
      >
        {!plotlyReady ? (
          <div className="flex h-full items-center justify-center">
            <span className="text-sm animate-pulse" style={{ color:vt.axisColor }}>
              Cargando visualizador 3D…
            </span>
          </div>
        ) : (
          <div ref={containerRef} style={{ width:"100%", height:"100%" }} />
        )}
      </div>

      {/* ── Leyenda inferior ──────────────────────────────────────────────── */}
      {!hideControls && (
        <div className="flex items-center gap-4 text-[11px] flex-shrink-0" style={{ color:vt.axisColor }}>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-4 h-[2px] rounded" style={{ background:C_COL_LINE }}/>
            Columnas
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-4 h-[2px] rounded" style={{ background:C_BM_LINE }}/>
            Vigas
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-2 h-2 rounded-sm rotate-45" style={{ background:C_SUPPORT }}/>
            Apoyos
          </span>
          {selectedIds.size > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-4 h-[3px] rounded" style={{ background:C_SELECT }}/>
              Seleccionados ({selectedIds.size})
            </span>
          )}
          <span className="ml-auto text-[10px]" style={{ color:vt.gridColor }}>
            Clic para seleccionar · Arrastra · Scroll · Doble clic para reset
          </span>
        </div>
      )}
    </div>
  );
}
