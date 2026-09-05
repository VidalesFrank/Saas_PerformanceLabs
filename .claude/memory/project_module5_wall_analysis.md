---
name: Módulo 5 — Análisis de Muros RC 3D (Phase 1 backend)
description: Estado del módulo de muros RC 3D independiente basado en E-SFI-MVLEM-3D / MVLEM_3D. Phase 1 backend completo.
type: project
originSessionId: d1868229-34b6-4263-a6b0-7c22f7a13c4b
---
Módulo 5 — Análisis de Muros RC 3D en PerformanceLabs. Inspirado en RCW-3D pero completamente independiente.

**Why:** Frank quiere integrar las mejores piezas de RCW-3D como módulo separado en la plataforma. Independiente de Módulo 1 (no requiere proyecto ETABS).

## Phase 1 — Backend (completada 2026-09-02)

### Nuevos archivos

| Archivo | Descripción |
|---------|-------------|
| `apps/api/app/engine/building/walls/material_presets.py` | Port de RCW-3D: ConcreteCM, Concrete02, Hysteretic, HystereticSM, Elastic |
| `apps/api/app/routers/wall_projects.py` | Router CRUD + presets + script export |
| `apps/api/app/tasks/wall_analysis_task.py` | Celery skeleton (gravity, modal, pushover) |
| `apps/api/alembic/versions/e5f2a3b4c1d0_add_wall_projects_module5.py` | Migración tablas wall_projects + wall_jobs |

### Archivos modificados

- `models.py` — WallProject + WallJob + WallProjectStatus + WallJobType + WallJobStatus
- `engine/building/walls/__init__.py` — exports de material_presets
- `catalog.py` — Módulo 5 con 4 productos, route `/wall-projects`
- `main.py` — registro router + cleanup orphaned WallJobs al startup
- `tasks/celery_app.py` — wall_analysis_task en includes + time_limits

### Endpoints disponibles (prefix /api/v1/wall-projects)

```
GET  /presets/materials              — catálogo default (ConcreteCM 28 + bars + WWM)
GET  /presets/materials/all          — 8 presets ConcreteCM + 2 barras + WWM
POST /presets/mvlem-basic-set        — genera Concrete02 + HystereticSM vía opseestools
GET  /                               — listar proyectos
POST /                               — crear proyecto (inicia con documento default)
GET  /{id}                           — obtener proyecto
DELETE /{id}                         — eliminar proyecto + archivos
GET  /{id}/document                  — obtener documento completo
PUT  /{id}/document                  — guardar documento (hash SHA256 + staleness)
GET  /{id}/jobs                      — listar jobs de análisis
POST /{id}/export-script             — script standalone OpenSeesPy (descarga .py)
```

### Documento del proyecto (schema_version: wrc-1.0)

```json
{
  "schema_version": "wrc-1.0",
  "name": "...",
  "detailing": "DES",
  "units": {"length": "m", "force": "kN", "mass": "t"},
  "materials": { "<id>": {"kind": "ConcreteCM|Concrete02|Hysteretic|...", ...} },
  "walls": [ { "id": "w1", "formulation": "E_SFI_MVLEM_3D", "height_m": 3.0, ... } ],
  "analysis": { "gravity_steps": 10, "modal_modes": 6, "pushover_directions": ["X"] }
}
```

### Pendientes Phase 2

- Implementar `run_gravity` Celery task (OpenSeesPy gravity analysis)
- Implementar `run_modal` Celery task (eigenvalue)
- Implementar `run_pushover` Celery task (DisplacementControl pushover)
- Endpoints `POST /{id}/analyze/gravity`, `POST /{id}/analyze/modal`, `POST /{id}/analyze/pushover/{direction}`
- Resultados: curvas de capacidad, derivas por piso, fibra strains heatmap

**How to apply:** El frontend (Phase 3) irá en `/wall-projects` con ruta `apps/web/src/app/wall-projects/`.
