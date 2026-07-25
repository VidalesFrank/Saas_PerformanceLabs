"""Redirige la app a una base de datos SQLite temporal ANTES de que se importe
`app.db` (que crea el engine/session al nivel de modulo). Debe ejecutarse en la
importacion de este conftest, no dentro de un fixture, para ganarle a la
recoleccion de tests de pytest.
"""
import os
import tempfile

_fd, _db_path = tempfile.mkstemp(suffix=".db")
os.close(_fd)
os.environ["DATABASE_URL"] = f"sqlite:///{_db_path}"

from app import models  # noqa: E402,F401 (registra los modelos en Base.metadata)
from app.db import Base, engine  # noqa: E402

Base.metadata.create_all(bind=engine)
