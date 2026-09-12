"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import type { ModelGeometry } from "@/lib/structural-types";
import type { ElementClickInfo, ColorMode, ViewerTypeFilter } from "@/lib/structural-types";
import { useTheme } from "@/lib/theme";
import { viewer3dTheme } from "@/lib/plotly-theme";

// ── Paleta de colores ──────────────────────────────────────────────────────────
const C_COL_LINE  = "#818CF8";
const C_BM_LINE   = "#38BDF8";
const C_SUPPORT   = "#FBBF24";
const C_NODE      = "#475569";
const C_SELECT    = "#F59E0B";
const C_DIM       = "#334155";
const C_COL_EXT   = "#4F46E5";
const C_BM_EXT    = "#0284C7";

const SECTION_PALETTE = [
  "#6366F1","#06B6D4","#10B981","#F59E0B","#EF4444",
  "#8B5CF6","#EC4899","#14B8A6","#F97316","#84CC16",
  "#3B82F6","#E11D48","#059669","#D97706","#7C3AED",
  "#0891B2","#65A30D","#DC2626","#7C2D12","#1D4ED8",
];

const PIER_PALETTE = [
  "#34D399","#F472B6","#FBBF24","#60A5FA","#A78BFA",
  "#FB923C","#4ADE80","#E879F9","#38BDF8","#FDE68A",
  "#6EE7B7","#F9A8D4","#FCD34D","#93C5FD","#C4B5FD",
  "#86EFAC","#FDA4AF","#FDE047","#BAE6FD","#DDD6FE",
  "#5EEAD4","#FB7185","#D9F99D","#7DD3FC","#E9D5FF",
];

const STORY_PALETTE = [
  "#818CF8","#6EE7B7","#FCD34D","#F87171","#A78BFA",
  "#34D399","#FBBF24","#F472B6","#60A5FA","#4ADE80",
  "#FB923C","#A3E635","#E879F9","#38BDF8","#FB7185",
];

// ── Proyección 2D ──────────────────────────────────────────────────────────────
type Projection = "xy" | "xz" | "yz";

function proj2d(jx: number, jy: number, jz: number, p: Projection): [number, number] {
  if (p === "xy") return [jx, jy];
  if (p === "xz") return [jx, jz];
  return [jy, jz];
}

// ── Helpers geométricos (3D extruido) ─────────────────────────────────────────
function parseSectionDims(name: string): { b: number; h: number } {
  const m2 = name.match(/(\d+\.?\d*)\s*[xX×]\s*(\d+\.?\d*)/);
  if (m2) {
    let b = parseFloat(m2[1]), h = parseFloat(m2[2]);
    if (b >= 2) b /= 100;
    if (h >= 2) h /= 100;
    return { b, h };
  }
  const m1 = name.match(/(\d+\.?\d*)$/);
  if (m1) {
    let v = parseFloat(m1[1]);
    if (v >= 10) v /= 100;
    return { b: v, h: v };
  }
  return { b: 0.3, h: 0.3 };
}

type V3 = [number, number, number];
function norm3(v: V3): V3 { const L=Math.sqrt(v[0]**2+v[1]**2+v[2]**2); return L>1e-9?[v[0]/L,v[1]/L,v[2]/L]:[1,0,0]; }
function cross3(a: V3, b: V3): V3 { return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]; }
function localAxes(p0: V3, p1: V3): { ay: V3; az: V3 } {
  const ax = norm3([p1[0]-p0[0],p1[1]-p0[1],p1[2]-p0[2]]);
  const up: V3 = Math.abs(ax[2]) > 0.9 ? [1,0,0] : [0,0,1];
  const ay = norm3(cross3(up, ax)); const az = cross3(ax, ay);
  return { ay, az };
}

function appendBox(p0:V3,p1:V3,b:number,h:number,offset:number,
  vx:number[],vy:number[],vz:number[],vi:number[],vj:number[],vk:number[]) {
  const { ay, az } = localAxes(p0, p1);
  const bh = b/2, hh = h/2;
  const corners: [number, number][] = [[-bh,-hh],[bh,-hh],[bh,hh],[-bh,hh]];
  for (const pt of [p0, p1]) for (const [oy, oz] of corners) {
    vx.push(pt[0]+oy*ay[0]+oz*az[0]);
    vy.push(pt[1]+oy*ay[1]+oz*az[1]);
    vz.push(pt[2]+oy*ay[2]+oz*az[2]);
  }
  vi.push(offset+0,offset+0,offset+4,offset+4);
  vj.push(offset+1,offset+2,offset+5,offset+6);
  vk.push(offset+2,offset+3,offset+6,offset+7);
  for (const [a,b2,c,d] of [[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]] as [number,number,number,number][]) {
    vi.push(offset+a,offset+a); vj.push(offset+b2,offset+c); vk.push(offset+c,offset+d);
  }
}

const LIGHTING = { ambient:0.55, diffuse:0.9, roughness:0.25, specular:0.65, fresnel:0.2 };
const LIGHTPOS  = { x:2000, y:2000, z:5000 };

// ── Opciones del viewer ────────────────────────────────────────────────────────
export interface ViewerOptions {
  colorMode?: ColorMode;
  storyFilter?: string | null;
  pierFilter?: string | null;
  typeFilter?: ViewerTypeFilter;
  isolationMode?: boolean;
  selectedIds?: Set<string>;
  modelSections?: Record<string, { material?: string }>;
  sectionFilter?: string | null;
  materialFilter?: string | null;
  wallColor?: string;
  slabColor?: string;
  shellLoads?: Record<string, Record<string, number>>;
  shellLoadPattern?: string | null;
}

// ── Helpers de color ───────────────────────────────────────────────────────────
function _wallPierColor(pier: string, allPiers: string[]): string {
  return PIER_PALETTE[Math.max(0, allPiers.indexOf(pier)) % PIER_PALETTE.length];
}

function _wallPiersSorted(geometry: ModelGeometry): string[] {
  const piers = new Set<string>();
  for (const sd of Object.values(geometry.shells ?? {}))
    if (sd.element_type === "wall") piers.add(sd.pier || "(sin pier)");
  return [...piers].sort();
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
  if (isExtruded) return fd.element_type === "column" ? C_COL_EXT : C_BM_EXT;
  return fd.element_type === "column" ? C_COL_LINE : C_BM_LINE;
}

// ══════════════════════════════════════════════════════════════════════════════
// TRAZAS 3D
// ══════════════════════════════════════════════════════════════════════════════

interface TraceGroup {
  xs: (number|null)[]; ys: (number|null)[]; zs: (number|null)[];
  customdata: (ElementClickInfo|null)[];
  color: string; width: number; name: string;
}

function buildLinesInteractive(geometry: ModelGeometry, opts: ViewerOptions): object[] {
  const { joints, frames } = geometry;
  const { storyFilter, typeFilter, isolationMode, selectedIds = new Set() } = opts;
  const allSections = [...new Set(Object.values(frames).map(f => f.section).filter(Boolean))];
  const allStories = Object.keys(geometry.stories).sort(
    (a, b) => (geometry.stories[a]?.elevation_m ?? 0) - (geometry.stories[b]?.elevation_m ?? 0)
  );
  const groups = new Map<string, TraceGroup>();
  const getGroup = (color: string, name: string, width: number) => {
    if (!groups.has(color)) groups.set(color, { xs:[], ys:[], zs:[], customdata:[], color, width, name });
    return groups.get(color)!;
  };

  for (const [fid, fd] of Object.entries(frames)) {
    const isCol = fd.element_type === "column";
    if (typeFilter?.columns === false && isCol) continue;
    if (typeFilter?.beams === false && !isCol) continue;
    if (storyFilter && storyFilter !== "all" && fd.story !== storyFilter) continue;
    if (isolationMode && selectedIds.size > 0 && !selectedIds.has(fid)) continue;
    const ji = joints[fd.joint_i], jj = joints[fd.joint_j];
    if (!ji || !jj) continue;
    const color = getFrameColor(fid, fd, opts, allSections, allStories, selectedIds);
    const width = selectedIds.has(fid) ? 6 : (isCol ? 3 : 2);
    const grp = getGroup(color, isCol ? "Columnas" : "Vigas", width);
    const info: ElementClickInfo = { id:fid, element_type:fd.element_type as "column"|"beam",
      story:fd.story, section:fd.section, object_label:(fd as {object_label?:string}).object_label };
    grp.xs.push(ji.x, jj.x, null); grp.ys.push(ji.y, jj.y, null); grp.zs.push(ji.z, jj.z, null);
    grp.customdata.push(info, info, null);
  }
  const hoverTpl = "<b>%{customdata.element_type}</b> · %{customdata.id}<br>Piso: %{customdata.story}<br>Sección: %{customdata.section}<extra></extra>";
  return Array.from(groups.values()).map(g => ({
    type:"scatter3d", mode:"lines", x:g.xs, y:g.ys, z:g.zs,
    customdata:g.customdata, name:g.name, line:{ color:g.color, width:g.width },
    hovertemplate:hoverTpl, showlegend:false,
  }));
}

function buildExtrudedInteractive(geometry: ModelGeometry, opts: ViewerOptions): object[] {
  const { joints, frames } = geometry;
  const { storyFilter, typeFilter, isolationMode, selectedIds = new Set() } = opts;
  const allSections = [...new Set(Object.values(frames).map(f => f.section).filter(Boolean))];
  const allStories = Object.keys(geometry.stories).sort(
    (a, b) => (geometry.stories[a]?.elevation_m ?? 0) - (geometry.stories[b]?.elevation_m ?? 0)
  );
  const colsByColor = new Map<string, {vx:number[];vy:number[];vz:number[];vi:number[];vj:number[];vk:number[];n:number}>();
  const bmsByColor  = new Map<string, {vx:number[];vy:number[];vz:number[];vi:number[];vj:number[];vk:number[];n:number}>();

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
  for (const map of [colsByColor, bmsByColor]) {
    for (const [color, g] of map) {
      if (g.n === 0) continue;
      traces.push({ type:"mesh3d", x:g.vx,y:g.vy,z:g.vz,i:g.vi,j:g.vj,k:g.vk,
        color, flatshading:true, lighting:LIGHTING, lightposition:LIGHTPOS,
        hovertemplate:"<extra></extra>", showscale:false, opacity:1.0, showlegend:false });
    }
  }
  return traces;
}

function buildWallsLines(geometry: ModelGeometry, opts: ViewerOptions): object[] {
  const { shells, joints } = geometry;
  if (!shells || opts.typeFilter?.walls === false) return [];
  const allPiers = _wallPiersSorted(geometry);
  type WBuf = { xs:(number|null)[]; ys:(number|null)[]; zs:(number|null)[]; cd:(ElementClickInfo|null)[] };
  const groups = new Map<string, WBuf>();
  for (const [shellId, sd] of Object.entries(shells)) {
    if (sd.element_type !== "wall") continue;
    if (opts.storyFilter && opts.storyFilter !== "all" && sd.story !== opts.storyFilter) continue;
    const pier = sd.pier || "(sin pier)";
    if (opts.pierFilter && pier !== opts.pierFilter) continue;
    const corners = sd.joints.map(jl => joints[jl]).filter(Boolean);
    if (corners.length < 3) continue;
    if (!groups.has(pier)) groups.set(pier, { xs:[], ys:[], zs:[], cd:[] });
    const g = groups.get(pier)!;
    const info: ElementClickInfo = { id:shellId, element_type:"wall", story:sd.story||"", section:sd.section||"" };
    for (const c of corners) { g.xs.push(c.x); g.ys.push(c.y); g.zs.push(c.z); g.cd.push(info); }
    g.xs.push(corners[0].x, null); g.ys.push(corners[0].y, null); g.zs.push(corners[0].z, null); g.cd.push(info, null);
  }
  return [...groups.entries()].map(([pier, g]) => ({
    type:"scatter3d", mode:"lines", x:g.xs, y:g.ys, z:g.zs, customdata:g.cd, name:pier,
    line:{ color: opts.wallColor ?? _wallPierColor(pier, allPiers), width:1.5 },
    hovertemplate:`<b>Muro</b> %{customdata.id}<br>Piso: %{customdata.story}<extra></extra>`, showlegend:false,
  }));
}

function buildWallPanels(geometry: ModelGeometry, opts: ViewerOptions): object[] {
  const { shells, joints } = geometry;
  if (!shells || opts.typeFilter?.walls === false) return [];
  const allPiers = _wallPiersSorted(geometry);
  type MBuf = { vx:number[];vy:number[];vz:number[];vi:number[];vj:number[];vk:number[];cd:(ElementClickInfo|null)[];n:number };
  const groups = new Map<string, MBuf>();
  for (const [shellId, sd] of Object.entries(shells)) {
    if (sd.element_type !== "wall") continue;
    if (opts.storyFilter && opts.storyFilter !== "all" && sd.story !== opts.storyFilter) continue;
    const pier = sd.pier || "(sin pier)";
    if (opts.pierFilter && pier !== opts.pierFilter) continue;
    const corners = sd.joints.map(jl => joints[jl]).filter(Boolean);
    if (corners.length < 3) continue;
    if (!groups.has(pier)) groups.set(pier, { vx:[],vy:[],vz:[],vi:[],vj:[],vk:[],cd:[],n:0 });
    const g = groups.get(pier)!;
    const info: ElementClickInfo = { id:shellId, element_type:"wall", story:sd.story||"", section:sd.section||"" };
    for (const c of corners) { g.vx.push(c.x); g.vy.push(c.y); g.vz.push(c.z); g.cd.push(info); }
    for (let i = 1; i < corners.length - 1; i++) { g.vi.push(g.n); g.vj.push(g.n+i); g.vk.push(g.n+i+1); }
    g.n += corners.length;
  }
  return [...groups.entries()].filter(([,g]) => g.n > 0).map(([pier, g]) => ({
    type:"mesh3d", x:g.vx,y:g.vy,z:g.vz,i:g.vi,j:g.vj,k:g.vk, customdata:g.cd,
    color: opts.wallColor ?? _wallPierColor(pier, allPiers),
    flatshading:true, lighting:LIGHTING, lightposition:LIGHTPOS, opacity:0.85,
    hovertemplate:`<b>%{customdata.id}</b><br>Piso: %{customdata.story}<extra></extra>`, showlegend:false,
  }));
}

function buildSlabsLines(geometry: ModelGeometry, opts: ViewerOptions): object[] {
  const { shells, joints } = geometry;
  if (!shells || opts.typeFilter?.slabs === false) return [];
  const slabColor = opts.slabColor ?? "#F59E0B";
  type SBuf = { xs:(number|null)[]; ys:(number|null)[]; zs:(number|null)[]; cd:(ElementClickInfo|null)[] };
  const groups = new Map<string, SBuf>();
  for (const [shellId, sd] of Object.entries(shells)) {
    if (sd.element_type !== "slab") continue;
    if (opts.storyFilter && opts.storyFilter !== "all" && sd.story !== opts.storyFilter) continue;
    const corners = sd.joints.map(jl => joints[jl]).filter(Boolean);
    if (corners.length < 3) continue;
    const story = sd.story || "(sin piso)";
    if (!groups.has(story)) groups.set(story, { xs:[], ys:[], zs:[], cd:[] });
    const g = groups.get(story)!;
    const info: ElementClickInfo = { id:shellId, element_type:"slab", story:sd.story||"", section:sd.section||"" };
    for (const c of corners) { g.xs.push(c.x); g.ys.push(c.y); g.zs.push(c.z); g.cd.push(info); }
    g.xs.push(corners[0].x, null); g.ys.push(corners[0].y, null); g.zs.push(corners[0].z, null); g.cd.push(info, null);
  }
  return [...groups.entries()].map(([story, g]) => ({
    type:"scatter3d", mode:"lines", x:g.xs, y:g.ys, z:g.zs, customdata:g.cd, name:`Losas ${story}`,
    line:{ color:slabColor, width:1 },
    hovertemplate:`<b>Losa</b> %{customdata.id}<br>Piso: %{customdata.story}<extra></extra>`, showlegend:false,
  }));
}

// Losas extruidas: prisma con caras top, bottom y laterales.
// El espesor viene de thickness_m del shell (fallback 0.15 m para visibilidad).
// Se agrupa por piso para reducir el número de traces mesh3d.
function buildSlabsPanels(geometry: ModelGeometry, opts: ViewerOptions): object[] {
  const { shells, joints } = geometry;
  if (!shells || opts.typeFilter?.slabs === false) return [];
  const slabColor = opts.slabColor ?? "#F59E0B";

  type MBuf = {
    vx:number[]; vy:number[]; vz:number[];
    vi:number[]; vj:number[]; vk:number[];
    cd:(ElementClickInfo|null)[]; n:number;
  };
  const groups = new Map<string, MBuf>();

  for (const [shellId, sd] of Object.entries(shells)) {
    if (sd.element_type !== "slab") continue;
    if (opts.storyFilter && opts.storyFilter !== "all" && sd.story !== opts.storyFilter) continue;
    const corners = sd.joints.map(jl => joints[jl]).filter(Boolean);
    if (corners.length < 3) continue;

    const story = sd.story || "(sin piso)";
    if (!groups.has(story)) groups.set(story, { vx:[],vy:[],vz:[],vi:[],vj:[],vk:[],cd:[],n:0 });
    const g = groups.get(story)!;
    const info: ElementClickInfo = {
      id:shellId, element_type:"slab", story:sd.story||"", section:sd.section||"",
    };

    // Espesor: usa thickness_m si viene, con mínimo para visibilidad
    const t    = Math.max((sd.thickness_m ?? 0.15) || 0.15, 0.05);
    const half = t / 2;
    const nC   = corners.length;
    const base = g.n;

    // Vertices: primero top (z + half), luego bottom (z - half)
    for (const c of corners) { g.vx.push(c.x); g.vy.push(c.y); g.vz.push(c.z + half); g.cd.push(info); }
    for (const c of corners) { g.vx.push(c.x); g.vy.push(c.y); g.vz.push(c.z - half); g.cd.push(info); }

    // Cara superior (fan triangulation) — orden CCW ya garantizado por backend
    for (let i = 1; i < nC - 1; i++) {
      g.vi.push(base);       g.vj.push(base + i);       g.vk.push(base + i + 1);
    }
    // Cara inferior (fan invertido para que la normal apunte hacia abajo)
    for (let i = 1; i < nC - 1; i++) {
      g.vi.push(base + nC);  g.vj.push(base + nC + i + 1); g.vk.push(base + nC + i);
    }
    // Caras laterales: por cada arista, 2 triángulos (top→bot)
    for (let i = 0; i < nC; i++) {
      const i1 = i;
      const i2 = (i + 1) % nC;
      g.vi.push(base + i1);       g.vj.push(base + i2);       g.vk.push(base + nC + i1);
      g.vi.push(base + i2);       g.vj.push(base + nC + i2);  g.vk.push(base + nC + i1);
    }

    g.n += 2 * nC;
  }

  return [...groups.entries()].filter(([,g]) => g.n > 0).map(([story, g]) => ({
    type:"mesh3d", x:g.vx, y:g.vy, z:g.vz, i:g.vi, j:g.vj, k:g.vk, customdata:g.cd,
    color: slabColor,
    flatshading:true, lighting:LIGHTING, lightposition:LIGHTPOS, opacity:0.85,
    name:`Losas ${story}`,
    hovertemplate:`<b>Losa</b> %{customdata.id}<br>Piso: %{customdata.story}<br>Sección: %{customdata.section}<extra></extra>`,
    showlegend:false,
  }));
}

// Overlay de picking universal: markers casi invisibles en el centroide de cada
// shell. Necesario porque mesh3d de Plotly NO emite plotly_click. Estos markers
// scatter3d sí son pickables en cualquier modo y llevan el customdata correcto.
function buildShellsPickerOverlay(geometry: ModelGeometry, opts: ViewerOptions): object | null {
  const { shells, joints } = geometry;
  if (!shells) return null;
  const xs:number[]=[], ys:number[]=[], zs:number[]=[], cd:ElementClickInfo[]=[];

  for (const [shellId, sd] of Object.entries(shells)) {
    if (opts.storyFilter && opts.storyFilter !== "all" && sd.story !== opts.storyFilter) continue;
    if (sd.element_type === "slab" && opts.typeFilter?.slabs === false) continue;
    if (sd.element_type === "wall" && opts.typeFilter?.walls === false) continue;

    const corners = sd.joints.map(jl => joints[jl]).filter(Boolean);
    if (corners.length === 0) continue;

    let cx=0, cy=0, cz=0;
    for (const c of corners) { cx += c.x; cy += c.y; cz += c.z; }
    cx /= corners.length; cy /= corners.length; cz /= corners.length;

    xs.push(cx); ys.push(cy); zs.push(cz);
    cd.push({
      id: shellId,
      element_type: sd.element_type,
      story: sd.story || "",
      section: sd.section || "",
    });
  }

  if (xs.length === 0) return null;
  return {
    type: "scatter3d", mode: "markers", x: xs, y: ys, z: zs, customdata: cd,
    marker: { size: 10, color: "rgba(0,0,0,0)", opacity: 0.01 },
    hoverinfo: "skip", showlegend: false, name: "__shell_pickers",
  };
}

function buildSupports3D(geometry: ModelGeometry): object {
  const sx:number[]=[], sy:number[]=[], sz:number[]=[];
  for (const jd of Object.values(geometry.joints))
    if (jd.is_restrained) { sx.push(jd.x); sy.push(jd.y); sz.push(jd.z); }
  return { type:"scatter3d", mode:"markers", x:sx,y:sy,z:sz, name:"Apoyos",
    marker:{ color:C_SUPPORT, size:6, symbol:"diamond" }, hoverinfo:"skip", showlegend:true };
}

function buildNodes3D(geometry: ModelGeometry): object {
  const nx:number[]=[], ny:number[]=[], nz:number[]=[], txt:string[]=[];
  for (const [lbl,jd] of Object.entries(geometry.joints)) if (!jd.is_restrained) {
    nx.push(jd.x); ny.push(jd.y); nz.push(jd.z);
    txt.push(`${lbl} | ${jd.story}<br>x=${jd.x.toFixed(2)} y=${jd.y.toFixed(2)} z=${jd.z.toFixed(2)}`);
  }
  return { type:"scatter3d", mode:"markers", x:nx,y:ny,z:nz, text:txt, name:"Nodos",
    marker:{ color:C_NODE, size:2, opacity:0.7 }, hovertemplate:"%{text}<extra></extra>", showlegend:false };
}

function buildLegendTraces(opts: ViewerOptions): object[] {
  if ((opts.colorMode ?? "type") !== "type") return [];
  return [
    { type:"scatter3d", mode:"lines", x:[null],y:[null],z:[null], name:"Columnas",
      line:{ color:C_COL_LINE, width:3 }, showlegend:true },
    { type:"scatter3d", mode:"lines", x:[null],y:[null],z:[null], name:"Vigas",
      line:{ color:C_BM_LINE, width:2 }, showlegend:true },
  ];
}

function buildLoadArrows(geometry: ModelGeometry, totalHeight: number): object[] {
  const masses = geometry.masses;
  if (!masses || Object.keys(masses).length === 0) return [];
  const massValues = Object.values(masses).map(m => m.mass_x_t);
  const maxMass = Math.max(...massValues, 1e-9);
  const baseLen = Math.max(totalHeight * 0.10, 1.5);
  const xs:number[]=[], ys:number[]=[], zs:number[]=[], us:number[]=[], vs:number[]=[], ws:number[]=[], labels:string[]=[];
  for (const md of Object.values(masses)) {
    const len = Math.max(baseLen * md.mass_x_t / maxMass, baseLen * 0.25);
    xs.push(md.x_cm_m); ys.push(md.y_cm_m); zs.push(md.z_m);
    us.push(0); vs.push(0); ws.push(-len);
    labels.push(`<b>${md.story}</b><br>W = ${Math.round(md.mass_x_t*9.81)} kN<br>m = ${md.mass_x_t.toFixed(1)} t<extra></extra>`);
  }
  return [{ type:"cone", x:xs,y:ys,z:zs, u:us,v:vs,w:ws, anchor:"tip",
    sizemode:"absolute", sizeref:baseLen*0.9,
    colorscale:[[0,"#3B82F6"],[1,"#60A5FA"]], cmin:0, cmax:maxMass, color:massValues,
    showscale:false, opacity:0.82, hovertemplate:labels, name:"Cargas", showlegend:true }];
}

// ══════════════════════════════════════════════════════════════════════════════
// TRAZAS 2D  (planta / elevación) — scatter puro, sin rotación
// ══════════════════════════════════════════════════════════════════════════════

function build2DFrames(geometry: ModelGeometry, opts: ViewerOptions, p: Projection): object[] {
  const { joints, frames } = geometry;
  const { storyFilter, typeFilter, isolationMode, selectedIds = new Set() } = opts;
  const allSections = [...new Set(Object.values(frames).map(f => f.section).filter(Boolean))];
  const allStories = Object.keys(geometry.stories).sort(
    (a, b) => (geometry.stories[a]?.elevation_m ?? 0) - (geometry.stories[b]?.elevation_m ?? 0)
  );

  type G2 = { xs:(number|null)[]; ys:(number|null)[]; cd:(ElementClickInfo|null)[]; color:string; width:number };
  const groups = new Map<string, G2>();
  const getGrp = (color: string, width: number): G2 => {
    if (!groups.has(color)) groups.set(color, { xs:[], ys:[], cd:[], color, width });
    return groups.get(color)!;
  };

  for (const [fid, fd] of Object.entries(frames)) {
    const isCol = fd.element_type === "column";
    if (typeFilter?.columns === false && isCol) continue;
    if (typeFilter?.beams === false && !isCol) continue;
    if (storyFilter && storyFilter !== "all" && fd.story !== storyFilter) continue;
    if (isolationMode && selectedIds.size > 0 && !selectedIds.has(fid)) continue;
    const ji = joints[fd.joint_i], jj = joints[fd.joint_j];
    if (!ji || !jj) continue;
    const color = getFrameColor(fid, fd, opts, allSections, allStories, selectedIds);
    const width = selectedIds.has(fid) ? 4 : (isCol ? 2.5 : 1.5);
    const grp = getGrp(color, width);
    const [x1, y1] = proj2d(ji.x, ji.y, ji.z, p);
    const [x2, y2] = proj2d(jj.x, jj.y, jj.z, p);
    const info: ElementClickInfo = { id:fid, element_type:fd.element_type as "column"|"beam",
      story:fd.story, section:fd.section, object_label:(fd as {object_label?:string}).object_label };
    grp.xs.push(x1, x2, null); grp.ys.push(y1, y2, null); grp.cd.push(info, info, null);
  }

  const hoverTpl = "<b>%{customdata.element_type}</b> · %{customdata.id}<br>Piso: %{customdata.story}<br>Sección: %{customdata.section}<extra></extra>";
  return Array.from(groups.values()).map(g => ({
    type:"scatter", mode:"lines", x:g.xs, y:g.ys, customdata:g.cd,
    line:{ color:g.color, width:g.width }, hovertemplate:hoverTpl, showlegend:false,
  }));
}

function build2DWalls(geometry: ModelGeometry, opts: ViewerOptions, p: Projection): object[] {
  const { shells, joints } = geometry;
  if (!shells || opts.typeFilter?.walls === false) return [];
  const allPiers = _wallPiersSorted(geometry);
  type G2 = { xs:(number|null)[]; ys:(number|null)[]; cd:(ElementClickInfo|null)[]; color:string };
  const groups = new Map<string, G2>();
  for (const [shellId, sd] of Object.entries(shells)) {
    if (sd.element_type !== "wall") continue;
    if (opts.storyFilter && opts.storyFilter !== "all" && sd.story !== opts.storyFilter) continue;
    const pier = sd.pier || "(sin pier)";
    if (opts.pierFilter && pier !== opts.pierFilter) continue;
    const corners = sd.joints.map(jl => joints[jl]).filter(Boolean);
    if (corners.length < 3) continue;
    const color = opts.wallColor ?? _wallPierColor(pier, allPiers);
    if (!groups.has(pier)) groups.set(pier, { xs:[], ys:[], cd:[], color });
    const g = groups.get(pier)!;
    const info: ElementClickInfo = { id:shellId, element_type:"wall", story:sd.story||"", section:sd.section||"" };
    for (const c of corners) { const [px,py]=proj2d(c.x,c.y,c.z,p); g.xs.push(px); g.ys.push(py); g.cd.push(info); }
    const [px0,py0]=proj2d(corners[0].x,corners[0].y,corners[0].z,p);
    g.xs.push(px0, null); g.ys.push(py0, null); g.cd.push(info, null);
  }
  return [...groups.values()].map(g => ({
    type:"scatter", mode:"lines", x:g.xs, y:g.ys, customdata:g.cd,
    line:{ color:g.color, width:2 },
    hovertemplate:`<b>Muro</b> %{customdata.id}<br>Piso: %{customdata.story}<extra></extra>`, showlegend:false,
  }));
}

function build2DSlabs(geometry: ModelGeometry, opts: ViewerOptions, p: Projection): object[] {
  const { shells, joints } = geometry;
  if (!shells || opts.typeFilter?.slabs === false) return [];
  const slabColor = opts.slabColor ?? "#F59E0B";
  type G2 = { xs:(number|null)[]; ys:(number|null)[]; cd:(ElementClickInfo|null)[] };
  const groups = new Map<string, G2>();
  for (const [shellId, sd] of Object.entries(shells)) {
    if (sd.element_type !== "slab") continue;
    if (opts.storyFilter && opts.storyFilter !== "all" && sd.story !== opts.storyFilter) continue;
    const corners = sd.joints.map(jl => joints[jl]).filter(Boolean);
    if (corners.length < 3) continue;
    const story = sd.story || "(sin piso)";
    if (!groups.has(story)) groups.set(story, { xs:[], ys:[], cd:[] });
    const g = groups.get(story)!;
    const info: ElementClickInfo = { id:shellId, element_type:"slab", story:sd.story||"", section:sd.section||"" };
    for (const c of corners) { const [px,py]=proj2d(c.x,c.y,c.z,p); g.xs.push(px); g.ys.push(py); g.cd.push(info); }
    const [px0,py0]=proj2d(corners[0].x,corners[0].y,corners[0].z,p);
    g.xs.push(px0, null); g.ys.push(py0, null); g.cd.push(info, null);
  }
  return [...groups.values()].map(g => ({
    type:"scatter", mode:"lines", x:g.xs, y:g.ys, customdata:g.cd,
    line:{ color:slabColor, width:1 },
    hovertemplate:`<b>Losa</b> %{customdata.id}<br>Piso: %{customdata.story}<extra></extra>`, showlegend:false,
  }));
}

// ── Mapa de color para intensidad de carga ────────────────────────────────────
// azul (#3B82F6) → amarillo (#FBBF24) → rojo (#EF4444)
function loadColor(val: number, minV: number, maxV: number, alpha = 0.55): string {
  const t = maxV > minV ? Math.max(0, Math.min(1, (val - minV) / (maxV - minV))) : 0;
  let r: number, g: number, b: number;
  if (t < 0.5) {
    const s = t / 0.5;
    r = Math.round(59  + s * (251 - 59));    // blue→yellow
    g = Math.round(130 + s * (191 - 130));
    b = Math.round(246 + s * (36  - 246));
  } else {
    const s = (t - 0.5) / 0.5;
    r = Math.round(251 + s * (239 - 251));   // yellow→red
    g = Math.round(191 + s * (68  - 191));
    b = Math.round(36  + s * (68  - 36));
  }
  return `rgba(${r},${g},${b},${alpha})`;
}

function build2DSlabLoads(
  geometry: ModelGeometry,
  shellLoads: Record<string, Record<string, number>>,
  pattern: string,
  opts: ViewerOptions,
  p: Projection,
): object[] {
  const { shells, joints } = geometry;
  if (!shells || opts.typeFilter?.slabs === false) return [];

  const loadMap: Record<string, number> = {};
  for (const [sid, patterns] of Object.entries(shellLoads)) {
    if (pattern in patterns) loadMap[sid] = patterns[pattern];
  }
  if (Object.keys(loadMap).length === 0) return [];

  const allVals = Object.values(loadMap);
  const minV = Math.min(...allVals);
  const maxV = Math.max(...allVals, minV + 1e-9);

  // Agrupar por valor de carga → una traza por valor único
  type G2 = { xs: (number|null)[]; ys: (number|null)[]; cd: (ElementClickInfo|null)[]; val: number };
  const groups = new Map<number, G2>();

  for (const [shellId, sd] of Object.entries(shells)) {
    if (sd.element_type !== "slab") continue;
    if (opts.storyFilter && opts.storyFilter !== "all" && sd.story !== opts.storyFilter) continue;
    const corners = sd.joints.map(jl => joints[jl]).filter(Boolean);
    if (corners.length < 3) continue;
    const val = loadMap[shellId] ?? 0;
    if (!groups.has(val)) groups.set(val, { xs: [], ys: [], cd: [], val });
    const g = groups.get(val)!;
    const info: ElementClickInfo = { id: shellId, element_type: "slab", story: sd.story || "", section: sd.section || "" };
    for (const c of corners) { const [px, py] = proj2d(c.x, c.y, c.z, p); g.xs.push(px); g.ys.push(py); g.cd.push(info); }
    const [px0, py0] = proj2d(corners[0].x, corners[0].y, corners[0].z, p);
    g.xs.push(px0, null); g.ys.push(py0, null); g.cd.push(info, null);
  }

  return [...groups.values()].map(g => {
    const fill = loadColor(g.val, minV, maxV, 0.55);
    const line = loadColor(g.val, minV, maxV, 0.9);
    return {
      type: "scatter", mode: "lines", x: g.xs, y: g.ys, customdata: g.cd,
      fill: "toself", fillcolor: fill,
      line: { color: line, width: 1 },
      hovertemplate: `<b>Losa</b> %{customdata.id}<br>Piso: %{customdata.story}<br>${pattern}: ${g.val.toFixed(2)} kN/m²<extra></extra>`,
      showlegend: false,
    };
  });
}

function build2DSupports(geometry: ModelGeometry, p: Projection): object {
  const sx:number[]=[], sy:number[]=[];
  for (const jd of Object.values(geometry.joints)) {
    if (!jd.is_restrained) continue;
    const [px,py] = proj2d(jd.x, jd.y, jd.z, p);
    sx.push(px); sy.push(py);
  }
  return { type:"scatter", mode:"markers", x:sx, y:sy,
    marker:{ color:C_SUPPORT, size:10, symbol:"triangle-up" },
    hoverinfo:"skip", showlegend:false };
}

function make2DLayout(isDark: boolean, p: Projection): object {
  const t = viewer3dTheme(isDark);
  const labels: Record<Projection, [string, string]> = {
    xy: ["X (m)", "Y (m)"],
    xz: ["X (m)", "Z — Altura (m)"],
    yz: ["Y (m)", "Z — Altura (m)"],
  };
  const [xLabel, yLabel] = labels[p];
  const axBase = {
    color: t.axisColor,
    gridcolor: t.gridColor,
    zerolinecolor: t.gridColor,
    zerolinewidth: 1,
    showgrid: true,
    zeroline: true,
    tickfont: { color: t.axisColor, size: 10 },
  };
  return {
    xaxis: { title: { text: xLabel, font: { color: t.axisColor, size: 11 } }, ...axBase },
    yaxis: { title: { text: yLabel, font: { color: t.axisColor, size: 11 } },
      scaleanchor: "x", scaleratio: 1, ...axBase },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: isDark ? "rgba(15,23,42,0.6)" : "rgba(248,250,252,0.8)",
    margin: { t: 24, r: 24, b: 52, l: 64 },
    dragmode: "pan",
    font: { color: t.axisColor },
    showlegend: false,
    modebar: { bgcolor: "rgba(0,0,0,0)", color: t.axisColor },
  };
}

// ── Layout 3D ─────────────────────────────────────────────────────────────────
function make3DLayout(isDark: boolean) {
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

// ── Props ─────────────────────────────────────────────────────────────────────
type ViewMode = "lines" | "extruded";

interface Props {
  geometry: ModelGeometry;
  selectedIds?: Set<string>;
  onClickElement?: (id: string, info: ElementClickInfo) => void;
  colorMode?: ColorMode;
  storyFilter?: string | null;
  pierFilter?: string | null;
  typeFilter?: ViewerTypeFilter;
  isolationMode?: boolean;
  modelSections?: Record<string, { material?: string }>;
  externalViewMode?: ViewMode;
  onViewModeChange?: (mode: ViewMode) => void;
  externalShowLoads?: boolean;
  externalShowNodes?: boolean;
  hideControls?: boolean;
  height?: number | string;
  sectionFilter?: string | null;
  materialFilter?: string | null;
  zoomBbox?: { xMin:number; xMax:number; yMin:number; yMax:number; zMin:number; zMax:number } | null;
  cameraViewMode?: "3d" | "plan" | "elevX" | "elevY";
  wallColor?: string;
  slabColor?: string;
  shellLoads?: Record<string, Record<string, number>>;
  shellLoadPattern?: string | null;
}

// ── Componente ────────────────────────────────────────────────────────────────
export function LinearModelViewer3D({
  geometry,
  selectedIds = new Set(),
  onClickElement,
  colorMode = "type",
  storyFilter = null,
  pierFilter = null,
  typeFilter = { columns:true, beams:true, walls:true, slabs:false },
  isolationMode = false,
  modelSections,
  externalViewMode,
  onViewModeChange,
  externalShowLoads,
  externalShowNodes,
  hideControls = false,
  height,
  sectionFilter = null,
  materialFilter = null,
  zoomBbox = null,
  cameraViewMode,
  wallColor,
  slabColor,
  shellLoads,
  shellLoadPattern = null,
}: Props) {
  const containerRef     = useRef<HTMLDivElement>(null);
  const prevRenderKeyRef = useRef<string>("");   // "3d-lines" | "3d-extruded" | "2d-xy" | "2d-xz" | "2d-yz"
  const [plotlyReady, setPlotlyReady] = useState(false);
  const [viewModeInternal, setViewModeInternal] = useState<ViewMode>("lines");
  const [showNodesInternal, setShowNodes] = useState(false);
  const [showLoadsInternal, setShowLoads] = useState(false);
  const showNodes = externalShowNodes ?? showNodesInternal;
  const showLoads = externalShowLoads ?? showLoadsInternal;
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const viewMode = externalViewMode ?? viewModeInternal;
  const setViewMode = (m: ViewMode) => { setViewModeInternal(m); onViewModeChange?.(m); };

  const { n_joints, n_frames, n_shells, n_stories, stories } = geometry;
  const totalHeight = Object.values(stories).reduce((mx, s) => Math.max(mx, s.elevation_m), 0);

  // Determinar si estamos en modo 2D y qué proyección
  const is2D = cameraViewMode === "plan" || cameraViewMode === "elevX" || cameraViewMode === "elevY";
  const projection: Projection = cameraViewMode === "plan" ? "xy" : cameraViewMode === "elevX" ? "xz" : "yz";

  // ── Cargar Plotly ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((window as any).Plotly) { setPlotlyReady(true); return; }
    const s = document.createElement("script");
    s.src = "https://cdn.plot.ly/plotly-2.35.2.min.js";
    s.onload = () => setPlotlyReady(true);
    document.head.appendChild(s);
  }, []);

  // ── Traces (memoized) ─────────────────────────────────────────────────────
  const traces = useMemo(() => {
    const opts: ViewerOptions = { colorMode, storyFilter, pierFilter, typeFilter, isolationMode,
      selectedIds, modelSections, sectionFilter, materialFilter, wallColor, slabColor,
      shellLoads, shellLoadPattern };

    if (is2D) {
      const useLoadMap = !!(shellLoadPattern && shellLoads && Object.keys(shellLoads).length > 0);
      const slabTraces = useLoadMap
        ? build2DSlabLoads(geometry, shellLoads!, shellLoadPattern!, opts, projection)
        : build2DSlabs(geometry, opts, projection);
      return [
        ...build2DFrames(geometry, opts, projection),
        ...build2DWalls(geometry, opts, projection),
        ...slabTraces,
        build2DSupports(geometry, projection),
      ];
    }

    // 3D
    const wallTraces = viewMode === "lines" ? buildWallsLines(geometry, opts) : buildWallPanels(geometry, opts);
    const slabTraces = viewMode === "lines" ? buildSlabsLines(geometry, opts) : buildSlabsPanels(geometry, opts);
    const dataTraces = viewMode === "lines"
      ? [...buildLinesInteractive(geometry, opts), ...wallTraces, ...slabTraces]
      : [...buildExtrudedInteractive(geometry, opts), ...wallTraces, ...slabTraces];

    // En modo extruido, mesh3d no soporta plotly_click → añade overlay picker
    const pickerOverlay = viewMode === "extruded" ? buildShellsPickerOverlay(geometry, opts) : null;

    return [
      ...buildLegendTraces(opts),
      ...dataTraces,
      ...(pickerOverlay ? [pickerOverlay] : []),
      buildSupports3D(geometry),
      ...(showNodes ? [buildNodes3D(geometry)] : []),
      ...(showLoads ? buildLoadArrows(geometry, totalHeight) : []),
    ];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry, viewMode, showNodes, showLoads, colorMode, storyFilter, pierFilter, typeFilter,
      isolationMode, selectedIds, sectionFilter, materialFilter, modelSections, wallColor, slabColor,
      shellLoads, shellLoadPattern, totalHeight, is2D, projection]);

  // ── Render Plotly ─────────────────────────────────────────────────────────
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Plotly = (window as any)?.Plotly;
    if (!plotlyReady || !containerRef.current || !Plotly) return;
    const el = containerRef.current;

    // Cuando cambia el tipo de render (3D↔2D o distinta proyección) hay que purgar
    const renderKey = is2D ? `2d-${projection}` : `3d-${viewMode}`;
    const needsPurge = prevRenderKeyRef.current !== renderKey;
    prevRenderKeyRef.current = renderKey;

    const layout = is2D ? make2DLayout(isDark, projection) : make3DLayout(isDark);
    const config = {
      responsive: true, displayModeBar: true, displaylogo: false,
      modeBarButtonsToRemove: ["toImage", "sendDataToCloud"],
      scrollZoom: true,
    };

    if (needsPurge) {
      try { Plotly.purge(el); } catch { /* silencioso */ }
      Plotly.newPlot(el, traces, layout, config);
    } else {
      Plotly.react(el, traces, layout, config);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plotlyReady, traces, isDark, is2D, projection, viewMode]);

  // ── Click handler ─────────────────────────────────────────────────────────
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
      if (info?.id) onClickRef.current?.(info.id, info);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (el as any).on("plotly_click", handler);
    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      try { (el as any).removeListener?.("plotly_click", handler); } catch { /* silencioso */ }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plotlyReady, onClickElement, is2D, projection, viewMode]);

  // ── Cámara 3D (solo aplica en modo 3D) ───────────────────────────────────
  useEffect(() => {
    if (is2D || !cameraViewMode || cameraViewMode === "3d") return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Plotly = (window as any)?.Plotly;
    if (!plotlyReady || !containerRef.current || !Plotly) return;
    const cameras = {
      "3d": { eye:{ x:1.6, y:1.6, z:0.8 }, up:{ x:0,y:0,z:1 }, projection:{ type:"perspective" } },
    } as const;
    // Solo aplica la cámara "3d" — las vistas 2D se manejan con el cambio de traces
    if (cameraViewMode in cameras) {
      Plotly.relayout(containerRef.current, { "scene.camera": cameras["3d"] });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraViewMode, plotlyReady, is2D]);

  // ── Zoom to bounding box (solo 3D) ────────────────────────────────────────
  useEffect(() => {
    if (!zoomBbox || !plotlyReady || !containerRef.current || is2D) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Plotly = (window as any)?.Plotly;
    if (!Plotly) return;
    const pad = Math.max(
      (zoomBbox.xMax - zoomBbox.xMin) * 0.4,
      (zoomBbox.yMax - zoomBbox.yMin) * 0.4,
      (zoomBbox.zMax - zoomBbox.zMin) * 0.4, 3,
    );
    Plotly.relayout(containerRef.current, {
      "scene.xaxis.range": [zoomBbox.xMin - pad, zoomBbox.xMax + pad],
      "scene.yaxis.range": [zoomBbox.yMin - pad, zoomBbox.yMax + pad],
      "scene.zaxis.range": [zoomBbox.zMin - pad, zoomBbox.zMax + pad],
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomBbox, plotlyReady, is2D]);

  // ── ResizeObserver ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!plotlyReady || !containerRef.current) return;
    const el = containerRef.current;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Plotly = (window as any)?.Plotly;
    if (!Plotly) return;
    const ro = new ResizeObserver(() => { try { Plotly.Plots.resize(el); } catch { /* silencioso */ } });
    const parent = el.parentElement;
    if (parent) ro.observe(parent);
    return () => ro.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plotlyReady]);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Plotly = (window as any)?.Plotly;
      if (containerRef.current && Plotly) try { Plotly.purge(containerRef.current); } catch { /* silencioso */ }
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
      {/* ── Stats + controles (modo standalone) ──────────────────────────── */}
      {!hideControls && (
        <div className="flex items-center justify-between flex-wrap gap-2 flex-shrink-0">
          <div className="flex gap-4 text-xs" style={{ color: vt.axisColor }}>
            <span><strong style={{ color: isDark ? "#e2e8f0" : "#1e293b" }}>{n_stories}</strong> pisos</span>
            <span><strong style={{ color: isDark ? "#e2e8f0" : "#1e293b" }}>{n_joints}</strong> nodos</span>
            <span><strong style={{ color: isDark ? "#e2e8f0" : "#1e293b" }}>{n_frames}</strong> frames</span>
            {n_shells > 0 && <span><strong style={{ color: isDark ? "#e2e8f0" : "#1e293b" }}>{n_shells}</strong> shells</span>}
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
            <button onClick={() => setShowLoads(v=>!v)}
              className={`${btnBase} border rounded-lg ${showLoads?btnOn:btnOff}`}>
              Cargas
            </button>
          </div>
        </div>
      )}

      {/* ── Viewport ─────────────────────────────────────────────────────── */}
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
            <span className="text-sm animate-pulse" style={{ color: vt.axisColor }}>
              Cargando visualizador 3D…
            </span>
          </div>
        ) : (
          <div style={{ position:"relative", width:"100%", height:"100%" }}>
            <div ref={containerRef} style={{ width:"100%", height:"100%" }} />
            {/* Leyenda de carga cuando el mapa de calor está activo */}
            {shellLoadPattern && shellLoads && Object.keys(shellLoads).length > 0 && is2D && (() => {
              const vals = Object.values(shellLoads).map(p => p[shellLoadPattern!]).filter(v => v !== undefined);
              if (vals.length === 0) return null;
              const minV = Math.min(...vals), maxV = Math.max(...vals);
              return (
                <div style={{
                  position:"absolute", bottom:36, right:12,
                  background: isDark ? "rgba(15,23,42,0.85)" : "rgba(255,255,255,0.85)",
                  border: `1px solid ${vt.containerBorder}`, borderRadius:6,
                  padding:"6px 10px", display:"flex", flexDirection:"column", gap:4, minWidth:120,
                }}>
                  <span style={{ fontSize:10, fontWeight:600, color: vt.axisColor, marginBottom:2 }}>
                    {shellLoadPattern} (kN/m²)
                  </span>
                  <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <span style={{ fontSize:9, color: vt.axisColor }}>{minV.toFixed(1)}</span>
                    <div style={{
                      flex:1, height:10, borderRadius:4,
                      background:"linear-gradient(to right, rgba(59,130,246,0.85), rgba(251,191,36,0.85), rgba(239,68,68,0.85))",
                    }}/>
                    <span style={{ fontSize:9, color: vt.axisColor }}>{maxV.toFixed(1)}</span>
                  </div>
                </div>
              );
            })()}
          </div>
        )}
      </div>

      {/* ── Leyenda (modo standalone) ─────────────────────────────────────── */}
      {!hideControls && (
        <div className="flex items-center gap-4 text-[11px] flex-shrink-0" style={{ color: vt.axisColor }}>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-4 h-[2px] rounded" style={{ background: C_COL_LINE }}/>
            Columnas
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-4 h-[2px] rounded" style={{ background: C_BM_LINE }}/>
            Vigas
          </span>
          {(typeFilter?.walls !== false) && n_shells > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 rounded-sm" style={{ background: PIER_PALETTE[0] }}/>
              <span className="inline-block w-3 h-3 rounded-sm" style={{ background: PIER_PALETTE[1] }}/>
              Muros
            </span>
          )}
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-2 h-2 rounded-sm rotate-45" style={{ background: C_SUPPORT }}/>
            Apoyos
          </span>
          {selectedIds.size > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-4 h-[3px] rounded" style={{ background: C_SELECT }}/>
              Seleccionados ({selectedIds.size})
            </span>
          )}
          <span className="ml-auto text-[10px]" style={{ color: vt.gridColor }}>
            {is2D ? "Pan: arrastrar · Zoom: scroll" : "Rotar: arrastrar · Zoom: scroll · Reset: doble clic"}
          </span>
        </div>
      )}
    </div>
  );
}
