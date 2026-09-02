"use client";

import { useState, useMemo } from "react";
import type { FrameListItem, FrameListResult } from "@/lib/structural-types";

interface Props {
  data: FrameListResult;
  selectedFrameId: string | null;
  onSelect: (frameId: string, elementType: "column" | "beam") => void;
}

type FilterType = "all" | "column" | "beam";
type FilterStatus = "all" | "ok" | "ng" | "warning" | "user_modified";

function StatusIcon({ status, dcr }: { status: FrameListItem["status"]; dcr: number }) {
  if (status === "user_modified") {
    return (
      <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-500 text-white text-xs font-bold" title="Modificado por el usuario">
        ✎
      </span>
    );
  }
  if (status === "ng") {
    return (
      <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-500 text-white text-xs font-bold" title={`No cumple — DCR ${dcr.toFixed(3)}`}>
        ✕
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

export default function FrameNavigator({ data, selectedFrameId, onSelect }: Props) {
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

  const stats = {
    ok:  data.frames.filter((f) => f.ok).length,
    ng:  data.frames.filter((f) => !f.ok).length,
    mod: data.frames.filter((f) => f.user_modified).length,
  };

  return (
    <div className="flex flex-col h-full bg-[var(--card)] border-r border-[var(--border)]">
      {/* Header */}
      <div className="p-3 border-b border-[var(--border)]">
        <h3 className="text-sm font-semibold text-[var(--foreground)] mb-2">Elementos</h3>

        {/* Stats */}
        <div className="flex gap-2 mb-3 text-xs">
          <span className="px-2 py-0.5 rounded-full bg-green-500/15 text-green-600 font-medium">
            {stats.ok} OK
          </span>
          <span className="px-2 py-0.5 rounded-full bg-red-500/15 text-red-600 font-medium">
            {stats.ng} NG
          </span>
          {stats.mod > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-600 font-medium">
              {stats.mod} mod.
            </span>
          )}
        </div>

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
                          onSelect={() => onSelect(f.frame_id, f.element_type)}
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
                          onSelect={() => onSelect(f.frame_id, f.element_type)}
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
  onSelect,
}: {
  frame: FrameListItem;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors ${
        selected
          ? "bg-[var(--accent)]/15 border-l-2 border-[var(--accent)]"
          : "hover:bg-[var(--border)]/20 border-l-2 border-transparent"
      }`}
    >
      <StatusIcon status={frame.status} dcr={frame.dcr} />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-[var(--foreground)] truncate">
          {frame.frame_id}
        </div>
        <div className="text-xs text-[var(--muted)] truncate">
          DCR {frame.dcr.toFixed(3)}
          {frame.user_modified && " · editado"}
        </div>
      </div>
    </button>
  );
}
