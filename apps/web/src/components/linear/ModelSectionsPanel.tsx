"use client";

import { useState } from "react";
import type { FullModelData, SectionData } from "@/lib/structural-types";
import { structuralEditorApi } from "@/lib/structural-api";

// ── Preview sección transversal SVG ──────────────────────────────────────────

function SectionPreviewSVG({ h_cm, b_cm }: { h_cm: number; b_cm: number }) {
  const SVG_W = 180, SVG_H = 140;
  const PAD = 28;
  const maxDim = Math.max(h_cm, b_cm);
  const scale = (Math.min(SVG_W, SVG_H) - 2 * PAD) / maxDim;
  const rw = b_cm * scale;
  const rh = h_cm * scale;
  const ox = (SVG_W - rw) / 2;
  const oy = (SVG_H - rh) / 2;

  return (
    <svg width={SVG_W} height={SVG_H} viewBox={`0 0 ${SVG_W} ${SVG_H}`} className="text-[var(--text-muted)]">
      {/* Dimensión horizontal (b) */}
      <line x1={ox} y1={oy - 10} x2={ox + rw} y2={oy - 10} stroke="currentColor" strokeWidth="0.8" opacity="0.35" />
      <line x1={ox} y1={oy - 13} x2={ox} y2={oy - 7} stroke="currentColor" strokeWidth="0.8" opacity="0.35" />
      <line x1={ox + rw} y1={oy - 13} x2={ox + rw} y2={oy - 7} stroke="currentColor" strokeWidth="0.8" opacity="0.35" />
      <text x={ox + rw / 2} y={oy - 14} textAnchor="middle" fontSize="8" fill="currentColor" opacity="0.55">
        b = {b_cm.toFixed(0)} cm
      </text>
      {/* Dimensión vertical (h) */}
      <line x1={ox + rw + 10} y1={oy} x2={ox + rw + 10} y2={oy + rh} stroke="currentColor" strokeWidth="0.8" opacity="0.35" />
      <line x1={ox + rw + 7} y1={oy} x2={ox + rw + 13} y2={oy} stroke="currentColor" strokeWidth="0.8" opacity="0.35" />
      <line x1={ox + rw + 7} y1={oy + rh} x2={ox + rw + 13} y2={oy + rh} stroke="currentColor" strokeWidth="0.8" opacity="0.35" />
      <text x={ox + rw + 14} y={oy + rh / 2 + 3} textAnchor="start" fontSize="8" fill="currentColor" opacity="0.55">
        h = {h_cm.toFixed(0)} cm
      </text>
      {/* Rectángulo de sección */}
      <rect
        x={ox} y={oy} width={rw} height={rh}
        fill="#6366F1" fillOpacity="0.12"
        stroke="#6366F1" strokeWidth="1.5"
      />
      {/* Barras de esquina (decorativas) */}
      {[
        [ox + 6, oy + 6], [ox + rw - 6, oy + 6],
        [ox + 6, oy + rh - 6], [ox + rw - 6, oy + rh - 6],
      ].map(([cx, cy], i) => (
        <circle key={i} cx={cx} cy={cy} r="3" fill="#EF4444" fillOpacity="0.7" />
      ))}
      {/* Recubrimiento */}
      <rect
        x={ox + 5} y={oy + 5} width={rw - 10} height={rh - 10}
        fill="none" stroke="#6366F1" strokeWidth="0.6" strokeDasharray="3 2" opacity="0.3"
      />
    </svg>
  );
}

function SectionMiniThumb({ h_cm, b_cm }: { h_cm: number; b_cm: number }) {
  const W = 32, H = 24, PAD = 3;
  const maxDim = Math.max(h_cm, b_cm, 1);
  const scale = (Math.min(W, H) - 2 * PAD) / maxDim;
  const rw = Math.max(b_cm * scale, 2);
  const rh = Math.max(h_cm * scale, 2);
  const ox = (W - rw) / 2;
  const oy = (H - rh) / 2;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="flex-shrink-0">
      <rect x={ox} y={oy} width={rw} height={rh}
        fill="#6366F1" fillOpacity="0.15" stroke="#6366F1" strokeWidth="1" />
    </svg>
  );
}

interface Props {
  projectId: string;
  modelData: FullModelData;
  onModelDataChange: () => void;
}

interface SectionForm {
  name: string;
  material: string;
  shape: string;
  h_cm: string;   // en cm para el usuario
  b_cm: string;
}

const DEFAULT_FORM: SectionForm = { name: "", material: "", shape: "Rectangular", h_cm: "", b_cm: "" };

function usesCount(sectionName: string, frames: FullModelData["frames"]): number {
  return Object.values(frames).filter(f => f.section === sectionName).length;
}

export default function ModelSectionsPanel({ projectId, modelData, onModelDataChange }: Props) {
  const [mode, setMode] = useState<"list" | "create" | "edit">("list");
  const [editingName, setEditingName] = useState<string | null>(null);
  const [form, setForm] = useState<SectionForm>(DEFAULT_FORM);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const { sections, materials, frames } = modelData;
  const matNames = Object.keys(materials);

  const filtered = Object.entries(sections).filter(([name]) =>
    name.toLowerCase().includes(filter.toLowerCase())
  );

  function startCreate() {
    setForm({ ...DEFAULT_FORM, material: matNames[0] ?? "" });
    setEditingName(null);
    setMode("create");
    setError(null);
    setSuccess(null);
  }

  function startEdit(name: string, sec: SectionData) {
    setForm({
      name,
      material: sec.material,
      shape: sec.shape,
      h_cm: (sec.h_m * 100).toFixed(0),
      b_cm: (sec.b_m * 100).toFixed(0),
    });
    setEditingName(name);
    setMode("edit");
    setError(null);
    setSuccess(null);
  }

  function cancel() {
    setMode("list");
    setForm(DEFAULT_FORM);
    setEditingName(null);
    setError(null);
    setSuccess(null);
  }

  async function handleSave() {
    if (!form.name.trim() || !form.material || !form.h_cm || !form.b_cm) {
      setError("Completa todos los campos requeridos.");
      return;
    }
    const h_m = parseFloat(form.h_cm) / 100;
    const b_m = parseFloat(form.b_cm) / 100;
    if (isNaN(h_m) || h_m <= 0 || isNaN(b_m) || b_m <= 0) {
      setError("Las dimensiones deben ser valores positivos.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      if (mode === "create") {
        await structuralEditorApi.createSection(projectId, form.name.trim(), {
          material: form.material,
          shape: form.shape,
          h_m,
          b_m,
        });
        setSuccess(`Sección '${form.name}' creada.`);
      } else if (mode === "edit" && editingName) {
        await structuralEditorApi.updateSection(projectId, editingName, {
          material: form.material,
          shape: form.shape,
          h_m,
          b_m,
        });
        setSuccess(`Sección '${editingName}' actualizada.`);
      }
      onModelDataChange();
      setMode("list");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al guardar");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(name: string) {
    const uses = usesCount(name, frames);
    const confirm = window.confirm(
      uses > 0
        ? `La sección '${name}' está asignada a ${uses} elemento(s). Al eliminarla quedarán sin sección. ¿Continuar?`
        : `¿Eliminar la sección '${name}'?`
    );
    if (!confirm) return;
    setDeleting(name);
    try {
      await structuralEditorApi.deleteSection(projectId, name);
      onModelDataChange();
      setSuccess(`Sección '${name}' eliminada.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al eliminar");
    } finally {
      setDeleting(null);
    }
  }

  // ── Lista ──────────────────────────────────────────────────────────────────
  if (mode === "list") {
    return (
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="px-4 py-3 border-b border-border bg-surface-2 flex-shrink-0">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-text">
              Secciones <span className="text-text-muted font-normal">({Object.keys(sections).length})</span>
            </span>
            <button
              onClick={startCreate}
              className="text-[11px] px-2.5 py-1 rounded-lg bg-accent text-white hover:bg-accent/80 transition-colors font-medium"
            >
              + Nueva
            </button>
          </div>
          <input
            type="text"
            placeholder="Filtrar secciones…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="w-full text-xs rounded-lg border border-border bg-surface px-2.5 py-1.5 text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
          />
        </div>

        {success && (
          <div className="mx-4 mt-2 px-3 py-1.5 rounded-lg bg-success/10 border border-success/30">
            <p className="text-[11px] text-success">{success}</p>
          </div>
        )}
        {error && (
          <div className="mx-4 mt-2 px-3 py-1.5 rounded-lg bg-danger/10 border border-danger/30">
            <p className="text-[11px] text-danger">{error}</p>
          </div>
        )}

        {/* Lista */}
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 && (
            <div className="px-4 py-8 text-center">
              <p className="text-xs text-text-muted">
                {filter ? "Sin resultados para ese filtro." : "No hay secciones definidas."}
              </p>
            </div>
          )}
          {filtered.map(([name, sec]) => {
            const uses = usesCount(name, frames);
            const h_cm = sec.h_m * 100;
            const b_cm = sec.b_m * 100;
            return (
              <div key={name}
                className="flex items-center gap-2 px-4 py-2.5 border-b border-border/40 hover:bg-surface-2 transition-colors group">
                <SectionMiniThumb h_cm={h_cm} b_cm={b_cm} />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-text truncate">{name}</p>
                  <p className="text-[10px] text-text-muted">
                    {h_cm.toFixed(0)}×{b_cm.toFixed(0)} cm
                    &nbsp;·&nbsp;{sec.material}
                    {uses > 0 && <span className="ml-1 text-accent">{uses} elem.</span>}
                  </p>
                </div>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => startEdit(name, sec)}
                    className="text-[10px] px-2 py-0.5 rounded border border-border text-text-muted hover:text-text hover:border-accent transition-colors"
                  >
                    Editar
                  </button>
                  <button
                    onClick={() => handleDelete(name)}
                    disabled={deleting === name}
                    className="text-[10px] px-2 py-0.5 rounded border border-danger/40 text-danger hover:bg-danger/10 transition-colors disabled:opacity-40"
                  >
                    {deleting === name ? "…" : "×"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ── Formulario crear/editar ────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border bg-surface-2 flex-shrink-0">
        <p className="text-xs font-semibold text-text">
          {mode === "create" ? "Nueva sección" : `Editar: ${editingName}`}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3">
        {mode === "create" && (
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-widest text-text-muted block mb-1">
              Nombre *
            </label>
            <input
              type="text"
              placeholder="ej. C40x60"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              className="w-full text-xs rounded-lg border border-border bg-surface px-2.5 py-1.5 text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
            />
          </div>
        )}

        <div>
          <label className="text-[10px] font-semibold uppercase tracking-widest text-text-muted block mb-1">
            Material *
          </label>
          <select
            value={form.material}
            onChange={e => setForm(f => ({ ...f, material: e.target.value }))}
            className="w-full text-xs rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-text focus:outline-none focus:border-accent"
          >
            <option value="">— Seleccionar —</option>
            {matNames.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-widest text-text-muted block mb-1">
              h (cm) *
            </label>
            <input
              type="number" min="1" step="1"
              placeholder="60"
              value={form.h_cm}
              onChange={e => setForm(f => ({ ...f, h_cm: e.target.value }))}
              className="w-full text-xs rounded-lg border border-border bg-surface px-2.5 py-1.5 text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-widest text-text-muted block mb-1">
              b (cm) *
            </label>
            <input
              type="number" min="1" step="1"
              placeholder="40"
              value={form.b_cm}
              onChange={e => setForm(f => ({ ...f, b_cm: e.target.value }))}
              className="w-full text-xs rounded-lg border border-border bg-surface px-2.5 py-1.5 text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
            />
          </div>
        </div>

        {/* Preview visual + propiedades calculadas */}
        {form.h_cm && form.b_cm && parseFloat(form.h_cm) > 0 && parseFloat(form.b_cm) > 0 && (
          <div className="rounded-lg border border-border/60 bg-surface-2 px-3 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-text-muted mb-2">
              Sección transversal
            </p>
            {(() => {
              const h = parseFloat(form.h_cm) / 100;
              const b = parseFloat(form.b_cm) / 100;
              const A   = b * h;
              const I33 = b * h ** 3 / 12;
              const I22 = h * b ** 3 / 12;
              return (
                <div className="flex items-center gap-3">
                  <SectionPreviewSVG h_cm={parseFloat(form.h_cm)} b_cm={parseFloat(form.b_cm)} />
                  <div className="text-[10px] text-text-muted space-y-1">
                    <div className="flex justify-between gap-4">
                      <span>A</span>
                      <span className="font-mono text-text">{(A * 10000).toFixed(1)} cm²</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span>I₃₃</span>
                      <span className="font-mono text-text">{(I33 * 1e8).toFixed(0)} cm⁴</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span>I₂₂</span>
                      <span className="font-mono text-text">{(I22 * 1e8).toFixed(0)} cm⁴</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span>r₃₃</span>
                      <span className="font-mono text-text">{(Math.sqrt(I33 / A) * 100).toFixed(1)} cm</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span>S₃₃</span>
                      <span className="font-mono text-text">{(b * h ** 2 / 6 * 1e6).toFixed(0)} cm³</span>
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {error && (
          <p className="text-[11px] text-danger px-1">{error}</p>
        )}
      </div>

      {/* Acciones */}
      <div className="px-4 py-3 border-t border-border flex gap-2 flex-shrink-0">
        <button
          onClick={cancel}
          className="flex-1 py-1.5 text-xs font-medium rounded-lg border border-border text-text-muted hover:text-text hover:border-text-muted transition-colors"
        >
          Cancelar
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex-1 py-1.5 text-xs font-medium rounded-lg bg-accent text-white hover:bg-accent/80 transition-colors disabled:opacity-40"
        >
          {saving ? "Guardando…" : mode === "create" ? "Crear sección" : "Guardar cambios"}
        </button>
      </div>
    </div>
  );
}
