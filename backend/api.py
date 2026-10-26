import logging
import os
import sys
import time
from datetime import datetime
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import PlainTextResponse
from fastapi.middleware.cors import CORSMiddleware

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from config import (  # noqa: E402
    CORS_ORIGINS, HISTORY_MAX_SIZE, SETTINGS_FILE,
    PREDICTION_MINUTES_AHEAD, PREDICTION_LOOKBACK_MIN, SENSOR_STALE_SEC,
    MQTT_PORT, DISCOVERY_ENABLED, DISCOVERY_PORT, DISCOVERY_INTERVAL_SEC, DISCOVERY_KEY,
    TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, NOTIFY_CHECK_SEC, NOTIFY_COOLDOWN_MIN,
    DAILY_SUMMARY_TIME, STATS_FILE, HISTORY_DB, ALERT_STATE_FILE, PREFERENCES_FILE,
    VOICEMONKEY_TOKEN, VOICEMONKEY_DEVICE, VOICE_QUIET_HOURS, VOICE_STATUS_VAR, VOICE_STATUS_SEC, VOICE_STATUS_ENABLED,
    IKEA_HUB_IP, IKEA_TOKEN, IKEA_OUTLET_ID, LAMP_QUIET_HOURS, HUMIDITY_HOLD_MIN, MOLD_EXPOSURE_HOURS,
)
from ai.mqtt_client import SharedMQTTClient  # noqa: E402
from ai.engines import (  # noqa: E402
    PredictionEngine, RecommendationEngine,
    dew_point, health_score, health_status, mold_risk,
)
from backend.settings_store import SettingsStore  # noqa: E402
from backend.alerts import active_alerts  # noqa: E402
from backend.discovery import BrokerBeacon  # noqa: E402
from backend.notifier import AlertNotifier, TelegramClient  # noqa: E402
from backend.daily_stats import DailyStats  # noqa: E402
from backend.telegram_bot import TelegramBot  # noqa: E402
from backend.voice import VoiceAnnouncer, VoiceStatusPublisher  # noqa: E402
from backend.ikea import AlertLamp, IkeaOutlet  # noqa: E402
from backend.history_store import HistoryStore  # noqa: E402
from backend.preferences import Preferences  # noqa: E402
from backend.presence import PresenceWatcher  # noqa: E402

logger = logging.getLogger(__name__)

sensor = SharedMQTTClient(max_history=HISTORY_MAX_SIZE)
settings = SettingsStore(SETTINGS_FILE)
predictor = PredictionEngine(PREDICTION_MINUTES_AHEAD, PREDICTION_LOOKBACK_MIN)
recommender = RecommendationEngine()
beacon = BrokerBeacon(MQTT_PORT, DISCOVERY_PORT, DISCOVERY_INTERVAL_SEC, DISCOVERY_KEY)
telegram = TelegramClient(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)
voice = VoiceAnnouncer(VOICEMONKEY_TOKEN, VOICEMONKEY_DEVICE, VOICE_QUIET_HOURS)
lamp = AlertLamp(IkeaOutlet(IKEA_HUB_IP, IKEA_TOKEN, IKEA_OUTLET_ID), LAMP_QUIET_HOURS)
history_store = HistoryStore(HISTORY_DB)
notifier = AlertNotifier(telegram, sensor, settings, NOTIFY_CHECK_SEC, NOTIFY_COOLDOWN_MIN, voice=voice, lamp=lamp,
                         history=history_store, state_path=ALERT_STATE_FILE,
                         humidity_hold_min=HUMIDITY_HOLD_MIN, mold_hours=MOLD_EXPOSURE_HOURS)
presence = PresenceWatcher(telegram, sensor, notifier, history=history_store, settings=settings)
notifier.presence = presence
preferences = Preferences(PREFERENCES_FILE, voice, lamp, presence)
voice_status = VoiceStatusPublisher(voice, sensor, settings, VOICE_STATUS_VAR, VOICE_STATUS_SEC)
bot = TelegramBot(telegram, notifier, sensor, settings, predictor, DailyStats(STATS_FILE), DAILY_SUMMARY_TIME,
                  history=history_store, preferences=preferences, presence=presence)


@asynccontextmanager
async def lifespan(app: FastAPI):
    sensor.start()
    history_store.start(sensor)
    if DISCOVERY_ENABLED:
        beacon.start()
    notifier.start()
    presence.start()
    bot.start()
    if VOICE_STATUS_ENABLED:
        voice_status.start()
    else:
        voice_status.leave_paused_note()
    yield
    voice_status.stop()
    bot.stop()
    presence.stop()
    notifier.stop()
    beacon.stop()
    history_store.stop()
    sensor.stop()


app = FastAPI(title="Thalpos API", version="6.20.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=False,  # no cookies/auth; required to be False with "*"
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["*"],
)


# =========================
# STATUS / DATA
# =========================
@app.get("/")
def root():
    latest = sensor.latest
    return {
        "message": "Thalpos API is running",
        "version": app.version,
        "mqtt_topic": sensor.topic,
        "broker": sensor.broker,
        "broker_connected": latest["broker_connected"],
        "sensor_online": latest["sensor_online"],
        "sensor_stale_after_sec": SENSOR_STALE_SEC,
    }


@app.get("/latest")
def get_latest():
    since = presence.since
    return {**sensor.latest, "presence_since": round(since) if since else None}


@app.get("/presence/daily")
def get_presence_daily(days: int = Query(7, ge=1, le=30)):
    """Minutes someone was in the room per day (from the radar), oldest first."""
    return {"days": history_store.daily_presence(days), "in_now": presence.occupied, "since": presence.since}


@app.get("/history")
def get_history(limit: int | None = Query(None, ge=1, le=HISTORY_MAX_SIZE)):
    return sensor.history(limit)


@app.get("/history/range")
def get_history_range(hours: float = Query(12, gt=0, le=24 * 30), step: int = Query(300, ge=30, le=86400)):
    """Stored readings (SQLite) averaged per `step` seconds, for charts."""
    return history_store.series(time.time() - hours * 3600, step)


@app.get("/history.csv", response_class=PlainTextResponse)
def get_history_csv(hours: float = Query(24, gt=0, le=24 * 30)):
    """Every stored reading of the last `hours` as a CSV download."""
    name = f"thalpos_history_{datetime.now():%Y%m%d_%H%M}.csv"
    return PlainTextResponse(history_store.csv(time.time() - hours * 3600), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.get("/health")
def get_health():
    latest = sensor.latest
    temp, hum = latest["temperature"], latest["humidity"]

    if temp is None or hum is None:
        return {
            "status": "WAITING_FOR_DATA",
            "health_score": None,
            "message": "No MQTT data received yet",
        }

    score = health_score(temp, hum, settings.thresholds)
    return {
        "status": health_status(score),
        "health_score": score,
        "temperature": temp,
        "humidity": hum,
        "dew_point": dew_point(temp, hum),
        "mold_risk": mold_risk(temp, hum),
        "sensor_online": latest["sensor_online"],
    }


@app.get("/alerts/history")
def get_alert_history(days: float = Query(7, gt=0, le=30)):
    """Alert log, newest first: when each alert started, cleared and whether you were told."""
    return history_store.alert_events(time.time() - days * 86400)


@app.get("/alerts")
def get_alerts():
    alerts = [a.message for a in active_alerts(sensor.latest, settings.thresholds)]
    if notifier.stuck:
        alerts.append(f"Sensor may be stuck: {notifier.stuck} for hours.")
    if notifier.mold_message:
        alerts.append(notifier.mold_message)
    return {"alerts": alerts or ["No active alerts."]}


# =========================
# AI
# =========================
@app.get("/predictions")
def get_predictions():
    return predictor.predict_all(sensor.history(), settings.thresholds)


@app.get("/recommendations")
def get_recommendations():
    t = settings.thresholds
    predictions = predictor.predict_all(sensor.history(), t)
    return {"recommendations": recommender.generate(sensor.latest, predictions, t)}


# =========================
# CONFIG (single source of truth for thresholds)
# =========================
@app.get("/config")
def get_config():
    return {"thresholds": settings.thresholds.as_dict(), "mqtt_topic": sensor.topic}


@app.put("/config")
def put_config(changes: dict[str, float]):
    try:
        updated = settings.update(changes)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return {"thresholds": updated.as_dict(), "mqtt_topic": sensor.topic}


@app.delete("/config")
def reset_config():
    return {"thresholds": settings.reset().as_dict(), "mqtt_topic": sensor.topic}


# =========================
# NOTIFICATIONS
# =========================
@app.get("/notifications")
def get_notifications():
    return {
        "telegram_enabled": telegram.enabled,
        "voice_enabled": voice.enabled,
        "lamp_enabled": lamp.enabled,
        "muted_until": notifier.muted_until,
        **preferences.as_dict(),
    }


@app.put("/notifications")
def put_notifications(changes: dict):
    """Change voice_on, voice_quiet_hours, lamp_auto, lamp_quiet_hours, presence_on,
    presence_quiet_hours, alerts_only_present or airing_reminder (saved across restarts)."""
    try:
        preferences.update(changes)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return get_notifications()


@app.post("/notifications/mute")
def mute_notifications(minutes: float = Query(..., gt=0, le=7 * 24 * 60)):
    """Pauses Telegram and Alexa alerts, like the Telegram /mute command."""
    notifier.mute(minutes * 60)
    return get_notifications()


@app.delete("/notifications/mute")
def unmute_notifications():
    notifier.unmute()
    return get_notifications()


@app.post("/notifications/test")
def send_test_notification():
    room = sensor.latest.get("room") or "Thalpos"
    try:
        notifier.telegram.send(f"👋 Test from Thalpos: Telegram alerts for {room} are working.")
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    return {"sent": True}


@app.post("/voice/test")
def send_test_announcement():
    try:
        voice.announce("This is a test from your smart home. Voice alerts are working.")
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    return {"sent": True}


@app.get("/voice/status")
def get_voice_status():
    """The sentence Alexa reads for "Alexa, bedroom status", and whether it reached Voice Monkey."""
    return {
        "enabled": voice.enabled and VOICE_STATUS_ENABLED,
        "variable": voice_status.variable,
        "text": voice_status.text,
        "last_error": voice_status.last_error,
    }


@app.get("/lamp")
def get_lamp():
    return {"enabled": lamp.enabled, "auto": lamp.auto, "lit_by_alert": lamp.lit_by_alert,
            "quiet_hours": lamp.quiet_hours}


@app.put("/lamp/auto")
def set_lamp_auto(on: bool):
    preferences.update({"lamp_auto": on})
    return get_lamp()


@app.post("/lamp")
def set_lamp(on: bool):
    try:
        lamp.manual(on, alert_active=bool(notifier.active_keys))
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    return {"on": on}
