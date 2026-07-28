"use client";

import { FormEvent, useMemo, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { PMMSurface3D, PMMEnvelopeChart, MxMyPanel } from "@/components/pmm-chart";
import { SectionPreview } from "@/components/section-preview";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { ApiError, api } from "@/lib/api";
import type { PMMSurfaceResultOut, SectionCreatePayload, SectionOut, ShapeType } from "@/lib/types";
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
  num_angles: 8,
  num_points: 10,
};

type FormState = typeof DEFAULT_FORM;

interface Demand { pu: string; mxu: string; myu: string }

function parsePairs(text: string): [number, number][] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [a, b] = l.split(",").map((v) => parseFloat(v.trim()));
      return [a, b] as [number, number];
    })
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
}

function Views2D({ result, defaultP }: { result: PMMSurfaceResultOut; defaultP: number }) {
  const [tab, setTab] = useState<"envelope" | "section">("envelope");
  return (
    <div className="flex flex-col gap-4">
      <div className="flex rounded-md border border-border overflow-hidden text-xs w-fit">
        {(["envelope", "section"] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)}
            className={`px-3 py-1.5 font-medium transition-colors ${
              tab === t ? "bg-accent text-white" : "bg-surface text-text-muted hover:text-text"
            }`}>
            {t === "envelope" ? "P-M envolvente" : "Mx-My seccion"}
          </button>
        ))}
      </div>

      {tab === "envelope" && (
        <div>
          <PMMEnvelopeChart curves={result.curves} demands={result.demands_out} />
          <dl className="mt-4 grid grid-cols-3 gap-4 border-t border-border pt-4 text-xs">
            <div>
              <dt className="text-text-muted">P compresion pura</dt>
              <dd className="font-mono text-text">{result.p_max_kn.toFixed(0)} kN</dd>
            </div>
            <div>
              <dt className="text-text-muted">P tension pura</dt>
              <dd className="font-mono text-text">{result.p_min_kn.toFixed(0)} kN</dd>
            </div>
            <div>
              <dt className="text-text-muted">M resultante max.</dt>
              <dd className="font-mono text-text">{result.m_max_knm.toFixed(1)} kN·m</dd>
            </div>
          </dl>
        </div>
      )}

      {tab === "section" && (
        <div>
          <p className="mb-3 text-xs text-text-muted">
            Contorno de capacidad biaxial Mx-My a un nivel de P fijo. Punto relleno = demanda;
            circulo vacio = capacidad en esa direccion.
          </p>
          <MxMyPanel curves={result.curves} demands={result.demands_out} defaultP={defaultP} />
        </div>
      )}
    </div>
  );
}

export default function PMMPage() {
  const ready = useRequireAuth();
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PMMSurfaceResultOut | null>(null);
  const [demands, setDemands] = useState<Demand[]>([{ pu: "", mxu: "", myu: "" }]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const isRectLike = form.shape_type === "rectangular" || form.shape_type === "square";
  const sectionWidth = form.shape_type === "square" ? form.side : form.width;
  const sectionHeight = form.shape_type === "square" ? form.side : form.height;

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
    if (form.shape_type === "rectangular") return { ...base, width: form.width, height: form.height, n_bars_y: form.n_bars_y, n_bars_z: form.n_bars_z };
    if (form.shape_type === "square") return { ...base, width: form.side, height: form.side, n_bars_y: form.n_bars_y, n_bars_z: form.n_bars_z };
    if (form.shape_type === "circular") return { ...base, diameter: form.diameter, n_bars: form.n_bars };
    return { ...base, vertices: parsePairs(form.verticesText), bars: parsePairs(form.barsText), cover_to_bar_centroid: undefined };
  }

  const validDemands = useMemo(
    () =>
      demands
        .filter((d) => d.pu !== "" && d.mxu !== "" && d.myu !== "")
        .map((d) => ({ p_kn: +d.pu, mx_knm: +d.mxu, my_knm: +d.myu }))
        .filter((d) => Number.isFinite(d.p_kn) && Number.isFinite(d.mx_knm) && Number.isFinite(d.my_knm)),
    [demands],
  );

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    setResult(null);
    try {
      const payload = buildPayload();
      const sec = await api.post<SectionOut>("/api/v1/sections", payload);
      const res = await api.post<PMMSurfaceResultOut>(`/api/v1/sections/${sec.id}/pmm-surface`, {
        num_angles: form.num_angles,
        num_points: form.num_points,
        demands: validDemands,
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Error calculando la superficie P-M-M");
    } finally {
      setLoading(false);
    }
  }

  function addDemandRow() {
    setDemands((d) => [...d, { pu: "", mxu: "", myu: "" }]);
  }
  function updateDemand(i: number, field: keyof Demand, val: string) {
    setDemands((d) => d.map((row, idx) => (idx === i ? { ...row, [field]: val } : row)));
  }
  function removeDemandRow(i: number) {
    setDemands((d) => d.filter((_, idx) => idx !== i));
  }

  const defaultP = result
    ? (result.p_max_kn + result.p_min_kn) / 2
    : 0;

  if (!ready) return null;

  return (
    <div className="flex flex-1 flex-col">
      <AppHeader crumb="Interaccion Biaxial P-M-M" />
      <main className="mx-auto grid w-full max-w-7xl flex-1 grid-cols-1 gap-6 px-6 py-10 lg:grid-cols-[400px_1fr]">

        {/* ── Formulario ── */}
        <Card className="h-fit">
          <CardHeader>
            <h1 className="text-lg font-semibold text-text">Superficie de interaccion P-M-M</h1>
            <p className="mt-1 text-xs text-text-muted">
              Interaccion biaxial completa. Secciones rectangular, cuadrada, circular o especial.
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
                    <button type="button" key={s} onClick={() => update("shape_type", s)}
                      className={`rounded-md border px-2 py-1.5 text-xs font-medium capitalize transition-colors ${
                        form.shape_type === s ? "border-accent bg-accent/10 text-accent" : "border-border text-text-muted hover:text-text"
                      }`}>
                      {{ rectangular: "Rect.", square: "Cuadrada", circular: "Circular", special: "Especial" }[s]}
                    </button>
                  ))}
                </div>
              </div>

              {form.shape_type === "rectangular" && (
                <div className="grid grid-cols-2 gap-3">
                  <div><Label htmlFor="width">Ancho b (mm)</Label><Input id="width" type="number" value={form.width} onChange={(e) => update("width", +e.target.value)} /></div>
                  <div><Label htmlFor="height">Altura h (mm)</Label><Input id="height" type="number" value={form.height} onChange={(e) => update("height", +e.target.value)} /></div>
                </div>
              )}
              {form.shape_type === "square" && (
                <div><Label htmlFor="side">Lado (mm)</Label><Input id="side" type="number" value={form.side} onChange={(e) => update("side", +e.target.value)} /></div>
              )}
              {form.shape_type === "circular" && (
                <div><Label htmlFor="diameter">Diametro (mm)</Label><Input id="diameter" type="number" value={form.diameter} onChange={(e) => update("diameter", +e.target.value)} /></div>
              )}
              {form.shape_type === "special" && (
                <div className="flex flex-col gap-3">
                  <div>
                    <Label>Vertices del contorno (y,z mm)</Label>
                    <textarea value={form.verticesText} onChange={(e) => update("verticesText", e.target.value)} rows={4}
                      className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-xs text-text" />
                  </div>
                  <div>
                    <Label>Barras (y,z mm)</Label>
                    <textarea value={form.barsText} onChange={(e) => update("barsText", e.target.value)} rows={4}
                      className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-xs text-text" />
                  </div>
                </div>
              )}

              <div><Label htmlFor="cover">Recubrimiento libre (mm)</Label><Input id="cover" type="number" value={form.cover} onChange={(e) => update("cover", +e.target.value)} /></div>

              <div className="grid grid-cols-3 gap-3">
                <div><Label>f&apos;c (MPa)</Label><Input type="number" value={form.fpc} onChange={(e) => update("fpc", +e.target.value)} /></div>
                <div><Label>fy (MPa)</Label><Input type="number" value={form.fy} onChange={(e) => update("fy", +e.target.value)} /></div>
                <div><Label>Es (MPa)</Label><Input type="number" value={form.es} onChange={(e) => update("es", +e.target.value)} /></div>
              </div>

              {form.shape_type !== "special" && (
                <>
                  <div className="border-t border-border pt-4">
                    <p className="mb-3 text-xs font-medium uppercase tracking-wide text-text-muted">Confinamiento</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div><Label>Diam. estribo (mm)</Label><Input type="number" value={form.hoop_bar_diameter} onChange={(e) => update("hoop_bar_diameter", +e.target.value)} /></div>
                      <div><Label>Espaciamiento s (mm)</Label><Input type="number" value={form.hoop_spacing} onChange={(e) => update("hoop_spacing", +e.target.value)} /></div>
                      <div><Label>Area rama (mm²)</Label><Input type="number" value={form.hoop_leg_area} onChange={(e) => update("hoop_leg_area", +e.target.value)} /></div>
                      {form.shape_type !== "circular" ? (
                        <>
                          <div><Label>Ramas en x</Label><Input type="number" value={form.hoop_legs_x} onChange={(e) => update("hoop_legs_x", +e.target.value)} /></div>
                          <div><Label>Ramas en y</Label><Input type="number" value={form.hoop_legs_y} onChange={(e) => update("hoop_legs_y", +e.target.value)} /></div>
                        </>
                      ) : (
                        <div className="col-span-2 flex items-center gap-2">
                          <input id="spiral" type="checkbox" checked={form.is_spiral} onChange={(e) => update("is_spiral", e.target.checked)} />
                          <label htmlFor="spiral" className="text-xs text-text-muted">Zuncho continuo (espiral)</label>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="border-t border-border pt-4">
                    <p className="mb-3 text-xs font-medium uppercase tracking-wide text-text-muted">Refuerzo longitudinal</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label>Barra</Label>
                        <select value={form.bar_id} onChange={(e) => update("bar_id", e.target.value)}
                          className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text">
                          {BAR_IDS.map((b) => <option key={b} value={b}>{b}</option>)}
                        </select>
                      </div>
                      <div><Label>Recub. a centroide (mm)</Label><Input type="number" value={form.cover_to_bar_centroid} onChange={(e) => update("cover_to_bar_centroid", +e.target.value)} /></div>
                      {form.shape_type === "circular" && (
                        <div><Label>Numero de barras</Label><Input type="number" value={form.n_bars} onChange={(e) => update("n_bars", +e.target.value)} /></div>
                      )}
                      {isRectLike && (
                        <>
                          <div><Label>Barras cara sup./inf.</Label><Input type="number" value={form.n_bars_y} onChange={(e) => update("n_bars_y", +e.target.value)} /></div>
                          <div><Label>Barras cara izq./der.</Label><Input type="number" value={form.n_bars_z} onChange={(e) => update("n_bars_z", +e.target.value)} /></div>
                        </>
                      )}
                    </div>
                  </div>
                </>
              )}

              <div className="border-t border-border pt-4">
                <p className="mb-3 text-xs font-medium uppercase tracking-wide text-text-muted">Parametros de calculo</p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Angulos del eje neutro</Label>
                    <select value={form.num_angles} onChange={(e) => update("num_angles", +e.target.value)}
                      className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text">
                      {[4, 8, 12, 16].map((n) => <option key={n} value={n}>{n} angulos</option>)}
                    </select>
                  </div>
                  <div>
                    <Label>Niveles de P por angulo</Label>
                    <select value={form.num_points} onChange={(e) => update("num_points", +e.target.value)}
                      className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text">
                      {[6, 8, 10, 12].map((n) => <option key={n} value={n}>{n} puntos</option>)}
                    </select>
                  </div>
                </div>
                <p className="mt-2 text-[11px] text-text-muted">
                  Seccion rectangular: ~{Math.ceil(form.num_angles / 4) + 1} angulos reales (simetria). Tiempo estimado: {Math.round((Math.ceil(form.num_angles / 4) + 1) * form.num_points * 0.8)}–{Math.round((Math.ceil(form.num_angles / 4) + 1) * form.num_points * 1.5)}s.
                </p>
              </div>

              {error && <p className="text-sm text-danger">{error}</p>}

              <Button type="submit" disabled={loading} className="w-full">
                {loading ? "Calculando superficie P-M-M..." : "Calcular superficie P-M-M"}
              </Button>
            </form>
          </CardBody>
        </Card>

        {/* ── Panel derecho ── */}
        <div className="flex flex-col gap-6">

          {/* Vista previa de seccion */}
          <Card>
            <CardHeader><h2 className="text-sm font-medium text-text">Vista previa de la seccion</h2></CardHeader>
            <CardBody className="flex justify-center">
              <SectionPreview
                shapeType={form.shape_type === "special" ? "special" : form.shape_type}
                width={sectionWidth} height={sectionHeight} diameter={form.diameter}
                cover={form.cover} coverToBarCentroid={form.cover_to_bar_centroid}
                nBarsY={form.n_bars_y} nBarsZ={form.n_bars_z} nBars={form.n_bars}
                vertices={form.shape_type === "special" ? parsePairs(form.verticesText) : undefined}
                bars={form.shape_type === "special" ? parsePairs(form.barsText) : undefined}
              />
            </CardBody>
          </Card>

          {/* Demandas P-Mx-My */}
          <Card>
            <CardHeader>
              <h2 className="text-sm font-medium text-text">Demandas P-M-M — Verificacion</h2>
              <p className="mt-1 text-xs text-text-muted">
                Ingresa combinaciones de carga. El DCR se calcula como M_resultante_demanda / M_capacidad(Pu, θ).
              </p>
            </CardHeader>
            <CardBody>
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-[1fr_1fr_1fr_24px] gap-2 text-[11px] font-medium text-text-muted px-1">
                  <span>Pu (kN)</span><span>Mxu (kN·m)</span><span>Myu (kN·m)</span><span />
                </div>
                {demands.map((d, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_1fr_24px] gap-2 items-center">
                    <Input type="number" placeholder="1000" value={d.pu} onChange={(e) => updateDemand(i, "pu", e.target.value)} />
                    <Input type="number" placeholder="200" value={d.mxu} onChange={(e) => updateDemand(i, "mxu", e.target.value)} />
                    <Input type="number" placeholder="150" value={d.myu} onChange={(e) => updateDemand(i, "myu", e.target.value)} />
                    <button type="button" onClick={() => removeDemandRow(i)}
                      className="text-text-muted hover:text-danger text-sm leading-none">×</button>
                  </div>
                ))}
                <button type="button" onClick={addDemandRow}
                  className="mt-1 text-left text-xs text-accent hover:underline">
                  + Agregar combinacion
                </button>
              </div>

              {/* Tabla de resultados */}
              {result && result.demands_out.length > 0 && (
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border text-text-muted">
                        <th className="py-1 pr-3 text-left font-medium">Pu (kN)</th>
                        <th className="py-1 pr-3 text-left font-medium">Mxu</th>
                        <th className="py-1 pr-3 text-left font-medium">Myu</th>
                        <th className="py-1 pr-3 text-left font-medium">M_dem</th>
                        <th className="py-1 pr-3 text-left font-medium">M_cap</th>
                        <th className="py-1 pr-3 text-left font-medium">DCR</th>
                        <th className="py-1 text-left font-medium">Estado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.demands_out.map((d, i) => (
                        <tr key={i} className="border-b border-border/40">
                          <td className="py-1 pr-3 font-mono">{d.p_kn.toFixed(0)}</td>
                          <td className="py-1 pr-3 font-mono">{d.mx_knm.toFixed(1)}</td>
                          <td className="py-1 pr-3 font-mono">{d.my_knm.toFixed(1)}</td>
                          <td className="py-1 pr-3 font-mono">{d.m_demand_knm.toFixed(1)}</td>
                          <td className="py-1 pr-3 font-mono">{d.m_capacity_knm.toFixed(1)}</td>
                          <td className={`py-1 pr-3 font-mono font-semibold ${d.inside ? "text-green-500" : "text-red-500"}`}>
                            {d.dcr === Infinity ? "∞" : d.dcr.toFixed(3)}
                          </td>
                          <td className={`py-1 text-xs font-medium ${d.inside ? "text-green-500" : "text-red-500"}`}>
                            {d.inside ? "OK" : "FALLA"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>

          {/* Graficas */}
          {!result && !loading && (
            <Card>
              <CardBody>
                <p className="text-sm text-text-muted">
                  Completa la seccion y calcula para ver la superficie P-M-M.
                </p>
              </CardBody>
            </Card>
          )}

          {loading && (
            <Card>
              <CardBody>
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-3 text-sm text-text-muted">
                    <svg className="h-4 w-4 animate-spin text-accent" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
                      <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Ejecutando analisis biaxial en OpenSees…
                  </div>
                  <p className="text-xs text-text-muted">
                    La superficie P-M-M requiere multiples pasadas de momento-curvatura. Esto puede tomar 30–90 segundos.
                  </p>
                </div>
              </CardBody>
            </Card>
          )}

          {result && (
            <>
              {/* ── Superficie 3D — gráfica principal ── */}
              <Card>
                <CardHeader>
                  <h2 className="text-sm font-medium text-text">Superficie de interaccion P-M-M — Vista 3D</h2>
                  <p className="mt-1 text-xs text-text-muted">
                    Curvas azules = P-M por angulo del eje neutro. Anillos grises = secciones Mx-My.
                    Arrastra con el mouse para rotar.
                  </p>
                </CardHeader>
                <CardBody>
                  <PMMSurface3D
                    curves={result.curves}
                    demands={result.demands_out}
                    pMaxKn={result.p_max_kn}
                    pMinKn={result.p_min_kn}
                    mMaxKnm={result.m_max_knm}
                  />
                </CardBody>
              </Card>

              {/* ── Vistas 2D complementarias (tabs) ── */}
              <Card>
                <CardHeader>
                  <h2 className="text-sm font-medium text-text">Vistas 2D complementarias</h2>
                </CardHeader>
                <CardBody>
                  <Views2D result={result} defaultP={defaultP} />
                </CardBody>
              </Card>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
