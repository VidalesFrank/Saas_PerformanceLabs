from fastapi import APIRouter

from app.catalog import CATALOG

router = APIRouter(prefix="/api/v1/catalog", tags=["catalog"])


@router.get("")
def get_catalog() -> list[dict]:
    result = []
    for module in CATALOG:
        visible_products = [p for p in module["products"] if not p.get("hidden")]
        if visible_products:
            result.append({**module, "products": visible_products})
    return result
