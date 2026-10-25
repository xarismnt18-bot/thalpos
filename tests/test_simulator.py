import json

from ai.mqtt_client import parse_payload
from tools.simulate_board import SimulatedRoom


def test_simulated_board_sends_what_the_backend_accepts():
    room = SimulatedRoom(seed=1)
    seen_presence = set()
    for i in range(1, 400):
        reading = parse_payload(json.dumps(room.step(i * 3.0, 3.0)))
        assert 15 < reading["temperature"] < 32 and 30 < reading["humidity"] < 80
        seen_presence.add(reading["presence"])
    assert seen_presence == {True, False}        # someone comes and goes
