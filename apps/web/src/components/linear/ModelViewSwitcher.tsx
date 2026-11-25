"use client";

/**
 * ModelViewSwitcher — toggle 3D ↔ Planta 2D ↔ Elevación 2D del modelo.
 *
 * Cuando se pasa `projectId`, las vistas 2D activan el modo de dibujo y el
 * usuario puede crear columnas/vigas/muros/losas/infills. Con `editable=true`
 * también aparece el panel lateral de propiedades al seleccionar un elemento
 * en cualquiera de las tres vistas (planta, elevación o 3D).
 */
import { useCallback, useEffect, useState } from "react";
import type {
  ModelGeometry,
  SectionData,
  GridDefinition,
  MasonryMaterial,
  InfillPanel,
  ElementClickInfo,
} from "@/lib/structural-types";
import { LinearModelViewer3D } from "./LinearModelViewer3D";
import Building2DPlanView from "./Building2DPlanView";
import BuildingElevationView from "./BuildingElevationView";
import { ElementPropertiesPanel, type SelectedElement } from "./ElementPropertiesPanel";
import { structuralEditorApi } from "@/lib/structural-api";

export interface MixedInterface {
  joint_id: string;
  x: number; y: number; z: number;
  elev_m: number;
  concrete_frames: string[];
  steel_frames: string[];
  is_roof_support: boolean;
}

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
  const [mode, setMode]         = useState<ViewMode>(initial);
  const [selected, setSelected] = useState<SelectedElement[]>([]);
  const [mixedInterfaces, setMixedInterfaces] = useState<MixedInterface[]>([]);

  // Carga lazy de interfaces concreto↔acero (apoyos de cubierta metálica).
  // Se refresca cuando el modelo cambia para capturar nuevas transiciones.
  useEffect(() => {
    if (!projectId) { setMixedInterfaces([]); return; }
    let cancel = false;
    structuralEditorApi.getMixedInterfaces(projectId)
      .then((r) => { if (!cancel) setMixedInterfaces(r.interfaces); })
      .catch(() => { if (!cancel) setMixedInterfaces([]); });
    return () => { cancel = true; };
    // Dependencia en `geometry` para re-fetch tras edits del modelo.
  }, [projectId, geometry]);

  const handleSwitch = (m: ViewMode) => {
    setMode(m);
    if (m !== "3d") onSwitchTo2D?.();
  };

  // Toggle con shift / reemplaza sin shift
  const applySelection = useCallback((el: SelectedElement, shift: boolean) => {
    setSelected((prev) => {
      if (!shift) return [el];
      const i = prev.findIndex((s) => s.kind === el.kind && s.id === el.id);
      if (i >= 0) {
        const copy = [...prev]; copy.splice(i, 1); return copy;
      }
      return [...prev, el];
    });
  }, []);

  // Clics desde las vistas 2D
  const handle2DClick = useCallback(
    (el: { id: string; type: string; label?: string; shiftKey?: boolean }) => {
      if (el.type === "column" || el.type === "beam" ||
          el.type === "wall"   || el.type === "slab") {
        applySelection({ kind: el.type, id: el.id }, !!el.shiftKey);
      }
    },
    [applySelection],
  );

  // Rubber-band desde planta — reemplaza la selección por el lote encerrado
  const handleMultiSelect = useCallback(
    (items: Array<{ id: string; type: "column" | "beam" | "wall" | "slab" }>) => {
      setSelected(items.map((it) => ({ kind: it.type, id: it.id })));
    },
    [],
  );

  // Clics desde la vista 3D — Plotly no expone shiftKey, siempre reemplaza
  const handle3DClick = useCallback(
    (_id: string, info: ElementClickInfo) => {
      applySelection({ kind: info.element_type, id: info.id }, false);
    },
    [applySelection],
  );

  const editable = !!projectId;

  return (
    <div className="flex gap-4">
      {/* Columna principal: tabs + vista */}
      <div className="flex-1 min-w-0 flex flex-col gap-2">
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
            mixedInterfaces={mixedInterfaces}
            onClickElement={editable ? handle3DClick : undefined}
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
            onElementClick={editable ? handle2DClick : undefined}
            onMultiSelect={editable ? handleMultiSelect : undefined}
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
            onElementClick={editable ? handle2DClick : undefined}
          />
        )}
      </div>

      {/* Panel lateral de propiedades (solo cuando hay seleccion + editable) */}
      {editable && projectId && selected.length > 0 && (
        <ElementPropertiesPanel
          projectId={projectId}
          geometry={geometry}
          sections={sections}
          selected={selected}
          mixedInterfaces={mixedInterfaces}
          onClose={() => setSelected([])}
          onChanged={async () => {
            await onModelChanged?.();
          }}
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
