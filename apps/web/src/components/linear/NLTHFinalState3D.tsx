"use client";

/**
 * NLTHFinalState3D — radiografía 3D estática post-sismo.
 *
 * Muestra el modelo SIN deformar coloreado por el peor estado alcanzado
 * durante toda la historia del registro. Hover por elemento muestra:
 *   - fid, kind, piso
 *   - Nivel ASCE 41 por rotación (θ_p máx)
 *   - Eventos locales detectados (fluencia, spalling, crush, pandeo, fractura)
 *     con tiempo de primera aparición
 *   - Reparación sugerida (severidad del Bloque C)
 *
 * No anima — para registros largos (17+ min) el costo de capturar frames
 * por paso es prohibitivo. Esta vista responde "cómo quedó" en lugar de
 * "cómo se movió".
 *
 * Fuente de geometría: reutiliza `joints_ref` del endpoint de pushover
 * history (misma geometría del modelo, cero costo adicional).
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { structuralAnalysisApi } from "@/lib/structural-api";
import type { ElementDemandResult } from "@/lib/structural-api";
import type {
  NLTHResult, LocalEvent, LocalEventType, HingeDamageLevel,
  NLFramePushoverHistory, ElementLine, InfillLine, InfillDamageLevel,
  InfillDamagePanel, InfillDamageByDriftPanel, FailureModeElement,
} from "@/lib/structural-types";

import { EVENT_STYLE } from "./LocalEventsPanel";

// ── Genera un prisma rectangular (mesh3d) para el modo extruido ───────────
// Rescatado del antiguo ModelViewer3D eliminado en el rediseño del app shell.
function makeBox(
  x1: number, y1: number, z1: number,
  x2: number, y2: number, z2: number,
  b: number, h: number,
  localY: [number, number, number],
  color: string,
  label: string,
): object[] {
  const ax = x2 - x1, ay = y2 - y1, az = z2 - z1;
  const L  = Math.sqrt(ax * ax + ay * ay + az * az);
  if (L < 1e-6) return [];

  const ex: [number, number, number] = [ax / L, ay / L, az / L];
  let ey: [number, number, number] = [...(localY ?? [0, 1, 0])];
  const dot = ey[0] * ex[0] + ey[1] * ex[1] + ey[2] * ex[2];
  ey = [ey[0] - dot * ex[0], ey[1] - dot * ex[1], ey[2] - dot * ex[2]];
  const lyLen = Math.sqrt(ey[0] ** 2 + ey[1] ** 2 + ey[2] ** 2);
  if (lyLen < 1e-6) {
    ey = ex[2] < 0.9 ? [0, 0, 1] : [0, 1, 0];
  } else {
    ey = [ey[0] / lyLen, ey[1] / lyLen, ey[2] / lyLen];
  }
  const ez: [number, number, number] = [
    ey[1] * ex[2] - ey[2] * ex[1],
    ey[2] * ex[0] - ey[0] * ex[2],
    ey[0] * ex[1] - ey[1] * ex[0],
  ];
  const hb = b / 2, hh = h / 2;
  const corners: [number, number][] = [[-hb, -hh], [hb, -hh], [hb, hh], [-hb, hh]];
  const pts = [
    ...corners.map(([u, v]) => [x1 + u * ey[0] + v * ez[0], y1 + u * ey[1] + v * ez[1], z1 + u * ey[2] + v * ez[2]]),
    ...corners.map(([u, v]) => [x2 + u * ey[0] + v * ez[0], y2 + u * ey[1] + v * ez[1], z2 + u * ey[2] + v * ez[2]]),
  ];
  const px = pts.map(p => p[0]), py = pts.map(p => p[1]), pz = pts.map(p => p[2]);
  const i_ = [0, 0, 1, 1, 2, 2, 3, 3, 0, 0, 1, 2, 4, 4, 5, 6];
  const j_ = [1, 2, 2, 5, 3, 6, 0, 7, 1, 4, 5, 3, 5, 6, 6, 7];
  const k_ = [2, 5, 5, 6, 6, 7, 7, 4, 4, 5, 6, 7, 6, 7, 7, 4];
  return [{
    type: "mesh3d",
    x: px, y: py, z: pz,
    i: i_, j: j_, k: k_,
    color,
    opacity: 0.75,
    flatshading: true,
    hovertext: label,
    hoverinfo: "text",
    showlegend: false,
    lighting:      { ambient: 0.7, diffuse: 0.8, roughness: 0.5, specular: 0.2 },
    lightposition: { x: 1000, y: 1000, z: 2000 },
  }];
}

type ViewMode = "lines" | "extruded";

// Mapa evento → "worst state" ranking (mayor = peor)
const EVENT_SEV: Record<LocalEventType, number> = {
  first_yield_bar: 1, cover_crush: 2, core_crush: 3,
  bar_buckling:    4, bar_fracture: 5,
};

// Mapa nivel ASCE 41 → ranking (post-cp = 5 ≡ crush/buckling local)
const HINGE_SEV: Record<HingeDamageLevel, number> = {
  none: 0, near_io: 0, io: 1, ls: 2, cp: 3, collapse: 4,
};

const STATE_LABEL: Record<number, string> = {
  0: "Elástico",
  1: "Fluencia",
  2: "Spalling cover",
  3: "Core crush",
  4: "Pandeo",
  5: "Fractura",
};
const STATE_COLOR: Record<number, string> = {
  0: "#94a3b8",
  1: EVENT_STYLE.first_yield_bar.color,
  2: EVENT_STYLE.cover_crush.color,
  3: EVENT_STYLE.core_crush.color,
  4: EVENT_STYLE.bar_buckling.color,
  5: EVENT_STYLE.bar_fracture.color,
};

// Paleta de infills — misma que FrameDeformedShape3D para consistencia visual.
const INFILL_FILL: Record<InfillDamageLevel, string> = {
  none:      "#d97706",
  cracking:  "#eab308",
  degrading: "#ea580c",
  collapse:  "#7f1d1d",
};
const INFILL_OPACITY: Record<InfillDamageLevel, number> = {
  none:      0.18,
  cracking:  0.35,
  degrading: 0.55,
  collapse:  0.75,
};
const INFILL_LABEL: Record<InfillDamageLevel, string> = {
  none:      "Infill sano",
  cracking:  "Infill fisurado",
  degrading: "Infill degradando",
  collapse:  "Infill colapsado",
};

interface Props {
  projectId: string;
  result:    NLTHResult;
  /** Si está disponible, usa by_fid para colorear TODOS los elementos
   *  (not solo top-20 de worst_elements). */
  demand?:   ElementDemandResult | null;
}

interface ElementDamage {
  fid:         string;
  kind:        "column" | "beam";
  story:       string;
  worstState:  number;
  color:       string;
  stateLabel:  string;
  hingeLevel:  HingeDamageLevel | null;
  thetaMax:    number | null;
  eventList:   LocalEvent[];
}

export default function NLTHFinalState3D({ projectId, result, demand }: Props) {

  const divRef = useRef<HTMLDivElement>(null);
  const [geom, setGeom] = useState<NLFramePushoverHistory | null>(null);
  const [geomStatus, setGeomStatus] = useState<"idle" | "loading" | "ok" | "fail">("idle");
  const [hoverFid, setHoverFid] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("lines");

  // Fetch pushover history (1 frame) para extraer joints_ref + element_lines.
  // La geometría es idéntica a NLTHA (mismo modelo).
  useEffect(() => {
    let cancelled = false;
    setGeomStatus("loading");
    // Intenta X primero; si falla, Y
    const tryDir = async (dir: "X" | "Y"): Promise<NLFramePushoverHistory | null> => {
      try {
        return await structuralAnalysisApi.nlFramePushoverHistory(projectId, dir, 1);
      } catch {
        return null;
      }
    };
    (async () => {
      let g = await tryDir("X");
      if (!g) g = await tryDir("Y");
      if (cancelled) return;
      if (g && g.joints_ref) {
        setGeom(g);
        setGeomStatus("ok");
      } else {
        setGeomStatus("fail");
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  // Combina damage.hinges + events → peor estado por fid
  const damageByFid: Map<string, ElementDamage> = useMemo(() => {
    const map = new Map<string, ElementDamage>();
    const lineByFid: Record<string, ElementLine> =
      (geom?.element_lines ?? result.element_lines ?? [])
        .reduce((acc, el) => { acc[String(el.fid)] = el; return acc; },
                {} as Record<string, ElementLine>);

    // Fuente de θ_p por fid: preferir `demand.by_fid` (todos los elementos NLTHA).
    // Fallback: `worst_elements` del damage (solo top-20, resuelto por tag).
    const thetaByFid: Record<string, { theta: number; level: HingeDamageLevel }> = {};

    if (demand && demand.source !== "none") {
      for (const [fid, d] of Object.entries(demand.by_fid)) {
        if (d.source !== "nlth" && d.source !== "pushover") continue;
        thetaByFid[fid] = {
          theta: d.theta_p_max,
          level: (d.level as HingeDamageLevel) ?? "none",
        };
      }
    } else {
      // Fallback: top-20 worst_elements del damage NLTHA, resuelto por ele_tag
      const hinges = (result.damage.status === "success" && "max_theta_p" in result.damage)
        ? ((result.damage as unknown as { worst_elements?: Array<{ element: number; theta_p_max: number; level: string }> }).worst_elements ?? [])
        : [];
      const tagToFid: Record<number, string> = {};
      for (const el of geom?.element_lines ?? result.element_lines ?? []) {
        tagToFid[el.ele_tag] = String(el.fid);
      }
      for (const h of hinges) {
        const fid = tagToFid[h.element];
        if (!fid) continue;
        const prev = thetaByFid[fid];
        if (!prev || h.theta_p_max > prev.theta) {
          thetaByFid[fid] = {
            theta: h.theta_p_max,
            level: (h.level as HingeDamageLevel) ?? "none",
          };
        }
      }
    }

    // Pasa 2: events agrupados por fid
    const eventsByFid: Record<string, LocalEvent[]> = {};
    for (const ev of (result.events?.events ?? [])) {
      (eventsByFid[ev.fid] = eventsByFid[ev.fid] ?? []).push(ev);
    }

    // Universo de fids
    const allFids = new Set<string>();
    for (const fid of Object.keys(lineByFid)) allFids.add(fid);
    for (const fid of Object.keys(thetaByFid)) allFids.add(fid);
    for (const fid of Object.keys(eventsByFid)) allFids.add(fid);

    for (const fid of allFids) {
      const line = lineByFid[fid];
      if (!line) continue;
      const thetaEntry = thetaByFid[fid];
      const evs = eventsByFid[fid] ?? [];
      // Peor estado: max de (event severity, hinge severity-level)
      let worst = 0;
      for (const ev of evs) worst = Math.max(worst, EVENT_SEV[ev.type] ?? 0);
      // Hinge-level puede sobrepasar strain si θ_p > 1.5·θ_CP (local post-CP).
      // Lo tratamos como severity ~3 (equivalente a core_crush) si collapse,
      // ya que no sabemos qué fibra falló.
      if (thetaEntry) {
        const h = HINGE_SEV[thetaEntry.level] ?? 0;
        if (h >= 4 && worst < 3) worst = 3;   // post-CP → al menos core-crush equivalente
      }

      map.set(fid, {
        fid,
        kind: line.kind,
        story: line.story,
        worstState: worst,
        color: STATE_COLOR[worst],
        stateLabel: STATE_LABEL[worst],
        hingeLevel: thetaEntry?.level ?? null,
        thetaMax: thetaEntry?.theta ?? null,
        eventList: evs,
      });
    }

    return map;
  }, [geom, result, demand]);

  // Render Plotly scatter3d
  useEffect(() => {
    if (!divRef.current || geomStatus !== "ok" || !geom) return;
    const Plotly = (window as unknown as { Plotly?: {
      newPlot: (...a: unknown[]) => void;
      react:   (...a: unknown[]) => void;
      purge:   (el: Element) => void;
    } }).Plotly;
    if (!Plotly) return;

    const traces: Record<string, unknown>[] = [];

    if (viewMode === "lines") {
      // Modo líneas: 1 traza por color (bucket)
      const linesByColor: Record<string, { x: number[]; y: number[]; z: number[]; text: string[] }> = {};

      for (const el of geom.element_lines) {
        const ri = geom.joints_ref[String(el.node_i)];
        const rj = geom.joints_ref[String(el.node_j)];
        if (!ri || !rj) continue;
        const dmg = damageByFid.get(String(el.fid));
        const color = dmg?.color ?? STATE_COLOR[0];
        const txt = buildHoverText(dmg, el);

        if (!linesByColor[color]) {
          linesByColor[color] = { x: [], y: [], z: [], text: [] };
        }
        const bucket = linesByColor[color];
        bucket.x.push(ri[0], rj[0], NaN);
        bucket.y.push(ri[1], rj[1], NaN);
        bucket.z.push(ri[2], rj[2], NaN);
        bucket.text.push(txt, txt, "");
      }

      const colorsSorted = Object.entries(linesByColor)
        .sort(([ca], [cb]) => {
          const sa = Object.entries(STATE_COLOR).find(([, c]) => c === ca)?.[0] ?? "0";
          const sb = Object.entries(STATE_COLOR).find(([, c]) => c === cb)?.[0] ?? "0";
          return Number(sa) - Number(sb);
        });

      const seenLegend = new Set<number>();
      for (const [color, bucket] of colorsSorted) {
        const stateKey = Object.entries(STATE_COLOR).find(([, c]) => c === color)?.[0];
        const stateIdx = stateKey ? Number(stateKey) : 0;
        const label = STATE_LABEL[stateIdx] ?? "Elástico";
        const showLeg = !seenLegend.has(stateIdx);
        seenLegend.add(stateIdx);
        traces.push({
          type: "scatter3d", mode: "lines",
          x: bucket.x, y: bucket.y, z: bucket.z,
          line: { color, width: stateIdx > 0 ? 5 : 3 },
          text: bucket.text,
          hoverinfo: "text",
          name: label,
          legendgroup: `s-${stateIdx}`,
          showlegend: showLeg,
        });
      }
    } else {
      // Modo extruido: 1 mesh3d por elemento con makeBox + leyenda-dummy
      // por severidad para que el panel de leyenda refleje los colores.
      for (const el of geom.element_lines) {
        const ri = geom.joints_ref[String(el.node_i)];
        const rj = geom.joints_ref[String(el.node_j)];
        if (!ri || !rj) continue;
        const dmg = damageByFid.get(String(el.fid));
        const color = dmg?.color ?? STATE_COLOR[0];
        const txt = buildHoverText(dmg, el);

        // Eje local Y aproximado:
        //   - Columnas (verticales): usar [1, 0, 0] para que b esté en X y h en Y
        //   - Vigas (horizontales): usar [0, 0, 1] para que b esté horizontal y h vertical
        const localY: [number, number, number] =
          el.kind === "column" ? [1, 0, 0] : [0, 0, 1];
        const boxes = makeBox(
          ri[0], ri[1], ri[2],
          rj[0], rj[1], rj[2],
          el.b_m, el.h_m,
          localY, color, txt,
        ) as Record<string, unknown>[];
        traces.push(...boxes);
      }

      // Dummy traces (invisibles) para forzar la leyenda por severidad
      const seenStates = new Set<number>();
      for (const el of geom.element_lines) {
        const dmg = damageByFid.get(String(el.fid));
        const s = dmg?.worstState ?? 0;
        if (seenStates.has(s)) continue;
        seenStates.add(s);
        traces.push({
          type: "scatter3d", mode: "markers",
          x: [null], y: [null], z: [null],
          marker: { size: 10, color: STATE_COLOR[s] },
          name: STATE_LABEL[s],
          legendgroup: `s-${s}`,
          showlegend: true,
          hoverinfo: "skip",
        });
      }
    }

    // ── Infills (paneles de mampostería) ─────────────────────────────────
    // Fuentes de daño combinadas (toma el peor nivel por panel):
    //   1. result.infill_damage           → elongación del puntal RCF-AD
    //   2. result.infill_damage_by_drift  → deriva de entrepiso FEMA 356/HAZUS
    // Fuente de geometría: result.infill_lines ?? geom.infill_lines.
    const infillLines: InfillLine[] =
      result.infill_lines ?? geom.infill_lines ?? [];
    const infillDmgMap: Record<string, InfillDamagePanel> = {};
    for (const p of (result.infill_damage?.panels ?? [])) {
      infillDmgMap[p.panel_id] = p;
    }
    const infillDriftMap: Record<string, InfillDamageByDriftPanel> = {};
    for (const p of (result.infill_damage_by_drift?.panels ?? [])) {
      infillDriftMap[p.panel_id] = p;
    }
    const LEVEL_RANK: Record<InfillDamageLevel, number> =
      { none: 0, cracking: 1, degrading: 2, collapse: 3 };
    const worstLevel = (
      a: InfillDamageLevel, b: InfillDamageLevel,
    ): InfillDamageLevel => (LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b);
    if (infillLines.length > 0) {
      type Bucket = {
        px: number[]; py: number[]; pz: number[];
        mi: number[]; mj: number[]; mk: number[];
        hoverX: number[]; hoverY: number[]; hoverZ: number[];
        hoverText: string[]; count: number;
      };
      const emptyBucket = (): Bucket => ({
        px: [], py: [], pz: [], mi: [], mj: [], mk: [],
        hoverX: [], hoverY: [], hoverZ: [], hoverText: [], count: 0,
      });
      const buckets: Record<InfillDamageLevel, Bucket> = {
        none:      emptyBucket(),
        cracking:  emptyBucket(),
        degrading: emptyBucket(),
        collapse:  emptyBucket(),
      };

      for (const inf of infillLines) {
        const bl = inf.coords.bl, br = inf.coords.br;
        const tr = inf.coords.tr, tl = inf.coords.tl;
        const d  = infillDmgMap[String(inf.panel_id)];
        const dd = infillDriftMap[String(inf.panel_id)];
        const lvlElong: InfillDamageLevel = d?.max_level  ?? "none";
        const lvlDrift: InfillDamageLevel = dd?.max_level ?? "none";
        const level: InfillDamageLevel = worstLevel(lvlElong, lvlDrift);
        const b = buckets[level];
        const base = b.px.length;
        b.px.push(bl[0], br[0], tr[0], tl[0]);
        b.py.push(bl[1], br[1], tr[1], tl[1]);
        b.pz.push(bl[2], br[2], tr[2], tl[2]);
        // 2 triángulos del rectángulo
        b.mi.push(base + 0, base + 0);
        b.mj.push(base + 1, base + 2);
        b.mk.push(base + 2, base + 3);
        // Punto de hover al centro del panel
        const cx = (bl[0] + tr[0]) / 2;
        const cy = (bl[1] + tr[1]) / 2;
        const cz = (bl[2] + tr[2]) / 2;
        b.hoverX.push(cx); b.hoverY.push(cy); b.hoverZ.push(cz);
        const dmgPct = d ? (d.max_damage * 100).toFixed(1) : "0.0";
        const whenCrack = d && d.step_first_cracking >= 0
          ? `paso ${d.step_first_cracking}` : "—";
        const whenColl  = d && d.step_first_collapse >= 0
          ? `paso ${d.step_first_collapse}` : "—";
        const driftLine = dd
          ? `Deriva piso: ${dd.max_drift_pct.toFixed(2)}% (${dd.orientation}) → <b>${INFILL_LABEL[lvlDrift]}</b><br>`
          : "";
        const elongLine = d
          ? `Elongación puntal: damage ${dmgPct}% → <b>${INFILL_LABEL[lvlElong]}</b><br>`
          : "";
        b.hoverText.push(
          `<b>Infill ${inf.panel_id}</b> · Piso ${inf.story}<br>` +
          `L=${inf.L_m.toFixed(2)} m · H=${inf.H_m.toFixed(2)} m · t=${inf.thickness_m.toFixed(3)} m<br>` +
          `Ancho equivalente ${inf.effective_width_m.toFixed(3)} m · λ_aberturas=${inf.lambda_openings.toFixed(2)}<br>` +
          driftLine + elongLine +
          `<b>Estado consolidado: ${INFILL_LABEL[level]}</b><br>` +
          `Primera fisura (elong): ${whenCrack} · Primer colapso (elong): ${whenColl}`
        );
        b.count++;
      }

      const seenInfLvl = new Set<InfillDamageLevel>();
      for (const level of ["collapse", "degrading", "cracking", "none"] as InfillDamageLevel[]) {
        const b = buckets[level];
        if (!b.count) continue;
        traces.push({
          type: "mesh3d",
          x: b.px, y: b.py, z: b.pz,
          i: b.mi, j: b.mj, k: b.mk,
          color: INFILL_FILL[level], opacity: INFILL_OPACITY[level],
          hoverinfo: "skip", showlegend: false,
          name: INFILL_LABEL[level],
        });
        // Hover-only invisible markers
        traces.push({
          type: "scatter3d", mode: "markers",
          x: b.hoverX, y: b.hoverY, z: b.hoverZ,
          marker: { size: 1, color: INFILL_FILL[level], opacity: 0 },
          text: b.hoverText, hovertemplate: "%{text}<extra></extra>",
          showlegend: false,
          name: `${INFILL_LABEL[level]} info`,
        });
        // Legend entry (si no estaba)
        if (!seenInfLvl.has(level)) {
          seenInfLvl.add(level);
          traces.push({
            type: "scatter3d", mode: "markers",
            x: [null], y: [null], z: [null],
            marker: { size: 10, color: INFILL_FILL[level] },
            name: `${INFILL_LABEL[level]} (${b.count})`,
            legendgroup: `inf-${level}`,
            showlegend: true,
            hoverinfo: "skip",
          });
        }
      }
    }

    // ── Marcadores de modo de falla por columna (ASCE 41 × hinges) ───────
    // Se dibujan en los dos extremos de cada columna marcada, superpuestos
    // sobre el color de daño actual. Rayo ⚡ para shear_failed, cruz ✕ para
    // flexure_shear_risk. No reemplazan el coloreo, lo complementan.
    const failureElements: FailureModeElement[] = result.failure_modes?.elements ?? [];
    const failureByFid = new Map<string, FailureModeElement>();
    for (const e of failureElements) {
      if (e.needs_marker) failureByFid.set(e.fid, e);
    }
    if (failureByFid.size > 0 && geomStatus === "ok" && geom) {
      type MkBucket = {
        x: number[]; y: number[]; z: number[]; text: string[];
      };
      const markers: Record<"lightning" | "cross", MkBucket> = {
        lightning: { x: [], y: [], z: [], text: [] },
        cross:     { x: [], y: [], z: [], text: [] },
      };
      for (const el of geom.element_lines) {
        if (el.kind !== "column") continue;
        const fm = failureByFid.get(String(el.fid));
        if (!fm) continue;
        const ri = geom.joints_ref[String(el.node_i)];
        const rj = geom.joints_ref[String(el.node_j)];
        if (!ri || !rj) continue;
        const sym = fm.marker_symbol === "lightning" ? "lightning" : "cross";
        const b = markers[sym];
        // Marcador a 15% desde cada extremo (misma convención que rótulas).
        const t = 0.15;
        for (const [x1, y1, z1, x2, y2, z2] of [
          [ri[0], ri[1], ri[2], rj[0], rj[1], rj[2]],
          [rj[0], rj[1], rj[2], ri[0], ri[1], ri[2]],
        ]) {
          b.x.push(x1 + t * (x2 - x1));
          b.y.push(y1 + t * (y2 - y1));
          b.z.push(z1 + t * (z2 - z1));
          const label = sym === "lightning" ? "⚡ Falla por cortante"
                                              : "✕ Riesgo flexión-cortante";
          b.text.push(
            `<b>${label}</b><br>` +
            `Columna ${fm.fid} · ${fm.section} · Piso ${fm.story}<br>` +
            `Predicción ASCE 41 §10.3: ${fm.asce_prediction} (cond. ${fm.asce_condition})<br>` +
            `Vp/Vn = ${fm.Vp_over_Vn.toFixed(2)} · Vn = ${fm.Vn_kN.toFixed(0)} kN<br>` +
            `Rótula observada: ${fm.observed_hinge.toUpperCase()} · DCR = ${fm.max_dcr.toFixed(2)}<br>` +
            (fm.flags.length ? `Flags detallado: ${fm.flags.join(", ")}` : "")
          );
        }
      }
      // Plotly scatter3d: no soporta "lightning" literal; usamos symbol
      // alternativos que recuerden al concepto.
      if (markers.lightning.x.length > 0) {
        traces.push({
          type: "scatter3d", mode: "markers+text",
          x: markers.lightning.x, y: markers.lightning.y, z: markers.lightning.z,
          marker: {
            size: 10, symbol: "diamond-open",
            color: "#dc2626", line: { color: "#991b1b", width: 2 },
          },
          text: markers.lightning.x.map(() => "⚡"),
          textposition: "middle center",
          textfont: { size: 14, color: "#dc2626" },
          hovertext: markers.lightning.text,
          hoverinfo: "text",
          name: `Falla por cortante (${markers.lightning.x.length / 2})`,
          legendgroup: "fm-shear",
          showlegend: true,
        });
      }
      if (markers.cross.x.length > 0) {
        traces.push({
          type: "scatter3d", mode: "markers+text",
          x: markers.cross.x, y: markers.cross.y, z: markers.cross.z,
          marker: {
            size: 10, symbol: "x",
            color: "#ea580c", line: { color: "#9a3412", width: 2 },
          },
          text: markers.cross.x.map(() => "✕"),
          textposition: "middle center",
          textfont: { size: 12, color: "#ea580c" },
          hovertext: markers.cross.text,
          hoverinfo: "text",
          name: `Riesgo flexión-cortante (${markers.cross.x.length / 2})`,
          legendgroup: "fm-flexshear",
          showlegend: true,
        });
      }
    }

    const layout = {
      paper_bgcolor: "transparent",
      scene: {
        aspectmode: "data",
        xaxis: { title: "X (m)", gridcolor: "#e2e8f0", showbackground: false },
        yaxis: { title: "Y (m)", gridcolor: "#e2e8f0", showbackground: false },
        zaxis: { title: "Z (m)", gridcolor: "#e2e8f0", showbackground: false },
        camera: { eye: { x: 1.6, y: 1.6, z: 1.1 } },
      },
      margin: { t: 10, r: 10, b: 10, l: 10 },
      font: { size: 10 },
      legend: {
        orientation: "h", y: -0.05, x: 0, xanchor: "left",
        font: { size: 10 }, bgcolor: "rgba(255,255,255,0)",
      },
      hovermode: "closest",
    };

    Plotly.react(divRef.current, traces, layout,
      { responsive: true, displayModeBar: false });

    return () => { if (divRef.current) Plotly.purge(divRef.current); };
  }, [geom, geomStatus, damageByFid, viewMode, result.failure_modes]);

  // ── Resumen por estado (pills arriba) ─────────────────────────────────
  const counts: Record<number, number> = {};
  for (const d of damageByFid.values()) {
    counts[d.worstState] = (counts[d.worstState] ?? 0) + 1;
  }
  const totalElements = damageByFid.size;

  if (geomStatus === "fail") {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wider">
          Radiografía 3D post-sismo
        </h3>
        <p className="text-xs text-[var(--text-muted)] leading-snug">
          No se pudo cargar la geometría. La radiografía usa `joints_ref` del
          endpoint de pushover para la referencia 3D (mismo modelo). Corre
          pushover al menos una vez (en X o Y) para habilitar esta vista.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-sm font-semibold uppercase tracking-wider">
          Radiografía 3D post-sismo
        </h3>
        <div className="flex items-center gap-3 flex-wrap">
          {/* Toggle líneas / extruido */}
          <div className="flex items-center gap-1 rounded-lg border border-[var(--border)] p-0.5
                           bg-[var(--surface-2)]">
            {(["lines", "extruded"] as ViewMode[]).map(m => (
              <button key={m}
                      onClick={() => setViewMode(m)}
                      className={[
                        "px-2.5 py-1 rounded text-[11px] font-medium transition-colors",
                        viewMode === m
                          ? "bg-[var(--accent)] text-white"
                          : "text-[var(--text-muted)] hover:text-[var(--text)]",
                      ].join(" ")}>
                {m === "lines" ? "Líneas" : "Extruido"}
              </button>
            ))}
          </div>
          <span className="text-[10px] text-[var(--text-muted)] italic">
            Peor estado por elemento · hover para detalles
          </span>
        </div>
      </div>

      {/* Resumen por estado — elementos frame */}
      <div className="flex items-center gap-2 flex-wrap text-xs">
        {[5, 4, 3, 2, 1, 0].map(s => {
          const n = counts[s] ?? 0;
          if (n === 0 && s !== 0) return null;
          return (
            <span key={s}
                  className="px-2 py-0.5 rounded font-semibold text-[11px] border"
                  style={{ background: `${STATE_COLOR[s]}18`,
                           color: STATE_COLOR[s],
                           borderColor: `${STATE_COLOR[s]}44` }}>
              {STATE_LABEL[s]}: {n}
            </span>
          );
        })}
        <span className="text-slate-500 text-[10px] ml-auto">
          {totalElements} elementos
        </span>
      </div>

      {/* Resumen por nivel de daño — infills (consolidado: elong + deriva) */}
      {(() => {
        const dElong = result.infill_damage;
        const dDrift = result.infill_damage_by_drift;
        const hasElong = dElong && dElong.status === "success" && dElong.n_total > 0;
        const hasDrift = dDrift && dDrift.status === "success" && dDrift.n_total > 0;
        if (!hasElong && !hasDrift) return null;

        const LEVEL_RANK: Record<InfillDamageLevel, number> =
          { none: 0, cracking: 1, degrading: 2, collapse: 3 };
        const by: Record<InfillDamageLevel, number> = {
          none: 0, cracking: 0, degrading: 0, collapse: 0,
        };
        const perPanel: Record<string, InfillDamageLevel> = {};
        if (hasElong) {
          for (const p of dElong!.panels) {
            perPanel[p.panel_id] = p.max_level;
          }
        }
        if (hasDrift) {
          for (const p of dDrift!.panels) {
            const cur = perPanel[p.panel_id] ?? "none";
            perPanel[p.panel_id] = LEVEL_RANK[p.max_level] > LEVEL_RANK[cur] ? p.max_level : cur;
          }
        }
        for (const lvl of Object.values(perPanel)) by[lvl] += 1;
        const total = Object.keys(perPanel).length;
        const pills: Array<[string, string, number]> = [
          ["Infill colapsado",   INFILL_FILL.collapse,  by.collapse],
          ["Infill degradando",  INFILL_FILL.degrading, by.degrading],
          ["Infill fisurado",    INFILL_FILL.cracking,  by.cracking],
          ["Infill sano",        INFILL_FILL.none,      by.none],
        ];
        return (
          <div className="flex items-center gap-2 flex-wrap text-xs">
            {pills.map(([label, col, n]) => (
              n === 0 ? null : (
                <span key={label}
                      className="px-2 py-0.5 rounded font-semibold text-[11px] border"
                      style={{ background: `${col}18`, color: col,
                               borderColor: `${col}44` }}>
                  {label}: {n}
                </span>
              )
            ))}
            <span className="text-slate-500 text-[10px] ml-auto">
              {total} paneles de mampostería
              {hasElong && ` · damage máx (elong) ${(dElong!.max_damage * 100).toFixed(1)}%`}
              {hasDrift && ` · deriva máx (piso) ${dDrift!.max_drift_pct.toFixed(2)}%`}
            </span>
          </div>
        );
      })()}

      {/* Resumen por categoría de modo de falla (ASCE 41 × hinges NLTHA) */}
      {result.failure_modes?.status === "success" &&
       result.failure_modes.n_total > 0 && (() => {
        const c = result.failure_modes!.counts;
        const pills: Array<[string, string, number, string]> = [
          ["⚡ Falla por cortante",      "#dc2626", c.shear_failed       ?? 0, "shear_failed"],
          ["✕ Riesgo flexión-cortante", "#ea580c", c.flexure_shear_risk ?? 0, "flexure_shear_risk"],
          ["Flexión dúctil",            "#eab308", c.flexural_ductile   ?? 0, "flexural_ductile"],
          ["Sin daño",                  "#64748b", c.no_damage          ?? 0, "no_damage"],
        ];
        return (
          <div className="flex items-center gap-2 flex-wrap text-xs">
            {pills.map(([label, col, n, key]) => (
              n === 0 ? null : (
                <span key={key}
                      className="px-2 py-0.5 rounded font-semibold text-[11px] border"
                      style={{ background: `${col}18`, color: col,
                               borderColor: `${col}44` }}>
                  {label}: {n}
                </span>
              )
            ))}
            <span className="text-slate-500 text-[10px] ml-auto">
              {result.failure_modes!.n_total} columnas · ASCE 41 §10.3 × rótulas observadas
            </span>
          </div>
        );
      })()}

      {/* Visor 3D */}
      {geomStatus === "loading" ? (
        <div className="flex items-center justify-center h-[480px] text-xs text-[var(--text-muted)]">
          Cargando geometría…
        </div>
      ) : (
        <div ref={divRef} style={{ height: 480 }}
             onMouseLeave={() => setHoverFid(null)} />
      )}

      <p className="text-[10px] text-[var(--text-muted)] italic leading-snug">
        Vista estática — sin animación por costo prohibitivo para registros largos.
        El color de cada elemento corresponde al <b>peor evento</b> detectado
        durante toda la historia del registro. Para el detalle temporal de
        cada evento, consulta la tabla "Eventos locales" abajo.
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function buildHoverText(dmg: ElementDamage | undefined, el: ElementLine): string {
  const kind = el.kind === "column" ? "Columna" : "Viga";
  const header = `<b>${kind} ${el.fid}</b> · Piso ${el.story}`;
  const geomLine = `${(el.b_m * 100).toFixed(0)}×${(el.h_m * 100).toFixed(0)} cm · L=${el.L_m.toFixed(2)} m`;

  if (!dmg || dmg.worstState === 0) {
    return `${header}<br>${geomLine}<br><br>Estado: elástico`;
  }

  const parts: string[] = [header, geomLine, ""];
  parts.push(`<b>Estado final:</b> ${dmg.stateLabel}`);

  if (dmg.thetaMax !== null && dmg.hingeLevel) {
    const lv = dmg.hingeLevel === "collapse" ? "Post-CP" : dmg.hingeLevel.toUpperCase();
    parts.push(`θ_p máx = ${(dmg.thetaMax * 1000).toFixed(2)}‰ (ASCE 41: ${lv})`);
  }

  if (dmg.eventList.length > 0) {
    parts.push("");
    parts.push("<b>Eventos:</b>");
    // Ordenar por tiempo
    const sorted = [...dmg.eventList].sort(
      (a, b) => (a.time_s ?? a.step) - (b.time_s ?? b.step)
    );
    const seenTypes = new Set<string>();
    for (const ev of sorted) {
      if (seenTypes.has(ev.type)) continue;
      seenTypes.add(ev.type);
      const s = EVENT_STYLE[ev.type];
      const when = ev.time_s !== null ? `t=${ev.time_s.toFixed(2)}s` : `paso ${ev.step}`;
      const strain = `ε=${(ev.strain * 100).toFixed(2)}%`;
      parts.push(`  ${s.icon} ${s.short} @ ${when} (${strain})`);
    }
  }

  // Reparación sugerida (clasificación inline simple)
  const repair = inferRepair(dmg);
  if (repair) {
    parts.push("");
    parts.push(`<b>Reparación:</b> ${repair}`);
  }

  return parts.join("<br>");
}

function inferRepair(dmg: ElementDamage): string | null {
  const types = new Set(dmg.eventList.map(e => e.type));
  const h = dmg.hingeLevel;
  if (types.has("bar_fracture") || h === "collapse")
    return "⛔ Reemplazo del elemento";
  if (types.has("bar_buckling") || types.has("core_crush") || h === "cp")
    return "⚠ Refuerzo (encamisado FRP/concreto)";
  if (types.has("cover_crush") || h === "ls")
    return "✎ Reparación local (resane + anti-corrosión)";
  if (types.has("first_yield_bar") || h === "io" || h === "near_io")
    return "🔍 Inspección detallada";
  return null;
}
