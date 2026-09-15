"use client";

import { useRef, useCallback, useEffect, useState } from "react";
import type { MouseEvent as RMouseEvent, WheelEvent as RWheelEvent } from "react";
import type { EditorState, EditorAction, Selection } from "@/lib/editor-state";
import { screenToWorld, snapToGrid } from "@/lib/editor-state";
import type { ConcreteRegion, ReinforcementBar, RegionShape } from "@/lib/section-document";
import { BAR_DIAMETERS_MM, uid } from "@/lib/section-document";
import { useTheme } from "@/lib/theme";
import { BarEditDialog } from "./BarEditDialog";
import {
  IconDuplicate, IconEdit, IconAlign, IconMove, IconTrash, IconClose,
} from "./icons";

// ── Props ──────────────────────────────────────────────────────────────────

interface Props {
  state: EditorState;
  dispatch: React.Dispatch<EditorAction>;
  onLineComplete?: (y1: number, z1: number, y2: number, z2: number) => void;
}

// ── Paletas de colores por tema ────────────────────────────────────────────

const DARK_C = {
  grid:            "rgba(120,130,160,0.15)",
  gridMajor:       "rgba(120,130,160,0.30)",
  axis:            "rgba(120,130,160,0.55)",
  concrete:        "#4e8ab0",
  concreteVoid:    "transparent",
  concreteStroke:  "#2e6888",
  concreteHover:   "#5aa2c8",
  concreteSelected:"#2dd4e8",
  bar:             "#f59e0b",
  barSelected:     "#fbbf24",
  barStroke:       "#78350f",
  barHalo:         "rgba(251,191,36,0.35)",
  barHover:        "#fbbf24",
  preview:         "rgba(45,212,232,0.20)",
  previewStroke:   "#2dd4e8",
  polygon:         "rgba(45,212,232,0.18)",
  polygonStroke:   "#2dd4e8",
  boxFill:         "rgba(45,212,232,0.08)",
  boxStroke:       "#2dd4e8",
  guide:           "#22d3ee",           // guías de alineación (cyan pálido)
  snap:            "#a855f7",            // snap magnético (púrpura)
  centroid:        "#fb7185",            // centroide (rosa)
  axisI1:          "#22d3ee",
  axisI2:          "#a855f7",
};

const LIGHT_C = {
  grid:            "rgba(80,100,140,0.10)",
  gridMajor:       "rgba(80,100,140,0.22)",
  axis:            "rgba(60,80,130,0.45)",
  concrete:        "#5b8fc9",
  concreteVoid:    "rgba(190,210,240,0.35)",
  concreteStroke:  "#2c6090",
  concreteHover:   "#3d76b0",
  concreteSelected:"#0e7fa8",
  bar:             "#d97706",
  barSelected:     "#f59e0b",
  barStroke:       "#78350f",
  barHalo:         "rgba(217,119,6,0.28)",
  barHover:        "#ea9c1f",
  preview:         "rgba(14,127,168,0.16)",
  previewStroke:   "#0e7fa8",
  polygon:         "rgba(14,127,168,0.12)",
  polygonStroke:   "#0e7fa8",
  boxFill:         "rgba(14,127,168,0.06)",
  boxStroke:       "#0e7fa8",
  guide:           "#0891b2",
  snap:            "#7c3aed",
  centroid:        "#e11d48",
  axisI1:          "#0891b2",
  axisI2:          "#7c3aed",
};

// ── Hit testing ────────────────────────────────────────────────────────────

function pointInRect(y: number, z: number, s: { y: number; z: number; height: number; width: number }): boolean {
  return Math.abs(z - s.z) <= s.width / 2 && Math.abs(y - s.y) <= s.height / 2;
}
function pointInCircle(y: number, z: number, s: { y: number; z: number; radius: number }): boolean {
  return Math.hypot(z - s.z, y - s.y) <= s.radius;
}
function pointInPolygon(y: number, z: number, verts: [number, number][]): boolean {
  let inside = false; const n = verts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [yi, zi] = verts[i]; const [yj, zj] = verts[j];
    if ((zi > z) !== (zj > z) && z < ((zj - zi) * (y - yi)) / (yj - yi) + zi) inside = !inside;
  }
  return inside;
}
function hitRegion(y: number, z: number, r: ConcreteRegion): boolean {
  const s = r.shape;
  if (s.kind === "rect") return pointInRect(y, z, s);
  if (s.kind === "circ") return pointInCircle(y, z, s);
  // Otras formas paramétricas / poly: usar vértices convertidos si los expone; por ahora fallback a poly
  if ("vertices" in s) return pointInPolygon(y, z, (s as { vertices: [number, number][] }).vertices);
  return false;
}
function hitBar(y: number, z: number, b: ReinforcementBar, minR: number): boolean {
  const r = Math.max(BAR_DIAMETERS_MM[b.bar_size] / 2, minR);
  return Math.hypot(z - b.z, y - b.y) <= r;
}

function isElemSelected(sel: Selection, kind: "region" | "bar", id: string): boolean {
  if (!sel) return false;
  if (sel.kind === "region") return kind === "region" && sel.id === id;
  if (sel.kind === "bar")    return kind === "bar" && sel.id === id;
  if (sel.kind === "multi")  return kind === "region" ? sel.regionIds.includes(id) : sel.barIds.includes(id);
  return false;
}

// ── Centroide y bbox ─────────────────────────────────────────────────────

function regionCenter(shape: RegionShape): { y: number; z: number } {
  if (shape.kind === "rect" || shape.kind === "circ") return { y: shape.y, z: shape.z };
  const verts: [number, number][] = "vertices" in shape ? shape.vertices : [];
  if (verts.length === 0) return { y: 0, z: 0 };
  const y = verts.reduce((s, [vy]) => s + vy, 0) / verts.length;
  const z = verts.reduce((s, [, vz]) => s + vz, 0) / verts.length;
  return { y, z };
}

function getShapeBBox(shape: RegionShape) {
  if (shape.kind === "rect") {
    const { y, z, height: h, width: w } = shape;
    return { minY: y - h / 2, maxY: y + h / 2, minZ: z - w / 2, maxZ: z + w / 2,
      wLabel: `${Math.round(w)} mm`, hLabel: `${Math.round(h)} mm` };
  }
  if (shape.kind === "circ") {
    const { y, z, radius: r } = shape;
    const d = Math.round(2 * r);
    return { minY: y - r, maxY: y + r, minZ: z - r, maxZ: z + r,
      wLabel: `⌀${d} mm`, hLabel: `⌀${d} mm` };
  }
  const verts: [number, number][] = "vertices" in shape ? shape.vertices : [];
  if (verts.length < 2) return null;
  const ys = verts.map(([vy]) => vy); const zs = verts.map(([, vz]) => vz);
  const [minY, maxY] = [Math.min(...ys), Math.max(...ys)];
  const [minZ, maxZ] = [Math.min(...zs), Math.max(...zs)];
  return { minY, maxY, minZ, maxZ,
    wLabel: `${Math.round(maxZ - minZ)} mm`, hLabel: `${Math.round(maxY - minY)} mm` };
}

// ── DimLines (cotas de región seleccionada) ──────────────────────────────

function DimLines({ shape, zoom, color }: { shape: RegionShape; zoom: number; color: string }) {
  const bb = getShapeBBox(shape); if (!bb) return null;
  const { minY, maxY, minZ, maxZ, wLabel, hLabel } = bb;
  const gap = 28 / zoom, ext = 6 / zoom, tick = 5 / zoom, lw = 1 / zoom, fs = 10;
  const hdY = minY - gap, hmidZ = (minZ + maxZ) / 2, vdZ = minZ - gap, vmidY = (minY + maxY) / 2;
  return (
    <g pointerEvents="none">
      <line x1={minZ} y1={hdY} x2={maxZ} y2={hdY} stroke={color} strokeWidth={lw} />
      <line x1={minZ} y1={minY} x2={minZ} y2={hdY - ext} stroke={color} strokeWidth={lw * 0.6} strokeDasharray={`${3/zoom} ${2/zoom}`} />
      <line x1={maxZ} y1={minY} x2={maxZ} y2={hdY - ext} stroke={color} strokeWidth={lw * 0.6} strokeDasharray={`${3/zoom} ${2/zoom}`} />
      <line x1={minZ - tick} y1={hdY} x2={minZ + tick} y2={hdY} stroke={color} strokeWidth={lw * 1.8} />
      <line x1={maxZ - tick} y1={hdY} x2={maxZ + tick} y2={hdY} stroke={color} strokeWidth={lw * 1.8} />
      <text transform={`translate(${hmidZ},${hdY - ext}) scale(${1/zoom},${-1/zoom})`}
        textAnchor="middle" fontSize={fs} fontFamily="monospace" fill={color}>{wLabel}</text>
      <line x1={vdZ} y1={minY} x2={vdZ} y2={maxY} stroke={color} strokeWidth={lw} />
      <line x1={minZ} y1={minY} x2={vdZ - ext} y2={minY} stroke={color} strokeWidth={lw * 0.6} strokeDasharray={`${3/zoom} ${2/zoom}`} />
      <line x1={minZ} y1={maxY} x2={vdZ - ext} y2={maxY} stroke={color} strokeWidth={lw * 0.6} strokeDasharray={`${3/zoom} ${2/zoom}`} />
      <line x1={vdZ} y1={minY - tick} x2={vdZ} y2={minY + tick} stroke={color} strokeWidth={lw * 1.8} />
      <line x1={vdZ} y1={maxY - tick} x2={vdZ} y2={maxY + tick} stroke={color} strokeWidth={lw * 1.8} />
      <text transform={`translate(${vdZ - ext},${vmidY}) scale(${1/zoom},${-1/zoom}) rotate(-90)`}
        textAnchor="middle" fontSize={fs} fontFamily="monospace" fill={color}>{hLabel}</text>
    </g>
  );
}

// ── SVG path de formas ────────────────────────────────────────────────────

function regionPath(shape: RegionShape): string {
  if (shape.kind === "rect") {
    const { y, z, height: h, width: w } = shape;
    return `M ${z - w / 2} ${y - h / 2} h ${w} v ${h} h ${-w} Z`;
  }
  if (shape.kind === "circ") {
    const { y, z, radius: r, radius_inner: ri } = shape;
    const p = `M ${z + r} ${y} A ${r} ${r} 0 1 0 ${z - r} ${y} A ${r} ${r} 0 1 0 ${z + r} ${y} Z`;
    if (ri > 0) return `${p} M ${z + ri} ${y} A ${ri} ${ri} 0 1 1 ${z - ri} ${y} A ${ri} ${ri} 0 1 1 ${z + ri} ${y} Z`;
    return p;
  }
  const verts: [number, number][] = "vertices" in shape ? shape.vertices : [];
  if (verts.length < 2) return "";
  return `M ${verts.map(([vy, vz]) => `${vz} ${vy}`).join(" L ")} Z`;
}

// ── Snap magnético a coordenadas de otras barras ─────────────────────────

const SNAP_PIXELS = 8;   // radio en píxeles de pantalla para snap

function findSnap(
  y: number, z: number, zoom: number,
  bars: readonly ReinforcementBar[],
  excludeIds: Set<string>,
): { y: number; z: number; snappedY: boolean; snappedZ: boolean } {
  const tol = SNAP_PIXELS / zoom;
  let bestY: number | null = null; let bestYd = Infinity;
  let bestZ: number | null = null; let bestZd = Infinity;
  for (const b of bars) {
    if (excludeIds.has(b.id)) continue;
    const dy = Math.abs(b.y - y);
    const dz = Math.abs(b.z - z);
    if (dy < bestYd && dy < tol) { bestYd = dy; bestY = b.y; }
    if (dz < bestZd && dz < tol) { bestZd = dz; bestZ = b.z; }
  }
  return {
    y: bestY !== null ? bestY : y,
    z: bestZ !== null ? bestZ : z,
    snappedY: bestY !== null,
    snappedZ: bestZ !== null,
  };
}

// ── Componente canvas ─────────────────────────────────────────────────────

export function EditorCanvas({ state, dispatch, onLineComplete }: Props) {
  const { theme } = useTheme();
  const C = theme === "dark" ? DARK_C : LIGHT_C;

  const svgRef = useRef<SVGSVGElement>(null);
  const stateRef = useRef(state); stateRef.current = state;

  // Refs de pan
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const isMouseDown = useRef(false);
  const spaceHeld = useRef(false);

  // Estados locales para interacciones transitorias (no van al reducer)
  const [boxRect, setBoxRect] = useState<{ sY: number; sZ: number; cY: number; cZ: number } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; canEdit: boolean } | null>(null);
  const [editingBarId, setEditingBarId] = useState<string | null>(null);
  const [hover, setHover] = useState<{ kind: "bar" | "region"; id: string; sx: number; sy: number } | null>(null);
  const [dragPreview, setDragPreview] = useState<{
    dy: number; dz: number;
    startY: number; startZ: number;
    curY: number; curZ: number;
    snappedY: boolean; snappedZ: boolean;
  } | null>(null);

  // Refs para modo de arrastre
  const dragModeRef = useRef<"box" | "move" | null>(null);
  const dragStartRef = useRef<{ y: number; z: number } | null>(null);
  const moveDeltaRef = useRef<{ dy: number; dz: number }>({ dy: 0, dz: 0 });

  // Cerrar menú contextual al hacer clic fuera
  useEffect(() => {
    if (!ctxMenu) return;
    const handler = () => setCtxMenu(null);
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [ctxMenu]);

  // Coordenadas pantalla → mundo
  const getWorldPos = useCallback((e: { clientX: number; clientY: number }, snap = true) => {
    const svg = svgRef.current; if (!svg) return { y: 0, z: 0 };
    const rect = svg.getBoundingClientRect();
    const raw = screenToWorld(e.clientX - rect.left, e.clientY - rect.top, stateRef.current.view);
    if (snap && stateRef.current.view.snapEnabled) {
      const gs = stateRef.current.view.gridSize;
      return { y: snapToGrid(raw.y, gs), z: snapToGrid(raw.z, gs) };
    }
    return raw;
  }, []);

  // Teclado
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const s = stateRef.current;
      if (e.code === "Space") spaceHeld.current = true;
      if (e.key === "Escape") {
        setBoxRect(null); setDragPreview(null); setCtxMenu(null); setEditingBarId(null);
        dragModeRef.current = null;
        if (s.drawing) dispatch({ type: "SET_DRAWING", drawing: null });
        else dispatch({ type: "SET_SELECTION", selection: null });
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        const sel = s.selection; if (!sel) return;
        if (sel.kind === "region") dispatch({ type: "DELETE_REGION", id: sel.id });
        else if (sel.kind === "bar") dispatch({ type: "DELETE_BAR", id: sel.id });
        else if (sel.kind === "multi") dispatch({ type: "DELETE_SELECTION" });
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); dispatch({ type: "UNDO" }); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.shiftKey && e.key === "z"))) { e.preventDefault(); dispatch({ type: "REDO" }); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === "d") {
        e.preventDefault();
        const sel = s.selection;
        if (sel?.kind === "region") dispatch({ type: "DUPLICATE_REGION", id: sel.id });
        if (sel?.kind === "bar") dispatch({ type: "DUPLICATE_BAR", id: sel.id });
        return;
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === "s") dispatch({ type: "SET_TOOL", tool: "select" });
        if (k === "r") dispatch({ type: "SET_TOOL", tool: "rect" });
        if (k === "c") dispatch({ type: "SET_TOOL", tool: "circle" });
        if (k === "g") dispatch({ type: "SET_TOOL", tool: "polygon" });
        if (k === "b") dispatch({ type: "SET_TOOL", tool: "bar" });
        if (k === "l") dispatch({ type: "SET_TOOL", tool: "line" });
        if (k === "f") {
          e.preventDefault();
          const svg = svgRef.current;
          if (svg) dispatch({ type: "FIT_VIEW", canvasWidth: svg.clientWidth, canvasHeight: svg.clientHeight });
        }
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space") spaceHeld.current = false;
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [dispatch]);

  // ── Mouse down ────────────────────────────────────────────────────────

  const handleMouseDown = useCallback((e: RMouseEvent<SVGSVGElement>) => {
    const s = stateRef.current; const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const sx = e.clientX - rect.left; const sy = e.clientY - rect.top;

    // Pan: middle button, Alt+click, o Space+click
    if (e.button === 1 || (e.button === 0 && (e.altKey || spaceHeld.current))) {
      e.preventDefault();
      isPanning.current = true;
      panStart.current = { x: sx, y: sy, panX: s.view.panX, panY: s.view.panY };
      return;
    }
    if (e.button === 2) return;
    if (e.button !== 0) return;

    setCtxMenu(null);
    const world = getWorldPos(e);
    isMouseDown.current = true;

    switch (s.tool) {
      case "rect":
        dispatch({ type: "SET_DRAWING", drawing: { tool: "rect", startY: world.y, startZ: world.z } });
        break;
      case "circle":
        dispatch({ type: "SET_DRAWING", drawing: { tool: "circle", cy: world.y, cz: world.z } });
        break;
      case "line":
        if (!s.drawing) dispatch({ type: "SET_DRAWING", drawing: { tool: "line", startY: world.y, startZ: world.z } });
        break;
      case "polygon": {
        if (!s.drawing || s.drawing.tool !== "polygon") {
          dispatch({ type: "SET_DRAWING", drawing: { tool: "polygon", vertices: [[world.y, world.z]] } });
        } else {
          const [fy, fz] = s.drawing.vertices[0];
          const closeRadius = Math.max(10 / s.view.zoom, s.view.gridSize / 2);
          if (s.drawing.vertices.length >= 3 && Math.hypot(world.z - fz, world.y - fy) < closeRadius) {
            const vertices = s.drawing.vertices;
            const defaultConcreteId = s.doc.concrete_defs[0]?.id ?? "c0";
            dispatch({ type: "ADD_REGION", region: {
              id: uid(), label: "Región",
              shape: { kind: "poly", vertices },
              concrete_id: defaultConcreteId, confinement: null, cover_to_bar: 40, is_void: false, core_polygon: null,
            }});
          } else {
            dispatch({ type: "SET_DRAWING", drawing: { tool: "polygon", vertices: [...s.drawing.vertices, [world.y, world.z]] } });
          }
        }
        break;
      }
      case "bar": {
        const defaultSteelId = s.doc.steel_defs[0]?.id ?? "s0";
        dispatch({ type: "ADD_BAR", bar: { id: uid(), y: world.y, z: world.z, bar_size: "#5", steel_id: defaultSteelId } });
        break;
      }
      case "select": {
        const minBarR = 6 / s.view.zoom;
        const hitB = s.doc.bars.find((b) => hitBar(world.y, world.z, b, minBarR));
        const hitR = [...s.doc.regions].reverse().find((r) => hitRegion(world.y, world.z, r));
        const hitElem = hitB ? { kind: "bar" as const, id: hitB.id } : hitR ? { kind: "region" as const, id: hitR.id } : null;

        if (hitElem && isElemSelected(s.selection, hitElem.kind, hitElem.id)) {
          dragModeRef.current = "move"; dragStartRef.current = world;
          moveDeltaRef.current = { dy: 0, dz: 0 };
          setDragPreview({
            dy: 0, dz: 0, startY: world.y, startZ: world.z, curY: world.y, curZ: world.z,
            snappedY: false, snappedZ: false,
          });
        } else if (hitElem) {
          dispatch({ type: "SET_SELECTION", selection: hitElem });
        } else {
          dragModeRef.current = "box"; dragStartRef.current = world;
          setBoxRect({ sY: world.y, sZ: world.z, cY: world.y, cZ: world.z });
        }
        break;
      }
    }
  }, [dispatch, getWorldPos]);

  // ── Mouse move ────────────────────────────────────────────────────────

  const handleMouseMove = useCallback((e: RMouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current; if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const sx = e.clientX - rect.left; const sy = e.clientY - rect.top;

    if (isPanning.current) {
      dispatch({ type: "SET_VIEW", view: {
        panX: panStart.current.panX + sx - panStart.current.x,
        panY: panStart.current.panY + sy - panStart.current.y,
      }});
      return;
    }

    const s = stateRef.current;
    const raw = screenToWorld(sx, sy, s.view);
    const world = s.view.snapEnabled
      ? { y: snapToGrid(raw.y, s.view.gridSize), z: snapToGrid(raw.z, s.view.gridSize) }
      : raw;
    dispatch({ type: "SET_CURSOR", y: world.y, z: world.z });

    // Detección de hover — solo en herramienta select y sin drag activo
    if (s.tool === "select" && !dragModeRef.current && !s.drawing) {
      const minBarR = 6 / s.view.zoom;
      const hitB = s.doc.bars.find((b) => hitBar(raw.y, raw.z, b, minBarR));
      const hitR = !hitB ? [...s.doc.regions].reverse().find((r) => hitRegion(raw.y, raw.z, r)) : null;
      if (hitB) setHover({ kind: "bar", id: hitB.id, sx: e.clientX, sy: e.clientY });
      else if (hitR) setHover({ kind: "region", id: hitR.id, sx: e.clientX, sy: e.clientY });
      else if (hover) setHover(null);
    } else if (hover) {
      setHover(null);
    }

    // Recuadro de selección
    if (dragModeRef.current === "box" && dragStartRef.current) {
      setBoxRect({ sY: dragStartRef.current.y, sZ: dragStartRef.current.z, cY: world.y, cZ: world.z });
    }

    // Mover con snap magnético a otras barras
    if (dragModeRef.current === "move" && dragStartRef.current) {
      let targetY = world.y, targetZ = world.z;
      let snappedY = false, snappedZ = false;

      if (s.selection?.kind === "bar") {
        const barId = s.selection.id;
        const bar = s.doc.bars.find((b) => b.id === barId);
        if (bar) {
          const currentY = bar.y + (targetY - dragStartRef.current.y);
          const currentZ = bar.z + (targetZ - dragStartRef.current.z);
          const excludeIds = new Set([bar.id]);
          const snap = findSnap(currentY, currentZ, s.view.zoom, s.doc.bars, excludeIds);
          if (snap.snappedY) { targetY += snap.y - currentY; snappedY = true; }
          if (snap.snappedZ) { targetZ += snap.z - currentZ; snappedZ = true; }
        }
      }
      const dy = targetY - dragStartRef.current.y;
      const dz = targetZ - dragStartRef.current.z;
      moveDeltaRef.current = { dy, dz };
      setDragPreview({
        dy, dz,
        startY: dragStartRef.current.y, startZ: dragStartRef.current.z,
        curY: targetY, curZ: targetZ,
        snappedY, snappedZ,
      });
    }
  }, [dispatch, hover]);

  // ── Mouse up ──────────────────────────────────────────────────────────

  const handleMouseUp = useCallback((e: RMouseEvent<SVGSVGElement>) => {
    if (isPanning.current) { isPanning.current = false; return; }

    const mode = dragModeRef.current; dragModeRef.current = null;

    if (mode === "box") {
      setBoxRect(null);
      const s = stateRef.current;
      const world = getWorldPos(e); const start = dragStartRef.current;
      if (!start) return;
      const minY = Math.min(start.y, world.y), maxY = Math.max(start.y, world.y);
      const minZ = Math.min(start.z, world.z), maxZ = Math.max(start.z, world.z);
      if ((maxZ - minZ) < 5 || (maxY - minY) < 5) {
        dispatch({ type: "SET_SELECTION", selection: null }); return;
      }
      const regionIds = s.doc.regions
        .filter((r) => { const c = regionCenter(r.shape); return c.y >= minY && c.y <= maxY && c.z >= minZ && c.z <= maxZ; })
        .map((r) => r.id);
      const barIds = s.doc.bars
        .filter((b) => b.y >= minY && b.y <= maxY && b.z >= minZ && b.z <= maxZ)
        .map((b) => b.id);
      const total = regionIds.length + barIds.length;
      if (total === 0) dispatch({ type: "SET_SELECTION", selection: null });
      else if (total === 1) dispatch({ type: "SET_SELECTION", selection: regionIds.length ? { kind: "region", id: regionIds[0] } : { kind: "bar", id: barIds[0] } });
      else dispatch({ type: "SET_SELECTION", selection: { kind: "multi", regionIds, barIds } });
      dragStartRef.current = null; return;
    }

    if (mode === "move") {
      const { dy, dz } = moveDeltaRef.current;
      if (Math.abs(dy) > 0 || Math.abs(dz) > 0) dispatch({ type: "MOVE_SELECTION", dy, dz });
      dragStartRef.current = null;
      setDragPreview(null);
      return;
    }

    if (!isMouseDown.current) return;
    isMouseDown.current = false;

    const s = stateRef.current;
    if (!s.drawing) return;
    const world = getWorldPos(e);

    if (s.drawing.tool === "rect") {
      const w = Math.abs(world.z - s.drawing.startZ), h = Math.abs(world.y - s.drawing.startY);
      if (w < 5 || h < 5) { dispatch({ type: "SET_DRAWING", drawing: null }); return; }
      const cy = (world.y + s.drawing.startY) / 2, cz = (world.z + s.drawing.startZ) / 2;
      const defaultConcreteId = s.doc.concrete_defs[0]?.id ?? "c0";
      dispatch({ type: "ADD_REGION", region: {
        id: uid(), label: "Región",
        shape: { kind: "rect", y: cy, z: cz, height: h, width: w, angle_deg: 0 },
        concrete_id: defaultConcreteId, confinement: null, cover_to_bar: 40, is_void: false, core_polygon: null,
      }});
    } else if (s.drawing.tool === "circle") {
      const r = Math.hypot(world.z - s.drawing.cz, world.y - s.drawing.cy);
      if (r < 5) { dispatch({ type: "SET_DRAWING", drawing: null }); return; }
      const defaultConcreteId = s.doc.concrete_defs[0]?.id ?? "c0";
      dispatch({ type: "ADD_REGION", region: {
        id: uid(), label: "Región",
        shape: { kind: "circ", y: s.drawing.cy, z: s.drawing.cz, radius: r, radius_inner: 0 },
        concrete_id: defaultConcreteId, confinement: null, cover_to_bar: 40, is_void: false, core_polygon: null,
      }});
    } else if (s.drawing.tool === "line") {
      const dy = world.y - s.drawing.startY, dz = world.z - s.drawing.startZ;
      if (Math.hypot(dy, dz) < 5) { dispatch({ type: "SET_DRAWING", drawing: null }); return; }
      dispatch({ type: "SET_DRAWING", drawing: null });
      onLineComplete?.(s.drawing.startY, s.drawing.startZ, world.y, world.z);
    }
  }, [dispatch, getWorldPos, onLineComplete]);

  const handleWheel = useCallback((e: RWheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const svg = svgRef.current; if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    dispatch({ type: "ZOOM_AT", factor, screenX: e.clientX - rect.left, screenY: e.clientY - rect.top });
  }, [dispatch]);

  // Doble clic → editar barra
  const handleDoubleClick = useCallback((e: RMouseEvent<SVGSVGElement>) => {
    const s = stateRef.current;
    if (s.tool !== "select") return;
    const world = getWorldPos(e, false);
    const minBarR = 6 / s.view.zoom;
    const hitB = s.doc.bars.find((b) => hitBar(world.y, world.z, b, minBarR));
    if (hitB) {
      dispatch({ type: "SET_SELECTION", selection: { kind: "bar", id: hitB.id } });
      setEditingBarId(hitB.id);
    }
  }, [dispatch, getWorldPos]);

  // Menú contextual
  const handleContextMenu = useCallback((e: RMouseEvent<SVGSVGElement>) => {
    e.preventDefault();
    const s = stateRef.current;
    if (s.tool !== "select") { if (s.drawing) dispatch({ type: "SET_DRAWING", drawing: null }); return; }
    const world = getWorldPos(e, false);
    const minBarR = 6 / s.view.zoom;
    const hitB = s.doc.bars.find((b) => hitBar(world.y, world.z, b, minBarR));
    const hitR = [...s.doc.regions].reverse().find((r) => hitRegion(world.y, world.z, r));
    let canEdit = false;
    if (hitB) {
      dispatch({ type: "SET_SELECTION", selection: { kind: "bar", id: hitB.id } });
      canEdit = true;
    } else if (hitR) {
      dispatch({ type: "SET_SELECTION", selection: { kind: "region", id: hitR.id } });
    }
    if (hitB || hitR || s.selection) {
      setCtxMenu({ x: e.clientX, y: e.clientY, canEdit });
    }
  }, [dispatch, getWorldPos]);

  // Cursor style
  const getCursorStyle = (): string => {
    if (isPanning.current || spaceHeld.current) return "grab";
    if (dragModeRef.current === "move") return "grabbing";
    const s = stateRef.current;
    if (s.tool === "select") {
      if (hover) return "pointer";
      return "default";
    }
    if (s.drawing) return "crosshair";
    return "crosshair";
  };

  // ── Renderizado ───────────────────────────────────────────────────────

  const { doc, view, selection, drawing, cursor } = state;
  const { panX, panY, zoom, showGrid, gridSize } = view;

  const svgEl = svgRef.current;
  const svgW = svgEl?.clientWidth ?? 800;
  const svgH = svgEl?.clientHeight ?? 600;
  const minZ = (0 - panX) / zoom, maxZ = (svgW - panX) / zoom;
  const maxY = panY / zoom, minY = -(svgH - panY) / zoom;
  const lineW = 1 / zoom;

  // Grid
  const gridLines: React.ReactNode[] = [];
  if (showGrid && zoom > 0.02) {
    const startZ = Math.floor(minZ / gridSize) * gridSize;
    const startY = Math.floor(minY / gridSize) * gridSize;
    const cntZ = Math.ceil((maxZ - startZ) / gridSize) + 1;
    const cntY = Math.ceil((maxY - startY) / gridSize) + 1;
    if (cntZ < 300 && cntY < 300) {
      for (let i = 0; i <= cntZ; i++) {
        const z = startZ + i * gridSize;
        const isMajor = z % (gridSize * 5) === 0;
        gridLines.push(<line key={`gz${i}`} x1={z} y1={minY} x2={z} y2={maxY}
          stroke={z === 0 ? C.axis : isMajor ? C.gridMajor : C.grid}
          strokeWidth={z === 0 ? lineW * 1.5 : lineW} />);
      }
      for (let i = 0; i <= cntY; i++) {
        const y = startY + i * gridSize;
        const isMajor = y % (gridSize * 5) === 0;
        gridLines.push(<line key={`gy${i}`} x1={minZ} y1={y} x2={maxZ} y2={y}
          stroke={y === 0 ? C.axis : isMajor ? C.gridMajor : C.grid}
          strokeWidth={y === 0 ? lineW * 1.5 : lineW} />);
      }
    }
  }

  // Regiones
  const regionEls = doc.regions.map((r) => {
    const sel = isElemSelected(selection, "region", r.id);
    const isHover = hover?.kind === "region" && hover.id === r.id;
    const d = regionPath(r.shape);
    if (!d) return null;
    const strokeColor = sel ? C.concreteSelected : (isHover ? C.concreteHover : C.concreteStroke);
    return (
      <path key={r.id} d={d}
        fill={r.is_void ? C.concreteVoid : C.concrete}
        fillOpacity={r.is_void ? 0 : (isHover ? 0.55 : 0.45)}
        stroke={strokeColor}
        strokeWidth={sel ? lineW * 2.5 : (isHover ? lineW * 1.8 : lineW)}
        fillRule="evenodd"
        style={{ cursor: state.tool === "select" ? "pointer" : "default", transition: "fill-opacity 100ms, stroke-width 100ms" }}
      />
    );
  });

  // Barras — con halo si hover/selected, y desplazamiento visual si dragPreview
  const barEls = doc.bars.map((b) => {
    const sel = isElemSelected(selection, "bar", b.id);
    const isHover = hover?.kind === "bar" && hover.id === b.id;
    const isBeingDragged = dragModeRef.current === "move" && sel && dragPreview;
    const r = BAR_DIAMETERS_MM[b.bar_size] / 2;
    const displayR = Math.max(r, 4 / zoom);
    // Visual position: si es la barra arrastrada, aplicar delta
    const posY = isBeingDragged ? b.y + (dragPreview?.dy ?? 0) : b.y;
    const posZ = isBeingDragged ? b.z + (dragPreview?.dz ?? 0) : b.z;
    return (
      <g key={b.id}>
        {(sel || isHover) && (
          <circle cx={posZ} cy={posY} r={displayR * (isHover && !sel ? 1.6 : 2.0)}
            fill={C.barHalo} opacity={sel ? 0.8 : 0.5}
            style={{ transition: "r 120ms, opacity 120ms" }}
          />
        )}
        <circle cx={posZ} cy={posY} r={displayR * (isHover ? 1.1 : 1.0)}
          fill={sel ? C.barSelected : (isHover ? C.barHover : C.bar)}
          stroke={sel ? "#fde68a" : C.barStroke}
          strokeWidth={lineW * (sel ? 1.5 : 1)}
          style={{ cursor: state.tool === "select" ? "pointer" : "default", transition: "r 100ms" }}
        />
      </g>
    );
  });

  // Guías de alineación al arrastrar
  let guidesEl: React.ReactNode = null;
  if (dragPreview && (dragPreview.snappedY || dragPreview.snappedZ)) {
    guidesEl = (
      <g pointerEvents="none">
        {dragPreview.snappedY && (
          <line x1={minZ} y1={dragPreview.curY} x2={maxZ} y2={dragPreview.curY}
            stroke={C.guide} strokeWidth={lineW * 0.8} strokeDasharray={`${6/zoom} ${3/zoom}`} opacity={0.85} />
        )}
        {dragPreview.snappedZ && (
          <line x1={dragPreview.curZ} y1={minY} x2={dragPreview.curZ} y2={maxY}
            stroke={C.guide} strokeWidth={lineW * 0.8} strokeDasharray={`${6/zoom} ${3/zoom}`} opacity={0.85} />
        )}
        {/* Snap ring cuando alineado en ambos ejes */}
        {dragPreview.snappedY && dragPreview.snappedZ && (
          <circle cx={dragPreview.curZ} cy={dragPreview.curY} r={8 / zoom}
            fill="none" stroke={C.snap} strokeWidth={lineW * 1.5} opacity={0.9} />
        )}
      </g>
    );
  }

  // Delta cotas al arrastrar (etiqueta con dy, dz)
  let deltaLabel: React.ReactNode = null;
  if (dragPreview) {
    const { dy, dz, curY, curZ } = dragPreview;
    const label = `Δy=${dy >= 0 ? "+" : ""}${dy.toFixed(1)}  Δz=${dz >= 0 ? "+" : ""}${dz.toFixed(1)}`;
    deltaLabel = (
      <g pointerEvents="none">
        <rect
          x={curZ + 12 / zoom} y={curY - 30 / zoom}
          width={95 / zoom} height={20 / zoom} rx={4 / zoom}
          fill={C.snap} opacity={0.92}
        />
        <text x={curZ + 60 / zoom} y={curY - 16 / zoom}
          textAnchor="middle"
          transform={`scale(${1/zoom},${-1/zoom}) translate(${(curZ + 60/zoom) * (zoom - 1)},${(curY - 16/zoom) * (-zoom - 1)})`}
          fontSize={10} fontFamily="monospace" fontWeight="600" fill="white"
        >{label}</text>
      </g>
    );
  }

  // Preview de dibujo
  let previewEl: React.ReactNode = null;
  if (drawing) {
    if (drawing.tool === "rect") {
      const x = Math.min(drawing.startZ, cursor.z), y = Math.min(drawing.startY, cursor.y);
      previewEl = <rect x={x} y={y} width={Math.abs(cursor.z - drawing.startZ)} height={Math.abs(cursor.y - drawing.startY)}
        fill={C.preview} stroke={C.previewStroke} strokeWidth={lineW} strokeDasharray={`${6/zoom},${3/zoom}`} />;
    } else if (drawing.tool === "circle") {
      const r = Math.hypot(cursor.z - drawing.cz, cursor.y - drawing.cy);
      previewEl = <circle cx={drawing.cz} cy={drawing.cy} r={r}
        fill={C.preview} stroke={C.previewStroke} strokeWidth={lineW} strokeDasharray={`${6/zoom},${3/zoom}`} />;
    } else if (drawing.tool === "polygon" && drawing.vertices.length > 0) {
      const pts = [...drawing.vertices, [cursor.y, cursor.z] as [number, number]].map(([vy, vz]) => `${vz},${vy}`).join(" ");
      previewEl = <>
        <polygon points={pts} fill={C.polygon} stroke={C.polygonStroke} strokeWidth={lineW} strokeDasharray={`${6/zoom},${3/zoom}`} />
        {drawing.vertices.map(([vy, vz], i) => (
          <circle key={i} cx={vz} cy={vy} r={4/zoom}
            fill={i === 0 ? C.previewStroke : "white"} stroke={C.previewStroke} strokeWidth={lineW} />
        ))}
      </>;
    } else if (drawing.tool === "line") {
      previewEl = <>
        <line x1={drawing.startZ} y1={drawing.startY} x2={cursor.z} y2={cursor.y}
          stroke={C.previewStroke} strokeWidth={lineW * 1.5} strokeDasharray={`${8/zoom},${4/zoom}`} />
        <circle cx={drawing.startZ} cy={drawing.startY} r={4/zoom} fill={C.previewStroke} stroke="none" />
        <circle cx={cursor.z} cy={cursor.y} r={4/zoom} fill="none" stroke={C.previewStroke} strokeWidth={lineW} />
      </>;
    }
  }

  // Cotas + centroide + ejes de la región seleccionada
  let cotasEl: React.ReactNode = null;
  let centroidEl: React.ReactNode = null;
  if (selection?.kind === "region") {
    const selRegion = doc.regions.find((r) => r.id === selection.id);
    if (selRegion) {
      cotasEl = <DimLines shape={selRegion.shape} zoom={zoom} color={C.concreteSelected} />;
      const c = regionCenter(selRegion.shape);
      centroidEl = (
        <g pointerEvents="none">
          {/* Crosshair del centroide */}
          <line x1={c.z - 12/zoom} y1={c.y} x2={c.z + 12/zoom} y2={c.y} stroke={C.centroid} strokeWidth={lineW * 1.5} />
          <line x1={c.z} y1={c.y - 12/zoom} x2={c.z} y2={c.y + 12/zoom} stroke={C.centroid} strokeWidth={lineW * 1.5} />
          <circle cx={c.z} cy={c.y} r={3/zoom} fill={C.centroid} />
          <circle cx={c.z} cy={c.y} r={8/zoom} fill="none" stroke={C.centroid} strokeWidth={lineW * 0.5} opacity={0.5} />
        </g>
      );
    }
  }

  // Recuadro de selección múltiple
  const boxEl = boxRect ? (
    <rect
      x={Math.min(boxRect.sZ, boxRect.cZ)} y={Math.min(boxRect.sY, boxRect.cY)}
      width={Math.abs(boxRect.cZ - boxRect.sZ)} height={Math.abs(boxRect.cY - boxRect.sY)}
      fill={C.boxFill} stroke={C.boxStroke} strokeWidth={lineW}
      strokeDasharray={`${4/zoom},${3/zoom}`} pointerEvents="none"
    />
  ) : null;

  // Crosshair de cursor
  const crosshair = state.tool !== "select" || drawing ? (
    <g opacity={0.35} pointerEvents="none">
      <line x1={cursor.z} y1={minY} x2={cursor.z} y2={maxY} stroke={C.previewStroke} strokeWidth={lineW * 0.5} strokeDasharray={`${4/zoom},${4/zoom}`} />
      <line x1={minZ} y1={cursor.y} x2={maxZ} y2={cursor.y} stroke={C.previewStroke} strokeWidth={lineW * 0.5} strokeDasharray={`${4/zoom},${4/zoom}`} />
    </g>
  ) : null;

  // Barra en edición
  const editingBar = editingBarId ? doc.bars.find((b) => b.id === editingBarId) : null;

  return (
    <div className="relative h-full w-full">
      <svg
        ref={svgRef}
        className="block h-full w-full select-none"
        style={{ cursor: getCursorStyle() }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onWheel={handleWheel}
        onContextMenu={handleContextMenu}
        onDoubleClick={handleDoubleClick}
      >
        <g transform={`translate(${panX},${panY}) scale(${zoom},${-zoom})`}>
          {gridLines}
          {regionEls}
          {barEls}
          {cotasEl}
          {centroidEl}
          {previewEl}
          {boxEl}
          {crosshair}
          {guidesEl}
          {deltaLabel}
        </g>

        {/* HUD — coordenadas y modo */}
        <g style={{ pointerEvents: "none" }}>
          <text x={12} y={svgH - 12} fill="var(--color-text-muted)" fontSize={10} fontFamily="monospace">
            y={cursor.y.toFixed(0)} mm · z={cursor.z.toFixed(0)} mm · ×{zoom.toFixed(2)}
          </text>
          {state.tool !== "select" && (
            <text x={12} y={20} fill="var(--color-accent)" fontSize={11} fontFamily="monospace" fontWeight="600">
              {state.tool === "rect"    ? "▭ Rectángulo — arrastrar"
              : state.tool === "circle" ? "◯ Círculo — arrastrar"
              : state.tool === "polygon"? "⬡ Polígono — clic para vértice · Esc para cerrar"
              : state.tool === "bar"    ? "• Barra — clic para colocar"
              : state.tool === "line"   ? "╌ Línea — arrastrar"
              : ""}
            </text>
          )}
        </g>

        {/* Mini axes (esquina inferior izquierda) */}
        <MiniAxes size={40} x={20} y={svgH - 60} colorY={C.axis} colorZ={C.axis} labelColor="var(--color-text-muted)" />
      </svg>

      {/* Tooltip flotante al hover */}
      {hover && !ctxMenu && !dragPreview && (
        <HoverTooltip hover={hover} doc={doc} />
      )}

      {/* Menú contextual */}
      {ctxMenu && (
        <ContextMenu
          ctx={ctxMenu}
          selection={selection}
          onEdit={() => { if (selection?.kind === "bar") setEditingBarId(selection.id); setCtxMenu(null); }}
          onDuplicate={() => {
            const sel = stateRef.current.selection;
            if (sel?.kind === "region") dispatch({ type: "DUPLICATE_REGION", id: sel.id });
            if (sel?.kind === "bar") dispatch({ type: "DUPLICATE_BAR", id: sel.id });
            setCtxMenu(null);
          }}
          onMove={() => {
            const delta = prompt("Mover por Δy Δz (mm), ej: 100 50");
            if (!delta) { setCtxMenu(null); return; }
            const parts = delta.trim().split(/[\s,]+/);
            const dy = parseFloat(parts[0] ?? "0") || 0;
            const dz = parseFloat(parts[1] ?? "0") || 0;
            dispatch({ type: "MOVE_SELECTION", dy, dz });
            setCtxMenu(null);
          }}
          onDelete={() => {
            const sel = stateRef.current.selection;
            if (sel?.kind === "region") dispatch({ type: "DELETE_REGION", id: sel.id });
            else if (sel?.kind === "bar") dispatch({ type: "DELETE_BAR", id: sel.id });
            else if (sel?.kind === "multi") dispatch({ type: "DELETE_SELECTION" });
            setCtxMenu(null);
          }}
        />
      )}

      {/* Diálogo edición barra */}
      {editingBar && (
        <BarEditDialog
          bar={editingBar}
          onChange={(updates) => dispatch({
            type: "UPDATE_BAR",
            id: editingBar.id,
            updates: updates as Partial<ReinforcementBar>,
          })}
          onClose={() => setEditingBarId(null)}
        />
      )}
    </div>
  );
}

// ── Tooltip flotante ──────────────────────────────────────────────────────

function HoverTooltip({ hover, doc }: {
  hover: { kind: "bar" | "region"; id: string; sx: number; sy: number };
  doc: EditorState["doc"];
}) {
  if (hover.kind === "bar") {
    const b = doc.bars.find((x) => x.id === hover.id);
    if (!b) return null;
    const dia = BAR_DIAMETERS_MM[b.bar_size];
    const area = Math.PI * (dia / 2) ** 2;
    return (
      <div
        className="pointer-events-none fixed z-30 rounded-lg border border-border bg-surface/95 px-3 py-2 shadow-xl backdrop-blur-sm"
        style={{ left: hover.sx + 14, top: hover.sy + 14 }}
      >
        <div className="flex items-center gap-2 border-b border-border pb-1 mb-1">
          <span className="h-2 w-2 rounded-full bg-amber-500" />
          <span className="text-[11px] font-bold text-text">Barra {b.bar_size}</span>
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10.5px] font-mono text-text-muted">
          <span>φ:</span>       <span className="text-text">{dia.toFixed(2)} mm</span>
          <span>As:</span>       <span className="text-text">{area.toFixed(0)} mm²</span>
          <span>y:</span>        <span className="text-text tabular-nums">{b.y.toFixed(1)} mm</span>
          <span>z:</span>        <span className="text-text tabular-nums">{b.z.toFixed(1)} mm</span>
        </div>
        <p className="mt-1 border-t border-border pt-1 text-[9.5px] text-text-muted italic">
          Doble-clic para editar
        </p>
      </div>
    );
  }
  // Región
  const r = doc.regions.find((x) => x.id === hover.id);
  if (!r) return null;
  const bb = getShapeBBox(r.shape);
  return (
    <div
      className="pointer-events-none fixed z-30 rounded-lg border border-border bg-surface/95 px-3 py-2 shadow-xl backdrop-blur-sm"
      style={{ left: hover.sx + 14, top: hover.sy + 14 }}
    >
      <div className="flex items-center gap-2 border-b border-border pb-1 mb-1">
        <span className="h-2 w-2 rounded-full bg-sky-500" />
        <span className="text-[11px] font-bold text-text">{r.label} {r.is_void ? "(hueco)" : ""}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10.5px] font-mono text-text-muted">
        <span>tipo:</span>  <span className="text-text">{r.shape.kind}</span>
        {bb && (
          <>
            <span>ancho:</span> <span className="text-text">{bb.wLabel}</span>
            <span>alto:</span>  <span className="text-text">{bb.hLabel}</span>
          </>
        )}
        <span>cover:</span> <span className="text-text">{r.cover_to_bar} mm</span>
      </div>
    </div>
  );
}

// ── Menú contextual premium ───────────────────────────────────────────────

function ContextMenu({ ctx, selection, onEdit, onDuplicate, onMove, onDelete }: {
  ctx: { x: number; y: number; canEdit: boolean };
  selection: Selection;
  onEdit: () => void;
  onDuplicate: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  const title = selection?.kind === "multi"
    ? `${selection.regionIds.length + selection.barIds.length} elementos`
    : selection?.kind === "region" ? "Región"
    : selection?.kind === "bar" ? "Barra"
    : "Elemento";
  const isMulti = selection?.kind === "multi";

  return (
    <div
      className="fixed z-[200] min-w-[200px] overflow-hidden rounded-xl border border-border bg-surface/98 shadow-2xl backdrop-blur-sm"
      style={{ left: ctx.x, top: ctx.y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="border-b border-border px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-text-muted">
        {title}
      </div>
      <div className="py-1">
        {ctx.canEdit && !isMulti && (
          <CtxItem Icon={IconEdit} label="Editar barra…" shortcut="Doble-clic" onClick={onEdit} accent />
        )}
        {!isMulti && (
          <CtxItem Icon={IconDuplicate} label="Duplicar" shortcut="Ctrl+D" onClick={onDuplicate} />
        )}
        <CtxItem Icon={IconMove} label="Mover por Δy Δz…" onClick={onMove} />
        {selection?.kind === "multi" && (
          <CtxItem Icon={IconAlign} label={`Elementos: ${selection.regionIds.length + selection.barIds.length}`} disabled />
        )}
      </div>
      <div className="border-t border-border py-1">
        <CtxItem Icon={IconTrash} label="Eliminar" shortcut="Del" onClick={onDelete} danger />
      </div>
    </div>
  );
}

function CtxItem({ Icon, label, shortcut, onClick, accent, danger, disabled }: {
  Icon: React.FC<{ size?: number }>;
  label: string;
  shortcut?: string;
  onClick?: () => void;
  accent?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  const colorCls = danger ? "text-danger hover:bg-danger/10"
    : accent ? "text-accent hover:bg-accent/10"
    : "text-text hover:bg-surface-2";
  return (
    <button
      onClick={onClick} disabled={disabled}
      className={`flex w-full items-center gap-3 px-3 py-1.5 text-left text-xs transition-colors
        ${colorCls} disabled:cursor-not-allowed disabled:opacity-40`}
    >
      <span className="flex h-5 w-5 items-center justify-center opacity-80"><Icon size={15} /></span>
      <span className="flex-1 font-medium">{label}</span>
      {shortcut && <span className="text-[10px] font-mono text-text-muted">{shortcut}</span>}
    </button>
  );
}

// ── Mini axes ─────────────────────────────────────────────────────────────

function MiniAxes({ size, x, y, colorY, colorZ, labelColor }: {
  size: number; x: number; y: number; colorY: string; colorZ: string; labelColor: string;
}) {
  return (
    <g transform={`translate(${x},${y})`} pointerEvents="none">
      <circle cx={0} cy={0} r={2} fill={labelColor} />
      {/* Y arrow (up) */}
      <line x1={0} y1={0} x2={0} y2={-size} stroke={colorY} strokeWidth={1.5} />
      <path d={`M -3 ${-size + 5} L 0 ${-size} L 3 ${-size + 5}`} fill="none" stroke={colorY} strokeWidth={1.5} />
      <text x={4} y={-size + 4} fontSize={10} fontFamily="monospace" fill={labelColor}>Y</text>
      {/* Z arrow (right) */}
      <line x1={0} y1={0} x2={size} y2={0} stroke={colorZ} strokeWidth={1.5} />
      <path d={`M ${size - 5} -3 L ${size} 0 L ${size - 5} 3`} fill="none" stroke={colorZ} strokeWidth={1.5} />
      <text x={size - 4} y={-4} fontSize={10} fontFamily="monospace" fill={labelColor}>Z</text>
    </g>
  );
}
