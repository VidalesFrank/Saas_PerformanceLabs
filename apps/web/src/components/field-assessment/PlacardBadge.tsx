"use client";

import type { Placard } from "@/lib/field-assessment-types";

const CFG: Record<Placard, { label: string; sub: string; color: string; bg: string; ring: string }> = {
  green:  { label: "INSPECCIONADO",   sub: "Ocupable",            color: "#166534", bg: "#dcfce7", ring: "#86efac" },
  yellow: { label: "USO RESTRINGIDO", sub: "Acceso limitado",     color: "#92400e", bg: "#fef3c7", ring: "#fcd34d" },
  red:    { label: "INSEGURO",        sub: "No ocupar",            color: "#991b1b", bg: "#fee2e2", ring: "#fca5a5" },
};

export function PlacardBadge({ placard, size = "md" }: { placard: Placard; size?: "sm" | "md" | "lg" }) {
  const cfg = CFG[placard];
  const dims = {
    sm: { padX: 10, padY: 6, fs: 11, sub: 9 },
    md: { padX: 18, padY: 10, fs: 14, sub: 11 },
    lg: { padX: 28, padY: 18, fs: 20, sub: 13 },
  }[size];
  return (
    <div
      style={{
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "center",
        padding: `${dims.padY}px ${dims.padX}px`,
        borderRadius: 10,
        background: cfg.bg,
        border: `2px solid ${cfg.ring}`,
        color: cfg.color,
        lineHeight: 1.2,
      }}
    >
      <span style={{ fontSize: dims.fs, fontWeight: 800, letterSpacing: ".05em" }}>{cfg.label}</span>
      <span style={{ fontSize: dims.sub, fontWeight: 600, opacity: 0.85 }}>{cfg.sub}</span>
    </div>
  );
}

export function PlacardDot({ placard }: { placard: Placard }) {
  const cfg = CFG[placard];
  return (
    <span
      title={cfg.label}
      style={{
        display: "inline-block",
        width: 10, height: 10, borderRadius: 999,
        background: cfg.color,
      }}
    />
  );
}
