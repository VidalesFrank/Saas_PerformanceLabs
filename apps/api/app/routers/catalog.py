from fastapi import APIRouter

from app.catalog import CATALOG

router = APIRouter(prefix="/api/v1/catalog", tags=["catalog"])


@router.get("")
def get_catalog() -> list[dict]:
    return CATALOG
