"use client";

/**
 * InfillsPanel — CRUD de paneles de mampostería de relleno (infills).
 *
 * Un infill se define por dos columnas del canonical (column_i_fid y
 * column_j_fid) que delimitan el vano del panel, el story al que pertenece,
 * el material de mampostería, espesor, ratio de aberturas (Al-Chaar 2002)
 * y width_ratio (Mainstone). Solo participa en el pushover no lineal.
 */
import { useEffect, useMemo, useState } from "react";
import type {
  InfillPanel,
  MasonryMaterial,
  ModelGeometry,
} from "@/lib/structural-types";
import { structuralEditorApi } from "@/lib/structural-api";

interface Props {
  projectId: string;
  infills: Record<string, InfillPanel>;
  masonryMaterials: Record<string, MasonryMaterial>;
  geometry: ModelGeometry;
  onChange?: () => void | Promise<void>;
  /** fids pre-seleccionados desde una herramienta gráfica (ej. click en 2 columnas en 3D/2D). */
  preselectedColumns?: { col_i: string; col_j: string; story: string } | null;
  onPreselectConsumed?: () => void;
  /** Notifica al padre qué fila está siendo "hovered" para resaltarla en 3D. */
  onHoverPanel?: (panelId: string | null) => void;
  /** Si se setea, abre el formulario de edición de ese panel al cambiar el valor. */
  editInfillId?: string | null;
  onEditInfillConsumed?: () => void;
}

interface DraftForm {
  id:                  string;
  column_i_fid:        string;
  column_j_fid:        string;
  story:               string;
  thickness_m:         number;
  masonry_material_id: string;
  opening_ratio:       number;
  width_ratio:         number;
  pier:                string;
}

export default function InfillsPanel({
  projectId, infills, masonryMaterials, geometry, onChange,
  preselectedColumns, onPreselectConsumed, onHoverPanel,
  editInfillId, onEditInfillConsumed,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating,  setCreating]  = useState(false);
  const [draft,     setDraft]     = useState<DraftForm | null>(null);
  const [busy,      setBusy]      = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const [replicateStories, setReplicateStories] = useState<Set<string>>(new Set());
  const [replicateInfo,    setReplicateInfo]    = useState<string | null>(null);
  // Replicación "ex post" desde la tabla: panel source + stories seleccionados.
  const [replicateFromId,  setReplicateFromId]  = useState<string | null>(null);
  const [replicateFromStories, setReplicateFromStories] = useState<Set<string>>(new Set());

  // Columnas del canonical: fid → {story, label, joints}
  type ColumnInfo = { fid: string; story: string; label: string };
  const columnsAll: ColumnInfo[] = useMemo(() => {
    const out: ColumnInfo[] = [];
    for (const [fid, fr] of Object.entries(geometry.frames ?? {})) {
      if ((fr.element_type ?? "").toLowerCase() === "column") {
        out.push({
          fid,
          story: fr.story ?? "",
          label: fr.object_label || fid,
        });
      }
    }
    return out.sort((a, b) => a.story.localeCompare(b.story) || a.label.localeCompare(b.label));
  }, [geometry.frames]);

  const storyNames   = useMemo(() => Object.keys(geometry.stories ?? {}), [geometry.stories]);
  const materialsList = useMemo(() => Object.entries(masonryMaterials), [masonryMaterials]);

  const columnsByStory = useMemo(() => {
    const m: Record<string, ColumnInfo[]> = {};
    for (const c of columnsAll) {
      (m[c.story] ??= []).push(c);
    }
    return m;
  }, [columnsAll]);

  const startCreate = (preset?: { col_i?: string; col_j?: string; story?: string }) => {
    const firstStory = preset?.story || storyNames[0] || "";
    const colsOfStory = columnsByStory[firstStory] ?? [];
    const firstMat = materialsList[0]?.[0] ?? "";
    setCreating(true);
    setEditingId(null);
    setDraft({
      id:                  `INF-${Object.keys(infills).length + 1}`,
      column_i_fid:        preset?.col_i || colsOfStory[0]?.fid || "",
      column_j_fid:        preset?.col_j || colsOfStory[1]?.fid || "",
      story:               firstStory,
      thickness_m:         0.12,
      masonry_material_id: firstMat,
      opening_ratio:       0.0,
      width_ratio:         0.25,
      pier:                "",
    });
    setError(null);
  };

  // Reaccionar a selección gráfica externa.
  useEffect(() => {
    if (!preselectedColumns) return;
    if (!materialsList.length) {
      setError("Define primero un material de mampostería para crear infills gráficamente.");
      onPreselectConsumed?.();
      return;
    }
    startCreate(preselectedColumns);
    onPreselectConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preselectedColumns]);

  // Reaccionar a petición externa de abrir un edit (ej. click en 3D).
  useEffect(() => {
    if (!editInfillId) return;
    if (!infills[editInfillId]) {
      onEditInfillConsumed?.();
      return;
    }
    startEdit(editInfillId);
    onEditInfillConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editInfillId]);

  const startEdit = (id: string) => {
    const inf = infills[id];
    if (!inf) return;
    setEditingId(id);
    setCreating(false);
    setDraft({
      id:                  inf.id,
      column_i_fid:        inf.column_i_fid ?? "",
      column_j_fid:        inf.column_j_fid ?? "",
      story:               inf.story,
      thickness_m:         inf.thickness_m,
      masonry_material_id: inf.masonry_material_id,
      opening_ratio:       inf.opening_ratio,
      width_ratio:         inf.width_ratio,
      pier:                inf.pier ?? "",
    });
    setError(null);
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true); setError(null);
    try {
      if (!draft.column_i_fid || !draft.column_j_fid) throw new Error("Selecciona las 2 columnas del vano");
      if (draft.column_i_fid === draft.column_j_fid)  throw new Error("Las dos columnas deben ser distintas");
      if (!draft.story) throw new Error("Selecciona un story");
      if (!draft.masonry_material_id) throw new Error("Selecciona un material de mampostería");
      if (draft.thickness_m <= 0) throw new Error("El espesor debe ser > 0");

      const payload = {
        column_i_fid:        draft.column_i_fid,
        column_j_fid:        draft.column_j_fid,
        pier:                draft.pier || "",
        story:               draft.story,
        thickness_m:         draft.thickness_m,
        masonry_material_id: draft.masonry_material_id,
        opening_ratio:       draft.opening_ratio,
        width_ratio:         draft.width_ratio,
      };
      if (creating) {
        await structuralEditorApi.createInfill(projectId, { id: draft.id, ...payload });
        // Replicación en altura (opcional).
        if (replicateStories.size > 0) {
          const resp = await structuralEditorApi.replicateInfill(projectId, {
            source_infill_id: draft.id,
            target_stories:   Array.from(replicateStories),
            id_prefix:        draft.id,
          });
          const parts: string[] = [];
          if (resp.n_created > 0) parts.push(`${resp.n_created} replicado(s)`);
          if (resp.n_skipped > 0) {
            const reasons = resp.skipped.map((s) => `${s.story} (${s.reason})`).join("; ");
            parts.push(`${resp.n_skipped} saltado(s): ${reasons}`);
          }
          if (parts.length) setReplicateInfo(parts.join(" · "));
        }
      } else if (editingId) {
        await structuralEditorApi.updateInfill(projectId, editingId, payload);
      }
      setCreating(false);
      setEditingId(null);
      setDraft(null);
      setReplicateStories(new Set());
      await onChange?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const openReplicateFor = (id: string) => {
    const src = infills[id];
    if (!src) return;
    const srcZ = geometry.stories[src.story]?.elevation_m ?? 0;
    // Default: todos los pisos superiores al source.
    const defaults = new Set(storyNames.filter(
      (s) => s !== src.story && (geometry.stories[s]?.elevation_m ?? 0) > srcZ
    ));
    setReplicateFromId(id);
    setReplicateFromStories(defaults);
    setError(null);
  };

  const runReplicate = async () => {
    if (!replicateFromId) return;
    if (replicateFromStories.size === 0) {
      setError("Selecciona al menos un piso destino.");
      return;
    }
    setBusy(true); setError(null);
    try {
      const resp = await structuralEditorApi.replicateInfill(projectId, {
        source_infill_id: replicateFromId,
        target_stories:   Array.from(replicateFromStories),
        id_prefix:        replicateFromId,
      });
      const parts: string[] = [];
      if (resp.n_created > 0) parts.push(`${resp.n_created} replicado(s)`);
      if (resp.n_skipped > 0) {
        const reasons = resp.skipped.map((s) => `${s.story} (${s.reason})`).join("; ");
        parts.push(`${resp.n_skipped} saltado(s): ${reasons}`);
      }
      setReplicateInfo(parts.length ? parts.join(" · ") : "Sin cambios.");
      setReplicateFromId(null);
      setReplicateFromStories(new Set());
      await onChange?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm(`¿Eliminar infill '${id}'?`)) return;
    setBusy(true); setError(null);
    try {
      await structuralEditorApi.deleteInfill(projectId, id);
      await onChange?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const editing = creating || editingId !== null;

  const lambdaOpenings = useMemo(() => {
    if (!draft) return 1;
    const r = Math.max(0, Math.min(1, draft.opening_ratio));
    if (r === 0) return 1;
    if (r >= 1) return 0;
    return Math.max(0, 1 - 2 * Math.pow(r, 0.54) + Math.pow(r, 1.14));
  }, [draft]);

  const columnOptions = useMemo(() => {
    if (!draft) return columnsAll;
    const inStory = columnsByStory[draft.story] ?? [];
    return inStory.length ? inStory : columnsAll;
  }, [draft, columnsByStory, columnsAll]);

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-[var(--text)]" title="Dos columnas delimitan el vano. En pushover se insertan 2 puntales cruzados (RCF-AD) con reducción Al-Chaar.">
          Infills
        </h3>
        {!editing && materialsList.length > 0 && columnsAll.length >= 2 && (
          <button
            onClick={() => startCreate()}
            className="text-[10px] px-2 py-1 rounded bg-blue-600 text-white font-medium hover:bg-blue-700"
          >
            + Nuevo
          </button>
        )}
      </div>

      {error && (
        <div className="text-[11px] px-3 py-2 rounded bg-red-50 border border-red-200 text-red-700 font-mono">
          {error}
        </div>
      )}

      {materialsList.length === 0 && (
        <div className="text-[11px] px-3 py-2 rounded bg-amber-50 border border-amber-200 text-amber-800">
          Primero define al menos un material de mampostería.
        </div>
      )}
      {columnsAll.length < 2 && materialsList.length > 0 && (
        <div className="text-[11px] px-3 py-2 rounded bg-amber-50 border border-amber-200 text-amber-800">
          Necesitas al menos 2 columnas en el modelo para crear un infill.
        </div>
      )}

      {editing && draft && (
        <div className="border border-[var(--border)] rounded-lg bg-[var(--surface-2)] p-3 space-y-2 text-[11px]">
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[var(--text-muted)]">ID</span>
              <input
                value={draft.id}
                disabled={!creating}
                onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 font-mono disabled:opacity-50"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[var(--text-muted)]">Story</span>
              <select
                value={draft.story}
                onChange={(e) => setDraft({ ...draft, story: e.target.value, column_i_fid: "", column_j_fid: "" })}
                className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1"
              >
                {storyNames.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[var(--text-muted)]">Columna I (izq)</span>
              <select
                value={draft.column_i_fid}
                onChange={(e) => setDraft({ ...draft, column_i_fid: e.target.value })}
                className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 font-mono"
              >
                <option value="">—</option>
                {columnOptions.map((c) => (
                  <option key={c.fid} value={c.fid}>{c.label} ({c.story})</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[var(--text-muted)]">Columna J (der)</span>
              <select
                value={draft.column_j_fid}
                onChange={(e) => setDraft({ ...draft, column_j_fid: e.target.value })}
                className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 font-mono"
              >
                <option value="">—</option>
                {columnOptions.map((c) => (
                  <option key={c.fid} value={c.fid}>{c.label} ({c.story})</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[var(--text-muted)]">Material</span>
              <select
                value={draft.masonry_material_id}
                onChange={(e) => setDraft({ ...draft, masonry_material_id: e.target.value })}
                className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1"
              >
                {materialsList.map(([id, m]) => (
                  <option key={id} value={id}>{m.name} · fm={m.fm_mpa} · {m.brick_type}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[var(--text-muted)]">Espesor (m)</span>
              <input
                type="number" step="0.01" min={0.05} max={1}
                value={draft.thickness_m}
                onChange={(e) => setDraft({ ...draft, thickness_m: Math.max(0.05, Number(e.target.value) || 0.12) })}
                className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 font-mono"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[var(--text-muted)]">width_ratio (Mainstone)</span>
              <input
                type="number" step="0.01" min={0.05} max={0.5}
                value={draft.width_ratio}
                onChange={(e) => setDraft({ ...draft, width_ratio: Math.max(0.05, Math.min(0.5, Number(e.target.value) || 0.25)) })}
                className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 font-mono"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[var(--text-muted)]">Pier (opcional, etiqueta)</span>
              <input
                value={draft.pier}
                onChange={(e) => setDraft({ ...draft, pier: e.target.value })}
                className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 font-mono"
                placeholder="(descriptivo)"
              />
            </label>
          </div>

          <div className="pt-1 border-t border-[var(--border)] space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-[var(--text-muted)] w-40">opening_ratio (aberturas)</span>
              <input
                type="range" min={0} max={0.95} step={0.05}
                value={draft.opening_ratio}
                onChange={(e) => setDraft({ ...draft, opening_ratio: Number(e.target.value) })}
                className="flex-1"
              />
              <span className="font-mono w-12 text-right">{(draft.opening_ratio * 100).toFixed(0)}%</span>
            </div>
            <div className="text-[10px] text-[var(--text-muted)] font-mono">
              λ Al-Chaar = {lambdaOpenings.toFixed(3)} · área efectiva se reduce a {(lambdaOpenings * 100).toFixed(1)}%
            </div>
          </div>

          {storyNames.length > 1 && (
            <div className="pt-1 border-t border-[var(--border)] space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[var(--text-muted)] font-semibold">
                  {creating ? "Replicar en pisos:" : "Replicar este infill en pisos:"}
                </span>
                <div className="flex gap-1">
                  <button type="button"
                    onClick={() => setReplicateStories(new Set(storyNames.filter((s) => s !== draft.story)))}
                    className="text-[10px] px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]">
                    Todos
                  </button>
                  <button type="button"
                    onClick={() => {
                      const z = geometry.stories[draft.story]?.elevation_m ?? 0;
                      setReplicateStories(new Set(storyNames.filter((s) => (geometry.stories[s]?.elevation_m ?? 0) > z)));
                    }}
                    className="text-[10px] px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]">
                    Superiores
                  </button>
                  <button type="button"
                    onClick={() => setReplicateStories(new Set())}
                    className="text-[10px] px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]">
                    Ninguno
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {storyNames
                  .filter((s) => s !== draft.story)
                  .sort((a, b) => (geometry.stories[a]?.elevation_m ?? 0) - (geometry.stories[b]?.elevation_m ?? 0))
                  .map((s) => {
                    const on = replicateStories.has(s);
                    return (
                      <button type="button" key={s}
                        onClick={() => {
                          const next = new Set(replicateStories);
                          if (on) next.delete(s); else next.add(s);
                          setReplicateStories(next);
                        }}
                        className={[
                          "text-[10px] px-2 py-0.5 rounded border font-mono",
                          on ? "bg-blue-600 text-white border-blue-700"
                             : "bg-[var(--surface)] text-[var(--text-muted)] border-[var(--border)] hover:text-[var(--text)]",
                        ].join(" ")}
                      >{s}</button>
                    );
                  })}
              </div>
              <p className="text-[10px] text-[var(--text-muted)]">
                {creating
                  ? "Se buscará automáticamente la pareja de columnas homólogas en cada piso seleccionado (snap XY ≤ 0.3 m)."
                  : "Al clic en \"Replicar en N\" se crearán los paneles sin tocar los parámetros del original."}
              </p>
              {!creating && editingId && (
                <button
                  onClick={async () => {
                    if (replicateStories.size === 0 || !editingId) return;
                    setBusy(true); setError(null);
                    try {
                      const resp = await structuralEditorApi.replicateInfill(projectId, {
                        source_infill_id: editingId,
                        target_stories:   Array.from(replicateStories),
                        id_prefix:        editingId,
                      });
                      const parts: string[] = [];
                      if (resp.n_created > 0) parts.push(`${resp.n_created} replicado(s)`);
                      if (resp.n_skipped > 0) {
                        const reasons = resp.skipped.map((s) => `${s.story} (${s.reason})`).join("; ");
                        parts.push(`${resp.n_skipped} saltado(s): ${reasons}`);
                      }
                      setReplicateInfo(parts.length ? parts.join(" · ") : "Sin cambios.");
                      setReplicateStories(new Set());
                      await onChange?.();
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                  disabled={busy || replicateStories.size === 0}
                  className="text-xs px-3 py-1.5 rounded bg-emerald-600 text-white font-medium disabled:opacity-40 hover:bg-emerald-700">
                  {busy ? "Replicando..." : `Replicar en ${replicateStories.size}`}
                </button>
              )}
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <button onClick={save} disabled={busy}
              className="text-xs px-3 py-1.5 rounded bg-blue-600 text-white font-medium disabled:opacity-40 hover:bg-blue-700">
              {busy ? "Guardando..." : creating
                ? (replicateStories.size > 0 ? `Crear + replicar en ${replicateStories.size}` : "Crear infill")
                : "Guardar cambios"}
            </button>
            <button onClick={() => { setCreating(false); setEditingId(null); setDraft(null); setReplicateStories(new Set()); }}
              className="text-xs px-3 py-1.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]">
              Cancelar
            </button>
          </div>
        </div>
      )}

      {replicateInfo && (
        <div className="text-[11px] px-3 py-2 rounded bg-blue-50 border border-blue-200 text-blue-700 flex items-start justify-between gap-3">
          <span>{replicateInfo}</span>
          <button onClick={() => setReplicateInfo(null)} className="text-blue-700 hover:text-blue-900 font-semibold">×</button>
        </div>
      )}

      {!editing && Object.keys(infills).length === 0 && (
        <p className="text-[11px] text-[var(--text-muted)] text-center py-4">
          Sin infills definidos. Añade uno manualmente o usa la herramienta de
          selección de columnas en la vista 2D/3D.
        </p>
      )}

      {!editing && Object.keys(infills).length > 0 && (
        <div className="flex flex-col text-[11px]">
          <div className="flex items-center justify-between px-1 pb-0.5 text-[9px] text-[var(--text-muted)] uppercase tracking-wider border-b border-[var(--border)]">
            <span>{Object.keys(infills).length} infill(s)</span>
            <span>t · ab · ⋯</span>
          </div>
          {Object.entries(infills).map(([id, inf]) => {
            const ci = geometry.frames?.[inf.column_i_fid ?? ""]?.object_label ?? inf.column_i_fid ?? "—";
            const cj = geometry.frames?.[inf.column_j_fid ?? ""]?.object_label ?? inf.column_j_fid ?? "—";
            const matName = masonryMaterials[inf.masonry_material_id]?.name ?? inf.masonry_material_id;
            const titleTip = `${id}\n${inf.story} · ${ci}↔${cj}\n${matName}\nt=${inf.thickness_m.toFixed(3)}m · ab=${(inf.opening_ratio * 100).toFixed(0)}% · wr=${inf.width_ratio.toFixed(2)}`;
            return (
              <div key={id}
                  onMouseEnter={() => onHoverPanel?.(id)}
                  onMouseLeave={() => onHoverPanel?.(null)}
                  title={titleTip}
                  className="flex items-center gap-1.5 px-1 py-0.5 hover:bg-[var(--surface-2)] transition-colors border-b border-[var(--border)]/60">
                <span className="font-mono text-[10px] text-[var(--text)] truncate min-w-0 flex-1" style={{ maxWidth: 100 }}>{id}</span>
                <span className="font-mono text-[9px] text-[var(--text-muted)] truncate flex-shrink min-w-0" style={{ maxWidth: 70 }}>{inf.story}</span>
                <span className="font-mono text-[9px] text-[var(--text-muted)] tabular-nums whitespace-nowrap">
                  {inf.thickness_m.toFixed(2)}·{(inf.opening_ratio * 100).toFixed(0)}%
                </span>
                <div className="flex items-center gap-0 flex-shrink-0">
                  <button onClick={() => startEdit(id)} title="Editar / Replicar"
                    className="w-4 h-4 flex items-center justify-center rounded text-blue-600 hover:bg-blue-100 text-[10px]">
                    ✎
                  </button>
                  <button onClick={() => openReplicateFor(id)} disabled={busy || storyNames.length <= 1}
                    title="Replicar en pisos"
                    className="w-4 h-4 flex items-center justify-center rounded text-emerald-600 hover:bg-emerald-100 disabled:opacity-30 text-[10px]">
                    ⇧
                  </button>
                  <button onClick={() => remove(id)} disabled={busy} title="Eliminar"
                    className="w-4 h-4 flex items-center justify-center rounded text-red-600 hover:bg-red-100 text-[11px]">
                    ×
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!editing && replicateFromId && infills[replicateFromId] && (
        <div className="border border-emerald-300 bg-emerald-50 rounded-lg p-3 space-y-2 text-[11px]">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-emerald-900">
              Replicar <span className="font-mono">{replicateFromId}</span> (story <span className="font-mono">{infills[replicateFromId].story}</span>) en:
            </span>
            <div className="flex gap-1">
              <button type="button"
                onClick={() => setReplicateFromStories(new Set(storyNames.filter((s) => s !== infills[replicateFromId].story)))}
                className="text-[10px] px-2 py-0.5 rounded border border-emerald-300 bg-white text-emerald-700 hover:bg-emerald-100">
                Todos
              </button>
              <button type="button"
                onClick={() => {
                  const z = geometry.stories[infills[replicateFromId].story]?.elevation_m ?? 0;
                  setReplicateFromStories(new Set(storyNames.filter((s) => (geometry.stories[s]?.elevation_m ?? 0) > z)));
                }}
                className="text-[10px] px-2 py-0.5 rounded border border-emerald-300 bg-white text-emerald-700 hover:bg-emerald-100">
                Superiores
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {storyNames
              .filter((s) => s !== infills[replicateFromId].story)
              .sort((a, b) => (geometry.stories[a]?.elevation_m ?? 0) - (geometry.stories[b]?.elevation_m ?? 0))
              .map((s) => {
                const on = replicateFromStories.has(s);
                return (
                  <button type="button" key={s}
                    onClick={() => {
                      const next = new Set(replicateFromStories);
                      if (on) next.delete(s); else next.add(s);
                      setReplicateFromStories(next);
                    }}
                    className={[
                      "text-[10px] px-2 py-0.5 rounded border font-mono",
                      on ? "bg-emerald-600 text-white border-emerald-700"
                         : "bg-white text-emerald-700 border-emerald-300 hover:bg-emerald-100",
                    ].join(" ")}
                  >{s}</button>
                );
              })}
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button onClick={runReplicate} disabled={busy || replicateFromStories.size === 0}
              className="text-xs px-3 py-1.5 rounded bg-emerald-600 text-white font-medium disabled:opacity-40 hover:bg-emerald-700">
              {busy ? "Replicando..." : `Replicar en ${replicateFromStories.size}`}
            </button>
            <button onClick={() => { setReplicateFromId(null); setReplicateFromStories(new Set()); }}
              className="text-xs px-3 py-1.5 rounded border border-emerald-300 bg-white text-emerald-700 hover:bg-emerald-100">
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
