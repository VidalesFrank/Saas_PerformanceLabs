/**
 * Adapter para las páginas de análisis (interaction / pmm / moment-curvature).
 *
 * Estas páginas usan un form con inputs para tipo de sección + dimensiones + n_bars.
 * Las barras se generan automáticamente por `rectPerimeterBars` / `circPerimeterBars`.
 *
 * Cuando el usuario quiere ajustar una barra individual (clic derecho → Editar),
 * necesitamos convertir el form al modo "special" (shape_type = "special") para
 * poder persistir cambios individuales por barra. Este módulo hace esa conversión
 * de forma transparente.
 */
import type { ShapeType } from "@/lib/types";
import { circPerimeterBars, rectPerimeterBars, type BarPoint } from "@/lib/section-preview";

// Form mínimo requerido para el adapter (sub-conjunto del form completo de las 3 páginas)
export interface AnalysisFormLike {
  shape_type: ShapeType;
  width?: number;
  height?: number;
  diameter?: number;
  cover_to_bar_centroid?: number;
  n_bars_y?: number;
  n_bars_z?: number;
  n_bars?: number;
  bar_id?: string;
  verticesText?: string;
  barsText?: string;
  /** Tamaños individuales por barra (paralelo al array de barras).
   *  Si no existe o alguna posición no tiene entrada, se usa bar_id global. */
  bar_sizes?: string[];
}

// ── Serializadores ────────────────────────────────────────────────────────

export function serializePairs(pairs: [number, number][]): string {
  return pairs.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join("\n");
}

export function parsePairs(text: string): [number, number][] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [a, b] = l.split(",").map((v) => parseFloat(v.trim()));
      return [a, b] as [number, number];
    })
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
}

// ── Cálculo de barras y vértices desde el form ────────────────────────────

export function computeBarsFromForm(form: AnalysisFormLike): BarPoint[] {
  if (form.shape_type === "circular" && form.diameter && form.n_bars && form.cover_to_bar_centroid) {
    return circPerimeterBars(form.diameter, form.cover_to_bar_centroid, form.n_bars);
  }
  if (form.shape_type === "special") {
    return parsePairs(form.barsText ?? "").map(([y, z]) => ({ y, z }));
  }
  if ((form.shape_type === "rectangular" || form.shape_type === "square") &&
      form.height && form.width && form.n_bars_y && form.n_bars_z && form.cover_to_bar_centroid) {
    return rectPerimeterBars(form.height, form.width, form.cover_to_bar_centroid, form.n_bars_y, form.n_bars_z);
  }
  return [];
}

// Vértices del polígono correspondientes a la forma actual
export function computeVerticesFromForm(form: AnalysisFormLike): [number, number][] {
  if (form.shape_type === "special") return parsePairs(form.verticesText ?? "");
  if (form.shape_type === "circular" && form.diameter) {
    const R = form.diameter / 2;
    const n = 32;
    return Array.from({ length: n }, (_, i) => {
      const t = (2 * Math.PI * i) / n;
      return [R * Math.cos(t), R * Math.sin(t)] as [number, number];
    });
  }
  if ((form.shape_type === "rectangular" || form.shape_type === "square") && form.height && form.width) {
    const h2 = form.height / 2, w2 = form.width / 2;
    return [
      [-h2, -w2], [-h2, w2], [h2, w2], [h2, -w2],
    ];
  }
  return [];
}

// ── Tamaños de barra individuales ────────────────────────────────────────

/** Devuelve el array de tamaños de barra alineado con `computeBarsFromForm(form)`.
 *  Si el form no tiene `bar_sizes` o es más corto, rellena con `bar_id`. */
export function computeBarSizesFromForm(form: AnalysisFormLike): string[] {
  const bars = computeBarsFromForm(form);
  const fallback = form.bar_id ?? "#5";
  const explicit = form.bar_sizes ?? [];
  return bars.map((_, i) => explicit[i] || fallback);
}

// ── Conversiones para editar barras individuales ──────────────────────────

/**
 * Convierte el form actual al modo "special" (polígono + barras explícitas),
 * dejando la geometría VISUALMENTE idéntica. Después de esta conversión,
 * cada barra tiene una entrada individual en `barsText` que puede editarse.
 *
 * Devuelve el nuevo form + índice mapeado si se pasó `preserveBarIdx`.
 */
export function ensureSpecialMode<T extends AnalysisFormLike>(
  form: T,
): T {
  if (form.shape_type === "special") {
    // Ya en special — pero garantizamos que bar_sizes tenga longitud correcta
    const nBars = parsePairs(form.barsText ?? "").length;
    const fallback = form.bar_id ?? "#5";
    const currentSizes = form.bar_sizes ?? [];
    const bar_sizes = Array.from({ length: nBars }, (_, i) => currentSizes[i] || fallback);
    return { ...form, bar_sizes };
  }
  const bars = computeBarsFromForm(form);
  const verts = computeVerticesFromForm(form);
  const fallback = form.bar_id ?? "#5";
  const currentSizes = form.bar_sizes ?? [];
  const bar_sizes = bars.map((_, i) => currentSizes[i] || fallback);
  return {
    ...form,
    shape_type: "special" as ShapeType,
    verticesText: serializePairs(verts),
    barsText: serializePairs(bars.map((b) => [b.y, b.z] as [number, number])),
    bar_sizes,
  };
}

/**
 * Aplica una edición a la barra idx del preview. Si el form no está en modo
 * special, primero lo convierte para que el cambio sea persistible.
 *
 * `updates.y` y `updates.z` reemplazan las coordenadas. `updates.bar_size`
 * está implicito (todas las barras comparten un tamaño único `bar_id` en
 * modo automático, o no se soporta cambiar tamaño individual en modo special
 * v1). Documentado para el futuro.
 */
export function applyBarEdit<T extends AnalysisFormLike>(
  form: T,
  idx: number,
  updates: { y?: number; z?: number; bar_size?: string },
): T {
  const special = ensureSpecialMode(form);
  const bars = parsePairs(special.barsText ?? "");
  if (idx < 0 || idx >= bars.length) return special;
  const cur = bars[idx];
  bars[idx] = [
    updates.y !== undefined ? updates.y : cur[0],
    updates.z !== undefined ? updates.z : cur[1],
  ];
  // Actualizar bar_sizes solo en el índice editado (mantiene los otros individuales)
  const bar_sizes = (special.bar_sizes ?? bars.map(() => special.bar_id ?? "#5")).slice();
  while (bar_sizes.length < bars.length) bar_sizes.push(special.bar_id ?? "#5");
  if (updates.bar_size !== undefined) bar_sizes[idx] = updates.bar_size;
  return {
    ...special,
    barsText: serializePairs(bars),
    bar_sizes,
  };
}

/**
 * Elimina la barra idx. Convierte a special si es necesario.
 */
export function applyBarDelete<T extends AnalysisFormLike>(form: T, idx: number): T {
  const special = ensureSpecialMode(form);
  const bars = parsePairs(special.barsText ?? "");
  if (idx < 0 || idx >= bars.length) return special;
  bars.splice(idx, 1);
  const bar_sizes = (special.bar_sizes ?? []).slice();
  if (idx < bar_sizes.length) bar_sizes.splice(idx, 1);
  return {
    ...special,
    barsText: serializePairs(bars),
    bar_sizes,
  };
}

/**
 * Duplica la barra idx con un offset visible. Copia también el bar_size.
 */
export function applyBarDuplicate<T extends AnalysisFormLike>(form: T, idx: number, offset = 30): T {
  const special = ensureSpecialMode(form);
  const bars = parsePairs(special.barsText ?? "");
  if (idx < 0 || idx >= bars.length) return special;
  const [y, z] = bars[idx];
  bars.push([y + offset, z + offset]);
  const bar_sizes = (special.bar_sizes ?? []).slice();
  const sizeCopied = bar_sizes[idx] ?? special.bar_id ?? "#5";
  bar_sizes.push(sizeCopied);
  return {
    ...special,
    barsText: serializePairs(bars),
    bar_sizes,
  };
}
