"""
Sleep page: how the bedroom was while you slept, night by night.

The night is found from the radar: the stay in the room that covers the small
hours (SLEEP_CORE, 01:00-05:00), with short trips out (up to MERGE_GAP_SEC)
counted as interruptions rather than the end of the night. Without radar data
for a night, a fixed FALLBACK window (23:00-07:00) is used and marked
"estimated". Nights with too few stored readings are reported as missing, so
a laptop that slept through the night never produces a made-up score.

The score rates the room, not your sleep: 100 means every reading was inside
the ideal sleeping range (16-20 degC, 40-60 % humidity by default); each
degree or humidity point outside it costs points, as the comments below say.
"""
from datetime import date, datetime, time as dtime, timedelta

from backend.history_store import HistoryStore

SLEEP_CORE = (dtime(1, 0), dtime(5, 0))
SEARCH_FROM = dtime(18, 0)   # a night that ends on day D starts looking at 18:00 on D-1 ...
SEARCH_TO = dtime(13, 0)     # ... and stops at 13:00 on D
FALLBACK = (dtime(23, 0), dtime(7, 0))
MERGE_GAP_SEC = 20 * 60      # a gap shorter than this is a trip out, not the end of the night
INTERRUPTION_SEC = 3 * 60    # gaps at least this long count as "left the room"
MIN_NIGHT_SEC = 2 * 3600
MIN_COVERAGE = 0.5           # share of the night that must have stored readings
STEP_SEC = 600               # chart resolution: 10-minute averages

TEMP_POINTS = 10   # score points lost per degree outside the ideal range (at most 50)
HUM_POINTS = 2.5   # ... per humidity point outside it (at most 50)


def _at(day: date, t: dtime) -> float:
    return datetime.combine(day, t).timestamp()


def _merge(visits: list[tuple[float, float]]) -> list[list]:
    """Visits -> stays: [start, end, pieces], joining gaps shorter than MERGE_GAP_SEC."""
    stays: list[list] = []
    for s, e in sorted(visits):
        if stays and s - stays[-1][1] <= MERGE_GAP_SEC:
            last = stays[-1]
            if s - last[1] >= INTERRUPTION_SEC:
                last[2] += 1
            last[1] = max(last[1], e)
        else:
            stays.append([s, e, 0])
    return stays


def _reading_score(temp: float, hum: float, ideal: dict) -> float:
    t_out = max(ideal["temp_low"] - temp, temp - ideal["temp_high"], 0)
    h_out = max(ideal["hum_low"] - hum, hum - ideal["hum_high"], 0)
    return 100 - min(t_out * TEMP_POINTS, 50) - min(h_out * HUM_POINTS, 50)


def night_report(store: HistoryStore, morning: date, ideal: dict, now: float) -> dict:
    """The night that ends on the morning of `morning`."""
    lo, hi = _at(morning - timedelta(days=1), SEARCH_FROM), min(_at(morning, SEARCH_TO), now)
    core_lo, core_hi = _at(morning, SLEEP_CORE[0]), _at(morning, SLEEP_CORE[1])
    out = {"date": morning.isoformat(), "source": None, "score": None}
    if hi <= core_lo:
        return {**out, "missing": "not yet"}

    stays = _merge(store.visits_between(lo, hi, now))
    best = max(stays, key=lambda st: max(0.0, min(st[1], core_hi) - max(st[0], core_lo)), default=None)
    if best and min(best[1], core_hi) > max(best[0], core_lo) and best[1] - best[0] >= MIN_NIGHT_SEC:
        start, end, interruptions, source = max(best[0], lo), min(best[1], hi), best[2], "radar"
    else:
        start, end, interruptions, source = _at(morning - timedelta(days=1), FALLBACK[0]), _at(morning, FALLBACK[1]), None, "estimated"
        end = min(end, hi)

    rows = store.rows(start, end)
    expected = (end - start) / 30  # the history stores a reading every 30 s
    if not rows or len(rows) < MIN_COVERAGE * expected:
        return {**out, "source": source, "start": start, "end": end, "missing": "no readings"}

    temps, hums = [r[2] for r in rows], [r[3] for r in rows]
    too = {"warm": 0, "cold": 0, "humid": 0, "dry": 0}
    for t, h in zip(temps, hums):
        too["warm"] += t > ideal["temp_high"]
        too["cold"] += t < ideal["temp_low"]
        too["humid"] += h > ideal["hum_high"]
        too["dry"] += h < ideal["hum_low"]
    minutes_per_row = (end - start) / 60 / len(rows)
    score = sum(_reading_score(t, h, ideal) for t, h in zip(temps, hums)) / len(rows)
    return {
        **out,
        "source": source,
        "start": start,
        "end": end,
        "minutes": round((end - start) / 60),
        "interruptions": interruptions,
        "score": round(score),
        "temperature": {"avg": round(sum(temps) / len(temps), 1), "min": min(temps), "max": max(temps)},
        "humidity": {"avg": round(sum(hums) / len(hums), 1), "min": min(hums), "max": max(hums)},
        "minutes_outside": {k: round(v * minutes_per_row) for k, v in too.items()},
        "series": store.series(start, STEP_SEC, end),
    }


def sleep_nights(store: HistoryStore, nights: int, ideal: dict, now: float | None = None) -> list[dict]:
    """The last `nights` nights, newest first. Tonight counts once 01:00 has passed."""
    now = now or datetime.now().timestamp()
    today = datetime.fromtimestamp(now).date()
    first = today if now >= _at(today, SLEEP_CORE[0]) else today - timedelta(days=1)
    return [night_report(store, first - timedelta(days=i), ideal, now) for i in range(nights)]


def tip(night: dict, ideal: dict) -> str | None:
    """One practical line about the biggest problem of the night."""
    if night.get("score") is None:
        return None
    worst = max(night["minutes_outside"].items(), key=lambda kv: kv[1])
    if worst[1] < 30:
        return "The room stayed in the ideal range for sleeping."
    hours = f"{worst[1] / 60:.1f} h"
    return {
        "warm": f"Too warm for {hours}: cool the room before bed (air it, or the AC around {ideal['temp_high']:g} °C).",
        "cold": f"Too cold for {hours}: warm the room a little before bed, or add a blanket.",
        "humid": f"Too humid for {hours}: air the room before bed, and a dehumidifier would help.",
        "dry": f"Too dry for {hours}: a bowl of water or a humidifier would help.",
    }[worst[0]]
