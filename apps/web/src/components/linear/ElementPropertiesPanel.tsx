"use client";

/**
 * ElementPropertiesPanel — panel lateral de propiedades del elemento o
 * elementos seleccionados.
 *
 * Fase 1: selección única con delete + reasignar sección (para frames).
 * Fase 2: selección múltiple (shift+clic en 2D) con batch delete + batch
 *         reassign section, release para frames, y replicar lineal para
 *         columnas seleccionadas.
 */
import { useEffect, useMemo, useState } from "react";
import { ApiError } from "@/lib/api";
import { structuralEditorApi } from "@/lib/structural-api";
import type {
  FrameGeometry,
  ModelGeometry,
  SectionData,
  ShellSummary,
} from "@/lib/structural-types";

export type SelectedElement =
  | { kind: "column";  id: string }
  | { kind: "beam";    id: string }
  | { kind: "wall";    id: string }
  | { kind: "slab";    id: string };

interface Props {
  projectId: string;
  geometry:  ModelGeometry;
  sections?: Record<string, SectionData>;
  selected:  SelectedElement[];
  onClose:   () => void;
  onChanged: () => void | Promise<void>;
}

const KIND_LABEL: Record<SelectedElement["kind"], string> = {
  column: "Columna",
  beam:   "Viga",
  wall:   "Muro",
  slab:   "Losa",
};

const KIND_PLURAL: Record<SelectedElement["kind"], string> = {
  column: "Columnas",
  beam:   "Vigas",
  wall:   "Muros",
  slab:   "Losas",
};

const KIND_COLOR: Record<SelectedElement["kind"], string> = {
  column: "#6366f1",
  beam:   "#10b981",
  wall:   "#f59e0b",
  slab:   "#64748b",
};

const RELEASE_LABEL: Record<string, string> = {
  "":   "Empotrado (ambos extremos)",
  "i":  "Articulado en i",
  "j":  "Articulado en j",
  "ij": "Articulado en ambos extremos",
};

export function ElementPropertiesPanel({
  projectId, geometry, sections, selected, onClose, onChanged,
}: Props) {
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Modo uni vs multi
  const isSingle = selected.length === 1;
  const isMulti  = selected.length > 1;

  const availableSections = useMemo(
    () => Object.keys(sections ?? {}).sort(),
    [sections],
  );

  // Atajo teclado Delete + Esc
  useEffect(() => {
    if (selected.length === 0) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.key === "Delete" || e.key === "Backspace") && !busy) {
        e.preventDefault();
        void handleDelete();
      } else if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, busy]);

  async function handleDelete() {
    const nFrames = selected.filter((s) => s.kind === "column" || s.kind === "beam").length;
    const nShells = selected.filter((s) => s.kind === "wall"   || s.kind === "slab").length;
    const label = isSingle
      ? `${KIND_LABEL[selected[0].kind].toLowerCase()} ${selected[0].id}`
      : `${selected.length} elementos (${nFrames} frames + ${nShells} shells)`;
    if (!window.confirm(`¿Eliminar ${label}? Esta acción no se puede deshacer.`)) return;
    setBusy(true); setError(null);
    try {
      for (const s of selected) {
        if (s.kind === "column" || s.kind === "beam") {
          await structuralEditorApi.deleteFrame(projectId, s.id);
        } else {
          await structuralEditorApi.deleteShell(projectId, s.id);
        }
      }
      await onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (selected.length === 0) return null;

  return (
    <aside
      className="flex flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm"
      style={{ width: 340, flexShrink: 0 }}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="min-w-0">
          {isSingle ? (
            <>
              <div className="flex items-center gap-2">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full flex-shrink-0"
                  style={{ background: KIND_COLOR[selected[0].kind] }}
                />
                <h3 className="text-sm font-semibold text-[var(--text)]">
                  {KIND_LABEL[selected[0].kind]}
                </h3>
              </div>
              <p className="text-[11px] text-[var(--text-muted)] font-mono mt-0.5 truncate">
                {selected[0].id}
              </p>
            </>
          ) : (
            <MultiHeader selected={selected} />
          )}
        </div>
        <button
          onClick={onClose}
          className="text-[var(--text-muted)] hover:text-[var(--text)] transition"
          title="Cerrar (Esc)"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Contenido */}
      {isSingle && (
        <SinglePanel
          projectId={projectId}
          geometry={geometry}
          availableSections={availableSections}
          selected={selected[0]}
          onChanged={onChanged}
          busy={busy} setBusy={setBusy}
          setError={setError}
        />
      )}

      {isMulti && (
        <MultiPanel
          projectId={projectId}
          availableSections={availableSections}
          selected={selected}
          onChanged={onChanged}
          busy={busy} setBusy={setBusy}
          setError={setError}
        />
      )}

      {/* Error */}
      {error && (
        <div className="mt-3 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-500">
          {error}
        </div>
      )}

      {/* Acciones */}
      <div className="mt-auto pt-3 border-t border-[var(--border)]">
        <button
          onClick={handleDelete}
          disabled={busy}
          className="w-full px-3 py-2 rounded-md bg-rose-600 text-white text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-rose-700 transition flex items-center justify-center gap-2"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6M5 6h14l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6Z" />
          </svg>
          {busy ? "Procesando…" : isMulti ? `Eliminar ${selected.length}` : "Eliminar"}
        </button>
        <p className="text-[10px] text-center text-[var(--text-muted)] mt-1.5">
          <kbd className="px-1 py-0.5 bg-[var(--panel-muted)] rounded text-[9px]">Shift+Clic</kbd> añadir · <kbd className="px-1 py-0.5 bg-[var(--panel-muted)] rounded text-[9px]">Del</kbd> eliminar · <kbd className="px-1 py-0.5 bg-[var(--panel-muted)] rounded text-[9px]">Esc</kbd> cerrar
        </p>
      </div>
    </aside>
  );
}

// ── Header de selección múltiple ─────────────────────────────────────────────
function MultiHeader({ selected }: { selected: SelectedElement[] }) {
  const counts: Record<SelectedElement["kind"], number> = { column: 0, beam: 0, wall: 0, slab: 0 };
  for (const s of selected) counts[s.kind]++;
  const breakdown = (Object.entries(counts) as [SelectedElement["kind"], number][])
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${n === 1 ? KIND_LABEL[k].toLowerCase() : KIND_PLURAL[k].toLowerCase()}`);
  return (
    <>
      <h3 className="text-sm font-semibold text-[var(--text)]">
        {selected.length} elementos seleccionados
      </h3>
      <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
        {breakdown.join(" · ")}
      </p>
    </>
  );
}

// ── Panel single: Fase 1 + release + replicar (columnas) ─────────────────────
function SinglePanel({
  projectId, geometry, availableSections, selected, onChanged,
  busy, setBusy, setError,
}: {
  projectId: string;
  geometry:  ModelGeometry;
  availableSections: string[];
  selected:  SelectedElement;
  onChanged: () => void | Promise<void>;
  busy:      boolean;
  setBusy:   (v: boolean) => void;
  setError:  (v: string | null) => void;
}) {
  const isFrame = selected.kind === "column" || selected.kind === "beam";
  const isShell = selected.kind === "wall"   || selected.kind === "slab";

  const frame: FrameGeometry | undefined = isFrame ? geometry.frames[selected.id] : undefined;
  const shell: ShellSummary  | undefined = isShell ? geometry.shells[selected.id] : undefined;

  const [draftSection, setDraftSection] = useState<string>(frame?.section ?? shell?.section ?? "");
  const [draftRelease, setDraftRelease] = useState<string>(frame?.release ?? "");

  // Replicar (solo columnas)
  const [arrDx,    setArrDx]    = useState<string>("5");
  const [arrDy,    setArrDy]    = useState<string>("0");
  const [arrCount, setArrCount] = useState<string>("3");

  useEffect(() => {
    setDraftSection(frame?.section ?? shell?.section ?? "");
    setDraftRelease(frame?.release ?? "");
  }, [frame, shell, selected]);

  if (isFrame && !frame)
    return <p className="text-xs italic text-amber-500">Frame {selected.id} ya no existe.</p>;
  if (isShell && !shell)
    return <p className="text-xs italic text-amber-500">Shell {selected.id} ya no existe.</p>;

  const jointI = frame ? geometry.joints[frame.joint_i] : undefined;
  const jointJ = frame ? geometry.joints[frame.joint_j] : undefined;

  async function handlePatchFrame(patch: { section?: string; release?: "" | "i" | "j" | "ij" }) {
    if (!isFrame) return;
    setBusy(true); setError(null);
    try {
      await structuralEditorApi.updateFrame(projectId, selected.id, patch);
      await onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleReplicateShell() {
    if (!isShell) return;
    const dx    = Number(arrDx);
    const dy    = Number(arrDy);
    const count = Math.max(2, Math.min(50, Math.round(Number(arrCount) || 0)));
    if (!isFinite(dx) || !isFinite(dy) || Math.hypot(dx, dy) < 0.01) {
      setError("Offset inválido: necesitas Δx ó Δy ≠ 0."); return;
    }
    setBusy(true); setError(null);
    try {
      await structuralEditorApi.replicateShell(projectId, selected.id, { dx, dy, count });
      await onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleReplicateFrame() {
    if (!isFrame || !frame) return;
    const dx    = Number(arrDx);
    const dy    = Number(arrDy);
    const count = Math.max(2, Math.min(50, Math.round(Number(arrCount) || 0)));
    if (!isFinite(dx) || !isFinite(dy) || Math.hypot(dx, dy) < 0.01) {
      setError("Offset inválido: necesitas Δx ó Δy ≠ 0."); return;
    }
    setBusy(true); setError(null);
    // Sufijo aleatorio para evitar colisiones en replicaciones sucesivas
    const salt = Math.random().toString(36).slice(2, 6);
    try {
      const copies = count - 1;
      const ji = jointI!, jj = jointJ!;
      for (let k = 1; k <= copies; k++) {
        const odx = dx * k, ody = dy * k;
        const newIId = `${frame.joint_i}_r${k}_${salt}`;
        const newJId = `${frame.joint_j}_r${k}_${salt}`;
        await structuralEditorApi.createJoint(projectId, {
          id: newIId, x: ji.x + odx, y: ji.y + ody, z: ji.z,
          story: ji.story, is_restrained: ji.is_restrained,
        });
        await structuralEditorApi.createJoint(projectId, {
          id: newJId, x: jj.x + odx, y: jj.y + ody, z: jj.z,
          story: jj.story, is_restrained: selected.kind === "column" ? false : jj.is_restrained,
        });
        await structuralEditorApi.createFrame(projectId, {
          id:           `${selected.id}_r${k}_${salt}`,
          joint_i:      newIId,
          joint_j:      newJId,
          section:      frame.section,
          element_type: selected.kind as "column" | "beam",
          story:        frame.story,
        });
      }
      await onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 text-xs">
      {/* Propiedades */}
      <div className="space-y-1.5">
        {frame && (
          <>
            <PropRow label="Piso"     value={frame.story} />
            <PropRow label="Nodo i"   value={`${frame.joint_i}${jointI ? ` (${jointI.x.toFixed(2)}, ${jointI.y.toFixed(2)}, ${jointI.z.toFixed(2)})` : ""}`} />
            <PropRow label="Nodo j"   value={`${frame.joint_j}${jointJ ? ` (${jointJ.x.toFixed(2)}, ${jointJ.y.toFixed(2)}, ${jointJ.z.toFixed(2)})` : ""}`} />
          </>
        )}
        {shell && (
          <>
            <PropRow label="Piso"      value={shell.story} />
            <PropRow label="Nodos"     value={shell.joints.join(" → ")} mono small />
            <PropRow label="Espesor"   value={`${(shell.thickness_m * 1000).toFixed(0)} mm`} />
            {shell.pier && <PropRow label="Pier" value={shell.pier} mono />}
          </>
        )}
      </div>

      {/* Sección (frames) */}
      {isFrame && availableSections.length > 0 && (
        <div>
          <label className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] block mb-1">
            Sección
          </label>
          <div className="flex gap-2">
            <select
              value={draftSection}
              onChange={(e) => setDraftSection(e.target.value)}
              disabled={busy}
              className="flex-1 rounded-md bg-[var(--panel-muted)] px-2 py-1.5 text-xs font-mono text-[var(--text)] disabled:opacity-50"
            >
              {availableSections.map((s) => (<option key={s} value={s}>{s}</option>))}
            </select>
            <button
              onClick={() => handlePatchFrame({ section: draftSection })}
              disabled={busy || !draftSection || draftSection === frame?.section}
              className="px-3 py-1.5 rounded-md bg-indigo-600 text-white text-[11px] font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-indigo-700 transition"
            >
              Aplicar
            </button>
          </div>
        </div>
      )}

      {/* Release (frames) */}
      {isFrame && (
        <div>
          <label className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] block mb-1">
            Release / tipo conexión
          </label>
          <div className="flex gap-2">
            <select
              value={draftRelease}
              onChange={(e) => setDraftRelease(e.target.value)}
              disabled={busy}
              className="flex-1 rounded-md bg-[var(--panel-muted)] px-2 py-1.5 text-xs text-[var(--text)] disabled:opacity-50"
            >
              {Object.entries(RELEASE_LABEL).map(([val, label]) => (
                <option key={val} value={val}>{label}</option>
              ))}
            </select>
            <button
              onClick={() => handlePatchFrame({ release: draftRelease as "" | "i" | "j" | "ij" })}
              disabled={busy || draftRelease === (frame?.release ?? "")}
              className="px-3 py-1.5 rounded-md bg-indigo-600 text-white text-[11px] font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-indigo-700 transition"
            >
              Aplicar
            </button>
          </div>
        </div>
      )}

      {/* Replicar lineal (columnas, vigas, muros, losas) */}
      {(isFrame || isShell) && (
        <details className="rounded-md border border-[var(--border)] p-2 bg-[var(--panel-muted)]/20">
          <summary className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] cursor-pointer">
            Replicar lineal
          </summary>
          <div className="pt-2 space-y-2">
            <div className="grid grid-cols-3 gap-1.5 text-[11px]">
              <NumField label="Δx (m)"  value={arrDx}    onChange={setArrDx} />
              <NumField label="Δy (m)"  value={arrDy}    onChange={setArrDy} />
              <NumField label="N total" value={arrCount} onChange={setArrCount} />
            </div>
            <button
              onClick={isFrame ? handleReplicateFrame : handleReplicateShell}
              disabled={busy}
              className="w-full px-3 py-1.5 rounded-md bg-emerald-600 text-white text-[11px] font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-emerald-700 transition"
            >
              {busy ? "Replicando…" : `Crear ${Math.max(0, Math.min(49, Math.round(Number(arrCount) || 0) - 1))} copias`}
            </button>
            <p className="text-[10px] italic text-[var(--text-muted)]">
              {isShell
                ? "El endpoint backend reutiliza joints existentes dentro de 5 cm."
                : "Las copias crean joints nuevos. Usa Mover para fusionarlos con existentes."}
            </p>
          </div>
        </details>
      )}
    </div>
  );
}

// ── Panel multi: batch section + info ────────────────────────────────────────
function MultiPanel({
  projectId, availableSections, selected, onChanged, busy, setBusy, setError,
}: {
  projectId: string;
  availableSections: string[];
  selected:  SelectedElement[];
  onChanged: () => void | Promise<void>;
  busy:      boolean;
  setBusy:   (v: boolean) => void;
  setError:  (v: string | null) => void;
}) {
  const [batchSection, setBatchSection] = useState<string>("");
  const [mirrorAxis,   setMirrorAxis]   = useState<"x" | "y">("x");
  const [mirrorCoord,  setMirrorCoord]  = useState<string>("0");
  const frameIds = selected
    .filter((s) => s.kind === "column" || s.kind === "beam")
    .map((s) => s.id);

  async function handleBatchAssign() {
    if (!batchSection || frameIds.length === 0) return;
    setBusy(true); setError(null);
    try {
      await structuralEditorApi.assignSection(projectId, frameIds, batchSection);
      await onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleMirror() {
    const coord = Number(mirrorCoord);
    if (!isFinite(coord)) { setError("Coordenada de espejo no válida"); return; }
    setBusy(true); setError(null);
    try {
      await structuralEditorApi.mirrorElements(projectId, {
        elements: selected.map((s) => ({ kind: s.kind, id: s.id })),
        axis:  mirrorAxis,
        coord,
      });
      await onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 text-xs">
      {/* IDs seleccionados (lista compacta) */}
      <details className="rounded-md border border-[var(--border)] p-2 bg-[var(--panel-muted)]/20">
        <summary className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] cursor-pointer">
          IDs ({selected.length})
        </summary>
        <ul className="pt-2 max-h-40 overflow-y-auto space-y-0.5 text-[10px] font-mono text-[var(--text-muted)]">
          {selected.map((s) => (
            <li key={`${s.kind}-${s.id}`}>
              <span className="text-[var(--text)]">{s.id}</span>
              <span className="ml-1 text-[9px]">· {KIND_LABEL[s.kind].toLowerCase()}</span>
            </li>
          ))}
        </ul>
      </details>

      {/* Batch assign section (solo si hay frames seleccionados) */}
      {frameIds.length > 0 && availableSections.length > 0 && (
        <div>
          <label className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] block mb-1">
            Reasignar sección a {frameIds.length} frames
          </label>
          <div className="flex gap-2">
            <select
              value={batchSection}
              onChange={(e) => setBatchSection(e.target.value)}
              disabled={busy}
              className="flex-1 rounded-md bg-[var(--panel-muted)] px-2 py-1.5 text-xs font-mono text-[var(--text)] disabled:opacity-50"
            >
              <option value="">— Elegir —</option>
              {availableSections.map((s) => (<option key={s} value={s}>{s}</option>))}
            </select>
            <button
              onClick={handleBatchAssign}
              disabled={busy || !batchSection}
              className="px-3 py-1.5 rounded-md bg-indigo-600 text-white text-[11px] font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-indigo-700 transition"
            >
              Aplicar
            </button>
          </div>
        </div>
      )}

      {/* Espejo (mirror) */}
      <details className="rounded-md border border-[var(--border)] p-2 bg-[var(--panel-muted)]/20">
        <summary className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] cursor-pointer">
          Reflejar (espejo)
        </summary>
        <div className="pt-2 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-[var(--text-muted)]">Eje de espejo:</span>
            <div className="flex gap-1">
              <button
                onClick={() => setMirrorAxis("x")}
                className={`px-2 py-0.5 rounded text-[10px] ${mirrorAxis === "x" ? "bg-indigo-600 text-white" : "bg-[var(--panel-muted)]"}`}
              >Horizontal (y=k)</button>
              <button
                onClick={() => setMirrorAxis("y")}
                className={`px-2 py-0.5 rounded text-[10px] ${mirrorAxis === "y" ? "bg-indigo-600 text-white" : "bg-[var(--panel-muted)]"}`}
              >Vertical (x=k)</button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-[var(--text-muted)]">
              {mirrorAxis === "x" ? "y =" : "x ="}
            </span>
            <input
              type="number"
              step="0.1"
              value={mirrorCoord}
              onChange={(e) => setMirrorCoord(e.target.value)}
              className="w-24 rounded bg-[var(--panel-muted)] px-2 py-0.5 text-[11px] font-mono text-[var(--text)]"
            />
            <span className="text-[10px] text-[var(--text-muted)]">m</span>
            <button
              onClick={handleMirror}
              disabled={busy}
              className="ml-auto px-3 py-1 rounded-md bg-emerald-600 text-white text-[11px] font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-emerald-700 transition"
            >
              {busy ? "Reflejando…" : "Reflejar"}
            </button>
          </div>
          <p className="text-[10px] italic text-[var(--text-muted)]">
            Crea una copia espejada de los {selected.length} elementos al otro lado del eje.
          </p>
        </div>
      </details>
    </div>
  );
}

// ── Mini componentes ─────────────────────────────────────────────────────────
function PropRow({ label, value, mono, small }: { label: string; value: string; mono?: boolean; small?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="text-[var(--text-muted)] flex-shrink-0">{label}</span>
      <span
        className={[
          "text-right text-[var(--text)]",
          mono ? "font-mono" : "",
          small ? "text-[10px]" : "",
        ].join(" ").trim()}
      >
        {value}
      </span>
    </div>
  );
}

function NumField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="text-[9px] uppercase tracking-wider text-[var(--text-muted)] block mb-0.5">{label}</span>
      <input
        type="number"
        step="0.1"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded bg-[var(--panel-muted)] px-1.5 py-0.5 text-[11px] font-mono text-[var(--text)]"
      />
    </label>
  );
}
