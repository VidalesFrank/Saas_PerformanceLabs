/** Replica en TS la geometria de engine.sections (solo para la vista previa 2D; el
 * calculo real del diagrama de interaccion siempre lo hace el motor en Python). */

export interface BarPoint {
  y: number;
  z: number;
}

export function rectPerimeterBars(
  height: number,
  width: number,
  coverToBarCentroid: number,
  nBarsY: number,
  nBarsZ: number
): BarPoint[] {
  if (nBarsY < 2 || nBarsZ < 2) return [];
  const yOut = height / 2 - coverToBarCentroid;
  const zOut = width / 2 - coverToBarCentroid;
  const bars: BarPoint[] = [];

  for (let i = 0; i < nBarsY; i++) {
    const z = -zOut + (i * (2 * zOut)) / (nBarsY - 1);
    bars.push({ y: yOut, z });
    bars.push({ y: -yOut, z });
  }
  for (let i = 1; i < nBarsZ - 1; i++) {
    const y = -yOut + (i * (2 * yOut)) / (nBarsZ - 1);
    bars.push({ y, z: zOut });
    bars.push({ y, z: -zOut });
  }
  return bars;
}

export function circPerimeterBars(diameter: number, coverToBarCentroid: number, nBars: number): BarPoint[] {
  if (nBars < 4) return [];
  const radius = diameter / 2 - coverToBarCentroid;
  const bars: BarPoint[] = [];
  for (let i = 0; i < nBars; i++) {
    const theta = (2 * Math.PI * i) / nBars;
    bars.push({ y: radius * Math.cos(theta), z: radius * Math.sin(theta) });
  }
  return bars;
}
