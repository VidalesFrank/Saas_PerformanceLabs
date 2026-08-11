"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import type { SeismicParameters } from "@/lib/structural-types";
import { structuralProjectsApi } from "@/lib/structural-api";

// ── NSR-10 lookup tables ──────────────────────────────────────────────────────

const IMPORTANCE_FACTOR: Record<string, number> = {
  I: 1.0, II: 1.1, III: 1.25, IV: 1.5,
};

// R factor per system + dissipation level (NSR-10 A.3.3)
const R_TABLE: Record<string, Record<string, number>> = {
  RCMRF:   { DMO: 5.0, DES: 7.0, DES_ESP: 8.0 },
  RCPF:    { DMO: 3.0, DES: 4.0, DES_ESP: 5.0 },
  DUAL:    { DMO: 5.0, DES: 7.0, DES_ESP: 8.0 },
  WRCF:    { DMO: 4.0, DES: 5.5, DES_ESP: 7.0 },
  SCMRF:   { DMO: 5.0, DES: 7.0, DES_ESP: 8.0 },
  MURO_RC: { DMO: 4.0, DES: 5.5, DES_ESP: 7.0 },
};

// Ct, alpha_x per system type (NSR-10 A.4.2)
const CT_TABLE: Record<string, { Ct: number; alpha_x: number }> = {
  RCMRF:   { Ct: 0.047, alpha_x: 0.90 },
  RCPF:    { Ct: 0.047, alpha_x: 0.90 },
  DUAL:    { Ct: 0.047, alpha_x: 0.90 },
  WRCF:    { Ct: 0.049, alpha_x: 0.75 },
  SCMRF:   { Ct: 0.072, alpha_x: 0.80 },
  MURO_RC: { Ct: 0.049, alpha_x: 0.75 },
};

// NSR-10 Tablas A.2.4-1 y A.2.4-2 — Fa y Fv por tipo de suelo
// Breakpoints: Aa/Av = [0.10, 0.20, 0.30, 0.40, 0.50] — igual que nsr10_data.py
const NSR10_BREAKS = [0.10, 0.20, 0.30, 0.40, 0.50];

const FA_TABLE: Record<string, number[]> = {
  A: [0.8, 0.8, 0.8, 0.8, 0.8],
  B: [1.0, 1.0, 1.0, 1.0, 1.0],
  C: [1.2, 1.1, 1.0, 1.0, 1.0],
  D: [1.6, 1.4, 1.2, 1.1, 1.0],
  E: [2.5, 1.7, 1.2, 0.9, 0.9],
};

const FV_TABLE: Record<string, number[]> = {
  A: [0.8, 0.8, 0.8, 0.8, 0.8],
  B: [1.0, 1.0, 1.0, 1.0, 1.0],
  C: [1.7, 1.6, 1.5, 1.4, 1.3],
  D: [2.4, 2.0, 1.8, 1.6, 1.5],
  E: [3.5, 3.2, 2.8, 2.4, 2.4],
};

function interpTable(x: number, breaks: number[], vals: number[]): number {
  if (x <= breaks[0]) return vals[0];
  if (x >= breaks[breaks.length - 1]) return vals[breaks.length - 1];
  for (let i = 0; i < breaks.length - 1; i++) {
    if (x >= breaks[i] && x <= breaks[i + 1]) {
      const t = (x - breaks[i]) / (breaks[i + 1] - breaks[i]);
      return vals[i] + t * (vals[i + 1] - vals[i]);
    }
  }
  return vals[vals.length - 1];
}

function computeFaFv(soilType: string, Aa: number, Av: number): { Fa: number; Fv: number } | null {
  const faRow = FA_TABLE[soilType];
  const fvRow = FV_TABLE[soilType];
  if (!faRow || !fvRow || Aa <= 0 || Av <= 0) return null;
  return {
    Fa: parseFloat(interpTable(Aa, NSR10_BREAKS, faRow).toFixed(2)),
    Fv: parseFloat(interpTable(Av, NSR10_BREAKS, fvRow).toFixed(2)),
  };
}

// ── Static data ───────────────────────────────────────────────────────────────

const STRUCTURE_SYSTEMS = [
  { value: "RCMRF",   label: "Pórtico Resistente de Momentos de Concreto (RCMRF)" },
  { value: "RCPF",    label: "Pórtico de Concreto con Muros Parciales (RCPF)" },
  { value: "DUAL",    label: "Sistema Dual (Pórticos + Muros RC)" },
  { value: "WRCF",    label: "Sistema de Muros de Concreto (WRCF)" },
  { value: "SCMRF",   label: "Pórtico Resistente de Momentos de Acero (SCMRF)" },
  { value: "MURO_RC", label: "Muros Estructurales de Concreto" },
];

const DISSIPATION_LEVELS = [
  { value: "DMO",     label: "DMO — Disipación Moderada de Energía" },
  { value: "DES",     label: "DES — Disipación Especial de Energía" },
  { value: "DES_ESP", label: "DES_ESP — Disipación Especial (Cuadro A.3-3)" },
];

const EDIFICATION_USES = [
  { value: "I",   label: "Grupo I — Uso normal (I = 1.00)" },
  { value: "II",  label: "Grupo II — Uso especial (I = 1.10)" },
  { value: "III", label: "Grupo III — Atención a la comunidad (I = 1.25)" },
  { value: "IV",  label: "Grupo IV — Indispensable (I = 1.50)" },
];

const SOIL_TYPES = [
  { value: "A", label: "Tipo A — Roca dura (Vs > 1500 m/s)" },
  { value: "B", label: "Tipo B — Roca (760 < Vs ≤ 1500 m/s)" },
  { value: "C", label: "Tipo C — Suelo muy denso (360 < Vs ≤ 760 m/s)" },
  { value: "D", label: "Tipo D — Suelo rígido (180 < Vs ≤ 360 m/s)" },
  { value: "E", label: "Tipo E — Suelo blando (Vs < 180 m/s)" },
];

// ── Municipality type ─────────────────────────────────────────────────────────

interface MunicipioOption {
  id: string;
  nombre: string;
  departamento: string;
  Aa: number;
  Av: number;
  zona_sismica: string;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  projectId: string;
  initial?: Partial<SeismicParameters>;
  onSaved: (params: SeismicParameters) => void;
  onPreview: (params: { Aa: number; Av: number; soil_type: string }) => void;
}

type FormState = Omit<SeismicParameters, "importance_factor" | "R" | "Ct" | "alpha_x" | "Aa" | "Av"> & {
  importance_factor: string;
  R: string;
  Ct: string;
  alpha_x: string;
  Aa: string;
  Av: string;
};

function toForm(p?: Partial<SeismicParameters>): FormState {
  const sys = p?.structure_system ?? "RCMRF";
  const dis = p?.energy_dissipation ?? "DMO";
  const use = p?.edification_use ?? "II";
  return {
    code: p?.code ?? "NSR-10",
    city: p?.city ?? "",
    department: p?.department ?? "",
    Aa: String(p?.Aa ?? ""),
    Av: String(p?.Av ?? ""),
    seismic_zone: p?.seismic_zone ?? "",
    soil_type: p?.soil_type ?? "D",
    edification_use: use,
    importance_factor: String(p?.importance_factor ?? IMPORTANCE_FACTOR[use] ?? 1.0),
    structure_system: sys,
    energy_dissipation: dis,
    R: String(p?.R ?? R_TABLE[sys]?.[dis] ?? ""),
    Ct: String(p?.Ct ?? CT_TABLE[sys]?.Ct ?? ""),
    alpha_x: String(p?.alpha_x ?? CT_TABLE[sys]?.alpha_x ?? ""),
    damping_ratio: p?.damping_ratio ?? 0.05,
    n_modes: p?.n_modes ?? 12,
    combination_method: p?.combination_method ?? "CQC",
    cm_load: p?.cm_load ?? "DEAD",
    cv_load: p?.cv_load ?? "LIVE",
  };
}

// ── Primitive UI components ───────────────────────────────────────────────────

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-xs font-medium text-text-muted mb-1">{children}</label>
  );
}

function Input({
  value, onChange, type = "text", step, min, max, placeholder, readOnly,
}: {
  value: string | number;
  onChange?: (v: string) => void;
  type?: string; step?: string; min?: string; max?: string; placeholder?: string; readOnly?: boolean;
}) {
  return (
    <input
      type={type}
      step={step}
      min={min}
      max={max}
      value={value}
      readOnly={readOnly}
      placeholder={placeholder}
      onChange={(e) => onChange?.(e.target.value)}
      className={[
        "w-full rounded border border-border bg-surface px-3 py-1.5 text-sm text-text",
        "focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-text-muted/60",
        readOnly ? "opacity-60 cursor-default" : "",
      ].join(" ")}
    />
  );
}

function Select({
  value, onChange, children,
}: {
  value: string; onChange: (v: string) => void; children: React.ReactNode;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded border border-border bg-surface px-3 py-1.5 text-sm text-text
                 focus:outline-none focus:ring-1 focus:ring-accent"
    >
      {children}
    </select>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted
                  border-b border-border pb-1 mb-3 mt-5">
      {children}
    </p>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function SeismicParamsForm({ projectId, initial, onSaved, onPreview }: Props) {
  const [form, setForm] = useState<FormState>(() => toForm(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState<string | null>(null);
  const [saved, setSaved]   = useState(false);

  // Municipality combobox state
  const [municipioQuery, setMunicipioQuery] = useState(initial?.city ?? "");
  const [municipioOptions, setMunicipioOptions] = useState<MunicipioOption[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [searching, setSearching]       = useState(false);
  const comboRef = useRef<HTMLDivElement>(null);

  // Debounced municipality search
  useEffect(() => {
    if (municipioQuery.length < 2) { setMunicipioOptions([]); return; }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(
          `${API_URL}/api/v1/seismic/municipios?q=${encodeURIComponent(municipioQuery)}&limit=8`
        );
        if (res.ok) {
          const data: MunicipioOption[] = await res.json();
          setMunicipioOptions(data);
          setShowDropdown(data.length > 0);
        }
      } catch { /* ignore network errors */ } finally {
        setSearching(false);
      }
    }, 280);
    return () => clearTimeout(timer);
  }, [municipioQuery]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (comboRef.current && !comboRef.current.contains(e.target as Node))
        setShowDropdown(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Computed Fa/Fv from soil type + Aa/Av
  const computedFaFv = useMemo(() => {
    const Aa = parseFloat(form.Aa);
    const Av = parseFloat(form.Av);
    return computeFaFv(form.soil_type, Aa, Av);
  }, [form.Aa, form.Av, form.soil_type]);

  // ── Form helpers ────────────────────────────────────────────────────────────

  function set(key: keyof FormState, value: string | number) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }

  function selectMunicipio(m: MunicipioOption) {
    setMunicipioQuery(m.nombre);
    setShowDropdown(false);
    setForm((prev) => ({
      ...prev,
      city:         m.nombre,
      department:   m.departamento,
      Aa:           String(m.Aa),
      Av:           String(m.Av),
      seismic_zone: m.zona_sismica,
    }));
    setSaved(false);
  }

  function handleSystemChange(sys: string) {
    const dis = form.energy_dissipation;
    setForm((prev) => ({
      ...prev,
      structure_system: sys,
      R:       String(R_TABLE[sys]?.[dis] ?? prev.R),
      Ct:      String(CT_TABLE[sys]?.Ct ?? prev.Ct),
      alpha_x: String(CT_TABLE[sys]?.alpha_x ?? prev.alpha_x),
    }));
    setSaved(false);
  }

  function handleDissipationChange(dis: string) {
    const sys = form.structure_system;
    setForm((prev) => ({
      ...prev,
      energy_dissipation: dis,
      R: String(R_TABLE[sys]?.[dis] ?? prev.R),
    }));
    setSaved(false);
  }

  function handleUseChange(use: string) {
    setForm((prev) => ({
      ...prev,
      edification_use:   use,
      importance_factor: String(IMPORTANCE_FACTOR[use] ?? prev.importance_factor),
    }));
    setSaved(false);
  }

  function buildPayload(): SeismicParameters {
    return {
      code:              form.code,
      city:              form.city,
      department:        form.department,
      Aa:                parseFloat(form.Aa) || undefined,
      Av:                parseFloat(form.Av) || undefined,
      seismic_zone:      form.seismic_zone || undefined,
      soil_type:         form.soil_type,
      edification_use:   form.edification_use,
      importance_factor: parseFloat(form.importance_factor) || 1.0,
      structure_system:  form.structure_system,
      energy_dissipation: form.energy_dissipation,
      R:       parseFloat(form.R)       || undefined,
      Ct:      parseFloat(form.Ct)      || undefined,
      alpha_x: parseFloat(form.alpha_x) || undefined,
      damping_ratio:     form.damping_ratio,
      n_modes:           form.n_modes,
      combination_method: form.combination_method,
      cm_load:           form.cm_load,
      cv_load:           form.cv_load,
    };
  }

  async function handleSave() {
    if (!form.city) { setError("Seleccione o ingrese el municipio del proyecto."); return; }
    if (!form.Aa || !form.Av) { setError("Ingrese o seleccione Aa y Av."); return; }
    setError(null);
    setSaving(true);
    try {
      await structuralProjectsApi.saveParameters(projectId, buildPayload());
      setSaved(true);
      onSaved(buildPayload());
      const Aa = parseFloat(form.Aa);
      const Av = parseFloat(form.Av);
      if (Aa > 0 && Av > 0) onPreview({ Aa, Av, soil_type: form.soil_type });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error al guardar parámetros");
    } finally {
      setSaving(false);
    }
  }

  function handlePreviewClick() {
    const Aa = parseFloat(form.Aa);
    const Av = parseFloat(form.Av);
    if (!Aa || !Av) { setError("Ingrese Aa y Av para previsualizar el espectro."); return; }
    setError(null);
    onPreview({ Aa, Av, soil_type: form.soil_type });
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-1">

      {/* ── Sección 1: Ubicación y Amenaza Sísmica ── */}
      <SectionTitle>Ubicación y Amenaza Sísmica</SectionTitle>

      {/* Municipality combobox */}
      <div ref={comboRef} className="relative">
        <FieldLabel>Municipio *</FieldLabel>
        <div className="relative">
          <input
            type="text"
            value={municipioQuery}
            onChange={(e) => { setMunicipioQuery(e.target.value); setSaved(false); }}
            onBlur={() => {
              setTimeout(() => setShowDropdown(false), 160);
              if (municipioQuery && !form.city) set("city", municipioQuery);
            }}
            onFocus={() => municipioOptions.length > 0 && setShowDropdown(true)}
            placeholder="Buscar municipio por nombre…"
            className="w-full rounded border border-border bg-surface px-3 py-1.5 pr-20 text-sm text-text
                       focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-text-muted/60"
          />
          <div className="absolute inset-y-0 right-3 flex items-center gap-2 pointer-events-none">
            {searching && (
              <span className="text-[11px] text-text-muted animate-pulse">buscando…</span>
            )}
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
              className="text-text-muted opacity-50">
              <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M10 10 L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </div>
        </div>

        {/* Dropdown */}
        {showDropdown && municipioOptions.length > 0 && (
          <div className="absolute z-50 mt-1 w-full rounded-lg border border-border bg-surface shadow-xl
                          max-h-60 overflow-y-auto">
            {municipioOptions.map((m) => (
              <button
                key={m.id}
                type="button"
                onMouseDown={() => selectMunicipio(m)}
                className="w-full flex items-center justify-between px-3 py-2.5 text-left
                           hover:bg-surface-2 transition-colors border-b border-border/50 last:border-0"
              >
                <div>
                  <span className="text-sm font-medium text-text">{m.nombre}</span>
                  <span className="ml-2 text-xs text-text-muted">{m.departamento}</span>
                </div>
                <div className="flex gap-2 text-[11px] text-text-muted shrink-0 ml-3">
                  <span className="rounded bg-surface-2 px-1.5 py-0.5">Aa {m.Aa}</span>
                  <span className="rounded bg-surface-2 px-1.5 py-0.5">Av {m.Av}</span>
                  <span className="rounded bg-accent/10 text-accent px-1.5 py-0.5">{m.zona_sismica}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* City + Department (auto-filled, editable) */}
      <div className="grid grid-cols-2 gap-3 mt-2">
        <div>
          <FieldLabel>Ciudad</FieldLabel>
          <Input value={form.city} onChange={(v) => { set("city", v); setMunicipioQuery(v); }}
            placeholder="Ej: Bogotá D.C." />
        </div>
        <div>
          <FieldLabel>Departamento</FieldLabel>
          <Input value={form.department ?? ""} onChange={(v) => set("department", v)}
            placeholder="Ej: Cundinamarca" />
        </div>
      </div>

      {/* Aa, Av, Zona sísmica (auto-filled from municipio, editable) */}
      <div className="grid grid-cols-3 gap-3 mt-2">
        <div>
          <FieldLabel>Aa (g) *</FieldLabel>
          <Input type="number" step="0.01" min="0" value={form.Aa}
            onChange={(v) => set("Aa", v)} placeholder="0.15" />
        </div>
        <div>
          <FieldLabel>Av (g) *</FieldLabel>
          <Input type="number" step="0.01" min="0" value={form.Av}
            onChange={(v) => set("Av", v)} placeholder="0.15" />
        </div>
        <div>
          <FieldLabel>Zona sísmica</FieldLabel>
          <Input value={form.seismic_zone ?? ""} onChange={(v) => set("seismic_zone", v)}
            placeholder="Alta / Media / Baja" />
        </div>
      </div>

      {/* Soil type */}
      <div className="mt-2">
        <FieldLabel>Tipo de suelo (NSR-10 A.2.4) *</FieldLabel>
        <Select value={form.soil_type} onChange={(v) => set("soil_type", v)}>
          {SOIL_TYPES.map(({ value, label }) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </Select>
      </div>

      {/* Computed Fa / Fv */}
      {computedFaFv && (
        <div className="grid grid-cols-2 gap-3 mt-2">
          <div className="rounded-lg border border-border bg-surface-2 px-4 py-2.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
              Fa — NSR-10 Tabla A.2.4-1
            </p>
            <p className="text-xl font-bold text-accent mt-0.5">{computedFaFv.Fa.toFixed(2)}</p>
            <p className="text-[10px] text-text-muted">Amplificación períodos cortos</p>
          </div>
          <div className="rounded-lg border border-border bg-surface-2 px-4 py-2.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
              Fv — NSR-10 Tabla A.2.4-2
            </p>
            <p className="text-xl font-bold text-accent mt-0.5">{computedFaFv.Fv.toFixed(2)}</p>
            <p className="text-[10px] text-text-muted">Amplificación períodos largos</p>
          </div>
        </div>
      )}

      {/* Botón previsualizar espectro */}
      <button
        type="button"
        onClick={handlePreviewClick}
        className="mt-3 self-start rounded border border-accent px-3 py-1.5 text-xs font-medium
                   text-accent hover:bg-accent hover:text-white transition-colors"
      >
        Previsualizar espectro NSR-10
      </button>

      {/* ── Sección 2: Grupo de uso ── */}
      <SectionTitle>Grupo de Uso e Importancia</SectionTitle>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel>Grupo de uso (NSR-10 A.2.5)</FieldLabel>
          <Select value={form.edification_use} onChange={handleUseChange}>
            {EDIFICATION_USES.map(({ value, label }) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </Select>
        </div>
        <div>
          <FieldLabel>Factor de importancia I</FieldLabel>
          <Input value={form.importance_factor} readOnly />
        </div>
      </div>

      {/* ── Sección 3: Sistema estructural ── */}
      <SectionTitle>Sistema Estructural y Factor R</SectionTitle>
      <div className="grid grid-cols-1 gap-3">
        <div>
          <FieldLabel>Sistema estructural (NSR-10 A.3)</FieldLabel>
          <Select value={form.structure_system} onChange={handleSystemChange}>
            {STRUCTURE_SYSTEMS.map(({ value, label }) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </Select>
        </div>
        <div>
          <FieldLabel>Nivel de disipación de energía</FieldLabel>
          <Select value={form.energy_dissipation} onChange={handleDissipationChange}>
            {DISSIPATION_LEVELS.map(({ value, label }) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 mt-2">
        <div>
          <FieldLabel>Factor R</FieldLabel>
          <Input type="number" step="0.5" min="1" value={form.R}
            onChange={(v) => set("R", v)} />
        </div>
        <div>
          <FieldLabel>Ct (período empírico)</FieldLabel>
          <Input type="number" step="0.001" min="0" value={form.Ct}
            onChange={(v) => set("Ct", v)} />
        </div>
        <div>
          <FieldLabel>α_x (exponente)</FieldLabel>
          <Input type="number" step="0.01" min="0" value={form.alpha_x}
            onChange={(v) => set("alpha_x", v)} />
        </div>
      </div>

      {/* ── Sección 4: Parámetros de análisis modal ── */}
      <SectionTitle>Parámetros de Análisis Modal</SectionTitle>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <FieldLabel>Amortiguamiento ζ</FieldLabel>
          <Input type="number" step="0.01" min="0.01" max="0.20"
            value={form.damping_ratio}
            onChange={(v) => set("damping_ratio", parseFloat(v) || 0.05)} />
        </div>
        <div>
          <FieldLabel>N° modos</FieldLabel>
          <Input type="number" step="1" min="3"
            value={form.n_modes}
            onChange={(v) => set("n_modes", parseInt(v) || 12)} />
        </div>
        <div>
          <FieldLabel>Combinación modal</FieldLabel>
          <Select value={form.combination_method} onChange={(v) => set("combination_method", v)}>
            <option value="CQC">CQC — Combinación Cuadrática Completa</option>
            <option value="SRSS">SRSS — Raíz cuadrada de la suma de cuadrados</option>
          </Select>
        </div>
      </div>

      {/* ── Sección 5: Patrones de carga ── */}
      <SectionTitle>Patrones de Carga del Modelo</SectionTitle>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel>Carga muerta (nombre en ETABS)</FieldLabel>
          <Input value={form.cm_load} onChange={(v) => set("cm_load", v)} placeholder="DEAD" />
        </div>
        <div>
          <FieldLabel>Carga viva (nombre en ETABS)</FieldLabel>
          <Input value={form.cv_load} onChange={(v) => set("cv_load", v)} placeholder="LIVE" />
        </div>
      </div>

      {/* ── Acciones ── */}
      <div className="flex items-center gap-3 mt-5 pt-4 border-t border-border">
        {error && (
          <p className="flex-1 text-xs text-[var(--color-danger)]">{error}</p>
        )}
        {saved && !error && (
          <p className="flex-1 text-xs text-[var(--color-success)]">
            Parámetros guardados correctamente.
          </p>
        )}
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="ml-auto rounded bg-accent px-4 py-2 text-sm font-semibold text-white
                     hover:bg-accent/90 disabled:opacity-50 transition-colors"
        >
          {saving ? "Guardando…" : "Guardar parámetros"}
        </button>
      </div>
    </div>
  );
}
