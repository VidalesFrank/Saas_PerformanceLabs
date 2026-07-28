"use client";

import { useEffect, useRef, useState } from "react";
import type { ModalViewer, ModeRow } from "@/lib/building-types";

const MODE_COLORS = ["#75b72a", "#4a9fd4", "#e8761e"] as const;

interface Props {
  viewer: ModalViewer | null | undefined;
  modesTable: ModeRow[];
}

interface PerModeData {
  shape: Record<string, [number, number, number]>;
  sf: number;
}

interface PrepData {
  nodes:    Record<string, [number, number, number]>;
  elements: [number, number][];
  undX: (number | null)[];
  undY: (number | null)[];
  undZ: (number | null)[];
  perMode: (PerModeData | null)[];
}

function modeCharLabel(m: ModeRow): string {
  const { Ux_pct: dx, Uy_pct: dy, Rz_pct: drz } = m;
  if (drz > dx + 15 && drz > dy + 15) return "Torsional";
  if (dx > dy + 15) return "Trasl. X";
  if (dy > dx + 15) return "Trasl. Y";
  return "Torsional";
}

function buildDeformedLines(
  nodes:    Record<string, [number, number, number]>,
  elements: [number, number][],
  shape:    Record<string, [number, number, number]>,
  sf:   number,
  amp:  number,
): [(number | null)[], (number | null)[], (number | null)[]] {
  const dx: (number | null)[] = [], dy: (number | null)[] = [], dz: (number | null)[] = [];
  for (const [n1, n2] of elements) {
    const t1 = String(n1), t2 = String(n2);
    const c1 = nodes[t1], c2 = nodes[t2];
    const p1 = shape[t1] ?? [0, 0, 0];
    const p2 = shape[t2] ?? [0, 0, 0];
    if (c1 && c2) {
      dx.push(c1[0] + amp * sf * (p1[0] ?? 0), c2[0] + amp * sf * (p2[0] ?? 0), null);
      dy.push(c1[1] + amp * sf * (p1[1] ?? 0), c2[1] + amp * sf * (p2[1] ?? 0), null);
      dz.push(c1[2] + amp * sf * (p1[2] ?? 0), c2[2] + amp * sf * (p2[2] ?? 0), null);
    }
  }
  return [dx, dy, dz];
}

export function ModeShapeViewer({ viewer, modesTable }: Props) {
  const [status,    setStatus]    = useState<"idle" | "rendering" | "ready" | "error">("idle");
  const [errMsg,    setErrMsg]    = useState<string | null>(null);
  const [animating, setAnimating] = useState(false);
  const [info,      setInfo]      = useState<{ nNodes: number; nEles: number } | null>(null);

  const animRef  = useRef<number | null>(null);
  const phaseRef = useRef(0);
  const prepRef  = useRef<PrepData | null>(null);

  // Tres refs separados — uno por panel de Plotly
  const plotRef0 = useRef<HTMLDivElement>(null);
  const plotRef1 = useRef<HTMLDivElement>(null);
  const plotRef2 = useRef<HTMLDivElement>(null);
  const plotRefs = [plotRef0, plotRef1, plotRef2];

  function buildLayout(mi: number) {
    return {
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor:  "rgba(0,0,0,0)",
      margin: { l: 0, r: 0, t: 0, b: 0 },
      scene: {
        xaxis: { title: "", showticklabels: false, gridcolor: "#ececec", zeroline: false },
        yaxis: { title: "", showticklabels: false, gridcolor: "#ececec", zeroline: false },
        zaxis: { title: "Z (m)", gridcolor: "#ececec", zeroline: false, tickfont: { size: 9 } },
        bgcolor: "rgba(250,250,249,0.25)",
        aspectmode: "data",
        camera: { eye: { x: 1.5, y: 1.5, z: 1.0 } },
      },
      legend: { x: 0, y: 1, font: { size: 10 }, bgcolor: "rgba(255,255,255,0.85)", bordercolor: "#e0e0e0", borderwidth: 1 },
      uirevision: `modal-m${mi + 1}`,
    };
  }

  function renderAll(prep: PrepData, amp: number) {
    if (!window.Plotly) return;
    const { nodes, elements, undX, undY, undZ, perMode } = prep;
    perMode.forEach((pm, mi) => {
      const el = plotRefs[mi]?.current;
      if (!pm || !el) return;
      const [dx, dy, dz] = buildDeformedLines(nodes, elements, pm.shape, pm.sf, amp);
      window.Plotly.react(
        el,
        [
          { type: "scatter3d", mode: "lines", x: undX, y: undY, z: undZ, line: { color: "#c8c8c8", width: 2 }, name: "Sin deformar", showlegend: true, hoverinfo: "none" },
          { type: "scatter3d", mode: "lines", x: dx,   y: dy,   z: dz,   line: { color: MODE_COLORS[mi], width: 4 }, name: "Deformada", showlegend: true, hoverinfo: "none" },
        ],
        buildLayout(mi),
        { responsive: true, displayModeBar: false },
      );
    });
  }

  function updateDeformed(prep: PrepData, amp: number) {
    if (!window.Plotly) return;
    const { nodes, elements, perMode } = prep;
    perMode.forEach((pm, mi) => {
      const el = plotRefs[mi]?.current;
      if (!pm || !el) return;
      const [dx, dy, dz] = buildDeformedLines(nodes, elements, pm.shape, pm.sf, amp);
      window.Plotly.restyle(el, { x: [dx], y: [dy], z: [dz] }, [1]);
    });
  }

  function startAnimation() {
    setAnimating(true);
    phaseRef.current = 0;
    const loop = () => {
      phaseRef.current += 0.05;
      if (prepRef.current) updateDeformed(prepRef.current, Math.sin(phaseRef.current));
      animRef.current = requestAnimationFrame(loop);
    };
    animRef.current = requestAnimationFrame(loop);
  }

  function stopAnimation() {
    if (animRef.current) cancelAnimationFrame(animRef.current);
    animRef.current = null;
    setAnimating(false);
    if (prepRef.current) renderAll(prepRef.current, 1.0);
  }

  useEffect(() => {
    if (!viewer?.nodes || !viewer?.elements || !viewer?.mode_shapes) return;

    setStatus("rendering");
    if (animRef.current) cancelAnimationFrame(animRef.current);
    setAnimating(false);

    // setTimeout garantiza que los divs ya están en el DOM
    const timer = setTimeout(() => {
      try {
        if (!window.Plotly) throw new Error("Plotly no disponible");

        const { nodes, elements, mode_shapes } = viewer;
        const coords = Object.values(nodes);
        if (!coords.length) throw new Error("viewer.nodes está vacío");

        // Calcular factor de escala visual automático
        const xs = coords.map(c => c[0]);
        const ys = coords.map(c => c[1]);
        const zs = coords.map(c => c[2]);
        const bH = Math.max(...zs) - Math.min(...zs);
        const bE = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
        const targetAmp = Math.max(bH, bE, 1) * 0.12;

        // Líneas sin deformar (estructura base)
        const undX: (number | null)[] = [], undY: (number | null)[] = [], undZ: (number | null)[] = [];
        for (const [n1, n2] of elements) {
          const c1 = nodes[String(n1)], c2 = nodes[String(n2)];
          if (c1 && c2) {
            undX.push(c1[0], c2[0], null);
            undY.push(c1[1], c2[1], null);
            undZ.push(c1[2], c2[2], null);
          }
        }

        // Datos por modo (1, 2, 3)
        const perMode = [1, 2, 3].map(mn => {
          const shape = mode_shapes[String(mn)];
          if (!shape) return null;
          const maxD = Math.max(
            1e-14,
            ...Object.values(shape).map(v => Math.sqrt((v[0] ?? 0) ** 2 + (v[1] ?? 0) ** 2 + (v[2] ?? 0) ** 2)),
          );
          const sf = maxD > 1e-10 ? targetAmp / maxD : 0;
          return { shape, sf };
        });

        prepRef.current = { nodes, elements, undX, undY, undZ, perMode };
        setInfo({ nNodes: coords.length, nEles: elements.length });
        renderAll(prepRef.current, 1.0);
        setStatus("ready");
      } catch (e) {
        console.error("[ModeShapeViewer]", e);
        setStatus("error");
        setErrMsg((e as Error).message);
      }
    }, 80);

    return () => {
      clearTimeout(timer);
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer]);

  if (!viewer) return null;

  if (status === "error") {
    return (
      <div className="mt-5 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        No se pudo renderizar las formas modales: {errMsg}
      </div>
    );
  }

  return (
    <div className="mt-6">
      {/* Encabezado */}
      <div className="mb-3 flex items-center justify-between">
        <div className="text-[11px] font-bold uppercase tracking-widest text-text-muted">
          Formas modales — primeros 3 modos
        </div>
        <button
          className={`rounded px-3 py-1.5 text-xs font-semibold transition-colors ${
            animating
              ? "bg-red-100 text-red-700 hover:bg-red-200"
              : "border border-border bg-surface text-text-muted hover:text-text"
          }`}
          onClick={animating ? stopAnimation : startAnimation}
          disabled={status !== "ready"}
        >
          {animating ? "⏹ Detener" : "▶ Animar"}
        </button>
      </div>

      <div className="mb-4 text-[11px] text-text-muted">
        {info
          ? `${info.nNodes} nodos · ${info.nEles} elementos · escala amplificada · arrastra para rotar`
          : status === "rendering"
            ? "Preparando visualización..."
            : "Escala amplificada · arrastra para rotar"}
      </div>

      {/* Tres paneles en paralelo */}
      <div className="grid grid-cols-3 gap-3">
        {([0, 1, 2] as const).map(mi => {
          const m     = modesTable[mi];
          const color = MODE_COLORS[mi];
          const char  = m ? modeCharLabel(m) : "";
          return (
            <div
              key={mi}
              style={{ border: `1.5px solid ${color}44`, borderRadius: 10, overflow: "hidden", background: "white" }}
            >
              {/* Cabecera del panel */}
              <div style={{
                padding: "8px 14px",
                background: `${color}12`,
                borderBottom: `1px solid ${color}30`,
                display: "flex", justifyContent: "space-between", alignItems: "center",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontWeight: 700, fontSize: 15, color }}>Modo {mi + 1}</span>
                  {char && (
                    <span style={{
                      fontSize: 10, padding: "2px 8px", borderRadius: 10,
                      background: `${color}22`, color, fontWeight: 700,
                    }}>
                      {char}
                    </span>
                  )}
                </div>
                {m && (
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#444" }}>
                    T = {m.T.toFixed(3)} s
                  </span>
                )}
              </div>

              {/* Panel Plotly */}
              <div style={{ position: "relative" }}>
                <div ref={plotRefs[mi]} style={{ height: 340, width: "100%" }} />
                {status === "rendering" && (
                  <div style={{
                    position: "absolute", inset: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color: "#999", fontSize: 12, pointerEvents: "none",
                    background: "rgba(255,255,255,0.7)",
                  }}>
                    Preparando...
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
