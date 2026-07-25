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
    const h = height ?? 0;
    const w = width ?? 0;
    return {
      extent: (Math.max(h, w, 1) / 2) * 1.15,
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

  const dimensionLabel =
    shapeType === "circular" && diameter
      ? `Ø${diameter} mm`
      : (shapeType === "rectangular" || shapeType === "square") && width && height
        ? `${width} × ${height} mm`
        : null;

  return (
    <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="rounded-md bg-surface-2">
      {/* Circular section */}
      {shapeType === "circular" && diameter && (
        <>
          <circle
            cx={CENTER} cy={CENTER}
            r={(diameter / 2) * scale}
            fill="var(--color-border)" fillOpacity={0.35}
            stroke="var(--color-border)" strokeWidth={2}
          />
          {cover > 0 && (
            <circle
              cx={CENTER} cy={CENTER}
              r={Math.max((diameter / 2 - cover) * scale, 0)}
              fill="var(--color-surface-2)" fillOpacity={0.6}
              stroke="var(--color-border)" strokeWidth={1}
              strokeDasharray="4,3"
            />
          )}
        </>
      )}

      {/* Rectangular / square section */}
      {shapeType !== "circular" && shapeType !== "special" && width && height && (
        <>
          <rect
            x={sx(-width / 2)} y={sy(height / 2)}
            width={width * scale} height={height * scale}
            fill="var(--color-border)" fillOpacity={0.35}
            stroke="var(--color-border)" strokeWidth={2}
          />
          {cover > 0 && width - 2 * cover > 0 && height - 2 * cover > 0 && (
            <rect
              x={sx(-(width / 2 - cover))} y={sy(height / 2 - cover)}
              width={(width - 2 * cover) * scale} height={(height - 2 * cover) * scale}
              fill="var(--color-surface-2)" fillOpacity={0.5}
              stroke="var(--color-border)" strokeWidth={1}
              strokeDasharray="4,3"
            />
          )}
        </>
      )}

      {/* Special polygon section */}
      {shapeType === "special" && outlinePoints && outlinePoints.length >= 3 && (
        <polygon
          points={outlinePoints.map(([y, z]) => `${sx(z)},${sy(y)}`).join(" ")}
          fill="var(--color-border)" fillOpacity={0.35}
          stroke="var(--color-border)" strokeWidth={2}
        />
      )}

      {/* Reinforcement bars */}
      {barPoints.map((b, i) => (
        <circle
          key={i}
          cx={sx(b.z)} cy={sy(b.y)} r={5}
          fill="var(--color-text)"
          stroke="var(--color-warning)" strokeWidth={1.5}
        />
      ))}

      {barPoints.length === 0 && (
        <text x={CENTER} y={CENTER + 4} textAnchor="middle" fill="var(--color-text-muted)" className="text-xs">
          Completa la geometría
        </text>
      )}

      {/* Dimension label */}
      {dimensionLabel && (
        <text
          x={CENTER} y={SIZE - 8}
          textAnchor="middle" fill="var(--color-text-muted)"
          fontSize={9} fontFamily="monospace"
        >
          {dimensionLabel}
        </text>
      )}
    </svg>
  );
}
