"use client";

import { useState } from "react";
import type { FullModelData, MaterialData } from "@/lib/structural-types";
import { structuralEditorApi } from "@/lib/structural-api";

// ── Curva constitutiva SVG ────────────────────────────────────────────────────

function ConstitutiveCurve({ mat }: { mat: MaterialData }) {
  const W = 240, H = 140;
  const PAD = { t: 14, r: 12, b: 28, l: 38 };
  const cW = W - PAD.l - PAD.r;
  const cH = H - PAD.t - PAD.b;

  const sx = (v: number, max: number) => PAD.l + (v / max) * cW;
  const sy = (v: number, max: number) => PAD.t + cH - (v / max) * cH;

  if (mat.type === "concrete") {
    const fpc = mat.fpc_mpa;
    const Ec  = mat.E_mpa > 0 ? mat.E_mpa : 4700 * Math.sqrt(fpc);
    const e0  = (2 * fpc) / Ec;           // deformación en pico ≈ 0.002
    const eCu = 0.003;
    const maxE = eCu * 1.15, maxF = fpc * 1.15;

    const pts: string[] = [];
    for (let i = 0; i <= 60; i++) {
      const e = (i / 60) * maxE;
      let fc: number;
      if (e <= e0) {
        const x = e / e0;
        fc = fpc * (2 * x - x * x);
      } else {
        fc = fpc * Math.max(0, 1 - ((e - e0) / (eCu - e0)) * 0.8);
      }
      pts.push(`${sx(e, maxE).toFixed(1)},${sy(fc, maxF).toFixed(1)}`);
    }

    return (
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="w-full text-[var(--text-muted)]">
        {/* Área bajo la curva */}
        <polygon
          points={`${PAD.l},${PAD.t + cH} ${pts.join(" ")} ${sx(maxE, maxE)},${PAD.t + cH}`}
          fill="#818CF8" fillOpacity="0.08"
        />
        {/* Curva */}
        <polyline points={pts.join(" ")} fill="none" stroke="#818CF8" strokeWidth="2" strokeLinejoin="round" />
        {/* Marker pico */}
        <circle cx={sx(e0, maxE)} cy={sy(fpc, maxF)} r="3" fill="#818CF8" />
        {/* Línea puntada εcu */}
        <line x1={sx(eCu, maxE)} y1={PAD.t} x2={sx(eCu, maxE)} y2={PAD.t + cH}
          stroke="#818CF8" strokeWidth="1" strokeDasharray="3 2" opacity="0.4" />
        {/* Ejes */}
        <line x1={PAD.l} y1={PAD.t} x2={PAD.l} y2={PAD.t + cH} stroke="currentColor" strokeWidth="1" opacity="0.25" />
        <line x1={PAD.l} y1={PAD.t + cH} x2={PAD.l + cW} y2={PAD.t + cH} stroke="currentColor" strokeWidth="1" opacity="0.25" />
        {/* Etiquetas eje Y */}
        <text x={PAD.l - 4} y={sy(fpc, maxF) + 3} textAnchor="end" fontSize="8" fill="#818CF8">{fpc}</text>
        <text x={PAD.l - 4} y={PAD.t + cH + 2} textAnchor="end" fontSize="8" fill="currentColor" opacity="0.4">0</text>
        {/* Etiquetas eje X */}
        <text x={sx(e0, maxE)} y={PAD.t + cH + 10} textAnchor="middle" fontSize="7" fill="currentColor" opacity="0.5">{e0.toFixed(4)}</text>
        <text x={sx(eCu, maxE)} y={PAD.t + cH + 10} textAnchor="middle" fontSize="7" fill="#818CF8" opacity="0.7">{eCu.toFixed(3)}</text>
        {/* Títulos */}
        <text x={PAD.l + cW / 2} y={H - 2} textAnchor="middle" fontSize="8" fill="currentColor" opacity="0.4">ε (adimensional)</text>
        <text x={8} y={PAD.t + cH / 2} textAnchor="middle" fontSize="8" fill="currentColor" opacity="0.4"
          transform={`rotate(-90 8 ${PAD.t + cH / 2})`}>fc (MPa)</text>
        {/* Leyenda */}
        <text x={PAD.l + cW} y={PAD.t + 8} textAnchor="end" fontSize="8" fill="#818CF8" fontWeight="600">f&apos;c = {fpc} MPa</text>
        <text x={PAD.l + cW} y={PAD.t + 18} textAnchor="end" fontSize="7" fill="currentColor" opacity="0.5">Ec = {(Ec / 1000).toFixed(1)} GPa</text>
      </svg>
    );
  } else {
    // Acero — bilineal
    const fy = mat.fy_mpa ?? 420;
    const E  = mat.E_mpa > 0 ? mat.E_mpa : 200000;
    const ey = fy / E;
    const eu = 0.05;
    const maxE = eu * 1.05, maxF = fy * 1.15;

    const pts = [
      `${sx(0, maxE).toFixed(1)},${sy(0, maxF).toFixed(1)}`,
      `${sx(ey, maxE).toFixed(1)},${sy(fy, maxF).toFixed(1)}`,
      `${sx(eu, maxE).toFixed(1)},${sy(fy, maxF).toFixed(1)}`,
    ].join(" ");

    return (
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="w-full text-[var(--text-muted)]">
        <polygon
          points={`${PAD.l},${PAD.t + cH} ${pts} ${sx(eu, maxE)},${PAD.t + cH}`}
          fill="#F59E0B" fillOpacity="0.08"
        />
        <polyline points={pts} fill="none" stroke="#F59E0B" strokeWidth="2" strokeLinejoin="round" />
        <circle cx={sx(ey, maxE)} cy={sy(fy, maxF)} r="3" fill="#F59E0B" />
        <line x1={PAD.l} y1={PAD.t} x2={PAD.l} y2={PAD.t + cH} stroke="currentColor" strokeWidth="1" opacity="0.25" />
        <line x1={PAD.l} y1={PAD.t + cH} x2={PAD.l + cW} y2={PAD.t + cH} stroke="currentColor" strokeWidth="1" opacity="0.25" />
        <text x={PAD.l - 4} y={sy(fy, maxF) + 3} textAnchor="end" fontSize="8" fill="#F59E0B">{fy}</text>
        <text x={PAD.l - 4} y={PAD.t + cH + 2} textAnchor="end" fontSize="8" fill="currentColor" opacity="0.4">0</text>
        <text x={sx(ey, maxE)} y={PAD.t + cH + 10} textAnchor="middle" fontSize="7" fill="currentColor" opacity="0.5">{ey.toFixed(4)}</text>
        <text x={PAD.l + cW / 2} y={H - 2} textAnchor="middle" fontSize="8" fill="currentColor" opacity="0.4">ε (adimensional)</text>
        <text x={8} y={PAD.t + cH / 2} textAnchor="middle" fontSize="8" fill="currentColor" opacity="0.4"
          transform={`rotate(-90 8 ${PAD.t + cH / 2})`}>σ (MPa)</text>
        <text x={PAD.l + cW} y={PAD.t + 8} textAnchor="end" fontSize="8" fill="#F59E0B" fontWeight="600">fy = {fy} MPa</text>
        <text x={PAD.l + cW} y={PAD.t + 18} textAnchor="end" fontSize="7" fill="currentColor" opacity="0.5">E = {(E / 1000).toFixed(0)} GPa</text>
      </svg>
    );
  }
}

interface Props {
  projectId: string;
  modelData: FullModelData;
  onModelDataChange: () => void;
}

interface MatForm {
  name: string;
  type: "concrete" | "steel";
  fpc_mpa: string;
  fy_mpa: string;
  E_mpa: string;
}

const DEFAULT_FORM: MatForm = { name: "", type: "concrete", fpc_mpa: "", fy_mpa: "", E_mpa: "" };

function usedBySections(matName: string, sections: FullModelData["sections"]): string[] {
  return Object.entries(sections)
    .filter(([, s]) => s.material === matName)
    .map(([name]) => name);
}

export default function ModelMaterialsPanel({ projectId, modelData, onModelDataChange }: Props) {
  const [mode, setMode] = useState<"list" | "create" | "edit">("list");
  const [editingName, setEditingName] = useState<string | null>(null);
  const [form, setForm] = useState<MatForm>(DEFAULT_FORM);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [selectedMatName, setSelectedMatName] = useState<string | null>(null);

  const { materials, sections } = modelData;

  function startCreate() {
    setForm(DEFAULT_FORM);
    setEditingName(null);
    setMode("create");
    setError(null); setSuccess(null);
  }

  function startEdit(name: string, mat: MaterialData) {
    setForm({
      name,
      type: mat.type,
      fpc_mpa: mat.fpc_mpa > 0 ? String(mat.fpc_mpa) : "",
      fy_mpa: mat.fy_mpa ? String(mat.fy_mpa) : "",
      E_mpa: mat.E_mpa > 0 ? String(mat.E_mpa) : "",
    });
    setEditingName(name);
    setMode("edit");
    setError(null); setSuccess(null);
  }

  function cancel() {
    setMode("list");
    setForm(DEFAULT_FORM);
    setEditingName(null);
    setError(null); setSuccess(null);
  }

  function buildPayload() {
    return {
      type: form.type,
      fpc_mpa: form.type === "concrete" ? parseFloat(form.fpc_mpa || "0") : 0,
      fy_mpa:  form.type === "steel"    ? parseFloat(form.fy_mpa  || "0") : 0,
      E_mpa:   form.E_mpa ? parseFloat(form.E_mpa) : 0,
      G_mpa:   0,
      nu:      0.2,
    };
  }

  async function handleSave() {
    if (mode === "create" && !form.name.trim()) {
      setError("El nombre es obligatorio."); return;
    }
    if (form.type === "concrete" && (!form.fpc_mpa || parseFloat(form.fpc_mpa) <= 0)) {
      setError("Ingresa un valor válido de f'c (MPa)."); return;
    }
    if (form.type === "steel" && (!form.fy_mpa || parseFloat(form.fy_mpa) <= 0)) {
      setError("Ingresa un valor válido de fy (MPa)."); return;
    }

    setSaving(true); setError(null);
    try {
      if (mode === "create") {
        await structuralEditorApi.createMaterial(projectId, form.name.trim(), buildPayload());
        setSuccess(`Material '${form.name}' creado.`);
      } else if (editingName) {
        await structuralEditorApi.updateMaterial(projectId, editingName, buildPayload());
        setSuccess(`Material '${editingName}' actualizado.`);
      }
      onModelDataChange();
      setMode("list");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al guardar");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(name: string) {
    const usedBy = usedBySections(name, sections);
    if (usedBy.length > 0) {
      alert(`No se puede eliminar: lo usan las secciones ${usedBy.slice(0, 3).join(", ")}${usedBy.length > 3 ? "…" : ""}. Reasigna primero.`);
      return;
    }
    if (!window.confirm(`¿Eliminar el material '${name}'?`)) return;
    setDeleting(name);
    try {
      await structuralEditorApi.deleteMaterial(projectId, name);
      onModelDataChange();
      setSuccess(`Material '${name}' eliminado.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al eliminar");
    } finally {
      setDeleting(null);
    }
  }

  // ── Lista ──────────────────────────────────────────────────────────────────
  if (mode === "list") {
    const selectedMat = selectedMatName ? materials[selectedMatName] : null;
    const isConcreteSel = selectedMat?.type === "concrete";

    return (
      <div className="flex flex-col h-full">
        <div className="px-4 py-3 border-b border-border bg-surface-2 flex-shrink-0 flex items-center justify-between">
          <span className="text-xs font-semibold text-text">
            Materiales <span className="text-text-muted font-normal">({Object.keys(materials).length})</span>
          </span>
          <button
            onClick={startCreate}
            className="text-[11px] px-2.5 py-1 rounded-lg bg-accent text-white hover:bg-accent/80 transition-colors font-medium"
          >
            + Nuevo
          </button>
        </div>

        {success && (
          <div className="mx-4 mt-2 px-3 py-1.5 rounded-lg bg-success/10 border border-success/30">
            <p className="text-[11px] text-success">{success}</p>
          </div>
        )}
        {error && (
          <div className="mx-4 mt-2 px-3 py-1.5 rounded-lg bg-danger/10 border border-danger/30">
            <p className="text-[11px] text-danger">{error}</p>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {Object.keys(materials).length === 0 && (
            <div className="px-4 py-8 text-center">
              <p className="text-xs text-text-muted">No hay materiales definidos.</p>
            </div>
          )}
          {Object.entries(materials).map(([name, mat]) => {
            const usedBy = usedBySections(name, sections);
            const isConcrete = mat.type === "concrete";
            const isSelected = selectedMatName === name;
            return (
              <div key={name}>
                <div
                  onClick={() => setSelectedMatName(isSelected ? null : name)}
                  className={[
                    "flex items-center justify-between px-4 py-2.5 border-b border-border/40 transition-colors cursor-pointer group",
                    isSelected ? "bg-surface-2" : "hover:bg-surface-2/60",
                  ].join(" ")}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                        style={{ background: isConcrete ? "#818CF8" : "#F59E0B" }}
                      />
                      <span className="text-xs font-semibold text-text truncate">{name}</span>
                      <span
                        className="text-[10px] rounded-full px-1.5 py-px font-medium"
                        style={{
                          background: isConcrete ? "#6366F122" : "#F59E0B22",
                          color: isConcrete ? "#818CF8" : "#F59E0B",
                        }}
                      >
                        {isConcrete ? "Concreto" : "Acero"}
                      </span>
                    </div>
                    <p className="text-[10px] text-text-muted">
                      {isConcrete
                        ? `f'c = ${mat.fpc_mpa} MPa · E = ${(mat.E_mpa / 1000).toFixed(1)} GPa`
                        : `fy = ${mat.fy_mpa ?? "—"} MPa · E = ${(mat.E_mpa / 1000).toFixed(0)} GPa`}
                      {usedBy.length > 0 && <span className="ml-1 text-accent">{usedBy.length} secc.</span>}
                    </p>
                  </div>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => { e.stopPropagation(); startEdit(name, mat); }}
                      className="text-[10px] px-2 py-0.5 rounded border border-border text-text-muted hover:text-text hover:border-accent transition-colors"
                    >
                      Editar
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(name); }}
                      disabled={deleting === name || usedBy.length > 0}
                      title={usedBy.length > 0 ? "Reasigna las secciones primero" : undefined}
                      className="text-[10px] px-2 py-0.5 rounded border border-danger/40 text-danger hover:bg-danger/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      {deleting === name ? "…" : "×"}
                    </button>
                  </div>
                </div>

                {/* Curva constitutiva expandida */}
                {isSelected && (
                  <div className="border-b border-border/40 bg-surface-2/50 px-4 py-3">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-text-muted mb-2">
                      Modelo constitutivo — {isConcrete ? "Mander (parabólico)" : "Bilineal elástico-perfecto"}
                    </p>
                    <ConstitutiveCurve mat={mat} />
                    <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px] text-text-muted">
                      {isConcrete ? (
                        <>
                          <span>f&apos;c = <strong className="text-text">{mat.fpc_mpa} MPa</strong></span>
                          <span>Ec = <strong className="text-text">{(mat.E_mpa / 1000).toFixed(1)} GPa</strong></span>
                          <span>ε₀ ≈ <strong className="text-text">{((2 * mat.fpc_mpa) / mat.E_mpa).toFixed(4)}</strong></span>
                          <span>εcu = <strong className="text-text">0.003</strong></span>
                        </>
                      ) : (
                        <>
                          <span>fy = <strong className="text-text">{mat.fy_mpa ?? 420} MPa</strong></span>
                          <span>E = <strong className="text-text">{(mat.E_mpa / 1000).toFixed(0)} GPa</strong></span>
                          <span>εy = <strong className="text-text">{((mat.fy_mpa ?? 420) / mat.E_mpa).toFixed(4)}</strong></span>
                          <span>εu = <strong className="text-text">0.05</strong></span>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {Object.keys(materials).length > 0 && !selectedMatName && (
          <p className="px-4 py-2 text-[10px] text-text-muted border-t border-border/30 flex-shrink-0">
            Haz clic en un material para ver su modelo constitutivo
          </p>
        )}
      </div>
    );
  }

  // ── Formulario crear/editar ────────────────────────────────────────────────
  const isConcrete = form.type === "concrete";
  const previewE = isConcrete && form.fpc_mpa && parseFloat(form.fpc_mpa) > 0
    ? (4700 * Math.sqrt(parseFloat(form.fpc_mpa))).toFixed(0)
    : form.E_mpa || "—";

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border bg-surface-2 flex-shrink-0">
        <p className="text-xs font-semibold text-text">
          {mode === "create" ? "Nuevo material" : `Editar: ${editingName}`}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3">
        {mode === "create" && (
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-widest text-text-muted block mb-1">Nombre *</label>
            <input
              type="text" placeholder="ej. Concreto 28 MPa"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              className="w-full text-xs rounded-lg border border-border bg-surface px-2.5 py-1.5 text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
            />
          </div>
        )}

        <div>
          <label className="text-[10px] font-semibold uppercase tracking-widest text-text-muted block mb-1">Tipo *</label>
          <div className="flex gap-2">
            {(["concrete", "steel"] as const).map(t => (
              <button
                key={t}
                onClick={() => setForm(f => ({ ...f, type: t }))}
                className={[
                  "flex-1 py-1.5 text-xs font-medium rounded-lg border transition-colors",
                  form.type === t
                    ? "bg-accent text-white border-accent"
                    : "border-border text-text-muted hover:border-accent hover:text-text",
                ].join(" ")}
              >
                {t === "concrete" ? "Concreto" : "Acero"}
              </button>
            ))}
          </div>
        </div>

        {isConcrete ? (
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-widest text-text-muted block mb-1">
              f'c (MPa) *
            </label>
            <input
              type="number" min="1" step="1" placeholder="28"
              value={form.fpc_mpa}
              onChange={e => setForm(f => ({ ...f, fpc_mpa: e.target.value }))}
              className="w-full text-xs rounded-lg border border-border bg-surface px-2.5 py-1.5 text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
            />
            <p className="text-[10px] text-text-muted mt-1">
              E calculado automáticamente: Ec = 4700√f'c = {previewE} MPa
            </p>
          </div>
        ) : (
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-widest text-text-muted block mb-1">
              fy (MPa) *
            </label>
            <input
              type="number" min="1" step="10" placeholder="420"
              value={form.fy_mpa}
              onChange={e => setForm(f => ({ ...f, fy_mpa: e.target.value }))}
              className="w-full text-xs rounded-lg border border-border bg-surface px-2.5 py-1.5 text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
            />
            <p className="text-[10px] text-text-muted mt-1">
              E acero estructural = 200,000 MPa (calculado automáticamente si no se especifica)
            </p>
          </div>
        )}

        {error && <p className="text-[11px] text-danger px-1">{error}</p>}
      </div>

      <div className="px-4 py-3 border-t border-border flex gap-2 flex-shrink-0">
        <button
          onClick={cancel}
          className="flex-1 py-1.5 text-xs font-medium rounded-lg border border-border text-text-muted hover:text-text hover:border-text-muted transition-colors"
        >
          Cancelar
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex-1 py-1.5 text-xs font-medium rounded-lg bg-accent text-white hover:bg-accent/80 transition-colors disabled:opacity-40"
        >
          {saving ? "Guardando…" : mode === "create" ? "Crear" : "Guardar"}
        </button>
      </div>
    </div>
  );
}
