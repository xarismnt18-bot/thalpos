"""
Two-way Telegram: commands from your phone, plus the morning summary.

Commands (only the chat saved by setup_telegram.bat gets answers):
    /status          current readings, trend and active alerts
    /today           today's min / max / average and time out of range
    /night [hours]   hour-by-hour readings of the last night (default 10 h)
    /mute [30m|2h]   pause alert messages (default 1 hour)
    /unmute          resume alert messages
    /voice on|off|test|status   Alexa: spoken alerts, test, read the status aloud
    /lamp on|off|auto on|auto off   the IKEA alert lamp
    /help            this list
"""
import logging
import re
import threading
import time
from datetime import datetime

from ai.engines import dew_point, health_score, mold_risk
from backend.alerts import active_alerts
from backend.daily_stats import DailyStats, format_day, yesterday
from backend import charts
from backend.history_store import format_night, humid_hours
from backend.voice import status_sentence

logger = logging.getLogger(__name__)

SAMPLE_SEC = 10
HELP = (
    "Thalpos commands:\n"
    "/status – current readings and alerts\n"
    "/today – today's range and time out of comfort\n"
    "/night – hour by hour, last 10 h (/night 24 for a day)\n"
    "/presence – time someone was in the room, today and this week\n"
    "/mute 2h – pause alerts (30m, 2h, 1d; default 1h)\n"
    "/unmute – resume alerts\n"
    "/voice on | off | test – spoken alerts on Alexa\n"
    "/voice status – Alexa reads the room status aloud\n"
    "/lamp on | off – switch the alert lamp\n"
    "/lamp auto on | off – lamp lights up on alerts"
)


def minutes_text(minutes: int) -> str:
    if minutes < 1:
        return "0 min"
    hours, mins = divmod(int(minutes), 60)
    return f"{hours} h {mins} min" if hours and mins else f"{hours} h" if hours else f"{mins} min"


def parse_duration(text: str, default_sec: int = 3600) -> int | None:
    """'30m' -> 1800, '2h' -> 7200, '1d' -> 86400, '' -> default. None if invalid."""
    text = text.strip().lower()
    if not text:
        return default_sec
    match = re.fullmatch(r"(\d+)\s*(m|min|h|d)?", text)
    if not match:
        return None
    value, unit = int(match.group(1)), match.group(2) or "m"
    seconds = value * {"m": 60, "min": 60, "h": 3600, "d": 86400}[unit]
    return seconds if 0 < seconds <= 7 * 86400 else None


class TelegramBot:
    def __init__(self, telegram, notifier, sensor, settings, predictor, stats: DailyStats, summary_time: str,
                 history=None, preferences=None, presence=None):
        self.telegram = telegram
        self._preferences = preferences  # saves /voice and /lamp auto changes across restarts
        self._notifier = notifier
        self._sensor = sensor
        self._settings = settings
        self._predictor = predictor
        self._stats = stats
        self._summary_hhmm = summary_time
        self._history = history
        self._presence = presence
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []

    def start(self) -> None:
        # Daily stats are useful for /today even before Telegram is set up.
        self._spawn(self._record_loop, "daily-stats")
        if self.telegram.enabled:
            self._spawn(self._command_loop, "telegram-commands")
            self._spawn(self._summary_loop, "daily-summary")

    def stop(self) -> None:
        self._stop.set()
        self._stats.save()

    def _spawn(self, target, name: str) -> None:
        thread = threading.Thread(target=target, name=name, daemon=True)
        thread.start()
        self._threads.append(thread)

    # ---------- daily stats + morning summary ----------
    def _record_loop(self) -> None:
        while not self._stop.wait(SAMPLE_SEC):
            try:
                self._stats.sample(self._sensor.latest, self._settings.thresholds)
            except Exception:
                logger.exception("Daily stats sample failed")

    def _summary_loop(self) -> None:
        while not self._stop.wait(30):
            try:
                self.maybe_send_summary(datetime.now())
            except Exception:
                logger.exception("Daily summary failed")

    def maybe_send_summary(self, now: datetime) -> bool:
        if now.strftime("%H:%M") < self._summary_hhmm:
            return False
        day = yesterday(now.date())
        if self._stats.summary_sent_for() == day.isoformat():
            return False
        data = self._stats.day(day)
        room = self._sensor.latest.get("room") or "Room"
        if data:  # nothing to report for a day with no readings
            text = format_day(f"☀️ Good morning. {room} yesterday ({day:%a %d %b}):", data, self._settings.thresholds)
            try:
                self.telegram.send(text)
            except RuntimeError as e:
                logger.warning("Daily summary not sent: %s", e)
                return False
            start = datetime.combine(day, datetime.min.time()).timestamp()
            self.send_chart(start, start + 86400, f"{day:%a %d %b}")
        self._stats.mark_summary_sent(day)
        return bool(data)

    def send_chart(self, since: float, until: float, label: str) -> bool:
        """Sends a temperature/humidity chart from the stored history, if possible."""
        if self._history is None:
            return False
        step = 300 if until - since <= 36 * 3600 else 1800
        room = self._sensor.latest.get("room") or "Room"
        png = charts.render(self._history.series(since, step, until), step, self._settings.thresholds,
                            f"{room} · {label}")
        if not png:
            return False
        try:
            self.telegram.send_photo(png)
        except (RuntimeError, AttributeError) as e:
            logger.warning("Chart not sent: %s", e)
            return False
        return True

    # ---------- commands ----------
    def _command_loop(self) -> None:
        offset = self._skip_backlog()
        while not self._stop.is_set():
            try:
                updates = self.telegram.get_updates(offset)
            except RuntimeError as e:
                logger.warning("Telegram polling: %s", e)
                self._stop.wait(15)
                continue
            for update in updates:
                offset = update["update_id"] + 1
                message = update.get("message") or {}
                if str(message.get("chat", {}).get("id")) != str(self.telegram.chat_id):
                    continue  # someone else found the bot: ignore
                reply = self.handle(message.get("text", ""))
                if reply:
                    try:
                        self.telegram.send(reply)
                    except RuntimeError as e:
                        logger.warning("Telegram reply not sent: %s", e)

    def _skip_backlog(self) -> int | None:
        """Commands sent while Thalpos was off are stale; start after the newest one."""
        try:
            pending = self.telegram.get_updates(-1, timeout=0)
        except RuntimeError:
            return None
        return pending[-1]["update_id"] + 1 if pending else None

    def handle(self, text: str) -> str | None:
        command, _, arg = text.strip().partition(" ")
        command = command.split("@")[0].lower()
        if command in ("/start", "/help"):
            return HELP
        if command == "/status":
            return self.status_text()
        if command == "/today":
            return format_day("📊 Today so far:", self._stats.day(datetime.now().date()), self._settings.thresholds)
        if command == "/night":
            if self._history is None:
                return "History is not available."
            hours = int(arg) if arg.strip().isdigit() and 1 <= int(arg) <= 72 else 10
            now = time.time()
            self.send_chart(now - hours * 3600, now, f"last {hours} hours")
            return format_night(self._history, self._settings.thresholds, hours=hours)
        if command == "/presence":
            return self.presence_text()
        if command == "/mute":
            seconds = parse_duration(arg)
            if seconds is None:
                return "Use it like /mute 30m, /mute 2h or /mute 1d."
            until = self._notifier.mute(seconds)
            return f"🔕 Alerts paused until {datetime.fromtimestamp(until):%H:%M %a}. /unmute to resume."
        if command == "/unmute":
            self._notifier.unmute()
            return "🔔 Alerts are back on."
        if command == "/voice":
            return self.voice_command(arg.strip().lower())
        if command == "/lamp":
            return self.lamp_command(arg.strip().lower())
        if command.startswith("/"):
            return "I don't know that one.\n\n" + HELP
        return None

    def _remember(self, change: dict, apply) -> None:
        """Applies a setting, saving it like the dashboard does when possible."""
        if self._preferences is None:
            apply()
            return
        try:
            self._preferences.update(change)
        except (OSError, ValueError):
            logger.exception("Could not save %s", change)
            apply()

    def lamp_command(self, arg: str) -> str:
        lamp = self._notifier.lamp
        if not lamp or not lamp.enabled:
            return "💡 The alert lamp isn't set up. Run setup_ikea.bat on the PC."
        if arg in ("auto on", "auto off"):
            self._remember({"lamp_auto": arg == "auto on"}, lambda: setattr(lamp, "auto", arg == "auto on"))
            return ("💡 The lamp will light up on temperature or humidity alerts "
                    f"(not during {lamp.quiet_hours})." if lamp.auto else "💡 Automatic lamp off. /lamp auto on to bring it back.")
        if arg in ("on", "off"):
            try:
                lamp.manual(arg == "on", alert_active=bool(self._notifier.active_keys))
            except RuntimeError as e:
                return f"Lamp: {e}"
            return "💡 Lamp on." if arg == "on" else "💡 Lamp off."
        auto = "on" if lamp.auto else "off"
        return f"Automatic alert lamp is {auto}. Use /lamp on, /lamp off, /lamp auto on or /lamp auto off."

    def voice_command(self, arg: str) -> str:
        voice = self._notifier.voice
        if not voice or not voice.enabled:
            return "🔇 Voice alerts aren't set up. Run setup_voice.bat on the PC."
        if arg == "off":
            self._remember({"voice_on": False}, lambda: setattr(voice, "on", False))
            return "🔇 Alexa will stay quiet. /voice on to bring it back."
        if arg == "on":
            self._remember({"voice_on": True}, lambda: setattr(voice, "on", True))
            return f"🔊 Alexa will announce new alerts (quiet hours {voice.quiet_hours})."
        if arg == "test":
            try:
                voice.announce("This is a test from your smart home. Voice alerts are working.")
            except RuntimeError as e:
                return f"Alexa test failed: {e}"
            return "🔊 Sent. Your Echo should speak now."
        if arg == "status":
            try:
                voice.announce(status_sentence(self._sensor.latest, self._settings.thresholds))
            except RuntimeError as e:
                return f"Alexa status failed: {e}"
            return "🔊 Your Echo is reading the room status."
        state = "on" if voice.on else "off"
        return f"Voice alerts are {state} (quiet hours {voice.quiet_hours}). Use /voice on, /voice off, /voice test or /voice status."

    def presence_text(self, now: float | None = None) -> str:
        if self._history is None:
            return "History is not available."
        room = self._sensor.latest.get("room") or "room"
        days = self._history.daily_presence(7, now)
        today = days[-1]["minutes"]
        lines = [f"🚶 {room} today: someone was in for {minutes_text(today)}."]
        p = self._presence
        if p is not None and p.occupied:
            since = p.since
            lines.append(f"Someone is in now{f' (since {datetime.fromtimestamp(since):%H:%M})' if since else ''}.")
        elif p is not None and p.empty:
            lines.append("The room is empty now.")
        lines.append("")
        lines.append("Last 7 days:")
        for d in days:
            day = datetime.strptime(d["date"], "%Y-%m-%d")
            lines.append(f"{day:%a %d/%m}  {minutes_text(d['minutes'])}")
        return "\n".join(lines)

    def status_text(self) -> str:
        latest = self._sensor.latest
        t = self._settings.thresholds
        room = latest.get("room") or "Room"
        temp, hum = latest.get("temperature"), latest.get("humidity")

        if not latest.get("broker_connected"):
            return f"🛑 {room}: MQTT broker unreachable, no live data."
        if not latest.get("sensor_online") or temp is None:
            age = latest.get("seconds_since_update")
            when = f"{age / 60:.0f} min ago" if age else "never"
            return f"📡 {room}: sensor offline (last packet {when})."

        lines = [
            f"🏠 {room}: {temp:.1f}°C, {hum:.0f}%",
            f"Health {health_score(temp, hum, t)}/100 · dew point {dew_point(temp, hum):.1f}° · mold risk {mold_risk(temp, hum)}",
        ]
        forecast = self._predictor.predict_all(self._sensor.history(), t)
        trend = forecast["temperature"].get("trend")
        predicted = forecast["temperature"].get("predicted")
        if trend and trend != "unknown" and predicted is not None:
            lines.append(f"Next {forecast['minutes_ahead']} min: {trend}, ~{predicted:.1f}°C")
        alerts = [a.message for a in active_alerts(latest, t)]
        if self._notifier.stuck:
            alerts.append(f"Sensor may be stuck ({self._notifier.stuck} for hours).")
        if self._notifier.mold_message:
            alerts.append(self._notifier.mold_message)
        lines.append("⚠️ " + "\n⚠️ ".join(alerts) if alerts else "✅ No alerts.")
        if self._history is not None:
            week = humid_hours(self._history, t.HUMIDITY_HIGH, time.time() - 7 * 86400)
            lines.append(f"💧 Above {t.HUMIDITY_HIGH:g}% for {week:.1f} h in the last 7 days.")
        lamp = self._notifier.lamp
        if lamp and lamp.lit_by_alert:
            lines.append("💡 Alert lamp is on.")
        muted = self._notifier.muted_until
        if muted:
            lines.append(f"🔕 Alerts paused until {datetime.fromtimestamp(muted):%H:%M}.")
        return "\n".join(lines)
