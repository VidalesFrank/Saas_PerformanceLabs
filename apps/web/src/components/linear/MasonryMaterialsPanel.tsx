"use client";

/**
 * MasonryMaterialsPanel — CRUD de materiales de mampostería para infills.
 *
 * Tipos VP (perforación vertical, Guerrero 2022) y HP (perforación horizontal,
 * Borah 2021) calculan Em automáticamente desde fm. Tipo "custom" (para
 * parámetros NSR-10 Título D o resultados de laboratorio) requiere que el
 * usuario ingrese Em explícitamente.
 */
import { useState } from "react";
import type { MasonryMaterial, MasonryBrickType } from "@/lib/structural-types";
import { structuralEditorApi } from "@/lib/structural-api";

interface Props {
  projectId: string;
  materials: Record<string, MasonryMaterial>;
  onChange?: () => void | Promise<void>;
}

interface DraftForm {
  id: string;
  name: string;
  fm_mpa: number;
  brick_type: MasonryBrickType;
  Em_mpa: number | null;
}

const BLANK_DRAFT: DraftForm = {
  id: "",
  name: "",
  fm_mpa: 5.0,
  brick_type: "VP",
  Em_mpa: null,
};

const NSR10_PRESETS: { label: string; fm_mpa: number; Em_mpa: number }[] = [
  { label: "NSR-10 D — arcilla f'm=8 MPa", fm_mpa: 8.0, Em_mpa: 6400 },
  { label: "NSR-10 D — arcilla f'm=10 MPa", fm_mpa: 10.0, Em_mpa: 8000 },
  { label: "NSR-10 D — concreto f'm=12 MPa", fm_mpa: 12.0, Em_mpa: 10800 },
];

export default function MasonryMaterialsPanel({ projectId, materials, onChange }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<DraftForm>(BLANK_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startCreate = () => {
    setCreating(true);
    setEditingId(null);
    setDraft({
      ...BLANK_DRAFT,
      id: `mamp_${Object.keys(materials).length + 1}`,
      name: `Mampostería ${Object.keys(materials).length + 1}`,
    });
    setError(null);
  };

  const startEdit = (id: string) => {
    const m = materials[id];
    if (!m) return;
    setCreating(false);
    setEditingId(id);
    setDraft({ id: m.id, name: m.name, fm_mpa: m.fm_mpa, brick_type: m.brick_type, Em_mpa: m.Em_mpa });
    setError(null);
  };

  const applyPreset = (p: { fm_mpa: number; Em_mpa: number }) => {
    setDraft((d) => ({ ...d, brick_type: "custom", fm_mpa: p.fm_mpa, Em_mpa: p.Em_mpa }));
  };

  const save = async () => {
    setBusy(true); setError(null);
    try {
      if (draft.brick_type === "custom" && (!draft.Em_mpa || draft.Em_mpa <= 0)) {
        throw new Error("El tipo custom requiere Em_mpa > 0");
      }
      const payload = {
        name: draft.name,
        fm_mpa: draft.fm_mpa,
        brick_type: draft.brick_type,
        Em_mpa: draft.brick_type === "custom" ? draft.Em_mpa : null,
      };
      if (creating) {
        if (!draft.id) throw new Error("Falta el id");
        if (materials[draft.id]) throw new Error("Ya existe un material con ese id");
        await structuralEditorApi.createMasonryMaterial(projectId, { id: draft.id, ...payload });
      } else if (editingId) {
        await structuralEditorApi.updateMasonryMaterial(projectId, editingId, payload);
      }
      setCreating(false);
      setEditingId(null);
      await onChange?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm(`¿Eliminar material '${id}'?`)) return;
    setBusy(true); setError(null);
    try {
      await structuralEditorApi.deleteMasonryMaterial(projectId, id);
      await onChange?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const editing = creating || editingId !== null;
  const EmEffective = draft.brick_type === "VP" ? 775 * draft.fm_mpa
    : draft.brick_type === "HP" ? 622 * draft.fm_mpa
    : (draft.Em_mpa ?? 0);

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text)]">Materiales de mampostería</h3>
          <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
            Se usan para los infills. VP/HP calculan Em automáticamente; custom es para parámetros NSR-10 o de laboratorio.
          </p>
        </div>
        {!editing && (
          <button onClick={startCreate} className="text-xs px-3 py-1.5 rounded bg-blue-600 text-white font-medium hover:bg-blue-700">
            + Nuevo material
          </button>
        )}
      </div>

      {error && (
        <div className="text-[11px] px-3 py-2 rounded bg-red-50 border border-red-200 text-red-700 font-mono">
          {error}
        </div>
      )}

      {editing && (
        <div className="border border-[var(--border)] rounded-lg bg-[var(--surface-2)] p-3 space-y-2 text-[11px]">
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[var(--text-muted)]">ID (único)</span>
              <input
                value={draft.id}
                disabled={!creating}
                onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 font-mono disabled:opacity-50"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[var(--text-muted)]">Nombre</span>
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[var(--text-muted)]">Tipo</span>
              <select
                value={draft.brick_type}
                onChange={(e) => setDraft({ ...draft, brick_type: e.target.value as MasonryBrickType })}
                className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1"
              >
                <option value="VP">VP · Perforación vertical (Guerrero 2022)</option>
                <option value="HP">HP · Perforación horizontal (Borah 2021)</option>
                <option value="custom">Custom · Em explícito (NSR-10 D / lab)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[var(--text-muted)]">fm (MPa)</span>
              <input
                type="number" step="0.1" min={0.5}
                value={draft.fm_mpa}
                onChange={(e) => setDraft({ ...draft, fm_mpa: Math.max(0.5, Number(e.target.value) || 5) })}
                className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 font-mono"
              />
            </label>
            {draft.brick_type === "custom" && (
              <label className="flex flex-col gap-1">
                <span className="text-[var(--text-muted)]">Em (MPa)</span>
                <input
                  type="number" step="100" min={100}
                  value={draft.Em_mpa ?? ""}
                  onChange={(e) => setDraft({ ...draft, Em_mpa: e.target.value === "" ? null : Number(e.target.value) })}
                  className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 font-mono"
                  placeholder="Requerido"
                />
              </label>
            )}
            {draft.brick_type !== "custom" && (
              <div className="flex flex-col gap-1">
                <span className="text-[var(--text-muted)]">Em calculado</span>
                <span className="font-mono text-[var(--text)]">{EmEffective.toFixed(0)} MPa</span>
              </div>
            )}
          </div>

          {draft.brick_type === "custom" && (
            <div className="flex flex-wrap gap-1 pt-1 border-t border-[var(--border)]">
              <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider mr-2 self-center">Presets NSR-10:</span>
              {NSR10_PRESETS.map((p) => (
                <button key={p.label} onClick={() => applyPreset(p)}
                  className="text-[10px] px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]">
                  {p.label}
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <button onClick={save} disabled={busy}
              className="text-xs px-3 py-1.5 rounded bg-blue-600 text-white font-medium disabled:opacity-40 hover:bg-blue-700">
              {busy ? "Guardando..." : creating ? "Crear material" : "Guardar cambios"}
            </button>
            <button onClick={() => { setCreating(false); setEditingId(null); }}
              className="text-xs px-3 py-1.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]">
              Cancelar
            </button>
          </div>
        </div>
      )}

      {!editing && Object.keys(materials).length === 0 && (
        <p className="text-[11px] text-[var(--text-muted)] text-center py-4">
          Sin materiales de mampostería. Crea uno para poder añadir infills.
        </p>
      )}

      {!editing && Object.keys(materials).length > 0 && (
        <table className="w-full text-[11px]">
          <thead className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider text-left">
            <tr>
              <th className="pb-1">ID</th>
              <th className="pb-1">Nombre</th>
              <th className="pb-1">Tipo</th>
              <th className="pb-1 text-right">fm (MPa)</th>
              <th className="pb-1 text-right">Em (MPa)</th>
              <th></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {Object.entries(materials).map(([id, m]) => (
              <tr key={id}>
                <td className="py-1.5 font-mono">{id}</td>
                <td>{m.name}</td>
                <td className="text-[var(--text-muted)]">{m.brick_type}</td>
                <td className="text-right font-mono">{m.fm_mpa.toFixed(1)}</td>
                <td className="text-right font-mono">{m.Em_mpa.toFixed(0)}</td>
                <td className="text-right">
                  <button onClick={() => startEdit(id)} className="text-[10px] text-blue-600 hover:underline mr-2">Editar</button>
                  <button onClick={() => remove(id)} disabled={busy} className="text-[10px] text-red-600 hover:underline">Eliminar</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
