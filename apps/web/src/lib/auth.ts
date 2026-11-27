const TOKEN_KEY = "pl_token";
const ME_KEY    = "pl_me";

export type UserRole = "admin" | "collaborator";

export interface CurrentUser {
  id: string;
  email: string;
  full_name: string;
  plan: string;
  role: UserRole;
  /** Prefijos de ruta permitidos cuando `role === "collaborator"`. `null` => sin restriccion. */
  allowed_modules: string[] | null;
  created_at: string;
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(ME_KEY);
}

export function getMe(): CurrentUser | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(ME_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CurrentUser;
  } catch {
    return null;
  }
}

export function setMe(user: CurrentUser): void {
  window.localStorage.setItem(ME_KEY, JSON.stringify(user));
}

/** Decide si un pathname cae dentro de los modulos permitidos del usuario. */
export function isPathAllowed(pathname: string, me: CurrentUser | null): boolean {
  if (!me) return true;                 // sin perfil cargado aun — deja pasar, el layout vuelve a chequear
  if (me.allowed_modules === null) return true;  // admin
  return me.allowed_modules.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** Ruta de aterrizaje tras login segun rol. */
export function homeRouteFor(me: CurrentUser): string {
  if (me.role === "collaborator") return "/ground-motion";
  return "/dashboard";
}
