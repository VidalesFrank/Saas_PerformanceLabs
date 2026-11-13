"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EditableField } from "@/components/ui/editable-field";
import { Input, Label } from "@/components/ui/input";
import { PageHero } from "@/components/ui/page-hero";
import { ApiError } from "@/lib/api";
import { wallProjectsApi } from "@/lib/wall-api";
import type { WallProject5 } from "@/lib/wall-types";
import { useRequireAuth } from "@/lib/use-require-auth";

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("es-CO", { day: "2-digit", month: "short", year: "numeric" });
}

const STATUS_CFG: Record<string, { label: string; color: string }> = {
  empty:   { label: "Sin configurar", color: "var(--text-muted)" },
  ready:   { label: "Listo",          color: "#22c55e" },
  running: { label: "Analizando…",    color: "#f59e0b" },
  done:    { label: "Completado",     color: "#6366f1" },
};

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CFG[status] ?? STATUS_CFG.empty;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
      style={{ background: `${cfg.color}22`, color: cfg.color }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: cfg.color }} />
      {cfg.label}
    </span>
  );
}

function WallProjectCard({
  project,
  onUpdated,
  onDeleted,
}: {
  project: WallProject5;
  onUpdated: (updated: WallProject5) => void;
  onDeleted: (id: string) => Promise<void>;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <Card className="group relative h-full hover:shadow-[0_8px_24px_-12px_rgba(34,211,238,0.3)] hover:border-[color-mix(in_srgb,var(--tech-cyan)_45%,var(--color-border))]">
      <CardBody className="flex h-full flex-col gap-3 p-5">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-semibold leading-snug text-text line-clamp-2">
            <EditableField
              value={project.name}
              as="span"
              ariaLabel="Renombrar proyecto"
              validate={(v) => (v.trim().length < 2 ? "Mínimo 2 caracteres" : null)}
              onSave={async (v) => {
                const updated = await wallProjectsApi.update(project.id, { name: v });
                onUpdated(updated);
              }}
            />
          </h3>
          <div className="flex flex-shrink-0 items-center gap-1.5">
            <StatusBadge status={project.status} />
            <button
              type="button"
              onClick={() => setConfirmOpen(true)}
              aria-label="Eliminar proyecto"
              title="Eliminar proyecto"
              className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted opacity-0 transition-[opacity,color,background] group-hover:opacity-100 hover:bg-[rgba(239,68,68,0.10)] hover:text-danger focus:opacity-100"
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

        <div className="text-xs leading-relaxed text-text-muted">
          <EditableField
            value={project.description ?? ""}
            as="p"
            multiline
            placeholder="Añadir descripción…"
            ariaLabel="Editar descripción"
            onSave={async (v) => {
              const updated = await wallProjectsApi.update(project.id, { description: v });
              onUpdated(updated);
            }}
          />
        </div>

        <Link
          href={`/wall-projects/${project.id}`}
          className="mt-auto flex items-center justify-between border-t border-border pt-2.5 transition-colors hover:text-[var(--tech-cyan-strong)]"
        >
          <span className="text-[10px] text-text-muted">{fmtDate(project.created_at)}</span>
          {project.latest_job && (
            <span className="text-[10px] text-text-muted">
              {project.latest_job.job_type} ·{" "}
              <span style={{
                color: project.latest_job.status === "success" ? "#22c55e"
                     : project.latest_job.status === "failed"  ? "#ef4444"
                     : project.latest_job.status === "running" ? "#f59e0b"
                     : "var(--text-muted)"
              }}>
                {project.latest_job.status}
              </span>
            </span>
          )}
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"
            className="opacity-0 transition-opacity group-hover:opacity-100">
            <path d="M5 12h14M13 5l7 7-7 7" />
          </svg>
        </Link>
      </CardBody>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={async () => { await onDeleted(project.id); setConfirmOpen(false); }}
        title="¿Eliminar este proyecto de muros?"
        description={<>Vas a eliminar <strong className="text-text">«{project.name}»</strong>. Esta acción no se puede deshacer.</>}
        confirmLabel="Eliminar proyecto"
        tone="danger"
      >
        <div className="rounded-lg border border-border bg-surface-2 px-3 py-2.5">
          <div className="mb-1.5 text-[10.5px] font-bold uppercase tracking-wider text-text-muted">
            Se perderá
          </div>
          <ul className="space-y-0.5 text-[12px] text-text">
            <li>· Documento WRC del proyecto</li>
            <li>· Todos los jobs de pushover y análisis asociados</li>
            <li>· Resultados en disco (NPZ, scripts OpenSees)</li>
          </ul>
        </div>
      </ConfirmDialog>
    </Card>
  );
}

export default function WallProjectsPage() {
  const ready = useRequireAuth();
  const [projects, setProjects] = useState<WallProject5[]>([]);
  const [loading, setLoading]   = useState(true);
  const [showNew, setShowNew]   = useState(false);
  const [name, setName]         = useState("");
  const [desc, setDesc]         = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError]       = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    wallProjectsApi.list()
      .then(setProjects)
      .catch(() => setError("No se pudo cargar la lista de proyectos"))
      .finally(() => setLoading(false));
  }, [ready]);

  async function handleCreate() {
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const p = await wallProjectsApi.create(name.trim(), desc.trim() || undefined);
      setProjects(prev => [p, ...prev]);
      setShowNew(false);
      setName(""); setDesc("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Error al crear proyecto");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string) {
    await wallProjectsApi.delete(id);
    setProjects(prev => prev.filter(p => p.id !== id));
  }

  if (!ready) return null;

  return (
    <div className="flex min-h-screen flex-col bg-[var(--bg)]">
      <AppHeader crumb="Muros RC 3D" />
      <PageHero
        eyebrow="Modelación · Muros"
        title="Análisis de Muros RC 3D"
        subtitle="Diseño automático y análisis no lineal con macroelementos E-SFI-MVLEM-3D / MVLEM_3D, pushover ±X/±Y y curvas de capacidad."
        tone="cyan"
        icon="wall"
        actions={
          <Button onClick={() => setShowNew(v => !v)}>
            {showNew ? "Cancelar" : "+ Nuevo proyecto"}
          </Button>
        }
      />

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">

        {/* New project form */}
        {showNew && (
          <Card className="mb-6">
            <CardHeader>Nuevo proyecto de muros</CardHeader>
            <CardBody className="flex flex-col gap-4">
              <div>
                <Label htmlFor="wp-name">Nombre *</Label>
                <Input id="wp-name" value={name} onChange={e => setName(e.target.value)}
                  placeholder="Muro Escalera P1-P8" autoFocus />
              </div>
              <div>
                <Label htmlFor="wp-desc">Descripción</Label>
                <Input id="wp-desc" value={desc} onChange={e => setDesc(e.target.value)}
                  placeholder="Opcional" />
              </div>
              {error && <p className="text-xs text-red-400">{error}</p>}
              <div className="flex gap-2">
                <Button onClick={handleCreate} disabled={creating || !name.trim()}>
                  {creating ? "Creando…" : "Crear proyecto"}
                </Button>
                <Button variant="ghost" onClick={() => setShowNew(false)}>Cancelar</Button>
              </div>
            </CardBody>
          </Card>
        )}

        {/* Error */}
        {error && !showNew && (
          <p className="mb-4 text-sm text-red-400">{error}</p>
        )}

        {/* Project grid */}
        {loading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[1,2,3].map(i => (
              <div key={i} className="h-36 rounded-xl border border-[var(--border)] bg-[var(--surface)] animate-pulse" />
            ))}
          </div>
        ) : projects.length === 0 ? (
          <div className="text-center py-24 text-[var(--text-muted)]">
            <p className="text-4xl mb-3">🧱</p>
            <p className="text-sm font-medium">Sin proyectos aún</p>
            <p className="text-xs mt-1">Crea tu primer proyecto de muros RC para empezar</p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map(p => (
              <WallProjectCard
                key={p.id}
                project={p}
                onUpdated={(upd) =>
                  setProjects(prev => prev.map(x => x.id === upd.id ? upd : x))
                }
                onDeleted={handleDelete}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
