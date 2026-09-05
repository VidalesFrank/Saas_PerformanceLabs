---
name: project-ground-motion-module
description: Estado del módulo de análisis de acelerogramas — bug real de formato PEER/NGA corregido (2026-09-05)
metadata: 
  node_type: memory
  type: project
  originSessionId: 01f0eb4f-257e-400c-9f99-6f0b131f931e
  modified: 2026-09-05T17:13:41.447Z
---

Estado al 2026-09-05: el usuario reportó que cargar un .txt real "no dio". Causa raíz
encontrada y corregida — ver detalle abajo. Estado previo (Fase 1+2, cerrado 2026-09-04):
engine Python + 13 rutas API + 10 componentes frontend (todo en español), 33 tests OK en
ese momento (ahora 44). Componentes clave: `apps/api/app/engine/ground_motion/` (units,
record, io/{detector,parser}, processing/{integration,baseline,filtering},
analysis/{intensity,frequency,spectra,inelastic_spectra}); `apps/web/src/app/ground-motion/`
+ `src/components/ground-motion/*` (ImportWizard, TimeHistoryPanel, IntensityPanel,
FrequencyPanel, SpectrumPanel, ProcessingPanel, InelasticSpectrumPanel).

## Bug real encontrado (2026-09-05): formato PEER/NGA no soportado

Los acelerogramas reales (PEER NGA-West2, FEMA P-695 — los 44 registros que el propio
proyecto usa para el Módulo 3, ver `apps/api/.env.example`) vienen en formato Fortran de
ancho fijo: **una sola serie de tiempo repartida en N valores por línea** (5, 6, 8...),
NO N canales paralelos. Dos problemas distintos, ambos corregidos:

1. **Números "pegados" sin espacio**: el signo negativo ocupa el espacio que separaría
   un valor positivo del anterior (ej. `...E-02-3.616...E-02`). `detector.py`/`parser.py`
   solo hacían `line.split()` por espacios → fusionaban dos números en un token inválido
   → filas/columnas totalmente descuadradas. Fix: tokenizador regex
   `_NUM_TOKEN_RE`/`_tokenize_numeric_line()` que extrae números individuales aunque
   estén pegados, aplicado tanto en la clasificación header-vs-datos
   (`_robust_numeric_token_count()`) como en el parseo final. Cuidado: la clasificación
   robusta SOLO se activa si la línea es puramente numérica en caracteres
   (`_NUMERIC_LINE_RE`) — si no, un header como "NPTS=500, DT=0.01" hace que la regex
   capture "500"/"0.01" como si fueran datos y rompe la extracción de metadata (regresión
   real que apareció y se corrigió en el mismo fix).

2. **Modelo conceptual faltante**: el wizard trataba cada columna detectada como un canal
   físico independiente (mapeo por columna). Para un archivo envuelto, eso da N series
   basura sub-muestreadas (cada una = cada N-ésima muestra real) en vez de LA serie
   continua. Fix: nuevo modo `flatten` end-to-end:
   - `detector.py`: `DetectedStructure.wrapped_series_hint` (heurística: ninguna columna
     monótona + todas oscilatorias + n_rows*n_cols ≈ NPTS del header) + warning sugiriendo
     activar el modo.
   - `parser.py`: `build_record(..., flatten=True)` → `_build_record_flattened()`
     concatena todas las columnas activas (misma quantity/unit, sin columna de tiempo)
     en orden fila-mayor → reconstruye la serie real. Verificado exacto (diff ~1e-8)
     contra la señal de referencia.
   - `routers/ground_motion.py`: `CreateRecordRequest.flatten`, expuesto en `/detect`.
   - `ImportWizard.tsx`: checkbox "serie continua envuelta" auto-marcado cuando
     `wrapped_series_hint` es true; `effectiveNSamples()` corrige el conteo de muestras
     mostrado (n_rows×n_cols, no n_rows) cuando flatten está activo.
   - Tests: `TestPeerWrappedFormat` en `test_ground_motion_engine.py` (5 tests, fixture
     `peer_wrapped_content()`/`peer_acc_truth()` con números pegados reales).

Verificado end-to-end: servidor real levantado, registro creado vía API con
`flatten=true`, pipeline completo (timeseries, intensity, fft, spectrum, baseline,
inelastic-spectrum) corrido sobre el registro reconstruido — todo correcto.

**Why:** el usuario (ingeniero estructural/sísmico) siempre va a cargar archivos reales
en formato PEER/NGA — es el estándar de facto del campo. Sin el modo `flatten`, el
importador silenciosamente corrompía cualquier archivo real de más de 1 valor por línea.
**How to apply:** al tocar detector.py/parser.py, correr
`apps/api/tests/test_ground_motion_engine.py` (44 tests) — cualquier cambio a la
tokenización debe mantener `TestPeerWrappedFormat` en verde. Si se agrega un nuevo campo
a `ColumnMapping`/`CreateRecordRequest`, revisar también `_build_record_flattened()`.

## Nota de entorno (no relacionada, encontrada en el camino)

En Windows nativo (fuera de Docker), `openseespywin` (dependencia de `openseespy`) trae
un wheel mal etiquetado `py3-none-any` pero el `.pyd` interno solo funciona con
**Python 3.12** (requiere `python312.dll`) — con un venv en Python 3.11 (la versión que
sí usa el Dockerfile, `python:3.11-slim`, vía `openseespylinux` que sí está bien
empaquetado) la API completa falla al arrancar (`RuntimeError: Failed to import
openseespy on Windows`), porque `app/main.py` importa `sections.py` a nivel de módulo y
esta importa OpenSees. Si `.venv` se recrea en una máquina nueva y algo "no arranca nada"
(no solo ground-motion), verificar primero con `python --version` que el venv se creó con
3.12, no 3.11. Detalle completo en [[env-openseespy-windows-python312]].
