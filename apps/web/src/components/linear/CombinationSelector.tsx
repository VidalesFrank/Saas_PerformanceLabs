"use client";

import { useEffect, useState, useCallback } from "react";
import type { LoadCombination, CombinationGroup } from "@/lib/structural-types";
import { structuralProjectsApi } from "@/lib/structural-api";

// ── Constantes de grupo ────────────────────────────────────────────────────────

const GROUP_ORDER: CombinationGroup[] = ["gravity", "seismic_x", "seismic_y"];

const GROUP_META: Record<CombinationGroup, { label: string; color: string; badge: string }> = {
  gravity:   { label: "Gravitacionales",         color: "var(--color-success)",  badge: "G" },
  seismic_x: { label: "Sísmicas — Dirección X",  color: "var(--color-accent)",   badge: "X" },
  seismic_y: { label: "Sísmicas — Dirección Y",  color: "var(--color-warning)",  badge: "Y" },
};

// ── Sub-componentes ────────────────────────────────────────────────────────────

function IdBadge({ id, color }: { id: string; color: string }) {
  return (
    <span
      className="inline-flex items-center justify-center rounded px-1.5 py-0.5 text-[10px] font-bold font-mono min-w-[28px]"
      style={{ background: `${color}22`, color }}
    >
      {id}
    </span>
  );
}

function FactorChip({ label, value }: { label: string; value: number }) {
  if (value === 0) return null;
  const sign = value > 0 ? "+" : "";
  return (
    <span className="inline-flex items-center gap-0.5 rounded border border-border px-1 py-0.5 text-[9px] font-mono text-text-muted">
      <span className="opacity-60">{sign}{value}·</span>
      <span className="text-text font-semibold">{label}</span>
    </span>
  );
}

interface CombinationRowProps {
  combo: LoadCombination;
  selected: boolean;
  onChange: (id: string, checked: boolean) => void;
  disabled?: boolean;
}

function CombinationRow({ combo, selected, onChange, disabled }: CombinationRowProps) {
  const meta = GROUP_META[combo.group];
  return (
    <label
      className={[
        "flex items-start gap-3 px-4 py-3 cursor-pointer transition-colors",
        selected ? "bg-accent/5" : "hover:bg-surface-2",
        disabled ? "cursor-not-allowed opacity-50" : "",
      ].join(" ")}
    >
      <input
        type="checkbox"
        className="mt-0.5 accent-[var(--color-accent)] flex-shrink-0"
        checked={selected}
        disabled={disabled}
        onChange={(e) => onChange(combo.id, e.target.checked)}
      />

      <div className="flex flex-1 flex-wrap items-center gap-2 min-w-0">
        <IdBadge id={combo.id} color={meta.color} />

        {/* Fórmula compacta como chips de factores */}
        <div className="flex flex-wrap items-center gap-1">
          <FactorChip label="CM" value={combo.factors.CM} />
          <FactorChip label="CV" value={combo.factors.CV} />
          <FactorChip label="Ex" value={combo.factors.Ex} />
          <FactorChip label="Ey" value={combo.factors.Ey} />
        </div>

        {/* Fórmula algebraica */}
        <span className="font-mono text-[11px] text-text-muted hidden sm:block">
          {combo.formula}
        </span>
      </div>

      <div className="flex items-center gap-3 flex-shrink-0 text-right">
        <span className="text-[10px] text-text-muted hidden md:block max-w-[200px] truncate" title={combo.note}>
          {combo.note}
        </span>
        <span className="text-[10px] text-text-muted font-mono opacity-70 whitespace-nowrap">
          NSR-10 {combo.ref}
        </span>
      </div>
    </label>
  );
}

// ── Componente principal ──────────────────────────────────────────────────────

interface Props {
  projectId: string;
  cmLoad: string;
  cvLoad: string;
}

type SaveState = "idle" | "saving" | "saved" | "error";

export function CombinationSelector({ projectId, cmLoad, cvLoad }: Props) {
  const [combinations, setCombinations] = useState<LoadCombination[]>([]);
  const [selectedIds, setSelectedIds]   = useState<Set<string>>(new Set());
  const [loading, setLoading]           = useState(true);
  const [dirty, setDirty]               = useState(false);
  const [saveState, setSaveState]       = useState<SaveState>("idle");

  // ── Carga inicial ──────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await structuralProjectsApi.getCombinations(projectId);
      setCombinations(data.combinations);
      setSelectedIds(new Set(data.selected_ids));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  // ── Handlers ───────────────────────────────────────────────────────────────

  function handleToggle(id: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
    setDirty(true);
    setSaveState("idle");
  }

  function handleGroupToggle(group: CombinationGroup, selectAll: boolean) {
    const groupIds = combinations.filter((c) => c.group === group).map((c) => c.id);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      groupIds.forEach((id) => { if (selectAll) next.add(id); else next.delete(id); });
      return next;
    });
    setDirty(true);
    setSaveState("idle");
  }

  function handleSelectAll() {
    setSelectedIds(new Set(combinations.map((c) => c.id)));
    setDirty(true);
    setSaveState("idle");
  }

  async function handleSave() {
    setSaveState("saving");
    try {
      await structuralProjectsApi.saveCombinations(projectId, Array.from(selectedIds));
      setSaveState("saved");
      setDirty(false);
      setTimeout(() => setSaveState("idle"), 2500);
    } catch {
      setSaveState("error");
    }
  }

  // ── Derivados ──────────────────────────────────────────────────────────────

  const byGroup = (group: CombinationGroup) => combinations.filter((c) => c.group === group);
  const groupAllSelected = (group: CombinationGroup) =>
    byGroup(group).every((c) => selectedIds.has(c.id));

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-10 rounded-lg pl-skeleton" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">

      {/* ── Cabecera info ──────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-4 text-xs text-text-muted">
          <span>
            CM ←
            <strong className="text-text ml-1 font-mono">{cmLoad}</strong>
          </span>
          <span>
            CV ←
            <strong className="text-text ml-1 font-mono">{cvLoad}</strong>
          </span>
          <span>
            E ← RSA (espectro NSR-10,{" "}
            <span className="font-mono">R</span> incluido)
          </span>
          <span className="text-text">
            <strong>{selectedIds.size}</strong> / {combinations.length} combinaciones activas
          </span>
        </div>
        <button
          onClick={handleSelectAll}
          className="text-[11px] text-accent hover:text-accent-strong transition-colors underline underline-offset-2"
        >
          Seleccionar todas
        </button>
      </div>

      {/* ── Grupos ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3">
        {GROUP_ORDER.map((group) => {
          const meta   = GROUP_META[group];
          const combos = byGroup(group);
          const allSel = groupAllSelected(group);

          return (
            <div key={group} className="rounded-lg border border-border overflow-hidden">
              {/* Encabezado de grupo */}
              <div
                className="flex items-center justify-between px-4 py-2 bg-surface-2"
                style={{ borderLeft: `3px solid ${meta.color}` }}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                    style={{ background: `${meta.color}22`, color: meta.color }}
                  >
                    {meta.badge}
                  </span>
                  <span className="text-xs font-semibold text-text">{meta.label}</span>
                  <span className="text-[10px] text-text-muted">
                    ({combos.filter((c) => selectedIds.has(c.id)).length}/{combos.length})
                  </span>
                </div>
                <button
                  onClick={() => handleGroupToggle(group, !allSel)}
                  className="text-[11px] text-accent hover:text-accent-strong transition-colors"
                >
                  {allSel ? "Desmarcar todas" : "Marcar todas"}
                </button>
              </div>

              {/* Filas */}
              <div className="divide-y divide-border">
                {combos.map((combo) => (
                  <CombinationRow
                    key={combo.id}
                    combo={combo}
                    selected={selectedIds.has(combo.id)}
                    onChange={handleToggle}
                    disabled={combo.id === "G1" || combo.id === "G2"}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Nota NSR-10 y acción guardar ──────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4">
        <p className="text-[11px] text-text-muted">
          G1 y G2 son obligatorias (NSR-10 B.3.4). Las fuerzas E del RSA ya incluyen el factor R.
        </p>

        <button
          onClick={handleSave}
          disabled={!dirty || saveState === "saving"}
          className={[
            "flex-shrink-0 px-4 py-2 rounded-lg text-xs font-semibold transition-all border",
            saveState === "saved"
              ? "border-[var(--color-success)] bg-[var(--color-success)]/10 text-[var(--color-success)]"
              : saveState === "error"
              ? "border-[var(--color-danger)] bg-[var(--color-danger)]/10 text-[var(--color-danger)]"
              : dirty
              ? "border-accent bg-accent text-white hover:bg-accent-strong"
              : "border-border bg-surface-2 text-text-muted cursor-not-allowed",
          ].join(" ")}
        >
          {saveState === "saving" ? "Guardando…"
           : saveState === "saved"  ? "Guardado ✓"
           : saveState === "error"  ? "Error al guardar"
           : dirty                  ? "Guardar configuración"
           :                          "Sin cambios"}
        </button>
      </div>
    </div>
  );
}
