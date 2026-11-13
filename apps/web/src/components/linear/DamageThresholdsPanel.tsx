"use client";

/**
 * Panel editable de umbrales de daño locales (NLTHA).
 *
 * Expone 5 valores que determinan cuándo un elemento cruza cada estado de
 * daño: fluencia (ε_sy), aplastamiento del recubrimiento (ε_cu_cover) y del
 * núcleo confinado (ε_cu_core), pandeo del refuerzo (ε_bk) y fractura por
 * tensión (ε_su). Dos de ellos (ε_cu_core y ε_bk) son por elemento — para
 * ellos se muestra el rango observado y permite "forzar valor global".
 *
 * Comportamiento:
 *   - Al cambiar un valor dispara un recálculo tras 500 ms (auto-apply).
 *   - Botón "Recalcular estados de daño" fuerza el recálculo inmediato.
 *   - Panel abierto por default (siempre visible en la cabecera de eventos).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  NLTHThresholdsMeta, ThresholdKey, ThresholdStats,
} from "@/lib/structural-types";

type Overrides = Partial<Record<ThresholdKey, number>>;

type ThresholdSpec = {
  key:   ThresholdKey;
  label: string;
  hint:  string;
  perElement: boolean;
};

const SPECS: ThresholdSpec[] = [
  { key: "eps_sy",       label: "ε_sy",       hint: "Fluencia del acero (fy/E)",             perElement: false },
  { key: "eps_cu_cover", label: "ε_cu,cover", hint: "Aplastamiento del recubrimiento",       perElement: false },
  { key: "eps_cu_core",  label: "ε_cu,core",  hint: "Aplastamiento del núcleo (Mander)",     perElement: true  },
  { key: "eps_bk",       label: "ε_bk",       hint: "Pandeo del refuerzo (Dhakal-Maekawa)",  perElement: true  },
  { key: "eps_su",       label: "ε_su",       hint: "Fractura por tensión del acero",        perElement: false },
];

export interface DamageThresholdsPanelProps {
  meta:        NLTHThresholdsMeta | null;
  busy?:       boolean;
  onApply:     (overrides: Overrides) => void;
}

export function DamageThresholdsPanel({
  meta, busy = false, onApply,
}: DamageThresholdsPanelProps) {
  // Estado local = valores actualmente editados; `undefined` = usar default/spec.
  const [values, setValues] = useState<Overrides>(meta?.user_override ?? {});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sincroniza si el meta inicial cambia (al cargar).
  useEffect(() => {
    if (meta?.user_override) setValues(meta.user_override);
  }, [meta?.user_override]);

  const scheduleApply = useCallback((next: Overrides) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onApply(next), 500);
  }, [onApply]);

  const change = (key: ThresholdKey, raw: string) => {
    const next = { ...values };
    if (raw === "") delete next[key];
    else {
      const v = Number(raw);
      if (!Number.isFinite(v) || v <= 0) return;
      next[key] = v;
    }
    setValues(next);
    scheduleApply(next);
  };

  const resetAll = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setValues({});
    onApply({});
  };

  const applyNow = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    onApply(values);
  };

  const hasOverrides = useMemo(
    () => Object.keys(values).some((k) => values[k as ThresholdKey] !== undefined),
    [values],
  );

  if (!meta) {
    return (
      <section className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
        Cargando umbrales de daño...
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <header className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">
            Umbrales de daño aplicados
          </h3>
          <p className="text-[11px] text-slate-500">
            Edita un valor para forzarlo globalmente; vacío = usar valor por
            elemento (spec/Mander). Auto-recálculo tras 500 ms.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {busy && (
            <span className="text-[11px] text-amber-600 font-medium animate-pulse">
              Recalculando…
            </span>
          )}
          <button
            type="button"
            onClick={applyNow}
            disabled={busy}
            className="rounded border border-slate-300 bg-slate-50 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            Recalcular estados de daño
          </button>
          <button
            type="button"
            onClick={resetAll}
            disabled={busy || !hasOverrides}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            title="Restaurar valores por defecto / por elemento"
          >
            Restaurar
          </button>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2 lg:grid-cols-5">
        {SPECS.map((s) => (
          <ThresholdInput
            key={s.key}
            spec={s}
            value={values[s.key]}
            defaultValue={meta.defaults[s.key]}
            observed={meta.observed[s.key]}
            onChange={(raw) => change(s.key, raw)}
          />
        ))}
      </div>
    </section>
  );
}

function ThresholdInput({
  spec, value, defaultValue, observed, onChange,
}: {
  spec:         ThresholdSpec;
  value:        number | undefined;
  defaultValue: number | undefined;
  observed:     ThresholdStats | undefined;
  onChange:     (raw: string) => void;
}) {
  const [raw, setRaw] = useState<string>(value !== undefined ? String(value) : "");
  useEffect(() => {
    setRaw(value !== undefined ? String(value) : "");
  }, [value]);

  const source = value !== undefined
    ? { label: "Custom", color: "bg-amber-100 text-amber-800 border-amber-300" }
    : spec.perElement
      ? { label: "Spec/Mander", color: "bg-sky-100 text-sky-800 border-sky-300" }
      : { label: "Default", color: "bg-slate-100 text-slate-700 border-slate-300" };

  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-2">
      <div className="flex items-center justify-between gap-2">
        <label className="font-mono text-[12px] font-semibold text-slate-900">
          {spec.label}
        </label>
        <span className={`rounded border px-1.5 py-[1px] text-[9px] font-medium ${source.color}`}>
          {source.label}
        </span>
      </div>
      <p className="mt-0.5 text-[10px] leading-tight text-slate-500">{spec.hint}</p>
      <input
        type="number"
        step={spec.key === "eps_sy" ? 0.0001 : 0.001}
        min={0}
        value={raw}
        placeholder={spec.perElement
          ? (observed ? `${observed.min.toFixed(4)}–${observed.max.toFixed(4)}` : "por elemento")
          : (defaultValue !== undefined ? defaultValue.toFixed(4) : "")}
        onChange={(e) => { setRaw(e.target.value); onChange(e.target.value); }}
        className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-[12px] text-slate-900 focus:border-slate-500 focus:outline-none"
      />
      <div className="mt-1 flex items-center justify-between text-[10px] text-slate-500">
        <span>default: <span className="font-mono">{defaultValue?.toFixed(4) ?? "—"}</span></span>
        {observed && observed.n > 0 && (
          <span title={`${observed.n} elementos`}>
            obs: <span className="font-mono">{observed.min.toFixed(4)}–{observed.max.toFixed(4)}</span>
          </span>
        )}
      </div>
    </div>
  );
}
