"""
Shared MQTT client - thread-safe store for the latest reading and history.

Connection state is tracked in two layers:
  * broker_connected - the TCP/MQTT session with Mosquitto is up
  * sensor_online    - a valid packet arrived within SENSOR_STALE_SEC
The dashboard's "connected" flag is the combination of both, so a dead
ESP8266 shows as offline even while the broker is still reachable.
"""
import json
import logging
import math
import os
import sys
import threading
import time
from collections import deque
from datetime import datetime

import paho.mqtt.client as mqtt

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from config import (  # noqa: E402
    MQTT_BROKER, MQTT_PORT, MQTT_TOPIC, MQTT_KEEPALIVE, SENSOR_STALE_SEC,
    MQTT_USERNAME, MQTT_PASSWORD,
)

logger = logging.getLogger(__name__)

# Physical limits of the DHT11/DHT22 family; anything outside is a bad read.
TEMP_RANGE = (-40.0, 80.0)
HUMIDITY_RANGE = (0.0, 100.0)
RSSI_RANGE = (-127, 0)   # Wi-Fi signal in dBm as the ESP8266 reports it
DEFAULT_ROOM = "My Room"


class InvalidPacket(ValueError):
    """Raised when an MQTT payload cannot be turned into a reading."""


def parse_payload(raw: bytes | str) -> dict:
    """Validate a sensor payload and return {room, temperature, humidity, ...}.

    Optional fields from firmware 2.0+/3.0+ are passed through when present:
    presence (bool, mmWave radar), sensor ("SHT31"/"DHT11"), fw, wifi, rssi, ip.
    """
    try:
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise TypeError("payload is not a JSON object")
        temperature = _number(payload["temperature"])
        humidity = _number(payload["humidity"])
    except (ValueError, TypeError, KeyError, OverflowError) as e:
        raise InvalidPacket(f"unreadable payload: {e}") from e

    if not TEMP_RANGE[0] <= temperature <= TEMP_RANGE[1]:
        raise InvalidPacket(f"temperature out of range: {temperature}")
    if not HUMIDITY_RANGE[0] <= humidity <= HUMIDITY_RANGE[1]:
        raise InvalidPacket(f"humidity out of range: {humidity}")

    reading = {
        "room": str(payload.get("room") or DEFAULT_ROOM),
        "temperature": round(temperature, 1),
        "humidity": round(humidity, 1),
    }
    if isinstance(payload.get("presence"), bool):
        reading["presence"] = payload["presence"]
    for key in ("sensor", "fw", "wifi", "ip"):
        if isinstance(payload.get(key), str) and payload[key]:
            reading[key] = payload[key][:40]
    rssi = _optional_number(payload.get("rssi"))
    if rssi is not None and RSSI_RANGE[0] <= rssi <= RSSI_RANGE[1]:
        reading["rssi"] = int(round(rssi))
    elif "rssi" in payload:
        logger.debug("Dropping invalid rssi field: %r", payload.get("rssi"))
    return reading


BACKLOG_MAX_AGE_SEC = 2 * 86400   # the board keeps 10 hours; anything older is nonsense


def parse_backlog(raw: bytes | str, received: float) -> tuple[str, list[tuple[float, float, float, bool]]]:
    """A backlog message from firmware 3.2+ (readings kept while the broker was
    unreachable): {"room": ..., "readings": [[age_sec, temperature, humidity, presence], ...]}.
    Returns (room, [(ts, temperature, humidity, presence)]) oldest first; rows
    that are out of range are dropped one by one."""
    try:
        payload = json.loads(raw)
        if not isinstance(payload, dict) or not isinstance(payload.get("readings"), list):
            raise TypeError("not a backlog object")
    except (ValueError, TypeError) as e:
        raise InvalidPacket(f"unreadable backlog: {e}") from e
    rows = []
    for item in payload["readings"]:
        try:
            age, temperature, humidity = (_number(v) for v in item[:3])
            presence = bool(item[3]) if len(item) > 3 else False
        except (ValueError, TypeError, IndexError, OverflowError):
            continue
        if (0 <= age <= BACKLOG_MAX_AGE_SEC and TEMP_RANGE[0] <= temperature <= TEMP_RANGE[1]
                and HUMIDITY_RANGE[0] <= humidity <= HUMIDITY_RANGE[1]):
            rows.append((round(received - age, 1), round(temperature, 1), round(humidity, 1), presence))
    return str(payload.get("room") or DEFAULT_ROOM), sorted(rows)


def _number(value) -> float:
    """A finite number; bools and strings like "NaN" are rejected."""
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise TypeError(f"not a number: {value!r}")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"not a finite number: {value!r}")
    return number


def _optional_number(value) -> float | None:
    """Like _number, but an optional field that is broken is simply left out."""
    if value is None:
        return None
    try:
        return _number(value)
    except (TypeError, ValueError, OverflowError):
        return None


class SharedMQTTClient:
    """MQTT subscriber that keeps the latest reading and a bounded history."""

    def __init__(self, broker=None, port=None, topic=None, max_history=500,
                 stale_after_sec=SENSOR_STALE_SEC):
        self._broker = broker or MQTT_BROKER
        self._port = port or MQTT_PORT
        self._topic = topic or MQTT_TOPIC
        self._stale_after = stale_after_sec

        self._lock = threading.Lock()
        self._reading: dict | None = None
        self._last_seen: float | None = None
        self._broker_connected = False
        self._invalid_packets = 0
        self._history: deque[dict] = deque(maxlen=max_history)
        self._client: mqtt.Client | None = None
        # called with (room, rows) for each backlog message; set by the app (history store)
        self.on_backlog = None

    # --- public API ---------------------------------------------------

    @property
    def topic(self) -> str:
        return self._topic

    @property
    def backlog_topic(self) -> str:
        return self._topic + "/backlog"

    def ingest_backlog(self, raw: bytes | str, received: float | None = None) -> int:
        """Hands a backlog message to on_backlog. The live reading is not touched:
        these values are minutes or hours old. Returns how many rows were valid."""
        try:
            room, rows = parse_backlog(raw, received or time.time())
        except InvalidPacket as e:
            logger.warning("Ignoring MQTT backlog: %s", e)
            with self._lock:
                self._invalid_packets += 1
            return 0
        if rows and self.on_backlog:
            self.on_backlog(room, rows)
        return len(rows)

    @property
    def broker(self) -> str:
        return f"{self._broker}:{self._port}"

    @property
    def latest(self) -> dict:
        with self._lock:
            reading = dict(self._reading) if self._reading else None
            last_seen = self._last_seen
            broker_connected = self._broker_connected
            invalid = self._invalid_packets

        age = None if last_seen is None else round(time.time() - last_seen, 1)
        sensor_online = age is not None and age <= self._stale_after

        return {
            "room": reading["room"] if reading else DEFAULT_ROOM,
            "temperature": reading["temperature"] if reading else None,
            "humidity": reading["humidity"] if reading else None,
            "last_update": reading["timestamp"] if reading else None,
            "seconds_since_update": age,
            "broker_connected": broker_connected,
            "sensor_online": sensor_online,
            "connected": broker_connected and sensor_online,
            "invalid_packets": invalid,
            # None when the board has no radar (or runs older firmware)
            "presence": reading.get("presence") if reading and sensor_online else None,
            "sensor": reading.get("sensor", "DHT11") if reading else None,
            "device": {k: reading[k] for k in ("fw", "wifi", "rssi", "ip") if k in reading} if reading else {},
        }

    def history(self, limit: int | None = None) -> list[dict]:
        with self._lock:
            items = list(self._history)
        return items[-limit:] if limit else items

    def ingest(self, raw: bytes | str) -> dict | None:
        """Parse and store one payload. Returns the stored packet, or None if invalid."""
        try:
            reading = parse_payload(raw)
        except InvalidPacket as e:
            # A single bad read must not flip the whole system to "offline".
            logger.warning("Ignoring MQTT packet: %s", e)
            with self._lock:
                self._invalid_packets += 1
            return None

        now = time.time()
        packet = {
            **reading,
            "timestamp": datetime.fromtimestamp(now).astimezone().isoformat(timespec="seconds"),
            "ts": round(now, 3),
        }
        with self._lock:
            self._reading = packet
            self._last_seen = now
            self._history.append(packet)
        return packet

    def start(self):
        """Connect in the background; paho keeps retrying until the broker is up."""
        self._client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
        self._client.on_connect = self._on_connect
        self._client.on_message = self._on_message
        self._client.on_disconnect = self._on_disconnect
        if MQTT_USERNAME:
            self._client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)
        else:
            logger.warning("No MQTT credentials set - connecting anonymously")
        self._client.reconnect_delay_set(min_delay=1, max_delay=30)
        self._client.connect_async(self._broker, self._port, MQTT_KEEPALIVE)
        self._client.loop_start()
        logger.info("MQTT client starting -> %s (topic %s)", self.broker, self._topic)

    def stop(self):
        if self._client:
            self._client.loop_stop()
            self._client.disconnect()

    # --- callbacks ----------------------------------------------------

    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        ok = reason_code == 0
        with self._lock:
            self._broker_connected = ok
        if ok:
            client.subscribe([(self._topic, 0), (self.backlog_topic, 0)])
            logger.info("Connected to MQTT broker, subscribed to %s", self._topic)
        else:
            logger.warning("MQTT connect refused: %s", reason_code)

    def _on_disconnect(self, client, userdata, flags, reason_code, properties=None):
        with self._lock:
            self._broker_connected = False
        logger.warning("MQTT disconnected (%s) - will retry automatically", reason_code)

    def _on_message(self, client, userdata, msg):
        # Nothing a packet contains may stop paho's receive loop.
        try:
            if msg.topic == self.backlog_topic:
                self.ingest_backlog(msg.payload)
            else:
                self.ingest(msg.payload)
        except Exception:
            logger.exception("Unexpected error while handling an MQTT packet")
            with self._lock:
                self._invalid_packets += 1
