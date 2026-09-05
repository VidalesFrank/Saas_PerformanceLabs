---
name: Módulo Editor de Secciones — /sections
description: Estado completo del editor de secciones transversales (Módulo 2 v2): sprints completados, arquitectura, archivos clave y pendientes
type: project
originSessionId: 8fb8c26f-2f75-47e5-bd03-c4572d7b8138
---
## Ruta y propósito
`/sections` — Biblioteca y editor de secciones de concreto reforzado. Sección = documento con regiones (geometría) + barras (acero) + defs de materiales. Permite diseñar, editar y analizar secciones directamente.

## Sprints completados (al 2026-07-29)

| Sprint | Feature | Archivos clave |
|--------|---------|---------------|
| 1-3 | CRUD secciones, editor canvas SVG, toolbar, capas, propiedades | `editor/page.tsx`, `EditorCanvas.tsx`, `LayersPanel.tsx`, `PropertiesPanel.tsx` |
| 4 | MaterialsDialog (CRUD f'c y fy), botón Materiales, Ctrl+D duplicar | `MaterialsDialog.tsx` |
| 5-7 | Biblioteca con thumbnails SVG, búsqueda, 6 nuevas plantillas (pilas, huecos, anulares) | `SectionThumbnail.tsx`, `section-templates.ts`, `sections/page.tsx` |
| 5-7 | Análisis completo: P-M con θ, M-φ multi-curva overlay, PMM biaxial con tabla DCR | `analyze/page.tsx`, `pmm-chart.tsx`, `interaction-chart.tsx` |
| 5-7 | PDF export via `window.print()` + CSV download | `analyze/page.tsx` |
| 8 | **Box selection** con rubber-band, **menú contextual** clic derecho (Duplicar/Mover/Eliminar), **drag-to-move** | `EditorCanvas.tsx`, `editor-state.ts` |
| 8 | **Ángulo θ** para P-M y M-φ (0°=eje fuerte, 90°=eje débil), rotación de fibras en engine | `interaction.py`, `moment_curvature.py`, `editor-api.ts` |
| 9 | **Tema claro/oscuro** global (sun/moon toggle), persiste en localStorage | `theme.ts`, `ThemeToggle.tsx`, `app-header.tsx`, `EditorCanvas.tsx` |
| 10 | **Verificación NSR-10** por tipo de elemento (Columna/Viga/Muro) y ductilidad (DMI/DMO/DES) | `nsr10_check.py`, `section_editor.py`, `analyze/page.tsx` |

## Archivos del engine

- `packages/engine/src/engine/sections/compiler.py` — `compile_doc()` → `CompiledFiberSection`
- `packages/engine/src/engine/sections/nsr10_check.py` — `compute_nsr10_check()` con checks por elemento/ductilidad
- `packages/engine/src/engine/analysis/interaction.py` — P-M con θ, KrylovNewton fallback, filtro M=0
- `packages/engine/src/engine/analysis/moment_curvature.py` — M-φ con θ
- `packages/engine/src/engine/analysis/pmm_surface.py` — superficie P-M-M biaxial, simetría quad

## Archivos API

- `apps/api/app/routers/section_editor.py` — todos los endpoints: CRUD + interaction + moment-curvature + pmm-surface + nsr10-check
- Endpoint NSR-10: `POST /{id}/nsr10-check` body `{element_type, ductility}` → `{summary, checks[]}`

## Archivos frontend clave

- `apps/web/src/app/sections/page.tsx` — biblioteca con search + thumbnails
- `apps/web/src/app/sections/[id]/editor/page.tsx` — editor completo con ThemeToggle
- `apps/web/src/app/sections/[id]/analyze/page.tsx` — 4 tabs: P-M, M-φ, P-M-M, NSR-10
- `apps/web/src/components/section-editor/EditorCanvas.tsx` — SVG canvas con paletas DARK_C / LIGHT_C
- `apps/web/src/lib/theme.ts` — `useTheme()` hook con custom event `pl-theme-change`
- `apps/web/src/lib/editor-api.ts` — `sectionEditorApi` con todos los métodos incluyendo `.nsr10()`
- `apps/web/src/lib/editor-state.ts` — reducer con Selection `{kind: "multi"}`, `MOVE_SELECTION`, `DELETE_SELECTION`

## Bugs importantes corregidos

- **P-M zigzag**: `_moment_curvature_max` devolvía M=0 en fallo de convergencia → se filtra en `compute_interaction_diagram` + KrylovNewton como 3er algoritmo fallback + `num_incr=120`
- **PMM dimples**: mismo fix en `_mc_max` y `compute_pmm_surface` (filtrar M=0 interior)

## Pendientes del módulo

- Sprint 10: Reporte PDF real (jsPDF — portada, tabla materiales, P-M + M-φ + PMM en un PDF)
- Sprint 11: Cotas overlay en canvas (dimensiones de región seleccionada)
- Sprint 12: Exportar PNG del canvas

## Why arquitectura

- `preview` en `_row_summary` del API: geometría compacta (shape+is_void por región, y/z/bar_size por barra) para `SectionThumbnail` sin cargar el documento completo
- Los colores del canvas son hardcoded (no CSS vars) porque el SVG renderiza en transform group; se usan `DARK_C`/`LIGHT_C` constantes seleccionadas por `useTheme()`
- Box selection usa `useState` local en EditorCanvas (no reducer) para no contaminar el historial undo con posiciones intermedias del arrastre
