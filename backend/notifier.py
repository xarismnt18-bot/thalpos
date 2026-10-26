"""
Telegram notifications for alerts.

A background thread checks the alerts every NOTIFY_CHECK_SEC seconds and sends
a message when an alert starts, and another one when it clears. To avoid spam:
  * a change must hold for two checks in a row before it is reported;
  * the same alert is not re-sent within NOTIFY_COOLDOWN_MIN minutes;
  * "sensor / broker offline" is ignored for the first minute after start-up.

Disabled (and silent) until TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set,
which setup_telegram.bat does.
"""
import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request

from backend.alerts import active_alerts
from backend.history_store import humid_for, stuck_reading
from backend.voice import spoken

logger = logging.getLogger(__name__)

STARTUP_GRACE_SEC = 60
CONNECTIVITY_KEYS = {"broker_offline", "sensor_offline"}
SILENT_KEYS = {"sensor_stuck"}  # Telegram only: not worth waking Alexa for
COMFORT_KEYS = {"temp_high", "temp_low", "humidity_high", "humidity_low"}  # can wait until someone is in
REMEMBER_SEC = 24 * 3600  # alerts sent before a restart are not sent again for this long


class TelegramClient:
    def __init__(self, token: str | None, chat_id: str | None):
        self._token = token
        self._chat_id = chat_id

    @property
    def enabled(self) -> bool:
        return bool(self._token and self._chat_id)

    @property
    def chat_id(self) -> str | None:
        return self._chat_id

    def send(self, text: str) -> None:
        """Raises RuntimeError with a readable reason if Telegram refuses."""
        self._call("sendMessage", {"chat_id": self._chat_id, "text": text}, timeout=10)

    def send_photo(self, png: bytes, caption: str = "") -> None:
        """Sends a PNG (multipart upload). Raises RuntimeError like send()."""
        boundary = "thalpos" + os.urandom(8).hex()
        parts = []
        for name, value in (("chat_id", str(self._chat_id)), ("caption", caption[:1024])):
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="photo"; filename="chart.png"\r\n'
                     "Content-Type: image/png\r\n\r\n".encode() + png + b"\r\n")
        parts.append(f"--{boundary}--\r\n".encode())
        self._post("sendPhoto", b"".join(parts), f"multipart/form-data; boundary={boundary}", timeout=30)

    def get_updates(self, offset: int | None, timeout: int = 25) -> list[dict]:
        """Long-polls for new messages to the bot."""
        params = {"timeout": timeout, "allowed_updates": ["message"]}
        if offset is not None:
            params["offset"] = offset
        return self._call("getUpdates", params, timeout=timeout + 10).get("result", [])

    def _call(self, method: str, params: dict, timeout: int) -> dict:
        return self._post(method, json.dumps(params).encode("utf-8"), "application/json", timeout)

    def _post(self, method: str, body: bytes, content_type: str, timeout: int) -> dict:
        if not self.enabled:
            raise RuntimeError("Telegram is not set up. Run setup_telegram.bat.")
        url = f"https://api.telegram.org/bot{self._token}/{method}"
        request = urllib.request.Request(url, data=body, headers={"Content-Type": content_type})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                result = json.load(response)
        except urllib.error.HTTPError as e:
            try:
                detail = json.load(e).get("description", str(e))
            except (ValueError, AttributeError):
                detail = str(e)
            raise RuntimeError(f"Telegram refused the message: {detail}") from None
        except (urllib.error.URLError, TimeoutError) as e:
            raise RuntimeError(f"Could not reach Telegram: {e}") from None
        if not result.get("ok"):
            raise RuntimeError(f"Telegram refused the message: {result.get('description')}")
        return result


def describe(key: str, latest: dict, thresholds, resolved: bool, stuck: str | None = None,
             humid_sec: float = 0.0) -> str:
    room = latest.get("room") or "Room"
    temp, hum = latest.get("temperature"), latest.get("humidity")
    t, h = (f"{temp:.1f}°C" if temp is not None else "--"), (f"{hum:.0f}%" if hum is not None else "--")

    if resolved:
        return {
            "broker_offline": "✅ MQTT broker is reachable again.",
            "sensor_offline": f"✅ {room} sensor is reporting again ({t}, {h}).",
            "temp_high": f"✅ {room}: temperature back to normal ({t}).",
            "temp_low": f"✅ {room}: temperature back to normal ({t}).",
            "humidity_high": f"✅ {room}: humidity back to normal ({h}).",
            "humidity_low": f"✅ {room}: humidity back to normal ({h}).",
            "sensor_stuck": f"✅ {room} sensor readings are changing again.",
            "mold_risk": f"✅ {room}: the long humid stretch is over ({h}).",
        }.get(key, f"✅ {room}: alert cleared.")

    age = latest.get("seconds_since_update")
    return {
        "broker_offline": "🛑 MQTT broker is unreachable. Check that the Mosquitto service is running.",
        "sensor_offline": f"📡 {room} sensor stopped sending"
                          + (f" (last packet {age:.0f} s ago)." if age is not None else "."),
        "temp_high": f"🌡️ {room} is warm: {t} (comfort limit {thresholds.TEMP_HIGH:g}°C).",
        "temp_low": f"🥶 {room} is cold: {t} (comfort limit {thresholds.TEMP_LOW:g}°C).",
        "humidity_high": f"💧 {room} humidity is high: {h} (limit {thresholds.HUMIDITY_HIGH:g}%). "
                         "Mold risk rises; open a window or run the dehumidifier.",
        "humidity_low": f"🏜️ {room} air is dry: {h} (limit {thresholds.HUMIDITY_LOW:g}%).",
        "mold_risk": f"🍄 {room} has been humid for {humid_sec / 3600:.1f} hours without a break "
                     f"(above {thresholds.HUMIDITY_HIGH:g}%, now {h}). Mold grows when damp air lasts: "
                     "air the room well or run a dehumidifier.",
        "sensor_stuck": f"🧐 {room} {stuck or 'sensor'} has not changed for hours. The sensor may be stuck "
                        "(a DHT11 often sticks near 95% when damp): check it is dry and away from cold walls.",
    }.get(key, f"⚠️ {room}: {key}")


class AlertNotifier:
    def __init__(self, telegram: TelegramClient, sensor, settings, check_sec: int, cooldown_min: int, voice=None, lamp=None,
                 history=None, state_path: str | None = None, humidity_hold_min: float = 20, mold_hours: float = 3):
        self.telegram = telegram
        self.voice = voice
        self.lamp = lamp
        self._sensor = sensor
        self._settings = settings
        self._check_sec = check_sec
        self._cooldown_sec = cooldown_min * 60
        self._started_at = time.monotonic()
        self._reported: set[str] = set()      # alerts currently considered active
        self._notified: set[str] = set()      # active alerts whose message was sent
        self._pending: dict[str, int] = {}    # key -> consecutive checks the change held
        self._last_sent: dict[str, float] = {}  # wall-clock time of the last message per alert
        self._muted_until = 0.0  # wall-clock time; alerts are not sent before it
        self.history = history   # HistoryStore, for the stuck-sensor check
        self.stuck: str | None = None  # e.g. "humidity at 95%" while the sensor looks stuck
        self.humid_sec = 0.0  # how long the room has been above HUMIDITY_HIGH without a break (from the history)
        self._humidity_hold_sec = humidity_hold_min * 60
        self._mold_sec = mold_hours * 3600
        self.presence = None  # PresenceWatcher, set by the app: comfort alerts wait while the room is empty
        self._stuck_checked_at = -1e9
        self._state_path = state_path
        self._load_state()
        self._log("close_open_alerts", set(self._reported))
        for key in self._reported:  # still active from before a restart: make sure the log shows it
            self._log("alert_started", key, "Active since before Thalpos restarted.", self._last_sent.get(key))
            self._log("alert_notified", key)
        self._stop = threading.Event()
        self._thread = None

    def start(self) -> None:
        voice_on = bool(self.voice and self.voice.enabled)
        lamp_on = bool(self.lamp and self.lamp.enabled)
        logger.info("Voice alerts %s", "on" if voice_on else "off (run setup_voice.bat to turn them on)")
        logger.info("Alert lamp %s", "on" if lamp_on else "off (run setup_ikea.bat to turn it on)")
        if not self.telegram.enabled:
            logger.info("Telegram notifications off (run setup_telegram.bat to turn them on)")
        if not (self.telegram.enabled or voice_on or lamp_on):
            return
        self._started_at = time.monotonic()
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="alert-notifier", daemon=True)
        self._thread.start()
        if self.telegram.enabled:
            logger.info("Telegram notifications on")

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        while not self._stop.wait(self._check_sec):
            try:
                self.check()
            except Exception:  # never let one bad check kill the thread
                logger.exception("Notification check failed")

    def check(self) -> None:
        if not self.muted_until and self._reported - self._notified:
            # alerts that started while muted: forget them so they are reported now
            self._reported &= self._notified
        latest = self._sensor.latest
        thresholds = self._settings.thresholds
        current = {a.key for a in active_alerts(latest, thresholds)}
        if self.history is not None:
            if time.monotonic() - self._stuck_checked_at >= 60:
                self.stuck = stuck_reading(self.history)
                self.humid_sec = humid_for(self.history, thresholds.HUMIDITY_HIGH)
                self._stuck_checked_at = time.monotonic()
            if self.stuck:
                current.add("sensor_stuck")
            current = self._humidity_over_time(current, latest, thresholds)
        if not latest.get("sensor_online"):
            # values are stale while the sensor is offline: keep value alerts as
            # they were and only track connectivity
            current = (current & CONNECTIVITY_KEYS) | (self._reported - CONNECTIVITY_KEYS)
        if time.monotonic() - self._started_at < STARTUP_GRACE_SEC:
            current -= CONNECTIVITY_KEYS
        current = self._hold_while_empty(current, latest, thresholds)

        changed = (current - self._reported) | (self._reported - current)
        for key in list(self._pending):
            if key not in changed:
                del self._pending[key]
        for key in changed:
            self._pending[key] = self._pending.get(key, 0) + 1
            if self._pending[key] < 2:
                continue  # wait one more check before believing it
            del self._pending[key]
            if key in current:
                self._raise(key, latest, thresholds)
            else:
                self._clear(key, latest, thresholds)
        if self.lamp:
            self.lamp.sync(self._reported)

    def _humidity_over_time(self, current: set[str], latest: dict, thresholds) -> set[str]:
        """A short spike (a shower, a pot boiling) is not worth a message: "humid"
        starts only after HUMIDITY_HOLD_MIN minutes above the limit, unless it is
        critical. Hours of it without a break raise the separate mold-risk alert."""
        hum = latest.get("humidity")
        if ("humidity_high" in current and "humidity_high" not in self._reported
                and (hum is None or hum < thresholds.HUMIDITY_CRITICAL)
                and self.humid_sec < self._humidity_hold_sec):
            current = current - {"humidity_high"}
        if self.humid_sec >= self._mold_sec and not self.stuck:
            current = current | {"mold_risk"}
        return current

    @property
    def mold_message(self) -> str | None:
        """For the dashboard and /status while the mold-risk stretch lasts."""
        if self.humid_sec < self._mold_sec or self.stuck:
            return None
        return f"Humid for {self.humid_sec / 3600:.1f} hours without a break: mold risk. Air the room or run a dehumidifier."

    def _hold_while_empty(self, current: set[str], latest: dict, thresholds) -> set[str]:
        """While the radar says the room is empty, comfort alerts neither start
        nor clear: you hear about a hot or humid room when someone is in it.
        Critical levels (mold risk, heat) and sensor problems still get through."""
        p = self.presence
        if p is None or not p.alerts_only_present or not p.empty:
            return current
        temp, hum = latest.get("temperature"), latest.get("humidity")
        critical = set()
        if hum is not None and hum >= thresholds.HUMIDITY_CRITICAL:
            critical.add("humidity_high")
        if temp is not None and temp >= thresholds.TEMP_CRITICAL:
            critical.add("temp_high")
        held = (current | self._reported) & COMFORT_KEYS - critical
        return (current - held) | (self._reported & held)

    def _raise(self, key: str, latest: dict, thresholds) -> None:
        self._reported.add(key)
        self._log("alert_started", key, describe(key, latest, thresholds, resolved=False, stuck=self.stuck,
                                                humid_sec=self.humid_sec))
        now = time.time()
        if now - self._last_sent.get(key, -self._cooldown_sec) < self._cooldown_sec:
            return
        if self._send(describe(key, latest, thresholds, resolved=False, stuck=self.stuck, humid_sec=self.humid_sec)):
            self._last_sent[key] = now
            self._notified.add(key)
            self._save_state()
            self._log("alert_notified", key)
            if key not in SILENT_KEYS:
                self._speak(key, spoken(key, latest, thresholds))

    def _clear(self, key: str, latest: dict, thresholds) -> None:
        self._reported.discard(key)
        self._log("alert_ended", key)
        if key in self._notified:  # only confirm alerts the user actually received
            self._notified.discard(key)
            self._save_state()
            self._send(describe(key, latest, thresholds, resolved=True))

    def _log(self, method: str, *args) -> None:
        """Alert log for the dashboard; never allowed to break notifications."""
        log = getattr(self.history, method, None)
        if log is None:
            return
        try:
            log(*args)
        except Exception:
            logger.exception("Alert log: %s failed", method)

    # ---------- remembered across restarts ----------
    def _load_state(self) -> None:
        """Alerts already sent before a restart count as reported, so a restart
        doesn't repeat them; if they cleared meanwhile, "back to normal" follows."""
        if not self._state_path:
            return
        try:
            with open(self._state_path, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            return
        now = time.time()
        self._last_sent = {k: float(t) for k, t in data.get("last_sent", {}).items() if now - float(t) < REMEMBER_SEC}
        self._notified = {k for k in data.get("notified", []) if k in self._last_sent}
        self._reported = set(self._notified)

    def _save_state(self) -> None:
        if not self._state_path:
            return
        try:
            os.makedirs(os.path.dirname(self._state_path) or ".", exist_ok=True)
            tmp = self._state_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"notified": sorted(self._notified), "last_sent": self._last_sent}, f)
            os.replace(tmp, self._state_path)
        except OSError as e:
            logger.warning("Could not save alert state: %s", e)

    # ---------- mute (from the Telegram /mute command) ----------
    def mute(self, seconds: float) -> float:
        self._muted_until = time.time() + seconds
        return self._muted_until

    def unmute(self) -> None:
        self._muted_until = 0.0

    @property
    def muted_until(self) -> float | None:
        return self._muted_until if self._muted_until > time.time() else None

    def _send(self, text: str) -> bool:
        """True when the alert counts as delivered (Telegram, or voice-only setups)."""
        if self.muted_until:
            return False  # treated like "not sent": no "resolved" follow-up either
        if not self.telegram.enabled:
            return bool(self.voice and self.voice.enabled)
        try:
            self.telegram.send(text)
            return True
        except RuntimeError as e:
            logger.warning("Telegram: %s", e)
            return False

    @property
    def active_keys(self) -> set[str]:
        return set(self._reported)

    def _speak(self, key: str, text: str) -> None:
        if not (self.voice and self.voice.should_speak(key)):
            return
        try:
            self.voice.announce(text)
        except RuntimeError as e:
            logger.warning("Voice: %s", e)
            return
        self.voice.spoke(key)
