# Notifications

[← Back to the README](../README.md)

All notifiers run inside the backend. Each one is off until you run its setup script, and its secrets are stored in a git-ignored `.env` file.

## Telegram

Run `setup_telegram.bat` and follow the prompts: create a bot with @BotFather, paste its token and press **Start** in the bot chat. The script saves the token and your chat id in `telegram.env` and sends a test message.

**Alerts.** You get a message when an alert starts or clears and when the sensor stops sending. To avoid noise:

- a change must hold for two checks (about 30 s) before it is reported;
- the same alert repeats at most every 30 minutes (`NOTIFY_COOLDOWN_MIN`);
- alerts already sent are remembered for 24 hours, so restarting Thalpos doesn't repeat them.

**Someone comes in or leaves.** With the radar connected you get:

- 🚶 *Someone came into the Bedroom (20:45).* after the radar has seen someone for 5 seconds;
- 🚪 *The Bedroom is empty now (21:30). Someone was there for 45 min.* after the room has been empty for 1 minute. The wait avoids a false "left" while someone sits very still.

**Time to air the room.** After someone has been in for 2 hours, if the humidity has climbed 3 points in the last hour (or is within 5 points of the limit), you get one reminder per stay: 🪟 *Someone has been in the Bedroom for 2 h 10 min and the humidity went from 52% to 58% in the last hour. Open the window for 5–10 minutes.*

**Humidity over time, not single spikes.** A shower or a boiling pot can push the humidity over the limit for a few minutes; that is not worth a message. *Humid* is sent only once the humidity has stayed above the limit for 20 minutes (`HUMIDITY_HOLD_MIN`); a critical level (85%) is sent at once. Mold needs damp air that lasts, so after 3 hours above the limit without a break (`MOLD_EXPOSURE_HOURS`) a separate alert follows: 🍄 *Bedroom has been humid for 3.2 hours without a break (above 70%, now 76%). Mold grows when damp air lasts: air the room well or run a dehumidifier.* Dips of up to 2 points under the limit and short gaps in the data don't break the stretch. A sensor that looks stuck never raises it. `/status` also shows how many hours the room spent above the limit in the last 7 days.

**Comfort alerts only while someone is in.** While the radar says the room is empty, too hot, too cold, too humid or too dry alerts wait: they are sent when someone comes in, if the problem is still there. Critical levels (mold-risk humidity, heat) and sensor problems always come through. The dashboard shows every alert either way.

If the radar stops reporting (sensor offline) for a minute, presence becomes *unknown*: no message is sent, and the current visit is closed at the last reading, so offline time never counts as time in the room.

All three are in **Settings → Alerts & quiet hours → Someone in the room**.

**Morning summary.** Every day at 09:00 (`DAILY_SUMMARY_TIME`) the bot sends yesterday's range with a chart and how long each limit was crossed.

**Commands** (answered only in your chat):

| Command | Reply |
|---------|-------|
| `/status` | Current readings, health, 10-minute forecast and active alerts |
| `/today` | Today's min, max, average and time out of comfort |
| `/night` | Hour by hour for the last 10 hours with a chart (`/night 24` for a day) |
| `/presence` | Time someone was in the room today and on each of the last 7 days |
| `/mute 2h` | Pause all messages (`30m`, `2h`, `1d`; default 1 hour) |
| `/unmute` | Resume messages |
| `/voice on`, `/voice off`, `/voice test`, `/voice status` | Alexa announcements |
| `/lamp on`, `/lamp off`, `/lamp auto on`, `/lamp auto off` | The alert lamp |

## Alexa (optional)

New alerts can be spoken by an Amazon Echo through [Voice Monkey](https://voicemonkey.io).

1. Sign in at Voice Monkey, enable its skill in the Alexa app and add your Echo as a Speaker device.
2. In the Alexa app create a Routine: *When* Smart Home → Alexa Voice Monkey v3 → VM Speakers → your speaker; *Action* the Voice Monkey skill; *From* your Echo.
3. Run `setup_voice.bat` and paste the API token. The Echo says hello.

Only new alerts are spoken, the same alert at most every 6 hours and at most 5 a day (the free plan allows 200 requests a month). Alexa stays silent during its quiet hours (23:00–08:00 by default) and while `/mute` is on. Announcements are in English.

**"Alexa, bedroom status"** needs a paid Voice Monkey plan. With `VOICE_STATUS_ENABLED=1`, Thalpos keeps a sentence such as *"The bedroom is 24 degrees, with 55 percent humidity"* in the Voice Monkey variable `THALPOS_STATUS`. Create a Voice Monkey Flow with one Speech node whose text is `{THALPOS_STATUS}`, and an Alexa Routine that says *"ask voice monkey to start flow <reference>"* when you say *"bedroom status"*.

## Alert lamp (optional)

A lamp on an IKEA smart plug lights up while a temperature or humidity alert is active. It stays on at least 10 minutes so a reading hovering at the limit can't make it flicker, and stays dark during its quiet hours (23:00–08:00).

Thalpos talks to the IKEA DIRIGERA hub over its local API (no cloud). With the plug already working in the IKEA Home smart app, run `setup_ikea.bat` and press the button under the hub when asked. The lamp flashes once to confirm.

## Quiet hours and pausing

| Control | Affects |
|---------|---------|
| `/mute` in Telegram or **Pause** in Settings | Telegram, Alexa and enter/leave messages |
| Alexa quiet hours | Spoken alerts |
| Lamp quiet hours | The alert lamp |
| Enter/leave quiet hours | The 🚶 and 🚪 messages |

The dashboard always shows every alert, whatever is paused.
