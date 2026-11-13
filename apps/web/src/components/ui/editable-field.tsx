"use client";

import { KeyboardEvent, useEffect, useRef, useState } from "react";

/* EditableField — click-to-edit inline.
 *
 * Patrón de uso:
 *   const [name, setName] = useState(project.name);
 *   <EditableField
 *     value={name}
 *     onSave={async (v) => { const p = await api.update(id, { name: v }); setName(p.name); }}
 *     className="text-2xl font-bold text-text"
 *   />
 *
 * Interacción:
 *   - Hover: ícono de lápiz aparece al lado
 *   - Click en el texto o el lápiz: entra en modo edición
 *   - Enter: guarda (textarea: Ctrl/Cmd+Enter)
 *   - Esc: cancela sin guardar
 *   - Click fuera: guarda (comportamiento "blur = commit")
 *   - Durante el guardado: input disabled + spinner
 *   - En error: mensaje rojo bajo el campo, no sale de edición
 */

export interface EditableFieldProps {
  value: string;
  onSave: (value: string) => Promise<void> | void;
  /** Elemento visual en modo lectura (default "span"). */
  as?: "span" | "h1" | "h2" | "h3" | "p" | "div";
  /** multiline usa <textarea> en edición y permite \n en la lectura. */
  multiline?: boolean;
  /** Mostrado cuando value está vacío (en modo lectura). */
  placeholder?: string;
  /** Validación local síncrona. Devuelve un mensaje de error o null. */
  validate?: (value: string) => string | null;
  /** Clase para el elemento de lectura. */
  className?: string;
  /** Clase para el input/textarea. Default coincide con la lectura. */
  inputClassName?: string;
  /** Texto accesible del botón de edición. */
  ariaLabel?: string;
  /** Si true, no permite salir del modo edición hasta guardar válido. */
  disableBlurSave?: boolean;
}

export function EditableField({
  value,
  onSave,
  as = "span",
  multiline = false,
  placeholder = "Sin contenido",
  validate,
  className = "",
  inputClassName,
  ariaLabel = "Editar",
  disableBlurSave = false,
}: EditableFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  // Si el value cambia externamente mientras no estamos editando, sincronizar.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  // Autofoco + selección al entrar en edición
  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if ("select" in el) el.select();
  }, [editing]);

  function startEdit() {
    setDraft(value);
    setError(null);
    setEditing(true);
  }

  function cancelEdit() {
    setDraft(value);
    setError(null);
    setEditing(false);
  }

  async function commit() {
    const trimmed = draft.trim();
    // Sin cambios: salir sin llamar al backend
    if (trimmed === (value ?? "").trim()) {
      setEditing(false);
      setError(null);
      return;
    }
    if (validate) {
      const err = validate(trimmed);
      if (err) { setError(err); return; }
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmed);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar");
    } finally {
      setSaving(false);
    }
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
      return;
    }
    if (e.key === "Enter") {
      // En textarea: solo guarda con Ctrl/Cmd+Enter (permite \n normal)
      if (multiline && !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      commit();
    }
  }

  // ── Modo edición ─────────────────────────────────────────────────────────
  if (editing) {
    const commonInputClass =
      inputClassName ??
      "w-full rounded-md border border-[var(--tech-cyan)] bg-surface px-2 py-1 " +
      "text-[inherit] text-text shadow-[0_0_0_3px_color-mix(in_srgb,var(--tech-cyan)_18%,transparent)] " +
      "focus:outline-none disabled:opacity-60 " +
      className;

    return (
      <span className="inline-flex w-full flex-col gap-1">
        <span className="inline-flex items-center gap-2">
          {multiline ? (
            <textarea
              ref={inputRef as React.RefObject<HTMLTextAreaElement>}
              value={draft}
              rows={3}
              disabled={saving}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKey}
              onBlur={() => { if (!disableBlurSave) commit(); }}
              className={commonInputClass + " resize-y min-h-[72px] leading-relaxed"}
            />
          ) : (
            <input
              ref={inputRef as React.RefObject<HTMLInputElement>}
              type="text"
              value={draft}
              disabled={saving}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKey}
              onBlur={() => { if (!disableBlurSave) commit(); }}
              className={commonInputClass}
            />
          )}
          {saving && (
            <span className="flex-shrink-0 text-[11px] font-mono text-text-muted">guardando…</span>
          )}
        </span>
        <span className="text-[10.5px] text-text-muted">
          {error ? (
            <span className="text-danger">{error}</span>
          ) : (
            <>Enter para guardar · Esc para cancelar{multiline ? " · Ctrl+Enter en multilínea" : ""}</>
          )}
        </span>
      </span>
    );
  }

  // ── Modo lectura ─────────────────────────────────────────────────────────
  const Tag = as as React.ElementType;
  const isEmpty = !value || value.trim() === "";

  return (
    <span
      className="group inline-flex items-center gap-1.5"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Tag
        onClick={startEdit}
        className={
          "cursor-text rounded-sm transition-colors hover:bg-[color-mix(in_srgb,var(--tech-cyan)_8%,transparent)] " +
          `${isEmpty ? "italic text-text-muted" : ""} ${className}`
        }
        title="Click para editar"
        style={multiline ? { whiteSpace: "pre-wrap" } : undefined}
      >
        {isEmpty ? placeholder : value}
      </Tag>
      <button
        type="button"
        onClick={startEdit}
        aria-label={ariaLabel}
        className="opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 text-text-muted hover:text-[var(--tech-cyan)]"
        style={{ visibility: hovered ? "visible" : undefined }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
      </button>
    </span>
  );
}
