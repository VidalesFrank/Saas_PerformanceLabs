"use client";

import type {
  FullModelData,
  SectionData,
  AssignSectionResult,
  ShellSummary,
} from "@/lib/structural-types";
import { useState } from "react";
import { structuralEditorApi } from "@/lib/structural-api";

interface Props {
  projectId: string;
  selectedIds: Set<string>;
  modelData: FullModelData;
  onSectionAssigned: (result: AssignSectionResult) => void;
  onModelDataChange: () => void;
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between items-baseline py-1 border-b border-border/40 last:border-0">
      <span className="text-[11px] text-text-muted">{label}</span>
      <span className="text-[11px] font-mono text-text">{String(value)}</span>
    </div>
  );
}

function TypeBadge({ type }: { type: "column" | "beam" | "wall" | "slab" }) {
  const cfg = {
    column: { label: "Columna", color: "#818CF8" },
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

// ── Subpanel: Frame (columna o viga) ──────────────────────────────────────────

function FramePanel({
  projectId, singleId, selectedArr, modelData, onSectionAssigned,
}: {
  projectId: string;
  singleId: string | null;
  selectedArr: string[];
  modelData: FullModelData;
  onSectionAssigned: (r: AssignSectionResult) => void;
}) {
  const [assignTarget, setAssignTarget] = useState("");
  const [assigning, setAssigning] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [assignSuccess, setAssignSuccess] = useState<string | null>(null);

  const n = selectedArr.length;
  const frames = modelData.frames;
  const sections = modelData.sections;
  const materials = modelData.materials;

  const singleFrame = singleId ? frames[singleId] : null;
  const singleSection: SectionData | null = singleFrame ? (sections[singleFrame.section] ?? null) : null;
  const singleMaterial = singleSection ? (materials[singleSection.material] ?? null) : null;
  const commonSection = n > 1
    ? (selectedArr.every(id => frames[id]?.section === frames[selectedArr[0]]?.section)
      ? frames[selectedArr[0]]?.section
      : "(múltiples)")
    : undefined;

  async function handleAssign() {
    if (!assignTarget || selectedArr.length === 0) return;
    setAssigning(true); setAssignError(null); setAssignSuccess(null);
    try {
      const result = await structuralEditorApi.assignSection(projectId, selectedArr, assignTarget);
      onSectionAssigned(result);
      setAssignSuccess(`${result.n_updated} elemento(s) → ${assignTarget}`);
      setAssignTarget("");
    } catch (e) {
      setAssignError(e instanceof Error ? e.message : "Error al asignar");
    } finally {
      setAssigning(false);
    }
  }

  return (
    <>
      {/* Header */}
      <div className="px-4 py-3 border-b border-border bg-surface-2 flex-shrink-0">
        <div className="flex items-center gap-2">
          {n === 1 && singleFrame && (
            <TypeBadge type={singleFrame.element_type as "column" | "beam"} />
          )}
          <span className="text-sm font-semibold text-text truncate">
            {n === 1 ? (singleFrame?.object_label || singleId) : `${n} elementos`}
          </span>
        </div>
        {n === 1 && singleFrame && (
          <p className="text-[11px] text-text-muted mt-0.5">
            Piso: {singleFrame.story} · ID: {singleId}
          </p>
        )}
        {n > 1 && (
          <p className="text-[11px] text-text-muted mt-0.5">
            Sección: <span className="font-mono">{commonSection || "—"}</span>
          </p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-4">

        {/* Sección */}
        {n === 1 && singleFrame && (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-text-muted mb-2">Sección</p>
            {singleSection ? (
              <div className="rounded-lg border border-border bg-surface-2 px-3 py-2 space-y-0.5">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold text-text">{singleFrame.section}</span>
                  <span className="text-[10px] text-text-muted font-mono">{singleSection.shape}</span>
                </div>
                <Row label="h" value={`${(singleSection.h_m * 100).toFixed(0)} cm`} />
                <Row label="b" value={`${(singleSection.b_m * 100).toFixed(0)} cm`} />
                <Row label="A" value={`${(singleSection.A_m2 * 10000).toFixed(1)} cm²`} />
                <Row label="I₃₃" value={`${(singleSection.I33_m4 * 1e8).toFixed(1)} cm⁴`} />
                <Row label="I₂₂" value={`${(singleSection.I22_m4 * 1e8).toFixed(1)} cm⁴`} />
              </div>
            ) : (
              <div className="rounded-lg border border-danger/40 bg-danger/5 px-3 py-2">
                <p className="text-xs text-danger">Sin sección asignada</p>
              </div>
            )}
          </div>
        )}

        {/* Material */}
        {n === 1 && singleMaterial && (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-text-muted mb-2">Material</p>
            <div className="rounded-lg border border-border bg-surface-2 px-3 py-2 space-y-0.5">
              <div className="mb-1">
                <span className="text-xs font-semibold text-text">{singleSection?.material}</span>
                <span className="text-[10px] text-text-muted ml-2 capitalize">{singleMaterial.type}</span>
              </div>
              {singleMaterial.fpc_mpa > 0 && <Row label="f'c" value={`${singleMaterial.fpc_mpa} MPa`} />}
              {singleMaterial.fy_mpa && singleMaterial.fy_mpa > 0 && <Row label="fy" value={`${singleMaterial.fy_mpa} MPa`} />}
              <Row label="E" value={`${(singleMaterial.E_mpa / 1000).toFixed(1)} GPa`} />
            </div>
          </div>
        )}

        {/* Asignar sección */}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-text-muted mb-2">
            Asignar sección
          </p>
          <select
            value={assignTarget}
            onChange={e => setAssignTarget(e.target.value)}
            className="w-full text-[11px] rounded-md border border-border bg-surface-2 px-2 py-1.5 text-text focus:outline-none focus:border-accent mb-2"
          >
            <option value="">— elegir sección —</option>
            {Object.keys(modelData.sections).map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <button
            onClick={handleAssign}
            disabled={!assignTarget || assigning}
            className="w-full py-1.5 rounded-md text-[11px] font-medium bg-accent/15 border border-accent/40 text-accent hover:bg-accent/25 disabled:opacity-40 transition-colors"
          >
            {assigning ? "Asignando…" : `Asignar a ${n} elemento(s)`}
          </button>
          {assignError && <p className="mt-1 text-[10px] text-danger">{assignError}</p>}
          {assignSuccess && <p className="mt-1 text-[10px] text-success">{assignSuccess}</p>}
        </div>
      </div>
    </>
  );
}

// ── Subpanel: Shell (muro o losa) ─────────────────────────────────────────────

function ShellPanel({ singleId, shell, modelData }: {
  singleId: string;
  shell: ShellSummary;
  modelData: FullModelData;
}) {
  const section = modelData.sections[shell.section] ?? null;
  const material = section ? (modelData.materials[section.material] ?? null) : null;

  return (
    <>
      {/* Header */}
      <div className="px-4 py-3 border-b border-border bg-surface-2 flex-shrink-0">
        <div className="flex items-center gap-2">
          <TypeBadge type={shell.element_type as "wall" | "slab"} />
          <span className="text-sm font-semibold text-text truncate">{singleId}</span>
        </div>
        <p className="text-[11px] text-text-muted mt-0.5">
          Piso: {shell.story}
          {shell.pier && <> · Pier: <span className="font-mono">{shell.pier}</span></>}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-4">

        {/* Geometría */}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-text-muted mb-2">Geometría</p>
          <div className="rounded-lg border border-border bg-surface-2 px-3 py-2 space-y-0.5">
            <Row label="Tipo" value={shell.element_type === "wall" ? "Muro" : "Losa"} />
            <Row label="Espesor" value={`${(shell.thickness_m * 100).toFixed(1)} cm`} />
            <Row label="Nodos" value={shell.joints.length} />
            {shell.pier && <Row label="Pier" value={shell.pier} />}
          </div>
        </div>

        {/* Sección */}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-text-muted mb-2">Sección</p>
          <div className="rounded-lg border border-border bg-surface-2 px-3 py-2 space-y-0.5">
            <p className="text-xs font-semibold text-text mb-1">{shell.section || "—"}</p>
            {section ? (
              <>
                <Row label="h" value={`${(section.h_m * 100).toFixed(0)} cm`} />
                <Row label="b" value={`${(section.b_m * 100).toFixed(0)} cm`} />
              </>
            ) : (
              <p className="text-[11px] text-text-muted">Sin sección en biblioteca</p>
            )}
          </div>
        </div>

        {/* Material */}
        {material && (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-text-muted mb-2">Material</p>
            <div className="rounded-lg border border-border bg-surface-2 px-3 py-2 space-y-0.5">
              <div className="mb-1">
                <span className="text-xs font-semibold text-text">{section?.material}</span>
                <span className="text-[10px] text-text-muted ml-2 capitalize">{material.type}</span>
              </div>
              {material.fpc_mpa > 0 && <Row label="f'c" value={`${material.fpc_mpa} MPa`} />}
              <Row label="E" value={`${(material.E_mpa / 1000).toFixed(1)} GPa`} />
            </div>
          </div>
        )}

        {/* Nodos */}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-text-muted mb-2">
            Nodos ({shell.joints.length})
          </p>
          <div className="rounded-lg border border-border bg-surface-2 px-3 py-2">
            <div className="flex flex-wrap gap-1">
              {shell.joints.map(j => (
                <span key={j} className="text-[10px] font-mono bg-surface px-1.5 py-0.5 rounded border border-border/60 text-text-muted">
                  {j}
                </span>
              ))}
            </div>
          </div>
        </div>

      </div>
    </>
  );
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function ModelPropertiesPanel({
  projectId, selectedIds, modelData, onSectionAssigned,
}: Props) {
  const selectedArr = [...selectedIds];
  const n = selectedArr.length;

  if (n === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-text-muted px-4 text-center">
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none" className="opacity-30">
          <rect x="4" y="4" width="32" height="32" rx="4" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 3"/>
          <circle cx="20" cy="20" r="4" stroke="currentColor" strokeWidth="1.5"/>
        </svg>
        <p className="text-xs leading-relaxed">Haz clic en un elemento del modelo para inspeccionar sus propiedades.</p>
        <p className="text-[11px] opacity-60">Ctrl+Clic para selección múltiple</p>
      </div>
    );
  }

  const singleId = n === 1 ? selectedArr[0] : null;

  // Detectar tipo: ¿frame o shell?
  const singleShell = singleId ? (modelData.shells?.[singleId] ?? null) : null;
  const isShell = !!singleShell;
  const isFrame = singleId ? !!modelData.frames[singleId] : false;

  // Selección múltiple sin tipo claro
  if (n > 1) {
    const allFrames = selectedArr.every(id => !!modelData.frames[id]);
    if (allFrames) {
      return (
        <div className="flex flex-col h-full overflow-hidden">
          <FramePanel
            projectId={projectId}
            singleId={null}
            selectedArr={selectedArr}
            modelData={modelData}
            onSectionAssigned={onSectionAssigned}
          />
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-text-muted px-4 text-center">
        <p className="text-xs">{n} elementos seleccionados</p>
        <p className="text-[11px] opacity-60">Selección mixta (frames + shells)</p>
      </div>
    );
  }

  // 1 elemento seleccionado
  if (isShell && singleShell && singleId) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <ShellPanel singleId={singleId} shell={singleShell} modelData={modelData} />
      </div>
    );
  }

  if (isFrame && singleId) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <FramePanel
          projectId={projectId}
          singleId={singleId}
          selectedArr={selectedArr}
          modelData={modelData}
          onSectionAssigned={onSectionAssigned}
        />
      </div>
    );
  }

  // id desconocido (no en frames ni shells)
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2 text-text-muted px-4 text-center">
      <p className="text-xs font-mono">{singleId}</p>
      <p className="text-[11px] opacity-60">Elemento no encontrado en el modelo</p>
    </div>
  );
}
