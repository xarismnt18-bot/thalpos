"""
A stand-in for the ESP8266 board: publishes the same MQTT message the real
firmware sends, so the whole stack (broker, backend, dashboard, alerts) runs
without any hardware. Used by the GitHub Codespaces demo (.devcontainer).

The room slowly warms and gets more humid while someone is in, and cools down
again when it is empty; someone comes and goes every few minutes.

    python tools/simulate_board.py            # every 3 s, until Ctrl+C
    python tools/simulate_board.py --fast     # a simulated day goes by quicker
"""
import json
import math
import os
import random
import sys
import time

import paho.mqtt.client as mqtt

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from config import MQTT_BROKER, MQTT_PASSWORD, MQTT_PORT, MQTT_TOPIC, MQTT_USERNAME  # noqa: E402

SEND_EVERY_SEC = 3


class SimulatedRoom:
    def __init__(self, seed: int | None = None):
        self.rng = random.Random(seed)
        self.temperature = 23.0
        self.humidity = 50.0
        self.present = True
        self.next_switch = self.rng.uniform(120, 300)   # seconds until someone comes or goes

    def step(self, t: float, dt: float) -> dict:
        if t >= self.next_switch:
            self.present = not self.present
            self.next_switch = t + (self.rng.uniform(240, 600) if self.present else self.rng.uniform(90, 240))
        # a person warms the room and adds moisture; an empty room drifts back
        target_t = 25.5 if self.present else 22.5
        target_h = 62.0 if self.present else 50.0
        day = 0.6 * math.sin(t / 900)                      # a slow outside swing
        self.temperature += (target_t + day - self.temperature) * dt / 900 + self.rng.gauss(0, 0.02)
        self.humidity += (target_h - self.humidity) * dt / 1200 + self.rng.gauss(0, 0.08)
        return {
            "room": "Bedroom",
            "temperature": round(self.temperature, 2),
            "humidity": round(min(max(self.humidity, 0), 100), 1),
            "presence": self.present,
            "sensor": "SHT31",
            "fw": "sim",
            "wifi": "simulated",
            "rssi": -55,
            "ip": "127.0.0.1",
        }


def main() -> None:
    speed = 20 if "--fast" in sys.argv else 1
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="thalpos-simulated-board")
    if MQTT_USERNAME:
        client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)
    while True:
        try:
            client.connect(MQTT_BROKER, MQTT_PORT, 60)
            break
        except OSError as e:
            print(f"Waiting for the MQTT broker at {MQTT_BROKER}:{MQTT_PORT} ({e})")
            time.sleep(2)
    client.loop_start()
    room, t = SimulatedRoom(), 0.0
    print(f"Simulated board publishing to {MQTT_TOPIC} every {SEND_EVERY_SEC} s")
    try:
        while True:
            t += SEND_EVERY_SEC * speed
            client.publish(MQTT_TOPIC, json.dumps(room.step(t, SEND_EVERY_SEC * speed)))
            time.sleep(SEND_EVERY_SEC)
    except KeyboardInterrupt:
        pass
    finally:
        client.loop_stop()
        client.disconnect()


if __name__ == "__main__":
    main()
