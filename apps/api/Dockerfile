FROM python:3.11-slim

# ── Dependencias de sistema ───────────────────────────────────────────────────
# - LAPACK / OpenMP: numpy, openseespy
# - OpenGL + libs FLTK: libgmsh.so (transitivo de opstool) necesita estas en runtime
# - Tk / Tcl: opstool.pre.tcl2py importa tkinter
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgfortran5 libgomp1 libopenblas0 libquadmath0 curl \
        libglu1-mesa libgl1 \
        libx11-6 libxext6 libxrender1 libxinerama1 libxrandr2 \
        libxcursor1 libxfixes3 libxi6 libxft2 \
        libfontconfig1 libfreetype6 \
        libtk8.6 libtcl8.6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── 1) Engine package ─────────────────────────────────────────────────────────
COPY packages/engine /packages/engine
RUN pip install --no-cache-dir /packages/engine

# ── 2) Dependencias de la API ─────────────────────────────────────────────────
COPY apps/api/requirements.txt /tmp/requirements.txt
RUN grep -v "^-e " /tmp/requirements.txt | pip install --no-cache-dir -r /dev/stdin

# ── 3) psycopg2 para PostgreSQL en producción ─────────────────────────────────
RUN pip install --no-cache-dir psycopg2-binary==2.9.9

# ── 4) Parchear opstool para operación headless ───────────────────────────────
# opstool importa gmsh (necesita X11) y tkinter al iniciarse, aunque solo usamos
# opst.pre.transform_surface_uniform_load (pure numpy, en _load.py).
# Se envuelven los imports problemáticos en try/except para que el módulo cargue.
COPY apps/api/patch_opstool.py /tmp/patch_opstool.py
RUN python3 /tmp/patch_opstool.py

# ── 5) Código de la aplicación ────────────────────────────────────────────────
COPY apps/api /app

# ── 6) Entrypoint ─────────────────────────────────────────────────────────────
COPY apps/api/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
