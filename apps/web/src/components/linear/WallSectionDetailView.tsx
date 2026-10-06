"use client";

import { useMemo, useState } from "react";
import type {
  WallDetailResponse,
  MacroFiberRegion,
  WallDesignResult,
  WallManualReinf,
} from "@/lib/wall-types";
import { redesignWall } from "@/lib/wall-api";

// ── Layout constants ─────────────────────────────────────────────────────────

const REGION_COLOR: Record<MacroFiberRegion, string> = {
  boundary_left:  "#3b7dd8",
  web:            "#4a9e5c",
  boundary_right: "#c06030",
};

const REGION_LABEL: Record<MacroFiberRegion, string> = {
  boundary_left:  "Boundary izq.",
  web:            "Alma (web)",
  boundary_right: "Boundary der.",
};

type TabKey = "seccion" | "refuerzo" | "discretizacion" | "opensees";

const TABS: { key: TabKey; label: string; desc: string }[] = [
  { key: "seccion",        label: "Sección",        desc: "Geometría y zonas" },
  { key: "refuerzo",       label: "Refuerzo",       desc: "Diseño propuesto NSR-10" },
  { key: "discretizacion", label: "Discretización", desc: "Macrofibras MVLEM_3D" },
  { key: "opensees",       label: "OpenSees",       desc: "Mapeo del elemento" },
];

interface Props {
  detail:    WallDetailResponse;
  projectId: string;
  onReload:  () => void;
}

// ── Root ─────────────────────────────────────────────────────────────────────

export default function WallSectionDetailView({ detail, projectId, onReload }: Props) {
  const [tab, setTab] = useState<TabKey>(detail.design_result ? "refuerzo" : "seccion");

  return (
    <div className="space-y-4">
      <HeaderCard detail={detail} />

      <div className="flex gap-0.5 rounded-lg bg-[var(--surface-2)] p-1">
        {TABS.map(t => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className="flex-1 rounded-md px-3 py-2 text-left transition-colors"
            style={tab === t.key
              ? { background: "var(--color-surface)", boxShadow: "0 1px 3px rgba(0,0,0,.08)" }
              : { color: "var(--color-text-muted)" }}
          >
            <div className="text-[13px] font-semibold"
                 style={{ color: tab === t.key ? "var(--color-text)" : "inherit" }}>
              {t.label}
            </div>
            <div className="text-[10.5px] mt-0.5" style={{ color: "var(--color-text-muted)" }}>
              {t.desc}
            </div>
          </button>
        ))}
      </div>

      {tab === "seccion"        && <SectionTab        detail={detail} />}
      {tab === "refuerzo"       && <ReinforcementTab  detail={detail} projectId={projectId} onReload={onReload} />}
      {tab === "discretizacion" && <DiscretizationTab detail={detail} />}
      {tab === "opensees"       && <OpenSeesTab       detail={detail} />}
    </div>
  );
}

// ── Header ───────────────────────────────────────────────────────────────────

function HeaderCard({ detail }: { detail: WallDetailResponse }) {
  const g  = detail.geometry;
  const f  = detail.formulation_info;
  const dr = detail.design_result;
  const a  = detail.analytical;
  const pier  = a?.source_pier;
  const story = a?.source_story;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-[10.5px] font-bold uppercase tracking-[.1em] text-[var(--text-muted)]">
            Detalle de muro
          </div>
          <h1 className="mt-0.5 text-xl font-semibold text-[var(--text)]">{detail.label}</h1>
          {(pier || story) && (
            <div className="mt-1 text-xs text-[var(--text-muted)]">
              {pier && <>Pier <span className="font-mono font-medium">{pier}</span></>}
              {pier && story && " · "}
              {story && <>Story <span className="font-mono font-medium">{story}</span></>}
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2 items-center">
          {dr && <DesignStatusBadge result={dr} />}
          {f && (
            <div className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Formulación</div>
              <div className="text-sm font-mono font-semibold text-[var(--text)]">{f.label}</div>
            </div>
          )}
        </div>
      </div>

      {g && (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
          <Stat label="Longitud"   value={`${(g.total_length_m * 1000).toFixed(0)} mm`} />
          <Stat label="Espesor"    value={`${(g.thickness_m   * 1000).toFixed(0)} mm`} />
          <Stat label="Boundary L" value={`${(g.boundary_left_m  * 1000).toFixed(0)} mm`} color={REGION_COLOR.boundary_left} />
          <Stat label="Web"        value={`${(g.web_m            * 1000).toFixed(0)} mm`} color={REGION_COLOR.web} />
          <Stat label="Boundary R" value={`${(g.boundary_right_m * 1000).toFixed(0)} mm`} color={REGION_COLOR.boundary_right} />
        </div>
      )}

      {!detail.has_analytical && !dr && (
        <div className="mt-3 rounded-md bg-amber-500/10 border border-amber-500/20 px-3 py-2 text-xs text-amber-500">
          Este muro aún no tiene diseño ni modelo analítico. Corre &ldquo;Diseñar todos los muros&rdquo; desde la pestaña de muros del proyecto.
        </div>
      )}
    </div>
  );
}

function DesignStatusBadge({ result }: { result: WallDesignResult }) {
  const okAll   = result.ok;
  const failed  = result.summary?.failed_checks ?? 0;
  const ebeReq  = result.summary?.ebe_required;

  const bg = okAll ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-500"
                   : "bg-red-500/10 border-red-500/30 text-red-500";
  return (
    <div className={`rounded-md border px-3 py-1.5 ${bg}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wider">
        Diseño {result.ductility}
      </div>
      <div className="text-sm font-semibold">
        {okAll ? "✓ Cumple" : `✗ ${failed} check(s) fallan`}
        {ebeReq && <span className="ml-1 opacity-75">· EBE</span>}
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-md bg-[var(--surface-2)] px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]"
           style={{ color }}>{label}</div>
      <div className="font-mono text-sm font-semibold text-[var(--text)]">{value}</div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Tab 1 — Sección transversal
// ═════════════════════════════════════════════════════════════════════════════

function SectionTab({ detail }: { detail: WallDetailResponse }) {
  const macrofibers = detail.analytical?.macrofibers;
  const zones = zonesFromDesign(detail);

  if (!zones && (!macrofibers || macrofibers.length === 0)) {
    return (
      <div className="rounded-lg border border-dashed border-[var(--border)] px-6 py-10 text-center">
        <p className="text-sm text-[var(--text-muted)]">
          Sin datos de sección. Corre el auto-diseño o configura el modelo analítico.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-3">
          Sección transversal en planta
        </div>
        <SectionSVG detail={detail} showBars={false} />
      </div>
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
          Zonas físicas
        </div>
        <ZonesTable detail={detail} />
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Tab 2 — Refuerzo
// ═════════════════════════════════════════════════════════════════════════════

function ReinforcementTab({
  detail, projectId, onReload,
}: {
  detail: WallDetailResponse; projectId: string; onReload: () => void;
}) {
  const dr = detail.design_result;
  const [editing, setEditing] = useState(false);

  if (!dr) {
    return (
      <div className="rounded-lg border border-dashed border-[var(--border)] px-6 py-12 text-center space-y-2">
        <p className="text-sm text-[var(--text-muted)]">
          Este muro aún no tiene refuerzo diseñado.
        </p>
        <p className="text-xs text-[var(--text-muted)]">
          Vuelve al tab &ldquo;Muros&rdquo; del proyecto y presiona &ldquo;⚙ Diseñar todos los muros&rdquo;.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              Sección con refuerzo propuesto
            </div>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-xs text-[var(--primary)] hover:underline"
            >
              ✎ Editar refuerzo
            </button>
          </div>
          <SectionSVG detail={detail} showBars={true} />
        </div>

        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
            Refuerzo por zona
          </div>
          <ReinforcementSummary result={dr} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
            Elemento de borde (EBE) — ACI 318-25 §18.10.6
          </div>
          <EBESection result={dr} />
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
            Cortante — ACI 318-25 §18.10.4
          </div>
          <ShearSection result={dr} />
        </div>
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
          Verificaciones NSR-10 / ACI 318-25 ({dr.checks.length})
        </div>
        <ChecksTable result={dr} />
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
          Combinaciones de diseño usadas
        </div>
        <DemandsTable demands={detail.design_demands} governing={dr.governing_combo} />
      </div>

      {editing && (
        <ReinforcementEditor
          detail={detail}
          projectId={projectId}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); onReload(); }}
        />
      )}
    </div>
  );
}

function ReinforcementSummary({ result }: { result: WallDesignResult }) {
  const r = result.reinforcement;
  const rows: { name: string; color: string; body: React.ReactNode }[] = [
    {
      name: "Boundary izq.", color: REGION_COLOR.boundary_left,
      body: (
        <>
          <ZoneLine label="n° barras long."   value={`${r.be_left.n_bars} · ⌀${r.be_left.db_mm}mm`} />
          <ZoneLine label="Longitud EBE"      value={`${(r.be_left.length_m * 1000).toFixed(0)} mm`} />
          <ZoneLine label="Estribos"          value={`⌀${r.be_left.tie_db_mm}mm @ ${r.be_left.tie_spacing_mm}mm`} />
          <ZoneLine label="Área acero"        value={`${r.be_left.As_mm2.toFixed(0)} mm²`} />
        </>
      ),
    },
    {
      name: "Alma (web)", color: REGION_COLOR.web,
      body: (
        <>
          <ZoneLine label="Vert." value={`⌀${r.web.vert_db_mm}mm @ ${r.web.vert_spacing_mm}mm`} />
          <ZoneLine label="Horiz." value={`⌀${r.web.horiz_db_mm}mm @ ${r.web.horiz_spacing_mm}mm`} />
          <ZoneLine label="Cortinas" value={`${r.web.n_curtains}`} />
          <ZoneLine label="ρᵥ · ρₕ" value={`${(r.web.rho_v * 100).toFixed(2)}% · ${(r.web.rho_h * 100).toFixed(2)}%`} />
        </>
      ),
    },
    {
      name: "Boundary der.", color: REGION_COLOR.boundary_right,
      body: (
        <>
          <ZoneLine label="n° barras long."   value={`${r.be_right.n_bars} · ⌀${r.be_right.db_mm}mm`} />
          <ZoneLine label="Longitud EBE"      value={`${(r.be_right.length_m * 1000).toFixed(0)} mm`} />
          <ZoneLine label="Estribos"          value={`⌀${r.be_right.tie_db_mm}mm @ ${r.be_right.tie_spacing_mm}mm`} />
          <ZoneLine label="Área acero"        value={`${r.be_right.As_mm2.toFixed(0)} mm²`} />
        </>
      ),
    },
  ];

  return (
    <div className="space-y-2">
      {rows.map(r => (
        <div key={r.name}
             className="rounded-md border-l-[3px] bg-[var(--surface-2)] px-3 py-2"
             style={{ borderLeftColor: r.color }}>
          <div className="text-xs font-semibold mb-1" style={{ color: r.color }}>{r.name}</div>
          <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[11px]">{r.body}</dl>
        </div>
      ))}
    </div>
  );
}

function ZoneLine({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-[var(--text-muted)]">{label}</dt>
      <dd className="font-mono text-[var(--text)]">{value}</dd>
    </>
  );
}

function EBESection({ result }: { result: WallDesignResult }) {
  const ebe = result.boundary_element;
  const conf = result.confinement;
  return (
    <div className="space-y-2 text-[11px]">
      <KV label="Requerido"     value={ebe.required ? "Sí" : "No"} strong />
      <KV label="Método"        value={ebe.method === "displacement" ? "Desplazamiento (18.10.6.2)" : ebe.method === "stress" ? "Esfuerzo (18.10.6.3)" : "N/A"} />
      <KV label="c"             value={`${(ebe.c_m * 1000).toFixed(0)} mm`} />
      <KV label="lc requerida"  value={`${(ebe.lc_m * 1000).toFixed(0)} mm`} strong />
      {ebe.sigma_max_mpa > 0 && <KV label="σ máx / umbral" value={`${ebe.sigma_max_mpa.toFixed(2)} / ${ebe.threshold_mpa.toFixed(2)} MPa`} />}
      {ebe.drift_ratio != null && <KV label="Deriva elástica" value={`${(ebe.drift_ratio * 100).toFixed(2)}%`} />}
      <div className="mt-2 rounded-md bg-[var(--surface-2)] px-2 py-1.5 text-[10.5px] text-[var(--text-muted)]">
        {ebe.message}
      </div>
      {conf && ebe.required && (
        <>
          <div className="mt-3 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Confinamiento</div>
          <KV label="Ash requerida" value={`${conf.Ash_req_mm2.toFixed(0)} mm²`} />
          <KV label="Ash provista"  value={`${conf.Ash_prov_mm2.toFixed(0)} mm²`} strong ok={conf.ok_ash} />
          <KV label="Espaciamiento" value={`${conf.s_mm.toFixed(0)} mm (max ${conf.s_max_code_mm.toFixed(0)})`} ok={conf.ok_spacing} />
        </>
      )}
    </div>
  );
}

function ShearSection({ result }: { result: WallDesignResult }) {
  const s = result.shear;
  return (
    <div className="space-y-2 text-[11px]">
      <KV label="hw / lw"       value={s.hw_lw.toFixed(2)} />
      <KV label="αc"            value={s.alpha_c.toFixed(3)} />
      <KV label="Acv"           value={`${s.Acv_m2.toFixed(3)} m²`} />
      <KV label="Vu"            value={`${s.Vu_kN.toFixed(0)} kN`} />
      <KV label="φVn"           value={`${s.phi_Vn_kN.toFixed(0)} kN`} strong ok={s.ok_shear} />
      <KV label="Vn máx"        value={`${s.Vn_limit_kN.toFixed(0)} kN`} ok={s.ok_vn_limit} />
      <KV label="ρt req / prov" value={`${(s.rho_t_req * 100).toFixed(2)}% / ${(s.rho_t_prov * 100).toFixed(2)}%`} ok={s.ok_rho_t} />
      <KV label="ρv prov"       value={`${(s.rho_v_prov * 100).toFixed(2)}%`} ok={s.ok_rho_v} />
    </div>
  );
}

function KV({ label, value, strong, ok }: { label: string; value: string; strong?: boolean; ok?: boolean }) {
  const okColor  = ok === undefined ? undefined : ok ? "#10b981" : "#ef4444";
  return (
    <div className="grid grid-cols-[1fr_auto] gap-2">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span className="font-mono" style={{ color: okColor, fontWeight: strong ? 600 : 400 }}>
        {ok === undefined ? value : `${ok ? "✓" : "✗"} ${value}`}
      </span>
    </div>
  );
}

function ChecksTable({ result }: { result: WallDesignResult }) {
  return (
    <div className="overflow-x-auto rounded-md border border-[var(--border)]">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-[var(--surface-2)] text-[var(--text-muted)] uppercase text-[10px] tracking-wider">
            <th className="px-2 py-1.5 text-left">Artículo</th>
            <th className="px-2 py-1.5 text-left">Descripción</th>
            <th className="px-2 py-1.5 text-right">Demanda</th>
            <th className="px-2 py-1.5 text-right">Capacidad</th>
            <th className="px-2 py-1.5 text-right">DCR</th>
            <th className="px-2 py-1.5 text-center">OK</th>
          </tr>
        </thead>
        <tbody>
          {result.checks.map((c, i) => (
            <tr key={i} className="border-t border-[var(--border)]">
              <td className="px-2 py-1.5 font-mono text-[var(--text-muted)]">{c.article}</td>
              <td className="px-2 py-1.5">{c.description}</td>
              <td className="px-2 py-1.5 text-right font-mono">{fmt(c.demand)} {c.unit}</td>
              <td className="px-2 py-1.5 text-right font-mono">{fmt(c.capacity)} {c.unit}</td>
              <td className="px-2 py-1.5 text-right font-mono">{c.dcr.toFixed(2)}</td>
              <td className="px-2 py-1.5 text-center" style={{ color: c.ok ? "#10b981" : "#ef4444" }}>
                {c.ok ? "✓" : "✗"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DemandsTable({ demands, governing }: {
  demands: WallDetailResponse["design_demands"];
  governing: string;
}) {
  if (!demands || demands.length === 0) {
    return <p className="text-xs text-[var(--text-muted)]">Sin demandas guardadas.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-md border border-[var(--border)]">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-[var(--surface-2)] text-[var(--text-muted)] uppercase text-[10px] tracking-wider">
            <th className="px-2 py-1.5 text-left">Combo</th>
            <th className="px-2 py-1.5 text-right">Pu (kN)</th>
            <th className="px-2 py-1.5 text-right">Vu (kN)</th>
            <th className="px-2 py-1.5 text-right">Mu (kN·m)</th>
            <th className="px-2 py-1.5 text-center">Sismo</th>
          </tr>
        </thead>
        <tbody>
          {demands.map((d, i) => {
            const gov = d.label === governing;
            return (
              <tr key={i} className="border-t border-[var(--border)]" style={gov ? { background: "rgba(59, 125, 216, .07)", fontWeight: 600 } : undefined}>
                <td className="px-2 py-1.5 font-mono">{d.label}{gov && " ★"}</td>
                <td className="px-2 py-1.5 text-right font-mono">{d.Pu_kN.toFixed(1)}</td>
                <td className="px-2 py-1.5 text-right font-mono">{d.Vu_kN.toFixed(1)}</td>
                <td className="px-2 py-1.5 text-right font-mono">{d.Mu_kNm.toFixed(1)}</td>
                <td className="px-2 py-1.5 text-center">{d.is_seismic ? "✓" : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Tab 3 — Discretización
// ═════════════════════════════════════════════════════════════════════════════

function DiscretizationTab({ detail }: { detail: WallDetailResponse }) {
  const mfs = detail.analytical?.macrofibers;

  if (!mfs || mfs.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-[var(--border)] px-6 py-12 text-center space-y-2">
        <p className="text-sm text-[var(--text-muted)]">
          Este muro aún no tiene modelo analítico (macrofibras) configurado.
        </p>
        <p className="text-xs text-[var(--text-muted)]">
          Configúralo desde la pestaña &ldquo;Muros&rdquo; con &ldquo;Configure →&rdquo; para pasar
          del refuerzo de diseño al MVLEM_3D no lineal.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-3">
          Macrofibras ({mfs.length})
        </div>
        <div className="overflow-x-auto rounded-md border border-[var(--border)]">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-[var(--surface-2)] text-[var(--text-muted)] uppercase text-[10px] tracking-wider">
                <th className="px-2 py-1.5 text-left">#</th>
                <th className="px-2 py-1.5 text-left">Región</th>
                <th className="px-2 py-1.5 text-right">Ancho (mm)</th>
                <th className="px-2 py-1.5 text-right">Espesor (mm)</th>
                <th className="px-2 py-1.5 text-right">ρᵥ (%)</th>
                <th className="px-2 py-1.5 text-right">ρₕ (%)</th>
                <th className="px-2 py-1.5 text-left">Concreto</th>
                <th className="px-2 py-1.5 text-left">Acero v.</th>
              </tr>
            </thead>
            <tbody>
              {mfs.map(mf => (
                <tr key={mf.index} className="border-t border-[var(--border)]">
                  <td className="px-2 py-1.5 font-mono">{mf.index}</td>
                  <td className="px-2 py-1.5">
                    <span className="inline-block w-2 h-2 rounded-sm mr-1 align-middle"
                          style={{ backgroundColor: REGION_COLOR[mf.region] }} />
                    <span style={{ color: REGION_COLOR[mf.region] }}>{REGION_LABEL[mf.region]}</span>
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono">{(mf.width_m * 1000).toFixed(0)}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{(mf.thickness_m * 1000).toFixed(0)}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{(mf.rho_vertical * 100).toFixed(2)}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{(mf.rho_horizontal * 100).toFixed(2)}</td>
                  <td className="px-2 py-1.5 font-mono text-[10.5px]">{mf.concrete_name || "—"}</td>
                  <td className="px-2 py-1.5 font-mono text-[10.5px]">{mf.steel_v_name || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Tab 4 — OpenSees
// ═════════════════════════════════════════════════════════════════════════════

function OpenSeesTab({ detail }: { detail: WallDetailResponse }) {
  const ops = detail.opensees;
  if (!ops) {
    return (
      <div className="rounded-lg border border-dashed border-[var(--border)] px-6 py-12 text-center">
        <p className="text-sm text-[var(--text-muted)]">
          Necesita modelo analítico configurado para mostrar el mapeo OpenSees.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
          Nodos del elemento (tags OpenSees)
        </div>
        <div className="grid grid-cols-4 gap-2 text-xs">
          {(["i","j","k","l"] as const).map(n => (
            <div key={n} className="rounded-md bg-[var(--surface-2)] px-2 py-1.5">
              <div className="text-[10px] uppercase text-[var(--text-muted)]">Nodo {n}</div>
              <div className="font-mono text-[var(--text)]">
                {ops.node_ids[n] || "—"} <span className="text-[var(--text-muted)]">→ tag {ops.node_tags[n] || 0}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
          Definición de materiales
        </div>
        <pre className="rounded-md bg-[var(--surface-2)] p-3 text-[11px] font-mono overflow-x-auto whitespace-pre">
{ops.material_lines.join("\n")}
        </pre>
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
          Elemento MVLEM (ele_tag = {ops.ele_tag})
        </div>
        <pre className="rounded-md bg-[var(--surface-2)] p-3 text-[11px] font-mono overflow-x-auto whitespace-pre">
{ops.element_line}
        </pre>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// SVG de sección — reutilizado por Sección y Refuerzo (con overlay de barras)
// ═════════════════════════════════════════════════════════════════════════════

interface Zone { region: MacroFiberRegion; x0_m: number; x1_m: number }

function zonesFromDesign(detail: WallDetailResponse): Zone[] | null {
  const dr = detail.design_result;
  if (!dr) return null;
  const lw = dr.geometry.lw_m;
  const lL = dr.reinforcement.be_left.length_m;
  const lR = dr.reinforcement.be_right.length_m;
  return [
    { region: "boundary_left",  x0_m: 0,       x1_m: lL },
    { region: "web",            x0_m: lL,      x1_m: lw - lR },
    { region: "boundary_right", x0_m: lw - lR, x1_m: lw },
  ];
}

function zonesFromMacrofibers(detail: WallDetailResponse): Zone[] | null {
  const mfs = detail.analytical?.macrofibers;
  if (!mfs || mfs.length === 0) return null;
  const out: Zone[] = [];
  let cursor = 0;
  mfs.forEach(mf => {
    const last = out[out.length - 1];
    if (last && last.region === mf.region) {
      last.x1_m = cursor + mf.width_m;
    } else {
      out.push({ region: mf.region, x0_m: cursor, x1_m: cursor + mf.width_m });
    }
    cursor += mf.width_m;
  });
  return out;
}

function SectionSVG({ detail, showBars }: { detail: WallDetailResponse; showBars: boolean }) {
  const dr = detail.design_result;
  // Prefer zones from design (fits the reinforcement layout). Fallback to macrofibers.
  const zones = useMemo(
    () => zonesFromDesign(detail) ?? zonesFromMacrofibers(detail),
    [detail],
  );
  const g = detail.geometry;

  if (!zones || !g) {
    return <p className="text-xs text-[var(--text-muted)]">Sin geometría disponible.</p>;
  }

  const totalMm = (dr?.geometry.lw_m ?? g.total_length_m) * 1000;
  const thickMm = (dr?.geometry.tw_m ?? g.thickness_m)   * 1000;

  const MARGIN_X = 40;
  const MARGIN_TOP = 34;
  const MARGIN_BOTTOM = 44;
  const CANVAS_W = 800;
  const drawableW = CANVAS_W - 2 * MARGIN_X;
  const scale = drawableW / totalMm;
  let sectionH = thickMm * scale;
  const MIN_ASPECT = 4;
  const minH = drawableW / MIN_ASPECT / 4;
  if (sectionH < minH) sectionH = minH;
  const CANVAS_H = MARGIN_TOP + sectionH + MARGIN_BOTTOM;

  const y0 = MARGIN_TOP;
  const y1 = MARGIN_TOP + sectionH;

  return (
    <svg viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`} className="w-full h-auto">
      {/* Zones */}
      {zones.map((z, i) => {
        const x  = MARGIN_X + z.x0_m * 1000 * scale;
        const w  = (z.x1_m - z.x0_m) * 1000 * scale;
        return (
          <rect
            key={i}
            x={x} y={y0} width={w} height={sectionH}
            fill={REGION_COLOR[z.region]}
            fillOpacity={0.45}
            stroke="#0b0b0f"
            strokeOpacity={0.35}
            strokeWidth={1}
          />
        );
      })}

      {/* Outer contour */}
      <rect
        x={MARGIN_X} y={y0}
        width={totalMm * scale}
        height={sectionH}
        fill="none"
        stroke="var(--color-text, #111)"
        strokeWidth={1.5}
      />

      {/* Rebar overlay (if design available and showBars) */}
      {showBars && dr && <RebarOverlay result={dr} originX={MARGIN_X} scale={scale} y0={y0} sectionH={sectionH} />}

      {/* Bottom total dimension */}
      <DimLine x1={MARGIN_X} x2={MARGIN_X + totalMm * scale} y={y1 + 22} label={`${totalMm.toFixed(0)} mm`} />

      {/* Right thickness */}
      <ThicknessTick x={MARGIN_X + totalMm * scale + 6} y1={y0} y2={y1} label={`${thickMm.toFixed(0)} mm`} />

      {/* Zone brackets top */}
      <ZoneBrackets zones={zones} originX={MARGIN_X} scale={scale} y={y0 - 14} />
    </svg>
  );
}

function RebarOverlay({
  result, originX, scale, y0, sectionH,
}: {
  result: WallDesignResult;
  originX: number; scale: number; y0: number; sectionH: number;
}) {
  const bars = result.bars;
  const tw = result.geometry.tw_m * 1000;
  const covLeft  = result.reinforcement.be_left.cover_mm;
  const covRight = result.reinforcement.be_right.cover_mm;

  const dbBE = Math.max(result.reinforcement.be_left.db_mm, result.reinforcement.be_right.db_mm);
  const dbW  = result.reinforcement.web.vert_db_mm;
  // px radius (visual only; not to strict scale for readability)
  const rBE = Math.max(3, Math.min(9,  dbBE * scale * 0.65));
  const rW  = Math.max(2, Math.min(6,  dbW  * scale * 0.65));

  const yTop    = y0 + Math.max(3, covLeft * scale);
  const yBot    = y0 + sectionH - Math.max(3, covRight * scale);
  const yMid    = (y0 + y0 + sectionH) / 2;

  // Tie rectangles for BE zones
  const beL = result.reinforcement.be_left;
  const beR = result.reinforcement.be_right;
  const beLx0 = originX;
  const beLw  = beL.length_m * 1000 * scale;
  const beRx1 = originX + result.geometry.lw_m * 1000 * scale;
  const beRw  = beR.length_m * 1000 * scale;
  const beRx0 = beRx1 - beRw;

  // Determine which bars belong to a BE via x coord
  const lwmm = result.geometry.lw_m * 1000;
  return (
    <g>
      {/* Confinement tie rectangles (perimeter of EBE) */}
      <rect
        x={beLx0 + 3} y={y0 + 3} width={beLw - 6} height={sectionH - 6}
        fill="none" stroke={REGION_COLOR.boundary_left} strokeWidth={1.5} strokeDasharray="3 2"
      />
      <rect
        x={beRx0 + 3} y={y0 + 3} width={beRw - 6} height={sectionH - 6}
        fill="none" stroke={REGION_COLOR.boundary_right} strokeWidth={1.5} strokeDasharray="3 2"
      />

      {/* Bars — 2 rows for BE, mid row for web */}
      {bars.map((b, i) => {
        const inBE_L = b.x * 1000 <  beL.length_m * 1000 + 1;
        const inBE_R = b.x * 1000 >  lwmm - beR.length_m * 1000 - 1;
        const cx     = originX + b.x * 1000 * scale;
        const r      = inBE_L || inBE_R ? rBE : rW;
        const col    = inBE_L ? REGION_COLOR.boundary_left
                     : inBE_R ? REGION_COLOR.boundary_right
                              : REGION_COLOR.web;
        if (inBE_L || inBE_R) {
          return (
            <g key={i}>
              <circle cx={cx} cy={yTop} r={r} fill={col} stroke="#000" strokeOpacity={0.6} strokeWidth={0.8} />
              <circle cx={cx} cy={yBot} r={r} fill={col} stroke="#000" strokeOpacity={0.6} strokeWidth={0.8} />
            </g>
          );
        }
        return (
          <circle key={i} cx={cx} cy={yMid} r={r} fill={col} stroke="#000" strokeOpacity={0.6} strokeWidth={0.6} />
        );
      })}
      {/* Legend under section */}
      <text x={originX} y={y0 + sectionH + 42} fontSize={10} fontFamily="ui-monospace" fill="var(--color-text-muted)">
        Barras EBE: {result.reinforcement.be_left.n_bars} × ⌀{result.reinforcement.be_left.db_mm.toFixed(1)}mm  ·  Web ⌀{dbW.toFixed(1)}mm @ {result.reinforcement.web.vert_spacing_mm.toFixed(0)}mm
      </text>
    </g>
  );
}

function DimLine({ x1, x2, y, label }: { x1: number; x2: number; y: number; label: string }) {
  const stroke = "var(--color-text-muted, #666)";
  return (
    <g>
      <line x1={x1} y1={y} x2={x2} y2={y} stroke={stroke} strokeWidth={1} />
      <line x1={x1} y1={y - 4} x2={x1} y2={y + 4} stroke={stroke} strokeWidth={1} />
      <line x1={x2} y1={y - 4} x2={x2} y2={y + 4} stroke={stroke} strokeWidth={1} />
      <text x={(x1 + x2) / 2} y={y + 14} textAnchor="middle" fontSize={11}
            fontFamily="ui-monospace, SFMono-Regular, monospace" fill={stroke}>
        {label}
      </text>
    </g>
  );
}

function ThicknessTick({ x, y1, y2, label }: { x: number; y1: number; y2: number; label: string }) {
  const stroke = "var(--color-text-muted, #666)";
  return (
    <g>
      <line x1={x} y1={y1} x2={x} y2={y2} stroke={stroke} strokeWidth={1} />
      <line x1={x - 4} y1={y1} x2={x + 4} y2={y1} stroke={stroke} strokeWidth={1} />
      <line x1={x - 4} y1={y2} x2={x + 4} y2={y2} stroke={stroke} strokeWidth={1} />
      <text x={x + 8} y={(y1 + y2) / 2 + 4} fontSize={11}
            fontFamily="ui-monospace, SFMono-Regular, monospace" fill={stroke}>
        {label}
      </text>
    </g>
  );
}

function ZoneBrackets({
  zones, originX, scale, y,
}: { zones: Zone[]; originX: number; scale: number; y: number }) {
  return (
    <g>
      {zones.map((z, i) => {
        const x0 = originX + z.x0_m * 1000 * scale;
        const x1 = originX + z.x1_m * 1000 * scale;
        return (
          <g key={i}>
            <line x1={x0} y1={y} x2={x1} y2={y} stroke={REGION_COLOR[z.region]} strokeWidth={2} />
            <text x={(x0 + x1) / 2} y={y - 5} textAnchor="middle" fontSize={10.5}
                  fontFamily="ui-monospace, SFMono-Regular, monospace"
                  fontWeight={700} fill={REGION_COLOR[z.region]}>
              {REGION_LABEL[z.region]}
            </text>
          </g>
        );
      })}
    </g>
  );
}

// ── Zones table (Section tab) ────────────────────────────────────────────────

function ZonesTable({ detail }: { detail: WallDetailResponse }) {
  const dr = detail.design_result;

  if (dr) {
    const r = dr.reinforcement;
    return (
      <div className="space-y-2 text-xs">
        <ZoneCard color={REGION_COLOR.boundary_left} name="Boundary izq.">
          <ZoneLine label="lc" value={`${(r.be_left.length_m  * 1000).toFixed(0)} mm`} />
          <ZoneLine label="Barras" value={`${r.be_left.n_bars} × ⌀${r.be_left.db_mm}mm`} />
        </ZoneCard>
        <ZoneCard color={REGION_COLOR.web} name="Alma (web)">
          <ZoneLine label="Ancho" value={`${((dr.geometry.lw_m - r.be_left.length_m - r.be_right.length_m) * 1000).toFixed(0)} mm`} />
          <ZoneLine label="ρᵥ" value={`${(r.web.rho_v * 100).toFixed(2)}%`} />
          <ZoneLine label="ρₕ" value={`${(r.web.rho_h * 100).toFixed(2)}%`} />
        </ZoneCard>
        <ZoneCard color={REGION_COLOR.boundary_right} name="Boundary der.">
          <ZoneLine label="lc" value={`${(r.be_right.length_m * 1000).toFixed(0)} mm`} />
          <ZoneLine label="Barras" value={`${r.be_right.n_bars} × ⌀${r.be_right.db_mm}mm`} />
        </ZoneCard>
      </div>
    );
  }

  // Fallback: aggregate macrofibers
  const mfs = detail.analytical?.macrofibers ?? [];
  const acc: Record<MacroFiberRegion, { n: number; width_m: number; rho_v_max: number }> = {
    boundary_left:  { n: 0, width_m: 0, rho_v_max: 0 },
    web:            { n: 0, width_m: 0, rho_v_max: 0 },
    boundary_right: { n: 0, width_m: 0, rho_v_max: 0 },
  };
  mfs.forEach(mf => {
    const a = acc[mf.region];
    a.n += 1; a.width_m += mf.width_m;
    a.rho_v_max = Math.max(a.rho_v_max, mf.rho_vertical);
  });

  return (
    <div className="space-y-2 text-xs">
      {(["boundary_left","web","boundary_right"] as MacroFiberRegion[]).map(r => {
        const a = acc[r];
        return (
          <ZoneCard key={r} color={REGION_COLOR[r]} name={REGION_LABEL[r]}>
            {a.n === 0 ? (
              <ZoneLine label="—" value="sin zona" />
            ) : (
              <>
                <ZoneLine label="MF" value={`${a.n}`} />
                <ZoneLine label="Ancho" value={`${(a.width_m * 1000).toFixed(0)} mm`} />
                <ZoneLine label="ρᵥ máx" value={`${(a.rho_v_max * 100).toFixed(2)}%`} />
              </>
            )}
          </ZoneCard>
        );
      })}
    </div>
  );
}

function ZoneCard({ color, name, children }: { color: string; name: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border-l-[3px] bg-[var(--surface-2)] px-3 py-2" style={{ borderLeftColor: color }}>
      <div className="text-xs font-semibold mb-1" style={{ color }}>{name}</div>
      <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[11px]">{children}</dl>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Editor de refuerzo (modal)
// ═════════════════════════════════════════════════════════════════════════════

function ReinforcementEditor({
  detail, projectId, onClose, onSaved,
}: {
  detail: WallDetailResponse; projectId: string;
  onClose: () => void; onSaved: () => void;
}) {
  const dr = detail.design_result!;
  const r  = dr.reinforcement;

  const [form, setForm] = useState<WallManualReinf>({
    be_left:  { ...r.be_left },
    be_right: { ...r.be_right },
    web:      { ...r.web },
    symmetric: true,
  });
  const [busy, setBusy]   = useState(false);
  const [err,  setErr]    = useState<string | null>(null);

  async function submit() {
    setBusy(true); setErr(null);
    try {
      await redesignWall(projectId, detail.label, { manual_reinf: form });
      onSaved();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function redoAuto() {
    setBusy(true); setErr(null);
    try {
      await redesignWall(projectId, detail.label, {});
      onSaved();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-3xl rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 overflow-y-auto max-h-[85vh]">
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="text-[11px] uppercase text-[var(--text-muted)]">Editor de refuerzo</div>
            <h2 className="text-lg font-semibold">{detail.label}</h2>
          </div>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text)]">✕</button>
        </div>

        {err && (
          <div className="mb-3 rounded-md bg-red-500/10 border border-red-500/20 px-3 py-2 text-xs text-red-500">
            {err}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <BEEditor
            title="Boundary izq."
            color={REGION_COLOR.boundary_left}
            zone={form.be_left}
            onChange={z => setForm({ ...form, be_left: z, be_right: form.symmetric ? { ...z } : form.be_right })}
          />
          <WebEditor
            zone={form.web}
            onChange={z => setForm({ ...form, web: z })}
          />
          <BEEditor
            title="Boundary der."
            color={REGION_COLOR.boundary_right}
            zone={form.be_right}
            disabled={form.symmetric}
            onChange={z => setForm({ ...form, be_right: z })}
          />
        </div>

        <label className="mt-3 flex items-center gap-2 text-xs">
          <input type="checkbox" checked={form.symmetric}
                 onChange={e => setForm({ ...form, symmetric: e.target.checked,
                                          be_right: e.target.checked ? { ...form.be_left } : form.be_right })} />
          <span>Simetría izquierda ↔ derecha</span>
        </label>

        <div className="mt-5 flex flex-wrap gap-2 justify-end">
          <button onClick={redoAuto} disabled={busy}
                  className="rounded-md border border-[var(--border)] px-4 py-1.5 text-xs hover:bg-[var(--surface-2)]">
            ⟲ Restaurar auto-diseño
          </button>
          <button onClick={onClose} disabled={busy}
                  className="rounded-md border border-[var(--border)] px-4 py-1.5 text-xs hover:bg-[var(--surface-2)]">
            Cancelar
          </button>
          <button onClick={submit} disabled={busy}
                  className="btn-primary text-xs px-4 py-1.5">
            {busy ? "Guardando…" : "Guardar y verificar"}
          </button>
        </div>
      </div>
    </div>
  );
}

function BEEditor({
  title, color, zone, onChange, disabled,
}: {
  title: string; color: string;
  zone: WallManualReinf["be_left"];
  onChange: (z: WallManualReinf["be_left"]) => void;
  disabled?: boolean;
}) {
  const upd = (k: keyof typeof zone, v: number) => onChange({ ...zone, [k]: v });
  return (
    <fieldset disabled={disabled} className="rounded-md border-l-[3px] bg-[var(--surface-2)] p-3 space-y-2"
              style={{ borderLeftColor: color, opacity: disabled ? 0.55 : 1 }}>
      <legend className="text-xs font-semibold" style={{ color }}>{title}</legend>
      <NumField label="Longitud EBE (m)" value={zone.length_m} step={0.05} onChange={v => upd("length_m", v)} />
      <NumField label="N° barras long." value={zone.n_bars}   step={1}     onChange={v => upd("n_bars", v)} />
      <NumField label="⌀ barra (mm)"    value={zone.db_mm}    step={0.1}   onChange={v => upd("db_mm", v)} />
      <NumField label="Recubrimiento (mm)" value={zone.cover_mm} step={5}  onChange={v => upd("cover_mm", v)} />
      <NumField label="⌀ estribo (mm)"    value={zone.tie_db_mm} step={0.1} onChange={v => upd("tie_db_mm", v)} />
      <NumField label="Espac. estribo (mm)" value={zone.tie_spacing_mm} step={5} onChange={v => upd("tie_spacing_mm", v)} />
    </fieldset>
  );
}

function WebEditor({
  zone, onChange,
}: {
  zone: WallManualReinf["web"]; onChange: (z: WallManualReinf["web"]) => void;
}) {
  const upd = (k: keyof typeof zone, v: number) => onChange({ ...zone, [k]: v });
  return (
    <fieldset className="rounded-md border-l-[3px] bg-[var(--surface-2)] p-3 space-y-2"
              style={{ borderLeftColor: REGION_COLOR.web }}>
      <legend className="text-xs font-semibold" style={{ color: REGION_COLOR.web }}>Alma (web)</legend>
      <NumField label="⌀ vertical (mm)"   value={zone.vert_db_mm}       step={0.1} onChange={v => upd("vert_db_mm", v)} />
      <NumField label="Espac. vertical (mm)"   value={zone.vert_spacing_mm}  step={10} onChange={v => upd("vert_spacing_mm", v)} />
      <NumField label="⌀ horizontal (mm)" value={zone.horiz_db_mm}      step={0.1} onChange={v => upd("horiz_db_mm", v)} />
      <NumField label="Espac. horiz. (mm)"     value={zone.horiz_spacing_mm} step={10} onChange={v => upd("horiz_spacing_mm", v)} />
      <NumField label="Cortinas"          value={zone.n_curtains}       step={1}   onChange={v => upd("n_curtains", v)} />
    </fieldset>
  );
}

function NumField({ label, value, step, onChange }: {
  label: string; value: number; step: number; onChange: (v: number) => void;
}) {
  return (
    <label className="block text-[11px]">
      <span className="text-[var(--text-muted)]">{label}</span>
      <input type="number" value={value} step={step}
             onChange={e => onChange(Number.parseFloat(e.target.value) || 0)}
             className="mt-0.5 w-full rounded-md border border-[var(--border)] bg-[var(--surface)]
                        px-2 py-1 font-mono text-xs" />
    </label>
  );
}

// ── utils ────────────────────────────────────────────────────────────────────

function fmt(v: number): string {
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 1)   return v.toFixed(2);
  return v.toFixed(4);
}
