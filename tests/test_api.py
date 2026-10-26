from fastapi.testclient import TestClient

from backend.api import app

client = TestClient(app)  # no context manager: background threads and MQTT stay off


def test_root_and_config():
    assert client.get("/").json()["message"].startswith("Thalpos")
    t = client.get("/config").json()["thresholds"]
    assert t["HUMIDITY_LOW"] < t["HUMIDITY_HIGH"]


def test_invalid_thresholds_are_rejected():
    r = client.put("/config", json={"TEMP_LOW": 40})
    assert r.status_code == 422


def test_lamp_without_setup():
    assert client.get("/lamp").json()["enabled"] in (True, False)
    if not client.get("/lamp").json()["enabled"]:
        assert client.post("/lamp?on=true").status_code == 503


def test_history_endpoints():
    assert isinstance(client.get("/history/range?hours=1&step=300").json(), list)
    r = client.get("/history.csv?hours=1")
    assert r.status_code == 200 and r.text.startswith("time,room,temperature_c,humidity_pct")
    assert "attachment" in r.headers["content-disposition"]


def test_alert_history_endpoint():
    assert isinstance(client.get("/alerts/history?days=7").json(), list)
    assert client.get("/alerts/history?days=0").status_code == 422


def test_notification_settings(monkeypatch, tmp_path):
    from backend import api

    monkeypatch.setattr(api.preferences, "_path", str(tmp_path / "prefs.json"))
    before = client.get("/notifications").json()
    try:
        r = client.put("/notifications", json={"voice_quiet_hours": "22:00-07:30", "lamp_auto": False})
        assert r.status_code == 200
        assert r.json()["voice_quiet_hours"] == "22:00-07:30" and r.json()["lamp_auto"] is False
        assert client.put("/notifications", json={"voice_quiet_hours": "soon"}).status_code == 422
        assert client.put("/notifications", json={"volume": 5}).status_code == 422

        muted = client.post("/notifications/mute?minutes=60").json()["muted_until"]
        assert muted is not None
        assert client.delete("/notifications/mute").json()["muted_until"] is None
    finally:
        client.put("/notifications", json={k: before[k] for k in
                                           ("voice_on", "voice_quiet_hours", "lamp_auto", "lamp_quiet_hours")})


def test_presence_daily_endpoint():
    r = client.get("/presence/daily?days=3")
    assert r.status_code == 200
    body = r.json()
    assert len(body["days"]) == 3 and "in_now" in body


def test_sleep_endpoint():
    r = client.get("/sleep?nights=3")
    assert r.status_code == 200
    body = r.json()
    assert len(body["nights"]) == 3 and set(body["ideal"]) == {"temp_low", "temp_high", "hum_low", "hum_high"}
    assert all("tip" in n and "date" in n for n in body["nights"])
