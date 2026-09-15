/**
 * Íconos SVG minimalistas para el editor de secciones.
 *
 * Diseño: stroke-based, 20×20 viewBox, stroke-width 1.75 por default.
 * Filosofía: líneas limpias, cuadrícula 4px, sin fills (solo trazo).
 * Inspirado en Lucide/Phosphor pero sin dependencia externa.
 */
import type { SVGProps } from "react";

interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

function IconBase({ size = 18, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size} height={size} viewBox="0 0 20 20"
      fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  );
}

// ── Herramientas de dibujo ─────────────────────────────────────────────────

export const IconSelect = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M3 3l5 14 2-6 6-2z" />
  </IconBase>
);

export const IconRectangle = (p: IconProps) => (
  <IconBase {...p}>
    <rect x="3" y="4" width="14" height="12" rx="0.5" />
  </IconBase>
);

export const IconCircle = (p: IconProps) => (
  <IconBase {...p}>
    <circle cx="10" cy="10" r="6.5" />
  </IconBase>
);

export const IconPolygon = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M10 2.5l7 4v7l-7 4-7-4v-7z" />
  </IconBase>
);

export const IconBar = (p: IconProps) => (
  <IconBase {...p}>
    <circle cx="10" cy="10" r="3" fill="currentColor" />
    <circle cx="10" cy="10" r="7" strokeDasharray="1.5 2" opacity="0.5" />
  </IconBase>
);

export const IconLine = (p: IconProps) => (
  <IconBase {...p}>
    <circle cx="4" cy="16" r="1.6" fill="currentColor" />
    <circle cx="10" cy="10" r="1.6" fill="currentColor" />
    <circle cx="16" cy="4" r="1.6" fill="currentColor" />
    <path d="M4 16L16 4" opacity="0.4" strokeDasharray="1.5 2" />
  </IconBase>
);

// ── Historial / navegación ─────────────────────────────────────────────────

export const IconUndo = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M4 8h9a4 4 0 010 8h-3M4 8l4-4M4 8l4 4" />
  </IconBase>
);

export const IconRedo = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M16 8H7a4 4 0 000 8h3M16 8l-4-4M16 8l-4 4" />
  </IconBase>
);

export const IconFitView = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M3 7V3h4M17 7V3h-4M3 13v4h4M17 13v4h-4" />
    <rect x="7" y="7" width="6" height="6" rx="0.5" opacity="0.5" />
  </IconBase>
);

export const IconZoomIn = (p: IconProps) => (
  <IconBase {...p}>
    <circle cx="9" cy="9" r="5.5" />
    <path d="M13 13l4 4M9 6v6M6 9h6" />
  </IconBase>
);

export const IconZoomOut = (p: IconProps) => (
  <IconBase {...p}>
    <circle cx="9" cy="9" r="5.5" />
    <path d="M13 13l4 4M6 9h6" />
  </IconBase>
);

export const IconGrid = (p: IconProps) => (
  <IconBase {...p}>
    <rect x="3" y="3" width="14" height="14" rx="0.5" />
    <path d="M3 8.5h14M3 14h14M8.5 3v14M14 3v14" opacity="0.6" />
  </IconBase>
);

// ── Acciones ────────────────────────────────────────────────────────────────

export const IconDuplicate = (p: IconProps) => (
  <IconBase {...p}>
    <rect x="7" y="7" width="10" height="10" rx="1" />
    <path d="M13 7V4a1 1 0 00-1-1H4a1 1 0 00-1 1v8a1 1 0 001 1h3" />
  </IconBase>
);

export const IconEdit = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M13.5 3.5l3 3L7 16H4v-3z" />
    <path d="M11.5 5.5l3 3" />
  </IconBase>
);

export const IconMove = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M10 3v14M3 10h14M10 3l-2 2M10 3l2 2M10 17l-2-2M10 17l2-2M3 10l2-2M3 10l2 2M17 10l-2-2M17 10l-2 2" />
  </IconBase>
);

export const IconAlign = (p: IconProps) => (
  <IconBase {...p}>
    <circle cx="5" cy="10" r="1.5" fill="currentColor" />
    <circle cx="10" cy="10" r="1.5" fill="currentColor" />
    <circle cx="15" cy="10" r="1.5" fill="currentColor" />
    <path d="M3 10h14" opacity="0.4" strokeDasharray="1.5 2" />
  </IconBase>
);

export const IconTrash = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M4 6h12M8 6V4h4v2M6 6l1 11h6l1-11" />
  </IconBase>
);

export const IconMaterials = (p: IconProps) => (
  <IconBase {...p}>
    <circle cx="6.5" cy="8" r="3" />
    <circle cx="13.5" cy="12" r="3" />
    <path d="M9 10l3 -1" opacity="0.4" />
  </IconBase>
);

// ── Overlay / vista ────────────────────────────────────────────────────────

export const IconCentroid = (p: IconProps) => (
  <IconBase {...p}>
    <circle cx="10" cy="10" r="1.5" fill="currentColor" />
    <circle cx="10" cy="10" r="6" opacity="0.5" />
    <path d="M10 2v3M10 15v3M2 10h3M15 10h3" opacity="0.8" />
  </IconBase>
);

export const IconRuler = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M2 8l6 6 6-6-6-6z M8 14v3M17 5l1 1" strokeOpacity="0.4" />
    <path d="M4 8l1-1M6 10l1-1M8 12l1-1M10 14l1-1" />
  </IconBase>
);

export const IconEye = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M1 10s3-6 9-6 9 6 9 6-3 6-9 6-9-6-9-6z" />
    <circle cx="10" cy="10" r="2.5" />
  </IconBase>
);

export const IconSave = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M4 3h9l4 4v10a1 1 0 01-1 1H4a1 1 0 01-1-1V4a1 1 0 011-1z" />
    <path d="M6 3v5h7V3" />
  </IconBase>
);

// ── Layout: I, T, L, Doble T (adiciones fase 2B) ──────────────────────────

export const IconIShape = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M4 4h12v3H12v6h4v3H4v-3h4V7H4z" />
  </IconBase>
);

export const IconTShape = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M3 3h14v3H12v11h-4V6H3z" />
  </IconBase>
);

export const IconLShape = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M4 3h4v11h9v4H4z" />
  </IconBase>
);

// Ícono "close" del panel/dialog
export const IconClose = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M4 4l12 12M16 4L4 16" />
  </IconBase>
);

export const IconCheck = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M4 10l4 4L16 5" />
  </IconBase>
);

export const IconChevronDown = (p: IconProps) => (
  <IconBase {...p}>
    <path d="M5 8l5 5 5-5" />
  </IconBase>
);
