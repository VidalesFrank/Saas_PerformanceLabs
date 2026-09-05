---
name: Estado de la plataforma — 2026-09-02
description: Snapshot sesión 2026-09-02 (actualizado tarde): demandas muros FHE completo, bug migration Postgres pendiente de fix
type: project
originSessionId: d1868229-34b6-4263-a6b0-7c22f7a13c4b
---
## Último commit

`2128441` — "Módulo 1: Constructor de Modelos + análisis modal/espectral NSR-10"  
**Todo el trabajo posterior sigue sin commitear.** Acumulado de 3+ sesiones.

---

## Trabajo de la sesión (2026-09-02 tarde) — sin commitear

### Pipeline Demandas de Muros FHE — COMPLETADO y probado

**Archivos nuevos/modificados:**

| Archivo | Cambio |
|---------|--------|
| `apps/api/app/engine/building/linear/wall_model_builder.py` | NUEVO — MVLEM_3D elástico |
| `apps/api/app/engine/building/linear/wall_demands.py` | NUEVO — FHE NSR-10 + combos |
| `apps/api/app/tasks/structural_wall_demands_task.py` | NUEVO — tarea Celery |
| `apps/api/alembic/versions/49b5c7c39908_add_wall_demands_analysis_type.py` | NUEVO — `wall_demands` enum value |
| `apps/api/alembic/versions/e5f2a3b4c1d0_add_wall_projects_module5.py` | FIX — `CREATE TYPE IF NOT EXISTS` con `pgENUM(create_type=False)` |
| `apps/api/app/models.py` | `wall_demands` añadido a `StructuralAnalysisType` |
| `apps/api/app/routers/structural_analysis.py` | validación + task_map + endpoint `GET /{project_id}/wall-demands` |
| `apps/api/app/tasks/celery_app.py` | `structural_wall_demands_task` registrado |
| `apps/api/app/engine/building/linear/model_builder.py` | Fix masas ÷1000 + skip fila unidades |
| `apps/api/app/engine/building/e2k_parser.py` | Fix `_build_shell_pier_assignments` (filtra PANEL) |
| `apps/web/src/lib/structural-types.ts` | `WallDemandsResult`, `WallPierDemand`, `WallFHEParams` + `wall_demands` en enum |
| `apps/web/src/components/linear/WallDemandsPanel.tsx` | NUEVO — tabla filtrable por combo/historia |
| `apps/web/src/app/projects/[id]/page.tsx` | sección "Demandas Muros (FHE)" en sidebar + estado + carga |

### Resultados verificados (VitaTorre_Red_V00.e2k)

- 270 pieres (54 piers × 5 historias) construidos correctamente
- W = 1533 kN, Vb = 138 kN, T = 0.32s, Cs = 0.09
- Pu_max = 121 kN, Vu_max = 8.9 kN (pier M7-1 @ N.E. 2.45), Mu_max = 21.8 kNm
- Sin singularidades (fix: `ops.fix(tag, 0,0,0,1,1,0)` en top nodes antes de `rigidDiaphragm`)

### Bugs corregidos

1. `_build_shell_pier_assignments` filtraba `Area Type == 'wall'` → VitaTorre usa `PANEL` → filtrar por pier assignment
2. Masas ÷1000 de más en `model_builder._build_masses` → ETABS exporta en ton, no kg
3. Fila unidades crea CM fantasma con `story=""` → skip con `if not story: continue`
4. DOF singulares out-of-plane en MVLEM_3D → `ops.fix(tag, 0,0,0,1,1,0)` en top nodes

---

## Bug pendiente: Migration Postgres `e5f2a3b4c1d0`

**Síntoma:** API no levanta en Docker con error:  
`sqlalchemy.exc.ProgrammingError: type "wallprojectstatus" already exists`

**Causa:** El enum existe en la DB de producción pero `alembic_version` muestra `d8e3f4a2b1c6` (sin `e5f2a3b4c1d0`). Al correr el migration, `sa.Enum(name='wallprojectstatus')` dentro de `op.create_table()` intenta crear el tipo de nuevo.

**Fix aplicado (pendiente rebuild):**  
`e5f2a3b4c1d0` ya usa:
- DO block `EXCEPTION WHEN duplicate_object THEN null` para los 3 tipos
- `pgENUM(..., create_type=False)` en los `op.create_table()` para no recrear tipos
- `if 'wall_projects' not in tables:` para skip si la tabla ya existe

**Próximo paso para arrancar mañana:**

```powershell
docker compose -f docker-compose.prod.yml build --no-cache api && docker compose -f docker-compose.prod.yml up -d
```

Si sigue fallando, verificar con:
```powershell
docker logs saas_performancelabs-api-1 2>&1 | tail -30
```

---

## Estado de la sesión anterior (2026-09-02 mañana)

### LinearModelViewer3D — 4 fixes
- `parseSectionDims`, colores extruido, `mesh3d` hover, ResizeObserver, `prevViewModeRef` + purge+newPlot

### projects/[id]/page.tsx — Sidebar ETABS
- `SectionId`: `archivos | vista-3d | materiales | secciones | muros | sismico | wall-demands | diseno | no-lineal`
- Grupos: MODELO · DEFINIR · ASIGNAR · ANÁLISIS (incluye "Demandas Muros FHE") · DISEÑO · NO LINEAL

### Módulo Muros E-SFI-MVLEM-3D — completo
- Engine `walls/`, router `wall_analytical.py`, 5 componentes UI

---

## Para commitear mañana (todo de golpe)

```powershell
git add apps/api/app/engine/building/linear/wall_model_builder.py
git add apps/api/app/engine/building/linear/wall_demands.py
git add apps/api/app/engine/building/linear/model_builder.py
git add apps/api/app/engine/building/e2k_parser.py
git add apps/api/app/tasks/structural_wall_demands_task.py
git add apps/api/app/models.py
git add apps/api/app/routers/structural_analysis.py
git add apps/api/app/tasks/celery_app.py
git add apps/api/alembic/versions/
git add apps/web/src/lib/structural-types.ts
git add apps/web/src/components/linear/WallDemandsPanel.tsx
git add apps/web/src/app/projects/[id]/page.tsx
```

**Why:** Deployment bloqueado por bug de enum en migration `e5f2a3b4c1d0`.  
**How to apply:** Mañana, verificar primero que el API levante bien, luego commitear.
