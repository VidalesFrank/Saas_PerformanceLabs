"use client";

/**
 * WallDesignDetailView — Vista gráfica premium de diseño de muros RC (Módulo 1).
 *
 * Reemplaza el antiguo WallSectionDetailView. Ofrece:
 *   • SVG interactivo estilo CAD con hover / tooltip / click / drag / doble-clic
 *   • Selector de piso + comparador side-by-side con vecino
 *   • Editor de barras con snap magnético y recalculo de cuantías en vivo
 *   • Botones replicar / copiar / pegar / restaurar auto-diseño
 *   • Curva P-M interactiva con demandas (Plotly)
 *   • Panel derecho con tabs: Refuerzo · P-M · Checks · OpenSees
 *
 * Depende de:
 *   - fetchWallDetail / fetchWalls / redesignWall  (lib/wall-api.ts)
 *   - WallDetailResponse / WallDesignResult / WallManualReinf  (lib/wall-types.ts)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type {
  WallDetailResponse,
  WallDesignResult,
  WallDesignBar,
  WallManualReinf,
  WallListItem,
  BoundaryZoneDesign,
  WebZoneDesign,
  WallCodeCheck,
} from "@/lib/wall-types";
import { fetchWallDetail, fetchWalls, redesignWall } from "@/lib/wall-api";
import { Button } from "@/components/ui/button";

declare const window: Window & { Plotly: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

// ── Constantes visuales ─────────────────────────────────────────────────────

const COLOR_BE_L = "#3b7dd8";
const COLOR_WEB  = "#4a9e5c";
const COLOR_BE_R = "#c06030";
const COLOR_TIE  = "#a855f7";

// Diámetros comerciales (mm) — usados en el picker.
// Colombia: catálogo ASTM A615 disponible en obra = #2, #3, #4, #5, #6, #7, #8, #10.
// #9 y #11 no son comerciales aquí y quedan fuera del picker.
const BAR_DIAMETERS_MM = [6.4, 9.5, 12.7, 15.9, 19.1, 22.2, 25.4, 32.3] as const;

// Mapeo diámetro → número comercial (#2, #3, ...). Tolera variaciones ±0.5 mm.
const BAR_NUMBER_TABLE: ReadonlyArray<{ db: number; label: string }> = [
  { db: 6.4,  label: "#2"  },
  { db: 9.5,  label: "#3"  },
  { db: 12.7, label: "#4"  },
  { db: 15.9, label: "#5"  },
  { db: 19.1, label: "#6"  },
  { db: 22.2, label: "#7"  },
  { db: 25.4, label: "#8"  },
  { db: 32.3, label: "#10" },
];

function barName(db_mm: number): string {
  let best = BAR_NUMBER_TABLE[0];
  let bestDist = Math.abs(db_mm - best.db);
  for (const entry of BAR_NUMBER_TABLE) {
    const d = Math.abs(db_mm - entry.db);
    if (d < bestDist) { best = entry; bestDist = d; }
  }
  return bestDist <= 0.5 ? best.label : `⌀${db_mm.toFixed(1)}`;
}

// Snap magnético: espaciamientos redondos (mm)
const SNAP_STEPS_MM = [25, 50, 75, 100, 125, 150, 175, 200, 250, 300];

// localStorage key para el buffer copia/pega
const CLIP_KEY = "pl:wall-reinf-clipboard";

// ── Zone helpers ────────────────────────────────────────────────────────────

type Zone = "be_left" | "web" | "be_right";

function classifyBar(
  x_m: number,
  lw_m: number,
  lc_left_m: number,
  lc_right_m: number,
): Zone {
  const x_mm = x_m * 1000;
  const lL   = lc_left_m  * 1000;
  const lR   = lc_right_m * 1000;
  const lw   = lw_m * 1000;
  if (x_mm <= lL + 1)      return "be_left";
  if (x_mm >= lw - lR - 1) return "be_right";
  return "web";
}

function zoneColor(z: Zone): string {
  return z === "be_left" ? COLOR_BE_L : z === "be_right" ? COLOR_BE_R : COLOR_WEB;
}

function zoneLabel(z: Zone): string {
  return z === "be_left" ? "BE izq." : z === "be_right" ? "BE der." : "Web";
}

function dbFromArea(As_mm2: number): number {
  return 2 * Math.sqrt(As_mm2 / Math.PI);
}

function areaFromDb(db_mm: number): number {
  return Math.PI * (db_mm / 2) ** 2;
}

// ── Editable bar (state mutable en el editor) ───────────────────────────────

interface EditableBar {
  id: string;
  x_m: number;      // posición desde extremo izquierdo (m)
  db_mm: number;    // diámetro (mm)
}

function barsFromDesign(dr: WallDesignResult): EditableBar[] {
  // El backend expone `bars: [{x, As}]`. Reconstruimos db desde As.
  return dr.bars.map((b, i) => ({
    id: `b${i}`,
    x_m: b.x,
    db_mm: dbFromArea(b.As),
  }));
}

// Snap magnético en X (mm)
function snapX(x_mm: number, others: EditableBar[], excludeId?: string, tolPx = 6, scale = 1): number {
  const tolMm = tolPx / scale;
  // 1) Snap a otras barras
  for (const b of others) {
    if (b.id === excludeId) continue;
    if (Math.abs(b.x_m * 1000 - x_mm) < tolMm) return b.x_m * 1000;
  }
  // 2) Snap a espaciamientos redondos (25, 50, 100, ...)
  for (const step of SNAP_STEPS_MM) {
    const snapped = Math.round(x_mm / step) * step;
    if (Math.abs(snapped - x_mm) < tolMm) return snapped;
  }
  return x_mm;
}

// ── ManualReinf serialization ───────────────────────────────────────────────

function editableToManual(
  bars: EditableBar[],
  dr: WallDesignResult,
  overrides?: Partial<WallDesignResult["reinforcement"]>,
): WallManualReinf {
  const r = dr.reinforcement;

  const inZone = (b: EditableBar): Zone =>
    classifyBar(b.x_m, dr.geometry.lw_m, r.be_left.length_m, r.be_right.length_m);

  const beL = bars.filter((b) => inZone(b) === "be_left");
  const beR = bars.filter((b) => inZone(b) === "be_right");
  const web = bars.filter((b) => inZone(b) === "web");

  const avgDb = (bs: EditableBar[], fallback: number): number =>
    bs.length > 0 ? bs.reduce((s, x) => s + x.db_mm, 0) / bs.length : fallback;

  // Nota: el WallManualReinf tiene n_bars por BE ("longitudinales por cara"), aquí
  // asumimos que el usuario editó las barras en la vista de la sección — que es
  // el arreglo total. Para el manual_reinf enviamos n_bars = total del BE.
  const be_left = overrides?.be_left ? { ...r.be_left, ...overrides.be_left } : { ...r.be_left };
  const be_right = overrides?.be_right ? { ...r.be_right, ...overrides.be_right } : { ...r.be_right };
  const web_out = overrides?.web ? { ...r.web, ...overrides.web } : { ...r.web };

  return {
    be_left: {
      n_bars: beL.length || be_left.n_bars,
      db_mm: avgDb(beL, be_left.db_mm),
      cover_mm: be_left.cover_mm,
      tie_db_mm: be_left.tie_db_mm,
      tie_spacing_mm: be_left.tie_spacing_mm,
      length_m: be_left.length_m,
    },
    web: {
      vert_db_mm: avgDb(web, web_out.vert_db_mm),
      vert_spacing_mm: web_out.vert_spacing_mm,
      horiz_db_mm: web_out.horiz_db_mm,
      horiz_spacing_mm: web_out.horiz_spacing_mm,
      n_curtains: web_out.n_curtains,
    },
    be_right: {
      n_bars: beR.length || be_right.n_bars,
      db_mm: avgDb(beR, be_right.db_mm),
      cover_mm: be_right.cover_mm,
      tie_db_mm: be_right.tie_db_mm,
      tie_spacing_mm: be_right.tie_spacing_mm,
      length_m: be_right.length_m,
    },
    symmetric: false,
  };
}

// ── Cuantías vivas ──────────────────────────────────────────────────────────

function liveRatios(bars: EditableBar[], dr: WallDesignResult) {
  const r = dr.reinforcement;
  const lw = dr.geometry.lw_m;
  const tw = dr.geometry.tw_m;

  const bucket = (z: Zone) =>
    bars.filter((b) => classifyBar(b.x_m, lw, r.be_left.length_m, r.be_right.length_m) === z);

  const asSum = (bs: EditableBar[]) => bs.reduce((s, b) => s + areaFromDb(b.db_mm), 0);

  const beL = bucket("be_left");
  const beR = bucket("be_right");
  const web = bucket("web");

  // BE: dos filas (frontal y posterior de las que muestra la vista en planta) — ya vienen en `bars`.
  const As_beL = asSum(beL);
  const As_beR = asSum(beR);
  const As_web = asSum(web);

  const A_beL = r.be_left.length_m * tw * 1e6;   // mm²
  const A_beR = r.be_right.length_m * tw * 1e6;
  const A_web = Math.max(0.001, (lw - r.be_left.length_m - r.be_right.length_m) * tw * 1e6);

  return {
    rho_v_be_L: A_beL > 0 ? As_beL / A_beL : 0,
    rho_v_be_R: A_beR > 0 ? As_beR / A_beR : 0,
    rho_v_web:  A_web > 0 ? As_web / A_web : 0,
    n_be_L: beL.length,
    n_be_R: beR.length,
    n_web:  web.length,
    As_be_L: As_beL, As_be_R: As_beR, As_web,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Root component
// ═══════════════════════════════════════════════════════════════════════════

interface Props {
  detail: WallDetailResponse;
  projectId: string;
  onReload: () => void;
}

export default function WallDesignDetailView({ detail, projectId, onReload }: Props) {
  const router = useRouter();

  // ── Estado global del componente ──────────────────────────────────────────
  const [walls, setWalls] = useState<WallListItem[] | null>(null);
  const [busy, setBusy]   = useState(false);
  const [err, setErr]     = useState<string | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [clipboardVersion, setClipboardVersion] = useState(0); // reactivo al buffer

  useEffect(() => {
    fetchWalls(projectId).then((r) => setWalls(r.walls)).catch(() => setWalls([]));
  }, [projectId]);

  // ── Info del muro actual ──────────────────────────────────────────────────
  const pier  = detail.physical_geom?.pier  ?? detail.analytical?.source_pier  ?? "—";
  const story = detail.physical_geom?.story ?? detail.analytical?.source_story ?? "—";

  // Muros hermanos (mismo pier, otras historias)
  const siblings = useMemo(() => {
    if (!walls) return [];
    return walls
      .filter((w) => (w.source_pier || w.area_label) === pier)
      .sort((a, b) => a.source_story.localeCompare(b.source_story));
  }, [walls, pier]);

  const currentIdx = siblings.findIndex((w) => w.label === detail.label);

  // ── Estado editable (barras + form data) ──────────────────────────────────
  const dr = detail.design_result;
  const [editBars, setEditBars] = useState<EditableBar[]>(() => (dr ? barsFromDesign(dr) : []));
  const [dirty, setDirty] = useState(false);

  // resync cuando cambia el muro visible
  useEffect(() => {
    setEditBars(dr ? barsFromDesign(dr) : []);
    setDirty(false);
  }, [detail.label, dr]);

  const ratios = useMemo(() => (dr ? liveRatios(editBars, dr) : null), [editBars, dr]);

  // ── Acciones ──────────────────────────────────────────────────────────────

  async function saveEdits() {
    if (!dr) return;
    setBusy(true); setErr(null);
    try {
      const manual = editableToManual(editBars, dr);
      await redesignWall(projectId, detail.label, { manual_reinf: manual });
      setDirty(false);
      onReload();
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  }

  async function restoreAuto() {
    setBusy(true); setErr(null);
    try {
      await redesignWall(projectId, detail.label, {});
      setDirty(false);
      onReload();
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  }

  function copyReinf() {
    if (!dr) return;
    const manual = editableToManual(editBars, dr);
    try {
      localStorage.setItem(CLIP_KEY, JSON.stringify({ ts: Date.now(), manual }));
      setClipboardVersion((v) => v + 1);
    } catch {/* ignore */}
  }

  async function pasteReinf() {
    if (!dr) return;
    let manual: WallManualReinf | null = null;
    try {
      const raw = localStorage.getItem(CLIP_KEY);
      if (raw) manual = JSON.parse(raw).manual;
    } catch {/* ignore */}
    if (!manual) return;
    setBusy(true); setErr(null);
    try {
      await redesignWall(projectId, detail.label, { manual_reinf: manual });
      onReload();
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  }

  async function replicateToAll() {
    if (!dr || siblings.length <= 1) return;
    if (!confirm(`Replicar refuerzo a ${siblings.length - 1} muros del pier ${pier}?`)) return;
    setBusy(true); setErr(null);
    const manual = editableToManual(editBars, dr);
    const targets = siblings.filter((w) => w.label !== detail.label);
    try {
      await Promise.all(
        targets.map((t) => redesignWall(projectId, t.label, { manual_reinf: manual })),
      );
      onReload();
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  }

  function gotoStory(label: string) {
    if (dirty && !confirm("Hay cambios sin guardar. ¿Descartar y navegar?")) return;
    router.push(`/projects/${projectId}/walls/${encodeURIComponent(label)}`);
  }

  const hasClipboard = (() => {
    if (typeof window === "undefined") return false;
    // Depend on clipboardVersion so this recomputes after copy
    void clipboardVersion;
    try { return !!localStorage.getItem(CLIP_KEY); } catch { return false; }
  })();

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Header + toolbar */}
      <HeaderBar
        detail={detail}
        pier={pier} story={story}
        dirty={dirty} busy={busy}
        hasClipboard={hasClipboard}
        onSave={saveEdits}
        onRestore={restoreAuto}
        onCopy={copyReinf}
        onPaste={pasteReinf}
        onReplicate={replicateToAll}
        onCompare={() => setCompareOpen(true)}
        canCompare={siblings.length > 1}
        projectId={projectId}
      />

      {err && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">
          {err}
        </div>
      )}

      {/* Layout 3-columnas */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[220px_minmax(0,1fr)_360px]">
        {/* Panel izquierdo */}
        <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start">
          <MiniPlanCard walls={walls} activeLabel={detail.label} onPick={gotoStory} />
          <ElevationCard
            siblings={siblings}
            activeLabel={detail.label}
            currentIdx={currentIdx}
            onPick={gotoStory}
          />
        </aside>

        {/* Área central: canvas SVG + interacción */}
        <section className="space-y-4">
          {dr ? (
            <WallSectionCanvas
              detail={detail}
              bars={editBars}
              onBarsChange={(next) => { setEditBars(next); setDirty(true); }}
            />
          ) : (
            <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface)] px-6 py-16 text-center text-sm text-[var(--text-muted)]">
              Este muro aún no tiene refuerzo diseñado. Corre el auto-diseño desde la lista de muros.
            </div>
          )}
        </section>

        {/* Panel derecho: tabs */}
        <aside className="space-y-4">
          <RightPanel detail={detail} ratios={ratios} bars={editBars} />
        </aside>
      </div>

      {/* Modal comparar */}
      {compareOpen && (
        <CompareModal
          projectId={projectId}
          currentDetail={detail}
          siblings={siblings}
          onClose={() => setCompareOpen(false)}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// HeaderBar
// ═══════════════════════════════════════════════════════════════════════════

function HeaderBar({
  detail, pier, story, dirty, busy, hasClipboard,
  onSave, onRestore, onCopy, onPaste, onReplicate, onCompare, canCompare, projectId,
}: {
  detail: WallDetailResponse;
  pier: string; story: string;
  dirty: boolean; busy: boolean; hasClipboard: boolean;
  onSave: () => void; onRestore: () => void;
  onCopy: () => void; onPaste: () => void;
  onReplicate: () => void; onCompare: () => void;
  canCompare: boolean;
  projectId: string;
}) {
  const g  = detail.geometry;
  const dr = detail.design_result;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-[.14em] text-[var(--text-muted)]">
            Diseño de muro RC — NSR-10 / ACI 318-25
          </div>
          <h1 className="mt-0.5 text-xl font-bold tracking-tight text-[var(--text)]">
            {detail.label}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs text-[var(--text-muted)]">
            <span>Pier <span className="font-mono font-semibold text-[var(--text)]">{pier}</span></span>
            <span>Story <span className="font-mono font-semibold text-[var(--text)]">{story}</span></span>
            {g && (
              <>
                <span>lw <span className="font-mono">{(g.total_length_m * 1000).toFixed(0)} mm</span></span>
                <span>tw <span className="font-mono">{(g.thickness_m * 1000).toFixed(0)} mm</span></span>
                {detail.physical_geom && (
                  <span>hw <span className="font-mono">{detail.physical_geom.hw_m.toFixed(2)} m</span></span>
                )}
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {dr && <DesignBadge dr={dr} />}
        </div>
      </div>

      {/* Toolbar */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Link href={`/projects/${projectId}?tab=walls`}>
          <Button variant="ghost" className="!px-2 !py-1 !text-xs">
            <span className="mr-1">←</span> Volver a lista
          </Button>
        </Link>
        <span className="mx-1 h-5 w-px bg-[var(--border)]" />
        <ToolbarBtn onClick={onRestore} disabled={busy} icon="⟲">
          Restaurar auto-diseño
        </ToolbarBtn>
        <ToolbarBtn onClick={onCopy} disabled={busy} icon="⧉">Copiar refuerzo</ToolbarBtn>
        {hasClipboard && (
          <ToolbarBtn onClick={onPaste} disabled={busy} icon="⎘" accent>Pegar refuerzo</ToolbarBtn>
        )}
        <ToolbarBtn onClick={onReplicate} disabled={busy} icon="⇓">Replicar a pisos hermanos</ToolbarBtn>
        <ToolbarBtn onClick={onCompare} disabled={!canCompare} icon="⇋">Comparar con vecino</ToolbarBtn>

        <div className="ml-auto flex items-center gap-2">
          {dirty && (
            <span className="text-[11px] font-medium text-amber-500">● Cambios sin guardar</span>
          )}
          <button
            type="button"
            onClick={onSave}
            disabled={!dirty || busy}
            className={`inline-flex items-center gap-1.5 rounded-md px-4 py-1.5 text-xs font-semibold transition-all
              ${dirty && !busy
                ? "bg-[var(--accent)] text-white hover:opacity-90 shadow-sm"
                : "bg-[var(--surface-2)] text-[var(--text-muted)] cursor-not-allowed"}`}
          >
            <span>💾</span>
            {busy ? "Guardando…" : "Guardar cambios"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ToolbarBtn({
  onClick, disabled, icon, children, accent,
}: {
  onClick: () => void; disabled?: boolean; icon: string; children: React.ReactNode; accent?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors
        ${accent
          ? "border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)]/10"
          : "border-[var(--border)] text-[var(--text)] hover:bg-[var(--surface-2)]"}
        disabled:opacity-40 disabled:cursor-not-allowed`}
    >
      <span className="text-[13px] leading-none">{icon}</span>
      <span>{children}</span>
    </button>
  );
}

function DesignBadge({ dr }: { dr: WallDesignResult }) {
  const ok = dr.ok;
  const failed = dr.summary.failed_checks;
  const ebe = dr.summary.ebe_required;
  const cls = ok
    ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-500"
    : "bg-red-500/10 border-red-500/30 text-red-500";
  return (
    <div className={`rounded-lg border px-3 py-1.5 ${cls}`}>
      <div className="text-[10px] font-bold uppercase tracking-wider">Diseño {dr.ductility}</div>
      <div className="text-sm font-semibold">
        {ok ? "✓ Cumple" : `✗ ${failed} check(s) fallan`}
        {ebe && <span className="ml-1 opacity-75">· EBE</span>}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Panel izquierdo — Mini-planta + Elevación
// ═══════════════════════════════════════════════════════════════════════════

function MiniPlanCard({
  walls, activeLabel, onPick,
}: {
  walls: WallListItem[] | null;
  activeLabel: string;
  onPick: (label: string) => void;
}) {
  // TODO(mini-map geometry): dibujar planta con coordenadas reales de los joints.
  // Requiere endpoint que devuelva coords por muro; por ahora listamos muros del
  // primer piso disponible como shortcut de navegación.
  const firstStory = walls && walls.length > 0
    ? [...new Set(walls.map((w) => w.source_story))].sort()[0]
    : null;

  const inFirst = walls
    ? walls.filter((w) => w.source_story === firstStory)
    : [];

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">
          Muros del piso {firstStory ?? "…"}
        </span>
        <span className="text-[9px] text-[var(--text-muted)]">planta (list.)</span>
      </div>
      <div className="max-h-[240px] space-y-0.5 overflow-y-auto pr-1">
        {inFirst.length === 0 && (
          <div className="pl-skeleton h-4 rounded" />
        )}
        {inFirst.map((w) => {
          const isActivePier = walls?.find((x) => x.label === activeLabel)?.source_pier === w.source_pier;
          return (
            <button
              key={w.label}
              onClick={() => onPick(w.label)}
              className={`flex w-full items-center justify-between rounded px-2 py-1 text-left text-[11px] transition-colors ${
                isActivePier
                  ? "bg-[var(--accent)]/12 text-[var(--accent)] font-semibold"
                  : "hover:bg-[var(--surface-2)] text-[var(--text)]"
              }`}
              title={`Pier ${w.source_pier} · Story ${w.source_story}`}
            >
              <span className="font-mono truncate">{w.source_pier || w.area_label}</span>
              <span className="ml-2 font-mono text-[10px] text-[var(--text-muted)]">
                {w.section}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ElevationCard({
  siblings, activeLabel, currentIdx, onPick,
}: {
  siblings: WallListItem[];
  activeLabel: string;
  currentIdx: number;
  onPick: (label: string) => void;
}) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">
          Elevación (pisos)
        </span>
        <span className="text-[9px] text-[var(--text-muted)]">{siblings.length} niveles</span>
      </div>

      {/* Selector rápido */}
      <div className="mb-2 flex items-center gap-1">
        <button
          onClick={() => currentIdx > 0 && onPick(siblings[currentIdx - 1].label)}
          disabled={currentIdx <= 0}
          className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[11px] hover:bg-[var(--surface-2)] disabled:opacity-40"
          title="Piso inferior"
        >↓</button>
        <select
          value={activeLabel}
          onChange={(e) => onPick(e.target.value)}
          className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-0.5 text-[11px] font-mono"
        >
          {siblings.map((w) => (
            <option key={w.label} value={w.label}>{w.source_story}</option>
          ))}
        </select>
        <button
          onClick={() => currentIdx < siblings.length - 1 && onPick(siblings[currentIdx + 1].label)}
          disabled={currentIdx >= siblings.length - 1}
          className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[11px] hover:bg-[var(--surface-2)] disabled:opacity-40"
          title="Piso superior"
        >↑</button>
      </div>

      {/* Barra vertical con celda por piso */}
      <div className="flex flex-col gap-0.5">
        {[...siblings].reverse().map((w) => {
          const active = w.label === activeLabel;
          // TODO: color según estado real (fetchWallDesign de cada sibling costaría N requests).
          // Por ahora sólo diferenciamos activo vs no-activo.
          return (
            <button
              key={w.label}
              onClick={() => onPick(w.label)}
              className={`flex h-6 items-center justify-between rounded px-2 text-[10.5px] transition-colors ${
                active
                  ? "bg-[var(--accent)]/15 text-[var(--accent)] font-semibold ring-1 ring-[var(--accent)]/40"
                  : "bg-[var(--surface-2)] hover:bg-[var(--border)] text-[var(--text-muted)]"
              }`}
            >
              <span className="font-mono">{w.source_story}</span>
              <span className="font-mono text-[9.5px] opacity-80">{w.section}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Canvas SVG interactivo del muro
// ═══════════════════════════════════════════════════════════════════════════

type PopoverState = {
  barId: string;
  clientX: number;
  clientY: number;
} | null;

function WallSectionCanvas({
  detail, bars, onBarsChange,
}: {
  detail: WallDetailResponse;
  bars: EditableBar[];
  onBarsChange: (next: EditableBar[]) => void;
}) {
  const dr = detail.design_result!;
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ barId: string; sx: number; sy: number } | null>(null);
  const [popover, setPopover] = useState<PopoverState>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragPos, setDragPos] = useState<{ x_mm: number } | null>(null);
  const [snapActive, setSnapActive] = useState<{ x_mm: number } | null>(null);
  const [zoomFit, setZoomFit] = useState(1);

  // Geometría
  const lw_mm = dr.geometry.lw_m * 1000;
  const tw_mm = dr.geometry.tw_m * 1000;
  const lcL_mm = dr.reinforcement.be_left.length_m * 1000;
  const lcR_mm = dr.reinforcement.be_right.length_m * 1000;

  // Canvas
  const MARGIN_X = 60, MARGIN_TOP = 44, MARGIN_BOTTOM = 60;
  const CANVAS_W = 900;
  const drawableW = CANVAS_W - 2 * MARGIN_X;
  const baseScale = drawableW / lw_mm;
  const scale = baseScale * zoomFit;
  let sectionH = tw_mm * scale;
  // Refuerzo: mostrar sección con proporción visible aún si es muy delgada
  const minH = 60;
  if (sectionH < minH) sectionH = minH;
  const CANVAS_H = MARGIN_TOP + sectionH + MARGIN_BOTTOM;

  const y0 = MARGIN_TOP;
  const y1 = MARGIN_TOP + sectionH;
  const yMid = (y0 + y1) / 2;

  // Cover para posicionar filas de barras en BE
  const covL = dr.reinforcement.be_left.cover_mm;
  const covR = dr.reinforcement.be_right.cover_mm;
  const rowOffsetTop = Math.max(3, Math.min(sectionH * 0.2, covL * scale));
  const rowOffsetBot = Math.max(3, Math.min(sectionH * 0.2, covR * scale));

  // Convertir screen → mundo (mm)
  function screenXtoMm(clientX: number): number {
    const svg = svgRef.current;
    if (!svg) return 0;
    const rect = svg.getBoundingClientRect();
    const relX = (clientX - rect.left) * (CANVAS_W / rect.width);
    return (relX - MARGIN_X) / scale;
  }

  // Handlers ─────────────────────────────────────────────────────────────────

  function handleBarClick(e: React.MouseEvent, barId: string) {
    e.stopPropagation();
    setPopover({ barId, clientX: e.clientX, clientY: e.clientY });
  }

  function handleBarMouseDown(e: React.MouseEvent, barId: string) {
    if (e.button !== 0) return;
    e.stopPropagation();
    setDragId(barId);
    const bar = bars.find((b) => b.id === barId);
    if (bar) setDragPos({ x_mm: bar.x_m * 1000 });
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (!dragId) return;
    let x_mm = screenXtoMm(e.clientX);
    x_mm = Math.max(0, Math.min(lw_mm, x_mm));
    const before = x_mm;
    x_mm = snapX(x_mm, bars, dragId, 8, scale);
    setSnapActive(before !== x_mm ? { x_mm } : null);
    setDragPos({ x_mm });
  }

  function handleMouseUp() {
    if (dragId && dragPos) {
      onBarsChange(
        bars.map((b) => (b.id === dragId ? { ...b, x_m: dragPos.x_mm / 1000 } : b)),
      );
    }
    setDragId(null); setDragPos(null); setSnapActive(null);
  }

  function handleCanvasDblClick(e: React.MouseEvent) {
    // Doble-clic en zona vacía → agregar barra
    let x_mm = screenXtoMm(e.clientX);
    x_mm = Math.max(0, Math.min(lw_mm, x_mm));
    x_mm = snapX(x_mm, bars, undefined, 10, scale);
    const zone = classifyBar(x_mm / 1000, dr.geometry.lw_m, dr.reinforcement.be_left.length_m, dr.reinforcement.be_right.length_m);
    const db = zone === "web"
      ? dr.reinforcement.web.vert_db_mm
      : (zone === "be_left" ? dr.reinforcement.be_left.db_mm : dr.reinforcement.be_right.db_mm);
    const newBar: EditableBar = {
      id: `n${Date.now()}`,
      x_m: x_mm / 1000,
      db_mm: db,
    };
    onBarsChange([...bars, newBar]);
  }

  function updateBar(id: string, upd: Partial<EditableBar>) {
    onBarsChange(bars.map((b) => (b.id === id ? { ...b, ...upd } : b)));
  }

  function deleteBar(id: string) {
    onBarsChange(bars.filter((b) => b.id !== id));
    setPopover(null);
  }

  return (
    <div className="relative rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">
            Sección del muro — vista en planta
          </div>
          <div className="text-[10px] text-[var(--text-muted)] mt-0.5">
            Doble-clic zona vacía: agregar · Click barra: editar · Drag: mover (snap magnético)
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setZoomFit((z) => Math.min(4, z * 1.25))}
            className="rounded border border-[var(--border)] px-2 py-0.5 text-[11px] hover:bg-[var(--surface-2)]"
            title="Zoom in">+</button>
          <button
            onClick={() => setZoomFit((z) => Math.max(0.5, z / 1.25))}
            className="rounded border border-[var(--border)] px-2 py-0.5 text-[11px] hover:bg-[var(--surface-2)]"
            title="Zoom out">−</button>
          <button
            onClick={() => setZoomFit(1)}
            className="rounded border border-[var(--border)] px-2 py-0.5 text-[11px] hover:bg-[var(--surface-2)]"
            title="Ajustar">⤢</button>
        </div>
      </div>

      <div
        className="relative w-full overflow-x-auto"
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <svg
          ref={svgRef}
          viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
          className="h-auto w-full select-none"
          onDoubleClick={handleCanvasDblClick}
          style={{ minWidth: 640, cursor: dragId ? "grabbing" : "default" }}
        >
          {/* Fondo del hormigón */}
          <rect
            x={MARGIN_X} y={y0}
            width={lw_mm * scale} height={sectionH}
            fill="#e8ecf3" fillOpacity={0.4}
            stroke="none"
          />

          {/* Zonas coloreadas */}
          <rect
            x={MARGIN_X} y={y0}
            width={lcL_mm * scale} height={sectionH}
            fill={COLOR_BE_L} fillOpacity={0.16}
          />
          <rect
            x={MARGIN_X + lcL_mm * scale} y={y0}
            width={(lw_mm - lcL_mm - lcR_mm) * scale} height={sectionH}
            fill={COLOR_WEB} fillOpacity={0.14}
          />
          <rect
            x={MARGIN_X + (lw_mm - lcR_mm) * scale} y={y0}
            width={lcR_mm * scale} height={sectionH}
            fill={COLOR_BE_R} fillOpacity={0.16}
          />

          {/* Contorno del muro */}
          <rect
            x={MARGIN_X} y={y0}
            width={lw_mm * scale} height={sectionH}
            fill="none"
            stroke="var(--color-text)"
            strokeWidth={1.6}
          />

          {/* Divisiones de zonas */}
          <line
            x1={MARGIN_X + lcL_mm * scale} y1={y0}
            x2={MARGIN_X + lcL_mm * scale} y2={y1}
            stroke={COLOR_BE_L} strokeWidth={1} strokeDasharray="4 2" opacity={0.7}
          />
          <line
            x1={MARGIN_X + (lw_mm - lcR_mm) * scale} y1={y0}
            x2={MARGIN_X + (lw_mm - lcR_mm) * scale} y2={y1}
            stroke={COLOR_BE_R} strokeWidth={1} strokeDasharray="4 2" opacity={0.7}
          />

          {/* Estribos EBE (rect punteado) */}
          <rect
            x={MARGIN_X + 3} y={y0 + 3}
            width={lcL_mm * scale - 6} height={sectionH - 6}
            fill="none" stroke={COLOR_TIE} strokeWidth={1.2} strokeDasharray="3 2" opacity={0.75}
          />
          <rect
            x={MARGIN_X + (lw_mm - lcR_mm) * scale + 3} y={y0 + 3}
            width={lcR_mm * scale - 6} height={sectionH - 6}
            fill="none" stroke={COLOR_TIE} strokeWidth={1.2} strokeDasharray="3 2" opacity={0.75}
          />

          {/* Etiquetas de zona */}
          <text
            x={MARGIN_X + (lcL_mm * scale) / 2} y={y0 - 10}
            textAnchor="middle" fontSize={11} fontWeight={700}
            fill={COLOR_BE_L} fontFamily="ui-monospace, monospace"
          >BE izq. · lc={lcL_mm.toFixed(0)}</text>
          <text
            x={MARGIN_X + (lcL_mm + (lw_mm - lcL_mm - lcR_mm) / 2) * scale} y={y0 - 10}
            textAnchor="middle" fontSize={11} fontWeight={700}
            fill={COLOR_WEB} fontFamily="ui-monospace, monospace"
          >Web · {(lw_mm - lcL_mm - lcR_mm).toFixed(0)}</text>
          <text
            x={MARGIN_X + (lw_mm - lcR_mm / 2) * scale} y={y0 - 10}
            textAnchor="middle" fontSize={11} fontWeight={700}
            fill={COLOR_BE_R} fontFamily="ui-monospace, monospace"
          >BE der. · lc={lcR_mm.toFixed(0)}</text>

          {/* Barras */}
          {bars.map((b) => {
            const isDrag = dragId === b.id;
            const x_mm = isDrag && dragPos ? dragPos.x_mm : b.x_m * 1000;
            const cx = MARGIN_X + x_mm * scale;
            const zone = classifyBar(x_mm / 1000, dr.geometry.lw_m, dr.reinforcement.be_left.length_m, dr.reinforcement.be_right.length_m);
            const color = zoneColor(zone);
            const r = Math.max(4, b.db_mm * scale * 0.55);
            const isHover = hover?.barId === b.id;

            if (zone === "web") {
              // Web: 1 barra en mitad (2 cortinas se dibujan como una sola visualmente)
              return (
                <g key={b.id}>
                  {isHover && (
                    <circle cx={cx} cy={yMid} r={r * 2} fill={color} fillOpacity={0.25} />
                  )}
                  <circle
                    cx={cx} cy={yMid} r={r}
                    fill={color} stroke="#000" strokeWidth={0.8} strokeOpacity={0.65}
                    onMouseEnter={(e) => setHover({ barId: b.id, sx: e.clientX, sy: e.clientY })}
                    onMouseLeave={() => setHover(null)}
                    onClick={(e) => handleBarClick(e, b.id)}
                    onMouseDown={(e) => handleBarMouseDown(e, b.id)}
                    style={{ cursor: "pointer" }}
                  />
                </g>
              );
            }
            // BE: dos filas (arriba y abajo)
            return (
              <g key={b.id}>
                {isHover && (
                  <>
                    <circle cx={cx} cy={y0 + rowOffsetTop} r={r * 2} fill={color} fillOpacity={0.25} />
                    <circle cx={cx} cy={y1 - rowOffsetBot} r={r * 2} fill={color} fillOpacity={0.25} />
                  </>
                )}
                <circle
                  cx={cx} cy={y0 + rowOffsetTop} r={r}
                  fill={color} stroke="#000" strokeWidth={0.8} strokeOpacity={0.65}
                  onMouseEnter={(e) => setHover({ barId: b.id, sx: e.clientX, sy: e.clientY })}
                  onMouseLeave={() => setHover(null)}
                  onClick={(e) => handleBarClick(e, b.id)}
                  onMouseDown={(e) => handleBarMouseDown(e, b.id)}
                  style={{ cursor: "pointer" }}
                />
                <circle
                  cx={cx} cy={y1 - rowOffsetBot} r={r}
                  fill={color} stroke="#000" strokeWidth={0.8} strokeOpacity={0.65}
                  onMouseEnter={(e) => setHover({ barId: b.id, sx: e.clientX, sy: e.clientY })}
                  onMouseLeave={() => setHover(null)}
                  onClick={(e) => handleBarClick(e, b.id)}
                  onMouseDown={(e) => handleBarMouseDown(e, b.id)}
                  style={{ cursor: "pointer" }}
                />
              </g>
            );
          })}

          {/* Snap guide */}
          {snapActive && dragId && (
            <line
              x1={MARGIN_X + snapActive.x_mm * scale} y1={y0 - 20}
              x2={MARGIN_X + snapActive.x_mm * scale} y2={y1 + 20}
              stroke={COLOR_TIE} strokeWidth={1.2} strokeDasharray="5 3" opacity={0.85}
            />
          )}

          {/* Cotas abajo */}
          <DimLine
            x1={MARGIN_X} x2={MARGIN_X + lw_mm * scale}
            y={y1 + 30} label={`lw = ${lw_mm.toFixed(0)} mm`}
          />
          {/* Espesor a la derecha */}
          <ThickTick
            x={MARGIN_X + lw_mm * scale + 6} y1={y0} y2={y1}
            label={`tw = ${tw_mm.toFixed(0)} mm`}
          />
        </svg>

        {/* Tooltip flotante */}
        {hover && !dragId && !popover && (
          <BarTooltip
            bar={bars.find((b) => b.id === hover.barId)!}
            dr={dr}
            sx={hover.sx} sy={hover.sy}
          />
        )}
      </div>

      {/* Popover contextual */}
      {popover && (
        <BarPopover
          bar={bars.find((b) => b.id === popover.barId)!}
          lw_mm={lw_mm}
          onUpdate={(upd) => updateBar(popover.barId, upd)}
          onDelete={() => deleteBar(popover.barId)}
          onClose={() => setPopover(null)}
          anchorX={popover.clientX} anchorY={popover.clientY}
        />
      )}
    </div>
  );
}

// ── DimLine / ThickTick ──────────────────────────────────────────────────────

function DimLine({ x1, x2, y, label }: { x1: number; x2: number; y: number; label: string }) {
  const s = "var(--color-text-muted, #666)";
  return (
    <g pointerEvents="none">
      <line x1={x1} y1={y} x2={x2} y2={y} stroke={s} strokeWidth={1} />
      <line x1={x1} y1={y - 5} x2={x1} y2={y + 5} stroke={s} strokeWidth={1.5} />
      <line x1={x2} y1={y - 5} x2={x2} y2={y + 5} stroke={s} strokeWidth={1.5} />
      <text x={(x1 + x2) / 2} y={y + 16} textAnchor="middle" fontSize={11}
            fontFamily="ui-monospace, monospace" fill={s}>{label}</text>
    </g>
  );
}

function ThickTick({ x, y1, y2, label }: { x: number; y1: number; y2: number; label: string }) {
  const s = "var(--color-text-muted, #666)";
  return (
    <g pointerEvents="none">
      <line x1={x} y1={y1} x2={x} y2={y2} stroke={s} strokeWidth={1} />
      <line x1={x - 5} y1={y1} x2={x + 5} y2={y1} stroke={s} strokeWidth={1.5} />
      <line x1={x - 5} y1={y2} x2={x + 5} y2={y2} stroke={s} strokeWidth={1.5} />
      <text x={x + 9} y={(y1 + y2) / 2 + 3} fontSize={11}
            fontFamily="ui-monospace, monospace" fill={s}>{label}</text>
    </g>
  );
}

// ── Tooltip flotante ─────────────────────────────────────────────────────────

function BarTooltip({
  bar, dr, sx, sy,
}: {
  bar: EditableBar; dr: WallDesignResult; sx: number; sy: number;
}) {
  const zone = classifyBar(bar.x_m, dr.geometry.lw_m, dr.reinforcement.be_left.length_m, dr.reinforcement.be_right.length_m);
  const As = areaFromDb(bar.db_mm);
  return (
    <div
      className="pointer-events-none fixed z-40 rounded-lg border border-[var(--border)] bg-[var(--surface)]/95 px-3 py-2 shadow-xl backdrop-blur-sm"
      style={{ left: sx + 14, top: sy + 14 }}
    >
      <div className="mb-1 flex items-center gap-2 border-b border-[var(--border)] pb-1">
        <span className="h-2 w-2 rounded-full" style={{ background: zoneColor(zone) }} />
        <span className="text-[11px] font-bold text-[var(--text)]">
          Barra · {zoneLabel(zone)}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10.5px] font-mono text-[var(--text-muted)]">
        <span>x:</span>   <span className="text-[var(--text)]">{(bar.x_m * 1000).toFixed(1)} mm</span>
        <span>bar:</span> <span className="text-[var(--text)]">{barName(bar.db_mm)}</span>
        <span>As:</span>  <span className="text-[var(--text)]">{As.toFixed(0)} mm²</span>
      </div>
      <p className="mt-1 border-t border-[var(--border)] pt-1 text-[9.5px] italic text-[var(--text-muted)]">
        Click para editar · Drag para mover
      </p>
    </div>
  );
}

// ── Popover contextual ───────────────────────────────────────────────────────

function BarPopover({
  bar, lw_mm, onUpdate, onDelete, onClose, anchorX, anchorY,
}: {
  bar: EditableBar; lw_mm: number;
  onUpdate: (upd: Partial<EditableBar>) => void;
  onDelete: () => void;
  onClose: () => void;
  anchorX: number; anchorY: number;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("[data-popover-root]")) return;
      onClose();
    };
    // Espera un tick para no cerrar por el mismo click que abrió
    const t = setTimeout(() => window.addEventListener("mousedown", h), 50);
    return () => { clearTimeout(t); window.removeEventListener("mousedown", h); };
  }, [onClose]);

  const As = areaFromDb(bar.db_mm);

  return (
    <div
      data-popover-root
      className="fixed z-50 w-64 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl"
      style={{
        left: Math.min(anchorX + 12, window.innerWidth - 280),
        top: Math.min(anchorY + 12, window.innerHeight - 280),
        animation: "pl-fade-up 0.15s ease-out both",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
        <span className="text-[11px] font-bold text-[var(--text)]">Editar barra</span>
        <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text)] text-sm">✕</button>
      </div>
      <div className="space-y-3 p-3">
        <div>
          <label className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">
            Posición x (mm)
          </label>
          <input
            type="number"
            value={Math.round(bar.x_m * 1000)}
            step={5}
            min={0}
            max={Math.round(lw_mm)}
            onChange={(e) => onUpdate({ x_m: Number.parseFloat(e.target.value) / 1000 })}
            className="mt-0.5 w-full rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 font-mono text-xs"
          />
        </div>
        <div>
          <label className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">
            Barra
          </label>
          <div className="mt-1 flex flex-wrap gap-1">
            {BAR_DIAMETERS_MM.map((d) => (
              <button
                key={d}
                onClick={() => onUpdate({ db_mm: d })}
                className={`rounded border px-1.5 py-0.5 font-mono text-[10.5px] transition-colors ${
                  Math.abs(bar.db_mm - d) < 0.1
                    ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                    : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--accent)]/50 hover:text-[var(--text)]"
                }`}
              >{barName(d)}</button>
            ))}
          </div>
        </div>
        <div className="rounded-md bg-[var(--surface-2)] px-2 py-1.5 text-[10.5px] font-mono text-[var(--text-muted)]">
          As = <span className="text-[var(--text)]">{As.toFixed(0)} mm²</span>
        </div>
        <button
          onClick={onDelete}
          className="w-full rounded-md border border-red-500/30 bg-red-500/10 py-1.5 text-[11px] font-semibold text-red-500 hover:bg-red-500/20"
        >Eliminar barra</button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Panel derecho — Tabs: Refuerzo · P-M · Checks · OpenSees
// ═══════════════════════════════════════════════════════════════════════════

type RightTab = "reinf" | "pm" | "checks" | "opensees";

function RightPanel({
  detail, ratios, bars,
}: {
  detail: WallDetailResponse;
  ratios: ReturnType<typeof liveRatios> | null;
  bars: EditableBar[];
}) {
  const [tab, setTab] = useState<RightTab>("reinf");
  const dr = detail.design_result;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)]">
      {/* Tabs header */}
      <div className="flex gap-0.5 border-b border-[var(--border)] bg-[var(--surface-2)]/50 p-1">
        {([
          ["reinf", "Refuerzo"],
          ["pm", "P-M"],
          ["checks", "Checks"],
          ["opensees", "OpenSees"],
        ] as const).map(([k, l]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`flex-1 rounded-md px-2 py-1.5 text-[11px] font-semibold transition-colors ${
              tab === k
                ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
                : "text-[var(--text-muted)] hover:text-[var(--text)]"
            }`}
          >{l}</button>
        ))}
      </div>

      <div className="p-3">
        {tab === "reinf"    && dr && ratios && <ReinforcementSummary dr={dr} ratios={ratios} bars={bars} />}
        {tab === "pm"       && dr && <PMPanel dr={dr} />}
        {tab === "checks"   && dr && <ChecksList checks={dr.checks} />}
        {tab === "opensees" && <OpenSeesPreview detail={detail} />}
        {!dr && (tab === "reinf" || tab === "pm" || tab === "checks") && (
          <p className="py-6 text-center text-xs text-[var(--text-muted)]">
            Sin diseño disponible.
          </p>
        )}
      </div>
    </div>
  );
}

// ── Refuerzo (tab derecho) ───────────────────────────────────────────────────

function ReinforcementSummary({
  dr, ratios, bars,
}: {
  dr: WallDesignResult;
  ratios: NonNullable<ReturnType<typeof liveRatios>>;
  bars: EditableBar[];
}) {
  const r = dr.reinforcement;

  const barsOriginal = barsFromDesign(dr);
  const originalRatios = liveRatios(barsOriginal, dr);

  return (
    <div className="space-y-3">
      {/* Cuantías vivas con Δ */}
      <ZoneRatioCard
        title="BE izquierdo"
        color={COLOR_BE_L}
        rho_v={ratios.rho_v_be_L}
        rho_v_orig={originalRatios.rho_v_be_L}
        n_bars={ratios.n_be_L}
        n_bars_orig={originalRatios.n_be_L}
        As={ratios.As_be_L}
        details={<BEDetails z={r.be_left} />}
      />
      <ZoneRatioCard
        title="Alma (web)"
        color={COLOR_WEB}
        rho_v={ratios.rho_v_web}
        rho_v_orig={originalRatios.rho_v_web}
        n_bars={ratios.n_web}
        n_bars_orig={originalRatios.n_web}
        As={ratios.As_web}
        details={<WebDetails z={r.web} />}
      />
      <ZoneRatioCard
        title="BE derecho"
        color={COLOR_BE_R}
        rho_v={ratios.rho_v_be_R}
        rho_v_orig={originalRatios.rho_v_be_R}
        n_bars={ratios.n_be_R}
        n_bars_orig={originalRatios.n_be_R}
        As={ratios.As_be_R}
        details={<BEDetails z={r.be_right} />}
      />

      {/* Resumen NSR-10 boundary element + confinamiento */}
      <div className="rounded-md border border-[var(--border)] bg-[var(--surface-2)]/40 p-2 text-[10.5px]">
        <div className="mb-1 font-bold uppercase tracking-wider text-[var(--text-muted)]">EBE (18.10.6)</div>
        <KV label="Requerido" value={dr.boundary_element.required ? "Sí" : "No"} strong />
        <KV label="c" value={`${(dr.boundary_element.c_m * 1000).toFixed(0)} mm`} />
        <KV label="lc" value={`${(dr.boundary_element.lc_m * 1000).toFixed(0)} mm`} strong />
        {dr.boundary_element.sigma_max_mpa > 0 && (
          <KV label="σ/σ_lim" value={`${dr.boundary_element.sigma_max_mpa.toFixed(2)}/${dr.boundary_element.threshold_mpa.toFixed(2)} MPa`} />
        )}
      </div>

      <p className="text-[10px] text-[var(--text-muted)] italic">
        {bars.length} barras totales. Δ vs auto-diseño mostrado en badge.
      </p>
    </div>
  );
}

function ZoneRatioCard({
  title, color, rho_v, rho_v_orig, n_bars, n_bars_orig, As, details,
}: {
  title: string;
  color: string;
  rho_v: number;
  rho_v_orig: number;
  n_bars: number;
  n_bars_orig: number;
  As: number;
  details: React.ReactNode;
}) {
  const drho = rho_v - rho_v_orig;
  const dn = n_bars - n_bars_orig;
  return (
    <div className="rounded-md border-l-[3px] bg-[var(--surface-2)]/50 px-2.5 py-2" style={{ borderLeftColor: color }}>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-bold" style={{ color }}>{title}</span>
        <span className="font-mono text-[10.5px] text-[var(--text-muted)]">
          {n_bars} barras {dn !== 0 && <span className={dn > 0 ? "text-emerald-500" : "text-amber-500"}>({dn > 0 ? "+" : ""}{dn})</span>}
        </span>
      </div>
      <div className="mb-1 grid grid-cols-2 gap-x-2 text-[10.5px]">
        <span className="text-[var(--text-muted)]">ρᵥ (vivo)</span>
        <span className="text-right font-mono font-semibold text-[var(--text)]">
          {(rho_v * 100).toFixed(3)}%
          {Math.abs(drho) > 1e-5 && (
            <span className={`ml-1 text-[9.5px] ${drho >= 0 ? "text-emerald-500" : "text-amber-500"}`}>
              ({drho >= 0 ? "+" : ""}{(drho * 100).toFixed(3)}%)
            </span>
          )}
        </span>
        <span className="text-[var(--text-muted)]">As</span>
        <span className="text-right font-mono text-[var(--text)]">{As.toFixed(0)} mm²</span>
      </div>
      <div className="mt-1 border-t border-[var(--border)] pt-1 text-[10px]">
        {details}
      </div>
    </div>
  );
}

function BEDetails({ z }: { z: BoundaryZoneDesign }) {
  if (z.n_bars <= 0 || z.length_m <= 0) {
    return (
      <span className="italic text-[var(--text-muted)]">
        Sin EBE — refuerzo distribuido en todo el muro
      </span>
    );
  }
  return (
    <>
      <KV label="lc" value={`${(z.length_m * 1000).toFixed(0)} mm`} />
      <KV label="barras" value={`${z.n_bars}${barName(z.db_mm)}`} />
      <KV label="cover" value={`${z.cover_mm} mm`} />
      <KV label="ties" value={`${barName(z.tie_db_mm)} @ ${z.tie_spacing_mm} mm`} />
    </>
  );
}

function WebDetails({ z }: { z: WebZoneDesign }) {
  return (
    <>
      <KV label="v." value={`${barName(z.vert_db_mm)}@${z.vert_spacing_mm}`} />
      <KV label="h." value={`${barName(z.horiz_db_mm)}@${z.horiz_spacing_mm}`} />
      <KV label="cortinas" value={String(z.n_curtains)} />
      <KV label="ρₕ" value={`${(z.rho_h * 100).toFixed(3)}%`} />
    </>
  );
}

function KV({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="grid grid-cols-[1fr_auto] gap-2 text-[10.5px]">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span className={`font-mono ${strong ? "font-semibold" : ""} text-[var(--text)]`}>{value}</span>
    </div>
  );
}

// ── P-M panel (Plotly desde CDN) ─────────────────────────────────────────────

function PMPanel({ dr }: { dr: WallDesignResult }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current || typeof window === "undefined" || !window.Plotly) return;
    const Plotly = window.Plotly;
    const d = dr.interaction;
    const traces = [
      {
        x: d.phiMn_kNm,
        y: d.phiPn_kN,
        type: "scatter", mode: "lines",
        line: { color: "#3b82f6", width: 2 },
        name: "φPn - φMn",
        hovertemplate: "M=%{x:.1f} kN·m<br>P=%{y:.1f} kN<extra></extra>",
      },
      {
        x: d.Mn_kNm,
        y: d.Pn_kN,
        type: "scatter", mode: "lines",
        line: { color: "#94a3b8", width: 1, dash: "dot" },
        name: "Pn - Mn",
        hovertemplate: "M=%{x:.1f}<br>P=%{y:.1f}<extra></extra>",
      },
      {
        x: dr.demand_points.map((p) => Math.abs(p.Mu_kNm)),
        y: dr.demand_points.map((p) => p.Pu_kN),
        type: "scatter", mode: "markers+text",
        marker: {
          size: 9,
          color: dr.demand_points.map((p) => (p.inside ? "#10b981" : "#ef4444")),
          symbol: dr.demand_points.map((p) => (p.is_seismic ? "diamond" : "circle")),
          line: { color: "#000", width: 0.5 },
        },
        text: dr.demand_points.map((p) => p.label),
        textposition: "top right",
        textfont: { size: 9, color: "#64748b" },
        name: "Demandas",
        hovertemplate: "%{text}<br>Mu=%{x:.1f} kN·m<br>Pu=%{y:.1f} kN<extra></extra>",
      },
    ];
    Plotly.newPlot(ref.current, traces, {
      paper_bgcolor: "transparent", plot_bgcolor: "transparent",
      font: { size: 10 },
      margin: { t: 10, r: 10, b: 40, l: 50 },
      xaxis: { title: { text: "M (kN·m)", font: { size: 10 } }, gridcolor: "rgba(120,130,160,0.15)" },
      yaxis: { title: { text: "P (kN)",   font: { size: 10 } }, gridcolor: "rgba(120,130,160,0.15)" },
      legend: { orientation: "h", y: -0.28, font: { size: 9 } },
      showlegend: true,
    }, { displayModeBar: false, responsive: true });
    return () => {
      if (ref.current) try { Plotly.purge(ref.current); } catch {/* ignore */}
    };
  }, [dr]);

  return (
    <div>
      <div ref={ref} style={{ width: "100%", height: 260 }} />
      <div className="mt-2 grid grid-cols-2 gap-2 text-[10.5px]">
        <div className="rounded bg-[var(--surface-2)] px-2 py-1">
          <span className="text-[var(--text-muted)]">Gobernante:</span>{" "}
          <span className="font-mono text-[var(--text)]">{dr.governing_combo}</span>
        </div>
        <div className="rounded bg-[var(--surface-2)] px-2 py-1">
          <span className="text-[var(--text-muted)]">φMn:</span>{" "}
          <span className="font-mono text-[var(--text)]">{dr.summary.phi_Mn_kNm.toFixed(0)} kN·m</span>
        </div>
      </div>
      <p className="mt-2 text-[10px] italic text-[var(--text-muted)]">
        La curva se recalcula al guardar cambios (POST /walls/…/design).
      </p>
    </div>
  );
}

// ── Checks list ──────────────────────────────────────────────────────────────

function ChecksList({ checks }: { checks: WallCodeCheck[] }) {
  if (!checks || checks.length === 0) {
    return <p className="py-4 text-center text-xs text-[var(--text-muted)]">Sin verificaciones.</p>;
  }
  return (
    <div className="space-y-1.5">
      {checks.map((c, i) => (
        <div
          key={i}
          className="rounded-md border border-[var(--border)] bg-[var(--surface-2)]/40 p-2 text-[10.5px]"
          style={c.ok ? undefined : { borderColor: "rgba(239,68,68,0.35)", background: "rgba(239,68,68,0.05)" }}
        >
          <div className="mb-0.5 flex items-center justify-between">
            <span className="font-mono text-[9.5px] text-[var(--text-muted)]">{c.article}</span>
            <span className="font-mono font-bold" style={{ color: c.ok ? "#10b981" : "#ef4444" }}>
              {c.ok ? "✓" : "✗"} DCR={c.dcr.toFixed(2)}
            </span>
          </div>
          <div className="text-[var(--text)]">{c.description}</div>
          <div className="mt-0.5 grid grid-cols-2 gap-2 font-mono text-[10px] text-[var(--text-muted)]">
            <span>Dem: {fmt(c.demand)} {c.unit}</span>
            <span>Cap: {fmt(c.capacity)} {c.unit}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── OpenSees preview ─────────────────────────────────────────────────────────

function OpenSeesPreview({ detail }: { detail: WallDetailResponse }) {
  const ops = detail.opensees;
  if (!ops) {
    return (
      <p className="py-6 text-center text-xs text-[var(--text-muted)]">
        Configura el modelo analítico para ver el mapeo OpenSees.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <div>
        <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">Nodos</div>
        <div className="grid grid-cols-2 gap-1 text-[10.5px]">
          {(["i","j","k","l"] as const).map((n) => (
            <div key={n} className="rounded bg-[var(--surface-2)] px-2 py-1">
              <span className="text-[var(--text-muted)]">{n}:</span>{" "}
              <span className="font-mono text-[var(--text)]">{ops.node_ids[n]}</span>{" "}
              <span className="text-[var(--text-muted)]">→</span>{" "}
              <span className="font-mono">{ops.node_tags[n]}</span>
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">
          Materiales ({ops.material_lines.length})
        </div>
        <pre className="max-h-[160px] overflow-auto rounded-md bg-[var(--surface-2)] p-2 text-[10px] font-mono">
{ops.material_lines.join("\n")}
        </pre>
      </div>
      <div>
        <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">
          Elemento (tag {ops.ele_tag})
        </div>
        <pre className="overflow-auto rounded-md bg-[var(--surface-2)] p-2 text-[10px] font-mono">
{ops.element_line}
        </pre>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Compare modal
// ═══════════════════════════════════════════════════════════════════════════

function CompareModal({
  projectId, currentDetail, siblings, onClose,
}: {
  projectId: string;
  currentDetail: WallDetailResponse;
  siblings: WallListItem[];
  onClose: () => void;
}) {
  const otherLabel = useMemo(() => {
    const idx = siblings.findIndex((w) => w.label === currentDetail.label);
    if (idx < 0) return null;
    if (idx + 1 < siblings.length) return siblings[idx + 1].label;
    if (idx - 1 >= 0) return siblings[idx - 1].label;
    return null;
  }, [siblings, currentDetail.label]);

  const [other, setOther] = useState<WallDetailResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selectedLabel, setSelectedLabel] = useState<string | null>(otherLabel);

  useEffect(() => {
    if (!selectedLabel) return;
    setErr(null); setOther(null);
    fetchWallDetail(projectId, selectedLabel)
      .then(setOther)
      .catch((e) => setErr(String(e)));
  }, [projectId, selectedLabel]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-6xl overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">
              Comparación side-by-side
            </div>
            <h2 className="text-lg font-bold">
              {currentDetail.label} ↔ {selectedLabel ?? "…"}
            </h2>
          </div>
          <div className="flex items-center gap-3">
            <select
              value={selectedLabel ?? ""}
              onChange={(e) => setSelectedLabel(e.target.value)}
              className="rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-xs font-mono"
            >
              {siblings.filter((s) => s.label !== currentDetail.label).map((s) => (
                <option key={s.label} value={s.label}>{s.source_story} · {s.label}</option>
              ))}
            </select>
            <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text)]">✕</button>
          </div>
        </div>

        {err && (
          <div className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">
            {err}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <CompareCell label="Actual" detail={currentDetail} />
          {other
            ? <CompareCell label="Vecino" detail={other} />
            : <div className="rounded-xl border border-dashed border-[var(--border)] p-10 text-center text-xs text-[var(--text-muted)]">Cargando…</div>}
        </div>

        {other && (
          <DiffPanel a={currentDetail} b={other} />
        )}
      </div>
    </div>
  );
}

function CompareCell({ label, detail }: { label: string; detail: WallDetailResponse }) {
  const dr = detail.design_result;
  if (!dr) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4 text-xs text-[var(--text-muted)]">
        {label}: sin diseño
      </div>
    );
  }
  const bars = barsFromDesign(dr);
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/30 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">{label}</span>
        <span className="font-mono text-[11px] text-[var(--text)]">{detail.label}</span>
      </div>
      <MiniSectionSVG dr={dr} bars={bars} />
      <div className="mt-2 grid grid-cols-2 gap-1.5 text-[10.5px]">
        <KV label="BE izq." value={dr.reinforcement.be_left.n_bars > 0
          ? `${dr.reinforcement.be_left.n_bars}${barName(dr.reinforcement.be_left.db_mm)}`
          : "—"} />
        <KV label="BE der." value={dr.reinforcement.be_right.n_bars > 0
          ? `${dr.reinforcement.be_right.n_bars}${barName(dr.reinforcement.be_right.db_mm)}`
          : "—"} />
        <KV label="Web v." value={`${barName(dr.reinforcement.web.vert_db_mm)}@${dr.reinforcement.web.vert_spacing_mm}`} />
        <KV label="Web h." value={`${barName(dr.reinforcement.web.horiz_db_mm)}@${dr.reinforcement.web.horiz_spacing_mm}`} />
        <KV label="φMn" value={`${dr.summary.phi_Mn_kNm.toFixed(0)} kNm`} />
        <KV label="φVn" value={`${dr.summary.phi_Vn_kN.toFixed(0)} kN`} />
      </div>
    </div>
  );
}

function MiniSectionSVG({ dr, bars }: { dr: WallDesignResult; bars: EditableBar[] }) {
  const lw_mm = dr.geometry.lw_m * 1000;
  const tw_mm = dr.geometry.tw_m * 1000;
  const lcL = dr.reinforcement.be_left.length_m * 1000;
  const lcR = dr.reinforcement.be_right.length_m * 1000;
  const CANVAS_W = 500;
  const MARGIN = 16;
  const scale = (CANVAS_W - 2 * MARGIN) / lw_mm;
  const H = Math.max(40, tw_mm * scale);
  const CANVAS_H = H + 2 * MARGIN;

  return (
    <svg viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`} className="h-auto w-full">
      <rect x={MARGIN} y={MARGIN} width={lw_mm * scale} height={H} fill="#e8ecf3" fillOpacity={0.4} />
      <rect x={MARGIN} y={MARGIN} width={lcL * scale} height={H} fill={COLOR_BE_L} fillOpacity={0.18} />
      <rect x={MARGIN + (lw_mm - lcR) * scale} y={MARGIN} width={lcR * scale} height={H} fill={COLOR_BE_R} fillOpacity={0.18} />
      <rect x={MARGIN} y={MARGIN} width={lw_mm * scale} height={H} fill="none" stroke="var(--color-text)" strokeWidth={1} />
      {bars.map((b, i) => {
        const zone = classifyBar(b.x_m, dr.geometry.lw_m, dr.reinforcement.be_left.length_m, dr.reinforcement.be_right.length_m);
        const color = zoneColor(zone);
        const cx = MARGIN + b.x_m * 1000 * scale;
        if (zone === "web") {
          return <circle key={i} cx={cx} cy={MARGIN + H / 2} r={Math.max(2.5, b.db_mm * scale * 0.4)} fill={color} />;
        }
        return (
          <g key={i}>
            <circle cx={cx} cy={MARGIN + Math.min(H * 0.25, 12)} r={Math.max(2.5, b.db_mm * scale * 0.4)} fill={color} />
            <circle cx={cx} cy={MARGIN + H - Math.min(H * 0.25, 12)} r={Math.max(2.5, b.db_mm * scale * 0.4)} fill={color} />
          </g>
        );
      })}
    </svg>
  );
}

function DiffPanel({ a, b }: { a: WallDetailResponse; b: WallDetailResponse }) {
  if (!a.design_result || !b.design_result) return null;
  const A = a.design_result, B = b.design_result;
  const rows: { label: string; a: string; b: string; hi?: boolean }[] = [
    { label: "BE izq. barras",
      a: A.reinforcement.be_left.n_bars > 0 ? `${A.reinforcement.be_left.n_bars}${barName(A.reinforcement.be_left.db_mm)}` : "sin EBE",
      b: B.reinforcement.be_left.n_bars > 0 ? `${B.reinforcement.be_left.n_bars}${barName(B.reinforcement.be_left.db_mm)}` : "sin EBE",
      hi: A.reinforcement.be_left.n_bars !== B.reinforcement.be_left.n_bars || Math.abs(A.reinforcement.be_left.db_mm - B.reinforcement.be_left.db_mm) > 0.1 },
    { label: "BE der. barras",
      a: A.reinforcement.be_right.n_bars > 0 ? `${A.reinforcement.be_right.n_bars}${barName(A.reinforcement.be_right.db_mm)}` : "sin EBE",
      b: B.reinforcement.be_right.n_bars > 0 ? `${B.reinforcement.be_right.n_bars}${barName(B.reinforcement.be_right.db_mm)}` : "sin EBE",
      hi: A.reinforcement.be_right.n_bars !== B.reinforcement.be_right.n_bars || Math.abs(A.reinforcement.be_right.db_mm - B.reinforcement.be_right.db_mm) > 0.1 },
    { label: "Web vert.", a: `${barName(A.reinforcement.web.vert_db_mm)}@${A.reinforcement.web.vert_spacing_mm}`,
      b: `${barName(B.reinforcement.web.vert_db_mm)}@${B.reinforcement.web.vert_spacing_mm}`,
      hi: A.reinforcement.web.vert_db_mm !== B.reinforcement.web.vert_db_mm || A.reinforcement.web.vert_spacing_mm !== B.reinforcement.web.vert_spacing_mm },
    { label: "Web horiz.", a: `${barName(A.reinforcement.web.horiz_db_mm)}@${A.reinforcement.web.horiz_spacing_mm}`,
      b: `${barName(B.reinforcement.web.horiz_db_mm)}@${B.reinforcement.web.horiz_spacing_mm}`,
      hi: A.reinforcement.web.horiz_db_mm !== B.reinforcement.web.horiz_db_mm || A.reinforcement.web.horiz_spacing_mm !== B.reinforcement.web.horiz_spacing_mm },
    { label: "EBE requerido", a: A.boundary_element.required ? "Sí" : "No", b: B.boundary_element.required ? "Sí" : "No",
      hi: A.boundary_element.required !== B.boundary_element.required },
    { label: "φMn (kN·m)", a: A.summary.phi_Mn_kNm.toFixed(0), b: B.summary.phi_Mn_kNm.toFixed(0),
      hi: Math.abs(A.summary.phi_Mn_kNm - B.summary.phi_Mn_kNm) / Math.max(1, A.summary.phi_Mn_kNm) > 0.05 },
    { label: "φVn (kN)", a: A.summary.phi_Vn_kN.toFixed(0), b: B.summary.phi_Vn_kN.toFixed(0),
      hi: Math.abs(A.summary.phi_Vn_kN - B.summary.phi_Vn_kN) / Math.max(1, A.summary.phi_Vn_kN) > 0.05 },
    { label: "Cumple", a: A.ok ? "✓" : "✗", b: B.ok ? "✓" : "✗", hi: A.ok !== B.ok },
  ];

  return (
    <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/30 p-3">
      <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">
        Diferencias
      </div>
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-[var(--text-muted)]">
            <th className="text-left">Campo</th>
            <th className="text-right">{a.label}</th>
            <th className="text-right">{b.label}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-[var(--border)]" style={r.hi ? { background: "rgba(245,158,11,0.08)" } : undefined}>
              <td className="py-1">{r.label}</td>
              <td className="py-1 text-right font-mono">{r.a}</td>
              <td className="py-1 text-right font-mono" style={r.hi ? { fontWeight: 600, color: "#f59e0b" } : undefined}>{r.b}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── utils ────────────────────────────────────────────────────────────────────

function fmt(v: number): string {
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 1)   return v.toFixed(2);
  return v.toFixed(4);
}
