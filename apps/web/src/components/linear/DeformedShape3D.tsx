"use client";

/**
 * DeformedShape3D — Visor 3D de la deformada del edificio de muros durante
 * un pushover no lineal, con coloreado por índice de daño Park-Ang.
 *
 * Renderiza cada pier como un cuadrilátero deformable (mesh3d) cuyo vertices
 * se recalculan por frame aplicando: coord_ref + amp × disp[node_tag].
 *
 * Los pieres se agrupan por damage_level para reducir el número de traces
 * (verde/amarillo/naranja/rojo) y permitir un restyle eficiente por frame.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { structuralAnalysisApi } from "@/lib/structural-api";
import type {
  NLPushoverHistory,
  PierLineDeformable,
  DamageLevel,
} from "@/lib/structural-types";

interface Props {
  projectId: string;
  direction: string; // "X" | "Y" | "-X" | "-Y"
  height?:   number; // px, default 520
}

// ── Colores por nivel de daño (verde→amarillo→rojo) ──────────────────────────
const DAMAGE_COLOR: Record<DamageLevel, string> = {
  none:     "#22c55e",   // verde
  minor:    "#a3e635",   // verde-lima
  moderate: "#eab308",   // amarillo
  severe:   "#f97316",   // naranja
  collapse: "#ef4444",   // rojo
};

const DAMAGE_LABEL: Record<DamageLevel, string> = {
  none:     "Sin daño (DI<0.10)",
  minor:    "Menor (0.10–0.25)",
  moderate: "Moderado (0.25–0.40)",
  severe:   "Severo (0.40–1.00)",
  collapse: "Colapso (DI≥1.00)",
};

// Plotly se carga vía CDN por otros componentes (declarado en ModelViewer3D)
function usePlotly() {
  const [ready, setReady] = useState(typeof window !== "undefined" && !!window.Plotly);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.Plotly) { setReady(true); return; }
    const existing = document.querySelector<HTMLScriptElement>("script[data-plotly]");
    if (existing) {
      existing.addEventListener("load", () => setReady(true));
      return;
    }
    const script = document.createElement("script");
    script.src = "https://cdn.plot.ly/plotly-2.35.2.min.js";
    script.async = true;
    script.dataset.plotly = "1";
    script.onload = () => setReady(true);
    document.head.appendChild(script);
  }, []);
  return ready;
}

// ── Vertices del cuadrilátero deformado de un pier (fan CCW: 0→1→2→3) ────────
function pierVertices(
  pl:  PierLineDeformable,
  disp: Record<string, [number, number, number]>,
  amp: number,
) {
  const { coords_ref: c, node_tags: t } = pl;
  const uBL = disp[String(t.base_left)]  ?? [0, 0, 0];
  const uBR = disp[String(t.base_right)] ?? [0, 0, 0];
  const uTR = disp[String(t.top_right)]  ?? [0, 0, 0];
  const uTL = disp[String(t.top_left)]   ?? [0, 0, 0];
  return {
    x: [c.base_left[0] + amp*uBL[0], c.base_right[0] + amp*uBR[0], c.top_right[0] + amp*uTR[0], c.top_left[0] + amp*uTL[0]],
    y: [c.base_left[1] + amp*uBL[1], c.base_right[1] + amp*uBR[1], c.top_right[1] + amp*uTR[1], c.top_left[1] + amp*uTL[1]],
    z: [c.base_left[2] + amp*uBL[2], c.base_right[2] + amp*uBR[2], c.top_right[2] + amp*uTR[2], c.top_left[2] + amp*uTL[2]],
  };
}

// Construye un traza mesh3d para un grupo de pieres del mismo damage level.
function buildDamageTrace(
  piers: PierLineDeformable[],
  disp:  Record<string, [number, number, number]>,
  amp:   number,
  color: string,
  name:  string,
) {
  const x:number[] = [], y:number[] = [], z:number[] = [];
  const i:number[] = [], j:number[] = [], k:number[] = [];
  const cd: object[] = [];
  let base = 0;
  for (const pl of piers) {
    const v = pierVertices(pl, disp, amp);
    x.push(...v.x); y.push(...v.y); z.push(...v.z);
    // Dos triángulos: (0,1,2) y (0,2,3) — fan
    i.push(base, base);
    j.push(base+1, base+2);
    k.push(base+2, base+3);
    const info = {
      pier: pl.pier, story: pl.story,
      di: pl.damage.di, level: pl.damage.level, drift: pl.damage.drift_pct,
    };
    cd.push(info, info, info, info);
    base += 4;
  }
  return {
    type: "mesh3d", x, y, z, i, j, k, color, opacity: 0.9, name,
    flatshading: true,
    lighting: { ambient: 0.55, diffuse: 0.9, roughness: 0.25, specular: 0.55, fresnel: 0.2 },
    lightposition: { x: 2000, y: 2000, z: 5000 },
    customdata: cd,
    hovertemplate:
      "<b>%{customdata.pier}</b> · %{customdata.story}<br>" +
      "DI = %{customdata.di:.3f} (%{customdata.level})<br>" +
      "Deriva = %{customdata.drift:.3f}%<extra></extra>",
    showlegend: true,
  };
}

// ═════════════════════════════════════════════════════════════════════════════

export default function DeformedShape3D({ projectId, direction, height = 520 }: Props) {
  const plotlyReady = usePlotly();
  const containerRef = useRef<HTMLDivElement>(null);

  const [history, setHistory] = useState<NLPushoverHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  const [frameIdx, setFrameIdx] = useState(0);
  const [playing,  setPlaying]  = useState(false);
  const [amp,      setAmp]      = useState(50);   // factor de amplificación default 50×
  const [showRef,  setShowRef]  = useState(true); // dibujar modelo indeformado como referencia

  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number>(0);

  // ── Fetch de la historia ────────────────────────────────────────────────────
  useEffect(() => {
    let mounted = true;
    setLoading(true); setError(null); setHistory(null); setFrameIdx(0); setPlaying(false);
    structuralAnalysisApi.nlPushoverHistory(projectId, direction, 60)
      .then((h) => { if (mounted) { setHistory(h); setLoading(false); } })
      .catch((e: Error) => { if (mounted) { setError(e.message || "Error al cargar historia"); setLoading(false); } });
    return () => { mounted = false; };
  }, [projectId, direction]);

  // ── Agrupa pieres por damage level ──────────────────────────────────────────
  const groups = useMemo(() => {
    if (!history) return {} as Record<DamageLevel, PierLineDeformable[]>;
    const g: Record<DamageLevel, PierLineDeformable[]> = {
      none: [], minor: [], moderate: [], severe: [], collapse: [],
    };
    for (const pl of history.pier_lines) g[pl.damage.level].push(pl);
    return g;
  }, [history]);

  const currentFrame = history?.frames[frameIdx];

  // ── Traces reactive al frame + amp ─────────────────────────────────────────
  const traces = useMemo(() => {
    if (!history || !currentFrame) return [];
    const disp = currentFrame.disp;
    const out: object[] = [];

    // Modelo indeformado (referencia gris)
    if (showRef) {
      const refDisp: Record<string, [number, number, number]> = {};
      out.push(buildDamageTrace(history.pier_lines, refDisp, 0, "rgba(148,163,184,0.35)", "Referencia"));
    }

    // Deformado agrupado por daño
    (["none", "minor", "moderate", "severe", "collapse"] as DamageLevel[]).forEach((lvl) => {
      const piers = groups[lvl];
      if (piers.length === 0) return;
      out.push(buildDamageTrace(piers, disp, amp, DAMAGE_COLOR[lvl], `${DAMAGE_LABEL[lvl]} (${piers.length})`));
    });

    return out;
  }, [history, currentFrame, groups, amp, showRef]);

  // ── Render Plotly ───────────────────────────────────────────────────────────
  const initialized = useRef(false);
  useEffect(() => {
    if (!plotlyReady || !containerRef.current || traces.length === 0) return;
    const Plotly = window.Plotly;
    if (!Plotly) return;
    const layout = {
      paper_bgcolor: "transparent",
      plot_bgcolor:  "transparent",
      margin: { t: 10, r: 10, b: 10, l: 10 },
      scene: {
        aspectmode: "data",
        xaxis: { title: "X (m)", gridcolor: "rgba(148,163,184,0.15)", zerolinecolor: "rgba(148,163,184,0.25)" },
        yaxis: { title: "Y (m)", gridcolor: "rgba(148,163,184,0.15)", zerolinecolor: "rgba(148,163,184,0.25)" },
        zaxis: { title: "Z (m)", gridcolor: "rgba(148,163,184,0.15)", zerolinecolor: "rgba(148,163,184,0.25)" },
        camera: { eye: { x: 1.6, y: 1.6, z: 0.8 } },
      },
      legend: { x: 0.02, y: 0.98, bgcolor: "rgba(0,0,0,0)", font: { size: 10 } },
    };
    if (!initialized.current) {
      Plotly.newPlot(containerRef.current, traces, layout, { responsive: true, displayModeBar: false });
      initialized.current = true;
    } else {
      Plotly.react(containerRef.current, traces, layout, { responsive: true, displayModeBar: false });
    }
  }, [plotlyReady, traces]);

  // ── Animación play/pause con requestAnimationFrame ─────────────────────────
  useEffect(() => {
    if (!playing || !history) return;
    const MS_PER_FRAME = 80;
    const tick = (ts: number) => {
      if (ts - lastTsRef.current >= MS_PER_FRAME) {
        lastTsRef.current = ts;
        setFrameIdx((i) => {
          const next = i + 1;
          if (next >= history.frames.length) { setPlaying(false); return history.frames.length - 1; }
          return next;
        });
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [playing, history]);

  // ═════════════════════════════════════════════════════════════════════════
  if (loading) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 flex items-center justify-center" style={{ height }}>
        <p className="text-sm text-[var(--text-muted)] animate-pulse">Cargando historia del pushover...</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6" style={{ height }}>
        <p className="text-sm text-red-600 font-medium">Error al cargar la deformada</p>
        <p className="text-xs text-[var(--text-muted)] mt-1">{error}</p>
      </div>
    );
  }
  if (!history) return null;

  const dmgSummary = (["none", "minor", "moderate", "severe", "collapse"] as DamageLevel[])
    .map((lvl) => ({ lvl, n: groups[lvl].length }))
    .filter((x) => x.n > 0);

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
      {/* Header + controles */}
      <div className="px-4 py-3 border-b border-[var(--border)] bg-[var(--surface-2)] flex items-center gap-3 flex-wrap">
        <span className="text-xs font-semibold text-[var(--text)] uppercase tracking-wider">
          Deformada Pushover — Dir {direction}
        </span>
        <span className="text-[11px] text-[var(--text-muted)]">
          Paso <span className="font-mono font-medium">{currentFrame?.step ?? 0}</span> ·
          Deriva <span className="font-mono font-medium">{(currentFrame?.drift_pct ?? 0).toFixed(3)}%</span> ·
          Vb <span className="font-mono font-medium">{(currentFrame?.base_shear_kN ?? 0).toFixed(1)} kN</span>
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => { setFrameIdx(0); setPlaying(false); }}
            className="px-2 py-1 rounded text-[11px] bg-[var(--surface)] hover:bg-[var(--border)] text-[var(--text)]"
            title="Reiniciar"
          >⏮</button>
          <button
            onClick={() => setPlaying((p) => !p)}
            className="px-3 py-1 rounded text-[11px] font-medium bg-[var(--accent)] text-white hover:opacity-90"
          >
            {playing ? "⏸ Pausa" : "▶ Reproducir"}
          </button>
          <label className="flex items-center gap-1 text-[11px] text-[var(--text-muted)] cursor-pointer">
            <input type="checkbox" checked={showRef} onChange={(e) => setShowRef(e.target.checked)} className="rounded" />
            Referencia
          </label>
        </div>
      </div>

      {/* Slider + amp */}
      <div className="px-4 py-2 border-b border-[var(--border)] flex items-center gap-4">
        <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider whitespace-nowrap">Paso</span>
        <input
          type="range" min={0} max={history.frames.length - 1} value={frameIdx}
          onChange={(e) => setFrameIdx(Number(e.target.value))}
          className="flex-1 accent-[var(--accent)]"
        />
        <span className="text-[11px] font-mono text-[var(--text)] w-14 text-right">
          {frameIdx + 1}/{history.frames.length}
        </span>
        <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider whitespace-nowrap ml-4">Amplificación</span>
        <input
          type="range" min={1} max={500} step={5} value={amp}
          onChange={(e) => setAmp(Number(e.target.value))}
          className="w-32 accent-[var(--accent)]"
        />
        <span className="text-[11px] font-mono text-[var(--text)] w-10 text-right">{amp}×</span>
      </div>

      {/* Plot */}
      <div ref={containerRef} style={{ height, width: "100%" }} />

      {/* Leyenda de daño */}
      <div className="px-4 py-2 border-t border-[var(--border)] flex items-center gap-4 text-[11px] flex-wrap bg-[var(--surface-2)]">
        {dmgSummary.map(({ lvl, n }) => (
          <span key={lvl} className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm border" style={{ background: DAMAGE_COLOR[lvl], borderColor: DAMAGE_COLOR[lvl] }} />
            <span className="text-[var(--text-muted)]">{DAMAGE_LABEL[lvl]}</span>
            <span className="font-mono font-medium text-[var(--text)]">×{n}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
