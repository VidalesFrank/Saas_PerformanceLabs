"use client";

/**
 * VariantManager — Gestor de variantes de rediseño del edificio.
 *
 * Ubicado dentro de NLPushoverPanel. Permite:
 *   • Ver las variantes creadas
 *   • Seleccionar la variante activa (donde se guardan los overrides)
 *   • Crear / borrar variantes
 *   • Lanzar el re-análisis (pushover NL) de una variante y hacer polling
 *   • Cuando la variante queda "analyzed" ofrecer "Ver resultado" → dispara la
 *     comparación baseline vs variante en el panel padre.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { structuralAnalysisApi } from "@/lib/structural-api";
import type { DesignVariant } from "@/lib/structural-types";

interface Props {
  projectId:        string;
  activeVariantId:  string | null;
  onSelect:         (v: DesignVariant | null) => void;
  onVariantsChanged?: (list: DesignVariant[]) => void;
  onShowResult?:    (v: DesignVariant) => void;
}

const POLL_INTERVAL_MS = 3000;

export default function VariantManager({
  projectId,
  activeVariantId,
  onSelect,
  onVariantsChanged,
  onShowResult,
}: Props) {
  const [variants, setVariants] = useState<DesignVariant[]>([]);
  const [loading, setLoading]   = useState(true);
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName]   = useState("");
  const [newDesc, setNewDesc]   = useState("");
  const [err, setErr]           = useState<string | null>(null);
  const [busyId, setBusyId]     = useState<string | null>(null);

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadList = useCallback(async () => {
    setErr(null);
    try {
      const res = await structuralAnalysisApi.listDesignVariants(projectId);
      setVariants(res.variants);
      onVariantsChanged?.(res.variants);
      return res.variants;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error al cargar variantes");
      return [];
    }
  }, [projectId, onVariantsChanged]);

  useEffect(() => {
    setLoading(true);
    loadList().finally(() => setLoading(false));
  }, [loadList]);

  // ── Polling automático mientras haya variantes en estado "analyzing" ──────
  useEffect(() => {
    const hasAnalyzing = variants.some((v) => v.status === "analyzing");
    if (!hasAnalyzing) {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }
    if (pollTimerRef.current) return; // ya hay uno activo
    pollTimerRef.current = setInterval(loadList, POLL_INTERVAL_MS);
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [variants, loadList]);

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
    if (v.status === "analyzing") {
      alert("No se puede eliminar mientras el análisis está en curso. Espera a que termine.");
      return;
    }
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

  async function handleAnalyze(v: DesignVariant) {
    setBusyId(v.variant_id); setErr(null);
    try {
      await structuralAnalysisApi.analyzeDesignVariant(projectId, v.variant_id);
      // Re-carga inmediata; el polling se activará por el useEffect al detectar analyzing.
      await loadList();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error al lanzar el análisis");
    } finally {
      setBusyId(null);
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

  const canAnalyze = (v: DesignVariant) =>
    (v.status === "draft" || v.status === "failed") &&
    Object.keys(v.overrides ?? {}).length > 0;

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
            const analyzeDisabled = !canAnalyze(v) || busyId === v.variant_id;
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
                  <div className="flex items-center gap-2 flex-wrap">
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
                  {v.status === "failed" && v.error_message && (
                    <p className="text-[11px] text-red-600 mt-0.5 truncate" title={v.error_message}>
                      Error: {v.error_message}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-1.5">
                  {v.status === "analyzed" && (
                    <button
                      onClick={() => onShowResult?.(v)}
                      className="px-2.5 py-1 rounded text-[11px] font-medium bg-green-600 text-white hover:bg-green-700"
                      title="Comparar con baseline"
                    >
                      Ver resultado
                    </button>
                  )}
                  {v.status === "analyzing" && (
                    <span className="text-[11px] text-blue-700 font-medium animate-pulse px-2">
                      Analizando…
                    </span>
                  )}
                  {(v.status === "draft" || v.status === "failed") && (
                    <button
                      onClick={() => handleAnalyze(v)}
                      disabled={analyzeDisabled}
                      className={[
                        "px-2.5 py-1 rounded text-[11px] font-medium transition-colors",
                        analyzeDisabled
                          ? "bg-[var(--surface-2)] text-[var(--text-muted)] opacity-50 cursor-not-allowed"
                          : "bg-[var(--accent)] text-white hover:opacity-90",
                      ].join(" ")}
                      title={
                        nOverrides === 0
                          ? "Añade al menos un override para poder analizar"
                          : v.status === "failed"
                          ? "Reintentar análisis"
                          : "Ejecutar pushover no lineal con esta variante"
                      }
                    >
                      {busyId === v.variant_id
                        ? "Lanzando…"
                        : v.status === "failed"
                        ? "Reintentar"
                        : "Analizar"}
                    </button>
                  )}
                  <button
                    onClick={() => handleDelete(v)}
                    disabled={v.status === "analyzing"}
                    className="text-xs text-[var(--text-muted)] hover:text-red-600 px-2 disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Eliminar variante"
                  >
                    ✕
                  </button>
                </div>
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
              El análisis puede tardar varios minutos según el número de pieres.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
