"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { PlacardBadge, PlacardDot } from "@/components/field-assessment/PlacardBadge";
import { fieldAssessmentApi } from "@/lib/field-assessment-api";
import type { FieldAssessmentDTO, Placard, TriageDecision } from "@/lib/field-assessment-types";
import { useRequireAuth } from "@/lib/use-require-auth";

type PlacardFilter = "all" | Placard;
type DecisionFilter = "all" | TriageDecision;

const DECISION_LABEL: Record<TriageDecision, string> = {
  low_risk: "Bajo",
  asce41_candidate: "Candidato ASCE 41",
  high_risk: "Precolapso",
  not_applicable: "No aplicable",
};

export default function FieldAssessmentListPage() {
  const ready = useRequireAuth();
  const router = useRouter();
  const [items, setItems] = useState<FieldAssessmentDTO[] | null>(null);
  const [placardFilter, setPlacardFilter] = useState<PlacardFilter>("all");
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>("all");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!ready) return;
    fieldAssessmentApi.list().then(setItems).catch(() => setItems([]));
  }, [ready]);

  async function createNew() {
    setCreating(true);
    try {
      const title = `Inspección ${new Date().toLocaleDateString("es-CO")}`;
      const a = await fieldAssessmentApi.create(title);
      router.push(`/field-assessment/${a.id}/edit`);
    } finally { setCreating(false); }
  }

  if (!ready) return null;

  const filtered = (items ?? []).filter(a => {
    if (placardFilter !== "all" && a.safety_evaluation?.placard !== placardFilter) return false;
    if (decisionFilter !== "all" && a.triage_result?.decision !== decisionFilter) return false;
    return true;
  });

  return (
    <div className="flex flex-1 flex-col">
      <AppHeader crumb="Triaje sísmico post-sismo" />
      <main className="flex-1 px-8 py-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-text">Inspecciones de campo</h1>
            <p className="mt-1 text-sm text-text-muted">
              Placard ATC-20 + Building Rating FEMA P-2018 sobre edificios inspeccionados tras un sismo.
            </p>
          </div>
          <Button onClick={createNew} disabled={creating}
            style={{ background: "#c2410c", color: "white" }}
          >{creating ? "Creando…" : "+ Nueva inspección"}</Button>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 rounded-md bg-surface-2 p-1">
            {(["all","green","yellow","red"] as PlacardFilter[]).map(f => (
              <button key={f}
                onClick={() => setPlacardFilter(f)}
                className="rounded px-3 py-1 text-xs font-medium"
                style={{
                  background: placardFilter === f ? "var(--color-surface)" : "transparent",
                  color: placardFilter === f ? "var(--color-text)" : "var(--color-text-muted)",
                }}>
                {f === "all" ? "Todos" : f === "green" ? "🟢 Verde" : f === "yellow" ? "🟡 Amarillo" : "🔴 Rojo"}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 rounded-md bg-surface-2 p-1">
            {(["all","low_risk","asce41_candidate","high_risk"] as DecisionFilter[]).map(f => (
              <button key={f}
                onClick={() => setDecisionFilter(f)}
                className="rounded px-3 py-1 text-xs font-medium"
                style={{
                  background: decisionFilter === f ? "var(--color-surface)" : "transparent",
                  color: decisionFilter === f ? "var(--color-text)" : "var(--color-text-muted)",
                }}>
                {f === "all" ? "Cualquier BR" : DECISION_LABEL[f as TriageDecision]}
              </button>
            ))}
          </div>
        </div>

        {items === null ? (
          <p className="text-sm text-text-muted">Cargando…</p>
        ) : filtered.length === 0 ? (
          <Card><CardBody className="text-center text-sm text-text-muted">
            {items.length === 0 ? "Aún no tienes inspecciones. Crea la primera con el botón de arriba." : "Ninguna inspección coincide con los filtros."}
          </CardBody></Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {filtered.map(a => (
              <Link key={a.id} href={`/field-assessment/${a.id}`}>
                <Card className="cursor-pointer transition-shadow hover:shadow-md">
                  <CardBody className="flex items-center gap-4">
                    {a.safety_evaluation?.placard ? (
                      <PlacardDot placard={a.safety_evaluation.placard} />
                    ) : (
                      <span className="inline-block h-2.5 w-2.5 rounded-full bg-text-muted opacity-30" />
                    )}
                    <div className="flex-1">
                      <div className="text-sm font-semibold text-text">{a.title}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-text-muted">
                        <span>{new Date(a.created_at).toLocaleDateString("es-CO")}</span>
                        {a.safety_evaluation?.inspector_name && <span>👤 {a.safety_evaluation.inspector_name}</span>}
                        {a.snapshot?.address_line && <span>📍 {a.snapshot.address_line}</span>}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      {a.safety_evaluation?.placard && <PlacardBadge placard={a.safety_evaluation.placard} size="sm" />}
                      {a.triage_result?.building_rating != null && (
                        <span className="text-xs text-text-muted">BR <strong className="text-text">{a.triage_result.building_rating.toFixed(2)}</strong></span>
                      )}
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
