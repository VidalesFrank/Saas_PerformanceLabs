"use client";

/**
 * Iconos SVG para el sidebar del Constructor de Modelos. Trazo 1.75,
 * `currentColor` para heredar el color del texto, viewBox 24×24 uniforme.
 * Diseño alineado con el editor premium de secciones (2026-09-12).
 */

type IconProps = { className?: string };

function _svg(path: React.ReactNode, props: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
         fill="none" stroke="currentColor" strokeWidth={1.75}
         strokeLinecap="round" strokeLinejoin="round"
         className={props.className ?? "h-4 w-4"}>
      {path}
    </svg>
  );
}

// Archivo con esquina doblada (archivos y validación)
export const IconArchivos = (p: IconProps) => _svg(
  <>
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
    <path d="M14 3v6h6" />
  </>, p,
);

// Cubo 3D (Vista 3D / Editor)
export const IconVista3D = (p: IconProps) => _svg(
  <>
    <path d="M12 2.5l8.5 4.5v9L12 20.5 3.5 16V7z" />
    <path d="M12 2.5v18" />
    <path d="M3.5 7l8.5 4.5L20.5 7" />
  </>, p,
);

// Beaker / probeta (Materiales)
export const IconMateriales = (p: IconProps) => _svg(
  <>
    <path d="M9 3h6" />
    <path d="M10 3v7l-5 9a2 2 0 0 0 1.75 3h10.5A2 2 0 0 0 19 19L14 10V3" />
    <path d="M6.5 15h11" />
  </>, p,
);

// Cuadricula de sección (Secciones)
export const IconSecciones = (p: IconProps) => _svg(
  <>
    <rect x="4" y="4" width="16" height="16" rx="1.5" />
    <path d="M4 9h16M4 15h16M9 4v16M15 4v16" />
  </>, p,
);

// Grid cardinal (Grid del edificio)
export const IconGrid = (p: IconProps) => _svg(
  <>
    <path d="M3 8h18M3 16h18M8 3v18M16 3v18" />
  </>, p,
);

// Ladrillos (Mampostería)
export const IconMamposteria = (p: IconProps) => _svg(
  <>
    <path d="M3 6h7v5H3zM10 6h7v5h-7zM17 6h4v5" />
    <path d="M3 11h4v5H3zM7 11h8v5H7zM15 11h6v5" />
    <path d="M3 16h7v5H3zM10 16h7v5h-7zM17 16h4v5" />
  </>, p,
);

// Panel diagonal (Infills)
export const IconInfills = (p: IconProps) => _svg(
  <>
    <rect x="4" y="4" width="16" height="16" rx="1" />
    <path d="M4 4l16 16M20 4L4 20" />
  </>, p,
);

// Onda sísmica (Sísmico/espectral)
export const IconSismico = (p: IconProps) => _svg(
  <>
    <path d="M3 12h2l2-7 3 14 3-11 3 7 2-3h3" />
  </>, p,
);

// Columna con flechas laterales (Demandas Muros)
export const IconWallDemands = (p: IconProps) => _svg(
  <>
    <rect x="9" y="3" width="6" height="18" rx="0.5" />
    <path d="M6 10l-3 2 3 2M18 10l3 2-3 2" />
  </>, p,
);

// Columna reforzada (Diseño Muros RC)
export const IconWallDesign = (p: IconProps) => _svg(
  <>
    <rect x="7" y="3" width="10" height="18" rx="0.5" />
    <circle cx="10" cy="6" r="0.75" fill="currentColor" />
    <circle cx="14" cy="6" r="0.75" fill="currentColor" />
    <circle cx="10" cy="18" r="0.75" fill="currentColor" />
    <circle cx="14" cy="18" r="0.75" fill="currentColor" />
    <path d="M7 12h10" />
  </>, p,
);

// Columna + barras (Diseño columnas/vigas)
export const IconDiseno = (p: IconProps) => _svg(
  <>
    <rect x="6" y="3" width="4" height="18" rx="0.5" />
    <rect x="14" y="3" width="4" height="18" rx="0.5" />
    <path d="M10 8h4M10 16h4" />
  </>, p,
);

// Edificio con rótula (Asignar Muros)
export const IconMuros = (p: IconProps) => _svg(
  <>
    <path d="M4 21V9l8-5 8 5v12" />
    <path d="M4 21h16" />
    <circle cx="12" cy="13" r="1.5" />
  </>, p,
);

// Pushover curve (Pushover No Lineal)
export const IconPushover = (p: IconProps) => _svg(
  <>
    <path d="M3 20h18" />
    <path d="M3 20c3-1 5-5 8-7s4-6 10-6" />
  </>, p,
);

// Oscilograma (NLTH / cronológico)
export const IconNLTH = (p: IconProps) => _svg(
  <>
    <path d="M3 12h2l1-3 2 6 2-9 2 12 2-6 2 3h6" />
  </>, p,
);

// Lupa con elemento (Evaluación por elemento)
export const IconEvaluacion = (p: IconProps) => _svg(
  <>
    <circle cx="11" cy="11" r="6" />
    <path d="M20 20l-4.3-4.3" />
    <path d="M11 8v6M8 11h6" />
  </>, p,
);

// Download arrow (Exportar)
export const IconExportar = (p: IconProps) => _svg(
  <>
    <path d="M12 4v12" />
    <path d="M7 11l5 5 5-5" />
    <path d="M4 20h16" />
  </>, p,
);

// Lock (items bloqueados)
export const IconLock = (p: IconProps) => _svg(
  <>
    <rect x="5" y="11" width="14" height="10" rx="1.5" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </>, p,
);

// Chevron izq/der (collapse toggle)
export const IconChevronLeft = (p: IconProps) => _svg(
  <path d="M15 6l-6 6 6 6" />, p,
);
export const IconChevronRight = (p: IconProps) => _svg(
  <path d="M9 6l6 6-6 6" />, p,
);

// ─────────────────────────────────────────────────────────────────────
// Mapeo SectionId → icono (para el sidebar del constructor)
// ─────────────────────────────────────────────────────────────────────

export type SectionIconId =
  | "archivos" | "vista-3d" | "materiales" | "secciones" | "muros"
  | "grid" | "mamposteria" | "infills" | "sismico" | "wall-demands"
  | "wall-design" | "pushover" | "nlth" | "evaluacion-elemento"
  | "diseno" | "no-lineal";

export const SECTION_ICON_MAP: Record<SectionIconId, (p: IconProps) => React.JSX.Element> = {
  "archivos":            IconArchivos,
  "vista-3d":            IconVista3D,
  "materiales":          IconMateriales,
  "secciones":           IconSecciones,
  "muros":               IconMuros,
  "grid":                IconGrid,
  "mamposteria":         IconMamposteria,
  "infills":             IconInfills,
  "sismico":             IconSismico,
  "wall-demands":        IconWallDemands,
  "wall-design":         IconWallDesign,
  "pushover":            IconPushover,
  "nlth":                IconNLTH,
  "evaluacion-elemento": IconEvaluacion,
  "diseno":              IconDiseno,
  "no-lineal":           IconPushover,
};
