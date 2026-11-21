"use client";

/**
 * LoadsPanel — definición y asignación de cargas (NSR-10 B.2).
 *
 * Flujo ETABS-like:
 *   1. Define patrones (DL, LL, SDL, EQX, EQY, WX, WY, ...).
 *   2. Asigna cargas lineales (kN/m) sobre vigas por patrón.
 *   3. Asigna presión (kN/m²) sobre losas por patrón.
 *
 * Todas las cargas son uniformes y en dirección gravitacional Z. Combinaciones
 * NSR-10 B.2.4 viven aparte (CombinationSelector) y consumen estos patrones.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { structuralEditorApi } from "@/lib/structural-api";
import { ApiError } from "@/lib/api";
import type { FullModelData } from "@/lib/structural-types";

interface Props {
  projectId: string;
  fullModel: FullModelData;
  onChanged: () => void | Promise<void>;
}

// Presets rápidos — el usuario los puede combinar con el textarea libre
const PATTERN_PRESETS = ["DL", "SDL", "LL", "LR", "EQX", "EQY", "WX", "WY", "SX", "SY"];

export default function LoadsPanel({ projectId, fullModel, onChanged }: Props) {
  const patterns = useMemo(
    () => fullModel.metadata.load_patterns ?? [],
    [fullModel.metadata.load_patterns],
  );

  const beams = useMemo(
    () => Object.entries(fullModel.frames).filter(([, f]) => f.element_type === "beam"),
    [fullModel.frames],
  );
  const slabs = useMemo(
    () => Object.entries(fullModel.shells).filter(([, s]) => s.element_type === "slab"),
    [fullModel.shells],
  );

  // Agrupar por piso para listar ordenado
  const beamsByStory = useMemo(() => groupBy(beams, ([, f]) => f.story || ""), [beams]);
  const slabsByStory = useMemo(() => groupBy(slabs, ([, s]) => s.story || ""), [slabs]);

  const line_loads  = fullModel.line_loads  ?? {};
  const shell_loads = fullModel.shell_loads ?? {};

  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Patrones: add/remove ───────────────────────────────────────────────
  const [newPattern, setNewPattern] = useState("");

  const commitPatterns = useCallback(
    async (next: string[]) => {
      setBusy(true); setError(null);
      try {
        const r = await structuralEditorApi.upsertLoadPatterns(projectId, next);
        if (r.line_loads_cleaned + r.shell_loads_cleaned > 0) {
          setError(`Se limpiaron ${r.line_loads_cleaned} line_loads y ${r.shell_loads_cleaned} shell_loads en cascada.`);
          setTimeout(() => setError(null), 3000);
        }
        await onChanged();
      } catch (e) {
        setError(e instanceof ApiError ? e.message : (e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [projectId, onChanged],
  );

  async function addPattern(name: string) {
    const clean = name.trim().toUpperCase();
    if (!clean || patterns.includes(clean)) return;
    await commitPatterns([...patterns, clean]);
    setNewPattern("");
  }

  async function removePattern(name: string) {
    if (!window.confirm(`¿Eliminar patrón "${name}"? Se borrarán todas sus asignaciones de carga.`)) return;
    await commitPatterns(patterns.filter((p) => p !== name));
  }

  // ── Cargas sobre elementos ─────────────────────────────────────────────
  async function setLineLoad(frameId: string, pattern: string, value: number) {
    setBusy(true); setError(null);
    try {
      await structuralEditorApi.upsertLineLoad(projectId, frameId, { [pattern]: value });
      await onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function setShellLoad(shellId: string, pattern: string, value: number) {
    setBusy(true); setError(null);
    try {
      await structuralEditorApi.upsertShellLoad(projectId, shellId, { [pattern]: value });
      await onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold text-[var(--text)]">Cargas</h2>
        <p className="text-sm text-[var(--text-muted)]">
          Define los patrones (DL, LL, sismo, viento) y asigna magnitudes
          uniformes sobre vigas (kN/m) y losas (kN/m²). Las combinaciones
          NSR-10 B.2.4 se arman después con estos patrones.
        </p>
      </header>

      {error && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
          {error}
        </div>
      )}

      {/* ── 1. Patrones ──────────────────────────────────────────────── */}
      <section className="pl-glass-soft rounded-xl p-4 space-y-3">
        <h3 className="text-sm font-semibold text-[var(--text)]">Patrones de carga</h3>
        <div className="flex flex-wrap gap-1.5">
          {patterns.map((p) => (
            <span key={p}
              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-xs font-mono"
            >
              {p}
              <button
                onClick={() => removePattern(p)}
                disabled={busy}
                className="text-[var(--text-muted)] hover:text-rose-500 disabled:opacity-40"
                title="Eliminar patrón (cascade)"
              >
                ×
              </button>
            </span>
          ))}
          {patterns.length === 0 && (
            <span className="text-xs italic text-[var(--text-muted)]">Sin patrones aún. Añade DL, LL o lo que necesites.</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <input
            value={newPattern}
            onChange={(e) => setNewPattern(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === "Enter") addPattern(newPattern); }}
            placeholder="Nombre (DL, LL, EQX, ...)"
            className="flex-1 rounded-md bg-[var(--panel-muted)] px-3 py-1.5 text-xs font-mono text-[var(--text)]"
          />
          <button
            onClick={() => addPattern(newPattern)}
            disabled={busy || !newPattern.trim()}
            className="px-3 py-1.5 rounded-md bg-indigo-600 text-white text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-indigo-700"
          >
            + Añadir
          </button>
        </div>

        <div className="flex flex-wrap gap-1">
          <span className="text-[10px] text-[var(--text-muted)] mr-1">Presets:</span>
          {PATTERN_PRESETS.filter((p) => !patterns.includes(p)).map((p) => (
            <button key={p}
              onClick={() => addPattern(p)}
              disabled={busy}
              className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] hover:border-indigo-400/40 disabled:opacity-40"
            >
              + {p}
            </button>
          ))}
        </div>
      </section>

      {/* ── 2. Cargas lineales sobre vigas ──────────────────────────── */}
      <section className="pl-glass-soft rounded-xl p-4 space-y-3">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-[var(--text)]">
            Cargas sobre vigas <span className="font-normal text-[var(--text-muted)]">(kN/m, gravedad)</span>
          </h3>
          <span className="text-[10px] text-[var(--text-muted)]">{beams.length} vigas en el modelo</span>
        </div>

        {patterns.length === 0 ? (
          <p className="text-xs italic text-[var(--text-muted)]">Define al menos un patrón arriba para asignar cargas.</p>
        ) : beams.length === 0 ? (
          <p className="text-xs italic text-[var(--text-muted)]">No hay vigas todavía.</p>
        ) : (
          <div className="overflow-x-auto">
            <ElementLoadsTable
              rowGroups={beamsByStory}
              patterns={patterns}
              loadsByElement={line_loads}
              onCommit={setLineLoad}
              busy={busy}
              elementLabel="Viga"
              unit="kN/m"
            />
          </div>
        )}
      </section>

      {/* ── 3. Cargas superficiales sobre losas ─────────────────────── */}
      <section className="pl-glass-soft rounded-xl p-4 space-y-3">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-[var(--text)]">
            Presión sobre losas <span className="font-normal text-[var(--text-muted)]">(kN/m², gravedad)</span>
          </h3>
          <span className="text-[10px] text-[var(--text-muted)]">{slabs.length} losas en el modelo</span>
        </div>

        {patterns.length === 0 ? (
          <p className="text-xs italic text-[var(--text-muted)]">Define al menos un patrón arriba para asignar cargas.</p>
        ) : slabs.length === 0 ? (
          <p className="text-xs italic text-[var(--text-muted)]">No hay losas todavía.</p>
        ) : (
          <div className="overflow-x-auto">
            <ElementLoadsTable
              rowGroups={slabsByStory}
              patterns={patterns}
              loadsByElement={shell_loads}
              onCommit={setShellLoad}
              busy={busy}
              elementLabel="Losa"
              unit="kN/m²"
            />
          </div>
        )}
      </section>
    </div>
  );
}

// ── Tabla reutilizable para line_loads y shell_loads ───────────────────────────

interface TableProps {
  rowGroups: Map<string, [string, unknown][]>;   // storyName -> [[id, data], ...]
  patterns:  string[];
  loadsByElement: Record<string, Record<string, number>>;
  onCommit:  (id: string, pattern: string, value: number) => Promise<void>;
  busy:      boolean;
  elementLabel: string;
  unit:      string;
}

function ElementLoadsTable({
  rowGroups, patterns, loadsByElement, onCommit, busy, elementLabel, unit,
}: TableProps) {
  // Renderizamos todas las filas con inputs controlados por fila.
  return (
    <table className="w-full text-xs border-separate border-spacing-0">
      <thead className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] bg-[var(--panel-muted)]/50">
        <tr>
          <th className="text-left px-2 py-1.5 sticky left-0 bg-[var(--panel-muted)]/50">{elementLabel}</th>
          <th className="text-left px-2 py-1.5">Piso</th>
          {patterns.map((p) => (
            <th key={p} className="text-right px-2 py-1.5 font-mono">{p}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {[...rowGroups.entries()].map(([story, rows]) => rows.map(([id]) => (
          <tr key={id} className="border-t border-[var(--border)]/30">
            <td className="px-2 py-1 font-mono text-[var(--text)] sticky left-0 bg-[var(--surface)]">{id}</td>
            <td className="px-2 py-1 text-[var(--text-muted)]">{story || "—"}</td>
            {patterns.map((p) => (
              <td key={p} className="px-2 py-1 text-right">
                <LoadCell
                  value={loadsByElement[id]?.[p] ?? 0}
                  onCommit={(v) => onCommit(id, p, v)}
                  disabled={busy}
                  title={`${unit}`}
                />
              </td>
            ))}
          </tr>
        )))}
      </tbody>
    </table>
  );
}

function LoadCell({
  value, onCommit, disabled, title,
}: { value: number; onCommit: (v: number) => void; disabled: boolean; title: string }) {
  // Input controlado local con commit on blur/Enter para no saturar la API
  // con cada tecla.
  const [draft, setDraft] = useState<string>(value === 0 ? "" : String(value));

  // Sync si el valor backend cambia por fuera
  useEffect(() => { setDraft(value === 0 ? "" : String(value)); }, [value]);

  const flush = () => {
    const parsed = parseFloat(draft);
    const next = isFinite(parsed) ? parsed : 0;
    if (Math.abs(next - value) < 1e-6) return;
    onCommit(next);
  };

  return (
    <input
      type="number"
      step="0.1"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={flush}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      disabled={disabled}
      title={title}
      className="w-20 text-right rounded bg-[var(--panel-muted)] px-1.5 py-0.5 font-mono text-[var(--text)] disabled:opacity-40"
      placeholder="—"
    />
  );
}

function groupBy<T, K>(items: T[], keyFn: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = keyFn(it);
    const arr = m.get(k);
    if (arr) arr.push(it); else m.set(k, [it]);
  }
  return m;
}
