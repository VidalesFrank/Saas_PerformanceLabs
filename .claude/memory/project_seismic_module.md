---
name: Módulo Espectros NSR-10
description: Estado y detalles del módulo generador de espectros sísmicos NSR-10 en PerformanceLabs
type: project
originSessionId: a57ed6ee-e8fa-4f61-9646-6dcac3856f22
---
Módulo de espectros NSR-10 implementado en la rama master. Ruta: /seismic.

**Por qué:** Frank (ingeniero estructural) necesitaba un generador de espectros elásticos de diseño según NSR-10 con mapa interactivo de Colombia y exportación de resultados.

**Archivos clave:**
- `packages/engine/src/engine/seismic/nsr10_data.py` — base de datos de ~100 municipios colombianos con Aa, Av, lat/lon + tablas Fa/Fv
- `packages/engine/src/engine/seismic/spectrum.py` — funciones: get_site_factors, spectral_parameters, compute_spectrum (Sa/Sd/Sv)
- `packages/engine/tests/test_seismic.py` — tests con caso Bogotá suelo D
- `apps/api/app/routers/seismic.py` — 3 endpoints: GET /municipios, GET /municipios/all, GET /soil-types, POST /espectro
- `apps/web/src/app/seismic/page.tsx` — página principal con mapa + gráficas
- `apps/web/src/components/seismic/SeismicMap.tsx` — mapa Leaflet (dynamic import, no SSR)
- `apps/web/src/components/seismic/SpectrumChart.tsx` — gráficas SVG Sa/Sd/Sv
- `apps/web/src/lib/seismic-types.ts` — tipos TypeScript

**Decisiones tomadas:**
- Solo espectro elástico (sin reducción por R)
- Mapa a nivel de municipio (puntos circulares coloreados por zona, sin GeoJSON de polígonos)
- Exportación CSV (client-side Blob) y PDF (jsPDF + html2canvas)
- Paquetes npm instalados: leaflet, react-leaflet, @types/leaflet, jspdf, html2canvas
- Sin auth requerida para endpoints de municipios (públicos); espectro sí requiere login

**Pendiente:**
- Ampliar base de datos de municipios con la Tabla A.2.3-1 completa del NSR-10 (~1100 municipios)
- Para el mapa de polígonos: cargar GeoJSON de municipios de DANE/IGAC en /public/
- Considerar añadir espectro reducido (con R/Cd) como segunda fase

**How to apply:** Cuando Frank quiera ampliar la base de datos de municipios, dirigirlo a nsr10_data.py. Si quiere agregar polígonos al mapa, necesita un GeoJSON de municipios colombianos en apps/web/public/.
