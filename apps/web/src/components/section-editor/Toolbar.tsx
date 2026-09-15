"use client";

import type { Tool } from "@/lib/editor-state";
import {
  IconSelect, IconRectangle, IconCircle, IconPolygon, IconBar, IconLine,
  IconUndo, IconRedo, IconFitView, IconGrid,
} from "./icons";

interface ToolbarProps {
  activeTool: Tool;
  onToolChange: (t: Tool) => void;
  onFitView: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  // Contador vivo
  nRegions: number;
  nBars: number;
  nSelected: number;
  // Grid toggle
  showGrid?: boolean;
  onToggleGrid?: () => void;
}

interface ToolDef {
  id: Tool;
  Icon: React.FC<{ size?: number }>;
  label: string;
  shortcut: string;
}

const TOOLS: ToolDef[] = [
  { id: "select",  Icon: IconSelect,    label: "Seleccionar", shortcut: "S" },
  { id: "rect",    Icon: IconRectangle, label: "Rectángulo",   shortcut: "R" },
  { id: "circle",  Icon: IconCircle,    label: "Círculo",      shortcut: "C" },
  { id: "polygon", Icon: IconPolygon,   label: "Polígono",     shortcut: "G" },
  { id: "bar",     Icon: IconBar,       label: "Barra",        shortcut: "B" },
  { id: "line",    Icon: IconLine,      label: "Línea",        shortcut: "L" },
];

// ── Botón base con tooltip ────────────────────────────────────────────────

function ToolButton({
  active, disabled, onClick, tooltip, Icon, badge,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  tooltip: string;
  Icon: React.FC<{ size?: number }>;
  badge?: string;
}) {
  return (
    <div className="group relative">
      <button
        onClick={onClick}
        disabled={disabled}
        className={`relative flex h-9 w-9 items-center justify-center rounded-md transition-all
          disabled:cursor-not-allowed disabled:opacity-30
          ${active
            ? "bg-accent text-[#04141a] shadow-[0_1px_3px_rgba(14,127,168,0.4)] ring-1 ring-accent/50"
            : "text-text-muted hover:bg-surface hover:text-text active:scale-95"}`}
      >
        <Icon size={17} />
      </button>
      {badge && (
        <span className="pointer-events-none absolute -right-0.5 -top-0.5 rounded-full bg-accent px-1 py-0
                          text-[8px] font-bold text-[#04141a] leading-3">{badge}</span>
      )}
      {/* Tooltip */}
      <span
        className="pointer-events-none absolute left-1/2 top-full z-50 mt-1.5 -translate-x-1/2 whitespace-nowrap
                   rounded-md bg-text/95 px-2 py-1 text-[10.5px] font-medium text-bg
                   opacity-0 shadow-lg transition-opacity delay-150 group-hover:opacity-100"
      >
        {tooltip}
      </span>
    </div>
  );
}

// ── Grupo con label ────────────────────────────────────────────────────────

function Group({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      {label && (
        <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-text-muted">
          {label}
        </span>
      )}
      <div className="flex items-center gap-0.5 rounded-lg border border-border bg-surface-2/60 p-0.5 shadow-inner">
        {children}
      </div>
    </div>
  );
}

// ── Contador vivo ──────────────────────────────────────────────────────────

function LiveCounter({ nRegions, nBars, nSelected }: {
  nRegions: number; nBars: number; nSelected: number;
}) {
  return (
    <div className="ml-auto flex items-center gap-3 rounded-lg border border-border bg-surface-2/60 px-3 py-1.5 text-[11px]
                    font-mono text-text-muted shadow-inner">
      <Chip color="rgb(91,143,201)" label="regiones" value={nRegions} />
      <span className="opacity-40">·</span>
      <Chip color="rgb(217,119,6)" label="barras" value={nBars} />
      {nSelected > 0 && (
        <>
          <span className="opacity-40">·</span>
          <Chip color="var(--color-accent)" label="sel." value={nSelected} highlight />
        </>
      )}
    </div>
  );
}

function Chip({ color, label, value, highlight }: {
  color: string; label: string; value: number; highlight?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-block h-2 w-2 rounded-full" style={{ background: color, opacity: highlight ? 1 : 0.7 }} />
      <span className={`tabular-nums ${highlight ? "text-accent font-bold" : ""}`}>{value}</span>
      <span className="opacity-60">{label}</span>
    </span>
  );
}

// ── Toolbar principal ─────────────────────────────────────────────────────

export function Toolbar({
  activeTool, onToolChange,
  onFitView, onUndo, onRedo,
  canUndo, canRedo,
  nRegions, nBars, nSelected,
  showGrid, onToggleGrid,
}: ToolbarProps) {
  return (
    <div className="flex items-end gap-4 border-b border-border bg-gradient-to-b from-surface to-surface-2/40 px-4 py-2">
      {/* Herramientas */}
      <Group label="Herramientas">
        {TOOLS.map(({ id, Icon, label, shortcut }) => (
          <ToolButton
            key={id}
            Icon={Icon}
            active={activeTool === id}
            onClick={() => onToolChange(id)}
            tooltip={`${label} · ${shortcut}`}
          />
        ))}
      </Group>

      {/* Historial */}
      <Group label="Historial">
        <ToolButton
          Icon={IconUndo}
          onClick={onUndo}
          disabled={!canUndo}
          tooltip="Deshacer · Ctrl+Z"
        />
        <ToolButton
          Icon={IconRedo}
          onClick={onRedo}
          disabled={!canRedo}
          tooltip="Rehacer · Ctrl+Y"
        />
      </Group>

      {/* Vista */}
      <Group label="Vista">
        <ToolButton
          Icon={IconFitView}
          onClick={onFitView}
          tooltip="Ajustar vista · F"
        />
        {onToggleGrid && (
          <ToolButton
            Icon={IconGrid}
            active={!!showGrid}
            onClick={onToggleGrid}
            tooltip={showGrid ? "Ocultar grilla" : "Mostrar grilla"}
          />
        )}
      </Group>

      {/* Contador vivo (a la derecha) */}
      <LiveCounter nRegions={nRegions} nBars={nBars} nSelected={nSelected} />
    </div>
  );
}
