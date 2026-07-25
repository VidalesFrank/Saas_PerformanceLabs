import { HTMLAttributes } from "react";
import type { Estado, Nivel } from "@/lib/types";

const estadoClasses: Record<Estado, string> = {
  listo: "bg-success/15 text-success border-success/30",
  en_desarrollo: "bg-warning/15 text-warning border-warning/30",
  idea: "bg-text-muted/15 text-text-muted border-text-muted/30",
};

const estadoLabel: Record<Estado, string> = {
  listo: "Listo",
  en_desarrollo: "En desarrollo",
  idea: "Idea",
};

const nivelLabel: Record<Exclude<Nivel, null>, string> = {
  free: "Free",
  pro: "Pro",
  premium: "Premium",
};

export function EstadoBadge({ estado }: { estado: Estado }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${estadoClasses[estado]}`}
    >
      {estadoLabel[estado]}
    </span>
  );
}

export function NivelBadge({ nivel }: { nivel: Nivel }) {
  if (!nivel) return null;
  return (
    <span className="inline-flex items-center rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
      {nivelLabel[nivel]}
    </span>
  );
}

export function Badge({ className = "", ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={`inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs font-medium ${className}`}
      {...props}
    />
  );
}
