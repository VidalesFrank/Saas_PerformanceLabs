"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

interface Props {
  patterns: string[];
  cmLoad: string;
  cvLoad: string;
  onSave: (cm: string, cv: string) => Promise<void>;
}

const DEAD_HINTS = new Set(["dead", "cm", "d", "sdl", "sw", "carga muerta", "muerta", "permanente"]);
const LIVE_HINTS = new Set(["live", "cv", "l", "carga viva", "viva", "sobrecarga"]);

function guessType(pattern: string): "dead" | "live" | null {
  const lower = pattern.toLowerCase();
  if (DEAD_HINTS.has(lower)) return "dead";
  if (LIVE_HINTS.has(lower)) return "live";
  return null;
}

export function LoadPatternSelector({ patterns, cmLoad, cvLoad, onSave }: Props) {
  const [cm, setCm] = useState(cmLoad);
  const [cv, setCv] = useState(cvLoad);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Si el valor actual ya no está en la lista, intenta auto-detectar
  const effectiveCm = patterns.includes(cm) ? cm : (patterns.find((p) => guessType(p) === "dead") ?? cm);
  const effectiveCv = patterns.includes(cv) ? cv : (patterns.find((p) => guessType(p) === "live") ?? cv);

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    try {
      await onSave(cm, cv);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-text-muted">
        Se detectaron <strong className="text-text">{patterns.length}</strong> patrones de carga en el modelo.
        Indica cuál corresponde a carga muerta y cuál a carga viva.
      </p>

      {/* Chips de patrones detectados */}
      <div className="flex flex-wrap gap-1.5">
        {patterns.map((p) => {
          const hint = guessType(p);
          return (
            <span
              key={p}
              className={[
                "inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium border",
                hint === "dead"
                  ? "border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
                  : hint === "live"
                  ? "border-[var(--color-success)]/40 bg-[var(--color-success)]/10 text-[var(--color-success)]"
                  : "border-border bg-surface-2 text-text-muted",
              ].join(" ")}
              title={
                hint === "dead" ? "Detectado como carga muerta"
                : hint === "live" ? "Detectado como carga viva"
                : "Sin coincidencia automática"
              }
            >
              {p}
              {hint === "dead" && <span className="ml-1 opacity-60">CM</span>}
              {hint === "live" && <span className="ml-1 opacity-60">CV</span>}
            </span>
          );
        })}
      </div>

      {/* Selectores */}
      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-semibold text-text">
            Carga Muerta (CM)
          </label>
          <select
            value={cm}
            onChange={(e) => setCm(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text
                       focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
          >
            {patterns.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <p className="text-[10px] text-text-muted">
            Peso propio + cargas permanentes (Dead, CM, SW…)
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-semibold text-text">
            Carga Viva (CV)
          </label>
          <select
            value={cv}
            onChange={(e) => setCv(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text
                       focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
          >
            {patterns.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <p className="text-[10px] text-text-muted">
            Sobrecargas de uso (Live, CV, L…)
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Guardando..." : "Guardar asignación"}
        </Button>
        {saved && (
          <span className="text-xs text-[var(--color-success)] font-medium">
            ✓ Guardado
          </span>
        )}
        {cm === cv && (
          <span className="text-xs text-[var(--color-warning)]">
            ⚠ Carga muerta y viva apuntan al mismo patrón
          </span>
        )}
      </div>
    </div>
  );
}
