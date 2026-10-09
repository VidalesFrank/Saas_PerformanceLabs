"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { structuralAnalysisApi } from "@/lib/structural-api";
import type {
  ElementLine, HingeDamageLevel, NLFramePushoverHistory, HingeRecord,
  InfillDamageLevel,
} from "@/lib/structural-types";

interface Props {
  projectId:    string;
  direction:    string;         // "X" | "Y"
  height?:      number;
  /** Click en un extremo con rótula → notifica fid+end al padre */
  onSelectHinge?: (fid: string, end: "i" | "j") => void;
  selectedFid?: string | null;
}

// ── Colores por nivel de daño ASCE 41 ────────────────────────────────────────
const DAMAGE_COLOR: Record<HingeDamageLevel, string> = {
  none:     "#64748b",   // gris (elástico)
  near_io:  "#38bdf8",   // azul claro
  io:       "#22c55e",   // verde (ocupación inmediata)
  ls:       "#eab308",   // amarillo (seguridad de vida)
  cp:       "#f97316",   // naranja (prevención de colapso)
  collapse: "#ef4444",   // rojo (colapso)
};

const LEVEL_LABEL: Record<HingeDamageLevel, string> = {
  none:     "Elástico",
  near_io:  "~IO",
  io:       "IO",
  ls:       "LS",
  cp:       "CP",
  collapse: "Colapso",
};

// ── Colores por nivel de daño de infill ──────────────────────────────────────
const INFILL_FILL: Record<InfillDamageLevel, string> = {
  none:      "#d97706",   // naranja suave (sano)
  cracking:  "#eab308",   // amarillo (fisurado)
  degrading: "#ea580c",   // naranja intenso (degradando)
  collapse:  "#7f1d1d",   // rojo oscuro (colapsado)
};
const INFILL_DIAG: Record<InfillDamageLevel, string> = {
  none:      "#c2410c",
  cracking:  "#ca8a04",
  degrading: "#9a3412",
  collapse:  "#450a0a",
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
const DAMAGE_THRESHOLDS: Array<[number, InfillDamageLevel]> = [
  [0.05, "none"],
  [0.50, "cracking"],
  [0.95, "degrading"],
  [Infinity, "collapse"],
];
function classifyInfill(dmg: number): InfillDamageLevel {
  for (const [thr, lvl] of DAMAGE_THRESHOLDS) if (dmg < thr) return lvl;
  return "collapse";
}


export default function FrameDeformedShape3D({
  projectId, direction, height = 520, onSelectHinge, selectedFid = null,
}: Props) {
  const divRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);

  const [data, setData]       = useState<NLFramePushoverHistory | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [playing, setPlaying] = useState<boolean>(false);
  const [frameIdx, setFrameIdx] = useState<number>(0);
  const [amp, setAmp]         = useState<number>(50);     // factor de amplificación
  const [showRef, setShowRef] = useState<boolean>(true);  // modelo indeformado

  // ── Carga de historia ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setData(null);
    structuralAnalysisApi
      .nlFramePushoverHistory(projectId, direction, 60)
      .then((h) => { if (!cancelled) { setData(h); setFrameIdx(h.frames.length - 1); } })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, direction]);

  // ── Agrupa rótulas por nivel para construir scatter3d por color ────────────
  const hingesByLevel = useMemo(() => {
    const groups: Record<HingeDamageLevel, HingeRecord[]> = {
      none: [], near_io: [], io: [], ls: [], cp: [], collapse: [],
    };
    for (const h of data?.hinge_damage ?? []) {
      groups[h.damage_level].push(h);
    }
    return groups;
  }, [data]);

  // ── Dibuja la escena en Plotly ─────────────────────────────────────────────
  const draw = useCallback(() => {
    if (!divRef.current || !data) return;
    const Plotly = (window as unknown as { Plotly?: {
      newPlot: (...a: unknown[]) => void;
      react:   (...a: unknown[]) => void;
      purge:   (el: Element) => void;
    } }).Plotly;
    if (!Plotly) return;

    const frame = data.frames[frameIdx];
    if (!frame) return;

    const refX: number[] = [];
    const refY: number[] = [];
    const refZ: number[] = [];
    const defX: number[] = [];
    const defY: number[] = [];
    const defZ: number[] = [];
    const defColor: string[] = [];

    const colorByFid: Record<string, string> = {};
    const maxDcrByFid: Record<string, number> = {};
    for (const h of data.hinge_damage) {
      const prev = maxDcrByFid[h.fid] ?? -1;
      if (h.dcr > prev) {
        maxDcrByFid[h.fid] = h.dcr;
        colorByFid[h.fid] = DAMAGE_COLOR[h.damage_level];
      }
    }

    for (const e of data.element_lines) {
      const ri = data.joints_ref[String(e.node_i)];
      const rj = data.joints_ref[String(e.node_j)];
      if (!ri || !rj) continue;

      refX.push(ri[0], rj[0], NaN);
      refY.push(ri[1], rj[1], NaN);
      refZ.push(ri[2], rj[2], NaN);

      const ui = frame.disp[String(e.node_i)] ?? [0, 0, 0];
      const uj = frame.disp[String(e.node_j)] ?? [0, 0, 0];
      defX.push(ri[0] + ui[0] * amp, rj[0] + uj[0] * amp, NaN);
      defY.push(ri[1] + ui[1] * amp, rj[1] + uj[1] * amp, NaN);
      defZ.push(ri[2] + ui[2] * amp, rj[2] + uj[2] * amp, NaN);
      const col = colorByFid[String(e.fid)] ?? (e.kind === "column" ? "#94a3b8" : "#cbd5e1");
      defColor.push(col, col, "rgba(0,0,0,0)");
    }

    // Scatter de rótulas (una traza por nivel para que la leyenda sea útil)
    type Scatter3D = Record<string, unknown>;
    const traces: Scatter3D[] = [];

    if (showRef) {
      traces.push({
        type: "scatter3d", mode: "lines",
        x: refX, y: refY, z: refZ,
        line: { color: "#64748b", width: 1.5 },
        opacity: 0.25, hoverinfo: "skip",
        showlegend: false,
        name: "Referencia",
      });
    }

    traces.push({
      type: "scatter3d", mode: "lines",
      x: defX, y: defY, z: defZ,
      line: { color: defColor, width: 4 },
      hoverinfo: "skip", showlegend: false,
      name: "Deformada",
    });

    // ── Infills: 2 diagonales + relleno coloreado por nivel de daño ────────────
    const infills = data.infill_lines ?? [];
    if (infills.length > 0) {
      // Damage del paso actual por panel_id (si hay historia disponible)
      const dmgInfo = data.infill_damage;
      const dmgRow: number[] = dmgInfo?.history?.[frameIdx] ?? [];
      const dmgByPanel: Record<string, number> = {};
      if (dmgInfo && dmgRow.length === (dmgInfo.panel_ids?.length ?? 0)) {
        for (let k = 0; k < dmgInfo.panel_ids.length; k++) {
          dmgByPanel[dmgInfo.panel_ids[k]] = dmgRow[k] ?? 0;
        }
      }

      // Agrupa los paneles por nivel para una traza por color
      type Bucket = {
        panelMeshX: number[]; panelMeshY: number[]; panelMeshZ: number[];
        meshI: number[]; meshJ: number[]; meshK: number[];
        diagX: number[]; diagY: number[]; diagZ: number[];
        hoverX: number[]; hoverY: number[]; hoverZ: number[];
        hoverText: string[];
        vIdx: number;
        count: number;
      };
      const emptyBucket = (): Bucket => ({
        panelMeshX: [], panelMeshY: [], panelMeshZ: [],
        meshI: [], meshJ: [], meshK: [],
        diagX: [], diagY: [], diagZ: [],
        hoverX: [], hoverY: [], hoverZ: [],
        hoverText: [], vIdx: 0, count: 0,
      });
      const buckets: Record<InfillDamageLevel, Bucket> = {
        none: emptyBucket(), cracking: emptyBucket(),
        degrading: emptyBucket(), collapse: emptyBucket(),
      };

      for (const inf of infills) {
        const dmg = dmgByPanel[inf.panel_id] ?? 0;
        const level = classifyInfill(dmg);
        const b = buckets[level];
        const c = inf.coords;
        const def = (lblKey: keyof typeof inf.nodes, orig: [number, number, number]): [number, number, number] => {
          const t = String(inf.nodes[lblKey]);
          const u = frame.disp[t] ?? [0, 0, 0];
          return [orig[0] + u[0] * amp, orig[1] + u[1] * amp, orig[2] + u[2] * amp];
        };
        const dBL = def("bl", c.bl); const dBR = def("br", c.br);
        const dTL = def("tl", c.tl); const dTR = def("tr", c.tr);

        // Diagonales
        b.diagX.push(dBL[0], dTR[0], NaN); b.diagY.push(dBL[1], dTR[1], NaN); b.diagZ.push(dBL[2], dTR[2], NaN);
        b.diagX.push(dBR[0], dTL[0], NaN); b.diagY.push(dBR[1], dTL[1], NaN); b.diagZ.push(dBR[2], dTL[2], NaN);

        // Si está colapsado, dibujar las diagonales rotas (gap al centro) para enfatizar
        if (level === "collapse") {
          // sobrescribe las últimas 2 diagonales con versión "quebrada"
          b.diagX.splice(b.diagX.length - 6, 6);
          b.diagY.splice(b.diagY.length - 6, 6);
          b.diagZ.splice(b.diagZ.length - 6, 6);
          const midA: [number, number, number] = [
            dBL[0] + 0.35 * (dTR[0] - dBL[0]),
            dBL[1] + 0.35 * (dTR[1] - dBL[1]),
            dBL[2] + 0.35 * (dTR[2] - dBL[2]),
          ];
          const midB: [number, number, number] = [
            dBL[0] + 0.65 * (dTR[0] - dBL[0]),
            dBL[1] + 0.65 * (dTR[1] - dBL[1]),
            dBL[2] + 0.65 * (dTR[2] - dBL[2]),
          ];
          b.diagX.push(dBL[0], midA[0], NaN, midB[0], dTR[0], NaN);
          b.diagY.push(dBL[1], midA[1], NaN, midB[1], dTR[1], NaN);
          b.diagZ.push(dBL[2], midA[2], NaN, midB[2], dTR[2], NaN);
          const midC: [number, number, number] = [
            dBR[0] + 0.35 * (dTL[0] - dBR[0]),
            dBR[1] + 0.35 * (dTL[1] - dBR[1]),
            dBR[2] + 0.35 * (dTL[2] - dBR[2]),
          ];
          const midD: [number, number, number] = [
            dBR[0] + 0.65 * (dTL[0] - dBR[0]),
            dBR[1] + 0.65 * (dTL[1] - dBR[1]),
            dBR[2] + 0.65 * (dTL[2] - dBR[2]),
          ];
          b.diagX.push(dBR[0], midC[0], NaN, midD[0], dTL[0], NaN);
          b.diagY.push(dBR[1], midC[1], NaN, midD[1], dTL[1], NaN);
          b.diagZ.push(dBR[2], midC[2], NaN, midD[2], dTL[2], NaN);
        }

        // Mesh3d: BL, BR, TR, TL
        b.panelMeshX.push(dBL[0], dBR[0], dTR[0], dTL[0]);
        b.panelMeshY.push(dBL[1], dBR[1], dTR[1], dTL[1]);
        b.panelMeshZ.push(dBL[2], dBR[2], dTR[2], dTL[2]);
        b.meshI.push(b.vIdx + 0, b.vIdx + 0);
        b.meshJ.push(b.vIdx + 1, b.vIdx + 2);
        b.meshK.push(b.vIdx + 2, b.vIdx + 3);
        b.vIdx += 4;

        // Hover
        const mx = (dBL[0] + dTR[0]) / 2;
        const my = (dBL[1] + dTR[1]) / 2;
        const mz = (dBL[2] + dTR[2]) / 2;
        b.hoverX.push(mx); b.hoverY.push(my); b.hoverZ.push(mz);
        b.hoverText.push(
          `Infill ${inf.panel_id} — ${inf.story}<br>` +
          `L=${inf.L_m.toFixed(2)} m, H=${inf.H_m.toFixed(2)} m, t=${inf.thickness_m.toFixed(3)} m<br>` +
          `Ancho eq: ${inf.effective_width_m.toFixed(3)} m · λ_aberturas=${inf.lambda_openings.toFixed(2)}<br>` +
          `A_eff puntal: ${inf.area_effective_m2.toFixed(4)} m²<br>` +
          `Daño actual: <b>${INFILL_LABEL[level]}</b> (D=${dmg.toFixed(2)})`
        );
        b.count++;
      }

      for (const level of ["none", "cracking", "degrading", "collapse"] as InfillDamageLevel[]) {
        const b = buckets[level];
        if (!b.count) continue;
        traces.push({
          type: "mesh3d",
          x: b.panelMeshX, y: b.panelMeshY, z: b.panelMeshZ,
          i: b.meshI, j: b.meshJ, k: b.meshK,
          color: INFILL_FILL[level], opacity: INFILL_OPACITY[level],
          hoverinfo: "skip", showlegend: false,
          name: INFILL_LABEL[level],
        });
        traces.push({
          type: "scatter3d", mode: "lines",
          x: b.diagX, y: b.diagY, z: b.diagZ,
          line: { color: INFILL_DIAG[level], width: level === "collapse" ? 2 : 3 },
          hoverinfo: "skip", showlegend: true,
          name: `${INFILL_LABEL[level]} (${b.count})`,
        });
        traces.push({
          type: "scatter3d", mode: "markers",
          x: b.hoverX, y: b.hoverY, z: b.hoverZ,
          marker: { size: 1, color: INFILL_DIAG[level], opacity: 0 },
          text: b.hoverText, hovertemplate: "%{text}<extra></extra>",
          showlegend: false, name: `${INFILL_LABEL[level]} info`,
        });
      }
    }

    for (const level of ["io", "ls", "cp", "collapse"] as HingeDamageLevel[]) {
      const items = hingesByLevel[level];
      if (!items.length) continue;
      const xs: number[] = []; const ys: number[] = []; const zs: number[] = [];
      const text: string[] = []; const custom: string[][] = [];
      const sizes: number[] = [];
      for (const h of items) {
        const el = data.element_lines.find((e) => String(e.fid) === h.fid);
        if (!el) continue;
        const ni = h.end === "i" ? el.node_i : el.node_j;
        const refc = data.joints_ref[String(ni)];
        if (!refc) continue;
        const u = frame.disp[String(ni)] ?? [0, 0, 0];
        xs.push(refc[0] + u[0] * amp);
        ys.push(refc[1] + u[1] * amp);
        zs.push(refc[2] + u[2] * amp);
        text.push(
          `${el.kind === "column" ? "Col" : "Viga"} ${h.fid} — ext ${h.end.toUpperCase()}<br>` +
          `Daño: <b>${LEVEL_LABEL[h.damage_level]}</b><br>` +
          `DCR = ${h.dcr.toFixed(2)}<br>` +
          `θ_p = ${h.theta_p_max.toFixed(4)} rad`
        );
        custom.push([h.fid, h.end]);
        sizes.push(6 + 6 * Math.min(h.dcr, 1.5));
      }
      traces.push({
        type: "scatter3d", mode: "markers",
        x: xs, y: ys, z: zs,
        marker: {
          size: sizes,
          color: DAMAGE_COLOR[level],
          symbol: "circle",
          line: { color: "#000", width: 0.5 },
          opacity: 0.95,
        },
        text, customdata: custom,
        hovertemplate: "%{text}<extra></extra>",
        name: LEVEL_LABEL[level],
        showlegend: true,
      });
    }

    // Pier/elemento seleccionado: contorno destacado
    if (selectedFid) {
      const el = data.element_lines.find((e) => String(e.fid) === selectedFid);
      if (el) {
        const ri = data.joints_ref[String(el.node_i)] ?? [0, 0, 0];
        const rj = data.joints_ref[String(el.node_j)] ?? [0, 0, 0];
        const ui = frame.disp[String(el.node_i)] ?? [0, 0, 0];
        const uj = frame.disp[String(el.node_j)] ?? [0, 0, 0];
        traces.push({
          type: "scatter3d", mode: "lines",
          x: [ri[0] + ui[0] * amp, rj[0] + uj[0] * amp],
          y: [ri[1] + ui[1] * amp, rj[1] + uj[1] * amp],
          z: [ri[2] + ui[2] * amp, rj[2] + uj[2] * amp],
          line: { color: "#fde047", width: 8 },
          opacity: 0.9, hoverinfo: "skip",
          showlegend: false,
          name: "Seleccionado",
        });
      }
    }

    const layout = {
      margin: { t: 0, b: 0, l: 0, r: 0 },
      scene: {
        aspectmode: "data",
        xaxis: { title: "X (m)" },
        yaxis: { title: "Y (m)" },
        zaxis: { title: "Z (m)" },
        bgcolor: "rgba(0,0,0,0)",
      },
      paper_bgcolor: "transparent",
      legend: { x: 0.02, y: 0.98, bgcolor: "rgba(255,255,255,0.3)" },
      showlegend: true,
    };

    Plotly.react(divRef.current, traces, layout,
      { responsive: true, displayModeBar: true });
  }, [data, frameIdx, amp, showRef, hingesByLevel, selectedFid]);

  // Re-dibuja cuando cambia frame / amp / ref
  useEffect(() => { draw(); }, [draw]);

  // Click en marcadores → onSelectHinge
  useEffect(() => {
    if (!divRef.current || !onSelectHinge) return;
    const el = divRef.current as unknown as {
      on?: (ev: string, cb: (ed: { points: Array<{ customdata?: unknown }> }) => void) => void;
    };
    const handler = (ed: { points: Array<{ customdata?: unknown }> }) => {
      const p = ed.points?.[0];
      const cd = p?.customdata;
      if (Array.isArray(cd) && cd.length >= 2) {
        onSelectHinge(String(cd[0]), (String(cd[1]) === "j" ? "j" : "i"));
      }
    };
    el.on?.("plotly_click", handler);
  }, [data, onSelectHinge]);

  // Autoplay
  useEffect(() => {
    if (!playing || !data) return;
    let last = performance.now();
    const step = () => {
      const now = performance.now();
      if (now - last > 80) {
        setFrameIdx((i) => {
          const next = i + 1;
          return next >= data.frames.length ? 0 : next;
        });
        last = now;
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, data]);

  if (loading) {
    return (
      <div style={{ height }} className="flex items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface)]">
        <p className="text-xs text-[var(--text-muted)] animate-pulse">
          Cargando historia del pushover…
        </p>
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ height }} className="flex items-center justify-center rounded-xl border border-red-300 bg-red-50">
        <p className="text-xs text-red-700 px-4 text-center">
          No se pudo cargar la historia: {error}
        </p>
      </div>
    );
  }
  if (!data || data.frames.length === 0) {
    return (
      <div style={{ height }} className="flex items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface)]">
        <p className="text-xs text-[var(--text-muted)]">
          Sin frames capturados en esta dirección.
        </p>
      </div>
    );
  }

  const curFrame = data.frames[frameIdx];
  return (
    <div className="flex flex-col gap-2">
      <div ref={divRef} style={{ height }} className="rounded-xl border border-[var(--border)] bg-[var(--surface)]" />

      {/* Controles */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3 text-[11px]">
          <button
            onClick={() => setPlaying((p) => !p)}
            className={[
              "px-3 py-1 rounded font-semibold",
              playing ? "bg-red-500 text-white" : "bg-[var(--accent)] text-white",
            ].join(" ")}
          >
            {playing ? "⏸ Pausar" : "▶ Reproducir"}
          </button>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={showRef}
              onChange={(e) => setShowRef(e.target.checked)} />
            <span className="text-[var(--text-muted)]">Modelo de referencia</span>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-[var(--text-muted)]">Amplificación:</span>
            <input type="range" min={1} max={300} step={1}
              value={amp} onChange={(e) => setAmp(parseInt(e.target.value))}
              className="w-32" />
            <span className="font-mono text-[var(--text)]">{amp}×</span>
          </label>
          <div className="ml-auto text-[var(--text-muted)] font-mono">
            Frame {frameIdx + 1} / {data.frames.length} · Deriva {curFrame.drift_pct.toFixed(3)}% ·
            Vb {curFrame.base_shear_kN.toFixed(1)} kN
          </div>
        </div>
        <input
          type="range"
          min={0}
          max={data.frames.length - 1}
          value={frameIdx}
          onChange={(e) => setFrameIdx(parseInt(e.target.value))}
          className="w-full"
        />
      </div>
    </div>
  );
}
