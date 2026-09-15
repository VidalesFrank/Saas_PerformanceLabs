"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { TriageWizard } from "@/components/field-assessment/TriageWizard";
import { fieldAssessmentApi } from "@/lib/field-assessment-api";
import type { FieldAssessmentDTO } from "@/lib/field-assessment-types";
import { useRequireAuth } from "@/lib/use-require-auth";

export default function TriagePage({ params }: { params: Promise<{ id: string }> }) {
  const ready = useRequireAuth();
  const { id } = use(params);
  const router = useRouter();
  const [assessment, setAssessment] = useState<FieldAssessmentDTO | null>(null);

  useEffect(() => {
    if (!ready) return;
    fieldAssessmentApi.get(id).then(setAssessment).catch(() => router.push("/field-assessment"));
  }, [id, ready, router]);

  if (!ready || !assessment) return null;

  return (
    <div className="flex min-h-screen flex-1 flex-col">
      <AppHeader crumb={`Triaje post-sismo · ${assessment.title} · Triaje FEMA`} />
      <TriageWizard assessment={assessment} />
    </div>
  );
}
