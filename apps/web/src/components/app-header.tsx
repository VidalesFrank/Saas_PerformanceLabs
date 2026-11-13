"use client";

import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { MODULE_CFG, ModuleIcon } from "@/lib/module-visuals";
import { clearToken } from "@/lib/auth";

/** Barra superior de cada herramienta.
 *
 * Detecta el módulo activo desde el pathname y muestra un chip con el
 * gradient del grupo (mismo esquema que dashboard + sidebar). El logo
 * global vive en el Sidebar persistente — aquí solo breadcrumb + chip
 * + acciones.
 *
 * El crumb se vuelve clickeable automáticamente cuando estás en una
 * sub-ruta del módulo (p.ej. /projects/[id] → click en "Constructor de
 * Modelos" te lleva a /projects). Si ya estás en la raíz del módulo, es
 * texto plano.
 */
export function AppHeader({ crumb }: { crumb?: string }) {
  const router = useRouter();
  const pathname = usePathname() ?? "";

  function logout() {
    clearToken();
    router.push("/login");
  }

  // Inferir módulo activo desde routePrefixes
  const activeEntry = Object.entries(MODULE_CFG).find(([, vis]) =>
    vis.routePrefixes.some((prefix) => pathname.startsWith(prefix)),
  );
  const activeVisual = activeEntry?.[1];

  // "Home" del módulo = primer prefix cuyo inicio matchea con el pathname.
  // Si estamos ahí mismo (pathname === crumbHome), el crumb no se linkea.
  const crumbHome = activeVisual?.routePrefixes.find((prefix) =>
    pathname.startsWith(prefix),
  );
  const isAtCrumbHome = crumbHome && (pathname === crumbHome || pathname === `${crumbHome}/`);
  const crumbIsLink = Boolean(crumbHome && !isAtCrumbHome);

  return (
    <header
      className="sticky top-0 z-30 border-b border-border backdrop-blur-md"
      style={{ background: "color-mix(in srgb, var(--color-surface) 82%, transparent)" }}
    >
      <div className="flex items-center justify-between px-6 py-3.5">
        <div className="flex items-center gap-3">
          {/* Botón "atrás" cuando estamos en una subpágina. Usa router.back()
              para respetar el historial real (p. ej. si viniste desde el
              dashboard y no desde la lista). */}
          {crumbIsLink && (
            <button
              type="button"
              onClick={() => router.back()}
              title="Volver"
              aria-label="Volver"
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-surface-2 text-text-muted transition-colors hover:border-[color-mix(in_srgb,var(--tech-cyan)_45%,var(--color-border))] hover:text-[var(--tech-cyan-strong)]"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
          )}

          {activeVisual && (
            <div
              className="flex h-8 w-8 items-center justify-center rounded-lg"
              style={{
                background: activeVisual.gradient,
                boxShadow: `0 6px 18px -10px ${activeVisual.accent}80`,
              }}
            >
              <ModuleIcon type={activeVisual.icon} color="#050b18" size={15} strokeWidth={2.2} />
            </div>
          )}
          <div className="flex items-baseline gap-2">
            <Link href="/dashboard" className="font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-text-muted hover:text-text transition-colors">
              Dashboard
            </Link>
            {crumb && (
              <>
                <span className="text-text-muted/50">/</span>
                {crumbIsLink ? (
                  <Link
                    href={crumbHome!}
                    className="font-mono text-[12.5px] font-semibold text-text transition-colors hover:text-[var(--tech-cyan-strong)]"
                    title={`Volver a ${crumb}`}
                  >
                    {crumb}
                  </Link>
                ) : (
                  <span className="font-mono text-[12.5px] font-semibold text-text">{crumb}</span>
                )}
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Button variant="ghost" size="sm" onClick={logout}>
            Cerrar sesión
          </Button>
        </div>
      </div>
    </header>
  );
}
