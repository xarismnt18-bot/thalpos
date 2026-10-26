"""
Long-term reading history in SQLite (data/history.db), plus the alert log
(when each alert started and cleared) shown on the dashboard's Alerts page,
and the visits (when someone was in the room, from the radar).

The MQTT client keeps only the last few hundred packets in memory, so a
background thread stores the live reading every SAMPLE_SEC seconds and keeps
KEEP_DAYS days. Readings are only stored while the sensor is online, so a gap
in the data means the sensor (or the PC) was off.
"""
import csv
import io
import logging
import os
import sqlite3
import threading
import time
from datetime import date, datetime, timedelta

logger = logging.getLogger(__name__)

SAMPLE_SEC = 30
KEEP_DAYS = 30
STUCK_HOURS = 3  # an unchanged reading for this long suggests a stuck sensor


class HistoryStore:
    def __init__(self, path: str):
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._lock = threading.Lock()
        with self._lock, self._db:
            self._db.execute(
                "CREATE TABLE IF NOT EXISTS readings (ts REAL PRIMARY KEY, room TEXT, temperature REAL, humidity REAL)"
            )
            self._db.execute(
                "CREATE TABLE IF NOT EXISTS alert_events (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, "
                "message TEXT, started REAL NOT NULL, ended REAL, notified INTEGER NOT NULL DEFAULT 0)"
            )
            self._db.execute(
                "CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY AUTOINCREMENT, started REAL NOT NULL, ended REAL)"
            )
        self._stop = threading.Event()

    # ---------- writing ----------
    def record(self, latest: dict, ts: float | None = None) -> bool:
        temp, hum = latest.get("temperature"), latest.get("humidity")
        if not latest.get("sensor_online") or temp is None or hum is None:
            return False
        with self._lock, self._db:
            self._db.execute("INSERT OR REPLACE INTO readings VALUES (?, ?, ?, ?)",
                             (ts or time.time(), latest.get("room"), temp, hum))
        return True

    def prune(self, now: float | None = None) -> None:
        cutoff = (now or time.time()) - KEEP_DAYS * 86400
        with self._lock, self._db:
            self._db.execute("DELETE FROM readings WHERE ts < ?", (cutoff,))
            self._db.execute("DELETE FROM alert_events WHERE ended IS NOT NULL AND ended < ?", (cutoff,))
            self._db.execute("DELETE FROM visits WHERE ended IS NOT NULL AND ended < ?", (cutoff,))

    # ---------- alert log ----------
    def alert_started(self, key: str, message: str, ts: float | None = None) -> None:
        """Opens an event for `key` unless one is already open."""
        with self._lock, self._db:
            if self._db.execute("SELECT 1 FROM alert_events WHERE key = ? AND ended IS NULL", (key,)).fetchone():
                return
            self._db.execute("INSERT INTO alert_events (key, message, started) VALUES (?, ?, ?)",
                             (key, message, ts or time.time()))

    def alert_notified(self, key: str) -> None:
        with self._lock, self._db:
            self._db.execute("UPDATE alert_events SET notified = 1 WHERE key = ? AND ended IS NULL", (key,))

    def alert_ended(self, key: str, ts: float | None = None) -> None:
        with self._lock, self._db:
            self._db.execute("UPDATE alert_events SET ended = ? WHERE key = ? AND ended IS NULL",
                             (ts or time.time(), key))

    def close_open_alerts(self, keep: set[str], ts: float | None = None) -> None:
        """At start-up: alerts left open by a previous run that are no longer active."""
        with self._lock, self._db:
            for (key,) in self._db.execute("SELECT DISTINCT key FROM alert_events WHERE ended IS NULL").fetchall():
                if key not in keep:
                    self._db.execute("UPDATE alert_events SET ended = ? WHERE key = ? AND ended IS NULL",
                                     (ts or time.time(), key))

    def alert_events(self, since: float, limit: int = 200) -> list[dict]:
        """Newest first. `ended` is None while the alert is still active."""
        with self._lock:
            rows = self._db.execute(
                "SELECT id, key, message, started, ended, notified FROM alert_events "
                "WHERE started >= ? OR ended IS NULL ORDER BY started DESC LIMIT ?", (since, limit),
            ).fetchall()
        return [{
            "id": i, "key": k, "message": m, "started": s, "ended": e, "notified": bool(n),
            "duration_sec": round((e or time.time()) - s),
        } for i, k, m, s, e, n in rows]

    # ---------- visits (someone in the room) ----------
    def visit_started(self, ts: float | None = None) -> None:
        with self._lock, self._db:
            if self._db.execute("SELECT 1 FROM visits WHERE ended IS NULL").fetchone():
                return
            self._db.execute("INSERT INTO visits (started) VALUES (?)", (ts or time.time(),))

    def visit_ended(self, ts: float | None = None) -> None:
        with self._lock, self._db:
            self._db.execute("UPDATE visits SET ended = ? WHERE ended IS NULL", (ts or time.time(),))

    def close_open_visits(self) -> None:
        """At start-up: a visit left open by a previous run ends at the last stored
        reading (when the PC or the sensor went off), never before it started."""
        with self._lock, self._db:
            (last,) = self._db.execute("SELECT MAX(ts) FROM readings").fetchone()
            self._db.execute("UPDATE visits SET ended = MAX(started, ?) WHERE ended IS NULL", (last or 0,))

    def daily_presence(self, days: int = 7, now: float | None = None) -> list[dict]:
        """Minutes someone was in the room on each of the last `days` days, oldest first."""
        now = now or time.time()
        today = datetime.fromtimestamp(now).date()
        first = today - timedelta(days=days - 1)
        start_ts = datetime.combine(first, datetime.min.time()).timestamp()
        with self._lock:
            visits = self._db.execute(
                "SELECT started, COALESCE(ended, ?) FROM visits WHERE COALESCE(ended, ?) >= ?", (now, now, start_ts),
            ).fetchall()
        out = []
        for i in range(days):
            day: date = first + timedelta(days=i)
            lo = datetime.combine(day, datetime.min.time()).timestamp()
            hi = datetime.combine(day + timedelta(days=1), datetime.min.time()).timestamp()  # DST-safe
            seconds = sum(max(0.0, min(e, hi) - max(s, lo)) for s, e in visits)
            out.append({"date": day.isoformat(), "minutes": round(seconds / 60)})
        return out

    def start(self, sensor) -> None:
        def loop():
            self.prune()
            while not self._stop.wait(SAMPLE_SEC):
                try:
                    self.record(sensor.latest)
                except Exception:
                    logger.exception("History: could not store a reading")
        threading.Thread(target=loop, name="history-store", daemon=True).start()
        logger.info("History: storing a reading every %d s in SQLite (%d days kept)", SAMPLE_SEC, KEEP_DAYS)

    def stop(self) -> None:
        self._stop.set()

    # ---------- reading ----------
    def rows(self, since: float, until: float | None = None) -> list[tuple]:
        with self._lock:
            return self._db.execute(
                "SELECT ts, room, temperature, humidity FROM readings WHERE ts >= ? AND ts <= ? ORDER BY ts",
                (since, until or time.time()),
            ).fetchall()

    def series(self, since: float, step_sec: int, until: float | None = None) -> list[dict]:
        """Averages per step_sec bucket, for charts."""
        with self._lock:
            rows = self._db.execute(
                "SELECT CAST(ts / ? AS INTEGER) * ? AS bucket, AVG(temperature), AVG(humidity), "
                "MIN(temperature), MAX(temperature), MIN(humidity), MAX(humidity), COUNT(*) "
                "FROM readings WHERE ts >= ? AND ts <= ? GROUP BY bucket ORDER BY bucket",
                (step_sec, step_sec, since, until or time.time()),
            ).fetchall()
        return [{
            "ts": b, "time": datetime.fromtimestamp(b).isoformat(timespec="minutes"),
            "temperature": round(t, 2), "humidity": round(h, 1),
            "t_min": tmin, "t_max": tmax, "h_min": hmin, "h_max": hmax, "samples": n,
        } for b, t, h, tmin, tmax, hmin, hmax, n in rows]

    def csv(self, since: float, until: float | None = None) -> str:
        out = io.StringIO()
        writer = csv.writer(out)
        writer.writerow(["time", "room", "temperature_c", "humidity_pct"])
        for ts, room, temp, hum in self.rows(since, until):
            writer.writerow([datetime.fromtimestamp(ts).isoformat(timespec="seconds"), room, temp, hum])
        return out.getvalue()


def stuck_reading(store: HistoryStore, now: float | None = None, hours: float = STUCK_HOURS) -> str | None:
    """'humidity at 95%' if a value hasn't moved at all for `hours` of near-continuous
    readings (a DHT11 tends to stick near 95% when damp), else None."""
    now = now or time.time()
    rows = store.rows(now - hours * 3600, now)
    if len(rows) < 0.8 * hours * 3600 / SAMPLE_SEC:
        return None  # too many gaps to judge
    hums, temps = {r[3] for r in rows}, {r[2] for r in rows}
    if len(hums) == 1:
        return f"humidity at {hums.pop():.0f}%"
    if len(temps) == 1:
        return f"temperature at {temps.pop():.1f}°C"
    return None


HUMID_DIP = 2.0         # a dip less than this many % under the limit doesn't end a humid stretch
HUMID_MAX_GAP_SEC = 600  # nor does a gap in the data shorter than this (a sensor hiccup)


def humid_for(store: HistoryStore, limit: float, now: float | None = None, lookback_hours: float = 48) -> float:
    """Seconds the room has been humid without a break: every stored reading back to
    then is above `limit` (small dips of up to HUMID_DIP % and short gaps don't count
    as a break). 0 when the newest reading isn't humid or there is no recent data."""
    now = now or time.time()
    rows = store.rows(now - lookback_hours * 3600, now)
    if not rows or now - rows[-1][0] > HUMID_MAX_GAP_SEC or rows[-1][3] <= limit:
        return 0.0
    start = rows[-1][0]
    for ts, _room, _temp, hum in reversed(rows):
        if start - ts > HUMID_MAX_GAP_SEC or hum <= limit - HUMID_DIP:
            break
        start = ts
    return now - start


def humid_hours(store: HistoryStore, limit: float, since: float, until: float | None = None) -> float:
    """Hours above `limit` between since and until (each reading counts for the time
    to the next one, at most HUMID_MAX_GAP_SEC, so gaps in the data add nothing)."""
    rows = store.rows(since, until)
    seconds = 0.0
    for (ts, _r, _t, hum), nxt in zip(rows, rows[1:] + [None]):
        if hum > limit:
            seconds += min((nxt[0] - ts) if nxt else SAMPLE_SEC, HUMID_MAX_GAP_SEC)
    return seconds / 3600


def format_night(store: HistoryStore, thresholds, now: datetime | None = None, hours: int = 10) -> str:
    """Hour-by-hour summary for Telegram /night (default: the last 10 hours)."""
    now = now or datetime.now()
    since = now.timestamp() - hours * 3600
    buckets = store.series(since, 3600, now.timestamp())
    if not buckets:
        return f"🌙 No readings stored in the last {hours} hours."
    lines = [f"🌙 Last {hours} hours, hourly average (min–max):"]
    for b in buckets:
        flag = " ⚠️" if (b["h_max"] > thresholds.HUMIDITY_HIGH or b["t_max"] > thresholds.TEMP_HIGH
                         or b["t_min"] < thresholds.TEMP_LOW or b["h_min"] < thresholds.HUMIDITY_LOW) else ""
        lines.append(f"{datetime.fromtimestamp(b['ts']):%H:%M}  {b['temperature']:.1f}°C  "
                     f"{b['humidity']:.0f}% ({b['h_min']:.0f}–{b['h_max']:.0f}){flag}")
    temps = [r[2] for r in store.rows(since, now.timestamp())]
    hums = [r[3] for r in store.rows(since, now.timestamp())]
    lines.append(f"Range: {min(temps):.1f}–{max(temps):.1f}°C, {min(hums):.0f}–{max(hums):.0f}%")
    return "\n".join(lines)
