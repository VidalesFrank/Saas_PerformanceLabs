"use client";

import { type ChangeEvent } from "react";
import type {
  SectionDocument, ConcreteRegion, ReinforcementBar,
  RectShape, CircShape, PolygonShape,
  ConfinementDef, RectConfinementDef, CircConfinementDef,
} from "@/lib/section-document";
import { BAR_SIZES, BAR_AREAS_MM2, sectionGrossArea, sectionSteelArea } from "@/lib/section-document";
import type { Selection, EditorAction } from "@/lib/editor-state";

interface Props {
  doc: SectionDocument;
  selection: Selection;
  dispatch: React.Dispatch<EditorAction>;
}

// ── Atoms de UI ───────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-2.5">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted">{label}</p>
      {children}
    </div>
  );
}

function NumInput({ value, onChange, min, max, step = 1 }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number;
}) {
  return (
    <input type="number" value={value} min={min} max={max} step={step}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(parseFloat(e.target.value) || 0)}
      className="w-full rounded border border-border bg-surface-2 px-2 py-1 text-xs text-text
        focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40" />
  );
}

function TextInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input type="text" value={value}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      className="w-full rounded border border-border bg-surface-2 px-2 py-1 text-xs text-text
        focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40" />
  );
}

function SelectEl({ value, onChange, options }: {
  value: string; onChange: (v: string) => void; options: { value: string; label: string }[];
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className="w-full rounded border border-border bg-surface-2 px-2 py-1 text-xs text-text
        focus:border-accent focus:outline-none">
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="mb-2 mt-3 border-t border-border pt-2 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
      {label}
    </div>
  );
}

// ── Editor de confinamiento ───────────────────────────────────────────────────

const DEFAULT_RECT_CONF: RectConfinementDef = {
  kind: "rect", hoop_bar_size: "#3", spacing: 150, legs_x: 2, legs_y: 2, fyh: null,
};

const DEFAULT_CIRC_CONF: CircConfinementDef = {
  kind: "circ", hoop_bar_size: "#3", spacing: 80, is_spiral: true, fyh: null,
};

function ConfinementEditor({ conf, regionShape, onChange }: {
  conf: ConfinementDef | null;
  regionShape: ConcreteRegion["shape"];
  onChange: (c: ConfinementDef | null) => void;
}) {
  const barSizeOpts = [...BAR_SIZES].map((s) => ({ value: s, label: s }));

  if (!conf) {
    const defaultConf = regionShape.kind === "circ" ? DEFAULT_CIRC_CONF : DEFAULT_RECT_CONF;
    return (
      <div>
        <button
          onClick={() => onChange(defaultConf)}
          className="w-full rounded border border-dashed border-border py-1.5 text-xs text-text-muted
            hover:border-accent/50 hover:text-accent transition-colors"
        >
          + Agregar confinamiento
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-accent/20 bg-accent/5 p-2.5">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-accent">
          {conf.kind === "rect" ? "Estribos rectangulares" : conf.is_spiral ? "Espiral" : "Zuncho circular"}
        </span>
        <button
          onClick={() => onChange(null)}
          className="text-[10px] text-danger/60 hover:text-danger"
          title="Quitar confinamiento"
        >
          × quitar
        </button>
      </div>

      {/* Selector tipo */}
      <Field label="Tipo">
        <div className="flex gap-1">
          {(["rect", "circ"] as const).map((k) => (
            <button key={k} onClick={() => onChange(k === "rect" ? DEFAULT_RECT_CONF : DEFAULT_CIRC_CONF)}
              className={`flex-1 rounded py-1 text-[10px] transition-colors
                ${conf.kind === k ? "bg-accent text-[#04141a]" : "bg-surface border border-border text-text-muted hover:border-accent/40"}`}>
              {k === "rect" ? "Rectangular" : "Circular"}
            </button>
          ))}
        </div>
      </Field>

      {/* Varilla del estribo */}
      <Field label="Varilla estribo">
        <SelectEl
          value={conf.hoop_bar_size}
          onChange={(v) => onChange({ ...conf, hoop_bar_size: v as typeof conf.hoop_bar_size })}
          options={barSizeOpts}
        />
      </Field>

      {/* Espaciamiento */}
      <Field label="Espaciamiento (mm)">
        <NumInput value={conf.spacing} onChange={(v) => onChange({ ...conf, spacing: v })} min={20} step={10} />
      </Field>

      {/* Parámetros específicos por tipo */}
      {conf.kind === "rect" && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Ramas en X">
            <NumInput value={conf.legs_x} onChange={(v) => onChange({ ...conf, legs_x: Math.max(1, Math.round(v)) })} min={1} step={1} />
          </Field>
          <Field label="Ramas en Y">
            <NumInput value={conf.legs_y} onChange={(v) => onChange({ ...conf, legs_y: Math.max(1, Math.round(v)) })} min={1} step={1} />
          </Field>
        </div>
      )}

      {conf.kind === "circ" && (
        <div className="mb-2 flex items-center gap-2">
          <input type="checkbox" id="is_spiral" checked={conf.is_spiral}
            onChange={(e) => onChange({ ...conf, is_spiral: e.target.checked })}
            className="rounded accent-accent" />
          <label htmlFor="is_spiral" className="cursor-pointer text-xs text-text">Espiral continua</label>
        </div>
      )}

      {/* fyh */}
      <Field label="fyh (MPa) — vacío = usar fy del acero">
        <input type="number"
          value={conf.fyh ?? ""}
          placeholder="fy del acero"
          onChange={(e) => onChange({ ...conf, fyh: e.target.value ? parseFloat(e.target.value) : null })}
          className="w-full rounded border border-border bg-surface-2 px-2 py-1 text-xs text-text
            focus:border-accent focus:outline-none" />
      </Field>
    </div>
  );
}

// ── Panel: región seleccionada ─────────────────────────────────────────────────

function RegionProperties({ region, doc, dispatch }: {
  region: ConcreteRegion; doc: SectionDocument; dispatch: React.Dispatch<EditorAction>;
}) {
  const update = (updates: Partial<ConcreteRegion>) =>
    dispatch({ type: "UPDATE_REGION", id: region.id, updates });

  const updateShape = (upd: Partial<RectShape> | Partial<CircShape> | Partial<PolygonShape>) =>
    update({ shape: { ...region.shape, ...upd } as ConcreteRegion["shape"] });

  const concreteOptions = doc.concrete_defs.map((c) => ({ value: c.id, label: c.label }));

  return (
    <div className="flex flex-col overflow-y-auto">
      <div className="border-b border-border bg-surface-2 px-3 py-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-text">Región</span>
        <button
          onClick={() => dispatch({ type: "DUPLICATE_REGION", id: region.id })}
          title="Duplicar región (Ctrl+D)"
          className="text-[10px] text-text-muted hover:text-accent"
        >
          ⧉ duplicar
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        <Field label="Etiqueta">
          <TextInput value={region.label} onChange={(v) => update({ label: v })} />
        </Field>

        <Field label="Concreto">
          <SelectEl value={region.concrete_id} onChange={(v) => update({ concrete_id: v })} options={concreteOptions} />
        </Field>

        <div className="mb-2.5 flex items-center gap-2">
          <input type="checkbox" id={`void_${region.id}`} checked={region.is_void}
            onChange={(e) => update({ is_void: e.target.checked })}
            className="rounded border-border accent-accent" />
          <label htmlFor={`void_${region.id}`} className="cursor-pointer text-xs text-text">Vacío / hueco</label>
        </div>

        <Field label="Recubrimiento a centroide (mm)">
          <NumInput value={region.cover_to_bar} onChange={(v) => update({ cover_to_bar: v })} min={0} step={5} />
        </Field>

        {/* ── Geometría ───────────────────────────────────────── */}
        {region.shape.kind === "rect" && (
          <>
            <SectionDivider label="Rectángulo" />
            <div className="grid grid-cols-2 gap-2">
              <Field label="Ancho Z (mm)">
                <NumInput value={region.shape.width} onChange={(v) => updateShape({ width: v })} min={1} step={10} />
              </Field>
              <Field label="Alto Y (mm)">
                <NumInput value={region.shape.height} onChange={(v) => updateShape({ height: v })} min={1} step={10} />
              </Field>
              <Field label="Centro Z (mm)">
                <NumInput value={region.shape.z} onChange={(v) => updateShape({ z: v })} step={10} />
              </Field>
              <Field label="Centro Y (mm)">
                <NumInput value={region.shape.y} onChange={(v) => updateShape({ y: v })} step={10} />
              </Field>
            </div>
            <Field label="Ángulo (°)">
              <NumInput value={region.shape.angle_deg} onChange={(v) => updateShape({ angle_deg: v })} min={-90} max={90} step={5} />
            </Field>
          </>
        )}

        {region.shape.kind === "circ" && (
          <>
            <SectionDivider label="Círculo" />
            <div className="grid grid-cols-2 gap-2">
              <Field label="Radio ext. (mm)">
                <NumInput value={region.shape.radius} onChange={(v) => updateShape({ radius: v })} min={1} step={10} />
              </Field>
              <Field label="Radio int. (mm)">
                <NumInput value={region.shape.radius_inner} onChange={(v) => updateShape({ radius_inner: v })} min={0} step={10} />
              </Field>
              <Field label="Centro Z (mm)">
                <NumInput value={region.shape.z} onChange={(v) => updateShape({ z: v })} step={10} />
              </Field>
              <Field label="Centro Y (mm)">
                <NumInput value={region.shape.y} onChange={(v) => updateShape({ y: v })} step={10} />
              </Field>
            </div>
          </>
        )}

        {region.shape.kind === "poly" && (
          <>
            <SectionDivider label="Polígono" />
            <p className="text-xs text-text-muted">{region.shape.vertices.length} vértices</p>
            <p className="mt-1 text-[10px] text-text-muted">Edita el polígono en el canvas.</p>
          </>
        )}

        {/* ── Confinamiento ────────────────────────────────────── */}
        <SectionDivider label="Confinamiento (Mander)" />
        <ConfinementEditor
          conf={region.confinement}
          regionShape={region.shape}
          onChange={(c) => update({ confinement: c })}
        />

        {/* Botón eliminar */}
        <button
          onClick={() => dispatch({ type: "DELETE_REGION", id: region.id })}
          className="mt-4 w-full rounded border border-danger/30 py-1.5 text-xs text-danger/70
            hover:border-danger hover:text-danger transition-colors"
        >
          Eliminar región
        </button>
      </div>
    </div>
  );
}

// ── Panel: barra seleccionada ──────────────────────────────────────────────────

function BarProperties({ bar, doc, dispatch }: {
  bar: ReinforcementBar; doc: SectionDocument; dispatch: React.Dispatch<EditorAction>;
}) {
  const update = (updates: Partial<ReinforcementBar>) =>
    dispatch({ type: "UPDATE_BAR", id: bar.id, updates });

  const steelOptions = doc.steel_defs.map((s) => ({ value: s.id, label: s.label }));
  const barSizeOptions = [...BAR_SIZES].map((s) => ({
    value: s, label: `${s} — ${BAR_AREAS_MM2[s]} mm²`,
  }));

  return (
    <div className="flex flex-col">
      <div className="border-b border-border bg-surface-2 px-3 py-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-text">Barra</span>
        <button
          onClick={() => dispatch({ type: "DUPLICATE_BAR", id: bar.id })}
          title="Duplicar barra (Ctrl+D)"
          className="text-[10px] text-text-muted hover:text-accent"
        >
          ⧉ duplicar
        </button>
      </div>

      <div className="p-3">
        <Field label="Tamaño">
          <SelectEl value={bar.bar_size} onChange={(v) => update({ bar_size: v as typeof bar.bar_size })} options={barSizeOptions} />
        </Field>
        <Field label="Acero">
          <SelectEl value={bar.steel_id} onChange={(v) => update({ steel_id: v })} options={steelOptions} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Posición Y (mm)">
            <NumInput value={bar.y} onChange={(v) => update({ y: v })} step={5} />
          </Field>
          <Field label="Posición Z (mm)">
            <NumInput value={bar.z} onChange={(v) => update({ z: v })} step={5} />
          </Field>
        </div>
        <div className="mt-2 rounded bg-surface-2 p-2 text-[10px] text-text-muted">
          Área: {BAR_AREAS_MM2[bar.bar_size]} mm²
        </div>

        <button
          onClick={() => dispatch({ type: "DELETE_BAR", id: bar.id })}
          className="mt-4 w-full rounded border border-danger/30 py-1.5 text-xs text-danger/70
            hover:border-danger hover:text-danger transition-colors"
        >
          Eliminar barra
        </button>
      </div>
    </div>
  );
}

// ── Panel: resumen de sección ──────────────────────────────────────────────────

function SectionSummaryPanel({ doc }: { doc: SectionDocument }) {
  const ag = sectionGrossArea(doc);
  const as = sectionSteelArea(doc);
  const rho = ag > 0 ? (as / ag) * 100 : 0;

  return (
    <div className="p-3">
      <p className="mb-3 text-xs font-semibold text-text">Resumen</p>
      <div className="space-y-1.5 text-xs">
        {[
          ["Ag", ag > 0 ? `${(ag / 1e6).toFixed(4)} m²` : "—"],
          ["As", as > 0 ? `${as.toFixed(0)} mm²` : "—"],
          ["ρ", as > 0 ? `${rho.toFixed(2)} %` : "—"],
          ["Regiones", doc.regions.length.toString()],
          ["Barras", doc.bars.length.toString()],
        ].map(([label, value]) => (
          <div key={label} className="flex justify-between text-text-muted">
            <span>{label}</span>
            <span className="font-mono text-text">{value}</span>
          </div>
        ))}
      </div>

      <SectionDivider label="Concretos" />
      {doc.concrete_defs.map((c) => (
        <div key={c.id} className="mb-1 flex items-center gap-2 text-[10px] text-text-muted">
          <span className="h-2 w-2 rounded-sm bg-accent/50 flex-shrink-0" />
          <span className="flex-1 truncate">{c.label}</span>
          <span className="font-mono">{c.fpc} MPa</span>
        </div>
      ))}

      <SectionDivider label="Aceros" />
      {doc.steel_defs.map((s) => (
        <div key={s.id} className="mb-1 flex items-center gap-2 text-[10px] text-text-muted">
          <span className="h-2 w-2 rounded-full bg-warning/60 flex-shrink-0" />
          <span className="flex-1 truncate">{s.label}</span>
          <span className="font-mono">{s.fy} MPa</span>
        </div>
      ))}

      <p className="mt-4 text-[10px] text-text-muted">
        Haz clic en una región o barra para editar. Usa el botón "Materiales" para definir f'c y fy.
      </p>
    </div>
  );
}

// ── Componente principal ───────────────────────────────────────────────────────

export function PropertiesPanel({ doc, selection, dispatch }: Props) {
  const selectedRegion = selection?.kind === "region"
    ? doc.regions.find((r) => r.id === selection.id) : undefined;
  const selectedBar = selection?.kind === "bar"
    ? doc.bars.find((b) => b.id === selection.id) : undefined;

  return (
    <div className="flex w-64 flex-col border-l border-border bg-surface overflow-hidden">
      {selectedRegion && (
        <RegionProperties region={selectedRegion} doc={doc} dispatch={dispatch} />
      )}
      {selectedBar && (
        <BarProperties bar={selectedBar} doc={doc} dispatch={dispatch} />
      )}
      {selection?.kind === "multi" && (
        <MultiSelectionPanel selection={selection} dispatch={dispatch} />
      )}
      {!selection && (
        <SectionSummaryPanel doc={doc} />
      )}
    </div>
  );
}

// ── Panel de selección múltiple ────────────────────────────────────────────────

function MultiSelectionPanel({ selection, dispatch }: {
  selection: { kind: "multi"; regionIds: string[]; barIds: string[] };
  dispatch: React.Dispatch<EditorAction>;
}) {
  const total = selection.regionIds.length + selection.barIds.length;
  return (
    <div className="flex flex-col gap-3 p-4">
      <p className="text-xs font-semibold text-text">
        {total} elemento{total !== 1 ? "s" : ""} seleccionado{total !== 1 ? "s" : ""}
      </p>
      <p className="text-[11px] text-text-muted">
        {selection.regionIds.length} región{selection.regionIds.length !== 1 ? "es" : ""}
        {" · "}
        {selection.barIds.length} barra{selection.barIds.length !== 1 ? "s" : ""}
      </p>
      <p className="text-[10px] text-text-muted">
        Arrastra para mover · Delete para eliminar
      </p>
      <div className="flex gap-2 pt-1">
        <button
          onClick={() => dispatch({ type: "DELETE_SELECTION" })}
          className="flex-1 rounded-lg bg-danger/15 px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/25"
        >
          Eliminar todos
        </button>
        <button
          onClick={() => dispatch({ type: "SET_SELECTION", selection: null })}
          className="flex-1 rounded-lg border border-border px-3 py-1.5 text-xs text-text-muted hover:text-text"
        >
          Deseleccionar
        </button>
      </div>
    </div>
  );
}
