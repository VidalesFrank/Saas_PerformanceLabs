import os
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # ── Core ──────────────────────────────────────────────────────────────────
    database_url: str = "sqlite:///./performancelabs.db"
    jwt_secret: str = "dev-secret-change-me"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60 * 24 * 7
    cors_origins: list[str] = ["http://localhost:3000"]

    # ── Celery / Redis ────────────────────────────────────────────────────────
    redis_url: str = "redis://localhost:6379/0"

    @property
    def celery_broker_url(self) -> str:
        return self.redis_url

    @property
    def celery_result_backend(self) -> str:
        return self.redis_url

    # ── Almacenamiento de archivos ────────────────────────────────────────────
    # BASE_DATA_DIR: directorio raíz de datos, relativo al CWD del proceso API.
    # En Docker el worker monta el mismo volumen en /app/data.
    base_data_dir: str = "./data"

    @property
    def upload_dir(self) -> str:
        path = os.path.join(self.base_data_dir, "uploads")
        os.makedirs(path, exist_ok=True)
        return path

    @property
    def output_dir(self) -> str:
        path = os.path.join(self.base_data_dir, "outputs")
        os.makedirs(path, exist_ok=True)
        return path

    @property
    def records_dir(self) -> str:
        """Registros sísmicos FEMA P-695 (44 archivos .txt)."""
        return os.path.join(self.base_data_dir, "records", "fema_records")


settings = Settings()
