"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { SpectrumChart, interpolateSpectrum } from "@/components/seismic/SpectrumChart";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { api } from "@/lib/api";
import type {
  EspectroMicrozonificacionResult,
  EspectroResult,
  MicrozonificacionInfo,
  MunicipioInfo,
  SoilType,
  SoilTypeInfo,
  ZonaSismica,
} from "@/lib/seismic-types";
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

  doc.setDrawColor(215, 219, 228);
  doc.line(margin, y, W - margin, y);
  y += 7;

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

  const [taInput, setTaInput] = useState<string>("");

  // Microzonificación
  const [microData, setMicroData] = useState<MicrozonificacionInfo | null>(null);
  const [selectedZona, setSelectedZona] = useState<string | null>(null);
  const [microResult, setMicroResult] = useState<EspectroMicrozonificacionResult | null>(null);
  const [microLoading, setMicroLoading] = useState(false);

  const chartsRef = useRef<HTMLDivElement>(null);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    api.get<MunicipioInfo[]>("/api/v1/seismic/municipios/all", false).then(setAllMunicipios).catch(() => {});
    api.get<SoilTypeInfo[]>("/api/v1/seismic/soil-types", false).then(setSoilTypes).catch(() => {});
  }, []);

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

  // Fetch microzonificación when municipality changes
  useEffect(() => {
    setMicroData(null);
    setSelectedZona(null);
    setMicroResult(null);
    if (!selected) return;
    api
      .get<MicrozonificacionInfo>(`/api/v1/seismic/microzonificacion/${selected.id}`, false)
      .then(setMicroData)
      .catch(() => setMicroData(null));
  }, [selected]);

  // Compute microzonification spectrum when zone changes
  useEffect(() => {
    setMicroResult(null);
    if (!selected || !selectedZona) return;
    setMicroLoading(true);
    api
      .post<EspectroMicrozonificacionResult>("/api/v1/seismic/espectro/microzonificacion", {
        municipio_id: selected.id,
        zona_id: selectedZona,
      })
      .then(setMicroResult)
      .catch(() => setMicroResult(null))
      .finally(() => setMicroLoading(false));
  }, [selected, selectedZona]);

  const spectrumExtra = useMemo(() => {
    if (!microResult || !selectedZona || !microData) return null;
    const zona = microData.zonas.find((z) => z.id === selectedZona);
    if (!zona) return null;
    const shortLabel = zona.nombre.includes("—")
      ? zona.nombre.split("—")[1]?.trim() ?? zona.nombre
      : zona.nombre;
    return {
      puntos: microResult.puntos,
      params: { T0: microResult.params.T0, Ts: microResult.params.Ts, TL: microResult.params.TL },
      label: shortLabel,
      color: zona.color,
    };
  }, [microResult, selectedZona, microData]);

  const ta = taInput.trim() ? parseFloat(taInput) : NaN;
  const taValid = !isNaN(ta) && ta > 0;

  const saAtTa = useMemo(
    () => (taValid && result ? interpolateSpectrum(result.puntos, ta, "Sa") : null),
    [taValid, result, ta],
  );
  const saAtTaMicro = useMemo(
    () => (taValid && microResult ? interpolateSpectrum(microResult.puntos, ta, "Sa") : null),
    [taValid, microResult, ta],
  );

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

              <div className="border-t border-border pt-3">
                <Label htmlFor="ta-input">Período de análisis Ta (s)</Label>
                <Input
                  id="ta-input"
                  type="number"
                  step="0.01"
                  min="0.01"
                  placeholder="ej. 0.50"
                  value={taInput}
                  onChange={(e) => setTaInput(e.target.value)}
                />
                <p className="mt-1 text-[11px] text-text-muted">
                  Período fundamental del edificio — se marca en el espectro y se entrega Sa(Ta).
                </p>
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

          {/* Microzonificación sísmica */}
          {microData && (
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h2 className="text-sm font-semibold text-text">Microzonificación sísmica</h2>
                    <p className="mt-1 text-[11px] text-text-muted leading-relaxed">{microData.estudio}</p>
                  </div>
                  <span className="mt-0.5 shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">
                    Oficial
                  </span>
                </div>
              </CardHeader>
              <CardBody className="flex flex-col gap-2">
                <p className="text-[11px] text-text-muted">
                  Selecciona una zona para comparar su espectro con el NSR-10 genérico:
                </p>
                <div className="flex flex-col gap-1.5">
                  {microData.zonas.map((zona) => (
                    <button
                      key={zona.id}
                      type="button"
                      onClick={() => setSelectedZona(selectedZona === zona.id ? null : zona.id)}
                      className={`flex items-center gap-2.5 rounded-md border px-3 py-2 text-left text-[11px] transition-colors ${
                        selectedZona === zona.id
                          ? "font-semibold"
                          : "border-border text-text-muted hover:text-text"
                      }`}
                      style={
                        selectedZona === zona.id
                          ? { borderColor: zona.color, color: zona.color, background: zona.color + "14" }
                          : {}
                      }
                    >
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: zona.color }}
                      />
                      <span className="leading-tight">{zona.nombre}</span>
                    </button>
                  ))}
                </div>

                {selectedZona && (() => {
                  const zona = microData.zonas.find((z) => z.id === selectedZona);
                  if (!zona) return null;
                  return (
                    <div className="mt-1 rounded-md bg-surface-2 p-2.5">
                      <p className="text-[11px] text-text-muted leading-relaxed">{zona.descripcion}</p>
                      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 font-mono text-[10px]">
                        <div>
                          <dt className="text-text-muted">SDs</dt>
                          <dd className="font-semibold text-text">{zona.SDs.toFixed(4)} g</dd>
                        </div>
                        <div>
                          <dt className="text-text-muted">SD1</dt>
                          <dd className="font-semibold text-text">{zona.SD1.toFixed(4)} g</dd>
                        </div>
                        <div>
                          <dt className="text-text-muted">T₀</dt>
                          <dd className="font-semibold text-text">{zona.T0.toFixed(4)} s</dd>
                        </div>
                        <div>
                          <dt className="text-text-muted">Ts</dt>
                          <dd className="font-semibold text-text">{zona.Ts.toFixed(4)} s</dd>
                        </div>
                      </dl>
                    </div>
                  );
                })()}

                {microLoading && (
                  <p className="text-[11px] text-text-muted">Calculando espectro de microzonificación…</p>
                )}

                <p className="mt-1 text-[10px] text-text-muted leading-relaxed border-t border-border pt-2">
                  {microData.nota}
                </p>
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
                <div>
                  <h2 className="text-sm font-medium text-text">
                    {result
                      ? `Espectros — ${result.municipio.nombre}, Suelo ${result.soil_type}`
                      : "Espectros de respuesta"}
                  </h2>
                  {spectrumExtra && (
                    <p className="mt-0.5 text-[11px] text-text-muted">
                      Comparando con microzonificación:{" "}
                      <span className="font-semibold" style={{ color: spectrumExtra.color }}>
                        {spectrumExtra.label}
                      </span>
                    </p>
                  )}
                </div>
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
                      seriesExtra={spectrumExtra}
                      tAnalisis={taValid ? ta : null}
                    />
                  </div>

                  {/* Panel Sa(Ta) — resultados del período de análisis */}
                  {taValid && saAtTa !== null && (
                    <div className="mt-4 rounded-md border border-border bg-surface-2 px-4 py-3">
                      <p className="text-xs font-semibold text-text">
                        Sa en Ta = {ta.toFixed(2)} s
                      </p>
                      <div className="mt-2 grid grid-cols-2 gap-4 text-xs">
                        <div>
                          <p className="font-mono text-[10px] text-text-muted">NSR-10 (genérico)</p>
                          <p className="mt-0.5 font-mono font-bold" style={{ color: "var(--color-danger)" }}>
                            Sa = {saAtTa.toFixed(4)} g
                          </p>
                        </div>
                        {saAtTaMicro !== null && spectrumExtra && (
                          <div>
                            <p className="font-mono text-[10px]" style={{ color: spectrumExtra.color }}>
                              {spectrumExtra.label}
                            </p>
                            <p className="mt-0.5 font-mono font-bold" style={{ color: spectrumExtra.color }}>
                              Sa = {saAtTaMicro.toFixed(4)} g
                            </p>
                          </div>
                        )}
                      </div>
                      {saAtTaMicro !== null && spectrumExtra && (
                        <p className="mt-2 border-t border-border pt-2 text-[11px] text-text-muted">
                          {saAtTaMicro > saAtTa
                            ? `Microzonificación más desfavorable: +${((saAtTaMicro / saAtTa - 1) * 100).toFixed(1)}% respecto al NSR-10 genérico.`
                            : saAtTaMicro < saAtTa
                              ? `NSR-10 genérico más desfavorable: microzonificación ${((1 - saAtTaMicro / saAtTa) * 100).toFixed(1)}% menor.`
                              : "Ambos espectros coinciden en Ta."}
                        </p>
                      )}
                    </div>
                  )}
                  {taValid && result && ta > (result.puntos.at(-1)?.T ?? 4) && (
                    <p className="mt-2 text-[11px] text-warning">
                      Ta ({ta.toFixed(2)} s) está fuera del rango graficado — ampliar T máx en configuración avanzada.
                    </p>
                  )}

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
