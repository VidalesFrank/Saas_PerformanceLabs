---
name: Módulo 1 — Demandas de Muros FHE (MVLEM_3D)
description: Pipeline completo E2K→MVLEM_3D→FHE NSR-10→P/V/M por pier implementado y funcionando (2026-09-02)
type: project
originSessionId: d1868229-34b6-4263-a6b0-7c22f7a13c4b
---
Pipeline de análisis de demandas de muros para edificio completo a partir del E2K de ETABS.

**Arquitectura:**
- `WallModelBuilder` (`apps/api/app/engine/building/linear/wall_model_builder.py`): construye MVLEM_3D elástico en OpenSees, unidades m·kN·kPa
- `WallDemandAnalyzer` (`apps/api/app/engine/building/linear/wall_demands.py`): FHE NSR-10 A.4.2 + combos C.9.2.1
- Task Celery: `structural_wall_demands_task.py` (análisis_type = `wall_demands`)
- Router: endpoint `GET /api/v1/analysis/{project_id}/wall-demands`
- Frontend: `WallDemandsPanel.tsx`, sección "Demandas Muros (FHE)" en sidebar de projects/[id]

**Bugs resueltos en esta sesión:**
1. `_build_shell_pier_assignments` filtraba por `Area Type == 'wall'` pero VitaTorre usa `PANEL` → cambio a filtrar por pier assignment existence
2. Masas ÷1000 de más en `model_builder.py` (ETABS exporta en ton, no kg) → eliminado factor
3. Fila de unidades del XLSX creaba CM fantasma con story="" → `_build_masses` skipea story vacío
4. Singularidad DOF out-of-plane en MVLEM_3D (elemento in-plane) → `ops.fix(tag, 0,0,0,1,1,0)` en top nodes antes del diaphragm

**Resultados VitaTorre (verificados):**
- 270 pieres (54 piers × 5 historias) construidos correctamente
- W=1533 kN, Vb=138 kN, T=0.32s, Cs=0.09
- Pu_max=121 kN, Vu_max=8.9 kN (pier M7-1 @ base), Mu_max=21.8 kNm

**Why:** Pendiente conectar demandas → diseño de muros (diseñar refuerzo desde la plataforma sin ETABS)
**How to apply:** El análisis corre DESPUÉS del import_validate y requiere parámetros sísmicos configurados. Requiere tabla "Shell Assignments - Pier Spandr" > 0 filas.
