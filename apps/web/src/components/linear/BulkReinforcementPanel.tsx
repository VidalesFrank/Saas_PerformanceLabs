"use client";

import { useMemo, useState } from "react";
import type {
  FrameListItem,
  ColumnReinforcementEdit,
  BeamReinforcementEdit,
} from "@/lib/structural-types";
import { structuralDesignApi } from "@/lib/structural-api";

const BARS = ["#3", "#4", "#5", "#6", "#7", "#8", "#9", "#10", "#11"];

interface Props {
  projectId: string;
  selected: FrameListItem[];
  onApplied?: () => void;
  onClear?: () => void;
}

type HomogeneityState =
  | { ok: true;  element_type: "column" | "beam"; section: string }
  | { ok: false; reason: string };

function checkHomogeneity(selected: FrameListItem[]): HomogeneityState {
  if (selected.length === 0) return { ok: false, reason: "Selección vacía." };
  const types    = new Set(selected.map((f) => f.element_type));
  const sections = new Set(selected.map((f) => f.section));
  if (types.size > 1) {
    return { ok: false, reason: `Hay ${sorted(types).join(", ")} mezclados.` };
  }
  if (sections.size > 1) {
    return { ok: false, reason: `Secciones distintas: ${sorted(sections).join(", ")}.` };
  }
  return {
    ok: true,
    element_type: [...types][0],
    section: [...sections][0],
  };
}

function sorted<T>(s: Set<T>): T[] {
  return [...s].sort();
}

export default function BulkReinforcementPanel({ projectId, selected, onApplied, onClear }: Props) {
  const homogeneity = useMemo(() => checkHomogeneity(selected), [selected]);
  const stories = useMemo(() => {
    const s = new Set(selected.map((f) => f.story));
    return [...s].sort();
  }, [selected]);

  const [patternLabel, setPatternLabel] = useState("");
  const [notes,        setNotes]        = useState("");

  // Estado del refuerzo según tipo
  // Columnas: default simple
  const [col_nBars, setColNBars]  = useState<number>(8);
  const [col_bar,   setColBar]    = useState<string>("#8");
  const [col_tie,   setColTie]    = useState<string>("#3");
  const [col_sConf, setColSConf]  = useState<number>(100);
  const [col_sGen,  setColSGen]   = useState<number>(200);

  // Vigas
  const [bm_topN,  setBmTopN]  = useState<number>(4);
  const [bm_topB,  setBmTopB]  = useState<string>("#6");
  const [bm_botN,  setBmBotN]  = useState<number>(4);
  const [bm_botB,  setBmBotB]  = useState<string>("#6");
  const [bm_stirrupBar,   setBmStirrupBar]  = useState<string>("#3");
  const [bm_stirrupLegs,  setBmStirrupLegs] = useState<number>(2);
  const [bm_sEnd,  setBmSEnd]  = useState<number>(100);
  const [bm_sMid,  setBmSMid]  = useState<number>(200);

  const [saveLoading, setSaveLoading] = useState(false);
  const [saveOk,      setSaveOk]      = useState(false);
  const [error,       setError]       = useState<string | null>(null);

  function buildReinforcement(): ColumnReinforcementEdit | BeamReinforcementEdit | null {
    if (!homogeneity.ok) return null;
    if (homogeneity.element_type === "column") {
      const r: ColumnReinforcementEdit = {
        longitudinal: { n_bars: col_nBars, bar_label: col_bar },
        transverse:   { tie_bar_label: col_tie, s_confined_mm: col_sConf, s_general_mm: col_sGen },
      };
      return r;
    } else {
      const r: BeamReinforcementEdit = {
        top_bars: { n_bars: bm_topN, bar_label: bm_topB },
        bot_bars: { n_bars: bm_botN, bar_label: bm_botB },
        stirrups: {
          zone_end: { bar_label: bm_stirrupBar, n_legs: bm_stirrupLegs, s_mm: bm_sEnd },
          zone_mid: { bar_label: bm_stirrupBar, n_legs: bm_stirrupLegs, s_mm: bm_sMid },
        },
      };
      return r;
    }
  }

  async function handleApply() {
    if (!homogeneity.ok) return;
    const reinf = buildReinforcement();
    if (!reinf) return;
    setSaveLoading(true);
    setError(null);
    try {
      await structuralDesignApi.bulkSaveReinforcement(projectId, {
        frame_ids: selected.map((f) => f.frame_id),
        reinforcement: reinf,
        notes: notes || undefined,
        pattern_label: patternLabel || undefined,
      });
      setSaveOk(true);
      setTimeout(() => setSaveOk(false), 3000);
      onApplied?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setSaveLoading(false);
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className={`flex items-center justify-between px-4 py-3 border-b border-[var(--border)] ${
        homogeneity.ok ? "bg-[var(--accent)]/5" : "bg-amber-500/10"
      }`}>
        <div>
          <h3 className="text-sm font-bold text-[var(--foreground)]">
            Aplicar patrón de refuerzo
          </h3>
          <p className="text-xs text-[var(--muted)]">
            {selected.length} elemento{selected.length === 1 ? "" : "s"} seleccionado{selected.length === 1 ? "" : "s"}
          </p>
        </div>
        {onClear && (
          <button
            onClick={onClear}
            className="text-xs px-3 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)] hover:border-[var(--accent)]"
          >
            Cerrar
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Resumen de homogeneidad */}
        {!homogeneity.ok ? (
          <div className="p-3 rounded border border-amber-500/40 bg-amber-500/10 text-sm text-amber-700 dark:text-amber-400">
            <div className="font-semibold mb-1">⚠ Selección no homogénea</div>
            <p className="text-xs">{homogeneity.reason}</p>
            <p className="text-xs mt-2">
              Para aplicar un patrón, la selección debe contener solo elementos del mismo tipo (columna o viga)
              y de la misma sección. Usa <b>“+ Misma sección”</b> en el navigator.
            </p>
          </div>
        ) : (
          <div className="p-3 rounded border border-[var(--border)] bg-[var(--card)]">
            <div className="grid grid-cols-3 gap-3 text-xs">
              <Stat label="Tipo" value={homogeneity.element_type === "column" ? "Columna" : "Viga"} />
              <Stat label="Sección" value={homogeneity.section} mono />
              <Stat label="Pisos" value={stories.length === 1 ? stories[0] : `${stories.length} pisos`} />
            </div>
            {stories.length > 1 && (
              <div className="mt-2 text-xs text-[var(--muted)]">
                {stories.join(", ")}
              </div>
            )}
          </div>
        )}

        {/* Metadata del patrón */}
        {homogeneity.ok && (
          <div className="space-y-2">
            <Field label="Etiqueta del patrón (opcional)">
              <input
                type="text"
                value={patternLabel}
                onChange={(e) => setPatternLabel(e.target.value)}
                placeholder={`${homogeneity.element_type === "column" ? "Col" : "Viga"} ${homogeneity.section} — típico`}
                className="w-full px-2 py-1 text-xs rounded border border-[var(--border)] bg-[var(--background)]"
              />
            </Field>
            <Field label="Notas (opcional)">
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                className="w-full px-2 py-1 text-xs rounded border border-[var(--border)] bg-[var(--background)] resize-none"
              />
            </Field>
          </div>
        )}

        {/* Editor específico */}
        {homogeneity.ok && homogeneity.element_type === "column" && (
          <section className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Longitudinal</h4>
            <div className="grid grid-cols-2 gap-3">
              <Field label="N° de barras">
                <input
                  type="number" min={4} max={64}
                  value={col_nBars}
                  onChange={(e) => setColNBars(parseInt(e.target.value) || 0)}
                  className="w-full px-2 py-1 text-xs rounded border border-[var(--border)] bg-[var(--background)]"
                />
              </Field>
              <Field label="Barra">
                <select
                  value={col_bar}
                  onChange={(e) => setColBar(e.target.value)}
                  className="w-full px-2 py-1 text-xs rounded border border-[var(--border)] bg-[var(--background)]"
                >
                  {BARS.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </Field>
            </div>

            <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)] mt-4">Transversal (estribos)</h4>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Barra">
                <select
                  value={col_tie}
                  onChange={(e) => setColTie(e.target.value)}
                  className="w-full px-2 py-1 text-xs rounded border border-[var(--border)] bg-[var(--background)]"
                >
                  {BARS.slice(0, 5).map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </Field>
              <Field label="s zona conf. (mm)">
                <input
                  type="number" min={50} max={300}
                  value={col_sConf}
                  onChange={(e) => setColSConf(parseInt(e.target.value) || 0)}
                  className="w-full px-2 py-1 text-xs rounded border border-[var(--border)] bg-[var(--background)]"
                />
              </Field>
              <Field label="s zona gral. (mm)">
                <input
                  type="number" min={50} max={400}
                  value={col_sGen}
                  onChange={(e) => setColSGen(parseInt(e.target.value) || 0)}
                  className="w-full px-2 py-1 text-xs rounded border border-[var(--border)] bg-[var(--background)]"
                />
              </Field>
            </div>
          </section>
        )}

        {homogeneity.ok && homogeneity.element_type === "beam" && (
          <section className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Barras superiores</h4>
            <div className="grid grid-cols-2 gap-3">
              <Field label="N° de barras">
                <input
                  type="number" min={2} max={16}
                  value={bm_topN}
                  onChange={(e) => setBmTopN(parseInt(e.target.value) || 0)}
                  className="w-full px-2 py-1 text-xs rounded border border-[var(--border)] bg-[var(--background)]"
                />
              </Field>
              <Field label="Barra">
                <select
                  value={bm_topB}
                  onChange={(e) => setBmTopB(e.target.value)}
                  className="w-full px-2 py-1 text-xs rounded border border-[var(--border)] bg-[var(--background)]"
                >
                  {BARS.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </Field>
            </div>

            <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)] mt-4">Barras inferiores</h4>
            <div className="grid grid-cols-2 gap-3">
              <Field label="N° de barras">
                <input
                  type="number" min={2} max={16}
                  value={bm_botN}
                  onChange={(e) => setBmBotN(parseInt(e.target.value) || 0)}
                  className="w-full px-2 py-1 text-xs rounded border border-[var(--border)] bg-[var(--background)]"
                />
              </Field>
              <Field label="Barra">
                <select
                  value={bm_botB}
                  onChange={(e) => setBmBotB(e.target.value)}
                  className="w-full px-2 py-1 text-xs rounded border border-[var(--border)] bg-[var(--background)]"
                >
                  {BARS.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </Field>
            </div>

            <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)] mt-4">Estribos</h4>
            <div className="grid grid-cols-4 gap-3">
              <Field label="Barra">
                <select
                  value={bm_stirrupBar}
                  onChange={(e) => setBmStirrupBar(e.target.value)}
                  className="w-full px-2 py-1 text-xs rounded border border-[var(--border)] bg-[var(--background)]"
                >
                  {BARS.slice(0, 5).map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </Field>
              <Field label="Ramas">
                <input
                  type="number" min={2} max={8}
                  value={bm_stirrupLegs}
                  onChange={(e) => setBmStirrupLegs(parseInt(e.target.value) || 0)}
                  className="w-full px-2 py-1 text-xs rounded border border-[var(--border)] bg-[var(--background)]"
                />
              </Field>
              <Field label="s extremo (mm)">
                <input
                  type="number" min={50} max={300}
                  value={bm_sEnd}
                  onChange={(e) => setBmSEnd(parseInt(e.target.value) || 0)}
                  className="w-full px-2 py-1 text-xs rounded border border-[var(--border)] bg-[var(--background)]"
                />
              </Field>
              <Field label="s medio (mm)">
                <input
                  type="number" min={50} max={400}
                  value={bm_sMid}
                  onChange={(e) => setBmSMid(parseInt(e.target.value) || 0)}
                  className="w-full px-2 py-1 text-xs rounded border border-[var(--border)] bg-[var(--background)]"
                />
              </Field>
            </div>
          </section>
        )}

        {/* Lista colapsable de IDs */}
        {homogeneity.ok && (
          <details className="rounded border border-[var(--border)]">
            <summary className="px-3 py-2 text-xs cursor-pointer text-[var(--muted)] hover:text-[var(--foreground)]">
              Ver los {selected.length} IDs incluidos
            </summary>
            <div className="px-3 py-2 text-xs text-[var(--muted)] font-mono max-h-32 overflow-y-auto">
              {selected.map((f) => f.frame_id).join(", ")}
            </div>
          </details>
        )}

        {error && (
          <div className="p-2 rounded bg-red-500/10 border border-red-500/40 text-xs text-red-600">
            {error}
          </div>
        )}
      </div>

      {/* Footer con botón de aplicar */}
      <div className="px-4 py-3 border-t border-[var(--border)] bg-[var(--card)] flex items-center justify-end gap-2">
        {saveOk && (
          <span className="text-xs text-green-600">✓ Patrón aplicado</span>
        )}
        <button
          onClick={handleApply}
          disabled={!homogeneity.ok || saveLoading || selected.length === 0}
          className="px-4 py-1.5 rounded text-sm font-semibold bg-[var(--accent)] text-white disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110"
        >
          {saveLoading ? "Aplicando…" : `Aplicar a ${selected.length} elemento${selected.length === 1 ? "" : "s"}`}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-[var(--muted)] font-medium">{label}</span>
      <div className="mt-0.5">{children}</div>
    </label>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className={`text-sm font-semibold text-[var(--foreground)] ${mono ? "font-mono" : ""}`}>
        {value}
      </div>
    </div>
  );
}
