"use client";

/**
 * ModelViewSwitcher — toggle 3D ↔ Planta 2D ↔ Elevación 2D del modelo.
 *
 * Cuando se pasa `projectId`, las vistas 2D activan el modo de dibujo, que
 * permite crear columnas/vigas/muros/losas/infills con clics en el SVG y
 * refresca el modelo canónico automáticamente al guardar.
 */
import { useState } from "react";
import type {
  ModelGeometry,
  SectionData,
  GridDefinition,
  MasonryMaterial,
  InfillPanel,
} from "@/lib/structural-types";
import { LinearModelViewer3D } from "./LinearModelViewer3D";
import Building2DPlanView from "./Building2DPlanView";
import BuildingElevationView from "./BuildingElevationView";

type ViewMode = "3d" | "plan" | "elevation";

interface Props {
  geometry: ModelGeometry;
  sections?: Record<string, SectionData>;
  /** Datos del modelo completo — usados por editores 2D para snap y dibujo. */
  grid?: GridDefinition;
  masonryMaterials?: Record<string, MasonryMaterial>;
  infills?: Record<string, InfillPanel>;
  /** Habilita edición: cuando se pasa, las vistas 2D pueden crear elementos. */
  projectId?: string;
  onModelChanged?: () => void | Promise<void>;
  initial?: ViewMode;
  onSwitchTo2D?: () => void;
}

export default function ModelViewSwitcher({
  geometry, sections, grid, masonryMaterials, infills,
  projectId, onModelChanged, initial = "3d", onSwitchTo2D,
}: Props) {
  const [mode, setMode] = useState<ViewMode>(initial);

  const handleSwitch = (m: ViewMode) => {
    setMode(m);
    if (m !== "3d") onSwitchTo2D?.();
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1 self-start rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-0.5">
        <SwitchBtn active={mode === "3d"}        onClick={() => handleSwitch("3d")}        label="Vista 3D" />
        <SwitchBtn active={mode === "plan"}      onClick={() => handleSwitch("plan")}      label="Vista en Planta" />
        <SwitchBtn active={mode === "elevation"} onClick={() => handleSwitch("elevation")} label="Vista en Elevación" />
      </div>

      {mode === "3d" && (
        <LinearModelViewer3D
          geometry={geometry}
          infills={infills}
          showInfills={true}
          grid={grid}
        />
      )}
      {mode === "plan" && (
        <Building2DPlanView
          geometry={geometry}
          sections={sections}
          grid={grid}
          masonryMaterials={masonryMaterials}
          projectId={projectId}
          onModelChanged={onModelChanged}
        />
      )}
      {mode === "elevation" && (
        <BuildingElevationView
          geometry={geometry}
          sections={sections}
          grid={grid}
          masonryMaterials={masonryMaterials}
          infills={infills}
          projectId={projectId}
          onModelChanged={onModelChanged}
        />
      )}
    </div>
  );
}

function SwitchBtn({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={[
        "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
        active
          ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
          : "text-[var(--text-muted)] hover:text-[var(--text)]",
      ].join(" ")}
    >
      {label}
    </button>
  );
}
