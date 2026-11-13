"use client";

/*
 * Wireframe 3D del edificio showcase para el hero del dashboard.
 * Renderiza una torre de concreto con núcleo de muros, columnas perímetro,
 * vigas y losas. La cámara rota lentamente sobre sí misma para dar sensación
 * de producto "vivo" sin requerir interacción.
 *
 * Plotly se carga desde CDN (patrón del resto de la plataforma — evita
 * conflictos de SSR con Next.js). El fondo del scene es transparente para
 * que el gradient dark del hero lo atraviese.
 */

import { useEffect, useRef, useState } from "react";
import { generateHeroBuilding } from "@/lib/hero-building";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Window { Plotly: any; }
}

interface Props {
  /** Altura fija del contenedor (px). Default 420. */
  height?: number;
  /** Desactivar rotación automática (para debugging o preferencia de usuario). */
  spin?: boolean;
}

export function HeroShowcase3D({ height = 420, spin = true }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [plotlyReady, setPlotlyReady] = useState(false);
  const rafRef = useRef<number | null>(null);
  const angleRef = useRef(0);

  // Cargar Plotly desde CDN (compartido con el resto de componentes 3D)
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.Plotly) { setPlotlyReady(true); return; }
    const script = document.createElement("script");
    script.src = "https://cdn.plot.ly/plotly-2.35.2.min.js";
    script.onload = () => setPlotlyReady(true);
    document.head.appendChild(script);
  }, []);

  useEffect(() => {
    if (!plotlyReady || !containerRef.current) return;
    const Plotly = window.Plotly;
    const node = containerRef.current;
    const b = generateHeroBuilding();

    // ── Trazas ────────────────────────────────────────────────────────────
    // Orden visual: losas al fondo → vigas → arriostramientos → columnas →
    // núcleo de muros (encima). Colores extraídos de la paleta tech del CSS
    // para consistencia con el hero.
    const traces = [
      {
        type: "scatter3d",
        mode: "lines",
        name: "slabs",
        x: b.slabs.x, y: b.slabs.y, z: b.slabs.z,
        line: { color: "rgba(100, 116, 139, 0.35)", width: 1 },
        hoverinfo: "skip",
        showlegend: false,
      },
      {
        type: "scatter3d",
        mode: "lines",
        name: "beams",
        x: b.beams.x, y: b.beams.y, z: b.beams.z,
        line: { color: "rgba(96, 165, 250, 0.55)", width: 1.5 },
        hoverinfo: "skip",
        showlegend: false,
      },
      {
        type: "scatter3d",
        mode: "lines",
        name: "bracing",
        x: b.bracing.x, y: b.bracing.y, z: b.bracing.z,
        line: { color: "rgba(103, 232, 249, 0.55)", width: 1.2 },
        hoverinfo: "skip",
        showlegend: false,
      },
      {
        type: "scatter3d",
        mode: "lines",
        name: "columns",
        x: b.columns.x, y: b.columns.y, z: b.columns.z,
        line: { color: "rgba(34, 211, 238, 0.95)", width: 2.6 },
        hoverinfo: "skip",
        showlegend: false,
      },
      {
        type: "scatter3d",
        mode: "lines",
        name: "walls",
        x: b.walls.x, y: b.walls.y, z: b.walls.z,
        line: { color: "rgba(167, 139, 250, 0.85)", width: 2.0 },
        hoverinfo: "skip",
        showlegend: false,
      },
    ];

    // Ajuste de rango para encuadrar bien el edificio (vista vertical dominante)
    const halfX = b.footprintX / 2;
    const halfY = b.footprintY / 2;
    const ampX  = halfX * 1.6;
    const ampY  = halfY * 1.6;

    const layout = {
      autosize: true,
      margin: { l: 0, r: 0, t: 0, b: 0, pad: 0 },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor:  "rgba(0,0,0,0)",
      showlegend: false,
      scene: {
        aspectmode: "manual",
        aspectratio: { x: 1, y: 1, z: 2.1 },
        bgcolor: "rgba(0,0,0,0)",
        camera: {
          eye:    { x: 1.7, y: 1.7, z: 0.9 },
          center: { x: 0,   y: 0,   z: 0.1 },
          up:     { x: 0,   y: 0,   z: 1   },
        },
        xaxis: {
          visible: false, showgrid: false, zeroline: false, showticklabels: false,
          range: [-ampX, ampX], backgroundcolor: "rgba(0,0,0,0)",
        },
        yaxis: {
          visible: false, showgrid: false, zeroline: false, showticklabels: false,
          range: [-ampY, ampY], backgroundcolor: "rgba(0,0,0,0)",
        },
        zaxis: {
          visible: false, showgrid: false, zeroline: false, showticklabels: false,
          range: [-2, b.height + 4], backgroundcolor: "rgba(0,0,0,0)",
        },
      },
    };

    const config = {
      displayModeBar: false,
      responsive: true,
      staticPlot: true,  // no interactividad — es puramente decorativo
    };

    Plotly.newPlot(node, traces, layout, config);

    // ── Animación: rotación lenta de la cámara ────────────────────────────
    if (spin) {
      let last = performance.now();
      const tick = (now: number) => {
        const dt = (now - last) / 1000;
        last = now;
        // ~0.18 rad/s → una vuelta completa cada ~35 s. Suave.
        angleRef.current += dt * 0.18;
        const a = angleRef.current;
        const r = 2.4;  // distancia (eye)
        Plotly.relayout(node, {
          "scene.camera.eye.x": r * Math.cos(a),
          "scene.camera.eye.y": r * Math.sin(a),
          "scene.camera.eye.z": 0.75,
        });
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    }

    // ── Cleanup ───────────────────────────────────────────────────────────
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      try { Plotly.purge(node); } catch { /* noop */ }
    };
  }, [plotlyReady, spin]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height,
        position: "relative",
        // Glow sutil detrás del plot para que no se vea "plano" sobre el hero
        filter: "drop-shadow(0 20px 40px rgba(34, 211, 238, 0.18))",
      }}
      aria-hidden="true"
    />
  );
}
