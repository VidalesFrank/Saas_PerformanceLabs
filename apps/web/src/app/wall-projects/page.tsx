"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
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

  async function handleDelete(id: string, e: React.MouseEvent) {
    e.preventDefault();
    if (!confirm("¿Eliminar este proyecto de muros?")) return;
    try {
      await wallProjectsApi.delete(id);
      setProjects(prev => prev.filter(p => p.id !== id));
    } catch {
      setError("Error al eliminar el proyecto");
    }
  }

  if (!ready) return null;

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <AppHeader />

      <main className="mx-auto max-w-5xl px-6 py-10">
        {/* Header */}
        <div className="flex items-start justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-[var(--text)]">Muros RC 3D</h1>
            <p className="text-sm text-[var(--text-muted)] mt-1">
              Análisis no lineal de muros RC con E-SFI-MVLEM-3D / MVLEM_3D
            </p>
          </div>
          <Button onClick={() => setShowNew(v => !v)}>
            {showNew ? "Cancelar" : "+ Nuevo proyecto"}
          </Button>
        </div>

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
              <Link key={p.id} href={`/wall-projects/${p.id}`} className="block group">
                <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5
                  transition-all duration-150 hover:shadow-md hover:-translate-y-0.5
                  group-hover:border-[var(--text-muted)]">
                  <div className="flex items-start justify-between mb-3">
                    <span className="text-sm font-semibold text-[var(--text)] line-clamp-1">{p.name}</span>
                    <button
                      onClick={e => handleDelete(p.id, e)}
                      className="ml-2 shrink-0 text-[var(--text-muted)] hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity text-xs"
                    >✕</button>
                  </div>

                  {p.description && (
                    <p className="text-xs text-[var(--text-muted)] mb-3 line-clamp-2">{p.description}</p>
                  )}

                  <div className="flex items-center justify-between">
                    <StatusBadge status={p.status} />
                    <span className="text-[10px] text-[var(--text-muted)]">{fmtDate(p.created_at)}</span>
                  </div>

                  {p.latest_job && (
                    <div className="mt-2 pt-2 border-t border-[var(--border)]">
                      <span className="text-[10px] text-[var(--text-muted)]">
                        Último análisis: {p.latest_job.job_type} —{" "}
                        <span style={{
                          color: p.latest_job.status === "success" ? "#22c55e"
                               : p.latest_job.status === "failed"  ? "#ef4444"
                               : p.latest_job.status === "running" ? "#f59e0b"
                               : "var(--text-muted)"
                        }}>{p.latest_job.status}</span>
                      </span>
                    </div>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
