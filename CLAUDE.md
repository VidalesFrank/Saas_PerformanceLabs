# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

PerformanceLabs: a SaaS platform for a structural/earthquake engineering services company,
built around OpenSees. Full product scope (6 modules, from model import through nonlinear
analysis, performance evaluation, seismic risk, to a decision/recommendation report) is
defined in `PlanteamientoDesarrollosEmpresaOpenSees.docx` at the repo root — read it before
proposing new modules or product-catalog changes. `apps/api/app/catalog.py` is the living,
code-form transcription of that doc's product table (drives the dashboard).

The owner (Frank Vidales) is a structural engineer, not primarily a web developer. The core
architectural constraint driving this repo is that he must be able to read and modify the
engineering logic directly in Python without touching the web stack — see Architecture below.

## Environment setup (fresh machine)

This is a Windows dev environment. Node.js and the Python venv are **not** committed —
recreate them per machine:

```
python -m venv .venv
./.venv/Scripts/python.exe -m pip install -r apps/api/requirements.txt   # installs packages/engine editable too
```

Node.js LTS must be installed separately (e.g. `winget install --id OpenJS.NodeJS.LTS -e`) —
it was not preinstalled on the original dev machine.

```
cd apps/web && npm install
```

Copy `.env.example` -> `.env.local` (apps/web) and `.env.example` -> `.env` (apps/api) if you
need non-default config; both have sane local defaults (SQLite, localhost).

**Known pin**: `apps/api/requirements.txt` pins `bcrypt==4.0.1` — `passlib==1.7.4` is
incompatible with `bcrypt>=4.1` (its self-test crashes with `ValueError: password cannot be
longer than 72 bytes`). Don't upgrade bcrypt without also replacing passlib's bcrypt backend.

## Commands

Run everything from the repo root unless noted. There's one shared venv at `.venv/` used by
both `packages/engine` and `apps/api`.

**Backend dev server**
```
cd apps/api && ../../.venv/Scripts/python.exe -m uvicorn app.main:app --reload --port 8000
```

**Frontend dev server**
```
cd apps/web && npm run dev          # http://localhost:3000, Turbopack
```

**Tests**
```
cd packages/engine && ../../.venv/Scripts/python.exe -m pytest -q     # engine unit tests
cd apps/api && ../../.venv/Scripts/python.exe -m pytest -q            # API smoke tests
```

**Frontend build / typecheck**
```
cd apps/web && npm run build        # also runs TypeScript
cd apps/web && npx tsc --noEmit     # typecheck only, faster
```

**DB migrations** (apps/api, SQLite en dev / PostgreSQL en prod)
```
../../.venv/Scripts/python.exe -m alembic revision --autogenerate -m "..."
../../.venv/Scripts/python.exe -m alembic upgrade head
```

**Docker producción** (puerto 7000 vía nginx)
```powershell
# Rebuild y levantar todo:
docker compose -f docker-compose.prod.yml build && docker compose -f docker-compose.prod.yml up -d

# Solo frontend (cambios web):
docker compose -f docker-compose.prod.yml build web && docker compose -f docker-compose.prod.yml up -d web

# Solo worker/API (cambios Python):
docker compose -f docker-compose.prod.yml build worker api && docker compose -f docker-compose.prod.yml up -d worker api
```
Siempre hacer Ctrl+Shift+R en el navegador tras rebuild web.

## Architecture

Monorepo, three parts:

```
packages/engine/   Pure Python engineering library (no web framework deps at all)
apps/api/           FastAPI — thin HTTP layer over packages/engine
apps/web/            Next.js 16 (App Router) + TypeScript + Tailwind v4
```

**The load-bearing decision**: `packages/engine` never imports FastAPI/Pydantic/anything web.
It is installed editable (`pip install -e packages/engine`) and imported by `apps/api` as a
plain dependency. This lets the engineering owner open, test, and modify the calculation code
(fiber sections, material models, OpenSeesPy analyses) in a bare Python REPL or notebook,
independent of the API.

`packages/engine` internal layout:
- `materials/` — Mander (1988) confined/unconfined concrete, reinforcing steel. Produce
  *parameter objects* (`ConcreteMaterialParams`, `SteelMaterialParams`), not stress-strain
  integrators — OpenSees does the fiber integration at analysis time.
- `sections/geometry.py` — `RectangularSection` / `CircularSection` / `PolygonSection`. Pure
  geometry, returns declarative patch/fiber specs. No OpenSees import.
- `sections/reinforcement.py` — bar-pattern generators; explicit `PointFiberSpec` fibers so
  the same bar coordinates can be reused for the frontend's 2D section preview.
- `analysis/interaction.py` — traces the full P-M interaction envelope via zeroLengthSection +
  DisplacementControl. Calls `ops.wipe()` on every P-level — deliberate, prevents domain leaks.
- `analysis/moment_curvature.py` — M-φ curve via zeroLengthSection. Captures
  `phi = abs(ops.nodeDisp(2,3))` and `moment = abs(ops.getLoadFactor(2))`. Engine units: mm/N.
  API converts: φ ×1000 (mm⁻¹→m⁻¹), M ÷1e6 (N·mm→kN·m). Yield = first M ≥ 0.75·Mu.
- `seismic/` — espectros NSR-10: Sa, Sd, Sv por municipio y tipo de suelo.

`apps/api`:
- `app/engine_adapter.py` — única frontera entre esquemas HTTP y tipos del engine.
- `app/tasks/` — tareas Celery: archetype, modal, pushover (os.fork para X+Y en paralelo),
  dynamic (IDA). `os.fork()` en pushover porque OpenSees no es thread-safe.
- `app/engine/building/` — scripts propietarios de Frank: `archetype_1.py` (E2K → OpenSees),
  `pushover.py`, `dynamic.py`. `archetype_1.py` tiene f-strings corregidas a Python 3.11
  (comillas dobles dentro de la expresión).
- `app/routers/building_projects.py` + `building_analysis.py` — CRUD de proyectos y jobs.
- `entrypoint.sh` — corre `alembic upgrade head` antes de uvicorn/celery.
- `patch_opstool.py` — se ejecuta en Docker build; parchea opstool para operación headless:
  wrap try/except en `__init__.py` (root + pre + anlys + vis). Necesario porque `anlys/_smart_analyze.py`
  tiene f-strings Python 3.12 incompatibles con el container Python 3.11.

`apps/web`:
- Tailwind v4 CSS-first (tokens en `src/app/globals.css` `@theme`, no `tailwind.config.js`).
- UI primitives hand-rolled en `src/components/ui/` — sin shadcn/ui.
- Auth: JWT en localStorage (`src/lib/auth.ts`). `use-require-auth.ts` redirige sin sesión.
- Plotly cargado desde CDN (no instalado como paquete) para evitar conflicto con SSR.
  Declarado como `window.Plotly: any`. Refs de div para los paneles, no IDs string.
- `src/lib/section-preview.ts` duplica la matemática de `reinforcement.py` en TS para el
  preview 2D en vivo — el cálculo real siempre ocurre en el engine Python.

## Docker — notas críticas

- **Python 3.11-slim** en el container. No usar f-strings `f'{dict["key"]}'` (Python 3.12+).
- **opstool headless**: `patch_opstool.py` (ejecutado en build) parchea 4 archivos:
  `opstool/__init__.py`, `pre/__init__.py`, `anlys/__init__.py`, `vis/__init__.py`.
  Si opstool se actualiza, puede ser necesario re-verificar los patches.
- **numpy==1.26.4** — no usar `np.trapezoid` ni otras APIs numpy 2.x.
- **bcrypt==4.0.1** + **passlib==1.7.4** — no actualizar bcrypt sin cambiar el backend de passlib.

## Current state — 2026-07-28

### Módulos funcionales y en producción

| Ruta | Descripción | Estado |
|------|-------------|--------|
| `/seismic` | Generador de espectros NSR-10 | ✅ Listo |
| `/analysis/interaction` | Diagrama P-M (rect/circ/especial) | ✅ Listo |
| `/analysis/moment-curvature` | Curva M-φ con confinamiento | ✅ Listo |
| `/analysis/pmm` | Superficie P-M-M biaxial | ✅ Listo |
| `/building` | Análisis no lineal 3D (Módulo 3) | 🔄 Engine completo, probando |

### Componentes frontend clave

**Dashboard** (`/dashboard`):
- Hero con saludo + plan del usuario (GET `/api/v1/auth/me`) + stats de catálogo.
- Módulos con color propio por índice (0=azul, 1=verde, 2=morado, 3=ámbar, 4=rojo, 5=teal).
- Tarjetas activas: borde izquierdo 3px coloreado + hover lift. Inactivas: borde punteado + 55% opacidad.
- Animaciones CSS `pl-fade-up` escalonadas, skeleton shimmer `pl-skeleton`.

**ModelViewer3D** (`src/components/building/ModelViewer3D.tsx`):
- Modo Líneas / Extruido. Extruido usa `makeBox()` que genera `mesh3d` Plotly (prisma rectangular).
- Dimensiones vienen de `col.geometry.base` / `col.geometry.height` del JSON del arquetipo (metros).
  Defaults: columnas 0.3×0.3m, vigas 0.3×0.4m.
- Colores: columnas `#54643a`, vigas `#75b72a`, losas `#b7d38a`.
- Props: solo `archetypeData`. La prop `modalData` fue eliminada — modal va en `ModeShapeViewer`.

**ModeShapeViewer** (`src/components/building/ModeShapeViewer.tsx`):
- 3 paneles Plotly con refs independientes (no IDs string).
- Autoescala: `targetAmp = max(altura, extensión) × 12%`.
- Animación `requestAnimationFrame` + `sin(phase)` + `Plotly.restyle` (solo traza deformada).
- Incluido internamente dentro de `ModalResultsTable` — no llamar por separado.

**PushoverChart**: `dtecho` del engine ya viene en porcentaje (`displacement_m × 100 / height_m`).
No multiplicar ×100 en el frontend. El resumen también usa `drift_techo_max` directo (ya en %).

### Pendientes inmediatos

1. Rebuild Docker `web` + `worker` para aplicar todos los cambios de 2026-07-28 en producción.
2. Probar flujo completo Módulo 3: arquetipo → modal → pushover → dinámico.
3. Ampliar `nsr10_data.py` con Tabla A.2.3-1 completa del NSR-10 (~1100 municipios).
4. Frank quiere dar feedback adicional sobre el diseño del dashboard antes de más cambios.

## Verification reference

Rectangular column 400×400mm, cover 40mm, 8-#8 bars, f'c=28MPa, fy=420MPa, #3 ties @150mm,
2 legs each direction → pure compression P ≈ 5424 kN, pure tension P ≈ -1714 kN, M_max ≈ 379 kN·m.
Encoded in `packages/engine/tests/test_interaction.py`.
