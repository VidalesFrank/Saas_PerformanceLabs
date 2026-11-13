"use client";

import { ReactNode } from "react";
import { COLOR_TOKENS, ModuleIcon } from "@/lib/module-visuals";
import type { CatalogColor } from "@/lib/types";

/* PageHero — sub-hero compacto en dark para la cabecera de cada módulo.
 *
 * Mantiene el lenguaje visual del dashboard (gradient navy + grid blueprint
 * + chip con gradient del flujo) pero más pequeño y con slot de acciones
 * para botones primarios/secundarios.
 *
 * Uso:
 *   <PageHero
 *     tone="cyan"
 *     eyebrow="Constructor de Modelos"
 *     title="Modela, importa y analiza"
 *     subtitle="Importa tu modelo ETABS y ejecuta análisis modal espectral NSR-10."
 *     icon="building"
 *     actions={<Button>+ Nuevo proyecto</Button>}
 *   />
 */

export interface PageHeroProps {
  /** Línea pequeña arriba del título (nombre del módulo, breadcrumb corto). */
  eyebrow?: string;
  /** Título principal. */
  title: string;
  /** Bajada bajo el título. */
  subtitle?: string;
  /** Color del flujo — determina el gradient del chip y los acentos. */
  tone?: CatalogColor;
  /** Id del ícono en module-visuals ICON_D. */
  icon?: string;
  /** Slot para botones u otras acciones alineadas a la derecha. */
  actions?: ReactNode;
  /** Chips/pills pequeños mostrados bajo el título. */
  meta?: ReactNode;
  /** Padding vertical. "lg" para hero más alto en landings de módulo. */
  size?: "md" | "lg";
}

export function PageHero({
  eyebrow,
  title,
  subtitle,
  tone = "cyan",
  icon,
  actions,
  meta,
  size = "md",
}: PageHeroProps) {
  const palette = COLOR_TOKENS[tone];
  const padY = size === "lg" ? "py-10 md:py-12" : "py-7 md:py-9";

  return (
    <section className="pl-hero-dark border-b border-white/5">
      <div className={`mx-auto flex max-w-7xl flex-col gap-6 px-6 md:flex-row md:items-center md:justify-between md:px-8 ${padY}`}>
        <div className="flex min-w-0 items-start gap-4">
          {icon && (
            <div
              className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl"
              style={{
                background: palette.gradient,
                boxShadow: `0 10px 28px -10px ${palette.accent}80, inset 0 1px 0 rgba(255,255,255,0.18)`,
              }}
            >
              <ModuleIcon type={icon} color="#050b18" size={22} strokeWidth={2.2} />
            </div>
          )}
          <div className="min-w-0">
            {eyebrow && (
              <div
                className="mb-1.5 inline-flex items-center gap-2 text-[10.5px] font-bold uppercase tracking-[0.14em]"
                style={{ color: palette.accent }}
              >
                <span
                  className="inline-block h-1 w-1 rounded-full"
                  style={{ background: palette.accent, boxShadow: `0 0 6px ${palette.accent}` }}
                />
                {eyebrow}
              </div>
            )}
            <h1 className="text-[22px] font-bold leading-tight tracking-tight text-slate-100 md:text-[26px]">
              {title}
            </h1>
            {subtitle && (
              <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-slate-300/85">
                {subtitle}
              </p>
            )}
            {meta && <div className="mt-3 flex flex-wrap items-center gap-2">{meta}</div>}
          </div>
        </div>

        {actions && (
          <div className="flex flex-shrink-0 flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>
    </section>
  );
}

/* Chip auxiliar para `meta` del PageHero. */
export function PageHeroChip({
  label,
  value,
  tone = "cyan",
}: {
  label?: string;
  value: string;
  tone?: CatalogColor;
}) {
  const palette = COLOR_TOKENS[tone];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10.5px] font-semibold"
      style={{
        background: `color-mix(in srgb, ${palette.accent} 10%, transparent)`,
        color: palette.accent,
        borderColor: `color-mix(in srgb, ${palette.accent} 30%, transparent)`,
      }}
    >
      {label && <span className="font-bold uppercase tracking-wider opacity-80">{label}:</span>}
      {value}
    </span>
  );
}
