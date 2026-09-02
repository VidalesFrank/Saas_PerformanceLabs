"use client";

import { WALL_FORMULATIONS, WallFormulation, FormulationInfo } from "@/lib/wall-types";

interface Props {
  value:    WallFormulation;
  onChange: (f: WallFormulation) => void;
  disabled?: boolean;
}

export default function WallFormulationSelector({ value, onChange, disabled }: Props) {
  return (
    <div className="space-y-2">
      <label className="block text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
        Analytical Formulation
      </label>
      <div className="space-y-2">
        {WALL_FORMULATIONS.map((f) => (
          <FormulationCard
            key={f.value}
            info={f}
            selected={value === f.value}
            onSelect={() => !disabled && onChange(f.value)}
            disabled={disabled}
          />
        ))}
      </div>
    </div>
  );
}

function FormulationCard({
  info,
  selected,
  onSelect,
  disabled,
}: {
  info:     FormulationInfo;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={[
        "w-full text-left rounded-lg border px-4 py-3 transition-all",
        selected
          ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--text-primary)]"
          : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-secondary)] hover:border-[var(--primary)]/50",
        disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <span className="font-mono text-sm font-bold">{info.label}</span>
          <p className="mt-0.5 text-xs">{info.description}</p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          {info.recommended && (
            <span className="rounded-full bg-[var(--primary)]/20 px-2 py-0.5 text-[10px] font-semibold text-[var(--primary)] uppercase">
              Recommended
            </span>
          )}
          {info.uses_rc_panel && (
            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-500 uppercase">
              RC Panel
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
