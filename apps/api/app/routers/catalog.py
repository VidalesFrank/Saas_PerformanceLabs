from fastapi import APIRouter, Depends, HTTPException
from fastapi.security.utils import get_authorization_scheme_param
from sqlalchemy.orm import Session
from starlette.requests import Request

from app.auth import oauth2_scheme  # noqa: F401 — mantiene el esquema registrado
from app.catalog import CATALOG
from app.config import settings
from app.db import get_db
from app.models import User
from app.schemas import allowed_modules_for
from jose import JWTError, jwt

router = APIRouter(prefix="/api/v1/catalog", tags=["catalog"])


def _optional_current_user(request: Request, db: Session = Depends(get_db)) -> User | None:
    """Resuelve el usuario si viene un Bearer valido; devuelve None si no hay
    header o si el token es invalido. No lanza 401 — el catalogo sigue siendo
    consultable anonimamente (comportamiento historico del endpoint)."""
    auth_header = request.headers.get("Authorization")
    if not auth_header:
        return None
    scheme, token = get_authorization_scheme_param(auth_header)
    if not token or scheme.lower() != "bearer":
        return None
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        user_id = payload.get("sub")
    except JWTError:
        return None
    if not user_id:
        return None
    return db.get(User, user_id)


def _product_allowed(product: dict, allowed_prefixes: list[str] | None) -> bool:
    """Un producto se muestra a colaboradores solo si su `route` (cuando existe)
    empieza con alguno de los prefijos permitidos. Productos sin ruta (idea)
    quedan ocultos para colaboradores — no sirven de nada sin acceso."""
    if allowed_prefixes is None:
        return True
    route = product.get("route")
    if not route:
        return False
    return any(route.startswith(prefix) for prefix in allowed_prefixes)


@router.get("")
def get_catalog(current_user: User | None = Depends(_optional_current_user)) -> list[dict]:
    allowed = allowed_modules_for(current_user.role) if current_user else None
    result: list[dict] = []
    for module in CATALOG:
        visible_products = [
            p for p in module["products"]
            if not p.get("hidden") and _product_allowed(p, allowed)
        ]
        if visible_products:
            result.append({**module, "products": visible_products})
    return result
