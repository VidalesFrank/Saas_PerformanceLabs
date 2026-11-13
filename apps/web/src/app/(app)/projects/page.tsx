"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EditableField } from "@/components/ui/editable-field";
import { Input, Label } from "@/components/ui/input";
import { PageHero } from "@/components/ui/page-hero";
import { ApiError } from "@/lib/api";
import { structuralProjectsApi } from "@/lib/structural-api";
import type { StructuralProject, ValidationStatus } from "@/lib/structural-types";
import { useRequireAuth } from "@/lib/use-require-auth";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("es-CO", {
    day: "2-digit", month: "short", year: "numeric",
  });
}

const VALIDATION_LABEL: Record<ValidationStatus, string> = {
  not_run:      "Sin validar",
  has_errors:   "Errores críticos",
  has_warnings: "Con advertencias",
  ok:           "Validado",
};

const VALIDATION_COLOR: Record<ValidationStatus, string> = {
  not_run:      "var(--color-text-muted)",
  has_errors:   "var(--color-danger)",
  has_warnings: "var(--color-warning)",
  ok:           "var(--color-success)",
};

/**
 * Tarjeta de un proyecto en la lista. Toda la card navega al detalle,
 * EXCEPTO cuando el nombre o la descripción están en edición (inline). Para
 * evitar que el click del input dispare la navegación del Link exterior, el
 * nombre vive fuera del <Link> y la fila meta/fecha hace la navegación.
 */
function ProjectCard({
  project,
  onUpdated,
  onDeleted,
}: {
  project: StructuralProject;
  onUpdated: (updated: StructuralProject) => void;
  onDeleted: (id: string) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function handleDelete() {
    await structuralProjectsApi.delete(project.id);
    onDeleted(project.id);
    setConfirmOpen(false);
  }

  const hasModel = Boolean(project.input_file_path || project.e2k_file_path);
  const hasParams = Boolean(project.parameters_json);
  const hasValidated = Boolean(project.canonical_model_path);

  return (
    <Card className="group relative h-full hover:shadow-[0_8px_24px_-12px_rgba(34,211,238,0.3)] hover:border-[color-mix(in_srgb,var(--tech-cyan)_45%,var(--color-border))]">
      <CardBody className="flex h-full flex-col gap-3 p-5">

        {/* Header: nombre editable + status + delete */}
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-semibold leading-snug text-text line-clamp-2">
            <EditableField
              value={project.name}
              as="span"
              ariaLabel="Renombrar proyecto"
              validate={(v) => (v.trim().length < 2 ? "Mínimo 2 caracteres" : null)}
              onSave={async (v) => {
                const updated = await structuralProjectsApi.update(project.id, { name: v });
                onUpdated(updated);
              }}
            />
          </h3>
          <div className="flex flex-shrink-0 items-center gap-1.5">
            <ProjectStatus project={project} />
            <button
              type="button"
              onClick={() => setConfirmOpen(true)}
              aria-label="Eliminar proyecto"
              title="Eliminar proyecto"
              className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted opacity-0 transition-[opacity,color,background] group-hover:opacity-100 hover:bg-[rgba(239,68,68,0.10)] hover:text-danger focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-[rgba(239,68,68,0.4)]"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18" />
                <path d="M19 6l-1.2 14a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
            </button>
          </div>
        </div>

        {/* Descripción editable */}
        <div className="text-xs leading-relaxed text-text-muted">
          <EditableField
            value={project.description ?? ""}
            as="p"
            multiline
            placeholder="Añadir descripción…"
            ariaLabel="Editar descripción"
            onSave={async (v) => {
              const updated = await structuralProjectsApi.update(project.id, { description: v });
              onUpdated(updated);
            }}
          />
        </div>

        {/* Parámetros */}
        {project.parameters_json && (
          <div className="flex flex-wrap gap-1.5">
            {[
              project.parameters_json.city,
              `Suelo ${project.parameters_json.soil_type}`,
              project.parameters_json.structure_system,
              project.parameters_json.code,
            ].filter(Boolean).map((tag) => (
              <span
                key={String(tag)}
                className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                style={{
                  background: "color-mix(in srgb, var(--tech-cyan) 10%, transparent)",
                  color: "var(--tech-cyan-strong)",
                  border: "1px solid color-mix(in srgb, var(--tech-cyan) 25%, transparent)",
                }}
              >
                {String(tag)}
              </span>
            ))}
          </div>
        )}

        {/* Footer: link al detalle */}
        <Link
          href={`/projects/${project.id}`}
          className="mt-auto flex items-center justify-between border-t border-border pt-2.5 transition-colors hover:text-[var(--tech-cyan-strong)]"
        >
          <div className="flex gap-3 text-[11px] text-text-muted">
            {project.input_file_path || project.e2k_file_path
              ? <span className="text-success">✓ Modelo</span>
              : <span>Sin modelo</span>}
            {project.parameters_json
              ? <span className="text-success">✓ Parámetros</span>
              : <span>Sin parámetros</span>}
            {project.canonical_model_path
              ? <span className="text-success">✓ Validado</span>
              : null}
          </div>
          <span className="inline-flex items-center gap-1 text-[10px] text-text-muted group-hover:text-[var(--tech-cyan-strong)]">
            {formatDate(project.updated_at)}
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M13 5l7 7-7 7" />
            </svg>
          </span>
        </Link>

      </CardBody>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={handleDelete}
        title="¿Eliminar este proyecto?"
        description={<>Vas a eliminar <strong className="text-text">«{project.name}»</strong>. Esta acción no se puede deshacer.</>}
        confirmLabel="Eliminar proyecto"
        tone="danger"
      >
        {(hasModel || hasParams || hasValidated) && (
          <div className="rounded-lg border border-border bg-surface-2 px-3 py-2.5">
            <div className="mb-1.5 text-[10.5px] font-bold uppercase tracking-wider text-text-muted">
              Se perderá
            </div>
            <ul className="space-y-0.5 text-[12px] text-text">
              {hasModel      && <li>· Modelo subido (ETABS XLSX / .e2k) y refuerzo</li>}
              {hasParams     && <li>· Parámetros sísmicos NSR-10 configurados</li>}
              {hasValidated  && <li>· Modelo canónico validado y análisis ejecutados</li>}
              <li>· Todos los jobs y resultados asociados</li>
            </ul>
          </div>
        )}
      </ConfirmDialog>
    </Card>
  );
}

function ProjectStatus({ project }: { project: StructuralProject }) {
  const hasFile = project.input_file_path || project.e2k_file_path;
  if (!hasFile) {
    return (
      <span
        className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold"
        style={{ background: "var(--color-text-muted)22", color: "var(--color-text-muted)" }}
      >
        Sin modelo
      </span>
    );
  }
  const vs = project.validation_status;
  const color = VALIDATION_COLOR[vs];
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold"
      style={{ background: `${color}22`, color }}
    >
      {VALIDATION_LABEL[vs]}
    </span>
  );
}

export default function StructuralProjectsPage() {
  const ready  = useRequireAuth();
  const router = useRouter();
  const [projects, setProjects] = useState<StructuralProject[]>([]);
  const [loading, setLoading]   = useState(true);
  const [showNew, setShowNew]   = useState(false);
  const [newName, setNewName]   = useState("");
  const [newDesc, setNewDesc]   = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  async function handleImport(file: File) {
    setImporting(true);
    setError(null);
    try {
      const p = await structuralProjectsApi.importProject(file);
      router.push(`/projects/${p.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo importar el modelo.");
    } finally {
      setImporting(false);
    }
  }

  useEffect(() => {
    if (!ready) return;
    structuralProjectsApi.list()
      .then(setProjects)
      .catch(() => setError("No se pudo cargar la lista de proyectos"))
      .finally(() => setLoading(false));
  }, [ready]);

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const p = await structuralProjectsApi.create({
        name: newName.trim(),
        description: newDesc.trim() || undefined,
      });
      setProjects((prev) => [p, ...prev]);
      setShowNew(false);
      setNewName("");
      setNewDesc("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Error al crear el proyecto");
    } finally {
      setCreating(false);
    }
  }

  if (!ready) return null;

  return (
    <div className="flex flex-1 flex-col">
      <AppHeader crumb="Constructor de Modelos" />
      <PageHero
        eyebrow="Modelación · Constructor"
        title="Constructor de Modelos Estructurales"
        subtitle="Importa tu modelo de ETABS (XLSX o .e2k), genera el modelo OpenSees y ejecuta análisis modal espectral con ajuste FHE NSR-10."
        tone="cyan"
        icon="building"
        actions={
          <>
            <input
              ref={importRef}
              type="file"
              accept=".json,.plabs.json,application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleImport(f);
                e.target.value = "";
              }}
            />
            <Button
              variant="secondary"
              onClick={() => importRef.current?.click()}
              disabled={importing}
              title="Importar un modelo .plabs.json exportado desde otra cuenta"
            >
              {importing ? "Importando…" : "↑ Importar modelo"}
            </Button>
            <Button onClick={() => setShowNew(true)}>+ Nuevo proyecto</Button>
          </>
        }
      />

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">

        {/* Formulario nuevo proyecto */}
        {showNew && (
          <Card className="mb-6">
            <CardHeader>
              <h2 className="text-sm font-semibold text-text">Nuevo proyecto estructural</h2>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
              <div>
                <Label htmlFor="new-name">Nombre del proyecto</Label>
                <Input
                  id="new-name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Ej: Torre Residencial Los Andes — Bogotá"
                  autoFocus
                />
              </div>
              <div>
                <Label htmlFor="new-desc">Descripción (opcional)</Label>
                <Input
                  id="new-desc"
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="Ej: Edificio 12 pisos, sistema dual, suelo D"
                />
              </div>
              {error && <p className="text-sm text-danger">{error}</p>}
              <div className="flex gap-3">
                <Button onClick={handleCreate} disabled={creating || !newName.trim()}>
                  {creating ? "Creando..." : "Crear proyecto"}
                </Button>
                <Button variant="ghost" onClick={() => { setShowNew(false); setError(null); }}>
                  Cancelar
                </Button>
              </div>
            </CardBody>
          </Card>
        )}

        {/* Lista de proyectos */}
        {loading ? (
          <p className="text-sm text-text-muted">Cargando proyectos...</p>
        ) : projects.length === 0 ? (
          <Card>
            <CardBody className="py-12 text-center">
              <p className="text-text-muted text-sm">No tienes proyectos todavía.</p>
              <p className="text-text-muted text-xs mt-1">
                Crea un proyecto, sube tu modelo de ETABS y ejecuta el análisis sísmico.
              </p>
              <Button className="mt-4" onClick={() => setShowNew(true)}>
                Crear tu primer proyecto
              </Button>
            </CardBody>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                onUpdated={(upd) =>
                  setProjects((prev) => prev.map((x) => (x.id === upd.id ? upd : x)))
                }
                onDeleted={(id) =>
                  setProjects((prev) => prev.filter((x) => x.id !== id))
                }
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
