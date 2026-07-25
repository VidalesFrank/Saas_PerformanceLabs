"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { SpectrumChart } from "@/components/seismic/SpectrumChart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { EspectroResult, MunicipioInfo, SoilType, SoilTypeInfo, ZonaSismica } from "@/lib/seismic-types";
import { useRequireAuth } from "@/lib/use-require-auth";

const SeismicMap = dynamic(() => import("@/components/seismic/SeismicMap"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center rounded-lg bg-surface-2 text-sm text-text-muted">
      Cargando mapa…
    </div>
  ),
});

type SpecTab = "Sa" | "Sd" | "Sv";

const ZONE_BADGE: Record<ZonaSismica, { label: string; className: string }> = {
  baja: { label: "Zona Baja", className: "bg-success/15 text-success" },
  intermedia: { label: "Zona Intermedia", className: "bg-warning/15 text-warning" },
  alta: { label: "Zona Alta", className: "bg-danger/15 text-danger" },
};

const SOIL_COLORS: Record<string, string> = {
  A: "#087f5b",
  B: "#0e7fa8",
  C: "#7048e8",
  D: "#b45309",
  E: "#c81e3a",
};

function exportCSV(result: EspectroResult) {
  const m = result.municipio;
  const header = [
    `# Espectro NSR-10 — ${m.nombre} (${m.departamento})`,
    `# Suelo ${result.soil_type} | Aa=${m.Aa}g | Av=${m.Av}g | Fa=${result.params.Fa} | Fv=${result.params.Fv}`,
    `# SDs=${result.params.SDs}g | SD1=${result.params.SD1}g | T0=${result.params.T0}s | Ts=${result.params.Ts}s | TL=${result.params.TL}s`,
    "T (s),Sa (g),Sd (cm),Sv (cm/s)",
  ].join("\n");
  const rows = result.puntos.map((p) => `${p.T},${p.Sa},${p.Sd},${p.Sv}`).join("\n");
  const blob = new Blob([header + "\n" + rows], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `espectro-${m.nombre.toLowerCase().replace(/\s+/g, "-")}-suelo${result.soil_type}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

async function exportPDF(result: EspectroResult, chartsEl: HTMLElement | null) {
  const [{ jsPDF }, html2canvas] = await Promise.all([
    import("jspdf"),
    import("html2canvas").then((m) => m.default),
  ]);

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const margin = 18;
  let y = 20;

  const m = result.municipio;
  const p = result.params;
  const zone = result.zona_sismica;

  // Header
  doc.setFontSize(15);
  doc.setFont("helvetica", "bold");
  doc.text("Espectro Elástico de Diseño — NSR-10", margin, y);
  y += 8;

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 90, 110);
  doc.text(`Municipio: ${m.nombre}, ${m.departamento}`, margin, y);
  y += 5;
  doc.text(
    `Perfil de suelo: ${result.soil_type}   |   Zona: ${zone.charAt(0).toUpperCase() + zone.slice(1)}   |   Generado: ${new Date().toLocaleDateString("es-CO")}`,
    margin,
    y
  );
  y += 9;

  // Divider
  doc.setDrawColor(215, 219, 228);
  doc.line(margin, y, W - margin, y);
  y += 7;

  // Parameters table
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(16, 21, 34);
  doc.text("Parámetros espectrales", margin, y);
  y += 6;

  const paramRows: [string, string, string, string][] = [
    ["Aa", `${p.Aa} g`, "Av", `${p.Av} g`],
    ["Fa", p.Fa.toFixed(3), "Fv", p.Fv.toFixed(3)],
    ["SDs = 2.5·Aa·Fa", `${p.SDs.toFixed(4)} g`, "SD1 = Av·Fv", `${p.SD1.toFixed(4)} g`],
    ["T₀ = 0.2·Ts", `${p.T0.toFixed(4)} s`, "Ts = SD1/SDs", `${p.Ts.toFixed(4)} s`],
    ["TL", `${p.TL.toFixed(1)} s`, "", ""],
  ];

  doc.setFontSize(9);
  const colW = (W - 2 * margin) / 4;
  for (const row of paramRows) {
    doc.setFont("helvetica", "bold");
    doc.setTextColor(84, 91, 108);
    doc.text(row[0], margin, y);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(16, 21, 34);
    doc.text(row[1], margin + colW, y);
    if (row[2]) {
      doc.setFont("helvetica", "bold");
      doc.setTextColor(84, 91, 108);
      doc.text(row[2], margin + colW * 2, y);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(16, 21, 34);
      doc.text(row[3], margin + colW * 3, y);
    }
    y += 5.5;
  }

  y += 4;
  doc.setDrawColor(215, 219, 228);
  doc.line(margin, y, W - margin, y);
  y += 6;

  // Charts
  if (chartsEl) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text("Espectros de respuesta", margin, y);
    y += 5;

    const canvas = await html2canvas(chartsEl, {
      scale: 2,
      backgroundColor: "#ffffff",
      useCORS: true,
    });
    const imgData = canvas.toDataURL("image/png");
    const imgW = W - 2 * margin;
    const imgH = (canvas.height / canvas.width) * imgW;

    if (y + imgH > 270) {
      doc.addPage();
      y = 20;
    }
    doc.addImage(imgData, "PNG", margin, y, imgW, imgH);
    y += imgH + 8;
  }

  // Footer
  doc.setFontSize(8);
  doc.setFont("helvetica", "italic");
  doc.setTextColor(130, 140, 160);
  doc.text(
    "Generado con PerformanceLabs · Los valores de Aa/Av deben verificarse contra NSR-10 Tabla A.2.3-1.",
    margin,
    285
  );

  doc.save(`espectro-NSR10-${m.nombre.replace(/\s+/g, "-")}-suelo${result.soil_type}.pdf`);
}

export default function SeismicPage() {
  const ready = useRequireAuth();

  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<MunicipioInfo[]>([]);
  const [allMunicipios, setAllMunicipios] = useState<MunicipioInfo[]>([]);
  const [selected, setSelected] = useState<MunicipioInfo | null>(null);
  const [soilType, setSoilType] = useState<SoilType>("D");
  const [soilTypes, setSoilTypes] = useState<SoilTypeInfo[]>([]);
  const [result, setResult] = useState<EspectroResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<SpecTab>("Sa");
  const [exporting, setExporting] = useState(false);
  const [showTable, setShowTable] = useState(false);

  const chartsRef = useRef<HTMLDivElement>(null);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load all municipios + soil types on mount
  useEffect(() => {
    api.get<MunicipioInfo[]>("/api/v1/seismic/municipios/all", false).then(setAllMunicipios).catch(() => {});
    api.get<SoilTypeInfo[]>("/api/v1/seismic/soil-types", false).then(setSoilTypes).catch(() => {});
  }, []);

  // Debounced search
  useEffect(() => {
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    if (!query.trim()) { setSuggestions([]); return; }
    searchDebounce.current = setTimeout(() => {
      api
        .get<MunicipioInfo[]>(`/api/v1/seismic/municipios?q=${encodeURIComponent(query)}&limit=8`, false)
        .then(setSuggestions)
        .catch(() => setSuggestions([]));
    }, 280);
    return () => { if (searchDebounce.current) clearTimeout(searchDebounce.current); };
  }, [query]);

  const calculateSpectrum = useCallback(
    async (mun: MunicipioInfo, soil: SoilType) => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.post<EspectroResult>("/api/v1/seismic/espectro", {
          municipio_id: mun.id,
          soil_type: soil,
        });
        setResult(res);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Error al calcular el espectro");
        setResult(null);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  function selectMunicipio(m: MunicipioInfo) {
    setSelected(m);
    setQuery(m.nombre);
    setSuggestions([]);
    calculateSpectrum(m, soilType);
  }

  function onSoilChange(s: SoilType) {
    setSoilType(s);
    if (selected) calculateSpectrum(selected, s);
  }

  async function handlePDF() {
    if (!result) return;
    setExporting(true);
    try {
      await exportPDF(result, chartsRef.current);
    } finally {
      setExporting(false);
    }
  }

  if (!ready) return null;

  const zone = result?.zona_sismica ?? selected?.zona_sismica;
  const zoneBadge = zone ? ZONE_BADGE[zone] : null;

  return (
    <div className="flex flex-1 flex-col">
      <AppHeader crumb="Espectros NSR-10" />

      <main className="mx-auto grid w-full max-w-7xl flex-1 grid-cols-1 gap-6 px-6 py-8 lg:grid-cols-[360px_1fr]">
        {/* ── Panel izquierdo ── */}
        <div className="flex flex-col gap-5">
          {/* Búsqueda */}
          <Card>
            <CardHeader>
              <h1 className="text-base font-semibold text-text">Espectros sísmicos NSR-10</h1>
              <p className="mt-0.5 text-xs text-text-muted">
                Espectro elástico de diseño según municipio y perfil de suelo.
              </p>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
              <div className="relative">
                <Label htmlFor="mun-search">Municipio</Label>
                <Input
                  id="mun-search"
                  placeholder="Buscar municipio o ciudad…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  autoComplete="off"
                />
                {suggestions.length > 0 && (
                  <ul className="absolute z-50 mt-1 w-full overflow-hidden rounded-md border border-border bg-surface shadow-lg">
                    {suggestions.map((m) => (
                      <li key={m.id}>
                        <button
                          type="button"
                          className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-surface-2"
                          onClick={() => selectMunicipio(m)}
                        >
                          <span>
                            <span className="font-medium text-text">{m.nombre}</span>
                            <span className="ml-2 text-xs text-text-muted">{m.departamento}</span>
                          </span>
                          <span
                            className="ml-2 shrink-0 text-[10px] font-semibold uppercase tracking-wide"
                            style={{ color: m.zona_sismica === "alta" ? "#c81e3a" : m.zona_sismica === "intermedia" ? "#b45309" : "#087f5b" }}
                          >
                            {m.zona_sismica}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Soil type */}
              <div>
                <Label>Perfil de suelo (NSR-10)</Label>
                <div className="mt-1 grid grid-cols-5 gap-1.5">
                  {(["A", "B", "C", "D", "E"] as SoilType[]).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => onSoilChange(s)}
                      style={soilType === s ? { borderColor: SOIL_COLORS[s], color: SOIL_COLORS[s], background: SOIL_COLORS[s] + "18" } : {}}
                      className={`rounded-md border py-2 text-sm font-bold transition-colors ${
                        soilType === s ? "border-current" : "border-border text-text-muted hover:text-text"
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
                {soilTypes.find((st) => st.id === soilType) && (
                  <p className="mt-2 text-xs text-text-muted leading-relaxed">
                    {soilTypes.find((st) => st.id === soilType)?.descripcion}
                  </p>
                )}
              </div>
            </CardBody>
          </Card>

          {/* Parámetros */}
          {result && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <h2 className="text-sm font-semibold text-text">Parámetros espectrales</h2>
                {zoneBadge && (
                  <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${zoneBadge.className}`}>
                    {zoneBadge.label}
                  </span>
                )}
              </CardHeader>
              <CardBody>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
                  {[
                    { label: "Aa", value: `${result.params.Aa} g`, hint: "Coef. aceleración" },
                    { label: "Av", value: `${result.params.Av} g`, hint: "Coef. velocidad" },
                    { label: "Fa", value: result.params.Fa.toFixed(3), hint: "Factor sitio T-corto" },
                    { label: "Fv", value: result.params.Fv.toFixed(3), hint: "Factor sitio T-largo" },
                    { label: "SDs = 2.5·Aa·Fa", value: `${result.params.SDs.toFixed(4)} g`, hint: "Meseta espectral" },
                    { label: "SD1 = Av·Fv", value: `${result.params.SD1.toFixed(4)} g`, hint: "Sa en T=1s" },
                    { label: "T₀ = 0.2·Ts", value: `${result.params.T0.toFixed(4)} s`, hint: "Inicio meseta" },
                    { label: "Ts = SD1/SDs", value: `${result.params.Ts.toFixed(4)} s`, hint: "Fin meseta" },
                    { label: "TL", value: `${result.params.TL.toFixed(1)} s`, hint: "Período largo" },
                  ].map(({ label, value, hint }) => (
                    <div key={label}>
                      <dt className="font-mono text-[10px] text-text-muted">{hint}</dt>
                      <dd className="mt-0.5 font-mono font-semibold text-text">
                        <span className="mr-1 text-text-muted">{label} =</span>
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </CardBody>
            </Card>
          )}

          {/* Exportar */}
          {result && (
            <div className="flex gap-2">
              <Button
                className="flex-1 text-xs"
                onClick={() => exportCSV(result)}
              >
                Exportar CSV
              </Button>
              <Button
                className="flex-1 text-xs"
                onClick={handlePDF}
                disabled={exporting}
              >
                {exporting ? "Generando…" : "Exportar PDF"}
              </Button>
            </div>
          )}

          {error && (
            <p className="rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>
          )}
        </div>

        {/* ── Panel derecho ── */}
        <div className="flex flex-col gap-5">
          {/* Mapa */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <h2 className="text-sm font-medium text-text">Mapa de amenaza sísmica Colombia</h2>
              {selected && (
                <span className="text-xs text-text-muted">
                  {selected.nombre}, {selected.departamento}
                </span>
              )}
            </CardHeader>
            <CardBody className="p-0" style={{ height: 380 }}>
              <SeismicMap
                municipios={allMunicipios}
                selected={selected}
                onSelect={selectMunicipio}
              />
            </CardBody>
          </Card>

          {/* Espectros */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-text">
                  {result
                    ? `Espectros — ${result.municipio.nombre}, Suelo ${result.soil_type}`
                    : "Espectros de respuesta"}
                </h2>
                {result && (
                  <div className="flex gap-1">
                    {(["Sa", "Sd", "Sv"] as SpecTab[]).map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        onClick={() => setActiveTab(tab)}
                        className={`rounded-md px-3 py-1 text-xs font-semibold transition-colors ${
                          activeTab === tab
                            ? "bg-accent text-white"
                            : "text-text-muted hover:text-text"
                        }`}
                      >
                        {tab}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </CardHeader>
            <CardBody>
              {!result && !loading && (
                <div className="flex h-48 items-center justify-center text-sm text-text-muted">
                  Selecciona un municipio en el mapa o en el buscador para ver el espectro.
                </div>
              )}
              {loading && (
                <div className="flex h-48 items-center justify-center text-sm text-text-muted">
                  Calculando espectro…
                </div>
              )}
              {result && (
                <>
                  <div ref={chartsRef}>
                    <SpectrumChart
                      puntos={result.puntos}
                      params={result.params}
                      spectralType={activeTab}
                    />
                  </div>

                  <button
                    type="button"
                    onClick={() => setShowTable((s) => !s)}
                    className="mt-3 text-xs font-medium text-accent hover:underline"
                  >
                    {showTable ? "Ocultar tabla de valores" : "Ver tabla de valores"}
                  </button>

                  {showTable && (
                    <div className="mt-3 max-h-64 overflow-y-auto rounded-md border border-border">
                      <table className="w-full text-left text-xs">
                        <thead className="sticky top-0 bg-surface-2 font-mono uppercase tracking-wide text-text-muted">
                          <tr>
                            <th className="px-3 py-2">T (s)</th>
                            <th className="px-3 py-2">Sa (g)</th>
                            <th className="px-3 py-2">Sd (cm)</th>
                            <th className="px-3 py-2">Sv (cm/s)</th>
                          </tr>
                        </thead>
                        <tbody className="font-mono">
                          {result.puntos
                            .filter((_, i) => i % 3 === 0)
                            .map((p) => (
                              <tr key={p.T} className="border-t border-border">
                                <td className="px-3 py-1.5">{p.T.toFixed(3)}</td>
                                <td className="px-3 py-1.5">{p.Sa.toFixed(4)}</td>
                                <td className="px-3 py-1.5">{p.Sd.toFixed(3)}</td>
                                <td className="px-3 py-1.5">{p.Sv.toFixed(3)}</td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </CardBody>
          </Card>
        </div>
      </main>
    </div>
  );
}
