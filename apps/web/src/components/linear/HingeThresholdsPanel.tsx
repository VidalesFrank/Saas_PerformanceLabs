"use client";

import { useMemo } from "react";
import type {
  HingeDamageLevel, HingeRecord, HingeThresholds,
} from "@/lib/structural-types";

interface Props {
  value:     HingeThresholds;
  onChange:  (v: HingeThresholds) => void;
  /** Rótulas enriquecidas con theta_p_hist (para preview de conteos). */
  hinges:    HingeRecord[];
}

export const ASCE41_DMO: HingeThresholds = {
  beam:       { IO: 0.010, LS: 0.020, CP: 0.030 },
  column:     { IO: 0.005, LS: 0.012, CP: 0.020 },
  infill:     { IO: 0.0025, LS: 0.0070, CP: 0.0120 },
  applyKConf: true,
};

export const ASCE41_DES: HingeThresholds = {
  beam:       { IO: 0.015, LS: 0.025, CP: 0.040 },
  column:     { IO: 0.007, LS: 0.015, CP: 0.025 },
  infill:     { IO: 0.0025, LS: 0.0070, CP: 0.0120 },
  applyKConf: true,
};

type PresetKey = "DMO" | "DES" | "custom";

const LEVEL_COLOR: Record<HingeDamageLevel, string> = {
  none:     "#64748b",
  near_io:  "#38bdf8",
  io:       "#22c55e",
  ls:       "#eab308",
  cp:       "#f97316",
  collapse: "#ef4444",
};
const LEVEL_LABEL: Record<HingeDamageLevel, string> = {
  none:     "Elástico",
  near_io:  "~IO",
  io:       "IO",
  ls:       "LS",
  cp:       "CP",
  collapse: "Post-CP",   // Rótula local post-CP (ASCE 41) — NO implica colapso del edificio
};

/** Clasifica un θ_p contra los umbrales (en rad). Replica _classify del backend. */
export function classifyWithThresholds(
  theta_p: number, io: number, ls: number, cp: number,
): HingeDamageLevel {
  if (theta_p < 0.5 * io) return "none";
  if (theta_p < io)       return "near_io";
  if (theta_p < ls)       return "io";
  if (theta_p < cp)       return "ls";
  if (theta_p < 1.5 * cp) return "cp";
  return "collapse";
}

/** Umbrales efectivos (rad) para una rótula bajo los sliders actuales. */
export function effectiveThresholds(h: HingeRecord, t: HingeThresholds) {
  const base = h.kind === "column" ? t.column : t.beam;
  const k = t.applyKConf ? (h.k_conf ?? 1.0) : 1.0;
  return { IO: base.IO * k, LS: base.LS * k, CP: base.CP * k };
}

function arePresetEqual(a: HingeThresholds, b: HingeThresholds): boolean {
  return (
    a.applyKConf === b.applyKConf &&
    a.beam.IO === b.beam.IO && a.beam.LS === b.beam.LS && a.beam.CP === b.beam.CP &&
    a.column.IO === b.column.IO && a.column.LS === b.column.LS && a.column.CP === b.column.CP &&
    a.infill.IO === b.infill.IO && a.infill.LS === b.infill.LS && a.infill.CP === b.infill.CP
  );
}

/** Clasifica nivel de daño de un infill según la deriva del panel (fracción). */
export function classifyInfillByDrift(
  drift: number, io: number, ls: number, cp: number,
): "none" | "cracking" | "degrading" | "collapse" {
  const d = Math.abs(drift);
  if (d < io) return "none";
  if (d < ls) return "cracking";
  if (d < cp) return "degrading";
  return "collapse";
}

function matchPreset(v: HingeThresholds): PresetKey {
  if (arePresetEqual(v, ASCE41_DMO)) return "DMO";
  if (arePresetEqual(v, ASCE41_DES)) return "DES";
  return "custom";
}


export default function HingeThresholdsPanel({ value, onChange, hinges }: Props) {
  const preset = matchPreset(value);

  // ── Conteos vivos: clasifica cada rótula por su θ_p MÁXIMO del pushover ──────
  const counts = useMemo(() => {
    const c: Record<HingeDamageLevel, number> = {
      none: 0, near_io: 0, io: 0, ls: 0, cp: 0, collapse: 0,
    };
    for (const h of hinges) {
      const { IO, LS, CP } = effectiveThresholds(h, value);
      c[classifyWithThresholds(h.theta_p_max, IO, LS, CP)]++;
    }
    return c;
  }, [hinges, value]);

  function setBeam(k: "IO" | "LS" | "CP", v: number) {
    onChange({ ...value, beam: { ...value.beam, [k]: v } });
  }
  function setColumn(k: "IO" | "LS" | "CP", v: number) {
    onChange({ ...value, column: { ...value.column, [k]: v } });
  }
  function setInfill(k: "IO" | "LS" | "CP", v: number) {
    onChange({ ...value, infill: { ...value.infill, [k]: v } });
  }
  function applyPreset(p: PresetKey) {
    if (p === "DMO") onChange(ASCE41_DMO);
    else if (p === "DES") onChange(ASCE41_DES);
    // "custom": no-op; el usuario edita libremente
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex flex-col">
          <h4 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
            Umbrales de daño (ASCE 41-17 §10.3 + infills por deriva)
          </h4>
          <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
            Rótulas: rotación plástica θ_p en rad. Infills: deriva relativa del
            panel (%). Ajusta y re-evalúa sin re-correr el análisis.
          </p>
        </div>
        <div className="flex items-center gap-1">
          {(["DMO", "DES", "custom"] as PresetKey[]).map((p) => (
            <button
              key={p}
              onClick={() => applyPreset(p)}
              className={[
                "px-2.5 py-1 rounded text-[11px] font-medium transition-colors",
                preset === p
                  ? "bg-[var(--accent)] text-white"
                  : "bg-[var(--surface-2)] text-[var(--text-muted)] hover:text-[var(--text)]",
              ].join(" ")}
              title={
                p === "DMO" ? "DMO: controlled by flexure, Tabla 10-7 / 10-8"
                : p === "DES" ? "DES: zonas de disipación especial (valores elevados)"
                : "Edición libre de valores"
              }
            >
              {p === "DMO" ? "ASCE 41 · DMO" : p === "DES" ? "ASCE 41 · DES" : "Personalizado"}
            </button>
          ))}
        </div>
      </div>

      {/* Grid de inputs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <ThresholdRow
          title="Vigas · θ_p (rad)"
          unit="rad"
          values={value.beam}
          onChange={setBeam}
        />
        <ThresholdRow
          title="Columnas · θ_p (rad)"
          unit="rad"
          values={value.column}
          onChange={setColumn}
        />
        <ThresholdRow
          title="Infills · deriva de piso (%)"
          unit="pct"
          values={value.infill}
          onChange={setInfill}
        />
      </div>

      {/* Toggle k_conf */}
      <label className="flex items-center gap-2 text-[11px] cursor-pointer select-none">
        <input
          type="checkbox"
          checked={value.applyKConf}
          onChange={(e) => onChange({ ...value, applyKConf: e.target.checked })}
        />
        <span className="text-[var(--text)]">Aplicar factor por confinamiento (Mander k_conf = ρ_s / 0.012)</span>
        <span className="text-[var(--text-muted)] italic">
          — escala θ_IO/LS/CP de cada rótula según el estribo de su diseño
        </span>
      </label>

      {/* Resumen de conteos */}
      <div className="flex flex-col gap-1.5">
        <p className="text-[11px] text-[var(--text-muted)]">
          Distribución final de las {hinges.length} rótulas (θ_p máximo del pushover):
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          {(["io", "ls", "cp", "collapse"] as HingeDamageLevel[]).map((lv) => (
            <div
              key={lv}
              className="px-2 py-1 rounded text-[10px] font-mono flex items-center gap-1.5"
              style={{ background: `${LEVEL_COLOR[lv]}22`, color: LEVEL_COLOR[lv] }}
            >
              <span className="w-2 h-2 rounded-full" style={{ background: LEVEL_COLOR[lv] }} />
              <span className="font-semibold">{LEVEL_LABEL[lv]}</span>
              <span>{counts[lv]}</span>
            </div>
          ))}
          <div className="px-2 py-1 rounded text-[10px] font-mono flex items-center gap-1.5 text-[var(--text-muted)] bg-[var(--surface-2)]">
            Pre-IO {counts.near_io} · Elástico {counts.none}
          </div>
        </div>
      </div>
    </div>
  );
}


function ThresholdRow({
  title, unit, values, onChange,
}: {
  title:    string;
  unit:     "rad" | "pct";
  values:   { IO: number; LS: number; CP: number };
  onChange: (k: "IO" | "LS" | "CP", v: number) => void;
}) {
  // "rad": valor interno y mostrado = rad (step 0.001, 4 decimales)
  // "pct": interno = fracción, mostrado = %
  const toDisplay = (x: number) => unit === "rad" ? x : x * 100;
  const toInternal = (x: number) => unit === "rad" ? x : x / 100;
  const step  = unit === "rad" ? 0.001 : 0.05;
  const decs  = unit === "rad" ? 4 : 2;
  const label = unit === "rad" ? "rad" : "%";

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 flex flex-col gap-2">
      <p className="text-[11px] font-semibold text-[var(--text)]">{title}</p>
      <div className="grid grid-cols-3 gap-2">
        {(["IO", "LS", "CP"] as const).map((k) => (
          <label key={k} className="flex flex-col gap-1 text-[10px]">
            <span className="text-[var(--text-muted)] font-semibold">
              {k} ({label})
            </span>
            <input
              type="number"
              step={step}
              min={0}
              value={+toDisplay(values[k]).toFixed(decs)}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (!isFinite(v) || v < 0) return;
                onChange(k, toInternal(v));
              }}
              className="w-full px-1.5 py-1 rounded bg-[var(--surface)] text-[var(--text)] font-mono text-[11px] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]"
            />
          </label>
        ))}
      </div>
    </div>
  );
}
