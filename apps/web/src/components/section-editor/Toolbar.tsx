"use client";

import type { Tool } from "@/lib/editor-state";

interface ToolbarProps {
  activeTool: Tool;
  onToolChange: (t: Tool) => void;
  onFitView: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

interface ToolDef {
  id: Tool;
  label: string;
  title: string;
  icon: string;
}

const TOOLS: ToolDef[] = [
  { id: "select",  label: "▶",  title: "Seleccionar (S)",      icon: "select"  },
  { id: "rect",    label: "▭",  title: "Rectángulo (R)",        icon: "rect"    },
  { id: "circle",  label: "◯",  title: "Círculo (C)",           icon: "circle"  },
  { id: "polygon", label: "⬡",  title: "Polígono (G)",          icon: "polygon" },
  { id: "bar",     label: "•",  title: "Barra individual (B)",  icon: "bar"     },
  { id: "line",    label: "╌",  title: "Línea de barras (L)",   icon: "line"    },
];

export function Toolbar({
  activeTool, onToolChange,
  onFitView, onUndo, onRedo,
  canUndo, canRedo,
}: ToolbarProps) {
  return (
    <div className="flex items-center gap-1 border-b border-border bg-surface px-3 py-1.5">
      {/* Herramientas de dibujo */}
      <div className="flex items-center gap-0.5 rounded-md border border-border bg-surface-2 p-0.5">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            title={t.title}
            onClick={() => onToolChange(t.id)}
            className={`flex h-8 w-8 items-center justify-center rounded text-base transition-colors
              ${activeTool === t.id
                ? "bg-accent text-[#04141a] shadow-sm"
                : "text-text-muted hover:bg-surface hover:text-text"
              }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mx-2 h-6 w-px bg-border" />

      {/* Historial */}
      <button
        title="Deshacer (Ctrl+Z)"
        onClick={onUndo}
        disabled={!canUndo}
        className="flex h-8 w-8 items-center justify-center rounded text-base text-text-muted
          hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-30"
      >
        ↩
      </button>
      <button
        title="Rehacer (Ctrl+Y)"
        onClick={onRedo}
        disabled={!canRedo}
        className="flex h-8 w-8 items-center justify-center rounded text-base text-text-muted
          hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-30"
      >
        ↪
      </button>

      <div className="mx-2 h-6 w-px bg-border" />

      {/* Vista */}
      <button
        title="Ajustar vista (F)"
        onClick={onFitView}
        className="flex h-8 w-8 items-center justify-center rounded text-base text-text-muted
          hover:bg-surface-2 hover:text-text"
      >
        ⊡
      </button>

      {/* Leyenda de atajos */}
      <div className="ml-4 text-xs text-text-muted">
        Rueda: zoom · Clic medio/Alt+arrastrar: paneo · Esc: cancelar
      </div>
    </div>
  );
}
