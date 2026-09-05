---
name: Módulo 4 — Evaluación de Desempeño Sísmico (CSM)
description: Estado de implementación del Módulo 4 (Capacity Spectrum Method ATC-40 / NSR-10)
type: project
originSessionId: 9e349dd4-b384-40e0-8bcc-eee78421bb28
---
Implementación del Módulo 4 completada en sesión 2026-08-29. Evalúa desempeño sísmico de edificios por el Método del Espectro de Capacidad.

## Archivos creados/modificados

**Engine** (`packages/engine/src/engine/building/performance/`):
- `__init__.py` — exporta funciones principales
- `capacity_spectrum.py` — implementación completa CSM con dos bugs corregidos:
  1. **Import fix**: `from engine.seismic.spectrum import get_site_factors` (era `packages_engine_facade._fa_fv`)
  2. **B-factor fix**: `ratio = B(beta_eff) / B(5%)` luego `Sa_red = sa * ratio` (era `sa / B` — amplificaba en lugar de reducir)
  3. **Intersection fix**: `_intersect_adrs` busca transición cap < dem → cap ≥ dem (era: salía en el primer punto donde cap ≤ dem, i.e., el origen)

**API** (`apps/api/app/routers/building_performance.py`):
- Router `/api/v1/building/performance/evaluate` (POST, síncrono, sin Celery)
- Lee `soil_type` y `city` del proyecto; busca Aa/Av en MUNICIPIOS NSR-10
- Llama `evaluate()` del engine; serializa con `dataclasses.asdict()`
- Registrado en `apps/api/app/main.py`

**Frontend** (`apps/web/`):
- `src/lib/building-types.ts` — tipos `AdrsCurve`, `PerformancePoint`, `PerformanceLevel`, `PerformanceResult`
- `src/lib/building-api.ts` — `buildingPerformanceApi.evaluate()`
- `src/components/building/PerformanceChart.tsx` — gráfica Plotly ADRS (capacidad + demanda elástica + demanda reducida + bilineal + PP marker) + badge nivel de desempeño + métricas grid
- `src/app/building/[id]/page.tsx` — Paso 5 con toggle Dir X/Y + botón Evaluar

## Cómo funciona el CSM

1. `pushover_to_adrs()`: convierte pushover (drift%, V/W) a ADRS — Sa=V/W, Sd=δ_techo/γ (m), γ≈1
2. `demand_spectrum_adrs()`: genera espectro elástico NSR-10 en ADRS (Sd en metros, Sa en g)
3. `_bilinear_idealize()`: idealización bilineal de igual área; devuelve (Sy, dy, Su, du)
4. `find_performance_point()`: iteración CSM:
   - Suponer PP = último punto capacidad
   - Calcular β_eff con ATC-40 Ec. 8-14 (con factor κ por degradación)
   - Reducir demanda: ratio = B(β_eff)/B(5%), Sa_red = Sa_elastic × ratio
   - Encontrar nueva intersección; iterar hasta convergencia
5. `classify_performance()`: IO<0.7%, LS<2.5%, CP<5.0%, C≥5.0%

## Parámetros del endpoint

```json
POST /api/v1/building/performance/evaluate
{
  "project_id": "...",
  "direction": "X",
  "dtecho_pct": [...],      // de pushoverResult[dir].dtecho
  "vbasal_norm": [...],     // de pushoverResult[dir].vbasal_norm
  "total_height_m": 20.0,   // pushoverResult.story_heights[-1]
  "T1_s": 0.85              // modalResult.modes_table[0].T
}
```

## Estado
Implementación completa y funcionando. Necesita prueba end-to-end con datos reales de ETABS (archetype → modal → pushover → performance).

**Why:** Requisito del plan de producto PerformanceLabs (Módulo 4).
**How to apply:** Al continuar el sprint: probar con proyecto real, luego considerar rebuild Docker.
