---
name: Estado de la plataforma — 2026-08-31
description: Snapshot del sprint 2026-08-31: todo el trabajo pendiente de commit/deploy, y próximos pasos del Model Builder interactivo
type: project
originSessionId: 7c17022a-d915-4142-95ac-66b450dedcb8
---
## Estado del repositorio

**Último commit:** `2128441` — "Módulo 1: Constructor de Modelos + análisis modal/espectral NSR-10"

**TODO el trabajo posterior está sin commitear.** Tres sesiones de trabajo en staging:

### Sesión 2026-08-15 a 2026-08-20 — F7–F11 diseño estructural
- `packages/engine/src/engine/building/design/` → combinations.py, column_check.py, beam_check.py, rebar_selector.py, column_designer.py, beam_designer.py
- `apps/api/app/tasks/` → structural_design_task.py, structural_beam_task.py (reescritos)
- `apps/api/app/routers/structural_design.py` (nuevo)
- `apps/api/alembic/versions/c7d4e2f1a8b5_add_design_columns_analysis_type.py` (nuevo)
- `apps/api/alembic/versions/d8e3f4a2b1c6_add_design_beams_analysis_type.py` (nuevo)
- Frontend: CombinationSelector, ColumnDesignResults, BeamDesignResults, FrameNavigator, ColumnDetailPanel, BeamDetailPanel, SectionSVG
- Bugs críticos corregidos: model_builder.py (clasificación geométrica columnas/vigas) + beam_check.py (gravedad sin acumulación)

### Sesión 2026-08-29 — Módulo 4 CSM Performance
- `packages/engine/src/engine/building/performance/capacity_spectrum.py` (nuevo)
- `apps/api/app/routers/building_performance.py` (nuevo)
- `apps/web/src/components/building/PerformanceChart.tsx` (nuevo)
- Integrado en building/[id]/page.tsx Step 5

### Sesión 2026-08-31 — Model Builder interactivo v1+v2
- `apps/api/app/routers/structural_editor.py` (nuevo) — CRUD secciones/materiales, assign frames, model-data, model-check
- `apps/web/src/components/linear/ModelEditorPanel.tsx` — reescrito completo
- `apps/web/src/components/linear/ModelPropertiesPanel.tsx`, ModelSectionsPanel, ModelMaterialsPanel, ModelHealthPanel (nuevos)
- `apps/web/src/components/linear/LinearModelViewer3D.tsx` — +sectionFilter, +materialFilter, +zoomBbox

## Para deployar mañana

```powershell
docker compose -f docker-compose.prod.yml build api worker web
docker compose -f docker-compose.prod.yml up -d api worker web
docker compose -f docker-compose.prod.yml restart nginx
```

Las migraciones Alembic (design_columns + design_beams) se aplican automáticamente via entrypoint.sh.
Después del rebuild: Ctrl+Shift+R en el navegador.

## Lo que funciona en el editor interactivo (criterios del prompt)

✅ #1–13: importar, visualizar, seleccionar, inspector, cambiar sección, multi-selección, asignar, gestión secciones/materiales
✅ #15: Ocultar/aislar elementos
✅ #17: Model Check (health panel)
✅ #18: Identificar problemas gráficamente (select desde health panel)
✅ #19: Guardar modelo (canonical JSON)
✅ Hover tooltip (Plotly hovertemplate con section/story/type/id)
✅ Filtro por sección en viewer (dimming de no-matching)
✅ Filtro por material en viewer (dimming)
✅ Menú contextual clic derecho → Select Similar (tipo/sección/material/piso), Aislar, Zoom, Limpiar
✅ Panel de tablas: Frames (orderable, búsqueda, sync 3D), Secciones, Materiales
✅ Zoom a selección via Plotly.relayout con bounding box
✅ #20: OpenSees consume el canonical JSON modificado (structural_import_task lee del mismo archivo)

❌ Pendiente:
- #14: Visualización de cargas importadas (load arrows en viewport)
- Verificación end-to-end Módulo 4 CSM con datos reales
- Rebuild Docker y prueba producción

## Próximos pasos sugeridos (orden de impacto)

1. **Rebuild Docker + prueba end-to-end** del flujo completo Artesia_E23:
   importar → modal → espectral → diseño columnas/vigas → CSM performance
2. **Visualización de cargas** (#14 del prompt):
   - Backend: endpoint `/{project_id}/model-loads` → retorna load_patterns + cargas por frame
   - Frontend: toggle "Cargas" en toolbar + selector de patrón + flechas escaladas en viewport
3. **Sincronización tabla ↔ 3D bidireccional mejorada**:
   - Actualmente: clic en tabla → selecciona en 3D ✅
   - Falta: cuando selección cambia en 3D → scroll automático al row en tabla
4. **Tooltip hover mejorado** en viewport: el hovertemplate actual muestra section/story/type pero NO el material. Agregar material al customdata del hovertemplate
5. **Commit de todo el trabajo acumulado** con mensaje descriptivo

## Arquitectura del Model Builder (para continuar)

El prompt original define la evolución hacia STRUCTURAL MODEL BUILDER / PREPROCESSOR.
Las fases completadas:
- Fase 0 (Auditoría) ✅
- Fase 1 (Modelo canónico) ✅ — structural_model.json como single source of truth
- Fase 2 (Interacción gráfica) ✅ — selección, hover, inspector, filtros, aislamiento
- Fase 3 (Edición) ✅ — asignar secciones/materiales, multi-edit, undo/redo, persistencia
- Fase 4 (Validación) ✅ — model health check con errores/advertencias
- Fase 5 (Cargas) ❌ — visualización + inspección de cargas importadas

**Why:** Frank quiere que ETABS sea una fuente de datos más, no el destino. El canonical JSON (structural_model.json) es la capa intermedia. El editor gráfico modifica ese JSON. El generador de OpenSees lo lee.
**How to apply:** Al continuar: no romper el flujo importación→canonical→OpenSees. Agregar cargas al canonical si aún no están, exponer via API, visualizar en viewer.
