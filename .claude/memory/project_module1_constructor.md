---
name: Módulo 1 — Constructor de Modelos Estructurales
description: Estado del desarrollo del Módulo 1 (análisis sísmico lineal): ruta /projects, arquitectura, fases y archivos clave
type: project
originSessionId: 473a2d8a-c540-4dfc-b695-914fa37a668b
---
## Objetivo
Importar modelos ETABS (XLSX/.e2k), validar, construir modelo lineal, análisis modal + espectral NSR-10 + ajuste FHE.
Es el núcleo de la plataforma — alimenta diseño y eventualmente Módulo 3 (no lineal).

## Ruta y navegación
- `/projects` → lista de proyectos estructurales
- `/projects/[id]` → wizard 4 tabs: Modelo | Análisis Sísmico | Diseño (🔒) | Modelo NL (🔒)

## Estado actual (2026-08-15): F0–F8 completos + 2 bugs críticos corregidos y verificados en Docker

### Backend creado
- `apps/api/app/models.py` → +`StructuralProject`, `StructuralJob`, `StructuralAnalysisType`, `StructuralJobStatus`
- `apps/api/app/routers/structural_projects.py` → CRUD + uploads (.xlsx, .e2k) + parámetros
- `apps/api/app/routers/structural_analysis.py` → launch / jobStatus / result / cancel
- `apps/api/app/tasks/structural_helpers.py` → mark_running/success/failed + update_project_validation + prepare_work_dir
- `apps/api/app/main.py` → structural_analysis (primero, más específico) + structural_projects
- `apps/api/alembic/versions/a3f2c1d8e9b0_module1_structural_projects.py` → migración Alembic

### Frontend creado
- `apps/web/src/lib/structural-types.ts` → todos los tipos TS del módulo
- `apps/web/src/lib/structural-api.ts` → structuralProjectsApi + structuralAnalysisApi
- `apps/web/src/app/projects/page.tsx` → lista de proyectos con StatusBadge
- `apps/web/src/app/projects/[id]/page.tsx` → wizard tabs con polling cada 3s

### API endpoints registrados (verificado via OpenAPI)
- GET/POST `/api/v1/projects`
- GET/DELETE `/api/v1/projects/{id}`
- PUT `/api/v1/projects/{id}/parameters`
- POST `/api/v1/projects/{id}/upload-model` (.xlsx)
- POST `/api/v1/projects/{id}/upload-e2k` (.e2k)
- GET `/api/v1/projects/{id}/jobs`
- POST `/api/v1/projects/analysis/launch`
- GET/DELETE `/api/v1/projects/analysis/jobs/{id}`, `/result`, `/download`, `/cancel`

### DB (SQLite dev)
Tablas creadas: `structural_projects`, `structural_jobs` — verificadas con columnas correctas.

### F1 completado (2026-07-30)
- `apps/api/app/engine/building/linear/validator.py` → DataValidator: 9 checks críticos + 7 advertencias
- `apps/api/app/engine/building/linear/model_builder.py` → CanonicalModelBuilder: genera structural_model.json
- `apps/api/app/tasks/structural_import_task.py` → tarea Celery: e2k→xlsx → ETABS23→17 → validar → build JSON
- `apps/web/src/components/linear/ValidationReport.tsx` → componente con banner estado + resumen + tabla issues
- `/projects/[id]/page.tsx` → integrado: muestra ValidationReport al completar import_validate

### F3 completado (2026-07-30)
- `apps/api/app/routers/structural_projects.py` → +`POST /{id}/spectrum-preview` (sync, llama engine)
- `apps/web/src/lib/structural-types.ts` → +`SpectrumPreviewResult`, `SpectrumPreviewPoint`
- `apps/web/src/lib/structural-api.ts` → +`spectrumPreview()`
- `apps/web/src/components/linear/SeismicParamsForm.tsx` → formulario NSR-10 completo con auto-fill R/Ct/I
- `apps/web/src/components/linear/SpectrumPreview.tsx` → gráfica Plotly CDN con Sa(T) + pills SDs/SD1/Fa/Fv

### F4 completado (2026-07-30)
- `apps/api/app/engine/building/linear/ops_builder.py` → LinearOPSBuilder: elasticBeamColumn + masas CM + rigidDiaphragm
- `apps/api/app/tasks/structural_modal_task.py` → Celery task: canonical JSON → OpenSees → eigen → modal_results.json
- `apps/web/src/components/linear/ModalResultsTable.tsx` → tabla de modos con barras de participación
- `/projects/[id]/page.tsx` → integrado: carga y muestra ModalResultsTable tras job modal exitoso

### F5 + F6 completados (2026-07-30)
- `apps/api/app/engine/building/linear/spectral_analysis.py` → SpectralAnalyzer: RSA CQC/SRSS, fuerzas/cortantes/derivas por piso
- `apps/api/app/engine/building/linear/fhe.py` → FHEChecker: Vb_modal vs Vb_min NSR-10 A.4.2.2, factores de escala
- `apps/api/app/tasks/structural_spectral_task.py` → Celery task: carga canonical+modal → análisis → FHE → spectral_results.json
- `apps/web/src/components/linear/SpectralResultsPanel.tsx` → FHEPanel + DriftTable + ShearChart (Plotly)
- `/projects/[id]/page.tsx` → integrado: carga SpectralResultsPanel tras job spectral exitoso

## Flujo completo del Módulo 1 (end-to-end)
1. Subir XLSX/e2k → Validar → ValidationReport
2. Configurar parámetros NSR-10 → Guardar → Previsualizar espectro
3. Ejecutar Modal → ModalResultsTable (períodos, participación, T1/T1x/T1y)
4. Ejecutar Espectral → SpectralResultsPanel (FHE, cortantes, derivas)

### F7 completado (2026-08-14) — Diseño de columnas P-M
- `engine/building/design/combinations.py` → 10 combinaciones NSR-10 B.3.4 (G1-G2, S1-S8)
- `engine/building/design/column_check.py` → pm_capacity, check_pm, distribute_gravity, distribute_seismic_moment
- `apps/api/app/tasks/structural_design_task.py` → Celery: portal method + envolvente + ρ=1%
- `apps/web/src/components/linear/CombinationSelector.tsx` → selector de 10 combos en 3 grupos
- `apps/web/src/components/linear/ColumnDesignResults.tsx` → tabla DCR + barras progreso

### F8 completado (2026-08-14) — Diseño de vigas flexión + cortante
- `engine/building/design/beam_check.py` → parse_beam_section, distribute_gravity_beams, distribute_seismic_beams, design_flexure, design_shear, check_beam
- `apps/api/app/tasks/structural_beam_task.py` → Celery: gravedad acumulada + portal method + envolvente
- `apps/web/src/components/linear/BeamDesignResults.tsx` → tabla agrupada por piso con As y estribos
- `StructuralAnalysisType`: `design_beams` agregado (migración d8e3f4a2b1c6)
- **Salida**: As_neg/pos en cm², estribos #3@s mm, DCR por flexión y cortante

### Bugs corregidos (2026-08-15) — Verificados con proyecto real Artesia_E23

**Bug 1 — `element_type` en model_builder** (`apps/api/app/engine/building/linear/model_builder.py`)
- ETABS E23 usa `"Frame"` como Object Type para columnas Y vigas → `_build_frames()` marcaba todo como "beam"
- Fix: clasificación geométrica como fallback: columna si `dz > sqrt(dx²+dy²)`
- `build()` ahora pasa `joints` a `_build_frames(joints)` para acceder a coordenadas
- Resultado en Artesia: 180 columnas + 616 vigas (antes: 0 columnas, 796 "vigas")

**Bug 2 — `distribute_gravity_beams` acumulaba masa** (`packages/engine/src/engine/building/design/beam_check.py`)
- Función acumulaba masa top→down como columnas, pero vigas solo cargan su propio piso
- Fix: usar `w_floor_kN = mass_t * g` por piso, sin acumulación, sin `reversed(story_order)`
- Resultado: 172 NG, DCR 999 → 52 NG, DCR 1.00 (los 52 NG restantes son reales)

**Resultados finales Artesia_E23 (proyecto real NSR-10):**
- Columnas: **CUMPLE — 180 OK / 0 NG — DCR max 0.30**
- Vigas: **52 NG** (secciones 0.12×0.50m con DCR ≈ 1.001, ligeramente sobre capacidad)

**Nota nginx+Docker:** Al rebuildar api+worker, nginx cachea la IP antigua del contenedor API → 502 Bad Gateway. Fix inmediato: `docker compose -f docker-compose.prod.yml restart nginx`.

### F9–F11 completados (2026-08-20) — Diseño detallado con navigator + detalle por frame

**Engine (`packages/engine/src/engine/building/design/`)**
- `rebar_selector.py` → selector de barras NSR-10 #3-#11: columnas (posiciones, ρ, espaciado) + vigas (por cara)
- `column_designer.py` → ColumnDesigner: curva P-M analítica (30 puntos, φ variable), estribos DMO/DES/DES_ESP, checks normativas individuales, propuesta automática As
- `beam_designer.py` → BeamDesigner: classify_beam (primaria/secundaria), diseño por zonas (end_i/mid/end_j), checks NSR-10 C.18

**API (`apps/api/app/`)**
- `tasks/structural_design_task.py` → reescrito: genera BOTH design_columns_results.json (compat) y design_columns_detail.json (nuevo)
- `tasks/structural_beam_task.py` → reescrito: genera BOTH beam_design_results.json (compat) y beam_design_detail.json (nuevo)
- `routers/structural_design.py` → nuevo router: GET /design/frames, GET /design/frames/{id}, PUT /reinforcement, POST /verify
- `main.py` → structural_design registrado entre structural_analysis y structural_projects

**Frontend**
- `structural-types.ts` → +FrameListResult, FrameListItem, ColumnDesignDetail, BeamDesignDetail, ColumnReinforcementEdit, BeamReinforcementEdit, PMCurveData, ColumnCheck, BarPosition, etc.
- `structural-api.ts` → +structuralDesignApi: listFrames, getFrame, saveReinforcement, verifyFrame
- `FrameNavigator.tsx` → sidebar navigator: agrupado por piso, filtros tipo/status, búsqueda, StatusIcon
- `SectionSVG.tsx` → SVG de sección transversal: concreto, estribos, barras, dimensiones
- `ColumnDetailPanel.tsx` → 4 tabs: info/demands/section(+PMcurve)/checks; edición manual + verify/save
- `BeamDetailPanel.tsx` → 4 tabs: info/demands/reinforcement(+SVG diagrama momento)/checks; edición manual
- `projects/[id]/page.tsx` → Tab Diseño: CombinationSelector + fila compacta botones launch + navigator+detail layout (FrameNavigator 256px + detail panel flex-1). `onReinforcementSaved` → reload frameList + frameDetail

**Persistencia de refuerzo:** `reinforcement.json` por proyecto en `/results/`, separado de los detail JSONs (no requiere DB schema changes)

### Editor interactivo v2 (2026-08-31) — Menú contextual + filtros sección/material + tablas

**ModelEditorPanel.tsx** — reescrito completo con:
- `sectionFilter` + `materialFilter` → dropdowns en toolbar + resaltan activos en azul
- Filtros mutuamente excluyentes (seleccionar sección limpia material y viceversa)
- `triggerZoom()` → calcula bbox de selectedIds en modelData.joints → pasa `zoomBbox` al viewer
- `selectByMaterial()` → selecciona frames cuya sección usa ese material
- `ContextMenuPopup` component → aparece en clic derecho sobre viewport cuando hay selección
  - "Seleccionar similares": por tipo / sección / material / piso (con label del primer elemento)
  - "Aislar selección", "Zoom a selección", "Limpiar selección"
  - Se cierra al hacer clic fuera (mousedown capture)
- Panel de tablas (collapsible, 256px) con 3 tabs: Frames / Secciones / Materiales
  - Frames: columnas Label/Tipo/Piso/Sección/Estado, ordenamiento por cualquier columna, búsqueda, max 500 filas
  - Secciones: h×b, A, material, usos; clic → selectBySection()
  - Materiales: tipo, f'c/fy, E, secciones; clic → selectByMaterial()
  - Filas seleccionadas en 3D se resaltan en la tabla
  - Clic en fila → selecciona elemento en 3D
- Barra de estado muestra filtros activos (Piso/Secc./Mat.)

**LinearModelViewer3D.tsx** — ediciones quirúrgicas:
- `ViewerOptions`: +`sectionFilter`, +`materialFilter`
- `getFrameColor()`: si sectionFilter activo y fd.section ≠ filter → C_DIM; ídem material
- Props: +`sectionFilter`, +`materialFilter`, +`zoomBbox`
- useEffect zoom: cuando zoomBbox ≠ null → Plotly.relayout con axis ranges de la bbox + padding 40%
- Dep array render: +sectionFilter, +materialFilter, +modelSections

## Fases pendientes (post-core)
- Las 52 vigas NG (0.12×0.50m) son reales — Frank debe revisar si las secciones necesitan ajuste
- El polling de UI no siempre captura jobs que terminan muy rápido (<1s) — requiere F5 manual tras "Recalcular"
- Ampliar NSR-10 municipios (nsr10_data.py ~1100 municipios)
- Exportación modelo NL → Módulo 3 (F_NL — futuro)

## LinearOPSBuilder — notas clave
- Unidades: metros, kN, s → E en kN/m² = MPa × 1000
- CM node tags: 10_000_000 + idx (evita colisión con tags ETABS)
- geomTransf: cachedado por vecxz tuple, 2 transforms típicos (vertical/horizontal)
- rigidDiaphragm(3, cm_tag, *slaves) — perpDirn=3 → diafragma en plano XY
- Masa: solo Mx, My, Mrz en CM node; Mz=Mrx=Mry=0 (análisis horizontal)

## Modelo canónico (structural_model.json)
Formato JSON generado por F1/F2, almacenado en:
`uploads/structural/{project_id}/work/canonical/structural_model.json`

Claves: schema_version, stories, joints, frames, shells, sections, materials, restraints, diaphragms, masses, loads, analysis_results{modal, spectral, design, nonlinear_model}

## Tareas Celery (nombres)
- `app.tasks.structural_import_task.run_import` → F1
- `app.tasks.structural_modal_task.run_modal` → F4
- `app.tasks.structural_spectral_task.run_spectral` → F5

## Why arquitectura
- Independiente de Módulo 3 (tablas, routers, tasks propias)
- structural_analysis registrado ANTES de structural_projects en main.py (prefix más específico)
- validation_status en StructuralProject es denormalización conveniente para lista de proyectos
- prepare_work_dir usa subcarpeta `structural/` para no colisionar con Module 3 en disco
