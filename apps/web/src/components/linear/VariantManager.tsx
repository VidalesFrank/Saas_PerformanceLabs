"use client";

/**
 * VariantManager — Gestor de variantes de rediseño del edificio.
 *
 * Se ubica al inicio del NLPushoverPanel. Permite:
 *   • Ver las variantes creadas
 *   • Seleccionar la variante activa (donde se guardan los overrides)
 *   • Crear una variante nueva
 *   • Borrar una variante
 *   • Ver cuántos overrides tiene cada variante
 *
 * El re-análisis se agrega en sprint 6.2.
 */
import { useEffect, useState } from "react";
import { structuralAnalysisApi } from "@/lib/structural-api";
import type { DesignVariant } from "@/lib/structural-types";

interface Props {
  projectId:        string;
  activeVariantId:  string | null;
  onSelect:         (v: DesignVariant | null) => void;
  onVariantsChanged?: (list: DesignVariant[]) => void;
}

export default function VariantManager({ projectId, activeVariantId, onSelect, onVariantsChanged }: Props) {
  const [variants, setVariants] = useState<DesignVariant[]>([]);
  const [loading, setLoading]   = useState(true);
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName]   = useState("");
  const [newDesc, setNewDesc]   = useState("");
  const [err, setErr]           = useState<string | null>(null);

  async function loadList() {
    setLoading(true); setErr(null);
    try {
      const res = await structuralAnalysisApi.listDesignVariants(projectId);
      setVariants(res.variants);
      onVariantsChanged?.(res.variants);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error al cargar variantes");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadList(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [projectId]);

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true); setErr(null);
    try {
      const v = await structuralAnalysisApi.createDesignVariant(projectId, newName, newDesc);
      const next = [...variants, v];
      setVariants(next);
      onVariantsChanged?.(next);
      onSelect(v);
      setShowForm(false); setNewName(""); setNewDesc("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error al crear");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(v: DesignVariant) {
    if (!confirm(`¿Eliminar la variante "${v.name}"?`)) return;
    try {
      await structuralAnalysisApi.deleteDesignVariant(projectId, v.variant_id);
      const next = variants.filter((x) => x.variant_id !== v.variant_id);
      setVariants(next);
      onVariantsChanged?.(next);
      if (activeVariantId === v.variant_id) onSelect(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error al eliminar");
    }
  }

  const statusBadge = (s: string) => {
    const map: Record<string, string> = {
      draft:     "bg-slate-100 text-slate-700",
      analyzing: "bg-blue-100 text-blue-700 animate-pulse",
      analyzed:  "bg-green-100 text-green-700",
      failed:    "bg-red-100 text-red-700",
    };
    return map[s] ?? map.draft;
  };

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--border)] bg-[var(--surface-2)] flex items-center gap-3 flex-wrap">
        <span className="text-xs font-semibold text-[var(--text)] uppercase tracking-wider">
          Variantes de Rediseño
        </span>
        <span className="text-[11px] text-[var(--text-muted)]">
          {variants.length} creada{variants.length === 1 ? "" : "s"}
        </span>
        <button
          onClick={() => setShowForm((s) => !s)}
          className="ml-auto px-3 py-1 rounded text-[11px] font-medium bg-[var(--accent)] text-white hover:opacity-90"
        >
          {showForm ? "Cancelar" : "+ Nueva variante"}
        </button>
      </div>

      {showForm && (
        <div className="p-4 border-b border-[var(--border)] bg-[var(--surface-2)] space-y-2">
          <input
            value={newName} onChange={(e) => setNewName(e.target.value)}
            placeholder="Nombre (ej: Aumento EBE en pieres críticos)"
            className="w-full px-3 py-1.5 rounded border border-[var(--border)] bg-[var(--surface)] text-sm text-[var(--text)]"
          />
          <textarea
            value={newDesc} onChange={(e) => setNewDesc(e.target.value)}
            placeholder="Descripción / objetivo del cambio (opcional)"
            rows={2}
            className="w-full px-3 py-1.5 rounded border border-[var(--border)] bg-[var(--surface)] text-sm text-[var(--text)]"
          />
          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              disabled={creating || !newName.trim()}
              className="px-3 py-1.5 rounded text-[11px] font-medium bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50"
            >
              {creating ? "Creando..." : "Crear"}
            </button>
          </div>
        </div>
      )}

      {loading && (
        <div className="p-6 flex items-center justify-center">
          <p className="text-sm text-[var(--text-muted)] animate-pulse">Cargando variantes...</p>
        </div>
      )}

      {err && <p className="px-4 py-2 text-xs text-red-600 bg-red-50">{err}</p>}

      {!loading && variants.length === 0 && !showForm && (
        <div className="p-6 text-center">
          <p className="text-sm text-[var(--text-muted)]">
            No hay variantes de rediseño todavía. Crea una para empezar a proponer cambios en pieres críticos.
          </p>
        </div>
      )}

      {!loading && variants.length > 0 && (
        <div className="divide-y divide-[var(--border)]">
          {variants.map((v) => {
            const active = v.variant_id === activeVariantId;
            const nOverrides = Object.keys(v.overrides ?? {}).length;
            return (
              <div
                key={v.variant_id}
                className={[
                  "px-4 py-2.5 flex items-center gap-3 transition-colors",
                  active ? "bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]" : "hover:bg-[var(--surface-2)]",
                ].join(" ")}
              >
                <input
                  type="radio"
                  checked={active}
                  onChange={() => onSelect(v)}
                  className="accent-[var(--accent)]"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[var(--text)] truncate">{v.name}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${statusBadge(v.status)}`}>
                      {v.status}
                    </span>
                    <span className="text-[10px] text-[var(--text-muted)]">
                      {nOverrides} override{nOverrides === 1 ? "" : "s"}
                    </span>
                  </div>
                  {v.description && (
                    <p className="text-[11px] text-[var(--text-muted)] mt-0.5 truncate">{v.description}</p>
                  )}
                </div>
                <button
                  onClick={() => handleDelete(v)}
                  className="text-xs text-[var(--text-muted)] hover:text-red-600 px-2"
                  title="Eliminar variante"
                >
                  ✕
                </button>
              </div>
            );
          })}
          <div className="px-4 py-2 bg-[var(--surface-2)] flex items-center justify-between">
            <button
              onClick={() => onSelect(null)}
              className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)]"
            >
              Trabajar sin variante (solo baseline)
            </button>
            <span className="text-[10px] text-[var(--text-muted)] italic">
              El re-análisis diferencial se habilitará en el próximo sprint
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
