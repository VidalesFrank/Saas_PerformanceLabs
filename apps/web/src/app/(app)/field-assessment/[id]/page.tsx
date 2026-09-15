"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ApiError } from "@/lib/api";
import { fieldAssessmentApi } from "@/lib/field-assessment-api";
import type { FieldAssessmentDTO } from "@/lib/field-assessment-types";
import { useRequireAuth } from "@/lib/use-require-auth";
import { PlacardBadge } from "@/components/field-assessment/PlacardBadge";

export default function AssessmentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ready = useRequireAuth();
  const { id } = use(params);
  const router = useRouter();
  const [assessment, setAssessment] = useState<FieldAssessmentDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fieldAssessmentApi.get(id).then(setAssessment).catch((e) => setError(e instanceof ApiError ? e.message : "Error"));
  }, [id]);

  useEffect(() => { if (ready) load(); }, [ready, load]);

  async function handleDelete() {
    if (!confirm("¿Eliminar esta inspección y todos sus datos?")) return;
    await fieldAssessmentApi.remove(id);
    router.push("/field-assessment");
  }

  async function handleDeleteTriage() {
    if (!confirm("¿Eliminar el triaje FEMA (se conserva la evaluación de seguridad)?")) return;
    await fieldAssessmentApi.deleteTriage(id);
    load();
  }

  if (!ready || (!assessment && !error)) return null;
  if (error && !assessment) return (
    <div className="p-8"><p className="text-red-500">{error}</p></div>
  );
  const a = assessment!;
  const safety = a.safety_evaluation;
  const triage = a.triage_result;

  return (
    <div className="flex flex-1 flex-col">
      <AppHeader crumb={`Triaje post-sismo · ${a.title}`} />
      <main className="flex-1 px-8 py-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-text">{a.title}</h1>
            <p className="mt-1 text-xs text-text-muted">
              Creada {new Date(a.created_at).toLocaleString("es-CO")}
              {a.snapshot?.address_line && <> · 📍 {a.snapshot.address_line}</>}
            </p>
          </div>
          <div className="flex gap-2">
            <Link href="/field-assessment"><Button variant="ghost">← Volver</Button></Link>
            <Link href={`/field-assessment/${a.id}/edit`}><Button variant="secondary">✎ Editar inspección</Button></Link>
            <Button variant="ghost" onClick={handleDelete}>🗑 Eliminar</Button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* ── Tarjeta A: safety ATC-20 ─────────────────────────────── */}
          <Card>
            <CardHeader className="flex items-center justify-between">
              <div>
                <div className="text-xs uppercase text-text-muted">Sub-flujo A</div>
                <div className="text-base font-semibold">Evaluación rápida ATC-20 / AIS-IDIGER</div>
              </div>
              {safety?.placard && <PlacardBadge placard={safety.placard} size="sm" />}
            </CardHeader>
            <CardBody>
              {safety?.placard ? (
                <>
                  <PlacardBadge placard={safety.placard} size="lg" />
                  {safety.placard_reasons && safety.placard_reasons.length > 0 && (
                    <div className="mt-4">
                      <div className="text-xs font-medium uppercase text-text-muted">Razones ({safety.placard_reasons.length})</div>
                      <ul className="mt-1 list-inside list-disc text-sm text-text">
                        {safety.placard_reasons.slice(0, 4).map((r, i) => <li key={i}>{r}</li>)}
                        {safety.placard_reasons.length > 4 && <li className="text-text-muted">… y {safety.placard_reasons.length - 4} más</li>}
                      </ul>
                    </div>
                  )}
                  {safety.restrictions && safety.restrictions.length > 0 && (
                    <div className="mt-3 rounded-md bg-surface-2 p-3">
                      <div className="text-xs font-medium uppercase text-text-muted">Restricciones sugeridas</div>
                      <ul className="mt-1 list-inside list-disc text-sm text-text">
                        {safety.restrictions.map((r, i) => <li key={i}>{r}</li>)}
                      </ul>
                    </div>
                  )}
                </>
              ) : (
                <div className="rounded-md bg-surface-2 p-6 text-center text-sm text-text-muted">
                  Sin evaluación aún. <Link href={`/field-assessment/${a.id}/edit`} className="text-accent underline">Completar</Link>
                </div>
              )}
              {a.photos.length > 0 && (
                <div className="mt-4">
                  <div className="text-xs font-medium uppercase text-text-muted">{a.photos.length} fotos</div>
                </div>
              )}
            </CardBody>
          </Card>

          {/* ── Tarjeta B: triaje FEMA ─────────────────────────────── */}
          <Card>
            <CardHeader className="flex items-center justify-between">
              <div>
                <div className="text-xs uppercase text-text-muted">Sub-flujo B</div>
                <div className="text-base font-semibold">Triaje FEMA P-2018</div>
              </div>
              {triage?.building_rating != null && (
                <div className="font-mono text-2xl font-bold" style={{
                  color: triage.decision === "high_risk" ? "#991b1b" : triage.decision === "asce41_candidate" ? "#92400e" : triage.decision === "low_risk" ? "#166534" : "var(--color-text-muted)",
                }}>{triage.building_rating.toFixed(2)}</div>
              )}
            </CardHeader>
            <CardBody>
              {triage ? (
                <>
                  <div className="text-sm">
                    <div className="font-semibold" style={{
                      color: triage.decision === "high_risk" ? "#991b1b" : triage.decision === "asce41_candidate" ? "#92400e" : triage.decision === "low_risk" ? "#166534" : "var(--color-text-muted)",
                    }}>
                      {triage.decision === "low_risk" && "🟢 Riesgo bajo"}
                      {triage.decision === "asce41_candidate" && "🟠 Candidato a estudio ASCE 41"}
                      {triage.decision === "high_risk" && "🔴 Riesgo excepcionalmente alto"}
                      {triage.decision === "not_applicable" && "⚪ Sistema no cubierto"}
                    </div>
                    <p className="mt-1 text-text-muted">{triage.decision_reason}</p>
                  </div>
                  {triage.decision !== "not_applicable" && (
                    <div className="mt-3 rounded-md bg-amber-50 p-3 text-xs text-amber-900">
                      ⚠ No se crea automáticamente un proyecto en el Módulo 3. Ábrelo manualmente desde /building si decides el estudio de vulnerabilidad.
                    </div>
                  )}
                  <div className="mt-3 flex gap-2">
                    <Link href={`/field-assessment/${a.id}/triage`}>
                      <Button variant="secondary">Recalcular triaje</Button>
                    </Link>
                    <Button variant="ghost" onClick={handleDeleteTriage}>Eliminar triaje</Button>
                  </div>
                </>
              ) : (
                <div className="rounded-md bg-surface-2 p-6 text-center text-sm text-text-muted">
                  <p>Aún no calculas el triaje FEMA. Requiere el sistema estructural definido en la evaluación de seguridad.</p>
                  <Link href={`/field-assessment/${a.id}/triage`} className="mt-3 inline-block">
                    <Button style={{ background: "#c2410c", color: "white" }}>Iniciar triaje FEMA</Button>
                  </Link>
                </div>
              )}
            </CardBody>
          </Card>
        </div>
      </main>
    </div>
  );
}
