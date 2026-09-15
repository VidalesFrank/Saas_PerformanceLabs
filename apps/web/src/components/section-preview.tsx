"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ShapeType } from "@/lib/types";
import { circPerimeterBars, rectPerimeterBars, type BarPoint } from "@/lib/section-preview";
import { useTheme } from "@/lib/theme";
import { BarEditDialog } from "@/components/section-editor/BarEditDialog";
import { IconEdit, IconTrash, IconDuplicate } from "@/components/section-editor/icons";

// ── Preview premium de sección con hover interactivo, centroide, mini-axes ──
// ── Diseñado como drop-in del `SectionPreview` anterior — misma API pública ──

interface SectionPreviewProps {
  shapeType: ShapeType;
  width?: number;
  height?: number;
  diameter?: number;
  cover: number;
  coverToBarCentroid?: number;
  nBarsY?: number;
  nBarsZ?: number;
  nBars?: number;
  vertices?: [number, number][];
  bars?: [number, number][];
  /** Tamaños de barra individuales para tooltip (si no se pasan, usa "#5" por defecto). */
  barSizes?: string[];
  /** Tamaño visual (default 320, responsive si `fluid=true`). */
  size?: number;
  fluid?: boolean;
  /** Editar barra individual (activa clic-derecho + doble-clic + diálogo).
   *  Si no se pasa, la vista es solo lectura. */
  onBarEdit?: (idx: number, updates: { y?: number; z?: number; bar_size?: string }) => void;
  /** Eliminar barra individual (activa opción en menú contextual). */
  onBarDelete?: (idx: number) => void;
  /** Duplicar barra individual (opción en menú contextual). */
  onBarDuplicate?: (idx: number) => void;
}

// Tabla de diámetros (mm) por bar_id
const BAR_DIAMS: Record<string, number> = {
  "#3": 9.5, "#4": 12.7, "#5": 15.9, "#6": 19.1, "#7": 22.2,
  "#8": 25.4, "#9": 28.7, "#10": 32.3, "#11": 35.8,
};

// ── Paletas por tema (idénticas al editor para consistencia visual) ────────

const DARK_C = {
  bg:            "var(--color-surface-2)",
  grid:          "rgba(120,130,160,0.10)",
  gridMajor:     "rgba(120,130,160,0.22)",
  axis:          "rgba(120,130,160,0.55)",
  concrete:      "#4e8ab0",
  concreteStroke:"#2e6888",
  cover:         "rgba(140,170,200,0.15)",
  coverStroke:   "rgba(120,150,180,0.5)",
  polygon:       "#4e8ab0",
  polygonStroke: "#2e6888",
  bar:           "#f59e0b",
  barStroke:     "#78350f",
  barHalo:       "rgba(251,191,36,0.4)",
  centroid:      "#fb7185",
  text:          "var(--color-text)",
  textMuted:     "var(--color-text-muted)",
};

const LIGHT_C = {
  bg:            "var(--color-surface-2)",
  grid:          "rgba(80,100,140,0.08)",
  gridMajor:     "rgba(80,100,140,0.20)",
  axis:          "rgba(60,80,130,0.45)",
  concrete:      "#5b8fc9",
  concreteStroke:"#2c6090",
  cover:         "rgba(140,170,200,0.30)",
  coverStroke:   "rgba(80,110,150,0.45)",
  polygon:       "#5b8fc9",
  polygonStroke: "#2c6090",
  bar:           "#d97706",
  barStroke:     "#78350f",
  barHalo:       "rgba(217,119,6,0.32)",
  centroid:      "#e11d48",
  text:          "var(--color-text)",
  textMuted:     "var(--color-text-muted)",
};

// ── Cálculos ────────────────────────────────────────────────────────────────

interface HoverInfo {
  kind: "bar";
  idx: number;
  y: number;
  z: number;
  barSize: string;
  screenX: number;
  screenY: number;
}

export function SectionPreview(props: SectionPreviewProps) {
  const {
    shapeType, width, height, diameter, cover, coverToBarCentroid,
    nBarsY, nBarsZ, nBars, vertices, bars,
    barSizes, size = 320, fluid = false,
    onBarEdit, onBarDelete, onBarDuplicate,
  } = props;

  const { theme } = useTheme();
  const C = theme === "dark" ? DARK_C : LIGHT_C;

  const wrapRef = useRef<HTMLDivElement>(null);
  const [wrapSize, setWrapSize] = useState({ w: size, h: size });
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; barIdx: number } | null>(null);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);

  const editable = !!onBarEdit;

  // Cerrar menú contextual al hacer clic fuera
  useEffect(() => {
    if (!ctxMenu) return;
    const handler = () => setCtxMenu(null);
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [ctxMenu]);

  // Responsive: si fluid, mide el contenedor
  useEffect(() => {
    if (!fluid || !wrapRef.current) return;
    const el = wrapRef.current;
    const ro = new ResizeObserver(() => {
      setWrapSize({ w: el.clientWidth, h: Math.max(el.clientHeight, 240) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fluid]);

  const SIZE_W = fluid ? wrapSize.w : size;
  const SIZE_H = fluid ? wrapSize.h : size;
  const CENTER_X = SIZE_W / 2;
  const CENTER_Y = SIZE_H / 2;
  const PADDING = 36;

  // ── Extract barpoints + outline + extent ──
  const { extent, barPoints, outlinePoints, centroid, dimLabel } = useMemo(() => {
    let extent = 200;
    let barPoints: BarPoint[] = [];
    let outlinePoints: [number, number][] | null = null;
    let cy = 0, cz = 0;
    let dimLabel = "";

    if (shapeType === "circular" && diameter) {
      extent = (diameter / 2) * 1.20;
      barPoints = (nBars && coverToBarCentroid) ? circPerimeterBars(diameter, coverToBarCentroid, nBars) : [];
      dimLabel = `⌀ ${diameter} mm`;
    } else if (shapeType === "special" && vertices && vertices.length >= 3) {
      const maxAbs = Math.max(...vertices.flatMap(([y, z]) => [Math.abs(y), Math.abs(z)]), 1);
      extent = maxAbs * 1.20;
      barPoints = (bars ?? []).map(([y, z]) => ({ y, z }) as BarPoint);
      outlinePoints = vertices;
      cy = vertices.reduce((s, [y]) => s + y, 0) / vertices.length;
      cz = vertices.reduce((s, [, z]) => s + z, 0) / vertices.length;
      const ys = vertices.map(([y]) => y);
      const zs = vertices.map(([, z]) => z);
      dimLabel = `${Math.round(Math.max(...zs) - Math.min(...zs))} × ${Math.round(Math.max(...ys) - Math.min(...ys))} mm`;
    } else {
      const h = height ?? 0;
      const w = width ?? 0;
      extent = (Math.max(h, w, 1) / 2) * 1.20;
      if (h && w && nBarsY && nBarsZ && coverToBarCentroid) {
        barPoints = rectPerimeterBars(h, w, coverToBarCentroid, nBarsY, nBarsZ);
      }
      dimLabel = w && h ? `${w} × ${h} mm` : "";
    }

    return { extent, barPoints, outlinePoints, centroid: { y: cy, z: cz }, dimLabel };
  }, [shapeType, width, height, diameter, nBars, nBarsY, nBarsZ, coverToBarCentroid, vertices, bars]);

  // Escalado: mundo → pantalla
  const scale = (Math.min(CENTER_X, CENTER_Y) - PADDING) / (extent || 1);
  const sx = (z: number) => CENTER_X + z * scale;
  const sy = (y: number) => CENTER_Y - y * scale;

  // ── Grilla sutil de fondo ──────────────────────────────────────────────
  const gridStep = extent < 300 ? 50 : extent < 800 ? 100 : 200;
  const gridLines: React.ReactNode[] = [];
  const nStepsHalf = Math.ceil(extent / gridStep);
  for (let i = -nStepsHalf; i <= nStepsHalf; i++) {
    const w = i * gridStep;
    const isMajor = i % 5 === 0;
    // Vertical
    gridLines.push(<line key={`gv${i}`} x1={sx(w)} y1={PADDING/2} x2={sx(w)} y2={SIZE_H - PADDING/2}
      stroke={i === 0 ? C.axis : isMajor ? C.gridMajor : C.grid}
      strokeWidth={i === 0 ? 1.2 : isMajor ? 0.8 : 0.5}
    />);
    // Horizontal
    gridLines.push(<line key={`gh${i}`} x1={PADDING/2} y1={sy(w)} x2={SIZE_W - PADDING/2} y2={sy(w)}
      stroke={i === 0 ? C.axis : isMajor ? C.gridMajor : C.grid}
      strokeWidth={i === 0 ? 1.2 : isMajor ? 0.8 : 0.5}
    />);
  }

  // ── Handlers de hover en barras ────────────────────────────────────────
  const handleBarHover = (i: number, b: BarPoint, e: React.MouseEvent) => {
    const bs = (barSizes?.[i]) ?? "#5";
    setHover({ kind: "bar", idx: i, y: b.y, z: b.z, barSize: bs, screenX: e.clientX, screenY: e.clientY });
  };

  return (
    <div ref={wrapRef} className="relative"
      style={{ width: fluid ? "100%" : SIZE_W, height: fluid ? "100%" : SIZE_H, minHeight: 240 }}
      onMouseLeave={() => setHover(null)}
    >
      <svg
        width={SIZE_W} height={SIZE_H}
        viewBox={`0 0 ${SIZE_W} ${SIZE_H}`}
        className="rounded-lg"
        style={{ background: C.bg, display: "block" }}
      >
        {/* Grilla sutil */}
        <g pointerEvents="none">{gridLines}</g>

        {/* Sección concreta (rectangular / cuadrada) */}
        {shapeType !== "circular" && shapeType !== "special" && width && height && (
          <>
            <rect
              x={sx(-width / 2)} y={sy(height / 2)}
              width={width * scale} height={height * scale}
              fill={C.concrete} fillOpacity={0.35}
              stroke={C.concreteStroke} strokeWidth={2} rx={2}
            />
            {cover > 0 && width - 2 * cover > 0 && height - 2 * cover > 0 && (
              <rect
                x={sx(-(width / 2 - cover))} y={sy(height / 2 - cover)}
                width={(width - 2 * cover) * scale} height={(height - 2 * cover) * scale}
                fill={C.cover}
                stroke={C.coverStroke} strokeWidth={0.7}
                strokeDasharray="3,2" rx={1}
              />
            )}
          </>
        )}

        {/* Sección circular */}
        {shapeType === "circular" && diameter && (
          <>
            <circle
              cx={CENTER_X} cy={CENTER_Y}
              r={(diameter / 2) * scale}
              fill={C.concrete} fillOpacity={0.35}
              stroke={C.concreteStroke} strokeWidth={2}
            />
            {cover > 0 && (
              <circle
                cx={CENTER_X} cy={CENTER_Y}
                r={Math.max((diameter / 2 - cover) * scale, 0)}
                fill={C.cover}
                stroke={C.coverStroke} strokeWidth={0.7}
                strokeDasharray="3,2"
              />
            )}
          </>
        )}

        {/* Polígono especial */}
        {shapeType === "special" && outlinePoints && outlinePoints.length >= 3 && (
          <polygon
            points={outlinePoints.map(([y, z]) => `${sx(z)},${sy(y)}`).join(" ")}
            fill={C.polygon} fillOpacity={0.35}
            stroke={C.polygonStroke} strokeWidth={2}
          />
        )}

        {/* Centroide (crosshair rosa sutil) */}
        {(centroid.y !== 0 || centroid.z !== 0 || shapeType === "rectangular" || shapeType === "circular") && barPoints.length > 0 && (
          <g pointerEvents="none" opacity={0.7}>
            <line x1={sx(centroid.z) - 8} y1={sy(centroid.y)} x2={sx(centroid.z) + 8} y2={sy(centroid.y)}
              stroke={C.centroid} strokeWidth={1.2} />
            <line x1={sx(centroid.z)} y1={sy(centroid.y) - 8} x2={sx(centroid.z)} y2={sy(centroid.y) + 8}
              stroke={C.centroid} strokeWidth={1.2} />
            <circle cx={sx(centroid.z)} cy={sy(centroid.y)} r={2} fill={C.centroid} />
          </g>
        )}

        {/* Barras — con halo si hover, clic-derecho para menú, doble-clic para editar */}
        {barPoints.map((b, i) => {
          const isHover = hover?.kind === "bar" && hover.idx === i;
          const isEditing = editingIdx === i;
          const bs = (barSizes?.[i]) ?? "#5";
          const dia = BAR_DIAMS[bs] ?? 15.9;
          const rScreen = Math.max(dia * scale / 2, 4);
          return (
            <g key={i}>
              {(isHover || isEditing) && (
                <circle cx={sx(b.z)} cy={sy(b.y)} r={rScreen * 2.2}
                  fill={C.barHalo} opacity={isEditing ? 0.85 : 0.7}
                  style={{ transition: "r 120ms" }}
                />
              )}
              <circle
                cx={sx(b.z)} cy={sy(b.y)}
                r={rScreen * (isHover ? 1.15 : 1)}
                fill={C.bar}
                stroke={isEditing ? C.centroid : C.barStroke}
                strokeWidth={isEditing ? 1.5 : 0.8}
                style={{ transition: "r 100ms", cursor: editable ? "pointer" : "default" }}
                onMouseEnter={(e) => handleBarHover(i, b, e)}
                onMouseMove={(e) => handleBarHover(i, b, e)}
                onMouseLeave={() => setHover(null)}
                onContextMenu={editable ? (e) => {
                  e.preventDefault();
                  setCtxMenu({ x: e.clientX, y: e.clientY, barIdx: i });
                  setHover(null);
                } : undefined}
                onDoubleClick={editable ? (e) => {
                  e.preventDefault();
                  setEditingIdx(i);
                  setHover(null);
                } : undefined}
              />
            </g>
          );
        })}

        {/* Empty state */}
        {barPoints.length === 0 && (
          <text x={CENTER_X} y={CENTER_Y + 4} textAnchor="middle"
            fill={C.textMuted} fontSize={11} fontFamily="monospace">
            Completa la geometría
          </text>
        )}

        {/* Etiqueta de dimensiones (arriba) */}
        {dimLabel && (
          <g>
            <rect x={CENTER_X - 55} y={6} width={110} height={18} rx={3}
              fill="var(--color-surface)" fillOpacity={0.85}
              stroke="var(--color-border)" strokeWidth={0.5}
            />
            <text x={CENTER_X} y={19} textAnchor="middle"
              fill={C.text} fontSize={11} fontFamily="monospace" fontWeight="600">
              {dimLabel}
            </text>
          </g>
        )}

        {/* Contador de barras (esquina superior derecha) */}
        {barPoints.length > 0 && (
          <g>
            <rect x={SIZE_W - 78} y={SIZE_H - 22} width={70} height={16} rx={3}
              fill="var(--color-surface)" fillOpacity={0.85}
              stroke="var(--color-border)" strokeWidth={0.5}
            />
            <text x={SIZE_W - 43} y={SIZE_H - 10} textAnchor="middle"
              fill={C.text} fontSize={10} fontFamily="monospace">
              <tspan fill={C.bar}>●</tspan> {barPoints.length} barras
            </text>
          </g>
        )}

        {/* Mini axes Y-Z en esquina inferior izquierda */}
        <g transform={`translate(24,${SIZE_H - 24})`} pointerEvents="none">
          <circle cx={0} cy={0} r={1.8} fill={C.textMuted} />
          {/* Y (arriba) */}
          <line x1={0} y1={0} x2={0} y2={-22} stroke={C.axis} strokeWidth={1.3} />
          <path d="M -3 -18 L 0 -22 L 3 -18" fill="none" stroke={C.axis} strokeWidth={1.3} />
          <text x={4} y={-20} fontSize={9} fontFamily="monospace" fill={C.textMuted}>Y</text>
          {/* Z (derecha) */}
          <line x1={0} y1={0} x2={22} y2={0} stroke={C.axis} strokeWidth={1.3} />
          <path d="M 18 -3 L 22 0 L 18 3" fill="none" stroke={C.axis} strokeWidth={1.3} />
          <text x={19} y={-3} fontSize={9} fontFamily="monospace" fill={C.textMuted}>Z</text>
        </g>
      </svg>

      {/* Tooltip flotante con info de barra (oculto si menú contextual abierto) */}
      {hover?.kind === "bar" && !ctxMenu && editingIdx === null && (
        <BarTooltip
          bar={{ y: hover.y, z: hover.z }}
          barSize={hover.barSize}
          screenX={hover.screenX}
          screenY={hover.screenY}
          wrapEl={wrapRef.current}
          editable={editable}
        />
      )}

      {/* Menú contextual sobre barra */}
      {ctxMenu && editable && (
        <div
          className="fixed z-[200] min-w-[190px] overflow-hidden rounded-xl border border-border bg-surface/98 shadow-2xl backdrop-blur-sm"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="border-b border-border px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-text-muted">
            Barra #{ctxMenu.barIdx + 1}
            <span className="ml-2 font-mono normal-case tracking-normal">
              {barSizes?.[ctxMenu.barIdx] ?? "#5"}
            </span>
          </div>
          <div className="py-1">
            <button
              className="flex w-full items-center gap-3 px-3 py-1.5 text-left text-xs text-accent hover:bg-accent/10 transition-colors"
              onClick={() => { setEditingIdx(ctxMenu.barIdx); setCtxMenu(null); }}
            >
              <IconEdit size={15} />
              <span className="flex-1 font-medium">Editar barra…</span>
              <span className="text-[10px] font-mono text-text-muted">Doble-clic</span>
            </button>
            {onBarDuplicate && (
              <button
                className="flex w-full items-center gap-3 px-3 py-1.5 text-left text-xs text-text hover:bg-surface-2 transition-colors"
                onClick={() => { onBarDuplicate(ctxMenu.barIdx); setCtxMenu(null); }}
              >
                <IconDuplicate size={15} />
                <span className="flex-1 font-medium">Duplicar</span>
              </button>
            )}
          </div>
          {onBarDelete && (
            <div className="border-t border-border py-1">
              <button
                className="flex w-full items-center gap-3 px-3 py-1.5 text-left text-xs text-danger hover:bg-danger/10 transition-colors"
                onClick={() => { onBarDelete(ctxMenu.barIdx); setCtxMenu(null); }}
              >
                <IconTrash size={15} />
                <span className="flex-1 font-medium">Eliminar</span>
                <span className="text-[10px] font-mono text-text-muted">Del</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Diálogo edición de barra */}
      {editingIdx !== null && editable && barPoints[editingIdx] && (
        <BarEditDialog
          bar={{
            y: barPoints[editingIdx].y,
            z: barPoints[editingIdx].z,
            bar_size: (barSizes?.[editingIdx]) ?? "#5",
            id: `preview-${editingIdx}`,
          }}
          title={`Barra #${editingIdx + 1} · ${(barSizes?.[editingIdx]) ?? "#5"}`}
          onChange={(u) => {
            if (onBarEdit) onBarEdit(editingIdx, u);
          }}
          onClose={() => setEditingIdx(null)}
        />
      )}
    </div>
  );
}

// ── Tooltip flotante (posicionado por bounding rect del wrapper) ────────

function BarTooltip({ bar, barSize, screenX, screenY, wrapEl, editable }: {
  bar: { y: number; z: number }; barSize: string;
  screenX: number; screenY: number;
  wrapEl: HTMLDivElement | null;
  editable?: boolean;
}) {
  if (!wrapEl) return null;
  const rect = wrapEl.getBoundingClientRect();
  const localX = screenX - rect.left;
  const localY = screenY - rect.top;
  const dia = BAR_DIAMS[barSize] ?? 15.9;
  const area = Math.PI * (dia / 2) ** 2;

  const tw = 170, th = editable ? 108 : 84;
  const px = localX + 14 + tw > rect.width ? localX - 14 - tw : localX + 14;
  const py = localY + 14 + th > rect.height ? localY - 14 - th : localY + 14;

  return (
    <div
      className="pointer-events-none absolute z-30 rounded-lg border border-border bg-surface/95 px-3 py-2 shadow-xl backdrop-blur-sm"
      style={{ left: px, top: py, minWidth: tw }}
    >
      <div className="mb-1 flex items-center gap-1.5 border-b border-border pb-1">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
        <span className="text-[10.5px] font-bold text-text">Barra {barSize}</span>
      </div>
      <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[10px] font-mono">
        <span className="text-text-muted">φ</span>   <span className="text-text">{dia.toFixed(2)} mm</span>
        <span className="text-text-muted">As</span>  <span className="text-text">{area.toFixed(0)} mm²</span>
        <span className="text-text-muted">y</span>   <span className="tabular-nums text-text">{bar.y.toFixed(1)} mm</span>
        <span className="text-text-muted">z</span>   <span className="tabular-nums text-text">{bar.z.toFixed(1)} mm</span>
      </div>
      {editable && (
        <p className="mt-1 border-t border-border pt-1 text-[9.5px] italic text-text-muted">
          Clic derecho / doble-clic para ajustar
        </p>
      )}
    </div>
  );
}
