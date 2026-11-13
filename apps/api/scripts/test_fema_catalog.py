from app.engine.building.fema_catalog import (
    FEMA_PAIRS, library_available, get_catalog, compute_scale_for_pair,
)

print("available:", library_available())
cat = get_catalog()
p1 = cat["pairs"][0]
print("par 1:", p1["earthquake"], "Mw", p1["mw"], "station", p1["station"])
print(f'pga H1 {p1["pga"][0]:.4f} g | pga H2 {p1["pga"][1]:.4f} g')
print(f'dur H1 {p1["duration_s"][0]:.1f} s | dur H2 {p1["duration_s"][1]:.1f} s')
print(f'Sa(1.0s) geomean: {p1["spectra"]["geomean"][10]:.4f} g')
res = compute_scale_for_pair(1, T1_s=1.0, sa_target_g=0.5)
print(f'scale para par 1 → Sa(T1=1s)=0.5g: {res.scale:.3f}')
print(f'  Sa_geomean sin escalar: {res.sa_geomean_unscaled:.4f} g')
