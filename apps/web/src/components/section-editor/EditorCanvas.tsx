"use client";

import { useRef, useCallback, useEffect, useState } from "react";
import type { MouseEvent as RMouseEvent, WheelEvent as RWheelEvent } from "react";
import type { EditorState, EditorAction, Selection } from "@/lib/editor-state";
import { screenToWorld, snapToGrid } from "@/lib/editor-state";
import type { ConcreteRegion, ReinforcementBar, RegionShape } from "@/lib/section-document";
import { BAR_DIAMETERS_MM, uid } from "@/lib/section-document";
import { useTheme } from "@/lib/theme";

// ── Props ──────────────────────────────────────────────────────────────────────

interface Props {
  state: EditorState;
  dispatch: React.Dispatch<EditorAction>;
  onLineComplete?: (y1: number, z1: number, y2: number, z2: number) => void;
}

// ── Paletas de colores por tema ────────────────────────────────────────────────

const DARK_C = {
  grid:            "rgba(120,130,160,0.15)",
  gridMajor:       "rgba(120,130,160,0.30)",
  axis:            "rgba(120,130,160,0.50)",
  concrete:        "#4e8ab0",
  concreteVoid:    "transparent",
  concreteStroke:  "#2e6888",
  concreteSelected:"#2dd4e8",
  bar:             "#f59e0b",
  barSelected:     "#fbbf24",
  barStroke:       "#92400e",
  preview:         "rgba(45,212,232,0.25)",
  previewStroke:   "#2dd4e8",
  polygon:         "rgba(45,212,232,0.18)",
  polygonStroke:   "#2dd4e8",
  boxFill:         "rgba(45,212,232,0.08)",
  boxStroke:       "#2dd4e8",
};

const LIGHT_C = {
  grid:            "rgba(80,100,140,0.10)",
  gridMajor:       "rgba(80,100,140,0.22)",
  axis:            "rgba(60,80,130,0.40)",
  concrete:        "#5b8fc9",
  concreteVoid:    "rgba(190,210,240,0.35)",
  concreteStroke:  "#2c6090",
  concreteSelected:"#0e7fa8",
  bar:             "#d97706",
  barSelected:     "#f59e0b",
  barStroke:       "#78350f",
  preview:         "rgba(14,127,168,0.18)",
  previewStroke:   "#0e7fa8",
  polygon:         "rgba(14,127,168,0.12)",
  polygonStroke:   "#0e7fa8",
  boxFill:         "rgba(14,127,168,0.06)",
  boxStroke:       "#0e7fa8",
};

// ── Hit testing ────────────────────────────────────────────────────────────────

function pointInRect(y: number, z: number, shape: { y: number; z: number; height: number; width: number }): boolean {
  return Math.abs(z - shape.z) <= shape.width / 2 && Math.abs(y - shape.y) <= shape.height / 2;
}

function pointInCircle(y: number, z: number, shape: { y: number; z: number; radius: number }): boolean {
  return Math.hypot(z - shape.z, y - shape.y) <= shape.radius;
}

function pointInPolygon(y: number, z: number, vertices: [number, number][]): boolean {
  let inside = false;
  const n = vertices.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [yi, zi] = vertices[i];
    const [yj, zj] = vertices[j];
    if ((zi > z) !== (zj > z) && z < ((zj - zi) * (y - yi)) / (yj - yi) + zi) inside = !inside;
  }
  return inside;
}

function hitRegion(y: number, z: number, region: ConcreteRegion): boolean {
  const s = region.shape;
  if (s.kind === "rect") return pointInRect(y, z, s);
  if (s.kind === "circ") return pointInCircle(y, z, s);
  return pointInPolygon(y, z, s.vertices);
}

function hitBar(y: number, z: number, bar: ReinforcementBar, minRadiusMm: number): boolean {
  const r = Math.max(BAR_DIAMETERS_MM[bar.bar_size] / 2, minRadiusMm);
  return Math.hypot(z - bar.z, y - bar.y) <= r;
}

// ── Selección ─────────────────────────────────────────────────────────────────

function isElemSelected(sel: Selection, kind: "region" | "bar", id: string): boolean {
  if (!sel) return false;
  if (sel.kind === "region") return kind === "region" && sel.id === id;
  if (sel.kind === "bar") return kind === "bar" && sel.id === id;
  if (sel.kind === "multi") return kind === "region" ? sel.regionIds.includes(id) : sel.barIds.includes(id);
  return false;
}

function regionCenter(shape: RegionShape): { y: number; z: number } {
  if (shape.kind === "rect") return { y: shape.y, z: shape.z };
  if (shape.kind === "circ") return { y: shape.y, z: shape.z };
  const n = shape.vertices.length;
  const y = shape.vertices.reduce((s, [vy]) => s + vy, 0) / n;
  const z = shape.vertices.reduce((s, [, vz]) => s + vz, 0) / n;
  return { y, z };
}

// ── SVG path de formas ─────────────────────────────────────────────────────────

function regionPath(shape: RegionShape): string {
  if (shape.kind === "rect") {
    const { y, z, height: h, width: w } = shape;
    return `M ${z - w / 2} ${y - h / 2} h ${w} v ${h} h ${-w} Z`;
  }
  if (shape.kind === "circ") {
    const { y, z, radius: r, radius_inner: ri } = shape;
    const p = `M ${z + r} ${y} A ${r} ${r} 0 1 0 ${z - r} ${y} A ${r} ${r} 0 1 0 ${z + r} ${y} Z`;
    if (ri > 0) {
      return `${p} M ${z + ri} ${y} A ${ri} ${ri} 0 1 1 ${z - ri} ${y} A ${ri} ${ri} 0 1 1 ${z + ri} ${y} Z`;
    }
    return p;
  }
  if (shape.vertices.length < 2) return "";
  return `M ${shape.vertices.map(([vy, vz]) => `${vz} ${vy}`).join(" L ")} Z`;
}

// ── Componente canvas ──────────────────────────────────────────────────────────

export function EditorCanvas({ state, dispatch, onLineComplete }: Props) {
  const { theme } = useTheme();
  const C = theme === "dark" ? DARK_C : LIGHT_C;

  const svgRef = useRef<SVGSVGElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Refs de pan
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const isMouseDown = useRef(false);

  // ── Estado local para interacciones transitorias ───────────────────────────
  // (no van al reducer para no contaminar el historial undo)
  const [boxRect, setBoxRect] = useState<{ sY: number; sZ: number; cY: number; cZ: number } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  // Refs para modo de arrastre (evitan re-render en mousemove)
  const dragModeRef = useRef<"box" | "move" | null>(null);
  const dragStartRef = useRef<{ y: number; z: number } | null>(null);
  const moveDeltaRef = useRef<{ dy: number; dz: number }>({ dy: 0, dz: 0 });

  // ── Cerrar menú contextual al hacer clic fuera ─────────────────────────────
  useEffect(() => {
    if (!ctxMenu) return;
    const handler = () => setCtxMenu(null);
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [ctxMenu]);

  // ── Coordenadas pantalla → mundo ──────────────────────────────────────────

  const getWorldPos = useCallback((e: { clientX: number; clientY: number }, snap = true) => {
    const svg = svgRef.current;
    if (!svg) return { y: 0, z: 0 };
    const rect = svg.getBoundingClientRect();
    const raw = screenToWorld(e.clientX - rect.left, e.clientY - rect.top, stateRef.current.view);
    if (snap && stateRef.current.view.snapEnabled) {
      const gs = stateRef.current.view.gridSize;
      return { y: snapToGrid(raw.y, gs), z: snapToGrid(raw.z, gs) };
    }
    return raw;
  }, []);

  // ── Teclado ───────────────────────────────────────────────────────────────

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const s = stateRef.current;
      if (e.key === "Escape") {
        setBoxRect(null); dragModeRef.current = null;
        if (s.drawing) dispatch({ type: "SET_DRAWING", drawing: null });
        else dispatch({ type: "SET_SELECTION", selection: null });
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        const sel = s.selection;
        if (!sel) return;
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
        if (e.key === "s" || e.key === "S") dispatch({ type: "SET_TOOL", tool: "select" });
        if (e.key === "r" || e.key === "R") dispatch({ type: "SET_TOOL", tool: "rect" });
        if (e.key === "c" || e.key === "C") dispatch({ type: "SET_TOOL", tool: "circle" });
        if (e.key === "g" || e.key === "G") dispatch({ type: "SET_TOOL", tool: "polygon" });
        if (e.key === "b" || e.key === "B") dispatch({ type: "SET_TOOL", tool: "bar" });
        if (e.key === "l" || e.key === "L") dispatch({ type: "SET_TOOL", tool: "line" });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch]);

  // ── Mouse down ─────────────────────────────────────────────────────────────

  const handleMouseDown = useCallback((e: RMouseEvent<SVGSVGElement>) => {
    const s = stateRef.current;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    // Pan: botón medio o Alt+clic
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      e.preventDefault();
      isPanning.current = true;
      panStart.current = { x: sx, y: sy, panX: s.view.panX, panY: s.view.panY };
      return;
    }
    if (e.button === 2) return; // click derecho → contextMenu
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
            commitPolygon(s.drawing.vertices);
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
          // Arrastrar elemento ya seleccionado → modo mover
          dragModeRef.current = "move";
          dragStartRef.current = world;
          moveDeltaRef.current = { dy: 0, dz: 0 };
        } else if (hitElem) {
          // Seleccionar nuevo elemento
          dispatch({ type: "SET_SELECTION", selection: hitElem });
        } else {
          // Clic en vacío → inicio de recuadro de selección
          dragModeRef.current = "box";
          dragStartRef.current = world;
          setBoxRect({ sY: world.y, sZ: world.z, cY: world.y, cZ: world.z });
        }
        break;
      }
    }
  }, [dispatch, getWorldPos]);

  // ── Mouse move ─────────────────────────────────────────────────────────────

  const handleMouseMove = useCallback((e: RMouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (isPanning.current) {
      dispatch({ type: "SET_VIEW", view: {
        panX: panStart.current.panX + sx - panStart.current.x,
        panY: panStart.current.panY + sy - panStart.current.y,
      }});
      return;
    }

    const raw = screenToWorld(sx, sy, stateRef.current.view);
    const { view } = stateRef.current;
    const world = view.snapEnabled ? { y: snapToGrid(raw.y, view.gridSize), z: snapToGrid(raw.z, view.gridSize) } : raw;
    dispatch({ type: "SET_CURSOR", y: world.y, z: world.z });

    // Actualizar recuadro de selección
    if (dragModeRef.current === "box" && dragStartRef.current) {
      setBoxRect({ sY: dragStartRef.current.y, sZ: dragStartRef.current.z, cY: world.y, cZ: world.z });
    }

    // Acumular delta de mover
    if (dragModeRef.current === "move" && dragStartRef.current) {
      moveDeltaRef.current = { dy: world.y - dragStartRef.current.y, dz: world.z - dragStartRef.current.z };
    }
  }, [dispatch]);

  // ── Mouse up ───────────────────────────────────────────────────────────────

  const handleMouseUp = useCallback((e: RMouseEvent<SVGSVGElement>) => {
    if (isPanning.current) { isPanning.current = false; return; }

    const mode = dragModeRef.current;
    dragModeRef.current = null;

    if (mode === "box") {
      setBoxRect(null);
      const s = stateRef.current;
      const world = getWorldPos(e);
      const start = dragStartRef.current;
      if (!start) return;
      const minY = Math.min(start.y, world.y), maxY = Math.max(start.y, world.y);
      const minZ = Math.min(start.z, world.z), maxZ = Math.max(start.z, world.z);
      const boxW = maxZ - minZ, boxH = maxY - minY;
      if (boxW < 5 || boxH < 5) {
        dispatch({ type: "SET_SELECTION", selection: null });
        return;
      }
      // Encontrar elementos dentro del recuadro
      const regionIds = s.doc.regions
        .filter((r) => { const c = regionCenter(r.shape); return c.y >= minY && c.y <= maxY && c.z >= minZ && c.z <= maxZ; })
        .map((r) => r.id);
      const barIds = s.doc.bars
        .filter((b) => b.y >= minY && b.y <= maxY && b.z >= minZ && b.z <= maxZ)
        .map((b) => b.id);
      const total = regionIds.length + barIds.length;
      if (total === 0) {
        dispatch({ type: "SET_SELECTION", selection: null });
      } else if (total === 1) {
        dispatch({ type: "SET_SELECTION", selection: regionIds.length ? { kind: "region", id: regionIds[0] } : { kind: "bar", id: barIds[0] } });
      } else {
        dispatch({ type: "SET_SELECTION", selection: { kind: "multi", regionIds, barIds } });
      }
      dragStartRef.current = null;
      return;
    }

    if (mode === "move") {
      const { dy, dz } = moveDeltaRef.current;
      if (Math.abs(dy) > 0 || Math.abs(dz) > 0) {
        dispatch({ type: "MOVE_SELECTION", dy, dz });
      }
      dragStartRef.current = null;
      return;
    }

    if (!isMouseDown.current) return;
    isMouseDown.current = false;

    const s = stateRef.current;
    if (!s.drawing) return;
    const world = getWorldPos(e);

    if (s.drawing.tool === "rect") {
      const w = Math.abs(world.z - s.drawing.startZ);
      const h = Math.abs(world.y - s.drawing.startY);
      if (w < 5 || h < 5) { dispatch({ type: "SET_DRAWING", drawing: null }); return; }
      const cy = (world.y + s.drawing.startY) / 2;
      const cz = (world.z + s.drawing.startZ) / 2;
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
      const dy = world.y - s.drawing.startY;
      const dz = world.z - s.drawing.startZ;
      if (Math.hypot(dy, dz) < 5) { dispatch({ type: "SET_DRAWING", drawing: null }); return; }
      dispatch({ type: "SET_DRAWING", drawing: null });
      onLineComplete?.(s.drawing.startY, s.drawing.startZ, world.y, world.z);
    }
  }, [dispatch, getWorldPos, onLineComplete]);

  // ── Rueda del mouse ────────────────────────────────────────────────────────

  const handleWheel = useCallback((e: RWheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    dispatch({ type: "ZOOM_AT", factor, screenX: e.clientX - rect.left, screenY: e.clientY - rect.top });
  }, [dispatch]);

  // ── Click derecho → menú contextual ───────────────────────────────────────

  const handleContextMenu = useCallback((e: RMouseEvent<SVGSVGElement>) => {
    e.preventDefault();
    const s = stateRef.current;
    if (s.tool !== "select") { if (s.drawing) dispatch({ type: "SET_DRAWING", drawing: null }); return; }

    const world = getWorldPos(e, false);
    const minBarR = 6 / s.view.zoom;
    const hitB = s.doc.bars.find((b) => hitBar(world.y, world.z, b, minBarR));
    const hitR = [...s.doc.regions].reverse().find((r) => hitRegion(world.y, world.z, r));

    if (hitB) dispatch({ type: "SET_SELECTION", selection: { kind: "bar", id: hitB.id } });
    else if (hitR) dispatch({ type: "SET_SELECTION", selection: { kind: "region", id: hitR.id } });

    if (hitB || hitR || s.selection) {
      setCtxMenu({ x: e.clientX, y: e.clientY });
    }
  }, [dispatch, getWorldPos]);

  function commitPolygon(vertices: [number, number][]) {
    if (vertices.length < 3) { dispatch({ type: "SET_DRAWING", drawing: null }); return; }
    const defaultConcreteId = stateRef.current.doc.concrete_defs[0]?.id ?? "c0";
    dispatch({ type: "ADD_REGION", region: {
      id: uid(), label: "Región",
      shape: { kind: "poly", vertices },
      concrete_id: defaultConcreteId, confinement: null, cover_to_bar: 40, is_void: false, core_polygon: null,
    }});
  }

  // ── Cursor style según contexto ───────────────────────────────────────────

  const getCursorStyle = (): string => {
    if (dragModeRef.current === "move") return "grabbing";
    const s = stateRef.current;
    if (s.tool === "select") {
      // Detectar si estamos sobre elemento seleccionado (para mostrar grab)
      if (s.selection) return "default";
    }
    if (s.drawing) return "crosshair";
    return "default";
  };

  // ── Renderizado ───────────────────────────────────────────────────────────

  const { doc, view, selection, drawing, cursor } = state;
  const { panX, panY, zoom, showGrid, gridSize } = view;

  const svgEl = svgRef.current;
  const svgW = svgEl?.clientWidth ?? 800;
  const svgH = svgEl?.clientHeight ?? 600;
  const minZ = (0 - panX) / zoom;
  const maxZ = (svgW - panX) / zoom;
  const maxY = panY / zoom;
  const minY = -(svgH - panY) / zoom;
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
    const d = regionPath(r.shape);
    if (!d) return null;
    return (
      <path key={r.id} d={d}
        fill={r.is_void ? C.concreteVoid : C.concrete}
        fillOpacity={r.is_void ? 0 : 0.45}
        stroke={sel ? C.concreteSelected : C.concreteStroke}
        strokeWidth={sel ? lineW * 2.5 : lineW}
        fillRule="evenodd"
        style={{ cursor: state.tool === "select" ? "pointer" : "default" }}
      />
    );
  });

  // Barras
  const barEls = doc.bars.map((b) => {
    const sel = isElemSelected(selection, "bar", b.id);
    const r = BAR_DIAMETERS_MM[b.bar_size] / 2;
    const displayR = Math.max(r, 4 / zoom);
    return (
      <circle key={b.id} cx={b.z} cy={b.y} r={displayR}
        fill={sel ? C.barSelected : C.bar}
        stroke={sel ? "#fde68a" : C.barStroke}
        strokeWidth={lineW}
        style={{ cursor: state.tool === "select" ? "pointer" : "default" }}
      />
    );
  });

  // Preview de dibujo
  let previewEl: React.ReactNode = null;
  if (drawing) {
    if (drawing.tool === "rect") {
      const x = Math.min(drawing.startZ, cursor.z);
      const y = Math.min(drawing.startY, cursor.y);
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

  // Recuadro de selección múltiple
  const boxEl = boxRect ? (
    <rect
      x={Math.min(boxRect.sZ, boxRect.cZ)}
      y={Math.min(boxRect.sY, boxRect.cY)}
      width={Math.abs(boxRect.cZ - boxRect.sZ)}
      height={Math.abs(boxRect.cY - boxRect.sY)}
      fill={C.boxFill} stroke={C.boxStroke} strokeWidth={lineW}
      strokeDasharray={`${4/zoom},${3/zoom}`}
      pointerEvents="none"
    />
  ) : null;

  // Crosshair
  const crosshair = (
    <g opacity={0.4}>
      <line x1={cursor.z} y1={minY} x2={cursor.z} y2={maxY} stroke={C.previewStroke} strokeWidth={lineW * 0.5} strokeDasharray={`${4/zoom},${4/zoom}`} />
      <line x1={minZ} y1={cursor.y} x2={maxZ} y2={cursor.y} stroke={C.previewStroke} strokeWidth={lineW * 0.5} strokeDasharray={`${4/zoom},${4/zoom}`} />
    </g>
  );

  // Contar selección múltiple para info
  const multiInfo = selection?.kind === "multi"
    ? `${selection.regionIds.length + selection.barIds.length} elementos seleccionados`
    : null;

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
      >
        <g transform={`translate(${panX},${panY}) scale(${zoom},${-zoom})`}>
          {gridLines}
          {regionEls}
          {barEls}
          {previewEl}
          {boxEl}
          {crosshair}
        </g>

        {/* HUD — coordenadas y herramienta */}
        <text x={8} y={svgH - 8} fill="var(--color-text-muted)" fontSize={10} fontFamily="monospace">
          y={cursor.y.toFixed(0)} mm  z={cursor.z.toFixed(0)} mm  ×{zoom.toFixed(2)}
          {multiInfo ? `  ·  ${multiInfo}` : ""}
        </text>
        {state.tool !== "select" && (
          <text x={8} y={16} fill="var(--color-accent)" fontSize={10} fontFamily="monospace">
            {state.tool === "rect" ? "Rectángulo — arrastrar"
              : state.tool === "circle" ? "Círculo — arrastrar"
              : state.tool === "polygon" ? "Polígono — clic para vértice · Esc para cerrar"
              : state.tool === "bar" ? "Barra — clic para colocar"
              : "Línea — arrastrar"}
          </text>
        )}
        {state.tool === "select" && !selection && (
          <text x={8} y={16} fill="var(--color-text-muted)" fontSize={10} fontFamily="monospace">
            Clic para seleccionar · Arrastrar en vacío para recuadro múltiple
          </text>
        )}
      </svg>

      {/* Menú contextual */}
      {ctxMenu && (
        <div
          className="fixed z-[200] min-w-[160px] overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="border-b border-border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
            {selection?.kind === "multi"
              ? `${(selection.regionIds.length + selection.barIds.length)} elementos`
              : selection?.kind === "region" ? "Región"
              : selection?.kind === "bar" ? "Barra"
              : "Elemento"}
          </div>
          {/* Duplicar (solo elemento único) */}
          {selection?.kind !== "multi" && (
            <button
              className="w-full px-4 py-2 text-left text-xs text-text hover:bg-surface-2"
              onClick={() => {
                const sel = stateRef.current.selection;
                if (sel?.kind === "region") dispatch({ type: "DUPLICATE_REGION", id: sel.id });
                if (sel?.kind === "bar") dispatch({ type: "DUPLICATE_BAR", id: sel.id });
                setCtxMenu(null);
              }}
            >
              Duplicar
            </button>
          )}
          {/* Mover a posición */}
          <button
            className="w-full px-4 py-2 text-left text-xs text-text hover:bg-surface-2"
            onClick={() => {
              const delta = prompt("Mover por (dy dz) en mm, ej: 100 50");
              if (!delta) { setCtxMenu(null); return; }
              const parts = delta.trim().split(/[\s,]+/);
              const dy = parseFloat(parts[0] ?? "0") || 0;
              const dz = parseFloat(parts[1] ?? "0") || 0;
              dispatch({ type: "MOVE_SELECTION", dy, dz });
              setCtxMenu(null);
            }}
          >
            Mover por delta…
          </button>
          <div className="my-1 border-t border-border" />
          <button
            className="w-full px-4 py-2 text-left text-xs text-danger hover:bg-surface-2"
            onClick={() => {
              const sel = stateRef.current.selection;
              if (sel?.kind === "region") dispatch({ type: "DELETE_REGION", id: sel.id });
              else if (sel?.kind === "bar") dispatch({ type: "DELETE_BAR", id: sel.id });
              else if (sel?.kind === "multi") dispatch({ type: "DELETE_SELECTION" });
              setCtxMenu(null);
            }}
          >
            Eliminar
          </button>
        </div>
      )}
    </div>
  );
}
