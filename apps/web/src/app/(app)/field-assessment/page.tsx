"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EditableField } from "@/components/ui/editable-field";
import { PageHero } from "@/components/ui/page-hero";
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

function AssessmentCard({
  assessment: a,
  onUpdated,
  onDeleted,
}: {
  assessment: FieldAssessmentDTO;
  onUpdated: (updated: FieldAssessmentDTO) => void;
  onDeleted: (id: string) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function handleDelete() {
    await fieldAssessmentApi.remove(a.id);
    onDeleted(a.id);
    setConfirmOpen(false);
  }

  return (
    <Card className="group relative hover:shadow-[0_8px_24px_-12px_rgba(245,158,11,0.25)] hover:border-[color-mix(in_srgb,#f59e0b_45%,var(--color-border))]">
      <CardBody className="flex items-center gap-4">
        {a.safety_evaluation?.placard ? (
          <PlacardDot placard={a.safety_evaluation.placard} />
        ) : (
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-text-muted opacity-30" />
        )}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-text">
            <EditableField
              value={a.title}
              as="span"
              ariaLabel="Renombrar inspección"
              validate={(v) => (v.trim().length < 2 ? "Mínimo 2 caracteres" : null)}
              onSave={async (v) => {
                const updated = await fieldAssessmentApi.update(a.id, { title: v });
                onUpdated(updated);
              }}
            />
          </div>
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
        <div className="flex flex-col items-center gap-1">
          <Link
            href={`/field-assessment/${a.id}`}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:text-[#f59e0b]"
            aria-label="Abrir inspección"
            title="Abrir"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M13 5l7 7-7 7" />
            </svg>
          </Link>
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            aria-label="Eliminar inspección"
            title="Eliminar"
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted opacity-0 transition-[opacity,color,background] group-hover:opacity-100 hover:bg-[rgba(239,68,68,0.10)] hover:text-danger focus:opacity-100"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" />
              <path d="M19 6l-1.2 14a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8L5 6" />
              <path d="M10 11v6M14 11v6" />
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
            </svg>
          </button>
        </div>
      </CardBody>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={handleDelete}
        title="¿Eliminar esta inspección?"
        description={<>Vas a eliminar <strong className="text-text">«{a.title}»</strong>. Esta acción no se puede deshacer.</>}
        confirmLabel="Eliminar inspección"
        tone="danger"
      >
        <div className="rounded-lg border border-border bg-surface-2 px-3 py-2.5">
          <div className="mb-1.5 text-[10.5px] font-bold uppercase tracking-wider text-text-muted">
            Se perderá
          </div>
          <ul className="space-y-0.5 text-[12px] text-text">
            <li>· Snapshot del edificio y datos de campo</li>
            <li>· Evaluación de seguridad ATC-20 y fotos adjuntas</li>
            {a.triage_result && <li>· Building Rating FEMA P-2018 calculado</li>}
          </ul>
        </div>
      </ConfirmDialog>
    </Card>
  );
}

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
      <PageHero
        eyebrow="Campo · Triaje post-sismo"
        title="Inspecciones de campo"
        subtitle="Placard ATC-20 + Building Rating FEMA P-2018 sobre edificaciones inspeccionadas tras un evento sísmico."
        tone="amber"
        icon="clipboard"
        actions={
          <Button onClick={createNew} disabled={creating}>
            {creating ? "Creando…" : "+ Nueva inspección"}
          </Button>
        }
      />
      <main className="flex-1 px-8 py-6">

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
              <AssessmentCard
                key={a.id}
                assessment={a}
                onUpdated={(upd) => setItems(prev => prev?.map(x => x.id === upd.id ? upd : x) ?? null)}
                onDeleted={(id) => setItems(prev => prev?.filter(x => x.id !== id) ?? null)}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
