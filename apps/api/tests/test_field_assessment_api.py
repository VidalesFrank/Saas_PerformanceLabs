"""Smoke tests del router Fase 0 (/api/v1/field-assessments)."""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _auth_headers(email: str = "field@example.com") -> dict:
    client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "supersecret1", "full_name": "Inspector"},
    )
    r = client.post(
        "/api/v1/auth/login", json={"email": email, "password": "supersecret1"}
    )
    token = r.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


# ── CRUD basico ──────────────────────────────────────────────────────────────


def test_field_assessments_requires_auth():
    r = client.get("/api/v1/field-assessments")
    assert r.status_code == 401


def test_create_and_list_assessment():
    h = _auth_headers("crud@example.com")

    r = client.post("/api/v1/field-assessments",
                    json={"title": "Torre A, Cra 15"}, headers=h)
    assert r.status_code == 201, r.text
    a = r.json()
    assert a["stage"] == "draft"
    assert a["sync_status"] == "synced"
    assert a["client_uuid"]

    r = client.get("/api/v1/field-assessments", headers=h)
    assert r.status_code == 200
    assert any(x["id"] == a["id"] for x in r.json())


def test_update_and_delete_assessment():
    h = _auth_headers("updel@example.com")
    r = client.post("/api/v1/field-assessments",
                    json={"title": "temp"}, headers=h)
    aid = r.json()["id"]

    r = client.patch(f"/api/v1/field-assessments/{aid}",
                     json={"title": "renombrado"}, headers=h)
    assert r.status_code == 200
    assert r.json()["title"] == "renombrado"

    r = client.delete(f"/api/v1/field-assessments/{aid}", headers=h)
    assert r.status_code == 204

    r = client.get(f"/api/v1/field-assessments/{aid}", headers=h)
    assert r.status_code == 404


def test_cannot_access_other_users_assessment():
    h1 = _auth_headers("owner@example.com")
    h2 = _auth_headers("stranger@example.com")

    r = client.post("/api/v1/field-assessments",
                    json={"title": "de otro"}, headers=h1)
    aid = r.json()["id"]

    r = client.get(f"/api/v1/field-assessments/{aid}", headers=h2)
    assert r.status_code == 403


# ── Snapshot as-built ─────────────────────────────────────────────────────────


def test_upsert_snapshot():
    h = _auth_headers("snap@example.com")
    r = client.post("/api/v1/field-assessments",
                    json={"title": "torre"}, headers=h)
    aid = r.json()["id"]

    payload = {
        "address_line": "Cra 15 #45-12",
        "city": "Bogotá",
        "year_built": 1998,
        "n_stories_above": 4,
        "total_height_m": 12.0,
        "structural_system": "rc_frame",
        "occupancy_use_nsr10": "II",
        "has_asbuilt_docs": True,
        "has_geotech_hazard": False,
    }
    r = client.put(f"/api/v1/field-assessments/{aid}/snapshot",
                   json=payload, headers=h)
    assert r.status_code == 200
    snap = r.json()["snapshot"]
    assert snap["structural_system"] == "rc_frame"
    assert snap["year_built"] == 1998


# ── Sub-flujo A: safety + placard ─────────────────────────────────────────────


def test_safety_evaluation_green_with_clean_input():
    h = _auth_headers("safety-green@example.com")
    r = client.post("/api/v1/field-assessments",
                    json={"title": "sin daño"}, headers=h)
    aid = r.json()["id"]

    payload = {
        "inspector_name": "Ing. Vidales",
        "hazards": {"checks": []},
        "component_damage": {"items": []},
        "access_condition": {
            "main_door": "ok", "emergency_exits": "ok",
            "stairs": "ok", "elevator_out_of_service": False,
        },
    }
    r = client.put(f"/api/v1/field-assessments/{aid}/safety",
                   json=payload, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["stage"] == "safety_done"
    assert body["safety_evaluation"]["placard"] == "green"


def test_safety_evaluation_red_on_collapse():
    h = _auth_headers("safety-red@example.com")
    r = client.post("/api/v1/field-assessments",
                    json={"title": "colapso"}, headers=h)
    aid = r.json()["id"]

    payload = {
        "hazards": {"checks": [{"code": "collapse", "response": "yes"}]},
        "component_damage": {"items": []},
        "access_condition": {},
    }
    r = client.put(f"/api/v1/field-assessments/{aid}/safety",
                   json=payload, headers=h)
    assert r.status_code == 200
    body = r.json()
    assert body["safety_evaluation"]["placard"] == "red"
    reasons = body["safety_evaluation"]["placard_reasons"]
    assert any("olapso" in x for x in reasons)


def test_safety_evaluation_yellow_on_d3_columns():
    h = _auth_headers("safety-yellow@example.com")
    r = client.post("/api/v1/field-assessments",
                    json={"title": "d3"}, headers=h)
    aid = r.json()["id"]

    payload = {
        "hazards": {"checks": []},
        "component_damage": {
            "items": [{"component": "columns", "level": "D3", "pct_affected": 30}]
        },
        "access_condition": {},
    }
    r = client.put(f"/api/v1/field-assessments/{aid}/safety",
                   json=payload, headers=h)
    assert r.status_code == 200
    assert r.json()["safety_evaluation"]["placard"] == "yellow"


def test_manual_override_can_escalate():
    h = _auth_headers("override@example.com")
    r = client.post("/api/v1/field-assessments",
                    json={"title": "manual"}, headers=h)
    aid = r.json()["id"]

    payload = {
        "hazards": {"checks": []},
        "component_damage": {"items": []},
        "access_condition": {},
        "manual_override": "red",
        "manual_override_reason": "riesgo por tanque",
    }
    r = client.put(f"/api/v1/field-assessments/{aid}/safety",
                   json=payload, headers=h)
    assert r.status_code == 200
    se = r.json()["safety_evaluation"]
    assert se["placard"] == "red"
    assert se["manual_override"] == "red"


# ── Sub-flujo B: triaje FEMA ─────────────────────────────────────────────────


def _create_with_snapshot(h, system="rc_frame"):
    r = client.post("/api/v1/field-assessments",
                    json={"title": "triage-test"}, headers=h)
    aid = r.json()["id"]
    client.put(f"/api/v1/field-assessments/{aid}/snapshot",
               json={"structural_system": system}, headers=h)
    return aid


def test_triage_requires_snapshot():
    h = _auth_headers("triage-nosnap@example.com")
    r = client.post("/api/v1/field-assessments",
                    json={"title": "sin snapshot"}, headers=h)
    aid = r.json()["id"]

    r = client.post(f"/api/v1/field-assessments/{aid}/triage",
                    json={}, headers=h)
    assert r.status_code == 400


def test_triage_not_applicable_for_urm():
    h = _auth_headers("triage-urm@example.com")
    aid = _create_with_snapshot(h, system="urm")

    r = client.post(f"/api/v1/field-assessments/{aid}/triage",
                    json={"stories": []}, headers=h)
    assert r.status_code == 200
    tr = r.json()["triage_result"]
    assert tr["decision"] == "not_applicable"
    assert tr["applicability_ok"] is False


def test_triage_exceptional_flag_forces_high_risk():
    h = _auth_headers("triage-exc@example.com")
    aid = _create_with_snapshot(h)

    r = client.post(
        f"/api/v1/field-assessments/{aid}/triage",
        json={
            "exceptional_flags": {"extreme_torsion": True},
            "stories": [],
        }, headers=h,
    )
    assert r.status_code == 200
    tr = r.json()["triage_result"]
    assert tr["decision"] == "high_risk"
    assert tr["building_rating"] >= 0.7


def test_triage_healthy_building_low_risk():
    h = _auth_headers("triage-low@example.com")
    aid = _create_with_snapshot(h)

    story = {
        "index": 1, "height_m": 3.0, "direction": "X",
        "components": [
            {"tag": "C1", "kind": "column",
             "delta_D": 0.10, "delta_C_base": 2.0, "damage": "D0"}
        ],
    }
    r = client.post(
        f"/api/v1/field-assessments/{aid}/triage",
        json={"stories": [story]}, headers=h,
    )
    assert r.status_code == 200
    tr = r.json()["triage_result"]
    assert tr["decision"] == "low_risk"
    assert tr["building_rating"] <= 0.30
    # El stage debe subir a triage_done.
    assert r.json()["stage"] == "triage_done"


def test_triage_asce41_candidate_at_capacity():
    h = _auth_headers("triage-mid@example.com")
    aid = _create_with_snapshot(h)

    r = client.post(
        f"/api/v1/field-assessments/{aid}/triage",
        json={
            "stories": [{
                "index": 1, "height_m": 3.0, "direction": "X",
                "components": [{"tag": "C1", "kind": "column",
                                "delta_D": 1.0, "delta_C_base": 1.0, "damage": "D0"}],
            }]
        }, headers=h,
    )
    assert r.status_code == 200
    tr = r.json()["triage_result"]
    assert tr["decision"] == "asce41_candidate"
    assert 0.30 < tr["building_rating"] < 0.70


def test_triage_wsi_shortcut_low_risk():
    h = _auth_headers("triage-wsi@example.com")
    aid = _create_with_snapshot(h, system="rc_wall")

    r = client.post(
        f"/api/v1/field-assessments/{aid}/triage",
        json={
            "shortcut": {
                "area_walls_x_m2": 3.0,
                "area_walls_y_m2": 3.0,
                "seismic_weight_kN": 50.0,
            },
            "stories": [],
        }, headers=h,
    )
    assert r.status_code == 200
    tr = r.json()["triage_result"]
    assert tr["decision"] == "low_risk"
    assert tr["shortcut_applied"] == "wsi"


def test_delete_triage_regresses_stage():
    h = _auth_headers("triage-del@example.com")
    aid = _create_with_snapshot(h)

    client.post(
        f"/api/v1/field-assessments/{aid}/triage",
        json={"stories": []}, headers=h,
    )
    r = client.delete(f"/api/v1/field-assessments/{aid}/triage", headers=h)
    assert r.status_code == 204

    r = client.get(f"/api/v1/field-assessments/{aid}", headers=h)
    body = r.json()
    assert body["triage_result"] is None
    assert body["stage"] == "safety_done"
