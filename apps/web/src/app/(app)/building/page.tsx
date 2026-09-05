"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { buildingProjectsApi } from "@/lib/building-api";
import type { BuildingProject } from "@/lib/building-types";
import { useRequireAuth } from "@/lib/use-require-auth";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("es-CO", {
    day: "2-digit", month: "short", year: "numeric",
  });
}

function StatusBadge({ project }: { project: BuildingProject }) {
  const hasModel  = project.input_file_path || project.e2k_file_path;
  const hasParams = !!project.parameters_json;
  const label     = !hasModel ? "Sin modelo" : !hasParams ? "Sin parámetros" : "Listo";
  const color     = !hasModel
    ? "var(--color-text-muted)"
    : !hasParams
    ? "var(--color-warning)"
    : "var(--color-success)";
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold"
      style={{ background: `${color}22`, color }}
    >
      {label}
    </span>
  );
}

export default function BuildingProjectsPage() {
  const ready = useRequireAuth();
  const [projects, setProjects] = useState<BuildingProject[]>([]);
  const [loading, setLoading]   = useState(true);
  const [showNew, setShowNew]   = useState(false);
  const [newName, setNewName]   = useState("");
  const [newDesc, setNewDesc]   = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError]       = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    buildingProjectsApi.list()
      .then(setProjects)
      .catch(() => setError("No se pudo cargar la lista de proyectos"))
      .finally(() => setLoading(false));
  }, [ready]);

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const p = await buildingProjectsApi.create({ name: newName.trim(), description: newDesc.trim() || undefined });
      setProjects((prev) => [p, ...prev]);
      setShowNew(false);
      setNewName(""); setNewDesc("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Error al crear el proyecto");
    } finally {
      setCreating(false);
    }
  }

  if (!ready) return null;

  return (
    <div className="flex flex-1 flex-col">
      <AppHeader crumb="Análisis No Lineal 3D" />
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">

        {/* Cabecera */}
        <div className="mb-8 flex items-start justify-between">
          <div>
            <h1 className="text-xl font-semibold text-text">Análisis No Lineal 3D de Edificios</h1>
            <p className="mt-1 text-sm text-text-muted">
              Importa tu modelo de ETABS y ejecuta análisis modal, pushover e IDA.
            </p>
          </div>
          <Button onClick={() => setShowNew(true)}>+ Nuevo proyecto</Button>
        </div>

        {/* Formulario nuevo proyecto */}
        {showNew && (
          <Card className="mb-6">
            <CardHeader>
              <h2 className="text-sm font-semibold text-text">Nuevo proyecto</h2>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
              <div>
                <Label htmlFor="new-name">Nombre del proyecto</Label>
                <Input
                  id="new-name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Ej: Torre Residencial Los Andes"
                  autoFocus
                />
              </div>
              <div>
                <Label htmlFor="new-desc">Descripción (opcional)</Label>
                <Input
                  id="new-desc"
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="Ej: Edificio 8 pisos, sistema dual, Bogotá"
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
              <p className="text-text-muted text-sm">No tienes proyectos de análisis 3D todavía.</p>
              <Button className="mt-4" onClick={() => setShowNew(true)}>Crear tu primer proyecto</Button>
            </CardBody>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <Link key={p.id} href={`/building/${p.id}`} className="group block">
                <Card className="h-full transition-shadow group-hover:shadow-md">
                  <CardBody className="flex flex-col gap-3 p-5">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-sm font-semibold text-text leading-snug line-clamp-2 group-hover:text-accent transition-colors">
                        {p.name}
                      </h3>
                      <StatusBadge project={p} />
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
                      </div>
                      <span className="text-[10px] text-text-muted">{formatDate(p.created_at)}</span>
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
