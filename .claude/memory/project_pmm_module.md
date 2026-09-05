---
name: Módulo Interacción Biaxial P-M-M
description: Estado del módulo de superficie de interacción biaxial P-M-M en PerformanceLabs
type: project
originSessionId: ded97351-3fe0-457a-8711-c2ef5a21deba
---
Módulo P-M-M implementado en master (sin commit aún). Ruta: /analysis/pmm.

**Por qué:** Extiende el diagrama P-M uniaxial al caso biaxial completo, necesario para columnas con demandas combinadas Mx+My.

**Archivos clave:**
- `packages/engine/src/engine/analysis/pmm_surface.py` — motor: discretiza patches→fibras, rota por ángulo theta, calcula P-M por ángulo. Optimización: sección rectangular/cuadrada solo calcula Q1 [0..90°] y espeja a los 4 cuadrantes (~75% menos cómputo). Circular: 1 ángulo replicado.
- `apps/api/app/routers/sections.py` — endpoint POST `/{section_id}/pmm-surface`
- `apps/api/app/schemas.py` — PMMSurfaceRequest, PMMSurfaceResultOut, PMMArcOut, PMMDemandOut
- `apps/web/src/app/analysis/pmm/page.tsx` — página principal (mismo formulario que P-M)
- `apps/web/src/components/pmm-chart.tsx` — dos gráficas SVG: PMMEnvelopeChart (P vs M_resultante) y MxMyPanel (sección Mx-My interactiva con slider de P)
- `apps/web/src/lib/types.ts` — tipos TypeScript para PMM

**Decisiones técnicas:**
- Rotación de fibras: y'=y·cos(θ)+z·sin(θ) para rotar el eje neutro
- Discretización de patches (rect/circ) a fibras individuales para permitir rotación
- DCR = M_demand/M_capacity(Pu, θ_demand) interpolando biliinearmente la superficie
- Cálculo síncrono (sin Celery) — estimado 30-90s para sección rectangular con 8 ángulos
- Convención: Mx = momento eje fuerte (bending en h), My = momento eje débil (bending en b)
- θ=0 da la misma curva P-M que el módulo existente de diagrama de interacción

**Pendiente:**
- Reducción por φ (factor de resistencia) en el contorno Mx-My
- Opción de exportar PDF/CSV de la superficie
- Posible paralelización con ProcessPoolExecutor para reducir tiempo de cómputo
- Test unitario en packages/engine/tests/ para verificar simetría y valores extremos

**How to apply:** El eje de coordenadas de la sección: y=vertical (altura h), z=horizontal (ancho b). Al agregar nuevas formas al motor, seguir el mismo patrón de discretización en _section_to_fibers.
