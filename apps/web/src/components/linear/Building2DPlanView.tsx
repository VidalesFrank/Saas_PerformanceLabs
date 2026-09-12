"use client";

/**
 * Building2DPlanView — Vista en planta 2D por piso, SVG puro.
 *
 * Renderiza el layout XY de un piso específico: losas como polígonos, muros
 * como segmentos (proyección vertical), columnas como puntos y vigas como
 * líneas. Auto-escala al bounding box, con pan/zoom y tooltip on hover.
 *
 * No requiere dependencias externas. Se apoya solo en la geometría del modelo
 * canónico (Record<joints, {x,y,z,story}> + shells + frames). Ideal para
 * verificación rápida del layout sin cargar Plotly.
 */
import { useMemo, useRef, useState, useCallback } from "react";
import type { ModelGeometry } from "@/lib/structural-types";

interface Props {
  geometry: ModelGeometry;
  /** Piso inicial. Si no se pasa, se elige el primero no-base. */
  initialStory?: string;
  height?: number;
  onElementClick?: (info: { id: string; type: "slab" | "wall" | "beam" | "column"; label: string }) => void;
}

interface Bounds {
  minX: number; minY: number; maxX: number; maxY: number;
}

interface HoverInfo {
  x: number; y: number;
  label: string;
  section?: string;
  extra?: string;
}

const COLORS = {
  slabFill:  "rgba(59, 130, 246, 0.14)",
  slabLine:  "#3b82f6",
  wall:      "#0f766e",
  wallLbl:   "#0f766e",
  beam:      "#64748b",
  column:    "#dc2626",
  support:   "#111827",
  grid:      "rgba(148, 163, 184, 0.2)",
  gridBold:  "rgba(148, 163, 184, 0.45)",
};

export default function Building2DPlanView({
  geometry,
  initialStory,
  height = 640,
  onElementClick,
}: Props) {
  // ── Stories disponibles ordenadas por elevación ────────────────────────────
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
  const [hover, setHover] = useState<HoverInfo | null>(null);

  // Pan + zoom locales al SVG (viewbox transform)
  const [zoom, setZoom] = useState(1);
  const [pan, setPan]   = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; startPan: { x: number; y: number } } | null>(null);

  // ── Filtro por piso ────────────────────────────────────────────────────────
  const slabsInStory = useMemo(() => {
    return Object.entries(geometry.shells).filter(
      ([, s]) => s.element_type === "slab" && s.story === story,
    );
  }, [geometry.shells, story]);

  const wallsInStory = useMemo(() => {
    return Object.entries(geometry.shells).filter(
      ([, s]) => s.element_type === "wall" && s.story === story,
    );
  }, [geometry.shells, story]);

  const framesInStory = useMemo(() => {
    return Object.entries(geometry.frames).filter(([, f]) => f.story === story);
  }, [geometry.frames, story]);

  // ── Bounds XY del piso ─────────────────────────────────────────────────────
  const bounds: Bounds = useMemo(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const consider = (x: number, y: number) => {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    };
    for (const [, s] of slabsInStory) {
      for (const jl of s.joints) {
        const j = geometry.joints[jl];
        if (j) consider(j.x, j.y);
      }
    }
    for (const [, s] of wallsInStory) {
      for (const jl of s.joints) {
        const j = geometry.joints[jl];
        if (j) consider(j.x, j.y);
      }
    }
    for (const [, f] of framesInStory) {
      const ji = geometry.joints[f.joint_i];
      const jj = geometry.joints[f.joint_j];
      if (ji) consider(ji.x, ji.y);
      if (jj) consider(jj.x, jj.y);
    }
    // fallback: si no hay nada, usa toda la geometría del edificio
    if (!isFinite(minX)) {
      for (const j of Object.values(geometry.joints)) consider(j.x, j.y);
    }
    if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    return { minX, minY, maxX, maxY };
  }, [slabsInStory, wallsInStory, framesInStory, geometry.joints]);

  // ── ViewBox con padding + zoom + pan ───────────────────────────────────────
  const PAD_M = 2; // metros de margen visible alrededor de la geometría
  const rawW = Math.max(bounds.maxX - bounds.minX, 1);
  const rawH = Math.max(bounds.maxY - bounds.minY, 1);
  const vbW = (rawW + 2 * PAD_M) / zoom;
  const vbH = (rawH + 2 * PAD_M) / zoom;
  const vbX = bounds.minX - PAD_M + pan.x;
  const vbY = bounds.minY - PAD_M + pan.y;
  const viewBox = `${vbX} ${vbY} ${vbW} ${vbH}`;

  // El SVG usa Y-invertido para respetar "arriba en pantalla = +Y del modelo".
  // Convención estándar SVG: y crece hacia abajo → aplicamos scale(-1) en Y.

  // ── Grid dinámico ──────────────────────────────────────────────────────────
  const gridStep = useMemo(() => {
    const span = Math.max(rawW, rawH);
    if (span >= 40) return 5;
    if (span >= 20) return 2;
    if (span >= 8)  return 1;
    return 0.5;
  }, [rawW, rawH]);

  // ── Handlers de pan / zoom ─────────────────────────────────────────────────
  const svgRef = useRef<SVGSVGElement | null>(null);

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
    const dx = (e.clientX - dragRef.current.x) * scaleX;
    const dy = (e.clientY - dragRef.current.y) * scaleY;
    setPan({ x: dragRef.current.startPan.x - dx, y: dragRef.current.startPan.y + dy });
  }, [vbW, vbH]);

  const endDrag = useCallback(() => { dragRef.current = null; }, []);

  const resetView = useCallback(() => {
    setZoom(1); setPan({ x: 0, y: 0 });
  }, []);

  // ── Renderers ──────────────────────────────────────────────────────────────
  const renderSlab = (id: string, joints: string[], section: string) => {
    const pts = joints
      .map((jl) => geometry.joints[jl])
      .filter(Boolean)
      .map((j) => `${j.x},${-j.y}`)
      .join(" ");
    if (!pts) return null;
    return (
      <polygon
        key={`slab-${id}`}
        points={pts}
        fill={COLORS.slabFill}
        stroke={COLORS.slabLine}
        strokeWidth={0.03}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        onMouseEnter={(e) => setHover({ x: e.clientX, y: e.clientY, label: id, section, extra: "Losa" })}
        onMouseLeave={() => setHover(null)}
        onClick={() => onElementClick?.({ id, type: "slab", label: id })}
        style={{ cursor: onElementClick ? "pointer" : "default" }}
      />
    );
  };

  const renderWall = (id: string, joints: string[], section: string, pier: string | undefined) => {
    // Un muro es un plano vertical: sus 4 joints tienen 2 posiciones únicas en XY.
    const unique: { x: number; y: number }[] = [];
    for (const jl of joints) {
      const j = geometry.joints[jl];
      if (!j) continue;
      if (!unique.some((u) => Math.abs(u.x - j.x) < 1e-4 && Math.abs(u.y - j.y) < 1e-4)) {
        unique.push({ x: j.x, y: j.y });
      }
    }
    if (unique.length < 2) return null;
    // Toma los dos vértices más separados como los extremos del muro en planta.
    let a = unique[0], b = unique[1], maxD = 0;
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const d = (unique[i].x - unique[j].x) ** 2 + (unique[i].y - unique[j].y) ** 2;
        if (d > maxD) { maxD = d; a = unique[i]; b = unique[j]; }
      }
    }
    const label = pier ? `${pier} (${id})` : id;
    return (
      <line
        key={`wall-${id}`}
        x1={a.x} y1={-a.y} x2={b.x} y2={-b.y}
        stroke={COLORS.wall}
        strokeWidth={0.12}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        onMouseEnter={(e) => setHover({ x: e.clientX, y: e.clientY, label, section, extra: pier ? `Muro (pier ${pier})` : "Muro" })}
        onMouseLeave={() => setHover(null)}
        onClick={() => onElementClick?.({ id, type: "wall", label })}
        style={{ cursor: onElementClick ? "pointer" : "default" }}
      />
    );
  };

  // ── Column: joint_i y joint_j comparten XY (vertical) → un punto en planta.
  const renderColumn = (id: string, jx: number, jy: number, section: string) => (
    <g
      key={`col-${id}`}
      onMouseEnter={(e) => setHover({ x: e.clientX, y: e.clientY, label: id, section, extra: "Columna" })}
      onMouseLeave={() => setHover(null)}
      onClick={() => onElementClick?.({ id, type: "column", label: id })}
      style={{ cursor: onElementClick ? "pointer" : "default" }}
    >
      <rect x={jx - 0.15} y={-jy - 0.15} width={0.3} height={0.3} fill={COLORS.column} vectorEffect="non-scaling-stroke" />
    </g>
  );

  const renderBeam = (id: string, ax: number, ay: number, bx: number, by: number, section: string) => (
    <line
      key={`beam-${id}`}
      x1={ax} y1={-ay} x2={bx} y2={-by}
      stroke={COLORS.beam}
      strokeWidth={0.04}
      strokeDasharray="0.15 0.1"
      vectorEffect="non-scaling-stroke"
      onMouseEnter={(e) => setHover({ x: e.clientX, y: e.clientY, label: id, section, extra: "Viga" })}
      onMouseLeave={() => setHover(null)}
      onClick={() => onElementClick?.({ id, type: "beam", label: id })}
      style={{ cursor: onElementClick ? "pointer" : "default" }}
    />
  );

  // ── Grid ───────────────────────────────────────────────────────────────────
  const gridLines: React.ReactElement[] = [];
  if (showGrid) {
    const gxStart = Math.floor(vbX / gridStep) * gridStep;
    const gxEnd   = Math.ceil((vbX + vbW) / gridStep) * gridStep;
    const gyStart = Math.floor(vbY / gridStep) * gridStep;
    const gyEnd   = Math.ceil((vbY + vbH) / gridStep) * gridStep;
    let i = 0;
    for (let x = gxStart; x <= gxEnd; x += gridStep, i++) {
      const bold = Math.abs(x) < 1e-6 || i % 5 === 0;
      gridLines.push(
        <line key={`gx-${x}`} x1={x} y1={vbY} x2={x} y2={vbY + vbH}
          stroke={bold ? COLORS.gridBold : COLORS.grid} strokeWidth={0.02}
          vectorEffect="non-scaling-stroke" />
      );
    }
    let j = 0;
    for (let y = gyStart; y <= gyEnd; y += gridStep, j++) {
      const bold = Math.abs(y) < 1e-6 || j % 5 === 0;
      gridLines.push(
        <line key={`gy-${y}`} x1={vbX} y1={y} x2={vbX + vbW} y2={y}
          stroke={bold ? COLORS.gridBold : COLORS.grid} strokeWidth={0.02}
          vectorEffect="non-scaling-stroke" />
      );
    }
  }

  const wallLabels = useMemo(() => {
    if (!showLabels) return [];
    const seen = new Set<string>();
    return wallsInStory
      .map(([id, s]) => {
        const pier = s.pier || id;
        if (seen.has(pier)) return null;
        seen.add(pier);
        const joints = s.joints
          .map((jl) => geometry.joints[jl])
          .filter(Boolean);
        if (joints.length === 0) return null;
        const cx = joints.reduce((a, j) => a + j.x, 0) / joints.length;
        const cy = joints.reduce((a, j) => a + j.y, 0) / joints.length;
        return { pier, cx, cy };
      })
      .filter(Boolean) as { pier: string; cx: number; cy: number }[];
  }, [wallsInStory, geometry.joints, showLabels]);

  const counts = {
    slabs:   slabsInStory.length,
    walls:   wallsInStory.length,
    frames:  framesInStory.length,
    columns: framesInStory.filter(([, f]) => f.element_type === "column").length,
    beams:   framesInStory.filter(([, f]) => f.element_type === "beam").length,
  };

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
          <ToggleChip active={showGrid}   onClick={() => setShowGrid((v) => !v)}   label="Grid" />
          <ToggleChip active={showLabels} onClick={() => setShowLabels((v) => !v)} label="Etiquetas" />
        </div>

        <span className="ml-auto text-[10px] text-[var(--text-muted)] font-mono">
          Bounds {(rawW).toFixed(1)}×{(rawH).toFixed(1)} m · zoom {zoom.toFixed(2)}×
        </span>
        <button
          onClick={resetView}
          className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text)] px-2 py-1 rounded border border-[var(--border)]"
        >
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
          style={{ width: "100%", height: "100%", cursor: dragRef.current ? "grabbing" : "grab" }}
        >
          {gridLines}

          {/* Origen (0,0) del modelo */}
          <circle cx={0} cy={0} r={0.12} fill="none" stroke="#f59e0b" strokeWidth={0.03} vectorEffect="non-scaling-stroke" />

          {/* Losas primero (fondo) */}
          {showSlabs && slabsInStory.map(([id, s]) => renderSlab(id, s.joints, s.section))}

          {/* Marcos por debajo de muros */}
          {showFrames && framesInStory.map(([id, f]) => {
            const ji = geometry.joints[f.joint_i];
            const jj = geometry.joints[f.joint_j];
            if (!ji || !jj) return null;
            if (f.element_type === "column") {
              // Columna: proyección coincide en XY → un punto
              return renderColumn(id, ji.x, ji.y, f.section);
            }
            return renderBeam(id, ji.x, ji.y, jj.x, jj.y, f.section);
          })}

          {/* Muros arriba */}
          {showWalls && wallsInStory.map(([id, s]) => renderWall(id, s.joints, s.section, s.pier))}

          {/* Labels de piers */}
          {showLabels && wallLabels.map(({ pier, cx, cy }) => (
            <text
              key={`lbl-${pier}`}
              x={cx} y={-cy}
              fill={COLORS.wallLbl}
              fontSize={0.35}
              textAnchor="middle"
              dominantBaseline="middle"
              style={{ pointerEvents: "none", userSelect: "none" }}
            >
              {pier}
            </text>
          ))}
        </svg>

        {/* Tooltip */}
        {hover && (
          <div
            className="pointer-events-none absolute rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11px] shadow-lg"
            style={{ left: hover.x + 12, top: hover.y + 12, position: "fixed" }}
          >
            <div className="font-semibold text-[var(--text)]">{hover.label}</div>
            {hover.extra && <div className="text-[var(--text-muted)]">{hover.extra}</div>}
            {hover.section && <div className="text-[var(--text-muted)] font-mono">{hover.section}</div>}
          </div>
        )}

        {/* Leyenda + escala en overlay */}
        <div className="absolute bottom-2 left-2 flex items-center gap-3 rounded-md border border-[var(--border)] bg-[var(--surface)]/90 backdrop-blur px-2 py-1 text-[10px]">
          <LegendChip color={COLORS.slabLine}  label="Losa" />
          <LegendChip color={COLORS.wall}      label="Muro" />
          <LegendChip color={COLORS.column}    label="Columna" square />
          <LegendChip color={COLORS.beam}      label="Viga" dashed />
          <span className="text-[var(--text-muted)] ml-2 font-mono">grid {gridStep} m</span>
        </div>
      </div>
    </div>
  );
}

function ToggleChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={[
        "px-2 py-0.5 rounded text-[10px] font-medium transition-colors",
        active
          ? "bg-[var(--accent)] text-white"
          : "bg-[var(--surface)] text-[var(--text-muted)] border border-[var(--border)] hover:text-[var(--text)]",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

function LegendChip({ color, label, square, dashed }: { color: string; label: string; square?: boolean; dashed?: boolean }) {
  return (
    <span className="flex items-center gap-1 text-[var(--text-muted)]">
      {square ? (
        <span style={{ width: 8, height: 8, background: color, display: "inline-block" }} />
      ) : dashed ? (
        <span style={{ width: 14, height: 2, borderTop: `2px dashed ${color}`, display: "inline-block" }} />
      ) : (
        <span style={{ width: 14, height: 2, background: color, display: "inline-block" }} />
      )}
      {label}
    </span>
  );
}
