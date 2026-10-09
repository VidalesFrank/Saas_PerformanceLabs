"use client";

import { useEffect, useRef, useState } from "react";
import { structuralProjectsApi } from "@/lib/structural-api";

interface Props {
  projectId: string;
  disabled?: boolean;
}

export default function ExportModelButton({ projectId, disabled }: Props) {
  const [open, setOpen]           = useState(false);
  const [includeReinf, setIncR]   = useState(true);
  const [includeDesign, setIncD]  = useState(true);
  const [busy, setBusy]           = useState(false);
  const [done, setDone]           = useState<string | null>(null);
  const [error, setError]         = useState<string | null>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  async function handleExport() {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await structuralProjectsApi.exportProject(projectId, {
        include_reinforcement: includeReinf,
        include_design:        includeDesign,
      });
      setDone(r.filename);
      setTimeout(() => setDone(null), 4000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative inline-block" ref={popRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={disabled || busy}
        title={disabled ? "Valida el modelo antes de exportar" : "Exportar modelo"}
        className="inline-flex items-center gap-1 text-xs font-semibold px-3 py-1 rounded border border-[var(--border)] text-[var(--text)] hover:border-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_5%,transparent)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        <span aria-hidden>⬇</span>
        {busy ? "Exportando…" : "Exportar modelo"}
      </button>

      {open && !disabled && (
        <div
          className="absolute right-0 top-full mt-1 w-72 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg z-20 p-3 text-xs"
        >
          <div className="font-semibold text-[var(--text)] mb-2">Opciones de exportación</div>

          <label className="flex items-start gap-2 py-1 cursor-pointer">
            <input
              type="checkbox"
              checked={includeReinf}
              onChange={(e) => setIncR(e.target.checked)}
              className="mt-0.5"
            />
            <div>
              <div className="text-[var(--text)]">Incluir refuerzo</div>
              <div className="text-[var(--text-muted)] text-[11px]">
                Patrones aplicados y ajustes manuales (reinforcement.json)
              </div>
            </div>
          </label>

          <label className="flex items-start gap-2 py-1 cursor-pointer">
            <input
              type="checkbox"
              checked={includeDesign}
              onChange={(e) => setIncD(e.target.checked)}
              className="mt-0.5"
            />
            <div>
              <div className="text-[var(--text)]">Incluir diseño</div>
              <div className="text-[var(--text-muted)] text-[11px]">
                Resultados de diseño de columnas, vigas y muros + spec no lineal
              </div>
            </div>
          </label>

          <div className="mt-2 pt-2 border-t border-[var(--border)] text-[11px] text-[var(--text-muted)]">
            El modelo canónico y los parámetros sísmicos siempre se incluyen.
            Los resultados de análisis (pushover, modal, dinámico) <b>no</b>: se recomputan al importar.
          </div>

          {error && (
            <div className="mt-2 p-2 rounded bg-red-500/10 border border-red-500/40 text-red-600">
              {error}
            </div>
          )}
          {done && (
            <div className="mt-2 p-2 rounded bg-green-500/10 border border-green-500/40 text-green-700">
              Descargado: <span className="font-mono">{done}</span>
            </div>
          )}

          <div className="mt-3 flex justify-end gap-2">
            <button
              onClick={() => setOpen(false)}
              className="px-3 py-1 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]"
            >
              Cancelar
            </button>
            <button
              onClick={handleExport}
              disabled={busy}
              className="px-3 py-1 rounded bg-[var(--accent)] text-white font-semibold hover:brightness-110 disabled:opacity-50"
            >
              {busy ? "Exportando…" : "Descargar .plabs.json"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
