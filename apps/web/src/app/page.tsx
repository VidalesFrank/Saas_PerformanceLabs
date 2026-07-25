import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col bg-bg">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <span className="font-mono text-sm font-semibold tracking-widest text-accent">
            PERFORMANCE<span className="text-text">LABS</span>
          </span>
          <nav className="flex items-center gap-3">
            <Link href="/login">
              <Button variant="ghost">Ingresar</Button>
            </Link>
            <Link href="/register">
              <Button variant="primary">Crear cuenta</Button>
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto flex max-w-4xl flex-1 flex-col items-start justify-center gap-6 px-6 py-24">
        <span className="font-mono text-xs uppercase tracking-[0.2em] text-text-muted">
          Ingenieria sismica basada en OpenSees
        </span>
        <h1 className="text-4xl font-semibold leading-tight tracking-tight text-text sm:text-5xl">
          Del modelo estructural a la decision de refuerzo,
          <br className="hidden sm:block" /> en una sola plataforma.
        </h1>
        <p className="max-w-2xl text-base leading-7 text-text-muted">
          Secciones de fibras, analisis lineal y no lineal, evaluacion de desempeno
          y riesgo sismico sobre un motor de calculo en Python que tu controlas.
        </p>
        <div className="flex gap-3 pt-2">
          <Link href="/register">
            <Button variant="primary" className="px-6 py-3 text-base">
              Empezar ahora
            </Button>
          </Link>
          <Link href="/login">
            <Button variant="secondary" className="px-6 py-3 text-base">
              Ya tengo cuenta
            </Button>
          </Link>
        </div>
      </main>
    </div>
  );
}
