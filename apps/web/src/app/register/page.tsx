"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { HeroShowcase3D } from "@/components/dashboard/HeroShowcase3D";
import { ApiError, api } from "@/lib/api";
import { setToken } from "@/lib/auth";

export default function RegisterPage() {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.post(
        "/api/v1/auth/register",
        { email, password, full_name: fullName },
        false,
      );
      const { access_token } = await api.post<{ access_token: string }>(
        "/api/v1/auth/login",
        { email, password },
        false,
      );
      setToken(access_token);
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo crear la cuenta");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-1">
      {/* ── Columna izquierda: dark hero con wireframe 3D ────────────────── */}
      <aside className="pl-hero-dark relative hidden min-h-screen flex-1 flex-col justify-between overflow-hidden lg:flex">
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

        <div className="relative z-0 flex flex-1 items-center justify-center">
          <HeroShowcase3D height={500} />
        </div>

        <div className="relative z-10 px-10 pb-12">
          <div className="pl-hero-pill mb-4">
            <span className="pl-hero-pill-dot" />
            Ingeniería sísmica · OpenSees
          </div>
          <h2 className="pl-hero-headline mb-3 text-[28px] md:text-[32px]">
            Ingeniería estructural
            <br />
            <span className="pl-hero-gradient-text">de alto desempeño.</span>
          </h2>
          <p className="max-w-md text-[13px] leading-relaxed text-slate-300/85">
            Análisis no lineal 3D, evaluación de desempeño y riesgo sísmico
            con NSR-10, ASCE 41 y FEMA integrados.
          </p>
        </div>
      </aside>

      {/* ── Columna derecha: formulario ──────────────────────────────────── */}
      <section className="flex flex-1 items-center justify-center bg-bg px-6 py-16">
        <div className="w-full max-w-sm">
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
              Crear cuenta
            </div>
            <h1 className="text-[26px] font-bold leading-tight tracking-tight text-text">
              Empieza a usar PerformanceLabs
            </h1>
            <p className="mt-1.5 text-[13px] text-text-muted">
              En menos de un minuto estás modelando tu primer edificio.
            </p>
          </div>

          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div>
              <Label htmlFor="full_name">Nombre completo</Label>
              <Input
                id="full_name"
                autoComplete="name"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
              />
            </div>
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
                autoComplete="new-password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <p className="mt-1 text-[10.5px] text-text-muted">Mínimo 8 caracteres.</p>
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
              {loading ? "Creando…" : "Crear cuenta"}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-text-muted">
            ¿Ya tienes cuenta?{" "}
            <Link
              href="/login"
              className="font-semibold text-[var(--tech-cyan-strong)] hover:underline"
            >
              Ingresar
            </Link>
          </p>
        </div>
      </section>
    </div>
  );
}
