from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    database_url: str = "sqlite:///./performancelabs.db"
    jwt_secret: str = "dev-secret-change-me"  # sobreescribir via .env / variable de entorno en produccion
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60 * 24 * 7  # 7 dias
    cors_origins: list[str] = ["http://localhost:3000"]


settings = Settings()
