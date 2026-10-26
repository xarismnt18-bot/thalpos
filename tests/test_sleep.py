from datetime import date, datetime, timedelta

import pytest

from backend.history_store import HistoryStore
from backend.sleep import night_report, sleep_nights, tip
from conftest import reading

IDEAL = {"temp_low": 16, "temp_high": 20, "hum_low": 40, "hum_high": 60}
MORNING = date(2026, 10, 27)


def at(day_offset: int, hh: int, mm: int = 0) -> float:
    """A time on the night before MORNING (day_offset -1) or on MORNING (0)."""
    return datetime.combine(MORNING + timedelta(days=day_offset), datetime.min.time()).timestamp() + hh * 3600 + mm * 60


@pytest.fixture
def store(tmp_path):
    return HistoryStore(str(tmp_path / "h.db"))


def fill(store, start, end, temp=18.0, hum=50.0):
    ts = start
    while ts <= end:
        store.record(reading(temp, hum), ts=ts)
        ts += 30


def visit(store, start, end):
    store.visit_started(start)
    store.visit_ended(end)


def test_night_from_the_radar_with_a_trip_out(store):
    fill(store, at(-1, 20), at(0, 10))
    visit(store, at(-1, 23, 30), at(0, 3, 0))
    visit(store, at(0, 3, 8), at(0, 7, 15))  # 8 minutes out (bathroom): same night, one interruption
    n = night_report(store, MORNING, IDEAL, now=at(0, 12))
    assert n["source"] == "radar"
    assert n["start"] == at(-1, 23, 30) and n["end"] == at(0, 7, 15)
    assert n["minutes"] == 7 * 60 + 45 and n["interruptions"] == 1
    assert n["score"] == 100 and n["minutes_outside"]["warm"] == 0
    assert n["series"] and n["temperature"]["avg"] == 18.0


def test_evening_visit_is_not_the_night(store):
    fill(store, at(-1, 18), at(0, 10))
    visit(store, at(-1, 19), at(-1, 22))       # evening at the desk
    visit(store, at(0, 0, 10), at(0, 6, 50))   # the night
    n = night_report(store, MORNING, IDEAL, now=at(0, 12))
    assert n["start"] == at(0, 0, 10) and n["end"] == at(0, 6, 50)


def test_without_radar_the_night_is_estimated(store):
    fill(store, at(-1, 22), at(0, 8))
    n = night_report(store, MORNING, IDEAL, now=at(0, 12))
    assert n["source"] == "estimated" and n["interruptions"] is None
    assert n["start"] == at(-1, 23) and n["end"] == at(0, 7)


def test_a_laptop_asleep_all_night_gives_no_score(store):
    fill(store, at(-1, 20), at(-1, 23, 30))  # readings stop when the laptop goes to sleep
    n = night_report(store, MORNING, IDEAL, now=at(0, 12))
    assert n["score"] is None and n["missing"] == "no readings"
    assert tip(n, IDEAL) is None


def test_score_and_tip_for_a_warm_humid_night(store):
    fill(store, at(-1, 22), at(0, 8), temp=23.0, hum=67.0)  # 3 degrees and 7 points outside
    n = night_report(store, MORNING, IDEAL, now=at(0, 12))
    assert n["score"] == round(100 - 3 * 10 - 7 * 2.5)
    assert n["minutes_outside"]["warm"] == pytest.approx(480, abs=2)
    assert tip(n, IDEAL).startswith("Too warm for 8.0 h")


def test_nights_list_newest_first_and_tonight_after_one_am(store):
    nights = sleep_nights(store, 3, IDEAL, now=at(0, 0, 30))  # 00:30: last night is still going on
    assert [n["date"] for n in nights] == ["2026-10-26", "2026-10-25", "2026-10-24"]
    nights = sleep_nights(store, 3, IDEAL, now=at(0, 1, 30))
    assert nights[0]["date"] == "2026-10-27"
