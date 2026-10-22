"use client";

/**
 * Panel premium — Refuerzo por sección (as-built).
 *
 * Permite definir, para cada sección geométrica del modelo (C40x40, V30x40…),
 * un patrón de refuerzo longitudinal + transversal que se aplicará a TODOS los
 * elementos que la usen. Pensado para evaluar edificios ya construidos donde
 * no corre el diseño automático: el usuario introduce el refuerzo observado en
 * obra y ese es el que alimenta el análisis no lineal (pushover / NLTHA / N2).
 *
 * Capas:
 *   1. Modo Auto    → sin patrón, cae al diseño automático o defaults ρ=1%.
 *   2. Modo Manual  → patrón as-built aplicado a toda la sección.
 *   3. Override individual por elemento (F3, no en esta pantalla).
 *
 * NSR-10 soft: se muestran advertencias si incumple C.21/C.10, pero NO bloquea.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { structuralDesignApi } from "@/lib/structural-api";
import type {
  SectionReinforcementItem,
  SectionReinforcementList,
  SectionPattern,
  SectionPatternColumn,
  SectionPatternBeam,
  ColumnReinfLongitudinal,
  ColumnReinfTransverse,
  ColumnBarGroup,
  ColumnBarGroups,
  BeamZones,
  BeamShear,
  ReinforcementNSR10Result,
  ReinforcementNSR10Warning,
  SaveSectionReinforcementPayload,
} from "@/lib/structural-types";

// ── Catálogo ASTM / NSR-10 ──────────────────────────────────────────────────
const BAR_SIZES = ["#3", "#4", "#5", "#6", "#7", "#8", "#9", "#10", "#11"] as const;
const BAR_DIAM_MM: Record<string, number> = {
  "#3":  9.5,  "#4": 12.7,  "#5": 15.9,  "#6": 19.1,  "#7": 22.2,
  "#8": 25.4,  "#9": 28.7,  "#10": 32.3, "#11": 35.8,
};
const BAR_AREA_CM2: Record<string, number> = Object.fromEntries(
  Object.entries(BAR_DIAM_MM).map(([k, d]) => [k, +(Math.PI * (d / 10) ** 2 / 4).toFixed(3)]),
);

function barArea(label: string, nBars: number): number {
  return +(BAR_AREA_CM2[label] ?? 2.0) * Math.max(nBars, 0);
}

function makeGroup(bar_label: string, n_bars: number): ColumnBarGroup {
  return {
    bar_label,
    n_bars,
    db_mm:  BAR_DIAM_MM[bar_label],
    As_cm2: +barArea(bar_label, n_bars).toFixed(3),
  };
}

function groupsTotalBars(g: ColumnBarGroups): number {
  return (g.corners.n_bars ?? 0) + g.top_face.n_bars + g.bot_face.n_bars
       + g.left_face.n_bars + g.right_face.n_bars;
}

function groupsTotalAs(g: ColumnBarGroups): number {
  return [g.corners, g.top_face, g.bot_face, g.left_face, g.right_face]
    .reduce((acc, grp) => acc + (grp.As_cm2 ?? barArea(grp.bar_label, grp.n_bars)), 0);
}

// ── Defaults razonables al pasar a modo manual ──────────────────────────────
function defaultColumnPattern(b_m: number, h_m: number): {
  longitudinal: ColumnReinfLongitudinal;
  transverse:   ColumnReinfTransverse;
} {
  // Esquinas #6 + 2 intermedias por cara #5 → 12 barras, ρ ≈ 1.5-2% típico
  const groups: ColumnBarGroups = {
    corners:    makeGroup("#6", 4),
    top_face:   makeGroup("#5", 2),
    bot_face:   makeGroup("#5", 2),
    left_face:  makeGroup("#5", 2),
    right_face: makeGroup("#5", 2),
  };
  return {
    longitudinal: {
      groups,
      n_bars:    groupsTotalBars(groups),
      bar_label: "#6",
      As_cm2:    +groupsTotalAs(groups).toFixed(2),
    },
    transverse: {
      tie_bar_label:     "#3",
      n_legs_b:          2,
      n_legs_h:          2,
      s_confined_mm:     100,
      s_general_mm:      200,
      L_confinement_mm:  Math.round(Math.max(b_m, h_m) * 1000),
    },
  };
}

/** Si viene un patrón legacy sin groups, los infiere. Operación idempotente. */
function ensureGroups(longitudinal: ColumnReinfLongitudinal): ColumnReinfLongitudinal {
  if (longitudinal.groups && longitudinal.groups.corners) return longitudinal;
  const label = longitudinal.bar_label ?? "#6";
  const n_total = Math.max(4, longitudinal.n_bars ?? 4);
  const extra = n_total - 4;
  const n_tb = Math.floor(extra / 2);
  const n_lr = extra - n_tb;
  const groups: ColumnBarGroups = {
    corners:    makeGroup(label, 4),
    top_face:   makeGroup(label, Math.floor(n_tb / 2)),
    bot_face:   makeGroup(label, n_tb - Math.floor(n_tb / 2)),
    left_face:  makeGroup(label, Math.floor(n_lr / 2)),
    right_face: makeGroup(label, n_lr - Math.floor(n_lr / 2)),
  };
  return {
    ...longitudinal,
    groups,
    n_bars:    groupsTotalBars(groups),
    bar_label: label,
    As_cm2:    +groupsTotalAs(groups).toFixed(2),
  };
}

function defaultBeamPattern(b_m: number, h_m: number): {
  zones: BeamZones; shear: BeamShear;
} {
  const _z = () => ({
    top: { n_bars: 3, bar_label: "#5", As_cm2: +barArea("#5", 3).toFixed(2) },
    bot: { n_bars: 2, bar_label: "#5", As_cm2: +barArea("#5", 2).toFixed(2) },
  });
  return {
    zones: { end_i: _z(), mid: _z(), end_j: _z() },
    shear: {
      tie_bar_label:     "#3",
      n_legs:            2,
      s_confined_mm:     100,
      s_central_mm:      200,
      L_confinement_mm:  Math.round(2 * h_m * 1000),
    },
  };
}

// ── Props ────────────────────────────────────────────────────────────────────
interface Props {
  projectId: string;
}

// ── Panel principal ─────────────────────────────────────────────────────────
export default function FrameReinforcementPanel({ projectId }: Props) {
  const [list, setList]       = useState<SectionReinforcementList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [filter, setFilter]   = useState<"all" | "column" | "beam">("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const refresh = useCallback(() => { setReloadTick((n) => n + 1); }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true); setError(null);
        const data = await structuralDesignApi.listSectionReinforcement(projectId);
        if (!cancelled) setList(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Error cargando secciones.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, reloadTick]);

  const sections = useMemo(() => {
    if (!list) return [];
    if (filter === "all") return list.sections;
    return list.sections.filter((s) => s.element_type === filter);
  }, [list, filter]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-16">
        <p className="text-sm text-[var(--text-muted)] animate-pulse">Cargando secciones…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-700 m-4">
        {error}
      </div>
    );
  }
  if (!list || list.sections.length === 0) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-8 text-sm text-[var(--text-muted)] m-4">
        No se encontraron secciones de pórticos (columnas o vigas) en el modelo.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Cabecera + filtros + resumen */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--text)]">
              Refuerzo por sección (as-built)
            </h3>
            <p className="text-[11px] text-[var(--text-muted)] mt-1 max-w-2xl">
              Define el refuerzo real de cada sección geométrica. El patrón
              aplica a todos los elementos que la usen. Pensado para edificios
              existentes: NSR-10 solo advierte, no bloquea el guardado.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <KpiMini label="Secciones" value={list.n_total} />
            <KpiMini label="Manual (as-built)" value={list.n_manual} color="#2563eb" />
            <KpiMini label="Auto / Diseño"     value={list.n_auto}   color="#94a3b8" />
          </div>
        </div>
        <div className="flex items-center gap-2 mt-4">
          {(["all", "column", "beam"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors ${
                filter === f
                  ? "bg-[var(--accent)] text-white"
                  : "bg-[var(--surface-2)] text-[var(--text-muted)] hover:text-[var(--text)]"
              }`}
            >
              {f === "all" ? "Todas" : f === "column" ? "Columnas" : "Vigas"}
            </button>
          ))}
        </div>
      </div>

      {/* Tabla con filas expandibles */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
        <div className="grid grid-cols-[160px_80px_90px_1fr_120px_60px] gap-2 px-4 py-2 bg-[var(--surface-2)] text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          <div>Sección</div>
          <div>Tipo</div>
          <div className="text-right"># Elementos</div>
          <div>Resumen de refuerzo</div>
          <div className="text-center">Modo</div>
          <div></div>
        </div>
        <div className="divide-y divide-[var(--border)]">
          {sections.map((s) => (
            <SectionRow
              key={s.section_key}
              section={s}
              isOpen={expanded === s.section_key}
              onToggle={() => setExpanded(expanded === s.section_key ? null : s.section_key)}
              projectId={projectId}
              onChanged={async () => refresh()}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Fila con panel expandible ───────────────────────────────────────────────
function SectionRow({
  section, isOpen, onToggle, projectId, onChanged,
}: {
  section: SectionReinforcementItem;
  isOpen:  boolean;
  onToggle: () => void;
  projectId: string;
  onChanged: () => void | Promise<void>;
}) {
  const summary    = reinfSummary(section);
  const dim        = `${(section.h_m * 100).toFixed(0)}×${(section.b_m * 100).toFixed(0)} cm`;

  return (
    <div>
      <button
        onClick={onToggle}
        className="w-full grid grid-cols-[160px_80px_90px_1fr_120px_60px] gap-2 px-4 py-3 items-center text-left hover:bg-[var(--surface-2)]/50 transition-colors"
      >
        <div>
          <p className="text-sm font-semibold text-[var(--text)] truncate">{section.section_name}</p>
          <p className="text-[10px] font-mono text-[var(--text-muted)]">{dim} · fc={section.fc_MPa} MPa</p>
        </div>
        <div>
          <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold ${
            section.element_type === "column"
              ? "bg-blue-100 text-blue-700"
              : "bg-emerald-100 text-emerald-700"
          }`}>
            {section.element_type === "column" ? "Columna" : "Viga"}
          </span>
        </div>
        <div className="text-right">
          <p className="text-sm font-mono text-[var(--text)]">{section.n_elements}</p>
          {section.n_overrides > 0 && (
            <p className="text-[9px] text-amber-600 font-mono">+{section.n_overrides} override</p>
          )}
        </div>
        <div className="text-xs font-mono text-[var(--text-muted)] truncate">{summary}</div>
        <div className="flex items-center justify-center">
          <ModeBadge mode={section.mode} label={section.pattern_label} />
        </div>
        <div className="text-right text-[var(--text-muted)]">
          <span className={`inline-block transition-transform ${isOpen ? "rotate-90" : ""}`}>›</span>
        </div>
      </button>

      {isOpen && (
        <SectionEditor
          section={section}
          projectId={projectId}
          onChanged={async () => { await onChanged(); }}
        />
      )}
    </div>
  );
}

function ModeBadge({ mode, label }: { mode: "auto" | "manual"; label: string | null }) {
  if (mode === "manual") {
    return (
      <span className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-[10px] font-semibold flex items-center gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
        Manual{label ? ` · ${label}` : ""}
      </span>
    );
  }
  return (
    <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[10px] font-semibold">
      Auto
    </span>
  );
}

function KpiMini({ label, value, color }: { label: string; value: number; color?: string }) {
  const c = color ?? "var(--text)";
  return (
    <div className="text-right">
      <p className="text-[9px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">{label}</p>
      <p className="text-xl font-bold font-mono" style={{ color: c }}>{value}</p>
    </div>
  );
}

function reinfSummary(s: SectionReinforcementItem): string {
  if (s.mode !== "manual" || !s.pattern) return "— sin patrón (diseño automático o defaults)";
  if (s.element_type === "column") {
    const p = s.pattern as SectionPatternColumn;
    const g = p.longitudinal.groups;
    const n = p.longitudinal.n_bars ?? 0;
    if (g && g.corners) {
      // Muestra los grupos activos, uniendo iguales
      const by_label: Record<string, number> = {};
      [["esq.", g.corners], ["sup", g.top_face], ["inf", g.bot_face],
       ["izq", g.left_face], ["der", g.right_face]].forEach(([_lbl, grp]) => {
        const gg = grp as ColumnBarGroup;
        if (gg.n_bars > 0) {
          by_label[gg.bar_label] = (by_label[gg.bar_label] ?? 0) + gg.n_bars;
        }
      });
      const long = Object.entries(by_label).map(([lb, n]) => `${n}·${lb}`).join(" + ");
      return `${n} long. (${long}) · ${p.transverse.tie_bar_label}@${p.transverse.s_confined_mm}/${p.transverse.s_general_mm} · ${p.transverse.n_legs_b}×${p.transverse.n_legs_h} ramas`;
    }
    return `${n}·${p.longitudinal.bar_label ?? "#"} long. · ${p.transverse.tie_bar_label}@${p.transverse.s_confined_mm}/${p.transverse.s_general_mm} · ${p.transverse.n_legs_b}×${p.transverse.n_legs_h} ramas`;
  }
  const p = s.pattern as SectionPatternBeam;
  const ei = p.zones.end_i;
  return `end_i: ${ei.top.n_bars}·${ei.top.bar_label}↑ ${ei.bot.n_bars}·${ei.bot.bar_label}↓ · estribos ${p.shear.tie_bar_label}@${p.shear.s_confined_mm}/${p.shear.s_central_mm} mm`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Editor expandible (columna o viga)
// ─────────────────────────────────────────────────────────────────────────────
function SectionEditor({
  section, projectId, onChanged,
}: {
  section:   SectionReinforcementItem;
  projectId: string;
  onChanged: () => Promise<void>;
}) {
  const initialPattern = (): SectionPattern => {
    if (section.pattern) return section.pattern;
    if (section.element_type === "column") {
      const d = defaultColumnPattern(section.b_m, section.h_m);
      return {
        mode: "manual", element_type: "column", section_name: section.section_name,
        pattern_label: null, notes: null, updated_at: "", ...d,
      };
    }
    const d = defaultBeamPattern(section.b_m, section.h_m);
    return {
      mode: "manual", element_type: "beam", section_name: section.section_name,
      pattern_label: null, notes: null, updated_at: "", ...d,
    };
  };

  const [draft, setDraft]       = useState<SectionPattern>(initialPattern());
  const [label, setLabel]       = useState<string>(section.pattern_label ?? "");
  const [saving, setSaving]     = useState(false);
  const [removing, setRemoving] = useState(false);
  const [validation, setValidation] = useState<ReinforcementNSR10Result | null>(null);
  const [actionErr, setActionErr]   = useState<string | null>(null);

  // Validación en vivo (debounced vía efecto por cambio)
  useEffect(() => {
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const payload = patternToValidationPayload(draft);
          const r = await structuralDesignApi.validateSectionReinforcement(
            projectId, section.element_type, section.section_name, payload,
          );
          setValidation(r);
        } catch {
          setValidation(null);
        }
      })();
    }, 400);
    return () => clearTimeout(timer);
  }, [draft, projectId, section.element_type, section.section_name]);

  const save = async () => {
    setSaving(true); setActionErr(null);
    try {
      const payload = patternToSavePayload(draft, label || null);
      await structuralDesignApi.saveSectionReinforcement(
        projectId, section.element_type, section.section_name, payload,
      );
      await onChanged();
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : "No se pudo guardar.");
    } finally { setSaving(false); }
  };

  const resetToAuto = async () => {
    setRemoving(true); setActionErr(null);
    try {
      await structuralDesignApi.deleteSectionReinforcement(
        projectId, section.element_type, section.section_name,
      );
      await onChanged();
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : "No se pudo revertir.");
    } finally { setRemoving(false); }
  };

  return (
    <div className="px-4 py-4 border-t border-[var(--border)] bg-[var(--surface-2)]/40">
      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr_auto] gap-4">
        {/* Preview */}
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 flex flex-col items-center">
          <ReinforcementSVG
            section={section}
            pattern={draft}
          />
          <p className="text-[10px] text-[var(--text-muted)] font-mono mt-2">
            {(section.h_m * 100).toFixed(0)} × {(section.b_m * 100).toFixed(0)} cm
          </p>
          {draft.element_type === "column" && (
            <div className="mt-1 flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-[9px]">
              <LegendDot color={GROUP_COLORS.corners}    label="Esquinas" />
              <LegendDot color={GROUP_COLORS.top_face}   label="Sup." />
              <LegendDot color={GROUP_COLORS.bot_face}   label="Inf." />
              <LegendDot color={GROUP_COLORS.left_face}  label="Izq." />
              <LegendDot color={GROUP_COLORS.right_face} label="Der." />
            </div>
          )}
          <ValidationChips validation={validation} />
        </div>

        {/* Formulario */}
        <div className="flex flex-col gap-3">
          {draft.element_type === "column"
            ? <ColumnForm pattern={draft as SectionPatternColumn} onChange={setDraft} />
            : <BeamForm   pattern={draft as SectionPatternBeam}   onChange={setDraft} />}
          <div>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                Etiqueta del patrón (opcional)
              </span>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="p.ej. Columnas tipo 1 — niveles 1-4"
                className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface)] text-sm"
              />
            </label>
          </div>
        </div>

        {/* Acciones */}
        <div className="flex flex-col gap-2 items-stretch min-w-[180px]">
          <button
            onClick={save}
            disabled={saving || removing}
            className="px-4 py-2 rounded-md text-sm font-semibold bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40"
          >
            {saving ? "Guardando…"
                    : (section.mode === "manual" ? "Actualizar patrón" : "Guardar patrón manual")}
          </button>
          {section.mode === "manual" && (
            <button
              onClick={resetToAuto}
              disabled={saving || removing}
              className="px-4 py-2 rounded-md text-sm font-medium bg-[var(--surface)] text-[var(--text-muted)] border border-[var(--border)] hover:text-[var(--text)]"
            >
              {removing ? "Revirtiendo…" : "Volver a modo auto"}
            </button>
          )}
          <p className="text-[10px] text-[var(--text-muted)] mt-1">
            Al guardar, se invalida el modelo no lineal cacheado y los próximos
            análisis se corren con este refuerzo para los <b>{section.n_elements}</b> elementos
            que usan la sección.
          </p>
          {actionErr && (
            <div className="rounded border border-red-300 bg-red-50 px-2 py-1 text-[11px] text-red-700">
              {actionErr}
            </div>
          )}
        </div>
      </div>

      {/* Lp observada — aplicar a toda la sección (atajo UI) */}
      <ApplyLpToSectionBlock
        projectId={projectId}
        sectionName={section.section_name}
        kind={section.element_type}
        nElements={section.n_elements}
      />

      {/* Overrides individuales por elemento */}
      <ElementOverridesBlock
        projectId={projectId}
        section={section}
        inheritedPattern={draft}
        onChanged={onChanged}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Lp observada → aplicar a todos los elementos de esta sección
// ─────────────────────────────────────────────────────────────────────────────
function ApplyLpToSectionBlock({
  projectId, sectionName, kind, nElements,
}: {
  projectId:   string;
  sectionName: string;
  kind:        "column" | "beam";
  nElements:   number;
}) {
  const [lp, setLp]       = useState<string>("");
  const [applying, setA]  = useState(false);
  const [msg, setMsg]     = useState<{ ok: boolean; text: string } | null>(null);

  async function apply() {
    const value = parseFloat(lp);
    if (!value || value <= 0 || value > 2000) {
      setMsg({ ok: false, text: "Lp debe estar entre 1 y 2000 mm" });
      return;
    }
    setA(true);
    setMsg(null);
    try {
      const { elementThresholdsApi } = await import("@/lib/structural-api");
      const r = await elementThresholdsApi.applyLpToSection(
        projectId, sectionName, kind, value,
      );
      setMsg({ ok: true,
               text: `Lp = ${value} mm aplicada a ${r.n_elements} elementos` });
    } catch (e) {
      setMsg({ ok: false,
               text: e instanceof Error ? e.message : String(e) });
    } finally {
      setA(false);
    }
  }

  return (
    <div className="mt-4 pt-4 border-t border-[var(--border)]">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1 text-sm text-[var(--text)]">
          <span>📏</span>
          <span className="font-medium">Lp medida en campo:</span>
        </div>
        <input
          type="number" step="10" min="1" max="2000" placeholder="mm"
          value={lp}
          onChange={(e) => setLp(e.target.value)}
          disabled={applying}
          className="w-24 px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface)] text-sm"
        />
        <button
          onClick={apply}
          disabled={applying || !lp}
          className="px-3 py-1.5 rounded text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
        >
          {applying ? "Aplicando…" : `Aplicar a los ${nElements} elementos`}
        </button>
        {msg && (
          <span className={`text-[11px] ${msg.ok ? "text-green-700" : "text-red-700"}`}>
            {msg.text}
          </span>
        )}
      </div>
      <p className="text-[10px] text-[var(--text-muted)] mt-1">
        Al aplicar Lp observada, el cálculo de capacidad de rotación para esos
        elementos pasa al método mecánico (Priestley) con esa Lp real, en vez
        de la calibración empírica de Haselton.
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Overrides individuales por elemento
// ─────────────────────────────────────────────────────────────────────────────
function ElementOverridesBlock({
  projectId, section, inheritedPattern, onChanged,
}: {
  projectId:        string;
  section:          SectionReinforcementItem;
  inheritedPattern: SectionPattern;
  onChanged:        () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, SectionPattern>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [storyFilter, setStoryFilter] = useState<string>("");
  const [loading, setLoading] = useState(false);

  const loadOverrides = useCallback(async () => {
    try {
      setLoading(true);
      const data = await structuralDesignApi.listFrameOverrides(projectId);
      // Filtrar solo los frames de esta sección
      const out: Record<string, SectionPattern> = {};
      for (const fid of section.frame_ids) {
        const v = data.overrides[fid];
        if (!v) continue;
        const r = v.reinforcement as Record<string, unknown>;
        if (section.element_type === "column") {
          out[fid] = {
            mode: "manual", element_type: "column",
            section_name: section.section_name,
            longitudinal: r.longitudinal as ColumnReinfLongitudinal,
            transverse:   r.transverse   as ColumnReinfTransverse,
            pattern_label: v.pattern_label, notes: v.notes,
            updated_at: v.saved_at ?? "",
          };
        } else {
          out[fid] = {
            mode: "manual", element_type: "beam",
            section_name: section.section_name,
            zones: r.zones as BeamZones,
            shear: r.shear as BeamShear,
            pattern_label: v.pattern_label, notes: v.notes,
            updated_at: v.saved_at ?? "",
          };
        }
      }
      setOverrides(out);
    } finally { setLoading(false); }
  }, [projectId, section.frame_ids, section.element_type, section.section_name]);

  useEffect(() => { if (open) void loadOverrides(); }, [open, loadOverrides]);

  const stories = useMemo(() => {
    const s = new Set(section.stories);
    return ["", ...Array.from(s)];
  }, [section.stories]);

  const visibleIds = useMemo(() => {
    // Mapa frame_id → story (desde el canonical ya no está disponible aquí; pero
    // podemos inferir del frame_id si tiene convención, o solo mostrar todos)
    return section.frame_ids;
  }, [section.frame_ids]);

  const resetOverride = async (fid: string) => {
    await structuralDesignApi.deleteFrameReinforcement(projectId, fid);
    await loadOverrides();
    await onChanged();
  };

  return (
    <div className="mt-4 border-t border-[var(--border)] pt-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] hover:text-[var(--text)]"
      >
        <span className={`transition-transform ${open ? "rotate-90" : ""}`}>›</span>
        Overrides individuales por elemento
        <span className="ml-2 text-[10px] font-mono text-amber-600">
          {section.n_overrides > 0 && `(${section.n_overrides} activos)`}
        </span>
      </button>

      {open && (
        <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
          {/* Filtro por piso */}
          {stories.length > 1 && (
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                Piso:
              </span>
              <select value={storyFilter} onChange={(e) => setStoryFilter(e.target.value)}
                className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs">
                {stories.map((s) => (
                  <option key={s} value={s}>{s === "" ? "Todos" : s}</option>
                ))}
              </select>
              <p className="text-[10px] text-[var(--text-muted)] ml-auto">
                Los overrides toman precedencia sobre el patrón de sección.
              </p>
            </div>
          )}

          {loading ? (
            <p className="text-xs text-[var(--text-muted)] italic">Cargando overrides…</p>
          ) : (
            <div className="divide-y divide-[var(--border)]/50 max-h-[320px] overflow-y-auto">
              {visibleIds.map((fid) => {
                const o = overrides[fid];
                const isEditing = editingId === fid;
                return (
                  <div key={fid} className="py-1.5">
                    <div className="flex items-center gap-2">
                      <code className="text-xs font-mono text-[var(--text)] flex-1 truncate">{fid}</code>
                      {o ? (
                        <>
                          <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[9px] font-semibold">
                            Override
                          </span>
                          <button
                            onClick={() => setEditingId(isEditing ? null : fid)}
                            className="text-[10px] text-blue-600 hover:underline"
                          >
                            {isEditing ? "Cerrar" : "Editar"}
                          </button>
                          <button
                            onClick={() => resetOverride(fid)}
                            className="text-[10px] text-red-600 hover:underline"
                          >
                            Reset
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 text-[9px] font-semibold">
                            Hereda sección
                          </span>
                          <button
                            onClick={() => setEditingId(isEditing ? null : fid)}
                            className="text-[10px] text-blue-600 hover:underline"
                          >
                            {isEditing ? "Cerrar" : "Override"}
                          </button>
                        </>
                      )}
                    </div>
                    {isEditing && (
                      <ElementOverrideEditor
                        projectId={projectId}
                        frameId={fid}
                        initial={o ?? inheritedPattern}
                        elementType={section.element_type}
                        onDone={async () => { setEditingId(null); await loadOverrides(); await onChanged(); }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ElementOverrideEditor({
  projectId, frameId, initial, elementType, onDone,
}: {
  projectId:   string;
  frameId:     string;
  initial:     SectionPattern;
  elementType: "column" | "beam";
  onDone:      () => Promise<void>;
}) {
  const [draft, setDraft] = useState<SectionPattern>(initial);
  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState<string | null>(null);

  const save = async () => {
    setSaving(true); setErr(null);
    try {
      // Reusamos el endpoint legacy PUT /frames/{fid}/reinforcement
      // (ya existe en structuralDesignApi.saveReinforcement) pasando el schema
      // completo. El NLSpecBuilder acepta ambos (con/sin wrapper).
      const reinforcement = elementType === "column"
        ? {
            longitudinal: (draft as SectionPatternColumn).longitudinal,
            transverse:   (draft as SectionPatternColumn).transverse,
          }
        : {
            zones: (draft as SectionPatternBeam).zones,
            shear: (draft as SectionPatternBeam).shear,
          };
      await structuralDesignApi.saveReinforcement(
        projectId, frameId, reinforcement as never, "override individual",
      );
      await onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error al guardar override.");
    } finally { setSaving(false); }
  };

  return (
    <div className="mt-2 ml-2 pl-3 border-l-2 border-amber-400 bg-amber-50/30 py-2 pr-2 rounded">
      {draft.element_type === "column"
        ? <ColumnForm pattern={draft as SectionPatternColumn} onChange={setDraft} />
        : <BeamForm   pattern={draft as SectionPatternBeam}   onChange={setDraft} />}
      <div className="flex items-center gap-2 mt-2">
        <button
          onClick={save} disabled={saving}
          className="px-3 py-1 rounded text-xs font-semibold bg-amber-600 text-white hover:opacity-90 disabled:opacity-40"
        >
          {saving ? "Guardando…" : "Guardar override"}
        </button>
        {err && <span className="text-[11px] text-red-600">{err}</span>}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Form para columna
// ─────────────────────────────────────────────────────────────────────────────
function ColumnForm({
  pattern, onChange,
}: {
  pattern: SectionPatternColumn;
  onChange: (p: SectionPattern) => void;
}) {
  // Asegurar que el pattern tenga groups (expand de legacy si viniera así)
  const long = ensureGroups(pattern.longitudinal);
  const groups = long.groups!;
  const t = pattern.transverse;

  const updateGroup = (key: keyof ColumnBarGroups, patch: Partial<ColumnBarGroup>) => {
    const prev = groups[key];
    const next_label = patch.bar_label ?? prev.bar_label;
    const next_n     = key === "corners" ? 4 : (patch.n_bars ?? prev.n_bars);
    const nextGroup: ColumnBarGroup = {
      bar_label: next_label,
      n_bars:    next_n,
      db_mm:     BAR_DIAM_MM[next_label],
      As_cm2:    +barArea(next_label, next_n).toFixed(3),
    };
    const newGroups: ColumnBarGroups = { ...groups, [key]: nextGroup };
    const nextLong: ColumnReinfLongitudinal = {
      groups:    newGroups,
      n_bars:    groupsTotalBars(newGroups),
      As_cm2:    +groupsTotalAs(newGroups).toFixed(2),
      bar_label: long.bar_label,
    };
    onChange({ ...pattern, longitudinal: nextLong });
  };

  const setTran = (patch: Partial<ColumnReinfTransverse>) => {
    onChange({ ...pattern, transverse: { ...t, ...patch } });
  };

  const n_total = groupsTotalBars(groups);
  const As_total = groupsTotalAs(groups);
  const Ag_cm2 = pattern.element_type === "column"
    ? // Lo correcto es tomar b×h de section — se queda en el preview;
      // aquí solo mostramos resumen
      0 : 0;
  // (ρ real se muestra en los chips NSR-10, aquí solo As)

  return (
    <div className="flex flex-col gap-3">
      {/* Longitudinal — 5 grupos */}
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <h5 className="text-xs font-semibold uppercase tracking-wider text-blue-700">
            Refuerzo longitudinal — por grupo
          </h5>
          <span className="text-[10px] font-mono text-[var(--text-muted)]">
            Total: <b className="text-[var(--text)]">{n_total} barras</b>
            {" · "}As = <b className="text-[var(--text)]">{As_total.toFixed(2)} cm²</b>
          </span>
        </div>

        <GroupRow
          label="Esquinas" color="#dc2626" fixedN={4}
          group={groups.corners}
          onChangeLabel={(v) => updateGroup("corners", { bar_label: v })}
        />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <GroupRow
            label="Cara superior (entre esquinas)" color="#2563eb"
            group={groups.top_face}
            onChangeN={(v) => updateGroup("top_face", { n_bars: v })}
            onChangeLabel={(v) => updateGroup("top_face", { bar_label: v })}
          />
          <GroupRow
            label="Cara inferior (entre esquinas)" color="#16a34a"
            group={groups.bot_face}
            onChangeN={(v) => updateGroup("bot_face", { n_bars: v })}
            onChangeLabel={(v) => updateGroup("bot_face", { bar_label: v })}
          />
          <GroupRow
            label="Cara izquierda (entre esquinas)" color="#9333ea"
            group={groups.left_face}
            onChangeN={(v) => updateGroup("left_face", { n_bars: v })}
            onChangeLabel={(v) => updateGroup("left_face", { bar_label: v })}
          />
          <GroupRow
            label="Cara derecha (entre esquinas)" color="#f59e0b"
            group={groups.right_face}
            onChangeN={(v) => updateGroup("right_face", { n_bars: v })}
            onChangeLabel={(v) => updateGroup("right_face", { bar_label: v })}
          />
        </div>
      </div>

      {/* Transversal */}
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 flex flex-col gap-2">
        <h5 className="text-xs font-semibold uppercase tracking-wider text-amber-700">
          Refuerzo transversal (estribos)
        </h5>
        <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
          <SelField label="Diámetro"  value={t.tie_bar_label} options={BAR_SIZES}
            onChange={(v) => setTran({ tie_bar_label: v })} />
          <NumField label="Ramas b"   value={t.n_legs_b}
            onChange={(v) => setTran({ n_legs_b: Math.max(2, Math.round(v)) })} step={1} min={2} />
          <NumField label="Ramas h"   value={t.n_legs_h}
            onChange={(v) => setTran({ n_legs_h: Math.max(2, Math.round(v)) })} step={1} min={2} />
          <NumField label="s conf (mm)" value={t.s_confined_mm}
            onChange={(v) => setTran({ s_confined_mm: Math.max(50, Math.round(v)) })} step={10} />
          <NumField label="s gen (mm)"  value={t.s_general_mm}
            onChange={(v) => setTran({ s_general_mm: Math.max(50, Math.round(v)) })} step={10} />
          <NumField label="L conf (mm)"  value={t.L_confinement_mm ?? 400}
            onChange={(v) => setTran({ L_confinement_mm: Math.max(100, Math.round(v)) })} step={50} />
        </div>
      </div>
    </div>
  );
}

function GroupRow({
  label, color, group, onChangeN, onChangeLabel, fixedN,
}: {
  label: string;
  color: string;
  group: ColumnBarGroup;
  onChangeN?: (v: number) => void;
  onChangeLabel: (v: string) => void;
  fixedN?: number;
}) {
  return (
    <div className="flex items-end gap-2 border-l-2 pl-2 py-1" style={{ borderColor: color }}>
      <div className="flex items-center gap-1 min-w-[52px]">
        <span className="w-2 h-2 rounded-full inline-block" style={{ background: color }} />
        <span className="text-[10px] font-mono text-[var(--text-muted)]">●●●</span>
      </div>
      <div className="flex-1">
        <p className="text-[10px] font-semibold text-[var(--text)]" style={{ color }}>
          {label}
        </p>
        <p className="text-[9px] font-mono text-[var(--text-muted)]">
          As grupo = {(group.As_cm2 ?? barArea(group.bar_label, group.n_bars)).toFixed(2)} cm²
        </p>
      </div>
      <div className="flex items-end gap-2">
        {fixedN !== undefined ? (
          <div className="flex flex-col gap-1 w-20">
            <span className="text-[9px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
              N° barras
            </span>
            <div className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-2)] text-sm font-mono text-center">
              {fixedN} <span className="text-[9px] text-[var(--text-muted)]">fijo</span>
            </div>
          </div>
        ) : (
          <div className="w-20">
            <NumField
              label="N° barras"
              value={group.n_bars}
              onChange={(v) => onChangeN?.(Math.max(0, Math.round(v)))}
              step={1} min={0}
            />
          </div>
        )}
        <div className="w-24">
          <SelField label="Diámetro" value={group.bar_label} options={BAR_SIZES}
            onChange={onChangeLabel} />
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Form para viga
// ─────────────────────────────────────────────────────────────────────────────
function BeamForm({
  pattern, onChange,
}: {
  pattern:  SectionPatternBeam;
  onChange: (p: SectionPattern) => void;
}) {
  const z = pattern.zones;
  const s = pattern.shear;

  const setZone = (zoneKey: keyof BeamZones, face: "top" | "bot",
                   patch: Partial<{ n_bars: number; bar_label: string }>) => {
    const prev = z[zoneKey][face];
    const next = { ...prev, ...patch };
    const As = +barArea(next.bar_label, next.n_bars).toFixed(2);
    const nextZone = { ...z[zoneKey], [face]: { ...next, As_cm2: As } };
    onChange({ ...pattern, zones: { ...z, [zoneKey]: nextZone } });
  };
  const setShear = (patch: Partial<BeamShear>) => {
    onChange({ ...pattern, shear: { ...s, ...patch } });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        {(["end_i", "mid", "end_j"] as const).map((zk) => (
          <div key={zk} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 flex flex-col gap-2">
            <h5 className="text-xs font-semibold uppercase tracking-wider text-emerald-700">
              Zona {zk === "end_i" ? "extrema (i)" : zk === "mid" ? "central" : "extrema (j)"}
            </h5>
            {(["top", "bot"] as const).map((face) => (
              <div key={face} className="grid grid-cols-2 gap-2 items-end">
                <NumField
                  label={`${face === "top" ? "↑ sup." : "↓ inf."} N° barras`}
                  value={z[zk][face].n_bars}
                  onChange={(v) => setZone(zk, face, { n_bars: Math.max(2, Math.round(v)) })}
                  step={1} min={2}
                />
                <SelField label="Diám." value={z[zk][face].bar_label} options={BAR_SIZES}
                  onChange={(v) => setZone(zk, face, { bar_label: v })} />
              </div>
            ))}
            <p className="text-[9px] font-mono text-[var(--text-muted)]">
              As ↑={z[zk].top.As_cm2.toFixed(1)} · ↓={z[zk].bot.As_cm2.toFixed(1)} cm²
            </p>
          </div>
        ))}
      </div>
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 flex flex-col gap-2">
        <h5 className="text-xs font-semibold uppercase tracking-wider text-amber-700">
          Estribos
        </h5>
        <div className="grid grid-cols-5 gap-2">
          <SelField label="Diám." value={s.tie_bar_label} options={BAR_SIZES}
            onChange={(v) => setShear({ tie_bar_label: v })} />
          <NumField label="Ramas"       value={s.n_legs}
            onChange={(v) => setShear({ n_legs: Math.max(2, Math.round(v)) })} step={1} min={2} />
          <NumField label="s conf (mm)" value={s.s_confined_mm}
            onChange={(v) => setShear({ s_confined_mm: Math.max(50, Math.round(v)) })} step={10} />
          <NumField label="s mid (mm)"  value={s.s_central_mm}
            onChange={(v) => setShear({ s_central_mm: Math.max(50, Math.round(v)) })} step={10} />
          <NumField label="L conf (mm)" value={s.L_confinement_mm ?? 800}
            onChange={(v) => setShear({ L_confinement_mm: Math.max(100, Math.round(v)) })} step={50} />
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview SVG con barras y estribos reales
// ─────────────────────────────────────────────────────────────────────────────
function ReinforcementSVG({
  section, pattern,
}: {
  section: SectionReinforcementItem;
  pattern: SectionPattern;
}) {
  const W = 220, H = 200;
  const PAD = 24;
  const b_cm = section.b_m * 100;
  const h_cm = section.h_m * 100;
  const maxD = Math.max(b_cm, h_cm);
  const scale = (Math.min(W, H - 20) - 2 * PAD) / maxD;
  const rw = b_cm * scale;
  const rh = h_cm * scale;
  const ox = (W - rw) / 2;
  const oy = ((H - 20) - rh) / 2;
  const cover_cm = (section.cover_m ?? 0.040) * 100;
  const cov = cover_cm * scale;

  // Barras longitudinales (columnas → por grupo; vigas → top+bot zona end_i)
  const barPts =
    pattern.element_type === "column"
      ? columnBarLayout(pattern as SectionPatternColumn, ox, oy, rw, rh, cov)
      : beamBarLayout(pattern as SectionPatternBeam, ox, oy, rw, rh, cov)
          .map(([x, y, r]) => ({ x, y, r, color: "#1d4ed8" }));

  // Ramas de estribo (cross-ties internos)
  const tiesInfo = computeTies(pattern, ox, oy, rw, rh, cov);

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      {/* Sección */}
      <rect x={ox} y={oy} width={rw} height={rh}
        fill="rgba(99,102,241,0.08)" stroke="#6366F1" strokeWidth={1.6} />
      {/* Estribo externo cerrado */}
      <rect x={ox + cov} y={oy + cov}
        width={Math.max(rw - 2 * cov, 1)} height={Math.max(rh - 2 * cov, 1)}
        fill="none" stroke="#f59e0b" strokeWidth={1.4} />
      {/* Ganchos sísmicos a 135° en las 4 esquinas */}
      {tiesInfo.hooks.map((hk, i) => (
        <line key={`hk${i}`} x1={hk.x1} y1={hk.y1} x2={hk.x2} y2={hk.y2}
          stroke="#f59e0b" strokeWidth={1.2} strokeLinecap="round" />
      ))}
      {/* Cross-ties internos (ramas adicionales) */}
      {tiesInfo.ties.map((tie, i) => (
        <g key={`tie${i}`}>
          <line x1={tie.x1} y1={tie.y1} x2={tie.x2} y2={tie.y2}
            stroke="#d97706" strokeWidth={1.1} strokeDasharray="3 2" />
          {/* Ganchos a 135° en los extremos */}
          <line x1={tie.x1} y1={tie.y1} x2={tie.hx1} y2={tie.hy1}
            stroke="#d97706" strokeWidth={1.1} strokeLinecap="round" />
          <line x1={tie.x2} y1={tie.y2} x2={tie.hx2} y2={tie.hy2}
            stroke="#d97706" strokeWidth={1.1} strokeLinecap="round" />
        </g>
      ))}
      {/* Barras — coloreadas por grupo (columnas) o azul (vigas) */}
      {barPts.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={p.r}
          fill={p.color} stroke="white" strokeWidth={0.5} />
      ))}
      {/* Dimensiones */}
      <text x={ox + rw / 2} y={oy - 6} textAnchor="middle" fontSize="9" fill="#64748b">
        b = {b_cm.toFixed(0)} cm
      </text>
      <text x={ox + rw + 6} y={oy + rh / 2 + 3} textAnchor="start" fontSize="9" fill="#64748b">
        h = {h_cm.toFixed(0)}
      </text>
      {/* Leyenda del estribo */}
      <text x={W / 2} y={H - 6} textAnchor="middle" fontSize="9" fill="#92400e">
        {tiesInfo.caption}
      </text>
    </svg>
  );
}

interface HookSeg { x1: number; y1: number; x2: number; y2: number; }
interface TieSeg extends HookSeg { hx1: number; hy1: number; hx2: number; hy2: number; }

function computeTies(
  pattern: SectionPattern,
  ox: number, oy: number, rw: number, rh: number, cov: number,
): { ties: TieSeg[]; hooks: HookSeg[]; caption: string } {
  const x0 = ox + cov, y0 = oy + cov;
  const w  = Math.max(rw - 2 * cov, 1);
  const h  = Math.max(rh - 2 * cov, 1);
  const hookLen = Math.max(3.5, Math.min(w, h) * 0.08);

  // Ganchos sísmicos del estribo externo (135° hacia dentro de la sección)
  const hooks: HookSeg[] = [
    { x1: x0,       y1: y0,       x2: x0 + hookLen,       y2: y0 + hookLen       }, // top-left
    { x1: x0 + w,   y1: y0,       x2: x0 + w - hookLen,   y2: y0 + hookLen       }, // top-right
    { x1: x0,       y1: y0 + h,   x2: x0 + hookLen,       y2: y0 + h - hookLen   }, // bot-left
    { x1: x0 + w,   y1: y0 + h,   x2: x0 + w - hookLen,   y2: y0 + h - hookLen   }, // bot-right
  ];

  const ties: TieSeg[] = [];
  // Convención Mander (engine): n_legs_b = ramas paralelas a b (horizontales),
  //                             n_legs_h = ramas paralelas a h (verticales).
  let nb = 2, nh = 2, tieLbl = "#3", sConf = 100, sGen = 150;

  if (pattern.element_type === "column") {
    const t = (pattern as SectionPatternColumn).transverse;
    nb = Math.max(2, Math.round(t.n_legs_b));
    nh = Math.max(2, Math.round(t.n_legs_h));
    tieLbl = t.tie_bar_label;
    sConf = t.s_confined_mm;
    sGen = t.s_general_mm;
  } else {
    const s = (pattern as SectionPatternBeam).shear;
    // En viga: n_legs cuenta ramas que resisten corte vertical (paralelas a h).
    nh = Math.max(2, Math.round(s.n_legs));
    tieLbl = s.tie_bar_label;
    sConf = s.s_confined_mm;
    sGen = s.s_central_mm;
  }

  // Ramas horizontales (paralelas a b): n_legs_b − 2 cross-ties entre caras izq/der
  const extraH = Math.max(0, nb - 2);
  for (let i = 1; i <= extraH; i++) {
    const y = y0 + (h * i) / (extraH + 1);
    ties.push({
      x1: x0, y1: y, x2: x0 + w, y2: y,
      hx1: x0 + hookLen,       hy1: y - hookLen,
      hx2: x0 + w - hookLen,   hy2: y + hookLen,
    });
  }
  // Ramas verticales (paralelas a h): n_legs_h − 2 cross-ties entre caras sup/inf
  const extraV = Math.max(0, nh - 2);
  for (let i = 1; i <= extraV; i++) {
    const x = x0 + (w * i) / (extraV + 1);
    ties.push({
      x1: x, y1: y0, x2: x, y2: y0 + h,
      hx1: x + hookLen, hy1: y0 + hookLen,
      hx2: x - hookLen, hy2: y0 + h - hookLen,
    });
  }

  const caption =
    pattern.element_type === "column"
      ? `Estribo ${tieLbl} @ ${sConf}/${sGen}mm · ${nb} ramas ∥ b · ${nh} ramas ∥ h`
      : `Estribo ${tieLbl} @ ${sConf}/${sGen}mm · ${nh} ramas ∥ h`;

  return { ties, hooks, caption };
}

interface BarDot { x: number; y: number; r: number; color: string; }

const GROUP_COLORS: Record<keyof ColumnBarGroups, string> = {
  corners:    "#dc2626",
  top_face:   "#2563eb",
  bot_face:   "#16a34a",
  left_face:  "#9333ea",
  right_face: "#f59e0b",
};

function columnBarLayout(
  p: SectionPatternColumn, ox: number, oy: number, rw: number, rh: number, cov: number,
): BarDot[] {
  const g = ensureGroups(p.longitudinal).groups!;
  const x0 = ox + cov, y0 = oy + cov;
  const w  = Math.max(rw - 2 * cov, 1);
  const h  = Math.max(rh - 2 * cov, 1);
  const toR = (lbl: string) =>
    Math.max(2.4, (BAR_DIAM_MM[lbl] ?? 19.1) * 0.18);

  const pts: BarDot[] = [];

  // Esquinas (4 fijas) con color propio y radio corner
  const rC = toR(g.corners.bar_label);
  pts.push({ x: x0,     y: y0,     r: rC, color: GROUP_COLORS.corners });
  pts.push({ x: x0 + w, y: y0,     r: rC, color: GROUP_COLORS.corners });
  pts.push({ x: x0,     y: y0 + h, r: rC, color: GROUP_COLORS.corners });
  pts.push({ x: x0 + w, y: y0 + h, r: rC, color: GROUP_COLORS.corners });

  // Caras: barras intermedias ENTRE esquinas
  const placeFace = (
    key: "top_face" | "bot_face" | "left_face" | "right_face",
    axis: "horizontal" | "vertical",
    axisStart: number, axisEnd: number, perpCoord: number,
  ) => {
    const grp = g[key];
    if (grp.n_bars <= 0) return;
    const r = toR(grp.bar_label);
    const color = GROUP_COLORS[key];
    const step = (axisEnd - axisStart) / (grp.n_bars + 1);
    for (let i = 1; i <= grp.n_bars; i++) {
      const t = axisStart + step * i;
      if (axis === "horizontal") pts.push({ x: t, y: perpCoord, r, color });
      else                        pts.push({ x: perpCoord, y: t, r, color });
    }
  };
  placeFace("top_face",   "horizontal", x0, x0 + w, y0);
  placeFace("bot_face",   "horizontal", x0, x0 + w, y0 + h);
  placeFace("left_face",  "vertical",   y0, y0 + h, x0);
  placeFace("right_face", "vertical",   y0, y0 + h, x0 + w);

  return pts;
}

function beamBarLayout(
  p: SectionPatternBeam, ox: number, oy: number, rw: number, rh: number, cov: number,
): Array<[number, number, number]> {
  // Muestra la zona end_i (zona crítica)
  const top = p.zones.end_i.top;
  const bot = p.zones.end_i.bot;
  const x0 = ox + cov, y0 = oy + cov;
  const w  = Math.max(rw - 2 * cov, 1);
  const h  = Math.max(rh - 2 * cov, 1);
  const r_top = Math.max(2.2, (BAR_DIAM_MM[top.bar_label] ?? 15.9) * 0.18);
  const r_bot = Math.max(2.2, (BAR_DIAM_MM[bot.bar_label] ?? 15.9) * 0.18);
  const pts: Array<[number, number, number]> = [];
  const n_t = Math.max(2, top.n_bars);
  const n_b = Math.max(2, bot.n_bars);
  for (let i = 0; i < n_t; i++) {
    const x = x0 + (w * i) / Math.max(1, n_t - 1);
    pts.push([x, y0, r_top]);
  }
  for (let i = 0; i < n_b; i++) {
    const x = x0 + (w * i) / Math.max(1, n_b - 1);
    pts.push([x, y0 + h, r_bot]);
  }
  return pts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chips de validación NSR-10
// ─────────────────────────────────────────────────────────────────────────────
function ValidationChips({ validation }: { validation: ReinforcementNSR10Result | null }) {
  if (!validation) return null;
  if (validation.n_warnings + validation.n_errors + validation.n_info === 0) {
    return (
      <span className="mt-2 px-2 py-0.5 rounded bg-green-100 text-green-700 text-[10px] font-semibold flex items-center gap-1">
        ✓ Cumple NSR-10
      </span>
    );
  }
  return (
    <div className="mt-2 flex flex-col items-center gap-1 max-w-[220px]">
      <div className="flex items-center gap-1">
        {validation.n_errors > 0 && (
          <span className="px-2 py-0.5 rounded bg-red-100 text-red-700 text-[9px] font-semibold">
            {validation.n_errors} error{validation.n_errors === 1 ? "" : "es"}
          </span>
        )}
        {validation.n_warnings > 0 && (
          <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-700 text-[9px] font-semibold">
            {validation.n_warnings} aviso{validation.n_warnings === 1 ? "" : "s"}
          </span>
        )}
        {validation.n_info > 0 && (
          <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-700 text-[9px] font-semibold">
            {validation.n_info} info
          </span>
        )}
      </div>
      {validation.warnings.slice(0, 3).map((w: ReinforcementNSR10Warning, i) => (
        <p key={i} className="text-[9px] text-[var(--text-muted)] font-mono text-left leading-tight">
          <span className={
            w.level === "error" ? "text-red-600" :
            w.level === "warning" ? "text-amber-600" :
            "text-blue-500"
          }>●</span> {w.code}: {w.message}
        </p>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de I/O
// ─────────────────────────────────────────────────────────────────────────────
function patternToSavePayload(p: SectionPattern, label: string | null): SaveSectionReinforcementPayload {
  if (p.element_type === "column") {
    return {
      mode: "manual",
      pattern_label: label,
      longitudinal: p.longitudinal,
      transverse:   p.transverse,
    };
  }
  return {
    mode: "manual",
    pattern_label: label,
    zones: p.zones,
    shear: p.shear,
  };
}

function patternToValidationPayload(p: SectionPattern) {
  if (p.element_type === "column") {
    return { longitudinal: p.longitudinal, transverse: p.transverse };
  }
  return { zones: p.zones, shear: p.shear };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fields primitivos
// ─────────────────────────────────────────────────────────────────────────────
function NumField({
  label, value, onChange, step = 1, min, max,
}: {
  label: string; value: number; onChange: (v: number) => void;
  step?: number; min?: number; max?: number;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[9px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">{label}</span>
      <input type="number" step={step} min={min} max={max}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (!Number.isNaN(v)) onChange(v);
        }}
        className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-2)] text-sm font-mono"
      />
    </label>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="w-2 h-2 rounded-full inline-block" style={{ background: color }} />
      <span className="text-[var(--text-muted)]">{label}</span>
    </span>
  );
}

function SelField({
  label, value, onChange, options,
}: {
  label: string; value: string; onChange: (v: string) => void;
  options: readonly string[];
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[9px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-2)] text-sm">
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}
