"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { sectionEditorApi } from "@/lib/editor-api";
import { editorReducer, initialState } from "@/lib/editor-state";
import type { SectionRecord } from "@/lib/section-document";
import { useRequireAuth } from "@/lib/use-require-auth";
import { Toolbar } from "@/components/section-editor/Toolbar";
import { LayersPanel } from "@/components/section-editor/LayersPanel";
import { EditorCanvas } from "@/components/section-editor/EditorCanvas";
import { PropertiesPanel } from "@/components/section-editor/PropertiesPanel";
import { BarPatternDialog } from "@/components/section-editor/BarPatternDialog";
import { MaterialsDialog } from "@/components/section-editor/MaterialsDialog";
import { ThemeToggle } from "@/components/ui/theme-toggle";

export default function SectionEditorPage() {
  useRequireAuth();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [state, dispatch] = useReducer(editorReducer, undefined, () => initialState());
  const [record, setRecord] = useState<SectionRecord | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lineDialog, setLineDialog] = useState<{ y1: number; z1: number; y2: number; z2: number } | null>(null);
  const [showBarDialog, setShowBarDialog] = useState(false);
  const [showMaterials, setShowMaterials] = useState(false);
  const canvasContainerRef = useRef<HTMLDivElement>(null);

  // Cargar sección al montar
  useEffect(() => {
    if (!id) return;
    sectionEditorApi.get(id)
      .then((rec) => {
        setRecord(rec);
        setNameValue(rec.name);
        dispatch({ type: "LOAD_DOCUMENT", doc: rec.document as unknown as typeof state.doc });
      })
      .catch((e) => setLoadError(e instanceof ApiError ? e.message : "Error al cargar la sección"));
  }, [id]);

  // Ajustar vista al canvas cuando cargue
  useEffect(() => {
    if (canvasContainerRef.current && state.doc.regions.length > 0 && record) {
      const { clientWidth: w, clientHeight: h } = canvasContainerRef.current;
      dispatch({ type: "FIT_VIEW", canvasWidth: w, canvasHeight: h });
    }
  }, [record]);

  // Guardado automático con debounce
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!state.isDirty || !id) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      setSaving(true);
      setSaveError(null);
      try {
        await sectionEditorApi.update(id, { document: state.doc as unknown as Parameters<typeof sectionEditorApi.update>[1]["document"] });
        dispatch({ type: "MARK_SAVED" });
      } catch (e) {
        setSaveError(e instanceof ApiError ? e.message : "Error al guardar");
      } finally {
        setSaving(false);
      }
    }, 1500);
    return () => { if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current); };
  }, [state.isDirty, state.doc, id]);

  const handleFitView = useCallback(() => {
    if (canvasContainerRef.current) {
      const { clientWidth: w, clientHeight: h } = canvasContainerRef.current;
      dispatch({ type: "FIT_VIEW", canvasWidth: w, canvasHeight: h });
    }
  }, []);

  async function handleRename() {
    if (!nameValue.trim() || !id) return;
    try {
      await sectionEditorApi.update(id, { name: nameValue.trim() });
      setRecord((r) => r ? { ...r, name: nameValue.trim() } : r);
    } catch {
      // silencioso — el nombre se puede reintentar
    } finally {
      setEditingName(false);
    }
  }

  function handleLineComplete(y1: number, z1: number, y2: number, z2: number) {
    setLineDialog({ y1, z1, y2, z2 });
  }

  if (loadError) {
    return (
      <div className="flex min-h-screen flex-col bg-bg">
        <AppHeader />
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <p className="text-danger">{loadError}</p>
          <Link href="/sections">
            <Button variant="secondary">Volver a la biblioteca</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg">
      {/* Encabezado propio del editor (sin el AppHeader global) */}
      <header className="flex items-center justify-between border-b border-border bg-surface px-4 py-2">
        <div className="flex items-center gap-3">
          <Link href="/sections" className="text-text-muted hover:text-text text-sm">
            ← Secciones
          </Link>
          <span className="text-border">|</span>
          {editingName ? (
            <input
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              onBlur={handleRename}
              onKeyDown={(e) => { if (e.key === "Enter") handleRename(); if (e.key === "Escape") setEditingName(false); }}
              autoFocus
              className="rounded border border-accent bg-surface-2 px-2 py-0.5 text-sm text-text
                focus:outline-none focus:ring-1 focus:ring-accent/50"
            />
          ) : (
            <button
              onClick={() => setEditingName(true)}
              className="text-sm font-medium text-text hover:text-accent"
              title="Clic para renombrar"
            >
              {record?.name ?? "Cargando…"}
            </button>
          )}
        </div>
        <div className="flex items-center gap-3">
          {saving && <span className="text-xs text-text-muted">Guardando…</span>}
          {!saving && !state.isDirty && <span className="text-xs text-success">✓ Guardado</span>}
          {saveError && <span className="text-xs text-danger">{saveError}</span>}
          <ThemeToggle />
          <Button variant="secondary" className="text-xs" onClick={() => setShowMaterials(true)}>
            Materiales
          </Button>
          <Link href={`/sections/${id}/analyze`}>
            <Button variant="secondary" className="text-xs">
              Analizar →
            </Button>
          </Link>
        </div>
      </header>

      {/* Toolbar */}
      <Toolbar
        activeTool={state.tool}
        onToolChange={(t) => dispatch({ type: "SET_TOOL", tool: t })}
        onFitView={handleFitView}
        onUndo={() => dispatch({ type: "UNDO" })}
        onRedo={() => dispatch({ type: "REDO" })}
        canUndo={state.history.length > 0}
        canRedo={state.future.length > 0}
      />

      {/* Cuerpo del editor */}
      <div className="flex flex-1 overflow-hidden">
        {/* Panel izquierdo — capas */}
        <LayersPanel
          doc={state.doc}
          selection={state.selection}
          dispatch={dispatch}
        />

        {/* Canvas central */}
        <div ref={canvasContainerRef} className="relative flex-1 overflow-hidden" style={{ background: "var(--color-canvas-bg)" }}>
          {!record && !loadError && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="pl-skeleton h-8 w-32 rounded" />
            </div>
          )}
          {record && (
            <EditorCanvas
              state={state}
              dispatch={dispatch}
              onLineComplete={handleLineComplete}
            />
          )}
        </div>

        {/* Panel derecho — propiedades */}
        <PropertiesPanel
          doc={state.doc}
          selection={state.selection}
          dispatch={dispatch}
        />
      </div>

      {/* Diálogo de patrón de barras — línea */}
      {lineDialog && (
        <BarPatternDialog
          doc={state.doc}
          dispatch={dispatch}
          onClose={() => setLineDialog(null)}
          lineEndpoints={lineDialog}
        />
      )}

      {/* Diálogo de patrón de barras — perimetral */}
      {showBarDialog && (
        <BarPatternDialog
          doc={state.doc}
          dispatch={dispatch}
          onClose={() => setShowBarDialog(false)}
        />
      )}

      {/* Diálogo de materiales */}
      {showMaterials && (
        <MaterialsDialog
          concreteDefs={state.doc.concrete_defs}
          steelDefs={state.doc.steel_defs}
          dispatch={dispatch}
          onClose={() => setShowMaterials(false)}
        />
      )}
    </div>
  );
}
