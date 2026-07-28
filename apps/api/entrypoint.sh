#!/bin/bash
set -e

# Corre migraciones solo para el servicio api, no para el worker
if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
    echo "[entrypoint] Ejecutando migraciones Alembic..."
    alembic upgrade head
    echo "[entrypoint] Migraciones completadas."
fi

exec "$@"
