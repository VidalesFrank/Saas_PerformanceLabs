"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { HeroShowcase3D } from "@/components/dashboard/HeroShowcase3D";
import { ApiError, api } from "@/lib/api";
import { CurrentUser, homeRouteFor, setMe, setToken } from "@/lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { access_token } = await api.post<{ access_token: string }>(
        "/api/v1/auth/login",
        { email, password },
        false,
      );
      setToken(access_token);
      // Traemos /me inmediatamente para saber el rol y decidir landing.
      // Fallback a /dashboard si la peticion falla (el layout re-verifica).
      try {
        const me = await api.get<CurrentUser>("/api/v1/auth/me");
        setMe(me);
        router.push(homeRouteFor(me));
      } catch {
        router.push("/dashboard");
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo iniciar sesión");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-1">
      {/* ── Columna izquierda: dark hero con wireframe 3D ────────────────── */}
      <aside className="pl-hero-dark relative hidden min-h-screen flex-1 flex-col justify-between overflow-hidden lg:flex">
        {/* Logo top-left */}
        <Link href="/" className="relative z-10 flex items-center gap-2 px-10 pt-10">
          <span
            className="flex h-8 w-8 items-center justify-center rounded-lg"
            style={{ background: "linear-gradient(135deg, #22d3ee 0%, #3b82f6 100%)" }}
          >
            <span className="font-mono text-[11px] font-extrabold text-[#050b18]">PL</span>
          </span>
          <span className="font-mono text-[14px] font-bold tracking-wider">
            <span
              style={{
                background: "linear-gradient(135deg, #22d3ee 0%, #3b82f6 100%)",
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                color: "transparent",
              }}
            >
              PERFORMANCE
            </span>
            <span className="text-slate-100">LABS</span>
          </span>
        </Link>

        {/* Wireframe 3D vivo */}
        <div className="relative z-0 flex flex-1 items-center justify-center">
          <HeroShowcase3D height={500} />
        </div>

        {/* Pitch bottom-left */}
        <div className="relative z-10 px-10 pb-12">
          <div className="pl-hero-pill mb-4">
            <span className="pl-hero-pill-dot" />
            Ingeniería sísmica · OpenSees
          </div>
          <h2 className="pl-hero-headline mb-3 text-[28px] md:text-[32px]">
            Del modelo estructural
            <br />
            <span className="pl-hero-gradient-text">a la decisión de refuerzo.</span>
          </h2>
          <p className="max-w-md text-[13px] leading-relaxed text-slate-300/85">
            Secciones de fibras, análisis no lineal 3D, evaluación de desempeño
            y riesgo sísmico — en una sola plataforma.
          </p>
        </div>
      </aside>

      {/* ── Columna derecha: formulario sobre fondo claro ────────────────── */}
      <section className="flex flex-1 items-center justify-center bg-bg px-6 py-16">
        <div className="w-full max-w-sm">
          {/* Logo compacto visible solo en móvil */}
          <Link href="/" className="mb-8 flex items-center justify-center gap-2 lg:hidden">
            <span
              className="flex h-7 w-7 items-center justify-center rounded-md"
              style={{ background: "linear-gradient(135deg, #22d3ee 0%, #3b82f6 100%)" }}
            >
              <span className="font-mono text-[10px] font-extrabold text-[#050b18]">PL</span>
            </span>
            <span className="font-mono text-[13px] font-bold tracking-wider">
              <span
                style={{
                  background: "linear-gradient(135deg, #22d3ee 0%, #3b82f6 100%)",
                  WebkitBackgroundClip: "text",
                  backgroundClip: "text",
                  color: "transparent",
                }}
              >
                PERFORMANCE
              </span>
              <span className="text-text">LABS</span>
            </span>
          </Link>

          <div className="mb-7">
            <div className="mb-2 inline-flex items-center gap-2 text-[10.5px] font-bold uppercase tracking-[0.14em] text-[var(--tech-cyan-strong)]">
              <span
                className="inline-block h-1 w-1 rounded-full"
                style={{ background: "var(--tech-cyan)", boxShadow: "0 0 6px var(--tech-cyan)" }}
              />
              Iniciar sesión
            </div>
            <h1 className="text-[26px] font-bold leading-tight tracking-tight text-text">
              Bienvenido de nuevo
            </h1>
            <p className="mt-1.5 text-[13px] text-text-muted">
              Accede a tu cuenta de PerformanceLabs.
            </p>
          </div>

          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div>
              <Label htmlFor="email">Correo</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="password">Contraseña</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error && (
              <div
                className="rounded-md border px-3 py-2 text-[12px]"
                style={{
                  background: "rgba(239, 68, 68, 0.08)",
                  borderColor: "rgba(239, 68, 68, 0.3)",
                  color: "#dc2626",
                }}
              >
                {error}
              </div>
            )}
            <Button type="submit" size="lg" disabled={loading} className="mt-2 w-full">
              {loading ? "Ingresando…" : "Ingresar"}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-text-muted">
            ¿No tienes cuenta?{" "}
            <Link
              href="/register"
              className="font-semibold text-[var(--tech-cyan-strong)] hover:underline"
            >
              Crear una
            </Link>
          </p>
        </div>
      </section>
    </div>
  );
}
