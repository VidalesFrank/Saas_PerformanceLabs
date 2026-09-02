"use client";

import { useState, useCallback } from "react";
import type {
  WallAnalyticalModel,
  WallFormulation,
  WallValidationResult,
  AutoDiscretizeRequest,
  BoundaryZoneIn,
  WebZoneIn,
} from "@/lib/wall-types";
import {
  autoDiscretize,
  saveWallModel,
  validateWall,
  fetchOpsPreview,
  deleteWallAnalytical,
} from "@/lib/wall-api";
import WallFormulationSelector from "./WallFormulationSelector";
import MacrofiberPreview from "./MacrofiberPreview";
import MacrofiberDetailPanel from "./MacrofiberDetailPanel";

interface Props {
  projectId:  string;
  wallLabel:  string;
  wallShell:  Record<string, unknown>;
  initial?:   WallAnalyticalModel | null;
  materials:  string[];
  steelTypes: string[];
  onSaved?:   (model: WallAnalyticalModel) => void;
  onDeleted?: () => void;
}

type Tab = "formulation" | "discretization" | "parameters" | "validate" | "preview";

function wallLengthFromShell(shell: Record<string, unknown>): number {
  return (shell.length_m as number)
      ?? (shell.horizontal_length_m as number)
      ?? (shell.dimension_m as number)
      ?? 0;
}

export default function WallAnalyticalPanel({
  projectId, wallLabel, wallShell, initial,
  materials, steelTypes, onSaved, onDeleted,
}: Props) {
  const [tab, setTab]           = useState<Tab>("formulation");
  const [model, setModel]       = useState<WallAnalyticalModel | null>(initial ?? null);
  const [formulation, setFormulation] = useState<WallFormulation>(initial?.formulation ?? "E_SFI_MVLEM_3D");
  const [saving, setSaving]     = useState(false);
  const [selectedFiber, setSelectedFiber] = useState<number | null>(null);
  const [validation, setValidation] = useState<WallValidationResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [opsPreview, setOpsPreview] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [copied, setCopied]     = useState(false);

  const showSuccess = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(null), 2500);
  };

  const wallThickness = (wallShell.thickness_m as number) ?? 0.20;
  const wallLength    = wallLengthFromShell(wallShell);

  const [autoForm, setAutoForm] = useState<AutoDiscretizeRequest>({
    wall_length_m:    wallLength,
    wall_thickness_m: wallThickness,
    n_fibers:         8,
    formulation:      "E_SFI_MVLEM_3D",
    node_i: (wallShell.joints as string[])?.[0] ?? "",
    node_j: (wallShell.joints as string[])?.[1] ?? "",
    node_k: (wallShell.joints as string[])?.[2] ?? "",
    node_l: (wallShell.joints as string[])?.[3] ?? "",
    c_rot: 0.4, thick_mod: 0.63, poisson: 0.25, density_t_m3: 2.4,
    web: {
      thickness_m:    wallThickness,
      rho_vertical:   0.0035,
      rho_horizontal: 0.004,
      concrete_name:  materials[0] ?? "",
      steel_v_name:   steelTypes[0] ?? "",
      steel_h_name:   steelTypes[0] ?? "",
    },
  });

  const [hasBoundaries, setHasBoundaries] = useState(false);
  const [leftBoundary, setLeftBoundary] = useState<BoundaryZoneIn>({
    width_m: 0.3, rho_vertical: 0.022,
    concrete_name: materials[0] ?? "", steel_v_name: steelTypes[0] ?? "",
  });
  const [rightBoundary, setRightBoundary] = useState<BoundaryZoneIn>({
    width_m: 0.3, rho_vertical: 0.022,
    concrete_name: materials[0] ?? "", steel_v_name: steelTypes[0] ?? "",
  });

  const handleAutoDiscretize = useCallback(async () => {
    setSaving(true); setError(null);
    try {
      const result = await autoDiscretize(projectId, wallLabel, {
        ...autoForm, formulation,
        left_boundary:  hasBoundaries ? leftBoundary : undefined,
        right_boundary: hasBoundaries ? rightBoundary : undefined,
      });
      setModel(result);
      setTab("discretization");
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }, [autoForm, formulation, hasBoundaries, leftBoundary, rightBoundary, projectId, wallLabel]);

  const handleSave = useCallback(async () => {
    if (!model) return;
    setSaving(true); setError(null);
    try {
      const saved = await saveWallModel(projectId, wallLabel, { ...model, formulation });
      setModel(saved);
      onSaved?.(saved);
      showSuccess("Analytical model saved.");
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }, [model, formulation, projectId, wallLabel, onSaved]);

  const handleValidate = useCallback(async () => {
    setValidating(true); setValidation(null); setError(null);
    try {
      setValidation(await validateWall(projectId, wallLabel));
    } catch (err) {
      setError(String(err));
    } finally {
      setValidating(false);
    }
  }, [projectId, wallLabel]);

  const loadPreview = useCallback(async () => {
    if (opsPreview) return;
    setLoadingPreview(true); setError(null);
    try {
      const result = await fetchOpsPreview(projectId, wallLabel);
      setOpsPreview(result.preview);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoadingPreview(false);
    }
  }, [projectId, wallLabel, opsPreview]);

  const handleDelete = useCallback(async () => {
    if (!confirm("Remove analytical model for this wall?")) return;
    setError(null);
    try {
      await deleteWallAnalytical(projectId, wallLabel);
      setModel(null); onDeleted?.();
    } catch (err) {
      setError(String(err));
    }
  }, [projectId, wallLabel, onDeleted]);

  const handleCopy = useCallback(async () => {
    if (!opsPreview) return;
    await navigator.clipboard.writeText(opsPreview);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [opsPreview]);

  const handleDownload = useCallback(() => {
    if (!opsPreview) return;
    const blob = new Blob([opsPreview], { type: "text/plain" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url;
    a.download = `wall_${wallLabel.replace(/\W+/g, "_")}.py`;
    a.click();
    URL.revokeObjectURL(url);
  }, [opsPreview, wallLabel]);

  // Model status badge
  const modelStatus = !model ? "unsaved"
    : validation ? (validation.is_valid ? "valid" : "invalid")
    : "saved";

  const STATUS_BADGE: Record<string, string> = {
    unsaved: "text-[var(--text-muted)] border border-[var(--border)] bg-transparent",
    saved:   "text-amber-400 bg-amber-500/10",
    valid:   "text-emerald-400 bg-emerald-500/10",
    invalid: "text-red-400 bg-red-500/10",
  };
  const STATUS_TEXT: Record<string, string> = {
    unsaved: "Not saved",
    saved:   "Saved · not validated",
    valid:   "Valid",
    invalid: `Invalid · ${validation?.n_errors ?? 0} error(s)`,
  };

  const nErrors = validation ? validation.checks.filter((c) => !c.ok && !c.code.startsWith("WARN_")).length : 0;

  return (
    <div className="flex flex-col gap-0 h-full">
      {/* Header */}
      <div className="flex items-start justify-between px-4 pt-4 pb-2">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-bold text-[var(--text-primary)] text-sm">{wallLabel}</h3>
            <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${STATUS_BADGE[modelStatus]}`}>
              {STATUS_TEXT[modelStatus]}
            </span>
          </div>
          <p className="text-[11px] text-[var(--text-muted)]">
            {(wallShell.story as string) ?? ""}
            {(wallShell.section as string) ? ` · ${wallShell.section as string}` : ""}
            {wallThickness > 0 ? ` · t = ${(wallThickness * 100).toFixed(0)} cm` : ""}
            {wallLength > 0 ? ` · L = ${wallLength.toFixed(2)} m` : ""}
          </p>
        </div>
        {model && (
          <button onClick={handleDelete} className="text-xs text-red-400 hover:text-red-300 transition-colors shrink-0">
            Reset model
          </button>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="mx-4 mb-2 flex items-start gap-3 rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-3">
          <span className="text-red-400 shrink-0">✗</span>
          <p className="text-red-400 text-sm flex-1">{error}</p>
          <button onClick={() => setError(null)} className="text-red-400/60 hover:text-red-400 text-xs shrink-0">✕</button>
        </div>
      )}

      {/* Success banner */}
      {successMsg && (
        <div className="mx-4 mb-2 flex items-center gap-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-4 py-3">
          <span className="text-emerald-400 shrink-0">✓</span>
          <p className="text-emerald-400 text-sm">{successMsg}</p>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 px-4 pb-2 border-b border-[var(--border)] overflow-x-auto">
        {(["formulation", "discretization", "parameters", "validate", "preview"] as Tab[]).map((id) => {
          const labels: Record<Tab, string> = {
            formulation: "Formulation", discretization: "Discretization",
            parameters: "Parameters", validate: "Validate", preview: "OpenSeesPy",
          };
          return (
            <button
              key={id}
              onClick={() => {
                setTab(id);
                if (id === "preview" && !opsPreview && model) loadPreview();
              }}
              className={[
                "px-3 py-1.5 rounded text-xs font-medium transition-colors whitespace-nowrap flex items-center gap-1",
                tab === id ? "bg-[var(--primary)] text-white" : "text-[var(--text-muted)] hover:text-[var(--text-primary)]",
              ].join(" ")}
            >
              {labels[id]}
              {id === "validate" && nErrors > 0 && (
                <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[9px] text-white font-bold">
                  {nErrors}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5">

        {/* ── FORMULATION ─────────────────────────────────────────────────────── */}
        {tab === "formulation" && (
          <div className="space-y-5">
            <WallFormulationSelector
              value={formulation}
              onChange={(f) => {
                setFormulation(f);
                setAutoForm((p) => ({ ...p, formulation: f }));
                if (model) setModel({ ...model, formulation: f });
              }}
            />

            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Wall Length (m)"
                hint={wallLength > 0 ? `ETABS: ${wallLength.toFixed(3)} m` : "Enter manually"}
              >
                <input
                  type="number" step="0.01" min="0.01"
                  value={autoForm.wall_length_m}
                  onChange={(e) => setAutoForm({ ...autoForm, wall_length_m: parseFloat(e.target.value) || 0 })}
                  className="input-field w-full"
                />
              </Field>
              <Field
                label="Wall Thickness (m)"
                hint={wallThickness > 0 ? `ETABS: ${wallThickness.toFixed(3)} m` : undefined}
              >
                <input
                  type="number" step="0.005" min="0.05"
                  value={autoForm.wall_thickness_m}
                  onChange={(e) => setAutoForm({ ...autoForm, wall_thickness_m: parseFloat(e.target.value) || 0 })}
                  className="input-field w-full"
                />
              </Field>
              <Field label="Number of Fibers" hint="2 – 40">
                <input
                  type="number" step="1" min="2" max="40"
                  value={autoForm.n_fibers}
                  onChange={(e) => setAutoForm({ ...autoForm, n_fibers: parseInt(e.target.value) || 8 })}
                  className="input-field w-full"
                />
              </Field>
            </div>

            <SectionTitle>Web Zone</SectionTitle>
            <WebZoneForm value={autoForm.web} materials={materials} steelTypes={steelTypes}
              onChange={(web) => setAutoForm({ ...autoForm, web })} />

            <div className="flex items-center gap-3 pt-1">
              <input type="checkbox" id="has-boundaries" checked={hasBoundaries}
                onChange={(e) => setHasBoundaries(e.target.checked)}
                className="w-4 h-4 rounded accent-[var(--primary)]" />
              <label htmlFor="has-boundaries" className="text-sm text-[var(--text-primary)] cursor-pointer">
                Define Boundary Elements (confined zones at wall ends)
              </label>
            </div>

            {hasBoundaries && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5 pl-7">
                <div>
                  <SectionTitle>Left Boundary</SectionTitle>
                  <BoundaryZoneForm value={leftBoundary} materials={materials} steelTypes={steelTypes} onChange={setLeftBoundary} />
                </div>
                <div>
                  <SectionTitle>Right Boundary</SectionTitle>
                  <BoundaryZoneForm value={rightBoundary} materials={materials} steelTypes={steelTypes} onChange={setRightBoundary} />
                </div>
              </div>
            )}

            <button
              onClick={handleAutoDiscretize}
              disabled={saving || autoForm.wall_length_m <= 0}
              className="btn-primary w-full py-2.5 text-sm disabled:opacity-50"
            >
              {saving ? "Generating…" : "Generate Macrofiber Discretization"}
            </button>
            {autoForm.wall_length_m <= 0 && (
              <p className="text-xs text-amber-400 text-center -mt-3">
                Enter a wall length greater than 0 to proceed.
              </p>
            )}
          </div>
        )}

        {/* ── DISCRETIZATION ──────────────────────────────────────────────────── */}
        {tab === "discretization" && (
          <div className="space-y-5">
            {model ? (
              <>
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="text-sm text-[var(--text-muted)] space-x-3">
                    <span><strong className="text-[var(--text-primary)]">{model.n_fibers}</strong> fiber{model.n_fibers !== 1 ? "s" : ""}</span>
                    <span>·</span>
                    <span>Total: <strong className="text-[var(--text-primary)]">{model.total_width_m.toFixed(3)} m</strong></span>
                  </div>
                  <span className="text-[10px] px-2 py-1 rounded bg-[var(--primary)]/10 text-[var(--primary)] font-mono">
                    {model.formulation.replace(/_/g, "-")}
                  </span>
                </div>

                <MacrofiberPreview
                  fibers={model.macrofibers}
                  totalWidthM={model.total_width_m}
                  selectedIndex={selectedFiber}
                  onSelect={setSelectedFiber}
                />

                {selectedFiber !== null ? (
                  <MacrofiberDetailPanel
                    fiber={model.macrofibers.find((f) => f.index === selectedFiber)!}
                    formulation={model.formulation}
                  />
                ) : (
                  <p className="text-xs text-[var(--text-muted)] text-center py-1">
                    Click a fiber bar to inspect its properties
                  </p>
                )}

                <div className="flex gap-2 pt-2">
                  <button onClick={handleSave} disabled={saving} className="btn-primary flex-1 py-2.5 text-sm">
                    {saving ? "Saving…" : "Save Analytical Model"}
                  </button>
                  <button onClick={() => setTab("formulation")}
                    className="px-4 py-2.5 text-xs border border-[var(--border)] rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
                    Re-discretize
                  </button>
                </div>
              </>
            ) : (
              <div className="text-center py-12 space-y-3">
                <p className="text-sm text-[var(--text-secondary)]">No discretization generated yet.</p>
                <p className="text-xs text-[var(--text-muted)]">
                  Configure the formulation and zones, then click Generate.
                </p>
                <button onClick={() => setTab("formulation")} className="text-xs text-[var(--primary)] hover:underline">
                  Go to Formulation →
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── PARAMETERS ──────────────────────────────────────────────────────── */}
        {tab === "parameters" && (
          <div className="space-y-5">
            <SectionTitle>Center of Rotation</SectionTitle>
            <Field label="CoR" hint="Default: 0.40 — OpenSees recommended">
              <input type="number" step="0.01" min="0" max="1"
                value={model?.c_rot ?? autoForm.c_rot}
                onChange={(e) => { const v = parseFloat(e.target.value) || 0; setAutoForm({ ...autoForm, c_rot: v }); if (model) setModel({ ...model, c_rot: v }); }}
                className="input-field w-full" />
            </Field>
            <p className="text-xs text-[var(--text-muted)]">
              Normalized height (0–1) of the center of rotation within the element. 0.4 is validated against experimental tests.
            </p>

            <SectionTitle>Out-of-Plane Stiffness</SectionTitle>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Thickness Modifier" hint="Default: 0.63">
                <input type="number" step="0.01" min="0.1" max="1"
                  value={model?.thick_mod ?? autoForm.thick_mod}
                  onChange={(e) => { const v = parseFloat(e.target.value) || 0; setAutoForm({ ...autoForm, thick_mod: v }); if (model) setModel({ ...model, thick_mod: v }); }}
                  className="input-field w-full" />
              </Field>
              <Field label="Poisson Ratio" hint="Default: 0.25">
                <input type="number" step="0.01" min="0" max="0.49"
                  value={model?.poisson ?? autoForm.poisson}
                  onChange={(e) => { const v = parseFloat(e.target.value) || 0; setAutoForm({ ...autoForm, poisson: v }); if (model) setModel({ ...model, poisson: v }); }}
                  className="input-field w-full" />
              </Field>
            </div>

            <SectionTitle>Mass</SectionTitle>
            <Field label="Density (t/m³)" hint="Default: 2.4 — reinforced concrete">
              <input type="number" step="0.05" min="0.1"
                value={model?.density_t_m3 ?? autoForm.density_t_m3}
                onChange={(e) => { const v = parseFloat(e.target.value) || 2.4; setAutoForm({ ...autoForm, density_t_m3: v }); if (model) setModel({ ...model, density_t_m3: v }); }}
                className="input-field w-full" />
            </Field>

            {model && (
              <button onClick={handleSave} disabled={saving} className="btn-primary w-full py-2.5 text-sm mt-2">
                {saving ? "Saving…" : "Save Parameters"}
              </button>
            )}
          </div>
        )}

        {/* ── VALIDATE ────────────────────────────────────────────────────────── */}
        {tab === "validate" && (
          <div className="space-y-4">
            {!model ? (
              <div className="text-center py-12 space-y-2">
                <p className="text-sm text-[var(--text-secondary)]">No model to validate.</p>
                <p className="text-xs text-[var(--text-muted)]">Save a discretization first.</p>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <p className="text-xs text-[var(--text-muted)]">
                    Runs 23+ geometry, material, and reinforcement checks.
                  </p>
                  <button onClick={handleValidate} disabled={validating}
                    className="btn-primary text-xs px-4 py-1.5 shrink-0">
                    {validating ? "Validating…" : validation ? "Re-validate" : "Run Validation"}
                  </button>
                </div>

                {validating && (
                  <div className="flex items-center gap-2 py-6 justify-center">
                    <div className="w-4 h-4 border-2 border-[var(--primary)] border-t-transparent rounded-full animate-spin" />
                    <span className="text-sm text-[var(--text-muted)]">Running checks…</span>
                  </div>
                )}

                {validation && !validating && (
                  <>
                    <div className={[
                      "rounded-lg px-4 py-3 text-sm font-semibold flex items-center gap-3",
                      validation.is_valid ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400",
                    ].join(" ")}>
                      <span>{validation.is_valid ? "✓" : "✗"}</span>
                      <span>
                        {validation.is_valid
                          ? `All checks passed${validation.n_warnings > 0 ? ` · ${validation.n_warnings} warning(s)` : ""}`
                          : `${validation.n_errors} error(s) · ${validation.n_warnings} warning(s)`}
                      </span>
                    </div>

                    {/* Errors */}
                    {validation.checks.filter((c) => !c.ok && !c.code.startsWith("WARN_")).length > 0 && (
                      <div className="space-y-1">
                        <p className="text-[10px] uppercase tracking-wider text-red-400 font-semibold mb-1">Errors</p>
                        {validation.checks.filter((c) => !c.ok && !c.code.startsWith("WARN_")).map((c, i) => (
                          <CheckRow key={i} check={c} />
                        ))}
                      </div>
                    )}

                    {/* Warnings */}
                    {validation.checks.filter((c) => !c.ok && c.code.startsWith("WARN_")).length > 0 && (
                      <div className="space-y-1">
                        <p className="text-[10px] uppercase tracking-wider text-amber-400 font-semibold mb-1">Warnings</p>
                        {validation.checks.filter((c) => !c.ok && c.code.startsWith("WARN_")).map((c, i) => (
                          <CheckRow key={i} check={c} />
                        ))}
                      </div>
                    )}

                    {/* Passed summary */}
                    {validation.checks.filter((c) => c.ok).length > 0 && (
                      <p className="text-xs text-[var(--text-muted)] pt-1">
                        {validation.checks.filter((c) => c.ok).length} checks passed ✓
                      </p>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        )}

        {/* ── OPENSEESPY PREVIEW ──────────────────────────────────────────────── */}
        {tab === "preview" && (
          <div className="space-y-3">
            {!model ? (
              <div className="text-center py-12 space-y-2">
                <p className="text-sm text-[var(--text-secondary)]">No model to preview.</p>
                <p className="text-xs text-[var(--text-muted)]">Save an analytical model first.</p>
              </div>
            ) : loadingPreview ? (
              <div className="flex items-center gap-2 py-8 justify-center">
                <div className="w-4 h-4 border-2 border-[var(--primary)] border-t-transparent rounded-full animate-spin" />
                <span className="text-sm text-[var(--text-muted)]">Generating preview…</span>
              </div>
            ) : opsPreview ? (
              <>
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <p className="text-xs text-[var(--text-muted)]">
                    Identical to what the analysis engine produces — Preview = Real Model.
                  </p>
                  <div className="flex gap-2">
                    <button onClick={handleCopy}
                      className="text-xs px-3 py-1.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
                      {copied ? "Copied ✓" : "Copy"}
                    </button>
                    <button onClick={handleDownload}
                      className="text-xs px-3 py-1.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
                      Download .py
                    </button>
                    <button onClick={() => { setOpsPreview(null); loadPreview(); }}
                      className="text-xs px-3 py-1.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
                      Refresh
                    </button>
                  </div>
                </div>
                <pre className="rounded-lg bg-[var(--surface-2)] border border-[var(--border)] p-4 text-[11px] font-mono text-[var(--text-secondary)] overflow-x-auto whitespace-pre-wrap leading-relaxed">
                  {opsPreview}
                </pre>
              </>
            ) : (
              <div className="text-center py-10">
                <button onClick={loadPreview} className="btn-primary text-sm px-6 py-2.5">
                  Load OpenSeesPy Preview
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Validation check row ──────────────────────────────────────────────────────

function CheckRow({ check }: { check: { ok: boolean; code: string; message: string } }) {
  const isWarn = check.code.startsWith("WARN_");
  return (
    <div className={[
      "flex items-start gap-2 rounded px-3 py-2 text-xs",
      isWarn ? "bg-amber-500/10 text-amber-400" : "bg-red-500/10 text-red-400",
    ].join(" ")}>
      <span className="shrink-0 font-mono">{isWarn ? "⚠" : "✗"}</span>
      <span className="font-mono text-[10px] shrink-0 opacity-60 pt-0.5">{check.code}</span>
      <span>{check.message}</span>
    </div>
  );
}

// ── Small shared components ───────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">{children}</h4>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-[var(--text-secondary)]">{label}</label>
        {hint && <span className="text-[10px] text-[var(--text-muted)]">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function WebZoneForm({ value, materials, steelTypes, onChange }: {
  value: WebZoneIn; materials: string[]; steelTypes: string[];
  onChange: (v: WebZoneIn) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Thickness (m)">
        <input type="number" step="0.005" min="0.05" value={value.thickness_m}
          onChange={(e) => onChange({ ...value, thickness_m: parseFloat(e.target.value) || 0 })}
          className="input-field w-full" />
      </Field>
      <Field label="Concrete">
        <select value={value.concrete_name ?? ""}
          onChange={(e) => onChange({ ...value, concrete_name: e.target.value })}
          className="input-field w-full">
          {materials.map((m) => <option key={m}>{m}</option>)}
        </select>
      </Field>
      <Field label="ρᵥ — vertical ratio">
        <input type="number" step="0.0001" min="0" max="0.12" value={value.rho_vertical}
          onChange={(e) => onChange({ ...value, rho_vertical: parseFloat(e.target.value) || 0 })}
          className="input-field w-full" />
      </Field>
      <Field label="ρₕ — horizontal ratio">
        <input type="number" step="0.0001" min="0" max="0.12" value={value.rho_horizontal}
          onChange={(e) => onChange({ ...value, rho_horizontal: parseFloat(e.target.value) || 0 })}
          className="input-field w-full" />
      </Field>
      <Field label="Vertical Steel">
        <select value={value.steel_v_name ?? ""}
          onChange={(e) => onChange({ ...value, steel_v_name: e.target.value })}
          className="input-field w-full">
          {steelTypes.map((s) => <option key={s}>{s}</option>)}
        </select>
      </Field>
      <Field label="Horizontal Steel">
        <select value={value.steel_h_name ?? ""}
          onChange={(e) => onChange({ ...value, steel_h_name: e.target.value })}
          className="input-field w-full">
          {steelTypes.map((s) => <option key={s}>{s}</option>)}
        </select>
      </Field>
    </div>
  );
}

function BoundaryZoneForm({ value, materials, steelTypes, onChange }: {
  value: BoundaryZoneIn; materials: string[]; steelTypes: string[];
  onChange: (v: BoundaryZoneIn) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 mt-2">
      <Field label="Width (m)">
        <input type="number" step="0.01" min="0.05" value={value.width_m}
          onChange={(e) => onChange({ ...value, width_m: parseFloat(e.target.value) || 0 })}
          className="input-field w-full" />
      </Field>
      <Field label="ρᵥ — vertical ratio">
        <input type="number" step="0.001" min="0" max="0.12" value={value.rho_vertical}
          onChange={(e) => onChange({ ...value, rho_vertical: parseFloat(e.target.value) || 0 })}
          className="input-field w-full" />
      </Field>
      <Field label="Concrete">
        <select value={value.concrete_name ?? ""}
          onChange={(e) => onChange({ ...value, concrete_name: e.target.value })}
          className="input-field w-full">
          {materials.map((m) => <option key={m}>{m}</option>)}
        </select>
      </Field>
      <Field label="Vertical Steel">
        <select value={value.steel_v_name ?? ""}
          onChange={(e) => onChange({ ...value, steel_v_name: e.target.value })}
          className="input-field w-full">
          {steelTypes.map((s) => <option key={s}>{s}</option>)}
        </select>
      </Field>
    </div>
  );
}
