import { useMemo } from "react";
import type { PreviewRegion, PreviewBar } from "@/lib/section-document";
import type { RegionShape } from "@/lib/section-document";

interface Props {
  regions: PreviewRegion[];
  bars: PreviewBar[];
  size?: number;
}

// ── Generación de path SVG (coordenadas en mm mundo) ─────────────────────────

function shapePath(shape: RegionShape): string {
  if (shape.kind === "rect") {
    const { y, z, height: h, width: w } = shape;
    return `M ${z - w / 2} ${y - h / 2} h ${w} v ${h} h ${-w} Z`;
  }
  if (shape.kind === "circ") {
    const { y, z, radius: r, radius_inner: ri } = shape;
    const outer = `M ${z + r} ${y} A ${r} ${r} 0 1 0 ${z - r} ${y} A ${r} ${r} 0 1 0 ${z + r} ${y} Z`;
    if (ri > 0) {
      const inner = `M ${z + ri} ${y} A ${ri} ${ri} 0 1 1 ${z - ri} ${y} A ${ri} ${ri} 0 1 1 ${z + ri} ${y} Z`;
      return `${outer} ${inner}`;
    }
    return outer;
  }
  if (shape.vertices.length < 2) return "";
  const pts = shape.vertices.map(([vy, vz]) => `${vz} ${vy}`).join(" L ");
  return `M ${pts} Z`;
}

// ── Bounding box en coordenadas mundo ────────────────────────────────────────

function computeBounds(regions: PreviewRegion[], bars: PreviewBar[]) {
  const ys: number[] = [];
  const zs: number[] = [];

  for (const { shape } of regions) {
    if (shape.kind === "rect") {
      ys.push(shape.y - shape.height / 2, shape.y + shape.height / 2);
      zs.push(shape.z - shape.width / 2, shape.z + shape.width / 2);
    } else if (shape.kind === "circ") {
      ys.push(shape.y - shape.radius, shape.y + shape.radius);
      zs.push(shape.z - shape.radius, shape.z + shape.radius);
    } else {
      shape.vertices.forEach(([vy, vz]) => { ys.push(vy); zs.push(vz); });
    }
  }
  for (const b of bars) { ys.push(b.y); zs.push(b.z); }

  if (!ys.length) return null;
  return {
    minY: Math.min(...ys), maxY: Math.max(...ys),
    minZ: Math.min(...zs), maxZ: Math.max(...zs),
  };
}

// ── Componente ────────────────────────────────────────────────────────────────

export function SectionThumbnail({ regions, bars, size = 72 }: Props) {
  const transform = useMemo(() => {
    const bounds = computeBounds(regions, bars);
    if (!bounds) return null;

    const { minY, maxY, minZ, maxZ } = bounds;
    const dz = maxZ - minZ || 100;
    const dy = maxY - minY || 100;
    const pad = 6; // px padding
    const scale = Math.min((size - pad * 2) / dz, (size - pad * 2) / dy);
    const cx = (minZ + maxZ) / 2;
    const cy = (minY + maxY) / 2;
    // SVG: x→z, y→−y (flip vertical)
    const tx = size / 2 - cx * scale;
    const ty = size / 2 + cy * scale;
    return { scale, tx, ty };
  }, [regions, bars, size]);

  if (!transform && regions.length === 0 && bars.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-lg bg-[#0a1120] text-[10px] text-text-muted"
        style={{ width: size, height: size }}
      >
        vacío
      </div>
    );
  }

  const { scale, tx, ty } = transform ?? { scale: 1, tx: size / 2, ty: size / 2 };
  const sw = 1 / scale; // stroke width en mm para que quede 1px en pantalla

  return (
    <svg
      width={size}
      height={size}
      className="rounded-lg bg-[#0a1120] shrink-0"
      style={{ display: "block" }}
    >
      <g transform={`translate(${tx},${ty}) scale(${scale},${-scale})`}>
        {/* Regiones */}
        {regions.map((r, i) => (
          <path
            key={i}
            d={shapePath(r.shape)}
            fill={r.is_void ? "transparent" : "#4e8ab0"}
            fillOpacity={r.is_void ? 0 : 0.65}
            stroke={r.is_void ? "#2dd4e8" : "#2e6888"}
            strokeWidth={sw}
            fillRule="evenodd"
          />
        ))}
        {/* Barras */}
        {bars.map((b, i) => {
          const r = Math.max(8, sw * 4); // radio mínimo visible
          return (
            <circle
              key={i}
              cx={b.z}
              cy={b.y}
              r={r}
              fill="#f59e0b"
              fillOpacity={0.9}
              stroke="#92400e"
              strokeWidth={sw * 0.5}
            />
          );
        })}
      </g>
    </svg>
  );
}
