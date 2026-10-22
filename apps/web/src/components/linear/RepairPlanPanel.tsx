"use client";

/**
 * RepairPlanPanel — Bloque C.
 *
 * Lista de reparación priorizada por elemento. Combina eventos locales
 * (fluencia / aplastamiento / pandeo / fractura), nivel ASCE 41 por rótula
 * y D/C vs envolvente para clasificar cada elemento en una de 5 severidades
 * de intervención:
 *
 *   1. Sin intervención        : elemento elástico o daño despreciable.
 *   2. Inspección              : primera fluencia o nivel IO.
 *   3. Reparación               : spalling cubierta o nivel LS.
 *   4. Refuerzo estructural    : aplastamiento del núcleo, pandeo o nivel CP.
 *   5. Reemplazo               : fractura del refuerzo o colapso ASCE 41.
 *
 * Referencias:
 *   FEMA 547  — Techniques for the Seismic Rehabilitation of Existing Buildings
 *   FEMA 306  — Evaluation of Earthquake-Damaged Concrete and Masonry
 *   ACI 369.1 — Standard Requirements for Seismic Rehabilitation (RC)
 *   ACI 546R  — Guide to Concrete Repair
 *   NSR-10 C.21 — Disposiciones especiales para diseño sismo-resistente
 */
import { useMemo } from "react";

import type { ElementDemandResult } from "@/lib/structural-api";
import type { LocalEvent, LocalEventType, ElementLine } from "@/lib/structural-types";

type Severity = "ninguna" | "inspeccion" | "reparacion" | "refuerzo" | "reemplazo";

export const SEVERITY_STYLE: Record<Severity, {
  label: string; color: string; priority: number;
}> = {
  ninguna:    { label: "Sin intervención",      color: "#64748b", priority: 1 },
  inspeccion: { label: "Inspección",             color: "#06b6d4", priority: 2 },
  reparacion: { label: "Reparación",             color: "#eab308", priority: 3 },
  refuerzo:   { label: "Refuerzo estructural",  color: "#f97316", priority: 4 },
  reemplazo:  { label: "Reemplazo",              color: "#dc2626", priority: 5 },
};

const SEVERITY_ORDER: Severity[] = [
  "reemplazo", "refuerzo", "reparacion", "inspeccion", "ninguna",
];

interface RepairAction {
  fid:            string;
  kind:           "column" | "beam";
  story:          string;
  severity:       Severity;
  action:         string;
  justification:  string;
  references:     string[];
  event_types:    LocalEventType[];
  hinge_level?:   string;
  theta_p_max?:   number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Classifier: dado un conjunto de eventos + nivel ASCE 41 → severidad.
// Orden de evaluación: de más severo a menos (first match wins).
// ─────────────────────────────────────────────────────────────────────────────

function classifyElement(
  fid: string,
  kind: "column" | "beam",
  story: string,
  eventTypes: Set<LocalEventType>,
  hingeLevel: string | undefined,
  thetaMax: number | undefined,
): RepairAction {

  // 1. Reemplazo — fractura del refuerzo o colapso ASCE 41
  if (eventTypes.has("bar_fracture") || hingeLevel === "collapse") {
    return {
      fid, kind, story, severity: "reemplazo",
      action: "Demolición y reconstrucción del elemento. Antes: evaluar daño colateral " +
              "en nudos y elementos adyacentes. Verificar continuidad del refuerzo con " +
              "los elementos remanentes mediante empalmes mecánicos o soldados.",
      justification: _buildJustification(eventTypes, hingeLevel, thetaMax,
        "Fractura del refuerzo o rótula en nivel de colapso detectada."),
      references: ["FEMA 547 §6", "ACI 369.1-17 §4.5.5", "NSR-10 C.21.1.4"],
      event_types: [...eventTypes], hinge_level: hingeLevel, theta_p_max: thetaMax,
    };
  }

  // 2. Refuerzo — aplastamiento del núcleo, pandeo o nivel CP
  if (eventTypes.has("bar_buckling") || eventTypes.has("core_crush") ||
      hingeLevel === "cp") {
    const needsFrp = eventTypes.has("bar_buckling");
    const action = needsFrp
      ? "Encamisado con FRP (fibra de carbono o vidrio, 2–3 capas) o encamisado de " +
        "concreto reforzado (adicionando 50–75 mm de sección). Previo al encamisado: " +
        "retirar recubrimiento aplastado, enderezar barras pandeadas si es viable (o " +
        "añadir refuerzo adicional cruzado), inyectar resina epóxica en grietas > 0.3 mm."
      : "Encamisado estructural (concreto reforzado o FRP). Reposición del recubrimiento " +
        "aplastado con mortero de reparación de alta resistencia e inyección de resina " +
        "epóxica en grietas visibles.";
    return {
      fid, kind, story, severity: "refuerzo", action,
      justification: _buildJustification(eventTypes, hingeLevel, thetaMax,
        needsFrp
          ? "Pandeo del refuerzo longitudinal detectado — pérdida de confinamiento efectivo."
          : "Aplastamiento del núcleo confinado o rótula en prevención de colapso (CP)."),
      references: ["FEMA 547 §5.3", "ACI 369.1-17 §5", "NSR-10 C.21.11", "ACI 440.2R-17"],
      event_types: [...eventTypes], hinge_level: hingeLevel, theta_p_max: thetaMax,
    };
  }

  // 3. Reparación — spalling de recubrimiento o nivel LS
  if (eventTypes.has("cover_crush") || hingeLevel === "ls") {
    return {
      fid, kind, story, severity: "reparacion",
      action: "Resane del recubrimiento aplastado con mortero de reparación de alta " +
              "resistencia (f'c ≥ 35 MPa). Protección anti-corrosión de barras expuestas " +
              "(pintura epóxica + conector adhesivo). Inyección de resina epóxica en " +
              "grietas > 0.3 mm.",
      justification: _buildJustification(eventTypes, hingeLevel, thetaMax,
        "Aplastamiento del recubrimiento o rótula en nivel de seguridad de vida (LS)."),
      references: ["FEMA 306 §C.3", "ACI 546R-14 §4"],
      event_types: [...eventTypes], hinge_level: hingeLevel, theta_p_max: thetaMax,
    };
  }

  // 4. Inspección — primera fluencia o nivel IO
  if (eventTypes.has("first_yield_bar") || hingeLevel === "io" ||
      hingeLevel === "near_io") {
    return {
      fid, kind, story, severity: "inspeccion",
      action: "Inspección detallada con grietómetro. Documentar fisuras > 0.3 mm con " +
              "fotos georeferenciadas. Monitoreo post-réplicas: re-medir anchos de " +
              "fisuras tras 2–4 semanas. Si fisuras crecen, escalar a reparación.",
      justification: _buildJustification(eventTypes, hingeLevel, thetaMax,
        "Primera fluencia del acero o rótula en nivel de ocupación inmediata (IO)."),
      references: ["FEMA 306 §3", "ACI 224.1R"],
      event_types: [...eventTypes], hinge_level: hingeLevel, theta_p_max: thetaMax,
    };
  }

  // 5. Sin intervención
  return {
    fid, kind, story, severity: "ninguna",
    action: "El elemento permaneció esencialmente elástico. Sin intervención requerida.",
    justification: "Ningún evento de daño detectado, rótula en nivel ≤ IO (sin daño).",
    references: [],
    event_types: [...eventTypes], hinge_level: hingeLevel, theta_p_max: thetaMax,
  };
}

function _buildJustification(
  eventTypes: Set<LocalEventType>,
  hingeLevel: string | undefined,
  thetaMax: number | undefined,
  prefix: string,
): string {
  const parts: string[] = [prefix];
  const evLabels: Partial<Record<LocalEventType, string>> = {
    first_yield_bar: "fluencia", cover_crush: "spalling",
    core_crush: "aplastamiento del núcleo", bar_buckling: "pandeo del refuerzo",
    bar_fracture: "fractura del refuerzo",
  };
  const evTxt = [...eventTypes]
    .map(t => evLabels[t]).filter(Boolean).join(", ");
  if (evTxt) parts.push(`Eventos: ${evTxt}.`);
  if (hingeLevel && hingeLevel !== "none") {
    const lvl = hingeLevel.toUpperCase();
    const theta = thetaMax ? ` (θ_p=${(thetaMax * 1000).toFixed(2)}‰)` : "";
    parts.push(`Rótula ASCE 41: ${lvl}${theta}.`);
  }
  return parts.join(" ");
}

// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  events:        LocalEvent[];
  demand:        ElementDemandResult | null;
  elementLines:  ElementLine[];
}

export default function RepairPlanPanel({ events, demand, elementLines }: Props) {

  const actions: RepairAction[] = useMemo(() => {
    // Agrupar eventos por fid
    const byFid: Map<string, Set<LocalEventType>> = new Map();
    for (const ev of events) {
      let s = byFid.get(ev.fid);
      if (!s) { s = new Set(); byFid.set(ev.fid, s); }
      s.add(ev.type);
    }

    // Universo de fids: unión de eventos + demand + element_lines
    const allFids = new Set<string>();
    for (const el of elementLines) allFids.add(String(el.fid));
    for (const fid of byFid.keys()) allFids.add(fid);
    if (demand) {
      for (const fid of Object.keys(demand.by_fid)) allFids.add(fid);
    }

    const elByFid: Record<string, ElementLine> = {};
    for (const el of elementLines) elByFid[String(el.fid)] = el;

    const out: RepairAction[] = [];
    for (const fid of allFids) {
      const el = elByFid[fid];
      const d  = demand?.by_fid[fid];
      const kind = ((el?.kind ?? d?.kind) === "beam" ? "beam" : "column") as "column" | "beam";
      const story = String(el?.story ?? d?.story ?? "");
      const eventTypes = byFid.get(fid) ?? new Set<LocalEventType>();
      out.push(classifyElement(
        fid, kind, story, eventTypes, d?.level, d?.theta_p_max,
      ));
    }
    // Priorizar por severidad desc, luego θ_p desc, luego fid
    out.sort((a, b) => {
      const sa = SEVERITY_STYLE[a.severity].priority;
      const sb = SEVERITY_STYLE[b.severity].priority;
      if (sb !== sa) return sb - sa;
      const ta = a.theta_p_max ?? 0;
      const tb = b.theta_p_max ?? 0;
      if (tb !== ta) return tb - ta;
      return a.fid.localeCompare(b.fid);
    });
    return out;
  }, [events, demand, elementLines]);

  const counts = useMemo(() => {
    const c: Record<Severity, number> = {
      ninguna: 0, inspeccion: 0, reparacion: 0, refuerzo: 0, reemplazo: 0,
    };
    for (const a of actions) c[a.severity] += 1;
    return c;
  }, [actions]);

  const nAccionables = counts.inspeccion + counts.reparacion +
                       counts.refuerzo + counts.reemplazo;

  const exportCSV = () => {
    const rows = [
      ["fid", "tipo", "piso", "severidad", "acción", "justificación", "referencias"].join(","),
      ...actions.map(a => [
        a.fid, a.kind, a.story, a.severity,
        `"${a.action.replace(/"/g, '""')}"`,
        `"${a.justification.replace(/"/g, '""')}"`,
        `"${a.references.join("; ")}"`,
      ].join(",")),
    ].join("\n");
    const blob = new Blob([rows], { type: "text/csv;charset=utf-8" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = "plan_reparacion.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  if (actions.length === 0) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-xs text-[var(--text-muted)]">
        Plan de reparación: sin datos aún (relanza el análisis para generar
        eventos locales y evaluación por elemento).
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h4 className="text-sm font-semibold uppercase tracking-wider text-[var(--text)]">
          Plan de reparación por elemento ({nAccionables} accionables de {actions.length})
        </h4>
        <button onClick={exportCSV}
                className="text-[11px] px-3 py-1 rounded border border-[var(--border)]
                           hover:bg-[var(--surface-2)] font-mono">
          Exportar CSV
        </button>
      </div>

      {/* Resumen por severidad */}
      <div className="flex items-center gap-2 flex-wrap text-xs">
        {SEVERITY_ORDER.map(sev => {
          const n = counts[sev];
          if (n === 0 && sev !== "ninguna") return null;
          const s = SEVERITY_STYLE[sev];
          return (
            <span key={sev}
                  className="px-2 py-0.5 rounded font-semibold text-[11px] border"
                  style={{ background: `${s.color}18`, color: s.color,
                           borderColor: `${s.color}44` }}>
              {s.label}: {n}
            </span>
          );
        })}
      </div>

      {/* Barra de resumen tipo progreso */}
      <RepairStackedBar counts={counts} total={actions.length} />

      {/* Tabla */}
      <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-600 sticky top-0 z-10">
            <tr>
              <th className="text-left px-2 py-2">Severidad</th>
              <th className="text-left px-2 py-2">fid</th>
              <th className="text-left px-2 py-2">Tipo</th>
              <th className="text-left px-2 py-2">Piso</th>
              <th className="text-left px-2 py-2">Acción sugerida</th>
              <th className="text-left px-2 py-2">Justificación</th>
              <th className="text-left px-2 py-2">Referencias</th>
            </tr>
          </thead>
          <tbody>
            {actions.filter(a => a.severity !== "ninguna").map(a => {
              const s = SEVERITY_STYLE[a.severity];
              return (
                <tr key={a.fid}
                    className="border-t border-slate-100 hover:bg-slate-50 align-top">
                  <td className="px-2 py-2 whitespace-nowrap">
                    <span className="px-1.5 py-0.5 rounded font-semibold text-[10px]"
                          style={{ background: `${s.color}22`, color: s.color }}>
                      {s.label}
                    </span>
                  </td>
                  <td className="px-2 py-2 font-mono whitespace-nowrap">{a.fid}</td>
                  <td className="px-2 py-2 whitespace-nowrap">
                    {a.kind === "column" ? "Columna" : "Viga"}
                  </td>
                  <td className="px-2 py-2 whitespace-nowrap">{a.story}</td>
                  <td className="px-2 py-2 min-w-[280px] leading-snug text-slate-700">
                    {a.action}
                  </td>
                  <td className="px-2 py-2 min-w-[220px] leading-snug text-slate-500 text-[11px]">
                    {a.justification}
                  </td>
                  <td className="px-2 py-2 min-w-[160px] text-[10px] text-slate-500 font-mono">
                    {a.references.join(" · ")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[10px] text-[var(--text-muted)] italic">
        Las acciones son recomendaciones orientativas basadas en FEMA 547 / 306,
        ACI 369.1, ACI 546R y NSR-10 C.21. La decisión final debe ser validada
        por un ingeniero estructural con acceso al edificio y catalogación de
        daños in situ post-sismo.
      </p>
    </div>
  );
}

function RepairStackedBar({ counts, total }: {
  counts: Record<Severity, number>; total: number;
}) {
  if (total === 0) return null;
  const segs = SEVERITY_ORDER.map(sev => ({
    sev, n: counts[sev], pct: (counts[sev] / total) * 100,
    color: SEVERITY_STYLE[sev].color, label: SEVERITY_STYLE[sev].label,
  })).filter(s => s.n > 0);

  return (
    <div className="flex flex-col gap-1">
      <div className="h-3 w-full rounded-full overflow-hidden flex border border-[var(--border)]">
        {segs.map(s => (
          <div key={s.sev}
               title={`${s.label}: ${s.n} (${s.pct.toFixed(0)}%)`}
               style={{ width: `${s.pct}%`, background: s.color }} />
        ))}
      </div>
      <p className="text-[10px] text-[var(--text-muted)] text-right font-mono">
        Total: {total} elementos
      </p>
    </div>
  );
}
