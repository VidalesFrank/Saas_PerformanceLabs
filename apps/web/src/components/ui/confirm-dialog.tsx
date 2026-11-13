"use client";

import { ReactNode, useEffect, useRef, useState } from "react";

/* ConfirmDialog — modal reutilizable para acciones destructivas o irreversibles.
 *
 * Patrón de uso:
 *   const [open, setOpen] = useState(false);
 *   <Button variant="danger" onClick={() => setOpen(true)}>Eliminar</Button>
 *   <ConfirmDialog
 *     open={open}
 *     onClose={() => setOpen(false)}
 *     onConfirm={async () => { await api.delete(id); refresh(); }}
 *     title="¿Eliminar proyecto?"
 *     description="Se perderán los análisis, resultados y archivos subidos. Esta acción no se puede deshacer."
 *     confirmLabel="Eliminar"
 *     tone="danger"
 *   />
 *
 * Comportamiento:
 *   - Esc cierra (si no está confirmando)
 *   - Click en el backdrop cierra (si no está confirmando)
 *   - Durante onConfirm: botones deshabilitados + "Eliminando…"
 *   - onConfirm puede ser async; si lanza, se muestra el mensaje bajo el cuerpo
 *   - Focus inicial en el botón de confirmar (comportamiento accesible)
 */

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** "danger" → rojo. "primary" → acción positiva (raro aquí). */
  tone?: "danger" | "primary";
  /** Contenido adicional entre description y botones (p. ej. stats de lo que se borrará). */
  children?: ReactNode;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  tone = "danger",
  children,
}: ConfirmDialogProps) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      setError(null);
      setWorking(false);
      return;
    }
    // Enfocar el botón de confirmar un tick después para que exista en el DOM
    const id = setTimeout(() => confirmRef.current?.focus(), 30);

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !working) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(id);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, working]);

  if (!open) return null;

  async function handleConfirm() {
    setError(null);
    setWorking(true);
    try {
      await onConfirm();
      // El padre decide si cierra el dialog tras el onConfirm (típicamente sí).
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo completar la acción");
    } finally {
      setWorking(false);
    }
  }

  const accent = tone === "danger" ? "#ef4444" : "#22d3ee";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pl-confirm-title"
      onClick={() => { if (!working) onClose(); }}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 backdrop-blur-[3px]"
        style={{ background: "rgba(5, 11, 24, 0.55)" }}
      />

      {/* Card */}
      <div
        className="relative w-full max-w-[460px] rounded-2xl border border-border bg-surface p-6 shadow-[0_30px_60px_-20px_rgba(0,0,0,0.35),0_8px_24px_-12px_rgba(0,0,0,0.2)]"
        style={{ animation: "pl-fade-up 0.18s ease-out" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Ícono + título */}
        <div className="mb-3 flex items-start gap-3">
          <div
            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl"
            style={{
              background: `color-mix(in srgb, ${accent} 14%, transparent)`,
              color: accent,
              border: `1px solid color-mix(in srgb, ${accent} 30%, transparent)`,
            }}
          >
            {tone === "danger" ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9"  x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M9 12l2 2 4-4" />
              </svg>
            )}
          </div>
          <div className="min-w-0 pt-0.5">
            <h2 id="pl-confirm-title" className="text-[16px] font-semibold leading-tight text-text">
              {title}
            </h2>
            {description && (
              <p className="mt-1.5 text-[13px] leading-relaxed text-text-muted">
                {description}
              </p>
            )}
          </div>
        </div>

        {/* Contenido extra */}
        {children && <div className="mt-4">{children}</div>}

        {/* Error */}
        {error && (
          <div
            className="mt-4 rounded-md border px-3 py-2 text-[12px]"
            style={{
              background: "rgba(239, 68, 68, 0.08)",
              borderColor: "rgba(239, 68, 68, 0.3)",
              color: "#dc2626",
            }}
          >
            {error}
          </div>
        )}

        {/* Botones */}
        <div className="mt-6 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={working}
            className="rounded-md border border-border bg-surface-2 px-4 py-2 text-[13px] font-medium text-text hover:bg-surface disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={handleConfirm}
            disabled={working}
            className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-[13px] font-semibold text-white shadow-[0_6px_18px_-8px_rgba(239,68,68,0.5)] transition-[filter,box-shadow] hover:brightness-110 disabled:opacity-60 disabled:cursor-not-allowed"
            style={{
              background:
                tone === "danger"
                  ? "linear-gradient(135deg, #ef4444 0%, #dc2626 100%)"
                  : "linear-gradient(135deg, #22d3ee 0%, #3b82f6 100%)",
            }}
          >
            {working && (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth={2.5} strokeLinecap="round" className="animate-spin">
                <path d="M21 12a9 9 0 11-6.219-8.56" />
              </svg>
            )}
            {working ? (tone === "danger" ? "Eliminando…" : "Procesando…") : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
