"use client";

/**
 * LocalEventsPanel — Bloque B.
 *
 * Resumen y lista de eventos locales (fluencia / aplastamiento / pandeo /
 * fractura) detectados durante pushover o NLTHA, agrupados por tipo con
 * tabla filtrable. Comparte helper `buildEventMarkers()` para dibujar
 * líneas verticales en las curvas Vb-δ (pushover) o Vb(t)/d(t) (NLTHA).
 */
import { useMemo, useState } from "react";

import type {
  LocalEvent, LocalEventsPayload, LocalEventType,
} from "@/lib/structural-types";

export const EVENT_STYLE: Record<LocalEventType, {
  label: string; short: string; color: string; icon: string; severity: number;
}> = {
  first_yield_bar: {
    label: "Fluencia del refuerzo", short: "Fluencia",
    color: "#06b6d4", icon: "◇", severity: 1,
  },
  cover_crush: {
    label: "Aplastamiento del recubrimiento", short: "Spalling",
    color: "#f59e0b", icon: "▣", severity: 2,
  },
  core_crush: {
    label: "Aplastamiento del núcleo confinado", short: "Core crush",
    color: "#dc2626", icon: "■", severity: 3,
  },
  bar_buckling: {
    label: "Pandeo del refuerzo longitudinal", short: "Pandeo",
    color: "#be185d", icon: "⬢", severity: 4,
  },
  bar_fracture: {
    label: "Fractura del refuerzo", short: "Fractura",
    color: "#7f1d1d", icon: "✕", severity: 5,
  },
};

const EVENT_ORDER: LocalEventType[] = [
  "bar_fracture", "bar_buckling", "core_crush", "cover_crush", "first_yield_bar",
];

type AxisMode =
  | { kind: "step"; stepToX: (step: number) => number | null }   // pushover (step→drift%)
  | { kind: "time" };                                             // NLTHA (event.time_s)

/**
 * Construye shapes + annotations de Plotly para dibujar líneas verticales
 * en los eventos. Modo:
 *   - "step": usa `stepToX(event.step)` (p. ej. drift% de la curva pushover).
 *   - "time": usa `event.time_s` (requiere que esté definido).
 *
 * Se agrupan eventos cuyo X caiga en el mismo "bucket" para evitar amontonarse.
 */
export function buildEventMarkers(
  events: LocalEvent[],
  axis:   AxisMode,
  opts: {
    yMax:         number;    // rango del eje Y para dibujar las líneas
    maxMarkers?:  number;    // tope de líneas (toma los primeros/eventos únicos)
    filterTypes?: Set<LocalEventType>;
    showAnnotations?: boolean;
  },
): {
  shapes:      Record<string, unknown>[];
  annotations: Record<string, unknown>[];
} {
  const shapes:      Record<string, unknown>[] = [];
  const annotations: Record<string, unknown>[] = [];
  const yMax = opts.yMax;
  const maxMarkers = opts.maxMarkers ?? 20;
  const types = opts.filterTypes;

  // Agrupar por tipo + bucket X para evitar duplicados visuales
  type Bucket = { xs: number[]; events: LocalEvent[] };
  const buckets: Map<string, Bucket> = new Map();

  for (const ev of events) {
    if (types && !types.has(ev.type)) continue;
    let x: number | null = null;
    if (axis.kind === "step") x = axis.stepToX(ev.step);
    else x = ev.time_s ?? null;
    if (x === null || !Number.isFinite(x)) continue;

    // bucket por tipo + X redondeado a 2 decimales
    const key = `${ev.type}|${x.toFixed(2)}`;
    const b = buckets.get(key);
    if (b) {
      b.events.push(ev);
    } else {
      buckets.set(key, { xs: [x], events: [ev] });
    }
  }

  // Orden por severidad desc, tope maxMarkers
  const sorted = Array.from(buckets.entries())
    .map(([key, b]) => ({ key, b, type: key.split("|")[0] as LocalEventType }))
    .sort((a, b) => {
      const sa = EVENT_STYLE[a.type].severity;
      const sb = EVENT_STYLE[b.type].severity;
      if (sb !== sa) return sb - sa;    // mayor severidad primero
      return a.b.xs[0] - b.b.xs[0];     // luego por X asc
    })
    .slice(0, maxMarkers);

  for (const { b, type } of sorted) {
    const style = EVENT_STYLE[type];
    const x = b.xs[0];
    shapes.push({
      type: "line",
      x0: x, x1: x, y0: 0, y1: yMax,
      line: { color: style.color, width: 1.2, dash: "dot" },
    });
    if (opts.showAnnotations !== false) {
      const n = b.events.length;
      annotations.push({
        x, y: yMax * 0.98,
        xanchor: "left", yanchor: "top",
        text: `${style.icon} ${style.short}${n > 1 ? ` ×${n}` : ""}`,
        font: { size: 9, color: style.color, family: "monospace" },
        bgcolor: "rgba(255,255,255,0.85)",
        bordercolor: style.color, borderwidth: 1, borderpad: 2,
        showarrow: false,
      });
    }
  }

  return { shapes, annotations };
}

/**
 * Genera traces de Plotly (uno por tipo de evento presente) para poblar la
 * LEYENDA. Útil cuando dibujas líneas verticales de eventos como `shapes`
 * (que Plotly no incluye en la leyenda) y necesitas una referencia visual
 * de qué color = qué tipo de daño.
 *
 * Cada trace es un scatter con un solo punto en la primera ocurrencia del
 * tipo, con hover que indica el evento + tiempo/paso. El modo es `lines`
 * con dash dot (match visual con las shapes verticales).
 */
export function buildEventLegendTraces(
  events: LocalEvent[],
  axis:   AxisMode,
): Record<string, unknown>[] {
  const firstByType: Partial<Record<LocalEventType, { x: number; event: LocalEvent }>> = {};
  for (const ev of events) {
    let x: number | null = null;
    if (axis.kind === "step") x = axis.stepToX(ev.step);
    else x = ev.time_s ?? null;
    if (x === null || !Number.isFinite(x)) continue;
    const prev = firstByType[ev.type];
    if (!prev || x < prev.x) firstByType[ev.type] = { x, event: ev };
  }

  // Orden por severidad asc (menos → más grave) para que la leyenda
  // lea de izquierda a derecha en orden lógico de daño.
  const types: LocalEventType[] = (Object.keys(firstByType) as LocalEventType[])
    .sort((a, b) => EVENT_STYLE[a].severity - EVENT_STYLE[b].severity);

  const traces: Record<string, unknown>[] = [];
  for (const t of types) {
    const entry = firstByType[t];
    if (!entry) continue;
    const s = EVENT_STYLE[t];
    const whenTxt = axis.kind === "step"
      ? `paso ${entry.event.step}`
      : `t=${(entry.event.time_s ?? 0).toFixed(2)}s`;
    traces.push({
      // Un segmento vertical corto del color del tipo, para que la entrada
      // de leyenda muestre la línea del color real (no un marker genérico).
      type: "scatter",
      mode: "lines",
      x: [entry.x, entry.x],
      y: [null, null],              // sin puntos reales — solo para la leyenda
      line: { color: s.color, width: 2, dash: "dot" },
      name: `${s.icon} ${s.short}`,
      legendgroup: `ev-${t}`,
      hoverinfo: "skip",
      showlegend: true,
    });
  }
  return traces;
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel visual: resumen + lista filtrable
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  events:   LocalEventsPayload | null | undefined;
  context:  "pushover" | "nlth";
  /** Mapeo opcional step → drift% para enriquecer la tabla (pushover). */
  stepToDrift?: (step: number) => number | null;
}

export default function LocalEventsPanel({ events, context, stepToDrift }: Props) {
  const [filter, setFilter] = useState<"all" | LocalEventType>("all");
  const [kindF, setKindF]   = useState<"all" | "column" | "beam">("all");

  // Hooks SIEMPRE antes de early-returns (regla de hooks).
  const list = (events && events.status === "success") ? events.events : [];
  const rows = useMemo(() => {
    return list
      .filter(ev => filter === "all" || ev.type === filter)
      .filter(ev => kindF === "all" || ev.kind === kindF)
      .sort((a, b) => {
        const sb = EVENT_STYLE[b.type].severity - EVENT_STYLE[a.type].severity;
        if (sb !== 0) return sb;
        return a.step - b.step;
      });
  }, [list, filter, kindF]);

  if (!events) return null;

  if (events.status !== "success") {
    const msg = events.status === "no_sect_def_captured"
      ? "El NLTHA se corrió antes de capturar deformaciones de sección. Relánzalo para obtener eventos locales."
      : (events.message ?? `Status: ${events.status}`);
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-xs text-[var(--text-muted)]">
        Eventos locales: {msg}
      </div>
    );
  }

  const summary = events.summary;
  const nTotal = list.length;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h4 className="text-sm font-semibold uppercase tracking-wider text-[var(--text)]">
          Eventos locales ({nTotal})
        </h4>
        <span className="text-[10px] text-[var(--text-muted)] italic">
          Umbrales: Mander (ε_cu confinado), Dhakal-Maekawa (pandeo), A615 Gr60 (fractura)
        </span>
      </div>

      {/* Resumen por tipo */}
      <div className="flex items-center gap-2 flex-wrap text-xs">
        {EVENT_ORDER.map(t => {
          const n = summary[t] ?? 0;
          if (n === 0) return null;
          const s = EVENT_STYLE[t];
          return (
            <button key={t}
                    onClick={() => setFilter(filter === t ? "all" : t)}
                    className="px-2 py-0.5 rounded font-semibold text-[11px] transition
                               border hover:brightness-95"
                    style={{
                      background: `${s.color}18`, color: s.color,
                      borderColor: filter === t ? s.color : "transparent",
                    }}>
              {s.icon} {s.short}: {n}
            </button>
          );
        })}
        {nTotal === 0 && (
          <span className="text-[var(--text-muted)]">
            Ningún evento detectado — el modelo permaneció elástico.
          </span>
        )}
      </div>

      {nTotal > 0 && (
        <>
          {/* Filtros */}
          <div className="flex items-center gap-3 text-xs flex-wrap">
            <select value={filter}
                    onChange={e => setFilter(e.target.value as typeof filter)}
                    className="border border-slate-300 rounded px-2 py-1">
              <option value="all">Todos los tipos</option>
              {EVENT_ORDER.map(t => (
                <option key={t} value={t}>{EVENT_STYLE[t].short}</option>
              ))}
            </select>
            <select value={kindF}
                    onChange={e => setKindF(e.target.value as typeof kindF)}
                    className="border border-slate-300 rounded px-2 py-1">
              <option value="all">Columnas + Vigas</option>
              <option value="column">Columnas</option>
              <option value="beam">Vigas</option>
            </select>
            <span className="text-slate-500 ml-auto">
              Mostrando {rows.length} de {nTotal}
            </span>
          </div>

          {/* Tabla */}
          <div className="overflow-x-auto max-h-80 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-600 sticky top-0">
                <tr>
                  <th className="text-left px-2 py-1">Tipo</th>
                  <th className="text-left px-2 py-1">fid</th>
                  <th className="text-left px-2 py-1">Piso</th>
                  <th className="text-center px-2 py-1">Extremo</th>
                  <th className="text-right px-2 py-1">
                    {context === "pushover" ? "Paso" : "Tiempo (s)"}
                  </th>
                  {context === "pushover" && stepToDrift && (
                    <th className="text-right px-2 py-1">Deriva (%)</th>
                  )}
                  <th className="text-right px-2 py-1">ε</th>
                  <th className="text-right px-2 py-1">ε límite</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((ev, i) => {
                  const s = EVENT_STYLE[ev.type];
                  const drift = stepToDrift ? stepToDrift(ev.step) : null;
                  return (
                    <tr key={`${ev.fid}-${ev.type}-${ev.location}-${i}`}
                        className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-2 py-1">
                        <span className="px-1.5 py-0.5 rounded font-semibold text-[10px]"
                              style={{ background: `${s.color}22`, color: s.color }}>
                          {s.icon} {s.short}
                        </span>
                      </td>
                      <td className="px-2 py-1 font-mono">{ev.fid}</td>
                      <td className="px-2 py-1">{ev.story}</td>
                      <td className="px-2 py-1 text-center font-mono">
                        {ev.location === "end_i" ? "i" : "j"}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">
                        {context === "pushover"
                          ? ev.step
                          : (ev.time_s !== null ? ev.time_s.toFixed(2) : "—")}
                      </td>
                      {context === "pushover" && stepToDrift && (
                        <td className="px-2 py-1 text-right font-mono">
                          {drift !== null ? drift.toFixed(3) : "—"}
                        </td>
                      )}
                      <td className="px-2 py-1 text-right font-mono">
                        {(ev.strain * 1000).toFixed(2)}‰
                      </td>
                      <td className="px-2 py-1 text-right font-mono text-slate-500">
                        {(ev.threshold * 1000).toFixed(2)}‰
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
