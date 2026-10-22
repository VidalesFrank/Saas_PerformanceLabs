"use client";

import { useEffect, useState } from "react";
import { structuralEditorApi } from "@/lib/structural-api";

const G = 9.80665;

/**
 * Hook: devuelve el peso sísmico total del edificio W en kN.
 *
 * Fuente: suma `mass_x_t` de todos los pisos del canonical model y
 * multiplica por g = 9.80665 m/s². Para edificios regulares `mass_x_t`
 * ≈ `mass_y_t`, por lo que un solo valor de W aplica a ambas direcciones.
 *
 * Devuelve `null` mientras carga o si no hay masas. No lanza — simplemente
 * deshabilita la normalización Vb/W.
 */
export function useBuildingWeightKN(projectId: string | null | undefined): number | null {
  const [W, setW] = useState<number | null>(null);

  useEffect(() => {
    if (!projectId) { setW(null); return; }
    let cancelled = false;
    structuralEditorApi.modelData(projectId)
      .then((model) => {
        if (cancelled) return;
        const masses = model.masses ?? {};
        const totalTons = Object.values(masses).reduce(
          (acc, m) => acc + (Number(m.mass_x_t) || 0),
          0,
        );
        setW(totalTons > 0 ? totalTons * G : null);
      })
      .catch(() => { if (!cancelled) setW(null); });
    return () => { cancelled = true; };
  }, [projectId]);

  return W;
}
