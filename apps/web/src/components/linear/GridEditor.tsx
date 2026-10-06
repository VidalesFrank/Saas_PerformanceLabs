"use client";

/**
 * GridEditor — Panel para definir manualmente los ejes X, Y y los pisos.
 *
 * El grid del usuario alimenta el snap del editor de dibujo (Building2DPlanView
 * y BuildingElevationView) y sincroniza las elevaciones de "stories" del
 * modelo canónico. No reemplaza los joints ya existentes; solo se usa como
 * referencia y ancla de snap.
 */
import { useEffect, useState } from "react";
import type { GridDefinition, GridAxis, StoryDef } from "@/lib/structural-types";
import { structuralEditorApi } from "@/lib/structural-api";

interface Props {
  projectId: string;
  initial?: GridDefinition;
  onSaved?: () => void | Promise<void>;
}

const EMPTY: GridDefinition = { axes_x: [], axes_y: [], stories: [] };

export default function GridEditor({ projectId, initial, onSaved }: Props) {
  const [grid, setGrid] = useState<GridDefinition>(initial ?? EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => { if (initial) setGrid(initial); }, [initial]);

  const update = (patch: Partial<GridDefinition>) => {
    setGrid((g) => ({ ...g, ...patch }));
    setDirty(true);
  };

  const addAxisX = () => {
    const next = [...grid.axes_x];
    const nextName = suggestAxisName(next.map((a) => a.name), true);
    const nextCoord = next.length ? +(next[next.length - 1].coord_m + 5).toFixed(2) : 0;
    update({ axes_x: [...next, { name: nextName, coord_m: nextCoord }] });
  };
  const addAxisY = () => {
    const next = [...grid.axes_y];
    const nextName = suggestAxisName(next.map((a) => a.name), false);
    const nextCoord = next.length ? +(next[next.length - 1].coord_m + 5).toFixed(2) : 0;
    update({ axes_y: [...next, { name: nextName, coord_m: nextCoord }] });
  };
  const addStory = () => {
    const s = [...grid.stories];
    const idx = s.length + 1;
    update({ stories: [...s, { name: idx === 1 ? "Nivel 1" : `Nivel ${idx}`, height_m: 3.0 }] });
  };

  const save = async () => {
    setSaving(true); setError(null);
    try {
      await structuralEditorApi.upsertGrid(projectId, grid);
      setDirty(false);
      await onSaved?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text)]">Grid del edificio</h3>
          <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
            Los ejes actúan como snap para dibujar. Los pisos definen alturas para las nuevas columnas y muros.
          </p>
        </div>
        <button
          onClick={save}
          disabled={saving || !dirty}
          className="text-xs px-3 py-1.5 rounded bg-blue-600 text-white font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-blue-700 transition-colors"
        >
          {saving ? "Guardando..." : dirty ? "Guardar grid" : "Sin cambios"}
        </button>
      </div>

      {error && (
        <div className="text-[11px] px-3 py-2 rounded bg-red-50 border border-red-200 text-red-700 font-mono">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <AxisList
          title="Ejes X (líneas verticales)"
          axes={grid.axes_x}
          onChange={(axes) => update({ axes_x: axes })}
          onAdd={addAxisX}
          example="A, B, C…"
        />
        <AxisList
          title="Ejes Y (líneas horizontales)"
          axes={grid.axes_y}
          onChange={(axes) => update({ axes_y: axes })}
          onAdd={addAxisY}
          example="1, 2, 3…"
        />
      </div>

      <StoryList
        stories={grid.stories}
        onChange={(s) => update({ stories: s })}
        onAdd={addStory}
      />
    </div>
  );
}

function AxisList({ title, axes, onChange, onAdd, example }: {
  title: string;
  axes: GridAxis[];
  onChange: (axes: GridAxis[]) => void;
  onAdd: () => void;
  example: string;
}) {
  return (
    <div className="border border-[var(--border)] rounded-lg bg-[var(--surface-2)] p-3">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-semibold text-[var(--text)]">{title}</h4>
        <button onClick={onAdd} className="text-[11px] px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]">
          + Eje
        </button>
      </div>
      {axes.length === 0 ? (
        <p className="text-[11px] text-[var(--text-muted)]">Sin ejes. Ejemplo: {example}</p>
      ) : (
        <ul className="space-y-1">
          {axes.map((ax, i) => (
            <li key={i} className="flex items-center gap-2 text-[11px]">
              <input
                value={ax.name}
                onChange={(e) => {
                  const next = [...axes]; next[i] = { ...ax, name: e.target.value }; onChange(next);
                }}
                className="w-16 bg-[var(--surface)] border border-[var(--border)] rounded px-1.5 py-0.5"
              />
              <input
                type="number" step="0.1"
                value={ax.coord_m}
                onChange={(e) => {
                  const next = [...axes]; next[i] = { ...ax, coord_m: Number(e.target.value) || 0 }; onChange(next);
                }}
                className="w-24 bg-[var(--surface)] border border-[var(--border)] rounded px-1.5 py-0.5 font-mono"
              />
              <span className="text-[10px] text-[var(--text-muted)]">m</span>
              <button
                onClick={() => onChange(axes.filter((_, j) => j !== i))}
                className="ml-auto text-[10px] text-red-600 hover:underline"
              >Eliminar</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StoryList({ stories, onChange, onAdd }: {
  stories: StoryDef[];
  onChange: (s: StoryDef[]) => void;
  onAdd: () => void;
}) {
  const totalH = stories.reduce((a, s) => a + s.height_m, 0);
  return (
    <div className="border border-[var(--border)] rounded-lg bg-[var(--surface-2)] p-3">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-semibold text-[var(--text)]">
          Pisos <span className="text-[var(--text-muted)] font-normal">({stories.length}, altura total {totalH.toFixed(2)}m)</span>
        </h4>
        <button onClick={onAdd} className="text-[11px] px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]">
          + Piso
        </button>
      </div>
      {stories.length === 0 ? (
        <p className="text-[11px] text-[var(--text-muted)]">Sin pisos definidos. Añade al menos uno para dibujar en 3D.</p>
      ) : (
        <ul className="space-y-1">
          {stories.map((s, i) => (
            <li key={i} className="flex items-center gap-2 text-[11px]">
              <span className="text-[10px] text-[var(--text-muted)] w-8">#{i + 1}</span>
              <input
                value={s.name}
                onChange={(e) => {
                  const next = [...stories]; next[i] = { ...s, name: e.target.value }; onChange(next);
                }}
                className="w-32 bg-[var(--surface)] border border-[var(--border)] rounded px-1.5 py-0.5"
              />
              <input
                type="number" step="0.1" min={0.1}
                value={s.height_m}
                onChange={(e) => {
                  const next = [...stories]; next[i] = { ...s, height_m: Math.max(0.1, Number(e.target.value) || 3.0) }; onChange(next);
                }}
                className="w-20 bg-[var(--surface)] border border-[var(--border)] rounded px-1.5 py-0.5 font-mono"
              />
              <span className="text-[10px] text-[var(--text-muted)]">m alto</span>
              <button
                onClick={() => onChange(stories.filter((_, j) => j !== i))}
                className="ml-auto text-[10px] text-red-600 hover:underline"
              >Eliminar</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function suggestAxisName(existing: string[], letters: boolean): string {
  if (letters) {
    for (let c = "A".charCodeAt(0); c <= "Z".charCodeAt(0); c++) {
      const s = String.fromCharCode(c);
      if (!existing.includes(s)) return s;
    }
    return `AA-${existing.length + 1}`;
  }
  for (let n = 1; n <= 99; n++) if (!existing.includes(String(n))) return String(n);
  return String(existing.length + 1);
}
