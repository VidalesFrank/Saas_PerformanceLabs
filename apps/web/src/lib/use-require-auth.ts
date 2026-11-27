"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "./api";
import {
  CurrentUser,
  clearToken,
  getMe,
  getToken,
  homeRouteFor,
  isPathAllowed,
  setMe,
} from "./auth";

export interface AuthState {
  /** true cuando la sesion fue verificada (token + perfil + guard de ruta). */
  ready: boolean;
  /** Perfil del usuario actual. Null mientras `ready === false`. */
  me: CurrentUser | null;
}

/** Hook base: valida token, trae `/me`, gatea por `allowed_modules` segun rol.
 *  - Sin token              → redirige a /login.
 *  - Token invalido         → limpia estado y redirige a /login.
 *  - Ruta fuera de permisos → redirige a la home del rol (admin: /dashboard, collaborator: /ground-motion).
 *  - Todo OK                → `ready=true` y `me` disponible.
 *
 *  El layout `(app)/layout.tsx` llama a `useAuthState()` para obtener `me`.
 *  Las paginas individuales siguen llamando `useRequireAuth()` (boolean) por
 *  retrocompatibilidad — solo necesitan saber si pueden renderizar.
 */
export function useAuthState(): AuthState {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const [me, setLocalMe] = useState<CurrentUser | null>(() => getMe());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const fresh = await api.get<CurrentUser>("/api/v1/auth/me");
        if (cancelled) return;
        setMe(fresh);
        setLocalMe(fresh);

        if (!isPathAllowed(pathname, fresh)) {
          router.replace(homeRouteFor(fresh));
          return;
        }
        setReady(true);
      } catch {
        if (cancelled) return;
        clearToken();
        router.replace("/login");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router, pathname]);

  return { ready, me };
}

/** Variante retrocompatible: devuelve solo `ready` (lo que esperaban
 *  los ~20 callers actuales). */
export function useRequireAuth(): boolean {
  return useAuthState().ready;
}
