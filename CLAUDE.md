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
cd apps/api && ../../.venv/Scripts/python.exe -m pytest -q            # API smoke tests (temp SQLite db, see tests/conftest.py)
```
Run a single test: `pytest tests/test_interaction.py::test_interaction_diagram_pure_compression_and_tension_match_hand_calc -q`

**Frontend build / typecheck**
```
cd apps/web && npm run build        # also runs TypeScript
cd apps/web && npx tsc --noEmit     # typecheck only, faster
```

**DB migrations** (apps/api, SQLite in dev)
```
../../.venv/Scripts/python.exe -m alembic revision --autogenerate -m "..."
../../.venv/Scripts/python.exe -m alembic upgrade head
```

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
independent of the API. When more of his existing OpenSeesPy scripts (modal, pushover,
nonlinear time-history, IDA — already written and validated by him elsewhere) get folded in,
they belong as new submodules under `packages/engine/src/engine/`, following the same pattern
as `analysis/interaction.py`, not rewritten into the API layer.

`packages/engine` internal layout:
- `materials/` — Mander (1988) confined/unconfined concrete, reinforcing steel. These produce
  *parameter objects* (`ConcreteMaterialParams`, `SteelMaterialParams`), not a duplicate
  stress-strain integrator — OpenSees does the actual fiber integration at analysis time.
- `sections/geometry.py` — `RectangularSection` / `CircularSection` / `PolygonSection`. Pure
  geometry, returns declarative patch/fiber specs (`RectPatchSpec`, `CircPatchSpec`,
  `PointFiberSpec`). No OpenSees import.
- `sections/reinforcement.py` — bar-pattern generators (perimeter rect, ring circular),
  producing explicit `PointFiberSpec` fibers rather than using OpenSees `layer()` helpers, so
  the exact same bar coordinates can be reused for the frontend's 2D section preview.
- `analysis/interaction.py` — the **only** module that imports `openseespy`. Builds the fiber
  section (materials + patches + bar fibers) and traces the full P-M interaction envelope by
  running moment-curvature at a swept range of constant axial loads (`zeroLengthSection` +
  `DisplacementControl`), taking the max moment reached at each level before
  non-convergence/failure. Rebuilds the whole OpenSees model from scratch (`ops.wipe()`) on
  every P-level — deliberate, to avoid OpenSees domain state leaking between runs.

`apps/api` — `app/engine_adapter.py` is the only file that knows both the HTTP schema
(`SectionCreate`) and the engine types; it's the translation boundary. `Section` rows persist
geometry/materials/reinforcement as three JSON blobs (shape-dependent — see `SectionCreate` in
`schemas.py` for which fields apply to which `shape_type`). Auth is a from-scratch JWT
implementation (`app/auth.py`, passlib+python-jose) — no external auth provider.

`apps/web` — Tailwind v4 CSS-first config (theme tokens live in `src/app/globals.css` `@theme`
block, not `tailwind.config.js`). Hand-rolled UI primitives in `src/components/ui/` (button,
card, input, badge) rather than shadcn/ui — deliberate, to avoid CLI compatibility risk against
the very-new Next 16 / Tailwind v4 / React 19 combination. Auth is a bare JWT-in-localStorage
scheme (`src/lib/auth.ts`); `src/lib/use-require-auth.ts` client-redirects unauthenticated
users. `src/lib/section-preview.ts` duplicates the rectangular/circular bar-placement math from
`engine/sections/reinforcement.py` in TypeScript purely for the live 2D preview — real
computation always happens server-side in the Python engine.

The dataviz chart (`src/components/interaction-chart.tsx`) is hand-built SVG, not a charting
library — no external chart dependency was added.

## Verification reference

For sanity-checking any change to the engine's interaction-diagram math, this case has a known
hand-calculated answer (ACI formulas): rectangular column 400x400mm, cover 40mm, 8-#8 bars,
f'c=28MPa, fy=420MPa, #3 ties @150mm, 2 legs each direction →
pure compression P ≈ 5424 kN, pure tension P ≈ -1714 kN, M_max ≈ 379 kN·m.
`packages/engine/tests/test_interaction.py` encodes this exact check.

## Current state / next steps

Foundational slice shipped: full auth flow, dashboard driven by the real product catalog, and
one complete working module — P-M interaction diagrams for rectangular/square/circular/special
sections. Verified end-to-end in a real browser, not just automated tests.

Not yet built (see `app/catalog.py` for the full roadmap with per-item status): model import
(ETABS/SAP2000/IFC), the other analysis engines (modal/pushover/time-history/IDA — owner has
working OpenSeesPy scripts for these to be integrated), biaxial P-M-M interaction, performance
evaluation, risk/fragility, and the decision-report generator. No background job queue yet
(Celery/RQ) — not needed until the longer-running analyses (pushover/IDA) are wired in.
