"use client";

/**
 * Building2DPlanView — Vista en planta 2D por piso, SVG puro.
 *
 * Renderiza el layout XY de un piso específico usando SVG con coordenadas
 * del modelo directamente (sin inversión Y). Convención: X hacia la derecha,
 * Y hacia abajo (como SVG nativo). Se agregarán ejes claros para que el
 * usuario entienda la orientación.
 *
 * Los muros consolidados por pier se dibujan con dimensiones REALES
 * amplificadas visualmente para que sean legibles.
 */
import { useMemo, useRef, useState, useCallback, useEffect } from "react";
import type { ModelGeometry, SectionData } from "@/lib/structural-types";

interface Props {
  geometry: ModelGeometry;
  initialStory?: string;
  height?: number;
  sections?: Record<string, SectionData>;
  onElementClick?: (info: { id: string; type: "slab" | "wall" | "beam" | "column"; label: string }) => void;
}

interface HoverInfo { x: number; y: number; label: string; section?: string; extra?: string; }

const COLORS = {
  slabFill:   "rgba(59, 130, 246, 0.10)",
  slabLine:   "#3b82f6",
  wall:       "#0f766e",
  wallFill:   "rgba(15, 118, 110, 0.75)",
  wallLbl:    "#083f39",
  beam:       "#475569",
  beamFill:   "rgba(100, 116, 139, 0.60)",
  column:     "#b91c1c",
  columnFill: "rgba(220, 38, 38, 0.80)",
  grid:       "rgba(148, 163, 184, 0.20)",
  gridBold:   "rgba(148, 163, 184, 0.45)",
  axisX:      "#dc2626",
  axisY:      "#059669",
};

export default function Building2DPlanView({
  geometry,
  initialStory,
  height = 640,
  sections,
  onElementClick,
}: Props) {
  const storiesOrdered = useMemo(() => {
    return Object.entries(geometry.stories)
      .map(([name, info]) => ({ name, z: info.elevation_m ?? 0 }))
      .sort((a, b) => a.z - b.z)
      .map((s) => s.name);
  }, [geometry.stories]);

  const defaultStory = initialStory
    ?? storiesOrdered.find((s) => (geometry.stories[s]?.elevation_m ?? 0) > 0)
    ?? storiesOrdered[storiesOrdered.length - 1]
    ?? "";

  const [story, setStory] = useState<string>(defaultStory);
  const [showGrid, setShowGrid] = useState(true);
  const [showLabels, setShowLabels] = useState(false);
  const [showSlabs, setShowSlabs] = useState(true);
  const [showWalls, setShowWalls] = useState(true);
  const [showFrames, setShowFrames] = useState(true);
  const [wallEmphasis, setWallEmphasis] = useState(true);   // muestra tw amplificado
  const [hover, setHover] = useState<HoverInfo | null>(null);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; startPan: { x: number; y: number } } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // ── Filtros ────────────────────────────────────────────────────────────────
  const slabsInStory = useMemo(() =>
    Object.entries(geometry.shells).filter(([, s]) => s.element_type === "slab" && s.story === story),
    [geometry.shells, story],
  );

  const wallsInStory = useMemo(() => {
    interface WallGroup {
      key: string; pier: string; section: string; thickness_m: number;
      shell_ids: string[];
      allXY: { x: number; y: number }[];
    }
    const groups = new Map<string, WallGroup>();
    for (const [shellId, s] of Object.entries(geometry.shells)) {
      if (s.element_type !== "wall") continue;
      if (s.story !== story) continue;
      const key = (s.pier || shellId) + "|" + (s.section || "");
      let g = groups.get(key);
      if (!g) {
        g = {
          key, pier: s.pier || shellId, section: s.section,
          thickness_m: s.thickness_m ?? 0.2, shell_ids: [], allXY: [],
        };
        groups.set(key, g);
      }
      g.shell_ids.push(shellId);
      for (const jl of s.joints) {
        const j = geometry.joints[jl];
        if (!j) continue;
        if (!g.allXY.some((u) => Math.abs(u.x - j.x) < 1e-4 && Math.abs(u.y - j.y) < 1e-4)) {
          g.allXY.push({ x: j.x, y: j.y });
        }
      }
    }
    return [...groups.values()];
  }, [geometry.shells, geometry.joints, story]);

  const framesInStory = useMemo(() =>
    Object.entries(geometry.frames).filter(([, f]) => f.story === story),
    [geometry.frames, story],
  );

  // ── Bounds del modelo ─────────────────────────────────────────────────────
  const bounds = useMemo(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const consider = (x: number, y: number) => {
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    };
    for (const [, s] of slabsInStory)
      for (const jl of s.joints) { const j = geometry.joints[jl]; if (j) consider(j.x, j.y); }
    for (const g of wallsInStory)
      for (const p of g.allXY) consider(p.x, p.y);
    for (const [, f] of framesInStory) {
      const ji = geometry.joints[f.joint_i]; const jj = geometry.joints[f.joint_j];
      if (ji) consider(ji.x, ji.y); if (jj) consider(jj.x, jj.y);
    }
    if (!isFinite(minX)) for (const j of Object.values(geometry.joints)) consider(j.x, j.y);
    if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    return { minX, minY, maxX, maxY };
  }, [slabsInStory, wallsInStory, framesInStory, geometry.joints]);

  const rawW = Math.max(bounds.maxX - bounds.minX, 1);
  const rawH = Math.max(bounds.maxY - bounds.minY, 1);
  const PAD_M = Math.max(rawW, rawH) * 0.10;   // 10% del rango como padding

  // ── ViewBox: usamos coord modelo directamente. Como SVG y crece hacia
  //     abajo, aplicamos transform "scale(1,-1)" al grupo raíz y compensamos
  //     el translate para mantener el contenido en el viewbox.
  const vbW = (rawW + 2 * PAD_M) / zoom;
  const vbH = (rawH + 2 * PAD_M) / zoom;
  const vbX = bounds.minX - PAD_M + pan.x;
  const vbY = bounds.minY - PAD_M + pan.y;
  const viewBox = `${vbX} ${vbY} ${vbW} ${vbH}`;

  // Con el transform scale(1,-1), lo que dibujamos en y' cae en -y' del SVG.
  // Para que quede dentro del viewbox, necesitamos trasladar el eje Y del
  // grupo por (2*centro_Y). Alternativa más simple: NO invertimos y aceptamos
  // que Y crezca hacia abajo (SVG nativo). Esto es lo que hacemos aquí.
  // Los textos y ejes se dibujan tal cual (Y hacia abajo).

  // ── Grid ──────────────────────────────────────────────────────────────────
  const gridStep = useMemo(() => {
    const span = Math.max(rawW, rawH);
    if (span >= 40) return 5; if (span >= 20) return 2;
    if (span >= 8) return 1; return 0.5;
  }, [rawW, rawH]);

  // ── Zoom/Pan handlers ────────────────────────────────────────────────────
  const onWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setZoom((z) => Math.min(20, Math.max(0.2, z * factor)));
  }, []);
  const onMouseDown = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    dragRef.current = { x: e.clientX, y: e.clientY, startPan: { ...pan } };
  }, [pan]);
  const onMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (!dragRef.current || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const scaleX = vbW / rect.width;
    const scaleY = vbH / rect.height;
    setPan({
      x: dragRef.current.startPan.x - (e.clientX - dragRef.current.x) * scaleX,
      y: dragRef.current.startPan.y - (e.clientY - dragRef.current.y) * scaleY,
    });
  }, [vbW, vbH]);
  const endDrag = useCallback(() => { dragRef.current = null; }, []);
  const resetView = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, []);

  useEffect(() => { resetView(); }, [story, resetView]);

  // ── Helpers geométricos ───────────────────────────────────────────────────
  const orientedRectPoints = (
    ax: number, ay: number, bx: number, by: number, widthLat: number,
  ): string => {
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) {
      const s = widthLat / 2;
      return `${ax - s},${ay - s} ${ax + s},${ay - s} ${ax + s},${ay + s} ${ax - s},${ay + s}`;
    }
    const ux = dx / len, uy = dy / len;
    const nx = -uy, ny = ux;
    const hw = widthLat / 2;
    return [
      [ax + nx * hw, ay + ny * hw],
      [bx + nx * hw, by + ny * hw],
      [bx - nx * hw, by - ny * hw],
      [ax - nx * hw, ay - ny * hw],
    ].map((p) => `${p[0]},${p[1]}`).join(" ");
  };

  const twEmphasized = (tw: number) => {
    if (!wallEmphasis) return Math.max(tw || 0.2, 0.05);
    // Amplifica el espesor para que sea legible manteniendo proporción visual.
    const factor = Math.max(rawW, rawH) / 60;   // ≈ 0.5m para edificios de 30m
    return Math.max(tw || 0.2, 0.05, factor);
  };

  // ── Renderers ─────────────────────────────────────────────────────────────
  const renderSlab = (id: string, joints: string[], section: string) => {
    const pts = joints
      .map((jl) => geometry.joints[jl]).filter(Boolean)
      .map((j) => `${j.x},${j.y}`).join(" ");
    if (!pts) return null;
    return (
      <polygon key={`slab-${id}`} points={pts}
        fill={COLORS.slabFill} stroke={COLORS.slabLine} strokeWidth={1.2}
        strokeLinejoin="round" vectorEffect="non-scaling-stroke"
        onMouseEnter={(e) => setHover({ x: e.clientX, y: e.clientY, label: id, section, extra: "Losa" })}
        onMouseLeave={() => setHover(null)}
        onClick={() => onElementClick?.({ id, type: "slab", label: id })}
        style={{ cursor: onElementClick ? "pointer" : "default" }}
      />
    );
  };

  const renderWallGroup = (g: {
    key: string; pier: string; section: string; thickness_m: number;
    shell_ids: string[]; allXY: { x: number; y: number }[];
  }) => {
    if (g.allXY.length < 2) return null;
    let a = g.allXY[0], b = g.allXY[1], maxD = 0;
    for (let i = 0; i < g.allXY.length; i++)
      for (let j = i + 1; j < g.allXY.length; j++) {
        const d = (g.allXY[i].x - g.allXY[j].x) ** 2 + (g.allXY[i].y - g.allXY[j].y) ** 2;
        if (d > maxD) { maxD = d; a = g.allXY[i]; b = g.allXY[j]; }
      }
    const lw = Math.hypot(b.x - a.x, b.y - a.y);
    const twReal = g.thickness_m || 0.2;
    const twDraw = twEmphasized(twReal);
    const points = orientedRectPoints(a.x, a.y, b.x, b.y, twDraw);
    const firstId = g.shell_ids[0] ?? g.pier;
    return (
      <polygon key={`wall-${g.key}`} points={points}
        fill={COLORS.wallFill} stroke={COLORS.wall} strokeWidth={1.5}
        strokeLinejoin="miter" vectorEffect="non-scaling-stroke"
        onMouseEnter={(e) => setHover({
          x: e.clientX, y: e.clientY, label: g.pier, section: g.section,
          extra: `Muro · lw=${lw.toFixed(2)}m tw=${twReal.toFixed(3)}m · ${g.shell_ids.length} sub-paneles`,
        })}
        onMouseLeave={() => setHover(null)}
        onClick={() => onElementClick?.({ id: firstId, type: "wall", label: g.pier })}
        style={{ cursor: onElementClick ? "pointer" : "default" }}
      />
    );
  };

  const renderColumn = (id: string, jx: number, jy: number, section: string) => {
    const sec = sections?.[section];
    const h = sec?.h_m ?? 0.3;
    const b = sec?.b_m ?? 0.3;
    const halfH = h / 2, halfB = b / 2;
    const points =
      `${jx - halfH},${jy - halfB} ${jx + halfH},${jy - halfB} ` +
      `${jx + halfH},${jy + halfB} ${jx - halfH},${jy + halfB}`;
    return (
      <polygon key={`col-${id}`} points={points}
        fill={COLORS.columnFill} stroke={COLORS.column} strokeWidth={1.2}
        vectorEffect="non-scaling-stroke"
        onMouseEnter={(e) => setHover({ x: e.clientX, y: e.clientY, label: id, section, extra: `Columna · h=${h.toFixed(2)}m b=${b.toFixed(2)}m` })}
        onMouseLeave={() => setHover(null)}
        onClick={() => onElementClick?.({ id, type: "column", label: id })}
        style={{ cursor: onElementClick ? "pointer" : "default" }}
      />
    );
  };

  const renderBeam = (id: string, ax: number, ay: number, bx: number, by: number, section: string) => {
    const sec = sections?.[section];
    const bWidth = sec?.b_m ?? 0.25;
    const length = Math.hypot(bx - ax, by - ay);
    const points = orientedRectPoints(ax, ay, bx, by, Math.max(bWidth, 0.08));
    return (
      <polygon key={`beam-${id}`} points={points}
        fill={COLORS.beamFill} stroke={COLORS.beam} strokeWidth={0.9}
        strokeLinejoin="miter" vectorEffect="non-scaling-stroke"
        onMouseEnter={(e) => setHover({ x: e.clientX, y: e.clientY, label: id, section, extra: `Viga · L=${length.toFixed(2)}m b=${bWidth.toFixed(2)}m` })}
        onMouseLeave={() => setHover(null)}
        onClick={() => onElementClick?.({ id, type: "beam", label: id })}
        style={{ cursor: onElementClick ? "pointer" : "default" }}
      />
    );
  };

  // ── Grid + ejes ───────────────────────────────────────────────────────────
  const gridLines: React.ReactElement[] = [];
  if (showGrid) {
    const gxStart = Math.floor(vbX / gridStep) * gridStep;
    const gxEnd   = Math.ceil((vbX + vbW) / gridStep) * gridStep;
    const gyStart = Math.floor(vbY / gridStep) * gridStep;
    const gyEnd   = Math.ceil((vbY + vbH) / gridStep) * gridStep;
    for (let x = gxStart; x <= gxEnd + 1e-9; x += gridStep) {
      const bold = Math.abs(x) < 1e-6;
      gridLines.push(
        <line key={`gx-${x.toFixed(3)}`} x1={x} y1={vbY} x2={x} y2={vbY + vbH}
          stroke={bold ? COLORS.axisX : COLORS.grid} strokeWidth={bold ? 1.5 : 0.7}
          vectorEffect="non-scaling-stroke" />
      );
    }
    for (let y = gyStart; y <= gyEnd + 1e-9; y += gridStep) {
      const bold = Math.abs(y) < 1e-6;
      gridLines.push(
        <line key={`gy-${y.toFixed(3)}`} x1={vbX} y1={y} x2={vbX + vbW} y2={y}
          stroke={bold ? COLORS.axisY : COLORS.grid} strokeWidth={bold ? 1.5 : 0.7}
          vectorEffect="non-scaling-stroke" />
      );
    }
  }

  const wallLabels = useMemo(() => {
    if (!showLabels) return [];
    return wallsInStory.map((g) => {
      if (g.allXY.length === 0) return null;
      const cx = g.allXY.reduce((a, p) => a + p.x, 0) / g.allXY.length;
      const cy = g.allXY.reduce((a, p) => a + p.y, 0) / g.allXY.length;
      return { pier: g.pier, cx, cy };
    }).filter(Boolean) as { pier: string; cx: number; cy: number }[];
  }, [wallsInStory, showLabels]);

  const counts = {
    slabs: slabsInStory.length,
    walls: wallsInStory.length,
    subPanels: wallsInStory.reduce((a, g) => a + g.shell_ids.length, 0),
    frames: framesInStory.length,
    columns: framesInStory.filter(([, f]) => f.element_type === "column").length,
    beams: framesInStory.filter(([, f]) => f.element_type === "beam").length,
  };

  const labelFontSize = Math.max(0.25, rawH / 100);

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
      {/* Toolbar */}
      <div className="px-4 py-2.5 border-b border-[var(--border)] bg-[var(--surface-2)] flex items-center gap-3 flex-wrap text-xs">
        <span className="font-semibold text-[var(--text)] uppercase tracking-wider">Planta 2D</span>
        <select
          value={story}
          onChange={(e) => setStory(e.target.value)}
          className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text)]"
        >
          {storiesOrdered.map((s) => (
            <option key={s} value={s}>{s} · z={(geometry.stories[s]?.elevation_m ?? 0).toFixed(2)} m</option>
          ))}
        </select>

        <div className="flex items-center gap-1 ml-2">
          <ToggleChip active={showSlabs}  onClick={() => setShowSlabs((v) => !v)}  label={`Losas (${counts.slabs})`} />
          <ToggleChip active={showWalls}  onClick={() => setShowWalls((v) => !v)}  label={`Muros (${counts.walls})`} />
          <ToggleChip active={showFrames} onClick={() => setShowFrames((v) => !v)} label={`Marcos (${counts.frames})`} />
          <ToggleChip active={showGrid}   onClick={() => setShowGrid((v) => !v)}   label="Grid+Ejes" />
          <ToggleChip active={showLabels} onClick={() => setShowLabels((v) => !v)} label="Etiquetas" />
          <ToggleChip active={wallEmphasis} onClick={() => setWallEmphasis((v) => !v)} label="Amplif. muros" />
        </div>

        <span className="ml-auto text-[10px] text-[var(--text-muted)] font-mono">
          {rawW.toFixed(1)}×{rawH.toFixed(1)} m · zoom {zoom.toFixed(2)}× · {counts.subPanels} sub-paneles → {counts.walls} muros
        </span>
        <button onClick={resetView} className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text)] px-2 py-1 rounded border border-[var(--border)]">
          Reset
        </button>
      </div>

      <div className="relative bg-[var(--surface)]" style={{ height }}>
        <svg
          ref={svgRef}
          viewBox={viewBox}
          preserveAspectRatio="xMidYMid meet"
          onWheel={onWheel}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={endDrag}
          onMouseLeave={endDrag}
          style={{ width: "100%", height: "100%", cursor: dragRef.current ? "grabbing" : "grab", background: "var(--surface)" }}
        >
          {gridLines}

          {/* Origen (0,0) */}
          <circle cx={0} cy={0} r={0.2}
            fill="none" stroke="#f59e0b" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />

          {/* Losas primero (fondo) */}
          {showSlabs && slabsInStory.map(([id, s]) => renderSlab(id, s.joints, s.section))}

          {/* Marcos (columnas y vigas) por debajo de muros */}
          {showFrames && framesInStory.map(([id, f]) => {
            const ji = geometry.joints[f.joint_i]; const jj = geometry.joints[f.joint_j];
            if (!ji || !jj) return null;
            if (f.element_type === "column") return renderColumn(id, ji.x, ji.y, f.section);
            return renderBeam(id, ji.x, ji.y, jj.x, jj.y, f.section);
          })}

          {/* Muros arriba de todo */}
          {showWalls && wallsInStory.map((g) => renderWallGroup(g))}

          {/* Etiquetas de pier */}
          {showLabels && wallLabels.map(({ pier, cx, cy }) => (
            <text key={`lbl-${pier}`} x={cx} y={cy}
              fill={COLORS.wallLbl} fontSize={labelFontSize}
              textAnchor="middle" dominantBaseline="middle"
              style={{ pointerEvents: "none", userSelect: "none", fontWeight: 600 }}
            >
              {pier}
            </text>
          ))}
        </svg>

        {/* Tooltip */}
        {hover && (
          <div
            className="pointer-events-none rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11px] shadow-lg"
            style={{ left: hover.x + 12, top: hover.y + 12, position: "fixed" }}
          >
            <div className="font-semibold text-[var(--text)]">{hover.label}</div>
            {hover.extra && <div className="text-[var(--text-muted)]">{hover.extra}</div>}
            {hover.section && <div className="text-[var(--text-muted)] font-mono">{hover.section}</div>}
          </div>
        )}

        {/* Leyenda */}
        <div className="absolute bottom-2 left-2 flex items-center gap-3 rounded-md border border-[var(--border)] bg-[var(--surface)]/95 backdrop-blur px-3 py-1.5 text-[11px] shadow-sm">
          <LegendChip fill={COLORS.slabFill}   stroke={COLORS.slabLine} label="Losa" />
          <LegendChip fill={COLORS.wallFill}   stroke={COLORS.wall}     label="Muro" />
          <LegendChip fill={COLORS.columnFill} stroke={COLORS.column}   label="Columna" />
          <LegendChip fill={COLORS.beamFill}   stroke={COLORS.beam}     label="Viga" />
          <span className="text-[var(--text-muted)] ml-2 font-mono">grid {gridStep} m</span>
          <span className="text-[var(--axisX,#dc2626)] font-mono">— +X</span>
          <span className="text-[var(--axisY,#059669)] font-mono">| +Y</span>
        </div>
      </div>
    </div>
  );
}

function ToggleChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick}
      className={[
        "px-2 py-0.5 rounded text-[10px] font-medium transition-colors",
        active
          ? "bg-[var(--accent)] text-white"
          : "bg-[var(--surface)] text-[var(--text-muted)] border border-[var(--border)] hover:text-[var(--text)]",
      ].join(" ")}>
      {label}
    </button>
  );
}

function LegendChip({ fill, stroke, label }: { fill: string; stroke: string; label: string }) {
  return (
    <span className="flex items-center gap-1 text-[var(--text-muted)]">
      <span style={{ width: 14, height: 8, background: fill, border: `1px solid ${stroke}`, display: "inline-block", borderRadius: 1 }} />
      {label}
    </span>
  );
}
