"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
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
  const ready = useRequireAuth();
  const [projects, setProjects] = useState<StructuralProject[]>([]);
  const [loading, setLoading]   = useState(true);
  const [showNew, setShowNew]   = useState(false);
  const [newName, setNewName]   = useState("");
  const [newDesc, setNewDesc]   = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError]       = useState<string | null>(null);

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
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">

        {/* Cabecera */}
        <div className="mb-8 flex items-start justify-between">
          <div>
            <h1 className="text-xl font-semibold text-text">Constructor de Modelos Estructurales</h1>
            <p className="mt-1 text-sm text-text-muted">
              Importa tu modelo de ETABS y ejecuta análisis sísmico modal espectral con ajuste FHE NSR-10.
            </p>
          </div>
          <Button onClick={() => setShowNew(true)}>+ Nuevo proyecto</Button>
        </div>

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
              <Link key={p.id} href={`/projects/${p.id}`} className="group block">
                <Card className="h-full transition-shadow group-hover:shadow-md">
                  <CardBody className="flex flex-col gap-3 p-5">

                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-sm font-semibold text-text leading-snug line-clamp-2 group-hover:text-accent transition-colors">
                        {p.name}
                      </h3>
                      <ProjectStatus project={p} />
                    </div>

                    {p.description && (
                      <p className="text-xs text-text-muted line-clamp-2">{p.description}</p>
                    )}

                    {p.parameters_json && (
                      <div className="flex flex-wrap gap-2">
                        {[
                          p.parameters_json.city,
                          `Suelo ${p.parameters_json.soil_type}`,
                          p.parameters_json.structure_system,
                          p.parameters_json.code,
                        ].filter(Boolean).map((tag) => (
                          <span
                            key={tag}
                            className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                            style={{ background: "var(--color-accent)15", color: "var(--color-accent)" }}
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}

                    <div className="mt-auto flex items-center justify-between pt-2 border-t border-border">
                      <div className="flex gap-3 text-[11px] text-text-muted">
                        {p.input_file_path || p.e2k_file_path
                          ? <span className="text-success">✓ Modelo</span>
                          : <span>Sin modelo</span>}
                        {p.parameters_json
                          ? <span className="text-success">✓ Parámetros</span>
                          : <span>Sin parámetros</span>}
                        {p.canonical_model_path
                          ? <span className="text-success">✓ Validado</span>
                          : null}
                      </div>
                      <span className="text-[10px] text-text-muted">{formatDate(p.updated_at)}</span>
                    </div>
                  </CardBody>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
