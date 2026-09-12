"use client";

/**
 * VariantEditor — Editor de override de refuerzo para un pier específico.
 *
 * Recibe el diseño baseline del pier + variante activa (si existe) y permite
 * modificar el armado propuesto. Muestra el impacto teórico estimado en la
 * capacidad (φMn, φVn) para retroalimentación inmediata sin re-análisis.
 */
import { useEffect, useMemo, useState } from "react";
import { structuralAnalysisApi } from "@/lib/structural-api";
import type { DesignVariant, DesignVariantOverride, WallDesignRow } from "@/lib/structural-types";

interface Props {
  projectId:     string;
  pier:          string;
  story:         string;
  baseline:      WallDesignRow;
  variant:       DesignVariant | null;
  onVariantUpdated: (v: DesignVariant) => void;
  onRequestCreate:  () => void;    // pide crear una variante nueva si no hay activa
}

const BAR_DIAMETERS = [9.5, 12.7, 15.9, 19.1, 22.2, 25.4, 32.3, 35.8];
const BAR_LABEL: Record<number, string> = {
  9.5: "#3", 12.7: "#4", 15.9: "#5", 19.1: "#6",
  22.2: "#7", 25.4: "#8", 32.3: "#10", 35.8: "#11",
};

export default function VariantEditor({
  projectId, pier, story, baseline, variant, onVariantUpdated, onRequestCreate,
}: Props) {
  const overrideKey = `${pier}|${story}`;
  const currentOv = (variant?.overrides?.[overrideKey] ?? {}) as DesignVariantOverride;

  // Estado local editable
  const [nBars, setNBars] = useState<number>(currentOv.be_n_bars ?? baseline.be_n_bars);
  const [dbMm,  setDbMm]  = useState<number>(currentOv.be_db_mm  ?? baseline.be_db_mm);
  const [rhoV,  setRhoV]  = useState<number>(currentOv.rho_v_pct ?? baseline.rho_v_pct);
  const [rhoH,  setRhoH]  = useState<number>(currentOv.rho_h_pct ?? baseline.rho_h_pct);
  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState<string | null>(null);

  // Reset al cambiar de pier / variante
  useEffect(() => {
    setNBars(currentOv.be_n_bars ?? baseline.be_n_bars);
    setDbMm (currentOv.be_db_mm  ?? baseline.be_db_mm);
    setRhoV (currentOv.rho_v_pct ?? baseline.rho_v_pct);
    setRhoH (currentOv.rho_h_pct ?? baseline.rho_h_pct);
    setErr(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pier, story, variant?.variant_id]);

  // Preview del delta de capacidad (aproximaciones frontend)
  const delta = useMemo(() => {
    const as0 = baseline.be_n_bars * Math.PI * (baseline.be_db_mm / 2) ** 2;
    const as1 = nBars * Math.PI * (dbMm / 2) ** 2;
    const dMn = as0 > 0 ? (Math.pow(as1 / as0, 0.85) - 1) * 100 : 0;
    const dVn = baseline.rho_h_pct > 0 ? (rhoH / baseline.rho_h_pct - 1) * 100 : 0;
    return { dMn, dVn };
  }, [nBars, dbMm, rhoH, baseline]);

  const hasChanges =
    nBars !== baseline.be_n_bars ||
    Math.abs(dbMm - baseline.be_db_mm) > 0.01 ||
    Math.abs(rhoV - baseline.rho_v_pct) > 0.001 ||
    Math.abs(rhoH - baseline.rho_h_pct) > 0.001;

  async function handleSave() {
    if (!variant) { onRequestCreate(); return; }
    setSaving(true); setErr(null);
    try {
      const payload: DesignVariantOverride = {
        be_n_bars: nBars,
        be_db_mm:  dbMm,
        rho_v_pct: rhoV,
        rho_h_pct: rhoH,
      };
      const updated = await structuralAnalysisApi.updateDesignVariant(
        projectId, variant.variant_id,
        { overrides: { [overrideKey]: payload } },
      );
      onVariantUpdated(updated);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error al guardar");
    } finally {
      setSaving(false);
    }
  }

  async function handleRemoveOverride() {
    if (!variant) return;
    setSaving(true); setErr(null);
    try {
      const updated = await structuralAnalysisApi.updateDesignVariant(
        projectId, variant.variant_id,
        { overrides: { [overrideKey]: null } },
      );
      onVariantUpdated(updated);
      setNBars(baseline.be_n_bars); setDbMm(baseline.be_db_mm);
      setRhoV(baseline.rho_v_pct);  setRhoH(baseline.rho_h_pct);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error al eliminar override");
    } finally {
      setSaving(false);
    }
  }

  const deltaColor = (d: number) =>
    d > 5 ? "#22c55e" : d < -5 ? "#ef4444" : "var(--text-muted)";

  const hasOverride = !!currentOv.be_n_bars;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--border)] bg-[var(--surface-2)] flex items-center gap-3 flex-wrap">
        <span className="text-xs font-semibold text-[var(--text)] uppercase tracking-wider">
          Propuesta de Rediseño — <span className="font-mono">{pier}</span> · {story}
        </span>
        {variant && (
          <span className="text-[11px] text-[var(--text-muted)]">
            Variante: <span className="font-mono font-medium text-[var(--text)]">{variant.name}</span>
          </span>
        )}
        {hasOverride && (
          <span className="ml-2 px-2 py-0.5 rounded text-[10px] font-bold bg-purple-100 text-purple-700">
            Con override activo
          </span>
        )}
      </div>

      <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Refuerzo EBE */}
        <div className="space-y-3">
          <p className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
            Elemento de borde (EBE)
          </p>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-[var(--text-muted)] flex justify-between">
              Nº barras <span className="text-[10px] text-[var(--text-muted)]">baseline: {baseline.be_n_bars}</span>
            </span>
            <input
              type="number" min={2} max={20} value={nBars}
              onChange={(e) => setNBars(Math.max(2, Number(e.target.value)))}
              className="w-full px-3 py-1.5 rounded border border-[var(--border)] bg-[var(--surface)] text-sm text-[var(--text)] font-mono"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-[var(--text-muted)] flex justify-between">
              Diámetro <span className="text-[10px] text-[var(--text-muted)]">baseline: {baseline.be_db_mm} mm</span>
            </span>
            <select
              value={dbMm}
              onChange={(e) => setDbMm(Number(e.target.value))}
              className="w-full px-3 py-1.5 rounded border border-[var(--border)] bg-[var(--surface)] text-sm text-[var(--text)] font-mono"
            >
              {BAR_DIAMETERS.map((d) => (
                <option key={d} value={d}>{BAR_LABEL[d] ?? d} · {d} mm</option>
              ))}
            </select>
          </label>
        </div>

        {/* Cuantías alma */}
        <div className="space-y-3">
          <p className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
            Cuantías de alma
          </p>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-[var(--text-muted)] flex justify-between">
              ρ vertical (%) <span className="text-[10px] text-[var(--text-muted)]">baseline: {baseline.rho_v_pct.toFixed(3)}%</span>
            </span>
            <input
              type="number" step={0.05} min={0.25} max={4.0} value={rhoV}
              onChange={(e) => setRhoV(Number(e.target.value))}
              className="w-full px-3 py-1.5 rounded border border-[var(--border)] bg-[var(--surface)] text-sm text-[var(--text)] font-mono"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-[var(--text-muted)] flex justify-between">
              ρ horizontal (%) <span className="text-[10px] text-[var(--text-muted)]">baseline: {baseline.rho_h_pct.toFixed(3)}%</span>
            </span>
            <input
              type="number" step={0.05} min={0.25} max={4.0} value={rhoH}
              onChange={(e) => setRhoH(Number(e.target.value))}
              className="w-full px-3 py-1.5 rounded border border-[var(--border)] bg-[var(--surface)] text-sm text-[var(--text)] font-mono"
            />
          </label>
        </div>
      </div>

      {/* Preview del impacto */}
      <div className="px-4 pb-3 grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-[var(--border)] px-3 py-2">
          <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Δ φMn estimado</p>
          <p className="text-lg font-bold font-mono" style={{ color: deltaColor(delta.dMn) }}>
            {delta.dMn >= 0 ? "+" : ""}{delta.dMn.toFixed(1)}%
          </p>
        </div>
        <div className="rounded-lg border border-[var(--border)] px-3 py-2">
          <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Δ φVn estimado</p>
          <p className="text-lg font-bold font-mono" style={{ color: deltaColor(delta.dVn) }}>
            {delta.dVn >= 0 ? "+" : ""}{delta.dVn.toFixed(1)}%
          </p>
        </div>
      </div>

      {err && <p className="px-4 pb-2 text-xs text-red-600">{err}</p>}

      <div className="px-4 py-3 border-t border-[var(--border)] bg-[var(--surface-2)] flex items-center gap-2 flex-wrap">
        {!variant && (
          <button
            onClick={onRequestCreate}
            className="px-3 py-1.5 rounded text-[11px] font-medium bg-[var(--accent)] text-white hover:opacity-90"
          >
            Crear variante para guardar
          </button>
        )}
        {variant && hasChanges && (
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-1.5 rounded text-[11px] font-medium bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Guardando..." : "Guardar en variante"}
          </button>
        )}
        {variant && hasOverride && (
          <button
            onClick={handleRemoveOverride}
            disabled={saving}
            className="px-3 py-1.5 rounded text-[11px] font-medium bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)] border border-[var(--border)] disabled:opacity-50"
          >
            Quitar override
          </button>
        )}
        <span className="ml-auto text-[10px] text-[var(--text-muted)] italic">
          Preview aprox: Δφ<sub>Mn</sub> ≈ (As<sub>new</sub>/As<sub>base</sub>)<sup>0.85</sup> ·
          Δφ<sub>Vn</sub> ≈ ρ<sub>h,new</sub>/ρ<sub>h,base</sub>
        </span>
      </div>
    </div>
  );
}
