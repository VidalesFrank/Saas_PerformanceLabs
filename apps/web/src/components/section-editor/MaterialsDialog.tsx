"use client";

import { useState } from "react";
import { uid } from "@/lib/section-document";
import type { ConcreteDef, SteelDef } from "@/lib/section-document";
import type { EditorAction } from "@/lib/editor-state";

interface Props {
  concreteDefs: ConcreteDef[];
  steelDefs: SteelDef[];
  dispatch: (action: EditorAction) => void;
  onClose: () => void;
}

type Tab = "concreto" | "acero";

const EMPTY_CONCRETE: Omit<ConcreteDef, "id"> = { label: "", fpc: 28, eco: 0.002 };
const EMPTY_STEEL: Omit<SteelDef, "id"> = { label: "", fy: 420, Es: 200000, b: 0.01 };

function NumInput({
  label, value, onChange, step = 1, min,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <label className="text-[10px] text-text-muted">{label}</label>
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="rounded border border-border bg-surface px-2 py-1 text-xs text-text
          focus:border-accent focus:outline-none"
      />
    </div>
  );
}

// ── Panel concreto ────────────────────────────────────────────────────────────

function ConcretePanel({ defs, dispatch }: { defs: ConcreteDef[]; dispatch: (a: EditorAction) => void }) {
  const [form, setForm] = useState<Omit<ConcreteDef, "id"> & { editId: string | null }>({
    ...EMPTY_CONCRETE, editId: null,
  });

  function startEdit(def: ConcreteDef) {
    setForm({ label: def.label, fpc: def.fpc, eco: def.eco, editId: def.id });
  }

  function cancel() {
    setForm({ ...EMPTY_CONCRETE, editId: null });
  }

  function save() {
    if (!form.label.trim()) return;
    if (form.editId) {
      dispatch({ type: "UPDATE_CONCRETE_DEF", id: form.editId, updates: { label: form.label, fpc: form.fpc, eco: form.eco } });
    } else {
      dispatch({ type: "ADD_CONCRETE_DEF", def: { id: uid(), label: form.label, fpc: form.fpc, eco: form.eco } });
    }
    cancel();
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Lista */}
      {defs.length === 0 ? (
        <p className="text-xs text-text-muted">Sin definiciones de concreto.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {defs.map((d) => (
            <div
              key={d.id}
              className={`flex items-center justify-between rounded-lg border px-3 py-2 text-xs
                ${form.editId === d.id ? "border-accent bg-accent/8" : "border-border bg-surface-2"}`}
            >
              <div>
                <span className="font-medium text-text">{d.label}</span>
                <span className="ml-2 text-text-muted">f'c={d.fpc} MPa, εco={d.eco}</span>
              </div>
              <div className="flex gap-1">
                <button
                  onClick={() => startEdit(d)}
                  className="rounded px-1.5 py-0.5 text-[10px] text-accent hover:bg-accent/15"
                >
                  Editar
                </button>
                <button
                  onClick={() => dispatch({ type: "DELETE_CONCRETE_DEF", id: d.id })}
                  className="rounded px-1.5 py-0.5 text-[10px] text-danger/60 hover:text-danger"
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Formulario */}
      <div className="rounded-xl border border-border bg-surface p-3">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
          {form.editId ? "Editar concreto" : "Nuevo concreto"}
        </p>
        <div className="mb-2">
          <label className="text-[10px] text-text-muted">Etiqueta</label>
          <input
            value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
            placeholder="p.ej. f'c = 28 MPa"
            className="mt-0.5 w-full rounded border border-border bg-surface px-2 py-1 text-xs text-text
              focus:border-accent focus:outline-none"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <NumInput label="f'c (MPa)" value={form.fpc} onChange={(v) => setForm({ ...form, fpc: v })} step={1} min={10} />
          <NumInput label="εco" value={form.eco} onChange={(v) => setForm({ ...form, eco: v })} step={0.0001} min={0.001} />
        </div>
        <div className="mt-3 flex gap-2">
          <button
            onClick={save}
            disabled={!form.label.trim()}
            className="rounded-lg bg-accent px-3 py-1 text-xs font-medium text-[#04141a]
              disabled:opacity-40 hover:opacity-90"
          >
            {form.editId ? "Guardar" : "Agregar"}
          </button>
          {form.editId && (
            <button onClick={cancel} className="rounded-lg border border-border px-3 py-1 text-xs text-text-muted hover:text-text">
              Cancelar
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Panel acero ───────────────────────────────────────────────────────────────

function SteelPanel({ defs, dispatch }: { defs: SteelDef[]; dispatch: (a: EditorAction) => void }) {
  const [form, setForm] = useState<Omit<SteelDef, "id"> & { editId: string | null }>({
    ...EMPTY_STEEL, editId: null,
  });

  function startEdit(def: SteelDef) {
    setForm({ label: def.label, fy: def.fy, Es: def.Es, b: def.b, editId: def.id });
  }

  function cancel() {
    setForm({ ...EMPTY_STEEL, editId: null });
  }

  function save() {
    if (!form.label.trim()) return;
    if (form.editId) {
      dispatch({ type: "UPDATE_STEEL_DEF", id: form.editId, updates: { label: form.label, fy: form.fy, Es: form.Es, b: form.b } });
    } else {
      dispatch({ type: "ADD_STEEL_DEF", def: { id: uid(), label: form.label, fy: form.fy, Es: form.Es, b: form.b } });
    }
    cancel();
  }

  return (
    <div className="flex flex-col gap-3">
      {defs.length === 0 ? (
        <p className="text-xs text-text-muted">Sin definiciones de acero.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {defs.map((d) => (
            <div
              key={d.id}
              className={`flex items-center justify-between rounded-lg border px-3 py-2 text-xs
                ${form.editId === d.id ? "border-accent bg-accent/8" : "border-border bg-surface-2"}`}
            >
              <div>
                <span className="font-medium text-text">{d.label}</span>
                <span className="ml-2 text-text-muted">fy={d.fy} MPa, Es={d.Es/1000}GPa, b={d.b}</span>
              </div>
              <div className="flex gap-1">
                <button
                  onClick={() => startEdit(d)}
                  className="rounded px-1.5 py-0.5 text-[10px] text-accent hover:bg-accent/15"
                >
                  Editar
                </button>
                <button
                  onClick={() => dispatch({ type: "DELETE_STEEL_DEF", id: d.id })}
                  className="rounded px-1.5 py-0.5 text-[10px] text-danger/60 hover:text-danger"
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="rounded-xl border border-border bg-surface p-3">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
          {form.editId ? "Editar acero" : "Nuevo acero"}
        </p>
        <div className="mb-2">
          <label className="text-[10px] text-text-muted">Etiqueta</label>
          <input
            value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
            placeholder="p.ej. fy = 420 MPa"
            className="mt-0.5 w-full rounded border border-border bg-surface px-2 py-1 text-xs text-text
              focus:border-accent focus:outline-none"
          />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <NumInput label="fy (MPa)" value={form.fy} onChange={(v) => setForm({ ...form, fy: v })} step={10} min={200} />
          <NumInput label="Es (MPa)" value={form.Es} onChange={(v) => setForm({ ...form, Es: v })} step={1000} min={100000} />
          <NumInput label="b (ratio)" value={form.b} onChange={(v) => setForm({ ...form, b: v })} step={0.001} min={0} />
        </div>
        <div className="mt-3 flex gap-2">
          <button
            onClick={save}
            disabled={!form.label.trim()}
            className="rounded-lg bg-accent px-3 py-1 text-xs font-medium text-[#04141a]
              disabled:opacity-40 hover:opacity-90"
          >
            {form.editId ? "Guardar" : "Agregar"}
          </button>
          {form.editId && (
            <button onClick={cancel} className="rounded-lg border border-border px-3 py-1 text-xs text-text-muted hover:text-text">
              Cancelar
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Dialog principal ──────────────────────────────────────────────────────────

export function MaterialsDialog({ concreteDefs, steelDefs, dispatch, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("concreto");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex w-full max-w-lg flex-col rounded-2xl border border-border bg-surface shadow-2xl"
        style={{ maxHeight: "85vh" }}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="font-semibold text-text">Materiales</h2>
            <p className="text-xs text-text-muted">Define los materiales usados en esta sección</p>
          </div>
          <button onClick={onClose} className="text-xl text-text-muted hover:text-text">×</button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-border px-5 py-2">
          {(["concreto", "acero"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors
                ${tab === t ? "bg-accent text-[#04141a]" : "text-text-muted hover:bg-surface-2 hover:text-text"}`}
            >
              {t === "concreto" ? `Concreto (${concreteDefs.length})` : `Acero (${steelDefs.length})`}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {tab === "concreto" ? (
            <ConcretePanel defs={concreteDefs} dispatch={dispatch} />
          ) : (
            <SteelPanel defs={steelDefs} dispatch={dispatch} />
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end border-t border-border px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-[#04141a] hover:opacity-90"
          >
            Listo
          </button>
        </div>
      </div>
    </div>
  );
}
