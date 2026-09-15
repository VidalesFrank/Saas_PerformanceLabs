"use client";

/**
 * ModelViewSwitcher — toggle 3D ↔ 2D del modelo estructural.
 *
 * Muestra un botón segmentado que alterna entre el visor 3D Plotly y la vista
 * en planta 2D SVG por piso. La geometría es compartida y solo se elige qué
 * componente montar.
 */
import { useState } from "react";
import type { ModelGeometry, SectionData } from "@/lib/structural-types";
import { LinearModelViewer3D } from "./LinearModelViewer3D";
import Building2DPlanView     from "./Building2DPlanView";

type ViewMode = "3d" | "2d";

interface Props {
  geometry: ModelGeometry;
  /** Secciones del canonical model — usadas por la vista 2D para dibujar
   *  columnas y vigas con dimensiones reales (h×b). Opcional. */
  sections?: Record<string, SectionData>;
  initial?: ViewMode;
  /** Callback opcional que la página puede usar para lazy-cargar sections
   *  cuando el usuario cambia a Vista en Planta y todavía no están listas. */
  onSwitchTo2D?: () => void;
}

export default function ModelViewSwitcher({ geometry, sections, initial = "3d", onSwitchTo2D }: Props) {
  const [mode, setMode] = useState<ViewMode>(initial);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1 self-start rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-0.5">
        <button
          onClick={() => setMode("3d")}
          className={[
            "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
            mode === "3d"
              ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
              : "text-[var(--text-muted)] hover:text-[var(--text)]",
          ].join(" ")}
        >
          Vista 3D
        </button>
        <button
          onClick={() => { setMode("2d"); onSwitchTo2D?.(); }}
          className={[
            "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
            mode === "2d"
              ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
              : "text-[var(--text-muted)] hover:text-[var(--text)]",
          ].join(" ")}
        >
          Vista en Planta
        </button>
      </div>

      {mode === "3d" ? (
        <LinearModelViewer3D geometry={geometry} />
      ) : (
        <Building2DPlanView geometry={geometry} sections={sections} />
      )}
    </div>
  );
}
