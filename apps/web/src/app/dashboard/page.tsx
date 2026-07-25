"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EstadoBadge, NivelBadge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import type { CatalogModule } from "@/lib/types";
import { useRequireAuth } from "@/lib/use-require-auth";

export default function DashboardPage() {
  const ready = useRequireAuth();
  const [modules, setModules] = useState<CatalogModule[] | null>(null);

  useEffect(() => {
    if (!ready) return;
    api.get<CatalogModule[]>("/api/v1/catalog").then(setModules).catch(() => setModules([]));
  }, [ready]);

  if (!ready) return null;

  return (
    <div className="flex flex-1 flex-col">
      <AppHeader crumb="Dashboard" />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
        <h1 className="mb-1 text-2xl font-semibold text-text">Modulos</h1>
        <p className="mb-8 text-sm text-text-muted">
          Catalogo completo de la plataforma. Los productos activos abren su herramienta;
          el resto muestra su estado de desarrollo.
        </p>

        {!modules && <p className="text-sm text-text-muted">Cargando catalogo...</p>}

        <div className="flex flex-col gap-10">
          {modules?.map((mod) => (
            <section key={mod.id}>
              <h2 className="mb-3 font-mono text-xs uppercase tracking-[0.15em] text-text-muted">
                {mod.name}
              </h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {mod.products.map((product) => {
                  const content = (
                    <Card
                      className={`h-full transition-colors ${
                        product.route ? "hover:border-accent" : "opacity-70"
                      }`}
                    >
                      <CardHeader className="flex items-start justify-between gap-2">
                        <span className="text-sm font-medium text-text">{product.name}</span>
                      </CardHeader>
                      <CardBody className="flex items-center gap-2">
                        <NivelBadge nivel={product.nivel} />
                        <EstadoBadge estado={product.estado} />
                        {!product.route && (
                          <span className="ml-auto text-xs text-text-muted">Proximamente</span>
                        )}
                      </CardBody>
                    </Card>
                  );
                  return product.route ? (
                    <Link key={product.id} href={product.route}>
                      {content}
                    </Link>
                  ) : (
                    <div key={product.id}>{content}</div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
