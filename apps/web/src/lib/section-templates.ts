/**
 * Plantillas de secciones transversales estándar.
 * Cada plantilla genera un SectionDocument listo para abrir en el editor.
 */
import type { SectionDocument, ConcreteRegion, ReinforcementBar } from "./section-document";
import { uid, generateRectPerimeterBars, generateCircPerimeterBars } from "./section-document";

function concreteDef(fpc = 28) {
  return { id: uid(), label: `f'c = ${fpc} MPa`, fpc, eco: 0.002 };
}

function steelDef(fy = 420) {
  return { id: uid(), label: `fy = ${fy} MPa`, fy, Es: 200000, b: 0.01 };
}

export interface SectionTemplate {
  id: string;
  name: string;
  description: string;
  category: "columna" | "viga" | "muro" | "pila";
  generate: () => SectionDocument;
}

export const SECTION_TEMPLATES: SectionTemplate[] = [
  // ── Columnas rectangulares ─────────────────────────────────────────────────
  {
    id: "col-rect-400",
    name: "Columna 400×400",
    description: "Columna cuadrada 400×400 mm, 8-#8, f'c=28, fy=420",
    category: "columna",
    generate: () => {
      const c = concreteDef(28);
      const s = steelDef(420);
      const region: ConcreteRegion = {
        id: uid(), label: "Columna",
        shape: { kind: "rect", y: 0, z: 0, height: 400, width: 400, angle_deg: 0 },
        concrete_id: c.id,
        confinement: { kind: "rect", hoop_bar_size: "#3", spacing: 150, legs_x: 2, legs_y: 2, fyh: 420 },
        cover_to_bar: 52,
        is_void: false, core_polygon: null,
      };
      const bars = generateRectPerimeterBars(400, 400, 52, 3, 3, "#8", s.id);
      return { schema_version: 1, concrete_defs: [c], steel_defs: [s], regions: [region], bars };
    },
  },
  {
    id: "col-rect-500",
    name: "Columna 500×500",
    description: "Columna cuadrada 500×500 mm, 12-#8, f'c=28, fy=420",
    category: "columna",
    generate: () => {
      const c = concreteDef(28);
      const s = steelDef(420);
      const region: ConcreteRegion = {
        id: uid(), label: "Columna",
        shape: { kind: "rect", y: 0, z: 0, height: 500, width: 500, angle_deg: 0 },
        concrete_id: c.id,
        confinement: { kind: "rect", hoop_bar_size: "#3", spacing: 100, legs_x: 3, legs_y: 3, fyh: 420 },
        cover_to_bar: 60,
        is_void: false, core_polygon: null,
      };
      const bars = generateRectPerimeterBars(500, 500, 60, 4, 4, "#8", s.id);
      return { schema_version: 1, concrete_defs: [c], steel_defs: [s], regions: [region], bars };
    },
  },
  {
    id: "col-rect-600x400",
    name: "Columna 600×400",
    description: "Columna rectangular 600×400 mm, 10-#8, f'c=28, fy=420",
    category: "columna",
    generate: () => {
      const c = concreteDef(28);
      const s = steelDef(420);
      const region: ConcreteRegion = {
        id: uid(), label: "Columna",
        shape: { kind: "rect", y: 0, z: 0, height: 600, width: 400, angle_deg: 0 },
        concrete_id: c.id,
        confinement: { kind: "rect", hoop_bar_size: "#3", spacing: 120, legs_x: 2, legs_y: 3, fyh: 420 },
        cover_to_bar: 55,
        is_void: false, core_polygon: null,
      };
      const bars = generateRectPerimeterBars(600, 400, 55, 4, 3, "#8", s.id);
      return { schema_version: 1, concrete_defs: [c], steel_defs: [s], regions: [region], bars };
    },
  },

  // ── Columnas circulares ────────────────────────────────────────────────────
  {
    id: "col-circ-500",
    name: "Columna circular Ø500",
    description: "Columna circular Ø500 mm, 8-#8 espiral, f'c=28, fy=420",
    category: "columna",
    generate: () => {
      const c = concreteDef(28);
      const s = steelDef(420);
      const region: ConcreteRegion = {
        id: uid(), label: "Columna circular",
        shape: { kind: "circ", y: 0, z: 0, radius: 250, radius_inner: 0 },
        concrete_id: c.id,
        confinement: { kind: "circ", hoop_bar_size: "#3", spacing: 80, is_spiral: true, fyh: 420 },
        cover_to_bar: 65,
        is_void: false, core_polygon: null,
      };
      const bars = generateCircPerimeterBars(250, 65, 8, "#8", s.id);
      return { schema_version: 1, concrete_defs: [c], steel_defs: [s], regions: [region], bars };
    },
  },
  {
    id: "col-circ-600",
    name: "Columna circular Ø600",
    description: "Columna circular Ø600 mm, 10-#9 espiral, f'c=35, fy=420",
    category: "columna",
    generate: () => {
      const c = concreteDef(35);
      const s = steelDef(420);
      const region: ConcreteRegion = {
        id: uid(), label: "Columna circular",
        shape: { kind: "circ", y: 0, z: 0, radius: 300, radius_inner: 0 },
        concrete_id: c.id,
        confinement: { kind: "circ", hoop_bar_size: "#3", spacing: 70, is_spiral: true, fyh: 420 },
        cover_to_bar: 70,
        is_void: false, core_polygon: null,
      };
      const bars = generateCircPerimeterBars(300, 70, 10, "#9", s.id);
      return { schema_version: 1, concrete_defs: [c], steel_defs: [s], regions: [region], bars };
    },
  },

  // ── Vigas ──────────────────────────────────────────────────────────────────
  {
    id: "viga-rect-300x500",
    name: "Viga 300×500",
    description: "Viga rectangular 300×500 mm, f'c=28, fy=420",
    category: "viga",
    generate: () => {
      const c = concreteDef(28);
      const s = steelDef(420);
      const region: ConcreteRegion = {
        id: uid(), label: "Viga",
        shape: { kind: "rect", y: 0, z: 0, height: 500, width: 300, angle_deg: 0 },
        concrete_id: c.id,
        confinement: { kind: "rect", hoop_bar_size: "#3", spacing: 150, legs_x: 2, legs_y: 2, fyh: 420 },
        cover_to_bar: 45,
        is_void: false, core_polygon: null,
      };
      const bars = generateRectPerimeterBars(500, 300, 45, 3, 2, "#6", s.id);
      return { schema_version: 1, concrete_defs: [c], steel_defs: [s], regions: [region], bars };
    },
  },
  {
    id: "viga-t-300x600",
    name: "Viga T 300×600",
    description: "Viga en T: alma 300×600, ala 800×120, f'c=28",
    category: "viga",
    generate: () => {
      const c = concreteDef(28);
      const s = steelDef(420);
      const alma: ConcreteRegion = {
        id: uid(), label: "Alma",
        shape: { kind: "rect", y: -240, z: 0, height: 480, width: 300, angle_deg: 0 },
        concrete_id: c.id,
        confinement: { kind: "rect", hoop_bar_size: "#3", spacing: 150, legs_x: 2, legs_y: 2, fyh: 420 },
        cover_to_bar: 45, is_void: false, core_polygon: null,
      };
      const ala: ConcreteRegion = {
        id: uid(), label: "Ala",
        shape: { kind: "rect", y: 60, z: 0, height: 120, width: 800, angle_deg: 0 },
        concrete_id: c.id, confinement: null,
        cover_to_bar: 30, is_void: false, core_polygon: null,
      };
      const bars: ReinforcementBar[] = [
        { id: uid(), y: -460, z: -80, bar_size: "#7", steel_id: s.id },
        { id: uid(), y: -460, z:   0, bar_size: "#7", steel_id: s.id },
        { id: uid(), y: -460, z:  80, bar_size: "#7", steel_id: s.id },
        { id: uid(), y:  20, z: -300, bar_size: "#4", steel_id: s.id },
        { id: uid(), y:  20, z:  300, bar_size: "#4", steel_id: s.id },
      ];
      return { schema_version: 1, concrete_defs: [c], steel_defs: [s], regions: [alma, ala], bars };
    },
  },

  // ── Muros ──────────────────────────────────────────────────────────────────
  {
    id: "muro-rect-200x2000",
    name: "Muro 200×2000",
    description: "Muro estructural 200×2000 mm, f'c=28, fy=420",
    category: "muro",
    generate: () => {
      const c = concreteDef(28);
      const s = steelDef(420);
      const region: ConcreteRegion = {
        id: uid(), label: "Muro",
        shape: { kind: "rect", y: 0, z: 0, height: 2000, width: 200, angle_deg: 0 },
        concrete_id: c.id,
        confinement: { kind: "rect", hoop_bar_size: "#3", spacing: 200, legs_x: 2, legs_y: 2, fyh: 420 },
        cover_to_bar: 35, is_void: false, core_polygon: null,
      };
      const bars = generateRectPerimeterBars(2000, 200, 35, 6, 2, "#5", s.id);
      return { schema_version: 1, concrete_defs: [c], steel_defs: [s], regions: [region], bars };
    },
  },
  {
    id: "muro-rect-300x3000",
    name: "Muro 300×3000",
    description: "Muro estructural 300×3000 mm, f'c=35, fy=420",
    category: "muro",
    generate: () => {
      const c = concreteDef(35);
      const s = steelDef(420);
      const region: ConcreteRegion = {
        id: uid(), label: "Muro",
        shape: { kind: "rect", y: 0, z: 0, height: 3000, width: 300, angle_deg: 0 },
        concrete_id: c.id,
        confinement: { kind: "rect", hoop_bar_size: "#3", spacing: 150, legs_x: 2, legs_y: 2, fyh: 420 },
        cover_to_bar: 40, is_void: false, core_polygon: null,
      };
      const bars = generateRectPerimeterBars(3000, 300, 40, 8, 2, "#5", s.id);
      return { schema_version: 1, concrete_defs: [c], steel_defs: [s], regions: [region], bars };
    },
  },

  // ── Columnas huecas ────────────────────────────────────────────────────────
  {
    id: "col-hueca-600x600",
    name: "Columna hueca 600×600",
    description: "Caja rectangular 600×600, alma 80 mm, f'c=35, fy=420",
    category: "columna",
    generate: () => {
      const c = concreteDef(35);
      const s = steelDef(420);
      const outer: ConcreteRegion = {
        id: uid(), label: "Sección exterior",
        shape: { kind: "rect", y: 0, z: 0, height: 600, width: 600, angle_deg: 0 },
        concrete_id: c.id,
        confinement: { kind: "rect", hoop_bar_size: "#3", spacing: 100, legs_x: 2, legs_y: 2, fyh: 420 },
        cover_to_bar: 55, is_void: false, core_polygon: null,
      };
      const inner: ConcreteRegion = {
        id: uid(), label: "Hueco interior",
        shape: { kind: "rect", y: 0, z: 0, height: 440, width: 440, angle_deg: 0 },
        concrete_id: c.id, confinement: null,
        cover_to_bar: 0, is_void: true, core_polygon: null,
      };
      const bars = generateRectPerimeterBars(600, 600, 55, 3, 3, "#8", s.id);
      return { schema_version: 1, concrete_defs: [c], steel_defs: [s], regions: [outer, inner], bars };
    },
  },

  // ── Pilas de puente ────────────────────────────────────────────────────────
  {
    id: "pila-circ-800",
    name: "Pila circular Ø800",
    description: "Pila sólida Ø800 mm, 12-#10 espiral, f'c=35, fy=420",
    category: "pila",
    generate: () => {
      const c = concreteDef(35);
      const s = steelDef(420);
      const region: ConcreteRegion = {
        id: uid(), label: "Pila circular",
        shape: { kind: "circ", y: 0, z: 0, radius: 400, radius_inner: 0 },
        concrete_id: c.id,
        confinement: { kind: "circ", hoop_bar_size: "#4", spacing: 75, is_spiral: true, fyh: 420 },
        cover_to_bar: 80,
        is_void: false, core_polygon: null,
      };
      const bars = generateCircPerimeterBars(400, 80, 12, "#10", s.id);
      return { schema_version: 1, concrete_defs: [c], steel_defs: [s], regions: [region], bars };
    },
  },
  {
    id: "pila-circ-hueca-1200",
    name: "Pila hueca Ø1200/Ø800",
    description: "Pila anular Ø1200/Ø800 mm, 20-#11 espiral, f'c=35, fy=420",
    category: "pila",
    generate: () => {
      const c = concreteDef(35);
      const s = steelDef(420);
      const region: ConcreteRegion = {
        id: uid(), label: "Pila anular",
        shape: { kind: "circ", y: 0, z: 0, radius: 600, radius_inner: 400 },
        concrete_id: c.id,
        confinement: { kind: "circ", hoop_bar_size: "#4", spacing: 60, is_spiral: true, fyh: 420 },
        cover_to_bar: 90,
        is_void: false, core_polygon: null,
      };
      const bars = generateCircPerimeterBars(600, 90, 20, "#11", s.id);
      return { schema_version: 1, concrete_defs: [c], steel_defs: [s], regions: [region], bars };
    },
  },
  {
    id: "pila-rect-1500x600",
    name: "Pila rectangular 1500×600",
    description: "Pila maciza 1500×600 mm, 16-#10, f'c=35, fy=420",
    category: "pila",
    generate: () => {
      const c = concreteDef(35);
      const s = steelDef(420);
      const region: ConcreteRegion = {
        id: uid(), label: "Pila rectangular",
        shape: { kind: "rect", y: 0, z: 0, height: 1500, width: 600, angle_deg: 0 },
        concrete_id: c.id,
        confinement: { kind: "rect", hoop_bar_size: "#4", spacing: 100, legs_x: 3, legs_y: 4, fyh: 420 },
        cover_to_bar: 80,
        is_void: false, core_polygon: null,
      };
      const bars = generateRectPerimeterBars(1500, 600, 80, 6, 3, "#10", s.id);
      return { schema_version: 1, concrete_defs: [c], steel_defs: [s], regions: [region], bars };
    },
  },
  {
    id: "pila-rect-2000x800",
    name: "Pila rectangular 2000×800",
    description: "Pila maciza 2000×800 mm, 20-#11, f'c=42, fy=420",
    category: "pila",
    generate: () => {
      const c = concreteDef(42);
      const s = steelDef(420);
      const region: ConcreteRegion = {
        id: uid(), label: "Pila rectangular",
        shape: { kind: "rect", y: 0, z: 0, height: 2000, width: 800, angle_deg: 0 },
        concrete_id: c.id,
        confinement: { kind: "rect", hoop_bar_size: "#4", spacing: 90, legs_x: 3, legs_y: 5, fyh: 420 },
        cover_to_bar: 90,
        is_void: false, core_polygon: null,
      };
      const bars = generateRectPerimeterBars(2000, 800, 90, 7, 3, "#11", s.id);
      return { schema_version: 1, concrete_defs: [c], steel_defs: [s], regions: [region], bars };
    },
  },
];
