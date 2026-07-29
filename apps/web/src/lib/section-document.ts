// Tipos del Módulo 2 v2 — Section Engineering
// Espejo exacto del modelo Python SectionDocument del engine.
// Unidades: mm, MPa (internas del motor).

// ── Constantes de barras ──────────────────────────────────────────────────────

export const BAR_SIZES = ["#3", "#4", "#5", "#6", "#7", "#8", "#9", "#10", "#11"] as const;
export type BarSize = typeof BAR_SIZES[number];

export const BAR_AREAS_MM2: Record<BarSize, number> = {
  "#3": 71,  "#4": 129, "#5": 199, "#6": 284,  "#7": 387,
  "#8": 510, "#9": 645, "#10": 819, "#11": 1006,
};

export const BAR_DIAMETERS_MM: Record<BarSize, number> = {
  "#3": 9.525, "#4": 12.70, "#5": 15.875, "#6": 19.05,  "#7": 22.225,
  "#8": 25.40, "#9": 28.65, "#10": 32.26, "#11": 35.81,
};

// ── Formas de región ──────────────────────────────────────────────────────────

export interface RectShape {
  kind: "rect";
  y: number;          // centroide mm
  z: number;
  height: number;     // dimensión en y, mm
  width: number;      // dimensión en z, mm
  angle_deg: number;  // rotación en grados
}

export interface CircShape {
  kind: "circ";
  y: number;            // centro mm
  z: number;
  radius: number;       // radio exterior mm
  radius_inner: number; // radio interior (0 = sólido)
}

export interface PolygonShape {
  kind: "poly";
  vertices: [number, number][]; // (y, z) mm
}

export type RegionShape = RectShape | CircShape | PolygonShape;

// ── Confinamiento ─────────────────────────────────────────────────────────────

export interface RectConfinementDef {
  kind: "rect";
  hoop_bar_size: BarSize;
  spacing: number;    // mm c/c
  legs_x: number;
  legs_y: number;
  fyh: number | null; // null = usar fy del acero principal
}

export interface CircConfinementDef {
  kind: "circ";
  hoop_bar_size: BarSize;
  spacing: number;
  is_spiral: boolean;
  fyh: number | null;
}

export type ConfinementDef = RectConfinementDef | CircConfinementDef;

// ── Materiales ────────────────────────────────────────────────────────────────

export interface ConcreteDef {
  id: string;
  label: string;
  fpc: number;  // MPa
  eco: number;  // deformación en pico
}

export interface SteelDef {
  id: string;
  label: string;
  fy: number;   // MPa
  Es: number;   // MPa
  b: number;    // endurecimiento
}

// ── Elementos de la sección ───────────────────────────────────────────────────

export interface ConcreteRegion {
  id: string;
  label: string;
  shape: RegionShape;
  concrete_id: string;
  confinement: ConfinementDef | null;
  cover_to_bar: number;  // mm
  is_void: boolean;
  core_polygon: [number, number][] | null;
}

export interface ReinforcementBar {
  id: string;
  y: number;       // mm
  z: number;       // mm
  bar_size: BarSize;
  steel_id: string;
}

// ── Documento principal ───────────────────────────────────────────────────────

export interface SectionDocument {
  schema_version: number;
  concrete_defs: ConcreteDef[];
  steel_defs: SteelDef[];
  regions: ConcreteRegion[];
  bars: ReinforcementBar[];
}

export interface SectionRecord {
  id: string;
  name: string;
  description: string | null;
  document: SectionDocument;
  schema_version: number;
  created_at: string;
  updated_at: string;
}

export interface PreviewBar { y: number; z: number; bar_size: BarSize }
export interface PreviewRegion { shape: RegionShape; is_void: boolean }

export interface SectionSummary {
  id: string;
  name: string;
  description: string | null;
  n_regions: number;
  n_bars: number;
  schema_version: number;
  created_at: string;
  updated_at: string;
  preview?: { regions: PreviewRegion[]; bars: PreviewBar[] };
}

// ── Propiedades derivadas (cálculos en TS) ────────────────────────────────────

export function sectionGrossArea(doc: SectionDocument): number {
  return doc.regions.reduce((sum, r) => {
    const a = regionArea(r.shape);
    return sum + (r.is_void ? -a : a);
  }, 0);
}

export function sectionSteelArea(doc: SectionDocument): number {
  return doc.bars.reduce((sum, b) => sum + (BAR_AREAS_MM2[b.bar_size] ?? 0), 0);
}

export function sectionDepth(doc: SectionDocument): number {
  const ys = allVertices(doc).map(([y]) => y);
  if (!ys.length) return 0;
  return Math.max(...ys) - Math.min(...ys);
}

export function sectionWidth(doc: SectionDocument): number {
  const zs = allVertices(doc).map(([, z]) => z);
  if (!zs.length) return 0;
  return Math.max(...zs) - Math.min(...zs);
}

function regionArea(shape: RegionShape): number {
  if (shape.kind === "rect") return shape.height * shape.width;
  if (shape.kind === "circ")
    return Math.PI * (shape.radius ** 2 - shape.radius_inner ** 2);
  return polygonArea(shape.vertices);
}

function polygonArea(verts: [number, number][]): number {
  let area = 0;
  const n = verts.length;
  for (let i = 0; i < n; i++) {
    const [y1, z1] = verts[i];
    const [y2, z2] = verts[(i + 1) % n];
    area += y1 * z2 - y2 * z1;
  }
  return Math.abs(area) / 2;
}

function allVertices(doc: SectionDocument): [number, number][] {
  const pts: [number, number][] = [];
  for (const r of doc.regions) {
    if (r.shape.kind === "rect") {
      const { y, z, height: h, width: w } = r.shape;
      pts.push([y - h / 2, z - w / 2], [y + h / 2, z + w / 2]);
    } else if (r.shape.kind === "circ") {
      pts.push(
        [r.shape.y - r.shape.radius, r.shape.z - r.shape.radius],
        [r.shape.y + r.shape.radius, r.shape.z + r.shape.radius],
      );
    } else {
      pts.push(...r.shape.vertices);
    }
  }
  return pts;
}

// ── Generadores de patrones de barras ─────────────────────────────────────────

export function generateRectPerimeterBars(
  height: number, width: number,
  coverToBar: number,
  nBarsY: number, nBarsZ: number,
  barSize: BarSize, steelId: string,
): ReinforcementBar[] {
  if (nBarsY < 2 || nBarsZ < 2) return [];
  const hh = height / 2 - coverToBar;
  const hw = width / 2 - coverToBar;
  const bars: ReinforcementBar[] = [];

  for (let i = 0; i < nBarsY; i++) {
    const z = nBarsY > 1 ? -hw + i * (2 * hw) / (nBarsY - 1) : 0;
    bars.push(newBar(hh, z, barSize, steelId));
    bars.push(newBar(-hh, z, barSize, steelId));
  }
  for (let i = 1; i < nBarsZ - 1; i++) {
    const y = -hh + i * (2 * hh) / (nBarsZ - 1);
    bars.push(newBar(y, hw, barSize, steelId));
    bars.push(newBar(y, -hw, barSize, steelId));
  }
  return bars;
}

export function generateCircPerimeterBars(
  radius: number, coverToBar: number,
  nBars: number, barSize: BarSize, steelId: string,
): ReinforcementBar[] {
  if (nBars < 4) return [];
  const r = radius - coverToBar;
  return Array.from({ length: nBars }, (_, i) => {
    const theta = (2 * Math.PI * i) / nBars;
    return newBar(r * Math.cos(theta), r * Math.sin(theta), barSize, steelId);
  });
}

export function generateLineBars(
  y1: number, z1: number, y2: number, z2: number,
  nBars: number, barSize: BarSize, steelId: string,
): ReinforcementBar[] {
  if (nBars < 2) return [newBar((y1 + y2) / 2, (z1 + z2) / 2, barSize, steelId)];
  return Array.from({ length: nBars }, (_, i) => {
    const t = i / (nBars - 1);
    return newBar(y1 + t * (y2 - y1), z1 + t * (z2 - z1), barSize, steelId);
  });
}

function newBar(y: number, z: number, bar_size: BarSize, steel_id: string): ReinforcementBar {
  return { id: uid(), y, z, bar_size, steel_id };
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ── Documento vacío por defecto ───────────────────────────────────────────────

export function defaultDocument(): SectionDocument {
  const cid = uid();
  const sid = uid();
  return {
    schema_version: 1,
    concrete_defs: [{ id: cid, label: "Concreto f'c=28 MPa", fpc: 28, eco: 0.002 }],
    steel_defs: [{ id: sid, label: "Acero fy=420 MPa", fy: 420, Es: 200000, b: 0.01 }],
    regions: [],
    bars: [],
  };
}
