"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { sectionEditorApi } from "@/lib/editor-api";
import type { SectionSummary } from "@/lib/section-document";
import { defaultDocument } from "@/lib/section-document";
import { SECTION_TEMPLATES, type SectionTemplate } from "@/lib/section-templates";
import { useRequireAuth } from "@/lib/use-require-auth";
import { SectionThumbnail } from "@/components/section-editor/SectionThumbnail";

const CATEGORY_LABELS = {
  columna: "Columnas",
  viga: "Vigas",
  muro: "Muros",
  pila: "Pilas",
} as const;

const CATEGORY_ICON = { columna: "▭", viga: "▬", muro: "▮", pila: "◯" } as const;

// Filtros de categoría para la biblioteca
const LIBRARY_FILTERS = ["todas", "columna", "viga", "muro", "pila"] as const;
type LibraryFilter = typeof LIBRARY_FILTERS[number];

export default function SectionsPage() {
  useRequireAuth();
  const router = useRouter();
  const [sections, setSections] = useState<SectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [templateCategory, setTemplateCategory] = useState<SectionTemplate["category"]>("columna");
  const [libFilter, setLibFilter] = useState<LibraryFilter>("todas");
  const [search, setSearch] = useState("");

  useEffect(() => {
    sectionEditorApi.list()
      .then(setSections)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Error al cargar secciones"))
      .finally(() => setLoading(false));
  }, []);

  async function createFromTemplate(tpl: SectionTemplate) {
    setCreating(true);
    setError(null);
    setShowTemplates(false);
    try {
      const record = await sectionEditorApi.create({
        name: tpl.name,
        description: tpl.description,
        document: tpl.generate(),
      });
      router.push(`/sections/${record.id}/editor`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Error al crear sección");
      setCreating(false);
    }
  }

  async function createBlank() {
    setCreating(true);
    setError(null);
    setShowTemplates(false);
    try {
      const record = await sectionEditorApi.create({
        name: "Sección nueva",
        document: defaultDocument(),
      });
      router.push(`/sections/${record.id}/editor`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Error al crear sección");
      setCreating(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await sectionEditorApi.delete(id);
      setSections((prev) => prev.filter((s) => s.id !== id));
      setDeleteId(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Error al eliminar");
    }
  }

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString("es-CO", { year: "numeric", month: "short", day: "numeric" });

  const filteredTemplates = SECTION_TEMPLATES.filter((t) => t.category === templateCategory);
  const categories = [...new Set(SECTION_TEMPLATES.map((t) => t.category))] as SectionTemplate["category"][];

  const filteredSections = sections.filter((s) => {
    const matchSearch = !search || s.name.toLowerCase().includes(search.toLowerCase());
    return matchSearch;
  });

  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <AppHeader />
      <main className="flex-1 p-6">
        {/* Header */}
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-text">Biblioteca de Secciones</h1>
            <p className="text-sm text-text-muted">
              Diseña secciones transversales y ejecuta análisis P-M, M-φ y P-M-M.
            </p>
          </div>
          <Button onClick={() => setShowTemplates(true)} disabled={creating}>
            {creating ? "Creando…" : "+ Nueva sección"}
          </Button>
        </div>

        {/* Barra de búsqueda */}
        {sections.length > 0 && (
          <div className="mb-4 flex items-center gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar sección…"
              className="h-8 w-56 rounded-lg border border-border bg-surface px-3 text-sm text-text
                placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
            <span className="text-xs text-text-muted">{filteredSections.length} sección{filteredSections.length !== 1 ? "es" : ""}</span>
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
            {error}
          </div>
        )}

        {/* Lista de secciones */}
        {loading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="pl-skeleton h-28 rounded-xl" />
            ))}
          </div>
        ) : sections.length === 0 ? (
          <div className="flex flex-col items-center gap-4 py-16 text-center">
            <div className="text-5xl opacity-30">⊙</div>
            <p className="text-text-muted">No tienes secciones guardadas.</p>
            <p className="text-sm text-text-muted">Crea una desde cero o usa una plantilla.</p>
            <Button onClick={() => setShowTemplates(true)} disabled={creating}>
              Crear primera sección
            </Button>
          </div>
        ) : filteredSections.length === 0 ? (
          <div className="py-8 text-center text-sm text-text-muted">
            No hay secciones que coincidan con la búsqueda.
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filteredSections.map((s) => (
              <div
                key={s.id}
                className="group relative rounded-xl border border-border bg-surface transition-all hover:border-accent/40 hover:shadow-md overflow-hidden"
              >
                <Link href={`/sections/${s.id}/editor`} className="block">
                  {/* Miniatura */}
                  <div className="flex justify-center bg-[#0a1120] py-3">
                    <SectionThumbnail
                      regions={s.preview?.regions ?? []}
                      bars={s.preview?.bars ?? []}
                      size={88}
                    />
                  </div>
                  {/* Info */}
                  <div className="p-3">
                    <p className="mb-0.5 truncate font-semibold text-sm text-text">{s.name}</p>
                    {s.description && (
                      <p className="mb-1.5 truncate text-[11px] text-text-muted">{s.description}</p>
                    )}
                    <div className="flex gap-3 text-[11px] text-text-muted">
                      <span>{s.n_regions} región{s.n_regions !== 1 ? "es" : ""}</span>
                      <span>{s.n_bars} barra{s.n_bars !== 1 ? "s" : ""}</span>
                    </div>
                    <p className="mt-1.5 text-[10px] text-text-muted">
                      {formatDate(s.updated_at)}
                    </p>
                  </div>
                </Link>

                {/* Acciones en hover */}
                <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <Link
                    href={`/sections/${s.id}/analyze`}
                    className="rounded bg-accent/15 px-2 py-1 text-[10px] text-accent hover:bg-accent/25"
                  >
                    Analizar
                  </Link>
                  <button
                    onClick={(e) => { e.preventDefault(); setDeleteId(s.id); }}
                    className="rounded bg-surface-2 px-2 py-1 text-[10px] text-danger/60 hover:text-danger"
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Modal de plantillas */}
      {showTemplates && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="flex w-full max-w-2xl flex-col rounded-2xl border border-border bg-surface shadow-2xl"
            style={{ maxHeight: "90vh" }}>
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div>
                <h2 className="font-semibold text-text">Nueva sección</h2>
                <p className="text-xs text-text-muted">Elige una plantilla o empieza desde cero</p>
              </div>
              <button onClick={() => setShowTemplates(false)} className="text-xl text-text-muted hover:text-text">×</button>
            </div>

            {/* Opción en blanco */}
            <div className="border-b border-border px-5 py-3">
              <button
                onClick={createBlank}
                className="flex w-full items-center gap-3 rounded-lg border border-border bg-surface-2 px-4 py-3 text-left
                  transition-colors hover:border-accent/50 hover:bg-accent/5"
              >
                <span className="text-xl text-text-muted">+</span>
                <div>
                  <p className="text-sm font-medium text-text">Sección en blanco</p>
                  <p className="text-xs text-text-muted">Empieza con un lienzo vacío en el editor CAD</p>
                </div>
              </button>
            </div>

            {/* Categorías */}
            <div className="flex gap-1 border-b border-border px-5 py-2">
              {categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setTemplateCategory(cat)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors
                    ${templateCategory === cat
                      ? "bg-accent text-[#04141a]"
                      : "text-text-muted hover:bg-surface-2 hover:text-text"
                    }`}
                >
                  {CATEGORY_ICON[cat]} {CATEGORY_LABELS[cat]}
                </button>
              ))}
            </div>

            {/* Lista de plantillas */}
            <div className="flex-1 overflow-y-auto p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                {filteredTemplates.map((tpl) => (
                  <button
                    key={tpl.id}
                    onClick={() => createFromTemplate(tpl)}
                    className="flex flex-col items-start gap-1 rounded-xl border border-border bg-surface-2 p-4 text-left
                      transition-all hover:border-accent/50 hover:bg-accent/5 hover:shadow-sm"
                  >
                    <p className="text-sm font-semibold text-text">{tpl.name}</p>
                    <p className="text-xs text-text-muted">{tpl.description}</p>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal de confirmación de eliminación */}
      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-80 rounded-xl border border-border bg-surface p-6 shadow-xl">
            <h3 className="mb-2 font-semibold text-text">¿Eliminar sección?</h3>
            <p className="mb-4 text-sm text-text-muted">
              Esta acción no se puede deshacer.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setDeleteId(null)}>Cancelar</Button>
              <Button
                onClick={() => handleDelete(deleteId)}
                className="bg-danger! text-white hover:opacity-80"
              >
                Eliminar
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
