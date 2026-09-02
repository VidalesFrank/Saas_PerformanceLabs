"use client";

import { useState } from "react";
import type {
  ElementClickInfo,
  FullModelData,
  SectionData,
  AssignSectionResult,
} from "@/lib/structural-types";
import { structuralEditorApi } from "@/lib/structural-api";

interface Props {
  projectId: string;
  selectedIds: Set<string>;
  modelData: FullModelData;
  onSectionAssigned: (result: AssignSectionResult) => void;
  onModelDataChange: () => void;
}

function SectionRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between items-baseline py-1 border-b border-border/40 last:border-0">
      <span className="text-[11px] text-text-muted">{label}</span>
      <span className="text-[11px] font-mono text-text">{value}</span>
    </div>
  );
}

function SectionBadge({ type }: { type: "column" | "beam" | "wall" | "slab" }) {
  const cfg = {
    column: { label: "Columna", color: "var(--color-accent)" },
    beam:   { label: "Viga",    color: "#38BDF8" },
    wall:   { label: "Muro",    color: "#10B981" },
    slab:   { label: "Losa",    color: "#F59E0B" },
  }[type];
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold"
      style={{ background: `${cfg.color}22`, color: cfg.color }}
    >
      {cfg.label}
    </span>
  );
}

export default function ModelPropertiesPanel({
  projectId, selectedIds, modelData, onSectionAssigned,
}: Props) {
  const [assigningSection, setAssigningSection] = useState(false);
  const [assignTarget, setAssignTarget] = useState("");
  const [assignError, setAssignError] = useState<string | null>(null);
  const [assignSuccess, setAssignSuccess] = useState<string | null>(null);

  const selectedArr = [...selectedIds];
  const n = selectedArr.length;

  const sections = modelData.sections;
  const materials = modelData.materials;
  const frames = modelData.frames;

  // Información del elemento seleccionado (cuando es uno solo)
  const singleId = n === 1 ? selectedArr[0] : null;
  const singleFrame = singleId ? frames[singleId] : null;
  const singleSection = singleFrame ? sections[singleFrame.section] : null;
  const singleMaterial = singleSection ? materials[singleSection.material] : null;

  // Sección común cuando hay múltiples seleccionados
  const commonSection = n > 1
    ? (selectedArr.every(id => frames[id]?.section === frames[selectedArr[0]]?.section)
        ? frames[selectedArr[0]]?.section
        : "(múltiples)")
    : undefined;

  async function handleAssignSection() {
    if (!assignTarget || selectedArr.length === 0) return;
    setAssigningSection(true);
    setAssignError(null);
    setAssignSuccess(null);
    try {
      const result = await structuralEditorApi.assignSection(projectId, selectedArr, assignTarget);
      onSectionAssigned(result);
      setAssignSuccess(`${result.n_updated} elemento(s) actualizados → ${assignTarget}`);
      setAssignTarget("");
    } catch (e) {
      setAssignError(e instanceof Error ? e.message : "Error al asignar sección");
    } finally {
      setAssigningSection(false);
    }
  }

  if (n === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-text-muted px-4 text-center">
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none" className="opacity-30">
          <rect x="4" y="4" width="32" height="32" rx="4" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 3"/>
          <circle cx="20" cy="20" r="4" stroke="currentColor" strokeWidth="1.5"/>
        </svg>
        <p className="text-xs leading-relaxed">
          Haz clic en un elemento del modelo para ver sus propiedades.
        </p>
        <p className="text-[11px] opacity-60">
          Ctrl+Clic para selección múltiple
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0 h-full overflow-y-auto">

      {/* ── Cabecera ─────────────────────────────────────────────────────── */}
      <div className="px-4 py-3 border-b border-border bg-surface-2 flex-shrink-0">
        <div className="flex items-center gap-2">
          {n === 1 && singleFrame && (
            <SectionBadge type={singleFrame.element_type as "column" | "beam"} />
          )}
          <span className="text-sm font-semibold text-text truncate">
            {n === 1 ? (singleFrame?.object_label || singleId) : `${n} elementos seleccionados`}
          </span>
        </div>
        {n === 1 && singleFrame && (
          <p className="text-[11px] text-text-muted mt-0.5">
            Piso: {singleFrame.story} &nbsp;·&nbsp; ID: {singleId}
          </p>
        )}
        {n > 1 && (
          <p className="text-[11px] text-text-muted mt-0.5">
            Sección común: <span className="font-mono">{commonSection || "—"}</span>
          </p>
        )}
      </div>

      {/* ── Propiedades (1 elemento) ────────────────────────────────────── */}
      {n === 1 && singleFrame && (
        <div className="px-4 py-3 flex flex-col gap-4">

          {/* SECTION */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-text-muted mb-2">Sección</p>
            {singleSection ? (
              <div className="rounded-lg border border-border bg-surface-2 px-3 py-2 space-y-0.5">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold text-text">{singleFrame.section}</span>
                  <span className="text-[10px] text-text-muted font-mono">{singleSection.shape}</span>
                </div>
                <SectionRow label="h" value={`${(singleSection.h_m * 100).toFixed(0)} cm`} />
                <SectionRow label="b" value={`${(singleSection.b_m * 100).toFixed(0)} cm`} />
                <SectionRow label="A" value={`${(singleSection.A_m2 * 10000).toFixed(1)} cm²`} />
                <SectionRow label="I₃₃" value={`${(singleSection.I33_m4 * 1e8).toFixed(1)} cm⁴`} />
                <SectionRow label="I₂₂" value={`${(singleSection.I22_m4 * 1e8).toFixed(1)} cm⁴`} />
              </div>
            ) : (
              <div className="rounded-lg border border-danger/40 bg-danger/5 px-3 py-2">
                <p className="text-xs text-danger">Sin sección asignada</p>
              </div>
            )}
          </div>

          {/* MATERIAL */}
          {singleMaterial && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-text-muted mb-2">Material</p>
              <div className="rounded-lg border border-border bg-surface-2 px-3 py-2 space-y-0.5">
                <div className="mb-1">
                  <span className="text-xs font-semibold text-text">{singleSection?.material}</span>
                  <span className="text-[10px] text-text-muted ml-2 capitalize">{singleMaterial.type}</span>
                </div>
                {singleMaterial.fpc_mpa > 0 && (
                  <SectionRow label="f'c" value={`${singleMaterial.fpc_mpa} MPa`} />
                )}
                {singleMaterial.fy_mpa && singleMaterial.fy_mpa > 0 && (
                  <SectionRow label="fy" value={`${singleMaterial.fy_mpa} MPa`} />
                )}
                <SectionRow label="E" value={`${(singleMaterial.E_mpa / 1000).toFixed(1)} GPa`} />
              </div>
            </div>
          )}

          {/* GEOMETRY */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-text-muted mb-2">Conectividad</p>
            <div className="rounded-lg border border-border bg-surface-2 px-3 py-2 space-y-0.5">
              <SectionRow label="Nodo I" value={singleFrame.joint_i} />
              <SectionRow label="Nodo J" value={singleFrame.joint_j} />
              <SectionRow label="Piso" value={singleFrame.story} />
            </div>
          </div>
        </div>
      )}

      {/* ── Asignar sección (1 o múltiples) ────────────────────────────── */}
      <div className="px-4 py-3 border-t border-border mt-auto flex-shrink-0">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-text-muted mb-2">
          Asignar sección
        </p>
        <div className="flex gap-2">
          <select
            value={assignTarget}
            onChange={e => { setAssignTarget(e.target.value); setAssignSuccess(null); setAssignError(null); }}
            className="flex-1 text-xs rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-text focus:outline-none focus:border-accent"
          >
            <option value="">— Elegir sección —</option>
            {Object.keys(sections).map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <button
            onClick={handleAssignSection}
            disabled={!assignTarget || assigningSection}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-accent text-white disabled:opacity-40 hover:bg-accent/80 transition-colors"
          >
            {assigningSection ? "…" : "Asignar"}
          </button>
        </div>
        {assignSuccess && (
          <p className="mt-2 text-[11px] text-success">{assignSuccess}</p>
        )}
        {assignError && (
          <p className="mt-2 text-[11px] text-danger">{assignError}</p>
        )}
      </div>
    </div>
  );
}
