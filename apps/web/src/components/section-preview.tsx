"use client";

import { useMemo } from "react";
import type { ShapeType } from "@/lib/types";
import { circPerimeterBars, rectPerimeterBars, type BarPoint } from "@/lib/section-preview";

const SIZE = 280;
const CENTER = SIZE / 2;
const PADDING = 28;

interface SectionPreviewProps {
  shapeType: ShapeType;
  width?: number;
  height?: number;
  diameter?: number;
  cover: number;
  coverToBarCentroid?: number;
  nBarsY?: number;
  nBarsZ?: number;
  nBars?: number;
  vertices?: [number, number][];
  bars?: [number, number][];
}

export function SectionPreview(props: SectionPreviewProps) {
  const { shapeType, width, height, diameter, cover, coverToBarCentroid, nBarsY, nBarsZ, nBars, vertices, bars } =
    props;

  const { extent, barPoints, outlinePoints } = useMemo(() => {
    if (shapeType === "circular" && diameter) {
      return {
        extent: (diameter / 2) * 1.15,
        barPoints: nBars && coverToBarCentroid ? circPerimeterBars(diameter, coverToBarCentroid, nBars) : [],
        outlinePoints: null as [number, number][] | null,
      };
    }
    if (shapeType === "special" && vertices && vertices.length >= 3) {
      const maxAbs = Math.max(...vertices.flatMap(([y, z]) => [Math.abs(y), Math.abs(z)]), 1);
      return {
        extent: maxAbs * 1.15,
        barPoints: (bars ?? []).map(([y, z]) => ({ y, z }) as BarPoint),
        outlinePoints: vertices,
      };
    }
    // rectangular / square
    const h = height ?? 0;
    const w = width ?? 0;
    return {
      extent: Math.max(h, w, 1) / 2 * 1.15,
      barPoints:
        h && w && nBarsY && nBarsZ && coverToBarCentroid
          ? rectPerimeterBars(h, w, coverToBarCentroid, nBarsY, nBarsZ)
          : [],
      outlinePoints: null as [number, number][] | null,
    };
  }, [shapeType, width, height, diameter, nBars, nBarsY, nBarsZ, coverToBarCentroid, vertices, bars]);

  const scale = (CENTER - PADDING) / (extent || 1);
  const sx = (z: number) => CENTER + z * scale;
  const sy = (y: number) => CENTER - y * scale;

  return (
    <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="rounded-md bg-surface-2">
      {shapeType === "circular" && diameter && (
        <>
          <circle cx={CENTER} cy={CENTER} r={(diameter / 2) * scale} fill="none" stroke="var(--color-border)" strokeWidth={2} />
          {cover > 0 && (
            <circle
              cx={CENTER}
              cy={CENTER}
              r={Math.max((diameter / 2 - cover) * scale, 0)}
              fill="none"
              stroke="var(--color-border)"
              strokeWidth={1}
              strokeDasharray="4,3"
            />
          )}
        </>
      )}

      {shapeType !== "circular" && shapeType !== "special" && width && height && (
        <>
          <rect
            x={sx(-width / 2)}
            y={sy(height / 2)}
            width={width * scale}
            height={height * scale}
            fill="none"
            stroke="var(--color-border)"
            strokeWidth={2}
          />
          {cover > 0 && width - 2 * cover > 0 && height - 2 * cover > 0 && (
            <rect
              x={sx(-(width / 2 - cover))}
              y={sy(height / 2 - cover)}
              width={(width - 2 * cover) * scale}
              height={(height - 2 * cover) * scale}
              fill="none"
              stroke="var(--color-border)"
              strokeWidth={1}
              strokeDasharray="4,3"
            />
          )}
        </>
      )}

      {shapeType === "special" && outlinePoints && outlinePoints.length >= 3 && (
        <polygon
          points={outlinePoints.map(([y, z]) => `${sx(z)},${sy(y)}`).join(" ")}
          fill="none"
          stroke="var(--color-border)"
          strokeWidth={2}
        />
      )}

      {barPoints.map((b, i) => (
        <circle key={i} cx={sx(b.z)} cy={sy(b.y)} r={4} fill="var(--color-warning)" />
      ))}

      {barPoints.length === 0 && (
        <text x={CENTER} y={CENTER} textAnchor="middle" fill="var(--color-text-muted)" className="text-xs">
          Completa la geometria
        </text>
      )}
    </svg>
  );
}
