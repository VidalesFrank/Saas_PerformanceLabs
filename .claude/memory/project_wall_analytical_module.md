---
name: Módulo Muros — WallAnalyticalModel con E-SFI-MVLEM-3D
description: Arquitectura E-SFI-MVLEM-3D y otras formulaciones de muros en el Constructor de Modelos (2026-09-01)
type: project
originSessionId: 37c61624-f184-4982-8578-247566781e91
---
Implementación de modelos analíticos de muros con soporte para tres formulaciones OpenSees.

**Why:** Frank necesita modelos 3D no lineales de edificios de muros con interacción axial-flexión-cortante. E-SFI-MVLEM-3D es la formulación eficiente recomendada para buildings 3D completos.

**How to apply:** Al trabajar con muros del Constructor de Modelos, la arquitectura está en `apps/api/app/engine/building/walls/`. Los endpoints API están en `apps/api/app/routers/wall_analytical.py`. Los componentes UI en `apps/web/src/components/linear/Walls*.tsx` y `Macrofiber*.tsx`.

## Archivos creados

### Engine Python (`apps/api/app/engine/building/walls/`)
- `__init__.py` — exports públicos del módulo
- `analytical_model.py` — jerarquía: `WallAnalyticalModel` base + `MVLEM3DModel` + `SFIMVLEM3DModel` + `ESFIMVLEM3DModel`. Factory `create_wall_model()`. `ESFIMVLEM3DModel.from_physical_wall()` construye desde zonas físicas.
- `macrofiber.py` — `MacroFiber` dataclass, `MacroFiberRegion` enum, `BoundaryZone`, `WebZone`, `AutoDiscretization` (respeta límites boundary/web, sin fibras que crucen zonas)
- `rc_panel_material.py` — `ConcreteMaterialDef`, `SteelMaterialDef`, `FSAMParams`, `RCPanelMaterial` con `cache_key` determinista para deduplicación
- `material_registry.py` — `MaterialRegistry`: asigna tags OpenSees secuencialmente, deduplica por cache_key. Ejemplo: 8 fibras con boundaries → sólo 5 tags únicos
- `ops_generator.py` — `WallOpsGenerator`: genera exactamente el mismo comando para Preview y análisis real. Soporta las 3 formulaciones.
- `validator.py` — `WallAnalyticalValidator`: 23+ checks (nodos, geometría, materiales, ancho total, RC panel para SFI/E-SFI)

### API (`apps/api/app/routers/wall_analytical.py`)
Endpoints bajo `/api/v1/projects/{project_id}/walls/`:
- `GET  /` — lista todos los muros con estado analítico
- `GET  /{label}` — detalle de un muro
- `GET  /settings` / `PUT /settings` — configuración global (formulation default)
- `POST /{label}/auto-discretize` — discretización automática desde zonas físicas
- `PUT  /{label}` — guardar modelo analítico
- `DELETE /{label}/analytical` — resetear a sin configurar
- `GET  /{label}/validate` — validación con 23+ checks
- `GET  /{label}/preview-ops` — comando OpenSeesPy (mismo generador que análisis)
- `POST /bulk-assign` — asignar formulación a múltiples muros
- `GET  /health` — salud del modelo completo (total/configured/incomplete/invalid)

### Frontend
- `apps/web/src/lib/wall-types.ts` — tipos TypeScript completos
- `apps/web/src/lib/wall-api.ts` — cliente API con autenticación JWT
- `apps/web/src/components/linear/WallFormulationSelector.tsx` — selector de formulación con cards descriptivas
- `apps/web/src/components/linear/MacrofiberPreview.tsx` — visualización gráfica de macrofibras (barras proporcionales coloreadas por región)
- `apps/web/src/components/linear/MacrofiberDetailPanel.tsx` — detalle de fibra individual con badges DEFAULT/USER DEFINED/MISSING
- `apps/web/src/components/linear/WallAnalyticalPanel.tsx` — panel principal (5 tabs: Formulation, Discretization, Parameters, Validate, OpenSeesPy)
- `apps/web/src/components/linear/WallsPanel.tsx` — lista de muros con filtros, health summary, bulk assign

## Arquitectura de datos

El modelo analítico se guarda en `canonical_model.json` bajo `model["wall_analytical"][shell_label]`. El modelo físico (geometría ETABS, secciones) queda en `model["shells"]` sin modificar.

## Flujo E-SFI-MVLEM-3D

```
ConcreteDef + SteelDef → RCPanelMaterial (FSAM) → MaterialRegistry (deduplicado)
BoundaryZone + WebZone → AutoDiscretization → MacroFibers
4 nodos ETABS + MacroFibers + Registry → WallOpsGenerator
→ ops.element('E_SFI_MVLEM_3D', eleTag, ni, nj, nk, nl, m, -thick, -width, -mat, -CoR, -ThickMod, -Poisson, -Density)
```

## Integración en página del proyecto (2026-09-01)

`WallsPanel` integrado como tab "Muros" en `/projects/[id]/page.tsx`:
- Tab visible cuando modelo está validado (`isValidated`)
- `fullModelData` cargado lazily (useEffect) al entrar al tab "walls"
- `materials` = `Object.keys(fullModelData.materials)` — nombres de materiales concreto del proyecto
- `steelTypes` = `["G420", "G60", "PDR60", "A60", "A615Gr60"]` — lista predeterminada NSR-10

**Corrección crítica de rutas FastAPI**: `/walls/health` y `/walls/bulk-assign` deben declararse ANTES de `/walls/{wall_label}` para evitar que FastAPI capture "health"/"bulk-assign" como wall_label. Orden final: settings → health → bulk-assign → {wall_label} → {wall_label}/sub-endpoints.

## Fixes aplicados en sesión 2026-09-01 (parte 2)

### LinearModelViewer3D.tsx
- `parseSectionDims` corregido: patrón AxB siempre divide /100 (cm→m); número solo requiere ≥10 para /100; "C1" → default {b:0.3, h:0.3}
- `getFrameColor` añadido `isExtruded=false` param: mode "type" en extruido usa `C_COL_EXT`/`C_BM_EXT` en vez de line colors
- `mesh3d` usa `hovertemplate:"<extra></extra>"` + `showscale:false` en vez de `hoverinfo:"skip"`
- ResizeObserver añadido: observa `el.parentElement` y llama `Plotly.Plots.resize(el)` al detectar cambios

### Nuevas tabs en /projects/[id]
- `TabId` ampliado: `"materiales" | "secciones"` añadidos entre "design" y "walls"
- `buildTabs()` añade "Materiales" y "Secciones" (requieren modelo validado)
- `fullModelData` carga lazy también con "materiales" y "secciones"
- `handleModelDataChange()` helper para recargar fullModelData tras CRUD

### ModelMaterialsPanel.tsx
- Componente `ConstitutiveCurve` SVG: parabólica Mander (concreto) y bilineal (acero)
- Estado `selectedMatName`: clic en fila de lista expande la curva constitutiva inline
- Layout: área + info paramétrica bajo la curva (ε₀, εcu, Ec, εy, eu)

### ModelSectionsPanel.tsx
- `SectionPreviewSVG`: rectángulo con dimensión b/h anotada + puntos de barras de esquina + recubrimiento
- `SectionMiniThumb`: thumbnail 32×24px proporcional en cada fila de la lista
- Formulario: preview visual integrado junto a las propiedades calculadas (A, I₃₃, I₂₂, r₃₃, S₃₃)

## Pendientes

- Implementar `Show Local Axes` en visualizador 3D (punto 15 del spec)
- Conectar piers ETABS al auto-populate de WallAnalyticalPanel
- Postproceso: recorders globalForce, Curvature, ShearDef, RCPanel (punto 26 del spec)
