"""Smoke test de los endpoints de FEMA library sin TestClient."""
import os
os.environ.setdefault("JWT_SECRET", "test")

from app.routers.fema_library import list_pairs, get_record_preview, compute_scale, ScaleRequest
from app.db import SessionLocal
from app.models import User

# El decorador de FastAPI necesita un User — tomamos el primero de la DB.
with SessionLocal() as db:
    user = db.query(User).first()

# list_pairs
cat = list_pairs(user)
print("available:", cat["available"], "n_pairs:", len(cat["pairs"]))
p1 = cat["pairs"][0]
print(f'par 1: {p1["earthquake"]} Mw {p1["mw"]} - {p1["station"]}')
print(f'  pga H1 {p1["pga"][0]:.4f} · H2 {p1["pga"][1]:.4f} g')
print(f'  Sa(1.0s) geomean = {p1["spectra"]["geomean"][10]:.4f} g')

# preview
pr = get_record_preview("GM01", user, max_points=10)
print(f'preview GM01: n_full={pr["n_full"]} dt={pr["dt"]} pga={pr["pga"]:.4f}')
print(f'  t[:3]={pr["t"][:3]} a[:3]={pr["a"][:3]}')

# scale factor
sr = compute_scale(ScaleRequest(pair_id=1, T1_s=1.0, sa_target_g=0.5), user)
print(f'scale→Sa(T1=1s)=0.5g: factor={sr["scale"]:.3f}')
print(f'  Sa_geomean_unscaled={sr["sa_geomean_unscaled_g"]:.4f}  Sa_target={sr["sa_target_g"]:.4f}')
