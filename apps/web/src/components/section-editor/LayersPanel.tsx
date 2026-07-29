"use client";

import type { SectionDocument, ConcreteRegion, ReinforcementBar } from "@/lib/section-document";
import type { Selection, EditorAction } from "@/lib/editor-state";

interface Props {
  doc: SectionDocument;
  selection: Selection;
  dispatch: React.Dispatch<EditorAction>;
}

function shapeLabel(r: ConcreteRegion): string {
  const { shape } = r;
  if (shape.kind === "rect") return `${Math.round(shape.width)}×${Math.round(shape.height)} mm`;
  if (shape.kind === "circ") return `Ø${Math.round(shape.radius * 2)} mm`;
  return `Polígono (${shape.vertices.length} vértices)`;
}

export function LayersPanel({ doc, selection, dispatch }: Props) {
  return (
    <div className="flex w-48 flex-col border-r border-border bg-surface">
      {/* Regiones */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">
          Regiones
        </span>
        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-text-muted">
          {doc.regions.length}
        </span>
      </div>

      <div className="flex-shrink-0 overflow-y-auto" style={{ maxHeight: "40%" }}>
        {doc.regions.length === 0 ? (
          <p className="px-3 py-2 text-xs text-text-muted">Sin regiones</p>
        ) : (
          doc.regions.map((r) => {
            const isSelected = selection?.kind === "region" && selection.id === r.id;
            return (
              <div
                key={r.id}
                onClick={() => dispatch({ type: "SET_SELECTION", selection: { kind: "region", id: r.id } })}
                className={`group flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs transition-colors
                  ${isSelected ? "bg-accent/15 text-text" : "text-text-muted hover:bg-surface-2 hover:text-text"}`}
              >
                <span className={`h-2.5 w-2.5 flex-shrink-0 rounded-sm ${r.is_void ? "border border-border bg-transparent" : "bg-accent/60"}`} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{r.label || "Región"}</p>
                  <p className="truncate text-[10px] text-text-muted">{shapeLabel(r)}</p>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    dispatch({ type: "DELETE_REGION", id: r.id });
                  }}
                  className="hidden text-danger opacity-70 hover:opacity-100 group-hover:block"
                  title="Eliminar región"
                >
                  ×
                </button>
              </div>
            );
          })
        )}
      </div>

      {/* Separador */}
      <div className="flex items-center justify-between border-b border-t border-border px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">
          Barras
        </span>
        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-text-muted">
          {doc.bars.length}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {doc.bars.length === 0 ? (
          <p className="px-3 py-2 text-xs text-text-muted">Sin barras</p>
        ) : (
          doc.bars.map((b) => {
            const isSelected = selection?.kind === "bar" && selection.id === b.id;
            return (
              <div
                key={b.id}
                onClick={() => dispatch({ type: "SET_SELECTION", selection: { kind: "bar", id: b.id } })}
                className={`group flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs transition-colors
                  ${isSelected ? "bg-accent/15 text-text" : "text-text-muted hover:bg-surface-2 hover:text-text"}`}
              >
                <span className="h-2 w-2 flex-shrink-0 rounded-full bg-warning/80" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{b.bar_size}</p>
                  <p className="truncate text-[10px] text-text-muted">
                    y={Math.round(b.y)} z={Math.round(b.z)} mm
                  </p>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    dispatch({ type: "DELETE_BAR", id: b.id });
                  }}
                  className="hidden text-danger opacity-70 hover:opacity-100 group-hover:block"
                  title="Eliminar barra"
                >
                  ×
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
