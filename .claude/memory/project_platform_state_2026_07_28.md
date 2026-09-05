---
name: Estado completo de la plataforma — 2026-07-29
description: Snapshot actualizado al 29-07-2026 con módulos activos, editor de secciones, Docker y pendientes
type: project
originSessionId: 8fb8c26f-2f75-47e5-bd03-c4572d7b8138
---
## Módulos completamente funcionales

### `/seismic` — Generador de Espectros NSR-10
- Engine: `packages/engine/src/engine/seismic/spectrum.py` + `nsr10_data.py`
- API: `apps/api/app/routers/seismic.py`
- Frontend: mapa Leaflet, gráficas SVG Sa/Sd/Sv, CSV + PDF export
- Estado: **listo en producción**

### `/sections` — Editor de Secciones (Módulo 2 v2) ← NUEVO MÓDULO COMPLETO
Ver memoria dedicada `project_section_editor_module.md`.

### `/analysis/interaction`, `/analysis/moment-curvature`, `/analysis/pmm`
Rutas legacy (sin editor). El módulo `/sections` las reemplaza.

### `/building` — Análisis No Lineal 3D (Módulo 3)
- Arquetipo → Modal → Pushover (X+Y con os.fork) → Dinámico/IDA
- `dtecho` en JSON de pushover ya viene en % — NO multiplicar ×100 en frontend
- Estado: engine y API completos; pendiente probar end-to-end en producción

## Docker producción (`docker-compose.prod.yml`)

Servicios: postgres:16, redis:7, api, worker (Celery), web (Next.js standalone), nginx (puerto 7000)

**Bug conocido corregido (2026-07-29)**: el healthcheck de postgres usaba `pg_isready -U plabs` sin `-d`, lo que intentaba conectar a DB `plabs` (inexistente) en lugar de `performancelabs`. Corregido a:
```yaml
test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-plabs} -d ${POSTGRES_DB:-performancelabs}"]
```
Si los contenedores no arrancan por la DB, correr `docker compose ... down -v && up -d`.

**Why**: Python 3.11-slim en container. `os.fork()` en pushover porque OpenSees no es thread-safe. opstool parcheado con `patch_opstool.py` en build time.

## Pendientes inmediatos

1. **Sprint 10**: Reporte PDF real de sección (jsPDF, no window.print — portada + materiales + P-M + M-φ + PMM en un doc)
2. **Sprint 11**: Cotas en canvas del editor (dimensiones overlay sobre región seleccionada)
3. **Sprint 12**: Exportar PNG del canvas
4. **Ampliar `nsr10_data.py`** con ~1100 municipios completos de Tabla A.2.3-1
5. **Probar flujo completo Módulo 3** en producción tras rebuild
6. **Frank quiere dar feedback** sobre el diseño del dashboard antes de más cambios ahí
