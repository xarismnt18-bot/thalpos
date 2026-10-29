import json

import pytest

from ai.mqtt_client import InvalidPacket, SharedMQTTClient, parse_backlog
from backend.history_store import HistoryStore

NOW = 1_800_000_000.0


def message(rows, room="Bedroom"):
    return json.dumps({"room": room, "readings": rows})


def test_parse_backlog_turns_ages_into_times_oldest_first():
    room, rows = parse_backlog(message([[60, 21.5, 55.0, 1], [120, 21.4, 54.8, 0]]), NOW)
    assert room == "Bedroom"
    assert rows == [(NOW - 120, 21.4, 54.8, False), (NOW - 60, 21.5, 55.0, True)]


def test_parse_backlog_drops_bad_rows_only():
    _, rows = parse_backlog(message([[30, 21, 50, 1], [30, "NaN", 50, 1], [30, 21, 140, 0],
                                     [-5, 21, 50, 0], [10 ** 7, 21, 50, 0], "junk", [40, 22, 51]]), NOW)
    assert rows == [(NOW - 40, 22.0, 51.0, False), (NOW - 30, 21.0, 50.0, True)]


@pytest.mark.parametrize("raw", ["not json", "[1, 2]", '{"room": "x"}', '{"readings": 5}'])
def test_parse_backlog_rejects_non_backlogs(raw):
    with pytest.raises(InvalidPacket):
        parse_backlog(raw, NOW)


def test_backlog_does_not_touch_the_live_reading():
    client = SharedMQTTClient(broker="x", port=1, topic="smartroom/dht11")
    got = []
    client.on_backlog = lambda room, rows: got.append((room, rows))
    assert client.ingest_backlog(message([[90, 20.0, 50.0, 0]]), received=NOW) == 1
    assert got == [("Bedroom", [(NOW - 90, 20.0, 50.0, False)])]
    assert client.latest["temperature"] is None and client.history() == []
    assert client.backlog_topic == "smartroom/dht11/backlog"
    assert client.ingest_backlog("garbage") == 0 and client.latest["invalid_packets"] == 1


def test_store_backlog_readings_and_presence_runs(tmp_path):
    store = HistoryStore(str(tmp_path / "h.db"))
    start = NOW - 3600
    # an hour every 30 s: someone in for the first 20 min, out 10 min, in again for the last 30 min
    rows = [(start + i * 30, 20.0, 50.0, not (40 <= i < 60)) for i in range(120)]
    stored, visits = store.record_backlog("Bedroom", rows)
    assert stored == 120 and visits == 2
    assert len(store.rows(start, NOW)) == 120
    v = store.visits_between(start, NOW, now=NOW)
    assert v == [(start, start + 40 * 30), (start + 60 * 30, start + 120 * 30)]


def test_store_backlog_never_doubles_up(tmp_path):
    store = HistoryStore(str(tmp_path / "h.db"))
    start = NOW - 1800
    store.record({"sensor_online": True, "temperature": 25.0, "humidity": 60.0, "room": "Bedroom"}, ts=start)
    store.visit_started(start)
    store.visit_ended(start + 600)     # the radar already logged the first 10 minutes
    rows = [(start + i * 30, 20.0, 50.0, True) for i in range(60)]
    stored, visits = store.record_backlog("Bedroom", rows)
    assert stored == 59                # the reading already stored is kept as it was
    assert store.rows(start, start)[0][2] == 25.0
    # the backlog continues the visit the radar logged instead of starting a second one
    assert visits == 0 and store.visits_between(start, NOW, now=NOW) == [(start, start + 1800)]
    assert store.record_backlog("Bedroom", rows) == (0, 0)   # the same backlog twice changes nothing


def test_a_gap_in_the_backlog_ends_the_visit(tmp_path):
    store = HistoryStore(str(tmp_path / "h.db"))
    rows = [(NOW + i * 30, 20.0, 50.0, True) for i in range(10)] + [(NOW + 1200 + i * 30, 20.0, 50.0, True) for i in range(10)]
    assert store.record_backlog("Bedroom", rows) == (20, 2)


def test_backlog_chunks_make_one_visit(tmp_path):
    store = HistoryStore(str(tmp_path / "h.db"))
    rows = [(NOW + i * 30, 20.0, 50.0, True) for i in range(100)]
    for k in range(0, 100, 25):   # as the board sends it: 25 readings per message
        store.record_backlog("Bedroom", rows[k:k + 25])
    assert store.visits_between(NOW, NOW + 3600, now=NOW + 3600) == [(NOW, NOW + 100 * 30)]


def test_backlog_next_to_live_readings_is_not_stored_twice(tmp_path):
    """Firmware 3.4 sends its 30 s samples even while the backend stores its own
    live reading every 30 s, about 9 s apart: that must stay one reading per 30 s."""
    store = HistoryStore(str(tmp_path / "h.db"))
    start = NOW - 3600
    for i in range(60):   # the live writer, at :24.4 / :54.4
        store.record({"sensor_online": True, "temperature": 21.0, "humidity": 50.0, "room": "Bedroom"}, ts=start + 21.2 + i * 30)
    rows = [(start + i * 30, 21.0, 50.0, False) for i in range(120)]   # board samples at :03.2 / :33.2
    stored, _ = store.record_backlog("Bedroom", rows)
    # the first board sample (21 s before the first live one) and the second half hour,
    # where nothing was stored live; every other board sample sits 8.8 s from a live one
    assert stored == 1 + 59
    assert len(store.rows(start, NOW)) == 60 + 60
    ts = [r[0] for r in store.rows(start, NOW)]
    assert min(b - a for a, b in zip(ts, ts[1:])) >= 15


def test_prune_removes_readings_that_were_already_doubled(tmp_path):
    store = HistoryStore(str(tmp_path / "h.db"))
    for i in range(10):
        for offset in (0, 8.8):
            store.record({"sensor_online": True, "temperature": 21.0, "humidity": 50.0, "room": "Bedroom"}, ts=NOW - 600 + i * 30 + offset)
    store.prune(now=NOW)
    ts = [r[0] for r in store.rows(NOW - 700, NOW)]
    assert len(ts) == 10 and all(b - a == 30 for a, b in zip(ts, ts[1:]))
