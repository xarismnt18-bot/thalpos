import pytest

from ai.mqtt_client import InvalidPacket, SharedMQTTClient, parse_payload


def test_old_firmware_payload_still_works():
    r = parse_payload('{"room":"Bedroom","temperature":24.2,"humidity":55}')
    assert r == {"room": "Bedroom", "temperature": 24.2, "humidity": 55.0}


def test_v3_fields_are_kept():
    r = parse_payload('{"room":"Bedroom","temperature":23.46,"humidity":51.2,"sensor":"SHT31",'
                      '"presence":true,"ip":"192.168.1.20","wifi":"Home","rssi":-61,"fw":"3.0"}')
    assert r["presence"] is True and r["sensor"] == "SHT31" and r["rssi"] == -61 and r["temperature"] == 23.5


def test_bad_optional_fields_are_ignored():
    r = parse_payload('{"temperature":20,"humidity":50,"presence":"yes","rssi":"strong"}')
    assert "presence" not in r and "rssi" not in r


def test_latest_reports_presence_and_sensor():
    c = SharedMQTTClient(stale_after_sec=60)
    assert c.latest["presence"] is None
    c.ingest('{"temperature":20,"humidity":50,"sensor":"SHT31","presence":false,"fw":"3.0"}')
    latest = c.latest
    assert latest["presence"] is False and latest["sensor"] == "SHT31" and latest["device"] == {"fw": "3.0"}


def test_oled_night_status_does_not_affect_measurements():
    c = SharedMQTTClient(stale_after_sec=60)
    c.ingest('{"temperature":20,"humidity":50,"fw":"3.3","oled_on":false,"oled_clock_ready":true}')
    assert c.latest['temperature']==20 and c.latest['humidity']==50
    assert c.latest['device']['oled_on'] is False
    assert c.latest['device']['oled_clock_ready'] is True


def test_invalid_optional_oled_status_is_not_treated_as_true():
    packet=parse_payload('{"temperature":20,"humidity":50,"oled_on":"false","oled_clock_ready":1}')
    assert 'oled_on' not in packet and 'oled_clock_ready' not in packet


def test_invalid_still_rejected():
    with pytest.raises(InvalidPacket):
        parse_payload('{"temperature":200,"humidity":50}')


@pytest.mark.parametrize("rssi", ["NaN", "1e999", "-1e999", "true", '"strong"', "-500", "12"])
def test_broken_rssi_is_dropped_not_fatal(rssi):
    r = parse_payload('{"temperature":20,"humidity":50,"rssi":%s}' % rssi)
    assert "rssi" not in r and r["temperature"] == 20


@pytest.mark.parametrize("payload", [
    '{"temperature":NaN,"humidity":50}', '{"temperature":1e999,"humidity":50}',
    '{"temperature":true,"humidity":50}', '[1,2]', '"text"', '{"temperature":20}',
])
def test_bad_climate_values_are_rejected(payload):
    with pytest.raises(InvalidPacket):
        parse_payload(payload)


def test_unexpected_error_does_not_escape_the_callback(monkeypatch):
    c = SharedMQTTClient()

    def boom(raw):
        raise RuntimeError("bug")
    monkeypatch.setattr(c, "ingest", boom)

    class Msg:
        payload = b"{}"
    c._on_message(None, None, Msg())          # must not raise
    assert c.latest["invalid_packets"] == 1
