// ── Fase 0 — Constantes UI para checklists y selects ────────────────────────

import type { DamageLevel, StructuralSystem } from "@/lib/field-assessment-types";

export const HAZARD_CATALOG: { code: string; label: string; hasSeverity: boolean }[] = [
  { code: "collapse",             label: "Colapso total o parcial",                              hasSeverity: false },
  { code: "tilt",                 label: "Inclinación global o de piso",                        hasSeverity: true  },
  { code: "column_wall_failure",  label: "Falla en columnas o muros portantes",                 hasSeverity: true  },
  { code: "beam_failure",         label: "Falla en vigas o conexiones",                         hasSeverity: true  },
  { code: "foundation_failure",   label: "Falla en cimentación",                                hasSeverity: true  },
  { code: "falling_finishes",     label: "Caída de acabados, cielorrasos, revestimientos",      hasSeverity: false },
  { code: "external_falling",     label: "Caída de elementos externos (parapetos, tanques)",    hasSeverity: false },
  { code: "adjacent_damage",      label: "Edificio contiguo dañado (riesgo de pounding)",       hasSeverity: false },
  { code: "utility_leak",         label: "Escape de gas / agua / electricidad peligroso",       hasSeverity: false },
  { code: "blocked_access",       label: "Bloqueo de accesos o salidas de emergencia",          hasSeverity: false },
  { code: "geotech_active",       label: "Amenaza geotécnica activa (deslizamiento, licuación)", hasSeverity: false },
  { code: "victims_trapped",      label: "Presencia de víctimas o personas atrapadas",          hasSeverity: false },
  { code: "other",                label: "Otros peligros",                                       hasSeverity: false },
];

export const COMPONENTS: { code: string; label: string; isStructural: boolean }[] = [
  { code: "columns",         label: "Columnas",                       isStructural: true  },
  { code: "beams",           label: "Vigas",                          isStructural: true  },
  { code: "shear_walls",     label: "Muros de corte",                 isStructural: true  },
  { code: "partition_walls", label: "Tabiquería / muros divisorios",  isStructural: false },
  { code: "slab",            label: "Losa de entrepiso",              isStructural: true  },
  { code: "foundation",      label: "Cimentación",                    isStructural: true  },
  { code: "stairs",          label: "Escaleras",                      isStructural: false },
  { code: "roof",            label: "Cubierta",                       isStructural: false },
];

export const DAMAGE_LEVELS: { level: DamageLevel; label: string; desc: string }[] = [
  { level: "D0", label: "D0", desc: "Sin daño" },
  { level: "D1", label: "D1", desc: "Ligero — grietas capilares" },
  { level: "D2", label: "D2", desc: "Moderado — hasta 3 mm" },
  { level: "D3", label: "D3", desc: "Severo — > 3 mm, refuerzo expuesto" },
  { level: "D4", label: "D4", desc: "Muy severo — falla parcial" },
  { level: "D5", label: "D5", desc: "Colapso" },
];

export const STRUCTURAL_SYSTEMS: { code: StructuralSystem; label: string; covered: boolean }[] = [
  { code: "rc_frame",         label: "Pórtico de concreto reforzado",       covered: true },
  { code: "rc_wall",          label: "Muros de carga de concreto",          covered: true },
  { code: "rc_dual",          label: "Sistema dual pórtico-muro",           covered: true },
  { code: "rc_infill",        label: "Pórtico con relleno de mampostería",  covered: true },
  { code: "masonry_confined", label: "Mampostería confinada",               covered: false },
  { code: "urm",              label: "Mampostería no reforzada",            covered: false },
  { code: "steel",            label: "Acero",                               covered: false },
  { code: "wood",             label: "Madera",                              covered: false },
  { code: "tilt_up",          label: "Tilt-up",                             covered: false },
  { code: "lift_slab",        label: "Lift-slab / prefabricado",            covered: false },
  { code: "other",            label: "Otro",                                covered: false },
];
