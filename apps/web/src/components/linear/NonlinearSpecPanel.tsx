"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { nlSpecApi } from "@/lib/structural-api";
import { useTheme } from "@/lib/theme";
import type { NLSpecStatusResult, NLSpecMetadata, NLSpecValidation } from "@/lib/structural-types";

// ── Paleta de estado ───────────────────────────────────────────────────────────

const STATUS_CONFIG = {
  missing: {
    label: "Sin generar",
    color: "var(--text-muted)",
    bg:    "var(--surface-2)",
    border:"var(--border)",
    dot:   "#94a3b8",
  },
  current: {
    label: "Vigente",
    color: "#22c55e",
    bg:    "#22c55e14",
    border:"#22c55e40",
    dot:   "#22c55e",
  },
  stale: {
    label: "Desactualizado",
    color: "#f59e0b",
    bg:    "#f59e0b14",
    border:"#f59e0b40",
    dot:   "#f59e0b",
  },
};

interface Props {
  projectId: string;
  isValidated: boolean;
}

export function NonlinearSpecPanel({ projectId, isValidated }: Props) {
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const [loading,      setLoading]      = useState(true);
  const [generating,   setGenerating]   = useState(false);
  const [uploading,    setUploading]    = useState(false);
  const [statusData,   setStatusData]   = useState<NLSpecStatusResult | null>(null);
  const [error,        setError]        = useState<string | null>(null);
  const [successMsg,   setSuccessMsg]   = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await nlSpecApi.getStatus(projectId);
      setStatusData(data);
    } catch {
      setError("No se pudo obtener el estado del modelo no lineal.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const handleGenerate = async () => {
    setGenerating(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const result = await nlSpecApi.generate(projectId);
      setSuccessMsg(result.message);
      await loadStatus();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error generando modelo no lineal.");
    } finally {
      setGenerating(false);
    }
  };

  const handleDownload = async () => {
    try {
      await nlSpecApi.download(projectId);
    } catch {
      setError("Error descargando el archivo.");
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    setSuccessMsg(null);
    try {
      await nlSpecApi.upload(projectId, file);
      setSuccessMsg("Modelo no lineal cargado correctamente.");
      await loadStatus();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Error al cargar el archivo.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleDelete = async () => {
    if (!confirm("¿Eliminar el modelo no lineal generado? Podrás regenerarlo en cualquier momento.")) return;
    try {
      await nlSpecApi.deleteSpec(projectId);
      setSuccessMsg("Modelo eliminado.");
      await loadStatus();
    } catch {
      setError("Error eliminando el modelo.");
    }
  };

  // ── Estilos base ─────────────────────────────────────────────────────────────

  const card  = "rounded-xl border border-[var(--border)] bg-[var(--surface)]";
  const head  = "px-5 py-4 border-b border-[var(--border)]";
  const body  = "px-5 py-4";
  const label = "text-[11px] text-[var(--text-muted)] uppercase tracking-wide font-semibold";
  const val   = "text-sm font-semibold text-[var(--text)]";
  const mono  = "font-mono text-xs text-[var(--text-muted)]";

  const btnPrimary = `px-4 py-2 text-xs font-semibold rounded-lg transition-colors
    bg-indigo-500 hover:bg-indigo-600 text-white disabled:opacity-50 disabled:cursor-not-allowed`;
  const btnSecondary = `px-3 py-2 text-xs font-medium rounded-lg border transition-colors
    border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] hover:border-[var(--text-muted)]
    disabled:opacity-40 disabled:cursor-not-allowed`;
  const btnDanger = `px-3 py-2 text-xs font-medium rounded-lg border transition-colors
    border-red-500/30 text-red-400 hover:border-red-500/60 hover:text-red-300`;

  if (loading) {
    return (
      <div className="flex flex-col gap-5">
        <div className={`${card} animate-pulse h-28`} />
        <div className={`${card} animate-pulse h-44`} />
      </div>
    );
  }

  const status = statusData?.status ?? "missing";
  const meta   = statusData?.metadata as NLSpecMetadata | null;
  const val_   = statusData?.validation as NLSpecValidation | null;
  const cfg    = STATUS_CONFIG[status];

  const hasSpec = status !== "missing";
  const isStale = status === "stale";
  const pctColDesign = meta ? Math.round((meta.n_columns_designed / Math.max(meta.n_columns, 1)) * 100) : 0;
  const pctBmDesign  = meta ? Math.round((meta.n_beams_designed   / Math.max(meta.n_beams,   1)) * 100) : 0;

  return (
    <div className="flex flex-col gap-5">

      {/* ── Estado ────────────────────────────────────────────────────────── */}
      <div className={card}>
        <div className={head}>
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-[var(--text)]">
                Modelo No Lineal — Spec JSON
              </h2>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                Especificación portátil para análisis pushover e IDA en OpenSees
              </p>
            </div>
            {/* Badge de estado */}
            <div
              className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold"
              style={{ background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.color }}
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: cfg.dot, boxShadow: `0 0 6px ${cfg.dot}` }}
              />
              {cfg.label}
            </div>
          </div>
        </div>

        <div className={body}>
          {/* Mensaje de contexto según estado */}
          {status === "missing" && (
            <p className="text-xs text-[var(--text-muted)] mb-4">
              Aún no se ha generado el modelo no lineal. Haz clic en &quot;Generar&quot; para construirlo desde
              el diseño actual, o carga un JSON previamente guardado.
            </p>
          )}
          {isStale && (
            <div
              className="mb-4 rounded-lg px-4 py-3 text-xs"
              style={{ background: "#f59e0b12", border: "1px solid #f59e0b30", color: "#f59e0b" }}
            >
              El diseño cambió desde la última generación. Regenera el spec para sincronizarlo.
            </div>
          )}
          {!isValidated && (
            <div
              className="mb-4 rounded-lg px-4 py-3 text-xs"
              style={{ background: isDark ? "#ef444412" : "#fef2f2", border: "1px solid #ef444430", color: "#ef4444" }}
            >
              El modelo debe estar importado y validado antes de generar el spec no lineal.
            </div>
          )}

          {/* Acciones */}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleGenerate}
              disabled={generating || !isValidated}
              className={btnPrimary}
            >
              {generating ? "Generando…" : hasSpec ? "Regenerar" : "Generar modelo NL"}
            </button>

            {hasSpec && (
              <button onClick={handleDownload} className={btnSecondary}>
                Descargar JSON
              </button>
            )}

            <label className={`${btnSecondary} cursor-pointer`}>
              {uploading ? "Cargando…" : "Cargar JSON"}
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={handleUpload}
                disabled={uploading || !isValidated}
              />
            </label>

            {hasSpec && (
              <button onClick={handleDelete} className={btnDanger}>
                Eliminar
              </button>
            )}
          </div>

          {/* Mensajes de feedback */}
          {successMsg && (
            <p className="mt-3 text-xs" style={{ color: "#22c55e" }}>{successMsg}</p>
          )}
          {error && (
            <p className="mt-3 text-xs text-red-400">{error}</p>
          )}
        </div>
      </div>

      {/* ── Resumen del spec ──────────────────────────────────────────────── */}
      {hasSpec && meta && (
        <div className={card}>
          <div className={head}>
            <h3 className="text-xs font-semibold text-[var(--text)]">Resumen del spec</h3>
          </div>
          <div className={`${body} grid grid-cols-2 sm:grid-cols-3 gap-4`}>
            <Stat label="Pisos"     value={String(meta.n_stories)} />
            <Stat label="Columnas"  value={String(meta.n_columns)} />
            <Stat label="Vigas"     value={String(meta.n_beams)} />
            <Stat label="Disipación" value={meta.energy_dissipation} />
            <Stat label="Sistema"   value={meta.structure_system} />
            <Stat label="Unidades"  value={meta.units} />
          </div>

          {/* Cobertura de diseño */}
          <div className="px-5 pb-5 flex flex-col gap-3">
            <CoverageBar label="Columnas diseñadas" pct={pctColDesign}
              n={meta.n_columns_designed} total={meta.n_columns} color="#6366f1" />
            <CoverageBar label="Vigas diseñadas" pct={pctBmDesign}
              n={meta.n_beams_designed} total={meta.n_beams} color="#38bdf8" />
          </div>

          {/* Digest */}
          <div className="px-5 pb-4 border-t border-[var(--border)] pt-3">
            <p className={label}>Digest de origen</p>
            <p className={mono}>{meta.source_digest.slice(0, 20)}…</p>
            <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
              Generado: {new Date(meta.generated_at).toLocaleString("es-CO")}
            </p>
          </div>
        </div>
      )}

      {/* ── Advertencias de validación ────────────────────────────────────── */}
      {hasSpec && val_ && val_.warnings.length > 0 && (
        <div className={card}>
          <div className={head}>
            <h3 className="text-xs font-semibold text-[var(--text)]">
              Advertencias del spec ({val_.warnings.length})
            </h3>
          </div>
          <ul className={`${body} flex flex-col gap-2`}>
            {val_.warnings.map((w, i) => (
              <li key={i} className="flex gap-2 text-xs text-[var(--text-muted)]">
                <span className="text-amber-400 mt-0.5 shrink-0">⚠</span>
                <span>{w}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Instrucciones ────────────────────────────────────────────────── */}
      <div
        className="rounded-xl px-5 py-4 text-xs"
        style={{ background: isDark ? "#6366f108" : "#eef2ff", border: "1px solid #6366f120" }}
      >
        <p className="font-semibold text-indigo-400 mb-2">¿Qué puedo hacer con este JSON?</p>
        <ul className="space-y-1 text-[var(--text-muted)] list-disc list-inside">
          <li>Cargarlo en el Módulo 3 para análisis pushover e IDA en OpenSees</li>
          <li>Guardarlo localmente como respaldo del modelo estructural no lineal</li>
          <li>Cargarlo de vuelta en este módulo si necesitas continuar más tarde</li>
          <li>Compartirlo con otro ingeniero para revisión o continuación del trabajo</li>
        </ul>
      </div>
    </div>
  );
}

// ── Sub-componentes ────────────────────────────────────────────────────────────

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] text-[var(--text-muted)] uppercase tracking-wide font-semibold mb-0.5">
        {label}
      </p>
      <p className="text-sm font-semibold text-[var(--text)]">{value}</p>
    </div>
  );
}

function CoverageBar({
  label, pct, n, total, color,
}: { label: string; pct: number; n: number; total: number; color: string }) {
  return (
    <div>
      <div className="flex justify-between mb-1">
        <span className="text-[11px] text-[var(--text-muted)]">{label}</span>
        <span className="text-[11px] text-[var(--text-muted)]">{n} / {total}</span>
      </div>
      <div className="h-1.5 rounded-full bg-[var(--surface-2)] overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
    </div>
  );
}
