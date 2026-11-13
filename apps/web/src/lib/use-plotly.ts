import { useEffect, useState } from "react";

/**
 * Hook compartido: devuelve `true` cuando `window.Plotly` está disponible,
 * y se encarga de inyectar el `<script>` CDN una única vez si aún no existe.
 *
 * Patrón usado antes de forma duplicada en ModelViewer3D, PushoverChart,
 * DeformedShape3D, etc. — ahora centralizado aquí (2026-11-04).
 *
 * Uso típico en paneles con Plotly:
 *     const plotlyReady = usePlotly();
 *     // En lugar de llamar los hooks con `result` crudo, gatekeepear con
 *     // plotlyReady para que los useEffect re-ejecuten cuando cargue:
 *     useRoofPlot(roofRef, plotlyReady ? result : null, ...);
 */
export function usePlotly(): boolean {
  const [ready, setReady] = useState<boolean>(() =>
    typeof window !== "undefined" &&
    !!(window as unknown as { Plotly?: unknown }).Plotly,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    if ((window as unknown as { Plotly?: unknown }).Plotly) {
      setReady(true);
      return;
    }

    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-plotly-cdn], script[data-plotly]',
    );
    if (existing) {
      existing.addEventListener("load", () => setReady(true));
      return;
    }

    const s = document.createElement("script");
    s.src = "https://cdn.plot.ly/plotly-2.35.2.min.js";
    s.async = true;
    s.setAttribute("data-plotly-cdn", "1");
    s.onload = () => setReady(true);
    document.head.appendChild(s);
  }, []);

  return ready;
}
