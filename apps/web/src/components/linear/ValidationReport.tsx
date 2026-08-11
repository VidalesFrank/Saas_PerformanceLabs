"use client";

import { useState } from "react";
import type { ValidationResult, ValidationIssue, ModelSummary } from "@/lib/structural-types";

interface Props {
  report: ValidationResult;
}

// ── Iconos inline ─────────────────────────────────────────────────────────────

function IconCritical() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm.75 4.5v4a.75.75 0 0 1-1.5 0v-4a.75.75 0 0 1 1.5 0zm-.75 6.5a.875.875 0 1 1 0-1.75A.875.875 0 0 1 8 12z" />
    </svg>
  );
}

function IconWarning() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8.48 1.54a.55.55 0 0 0-.96 0L.54 13.46A.55.55 0 0 0 1.02 14h13.96a.55.55 0 0 0 .48-.54.54.54 0 0 0-.06-.26L8.48 1.54zM7.25 6.5a.75.75 0 0 1 1.5 0v3a.75.75 0 0 1-1.5 0v-3zm.75 5.5a.875.875 0 1 1 0-1.75A.875.875 0 0 1 8 12z" />
    </svg>
  );
}

function IconOk() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm3.03 5.47-4 4a.75.75 0 0 1-1.06 0l-2-2a.75.75 0 0 1 1.06-1.06l1.47 1.47 3.47-3.47a.75.75 0 0 1 1.06 1.06z" />
    </svg>
  );
}

// ── Badge de severidad ────────────────────────────────────────────────────────

function SeverityBadge({ severity }: { severity: ValidationIssue["severity"] }) {
  const isCritical = severity === "critical";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
      style={{
        background: isCritical ? "var(--color-danger)22" : "var(--color-warning)22",
        color:      isCritical ? "var(--color-danger)"   : "var(--color-warning)",
      }}
    >
      {isCritical ? <IconCritical /> : <IconWarning />}
      {isCritical ? "Crítico" : "Advertencia"}
    </span>
  );
}

// ── Resumen del modelo ────────────────────────────────────────────────────────

function ModelSummaryCard({ summary }: { summary: ModelSummary }) {
  const stats = [
    { label: "Pisos",       value: summary.n_stories },
    { label: "Nodos",       value: summary.n_joints },
    { label: "Frames",      value: summary.n_frames },
    { label: "Shells",      value: summary.n_shells },
    { label: "Secciones",   value: summary.n_sections },
    { label: "Materiales",  value: summary.n_materials },
  ];

  return (
    <div className="rounded-lg border border-border bg-surface-2 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-3">
        Resumen del modelo
      </p>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
        {stats.map(({ label, value }) => (
          <div key={label} className="text-center">
            <p className="text-xl font-bold text-text">{value}</p>
            <p className="text-[10px] text-text-muted mt-0.5">{label}</p>
          </div>
        ))}
      </div>
      {summary.total_height_m > 0 && (
        <p className="mt-3 text-xs text-text-muted text-center">
          Altura total: <span className="text-text font-medium">{summary.total_height_m} m</span>
          {summary.story_names.length > 0 && (
            <> · Pisos: <span className="text-text font-medium">{summary.story_names.join(", ")}</span></>
          )}
        </p>
      )}
    </div>
  );
}

// ── Fila de issue ─────────────────────────────────────────────────────────────

function IssueRow({ issue }: { issue: ValidationIssue }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = issue.details && Object.keys(issue.details).length > 0;

  return (
    <div className="border-b border-border last:border-0">
      <div
        className={[
          "flex items-start gap-3 px-4 py-3",
          hasDetails ? "cursor-pointer hover:bg-surface-2 transition-colors" : "",
        ].join(" ")}
        onClick={() => hasDetails && setExpanded(!expanded)}
      >
        <div className="mt-0.5 flex-shrink-0">
          <SeverityBadge severity={issue.severity} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-text leading-snug">{issue.message}</p>
          {issue.location && (
            <p className="text-[11px] text-text-muted mt-0.5">
              {issue.location}
              {issue.code && <> · <span className="font-mono">{issue.code}</span></>}
            </p>
          )}
        </div>
        {hasDetails && (
          <span className="text-text-muted text-xs mt-0.5 flex-shrink-0">
            {expanded ? "▲" : "▼"}
          </span>
        )}
      </div>
      {expanded && hasDetails && (
        <div className="px-4 pb-3">
          <pre className="text-[11px] text-text-muted bg-surface rounded p-2 overflow-x-auto">
            {JSON.stringify(issue.details, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Componente principal ──────────────────────────────────────────────────────

// Códigos que se manejan en la UI de LoadPatternSelector — no mostrar aquí
const LOAD_PATTERN_CODES = new Set(["LOAD_PATTERN_MAPPING_REQUIRED", "MISSING_LOAD_PATTERN"]);

export function ValidationReport({ report }: Props) {
  const [filterSeverity, setFilterSeverity] = useState<"all" | "critical" | "warning">("all");

  const { validation_status, has_critical, issues, model_summary } = report;

  // Ocultar advertencias de patrones de carga — están en LoadPatternSelector
  const visibleIssues = issues.filter((i) => !LOAD_PATTERN_CODES.has(i.code));
  const n_critical = visibleIssues.filter((i) => i.severity === "critical").length;
  const n_warnings = visibleIssues.filter((i) => i.severity === "warning").length;

  const filtered = visibleIssues.filter((i) => {
    if (filterSeverity === "all") return true;
    return i.severity === filterSeverity;
  });

  // Banner según estado
  const banner = has_critical
    ? { text: "No se puede construir el modelo — corrija los errores críticos primero.",
        bg: "var(--color-danger)18", border: "var(--color-danger)", color: "var(--color-danger)",
        icon: <IconCritical /> }
    : n_warnings > 0
    ? { text: "El modelo se construyó con advertencias. Revíselas antes de continuar.",
        bg: "var(--color-warning)18", border: "var(--color-warning)", color: "var(--color-warning)",
        icon: <IconWarning /> }
    : { text: "Modelo válido. Sin errores ni advertencias.",
        bg: "var(--color-success)18", border: "var(--color-success)", color: "var(--color-success)",
        icon: <IconOk /> };

  return (
    <div className="flex flex-col gap-4">

      {/* Banner de estado */}
      <div
        className="flex items-center gap-2 rounded-lg border px-4 py-3"
        style={{ background: banner.bg, borderColor: banner.border }}
      >
        <span style={{ color: banner.color }}>{banner.icon}</span>
        <p className="text-sm font-medium" style={{ color: banner.color }}>
          {banner.text}
        </p>
      </div>

      {/* Resumen del modelo */}
      {model_summary && <ModelSummaryCard summary={model_summary} />}

      {/* Lista de issues */}
      {issues.length > 0 && (
        <div className="rounded-lg border border-border bg-surface overflow-hidden">
          {/* Cabecera con filtros */}
          <div className="flex items-center justify-between border-b border-border px-4 py-3 bg-surface-2">
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wide">
              Hallazgos
            </p>
            <div className="flex gap-1">
              {[
                { id: "all",      label: `Todos (${issues.length})` },
                { id: "critical", label: `Críticos (${n_critical})`, color: "var(--color-danger)" },
                { id: "warning",  label: `Advertencias (${n_warnings})`, color: "var(--color-warning)" },
              ].map(({ id, label, color }) => (
                <button
                  key={id}
                  onClick={() => setFilterSeverity(id as typeof filterSeverity)}
                  className={[
                    "rounded px-2 py-1 text-[11px] font-medium transition-colors",
                    filterSeverity === id
                      ? "text-text"
                      : "text-text-muted hover:text-text",
                  ].join(" ")}
                  style={filterSeverity === id && color
                    ? { background: `${color}22`, color }
                    : undefined}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Items */}
          {filtered.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-text-muted">
              No hay hallazgos en esta categoría.
            </p>
          ) : (
            filtered.map((issue, idx) => (
              <IssueRow key={`${issue.code}-${idx}`} issue={issue} />
            ))
          )}
        </div>
      )}
    </div>
  );
}
