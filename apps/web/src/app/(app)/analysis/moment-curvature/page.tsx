"use client";

import { FormEvent, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { SectionPreview } from "@/components/section-preview";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { ApiError, api } from "@/lib/api";
import type {
  MaterialSummary,
  MCPoint,
  MomentCurvatureResultOut,
  SectionCreatePayload,
  SectionOut,
  SectionSummary,
  ShapeType,
} from "@/lib/types";
import { useRequireAuth } from "@/lib/use-require-auth";

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_FORM = {
  name: "Columna C1",
  shape_type: "rectangular" as ShapeType,
  width: 400, height: 400, diameter: 500,
  cover: 40, fpc: 28, fy: 420, es: 200000,
  hoop_bar_diameter: 9.5, hoop_spacing: 150,
  hoop_legs_x: 2, hoop_legs_y: 2, hoop_leg_area: 71,
  is_spiral: true,
  n_bars_y: 3, n_bars_z: 3, n_bars: 8,
  bar_id: "#8", cover_to_bar_centroid: 52,
  axial_load_kn: 500,
  num_incr: 120,
};

const BAR_IDS = ["#3","#4","#5","#6","#7","#8","#9","#10","#11"];
type FormState = typeof DEFAULT_FORM;

// ── M-φ SVG chart con overlay bilineal ───────────────────────────────────────

const PAD = { top: 28, right: 28, bottom: 56, left: 72 };

function MomentCurvatureChart({ result }: { result: MomentCurvatureResultOut }) {
  const W = 680, H = 360;
  const { curve, phi_yield, moment_yield, phi_max, moment_max, phi_ultimate, moment_ultimate } = result;
  if (!curve.length) return <p className="text-sm text-text-muted">Sin datos.</p>;

  const phiMax  = Math.max(...curve.map((p) => p.phi)) * 1.05;
  const momMax  = Math.max(...curve.map((p) => p.moment)) * 1.12;
  const inner_w = W - PAD.left - PAD.right;
  const inner_h = H - PAD.top  - PAD.bottom;

  const sx = (v: number) => PAD.left + (v / phiMax) * inner_w;
  const sy = (v: number) => PAD.top  + inner_h - (v / momMax) * inner_h;

  const polyline = curve.map((p) => `${sx(p.phi)},${sy(p.moment)}`).join(" ");

  // Bilineal: origen → (φy, Mmax) → (φu, Mmax)
  const bilineal = [
    `${sx(0)},${sy(0)}`,
    `${sx(phi_yield)},${sy(moment_max)}`,
    `${sx(phi_ultimate)},${sy(moment_max)}`,
  ].join(" ");

  const xTicks = 5;
  const yTicks = 5;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ fontFamily: "monospace" }}>
      {/* Fondo */}
      <rect x={PAD.left} y={PAD.top} width={inner_w} height={inner_h} fill="none" stroke="var(--color-border)" strokeWidth={1} />

      {/* Grid X */}
      {Array.from({ length: xTicks + 1 }, (_, i) => {
        const x = PAD.left + (i / xTicks) * inner_w;
        const val = (i / xTicks) * phiMax;
        return (
          <g key={i}>
            <line x1={x} y1={PAD.top} x2={x} y2={PAD.top + inner_h} stroke="var(--color-border)" strokeWidth={0.5} />
            <text x={x} y={PAD.top + inner_h + 16} textAnchor="middle" fontSize={9} fill="var(--color-text-muted)">
              {val.toFixed(4)}
            </text>
          </g>
        );
      })}

      {/* Grid Y */}
      {Array.from({ length: yTicks + 1 }, (_, i) => {
        const y = PAD.top + inner_h - (i / yTicks) * inner_h;
        const val = (i / yTicks) * momMax;
        return (
          <g key={i}>
            <line x1={PAD.left} y1={y} x2={PAD.left + inner_w} y2={y} stroke="var(--color-border)" strokeWidth={0.5} />
            <text x={PAD.left - 6} y={y + 4} textAnchor="end" fontSize={9} fill="var(--color-text-muted)">
              {val.toFixed(0)}
            </text>
          </g>
        );
      })}

      {/* Bilineal idealizada (fondo) */}
      <polyline points={bilineal} fill="none" stroke="var(--color-accent)" strokeWidth={1.5}
        strokeDasharray="6,4" opacity={0.55} strokeLinejoin="round" />

      {/* Curva M-φ real */}
      <polyline points={polyline} fill="none" stroke="var(--color-accent)" strokeWidth={2.5} strokeLinejoin="round" />

      {/* ── Marcador fluencia φy ─────────────────────────────────────────── */}
      <line x1={sx(phi_yield)} y1={PAD.top} x2={sx(phi_yield)} y2={sy(moment_yield)}
        stroke="var(--color-success)" strokeWidth={1.5} strokeDasharray="5,3" />
      <line x1={PAD.left} y1={sy(moment_yield)} x2={sx(phi_yield)} y2={sy(moment_yield)}
        stroke="var(--color-success)" strokeWidth={1.5} strokeDasharray="5,3" />
      <circle cx={sx(phi_yield)} cy={sy(moment_yield)} r={4.5} fill="var(--color-success)" />
      <text x={sx(phi_yield) + 7} y={sy(moment_yield) - 7} fontSize={9} fill="var(--color-success)" fontWeight="600">
        φy = {phi_yield.toFixed(4)} | My = {moment_yield.toFixed(0)}
      </text>

      {/* ── Marcador momento máximo φmax ─────────────────────────────────── */}
      <line x1={sx(phi_max)} y1={PAD.top} x2={sx(phi_max)} y2={sy(moment_max)}
        stroke="var(--color-warning)" strokeWidth={1.5} strokeDasharray="5,3" />
      <line x1={PAD.left} y1={sy(moment_max)} x2={sx(phi_max)} y2={sy(moment_max)}
        stroke="var(--color-warning)" strokeWidth={1.5} strokeDasharray="5,3" />
      <circle cx={sx(phi_max)} cy={sy(moment_max)} r={4.5} fill="var(--color-warning)" />
      <text x={sx(phi_max) + 7} y={sy(moment_max) - 7} fontSize={9} fill="var(--color-warning)" fontWeight="600">
        φmax = {phi_max.toFixed(4)} | Mmax = {moment_max.toFixed(0)}
      </text>

      {/* ── Marcador curvatura última / falla φu ─────────────────────────── */}
      <line x1={sx(phi_ultimate)} y1={PAD.top} x2={sx(phi_ultimate)} y2={sy(moment_ultimate)}
        stroke="#ef4444" strokeWidth={1.5} strokeDasharray="5,3" />
      <line x1={PAD.left} y1={sy(moment_ultimate)} x2={sx(phi_ultimate)} y2={sy(moment_ultimate)}
        stroke="#ef4444" strokeWidth={1.5} strokeDasharray="5,3" />
      <circle cx={sx(phi_ultimate)} cy={sy(moment_ultimate)} r={4.5} fill="#ef4444" />
      <text x={sx(phi_ultimate) + 7} y={sy(moment_ultimate) - 7} fontSize={9} fill="#ef4444" fontWeight="600">
        φu = {phi_ultimate.toFixed(4)} | Mu = {moment_ultimate.toFixed(0)}
      </text>

      {/* Etiquetas de ejes */}
      <text x={PAD.left + inner_w / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--color-text-muted)">
        Curvatura φ (1/m)
      </text>
      <text x={0} y={0} textAnchor="middle" fontSize={11} fill="var(--color-text-muted)"
        transform={`translate(14, ${PAD.top + inner_h / 2}) rotate(-90)`}>
        Momento M (kN·m)
      </text>
    </svg>
  );
}

// ── Exportar CSV ──────────────────────────────────────────────────────────────

function exportCSV(result: MomentCurvatureResultOut) {
  const lines = [
    `# Curva Momento-Curvatura — PerformanceLabs`,
    `# P = ${result.axial_load_kn} kN | μφ = ${result.ductility.toFixed(2)} | EI_ef = ${result.ei_secant_kNm2.toFixed(0)} kN·m²`,
    `# φy = ${result.phi_yield.toFixed(5)} 1/m | My = ${result.moment_yield.toFixed(1)} kN·m`,
    `# φmax = ${result.phi_max.toFixed(5)} 1/m | Mmax = ${result.moment_max.toFixed(1)} kN·m`,
    `# φu = ${result.phi_ultimate.toFixed(5)} 1/m | Mu = ${result.moment_ultimate.toFixed(1)} kN·m`,
    `phi_1_m,moment_kNm`,
    ...result.curve.map((p: MCPoint) => `${p.phi.toFixed(7)},${p.moment.toFixed(4)}`),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `mc_P${result.axial_load_kn}kN.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Tabla materiales Mander ───────────────────────────────────────────────────

function MaterialTable({ mat }: { mat: MaterialSummary }) {
  if (mat.nota) {
    return <p className="text-xs text-text-muted">{mat.nota}</p>;
  }
  const rows: [string, string, string, string][] = [
    ["Resistencia pico f'c / f'cc (MPa)", `${mat.fpc_MPa}`, `${mat.fpcc_MPa.toFixed(2)}`, `×${mat.fcc_sobre_fc.toFixed(3)}`],
    ["Deform. en pico ε₀ / εcc", `${mat.epsc0_unconf.toFixed(4)}`, `${mat.epsc0_conf.toFixed(4)}`, ""],
    ["Deform. última εcu", `${mat.ecu_unconf.toFixed(4)}`, `${mat.ecu_conf.toFixed(4)}`, ""],
  ];
  return (
    <div className="space-y-3">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border">
            <th className="pb-1 text-left font-medium text-text-muted">Parámetro</th>
            <th className="pb-1 text-right font-medium text-text-muted">No conf.</th>
            <th className="pb-1 text-right font-medium text-text-muted">Confinado</th>
            <th className="pb-1 text-right font-medium text-text-muted">Ratio</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, unc, conf, ratio]) => (
            <tr key={label} className="border-b border-border/40">
              <td className="py-1 text-text-muted">{label}</td>
              <td className="py-1 text-right font-mono text-text">{unc}</td>
              <td className="py-1 text-right font-mono font-semibold" style={{ color: "var(--color-accent)" }}>{conf}</td>
              <td className="py-1 text-right font-mono text-text-muted">{ratio}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="grid grid-cols-3 gap-2 pt-1">
        {[
          { label: "ke", value: mat.ke.toFixed(3) },
          { label: "f'l (MPa)", value: mat.fl_MPa.toFixed(3) },
          { label: "ρs (%)", value: mat.rho_s_pct.toFixed(3) },
          { label: "fy / fyh (MPa)", value: `${mat.fy_MPa}` },
          { label: "εy", value: mat.eps_y.toFixed(5) },
        ].map(({ label, value }) => (
          <div key={label} className="rounded border border-border px-2 py-1.5">
            <div className="text-[10px] text-text-muted">{label}</div>
            <div className="font-mono text-xs font-semibold text-text">{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Tabla propiedades de sección ──────────────────────────────────────────────

function SectionSummaryCard({ sec }: { sec: SectionSummary }) {
  const items = [
    sec.b_mm    !== undefined && { label: "Ancho b", value: `${sec.b_mm} mm` },
    sec.h_mm    !== undefined && { label: "Altura h", value: `${sec.h_mm} mm` },
    sec.D_mm    !== undefined && { label: "Diámetro D", value: `${sec.D_mm} mm` },
    sec.recubrimiento_mm !== undefined && { label: "Recubrimiento", value: `${sec.recubrimiento_mm} mm` },
    sec.area_bruta_mm2 !== undefined && { label: "Ag", value: `${sec.area_bruta_mm2.toLocaleString()} mm²` },
    sec.area_acero_mm2 !== undefined && { label: "As", value: `${sec.area_acero_mm2.toFixed(0)} mm²` },
    sec.rho_t_pct !== undefined && { label: "ρt = As/Ag", value: `${sec.rho_t_pct.toFixed(3)} %` },
    sec.n_barras !== undefined && sec.varilla && { label: "Refuerzo", value: `${sec.n_barras} barras ${sec.varilla}` },
    sec.P_kN !== undefined && { label: "Carga axial P", value: `${sec.P_kN} kN` },
    sec.P_sobre_fcAg !== undefined && { label: "P / (f'c·Ag)", value: sec.P_sobre_fcAg.toFixed(4) },
  ].filter(Boolean) as { label: string; value: string }[];

  return (
    <div className="grid grid-cols-2 gap-1.5">
      {items.map(({ label, value }) => (
        <div key={label} className="rounded border border-border px-2 py-1.5">
          <div className="text-[10px] text-text-muted">{label}</div>
          <div className="font-mono text-xs font-semibold text-text">{value}</div>
        </div>
      ))}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function MomentCurvaturePage() {
  const ready = useRequireAuth();
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [result, setResult] = useState<MomentCurvatureResultOut | null>(null);
  const [computing, setComputing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((prev) => ({ ...prev, [k]: v }));

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    setComputing(true);
    try {
      const payload: SectionCreatePayload = {
        name: form.name,
        shape_type: form.shape_type,
        cover: form.cover,
        fpc: form.fpc, fy: form.fy, es: form.es,
        hoop_bar_diameter: form.hoop_bar_diameter,
        hoop_spacing: form.hoop_spacing,
        hoop_legs_x: form.hoop_legs_x,
        hoop_legs_y: form.hoop_legs_y,
        hoop_leg_area: form.hoop_leg_area,
        is_spiral: form.is_spiral,
        bar_id: form.bar_id,
        cover_to_bar_centroid: form.cover_to_bar_centroid,
        ...(form.shape_type === "rectangular" || form.shape_type === "square"
          ? { width: form.width, height: form.height, n_bars_y: form.n_bars_y, n_bars_z: form.n_bars_z }
          : { diameter: form.diameter, n_bars: form.n_bars }),
      };

      const sec = await api.post<SectionOut>("/api/v1/sections", payload);

      const res = await api.post<MomentCurvatureResultOut>(
        `/api/v1/sections/${sec.id}/moment-curvature`,
        { axial_load_kn: form.axial_load_kn, num_incr: form.num_incr },
      );
      setResult(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Error al calcular. Verifica los datos.");
    } finally {
      setComputing(false);
    }
  }

  if (!ready) return null;

  return (
    <div className="flex flex-1 flex-col">
      <AppHeader crumb="Momento-Curvatura" />
      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-text">Curva Momento-Curvatura</h1>
          <p className="mt-1 text-sm text-text-muted">
            Análisis de sección de fibras (Mander 1988) a carga axial constante.
            Fluencia identificada por idealización bilineal igual-energía (ASCE 41).
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">

          {/* ── Formulario ───────────────────────────────────────────────── */}
          <div className="flex flex-col gap-4">
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">

              {/* Geometría */}
              <Card>
                <CardHeader><h2 className="text-sm font-semibold text-text">Geometría</h2></CardHeader>
                <CardBody className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <div className="sm:col-span-3">
                    <Label>Tipo de sección</Label>
                    <div className="flex overflow-hidden rounded-md border border-border text-xs">
                      {(["rectangular", "circular"] as ShapeType[]).map((t) => (
                        <button key={t} type="button" onClick={() => set("shape_type", t)}
                          className={`flex-1 px-3 py-2 font-medium transition-colors ${form.shape_type === t ? "bg-accent text-white" : "text-text-muted hover:text-text"}`}>
                          {t === "rectangular" ? "Rectangular" : "Circular"}
                        </button>
                      ))}
                    </div>
                  </div>
                  {(form.shape_type === "rectangular" || form.shape_type === "square") ? (
                    <>
                      <div><Label>Ancho b (mm)</Label><Input type="number" value={form.width} onChange={(e) => set("width", +e.target.value)} /></div>
                      <div><Label>Altura h (mm)</Label><Input type="number" value={form.height} onChange={(e) => set("height", +e.target.value)} /></div>
                    </>
                  ) : (
                    <div><Label>Diámetro D (mm)</Label><Input type="number" value={form.diameter} onChange={(e) => set("diameter", +e.target.value)} /></div>
                  )}
                  <div><Label>Recubrimiento (mm)</Label><Input type="number" value={form.cover} onChange={(e) => set("cover", +e.target.value)} /></div>
                </CardBody>
              </Card>

              {/* Materiales */}
              <Card>
                <CardHeader><h2 className="text-sm font-semibold text-text">Materiales</h2></CardHeader>
                <CardBody className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <div><Label>f&apos;c (MPa)</Label><Input type="number" value={form.fpc} onChange={(e) => set("fpc", +e.target.value)} /></div>
                  <div><Label>fy (MPa)</Label><Input type="number" value={form.fy} onChange={(e) => set("fy", +e.target.value)} /></div>
                  <div><Label>Es (MPa)</Label><Input type="number" value={form.es} onChange={(e) => set("es", +e.target.value)} /></div>
                </CardBody>
              </Card>

              {/* Confinamiento */}
              <Card>
                <CardHeader><h2 className="text-sm font-semibold text-text">Confinamiento (Mander 1988)</h2></CardHeader>
                <CardBody className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <div><Label>Diám. estribo (mm)</Label><Input type="number" step="0.1" value={form.hoop_bar_diameter} onChange={(e) => set("hoop_bar_diameter", +e.target.value)} /></div>
                  <div><Label>Espaciado s (mm)</Label><Input type="number" value={form.hoop_spacing} onChange={(e) => set("hoop_spacing", +e.target.value)} /></div>
                  <div><Label>Área 1 rama (mm²)</Label><Input type="number" step="0.1" value={form.hoop_leg_area} onChange={(e) => set("hoop_leg_area", +e.target.value)} /></div>
                  {form.shape_type === "rectangular" && (
                    <>
                      <div><Label>Piernas dir. X</Label><Input type="number" min={1} value={form.hoop_legs_x} onChange={(e) => set("hoop_legs_x", +e.target.value)} /></div>
                      <div><Label>Piernas dir. Y</Label><Input type="number" min={1} value={form.hoop_legs_y} onChange={(e) => set("hoop_legs_y", +e.target.value)} /></div>
                    </>
                  )}
                  {form.shape_type === "circular" && (
                    <div className="flex items-center gap-2 pt-4">
                      <input type="checkbox" id="spiral" checked={form.is_spiral} onChange={(e) => set("is_spiral", e.target.checked)} className="h-4 w-4 rounded border-border" />
                      <label htmlFor="spiral" className="text-sm text-text-muted">Espiral continua</label>
                    </div>
                  )}
                </CardBody>
              </Card>

              {/* Refuerzo longitudinal */}
              <Card>
                <CardHeader><h2 className="text-sm font-semibold text-text">Refuerzo longitudinal</h2></CardHeader>
                <CardBody className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <div>
                    <Label>Varilla</Label>
                    <select value={form.bar_id} onChange={(e) => set("bar_id", e.target.value)}
                      className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-accent/50">
                      {BAR_IDS.map((b) => <option key={b} value={b}>{b}</option>)}
                    </select>
                  </div>
                  <div><Label>c.g. barra (mm)</Label><Input type="number" value={form.cover_to_bar_centroid} onChange={(e) => set("cover_to_bar_centroid", +e.target.value)} /></div>
                  {(form.shape_type === "rectangular" || form.shape_type === "square") ? (
                    <>
                      <div><Label>Barras cara Y (incl. esq.)</Label><Input type="number" min={2} value={form.n_bars_y} onChange={(e) => set("n_bars_y", +e.target.value)} /></div>
                      <div><Label>Barras cara Z (incl. esq.)</Label><Input type="number" min={2} value={form.n_bars_z} onChange={(e) => set("n_bars_z", +e.target.value)} /></div>
                    </>
                  ) : (
                    <div><Label>N° barras</Label><Input type="number" min={4} value={form.n_bars} onChange={(e) => set("n_bars", +e.target.value)} /></div>
                  )}
                </CardBody>
              </Card>

              {/* Parámetros análisis */}
              <Card>
                <CardHeader><h2 className="text-sm font-semibold text-text">Parámetros de análisis</h2></CardHeader>
                <CardBody className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Carga axial P (kN)</Label>
                    <Input type="number" value={form.axial_load_kn} onChange={(e) => set("axial_load_kn", +e.target.value)} />
                    <p className="mt-1 text-[11px] text-text-muted">Compresión positiva. 0 = flexión pura.</p>
                  </div>
                  <div>
                    <Label>Incrementos de curvatura</Label>
                    <Input type="number" min={20} max={500} value={form.num_incr} onChange={(e) => set("num_incr", +e.target.value)} />
                    <p className="mt-1 text-[11px] text-text-muted">Mayor = más resolución (más lento).</p>
                  </div>
                </CardBody>
              </Card>

              {error && <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

              <Button type="submit" disabled={computing} className="w-full py-3">
                {computing ? "Calculando curva M-φ..." : "Calcular curva Momento-Curvatura"}
              </Button>
            </form>
          </div>

          {/* ── Panel derecho ────────────────────────────────────────────── */}
          <div className="flex flex-col gap-4">

            {/* Vista previa sección */}
            <Card>
              <CardHeader><h2 className="text-sm font-semibold text-text">Vista previa</h2></CardHeader>
              <CardBody>
                <SectionPreview
                  shapeType={form.shape_type}
                  width={form.width} height={form.height} diameter={form.diameter}
                  cover={form.cover}
                  coverToBarCentroid={form.cover_to_bar_centroid}
                  nBarsY={form.n_bars_y} nBarsZ={form.n_bars_z} nBars={form.n_bars}
                />
              </CardBody>
            </Card>

            {/* Resultados clave */}
            {result && (
              <Card>
                <CardHeader><h2 className="text-sm font-semibold text-text">Resultados clave</h2></CardHeader>
                <CardBody>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { label: "My — Momento fluencia†", value: `${result.moment_yield.toFixed(1)} kN·m`, color: "var(--color-success)" },
                      { label: "φy — Curvatura fluencia†", value: `${result.phi_yield.toFixed(5)} 1/m`, color: "var(--color-success)" },
                      { label: "Mmax — Momento pico", value: `${result.moment_max.toFixed(1)} kN·m`, color: "var(--color-warning)" },
                      { label: "φmax — Curvatura en pico", value: `${result.phi_max.toFixed(5)} 1/m`, color: "var(--color-warning)" },
                      { label: "Mu — Momento en falla", value: `${result.moment_ultimate.toFixed(1)} kN·m`, color: "#ef4444" },
                      { label: "φu — Curvatura de falla", value: `${result.phi_ultimate.toFixed(5)} 1/m`, color: "#ef4444" },
                      { label: "μφ = φu / φy", value: result.ductility.toFixed(2), color: "var(--color-accent)" },
                      { label: "EI_ef — Rigidez secante", value: `${result.ei_secant_kNm2.toFixed(0)} kN·m²`, color: "var(--color-text-muted)" },
                    ].map(({ label, value, color }) => (
                      <div key={label} className="flex flex-col gap-0.5 rounded-lg border border-border px-2.5 py-2">
                        <span className="text-[9px] uppercase tracking-wide text-text-muted">{label}</span>
                        <span className="font-mono text-sm font-semibold" style={{ color }}>{value}</span>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-[10px] text-text-muted">
                    † Idealización bilineal igual-energía (ASCE 41 / Priestley &amp; Calvi).
                  </p>
                  {!result.failure_reached && (
                    <p className="mt-2 rounded border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-600 dark:text-amber-400">
                      El momento no cayó al 80% Mmax dentro del barrido — φu corresponde al límite del análisis,
                      no a la falla real. La ductilidad calculada es un límite inferior. Aumente el
                      {" "}<strong>multiplicador de curvatura</strong> o los <strong>incrementos</strong> para capturar la degradación post-pico.
                    </p>
                  )}
                </CardBody>
              </Card>
            )}

            {/* Propiedades de sección */}
            {result && (
              <Card>
                <CardHeader><h2 className="text-sm font-semibold text-text">Propiedades de la sección</h2></CardHeader>
                <CardBody>
                  <SectionSummaryCard sec={result.section_summary} />
                </CardBody>
              </Card>
            )}
          </div>
        </div>

        {/* ── Gráfica M-φ ─────────────────────────────────────────────────── */}
        {result && result.curve.length > 0 && (
          <Card className="mt-6">
            <CardHeader>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-text">Curva Momento-Curvatura</h2>
                <div className="flex items-center gap-4">
                  <div className="flex gap-3 text-[11px] text-text-muted">
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block h-0.5 w-4 opacity-55" style={{ background: "var(--color-accent)" }} />
                      Bilineal
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--color-success)" }} />
                      Fluencia (φy)
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--color-warning)" }} />
                      Pico (φmax)
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block h-2 w-2 rounded-full" style={{ background: "#ef4444" }} />
                      Falla (φu)
                    </span>
                  </div>
                  <button
                    onClick={() => exportCSV(result)}
                    className="rounded border border-border px-2.5 py-1 text-[11px] font-medium text-text-muted transition-colors hover:border-accent hover:text-accent"
                  >
                    Exportar CSV
                  </button>
                </div>
              </div>
            </CardHeader>
            <CardBody>
              <MomentCurvatureChart result={result} />
            </CardBody>
          </Card>
        )}

        {/* ── Resumen materiales Mander ────────────────────────────────────── */}
        {result && (
          <Card className="mt-6">
            <CardHeader>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-text">Modelo de confinamiento Mander (1988)</h2>
                <span className="text-[11px] text-text-muted">{result.section_summary.forma}</span>
              </div>
            </CardHeader>
            <CardBody>
              <MaterialTable mat={result.material_summary} />
            </CardBody>
          </Card>
        )}
      </main>
    </div>
  );
}
