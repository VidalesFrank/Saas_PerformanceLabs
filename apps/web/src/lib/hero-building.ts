/* Generador del edificio showcase del hero.
 *
 * Edificio sintético pensado para impactar visualmente: torre regular de
 * 24 pisos sobre planta rectangular de 36×24 m, con núcleo de muros de
 * concreto en el centro (pozo de ascensores + escaleras) y columnas en
 * cada intersección de ejes. Vigas X e Y en cada nivel conectan los
 * elementos verticales.
 *
 * El objetivo no es realismo estructural — es que *se vea como algo que
 * modelamos de verdad*: core, perímetro, grid regular, proporción esbelta
 * (altura/base ≈ 2), mostrando volumen suficiente para parecer "producto".
 *
 * Todas las unidades están en metros. La salida son listas de coordenadas
 * x/y/z con `null` como separador de segmentos — el formato nativo de
 * Plotly para dibujar varios segmentos en una sola traza.
 */

export interface HeroBuildingTrace {
  x: (number | null)[];
  y: (number | null)[];
  z: (number | null)[];
}

export interface HeroBuilding {
  columns: HeroBuildingTrace;
  beams: HeroBuildingTrace;
  walls: HeroBuildingTrace;
  slabs: HeroBuildingTrace;
  bracing: HeroBuildingTrace;
  height: number;
  footprintX: number;
  footprintY: number;
  storyHeight: number;
  stories: number;
}

const STORY_H = 3.2;
const STORIES = 24;
const BAY_X = 6.0;
const BAY_Y = 6.0;
const NBAYS_X = 6;
const NBAYS_Y = 4;

function pushSegment(trace: HeroBuildingTrace, a: [number, number, number], b: [number, number, number]) {
  trace.x.push(a[0], b[0], null);
  trace.y.push(a[1], b[1], null);
  trace.z.push(a[2], b[2], null);
}

function emptyTrace(): HeroBuildingTrace {
  return { x: [], y: [], z: [] };
}

/** Grid de ejes X (líneas de columnas). */
function axesX(): number[] {
  return Array.from({ length: NBAYS_X + 1 }, (_, i) => i * BAY_X);
}
function axesY(): number[] {
  return Array.from({ length: NBAYS_Y + 1 }, (_, i) => i * BAY_Y);
}
function axesZ(): number[] {
  return Array.from({ length: STORIES + 1 }, (_, i) => i * STORY_H);
}

/** Centrar la planta en el origen para rotación más natural. */
function centerX(x: number): number { return x - (NBAYS_X * BAY_X) / 2; }
function centerY(y: number): number { return y - (NBAYS_Y * BAY_Y) / 2; }

export function generateHeroBuilding(): HeroBuilding {
  const xs = axesX();
  const ys = axesY();
  const zs = axesZ();

  const columns = emptyTrace();
  const beams = emptyTrace();
  const walls = emptyTrace();
  const slabs = emptyTrace();
  const bracing = emptyTrace();

  // ── Columnas: cada intersección (xi, yi) va del z=0 al z=top ─────────────
  for (const x of xs) {
    for (const y of ys) {
      pushSegment(
        columns,
        [centerX(x), centerY(y), 0],
        [centerX(x), centerY(y), zs[zs.length - 1]],
      );
    }
  }

  // ── Vigas por nivel (saltamos z=0 que es la cimentación) ─────────────────
  for (let s = 1; s < zs.length; s++) {
    const z = zs[s];
    // Vigas X: a lo largo de cada eje Y
    for (const y of ys) {
      for (let i = 0; i < xs.length - 1; i++) {
        pushSegment(
          beams,
          [centerX(xs[i]),     centerY(y), z],
          [centerX(xs[i + 1]), centerY(y), z],
        );
      }
    }
    // Vigas Y: a lo largo de cada eje X
    for (const x of xs) {
      for (let i = 0; i < ys.length - 1; i++) {
        pushSegment(
          beams,
          [centerX(x), centerY(ys[i]),     z],
          [centerX(x), centerY(ys[i + 1]), z],
        );
      }
    }
  }

  // ── Núcleo de muros: rectángulo central ocupando 2 bays × 2 bays ─────────
  // Entre los ejes X=2 y X=4, y los ejes Y=1 y Y=3 → en planta: (12..24) × (6..18)
  const coreX0 = centerX(xs[2]);
  const coreX1 = centerX(xs[4]);
  const coreY0 = centerY(ys[1]);
  const coreY1 = centerY(ys[3]);
  const topZ = zs[zs.length - 1];

  // 4 muros verticales del perímetro del núcleo, cada uno dibujado como
  // rectángulo + diagonal (sugiriendo macroelementos) en cada piso.
  for (let s = 0; s < zs.length - 1; s++) {
    const z0 = zs[s];
    const z1 = zs[s + 1];
    const wallFaces: Array<[[number, number], [number, number]]> = [
      [[coreX0, coreY0], [coreX1, coreY0]],
      [[coreX1, coreY0], [coreX1, coreY1]],
      [[coreX1, coreY1], [coreX0, coreY1]],
      [[coreX0, coreY1], [coreX0, coreY0]],
    ];
    for (const [[ax, ay], [bx, by]] of wallFaces) {
      // Contorno del panel
      pushSegment(walls, [ax, ay, z0], [bx, by, z0]);
      pushSegment(walls, [bx, by, z0], [bx, by, z1]);
      pushSegment(walls, [bx, by, z1], [ax, ay, z1]);
      pushSegment(walls, [ax, ay, z1], [ax, ay, z0]);
      // Diagonal (sugiere macroelemento MVLEM)
      pushSegment(walls, [ax, ay, z0], [bx, by, z1]);
    }
  }

  // ── Columnas del núcleo: los 4 ejes del perímetro del core, extra gruesos ─
  for (const [x, y] of [
    [coreX0, coreY0],
    [coreX1, coreY0],
    [coreX1, coreY1],
    [coreX0, coreY1],
  ] as [number, number][]) {
    pushSegment(walls, [x, y, 0], [x, y, topZ]);
  }

  // ── Contorno de losas (perímetro de la planta en cada nivel) ─────────────
  const xMin = centerX(xs[0]);
  const xMax = centerX(xs[xs.length - 1]);
  const yMin = centerY(ys[0]);
  const yMax = centerY(ys[ys.length - 1]);
  for (let s = 1; s < zs.length; s++) {
    const z = zs[s];
    pushSegment(slabs, [xMin, yMin, z], [xMax, yMin, z]);
    pushSegment(slabs, [xMax, yMin, z], [xMax, yMax, z]);
    pushSegment(slabs, [xMax, yMax, z], [xMin, yMax, z]);
    pushSegment(slabs, [xMin, yMax, z], [xMin, yMin, z]);
  }

  // ── Arriostramientos decorativos en fachada (cada 4 pisos) ───────────────
  // Da sensación "edificio alto moderno" sin recargar.
  for (let s = 0; s < zs.length - 1; s += 4) {
    const z0 = zs[s];
    const z1 = zs[Math.min(s + 4, zs.length - 1)];
    // Fachadas X (y = yMin y y = yMax)
    for (const y of [yMin, yMax]) {
      // Diagonal cruzada en bays extremos
      for (const bayIdx of [0, NBAYS_X - 1]) {
        const xa = centerX(xs[bayIdx]);
        const xb = centerX(xs[bayIdx + 1]);
        pushSegment(bracing, [xa, y, z0], [xb, y, z1]);
        pushSegment(bracing, [xb, y, z0], [xa, y, z1]);
      }
    }
  }

  return {
    columns,
    beams,
    walls,
    slabs,
    bracing,
    height: STORIES * STORY_H,
    footprintX: NBAYS_X * BAY_X,
    footprintY: NBAYS_Y * BAY_Y,
    storyHeight: STORY_H,
    stories: STORIES,
  };
}
