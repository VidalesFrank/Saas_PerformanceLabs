import Link from "next/link";
import { Button } from "@/components/ui/button";
import { HeroShowcase3D } from "@/components/dashboard/HeroShowcase3D";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-1 flex-col pl-hero-dark">
      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <header className="relative z-10 border-b border-white/5">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-8 py-5">
          <Link href="/" className="flex items-center gap-2">
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
          <nav className="flex items-center gap-2">
            <Link
              href="/login"
              className="rounded-lg px-3 py-1.5 text-[13px] font-semibold text-slate-200 transition-colors hover:bg-white/5"
            >
              Ingresar
            </Link>
            <Link href="/register" className="pl-cta-primary">
              Crear cuenta
              <svg
                width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"
              >
                <path d="M5 12h14M13 5l7 7-7 7" />
              </svg>
            </Link>
          </nav>
        </div>
      </header>

      {/* ── Hero principal ──────────────────────────────────────────────── */}
      <main className="relative z-10 mx-auto grid w-full max-w-7xl flex-1 grid-cols-1 items-center gap-12 px-8 py-16 lg:grid-cols-[1.1fr_1fr]">
        <div style={{ animation: "pl-fade-up 0.5s ease-out both" }}>
          <div className="pl-hero-pill mb-5">
            <span className="pl-hero-pill-dot" />
            Ingeniería sísmica basada en OpenSees
          </div>

          <h1 className="pl-hero-headline text-[40px] md:text-[52px] lg:text-[56px]">
            Del modelo estructural
            <br />
            <span className="pl-hero-gradient-text">a la decisión de refuerzo.</span>
          </h1>

          <p className="mt-6 max-w-xl text-[15px] leading-relaxed text-slate-300/90">
            Secciones de fibras, análisis no lineal 3D, evaluación de desempeño
            y riesgo sísmico sobre un motor de cálculo en Python que tú controlas.
            NSR-10, ASCE 41 y FEMA integrados.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link href="/register" className="pl-cta-primary">
              Empezar ahora
              <svg
                width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"
              >
                <path d="M5 12h14M13 5l7 7-7 7" />
              </svg>
            </Link>
            <Link href="/login" className="pl-cta-ghost">
              Ya tengo cuenta
            </Link>
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-5">
            <span className="pl-hero-chip">
              <span className="pl-hero-chip-icon">
                <svg
                  width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
                >
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                </svg>
              </span>
              OpenSees · OpenSeesPy
            </span>
            <span className="pl-hero-chip">
              <span className="pl-hero-chip-icon">
                <svg
                  width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
                >
                  <path d="M9 12l2 2 4-4M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </span>
              NSR-10 · ASCE 41 · FEMA
            </span>
            <span className="pl-hero-chip">
              <span className="pl-hero-chip-icon">
                <svg
                  width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
                >
                  <path d="M3 21h18M3 7l9-4 9 4M4 21V7M20 21V7M9 21v-4h6v4" />
                </svg>
              </span>
              Análisis no lineal 3D
            </span>
          </div>
        </div>

        <div
          className="relative flex items-center justify-center"
          style={{ animation: "pl-fade-up 0.6s 0.15s ease-out both" }}
        >
          <HeroShowcase3D height={480} />
        </div>
      </main>

      {/* ── Footer sutil ────────────────────────────────────────────────── */}
      <footer className="relative z-10 border-t border-white/5 px-8 py-5">
        <div className="mx-auto flex max-w-7xl items-center justify-between text-[11px] text-slate-500">
          <span>© PerformanceLabs · Ingeniería sísmica avanzada</span>
          <span className="font-mono">v1.0</span>
        </div>
      </footer>
    </div>
  );
}
