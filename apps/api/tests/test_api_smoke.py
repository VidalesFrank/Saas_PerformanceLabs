from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

RECT_COLUMN_PAYLOAD = {
    "name": "Columna C1 40x40",
    "shape_type": "rectangular",
    "width": 400, "height": 400, "cover": 40,
    "fpc": 28.0, "fy": 420.0, "es": 200_000.0,
    "hoop_bar_diameter": 9.5, "hoop_spacing": 150,
    "hoop_legs_x": 2, "hoop_legs_y": 2, "hoop_leg_area": 71.0,
    "bar_id": "#8", "n_bars_y": 3, "n_bars_z": 3, "cover_to_bar_centroid": 52,
}


def _auth_headers(email: str = "ing@example.com") -> dict:
    client.post("/api/v1/auth/register", json={"email": email, "password": "supersecret1", "full_name": "Ing. Test"})
    r = client.post("/api/v1/auth/login", json={"email": email, "password": "supersecret1"})
    token = r.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def test_health():
    r = client.get("/api/v1/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_catalog_has_six_modules():
    r = client.get("/api/v1/catalog")
    assert r.status_code == 200
    assert len(r.json()) == 6


def test_register_login_me():
    headers = _auth_headers("auth-test@example.com")
    r = client.get("/api/v1/auth/me", headers=headers)
    assert r.status_code == 200
    assert r.json()["email"] == "auth-test@example.com"
    assert r.json()["plan"] == "free"


def test_protected_route_requires_auth():
    r = client.get("/api/v1/sections")
    assert r.status_code == 401


def test_create_section_and_run_interaction_diagram():
    headers = _auth_headers("interaction-test@example.com")

    r = client.post("/api/v1/sections", json=RECT_COLUMN_PAYLOAD, headers=headers)
    assert r.status_code == 201
    section_id = r.json()["id"]

    r = client.post(f"/api/v1/sections/{section_id}/interaction-diagram", headers=headers)
    assert r.status_code == 200
    data = r.json()

    assert len(data["points"]) > 10
    assert data["points"][0]["M"] == 0.0
    assert data["points"][-1]["M"] == 0.0
    assert data["points"][0]["P"] > 0  # compresion pura
    assert data["points"][-1]["P"] < 0  # tension pura
    assert data["result_metadata"]["m_max"] > 50e6  # > 50 kN*m

    r = client.get("/api/v1/sections", headers=headers)
    assert r.status_code == 200
    assert len(r.json()) == 1
