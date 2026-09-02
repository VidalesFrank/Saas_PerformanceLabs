"use client";

import type { BeamDesignResult, BeamCheckRow } from "@/lib/structural-types";

// ── Sub-componentes ────────────────────────────────────────────────────────────

function SummaryCard({
  label, value, sub, color,
}: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 px-4 py-3 flex flex-col gap-0.5">
      <span className="text-[10px] text-text-muted uppercase tracking-wide">{label}</span>
      <span className="text-xl font-bold font-mono" style={color ? { color } : undefined}>
        {value}
      </span>
      {sub && <span className="text-[10px] text-text-muted">{sub}</span>}
    </div>
  );
}

function DcrBar({ dcr, danger }: { dcr: number; danger?: boolean }) {
  const pct   = Math.min(dcr * 100, 130);
  const color = dcr > 1.0
    ? "var(--color-danger)"
    : dcr > 0.85
    ? "var(--color-warning)"
    : "var(--color-success)";
  return (
    <div className="flex items-center gap-2 min-w-[80px]">
      <div className="flex-1 h-1.5 rounded-full bg-border overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="text-[11px] font-mono font-semibold w-[42px] text-right" style={{ color }}>
        {dcr.toFixed(2)}
      </span>
    </div>
  );
}

function StatusBadge({ ok, fail }: { ok: boolean; fail?: boolean }) {
  const label = fail ? "FALLA" : ok ? "OK" : "NG";
  const bg    = (fail || !ok) ? "var(--color-danger)" : "var(--color-success)";
  return (
    <span
      className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-bold"
      style={{ background: `${bg}22`, color: bg }}
    >
      {label}
    </span>
  );
}

function SteelChip({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex flex-col items-center rounded border border-border px-1.5 py-0.5">
      <span className="text-[8px] text-text-muted uppercase">{label}</span>
      <span className="text-[11px] font-mono font-semibold text-text">{value.toFixed(2)}</span>
    </span>
  );
}

// ── Tabla principal ────────────────────────────────────────────────────────────

function BeamTable({ beams }: { beams: BeamCheckRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr className="border-b border-border bg-surface-2 text-left text-text-muted">
            <th className="px-3 py-2 font-medium">Piso</th>
            <th className="px-3 py-2 font-medium">Viga</th>
            <th className="px-3 py-2 font-medium">Sección</th>
            <th className="px-3 py-2 font-medium text-right">L (m)</th>
            <th className="px-3 py-2 font-medium text-right">Mu− (kN·m)</th>
            <th className="px-3 py-2 font-medium text-right">Vu (kN)</th>
            <th className="px-3 py-2 font-medium">As neg/pos</th>
            <th className="px-3 py-2 font-medium">Estribos</th>
            <th className="px-3 py-2 font-medium min-w-[100px]">DCR flex</th>
            <th className="px-3 py-2 font-medium min-w-[100px]">DCR cort</th>
            <th className="px-3 py-2 font-medium">Estado</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {beams.map((b) => (
            <tr
              key={b.id}
              className={[
                "transition-colors hover:bg-surface-2",
                !b.ok ? "bg-[var(--color-danger)]/5" : "",
              ].join(" ")}
            >
              <td className="px-3 py-2 text-text-muted font-mono">{b.story}</td>
              <td className="px-3 py-2 font-mono text-text">{b.id}</td>
              <td className="px-3 py-2 text-text-muted">
                <span className="font-mono">{b.b_m.toFixed(2)}×{b.h_m.toFixed(2)}</span>
                <span className="opacity-60 ml-1 text-[10px]">({b.fc_MPa}MPa)</span>
              </td>
              <td className="px-3 py-2 text-right font-mono text-text-muted">{b.L_m.toFixed(2)}</td>
              <td className="px-3 py-2 text-right font-mono text-text">{b.Mu_neg_kNm.toFixed(0)}</td>
              <td className="px-3 py-2 text-right font-mono text-text">{b.Vu_kN.toFixed(0)}</td>
              <td className="px-3 py-2">
                <div className="flex gap-1">
                  <SteelChip label="neg" value={b.As_neg_cm2} />
                  <SteelChip label="pos" value={b.As_pos_cm2} />
                </div>
              </td>
              <td className="px-3 py-2">
                <div className="flex flex-col">
                  <span className="font-mono text-text text-[11px]">#3@{b.s_mm}mm</span>
                  <span className="text-[10px] text-text-muted">{b.Av_cm2_m.toFixed(2)} cm²/m</span>
                </div>
              </td>
              <td className="px-3 py-2"><DcrBar dcr={b.dcr_flex} /></td>
              <td className="px-3 py-2"><DcrBar dcr={b.dcr_shear} /></td>
              <td className="px-3 py-2">
                <StatusBadge ok={b.ok} fail={b.section_fail} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Vista agrupada por piso ────────────────────────────────────────────────────

function StoryGroupHeader({ story, beams }: { story: string; beams: BeamCheckRow[] }) {
  const ngCount = beams.filter((b) => !b.ok).length;
  const maxDcr  = Math.max(...beams.map((b) => b.dcr), 0);
  const color   = ngCount > 0 ? "var(--color-danger)" : maxDcr > 0.85 ? "var(--color-warning)" : "var(--color-success)";
  return (
    <tr className="bg-surface-2 border-b border-border">
      <td colSpan={11} className="px-3 py-1.5">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-text text-xs">{story}</span>
          <span className="text-[10px] text-text-muted">{beams.length} vigas</span>
          {ngCount > 0 && (
            <span className="text-[10px] font-bold" style={{ color: "var(--color-danger)" }}>
              {ngCount} NG
            </span>
          )}
          <span className="text-[10px] font-mono ml-auto" style={{ color }}>
            DCR max = {maxDcr.toFixed(2)}
          </span>
        </div>
      </td>
    </tr>
  );
}

function BeamTableGrouped({ beams }: { beams: BeamCheckRow[] }) {
  const byStory: Record<string, BeamCheckRow[]> = {};
  const storyOrder: string[] = [];
  for (const b of beams) {
    if (!byStory[b.story]) {
      byStory[b.story] = [];
      storyOrder.push(b.story);
    }
    byStory[b.story].push(b);
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr className="border-b border-border bg-surface-2 text-left text-text-muted sticky top-0 z-10">
            <th className="px-3 py-2 font-medium">Piso</th>
            <th className="px-3 py-2 font-medium">Viga</th>
            <th className="px-3 py-2 font-medium">Sección</th>
            <th className="px-3 py-2 font-medium text-right">L (m)</th>
            <th className="px-3 py-2 font-medium text-right">Mu− (kN·m)</th>
            <th className="px-3 py-2 font-medium text-right">Vu (kN)</th>
            <th className="px-3 py-2 font-medium">As neg/pos (cm²)</th>
            <th className="px-3 py-2 font-medium">Estribos</th>
            <th className="px-3 py-2 font-medium min-w-[100px]">DCR flex</th>
            <th className="px-3 py-2 font-medium min-w-[100px]">DCR cort</th>
            <th className="px-3 py-2 font-medium">Estado</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {storyOrder.map((story) => (
            <>
              <StoryGroupHeader key={`hdr-${story}`} story={story} beams={byStory[story]} />
              {byStory[story].map((b) => (
                <tr
                  key={b.id}
                  className={[
                    "transition-colors hover:bg-surface-2",
                    !b.ok ? "bg-[var(--color-danger)]/5" : "",
                  ].join(" ")}
                >
                  <td className="px-3 py-2 text-text-muted font-mono text-[10px]">{b.story}</td>
                  <td className="px-3 py-2 font-mono text-text">{b.id}</td>
                  <td className="px-3 py-2 text-text-muted">
                    <span className="font-mono">{b.b_m.toFixed(2)}×{b.h_m.toFixed(2)}</span>
                    <span className="opacity-60 ml-1 text-[10px]">({b.fc_MPa}MPa)</span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-text-muted">{b.L_m.toFixed(2)}</td>
                  <td className="px-3 py-2 text-right font-mono text-text">{b.Mu_neg_kNm.toFixed(0)}</td>
                  <td className="px-3 py-2 text-right font-mono text-text">{b.Vu_kN.toFixed(0)}</td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1">
                      <SteelChip label="neg" value={b.As_neg_cm2} />
                      <SteelChip label="pos" value={b.As_pos_cm2} />
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-col">
                      <span className="font-mono text-text">#3@{b.s_mm}mm</span>
                      <span className="text-[10px] text-text-muted">{b.Av_cm2_m.toFixed(2)} cm²/m</span>
                    </div>
                  </td>
                  <td className="px-3 py-2"><DcrBar dcr={b.dcr_flex} /></td>
                  <td className="px-3 py-2"><DcrBar dcr={b.dcr_shear} /></td>
                  <td className="px-3 py-2">
                    <StatusBadge ok={b.ok} fail={b.section_fail} />
                  </td>
                </tr>
              ))}
            </>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Componente principal ──────────────────────────────────────────────────────

interface Props {
  result: BeamDesignResult;
}

export function BeamDesignResults({ result }: Props) {
  const overallOk = result.n_ng === 0;
  const pctOk     = result.n_beams > 0 ? Math.round((result.n_ok / result.n_beams) * 100) : 100;
  const failSecs  = result.beams.filter((b) => b.section_fail).length;

  return (
    <div className="flex flex-col gap-5">

      {/* Resumen */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryCard
          label="Estado global"
          value={overallOk ? "CUMPLE" : "REQUIERE AJUSTE"}
          sub={`${result.n_ok} OK / ${result.n_ng} NG`}
          color={overallOk ? "var(--color-success)" : "var(--color-danger)"}
        />
        <SummaryCard
          label="DCR máximo"
          value={result.max_dcr.toFixed(2)}
          sub="máx(flex, cort) envolvente"
          color={result.max_dcr > 1.0 ? "var(--color-danger)" : result.max_dcr > 0.85 ? "var(--color-warning)" : "var(--color-success)"}
        />
        <SummaryCard
          label="Vigas verificadas"
          value={`${result.n_beams}`}
          sub={`${pctOk}% dentro de capacidad`}
        />
        <SummaryCard
          label="Combinaciones"
          value={`${result.n_combinations}`}
          sub={`NSR-10 B.3.4 · fy=${result.fy_MPa} MPa`}
        />
      </div>

      {/* Alertas */}
      {!overallOk && (
        <div
          className="rounded-lg border px-4 py-3 text-sm"
          style={{ borderColor: "var(--color-danger)", background: "var(--color-danger)0d", color: "var(--color-danger)" }}
        >
          <strong>{result.n_ng} viga{result.n_ng > 1 ? "s" : ""}</strong> supera
          {result.n_ng > 1 ? "n" : ""} la capacidad P-M/V.
          Revise las dimensiones de sección o incremente el refuerzo.
        </div>
      )}

      {failSecs > 0 && (
        <div
          className="rounded-lg border px-4 py-3 text-sm"
          style={{ borderColor: "var(--color-warning)", background: "var(--color-warning)0d", color: "var(--color-warning)" }}
        >
          <strong>{failSecs} sección{failSecs > 1 ? "es" : ""}</strong> insuficiente
          {failSecs > 1 ? "s" : ""} en dimensiones —
          el discriminante de la fórmula cuadrática resultó negativo.
          Aumente la profundidad h de la viga.
        </div>
      )}

      {/* Leyenda */}
      <div className="flex flex-wrap gap-4 text-[11px] text-text-muted rounded-lg border border-border bg-surface-2 px-4 py-3">
        <span>
          <strong className="text-text">As neg</strong> — acero longitudinal en compresión (soporte superior)
        </span>
        <span>
          <strong className="text-text">As pos</strong> — acero inferior en vano (≥ 50% As neg, NSR-10 C.18.6.3)
        </span>
        <span>
          <strong className="text-text">Estribos</strong> — {result.stirrup_bar}
        </span>
      </div>

      {/* Tabla agrupada por piso */}
      <div className="rounded-lg border border-border overflow-hidden max-h-[640px] overflow-y-auto">
        <BeamTableGrouped beams={result.beams} />
      </div>

      {/* Notas */}
      <div className="rounded-lg border border-border bg-surface-2 px-4 py-3">
        <p className="text-[10px] font-semibold text-text-muted uppercase tracking-wide mb-2">
          Metodología y limitaciones
        </p>
        <ul className="flex flex-col gap-1">
          {result.notes.map((note, i) => (
            <li key={i} className="text-[11px] text-text-muted flex gap-2">
              <span className="text-accent flex-shrink-0">·</span>
              {note}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
