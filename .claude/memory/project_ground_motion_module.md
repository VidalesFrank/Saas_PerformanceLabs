---
name: Módulo Ground Motion Analysis
description: Estado completo del módulo de análisis de acelerogramas (2026-09-04): engine Python, API, frontend, tests
type: project
originSessionId: 3670d197-cb59-49d6-9c57-674c30efaea6
---
Estado al 2026-09-04: **Fase 1 + Fase 2 (espectros inelásticos) completas**.

## Archivos backend (engine)

- `apps/api/app/engine/ground_motion/units.py` — conversiones SI, G_STD=9.80665
- `apps/api/app/engine/ground_motion/record.py` — GroundMotionRecord, SignalChannel, ProcessingStep
- `apps/api/app/engine/ground_motion/io/detector.py` — detect_structure(), sin asumir Δt silenciosamente
- `apps/api/app/engine/ground_motion/io/parser.py` — build_record(), ColumnMapping
- `apps/api/app/engine/ground_motion/processing/integration.py` — integrate_trapz_vec (formula: dt*(cumsum - 0.5*(signal[0]+signal)))
- `apps/api/app/engine/ground_motion/processing/baseline.py` — remove_mean/linear/polynomial
- `apps/api/app/engine/ground_motion/processing/filtering.py` — butterworth_filter con sosfiltfilt (scipy requerido)
- `apps/api/app/engine/ground_motion/analysis/intensity.py` — PGA, Arias, CAV, D5-95, RMS; usa _trapz() propio (compatible numpy 1.x/2.x)
- `apps/api/app/engine/ground_motion/analysis/frequency.py` — FFT + PSD Welch
- `apps/api/app/engine/ground_motion/analysis/spectra.py` — Newmark-β (β=0.25, γ=0.5), k_eff=m+γ·dt·c+β·dt²·k (forma directa)
- `apps/api/app/engine/ground_motion/analysis/inelastic_spectra.py` — EPP SDOF bisección, espectros ductilidad constante

## Bugs corregidos

1. **integrate_trapz_vec**: fórmula incorrecta → corregida a `dt*(cumsum - 0.5*(signal[0]+signal))`
2. **np.trapz removido en numpy 2.x**: reemplazado con `_trapz()` propio en intensity.py
3. **k_eff Newmark**: forma incremental → corregida a forma directa predictor-corrector
4. **scipy no instalado**: agregado a requirements.txt como `scipy>=1.11`
5. **AppHeader default export**: corregido a named import `{ AppHeader }`
6. **ground-motion-api.ts URL relativa**: `BASE = '/api/v1/ground-motion'` → `BASE = \`${API_URL}/api/v1/ground-motion\`` (BUG CRÍTICO — causaba que todos los fetch fueran al Next.js server en lugar del backend FastAPI)

## API

- `apps/api/app/routers/ground_motion.py` — 13 rutas en /api/v1/ground-motion + endpoint inelastic-spectrum
- `apps/api/alembic/versions/a1b2c3d4e5f6_add_ground_motion_tables.py` — tablas gm_records, gm_jobs
- `apps/api/alembic/versions/b0c1d2e3f4a5_merge_wall_demands_and_ground_motion.py` — merge de dos branches alembic

## Frontend (todo en español)

- `apps/web/src/lib/ground-motion-types.ts` — tipos TypeScript
- `apps/web/src/lib/ground-motion-api.ts` — funciones API (CORREGIDO: usa API_URL)
- `apps/web/src/app/ground-motion/page.tsx` — lista de registros + wizard (español)
- `apps/web/src/app/ground-motion/[id]/page.tsx` — detalle con 7 tabs (español)
- `apps/web/src/components/ground-motion/ImportWizard.tsx` — 4 pasos (español)
- `apps/web/src/components/ground-motion/TimeHistoryPanel.tsx` — a, v, d (español)
- `apps/web/src/components/ground-motion/IntensityPanel.tsx` — PGA, Arias, CAV, D5-95 (español)
- `apps/web/src/components/ground-motion/FrequencyPanel.tsx` — FFT + PSD Welch (español)
- `apps/web/src/components/ground-motion/SpectrumPanel.tsx` — espectro multi-xi (español)
- `apps/web/src/components/ground-motion/ProcessingPanel.tsx` — baseline + filtrado (español)
- `apps/web/src/components/ground-motion/InelasticSpectrumPanel.tsx` — espectros EPP (español)

## Tests

33/33 pasan: `apps/api/tests/test_ground_motion_engine.py`

## Estado de pendientes

- Migración alembic: aplicada ✅
- Tests: 33/33 ✅
- TypeScript: 0 errores ✅
- UI en español: ✅ (completado 2026-09-04)
- Bug importación TXT: ✅ corregido (URL relativa → absoluta en ground-motion-api.ts)
- Docker rebuild: pendiente (necesario para producción)

**Why:** Módulo independiente de análisis sísmico profesional integrado al SaaS.
**How to apply:** Al modificar el motor, correr tests primero. Newmark usa forma directa (no incremental). La API siempre usa API_URL env var (NEXT_PUBLIC_API_URL o http://localhost:8000).
