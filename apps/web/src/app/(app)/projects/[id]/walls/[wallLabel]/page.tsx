"use client";

import { use, useCallback, useEffect, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { ApiError } from "@/lib/api";
import { fetchWallDetail } from "@/lib/wall-api";
import type { WallDetailResponse } from "@/lib/wall-types";
import { useRequireAuth } from "@/lib/use-require-auth";
import WallDesignDetailView from "@/components/linear/WallDesignDetailView";

export default function WallDetailPage({
  params,
}: {
  params: Promise<{ id: string; wallLabel: string }>;
}) {
  const ready = useRequireAuth();
  const { id, wallLabel } = use(params);
  const label = decodeURIComponent(wallLabel);

  const [detail, setDetail] = useState<WallDetailResponse | null>(null);
  const [error, setError]   = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    fetchWallDetail(id, label)
      .then(setDetail)
      .catch(e => setError(e instanceof ApiError ? e.message : String(e)));
  }, [id, label]);

  useEffect(() => { if (ready) load(); }, [ready, load]);

  if (!ready) return null;

  return (
    <div className="flex flex-1 flex-col">
      <AppHeader crumb={`Proyecto · Muros · ${label}`} />
      <main className="flex-1 px-6 py-5">
        {error && (
          <div className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-500">
            {error}
          </div>
        )}

        {!detail && !error && (
          <div className="rounded-lg border border-dashed border-[var(--border)] px-6 py-10 text-center text-sm text-[var(--text-muted)]">
            Cargando detalle del muro…
          </div>
        )}

        {detail && (
          <WallDesignDetailView
            detail={detail}
            projectId={id}
            onReload={load}
          />
        )}
      </main>
    </div>
  );
}
