import io
import json
from datetime import datetime
from unittest import mock

from backend import voice as V
from conftest import FakeSensor, FakeSettings, reading


def test_quiet_hours_wrap_midnight():
    q = "23:00-08:00"
    assert V.in_quiet_hours(datetime(2026, 1, 1, 23, 30), q)
    assert V.in_quiet_hours(datetime(2026, 1, 1, 7, 59), q)
    assert not V.in_quiet_hours(datetime(2026, 1, 1, 8, 0), q)
    assert not V.in_quiet_hours(datetime(2026, 1, 1, 12, 0), "")


def test_spoken_text_has_no_emoji(thresholds):
    text = V.spoken("humidity_high", reading(hum=82.4), thresholds)
    assert "82 percent" in text and text.isascii()


def test_status_sentence(thresholds):
    assert V.status_sentence(reading(21.44, 55), thresholds) == (
        "The bedroom is 21.4 degrees, with 55 percent humidity. Everything is in the comfort range.")
    assert "dehumidifier" in V.status_sentence(reading(hum=80), thresholds)
    assert "no live readings" in V.status_sentence(reading(online=False, age=400), thresholds)


class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        pass


def test_publisher_pushes_only_changes(thresholds):
    calls = []

    def fake_urlopen(req, timeout):
        calls.append(json.loads(req.data))
        assert "Thalpos" in req.headers["User-agent"]  # Cloudflare blocks Python's default UA
        return _Resp(b'{"success": true}')

    sensor = FakeSensor(reading(22, 50))
    p = V.VoiceStatusPublisher(V.VoiceAnnouncer("tok", "dev", ""), sensor, FakeSettings(thresholds), "THALPOS_STATUS", 60)
    with mock.patch("urllib.request.urlopen", fake_urlopen):
        assert p.publish() and not p.publish()
        sensor.latest = reading(23, 50)
        assert p.publish()
        p.stop()  # never started: must not spend a request
    assert len(calls) == 2 and calls[0]["variable"] == "THALPOS_STATUS"


def test_voice_budget():
    v = V.VoiceAnnouncer("tok", "dev", "")
    t0 = datetime(2026, 10, 20, 10, 0)
    assert v.should_speak("humidity_high", t0)
    v.spoke("humidity_high", t0)
    assert not v.should_speak("humidity_high", t0.replace(hour=15))  # same alert within 6 h
    assert v.should_speak("humidity_high", t0.replace(hour=16, minute=1))
    for i in range(4):
        v.spoke(f"k{i}", t0)
    assert not v.should_speak("temp_high", t0.replace(hour=17))  # 5 a day
    assert v.should_speak("temp_high", datetime(2026, 10, 21, 10, 0))  # new day


# ---------- free-plan "bedroom status": timed snapshots, a few a day ----------
def _economy(thresholds, sensor, tmp_path=None, voice=None):
    calls = []
    voice = voice or V.VoiceAnnouncer("tok", "dev", "")
    voice.set_variable = lambda name, value: calls.append(value)
    path = str(tmp_path / "vs.json") if tmp_path else None
    p = V.EconomyStatusPublisher(voice, sensor, FakeSettings(thresholds), "THALPOS_STATUS", 60, state_path=path)
    return p, calls


def test_snapshot_sentence_says_when(thresholds):
    s = V.snapshot_sentence(reading(23.4, 61), thresholds, datetime(2026, 10, 26, 16, 0))
    assert s.startswith("At 4 PM the bedroom was 23 degrees, with 61 percent humidity.")
    assert "comfort range" in s and "slash status" in s
    s = V.snapshot_sentence(reading(23.4, 76), thresholds, datetime(2026, 10, 26, 9, 35))
    assert s.startswith("At 9:35 AM") and "above your limit of 70" in s


def test_economy_updates_only_on_change(thresholds):
    sensor = FakeSensor(reading(22, 50))
    p, calls = _economy(thresholds, sensor)
    t = datetime(2026, 10, 26, 9, 0)
    assert p.publish(now=t)                                   # first: state unknown -> sent
    assert not p.publish(now=t.replace(minute=5))             # nothing changed
    sensor.latest = reading(22.8, 54)
    assert not p.publish(now=t.replace(hour=14))              # small drift: not worth a request
    sensor.latest = reading(24.0, 50)
    assert not p.publish(now=t.replace(hour=11))              # moved, but less than 4 h since the last
    assert p.publish(now=t.replace(hour=14))                  # moved and 5 h later
    sensor.latest = reading(24.0, 75)
    assert p.publish(now=t.replace(hour=14, minute=10))       # humid: a change of state, sent at once
    assert len(calls) == 3


def test_economy_daily_cap_and_last_slot_for_state_changes(thresholds):
    sensor = FakeSensor(reading(22, 50))
    p, calls = _economy(thresholds, sensor)
    t = datetime(2026, 10, 26, 8, 0)
    assert p.publish(now=t)
    sensor.latest = reading(25, 50)
    assert p.publish(now=t.replace(hour=13))                  # 2nd: moved after 5 h
    sensor.latest = reading(20, 50)
    assert not p.publish(now=t.replace(hour=18))              # 3rd is kept for a change of state
    sensor.latest = reading(20, 80)
    assert p.publish(now=t.replace(hour=18, minute=5))        # humid -> uses the last one
    sensor.latest = reading(20, 50)
    assert not p.publish(now=t.replace(hour=19))              # cap reached for today
    assert p.publish(now=datetime(2026, 10, 27, 8, 0))        # new day
    assert len(calls) == 4


def test_economy_shares_the_budget_with_spoken_alerts(thresholds):
    voice = V.VoiceAnnouncer("tok", "dev", "")
    t = datetime(2026, 10, 26, 8, 0)
    for i in range(5):
        voice.spoke(f"k{i}", t)
    sensor = FakeSensor(reading(22, 50))
    p, calls = _economy(thresholds, sensor, voice=voice)
    assert p.publish(now=t)                                   # 5 alerts + 1 status = 6
    sensor.latest = reading(22, 80)
    assert not p.publish(now=t.replace(hour=9))               # the shared daily budget is spent
    assert len(calls) == 1


def test_economy_counts_survive_a_restart_and_shutdown_is_free(thresholds, tmp_path):
    sensor = FakeSensor(reading(22, 50))
    p, calls = _economy(thresholds, sensor, tmp_path)
    t = datetime.now().replace(hour=9, minute=0)
    assert p.publish(now=t)
    p.stop()
    p2, calls2 = _economy(thresholds, sensor, tmp_path)
    assert not p2.publish(now=t.replace(minute=30))           # same state, remembered
    assert p2.text.startswith("At 9 AM")
    assert calls2 == [] and len(calls) == 1
