// Estado y reducer del editor de secciones.
// Gestiona la sección activa, la herramienta seleccionada, el historial
// undo/redo, la vista (zoom/pan) y el estado de dibujo en curso.

import {
  SectionDocument,
  ConcreteRegion,
  ReinforcementBar,
  ConcreteDef,
  SteelDef,
  uid,
  defaultDocument,
} from "./section-document";

// ── Tipos de herramienta ──────────────────────────────────────────────────────

export type Tool = "select" | "rect" | "circle" | "polygon" | "bar" | "line";

// ── Selección activa ──────────────────────────────────────────────────────────

export type Selection =
  | { kind: "region"; id: string }
  | { kind: "bar"; id: string }
  | { kind: "multi"; regionIds: string[]; barIds: string[] }
  | null;

// ── Estado de dibujo en curso ─────────────────────────────────────────────────

export type DrawingState =
  | { tool: "rect"; startY: number; startZ: number }
  | { tool: "circle"; cy: number; cz: number }
  | { tool: "polygon"; vertices: [number, number][] }
  | { tool: "line"; startY: number; startZ: number }
  | null;

// ── Vista (viewport) ──────────────────────────────────────────────────────────

export interface ViewState {
  panX: number;   // pixels — traslación horizontal del canvas
  panY: number;   // pixels — traslación vertical del canvas
  zoom: number;   // pixels por mm (escala)
  showGrid: boolean;
  gridSize: number;  // mm — tamaño de la cuadrícula
  snapEnabled: boolean;
}

// ── Estado global del editor ──────────────────────────────────────────────────

export interface EditorState {
  doc: SectionDocument;
  history: SectionDocument[];  // stack undo (más reciente al final)
  future: SectionDocument[];   // stack redo
  selection: Selection;
  tool: Tool;
  drawing: DrawingState;
  cursor: { y: number; z: number };  // posición en coordenadas mm
  view: ViewState;
  isDirty: boolean;
}

// ── Acciones ──────────────────────────────────────────────────────────────────

export type EditorAction =
  // Herramientas y selección
  | { type: "SET_TOOL"; tool: Tool }
  | { type: "SET_SELECTION"; selection: Selection }
  | { type: "SET_CURSOR"; y: number; z: number }
  | { type: "SET_DRAWING"; drawing: DrawingState }
  // Regiones
  | { type: "ADD_REGION"; region: ConcreteRegion }
  | { type: "UPDATE_REGION"; id: string; updates: Partial<ConcreteRegion> }
  | { type: "DELETE_REGION"; id: string }
  // Barras
  | { type: "ADD_BAR"; bar: ReinforcementBar }
  | { type: "ADD_BARS"; bars: ReinforcementBar[] }
  | { type: "UPDATE_BAR"; id: string; updates: Partial<ReinforcementBar> }
  | { type: "DELETE_BAR"; id: string }
  // Duplicar
  | { type: "DUPLICATE_REGION"; id: string }
  | { type: "DUPLICATE_BAR"; id: string }
  // Mover selección
  | { type: "MOVE_SELECTION"; dy: number; dz: number }
  | { type: "DELETE_SELECTION" }
  // Materiales
  | { type: "ADD_CONCRETE_DEF"; def: ConcreteDef }
  | { type: "UPDATE_CONCRETE_DEF"; id: string; updates: Partial<ConcreteDef> }
  | { type: "DELETE_CONCRETE_DEF"; id: string }
  | { type: "ADD_STEEL_DEF"; def: SteelDef }
  | { type: "UPDATE_STEEL_DEF"; id: string; updates: Partial<SteelDef> }
  | { type: "DELETE_STEEL_DEF"; id: string }
  // Historial
  | { type: "UNDO" }
  | { type: "REDO" }
  // Vista
  | { type: "SET_VIEW"; view: Partial<ViewState> }
  | { type: "PAN"; dx: number; dy: number }
  | { type: "ZOOM_AT"; factor: number; screenX: number; screenY: number }
  | { type: "FIT_VIEW"; canvasWidth: number; canvasHeight: number }
  // Persistencia
  | { type: "LOAD_DOCUMENT"; doc: SectionDocument }
  | { type: "MARK_SAVED" };

// ── Estado inicial ────────────────────────────────────────────────────────────

const MAX_HISTORY = 50;

export function initialState(doc?: SectionDocument): EditorState {
  return {
    doc: doc ?? defaultDocument(),
    history: [],
    future: [],
    selection: null,
    tool: "select",
    drawing: null,
    cursor: { y: 0, z: 0 },
    view: {
      panX: 0,
      panY: 0,
      zoom: 0.8,
      showGrid: true,
      gridSize: 50,
      snapEnabled: true,
    },
    isDirty: false,
  };
}

// ── Utilidades ────────────────────────────────────────────────────────────────

function saveHistory(state: EditorState): EditorState {
  return {
    ...state,
    history: [...state.history.slice(-MAX_HISTORY + 1), state.doc],
    future: [],
    isDirty: true,
  };
}

function updateDoc(state: EditorState, newDoc: SectionDocument): EditorState {
  const withHistory = saveHistory(state);
  return { ...withHistory, doc: newDoc };
}

// ── Reducer ───────────────────────────────────────────────────────────────────

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    // ── Herramienta y selección ──────────────────────────────────────────────
    case "SET_TOOL":
      return { ...state, tool: action.tool, drawing: null, selection: null };

    case "SET_SELECTION":
      return { ...state, selection: action.selection };

    case "SET_CURSOR":
      return { ...state, cursor: { y: action.y, z: action.z } };

    case "SET_DRAWING":
      return { ...state, drawing: action.drawing };

    // ── Regiones ──────────────────────────────────────────────────────────────
    case "ADD_REGION": {
      const newDoc = { ...state.doc, regions: [...state.doc.regions, action.region] };
      return {
        ...updateDoc(state, newDoc),
        drawing: null,
        selection: { kind: "region", id: action.region.id },
      };
    }

    case "UPDATE_REGION": {
      const regions = state.doc.regions.map((r) =>
        r.id === action.id ? { ...r, ...action.updates } : r
      );
      return updateDoc(state, { ...state.doc, regions });
    }

    case "DELETE_REGION": {
      const regions = state.doc.regions.filter((r) => r.id !== action.id);
      return {
        ...updateDoc(state, { ...state.doc, regions }),
        selection: state.selection?.kind === "region" && state.selection.id === action.id
          ? null : state.selection,
      };
    }

    // ── Barras ────────────────────────────────────────────────────────────────
    case "ADD_BAR": {
      const newDoc = { ...state.doc, bars: [...state.doc.bars, action.bar] };
      return {
        ...updateDoc(state, newDoc),
        selection: { kind: "bar", id: action.bar.id },
      };
    }

    case "ADD_BARS": {
      const newDoc = { ...state.doc, bars: [...state.doc.bars, ...action.bars] };
      return { ...updateDoc(state, newDoc), selection: null };
    }

    case "UPDATE_BAR": {
      const bars = state.doc.bars.map((b) =>
        b.id === action.id ? { ...b, ...action.updates } : b
      );
      return updateDoc(state, { ...state.doc, bars });
    }

    case "DELETE_BAR": {
      const bars = state.doc.bars.filter((b) => b.id !== action.id);
      return {
        ...updateDoc(state, { ...state.doc, bars }),
        selection: state.selection?.kind === "bar" && state.selection.id === action.id
          ? null : state.selection,
      };
    }

    case "DUPLICATE_REGION": {
      const orig = state.doc.regions.find((r) => r.id === action.id);
      if (!orig) return state;
      const s = orig.shape;
      const shifted =
        s.kind === "rect" ? { ...s, y: s.y + 50 } :
        s.kind === "circ" ? { ...s, y: s.y + s.radius + 20 } :
        { ...s, vertices: s.vertices.map(([y, z]) => [y + 50, z] as [number, number]) };
      const clone = { ...orig, id: uid(), label: `${orig.label} (copia)`, shape: shifted };
      const newDoc = { ...state.doc, regions: [...state.doc.regions, clone] };
      return { ...updateDoc(state, newDoc), selection: { kind: "region", id: clone.id } };
    }

    case "DUPLICATE_BAR": {
      const orig = state.doc.bars.find((b) => b.id === action.id);
      if (!orig) return state;
      const clone = { ...orig, id: uid(), y: orig.y + 30 };
      const newDoc = { ...state.doc, bars: [...state.doc.bars, clone] };
      return { ...updateDoc(state, newDoc), selection: { kind: "bar", id: clone.id } };
    }

    case "MOVE_SELECTION": {
      const { dy, dz } = action;
      const sel = state.selection;
      if (!sel) return state;
      const regionIds = sel.kind === "region" ? [sel.id] : sel.kind === "multi" ? sel.regionIds : [];
      const barIds = sel.kind === "bar" ? [sel.id] : sel.kind === "multi" ? sel.barIds : [];
      const regions = state.doc.regions.map((r) => {
        if (!regionIds.includes(r.id)) return r;
        const s = r.shape;
        const newShape =
          s.kind === "rect" ? { ...s, y: s.y + dy, z: s.z + dz } :
          s.kind === "circ" ? { ...s, y: s.y + dy, z: s.z + dz } :
          { ...s, vertices: s.vertices.map(([vy, vz]) => [vy + dy, vz + dz] as [number, number]) };
        return { ...r, shape: newShape };
      });
      const bars = state.doc.bars.map((b) =>
        barIds.includes(b.id) ? { ...b, y: b.y + dy, z: b.z + dz } : b
      );
      return updateDoc(state, { ...state.doc, regions, bars });
    }

    case "DELETE_SELECTION": {
      const sel = state.selection;
      if (!sel) return state;
      const regionIds = sel.kind === "region" ? [sel.id] : sel.kind === "multi" ? sel.regionIds : [];
      const barIds = sel.kind === "bar" ? [sel.id] : sel.kind === "multi" ? sel.barIds : [];
      const regions = state.doc.regions.filter((r) => !regionIds.includes(r.id));
      const bars = state.doc.bars.filter((b) => !barIds.includes(b.id));
      return { ...updateDoc(state, { ...state.doc, regions, bars }), selection: null };
    }

    // ── Materiales de concreto ────────────────────────────────────────────────
    case "ADD_CONCRETE_DEF": {
      const concrete_defs = [...state.doc.concrete_defs, action.def];
      return updateDoc(state, { ...state.doc, concrete_defs });
    }

    case "UPDATE_CONCRETE_DEF": {
      const concrete_defs = state.doc.concrete_defs.map((c) =>
        c.id === action.id ? { ...c, ...action.updates } : c
      );
      return updateDoc(state, { ...state.doc, concrete_defs });
    }

    case "DELETE_CONCRETE_DEF": {
      const concrete_defs = state.doc.concrete_defs.filter((c) => c.id !== action.id);
      return updateDoc(state, { ...state.doc, concrete_defs });
    }

    // ── Materiales de acero ───────────────────────────────────────────────────
    case "ADD_STEEL_DEF": {
      const steel_defs = [...state.doc.steel_defs, action.def];
      return updateDoc(state, { ...state.doc, steel_defs });
    }

    case "UPDATE_STEEL_DEF": {
      const steel_defs = state.doc.steel_defs.map((s) =>
        s.id === action.id ? { ...s, ...action.updates } : s
      );
      return updateDoc(state, { ...state.doc, steel_defs });
    }

    case "DELETE_STEEL_DEF": {
      const steel_defs = state.doc.steel_defs.filter((s) => s.id !== action.id);
      return updateDoc(state, { ...state.doc, steel_defs });
    }

    // ── Historial ─────────────────────────────────────────────────────────────
    case "UNDO": {
      if (!state.history.length) return state;
      const prev = state.history[state.history.length - 1];
      return {
        ...state,
        doc: prev,
        history: state.history.slice(0, -1),
        future: [state.doc, ...state.future],
        isDirty: true,
      };
    }

    case "REDO": {
      if (!state.future.length) return state;
      const next = state.future[0];
      return {
        ...state,
        doc: next,
        history: [...state.history, state.doc],
        future: state.future.slice(1),
        isDirty: true,
      };
    }

    // ── Vista ─────────────────────────────────────────────────────────────────
    case "SET_VIEW":
      return { ...state, view: { ...state.view, ...action.view } };

    case "PAN":
      return {
        ...state,
        view: { ...state.view, panX: state.view.panX + action.dx, panY: state.view.panY + action.dy },
      };

    case "ZOOM_AT": {
      const { factor, screenX, screenY } = action;
      const { panX, panY, zoom } = state.view;
      const newZoom = Math.max(0.1, Math.min(10, zoom * factor));
      // Mantener el punto bajo el cursor estático
      const newPanX = screenX - (screenX - panX) * (newZoom / zoom);
      const newPanY = screenY - (screenY - panY) * (newZoom / zoom);
      return { ...state, view: { ...state.view, zoom: newZoom, panX: newPanX, panY: newPanY } };
    }

    case "FIT_VIEW": {
      const { canvasWidth, canvasHeight } = action;
      const { doc } = state;
      if (!doc.regions.length && !doc.bars.length) {
        return {
          ...state,
          view: { ...state.view, zoom: 0.8, panX: canvasWidth / 2, panY: canvasHeight / 2 },
        };
      }
      // Calcular bounding box en mm
      const ys: number[] = [];
      const zs: number[] = [];
      for (const r of doc.regions) {
        const s = r.shape;
        if (s.kind === "rect") {
          ys.push(s.y - s.height / 2, s.y + s.height / 2);
          zs.push(s.z - s.width / 2, s.z + s.width / 2);
        } else if (s.kind === "circ") {
          ys.push(s.y - s.radius, s.y + s.radius);
          zs.push(s.z - s.radius, s.z + s.radius);
        } else {
          s.vertices.forEach(([vy, vz]) => { ys.push(vy); zs.push(vz); });
        }
      }
      for (const b of doc.bars) { ys.push(b.y); zs.push(b.z); }

      const minY = Math.min(...ys), maxY = Math.max(...ys);
      const minZ = Math.min(...zs), maxZ = Math.max(...zs);
      const margin = 60;
      const dz = maxZ - minZ || 400;
      const dy = maxY - minY || 400;
      const zoomFit = Math.min(
        (canvasWidth - margin * 2) / dz,
        (canvasHeight - margin * 2) / dy,
        3.0,
      );
      const centerZ = (minZ + maxZ) / 2;
      const centerY = (minY + maxY) / 2;
      return {
        ...state,
        view: {
          ...state.view,
          zoom: zoomFit,
          panX: canvasWidth / 2 - centerZ * zoomFit,
          panY: canvasHeight / 2 + centerY * zoomFit,
        },
      };
    }

    // ── Persistencia ──────────────────────────────────────────────────────────
    case "LOAD_DOCUMENT":
      return { ...initialState(action.doc), isDirty: false };

    case "MARK_SAVED":
      return { ...state, isDirty: false };

    default:
      return state;
  }
}

// ── Helpers de conversión de coordenadas ──────────────────────────────────────

export function screenToWorld(
  screenX: number, screenY: number,
  view: ViewState,
): { y: number; z: number } {
  return {
    z: (screenX - view.panX) / view.zoom,
    y: -(screenY - view.panY) / view.zoom,
  };
}

export function worldToScreen(
  y: number, z: number,
  view: ViewState,
): { x: number; y: number } {
  return {
    x: z * view.zoom + view.panX,
    y: -y * view.zoom + view.panY,
  };
}

export function snapToGrid(val: number, gridSize: number): number {
  return Math.round(val / gridSize) * gridSize;
}
