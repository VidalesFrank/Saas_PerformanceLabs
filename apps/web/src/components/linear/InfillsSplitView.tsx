"use client";

/**
 * InfillsSplitView — vista combinada 3D + panel para crear infills por click.
 *
 * Columna izquierda: visor 3D del edificio.
 * Columna derecha: InfillsPanel con lista + formulario.
 *
 * Botón "Agregar por 3D" activa modo picking: clic en 2 columnas del visor
 * → autodetecta story común → pasa preselección al panel que abre el modal.
 */
import { useCallback, useMemo, useState } from "react";
import { LinearModelViewer3D } from "./LinearModelViewer3D";
import InfillsPanel from "./InfillsPanel";
import type { ElementClickInfo, ModelGeometry } from "@/lib/structural-types";

interface FullModelData {
  infills?: Record<string, import("@/lib/structural-types").InfillPanel>;
  masonryMaterials?: Record<string, import("@/lib/structural-types").MasonryMaterial>;
}

interface Props {
  projectId: string;
  fullModelData: FullModelData | null;
  modelGeometry: ModelGeometry | null;
  onChange?: () => void | Promise<void>;
}

export default function InfillsSplitView({
  projectId, fullModelData, modelGeometry, onChange,
}: Props) {
  const [pickMode, setPickMode]       = useState(false);
  const [picked1,  setPicked1]        = useState<string | null>(null);
  const [preselect, setPreselect]     = useState<{ col_i: string; col_j: string; story: string } | null>(null);
  const [pickError, setPickError]     = useState<string | null>(null);
  const [hoveredPanel, setHoveredPanel] = useState<string | null>(null);
  const [editPanelId,  setEditPanelId]  = useState<string | null>(null);

  const resetPick = useCallback(() => {
    setPicked1(null);
    setPickError(null);
  }, []);

  const togglePickMode = useCallback(() => {
    setPickMode((v) => !v);
    resetPick();
  }, [resetPick]);

  // Click en el visor 3D: solo nos interesa cuando pickMode está activo y el
  // elemento es una columna.
  const handleViewerClick = useCallback((id: string, info: ElementClickInfo) => {
    if (!pickMode || !modelGeometry) return;
    if (info.element_type !== "column") {
      setPickError(`Selecciona una columna, no un ${info.element_type}.`);
      return;
    }
    const fr = modelGeometry.frames[id];
    if (!fr) return;
    if (!picked1) {
      setPicked1(id);
      setPickError(null);
      return;
    }
    if (picked1 === id) {
      setPickError("Elige una columna distinta a la primera.");
      return;
    }
    const story1 = modelGeometry.frames[picked1]?.story ?? "";
    const story2 = fr.story ?? "";
    if (!story1 || story1 !== story2) {
      setPickError(`Ambas columnas deben estar en el mismo story (${story1} ≠ ${story2}).`);
      return;
    }
    setPreselect({ col_i: picked1, col_j: id, story: story1 });
    setPickMode(false);
    setPicked1(null);
  }, [pickMode, modelGeometry, picked1]);

  const selectedIds = useMemo(() => {
    const s = new Set<string>();
    if (picked1) s.add(picked1);
    return s;
  }, [picked1]);

  if (!fullModelData || !modelGeometry) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-8">
        <p className="text-sm text-[var(--text-muted)] animate-pulse">Cargando modelo...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-hidden flex flex-col h-full">
      <div className="px-3 py-1.5 flex items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface)]">
        <h1 className="text-xs font-semibold text-[var(--text)]" title="Clic en 2 columnas del edificio 3D para colocar un panel. 2 puntales cruzados participan en el pushover no lineal.">
          Paneles de mampostería (infills)
        </h1>
        <div className="flex items-center gap-2">
          {pickMode ? (
            <div className="flex items-center gap-2 text-[11px]">
              <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-300 font-semibold">
                {picked1 ? "selecciona 2.ᵃ columna" : "selecciona 1.ᵃ columna"}
              </span>
              <button onClick={togglePickMode}
                className="text-[11px] px-2 py-1 rounded border border-[var(--border)] hover:bg-[var(--surface-2)]">
                Cancelar
              </button>
            </div>
          ) : (
            <button onClick={togglePickMode}
              className="text-[11px] px-2.5 py-1 rounded bg-blue-600 text-white font-medium hover:bg-blue-700">
              + Agregar por clic 3D
            </button>
          )}
        </div>
      </div>

      {pickError && (
        <div className="px-6 py-2 bg-red-50 border-b border-red-200 text-red-700 text-xs">
          {pickError}
        </div>
      )}

      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Visor 3D */}
        <div className="flex-1 min-w-0 relative">
          <LinearModelViewer3D
            geometry={modelGeometry}
            selectedIds={selectedIds}
            onClickElement={handleViewerClick}
            onClickInfill={setEditPanelId}
            infills={fullModelData.infills}
            masonryMaterials={fullModelData.masonryMaterials}
            highlightedInfillId={hoveredPanel}
            showInfills
            height="100%"
          />
          {pickMode && (
            <div className="pointer-events-none absolute top-2 left-2 right-2 flex justify-center">
              <div className="pointer-events-auto bg-amber-500/95 text-white text-[11px] font-medium px-3 py-1.5 rounded shadow">
                {picked1
                  ? "Columna 1 marcada en amarillo · haz clic en la 2.ᵃ columna del vano"
                  : "Haz clic en la primera columna del vano del infill"}
              </div>
            </div>
          )}
        </div>

        {/* Panel lateral — scroll vertical propio para que no estire la página */}
        <aside className="w-[320px] flex-shrink-0 overflow-y-auto border-l border-[var(--border)] bg-[var(--surface)] p-2">
          <InfillsPanel
            projectId={projectId}
            infills={fullModelData.infills ?? {}}
            masonryMaterials={fullModelData.masonryMaterials ?? {}}
            geometry={modelGeometry}
            onChange={onChange}
            preselectedColumns={preselect}
            onPreselectConsumed={() => setPreselect(null)}
            onHoverPanel={setHoveredPanel}
            editInfillId={editPanelId}
            onEditInfillConsumed={() => setEditPanelId(null)}
          />
        </aside>
      </div>
    </div>
  );
}
