"use client";

import { FormEvent, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { InteractionChart } from "@/components/interaction-chart";
import { SectionPreview } from "@/components/section-preview";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { ApiError, api } from "@/lib/api";
import type { InteractionResultOut, SectionCreatePayload, SectionOut, ShapeType } from "@/lib/types";
import { useRequireAuth } from "@/lib/use-require-auth";

const BAR_IDS = ["#3", "#4", "#5", "#6", "#7", "#8", "#9", "#10", "#11"];

const DEFAULT_FORM = {
  name: "Columna C1",
  shape_type: "rectangular" as ShapeType,
  width: 400,
  height: 400,
  diameter: 500,
  side: 400,
  verticesText: "-200,-150\n200,-150\n200,150\n-200,150",
  barsText: "-152,-112\n152,-112\n-152,112\n152,112",
  cover: 40,
  fpc: 28,
  fy: 420,
  es: 200000,
  hoop_bar_diameter: 9.5,
  hoop_spacing: 150,
  hoop_legs_x: 2,
  hoop_legs_y: 2,
  hoop_leg_area: 71,
  is_spiral: true,
  n_bars_y: 3,
  n_bars_z: 3,
  n_bars: 8,
  bar_id: "#8",
  cover_to_bar_centroid: 52,
};

type FormState = typeof DEFAULT_FORM;

function parsePairs(text: string): [number, number][] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [a, b] = line.split(",").map((v) => parseFloat(v.trim()));
      return [a, b] as [number, number];
    })
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
}

export default function InteractionDiagramPage() {
  const ready = useRequireAuth();
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<SectionOut | null>(null);
  const [result, setResult] = useState<InteractionResultOut | null>(null);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function buildPayload(): SectionCreatePayload {
    const base: SectionCreatePayload = {
      name: form.name,
      shape_type: form.shape_type,
      cover: form.cover,
      fpc: form.fpc,
      fy: form.fy,
      es: form.es,
      bar_id: form.bar_id,
      cover_to_bar_centroid: form.cover_to_bar_centroid,
      hoop_bar_diameter: form.hoop_bar_diameter,
      hoop_spacing: form.hoop_spacing,
      hoop_legs_x: form.hoop_legs_x,
      hoop_legs_y: form.hoop_legs_y,
      hoop_leg_area: form.hoop_leg_area,
      is_spiral: form.is_spiral,
    };

    if (form.shape_type === "rectangular") {
      return { ...base, width: form.width, height: form.height, n_bars_y: form.n_bars_y, n_bars_z: form.n_bars_z };
    }
    if (form.shape_type === "square") {
      return { ...base, width: form.side, height: form.side, n_bars_y: form.n_bars_y, n_bars_z: form.n_bars_z };
    }
    if (form.shape_type === "circular") {
      return { ...base, diameter: form.diameter, n_bars: form.n_bars };
    }
    // special
    return {
      ...base,
      vertices: parsePairs(form.verticesText),
      bars: parsePairs(form.barsText),
      cover_to_bar_centroid: undefined,
    };
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    setResult(null);
    try {
      const payload = buildPayload();
      const createdSection = await api.post<SectionOut>("/api/v1/sections", payload);
      setSection(createdSection);
      const diagram = await api.post<InteractionResultOut>(
        `/api/v1/sections/${createdSection.id}/interaction-diagram`
      );
      setResult(diagram);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo calcular el diagrama");
    } finally {
      setLoading(false);
    }
  }

  if (!ready) return null;

  return (
    <div className="flex flex-1 flex-col">
      <AppHeader crumb="Diagrama de interaccion" />
      <main className="mx-auto grid w-full max-w-6xl flex-1 grid-cols-1 gap-6 px-6 py-10 lg:grid-cols-[420px_1fr]">
        <Card className="h-fit">
          <CardHeader>
            <h1 className="text-lg font-semibold text-text">Diagrama de interaccion P-M</h1>
            <p className="mt-1 text-xs text-text-muted">
              Columnas, muros y pilas: rectangular, cuadrada, circular o especial.
            </p>
          </CardHeader>
          <CardBody>
            <form onSubmit={onSubmit} className="flex flex-col gap-5">
              <div>
                <Label htmlFor="name">Nombre de la seccion</Label>
                <Input id="name" value={form.name} onChange={(e) => update("name", e.target.value)} required />
              </div>

              <div>
                <Label>Forma</Label>
                <div className="grid grid-cols-4 gap-2">
                  {(["rectangular", "square", "circular", "special"] as ShapeType[]).map((s) => (
                    <button
                      type="button"
                      key={s}
                      onClick={() => update("shape_type", s)}
                      className={`rounded-md border px-2 py-1.5 text-xs font-medium capitalize transition-colors ${
                        form.shape_type === s
                          ? "border-accent bg-accent/10 text-accent"
                          : "border-border text-text-muted hover:text-text"
                      }`}
                    >
                      {{ rectangular: "Rect.", square: "Cuadrada", circular: "Circular", special: "Especial" }[s]}
                    </button>
                  ))}
                </div>
              </div>

              {form.shape_type === "rectangular" && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="width">Ancho b (mm)</Label>
                    <Input id="width" type="number" value={form.width} onChange={(e) => update("width", +e.target.value)} />
                  </div>
                  <div>
                    <Label htmlFor="height">Altura h (mm)</Label>
                    <Input id="height" type="number" value={form.height} onChange={(e) => update("height", +e.target.value)} />
                  </div>
                </div>
              )}

              {form.shape_type === "square" && (
                <div>
                  <Label htmlFor="side">Lado (mm)</Label>
                  <Input id="side" type="number" value={form.side} onChange={(e) => update("side", +e.target.value)} />
                </div>
              )}

              {form.shape_type === "circular" && (
                <div>
                  <Label htmlFor="diameter">Diametro (mm)</Label>
                  <Input id="diameter" type="number" value={form.diameter} onChange={(e) => update("diameter", +e.target.value)} />
                </div>
              )}

              {form.shape_type === "special" && (
                <div className="flex flex-col gap-3">
                  <div>
                    <Label htmlFor="vertices">Vertices del contorno (y,z por linea, mm)</Label>
                    <textarea
                      id="vertices"
                      value={form.verticesText}
                      onChange={(e) => update("verticesText", e.target.value)}
                      rows={4}
                      className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-xs text-text"
                    />
                  </div>
                  <div>
                    <Label htmlFor="bars">Barras (y,z por linea, mm)</Label>
                    <textarea
                      id="bars"
                      value={form.barsText}
                      onChange={(e) => update("barsText", e.target.value)}
                      rows={4}
                      className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-xs text-text"
                    />
                  </div>
                </div>
              )}

              <div>
                <Label htmlFor="cover">Recubrimiento libre (mm)</Label>
                <Input id="cover" type="number" value={form.cover} onChange={(e) => update("cover", +e.target.value)} />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label htmlFor="fpc">f&apos;c (MPa)</Label>
                  <Input id="fpc" type="number" value={form.fpc} onChange={(e) => update("fpc", +e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="fy">fy (MPa)</Label>
                  <Input id="fy" type="number" value={form.fy} onChange={(e) => update("fy", +e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="es">Es (MPa)</Label>
                  <Input id="es" type="number" value={form.es} onChange={(e) => update("es", +e.target.value)} />
                </div>
              </div>

              {form.shape_type !== "special" && (
                <>
                  <div className="border-t border-border pt-4">
                    <p className="mb-3 text-xs font-medium uppercase tracking-wide text-text-muted">
                      Confinamiento (estribos)
                    </p>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label htmlFor="hoop_bar_diameter">Diam. estribo (mm)</Label>
                        <Input
                          id="hoop_bar_diameter"
                          type="number"
                          value={form.hoop_bar_diameter}
                          onChange={(e) => update("hoop_bar_diameter", +e.target.value)}
                        />
                      </div>
                      <div>
                        <Label htmlFor="hoop_spacing">Espaciamiento s (mm)</Label>
                        <Input
                          id="hoop_spacing"
                          type="number"
                          value={form.hoop_spacing}
                          onChange={(e) => update("hoop_spacing", +e.target.value)}
                        />
                      </div>
                      <div>
                        <Label htmlFor="hoop_leg_area">Area rama estribo (mm2)</Label>
                        <Input
                          id="hoop_leg_area"
                          type="number"
                          value={form.hoop_leg_area}
                          onChange={(e) => update("hoop_leg_area", +e.target.value)}
                        />
                      </div>
                      {form.shape_type !== "circular" ? (
                        <>
                          <div>
                            <Label htmlFor="hoop_legs_x">Ramas en x</Label>
                            <Input
                              id="hoop_legs_x"
                              type="number"
                              value={form.hoop_legs_x}
                              onChange={(e) => update("hoop_legs_x", +e.target.value)}
                            />
                          </div>
                          <div>
                            <Label htmlFor="hoop_legs_y">Ramas en y</Label>
                            <Input
                              id="hoop_legs_y"
                              type="number"
                              value={form.hoop_legs_y}
                              onChange={(e) => update("hoop_legs_y", +e.target.value)}
                            />
                          </div>
                        </>
                      ) : (
                        <div className="col-span-2 flex items-center gap-2">
                          <input
                            id="is_spiral"
                            type="checkbox"
                            checked={form.is_spiral}
                            onChange={(e) => update("is_spiral", e.target.checked)}
                          />
                          <label htmlFor="is_spiral" className="text-xs text-text-muted">
                            Zuncho continuo (espiral)
                          </label>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="border-t border-border pt-4">
                    <p className="mb-3 text-xs font-medium uppercase tracking-wide text-text-muted">
                      Refuerzo longitudinal
                    </p>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label htmlFor="bar_id">Barra</Label>
                        <select
                          id="bar_id"
                          value={form.bar_id}
                          onChange={(e) => update("bar_id", e.target.value)}
                          className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text"
                        >
                          {BAR_IDS.map((b) => (
                            <option key={b} value={b}>
                              {b}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <Label htmlFor="cover_to_bar_centroid">Recub. a centroide barra (mm)</Label>
                        <Input
                          id="cover_to_bar_centroid"
                          type="number"
                          value={form.cover_to_bar_centroid}
                          onChange={(e) => update("cover_to_bar_centroid", +e.target.value)}
                        />
                      </div>
                      {form.shape_type === "circular" ? (
                        <div>
                          <Label htmlFor="n_bars">Numero de barras</Label>
                          <Input id="n_bars" type="number" value={form.n_bars} onChange={(e) => update("n_bars", +e.target.value)} />
                        </div>
                      ) : (
                        <>
                          <div>
                            <Label htmlFor="n_bars_y">Barras cara sup./inf.</Label>
                            <Input
                              id="n_bars_y"
                              type="number"
                              value={form.n_bars_y}
                              onChange={(e) => update("n_bars_y", +e.target.value)}
                            />
                          </div>
                          <div>
                            <Label htmlFor="n_bars_z">Barras cara izq./der.</Label>
                            <Input
                              id="n_bars_z"
                              type="number"
                              value={form.n_bars_z}
                              onChange={(e) => update("n_bars_z", +e.target.value)}
                            />
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </>
              )}

              {error && <p className="text-sm text-danger">{error}</p>}

              <Button type="submit" disabled={loading} className="w-full">
                {loading ? "Calculando..." : "Calcular diagrama de interaccion"}
              </Button>
            </form>
          </CardBody>
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <h2 className="text-sm font-medium text-text">Vista previa de la seccion</h2>
            </CardHeader>
            <CardBody className="flex justify-center">
              <SectionPreview
                shapeType={form.shape_type}
                width={form.shape_type === "square" ? form.side : form.width}
                height={form.shape_type === "square" ? form.side : form.height}
                diameter={form.diameter}
                cover={form.cover}
                coverToBarCentroid={form.cover_to_bar_centroid}
                nBarsY={form.n_bars_y}
                nBarsZ={form.n_bars_z}
                nBars={form.n_bars}
                vertices={form.shape_type === "special" ? parsePairs(form.verticesText) : undefined}
                bars={form.shape_type === "special" ? parsePairs(form.barsText) : undefined}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <h2 className="text-sm font-medium text-text">
                {section ? `Diagrama de interaccion — ${section.name}` : "Diagrama de interaccion"}
              </h2>
            </CardHeader>
            <CardBody>
              {!result && !loading && (
                <p className="text-sm text-text-muted">
                  Completa la seccion y calcula para ver el diagrama P-M.
                </p>
              )}
              {loading && <p className="text-sm text-text-muted">Ejecutando analisis en OpenSees...</p>}
              {result && (
                <>
                  <InteractionChart points={result.points} />
                  <dl className="mt-4 grid grid-cols-3 gap-4 border-t border-border pt-4 text-xs">
                    <div>
                      <dt className="text-text-muted">P max. compresion</dt>
                      <dd className="font-mono text-text">{(result.result_metadata.p_max_compresion / 1000).toFixed(0)} kN</dd>
                    </div>
                    <div>
                      <dt className="text-text-muted">P max. tension</dt>
                      <dd className="font-mono text-text">{(result.result_metadata.p_max_tension / 1000).toFixed(0)} kN</dd>
                    </div>
                    <div>
                      <dt className="text-text-muted">M max.</dt>
                      <dd className="font-mono text-text">{(result.result_metadata.m_max / 1e6).toFixed(1)} kN·m</dd>
                    </div>
                  </dl>
                </>
              )}
            </CardBody>
          </Card>
        </div>
      </main>
    </div>
  );
}
