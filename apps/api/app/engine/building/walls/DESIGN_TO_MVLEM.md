# Diseño de muros RC → Modelo no lineal MVLEM_3D

Documento de referencia para el motor de auto-diseño (`auto_design.py`) y su
traducción a los elementos macrofibra usados en el análisis no lineal
(MVLEM_3D / SFI-MVLEM-3D / E-SFI-MVLEM-3D).

Referencias normativas:
- **NSR-10** Título C: C.11 (cuantías mínimas), C.14 (muros), C.21.9 (muros
  estructurales con capacidad especial DES).
- **ACI 318-25** Chapter 18.10 (estructuras dúctiles), §11.6 (cuantías
  mínimas no sísmicas).
- Modelado: Kolozvari et al. (2015) — *Modeling of Reinforced Concrete
  Structural Walls Using SFI-MVLEM*; Orakcal & Wallace (2004).

---

## 1. Escalones de cuantía mínima en el alma

Aplican a las cuantías **verticales y horizontales del alma** (ρᵥ_web,
ρₕ_web). No aplican al EBE (que siempre respeta ρ_BE ≥ 1%).

Sea `Vc = Acv · λ · √f'c / 6` (unidades MPa, m², kN) el corte máximo
resistido por el concreto. El escalón se elige según la relación Vu / Vc:

| Nivel | Condición | ρᵥ mínima | ρₕ mínima | Fuente |
|---|---|---|---|---|
| **Alto** | Vu > Vc / 2 | 0.0025 | 0.0025 | NSR-10 C.21.9.2.1 · ACI §18.10.2.1 |
| **Medio** | Vc/12 < Vu ≤ Vc/2 | 0.0020 | 0.0025 | NSR-10 C.21.9.2.4 · ACI §18.10.2.4 |
| **Bajo** | Vu ≤ Vc/12 | 0.0012 | 0.0020 | NSR-10 C.11.6 · ACI §11.6.2 |

**Condición adicional** para acceder al escalón bajo (0.0012): las barras
verticales deben ser **≤ #5 (⌀15.9 mm)**. Si el motor selecciona barras
mayores, el mínimo sube automáticamente al escalón medio (0.0020).

**Regla adicional** de NSR-10 C.21.9.2.2 (muros bajos): si `hw/lw < 2`,
`ρᵥ ≥ ρₕ`. El motor lo aplica automáticamente.

**Cap de espaciamiento** (código): incluso si la cuantía teórica es
0.12%, el espaciamiento no puede exceder 300 mm (DES) o 450 mm (DMO).
En muros comunes esto fuerza que la ρ provista sea mayor a la mínima
teórica — no hay problema, es siempre lado seguro.

---

## 2. Cortinas de refuerzo

Una **cortina** (curtain / layer) es una capa longitudinal de barras
paralela a la cara del muro. Se colocan en el interior del recubrimiento.

- `tw ≤ 0.15 m` → **1 cortina** centrada en el eje del muro.
- `tw > 0.15 m` → **2 cortinas**, una cerca de cada cara.

En Colombia se ven muy pocos casos con cortina intermedia adicional
(BE con lc > 0.7 m). El motor no la genera; si el diseñador la requiere
puede añadir barras adicionales manualmente desde el editor gráfico.

---

## 3. Elemento de borde (EBE)

El EBE se detona por dos criterios independientes (ACI 318-25 §18.10.6 /
NSR-10 C.21.9.6 para DES; NSR-10 C.21.4.4.6 para DMO):

**Método esfuerzo**:
```
Se requiere EBE si σ_max en la fibra extrema > threshold · f'c,
donde σ_max = P/(lw·tw) + M/S (elástico bruto)
```

| Ductilidad | threshold | Fuente |
|---|---|---|
| **DES** (capacidad especial) | 0.20 · f'c | ACI 318-25 §18.10.6.3 / NSR-10 C.21.9.6.3 |
| **DMO** (capacidad moderada) | 0.30 · f'c | NSR-10 C.21.4.4.6 |

DMO es MENOS exigente que DES: exige EBE sólo cuando la fibra extrema
alcanza 30 % de f'c, no 20 %. Muchos muros DMO con demandas moderadas
NO requieren EBE.

**Método desplazamiento** (sólo DES, §18.10.6.2):
```
Se requiere EBE si c ≥ lw / (600 · δu / hw), con δu / hw ≥ 0.005
```

### 3.1 Cuando NO se requiere EBE

El motor emite un `WallReinforcement` con `be_left.is_empty == True` y
`be_right.is_empty == True` (`n_bars = 0`, `length_m = 0`). El refuerzo
del alma se distribuye en TODA la longitud del muro. En la traducción a
MVLEM esto genera un solo `WebZone` que ocupa el ancho completo — sin
zonas de borde confinadas.

### 3.2 Cuando SÍ se requiere EBE

**Longitud del EBE**:
```
lc = max(c - 0.1·lw, c/2)      (§18.10.6.4)
lc ≥ tw                          (piso geométrico)
lc ≤ 0.30 · lw                   (cap práctico)
```

El motor calcula `c` con el eje neutro real del refuerzo propuesto y
re-verifica el EBE. Si `c` real es mayor que el inicial, ajusta `lc` y
re-busca el refuerzo del EBE.

---

## 4. Búsqueda óptima del refuerzo BE

El motor NO fija a priori el número de barras. Genera candidatos
`(n_bars, db_mm, n_curtains)` con:

- `db ∈ {#4, #5, #6, #7, #8}` (12.7, 15.9, 19.1, 22.2, 25.4 mm) — #3 no
  se usa como longitudinal de BE (queda para estribos).
- `n_bars ∈ [2, 12]` por cortina
- `n_curtains = 1` si tw ≤ 0.15 m, `2` en otro caso (`curtains_for_tw`)
- Espaciamiento longitudinal `100 mm ≤ s ≤ 300 mm` para evitar congestión
  y respetar los máximos de código.
- Cuantía práctica: `1.0% ≤ ρ_BE ≤ 4.0%`

Los candidatos se ordenan **de menor a mayor As total**. El motor prueba
cada uno construyendo el diagrama P-M con el layout completo y verifica
que **todas las demandas mayoradas queden dentro de la envolvente
factorizada (φPn, φMn)**. Retorna el primer candidato que cumple.

**Si ningún candidato cumple**, el motor levanta
`WallNotDesignableError`. NO hay fallback a "acero excesivo" — el diseño
falla explícito con detalle de la combinación gobernante para que el
usuario revise geometría / demandas. La UI muestra el muro en rojo en el
resumen de `POST /walls/design-and-build-all`.

### 4.1 Diámetros del alma

`WEB_BAR_CANDIDATES_MM = (9.5, 12.7, 15.9, 19.1)` — arranca en #3 para
permitir que muros con `Vu` bajo lleguen a `ρ ≈ 0.20 %` en horizontal
sin que el cap de espaciamiento máximo (300 mm DES / 450 mm DMO) empuje
la cuantía provista hacia arriba. El motor elige el MENOR diámetro que
puede proveer la cuantía objetivo dentro de `[s_min, s_max]`.

### Distribución dentro del BE

Las barras se distribuyen **uniformemente a lo largo del BE** dentro de
cada cortina. Si `n_curtains = 2`, hay `n_bars` barras cerca de la cara
interna y `n_bars` cerca de la externa. El área total del EBE es:
```
As_BE_total = n_bars × n_curtains × área(db)
```

---

## 5. Confinamiento del EBE (Ash, s)

Cuando el EBE es requerido, el motor diseña el estribo cerrado + crossties.
Referencias: ACI 318-25 §18.10.6.4 → §18.7.5.4.

**Ecuaciones**:
```
Ash_req = max{ 0.09·s·bc·f'c/fyt,
               0.3·s·bc·(f'c/fyt)·[(Ag/Ach) - 1] }
```
donde `bc` es la dimensión del núcleo confinado en la dirección del
estribo, `Ag/Ach` la relación bruta/núcleo.

**Espaciamiento máximo** (DES, §18.7.5.3):
```
s ≤ min(s0, 6·db_long, 150 mm)
s0 = 4 + (355.6 - hx)/3   [pulgadas → mm]
```

El motor arranca con `tie_db_mm = 9.5` (#3) y `s = 100 mm` (DES) o
`150 mm` (DMO). Si `Ash_prov < Ash_req` escala en este orden:
1. Sube diámetro estribo a #4 (12.7 mm)
2. Aumenta patas del estribo (n_legs_b) de 2 → 3
3. Reduce s al mínimo del código

---

## 6. Traducción refuerzo → macrofibras (MVLEM)

Una vez que el motor produce un `WallReinforcement` completo, se convierte a
un `WallAnalyticalModel` con macrofibras. La discretización respeta las 3
zonas físicas: `boundary_left`, `web`, `boundary_right`. Las macrofibras
que caen en una zona reciben las cuantías uniformes de esa zona.

### 6.1 Cuantía vertical por zona

- **Fibras BE_izq**: `ρᵥ = As_BE_izq / (length_BE_izq · tw)` — uniforme
  para todas las fibras del BE (**convención A** del documento raíz).
- **Fibras web**: `ρᵥ = ρᵥ_web` (barra vertical del alma).
- **Fibras BE_der**: análogo.

### 6.2 Cuantía horizontal por zona (diferenciada)

- **Fibras BE**: `ρₕ_BE = n_legs · As(tie_db) / (tw · tie_spacing)` — es
  la contribución del estribo confinante del EBE, típicamente ~0.5-1.5%.
- **Fibras web**: `ρₕ_web = n_curtains · As(bar_h) / (tw · spacing_h)` —
  barra horizontal del alma, ~0.25-0.4% típico.

### 6.3 Concreto confinado vs. no confinado

- Fibras BE → `ConcreteMaterialDef(confined=True)`. El material aplica
  Mander confinado con incremento en `f'cc` y `ε_cu` según la
  cuantía transversal `ρₕ_BE`.
- Fibras web → `ConcreteMaterialDef(confined=False)`. Mander no confinado.

El `MaterialRegistry` deduplica por hash, así que un edificio con 300
pieres pero solo 4 combinaciones únicas de material genera solo 4 tags
`FSAM` en el script OpenSees.

### 6.4 Acero

Se usa el mismo `SteelMaterialDef` (Grade 60, fy=420 MPa por defecto)
para todas las zonas salvo que el diseñador especifique un fy diferente
por proyecto.

### 6.5 Discretización por ancho máximo

El auto-diseño usa por defecto un **ancho máximo por macrofibra de
0.30 m**. Esto respeta la práctica de la literatura MVLEM (Kolozvari
2013) para capturar bien la variación de deformaciones a lo largo del
muro. Alternativamente, el diseñador puede especificar un `N` fijo.

Reglas de reparto (ver `AutoDiscretization.auto`):
1. Cada BE recibe al menos 1 fibra.
2. Ninguna fibra cruza la frontera boundary/web.
3. Las fibras dentro de una zona son de ancho uniforme.

---

## 7. Ejemplo trabajado

Pier gobernante VitaTorre — piso 1, muro tipo M7 (aproximado):

**Geometría**: lw = 3.50 m, tw = 0.30 m, hw = 3.00 m, f'c = 28 MPa,
fy = 420 MPa, ductilidad DES.

**Demandas** (envolvente NSR-10 B.2.4):
| Combo | Pu (kN) | Vu (kN) | Mu (kN·m) |
|---|---|---|---|
| 1.4D | 350 | 5 | 25 |
| 1.2D+1.6L | 380 | 8 | 40 |
| 1.2D+L+E | 450 | 180 | 1200 |
| 0.9D-E | 90 | 180 | 1200 |

**Resultado del motor**:

- `Vc = 1.05 · √28 / 6 · 1000 = 926 kN` → `Vu/Vc = 0.19`
- `Vc/12 = 77 kN`, `Vc/2 = 463 kN` → tier **medium** (Vu = 180)
- Cuantía web: ρᵥ_min = 0.0020, ρₕ_min = 0.0025
- Web: #4 @ 200 mm × 2 cortinas → ρᵥ_web = 0.0043, ρₕ_web = 0.0043
- Chequeo EBE (esfuerzo con c₀ = 0.3·lw = 1.05): σ_max ≈ 0.32·f'c > 0.2·f'c → **EBE requerido**
- lc = max(1.05 - 0.35, 0.525) = **0.70 m** ≈ 20% de lw
- Búsqueda BE:
  - Candidatos ordenados por As total
  - Prueba (n=4, db=15.9, 2 cortinas) → As = 4·2·199 = 1592 mm² → ρ_BE = 0.76% (bajo)
  - Prueba (n=6, db=15.9, 2 cortinas) → As = 2388 mm² → ρ_BE = 1.14% → **satisface P-M**
- EBE final: **6 #5 por cortina × 2 cortinas = 12#5 total** (As = 2388 mm²)
- Confinamiento: ⌀12 mm @ 100 mm con 2 legs → Ash provisto ≈ 226 mm² · 2 = 452 mm² > Ash_req ≈ 380 mm²
- Chequeos NSR-10: **cumple 9/9**

**Macrofibras** (E-SFI-MVLEM-3D, ancho_max = 0.30 m):
- N = ⌈3.50 / 0.30⌉ = 12 macrofibras
- Distribución: 2 BE_izq (0.35 m c/u) + 8 web (0.35 m c/u) + 2 BE_der (0.35 m c/u)

| # | Zona | ancho | ρᵥ | ρₕ | Concreto |
|---|---|---|---|---|---|
| 1-2 | boundary_left | 0.35 m | 1.14% | 1.13% | confined |
| 3-10 | web | 0.35 m | 0.43% | 0.43% | unconfined |
| 11-12 | boundary_right | 0.35 m | 1.14% | 1.13% | confined |

**Ratio BE/web = 1.14 / 0.43 ≈ 2.7:1** — dentro del rango práctico
(literatura sugiere 4:1 a 10:1 para muros muy exigidos; aquí Mu es alto
pero se compensa con lc grande, así que 2.7:1 es sensato).

---

## 8. Overrides configurables

Todos los parámetros del auto-diseño son ajustables por el usuario en
`WallDesignManualIn` (endpoint `POST /walls/{label}/design`):

- `override_rho_v_web_min`, `override_rho_h_web_min` — fuerza escalón.
- `override_lc_min_m` — impone longitud mínima del EBE.
- `manual_reinf` — sobrescribe COMPLETAMENTE el refuerzo (BE_izq, web,
  BE_der, simetría). El motor entonces sólo verifica que cumpla P-M,
  cortante, EBE y confinamiento.

En la vista premium (`/projects/[id]/walls/[label]`), el editor de barras
produce automáticamente el `manual_reinf` desde el layout gráfico
editado.
