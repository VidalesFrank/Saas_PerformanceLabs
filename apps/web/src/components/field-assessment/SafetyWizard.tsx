"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { fieldAssessmentApi } from "@/lib/field-assessment-api";
import type {
  Access,
  AccessCondition,
  ComponentDamageItem,
  DamageLevel,
  FieldAssessmentDTO,
  HazardCheck,
  HazardSeverity,
  StructuralSystem,
} from "@/lib/field-assessment-types";
import { PlacardBadge } from "./PlacardBadge";
import {
  COMPONENTS,
  DAMAGE_LEVELS,
  HAZARD_CATALOG,
  STRUCTURAL_SYSTEMS,
} from "./constants";

type Step = 1 | 2 | 3 | 4 | 5;
const STEPS = ["Identificación", "Datos del edificio", "Peligros y daño", "Fotos", "Placard"];

const emptyAccess: AccessCondition = {
  main_door: "ok", emergency_exits: "ok", stairs: "ok", elevator_out_of_service: false,
};

interface Props {
  assessment: FieldAssessmentDTO;
  onSaved: (a: FieldAssessmentDTO) => void;
}

export function SafetyWizard({ assessment, onSaved }: Props) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [assess, setAssess] = useState<FieldAssessmentDTO>(assessment);

  // ── Paso 1: Identificación (inspector + inspected_at) ──────────────────────
  const s = assess.safety_evaluation;
  const [inspectorName, setInspectorName] = useState(s?.inspector_name ?? "");
  const [inspectorId, setInspectorId]     = useState(s?.inspector_id ?? "");
  const [inspectorOrg, setInspectorOrg]   = useState(s?.inspector_org ?? "");
  const [inspectedAt, setInspectedAt]     = useState(
    s?.inspected_at?.slice(0, 16) ?? new Date().toISOString().slice(0, 16)
  );

  // ── Paso 2: Snapshot as-built ─────────────────────────────────────────────
  const snap = assess.snapshot;
  const [address, setAddress]         = useState(snap?.address_line ?? "");
  const [city, setCity]               = useState(snap?.city ?? "");
  const [lat, setLat]                 = useState<string>(snap?.latitude?.toString() ?? "");
  const [lon, setLon]                 = useState<string>(snap?.longitude?.toString() ?? "");
  const [year, setYear]               = useState<string>(snap?.year_built?.toString() ?? "");
  const [nStories, setNStories]       = useState<string>(snap?.n_stories_above?.toString() ?? "");
  const [totalHeight, setTotalHeight] = useState<string>(snap?.total_height_m?.toString() ?? "");
  const [system, setSystem]           = useState<StructuralSystem>(snap?.structural_system ?? "rc_frame");
  const [useNSR, setUseNSR]           = useState(snap?.occupancy_use_nsr10 ?? "II");
  const [hasAsBuilt, setHasAsBuilt]   = useState(snap?.has_asbuilt_docs ?? false);
  const [hasGeotech, setHasGeotech]   = useState(snap?.has_geotech_hazard ?? false);

  // ── Paso 3: Hazards + damage + access ────────────────────────────────────
  const [hazards, setHazards] = useState<Record<string, HazardCheck>>(() => {
    const map: Record<string, HazardCheck> = {};
    HAZARD_CATALOG.forEach(h => { map[h.code] = { code: h.code, response: "no" }; });
    s?.hazards?.checks?.forEach((c: HazardCheck) => { map[c.code] = c; });
    return map;
  });
  const [damage, setDamage] = useState<Record<string, DamageLevel>>(() => {
    const map: Record<string, DamageLevel> = {};
    COMPONENTS.forEach(c => { map[c.code] = "D0"; });
    s?.component_damage?.items?.forEach((it: ComponentDamageItem) => { map[it.component] = it.level; });
    return map;
  });
  const [pctAffected, setPctAffected] = useState<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    COMPONENTS.forEach(c => { map[c.code] = ""; });
    s?.component_damage?.items?.forEach((it: ComponentDamageItem) => {
      map[it.component] = it.pct_affected ? String(it.pct_affected) : "";
    });
    return map;
  });
  const [access, setAccess] = useState<AccessCondition>(s?.access_condition ?? emptyAccess);
  const [residualDrift, setResidualDrift] = useState<string>(
    s?.residual_drift_pct != null ? String(s.residual_drift_pct) : ""
  );

  // ── Paso 4: Fotos (upload en vivo) ─────────────────────────────────────
  const photos = assess.photos;

  // ── Paso 5: Override manual ───────────────────────────────────────────────
  const [manualOverride, setManualOverride] = useState<string>(s?.manual_override ?? "");
  const [overrideReason, setOverrideReason] = useState(s?.manual_override_reason ?? "");

  const placard = assess.safety_evaluation?.placard;
  const reasons = assess.safety_evaluation?.placard_reasons ?? [];

  // ── Guardado ───────────────────────────────────────────────────────────────

  async function saveSnapshot() {
    setSaving(true); setError(null);
    try {
      const r = await fieldAssessmentApi.saveSnapshot(assess.id, {
        address_line: address || null,
        city: city || null,
        latitude: lat ? parseFloat(lat) : null,
        longitude: lon ? parseFloat(lon) : null,
        year_built: year ? parseInt(year) : null,
        n_stories_above: nStories ? parseInt(nStories) : null,
        total_height_m: totalHeight ? parseFloat(totalHeight) : null,
        structural_system: system,
        occupancy_use_nsr10: useNSR,
        has_asbuilt_docs: hasAsBuilt,
        has_geotech_hazard: hasGeotech,
      });
      setAssess(r);
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Error al guardar snapshot");
      return false;
    } finally { setSaving(false); }
  }

  async function saveSafety() {
    setSaving(true); setError(null);
    try {
      const checks = Object.values(hazards).filter(h => h.response !== "no");
      const items: ComponentDamageItem[] = Object.entries(damage)
        .filter(([, lvl]) => lvl !== "D0" || pctAffected[Object.keys(damage).find(k => k)!])
        .map(([component, level]) => ({
          component, level,
          pct_affected: pctAffected[component] ? parseFloat(pctAffected[component]) : 0,
        }));
      const r = await fieldAssessmentApi.saveSafety(assess.id, {
        inspector_name: inspectorName || null,
        inspector_id: inspectorId || null,
        inspector_org: inspectorOrg || null,
        inspected_at: inspectedAt ? new Date(inspectedAt).toISOString() : null,
        hazards: { checks },
        component_damage: { items },
        access_condition: access,
        residual_drift_pct: residualDrift ? parseFloat(residualDrift) : null,
        manual_override: manualOverride || null,
        manual_override_reason: overrideReason || null,
      });
      setAssess(r);
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Error al guardar evaluación");
      return false;
    } finally { setSaving(false); }
  }

  async function goNext() {
    if (step === 2) { const ok = await saveSnapshot(); if (!ok) return; }
    if (step === 3 || step === 5) { const ok = await saveSafety(); if (!ok) return; }
    if (step < 5) setStep((step + 1) as Step);
    else { onSaved(assess); router.push(`/field-assessment/${assess.id}`); }
  }

  const stepIsValid = useMemo(() => {
    if (step === 1) return inspectorName.trim().length > 0;
    if (step === 2) return system.length > 0;
    return true;
  }, [step, inspectorName, system]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Stepper */}
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
                  }}
                >
                  {done ? "✓" : n}
                </div>
                <span className={`text-xs font-medium ${active ? "text-text" : "text-text-muted"}`}>{label}</span>
              </div>
              {i < STEPS.length - 1 && (
                <div className="mx-3 h-px w-12" style={{ background: done ? "#c2410c" : "var(--color-border)" }} />
              )}
            </div>
          );
        })}
      </div>

      {/* Contenido */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {step === 1 && (
          <div className="mx-auto flex max-w-xl flex-col gap-4">
            <h2 className="text-lg font-semibold">Identificación del inspector</h2>
            <div>
              <Label>Nombre inspector *</Label>
              <Input value={inspectorName} onChange={(e) => setInspectorName(e.target.value)} placeholder="Ing. Vidales Frank" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Matrícula profesional</Label>
                <Input value={inspectorId} onChange={(e) => setInspectorId(e.target.value)} />
              </div>
              <div>
                <Label>Entidad</Label>
                <Input value={inspectorOrg} onChange={(e) => setInspectorOrg(e.target.value)} placeholder="AIS / IDIGER / independiente" />
              </div>
            </div>
            <div>
              <Label>Fecha y hora de inspección</Label>
              <Input type="datetime-local" value={inspectedAt} onChange={(e) => setInspectedAt(e.target.value)} />
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <h2 className="text-lg font-semibold">Datos del edificio (as-built)</h2>
            <div>
              <Label>Dirección</Label>
              <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Cra 15 #45-12" />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Ciudad</Label>
                <Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Bogotá" />
              </div>
              <div>
                <Label>Lat</Label>
                <Input type="number" step="any" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="4.7110" />
              </div>
              <div>
                <Label>Lon</Label>
                <Input type="number" step="any" value={lon} onChange={(e) => setLon(e.target.value)} placeholder="-74.0721" />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Año</Label>
                <Input type="number" value={year} onChange={(e) => setYear(e.target.value)} placeholder="1998" />
              </div>
              <div>
                <Label>Pisos sobre rasante</Label>
                <Input type="number" value={nStories} onChange={(e) => setNStories(e.target.value)} placeholder="4" />
              </div>
              <div>
                <Label>Altura total (m)</Label>
                <Input type="number" step="any" value={totalHeight} onChange={(e) => setTotalHeight(e.target.value)} placeholder="12.0" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Sistema estructural *</Label>
                <select
                  value={system}
                  onChange={(e) => setSystem(e.target.value as StructuralSystem)}
                  className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text"
                >
                  {STRUCTURAL_SYSTEMS.map(s => (
                    <option key={s.code} value={s.code}>
                      {s.label}{s.covered ? "" : " (fuera de alcance FEMA v1)"}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label>Uso NSR-10</Label>
                <select
                  value={useNSR}
                  onChange={(e) => setUseNSR(e.target.value)}
                  className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text"
                >
                  {["I","II","III","IV"].map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
            </div>
            <div className="mt-2 flex flex-col gap-2 rounded-md bg-surface-2 p-4">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={hasAsBuilt} onChange={(e) => setHasAsBuilt(e.target.checked)} />
                Existen planos as-built confiables (afecta señal #1 FEMA)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={hasGeotech} onChange={(e) => setHasGeotech(e.target.checked)} />
                Sitio con amenaza geotécnica activa (licuación, deslizamiento)
              </label>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="flex flex-col gap-6">
            <div>
              <h2 className="text-lg font-semibold">Peligros visibles</h2>
              <p className="text-xs text-text-muted mt-1">Marca los peligros observados. Algunos aceptan severidad.</p>
              <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
                {HAZARD_CATALOG.map(h => {
                  const state = hazards[h.code];
                  return (
                    <div key={h.code} className="flex flex-col gap-1 rounded-md border border-border bg-surface p-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm text-text">{h.label}</span>
                        <div className="flex gap-1">
                          {(["no","yes","na"] as const).map(v => (
                            <button
                              key={v}
                              onClick={() => setHazards({ ...hazards, [h.code]: { ...state, response: v } })}
                              className="rounded px-2 py-1 text-xs font-medium"
                              style={{
                                background: state.response === v ? (v === "yes" ? "#fee2e2" : v === "no" ? "#dcfce7" : "var(--color-surface-2)") : "var(--color-surface-2)",
                                color: state.response === v ? (v === "yes" ? "#991b1b" : v === "no" ? "#166534" : "var(--color-text-muted)") : "var(--color-text-muted)",
                              }}
                            >{v === "yes" ? "Sí" : v === "no" ? "No" : "N/A"}</button>
                          ))}
                        </div>
                      </div>
                      {h.hasSeverity && state.response === "yes" && (
                        <div className="mt-1 flex gap-1">
                          {(["light","moderate","severe"] as const).map(sev => (
                            <button
                              key={sev}
                              onClick={() => setHazards({ ...hazards, [h.code]: { ...state, severity: sev as HazardSeverity } })}
                              className="rounded px-2 py-1 text-xs"
                              style={{
                                background: state.severity === sev ? "#c2410c" : "var(--color-surface-2)",
                                color: state.severity === sev ? "white" : "var(--color-text-muted)",
                              }}
                            >{sev === "light" ? "Ligera" : sev === "moderate" ? "Moderada" : "Severa"}</button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <h2 className="text-lg font-semibold">Daño por componente (EMS-98 / HAZUS)</h2>
              <div className="mt-3 overflow-x-auto rounded-md border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-surface-2 text-left text-xs text-text-muted">
                      <th className="p-2">Componente</th>
                      {DAMAGE_LEVELS.map(d => <th key={d.level} className="p-2 text-center" title={d.desc}>{d.label}</th>)}
                      <th className="p-2 text-right">% afectado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {COMPONENTS.map(c => (
                      <tr key={c.code} className="border-t border-border">
                        <td className="p-2">
                          {c.label}
                          {c.isStructural && <span className="ml-1 text-[10px] text-text-muted">(estructural)</span>}
                        </td>
                        {DAMAGE_LEVELS.map(d => (
                          <td key={d.level} className="p-2 text-center">
                            <input
                              type="radio"
                              name={`dmg-${c.code}`}
                              checked={damage[c.code] === d.level}
                              onChange={() => setDamage({ ...damage, [c.code]: d.level })}
                            />
                          </td>
                        ))}
                        <td className="p-2 text-right">
                          <Input
                            type="number" min="0" max="100"
                            value={pctAffected[c.code]}
                            onChange={(e) => setPctAffected({ ...pctAffected, [c.code]: e.target.value })}
                            className="!py-1 text-right"
                            placeholder="—"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="rounded-md border border-border bg-surface p-4">
                <h3 className="mb-2 text-sm font-semibold">Condición de accesos</h3>
                {[
                  ["main_door", "Puerta principal"],
                  ["emergency_exits", "Salidas de emergencia"],
                  ["stairs", "Escaleras"],
                ].map(([key, label]) => (
                  <div key={key} className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-sm text-text">{label}</span>
                    <select
                      value={access[key as keyof AccessCondition] as string}
                      onChange={(e) => setAccess({ ...access, [key]: e.target.value as Access })}
                      className="rounded-md border border-border bg-surface-2 px-2 py-1 text-xs"
                    >
                      <option value="ok">OK</option>
                      <option value="obstructed">Obstruidas</option>
                      <option value="damaged">Dañadas</option>
                      <option value="collapsed">Colapsadas</option>
                    </select>
                  </div>
                ))}
                <label className="mt-2 flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={access.elevator_out_of_service}
                    onChange={(e) => setAccess({ ...access, elevator_out_of_service: e.target.checked })} />
                  Ascensor fuera de servicio
                </label>
              </div>

              <div className="rounded-md border border-border bg-surface p-4">
                <h3 className="mb-2 text-sm font-semibold">Deriva residual</h3>
                <Label>Deriva residual medida (%)</Label>
                <Input
                  type="number" step="any" value={residualDrift}
                  onChange={(e) => setResidualDrift(e.target.value)}
                  placeholder="Opcional — dispara amarillo si &gt; 1 %, rojo si &gt; 3 %"
                />
              </div>
            </div>
          </div>
        )}

        {step === 4 && (
          <PhotosStep
            assessmentId={assess.id}
            photos={photos}
            onChange={(p) => setAssess({ ...assess, photos: p })}
          />
        )}

        {step === 5 && (
          <div className="mx-auto flex max-w-xl flex-col gap-4">
            <h2 className="text-lg font-semibold">Placard calculado</h2>
            {placard ? (
              <div className="rounded-lg border border-border bg-surface p-6 text-center">
                <PlacardBadge placard={placard} size="lg" />
                {reasons.length > 0 && (
                  <div className="mt-4 text-left">
                    <p className="text-xs font-medium uppercase text-text-muted">Razones</p>
                    <ul className="mt-1 list-inside list-disc text-sm text-text">
                      {reasons.map((r, i) => <li key={i}>{r}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-md bg-surface-2 p-6 text-center text-sm text-text-muted">
                Guarda el paso 3 para ver el placard calculado.
              </div>
            )}

            <div className="rounded-md border border-border bg-surface p-4">
              <Label>Override manual (solo escalar, nunca bajar)</Label>
              <div className="flex gap-2">
                {(["", "yellow", "red"] as const).map(v => (
                  <button
                    key={v}
                    onClick={() => setManualOverride(v)}
                    className="rounded-md border px-3 py-1 text-xs font-medium"
                    style={{
                      background: manualOverride === v ? "#c2410c" : "var(--color-surface-2)",
                      color: manualOverride === v ? "white" : "var(--color-text-muted)",
                      borderColor: "var(--color-border)",
                    }}
                  >{v === "" ? "Sin override" : v === "yellow" ? "🟡 Amarillo" : "🔴 Rojo"}</button>
                ))}
              </div>
              {manualOverride && (
                <div className="mt-2">
                  <Label>Justificación</Label>
                  <Input value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="Motivo del escalamiento" />
                </div>
              )}
            </div>
          </div>
        )}

        {error && <p className="mt-4 rounded bg-red-500/10 px-4 py-2 text-sm text-red-500">{error}</p>}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-border px-8 py-4">
        <Button variant="secondary" onClick={() => (step > 1 ? setStep((step - 1) as Step) : router.back())} disabled={saving}>
          {step === 1 ? "Cancelar" : "← Atrás"}
        </Button>
        <Button onClick={goNext} disabled={saving || !stepIsValid}>
          {saving ? "Guardando…" : step < 5 ? "Siguiente →" : "Finalizar inspección"}
        </Button>
      </div>
    </div>
  );
}

// ── Paso 4: Fotos (subcomponente) ─────────────────────────────────────────

function PhotosStep({
  assessmentId, photos, onChange,
}: {
  assessmentId: string;
  photos: FieldAssessmentDTO["photos"];
  onChange: (p: FieldAssessmentDTO["photos"]) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploading(true); setError(null);
    try {
      // Intento capturar GPS del dispositivo
      let lat: number | undefined, lon: number | undefined;
      try {
        const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
          navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 3000 })
        );
        lat = pos.coords.latitude; lon = pos.coords.longitude;
      } catch { /* sin permiso GPS, seguimos sin coords */ }

      const p = await fieldAssessmentApi.uploadPhoto(assessmentId, f, {
        latitude: lat, longitude: lon,
        taken_at: new Date().toISOString(),
      });
      onChange([...photos, p]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Error al subir foto");
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  async function handleDelete(photoId: string) {
    try {
      await fieldAssessmentApi.deletePhoto(assessmentId, photoId);
      onChange(photos.filter(p => p.id !== photoId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Error al eliminar foto");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Fotos georreferenciadas</h2>
        <p className="text-xs text-text-muted mt-1">
          Se intenta capturar el GPS del dispositivo automáticamente. Sube al menos una foto de fachada.
        </p>
      </div>

      <label className="flex cursor-pointer items-center justify-center rounded-md border-2 border-dashed border-border bg-surface p-8 hover:border-accent">
        <input type="file" accept="image/*" capture="environment" className="hidden" onChange={handleFile} disabled={uploading} />
        <span className="text-sm text-text-muted">
          {uploading ? "Subiendo…" : "+ Agregar foto (cámara o galería)"}
        </span>
      </label>

      {error && <p className="rounded bg-red-500/10 px-3 py-2 text-xs text-red-500">{error}</p>}

      {photos.length > 0 && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {photos.map(p => (
            <div key={p.id} className="relative rounded-md border border-border bg-surface p-2">
              <div className="text-xs text-text-muted break-all">{p.file_path.split(/[\\/]/).pop()}</div>
              {p.latitude != null && p.longitude != null && (
                <div className="mt-1 text-[10px] text-text-muted">
                  📍 {p.latitude.toFixed(5)}, {p.longitude.toFixed(5)}
                </div>
              )}
              <button
                onClick={() => handleDelete(p.id)}
                className="mt-2 w-full rounded bg-red-500/10 px-2 py-1 text-xs text-red-600 hover:bg-red-500/20"
              >Eliminar</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
