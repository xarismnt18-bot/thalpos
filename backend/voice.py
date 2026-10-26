"""
Alexa through Voice Monkey: spoken alerts, and the room status Alexa reads
out when asked ("Alexa, bedroom status").

Only new alerts are spoken (not "back to normal"), never during quiet hours,
and never while alerts are muted. The status sentence is kept up to date in a
Voice Monkey variable that a Voice Monkey Flow speaks on request, so nothing
on this PC has to be reachable from the internet. Off until setup_voice.bat
has stored a Voice Monkey token and speaker device in voice.env.
"""
import json
import logging
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime

from backend.alerts import active_alerts

logger = logging.getLogger(__name__)

API = "https://api-v3.voicemonkey.io"
# Voice Monkey sits behind Cloudflare, which rejects Python's default
# User-Agent ("error code: 1010"), so identify the client explicitly.
HEADERS = {"Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (compatible; Thalpos/6.18)"}


def in_quiet_hours(now: datetime, quiet: str) -> bool:
    """quiet = 'HH:MM-HH:MM' (may wrap past midnight); empty = never quiet."""
    if not quiet or "-" not in quiet:
        return False
    start, end = (part.strip() for part in quiet.split("-", 1))
    hhmm = now.strftime("%H:%M")
    if start <= end:
        return start <= hhmm < end
    return hhmm >= start or hhmm < end


def spoken(key: str, latest: dict, thresholds) -> str:
    """Plain sentences for text-to-speech: no emoji, numbers rounded."""
    room = latest.get("room") or "the room"
    temp, hum = latest.get("temperature"), latest.get("humidity")
    t = f"{temp:.0f} degrees" if temp is not None else "unknown"
    h = f"{hum:.0f} percent" if hum is not None else "unknown"
    return {
        "broker_offline": "Smart home alert. The sensor broker is offline.",
        "sensor_offline": f"Smart home alert. The {room} sensor stopped sending data.",
        "temp_high": f"{room} is warm, {t}. Consider opening a window or switching on the air conditioning.",
        "temp_low": f"{room} is cold, {t}.",
        "humidity_high": f"{room} humidity is {h}, above {thresholds.HUMIDITY_HIGH:g}. "
                         "Consider running the dehumidifier.",
        "humidity_low": f"The air in the {room} is dry, {h} humidity.",
        "mold_risk": f"The {room} has been humid for hours. Mold risk. Please air the room or run the dehumidifier.",
    }.get(key, f"Smart home alert for the {room}.")


def status_sentence(latest: dict, thresholds) -> str:
    """What Alexa says when asked for the room status."""
    room = (latest.get("room") or "room").lower()
    temp, hum = latest.get("temperature"), latest.get("humidity")
    if not latest.get("broker_connected"):
        return "The sensor broker is offline, so I have no live readings right now."
    if not latest.get("sensor_online") or temp is None or hum is None:
        age = latest.get("seconds_since_update")
        when = f" for about {max(1, round(age / 60))} minutes" if age else ""
        return f"The {room} sensor has not sent any data{when}, so I have no live readings."

    keys = {a.key for a in active_alerts(latest, thresholds)}
    parts = [f"The {room} is {temp:.1f} degrees, with {hum:.0f} percent humidity."]
    if "humidity_high" in keys:
        parts.append(f"That is above your limit of {thresholds.HUMIDITY_HIGH:g} percent. "
                     "Consider running the dehumidifier.")
    elif "humidity_low" in keys:
        parts.append(f"The air is dry, below {thresholds.HUMIDITY_LOW:g} percent.")
    if "temp_high" in keys:
        parts.append(f"It is warmer than your limit of {thresholds.TEMP_HIGH:g} degrees.")
    elif "temp_low" in keys:
        parts.append(f"It is colder than your limit of {thresholds.TEMP_LOW:g} degrees.")
    if not keys:
        parts.append("Everything is in the comfort range.")
    return " ".join(parts)


OFFLINE_SENTENCE = "The smart home server is switched off, so I have no live readings."
PAUSED_SENTENCE = ("Live room status is paused to stay within the Voice Monkey free plan. "
                   "Send slash status to the Telegram bot for the current readings.")


class VoiceAnnouncer:
    REPEAT_SEC = 6 * 3600
    DAILY_MAX = 5

    def __init__(self, token: str | None, device: str | None, quiet_hours: str):
        self._token = token
        self._device = device
        self.quiet_hours = quiet_hours
        self.on = True  # switched by the Telegram /voice command
        self._last_spoken: dict[str, datetime] = {}
        self._budget_day = None
        self._spoken_today = 0

    @property
    def enabled(self) -> bool:
        return bool(self._token and self._device)

    def should_speak(self, key: str | None = None, now: datetime | None = None) -> bool:
        """Quiet hours, /voice off, and a budget: every announcement is a Voice
        Monkey request (free plan: 200 a month), so the same alert is spoken at
        most once every REPEAT_SEC and no more than DAILY_MAX alerts a day."""
        now = now or datetime.now()
        if not (self.enabled and self.on) or in_quiet_hours(now, self.quiet_hours):
            return False
        day = now.date()
        if self._budget_day != day:
            self._budget_day, self._spoken_today = day, 0
        if self._spoken_today >= self.DAILY_MAX:
            return False
        last = self._last_spoken.get(key)
        return key is None or last is None or (now - last).total_seconds() >= self.REPEAT_SEC

    def spoke(self, key: str | None, now: datetime | None = None) -> None:
        now = now or datetime.now()
        self._spoken_today += 1
        if key:
            self._last_spoken[key] = now

    def announce(self, text: str) -> None:
        """Raises RuntimeError with a readable reason if Voice Monkey refuses."""
        if not self.enabled:
            raise RuntimeError("Voice alerts are not set up. Run setup_voice.bat.")
        self._post("announce", {"device": self._device, "speech": text}, "announcement")

    def set_variable(self, name: str, value: str) -> None:
        """Stores a Voice Monkey variable that Flows can speak as {NAME}."""
        if not self.enabled:
            raise RuntimeError("Voice is not set up. Run setup_voice.bat.")
        self._post("variables", {"variable": name, "value": value}, "variable")

    def _post(self, path: str, fields: dict, what: str) -> dict:
        body = json.dumps({"token": self._token, **fields}).encode("utf-8")
        request = urllib.request.Request(f"{API}/{path}", data=body, headers=HEADERS)
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                result = json.load(response)
        except urllib.error.HTTPError as e:
            try:
                detail = json.load(e).get("error") or str(e)
            except (ValueError, AttributeError):
                detail = str(e)
            raise RuntimeError(f"Voice Monkey refused the {what}: {detail}") from None
        except (urllib.error.URLError, TimeoutError) as e:
            raise RuntimeError(f"Could not reach Voice Monkey: {e}") from None
        if not result.get("success", True):
            raise RuntimeError(f"Voice Monkey refused the {what}: {result}")
        return result


class VoiceStatusPublisher:
    """Keeps the status sentence in a Voice Monkey variable for "Alexa, bedroom status".

    Pushes when the sentence changes (checked every interval_sec) and at least
    every REFRESH_SEC anyway; on shutdown it leaves a "server is off" sentence.
    """

    REFRESH_SEC = 15 * 60

    def __init__(self, voice: VoiceAnnouncer, sensor, settings, variable: str, interval_sec: int):
        self._voice = voice
        self._sensor = sensor
        self._settings = settings
        self.variable = variable
        self._interval = interval_sec
        self._last_text: str | None = None
        self._last_push = 0.0
        self.last_error: str | None = None
        self._stop = threading.Event()
        self._started = False

    def start(self) -> None:
        if not self._voice.enabled:
            return
        self._stop.clear()
        self._started = True
        threading.Thread(target=self._run, name="voice-status", daemon=True).start()
        logger.info("Alexa status: kept in Voice Monkey variable %s", self.variable)

    def leave_paused_note(self) -> None:
        """Status updates are off: say so once instead of leaving stale numbers."""
        if self._voice.enabled:
            threading.Thread(target=self._push, args=(PAUSED_SENTENCE,), name="voice-status", daemon=True).start()

    def stop(self) -> None:
        if not self._started or self._stop.is_set():
            return
        self._stop.set()
        self._push(OFFLINE_SENTENCE)

    @property
    def text(self) -> str:
        return status_sentence(self._sensor.latest, self._settings.thresholds)

    def _run(self) -> None:
        self._stop.wait(20)  # give the sensor time to report after start-up
        while not self._stop.is_set():
            try:
                self.publish()
            except Exception:
                logger.exception("Alexa status update failed")
            self._stop.wait(self._interval)

    def publish(self, force: bool = False) -> bool:
        text = self.text
        due = time.monotonic() - self._last_push >= self.REFRESH_SEC
        if not force and text == self._last_text and not due:
            return False
        return self._push(text)

    def _push(self, text: str) -> bool:
        try:
            self._voice.set_variable(self.variable, text)
        except RuntimeError as e:
            if e.args[0] != self.last_error:
                logger.warning("Alexa status: %s", e)
            self.last_error = e.args[0]
            return False
        self._last_text, self._last_push, self.last_error = text, time.monotonic(), None
        return True
