"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ApiError } from "@/lib/api";
import { wallProjectsApi } from "@/lib/wall-api";
import { useRequireAuth } from "@/lib/use-require-auth";
import { useTheme } from "@/lib/theme";
import type {
  WallProject5, WRCDocument, WRCMaterial, WRCWall,
  WallJob5, ModalResult5, PushoverResult5, PushoverDirection,
} from "@/lib/wall-types";

// ── Shared styles ─────────────────────────────────────────────────────────────

const card    = "rounded-xl border border-[var(--border)] bg-[var(--surface)]";
const btnPri  = "px-4 py-2 text-xs font-semibold rounded-lg bg-indigo-500 hover:bg-indigo-600 text-white disabled:opacity-50 transition-colors";
const btnSec  = "px-3 py-2 text-xs font-medium rounded-lg border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors";
const btnDng  = "px-3 py-2 text-xs font-medium rounded-lg border border-red-500/30 text-red-400 hover:border-red-500/60 transition-colors";

const TABS = ["Materiales", "Muros", "Análisis", "Resultados"] as const;
type Tab = typeof TABS[number];

// ── Job status badge ──────────────────────────────────────────────────────────

const JOB_COLOR: Record<string, string> = {
  pending:   "var(--text-muted)",
  running:   "#f59e0b",
  success:   "#22c55e",
  failed:    "#ef4444",
  cancelled: "var(--text-muted)",
};
const JOB_LABEL: Record<string, string> = {
  pending: "Pendiente", running: "Procesando…",
  success: "Completado", failed: "Error", cancelled: "Cancelado",
};

function JobBadge({ status }: { status: string }) {
  const c = JOB_COLOR[status] ?? "var(--text-muted)";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
      style={{ background: `${c}22`, color: c }}>
      {status === "running" && <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: c }} />}
      {JOB_LABEL[status] ?? status}
    </span>
  );
}

// ── Pushover chart ────────────────────────────────────────────────────────────

function PushoverChart({ result, isDark }: { result: PushoverResult5; isDark: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(
    typeof window !== "undefined" && !!(window as unknown as { Plotly?: unknown }).Plotly
  );

  useEffect(() => {
    if ((window as unknown as { Plotly?: unknown }).Plotly) { setReady(true); return; }
    const s = document.createElement("script");
    s.src = "https://cdn.plot.ly/plotly-2.35.2.min.js";
    s.onload = () => setReady(true);
    document.head.appendChild(s);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const Plotly = (window as unknown as { Plotly: Record<string, Function> }).Plotly;
    if (!Plotly || !ref.current || !result.steps.length) return;

    const x = result.steps.map(s => s.drift_pct);
    const y = result.steps.map(s => s.base_shear_kN);
    const bg   = isDark ? "#0f172a" : "#ffffff";
    const grid = isDark ? "#1e293b" : "#f1f5f9";
    const txt  = isDark ? "#94a3b8" : "#64748b";

    Plotly.react(ref.current, [{
      x, y, type: "scatter", mode: "lines",
      line: { color: "#6366f1", width: 2.5 },
      name: `Pushover ${result.direction}`,
      hovertemplate: "Deriva: %{x:.3f}%<br>Cortante: %{y:.1f} kN<extra></extra>",
    }], {
      paper_bgcolor: bg, plot_bgcolor: bg,
      margin: { t: 20, r: 20, b: 50, l: 60 },
      xaxis: {
        title: { text: "Deriva de techo (%)", font: { size: 11, color: txt } },
        gridcolor: grid, zerolinecolor: grid, color: txt,
      },
      yaxis: {
        title: { text: "Cortante basal (kN)", font: { size: 11, color: txt } },
        gridcolor: grid, zerolinecolor: grid, color: txt,
      },
      showlegend: false,
    }, { responsive: true, displayModeBar: false });
  }, [result, isDark, ready]);

  return <div ref={ref} style={{ height: 320 }} />;
}

// ── Material card ─────────────────────────────────────────────────────────────

const KIND_COLOR: Record<string, string> = {
  ConcreteCM:   "#0e7fa8",
  Concrete02:   "#0891b2",
  Hysteretic:   "#7c3aed",
  HystereticSM: "#7c3aed",
  Elastic:      "#64748b",
};

function MaterialCard({
  mat, onRemove,
}: { mat: WRCMaterial; onRemove: () => void }) {
  const color = KIND_COLOR[mat.kind] ?? "#64748b";
  return (
    <div className="flex items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3">
      <div className="mt-0.5 h-2 w-2 rounded-full shrink-0" style={{ background: color, marginTop: 5 }} />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-[var(--text)] truncate">{mat.name}</p>
        <p className="text-[10px] text-[var(--text-muted)]">{mat.kind} — {mat.id}</p>
      </div>
      <button onClick={onRemove} className="text-[var(--text-muted)] hover:text-red-400 text-xs mt-0.5">✕</button>
    </div>
  );
}

// ── Wall card ─────────────────────────────────────────────────────────────────

function WallCard({ wall, onRemove }: { wall: WRCWall; onRemove: () => void }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-[var(--text)]">{wall.name}</span>
        <div className="flex items-center gap-2">
          <span className="text-[10px] rounded px-1.5 py-0.5 bg-[var(--surface)] text-[var(--text-muted)]">
            {wall.formulation}
          </span>
          <button onClick={onRemove} className="text-[var(--text-muted)] hover:text-red-400 text-xs">✕</button>
        </div>
      </div>
      <div className="grid grid-cols-4 gap-2 text-[10px] text-[var(--text-muted)]">
        <span>L: {wall.length_m} m</span>
        <span>t: {wall.thickness_m} m</span>
        <span>H: {wall.height_m} m</span>
        <span>{wall.n_fibers} fibras</span>
      </div>
    </div>
  );
}

// ── Add wall form ─────────────────────────────────────────────────────────────

function AddWallForm({ materials, onAdd }: {
  materials: WRCMaterial[];
  onAdd: (wall: WRCWall) => void;
}) {
  const [form, setForm] = useState({
    name: "", formulation: "E_SFI_MVLEM_3D" as WRCWall["formulation"],
    height_m: 3.0, length_m: 4.0, thickness_m: 0.2,
    n_fibers: 8, x0_m: 0.0, y0_m: 0.0, direction: "X" as "X"|"Y",
    c_rot: 0.4, thick_mod: 0.63, poisson: 0.25, density_t_m3: 2.4,
    concrete_mid: "", steel_mid: "",
  });

  const concMats = materials.filter(m => m.kind === "ConcreteCM" || m.kind === "Concrete02");
  const steelMats = materials.filter(m => m.kind === "Hysteretic" || m.kind === "HystereticSM");

  function handleAdd() {
    if (!form.name.trim()) return;
    const wid = `w_${Date.now()}`;
    const lw = form.length_m;
    const tw = form.thickness_m;
    const nf = form.n_fibers;
    const cmid = form.concrete_mid || concMats[0]?.id || "";
    const smid = form.steel_mid    || steelMats[0]?.id || "";
    const macrofibers = Array.from({ length: nf }, () => ({
      width_m: lw / nf,
      thickness_m: tw,
      rho_vertical: 0.005,
      rho_horizontal: 0.003,
      concrete_material_id: cmid,
      steel_v_material_id: smid,
      steel_h_material_id: smid,
    }));
    onAdd({ ...form, id: wid, macrofibers });
  }

  const F = ({ label, field, type = "number", step }: {
    label: string; field: keyof typeof form; type?: string; step?: number;
  }) => (
    <div>
      <p className="text-[10px] text-[var(--text-muted)] mb-0.5">{label}</p>
      <input
        type={type}
        step={step ?? 0.01}
        value={String(form[field])}
        onChange={e => setForm(p => ({ ...p, [field]: type === "number" ? parseFloat(e.target.value) || 0 : e.target.value }))}
        className="w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)]"
      />
    </div>
  );

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-5">
      <p className="text-xs font-semibold text-[var(--text)] mb-4">Nuevo muro</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <F label="Nombre" field="name" type="text" />
        <div>
          <p className="text-[10px] text-[var(--text-muted)] mb-0.5">Formulación</p>
          <select value={form.formulation}
            onChange={e => setForm(p => ({ ...p, formulation: e.target.value as WRCWall["formulation"] }))}
            className="w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)]">
            <option value="E_SFI_MVLEM_3D">E-SFI-MVLEM-3D</option>
            <option value="MVLEM_3D">MVLEM_3D</option>
          </select>
        </div>
        <div>
          <p className="text-[10px] text-[var(--text-muted)] mb-0.5">Dirección</p>
          <select value={form.direction}
            onChange={e => setForm(p => ({ ...p, direction: e.target.value as "X"|"Y" }))}
            className="w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)]">
            <option value="X">X</option>
            <option value="Y">Y</option>
          </select>
        </div>
        <F label="Altura (m)" field="height_m" step={0.1} />
        <F label="Longitud (m)" field="length_m" step={0.1} />
        <F label="Espesor (m)" field="thickness_m" step={0.05} />
        <F label="N° macrofibras" field="n_fibers" step={1} />
        <F label="x₀ (m)" field="x0_m" step={0.1} />
        <F label="y₀ (m)" field="y0_m" step={0.1} />
        <div>
          <p className="text-[10px] text-[var(--text-muted)] mb-0.5">Material concreto</p>
          <select value={form.concrete_mid}
            onChange={e => setForm(p => ({ ...p, concrete_mid: e.target.value }))}
            className="w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)]">
            {concMats.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>
        <div>
          <p className="text-[10px] text-[var(--text-muted)] mb-0.5">Material acero</p>
          <select value={form.steel_mid}
            onChange={e => setForm(p => ({ ...p, steel_mid: e.target.value }))}
            className="w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)]">
            {steelMats.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>
      </div>
      <div className="mt-4">
        <button onClick={handleAdd} disabled={!form.name.trim()}
          className={btnPri}>Agregar muro</button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Main page
// ══════════════════════════════════════════════════════════════════════════════

export default function WallProjectDetailPage() {
  const ready     = useRequireAuth();
  const { id }    = useParams<{ id: string }>();
  const { theme } = useTheme();
  const isDark    = theme === "dark";

  const [project, setProject]   = useState<WallProject5 | null>(null);
  const [doc, setDoc]           = useState<WRCDocument | null>(null);
  const [jobs, setJobs]         = useState<WallJob5[]>([]);
  const [tab, setTab]           = useState<Tab>("Materiales");
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [success, setSuccess]   = useState<string | null>(null);
  const [allPresets, setAllPresets] = useState<WRCMaterial[]>([]);

  // Pushover results per direction
  const [pushResults, setPushResults] = useState<Record<string, PushoverResult5>>({});
  const [modalResult, setModalResult] = useState<ModalResult5 | null>(null);

  // Add wall form toggle
  const [showAddWall, setShowAddWall] = useState(false);

  const pollRef = useRef<NodeJS.Timeout | null>(null);

  // ── Load initial data ───────────────────────────────────────────────────────

  const loadAll = useCallback(async () => {
    if (!id) return;
    try {
      const [p, d, j] = await Promise.all([
        wallProjectsApi.get(id),
        wallProjectsApi.getDocument(id),
        wallProjectsApi.listJobs(id),
      ]);
      setProject(p);
      setDoc(d);
      setJobs(j);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Error al cargar el proyecto");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (ready) loadAll();
  }, [ready, loadAll]);

  // Load preset list once
  useEffect(() => {
    wallProjectsApi.getAllPresets()
      .then(p => setAllPresets([...p.concretecm, ...p.bars, p.wwm]))
      .catch(() => {});
  }, []);

  // ── Poll running jobs ───────────────────────────────────────────────────────

  useEffect(() => {
    const running = jobs.filter(j => j.status === "pending" || j.status === "running");
    if (!running.length) { pollRef.current && clearInterval(pollRef.current); return; }

    pollRef.current = setInterval(async () => {
      const updates = await Promise.allSettled(
        running.map(j => wallProjectsApi.jobStatus(id, j.id))
      );
      setJobs(prev => prev.map(j => {
        const upd = updates.find((u, i) => running[i]?.id === j.id);
        if (upd?.status === "fulfilled") return upd.value;
        return j;
      }));
    }, 3000);

    return () => { pollRef.current && clearInterval(pollRef.current); };
  }, [jobs, id]);

  // ── Load results when jobs complete ────────────────────────────────────────

  useEffect(() => {
    const done = jobs.filter(j => j.status === "success");
    for (const j of done) {
      if (j.job_type === "modal" && !modalResult) {
        wallProjectsApi.jobResult<ModalResult5>(id, j.id)
          .then(r => setModalResult(r))
          .catch(() => {});
      }
      if (j.job_type === "pushover" && j.push_direction && !pushResults[j.push_direction]) {
        wallProjectsApi.jobResult<PushoverResult5>(id, j.id)
          .then(r => setPushResults(p => ({ ...p, [j.push_direction!]: r })))
          .catch(() => {});
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs]);

  // ── Document save ───────────────────────────────────────────────────────────

  const saveDoc = useCallback(async (d: WRCDocument) => {
    setSaving(true); setError(null); setSuccess(null);
    try {
      await wallProjectsApi.saveDocument(id, d);
      setSuccess("Guardado");
      setTimeout(() => setSuccess(null), 2000);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Error al guardar");
    } finally {
      setSaving(false);
    }
  }, [id]);

  // ── Material helpers ────────────────────────────────────────────────────────

  function addPreset(mat: WRCMaterial) {
    if (!doc) return;
    const next = { ...doc, materials: { ...doc.materials, [mat.id]: mat } };
    setDoc(next);
    saveDoc(next);
  }

  function removeMaterial(mid: string) {
    if (!doc) return;
    const mats = { ...doc.materials };
    delete mats[mid];
    const next = { ...doc, materials: mats };
    setDoc(next);
    saveDoc(next);
  }

  // ── Wall helpers ────────────────────────────────────────────────────────────

  function addWall(wall: WRCWall) {
    if (!doc) return;
    const next = { ...doc, walls: [...doc.walls, wall] };
    setDoc(next);
    setShowAddWall(false);
    saveDoc(next);
  }

  function removeWall(wid: string) {
    if (!doc) return;
    const next = { ...doc, walls: doc.walls.filter(w => w.id !== wid) };
    setDoc(next);
    saveDoc(next);
  }

  // ── Analysis launch ─────────────────────────────────────────────────────────

  async function launch(jobType: "gravity"|"modal"|"pushover", direction?: PushoverDirection) {
    setError(null);
    try {
      const r = await wallProjectsApi.launch(id, jobType, direction);
      setJobs(prev => [{
        id:             r.job_id,
        job_type:       jobType,
        status:         "pending",
        push_direction: direction ?? null,
        result_summary: null,
        error_message:  null,
        created_at:     new Date().toISOString(),
        finished_at:    null,
      }, ...prev]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Error al lanzar análisis");
    }
  }

  // ── Analysis settings update ────────────────────────────────────────────────

  function updateAnalysis(field: string, value: unknown) {
    if (!doc) return;
    const next = { ...doc, analysis: { ...doc.analysis, [field]: value } };
    setDoc(next);
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (!ready || loading) return (
    <div className="min-h-screen bg-[var(--bg)]">
      <AppHeader />
      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="h-8 w-48 rounded bg-[var(--surface-2)] animate-pulse mb-4" />
        <div className="h-96 rounded-xl bg-[var(--surface-2)] animate-pulse" />
      </div>
    </div>
  );

  if (!project || !doc) return (
    <div className="min-h-screen bg-[var(--bg)]"><AppHeader />
      <div className="mx-auto max-w-5xl px-6 py-10 text-[var(--text-muted)]">
        {error ?? "Proyecto no encontrado"}
      </div>
    </div>
  );

  const materialList = Object.values(doc.materials);
  const pendingJobs  = jobs.filter(j => j.status === "pending" || j.status === "running");
  const hasWalls     = doc.walls.length > 0;

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <AppHeader />

      <main className="mx-auto max-w-5xl px-6 py-8">

        {/* Breadcrumb + title */}
        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)] mb-1">
          <Link href="/wall-projects" className="hover:text-[var(--text)]">Muros RC</Link>
          <span>/</span>
          <span className="text-[var(--text)]">{project.name}</span>
        </div>
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold text-[var(--text)]">{project.name}</h1>
          <div className="flex items-center gap-2">
            {saving && <span className="text-xs text-[var(--text-muted)]">Guardando…</span>}
            {success && <span className="text-xs text-green-400">{success}</span>}
            <button onClick={() => wallProjectsApi.downloadScript(id, project.name)}
              className={btnSec}>Exportar .py</button>
          </div>
        </div>

        {error && <p className="mb-4 text-xs text-red-400">{error}</p>}

        {/* Tabs */}
        <div className="flex gap-1 border-b border-[var(--border)] mb-6">
          {TABS.map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
                tab === t
                  ? "border-indigo-500 text-indigo-400"
                  : "border-transparent text-[var(--text-muted)] hover:text-[var(--text)]"
              }`}>
              {t}
            </button>
          ))}
        </div>

        {/* ── Tab: Materiales ────────────────────────────────────────────────── */}
        {tab === "Materiales" && (
          <div className="grid gap-6 lg:grid-cols-2">

            {/* Current materials */}
            <div className={card}>
              <div className="px-5 py-4 border-b border-[var(--border)] flex items-center justify-between">
                <h2 className="text-sm font-semibold text-[var(--text)]">
                  Materiales del proyecto ({materialList.length})
                </h2>
              </div>
              <div className="px-5 py-4 flex flex-col gap-2">
                {materialList.length === 0 ? (
                  <p className="text-xs text-[var(--text-muted)]">Sin materiales. Agrega desde los presets.</p>
                ) : materialList.map(m => (
                  <MaterialCard key={m.id} mat={m} onRemove={() => removeMaterial(m.id)} />
                ))}
              </div>
            </div>

            {/* Preset picker */}
            <div className={card}>
              <div className="px-5 py-4 border-b border-[var(--border)]">
                <h2 className="text-sm font-semibold text-[var(--text)]">Presets disponibles</h2>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                  Click para agregar al proyecto
                </p>
              </div>
              <div className="px-5 py-4 flex flex-col gap-2 max-h-96 overflow-y-auto">
                {allPresets.filter(p => !doc.materials[p.id]).map(m => (
                  <button key={m.id} onClick={() => addPreset(m)}
                    className="flex items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 text-left hover:border-indigo-500/40 transition-colors">
                    <div className="mt-1 h-2 w-2 rounded-full shrink-0"
                      style={{ background: KIND_COLOR[m.kind] ?? "#64748b" }} />
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-[var(--text)] truncate">{m.name}</p>
                      <p className="text-[10px] text-[var(--text-muted)]">{m.kind}</p>
                    </div>
                    <span className="ml-auto text-indigo-400 text-xs">+</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Detailing */}
            <div className={card}>
              <div className="px-5 py-4 border-b border-[var(--border)]">
                <h2 className="text-sm font-semibold text-[var(--text)]">Nivel de disipación</h2>
              </div>
              <div className="px-5 py-4 flex gap-2">
                {["DMO", "DES", "DES_ESP"].map(d => (
                  <button key={d} onClick={() => {
                    const next = { ...doc, detailing: d };
                    setDoc(next); saveDoc(next);
                  }}
                    className={`px-4 py-2 text-xs font-semibold rounded-lg border transition-colors ${
                      doc.detailing === d
                        ? "border-indigo-500 bg-indigo-500/10 text-indigo-400"
                        : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]"
                    }`}>
                    {d}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Tab: Muros ─────────────────────────────────────────────────────── */}
        {tab === "Muros" && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <p className="text-xs text-[var(--text-muted)]">
                {doc.walls.length} muro{doc.walls.length !== 1 ? "s" : ""} configurado{doc.walls.length !== 1 ? "s" : ""}
              </p>
              <button onClick={() => setShowAddWall(v => !v)} className={btnPri}>
                {showAddWall ? "Cancelar" : "+ Agregar muro"}
              </button>
            </div>

            {showAddWall && (
              <AddWallForm
                materials={materialList}
                onAdd={addWall}
              />
            )}

            {doc.walls.length === 0 && !showAddWall ? (
              <div className="text-center py-16 text-[var(--text-muted)]">
                <p className="text-3xl mb-2">🧱</p>
                <p className="text-sm">Agrega al menos un muro para continuar</p>
              </div>
            ) : doc.walls.map(w => (
              <WallCard key={w.id} wall={w} onRemove={() => removeWall(w.id)} />
            ))}
          </div>
        )}

        {/* ── Tab: Análisis ──────────────────────────────────────────────────── */}
        {tab === "Análisis" && (
          <div className="grid gap-6 lg:grid-cols-2">

            {/* Launch panel */}
            <div className={card}>
              <div className="px-5 py-4 border-b border-[var(--border)]">
                <h2 className="text-sm font-semibold text-[var(--text)]">Lanzar análisis</h2>
                {!hasWalls && (
                  <p className="text-xs text-amber-400 mt-1">Configura al menos un muro primero</p>
                )}
              </div>
              <div className="px-5 py-4 flex flex-col gap-3">
                <button onClick={() => launch("gravity")}
                  disabled={!hasWalls || pendingJobs.length > 0}
                  className={btnSec + " text-left"}>
                  <span className="font-semibold">Gravitacional</span>
                  <span className="block text-[10px]">Establece estado de carga inicial</span>
                </button>
                <button onClick={() => launch("modal")}
                  disabled={!hasWalls || pendingJobs.length > 0}
                  className={btnSec + " text-left"}>
                  <span className="font-semibold">Modal (post-gravedad)</span>
                  <span className="block text-[10px]">Eigenvalue — periodos y frecuencias</span>
                </button>
                {(["X", "-X", "Y", "-Y"] as PushoverDirection[]).map(dir => (
                  <button key={dir} onClick={() => launch("pushover", dir)}
                    disabled={!hasWalls || pendingJobs.length > 0}
                    className={btnSec + " text-left"}>
                    <span className="font-semibold">Pushover {dir}</span>
                    <span className="block text-[10px]">Hasta {doc.analysis.target_drift_pct}% de deriva</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Settings */}
            <div className={card}>
              <div className="px-5 py-4 border-b border-[var(--border)]">
                <h2 className="text-sm font-semibold text-[var(--text)]">Parámetros de análisis</h2>
              </div>
              <div className="px-5 py-4 grid grid-cols-2 gap-4">
                {([
                  ["Pasos gravedad", "gravity_steps", 1],
                  ["Modos modales", "modal_modes", 1],
                  ["Deriva objetivo (%)", "target_drift_pct", 0.1],
                  ["Incremento (m)", "displacement_increment_m", 0.0001],
                ] as [string, keyof WRCDocument["analysis"], number][]).map(([lbl, field, step]) => (
                  <div key={field}>
                    <p className="text-[10px] text-[var(--text-muted)] mb-0.5">{lbl}</p>
                    <input type="number" step={step}
                      value={doc.analysis[field] as number}
                      onChange={e => updateAnalysis(field, parseFloat(e.target.value) || 0)}
                      onBlur={() => saveDoc(doc)}
                      className="w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)]" />
                  </div>
                ))}
              </div>
            </div>

            {/* Job list */}
            <div className={`${card} lg:col-span-2`}>
              <div className="px-5 py-4 border-b border-[var(--border)] flex items-center justify-between">
                <h2 className="text-sm font-semibold text-[var(--text)]">Jobs de análisis</h2>
                <button onClick={loadAll} className={btnSec + " text-[10px]"}>Actualizar</button>
              </div>
              {jobs.length === 0 ? (
                <div className="px-5 py-6 text-xs text-[var(--text-muted)]">Sin jobs todavía</div>
              ) : (
                <div className="divide-y divide-[var(--border)]">
                  {jobs.slice(0, 12).map(j => (
                    <div key={j.id} className="px-5 py-3 flex items-center gap-4">
                      <div className="flex-1 min-w-0">
                        <span className="text-xs font-medium text-[var(--text)] capitalize">
                          {j.job_type}{j.push_direction ? ` ${j.push_direction}` : ""}
                        </span>
                        {j.result_summary && (
                          <p className="text-[10px] text-[var(--text-muted)] truncate">
                            {Object.entries(j.result_summary).slice(0,3).map(([k,v]) =>
                              `${k}: ${typeof v === "number" ? v.toFixed(2) : v}`
                            ).join(" · ")}
                          </p>
                        )}
                        {j.error_message && (
                          <p className="text-[10px] text-red-400 truncate">{j.error_message}</p>
                        )}
                      </div>
                      <JobBadge status={j.status} />
                      <span className="text-[10px] text-[var(--text-muted)] whitespace-nowrap">
                        {new Date(j.created_at).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Tab: Resultados ────────────────────────────────────────────────── */}
        {tab === "Resultados" && (
          <div className="flex flex-col gap-6">

            {/* Modal */}
            {modalResult ? (
              <div className={card}>
                <div className="px-5 py-4 border-b border-[var(--border)]">
                  <h2 className="text-sm font-semibold text-[var(--text)]">Análisis Modal</h2>
                </div>
                <div className="px-5 py-4 grid grid-cols-2 sm:grid-cols-3 gap-4">
                  {modalResult.periods_s.map((T, i) => (
                    <div key={i}>
                      <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">Modo {i+1}</p>
                      <p className="text-sm font-semibold text-[var(--text)]">T = {T.toFixed(3)} s</p>
                      <p className="text-[10px] text-[var(--text-muted)]">f = {modalResult.frequencies_hz[i]?.toFixed(3)} Hz</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className={`${card} px-5 py-6 text-xs text-[var(--text-muted)]`}>
                Sin resultados modales. Ejecuta el análisis Modal en la pestaña Análisis.
              </div>
            )}

            {/* Pushover curves */}
            {Object.entries(pushResults).length > 0 ? (
              Object.entries(pushResults).map(([dir, res]) => (
                <div key={dir} className={card}>
                  <div className="px-5 py-4 border-b border-[var(--border)] flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-[var(--text)]">
                      Curva de capacidad — Pushover {dir}
                    </h2>
                    <div className="flex items-center gap-4 text-xs text-[var(--text-muted)]">
                      <span>Deriva máx: <span className="text-[var(--text)] font-semibold">
                        {res.summary.max_drift_pct.toFixed(2)}%
                      </span></span>
                      <span>V máx: <span className="text-[var(--text)] font-semibold">
                        {res.summary.max_base_shear_kN.toFixed(0)} kN
                      </span></span>
                      <span className={res.status === "partial" ? "text-amber-400" : "text-green-400"}>
                        {res.status === "partial" ? `Parcial (${res.converged_steps}/${res.total_steps})` : "Completo"}
                      </span>
                    </div>
                  </div>
                  <div className="px-2 py-2">
                    <PushoverChart result={res} isDark={isDark} />
                  </div>
                </div>
              ))
            ) : (
              <div className={`${card} px-5 py-6 text-xs text-[var(--text-muted)]`}>
                Sin curvas de pushover. Ejecuta un análisis Pushover en la pestaña Análisis.
              </div>
            )}
          </div>
        )}

      </main>
    </div>
  );
}
