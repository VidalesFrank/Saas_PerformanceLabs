"use client";

import { useEffect, useState } from "react";
import { BAR_DIAMETERS_MM } from "@/lib/section-document";
import { IconClose, IconCheck } from "./icons";

// Barra minimal — funciona con ReinforcementBar y con vistas efímeras (analysis pages)
export interface EditableBar {
  y: number;
  z: number;
  bar_size: string;
  id?: string;   // opcional, se usa como key si está
}

interface Props {
  bar: EditableBar;
  onChange: (updates: Partial<EditableBar>) => void;
  onClose: () => void;
  title?: string;   // opcional para override del header (ej: "Barra #3 de 8")
}

type BarSize = keyof typeof BAR_DIAMETERS_MM;
const BAR_SIZES: readonly BarSize[] = ["#3","#4","#5","#6","#7","#8","#9","#10","#11"] as const;

export function BarEditDialog({ bar, onChange, onClose, title }: Props) {
  const [localY, setLocalY] = useState(bar.y);
  const [localZ, setLocalZ] = useState(bar.z);
  const [localSize, setLocalSize] = useState<BarSize>(bar.bar_size as BarSize);
  const [live, setLive] = useState(true);   // aplica cambios en vivo

  useEffect(() => {
    setLocalY(bar.y); setLocalZ(bar.z); setLocalSize(bar.bar_size as BarSize);
  }, [bar.id, bar.y, bar.z, bar.bar_size]);   // sync al cambiar barra activa

  // Aplicar cambios en vivo cuando live=true
  useEffect(() => {
    if (!live) return;
    if (localY !== bar.y || localZ !== bar.z || localSize !== bar.bar_size) {
      onChange({ y: localY, z: localZ, bar_size: localSize });
    }

  }, [localY, localZ, localSize, live]);

  // Cerrar con Escape
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const diameter = BAR_DIAMETERS_MM[localSize as keyof typeof BAR_DIAMETERS_MM];
  const area = Math.PI * (diameter / 2) ** 2;

  return (
    <div
      className="fixed right-6 top-24 z-40 w-[320px] overflow-hidden rounded-2xl border border-border
                 bg-surface/98 shadow-2xl backdrop-blur-md"
      style={{ animation: "pl-fade-up 0.18s ease-out both" }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border bg-gradient-to-r from-accent/10 to-transparent px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-amber-500 shadow-[0_0_0_3px_rgba(245,158,11,0.25)]" />
          <div>
            <h3 className="text-sm font-bold text-text">{title ?? `Barra ${localSize}`}</h3>
            <p className="text-[10px] font-mono text-text-muted">φ {diameter.toFixed(2)} mm · As {area.toFixed(0)} mm²</p>
          </div>
        </div>
        <button onClick={onClose}
          className="rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text transition-colors">
          <IconClose size={16} />
        </button>
      </div>

      {/* Body */}
      <div className="space-y-4 p-4">
        {/* Tamaño (chips) */}
        <div>
          <label className="mb-2 flex items-baseline justify-between">
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-text-muted">Diámetro</span>
            <span className="text-[10px] text-text-muted">#3 → #11</span>
          </label>
          <div className="flex flex-wrap gap-1">
            {BAR_SIZES.map((s) => (
              <button
                key={s}
                onClick={() => setLocalSize(s)}
                className={`rounded-md border px-2 py-1 text-[11px] font-semibold font-mono transition-all
                  ${localSize === s
                    ? "border-accent bg-accent text-[#04141a] shadow-sm"
                    : "border-border text-text-muted hover:border-accent/50 hover:text-text"}`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* Posición Y */}
        <SliderInput
          label="y (dirección de flexión)"
          value={localY}
          onChange={setLocalY}
          min={-1000} max={1000} step={1}
          unit="mm"
        />
        {/* Posición Z */}
        <SliderInput
          label="z (perpendicular)"
          value={localZ}
          onChange={setLocalZ}
          min={-1000} max={1000} step={1}
          unit="mm"
        />

        {/* Preview visual del área */}
        <div className="flex items-center justify-around rounded-lg border border-border bg-surface-2/50 p-3">
          <div className="text-center">
            <div className="text-[10px] uppercase tracking-wide text-text-muted">φ</div>
            <div className="font-mono text-sm font-bold text-text">{diameter.toFixed(2)} mm</div>
          </div>
          <div className="flex items-center justify-center">
            <svg width={36} height={36} viewBox="-20 -20 40 40">
              <circle cx={0} cy={0} r={16} fill="none" stroke="var(--color-border)" strokeDasharray="1.5 2" opacity={0.6} />
              <circle cx={0} cy={0} r={Math.min(diameter / 2, 16)} fill="rgb(245,158,11)" stroke="rgb(120,53,15)" strokeWidth="0.5" />
            </svg>
          </div>
          <div className="text-center">
            <div className="text-[10px] uppercase tracking-wide text-text-muted">As</div>
            <div className="font-mono text-sm font-bold text-text">{area.toFixed(0)} mm²</div>
          </div>
        </div>

        {/* Toggle en vivo */}
        <label className="flex items-center gap-2 text-[11px] text-text-muted cursor-pointer">
          <input
            type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)}
            className="rounded accent-accent"
          />
          Aplicar en vivo mientras edito
        </label>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end gap-2 border-t border-border bg-surface-2/30 px-4 py-2.5">
        {!live && (
          <button
            onClick={() => onChange({ y: localY, z: localZ, bar_size: localSize })}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-[#04141a] hover:opacity-90 transition"
          >
            <IconCheck size={13} />
            Aplicar
          </button>
        )}
        <button onClick={onClose}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-text-muted hover:text-text transition">
          Cerrar
        </button>
      </div>
    </div>
  );
}

// ── SliderInput compuesto ──────────────────────────────────────────────────

function SliderInput({ label, value, onChange, min, max, step, unit }: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number; max: number; step: number;
  unit?: string;
}) {
  return (
    <div>
      <label className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-text-muted">{label}</span>
        <div className="flex items-center gap-1">
          <input
            type="number"
            value={value.toFixed(1)}
            onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
            step={step}
            className="w-20 rounded-md border border-border bg-surface-2 px-2 py-0.5 text-right text-xs font-mono text-text focus:border-accent focus:outline-none"
          />
          {unit && <span className="text-[10px] text-text-muted">{unit}</span>}
        </div>
      </label>
      <input
        type="range" min={min} max={max} step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-surface-2 accent-accent"
        style={{
          background: `linear-gradient(to right,
            var(--color-accent) 0%,
            var(--color-accent) ${((value - min) / (max - min)) * 100}%,
            var(--color-surface-2) ${((value - min) / (max - min)) * 100}%,
            var(--color-surface-2) 100%)`,
        }}
      />
    </div>
  );
}
