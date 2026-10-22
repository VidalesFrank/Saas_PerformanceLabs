"use client";

import { useMemo, useState } from "react";
import type {
  NLPushoverResult, StructuralJob, WallDesignRow,
} from "@/lib/structural-types";
import NLPushoverPanel          from "./NLPushoverPanel";
import NLFramePushoverPanel     from "./NLFramePushoverPanel";
import UnifiedPushoverLauncher  from "./UnifiedPushoverLauncher";

interface Props {
  projectId:        string;
  activeJobTypes:   Set<string>;
  wallResult?:      NLPushoverResult | null;
  wallDesign?:      { designs: WallDesignRow[] } | null;
  hasFrameResult?:  boolean;
  hasWallDesign:    boolean;
  lastWallJobId?:   string | null;
  lastFrameJobId?:  string | null;
  onJobCompleted?:  (job: StructuralJob) => void;
}

type TabKey = "walls" | "frames";

export default function UnifiedPushoverPanel({
  projectId, activeJobTypes, wallResult, wallDesign,
  hasFrameResult, hasWallDesign,
  lastWallJobId, lastFrameJobId, onJobCompleted,
}: Props) {
  const availableTabs = useMemo<TabKey[]>(() => {
    const t: TabKey[] = [];
    if (wallResult)     t.push("walls");
    if (hasFrameResult) t.push("frames");
    return t;
  }, [wallResult, hasFrameResult]);

  const [tab, setTab] = useState<TabKey | null>(null);

  const activeTab: TabKey | null =
    tab && availableTabs.includes(tab) ? tab : availableTabs[0] ?? null;

  return (
    <div className="flex flex-col gap-5">
      {/* Launcher único con selección automática del sistema estructural.
          La decisión de habilitar/bloquear se hace dentro del launcher según
          el sistema detectado — pórticos no requieren diseño de muros. */}
      <UnifiedPushoverLauncher
        projectId={projectId}
        activeJobTypes={activeJobTypes}
        lastWallJobId={lastWallJobId}
        lastFrameJobId={lastFrameJobId}
        hasWallDesign={hasWallDesign}
        onCompleted={onJobCompleted}
      />

      {/* Resultados */}
      {availableTabs.length === 0 ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 text-center">
          <p className="text-sm text-[var(--text-muted)]">
            Aún no hay resultados de pushover. Configura y ejecuta arriba.
          </p>
        </div>
      ) : (
        <>
          {availableTabs.length > 1 && (
            <div className="flex items-center gap-1 border-b border-[var(--border)]">
              {availableTabs.map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={[
                    "px-4 py-2 text-xs font-semibold uppercase tracking-wider transition-colors border-b-2",
                    activeTab === t
                      ? "text-[var(--accent)] border-[var(--accent)]"
                      : "text-[var(--text-muted)] border-transparent hover:text-[var(--text)]",
                  ].join(" ")}
                >
                  {t === "walls" ? "Muros (MVLEM_3D)" : "Pórticos (fibras + rótulas)"}
                </button>
              ))}
            </div>
          )}

          {activeTab === "walls" && wallResult && (
            <NLPushoverPanel
              result={wallResult}
              projectId={projectId}
              wallDesign={wallDesign}
            />
          )}
          {activeTab === "frames" && hasFrameResult && (
            <NLFramePushoverPanel projectId={projectId} hideLauncher />
          )}
        </>
      )}
    </div>
  );
}
