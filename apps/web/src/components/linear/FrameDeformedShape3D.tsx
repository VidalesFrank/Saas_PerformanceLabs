"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { structuralAnalysisApi } from "@/lib/structural-api";
import type {
  ElementLine, HingeDamageLevel, NLFramePushoverHistory, HingeRecord,
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

    // ── Infills: 2 diagonales + relleno traslúcido del panel ───────────────────
    const infills = data.infill_lines ?? [];
    if (infills.length > 0) {
      const diagX: number[] = []; const diagY: number[] = []; const diagZ: number[] = [];
      const panelMeshX: number[] = []; const panelMeshY: number[] = []; const panelMeshZ: number[] = [];
      const meshI: number[] = []; const meshJ: number[] = []; const meshK: number[] = [];
      const hoverText: string[] = []; const hoverX: number[] = []; const hoverY: number[] = []; const hoverZ: number[] = [];
      let vIdx = 0;
      for (const inf of infills) {
        const c = inf.coords;
        const bl = c.bl, br = c.br, tl = c.tl, tr = c.tr;
        // Deformadas por nodo
        const def = (lblKey: keyof typeof inf.nodes, orig: [number, number, number]): [number, number, number] => {
          const t = String(inf.nodes[lblKey]);
          const u = frame.disp[t] ?? [0, 0, 0];
          return [orig[0] + u[0] * amp, orig[1] + u[1] * amp, orig[2] + u[2] * amp];
        };
        const dBL = def("bl", bl); const dBR = def("br", br);
        const dTL = def("tl", tl); const dTR = def("tr", tr);
        // Diagonal 1: BL → TR
        diagX.push(dBL[0], dTR[0], NaN); diagY.push(dBL[1], dTR[1], NaN); diagZ.push(dBL[2], dTR[2], NaN);
        // Diagonal 2: BR → TL
        diagX.push(dBR[0], dTL[0], NaN); diagY.push(dBR[1], dTL[1], NaN); diagZ.push(dBR[2], dTL[2], NaN);
        // Mesh3d: 2 triángulos (BL, BR, TR) y (BL, TR, TL)
        panelMeshX.push(dBL[0], dBR[0], dTR[0], dTL[0]);
        panelMeshY.push(dBL[1], dBR[1], dTR[1], dTL[1]);
        panelMeshZ.push(dBL[2], dBR[2], dTR[2], dTL[2]);
        meshI.push(vIdx + 0, vIdx + 0); meshJ.push(vIdx + 1, vIdx + 2); meshK.push(vIdx + 2, vIdx + 3);
        vIdx += 4;
        // Punto medio para hover
        const mx = (dBL[0] + dTR[0]) / 2; const my = (dBL[1] + dTR[1]) / 2; const mz = (dBL[2] + dTR[2]) / 2;
        hoverX.push(mx); hoverY.push(my); hoverZ.push(mz);
        hoverText.push(
          `Infill ${inf.panel_id} — ${inf.story}<br>` +
          `L=${inf.L_m.toFixed(2)} m, H=${inf.H_m.toFixed(2)} m, t=${inf.thickness_m.toFixed(3)} m<br>` +
          `Ancho eq: ${inf.effective_width_m.toFixed(3)} m · λ_aberturas=${inf.lambda_openings.toFixed(2)}<br>` +
          `A_eff puntal: ${inf.area_effective_m2.toFixed(4)} m²`
        );
      }
      traces.push({
        type: "mesh3d",
        x: panelMeshX, y: panelMeshY, z: panelMeshZ,
        i: meshI, j: meshJ, k: meshK,
        color: "#d97706", opacity: 0.18,
        hoverinfo: "skip", showlegend: false,
        name: "Panel infill",
      });
      traces.push({
        type: "scatter3d", mode: "lines",
        x: diagX, y: diagY, z: diagZ,
        line: { color: "#c2410c", width: 3 },
        hoverinfo: "skip", showlegend: true,
        name: `Infills (${infills.length})`,
      });
      traces.push({
        type: "scatter3d", mode: "markers",
        x: hoverX, y: hoverY, z: hoverZ,
        marker: { size: 1, color: "#c2410c", opacity: 0 },
        text: hoverText, hovertemplate: "%{text}<extra></extra>",
        showlegend: false, name: "Infill info",
      });
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
