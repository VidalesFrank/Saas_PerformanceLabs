"use client";

import { useState } from "react";
import type { SectionDocument } from "@/lib/section-document";
import {
  BAR_SIZES, type BarSize,
  generateRectPerimeterBars, generateCircPerimeterBars, generateLineBars,
} from "@/lib/section-document";
import type { EditorAction } from "@/lib/editor-state";
import { Button } from "@/components/ui/button";

type PatternType = "rect-perimeter" | "circ-perimeter" | "line";

interface Props {
  doc: SectionDocument;
  dispatch: React.Dispatch<EditorAction>;
  onClose: () => void;
  // Para el patrón de línea, viene del canvas al completar una línea
  lineEndpoints?: { y1: number; z1: number; y2: number; z2: number };
  // Para perimetral, pasa la primera región activa
  defaultRegion?: { height: number; width: number; radius: number; coverToBar: number } | null;
}

export function BarPatternDialog({ doc, dispatch, onClose, lineEndpoints, defaultRegion }: Props) {
  const initialPattern: PatternType = lineEndpoints ? "line" : defaultRegion ? "rect-perimeter" : "line";

  const [pattern, setPattern] = useState<PatternType>(initialPattern);
  const [barSize, setBarSize] = useState<BarSize>("#5");
  const [nBarsY, setNBarsY] = useState(3);
  const [nBarsZ, setNBarsZ] = useState(3);
  const [nBarsCirc, setNBarsCirc] = useState(8);
  const [nBarsLine, setNBarsLine] = useState(5);
  const [height, setHeight] = useState(defaultRegion?.height ?? 400);
  const [width, setWidth] = useState(defaultRegion?.width ?? 400);
  const [radius, setRadius] = useState(defaultRegion?.radius ?? 200);
  const [coverToBar, setCoverToBar] = useState(defaultRegion?.coverToBar ?? 52);

  const steelId = doc.steel_defs[0]?.id ?? "s0";
  const steelOptions = doc.steel_defs.map((s) => ({ value: s.id, label: s.label }));
  const [selectedSteelId, setSelectedSteelId] = useState(steelId);

  function handlePlace() {
    let bars;
    if (pattern === "rect-perimeter") {
      bars = generateRectPerimeterBars(height, width, coverToBar, nBarsY, nBarsZ, barSize, selectedSteelId);
    } else if (pattern === "circ-perimeter") {
      bars = generateCircPerimeterBars(radius, coverToBar, nBarsCirc, barSize, selectedSteelId);
    } else if (lineEndpoints) {
      const { y1, z1, y2, z2 } = lineEndpoints;
      bars = generateLineBars(y1, z1, y2, z2, nBarsLine, barSize, selectedSteelId);
    } else {
      return;
    }
    dispatch({ type: "ADD_BARS", bars });
    onClose();
  }

  function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
      <div className="mb-3">
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted">{label}</p>
        {children}
      </div>
    );
  }

  function NumIn({ value, onChange, min = 1, step = 1 }: {
    value: number; onChange: (v: number) => void; min?: number; step?: number;
  }) {
    return (
      <input
        type="number"
        value={value}
        min={min}
        step={step}
        onChange={(e) => onChange(parseFloat(e.target.value) || min)}
        className="w-full rounded border border-border bg-surface-2 px-2 py-1.5 text-xs text-text
          focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40"
      />
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-80 rounded-xl border border-border bg-surface shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-text">Patrón de barras</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text">×</button>
        </div>

        <div className="p-4">
          {/* Tipo de patrón — no mostrar si vino de línea */}
          {!lineEndpoints && (
            <Field label="Patrón">
              <div className="flex gap-2">
                {(["rect-perimeter", "circ-perimeter"] as PatternType[]).map((p) => (
                  <button
                    key={p}
                    onClick={() => setPattern(p)}
                    className={`flex-1 rounded border py-1.5 text-xs transition-colors
                      ${pattern === p
                        ? "border-accent bg-accent/10 text-accent"
                        : "border-border text-text-muted hover:border-accent/50"
                      }`}
                  >
                    {p === "rect-perimeter" ? "▭ Perímetro rect." : "◯ Perímetro circ."}
                  </button>
                ))}
              </div>
            </Field>
          )}

          {lineEndpoints && (
            <Field label="Línea de barras">
              <NumIn value={nBarsLine} onChange={setNBarsLine} min={2} />
            </Field>
          )}

          {/* Parámetros geométricos según tipo */}
          {!lineEndpoints && pattern === "rect-perimeter" && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Ancho Z (mm)"><NumIn value={width} onChange={setWidth} step={10} /></Field>
                <Field label="Alto Y (mm)"><NumIn value={height} onChange={setHeight} step={10} /></Field>
                <Field label="Barras en Y"><NumIn value={nBarsY} onChange={setNBarsY} min={2} /></Field>
                <Field label="Barras en Z"><NumIn value={nBarsZ} onChange={setNBarsZ} min={2} /></Field>
              </div>
            </>
          )}

          {!lineEndpoints && pattern === "circ-perimeter" && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Radio exterior (mm)"><NumIn value={radius} onChange={setRadius} step={10} /></Field>
                <Field label="N° barras"><NumIn value={nBarsCirc} onChange={setNBarsCirc} min={4} /></Field>
              </div>
            </>
          )}

          {/* Recubrimiento — para perimetral */}
          {!lineEndpoints && (
            <Field label="Recubrimiento a centroide (mm)">
              <NumIn value={coverToBar} onChange={setCoverToBar} min={20} step={5} />
            </Field>
          )}

          {/* Tamaño y acero — siempre */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Tamaño">
              <select
                value={barSize}
                onChange={(e) => setBarSize(e.target.value as BarSize)}
                className="w-full rounded border border-border bg-surface-2 px-2 py-1.5 text-xs text-text
                  focus:border-accent focus:outline-none"
              >
                {[...BAR_SIZES].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="Acero">
              <select
                value={selectedSteelId}
                onChange={(e) => setSelectedSteelId(e.target.value)}
                className="w-full rounded border border-border bg-surface-2 px-2 py-1.5 text-xs text-text
                  focus:border-accent focus:outline-none"
              >
                {steelOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <Button variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button onClick={handlePlace}>Colocar barras</Button>
        </div>
      </div>
    </div>
  );
}
