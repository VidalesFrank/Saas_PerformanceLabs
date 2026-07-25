export type Nivel = "free" | "pro" | "premium" | null;
export type Estado = "idea" | "en_desarrollo" | "listo";

export interface CatalogProduct {
  id: string;
  name: string;
  nivel: Nivel;
  estado: Estado;
  route: string | null;
}

export interface CatalogModule {
  id: string;
  name: string;
  products: CatalogProduct[];
}

export interface User {
  id: string;
  email: string;
  full_name: string;
  plan: "free" | "pro" | "premium";
  created_at: string;
}

export type ShapeType = "rectangular" | "square" | "circular" | "special";

export interface SectionCreatePayload {
  name: string;
  project_id?: string | null;
  shape_type: ShapeType;
  width?: number;
  height?: number;
  diameter?: number;
  vertices?: [number, number][];
  core_vertices?: [number, number][];
  cover: number;
  fpc: number;
  fy: number;
  es: number;
  hoop_bar_diameter?: number;
  hoop_spacing?: number;
  hoop_legs_x?: number;
  hoop_legs_y?: number;
  hoop_leg_area?: number;
  is_spiral?: boolean;
  n_bars_y?: number;
  n_bars_z?: number;
  n_bars?: number;
  bars?: [number, number][];
  bar_id: string;
  cover_to_bar_centroid?: number;
}

export interface SectionOut {
  id: string;
  name: string;
  project_id: string | null;
  shape_type: ShapeType;
  geometry: Record<string, unknown>;
  materials: Record<string, unknown>;
  reinforcement: Record<string, unknown>;
  cover: number;
  created_at: string;
}

export interface InteractionPoint {
  P: number;
  M: number;
}

export interface InteractionResultOut {
  id: string;
  section_id: string;
  points: InteractionPoint[];
  result_metadata: Record<string, number>;
  created_at: string;
}
