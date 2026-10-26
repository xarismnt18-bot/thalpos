import pytest

from backend.ikea import AlertLamp
from backend.notifier import AlertNotifier
from backend.telegram_bot import TelegramBot, parse_duration
from conftest import FakeOutlet, FakeSensor, FakeSettings, FakeTelegram, reading


@pytest.mark.parametrize("text,sec", [("", 3600), ("30m", 1800), ("2h", 7200), ("1d", 86400), ("45", 2700)])
def test_parse_duration(text, sec):
    assert parse_duration(text) == sec


@pytest.mark.parametrize("text", ["abc", "0m", "8d", "-5m"])
def test_parse_duration_rejects(text):
    assert parse_duration(text) is None


@pytest.fixture
def bot(thresholds, tmp_path):
    from backend.daily_stats import DailyStats
    sensor, telegram = FakeSensor(reading(24, 80)), FakeTelegram()
    n = AlertNotifier(telegram, sensor, FakeSettings(thresholds), 15, 30, lamp=AlertLamp(FakeOutlet(), ""))

    class Predictor:
        def predict_all(self, history, t):
            return {"temperature": {"trend": "unknown"}, "minutes_ahead": 10}

    return TelegramBot(telegram, n, sensor, FakeSettings(thresholds), Predictor(),
                       DailyStats(str(tmp_path / "s.json")), "09:00")


def test_status_lists_alerts(bot):
    text = bot.handle("/status")
    assert "24.0°C, 80%" in text and "Humidity is above" in text


def test_mute_and_unmute(bot):
    assert "paused until" in bot.handle("/mute 2h")
    assert bot._notifier.muted_until
    bot.handle("/unmute")
    assert not bot._notifier.muted_until


def test_lamp_commands(bot):
    assert bot.handle("/lamp on") == "💡 Lamp on."
    assert bot._notifier.lamp.outlet.calls == [True]
    bot.handle("/lamp auto off")
    assert bot._notifier.lamp.auto is False


def test_unknown_command_and_plain_text(bot):
    assert bot.handle("/nope").startswith("I don't know")
    assert bot.handle("hello") is None


def test_night_sends_chart_and_text(bot, tmp_path):
    import time
    from backend.history_store import HistoryStore
    store = HistoryStore(str(tmp_path / "n.db"))
    now = time.time()
    for i in range(240):
        store.record(reading(24, 70 + i % 3), ts=now - i * 30)
    bot._history = store
    text = bot.handle("/night 2")
    assert text.startswith("🌙 Last 2 hours")
    photos = [m for m in bot.telegram.sent if isinstance(m, tuple)]
    assert len(photos) == 1 or __import__("importlib").util.find_spec("matplotlib") is None


def test_presence_command(bot, tmp_path):
    from backend.history_store import HistoryStore
    import time as _t
    bot._history = HistoryStore(str(tmp_path / "h.db"))
    now = _t.time()
    bot._history.visit_started(now - 300)
    text = bot.handle("/presence")
    assert "today" in text and "Last 7 days" in text and "5 min" in text


def test_sleep_command(bot, tmp_path):
    from datetime import datetime, timedelta
    from backend.history_store import HistoryStore
    bot._history = HistoryStore(str(tmp_path / "s.db"))
    assert "No night with readings yet" in bot.handle("/sleep")
    morning = datetime(2026, 10, 20)  # a night without a daylight-saving change
    start, end = (morning - timedelta(hours=1)).timestamp(), (morning + timedelta(hours=7)).timestamp()
    ts = start - 3600
    while ts <= end + 3600:
        bot._history.record(reading(22.0, 55.0), ts=ts)
        ts += 30
    bot._history.visit_started(start)
    bot._history.visit_ended(end)
    text = bot.sleep_text(now=(morning + timedelta(hours=13)).timestamp())
    assert "room score 80/100" in text and "23:00–07:00" in text and "Too warm for 8.0 h" in text
