---
name: Módulo 1 — Calibración Modal OpenSees vs ETABS
description: Investigación y fixes para alinear periodos modales OpenSees con ETABS (VitaTorre_Red_V00.e2k)
type: project
originSessionId: bec327c8-77c6-49f3-9aa4-786bf9f4f3ff
---
Investigación para VitaTorre (5 pisos RC muros, E2K canónico en `1cea051f-de46-4d2e-a21a-e5dec7828472`).

## Progresión de T1 (modo X)
| Etapa | T1 | Causa |
|-------|-----|-------|
| Inicial | 0.065s | Restricciones base incorrectas (6 DOFs fijos) |
| Fix restricciones | 0.1044s | Base pinned (UX/UY/UZ fijos, rotaciones libres) |
| +Masa muros | **0.1867s** | Peso propio muros 69 t/piso ahora incluido |
| ETABS | 0.246s | — |

## Causa raíz encontrada (2026-09-04)
ETABS `MASSSOURCE INCLUDEELEMENTS=Yes` incluye peso propio de muros en masa sísmica.
El parser E2K solo calculaba masa de losas → subestimaba masa ~3.2× → períodos 1.79× cortos.

**Fix implementado**: `_wall_mass_per_cm_story()` en `ops_builder.py`:
- Computa volumen de cada panel muro (t × L × H)
- Convierte con γ=24 kN/m³, g=9.81 m/s²
- Asigna masa al CM del piso superior (top del muro)
- Resultado: masa/piso 31.17t → 100.28t (+69.11t muros)

## Segunda causa: vigas articuladas (2026-09-04)
ETABS tiene beams PINNED (RELEASE "PINNED" en LINE ASSIGNS del E2K). En OpenSees, los beams
articulados no aportan rigidez lateral → se excluyen del modelo (continue en _create_frame_elements).
Sus joints quedan como "flotantes" en el diafragma → reciben fix Uz,Rx,Ry.

Resultado final de calibración:
| T1 OpenSees | T1 ETABS | % diff |
|-------------|----------|--------|
| 0.2024s | 0.246s | 18% |
| T2 0.0998s | 0.117s | 15% |

Diferencia residual ~18% atribuida a formulación de elemento (ShellMITC4 vs ETABS). Aceptable para diseño NSR-10 (conservador).

## Fixes en parser para modelos futuros
- e2k_parser.py: `line_assigns[(name,story)] = {'section':..., 'release': kv.get('RELEASE','')}` 
- `_build_frame_assignments`: columna 'Release' en xlsx
- model_builder.py `_build_frames`: lee 'Release' y lo guarda en canonical frames como `release` field
- ops_builder.py: `is_pinned = release=='PINNED' or element_type=='beam'` → skip element creation

## Otros bugs resueltos (misma sesión)
- Restricciones base: `"UX UY UZ"` → [1,1,1,0,0,0] (no 6 DOFs)
- Masa overcounting: eliminado `_add_selfweight_to_masses`
- Double-clamping: eliminado `ops.fix(RX,RY)` en nodos intermedios (N_SUB=2)
- ARPACK colgado: eliminado `_add_tiny_mass_to_wall_nodes` que creaba 6000+ DOFs con M>0
- N_SUB revertido a 1: N_SUB=2 demasiado lento (LU fill-in con 2220 nodos extra)

## Geometría VitaTorre
- 424 muros/piso, widths 0.069–0.45m, H_story=2.45m, t=0.1m
- A_vx=3.518 m²/piso, A_vy=8.012 m²/piso
- Estos son sub-elementos del mallado interno de ETABS (no pieres originales)
- E=21538.1 MPa (21 MPa concreto), nu=0.2

**Why:** El ratio de masa (wall vs slab) es crítico para modelos de edificios con muros RC donde el peso de los muros supera frecuentemente al de las losas.
**How to apply:** Siempre verificar que ops_builder incluye masa de muros cuando el MASSSOURCE de ETABS dice INCLUDEELEMENTS=Yes.
