---
name: env-openseespy-windows-python312
description: "El venv local en Windows debe crearse con Python 3.12, no 3.11 — openseespywin solo funciona con 3.12"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 01f0eb4f-257e-400c-9f99-6f0b131f931e
  modified: 2026-09-05T17:13:54.542Z
---

En Windows nativo (fuera de Docker), `openseespywin` (dependencia de `openseespy`, instalada
por `packages/engine/pyproject.toml` vía `openseespy>=3.7`) publica un wheel en PyPI
etiquetado `py3-none-any` — pip lo instala bajo cualquier versión de Python sin quejarse —
pero el `.pyd` compilado dentro solo enlaza con **python312.dll** (confirmado inspeccionando
sus imports con `pefile`). Bajo un venv de Python 3.11 falla así:

```
ImportError: DLL load failed while importing opensees: No se puede encontrar el módulo especificado.
RuntimeError: Failed to import openseespy on Windows.
```

Esto NO es un problema de Visual C++ Redistributable (ya estaba instalado) — es un
mismatch de ABI de CPython. El Dockerfile de producción usa `python:3.11-slim`
(ver CLAUDE.md, sección Docker) pero ahí corre Linux, que usa `openseespylinux` — un
paquete distinto, correctamente empaquetado para 3.11. El problema es solo del venv local
en Windows.

Consecuencia grave: `apps/api/app/main.py` importa `routers/sections.py` a nivel de módulo,
que a su vez importa `packages/engine/.../analysis/interaction.py`, que hace
`import openseespy.opensees as ops` a nivel de módulo. Si ese import falla, **toda la API
FastAPI falla al arrancar** (`uvicorn` crashea antes de levantar), no solo las rutas que
usan OpenSees — incluyendo ground-motion, seismic, auth, todo.

**Why:** CLAUDE.md dice recrear el venv con `python -m venv .venv` sin especificar versión;
si el `python` del PATH resuelve a 3.11 (o cualquier intérprete que no sea 3.12), la API
completa queda rota en silencio salvo que se intente arrancar `uvicorn` y se lea el
traceback completo.
**How to apply:** al recrear `.venv` en una máquina Windows nueva, usar explícitamente el
intérprete 3.12: `py -3.12 -m venv .venv` (o la ruta completa al python3.12.exe). Verificar
con `.venv\Scripts\python.exe -c "import openseespy.opensees"` antes de asumir que el
entorno está listo. Ver [[project_ground_motion_module]] (donde se descubrió este problema
al intentar reproducir un bug de importación de acelerogramas).
