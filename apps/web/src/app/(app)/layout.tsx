"use client";

import { Sidebar } from "@/components/sidebar";
import { useAuthState } from "@/lib/use-require-auth";

/** Shell compartido por todas las herramientas autenticadas: sidebar persistente
 * + guard de sesion centralizado. `useAuthState` tambien aplica el gating por
 * rol: si un colaborador aterriza en una ruta fuera de `allowed_modules`, el
 * hook redirige a su home antes de montar el contenido. */
export default function AppGroupLayout({ children }: { children: React.ReactNode }) {
  const { ready } = useAuthState();
  if (!ready) return null;

  return (
    <div className="flex flex-1">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
