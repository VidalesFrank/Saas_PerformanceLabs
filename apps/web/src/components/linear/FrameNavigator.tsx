"use client";

import { useState, useMemo, useEffect } from "react";
import type { FrameListItem, FrameListResult } from "@/lib/structural-types";

interface Props {
  data: FrameListResult;
  selectedFrameId: string | null;
  onSelect: (frameId: string, elementType: "column" | "beam") => void;
  /** Multi-selección: ids actualmente marcados. */
  selectedIds?: Set<string>;
  /** Modo multi-selección activo. */
  multiMode?: boolean;
  /** Callbacks de multi-selección. */
  onToggleMultiMode?: (next: boolean) => void;
  onToggleId?: (frameId: string) => void;
  onSetSelection?: (ids: Set<string>) => void;
}

type FilterType = "all" | "column" | "beam";
type FilterStatus = "all" | "ok" | "ng" | "warning" | "user_modified";

function StatusIcon({ frame }: { frame: FrameListItem }) {
  const { status, dcr, source } = frame;
  // Prioridad: NG > bulk > user_modified(manual) > warning > ok
  if (status === "ng") {
    return (
      <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-500 text-white text-xs font-bold" title={`No cumple — DCR ${dcr.toFixed(3)}`}>
        ✕
      </span>
    );
  }
  if (source === "bulk") {
    return (
      <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-purple-500 text-white text-xs font-bold" title={`Patrón bulk aplicado${frame.pattern_label ? ` — ${frame.pattern_label}` : ""}`}>
        ⬟
      </span>
    );
  }
  if (status === "user_modified") {
    return (
      <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-500 text-white text-xs font-bold" title="Ajustado manualmente">
        ✎
      </span>
    );
  }
  if (status === "warning") {
    return (
      <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-400 text-white text-xs font-bold" title={`Advertencia — DCR ${dcr.toFixed(3)}`}>
        ⚠
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-green-500 text-white text-xs font-bold" title={`Cumple — DCR ${dcr.toFixed(3)}`}>
      ✓
    </span>
  );
}

export default function FrameNavigator({
  data, selectedFrameId, onSelect,
  selectedIds, multiMode = false,
  onToggleMultiMode, onToggleId, onSetSelection,
}: Props) {
  const [filterType,   setFilterType]   = useState<FilterType>("all");
  const [filterStatus, setFilterStatus] = useState<FilterStatus>("all");
  const [search,       setSearch]       = useState("");
  const [collapsed,    setCollapsed]    = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    return data.frames.filter((f) => {
      if (filterType !== "all" && f.element_type !== filterType) return false;
      if (filterStatus !== "all" && f.status !== filterStatus) return false;
      if (search && !f.frame_id.toLowerCase().includes(search.toLowerCase()) &&
          !f.section.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [data.frames, filterType, filterStatus, search]);

  // Agrupar por piso (story_order define el orden)
  const byStory = useMemo(() => {
    const map: Record<string, FrameListItem[]> = {};
    for (const s of data.story_order) map[s] = [];
    for (const f of filtered) {
      if (!map[f.story]) map[f.story] = [];
      map[f.story].push(f);
    }
    return map;
  }, [filtered, data.story_order]);

  const toggleStory = (story: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(story)) next.delete(story);
      else next.add(story);
      return next;
    });
  };

  // Al salir del modo multi, limpiar la selección
  useEffect(() => {
    if (!multiMode && selectedIds && selectedIds.size > 0) {
      onSetSelection?.(new Set());
    }
  }, [multiMode, selectedIds, onSetSelection]);

  const stats = {
    ok:    data.frames.filter((f) => f.ok).length,
    ng:    data.frames.filter((f) => !f.ok).length,
    mod:   data.frames.filter((f) => f.user_modified).length,
    bulk:  data.frames.filter((f) => f.source === "bulk").length,
  };

  // Atajos de selección múltiple
  const selectAllVisible = () => {
    const next = new Set(selectedIds ?? []);
    for (const f of filtered) next.add(f.frame_id);
    onSetSelection?.(next);
  };
  const clearSelection = () => onSetSelection?.(new Set());

  // "Por sección": si hay EXACTAMENTE un frame seleccionado, selecciona todos los que
  // comparten su sección + element_type. Si hay varios y comparten sección, extiende.
  const extendBySection = () => {
    if (!selectedIds || selectedIds.size === 0) return;
    const picked = data.frames.filter((f) => selectedIds.has(f.frame_id));
    const types    = new Set(picked.map((f) => f.element_type));
    const sections = new Set(picked.map((f) => f.section));
    if (types.size !== 1 || sections.size !== 1) return;
    const t = [...types][0];
    const s = [...sections][0];
    const next = new Set(selectedIds);
    for (const f of data.frames) {
      if (f.element_type === t && f.section === s) next.add(f.frame_id);
    }
    onSetSelection?.(next);
  };

  // "Por piso": extiende con todos los frames del mismo piso + mismo tipo + misma sección
  const extendByStory = () => {
    if (!selectedIds || selectedIds.size === 0) return;
    const picked = data.frames.filter((f) => selectedIds.has(f.frame_id));
    const types    = new Set(picked.map((f) => f.element_type));
    const sections = new Set(picked.map((f) => f.section));
    const stories  = new Set(picked.map((f) => f.story));
    if (types.size !== 1 || sections.size !== 1) return;
    const t = [...types][0];
    const s = [...sections][0];
    const next = new Set(selectedIds);
    for (const f of data.frames) {
      if (stories.has(f.story) && f.element_type === t && f.section === s) {
        next.add(f.frame_id);
      }
    }
    onSetSelection?.(next);
  };

  const nSel = selectedIds?.size ?? 0;

  return (
    <div className="flex flex-col h-full bg-[var(--card)] border-r border-[var(--border)]">
      {/* Header */}
      <div className="p-3 border-b border-[var(--border)]">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-[var(--foreground)]">Elementos</h3>
          {onToggleMultiMode && (
            <button
              onClick={() => onToggleMultiMode(!multiMode)}
              className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                multiMode
                  ? "bg-[var(--accent)] text-white border-[var(--accent)]"
                  : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent)]"
              }`}
              title="Alternar selección múltiple para aplicar un patrón de refuerzo"
            >
              {multiMode ? "☑ Multi" : "☐ Multi"}
            </button>
          )}
        </div>

        {/* Stats */}
        <div className="flex flex-wrap gap-2 mb-3 text-xs">
          <span className="px-2 py-0.5 rounded-full bg-green-500/15 text-green-600 font-medium">
            {stats.ok} OK
          </span>
          <span className="px-2 py-0.5 rounded-full bg-red-500/15 text-red-600 font-medium">
            {stats.ng} NG
          </span>
          {stats.bulk > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-600 font-medium">
              {stats.bulk} bulk
            </span>
          )}
          {stats.mod - stats.bulk > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-600 font-medium">
              {stats.mod - stats.bulk} manual
            </span>
          )}
        </div>

        {/* Barra de selección múltiple */}
        {multiMode && (
          <div className="mb-3 p-2 rounded bg-[var(--accent)]/5 border border-[var(--accent)]/30">
            <div className="flex items-center justify-between text-xs mb-2">
              <span className="font-semibold text-[var(--foreground)]">
                {nSel} seleccionado{nSel === 1 ? "" : "s"}
              </span>
              {nSel > 0 && (
                <button
                  onClick={clearSelection}
                  className="text-[var(--muted)] hover:text-[var(--foreground)] underline"
                >
                  Limpiar
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1">
              <button
                onClick={selectAllVisible}
                className="text-xs px-2 py-0.5 rounded border border-[var(--border)] hover:border-[var(--accent)] hover:bg-[var(--accent)]/10"
                title="Marca todos los frames que pasan los filtros actuales"
              >
                Visibles
              </button>
              <button
                onClick={extendBySection}
                disabled={nSel === 0}
                className="text-xs px-2 py-0.5 rounded border border-[var(--border)] hover:border-[var(--accent)] hover:bg-[var(--accent)]/10 disabled:opacity-40 disabled:cursor-not-allowed"
                title="Añade todos los frames con la misma sección y tipo que los seleccionados"
              >
                + Misma sección
              </button>
              <button
                onClick={extendByStory}
                disabled={nSel === 0}
                className="text-xs px-2 py-0.5 rounded border border-[var(--border)] hover:border-[var(--accent)] hover:bg-[var(--accent)]/10 disabled:opacity-40 disabled:cursor-not-allowed"
                title="Añade todos los frames del mismo piso, sección y tipo"
              >
                + Mismo piso
              </button>
            </div>
          </div>
        )}

        {/* Búsqueda */}
        <input
          type="text"
          placeholder="Buscar ID o sección..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full px-2 py-1 text-xs rounded border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] mb-2"
        />

        {/* Filtros */}
        <div className="flex gap-1 mb-1">
          {(["all", "column", "beam"] as FilterType[]).map((t) => (
            <button
              key={t}
              onClick={() => setFilterType(t)}
              className={`flex-1 text-xs py-1 rounded border transition-colors ${
                filterType === t
                  ? "bg-[var(--accent)] text-white border-[var(--accent)]"
                  : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent)]"
              }`}
            >
              {t === "all" ? "Todos" : t === "column" ? "Cols" : "Vigas"}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {(["all", "ok", "ng", "warning"] as FilterStatus[]).map((s) => (
            <button
              key={s}
              onClick={() => setFilterStatus(s)}
              className={`flex-1 text-xs py-1 rounded border transition-colors ${
                filterStatus === s
                  ? "bg-[var(--accent)] text-white border-[var(--accent)]"
                  : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent)]"
              }`}
            >
              {s === "all" ? "Todos" : s === "ok" ? "OK" : s === "ng" ? "NG" : "⚠"}
            </button>
          ))}
        </div>
      </div>

      {/* Lista de frames agrupada por piso */}
      <div className="flex-1 overflow-y-auto">
        {data.story_order.slice().reverse().map((story) => {
          const frames = byStory[story] ?? [];
          if (frames.length === 0) return null;

          const isCollapsed = collapsed.has(story);
          const cols  = frames.filter((f) => f.element_type === "column");
          const beams = frames.filter((f) => f.element_type === "beam");
          const ngCount = frames.filter((f) => !f.ok).length;

          return (
            <div key={story} className="border-b border-[var(--border)]">
              {/* Cabecera de piso */}
              <button
                onClick={() => toggleStory(story)}
                className="w-full flex items-center justify-between px-3 py-2 hover:bg-[var(--border)]/30 transition-colors text-left"
              >
                <div className="flex items-center gap-2">
                  <span className={`transform transition-transform text-xs text-[var(--muted)] ${isCollapsed ? "" : "rotate-90"}`}>
                    ▶
                  </span>
                  <span className="text-xs font-semibold text-[var(--foreground)]">{story}</span>
                  <span className="text-xs text-[var(--muted)]">{frames.length} elem.</span>
                </div>
                {ngCount > 0 && (
                  <span className="text-xs text-red-500 font-medium">{ngCount} NG</span>
                )}
              </button>

              {/* Frames del piso */}
              {!isCollapsed && (
                <div className="pb-1">
                  {/* Columnas */}
                  {cols.length > 0 && (
                    <div>
                      <div className="px-3 py-1 text-xs text-[var(--muted)] font-medium uppercase tracking-wide">
                        Columnas
                      </div>
                      {cols.map((f) => (
                        <FrameRow
                          key={f.frame_id}
                          frame={f}
                          selected={f.frame_id === selectedFrameId}
                          multiMode={multiMode}
                          checked={!!selectedIds?.has(f.frame_id)}
                          onSelect={() => onSelect(f.frame_id, f.element_type)}
                          onToggle={() => onToggleId?.(f.frame_id)}
                        />
                      ))}
                    </div>
                  )}
                  {/* Vigas */}
                  {beams.length > 0 && (
                    <div>
                      <div className="px-3 py-1 text-xs text-[var(--muted)] font-medium uppercase tracking-wide">
                        Vigas
                      </div>
                      {beams.map((f) => (
                        <FrameRow
                          key={f.frame_id}
                          frame={f}
                          selected={f.frame_id === selectedFrameId}
                          multiMode={multiMode}
                          checked={!!selectedIds?.has(f.frame_id)}
                          onSelect={() => onSelect(f.frame_id, f.element_type)}
                          onToggle={() => onToggleId?.(f.frame_id)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {filtered.length === 0 && (
          <div className="p-4 text-center text-xs text-[var(--muted)]">
            No hay elementos con los filtros aplicados.
          </div>
        )}
      </div>
    </div>
  );
}

function FrameRow({
  frame,
  selected,
  multiMode,
  checked,
  onSelect,
  onToggle,
}: {
  frame: FrameListItem;
  selected: boolean;
  multiMode: boolean;
  checked: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  const highlight = multiMode
    ? (checked ? "bg-[var(--accent)]/15 border-l-2 border-[var(--accent)]" : "border-l-2 border-transparent")
    : (selected ? "bg-[var(--accent)]/15 border-l-2 border-[var(--accent)]" : "border-l-2 border-transparent");

  return (
    <div
      className={`w-full flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-[var(--border)]/20 transition-colors ${highlight}`}
      onClick={multiMode ? onToggle : onSelect}
    >
      {multiMode && (
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggle()}
          onClick={(e) => e.stopPropagation()}
          className="shrink-0"
        />
      )}
      <StatusIcon frame={frame} />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-[var(--foreground)] truncate">
          {frame.frame_id}
          <span className="text-[var(--muted)] font-normal"> · {frame.section}</span>
        </div>
        <div className="text-xs text-[var(--muted)] truncate">
          DCR {frame.dcr.toFixed(3)}
          {frame.source === "bulk" && frame.pattern_label && ` · ${frame.pattern_label}`}
          {frame.source === "manual" && " · editado"}
        </div>
      </div>
    </div>
  );
}
