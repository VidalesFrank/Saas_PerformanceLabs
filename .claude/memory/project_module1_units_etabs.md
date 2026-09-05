---
name: Módulo 1 — Unidades ETABS y flujo de normalización
description: Cómo se manejan las unidades entre ETABS 17/23 y el modelo canónico. Regla crítica para secciones.
type: project
originSessionId: 577a9fc9-7047-46c0-a553-91fad7f61592
---
## Regla de unidades por versión ETABS

| Dato | ETABS 17 (hoja "Frame Sections") | ETABS 23 (hoja "Frame Prop - Summary") |
|---|---|---|
| Area | **cm²** (→ ÷1e4 para m²) | **m²** (sin conversión) |
| I22, I33, J | **cm⁴** (→ ÷1e8 para m⁴) | **m⁴** (sin conversión) |
| E, G materiales | MPa | kN/m² (÷1000 → MPa en adaptador) |
| Masa por piso | kg (÷1000 → ton) | ton (adaptador la convierte a kg para E17-compat) |
| MMI | ton-m² | ton-m² |
| Coordenadas XYZ | m | m |

## Dónde ocurre la conversión

La normalización a m²/m⁴ ocurre en **`_load_raw_data`** (`structural_import_task.py`):

```python
if sheet == 'Frame Sections':
    area_unit = str(units_row.get('Area', 'm2') or 'm2').lower()
    if 'cm' in area_unit:
        # E17 original: cm² → ÷1e4, cm⁴ → ÷1e8
        for col, factor in [('Area', 1e4), ('I33', 1e8), ('I22', 1e8), ('J', 1e8)]:
            df[col] = pd.to_numeric(df[col], errors='coerce') / factor
```

Para E23: el adaptador (`etabs_adapter.py::adapt_e23_to_e17`) ya produce m²/m⁴ en la hoja adaptada, por lo que la detección `if 'cm' in area_unit` devuelve False y no hay conversión adicional.

**`model_builder.py` recibe siempre m²/m⁴** — no hace conversión de unidades de secciones.

## Flujo E23 completo

1. `detect_version(xlsx)` → detecta por presencia de hoja "Objects and Elements - Areas"
2. `adapt_e23_to_e17(xlsx, adapted_path)` → normaliza nombres de columnas y unidades
3. `_load_raw_data(adapted_path)` → lee hoja Frame Sections con unidades 'm2/m4' → sin conversión
4. `CanonicalModelBuilder(raw_data).build()` → produce JSON con m²/m⁴
5. `LinearOPSBuilder(model).build()` → OpenSees en metros/kN/s

## Nombres de columnas clave E17 vs E23

| Concepto | E17 | E23 (adaptado) |
|---|---|---|
| Joint label | "Element Label" | "Element Label" (renombrado de "Element Name") |
| Frame Joint I/J | "Joint I", "Joint J" | (renombrado de "Elm JtI", "Elm JtJ") |
| Shell → Shells | "Objects and Elements - Shells" | (renombrado de "Objects and Elements - Areas") |
| Restraints ID | "Unique Name" (integer) | "Unique Name" (= UniqueName = FEA element number) |
| Frame sec assign | "Analysis Section" | "Analysis Section" (renombrado de "Section Property") |

## Bug corregido: _joint_tag

`_joint_tag` en `ops_builder.py` usa `int(float(label))` en vez de `int(label)` para manejar que pandas lee enteros de Excel como float ("313.0" en lugar de "313").

## Tolerancias modales esperadas vs ETABS

Para el archivo Artesia_E23 (5 pisos, 431 nudos):
- T1: 0.803 s (nuestro) vs 0.736 s (ETABS) → +9% — esperado, no modelamos losas
- T2-T3: < 2% de diferencia
- Divergencia mayor en modos 5-6 (modos de losa/vertical que no capturamos)

**Why:** No modelamos elementos shell (losas). Las losas aportan rigidez lateral marginal pero sí masa. La masa se incluye como masa lumped en CM → T1 ligeramente mayor al de ETABS.
