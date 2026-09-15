"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { fieldAssessmentApi, type TriagePayload } from "@/lib/field-assessment-api";
import type {
  ComponentInput,
  DamageLevel,
  Direction,
  ExceptionalFlagsInput,
  FieldAssessmentDTO,
  ShortcutInputPayload,
  StoryInputPayload,
} from "@/lib/field-assessment-types";
import { DAMAGE_LEVELS, STRUCTURAL_SYSTEMS } from "./constants";

type Step = 1 | 2 | 3 | 4 | 5;
const STEPS = ["Aplicabilidad", "Seis señales", "Atajos", "Pisos", "Resultado"];

interface Props { assessment: FieldAssessmentDTO }

const EXCEPTIONAL_FIELDS: Array<{ key: keyof ExceptionalFlagsInput; label: string }> = [
  { key: "no_asbuilt_docs",      label: "1. Sin información as-built confiable" },
  { key: "incomplete_load_path", label: "2. Trayectoria de carga incompleta (diafragmas, colectores)" },
  { key: "discontinuous_walls",  label: "3. Muros discontinuos sobre columnas o vigas" },
  { key: "exceptionally_weak",   label: "4. Edificio excepcionalmente débil" },
  { key: "extreme_torsion",      label: "5. Torsión extrema" },
];

export function TriageWizard({ assessment }: Props) {
  const router = useRouter();
  const [assess, setAssess] = useState(assessment);
  const [step, setStep] = useState<Step>(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const system = assess.snapshot?.structural_system;
  const covered = STRUCTURAL_SYSTEMS.find(s => s.code === system)?.covered ?? false;

  // Estado del formulario
  const existing = assess.triage_result;
  const [flags, setFlags] = useState<ExceptionalFlagsInput>(
    existing?.exceptional_flags ?? { geotech_hazard: assess.snapshot?.has_geotech_hazard, no_asbuilt_docs: !assess.snapshot?.has_asbuilt_docs }
  );
  const [separation, setSeparation] = useState<string>(existing?.exceptional_flags?.separation_mm?.toString() ?? "");
  const [minHeight, setMinHeight] = useState<string>(existing?.exceptional_flags?.shorter_building_height_m?.toString() ?? "");

  const [useShortcut, setUseShortcut] = useState(!!existing?.shortcut_applied);
  const [shortcut, setShortcut] = useState<ShortcutInputPayload>({});

  const [stories, setStories] = useState<StoryInputPayload[]>(existing?.stories ?? []);

  // ── Editor de pisos ────────────────────────────────────────────────────────

  function addStory(direction: Direction) {
    const idx = stories.filter(s => s.direction === direction).length + 1;
    setStories([...stories, { index: idx, height_m: 3.0, direction, components: [] }]);
  }
  function addComponent(sIdx: number, kind: "column" | "wall") {
    const s = { ...stories[sIdx] };
    s.components = [
      ...s.components,
      { tag: `${kind === "column" ? "C" : "W"}${s.components.length + 1}`, kind, delta_D: 1.0, delta_C_base: 1.5, damage: "D0" },
    ];
    const next = [...stories]; next[sIdx] = s; setStories(next);
  }
  function updateComponent(sIdx: number, cIdx: number, patch: Partial<ComponentInput>) {
    const next = [...stories];
    const s = { ...next[sIdx] };
    s.components = s.components.map((c, i) => i === cIdx ? { ...c, ...patch } : c);
    next[sIdx] = s; setStories(next);
  }
  function removeComponent(sIdx: number, cIdx: number) {
    const next = [...stories];
    const s = { ...next[sIdx] };
    s.components = s.components.filter((_, i) => i !== cIdx);
    next[sIdx] = s; setStories(next);
  }
  function removeStory(sIdx: number) { setStories(stories.filter((_, i) => i !== sIdx)); }

  async function calculate() {
    setSaving(true); setError(null);
    try {
      const payload: TriagePayload = {
        exceptional_flags: {
          ...flags,
          separation_mm: separation ? parseFloat(separation) : null,
          shorter_building_height_m: minHeight ? parseFloat(minHeight) : null,
        },
        stories,
        shortcut: useShortcut ? shortcut : null,
      };
      const r = await fieldAssessmentApi.runTriage(assess.id, payload);
      setAssess(r);
      setStep(5);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Error al calcular triaje");
    } finally { setSaving(false); }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const tr = assess.triage_result;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-0 border-b border-border px-8 py-4">
        {STEPS.map((label, i) => {
          const n = (i + 1) as Step;
          const active = step === n, done = step > n;
          return (
            <div key={n} className="flex items-center">
              <div className="flex items-center gap-2">
                <div
                  className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold"
                  style={{
                    background: done || active ? "#c2410c" : "var(--color-surface-2)",
                    color: done || active ? "white" : "var(--color-text-muted)",
                    boxShadow: active ? "0 0 0 3px #c2410c33" : "none",
                  }}>{done ? "✓" : n}</div>
                <span className={`text-xs font-medium ${active ? "text-text" : "text-text-muted"}`}>{label}</span>
              </div>
              {i < STEPS.length - 1 && <div className="mx-3 h-px w-12" style={{ background: done ? "#c2410c" : "var(--color-border)" }} />}
            </div>
          );
        })}
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-6">
        {step === 1 && (
          <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <h2 className="text-lg font-semibold">Aplicabilidad</h2>
            {!system ? (
              <div className="rounded-md bg-amber-100 p-4 text-sm text-amber-900">
                Aún no has definido el sistema estructural en la evaluación de seguridad. Completa el paso 2 del wizard ATC-20 primero.
              </div>
            ) : covered ? (
              <div className="rounded-md bg-emerald-50 p-4 text-sm text-emerald-900">
                ✓ Sistema {STRUCTURAL_SYSTEMS.find(s => s.code === system)?.label} cubierto por FEMA P-2018 v1.
              </div>
            ) : (
              <div className="rounded-md bg-red-50 p-4 text-sm text-red-900">
                Sistema {STRUCTURAL_SYSTEMS.find(s => s.code === system)?.label} <strong>no cubierto</strong> por esta versión. El triaje FEMA P-2018 v1 sólo aplica a concreto reforzado (pórtico, muro, dual, con relleno mampostería). Se requiere estudio aparte.
              </div>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <h2 className="text-lg font-semibold">Seis señales de riesgo excepcional</h2>
            <p className="text-xs text-text-muted">Si CUALQUIERA es SÍ, el BR se fuerza a alto y no se calculan pisos.</p>
            {EXCEPTIONAL_FIELDS.map(f => (
              <label key={String(f.key)} className="flex items-center justify-between gap-4 rounded-md border border-border bg-surface p-3">
                <span className="text-sm">{f.label}</span>
                <div className="flex gap-1">
                  {[false, true].map(v => (
                    <button
                      key={String(v)}
                      onClick={() => setFlags({ ...flags, [f.key]: v })}
                      className="rounded px-3 py-1 text-xs font-medium"
                      style={{
                        background: !!flags[f.key] === v ? (v ? "#fee2e2" : "#dcfce7") : "var(--color-surface-2)",
                        color: !!flags[f.key] === v ? (v ? "#991b1b" : "#166534") : "var(--color-text-muted)",
                      }}
                    >{v ? "SÍ" : "NO"}</button>
                  ))}
                </div>
              </label>
            ))}
            <div className="rounded-md border border-border bg-surface p-3">
              <div className="mb-1 text-sm font-medium">6. Pounding (edificio contiguo)</div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Separación entre edificios (mm)</Label>
                  <Input type="number" step="any" value={separation} onChange={(e) => setSeparation(e.target.value)} placeholder="Opcional" />
                </div>
                <div>
                  <Label>Altura del edificio más bajo (m)</Label>
                  <Input type="number" step="any" value={minHeight} onChange={(e) => setMinHeight(e.target.value)} placeholder="Opcional" />
                </div>
              </div>
              <p className="mt-1 text-[11px] text-text-muted">Si separación &lt; 1.5% × altura menor → pounding activo.</p>
            </div>
            <label className="flex items-center gap-2 rounded-md border border-border bg-surface p-3">
              <input type="checkbox" checked={!!flags.geotech_hazard}
                onChange={(e) => setFlags({ ...flags, geotech_hazard: e.target.checked })} />
              <span className="text-sm">Amenaza geotécnica del sitio (licuación, deslizamiento) — bloquea el cálculo detallado</span>
            </label>
          </div>
        )}

        {step === 3 && (
          <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <h2 className="text-lg font-semibold">Atajos de riesgo bajo (opcional)</h2>
            <p className="text-xs text-text-muted">Sólo disponibles si señales 3 y 5 son NO.</p>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={useShortcut} onChange={(e) => setUseShortcut(e.target.checked)} />
              <span className="text-sm">Intentar aplicar atajos</span>
            </label>
            {useShortcut && (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="rounded-md border border-border bg-surface p-3">
                  <h3 className="mb-2 text-sm font-semibold">Wall Strength Index (WSI)</h3>
                  <Label>Área muros dir. X (m²)</Label>
                  <Input type="number" step="any" onChange={(e) => setShortcut({ ...shortcut, area_walls_x_m2: parseFloat(e.target.value) || null })} />
                  <Label className="mt-2">Área muros dir. Y (m²)</Label>
                  <Input type="number" step="any" onChange={(e) => setShortcut({ ...shortcut, area_walls_y_m2: parseFloat(e.target.value) || null })} />
                  <Label className="mt-2">Peso sísmico (kN)</Label>
                  <Input type="number" step="any" onChange={(e) => setShortcut({ ...shortcut, seismic_weight_kN: parseFloat(e.target.value) || null })} />
                </div>
                <div className="rounded-md border border-border bg-surface p-3">
                  <h3 className="mb-2 text-sm font-semibold">Elástico global</h3>
                  <Label>Ratio δD/δC global</Label>
                  <Input type="number" step="any" onChange={(e) => setShortcut({ ...shortcut, global_ratio_D_over_C: parseFloat(e.target.value) || null })} />
                  <p className="mt-1 text-[11px] text-text-muted">Si &lt; 0.5, edificio esencialmente elástico.</p>
                </div>
              </div>
            )}
          </div>
        )}

        {step === 4 && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Cálculo por piso</h2>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => addStory("X")}>+ Piso dir. X</Button>
                <Button variant="secondary" onClick={() => addStory("Y")}>+ Piso dir. Y</Button>
              </div>
            </div>
            {stories.length === 0 && (
              <div className="rounded-md bg-surface-2 p-6 text-center text-sm text-text-muted">
                Agrega pisos por dirección. Cada piso lleva sus columnas y muros con δD demanda y δC capacidad.
              </div>
            )}
            {stories.map((s, sIdx) => (
              <div key={sIdx} className="rounded-md border border-border bg-surface p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <span className="rounded bg-surface-2 px-2 py-1 text-xs font-semibold">Piso {s.index} · {s.direction}</span>
                    <label className="flex items-center gap-1 text-xs">
                      h(m):
                      <Input type="number" step="any" value={s.height_m}
                        onChange={(e) => setStories(stories.map((x, i) => i === sIdx ? { ...x, height_m: parseFloat(e.target.value) || 0 } : x))}
                        className="!py-1 w-20" />
                    </label>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="secondary" onClick={() => addComponent(sIdx, "column")}>+ Columna</Button>
                    <Button variant="secondary" onClick={() => addComponent(sIdx, "wall")}>+ Muro</Button>
                    <Button variant="ghost" onClick={() => removeStory(sIdx)}>🗑 piso</Button>
                  </div>
                </div>
                {s.components.length > 0 && (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-text-muted">
                        <th className="p-1">Tag</th><th className="p-1">Tipo</th>
                        <th className="p-1">δD (%)</th><th className="p-1">δC_base (%)</th>
                        <th className="p-1">Daño</th><th className="p-1"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.components.map((c, cIdx) => (
                        <tr key={cIdx} className="border-t border-border">
                          <td className="p-1"><Input value={c.tag} onChange={(e) => updateComponent(sIdx, cIdx, { tag: e.target.value })} className="!py-1" /></td>
                          <td className="p-1">{c.kind === "column" ? "Columna" : "Muro"}</td>
                          <td className="p-1"><Input type="number" step="any" value={c.delta_D} onChange={(e) => updateComponent(sIdx, cIdx, { delta_D: parseFloat(e.target.value) || 0 })} className="!py-1" /></td>
                          <td className="p-1"><Input type="number" step="any" value={c.delta_C_base} onChange={(e) => updateComponent(sIdx, cIdx, { delta_C_base: parseFloat(e.target.value) || 0 })} className="!py-1" /></td>
                          <td className="p-1">
                            <select value={c.damage} onChange={(e) => updateComponent(sIdx, cIdx, { damage: e.target.value as DamageLevel })}
                              className="w-full rounded border border-border bg-surface-2 px-1 py-1 text-xs">
                              {DAMAGE_LEVELS.map(d => <option key={d.level} value={d.level}>{d.label}</option>)}
                            </select>
                          </td>
                          <td className="p-1"><button onClick={() => removeComponent(sIdx, cIdx)} className="text-red-500">✕</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </div>
        )}

        {step === 5 && tr && (
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            <h2 className="text-lg font-semibold">Resultado del triaje</h2>
            <div className="rounded-lg border border-border bg-surface p-6">
              <div className="mb-3 text-center">
                <div className="text-xs uppercase text-text-muted">Building Rating</div>
                <div className="mt-1 font-mono text-4xl font-bold" style={{
                  color: (tr.building_rating ?? 0) >= 0.7 ? "#991b1b" : (tr.building_rating ?? 0) > 0.3 ? "#92400e" : "#166534",
                }}>{tr.building_rating?.toFixed(2) ?? "—"}</div>
                <div className="mt-2 text-sm font-semibold" style={{
                  color: tr.decision === "high_risk" ? "#991b1b" : tr.decision === "asce41_candidate" ? "#92400e" : tr.decision === "low_risk" ? "#166534" : "var(--color-text-muted)",
                }}>
                  {tr.decision === "low_risk" && "🟢 Riesgo bajo — documentar y monitorear"}
                  {tr.decision === "asce41_candidate" && "🟠 Candidato a estudio de vulnerabilidad ASCE 41"}
                  {tr.decision === "high_risk" && "🔴 Riesgo excepcionalmente alto (precolapso)"}
                  {tr.decision === "not_applicable" && "⚪ Sistema no cubierto por esta versión"}
                </div>
              </div>
              <p className="text-sm text-text">{tr.decision_reason}</p>
              <div className="mt-4 rounded bg-amber-50 p-3 text-xs text-amber-900">
                ⚠ Este resultado NO crea automáticamente un proyecto en el Módulo 3. Si decides iniciar el estudio de vulnerabilidad, ábrelo manualmente desde /building.
              </div>
            </div>

            {tr.story_ratings && tr.story_ratings.length > 0 && (
              <div className="rounded-md border border-border bg-surface p-3">
                <h3 className="mb-2 text-sm font-semibold">Ratings por piso</h3>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-text-muted">
                      <th className="p-1">Piso</th><th className="p-1">Dir</th><th className="p-1">Nc</th><th className="p-1">Nw</th>
                      <th className="p-1">CR</th><th className="p-1">WR</th><th className="p-1">SR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tr.story_ratings.map((sr, i) => (
                      <tr key={i} className="border-t border-border">
                        <td className="p-1">{sr.index}</td><td className="p-1">{sr.direction}</td>
                        <td className="p-1">{sr.Nc}</td><td className="p-1">{sr.Nw}</td>
                        <td className="p-1">{sr.CR.toFixed(2)}</td>
                        <td className="p-1">{sr.WR.toFixed(2)}</td>
                        <td className="p-1 font-semibold">{sr.SR.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {error && <p className="mt-4 rounded bg-red-500/10 px-4 py-2 text-sm text-red-500">{error}</p>}
      </div>

      <div className="flex items-center justify-between border-t border-border px-8 py-4">
        <Button variant="secondary" onClick={() => (step > 1 ? setStep((step - 1) as Step) : router.back())} disabled={saving}>
          {step === 1 ? "Volver al detalle" : "← Atrás"}
        </Button>
        <div className="flex gap-2">
          {step === 5 && (
            <Button variant="secondary" onClick={() => router.push(`/field-assessment/${assess.id}`)}>Volver al detalle</Button>
          )}
          {step < 4 && covered && (
            <Button onClick={() => setStep((step + 1) as Step)} disabled={saving}>Siguiente →</Button>
          )}
          {step === 4 && (
            <Button onClick={calculate} disabled={saving || !covered}>
              {saving ? "Calculando…" : "Calcular BR"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
