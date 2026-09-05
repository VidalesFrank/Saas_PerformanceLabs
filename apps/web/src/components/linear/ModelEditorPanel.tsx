"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import type {
  ModelGeometry,
  FullModelData,
  ElementClickInfo,
  AssignSectionResult,
  ColorMode,
  ViewerTypeFilter,
  UndoAssignSection,
  FrameSummary,
  SectionData,
  ShellSummary,
} from "@/lib/structural-types";
import { structuralEditorApi } from "@/lib/structural-api";
import { LinearModelViewer3D } from "./LinearModelViewer3D";
import ModelPropertiesPanel from "./ModelPropertiesPanel";
import ModelSectionsPanel from "./ModelSectionsPanel";
import ModelMaterialsPanel from "./ModelMaterialsPanel";
import ModelHealthPanel from "./ModelHealthPanel";

// ── Types ──────────────────────────────────────────────────────────────────────

type RightPanelTab = "properties" | "sections" | "materials" | "health";
type UndoAction = UndoAssignSection;
type TableTab = "frames" | "shells" | "sections" | "materials";
type SortKey = "element_type" | "story" | "section" | "object_label";

interface ZoomBbox {
  xMin: number; xMax: number;
  yMin: number; yMax: number;
  zMin: number; zMax: number;
}

interface EditorState {
  selectedIds: Set<string>;
  multiSelectMode: boolean;
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function ToolbarBtn({
  active, onClick, children, title, disabled,
}: {
  active?: boolean; onClick: () => void; children: React.ReactNode;
  title?: string; disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={[
        "px-2.5 py-1 text-[11px] font-medium rounded-md border transition-colors select-none",
        "disabled:opacity-40 disabled:cursor-not-allowed",
        active
          ? "bg-accent/20 border-accent/60 text-accent"
          : "border-border text-text-muted hover:text-text hover:border-text-muted",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <div className="w-px h-5 bg-border mx-1 flex-shrink-0" />;
}

function SortIcon({ active, asc }: { active: boolean; asc: boolean }) {
  if (!active) return <span className="opacity-20 ml-0.5">↕</span>;
  return <span className="text-accent ml-0.5">{asc ? "↑" : "↓"}</span>;
}

// ── Context menu ───────────────────────────────────────────────────────────────

function CtxItem({
  onClick, children, danger,
}: { onClick: () => void; children: React.ReactNode; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={[
        "w-full text-left px-3 py-[5px] text-[11px] flex items-center gap-2 transition-colors",
        danger ? "text-danger hover:bg-danger/10" : "text-text hover:bg-surface-2",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

interface CtxMenuProps {
  x: number; y: number;
  nSelected: number;
  singleFrame: FrameSummary | null;
  singleShell: ShellSummary | null;
  singleSection: SectionData | null;
  onClose: () => void;
  onSelectByType: () => void;
  onSelectBySection: () => void;
  onSelectByMaterial: () => void;
  onSelectByStory: () => void;
  onIsolate: () => void;
  onZoom: () => void;
  onClearSel: () => void;
}

function ContextMenuPopup({
  x, y, nSelected, singleFrame, singleShell, singleSection,
  onClose, onSelectByType, onSelectBySection,
  onSelectByMaterial, onSelectByStory, onIsolate, onZoom, onClearSel,
}: CtxMenuProps) {
  useEffect(() => {
    const handler = () => onClose();
    window.addEventListener("mousedown", handler, { capture: true });
    return () => window.removeEventListener("mousedown", handler, { capture: true });
  }, [onClose]);

  const safeX = Math.min(x, (typeof window !== "undefined" ? window.innerWidth : 1200) - 240);
  const safeY = Math.min(y, (typeof window !== "undefined" ? window.innerHeight : 800) - 280);

  const typeLabel = singleShell
    ? (singleShell.element_type === "wall" ? "Muro" : "Losa")
    : singleFrame?.element_type === "column" ? "Columna" : "Viga";
  const secLabel   = (singleFrame?.section ?? singleShell?.section) || "—";
  const matLabel   = singleSection?.material || "—";
  const storyLabel = (singleFrame?.story ?? singleShell?.story) || "—";

  return (
    <div
      style={{ position: "fixed", top: safeY, left: safeX, zIndex: 9999 }}
      className="bg-surface border border-border rounded-xl shadow-2xl py-1.5 min-w-[220px]"
      onMouseDown={e => e.stopPropagation()}
    >
      <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-text-muted">
        {nSelected === 1 ? "1 elemento" : `${nSelected} elementos`}
      </div>

      {singleShell?.pier && (
        <div className="px-3 py-0.5 text-[10px] text-text-muted">
          Pier: <span className="text-text font-mono">{singleShell.pier}</span>
        </div>
      )}

      <div className="h-px bg-border/50 my-1" />

      <div className="px-3 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-text-muted">
        Seleccionar similares
      </div>
      <CtxItem onClick={onSelectByType}>
        <span className="opacity-50 text-xs">≡</span> Por tipo
        {(singleFrame || singleShell) && <span className="ml-auto text-accent text-[10px]">{typeLabel}</span>}
      </CtxItem>
      <CtxItem onClick={onSelectBySection}>
        <span className="opacity-50 text-xs">▣</span> Por sección
        {(singleFrame || singleShell) && (
          <span className="ml-auto text-accent text-[10px] max-w-[100px] truncate">{secLabel}</span>
        )}
      </CtxItem>
      <CtxItem onClick={onSelectByMaterial}>
        <span className="opacity-50 text-xs">◈</span> Por material
        {(singleFrame || singleShell) && (
          <span className="ml-auto text-accent text-[10px] max-w-[100px] truncate">{matLabel}</span>
        )}
      </CtxItem>
      <CtxItem onClick={onSelectByStory}>
        <span className="opacity-50 text-xs">━</span> Por piso
        {(singleFrame || singleShell) && <span className="ml-auto text-accent text-[10px]">{storyLabel}</span>}
      </CtxItem>

      <div className="h-px bg-border/50 my-1" />
      <CtxItem onClick={onIsolate}>⊙ Aislar selección</CtxItem>
      <CtxItem onClick={onZoom}>⊡ Zoom a selección</CtxItem>

      <div className="h-px bg-border/50 my-1" />
      <CtxItem onClick={onClearSel} danger>✕ Limpiar selección</CtxItem>
    </div>
  );
}

// ── Right panel tabs ───────────────────────────────────────────────────────────

const RIGHT_TABS: { id: RightPanelTab; label: string }[] = [
  { id: "properties", label: "Inspector" },
  { id: "sections",   label: "Secciones" },
  { id: "materials",  label: "Materiales" },
  { id: "health",     label: "Check" },
];

// Botón de grupo (sin bordes individuales, para usar dentro de TGroup)
function TBtn({ active, onClick, children, title }: {
  active?: boolean; onClick: () => void; children: React.ReactNode; title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={[
        "px-2.5 py-1 text-[11px] font-medium transition-colors select-none",
        active
          ? "bg-accent/20 text-accent"
          : "text-text-muted hover:text-text hover:bg-surface-2",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

// Grupo de botones con borde contenedor
function TGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex rounded-md overflow-hidden border border-border divide-x divide-border">
      {children}
    </div>
  );
}

// Fila de checkbox en el panel de display
function CheckRow({
  label, checked, onChange, color, colorValue, onColorChange,
}: {
  label: string; checked: boolean; onChange: (v: boolean) => void;
  color?: string; colorValue?: string; onColorChange?: (v: string) => void;
}) {
  return (
    <label className="flex items-center justify-between py-0.5 cursor-pointer group">
      <div className="flex items-center gap-2">
        <div
          className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
          style={{ background: color ?? "var(--color-text-muted)", opacity: checked ? 1 : 0.3 }}
        />
        <span className={["text-[11px] transition-colors", checked ? "text-text" : "text-text-muted"].join(" ")}>
          {label}
        </span>
      </div>
      <div className="flex items-center gap-1">
        {onColorChange && colorValue && (
          <input
            type="color"
            value={colorValue}
            onChange={e => onColorChange(e.target.value)}
            onClick={e => e.stopPropagation()}
            className="w-4 h-4 rounded cursor-pointer border-0 p-0 bg-transparent"
            title={`Color de ${label}`}
          />
        )}
        <input
          type="checkbox"
          checked={checked}
          onChange={e => onChange(e.target.checked)}
          className="w-3.5 h-3.5 rounded accent-[var(--color-accent)] cursor-pointer"
        />
      </div>
    </label>
  );
}

// Fila de select en el panel de display
function FilterRow({
  label, value, options, onChange,
}: {
  label: string;
  value: string | null;
  options: string[];
  onChange: (v: string | null) => void;
}) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-[11px] text-text-muted">{label}</span>
      <select
        value={value ?? ""}
        onChange={e => onChange(e.target.value || null)}
        className={[
          "text-[10px] rounded border px-1 py-0.5 max-w-[110px] focus:outline-none focus:border-accent",
          value
            ? "border-accent bg-accent/10 text-accent"
            : "border-border bg-surface-2 text-text",
        ].join(" ")}
      >
        <option value="">Todos</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

interface Props {
  projectId: string;
  geometry: ModelGeometry;
  onLaunchAnalysis?: (type: "modal" | "spectral") => void;
  analysisRunning?: boolean;
}

export default function ModelEditorPanel({
  projectId, geometry, onLaunchAnalysis, analysisRunning,
}: Props) {

  // ── Selection + view state ─────────────────────────────────────────────────
  const [state, setState] = useState<EditorState>({
    selectedIds: new Set(),
    multiSelectMode: false,
  });
  const [viewMode, setViewMode]     = useState<"lines" | "extruded">("lines");
  const [colorMode, setColorMode]   = useState<ColorMode>("type");
  const [storyFilter, setStoryFilter]       = useState<string | null>(null);
  const [pierFilter, setPierFilter]         = useState<string | null>(null);
  const [sectionFilter, setSectionFilter]   = useState<string | null>(null);
  const [materialFilter, setMaterialFilter] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<ViewerTypeFilter>({
    columns: true, beams: true, walls: true, slabs: false,
  });
  const [isolationMode, setIsolationMode] = useState(false);
  const [showLoads, setShowLoads]           = useState(false);
  const [showNodes, setShowNodes]           = useState(false);
  const [cameraViewMode, setCameraViewMode] = useState<"3d" | "plan" | "elevX" | "elevY">("3d");
  const [wallColor, setWallColor]           = useState("#10B981");
  const [slabColor, setSlabColor]           = useState("#F59E0B");
  const [shellLoadPattern, setShellLoadPattern] = useState<string | null>(null);
  const [showDisplay, setShowDisplay]       = useState(false);
  const [leftTab, setLeftTab]               = useState<"model" | "stories" | "sections">("model");

  // ── Right panel ────────────────────────────────────────────────────────────
  const [rightPanel, setRightPanel] = useState<RightPanelTab>("properties");

  // ── Model data ─────────────────────────────────────────────────────────────
  const [modelData, setModelData]       = useState<FullModelData | null>(null);
  const [loadingModel, setLoadingModel] = useState(true);
  const [modelError, setModelError]     = useState<string | null>(null);

  // ── Undo / redo ────────────────────────────────────────────────────────────
  const [undoStack, setUndoStack] = useState<UndoAction[]>([]);
  const [redoStack, setRedoStack] = useState<UndoAction[]>([]);
  const [undoing, setUndoing]     = useState(false);
  const [modelModified, setModelModified] = useState(false);

  // ── Context menu ───────────────────────────────────────────────────────────
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  // ── Tables panel ──────────────────────────────────────────────────────────
  const [showTables, setShowTables] = useState(false);
  const [tableTab, setTableTab]     = useState<TableTab>("frames");
  const [tableSearch, setTableSearch] = useState("");
  const [sortKey, setSortKey]   = useState<SortKey>("story");
  const [sortAsc, setSortAsc]   = useState(true);

  // ── Zoom to selection ──────────────────────────────────────────────────────
  const [zoomBbox, setZoomBbox] = useState<ZoomBbox | null>(null);

  // ── Load model data ────────────────────────────────────────────────────────
  const loadModelData = useCallback(async () => {
    setLoadingModel(true);
    setModelError(null);
    try {
      const data = await structuralEditorApi.modelData(projectId);
      setModelData(data);
    } catch (e) {
      setModelError(e instanceof Error ? e.message : "Error al cargar el modelo");
    } finally {
      setLoadingModel(false);
    }
  }, [projectId]);

  useEffect(() => { loadModelData(); }, [loadModelData]);

  // ── Selection handlers ─────────────────────────────────────────────────────
  const handleClickElement = useCallback((id: string, _info: ElementClickInfo) => {
    setState(prev => {
      const next = new Set(prev.selectedIds);
      if (prev.multiSelectMode) {
        if (next.has(id)) next.delete(id); else next.add(id);
      } else {
        if (next.size === 1 && next.has(id)) next.clear();
        else { next.clear(); next.add(id); }
      }
      return { ...prev, selectedIds: next };
    });
    setRightPanel("properties");
    setCtxMenu(null);
  }, []);

  function clearSelection() {
    setState(prev => ({ ...prev, selectedIds: new Set() }));
    setIsolationMode(false);
    setCtxMenu(null);
  }

  function selectByType(type: "column" | "beam") {
    if (!modelData) return;
    setState(prev => ({
      ...prev,
      selectedIds: new Set(
        Object.entries(modelData.frames)
          .filter(([, f]) => f.element_type === type)
          .map(([id]) => id),
      ),
    }));
    setRightPanel("properties");
  }

  function selectByStory(story: string) {
    if (!modelData) return;
    const frameIds = Object.entries(modelData.frames)
      .filter(([, f]) => f.story === story)
      .map(([id]) => id);
    const shellIds = Object.entries(modelData.shells ?? {})
      .filter(([, s]) => s.story === story)
      .map(([id]) => id);
    setState(prev => ({
      ...prev,
      selectedIds: new Set([...frameIds, ...shellIds]),
    }));
    setRightPanel("properties");
  }

  function selectBySection(section: string) {
    if (!modelData) return;
    setState(prev => ({
      ...prev,
      selectedIds: new Set(
        Object.entries(modelData.frames)
          .filter(([, f]) => f.section === section)
          .map(([id]) => id),
      ),
    }));
    setRightPanel("properties");
  }

  function selectByMaterial(material: string) {
    if (!modelData) return;
    setState(prev => ({
      ...prev,
      selectedIds: new Set(
        Object.entries(modelData.frames)
          .filter(([, f]) => modelData.sections[f.section]?.material === material)
          .map(([id]) => id),
      ),
    }));
    setRightPanel("properties");
  }

  function selectByShellType(type: "wall" | "slab") {
    if (!modelData) return;
    setState(prev => ({
      ...prev,
      selectedIds: new Set(
        Object.entries(modelData.shells ?? {})
          .filter(([, s]) => s.element_type === type)
          .map(([id]) => id),
      ),
    }));
    setRightPanel("properties");
  }

  // ── Zoom to selection ──────────────────────────────────────────────────────
  function triggerZoom() {
    if (!modelData || state.selectedIds.size === 0) return;
    let xMin = Infinity, xMax = -Infinity;
    let yMin = Infinity, yMax = -Infinity;
    let zMin = Infinity, zMax = -Infinity;
    for (const id of state.selectedIds) {
      const frame = modelData.frames[id];
      if (!frame) continue;
      for (const jid of [frame.joint_i, frame.joint_j]) {
        const j = modelData.joints[String(jid)];
        if (!j) continue;
        xMin = Math.min(xMin, j.x); xMax = Math.max(xMax, j.x);
        yMin = Math.min(yMin, j.y); yMax = Math.max(yMax, j.y);
        zMin = Math.min(zMin, j.z); zMax = Math.max(zMax, j.z);
      }
    }
    if (!isFinite(xMin)) return;
    setZoomBbox({ xMin, xMax, yMin, yMax, zMin, zMax });
    setTimeout(() => setZoomBbox(null), 300);
  }

  function triggerStoryZoom(story: string) {
    let xMin = Infinity, xMax = -Infinity;
    let yMin = Infinity, yMax = -Infinity;
    let zMin = Infinity, zMax = -Infinity;

    for (const [, frame] of Object.entries(geometry.frames)) {
      if (frame.story !== story) continue;
      for (const jid of [frame.joint_i, frame.joint_j]) {
        const j = geometry.joints[String(jid)];
        if (!j) continue;
        xMin = Math.min(xMin, j.x); xMax = Math.max(xMax, j.x);
        yMin = Math.min(yMin, j.y); yMax = Math.max(yMax, j.y);
        zMin = Math.min(zMin, j.z); zMax = Math.max(zMax, j.z);
      }
    }
    for (const [, shell] of Object.entries(geometry.shells ?? {})) {
      if (shell.story !== story) continue;
      for (const jid of shell.joints) {
        const j = geometry.joints[String(jid)];
        if (!j) continue;
        xMin = Math.min(xMin, j.x); xMax = Math.max(xMax, j.x);
        yMin = Math.min(yMin, j.y); yMax = Math.max(yMax, j.y);
        zMin = Math.min(zMin, j.z); zMax = Math.max(zMax, j.z);
      }
    }
    if (!isFinite(xMin)) return;
    setZoomBbox({ xMin, xMax, yMin, yMax, zMin, zMax });
    setTimeout(() => setZoomBbox(null), 300);
  }

  // ── Undo / redo ────────────────────────────────────────────────────────────
  function handleSectionAssigned(result: AssignSectionResult) {
    const action: UndoAssignSection = {
      type: "assign_section",
      previous_sections: result.previous_sections,
      new_section: result.section_assigned,
      frame_ids: result.updated_ids,
    };
    setUndoStack(prev => [...prev, action]);
    setRedoStack([]);
    loadModelData();
  }

  async function handleUndo() {
    const action = undoStack[undoStack.length - 1];
    if (!action) return;
    setUndoing(true);
    try {
      if (action.type === "assign_section") {
        await structuralEditorApi.restoreSections(projectId, action.previous_sections);
        setUndoStack(prev => prev.slice(0, -1));
        setRedoStack(prev => [...prev, action]);
        await loadModelData();
      }
    } finally { setUndoing(false); }
  }

  async function handleRedo() {
    const action = redoStack[redoStack.length - 1];
    if (!action) return;
    setUndoing(true);
    try {
      if (action.type === "assign_section") {
        const assignments = Object.fromEntries(action.frame_ids.map(id => [id, action.new_section]));
        await structuralEditorApi.restoreSections(projectId, assignments);
        setRedoStack(prev => prev.slice(0, -1));
        setUndoStack(prev => [...prev, action]);
        await loadModelData();
      }
    } finally { setUndoing(false); }
  }

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { clearSelection(); setCtxMenu(null); }
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault(); handleUndo();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
        e.preventDefault(); handleRedo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        if (modelData) setState(prev => ({ ...prev, selectedIds: new Set(Object.keys(modelData.frames)) }));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undoStack, redoStack, modelData]);

  // ── Context menu ───────────────────────────────────────────────────────────
  function handleViewportContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    if (state.selectedIds.size > 0) {
      setCtxMenu({ x: e.clientX, y: e.clientY });
    }
  }

  function getCtxSingleInfo(): { frame: FrameSummary | null; section: SectionData | null; shell: ShellSummary | null } {
    if (state.selectedIds.size !== 1 || !modelData) return { frame: null, section: null, shell: null };
    const id = [...state.selectedIds][0];
    const frame = modelData.frames[id] ?? null;
    const shell = frame ? null : (modelData.shells?.[id] ?? null);
    const section = frame ? (modelData.sections[frame.section] ?? null) : null;
    return { frame, section, shell };
  }

  // ── Table data (memoized for performance) ──────────────────────────────────
  const tableFrames = useMemo(() => {
    if (!modelData) return [];
    let entries = Object.entries(modelData.frames);
    if (tableSearch.trim()) {
      const q = tableSearch.toLowerCase();
      entries = entries.filter(([id, f]) =>
        id.toLowerCase().includes(q) ||
        (f.object_label ?? "").toLowerCase().includes(q) ||
        f.section.toLowerCase().includes(q) ||
        f.story.toLowerCase().includes(q) ||
        f.element_type.toLowerCase().includes(q),
      );
    }
    entries.sort(([idA, a], [idB, b]) => {
      let va = "", vb = "";
      if (sortKey === "element_type") { va = a.element_type; vb = b.element_type; }
      else if (sortKey === "story")   { va = a.story;        vb = b.story; }
      else if (sortKey === "section") { va = a.section;      vb = b.section; }
      else                            { va = a.object_label ?? idA; vb = b.object_label ?? idB; }
      const cmp = va.localeCompare(vb, undefined, { numeric: true });
      return sortAsc ? cmp : -cmp;
    });
    return entries;
  }, [modelData, tableSearch, sortKey, sortAsc]);

  const tableShells = useMemo(() => {
    if (!modelData) return [] as [string, ShellSummary][];
    let entries = Object.entries(modelData.shells ?? {}) as [string, ShellSummary][];
    if (tableSearch.trim()) {
      const q = tableSearch.toLowerCase();
      entries = entries.filter(([id, s]) =>
        id.toLowerCase().includes(q) ||
        s.story.toLowerCase().includes(q) ||
        s.section.toLowerCase().includes(q) ||
        (s.pier ?? "").toLowerCase().includes(q) ||
        s.element_type.toLowerCase().includes(q),
      );
    }
    entries.sort(([, a], [, b]) => {
      const cmp = a.story.localeCompare(b.story, undefined, { numeric: true });
      if (cmp !== 0) return sortAsc ? cmp : -cmp;
      return a.element_type.localeCompare(b.element_type);
    });
    return entries;
  }, [modelData, tableSearch, sortAsc]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc(v => !v);
    else { setSortKey(key); setSortAsc(true); }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  const stories = Object.keys(geometry.stories).sort(
    (a, b) => (geometry.stories[a]?.elevation_m ?? 0) - (geometry.stories[b]?.elevation_m ?? 0),
  ).reverse();

  const piers = [...new Set(
    Object.values(geometry.shells ?? {})
      .filter(s => s.element_type === "wall" && s.pier)
      .map(s => s.pier as string)
  )].sort();

  const nSelected = state.selectedIds.size;
  const canUndo   = undoStack.length > 0 && !undoing;
  const canRedo   = redoStack.length > 0 && !undoing;

  function handleSectionAssignedWithDirty(result: AssignSectionResult) {
    handleSectionAssigned(result);
    setModelModified(true);
  }

  const modelSectionsForViewer = modelData
    ? Object.fromEntries(
        Object.entries(modelData.sections).map(([k, v]) => [k, { material: v.material }]),
      )
    : undefined;

  // ── Context menu data ──────────────────────────────────────────────────────
  const { frame: ctxFrame, section: ctxSection, shell: ctxShell } = getCtxSingleInfo();
  const ctxFirstFrame = state.selectedIds.size > 0
    ? (ctxFrame ?? modelData?.frames[[...state.selectedIds][0]])
    : null;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full relative" style={{ minHeight: 540 }}>

      {/* ── Context menu overlay ─────────────────────────────────────────── */}
      {ctxMenu && state.selectedIds.size > 0 && (
        <ContextMenuPopup
          x={ctxMenu.x}
          y={ctxMenu.y}
          nSelected={nSelected}
          singleFrame={ctxFrame}
          singleShell={ctxShell}
          singleSection={ctxSection}
          onClose={() => setCtxMenu(null)}
          onSelectByType={() => {
            if (ctxFrame) selectByType(ctxFrame.element_type as "column" | "beam");
            else if (ctxShell) selectByShellType(ctxShell.element_type);
            else if (ctxFirstFrame) selectByType(ctxFirstFrame.element_type as "column" | "beam");
            setCtxMenu(null);
          }}
          onSelectBySection={() => {
            if (ctxFirstFrame?.section) selectBySection(ctxFirstFrame.section);
            setCtxMenu(null);
          }}
          onSelectByMaterial={() => {
            const sec = ctxFirstFrame?.section ? modelData?.sections[ctxFirstFrame.section] : null;
            if (sec?.material) selectByMaterial(sec.material);
            setCtxMenu(null);
          }}
          onSelectByStory={() => {
            if (ctxFirstFrame?.story) selectByStory(ctxFirstFrame.story);
            else if (ctxShell?.story) selectByStory(ctxShell.story);
            setCtxMenu(null);
          }}
          onIsolate={() => { setIsolationMode(true); setCtxMenu(null); }}
          onZoom={() => { triggerZoom(); setCtxMenu(null); }}
          onClearSel={() => { clearSelection(); }}
        />
      )}

      {/* ── Toolbar principal ──────────────────────────────────────────── */}
      <div className="relative flex items-center gap-2 px-3 py-1.5 border-b border-border bg-surface-2 flex-shrink-0 flex-wrap">

        {/* Modo de render */}
        <TGroup>
          <TBtn active={viewMode === "lines"}    onClick={() => setViewMode("lines")}>Líneas</TBtn>
          <TBtn active={viewMode === "extruded"} onClick={() => setViewMode("extruded")}>Extruido</TBtn>
        </TGroup>

        <Sep />

        {/* Cámara */}
        <TGroup>
          <TBtn active={cameraViewMode === "3d"}    onClick={() => setCameraViewMode("3d")}    title="Vista 3D perspectiva">3D</TBtn>
          <TBtn active={cameraViewMode === "plan"}  onClick={() => setCameraViewMode("plan")}  title="Vista en planta ortográfica">Planta</TBtn>
          <TBtn active={cameraViewMode === "elevX"} onClick={() => setCameraViewMode("elevX")} title="Elevación eje X">Elev X</TBtn>
          <TBtn active={cameraViewMode === "elevY"} onClick={() => setCameraViewMode("elevY")} title="Elevación eje Y">Elev Y</TBtn>
        </TGroup>

        <Sep />

        {/* Filtro de piso (acción frecuente) */}
        <select
          value={storyFilter ?? ""}
          onChange={e => setStoryFilter(e.target.value || null)}
          className={[
            "text-[11px] rounded-md border px-1.5 py-0.5 focus:outline-none focus:border-accent max-w-[140px]",
            storyFilter
              ? "border-accent bg-accent/10 text-accent"
              : "border-border bg-surface-2 text-text",
          ].join(" ")}
          title="Filtrar por piso"
        >
          <option value="">Todos los pisos</option>
          {stories.map(s => <option key={s} value={s}>{s}</option>)}
        </select>

        {/* Botón Display Options */}
        <ToolbarBtn
          active={showDisplay}
          onClick={() => setShowDisplay(v => !v)}
          title="Opciones de visualización"
        >
          ⚙ Display
        </ToolbarBtn>

        <Sep />

        {/* Selección */}
        <ToolbarBtn
          active={state.multiSelectMode}
          onClick={() => setState(p => ({ ...p, multiSelectMode: !p.multiSelectMode }))}
          title="Selección múltiple (Ctrl+Clic)"
        >
          Multi
        </ToolbarBtn>

        {nSelected > 0 && (
          <>
            <ToolbarBtn active={isolationMode} onClick={() => setIsolationMode(v => !v)} title="Aislar selección">
              Aislar
            </ToolbarBtn>
            <ToolbarBtn onClick={triggerZoom} title="Zoom a selección">⊡</ToolbarBtn>
            {storyFilter && (
              <ToolbarBtn onClick={() => selectByStory(storyFilter)} title={`Seleccionar todo en ${storyFilter}`}>
                Sel. Piso
              </ToolbarBtn>
            )}
            <ToolbarBtn onClick={clearSelection} title="Limpiar selección (Esc)">
              ✕ {nSelected}
            </ToolbarBtn>
          </>
        )}

        {nSelected === 0 && (
          <>
            <ToolbarBtn onClick={() => selectByType("column")} title="Seleccionar todas las columnas">
              Sel. Col.
            </ToolbarBtn>
            <ToolbarBtn onClick={() => selectByType("beam")} title="Seleccionar todas las vigas">
              Sel. Vig.
            </ToolbarBtn>
            <ToolbarBtn onClick={() => selectByShellType("wall")} title="Seleccionar todos los muros">
              Sel. Muros
            </ToolbarBtn>
            {typeFilter.slabs && (
              <ToolbarBtn onClick={() => selectByShellType("slab")} title="Seleccionar todas las losas">
                Sel. Losas
              </ToolbarBtn>
            )}
          </>
        )}

        <Sep />

        {/* Undo / redo */}
        <ToolbarBtn disabled={!canUndo} onClick={handleUndo} title="Deshacer (Ctrl+Z)">↩</ToolbarBtn>
        <ToolbarBtn disabled={!canRedo} onClick={handleRedo} title="Rehacer (Ctrl+Y)">↪</ToolbarBtn>

        <Sep />

        <ToolbarBtn active={showTables} onClick={() => setShowTables(v => !v)} title="Tabla de elementos">
          Tabla
        </ToolbarBtn>

        {onLaunchAnalysis && (
          <>
            <Sep />
            <button
              onClick={() => { setModelModified(false); onLaunchAnalysis("modal"); }}
              disabled={analysisRunning}
              className={[
                "text-[11px] px-2.5 py-1 rounded-lg font-medium transition-colors border",
                modelModified
                  ? "bg-amber-500/15 border-amber-500/60 text-amber-400 hover:bg-amber-500/25"
                  : "bg-accent/10 border-accent/40 text-accent hover:bg-accent/20",
                analysisRunning ? "opacity-40 cursor-not-allowed" : "",
              ].join(" ")}
              title="Relanzar análisis modal"
            >
              {analysisRunning ? "Calculando…" : modelModified ? "↺ Modal ⚠" : "↺ Modal"}
            </button>
          </>
        )}

        {/* ── Display Options Panel (flotante) ───────────────────────────── */}
        {showDisplay && (
          <div
            className="absolute top-full left-0 mt-1 z-40 w-56 rounded-xl border border-border bg-surface shadow-2xl shadow-black/20"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-border">
              <span className="text-[9px] font-bold uppercase tracking-widest text-text-muted">
                Opciones de Visualización
              </span>
              <button
                onClick={() => setShowDisplay(false)}
                className="text-text-muted hover:text-text text-[10px] leading-none"
              >
                ✕
              </button>
            </div>

            {/* ELEMENTOS */}
            <div className="px-3 py-2 border-b border-border/60">
              <p className="text-[9px] font-bold uppercase tracking-widest text-text-muted mb-2">Elementos</p>
              <CheckRow
                label="Columnas" checked={typeFilter.columns} color="#818CF8"
                onChange={v => setTypeFilter(p => ({ ...p, columns: v }))}
              />
              <CheckRow
                label="Vigas" checked={typeFilter.beams} color="#38BDF8"
                onChange={v => setTypeFilter(p => ({ ...p, beams: v }))}
              />
              <CheckRow
                label="Muros" checked={typeFilter.walls} color={wallColor}
                colorValue={wallColor} onColorChange={setWallColor}
                onChange={v => setTypeFilter(p => ({ ...p, walls: v }))}
              />
              <CheckRow
                label="Losas" checked={typeFilter.slabs} color={slabColor}
                colorValue={slabColor} onColorChange={setSlabColor}
                onChange={v => setTypeFilter(p => ({ ...p, slabs: v }))}
              />
              <CheckRow
                label="Nodos" checked={showNodes} color="#475569"
                onChange={setShowNodes}
              />
              <CheckRow
                label="Cargas" checked={showLoads} color="#3B82F6"
                onChange={setShowLoads}
              />
            </div>

            {/* COLOR */}
            <div className="px-3 py-2 border-b border-border/60">
              <p className="text-[9px] font-bold uppercase tracking-widest text-text-muted mb-2">Color</p>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-text-muted">Esquema</span>
                <select
                  value={colorMode}
                  onChange={e => setColorMode(e.target.value as ColorMode)}
                  className="text-[10px] rounded border border-border bg-surface-2 px-1 py-0.5 text-text focus:outline-none focus:border-accent"
                >
                  <option value="type">Por tipo</option>
                  <option value="section">Por sección</option>
                  <option value="story">Por piso</option>
                </select>
              </div>
            </div>

            {/* CARGAS LOSAS */}
            {geometry.load_patterns.length > 0 && (
              <div className="px-3 py-2 border-b border-border/60">
                <p className="text-[9px] font-bold uppercase tracking-widest text-text-muted mb-2">Cargas losas</p>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-text-muted">Patrón</span>
                  <select
                    value={shellLoadPattern ?? ""}
                    onChange={e => {
                      const v = e.target.value;
                      setShellLoadPattern(v || null);
                      if (v) setTypeFilter(p => ({ ...p, slabs: true }));
                    }}
                    className="text-[10px] rounded border border-border bg-surface-2 px-1 py-0.5 text-text focus:outline-none focus:border-accent max-w-[120px]"
                  >
                    <option value="">— ninguno —</option>
                    {geometry.load_patterns.map(lp => (
                      <option key={lp} value={lp}>{lp}</option>
                    ))}
                  </select>
                </div>
                {shellLoadPattern && (
                  <p className="text-[9px] text-text-muted mt-1.5 leading-tight">
                    Vista Planta activa para ver mapa de colores
                  </p>
                )}
              </div>
            )}

            {/* FILTROS */}
            <div className="px-3 py-2">
              <p className="text-[9px] font-bold uppercase tracking-widest text-text-muted mb-2">Filtros</p>
              {piers.length > 0 && (
                <FilterRow label="Pier" value={pierFilter} options={piers} onChange={setPierFilter} />
              )}
              {modelData && Object.keys(modelData.sections).length > 0 && (
                <FilterRow
                  label="Sección"
                  value={sectionFilter}
                  options={Object.keys(modelData.sections)}
                  onChange={v => { setSectionFilter(v); if (v) setMaterialFilter(null); }}
                />
              )}
              {modelData && Object.keys(modelData.materials).length > 0 && (
                <FilterRow
                  label="Material"
                  value={materialFilter}
                  options={Object.keys(modelData.materials)}
                  onChange={v => { setMaterialFilter(v); if (v) setSectionFilter(null); }}
                />
              )}
            </div>
          </div>
        )}
      </div>

      {/* Banner: modelo modificado */}
      {modelModified && !analysisRunning && (
        <div className="flex items-center justify-between px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 flex-shrink-0">
          <p className="text-[11px] text-amber-400">
            Las secciones han cambiado — el análisis modal puede estar desactualizado.
          </p>
          <button
            onClick={() => { setModelModified(false); onLaunchAnalysis?.("modal"); }}
            className="text-[11px] px-2.5 py-1 rounded-lg bg-amber-500/20 border border-amber-500/50 text-amber-400 hover:bg-amber-500/30 transition-colors font-medium ml-3 whitespace-nowrap"
          >
            Recalcular modal →
          </button>
        </div>
      )}

      {/* ── Cuerpo: árbol | viewport | inspector ─────────────────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* Panel izquierdo: árbol del modelo con tabs ───────────────────── */}
        <div className="w-52 flex-shrink-0 border-r border-border flex flex-col overflow-hidden bg-surface">

          {/* Tabs */}
          <div className="flex border-b border-border flex-shrink-0 bg-surface-2">
            {(["model", "stories", "sections"] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setLeftTab(tab)}
                className={[
                  "flex-1 py-2 text-[9px] font-bold uppercase tracking-wider transition-colors border-b-2",
                  leftTab === tab
                    ? "text-accent border-accent"
                    : "text-text-muted border-transparent hover:text-text",
                ].join(" ")}
              >
                {tab === "model" ? "Modelo" : tab === "stories" ? "Pisos" : "Secc."}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto text-[11px]">

            {/* TAB: MODELO */}
            {leftTab === "model" && (
              <div className="py-1">
                {modelData ? (
                  <>
                    {/* Stats estructurales */}
                    <div className="px-3 py-2 border-b border-border/50">
                      <p className="text-[9px] font-bold uppercase tracking-widest text-text-muted mb-2">Estadísticas</p>
                      {([
                        ["Pisos",      modelData.metadata.n_stories],
                        ["Nodos",      modelData.metadata.n_joints],
                        ["Columnas",   Object.values(modelData.frames).filter(f => f.element_type === "column").length],
                        ["Vigas",      Object.values(modelData.frames).filter(f => f.element_type === "beam").length],
                        ["Muros",      Object.values(modelData.shells ?? {}).filter(s => s.element_type === "wall").length],
                        ["Losas",      Object.values(modelData.shells ?? {}).filter(s => s.element_type === "slab").length],
                        ["Secciones",  modelData.metadata.n_sections],
                        ["Materiales", modelData.metadata.n_materials],
                      ] as [string, number][]).map(([label, val]) => (
                        <div key={label} className="flex justify-between items-center py-0.5">
                          <span className="text-text-muted">{label}</span>
                          <span className="font-mono text-text font-semibold">{val}</span>
                        </div>
                      ))}
                    </div>

                    {/* Masas por piso */}
                    {Object.keys(modelData.masses).length > 0 && (
                      <div className="px-3 py-2">
                        <p className="text-[9px] font-bold uppercase tracking-widest text-text-muted mb-2">Masas por piso</p>
                        {Object.values(modelData.masses)
                          .sort((a, b) => b.z_m - a.z_m)
                          .map(m => (
                            <div key={m.story} className="flex justify-between items-center py-0.5">
                              <span className="text-text-muted truncate">{m.story}</span>
                              <span className="font-mono text-[10px] text-text">{m.mass_x_t.toFixed(1)} t</span>
                            </div>
                          ))}
                      </div>
                    )}
                  </>
                ) : (
                  <p className="px-3 py-4 text-text-muted text-center">Cargando…</p>
                )}
              </div>
            )}

            {/* TAB: PISOS */}
            {leftTab === "stories" && (
              <div className="py-1">
                <button
                  onClick={() => setStoryFilter(null)}
                  className={[
                    "w-full px-3 py-1.5 text-left transition-colors flex items-center gap-2",
                    !storyFilter ? "text-accent bg-accent/10" : "text-text-muted hover:text-text hover:bg-surface-2",
                  ].join(" ")}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60 flex-shrink-0" />
                  Todos los pisos
                </button>
                {stories.map(s => {
                  const storyInfo = geometry.stories[s];
                  const frameCount = Object.values(geometry.frames).filter(f => f.story === s).length;
                  const shellCount = Object.values(geometry.shells ?? {}).filter(sh => sh.story === s).length;
                  return (
                    <button
                      key={s}
                      onClick={() => {
                        const newFilter = storyFilter === s ? null : s;
                        setStoryFilter(newFilter);
                        if (newFilter) triggerStoryZoom(newFilter);
                      }}
                      className={[
                        "w-full px-3 py-1.5 text-left transition-colors",
                        storyFilter === s
                          ? "text-accent bg-accent/10"
                          : "text-text-muted hover:text-text hover:bg-surface-2",
                      ].join(" ")}
                    >
                      <div className="flex items-center justify-between">
                        <span className="truncate font-medium">{s}</span>
                        <div className="flex items-center gap-1.5 flex-shrink-0 ml-1">
                          <span className="text-[9px] font-mono opacity-60">{storyInfo?.elevation_m.toFixed(2)}m</span>
                          <span className="text-[9px] text-accent font-mono">{frameCount + shellCount}</span>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {/* TAB: SECCIONES */}
            {leftTab === "sections" && modelData && (
              <div className="py-1">
                <button
                  onClick={() => setSectionFilter(null)}
                  className={[
                    "w-full px-3 py-1.5 text-left transition-colors",
                    !sectionFilter ? "text-accent bg-accent/10" : "text-text-muted hover:text-text hover:bg-surface-2",
                  ].join(" ")}
                >
                  Todas las secciones
                </button>
                {Object.keys(modelData.sections).map(sec => {
                  const frameCount = Object.values(modelData.frames).filter(f => f.section === sec).length;
                  const shellCount = Object.values(modelData.shells ?? {}).filter(s => s.section === sec).length;
                  const total = frameCount + shellCount;
                  return (
                    <button
                      key={sec}
                      onClick={() => {
                        setSectionFilter(prev => prev === sec ? null : sec);
                        setMaterialFilter(null);
                      }}
                      className={[
                        "w-full px-3 py-1.5 text-left transition-colors flex items-center justify-between",
                        sectionFilter === sec
                          ? "text-accent bg-accent/10"
                          : "text-text-muted hover:text-text hover:bg-surface-2",
                      ].join(" ")}
                      title={`${sec} — ${total} elemento(s)`}
                    >
                      <span className="truncate">{sec}</span>
                      <span className="text-[9px] text-accent font-mono flex-shrink-0 ml-1">{total}</span>
                    </button>
                  );
                })}
              </div>
            )}

          </div>
        </div>

        {/* Viewport central — captura clic derecho para el menú contextual */}
        <div
          className="flex-1 min-w-0 overflow-hidden flex flex-col"
          onContextMenu={handleViewportContextMenu}
        >
          {loadingModel && !modelData && (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-sm text-text-muted animate-pulse">Cargando modelo…</p>
            </div>
          )}
          {modelError && (
            <div className="flex-1 flex items-center justify-center px-8">
              <p className="text-sm text-danger text-center">{modelError}</p>
            </div>
          )}
          {!modelError && (
            <div className="flex-1 p-2 min-h-0">
              <LinearModelViewer3D
                geometry={geometry}
                selectedIds={state.selectedIds}
                onClickElement={handleClickElement}
                colorMode={colorMode}
                storyFilter={storyFilter}
                pierFilter={pierFilter}
                typeFilter={typeFilter}
                isolationMode={isolationMode}
                hideControls={true}
                externalViewMode={viewMode}
                onViewModeChange={setViewMode}
                externalShowLoads={showLoads}
                externalShowNodes={showNodes}
                modelSections={modelSectionsForViewer}
                sectionFilter={sectionFilter}
                materialFilter={materialFilter}
                zoomBbox={zoomBbox}
                cameraViewMode={cameraViewMode}
                wallColor={wallColor}
                slabColor={slabColor}
                shellLoads={geometry.shell_loads}
                shellLoadPattern={shellLoadPattern}
              />
            </div>
          )}
        </div>

        {/* Panel derecho: inspector */}
        <div className="w-64 flex-shrink-0 border-l border-border flex flex-col overflow-hidden bg-surface">
          <div className="flex border-b border-border flex-shrink-0 bg-surface-2">
            {RIGHT_TABS.map(tab => (
              <button key={tab.id}
                onClick={() => setRightPanel(tab.id)}
                className={[
                  "flex-1 py-2 text-[10px] font-semibold uppercase tracking-wide transition-colors border-b-2",
                  rightPanel === tab.id
                    ? "text-accent border-accent"
                    : "text-text-muted border-transparent hover:text-text",
                ].join(" ")}
              >
                {tab.label}
                {tab.id === "properties" && nSelected > 0 && (
                  <span className="ml-1 text-accent">{nSelected}</span>
                )}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-hidden">
            {rightPanel === "properties" && modelData && (
              <ModelPropertiesPanel
                projectId={projectId}
                selectedIds={state.selectedIds}
                modelData={modelData}
                onSectionAssigned={handleSectionAssignedWithDirty}
                onModelDataChange={loadModelData}
              />
            )}
            {rightPanel === "sections" && modelData && (
              <ModelSectionsPanel
                projectId={projectId}
                modelData={modelData}
                onModelDataChange={() => { loadModelData(); setModelModified(true); }}
              />
            )}
            {rightPanel === "materials" && modelData && (
              <ModelMaterialsPanel
                projectId={projectId}
                modelData={modelData}
                onModelDataChange={() => { loadModelData(); setModelModified(true); }}
              />
            )}
            {rightPanel === "health" && (
              <ModelHealthPanel
                projectId={projectId}
                onSelectElements={(ids) => {
                  setState(prev => ({ ...prev, selectedIds: new Set(ids) }));
                  setRightPanel("properties");
                }}
              />
            )}
            {!modelData && rightPanel !== "health" && (
              <div className="flex items-center justify-center h-full">
                <p className="text-xs text-text-muted">
                  {loadingModel ? "Cargando…" : "Modelo no disponible"}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Panel de tablas (collapsible, altura fija) ────────────────────── */}
      {showTables && modelData && (
        <div className="flex-shrink-0 border-t border-border flex flex-col" style={{ height: 256 }}>

          {/* Header de tabs */}
          <div className="flex items-center border-b border-border bg-surface-2 flex-shrink-0">
            {(["frames", "shells", "sections", "materials"] as TableTab[]).map(t => {
              const label = t === "frames"
                ? `Frames (${Object.keys(modelData.frames).length})`
                : t === "shells"
                  ? `Shells (${Object.keys(modelData.shells ?? {}).length})`
                  : t === "sections"
                    ? `Secciones (${Object.keys(modelData.sections).length})`
                    : `Materiales (${Object.keys(modelData.materials).length})`;
              return (
                <button key={t}
                  onClick={() => { setTableTab(t); setTableSearch(""); }}
                  className={[
                    "px-4 py-2 text-[10px] font-semibold uppercase tracking-wide border-b-2 transition-colors",
                    tableTab === t
                      ? "text-accent border-accent"
                      : "text-text-muted border-transparent hover:text-text",
                  ].join(" ")}
                >
                  {label}
                </button>
              );
            })}
            <div className="ml-auto px-3 flex items-center gap-2">
              <input
                type="text"
                placeholder="Buscar…"
                value={tableSearch}
                onChange={e => setTableSearch(e.target.value)}
                className="text-[11px] rounded-md border border-border bg-surface px-2 py-1 text-text placeholder:text-text-muted focus:outline-none focus:border-accent w-28"
              />
              <button
                onClick={() => setShowTables(false)}
                className="text-text-muted hover:text-text text-base leading-none px-1"
                title="Cerrar tabla"
              >×</button>
            </div>
          </div>

          {/* Tabla */}
          <div className="flex-1 overflow-auto">

            {/* ── Frames table ─────────────────────────────────────────── */}
            {tableTab === "frames" && (
              <table className="w-full text-[11px] border-collapse">
                <thead className="sticky top-0 bg-surface-2 border-b border-border z-10">
                  <tr>
                    <th
                      className="text-left px-3 py-1.5 font-semibold text-text-muted cursor-pointer hover:text-text select-none whitespace-nowrap"
                      onClick={() => toggleSort("object_label")}
                    >
                      Label <SortIcon active={sortKey === "object_label"} asc={sortAsc} />
                    </th>
                    <th
                      className="text-left px-2 py-1.5 font-semibold text-text-muted cursor-pointer hover:text-text select-none"
                      onClick={() => toggleSort("element_type")}
                    >
                      Tipo <SortIcon active={sortKey === "element_type"} asc={sortAsc} />
                    </th>
                    <th
                      className="text-left px-2 py-1.5 font-semibold text-text-muted cursor-pointer hover:text-text select-none"
                      onClick={() => toggleSort("story")}
                    >
                      Piso <SortIcon active={sortKey === "story"} asc={sortAsc} />
                    </th>
                    <th
                      className="text-left px-2 py-1.5 font-semibold text-text-muted cursor-pointer hover:text-text select-none"
                      onClick={() => toggleSort("section")}
                    >
                      Sección <SortIcon active={sortKey === "section"} asc={sortAsc} />
                    </th>
                    <th className="text-left px-2 py-1.5 font-semibold text-text-muted">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {tableFrames.slice(0, 500).map(([id, frame]) => {
                    const isSelected = state.selectedIds.has(id);
                    return (
                      <tr
                        key={id}
                        onClick={() => {
                          setState(prev => ({ ...prev, selectedIds: new Set([id]) }));
                          setRightPanel("properties");
                        }}
                        className={[
                          "border-b border-border/30 cursor-pointer transition-colors",
                          isSelected
                            ? "bg-accent/10 hover:bg-accent/15"
                            : "hover:bg-surface-2",
                        ].join(" ")}
                      >
                        <td className="px-3 py-1 font-mono font-medium text-text">
                          {frame.object_label || id}
                        </td>
                        <td className="px-2 py-1">
                          <span className={[
                            "inline-flex items-center rounded-full px-1.5 py-px text-[10px] font-semibold",
                            frame.element_type === "column"
                              ? "bg-indigo-500/15 text-indigo-400"
                              : "bg-sky-500/15 text-sky-400",
                          ].join(" ")}>
                            {frame.element_type === "column" ? "Col." : "Vig."}
                          </span>
                        </td>
                        <td className="px-2 py-1 text-text-muted">{frame.story}</td>
                        <td className="px-2 py-1 font-mono text-text">{frame.section || "—"}</td>
                        <td className="px-2 py-1">
                          {!frame.section && (
                            <span className="text-[10px] text-danger">Sin sección</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {tableFrames.length > 500 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-2 text-center text-[10px] text-text-muted">
                        Mostrando 500 de {tableFrames.length} elementos. Usa el buscador para filtrar.
                      </td>
                    </tr>
                  )}
                  {tableFrames.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-4 text-center text-xs text-text-muted">
                        Sin resultados para ese filtro.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}

            {/* ── Shells table ────────────────────────────────────────────── */}
            {tableTab === "shells" && (
              <table className="w-full text-[11px] border-collapse">
                <thead className="sticky top-0 bg-surface-2 border-b border-border z-10">
                  <tr>
                    <th className="text-left px-3 py-1.5 font-semibold text-text-muted">Label</th>
                    <th className="text-left px-2 py-1.5 font-semibold text-text-muted">Tipo</th>
                    <th className="text-left px-2 py-1.5 font-semibold text-text-muted">Pier</th>
                    <th className="text-left px-2 py-1.5 font-semibold text-text-muted">Piso</th>
                    <th className="text-left px-2 py-1.5 font-semibold text-text-muted">Sección</th>
                    <th className="text-left px-2 py-1.5 font-semibold text-text-muted">e (cm)</th>
                  </tr>
                </thead>
                <tbody>
                  {tableShells.slice(0, 500).map(([id, shell]) => {
                    const isSelected = state.selectedIds.has(id);
                    return (
                      <tr
                        key={id}
                        onClick={() => {
                          setState(prev => ({ ...prev, selectedIds: new Set([id]) }));
                          setRightPanel("properties");
                        }}
                        className={[
                          "border-b border-border/30 cursor-pointer transition-colors",
                          isSelected ? "bg-accent/10 hover:bg-accent/15" : "hover:bg-surface-2",
                        ].join(" ")}
                      >
                        <td className="px-3 py-1 font-mono font-medium text-text">{id}</td>
                        <td className="px-2 py-1">
                          <span className={[
                            "inline-flex items-center rounded-full px-1.5 py-px text-[10px] font-semibold",
                            shell.element_type === "wall"
                              ? "bg-emerald-500/15 text-emerald-400"
                              : "bg-amber-500/15 text-amber-400",
                          ].join(" ")}>
                            {shell.element_type === "wall" ? "Muro" : "Losa"}
                          </span>
                        </td>
                        <td className="px-2 py-1 text-text-muted font-mono text-[10px]">{shell.pier || "—"}</td>
                        <td className="px-2 py-1 text-text-muted">{shell.story}</td>
                        <td className="px-2 py-1 font-mono text-text">{shell.section || "—"}</td>
                        <td className="px-2 py-1 font-mono text-text">
                          {shell.thickness_m ? (shell.thickness_m * 100).toFixed(1) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                  {tableShells.length > 500 && (
                    <tr>
                      <td colSpan={6} className="px-3 py-2 text-center text-[10px] text-text-muted">
                        Mostrando 500 de {tableShells.length}. Usa el buscador para filtrar.
                      </td>
                    </tr>
                  )}
                  {tableShells.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-3 py-4 text-center text-xs text-text-muted">
                        Sin resultados.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}

            {/* ── Sections table ───────────────────────────────────────── */}
            {tableTab === "sections" && (
              <table className="w-full text-[11px] border-collapse">
                <thead className="sticky top-0 bg-surface-2 border-b border-border z-10">
                  <tr>
                    <th className="text-left px-3 py-1.5 font-semibold text-text-muted">Sección</th>
                    <th className="text-left px-2 py-1.5 font-semibold text-text-muted">Material</th>
                    <th className="text-left px-2 py-1.5 font-semibold text-text-muted">h × b (cm)</th>
                    <th className="text-left px-2 py-1.5 font-semibold text-text-muted">A (cm²)</th>
                    <th className="text-left px-2 py-1.5 font-semibold text-text-muted">Usos</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(modelData.sections)
                    .filter(([name]) =>
                      !tableSearch || name.toLowerCase().includes(tableSearch.toLowerCase()),
                    )
                    .map(([name, sec]) => {
                      const uses = Object.values(modelData.frames).filter(f => f.section === name).length;
                      return (
                        <tr key={name}
                          onClick={() => selectBySection(name)}
                          className="border-b border-border/30 cursor-pointer hover:bg-surface-2 transition-colors"
                        >
                          <td className="px-3 py-1 font-mono font-semibold text-text">{name}</td>
                          <td className="px-2 py-1 text-text-muted">{sec.material}</td>
                          <td className="px-2 py-1 font-mono text-text">
                            {(sec.h_m * 100).toFixed(0)} × {(sec.b_m * 100).toFixed(0)}
                          </td>
                          <td className="px-2 py-1 font-mono text-text">
                            {(sec.A_m2 * 10000).toFixed(1)}
                          </td>
                          <td className="px-2 py-1">
                            <span className="text-accent font-mono">{uses}</span>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            )}

            {/* ── Materials table ──────────────────────────────────────── */}
            {tableTab === "materials" && (
              <table className="w-full text-[11px] border-collapse">
                <thead className="sticky top-0 bg-surface-2 border-b border-border z-10">
                  <tr>
                    <th className="text-left px-3 py-1.5 font-semibold text-text-muted">Material</th>
                    <th className="text-left px-2 py-1.5 font-semibold text-text-muted">Tipo</th>
                    <th className="text-left px-2 py-1.5 font-semibold text-text-muted">f&apos;c / fy (MPa)</th>
                    <th className="text-left px-2 py-1.5 font-semibold text-text-muted">E (GPa)</th>
                    <th className="text-left px-2 py-1.5 font-semibold text-text-muted">Secciones</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(modelData.materials)
                    .filter(([name]) =>
                      !tableSearch || name.toLowerCase().includes(tableSearch.toLowerCase()),
                    )
                    .map(([name, mat]) => {
                      const secCount = Object.values(modelData.sections).filter(s => s.material === name).length;
                      return (
                        <tr key={name}
                          onClick={() => selectByMaterial(name)}
                          className="border-b border-border/30 cursor-pointer hover:bg-surface-2 transition-colors"
                        >
                          <td className="px-3 py-1 font-mono font-semibold text-text">{name}</td>
                          <td className="px-2 py-1">
                            <span className={[
                              "text-[10px] rounded-full px-1.5 py-px font-medium",
                              mat.type === "concrete"
                                ? "bg-indigo-500/15 text-indigo-400"
                                : "bg-amber-500/15 text-amber-400",
                            ].join(" ")}>
                              {mat.type === "concrete" ? "Concreto" : "Acero"}
                            </span>
                          </td>
                          <td className="px-2 py-1 font-mono text-text">
                            {mat.type === "concrete" ? mat.fpc_mpa : (mat.fy_mpa ?? "—")}
                          </td>
                          <td className="px-2 py-1 font-mono text-text">
                            {(mat.E_mpa / 1000).toFixed(1)}
                          </td>
                          <td className="px-2 py-1">
                            <span className="text-accent font-mono">{secCount}</span>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ── Barra de estado inferior ──────────────────────────────────────── */}
      <div className="flex items-center justify-between px-3 py-1.5 border-t border-border bg-surface-2 flex-shrink-0 text-[10px] text-text-muted">
        <div className="flex gap-3 items-center flex-wrap">
          <span>
            {geometry.n_stories} pisos · {geometry.n_joints} nodos · {geometry.n_frames} frames
          </span>
          {storyFilter && <span className="text-accent">Piso: {storyFilter}</span>}
          {sectionFilter && <span className="text-accent">Secc.: {sectionFilter}</span>}
          {materialFilter && <span className="text-accent">Mat.: {materialFilter}</span>}
          {isolationMode && <span className="text-amber-400">Aislamiento activo</span>}
        </div>
        <div className="flex gap-3 items-center">
          {nSelected > 0 && (
            <span className="text-accent font-semibold">{nSelected} seleccionados</span>
          )}
          {undoStack.length > 0 && (
            <span className="opacity-60">{undoStack.length} acción(es)</span>
          )}
          <span className="opacity-50">
            Clic dcho. = menú · Esc = limpiar · Ctrl+Z/Y = deshacer/rehacer
          </span>
        </div>
      </div>
    </div>
  );
}
