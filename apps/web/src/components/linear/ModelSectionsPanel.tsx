"use client";

import { useEffect, useMemo, useState } from "react";
import type { FullModelData, SectionData } from "@/lib/structural-types";
import { structuralEditorApi } from "@/lib/structural-api";

interface SteelCatalogShape {
  name: string; A_mm2: number; d_mm: number; bf_mm: number;
  weight_kgm: number; Ix_mm4: number; Iy_mm4: number;
  Zx_mm3: number; Zy_mm3: number;
}
interface SteelCatalogGrade {
  name: string; fy_mpa: number; fu_mpa: number;
  E_mpa: number; G_mpa: number; eps_y: number;
}
interface ParametricSize {
  name: string;
  d_mm?: number;
  b_mm?: number;
  OD_mm?: number;
}
interface ParametricShape {
  label: string;
  sizes: ParametricSize[];
  default_thicknesses_mm: number[];
  user_adjustable_thickness: boolean;
}
interface SteelCatalog {
  shapes_by_type: Record<string, SteelCatalogShape[]>;
  parametric_shapes: Record<string, ParametricShape>;
  grades: SteelCatalogGrade[];
  total_shapes: number;
}

// Familias tabuladas (el usuario elige un perfil completo) y parametricas
// (el usuario elige dimensiones nominales + espesor). Los literales de familia
// coinciden con el ShapeType del engine (`engine.sections.steel_shapes`).
type SteelFamilyTab = "W" | "HSS_RECT" | "PIPE" | "IPE" | "HEA" | "HEB" | "HEM";
type SteelFamilyParam = "PTE" | "PHR";
type SteelFamily = SteelFamilyTab | SteelFamilyParam;

const TABULATED_FAMILIES: SteelFamilyTab[] = ["W", "IPE", "HEA", "HEB", "HEM", "HSS_RECT", "PIPE"];
const PARAMETRIC_FAMILIES: SteelFamilyParam[] = ["PTE", "PHR"];

const FAMILY_LABEL: Record<SteelFamily, string> = {
  W:        "W (I)",
  IPE:      "IPE",
  HEA:      "HEA",
  HEB:      "HEB",
  HEM:      "HEM",
  HSS_RECT: "HSS rect",
  PIPE:     "Pipe",
  PTE:      "PTE",
  PHR:      "PHR",
};

// Densidad del acero estructural para masa calculada (debe coincidir con el
// engine: packages/engine/src/engine/sections/steel_shapes.py).
const STEEL_DENSITY_KG_M3 = 7850.0;

// Propiedades geometricas calculadas para PTE (tubular rect. hueco).
function computePteProps(d_mm: number, b_mm: number, t_mm: number) {
  const d_in = d_mm - 2 * t_mm;
  const b_in = b_mm - 2 * t_mm;
  if (d_in <= 0 || b_in <= 0) return null;
  const A    = d_mm * b_mm - d_in * b_in;
  const Ix   = (b_mm * d_mm ** 3 - b_in * d_in ** 3) / 12;
  const Iy   = (d_mm * b_mm ** 3 - d_in * b_in ** 3) / 12;
  const Zx   = (b_mm * d_mm ** 2 - b_in * d_in ** 2) / 4;
  const mass = STEEL_DENSITY_KG_M3 * (A * 1e-6);
  return { A, Ix, Iy, Zx, mass };
}

// Propiedades geometricas calculadas para PHR (tubular circular hueco).
function computePhrProps(OD_mm: number, t_mm: number) {
  const ID = OD_mm - 2 * t_mm;
  if (ID <= 0) return null;
  const A    = Math.PI * (OD_mm ** 2 - ID ** 2) / 4;
  const I    = Math.PI * (OD_mm ** 4 - ID ** 4) / 64;
  const Z    = (OD_mm ** 3 - ID ** 3) / 6;
  const mass = STEEL_DENSITY_KG_M3 * (A * 1e-6);
  return { A, Ix: I, Iy: I, Zx: Z, mass };
}

// ── Preview sección transversal SVG ──────────────────────────────────────────

function SectionPreviewSVG({ h_cm, b_cm }: { h_cm: number; b_cm: number }) {
  const SVG_W = 180, SVG_H = 140;
  const PAD = 28;
  const maxDim = Math.max(h_cm, b_cm);
  const scale = (Math.min(SVG_W, SVG_H) - 2 * PAD) / maxDim;
  const rw = b_cm * scale;
  const rh = h_cm * scale;
  const ox = (SVG_W - rw) / 2;
  const oy = (SVG_H - rh) / 2;

  return (
    <svg width={SVG_W} height={SVG_H} viewBox={`0 0 ${SVG_W} ${SVG_H}`} className="text-[var(--text-muted)]">
      {/* Dimensión horizontal (b) */}
      <line x1={ox} y1={oy - 10} x2={ox + rw} y2={oy - 10} stroke="currentColor" strokeWidth="0.8" opacity="0.35" />
      <line x1={ox} y1={oy - 13} x2={ox} y2={oy - 7} stroke="currentColor" strokeWidth="0.8" opacity="0.35" />
      <line x1={ox + rw} y1={oy - 13} x2={ox + rw} y2={oy - 7} stroke="currentColor" strokeWidth="0.8" opacity="0.35" />
      <text x={ox + rw / 2} y={oy - 14} textAnchor="middle" fontSize="8" fill="currentColor" opacity="0.55">
        b = {b_cm.toFixed(0)} cm
      </text>
      {/* Dimensión vertical (h) */}
      <line x1={ox + rw + 10} y1={oy} x2={ox + rw + 10} y2={oy + rh} stroke="currentColor" strokeWidth="0.8" opacity="0.35" />
      <line x1={ox + rw + 7} y1={oy} x2={ox + rw + 13} y2={oy} stroke="currentColor" strokeWidth="0.8" opacity="0.35" />
      <line x1={ox + rw + 7} y1={oy + rh} x2={ox + rw + 13} y2={oy + rh} stroke="currentColor" strokeWidth="0.8" opacity="0.35" />
      <text x={ox + rw + 14} y={oy + rh / 2 + 3} textAnchor="start" fontSize="8" fill="currentColor" opacity="0.55">
        h = {h_cm.toFixed(0)} cm
      </text>
      {/* Rectángulo de sección */}
      <rect
        x={ox} y={oy} width={rw} height={rh}
        fill="#6366F1" fillOpacity="0.12"
        stroke="#6366F1" strokeWidth="1.5"
      />
      {/* Barras de esquina (decorativas) */}
      {[
        [ox + 6, oy + 6], [ox + rw - 6, oy + 6],
        [ox + 6, oy + rh - 6], [ox + rw - 6, oy + rh - 6],
      ].map(([cx, cy], i) => (
        <circle key={i} cx={cx} cy={cy} r="3" fill="#EF4444" fillOpacity="0.7" />
      ))}
      {/* Recubrimiento */}
      <rect
        x={ox + 5} y={oy + 5} width={rw - 10} height={rh - 10}
        fill="none" stroke="#6366F1" strokeWidth="0.6" strokeDasharray="3 2" opacity="0.3"
      />
    </svg>
  );
}

function SectionMiniThumb({ h_cm, b_cm }: { h_cm: number; b_cm: number }) {
  const W = 32, H = 24, PAD = 3;
  const maxDim = Math.max(h_cm, b_cm, 1);
  const scale = (Math.min(W, H) - 2 * PAD) / maxDim;
  const rw = Math.max(b_cm * scale, 2);
  const rh = Math.max(h_cm * scale, 2);
  const ox = (W - rw) / 2;
  const oy = (H - rh) / 2;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="flex-shrink-0">
      <rect x={ox} y={oy} width={rw} height={rh}
        fill="#6366F1" fillOpacity="0.15" stroke="#6366F1" strokeWidth="1" />
    </svg>
  );
}

interface Props {
  projectId: string;
  modelData: FullModelData;
  onModelDataChange: () => void;
}

interface SectionForm {
  name: string;
  material: string;
  shape: string;
  h_cm: string;   // en cm para el usuario
  b_cm: string;
}

const DEFAULT_FORM: SectionForm = { name: "", material: "", shape: "Rectangular", h_cm: "", b_cm: "" };

function usesCount(sectionName: string, frames: FullModelData["frames"]): number {
  return Object.values(frames).filter(f => f.section === sectionName).length;
}

export default function ModelSectionsPanel({ projectId, modelData, onModelDataChange }: Props) {
  const [mode, setMode] = useState<"list" | "create" | "create-steel" | "edit">("list");
  const [editingName, setEditingName] = useState<string | null>(null);
  const [form, setForm] = useState<SectionForm>(DEFAULT_FORM);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  // ── Catálogo de acero (lazy) ─────────────────────────────────────────────
  const [steelCatalog, setSteelCatalog] = useState<SteelCatalog | null>(null);
  const [steelForm, setSteelForm] = useState({
    name:       "",
    family:     "W" as SteelFamily,
    shape_name: "",         // selector dentro de la familia
    grade:      "A992",
    thickness_mm: "",       // solo PTE/PHR; string para permitir input vacío
  });

  // Carga lazy al entrar en modo create-steel
  useEffect(() => {
    if (mode !== "create-steel" || steelCatalog) return;
    structuralEditorApi.getSteelCatalog()
      .then((c) => {
        setSteelCatalog(c);
        // Default: primer shape W + grado A992
        const firstW = c.shapes_by_type["W"]?.[0]?.name ?? "";
        setSteelForm((f) => ({ ...f, shape_name: f.shape_name || firstW }));
      })
      .catch((e) => setError(e instanceof Error ? e.message : "No se pudo cargar el catálogo de acero"));
  }, [mode, steelCatalog]);

  const isParametric = PARAMETRIC_FAMILIES.includes(steelForm.family as SteelFamilyParam);

  const tabulatedShapes = useMemo(() => {
    if (isParametric) return [];
    return steelCatalog?.shapes_by_type[steelForm.family] ?? [];
  }, [steelCatalog, steelForm.family, isParametric]);

  const parametricInfo: ParametricShape | undefined = isParametric
    ? steelCatalog?.parametric_shapes?.[steelForm.family]
    : undefined;

  const tabulatedShape = tabulatedShapes.find((s) => s.name === steelForm.shape_name);
  const parametricSize = parametricInfo?.sizes.find((s) => s.name === steelForm.shape_name);
  const steelGrade = steelCatalog?.grades.find((g) => g.name === steelForm.grade);

  // Propiedades mostradas en el preview (A, I, Z, mass).
  const previewProps = useMemo(() => {
    if (tabulatedShape) {
      return {
        A_mm2:    tabulatedShape.A_mm2,
        Ix_mm4:   tabulatedShape.Ix_mm4,
        Iy_mm4:   tabulatedShape.Iy_mm4,
        Zx_mm3:   tabulatedShape.Zx_mm3,
        mass_kgm: tabulatedShape.weight_kgm,
        d_mm:     tabulatedShape.d_mm,
        bf_mm:    tabulatedShape.bf_mm,
      };
    }
    if (isParametric && parametricSize) {
      const t = parseFloat(steelForm.thickness_mm);
      if (!isFinite(t) || t <= 0) return null;
      if (steelForm.family === "PTE" && parametricSize.d_mm && parametricSize.b_mm) {
        const p = computePteProps(parametricSize.d_mm, parametricSize.b_mm, t);
        if (!p) return null;
        return {
          A_mm2: p.A, Ix_mm4: p.Ix, Iy_mm4: p.Iy, Zx_mm3: p.Zx, mass_kgm: p.mass,
          d_mm: parametricSize.d_mm, bf_mm: parametricSize.b_mm,
        };
      }
      if (steelForm.family === "PHR" && parametricSize.OD_mm) {
        const p = computePhrProps(parametricSize.OD_mm, t);
        if (!p) return null;
        return {
          A_mm2: p.A, Ix_mm4: p.Ix, Iy_mm4: p.Iy, Zx_mm3: p.Zx, mass_kgm: p.mass,
          d_mm: parametricSize.OD_mm, bf_mm: parametricSize.OD_mm,
        };
      }
    }
    return null;
  }, [tabulatedShape, isParametric, parametricSize, steelForm.family, steelForm.thickness_mm]);

  function startCreateSteel() {
    setSteelForm({ name: "", family: "W", shape_name: "", grade: "A992", thickness_mm: "" });
    setMode("create-steel");
    setError(null);
    setSuccess(null);
  }

  function selectFamily(fam: SteelFamily) {
    if (!steelCatalog) return;
    setSteelForm((f) => {
      let next_shape = "";
      let next_t = f.thickness_mm;
      if (PARAMETRIC_FAMILIES.includes(fam as SteelFamilyParam)) {
        const info = steelCatalog.parametric_shapes?.[fam];
        next_shape = info?.sizes[0]?.name ?? "";
        // espesor por default: primero de la lista (2.0 para PHR, 3.0 para PTE)
        if (!next_t) {
          next_t = (info?.default_thicknesses_mm?.[0] ?? "").toString();
        }
      } else {
        next_shape = steelCatalog.shapes_by_type[fam]?.[0]?.name ?? "";
      }
      return { ...f, family: fam, shape_name: next_shape };
    });
  }

  async function handleSaveSteel() {
    if (!steelForm.name.trim() || !steelForm.shape_name || !steelForm.grade) {
      setError("Completa nombre, perfil y grado.");
      return;
    }
    if (isParametric) {
      const t = parseFloat(steelForm.thickness_mm);
      if (!isFinite(t) || t <= 0) {
        setError("Especifica el espesor t (mm) para " + steelForm.family + ".");
        return;
      }
    }
    setSaving(true); setError(null);
    try {
      const payload: {
        name: string; shape_name: string; grade: string; thickness_mm?: number;
      } = {
        name:       steelForm.name.trim(),
        shape_name: steelForm.shape_name,
        grade:      steelForm.grade,
      };
      if (isParametric) {
        payload.thickness_mm = parseFloat(steelForm.thickness_mm);
      }
      const r = await structuralEditorApi.createSteelSection(projectId, payload);
      setSuccess(`Sección "${r.name}" creada (material ${r.material_created})`);
      setMode("list");
      await onModelDataChange();
      setTimeout(() => setSuccess(null), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al crear sección de acero");
    } finally {
      setSaving(false);
    }
  }

  const { sections, materials, frames } = modelData;
  const matNames = Object.keys(materials);

  const filtered = Object.entries(sections).filter(([name]) =>
    name.toLowerCase().includes(filter.toLowerCase())
  );

  function startCreate() {
    setForm({ ...DEFAULT_FORM, material: matNames[0] ?? "" });
    setEditingName(null);
    setMode("create");
    setError(null);
    setSuccess(null);
  }

  function startEdit(name: string, sec: SectionData) {
    setForm({
      name,
      material: sec.material,
      shape: sec.shape,
      h_cm: (sec.h_m * 100).toFixed(0),
      b_cm: (sec.b_m * 100).toFixed(0),
    });
    setEditingName(name);
    setMode("edit");
    setError(null);
    setSuccess(null);
  }

  function cancel() {
    setMode("list");
    setForm(DEFAULT_FORM);
    setEditingName(null);
    setError(null);
    setSuccess(null);
  }

  async function handleSave() {
    if (!form.name.trim() || !form.material || !form.h_cm || !form.b_cm) {
      setError("Completa todos los campos requeridos.");
      return;
    }
    const h_m = parseFloat(form.h_cm) / 100;
    const b_m = parseFloat(form.b_cm) / 100;
    if (isNaN(h_m) || h_m <= 0 || isNaN(b_m) || b_m <= 0) {
      setError("Las dimensiones deben ser valores positivos.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      if (mode === "create") {
        await structuralEditorApi.createSection(projectId, form.name.trim(), {
          material: form.material,
          shape: form.shape,
          h_m,
          b_m,
        });
        setSuccess(`Sección '${form.name}' creada.`);
      } else if (mode === "edit" && editingName) {
        await structuralEditorApi.updateSection(projectId, editingName, {
          material: form.material,
          shape: form.shape,
          h_m,
          b_m,
        });
        setSuccess(`Sección '${editingName}' actualizada.`);
      }
      onModelDataChange();
      setMode("list");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al guardar");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(name: string) {
    const uses = usesCount(name, frames);
    const confirm = window.confirm(
      uses > 0
        ? `La sección '${name}' está asignada a ${uses} elemento(s). Al eliminarla quedarán sin sección. ¿Continuar?`
        : `¿Eliminar la sección '${name}'?`
    );
    if (!confirm) return;
    setDeleting(name);
    try {
      await structuralEditorApi.deleteSection(projectId, name);
      onModelDataChange();
      setSuccess(`Sección '${name}' eliminada.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al eliminar");
    } finally {
      setDeleting(null);
    }
  }

  // ── Lista ──────────────────────────────────────────────────────────────────
  if (mode === "list") {
    return (
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="px-4 py-3 border-b border-border bg-surface-2 flex-shrink-0">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-text">
              Secciones <span className="text-text-muted font-normal">({Object.keys(sections).length})</span>
            </span>
            <div className="flex gap-1">
              <button
                onClick={startCreate}
                className="text-[11px] px-2.5 py-1 rounded-lg bg-accent text-white hover:bg-accent/80 transition-colors font-medium"
                title="Crear sección RC (rectangular / circular / especial)"
              >
                + RC
              </button>
              <button
                onClick={startCreateSteel}
                className="text-[11px] px-2.5 py-1 rounded-lg bg-slate-600 text-white hover:bg-slate-700 transition-colors font-medium"
                title="Crear sección metálica (perfil AISC)"
              >
                + Acero
              </button>
            </div>
          </div>
          <input
            type="text"
            placeholder="Filtrar secciones…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="w-full text-xs rounded-lg border border-border bg-surface px-2.5 py-1.5 text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
          />
        </div>

        {success && (
          <div className="mx-4 mt-2 px-3 py-1.5 rounded-lg bg-success/10 border border-success/30">
            <p className="text-[11px] text-success">{success}</p>
          </div>
        )}
        {error && (
          <div className="mx-4 mt-2 px-3 py-1.5 rounded-lg bg-danger/10 border border-danger/30">
            <p className="text-[11px] text-danger">{error}</p>
          </div>
        )}

        {/* Lista */}
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 && (
            <div className="px-4 py-8 text-center">
              <p className="text-xs text-text-muted">
                {filter ? "Sin resultados para ese filtro." : "No hay secciones definidas."}
              </p>
            </div>
          )}
          {filtered.map(([name, sec]) => {
            const uses = usesCount(name, frames);
            const h_cm = sec.h_m * 100;
            const b_cm = sec.b_m * 100;
            return (
              <div key={name}
                className="flex items-center gap-2 px-4 py-2.5 border-b border-border/40 hover:bg-surface-2 transition-colors group">
                <SectionMiniThumb h_cm={h_cm} b_cm={b_cm} />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-text truncate">{name}</p>
                  <p className="text-[10px] text-text-muted">
                    {h_cm.toFixed(0)}×{b_cm.toFixed(0)} cm
                    &nbsp;·&nbsp;{sec.material}
                    {uses > 0 && <span className="ml-1 text-accent">{uses} elem.</span>}
                  </p>
                </div>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => startEdit(name, sec)}
                    className="text-[10px] px-2 py-0.5 rounded border border-border text-text-muted hover:text-text hover:border-accent transition-colors"
                  >
                    Editar
                  </button>
                  <button
                    onClick={() => handleDelete(name)}
                    disabled={deleting === name}
                    className="text-[10px] px-2 py-0.5 rounded border border-danger/40 text-danger hover:bg-danger/10 transition-colors disabled:opacity-40"
                  >
                    {deleting === name ? "…" : "×"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ── Formulario crear sección de acero ──────────────────────────────────────
  if (mode === "create-steel") {
    return (
      <div className="flex flex-col h-full">
        <div className="px-4 py-3 border-b border-border bg-surface-2 flex-shrink-0 flex items-center justify-between">
          <p className="text-xs font-semibold text-text">Nueva sección de acero (AISC + DIN + NSR-10)</p>
          <button onClick={cancel} className="text-[10px] text-text-muted hover:text-text">Cancelar</button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3">
          {error && (
            <div className="px-3 py-1.5 rounded-lg bg-danger/10 border border-danger/30">
              <p className="text-[11px] text-danger">{error}</p>
            </div>
          )}

          {!steelCatalog && (
            <p className="text-xs text-text-muted">Cargando catálogo de perfiles…</p>
          )}

          {steelCatalog && (
            <>
              <div>
                <label className="text-[10px] font-semibold uppercase tracking-widest text-text-muted block mb-1">
                  Nombre de la sección *
                </label>
                <input
                  type="text"
                  placeholder="ej. COL-W14X90 o VIG-IPE-300"
                  value={steelForm.name}
                  onChange={(e) => setSteelForm((f) => ({ ...f, name: e.target.value }))}
                  className="w-full text-xs rounded-lg border border-border bg-surface px-2.5 py-1.5 text-text focus:outline-none focus:border-accent"
                />
              </div>

              <div>
                <label className="text-[10px] font-semibold uppercase tracking-widest text-text-muted block mb-1">
                  Familia de perfil
                </label>
                <div className="grid grid-cols-5 gap-1">
                  {TABULATED_FAMILIES.map((t) => (
                    <button
                      key={t}
                      onClick={() => selectFamily(t)}
                      className={[
                        "text-[10px] px-1.5 py-1.5 rounded-lg border transition-colors",
                        steelForm.family === t
                          ? "bg-indigo-600 text-white border-indigo-600"
                          : "bg-surface border-border text-text-muted hover:text-text",
                      ].join(" ")}
                    >
                      {FAMILY_LABEL[t]}
                      <span className="ml-0.5 opacity-60 text-[9px]">
                        ({steelCatalog.shapes_by_type[t]?.length ?? 0})
                      </span>
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-1 mt-1">
                  {PARAMETRIC_FAMILIES.map((t) => (
                    <button
                      key={t}
                      onClick={() => selectFamily(t)}
                      className={[
                        "text-[10px] px-1.5 py-1.5 rounded-lg border transition-colors",
                        steelForm.family === t
                          ? "bg-emerald-600 text-white border-emerald-600"
                          : "bg-surface border-border text-text-muted hover:text-text",
                      ].join(" ")}
                      title={steelCatalog.parametric_shapes?.[t]?.label}
                    >
                      {FAMILY_LABEL[t]}
                      <span className="ml-0.5 opacity-60 text-[9px]">
                        ({steelCatalog.parametric_shapes?.[t]?.sizes.length ?? 0} tamaños · t libre)
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-[10px] font-semibold uppercase tracking-widest text-text-muted block mb-1">
                  {isParametric ? "Dimensión nominal" : "Perfil"}
                </label>
                <select
                  value={steelForm.shape_name}
                  onChange={(e) => setSteelForm((f) => ({ ...f, shape_name: e.target.value }))}
                  className="w-full text-xs rounded-lg border border-border bg-surface px-2.5 py-1.5 text-text font-mono focus:outline-none focus:border-accent"
                >
                  {isParametric && parametricInfo?.sizes.map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.name}  —  {steelForm.family === "PTE"
                        ? `${s.d_mm} × ${s.b_mm} mm`
                        : `OD ${s.OD_mm} mm`}
                    </option>
                  ))}
                  {!isParametric && tabulatedShapes.map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.name}  —  {s.weight_kgm.toFixed(1)} kg/m, d={s.d_mm.toFixed(0)} mm
                    </option>
                  ))}
                </select>
              </div>

              {isParametric && parametricInfo && (
                <div>
                  <label className="text-[10px] font-semibold uppercase tracking-widest text-text-muted block mb-1">
                    Espesor t (mm) *
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    min="0.1"
                    placeholder={`ej. ${parametricInfo.default_thicknesses_mm[0] ?? 3}`}
                    value={steelForm.thickness_mm}
                    onChange={(e) => setSteelForm((f) => ({ ...f, thickness_mm: e.target.value }))}
                    className="w-full text-xs rounded-lg border border-border bg-surface px-2.5 py-1.5 text-text font-mono focus:outline-none focus:border-accent"
                  />
                  <div className="flex gap-1 mt-1.5 flex-wrap">
                    {parametricInfo.default_thicknesses_mm.map((t) => (
                      <button
                        key={t}
                        onClick={() => setSteelForm((f) => ({ ...f, thickness_mm: String(t) }))}
                        className={[
                          "text-[10px] px-2 py-0.5 rounded border transition-colors font-mono",
                          parseFloat(steelForm.thickness_mm) === t
                            ? "bg-emerald-600/20 border-emerald-600 text-emerald-600"
                            : "bg-surface border-border text-text-muted hover:text-text",
                        ].join(" ")}
                      >
                        {t} mm
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <label className="text-[10px] font-semibold uppercase tracking-widest text-text-muted block mb-1">
                  Grado del acero
                </label>
                <select
                  value={steelForm.grade}
                  onChange={(e) => setSteelForm((f) => ({ ...f, grade: e.target.value }))}
                  className="w-full text-xs rounded-lg border border-border bg-surface px-2.5 py-1.5 text-text font-mono focus:outline-none focus:border-accent"
                >
                  {steelCatalog.grades.map((g) => (
                    <option key={g.name} value={g.name}>
                      {g.name}  —  fy={g.fy_mpa} MPa, fu={g.fu_mpa} MPa
                    </option>
                  ))}
                </select>
              </div>

              {/* Preview + propiedades */}
              {previewProps && steelGrade && (
                <div className="rounded-lg border border-border bg-surface-2 p-3 space-y-2">
                  <p className="text-[10px] uppercase tracking-widest text-text-muted">
                    Vista previa — {steelForm.shape_name}
                    {isParametric && steelForm.thickness_mm && ` × ${steelForm.thickness_mm} mm`}
                  </p>
                  <div className="flex items-center gap-4">
                    <SteelShapePreviewSVG family={steelForm.family} d_mm={previewProps.d_mm} bf_mm={previewProps.bf_mm} t_mm={isParametric ? parseFloat(steelForm.thickness_mm) : undefined} />
                    <div className="flex-1 text-[11px] space-y-0.5">
                      <PropRow label="A"    value={`${(previewProps.A_mm2 * 1e-2).toFixed(2)} cm²`} />
                      <PropRow label="Masa" value={`${previewProps.mass_kgm.toFixed(1)} kg/m`} />
                      <PropRow label="Ix"   value={`${(previewProps.Ix_mm4 * 1e-6).toFixed(1)}×10⁶ mm⁴`} />
                      <PropRow label="Iy"   value={`${(previewProps.Iy_mm4 * 1e-6).toFixed(1)}×10⁶ mm⁴`} />
                      <PropRow label="Zx"   value={`${(previewProps.Zx_mm3 * 1e-3).toFixed(1)} cm³`} />
                      <PropRow label="Mp,x" value={`${(previewProps.Zx_mm3 * steelGrade.fy_mpa * 1e-6).toFixed(0)} kN·m`} />
                      <PropRow label="Py"   value={`${(previewProps.A_mm2 * steelGrade.fy_mpa * 1e-3).toFixed(0)} kN`} />
                    </div>
                  </div>
                </div>
              )}

              <button
                onClick={handleSaveSteel}
                disabled={saving || !steelForm.name.trim() || !steelForm.shape_name || (isParametric && !parseFloat(steelForm.thickness_mm))}
                className="mt-2 text-xs px-3 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors font-medium disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {saving ? "Creando…" : "Crear sección metálica"}
              </button>
              <p className="text-[10px] italic text-text-muted">
                Se auto-crea el material de acero <code className="font-mono">Steel_{steelForm.grade}</code> si aún no existe.
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  // ── Formulario crear/editar ────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border bg-surface-2 flex-shrink-0">
        <p className="text-xs font-semibold text-text">
          {mode === "create" ? "Nueva sección" : `Editar: ${editingName}`}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3">
        {mode === "create" && (
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-widest text-text-muted block mb-1">
              Nombre *
            </label>
            <input
              type="text"
              placeholder="ej. C40x60"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              className="w-full text-xs rounded-lg border border-border bg-surface px-2.5 py-1.5 text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
            />
          </div>
        )}

        <div>
          <label className="text-[10px] font-semibold uppercase tracking-widest text-text-muted block mb-1">
            Material *
          </label>
          <select
            value={form.material}
            onChange={e => setForm(f => ({ ...f, material: e.target.value }))}
            className="w-full text-xs rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-text focus:outline-none focus:border-accent"
          >
            <option value="">— Seleccionar —</option>
            {matNames.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-widest text-text-muted block mb-1">
              h (cm) *
            </label>
            <input
              type="number" min="1" step="1"
              placeholder="60"
              value={form.h_cm}
              onChange={e => setForm(f => ({ ...f, h_cm: e.target.value }))}
              className="w-full text-xs rounded-lg border border-border bg-surface px-2.5 py-1.5 text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-widest text-text-muted block mb-1">
              b (cm) *
            </label>
            <input
              type="number" min="1" step="1"
              placeholder="40"
              value={form.b_cm}
              onChange={e => setForm(f => ({ ...f, b_cm: e.target.value }))}
              className="w-full text-xs rounded-lg border border-border bg-surface px-2.5 py-1.5 text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
            />
          </div>
        </div>

        {/* Preview visual + propiedades calculadas */}
        {form.h_cm && form.b_cm && parseFloat(form.h_cm) > 0 && parseFloat(form.b_cm) > 0 && (
          <div className="rounded-lg border border-border/60 bg-surface-2 px-3 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-text-muted mb-2">
              Sección transversal
            </p>
            {(() => {
              const h = parseFloat(form.h_cm) / 100;
              const b = parseFloat(form.b_cm) / 100;
              const A   = b * h;
              const I33 = b * h ** 3 / 12;
              const I22 = h * b ** 3 / 12;
              return (
                <div className="flex items-center gap-3">
                  <SectionPreviewSVG h_cm={parseFloat(form.h_cm)} b_cm={parseFloat(form.b_cm)} />
                  <div className="text-[10px] text-text-muted space-y-1">
                    <div className="flex justify-between gap-4">
                      <span>A</span>
                      <span className="font-mono text-text">{(A * 10000).toFixed(1)} cm²</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span>I₃₃</span>
                      <span className="font-mono text-text">{(I33 * 1e8).toFixed(0)} cm⁴</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span>I₂₂</span>
                      <span className="font-mono text-text">{(I22 * 1e8).toFixed(0)} cm⁴</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span>r₃₃</span>
                      <span className="font-mono text-text">{(Math.sqrt(I33 / A) * 100).toFixed(1)} cm</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span>S₃₃</span>
                      <span className="font-mono text-text">{(b * h ** 2 / 6 * 1e6).toFixed(0)} cm³</span>
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {error && (
          <p className="text-[11px] text-danger px-1">{error}</p>
        )}
      </div>

      {/* Acciones */}
      <div className="px-4 py-3 border-t border-border flex gap-2 flex-shrink-0">
        <button
          onClick={cancel}
          className="flex-1 py-1.5 text-xs font-medium rounded-lg border border-border text-text-muted hover:text-text hover:border-text-muted transition-colors"
        >
          Cancelar
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex-1 py-1.5 text-xs font-medium rounded-lg bg-accent text-white hover:bg-accent/80 transition-colors disabled:opacity-40"
        >
          {saving ? "Guardando…" : mode === "create" ? "Crear sección" : "Guardar cambios"}
        </button>
      </div>
    </div>
  );
}

// ── Preview SVG de perfil metálico (W, HSS rect, Pipe) ───────────────────────

function SteelShapePreviewSVG({
  family, d_mm, bf_mm, t_mm,
}: {
  family: SteelFamily;
  d_mm: number;
  bf_mm: number;
  t_mm?: number;   // espesor real para PTE/PHR
}) {
  const SIZE = 90, PAD = 10;
  const d  = d_mm;
  const bf = bf_mm;
  const maxDim = Math.max(d, bf);
  const scale = (SIZE - 2 * PAD) / maxDim;
  const cx = SIZE / 2;
  const cy = SIZE / 2;

  const isIFamily   = ["W", "IPE", "HEA", "HEB", "HEM"].includes(family);
  const isBoxFamily = ["HSS_RECT", "PTE"].includes(family);
  const isRoundTube = ["PIPE", "PHR"].includes(family);

  if (isIFamily) {
    const h = d * scale;
    const w = bf * scale;
    const tf = Math.max(2, h * 0.08);
    const tw = Math.max(1.5, w * 0.06);
    return (
      <svg width={SIZE} height={SIZE} className="flex-shrink-0">
        <rect x={cx - w / 2} y={cy - h / 2}   width={w}  height={tf} fill="#64748b" opacity="0.8" />
        <rect x={cx - w / 2} y={cy + h / 2 - tf} width={w} height={tf} fill="#64748b" opacity="0.8" />
        <rect x={cx - tw / 2} y={cy - h / 2 + tf} width={tw} height={h - 2 * tf} fill="#64748b" opacity="0.8" />
      </svg>
    );
  }

  if (isBoxFamily) {
    const h = d * scale;
    const w = bf * scale;
    const t = t_mm !== undefined && isFinite(t_mm) && t_mm > 0
      ? Math.max(1.5, t_mm * scale)
      : Math.max(1.5, Math.min(h, w) * 0.07);
    return (
      <svg width={SIZE} height={SIZE} className="flex-shrink-0">
        <rect x={cx - w / 2} y={cy - h / 2} width={w} height={h}
          fill="#64748b" fillOpacity="0.2" stroke="#64748b" strokeWidth={t} />
      </svg>
    );
  }

  if (isRoundTube) {
    const r = (d / 2) * scale;   // d = OD
    const t = t_mm !== undefined && isFinite(t_mm) && t_mm > 0
      ? Math.max(1.5, t_mm * scale)
      : Math.max(1.5, r * 0.15);
    return (
      <svg width={SIZE} height={SIZE} className="flex-shrink-0">
        <circle cx={cx} cy={cy} r={r}
          fill="#64748b" fillOpacity="0.2" stroke="#64748b" strokeWidth={t} />
      </svg>
    );
  }

  return <svg width={SIZE} height={SIZE} className="flex-shrink-0" />;
}

function PropRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-text-muted">{label}</span>
      <span className="font-mono text-text">{value}</span>
    </div>
  );
}
