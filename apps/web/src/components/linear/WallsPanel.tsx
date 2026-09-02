"use client";

import { useState, useEffect, useCallback } from "react";
import type {
  WallListItem,
  WallListResponse,
  WallHealthResponse,
  WallFormulation,
  WallAnalyticalModel,
  BulkAssignResponse,
} from "@/lib/wall-types";
import { WALL_FORMULATIONS } from "@/lib/wall-types";
import { fetchWalls, fetchWallHealth, bulkAssignFormulation, fetchWall } from "@/lib/wall-api";
import WallAnalyticalPanel from "./WallAnalyticalPanel";

interface Props {
  projectId:  string;
  materials:  string[];
  steelTypes: string[];
}

type ViewMode = "list" | "detail";
type StatusFilter = "all" | "configured" | "unconfigured" | "invalid";

function wallStatus(w: WallListItem, invalidLabels: Set<string>): "configured" | "incomplete" | "invalid" | "unconfigured" {
  if (!w.has_analytical) return "unconfigured";
  if (invalidLabels.has(w.label)) return "invalid";
  if (w.n_fibers !== null && w.n_fibers < 2) return "incomplete";
  return "configured";
}

const STATUS_STYLE: Record<string, string> = {
  configured:  "text-emerald-400 bg-emerald-500/10",
  incomplete:  "text-amber-400 bg-amber-500/10",
  unconfigured:"text-[var(--text-muted)] bg-[var(--surface-2)]",
  invalid:     "text-red-400 bg-red-500/10",
};

const STATUS_LABEL: Record<string, string> = {
  configured:  "Configured",
  incomplete:  "Incomplete",
  unconfigured:"—",
  invalid:     "Invalid",
};

export default function WallsPanel({ projectId, materials, steelTypes }: Props) {
  const [wallsData, setWallsData] = useState<WallListResponse | null>(null);
  const [health, setHealth]       = useState<WallHealthResponse | null>(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [selected, setSelected]   = useState<WallListItem | null>(null);
  const [detailShell, setDetailShell] = useState<Record<string, unknown> | null>(null);
  const [detailModel, setDetailModel] = useState<WallAnalyticalModel | null>(null);
  const [view, setView]           = useState<ViewMode>("list");
  const [openingLabel, setOpeningLabel] = useState<string | null>(null);

  // Filters
  const [filterStory, setFilterStory] = useState("");
  const [filterStatus, setFilterStatus] = useState<StatusFilter>("all");

  // Bulk assign
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());
  const [bulkForm, setBulkForm] = useState({ formulation: "E_SFI_MVLEM_3D" as WallFormulation, n_fibers: 8 });
  const [bulkBusy, setBulkBusy] = useState(false);

  const showSuccess = useCallback((msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(null), 3500);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [w, h] = await Promise.all([fetchWalls(projectId), fetchWallHealth(projectId)]);
      setWallsData(w);
      setHealth(h);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const openWall = useCallback(async (wall: WallListItem) => {
    setOpeningLabel(wall.label);
    setError(null);
    try {
      const detail = await fetchWall(projectId, wall.label);
      setSelected(wall);
      setDetailShell(detail.shell as Record<string, unknown>);
      setDetailModel(detail.analytical);
      setView("detail");
    } catch (err) {
      setError(`Failed to load wall "${wall.label}": ${String(err)}`);
    } finally {
      setOpeningLabel(null);
    }
  }, [projectId]);

  const handleBulkAssign = useCallback(async () => {
    if (bulkSelected.size === 0) return;
    setBulkBusy(true);
    setError(null);
    try {
      const result = await bulkAssignFormulation(projectId, {
        wall_labels: Array.from(bulkSelected),
        formulation: bulkForm.formulation,
        n_fibers:    bulkForm.n_fibers,
        c_rot: 0.4, thick_mod: 0.63, poisson: 0.25,
      }) as BulkAssignResponse;
      setBulkSelected(new Set());
      await load();
      showSuccess(
        result.updated > 0
          ? `${result.updated} wall(s) assigned${result.skipped > 0 ? ` — ${result.skipped} skipped` : ""}.`
          : "No walls were updated."
      );
    } catch (err) {
      setError(String(err));
    } finally {
      setBulkBusy(false);
    }
  }, [bulkSelected, bulkForm, projectId, load, showSuccess]);

  const invalidLabels = new Set<string>(
    health?.issues?.map((i) => i.label) ?? []
  );

  const stories = wallsData
    ? Array.from(new Set(wallsData.walls.map((w) => w.story))).sort()
    : [];

  const filtered = wallsData?.walls.filter((w) => {
    if (filterStory && w.story !== filterStory) return false;
    const st = wallStatus(w, invalidLabels);
    if (filterStatus === "configured"   && st !== "configured") return false;
    if (filterStatus === "unconfigured" && w.has_analytical)    return false;
    if (filterStatus === "invalid"      && st !== "invalid")    return false;
    return true;
  }) ?? [];

  // ── Detail view ─────────────────────────────────────────────────────────────
  if (view === "detail" && selected && detailShell) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 px-4 pt-4 pb-2 border-b border-[var(--border)]">
          <button
            onClick={() => { setView("list"); setSelected(null); }}
            className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
          >
            ← All Walls
          </button>
          <span className="text-xs text-[var(--text-muted)]">/</span>
          <span className="text-xs font-mono text-[var(--text-primary)]">{selected.label}</span>
          <span className="text-xs text-[var(--text-muted)]">·</span>
          <span className="text-xs text-[var(--text-muted)]">{selected.story}</span>
        </div>
        <div className="flex-1 overflow-y-auto">
          <WallAnalyticalPanel
            projectId={projectId}
            wallLabel={selected.label}
            wallShell={detailShell}
            initial={detailModel}
            materials={materials}
            steelTypes={steelTypes}
            onSaved={(m) => { setDetailModel(m); load(); }}
            onDeleted={() => { setDetailModel(null); load(); }}
          />
        </div>
      </div>
    );
  }

  // ── List view ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Error banner */}
      {error && (
        <div className="flex items-start gap-3 rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-3">
          <span className="text-red-400 shrink-0">✗</span>
          <p className="text-red-400 text-sm flex-1">{error}</p>
          <button onClick={() => setError(null)} className="text-red-400/60 hover:text-red-400 text-xs">✕</button>
        </div>
      )}

      {/* Success toast */}
      {successMsg && (
        <div className="flex items-center gap-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-4 py-3">
          <span className="text-emerald-400 shrink-0">✓</span>
          <p className="text-emerald-400 text-sm">{successMsg}</p>
        </div>
      )}

      {/* Health summary — clickable filter chips */}
      {loading ? (
        <div className="grid grid-cols-4 gap-2">
          {[0,1,2,3].map((i) => (
            <div key={i} className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] h-16 animate-pulse" />
          ))}
        </div>
      ) : health ? (
        <div className="grid grid-cols-4 gap-2">
          {([
            { label: "Total",      value: health.total,      color: "text-[var(--text-primary)]", filter: null },
            { label: "Configured", value: health.configured, color: "text-emerald-400",           filter: "configured" as StatusFilter },
            { label: "Incomplete", value: health.incomplete, color: "text-amber-400",             filter: "unconfigured" as StatusFilter },
            { label: "Invalid",    value: health.invalid,    color: "text-red-400",               filter: "invalid" as StatusFilter },
          ]).map(({ label, value, color, filter }) => (
            <button
              key={label}
              disabled={!filter}
              onClick={() => filter && setFilterStatus(prev => prev === filter ? "all" : filter)}
              className={[
                "rounded-lg border p-3 text-center transition-colors",
                filter === filterStatus
                  ? "border-[var(--primary)] bg-[var(--primary)]/10"
                  : filter
                  ? "border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--primary)]/40 cursor-pointer"
                  : "border-[var(--border)] bg-[var(--surface-2)] cursor-default",
              ].join(" ")}
            >
              <p className={`text-xl font-bold ${color}`}>{value}</p>
              <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider mt-0.5">{label}</p>
            </button>
          ))}
        </div>
      ) : null}

      {/* Filters + Bulk */}
      <div className="flex flex-wrap gap-2 items-end">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Story</label>
          <select value={filterStory} onChange={(e) => setFilterStory(e.target.value)} className="input-field text-xs py-1.5">
            <option value="">All stories</option>
            {stories.map((s) => <option key={s}>{s}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Status</label>
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as StatusFilter)} className="input-field text-xs py-1.5">
            <option value="all">All</option>
            <option value="configured">Configured</option>
            <option value="unconfigured">Not configured</option>
            <option value="invalid">Invalid</option>
          </select>
        </div>

        {bulkSelected.size > 0 && (
          <div className="flex items-end gap-2 ml-auto flex-wrap">
            <span className="text-xs text-[var(--text-muted)] self-center pb-1">{bulkSelected.size} selected</span>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Formulation</label>
              <select
                value={bulkForm.formulation}
                onChange={(e) => setBulkForm({ ...bulkForm, formulation: e.target.value as WallFormulation })}
                className="input-field text-xs py-1.5"
              >
                {WALL_FORMULATIONS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Fibers</label>
              <input
                type="number" min="2" max="40" value={bulkForm.n_fibers}
                onChange={(e) => setBulkForm({ ...bulkForm, n_fibers: parseInt(e.target.value) || 8 })}
                className="input-field text-xs py-1.5 w-20"
              />
            </div>
            <button onClick={handleBulkAssign} disabled={bulkBusy} className="btn-primary text-xs py-1.5 px-4 self-end">
              {bulkBusy ? "Assigning…" : "Assign Formulation"}
            </button>
            <button onClick={() => setBulkSelected(new Set())} className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] self-end px-2 py-1.5">
              Cancel
            </button>
          </div>
        )}
      </div>

      {/* Wall list */}
      {loading ? (
        <div className="rounded-lg border border-[var(--border)] overflow-hidden">
          {[0,1,2,3,4].map((i) => (
            <div key={i} className="h-10 animate-pulse bg-[var(--surface-2)] border-b border-[var(--border)]" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-[var(--border)] border-dashed flex flex-col items-center justify-center py-14 gap-3">
          <p className="text-sm font-medium text-[var(--text-secondary)]">No walls found</p>
          <p className="text-xs text-[var(--text-muted)] text-center max-w-xs">
            {filterStatus !== "all" || filterStory
              ? "Try clearing your filters to see all walls."
              : "No wall shells detected in this model. Ensure the imported E2K file contains WALL type area objects."}
          </p>
          {(filterStatus !== "all" || filterStory) && (
            <button onClick={() => { setFilterStatus("all"); setFilterStory(""); }} className="text-xs text-[var(--primary)] hover:underline">
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-[var(--border)] overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--surface-2)]">
                <th className="px-3 py-2 text-left">
                  <input
                    type="checkbox"
                    checked={bulkSelected.size === filtered.length && filtered.length > 0}
                    ref={(el) => { if (el) el.indeterminate = bulkSelected.size > 0 && bulkSelected.size < filtered.length; }}
                    onChange={(e) => setBulkSelected(e.target.checked ? new Set(filtered.map((w) => w.label)) : new Set())}
                    className="accent-[var(--primary)]"
                  />
                </th>
                <th className="px-3 py-2 text-left text-[var(--text-muted)] font-semibold uppercase tracking-wider">Label</th>
                <th className="px-3 py-2 text-left text-[var(--text-muted)] font-semibold uppercase tracking-wider">Story</th>
                <th className="px-3 py-2 text-left text-[var(--text-muted)] font-semibold uppercase tracking-wider">Pier</th>
                <th className="px-3 py-2 text-left text-[var(--text-muted)] font-semibold uppercase tracking-wider">Section</th>
                <th className="px-3 py-2 text-left text-[var(--text-muted)] font-semibold uppercase tracking-wider">Formulation</th>
                <th className="px-3 py-2 text-left text-[var(--text-muted)] font-semibold uppercase tracking-wider">Fibers</th>
                <th className="px-3 py-2 text-left text-[var(--text-muted)] font-semibold uppercase tracking-wider">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((wall) => {
                const st = wallStatus(wall, invalidLabels);
                return (
                  <tr key={wall.label} className="border-b border-[var(--border)] hover:bg-[var(--surface-2)] transition-colors">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={bulkSelected.has(wall.label)}
                        onChange={(e) => {
                          const next = new Set(bulkSelected);
                          e.target.checked ? next.add(wall.label) : next.delete(wall.label);
                          setBulkSelected(next);
                        }}
                        className="accent-[var(--primary)]"
                      />
                    </td>
                    <td className="px-3 py-2 font-mono text-[var(--text-primary)]">{wall.label}</td>
                    <td className="px-3 py-2 text-[var(--text-secondary)]">{wall.story}</td>
                    <td className="px-3 py-2 text-[var(--text-secondary)]">{wall.source_pier || wall.area_label || "—"}</td>
                    <td className="px-3 py-2 text-[var(--text-muted)]">{wall.section}</td>
                    <td className="px-3 py-2">
                      {wall.has_analytical && wall.formulation ? (
                        <span className="font-mono text-[var(--primary)] text-[10px]">
                          {wall.formulation.replace(/_/g, "-")}
                        </span>
                      ) : (
                        <span className="text-[var(--text-muted)]">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-[var(--text-secondary)]">{wall.n_fibers ?? "—"}</td>
                    <td className="px-3 py-2">
                      <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${STATUS_STYLE[st]}`}>
                        {STATUS_LABEL[st]}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <button
                        onClick={() => openWall(wall)}
                        disabled={openingLabel === wall.label}
                        className="text-[var(--primary)] hover:underline text-xs disabled:opacity-50 whitespace-nowrap"
                      >
                        {openingLabel === wall.label ? "Loading…" : "Configure →"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="px-4 py-2 border-t border-[var(--border)] bg-[var(--surface-2)] text-[10px] text-[var(--text-muted)]">
            {filtered.length} wall{filtered.length !== 1 ? "s" : ""} shown
            {bulkSelected.size > 0 && ` · ${bulkSelected.size} selected`}
          </div>
        </div>
      )}
    </div>
  );
}
