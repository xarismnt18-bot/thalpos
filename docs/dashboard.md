# Dashboard

[← Back to the README](../README.md)

Open http://localhost:5173 on the PC, or the Tailscale link on the phone (see [Running it at home](running.md)).

## Pages

| Page | What it shows |
|------|---------------|
| **Dashboard** | Full-screen 3D twin of the home with the live readings, trend, alerts, outside weather and the packet stream. Views: temperature, humidity, X-ray. Click a room to fly to it. The live room turns red and pulses on an alert, and grey when there is no data. While the radar sees someone, a hologram stands in the room with how long they have been there |
| **Floorplan** | 2D overview of the rooms |
| **Analytics** | Temperature and humidity charts: live hour, 24 hours, 7 or 30 days. Gaps (sensor off) stay empty. Below them, **time in the room** for each of the last 7 days, from the radar |
| **Sleep** | How the bedroom was overnight, night by night: a room score out of 100 (100 = the whole night inside the ideal 16–20 °C and 40–60 %), when you went to bed and got up (from the radar; 23:00–07:00 marked *estimated* without it), times you left the room, average and range, time too warm / cold / humid / dry, one tip, the last 7 nights, and the night hour by hour. The score rates the room, not your sleep. Nights when the PC was off show no score |
| **AI Brain** | Rule-based comfort analysis and deviation check |
| **Predictions** | 10-minute forecasts with confidence |
| **Energy** | **Simulated** power estimate (no power meter connected) |
| **MQTT Stream** | Every packet as it arrives |
| **Alerts** | Active alerts, dew point, mold risk and the alert history (24 h, 7 or 30 days): when each alert started, how long it lasted and whether you were told |
| **Reports** | Summary statistics, distribution charts and CSV downloads of the stored history |
| **Settings** | Thresholds, pause alerts, and on/off and quiet hours for Alexa, the lamp and the enter/leave messages |

## Connection states

The badges at the top tell three problems apart:

- **API offline**: the dashboard can't reach the backend.
- **Broker offline**: the backend can't reach Mosquitto. It retries every 1–30 s.
- **Sensor offline**: the broker is up, but no valid packet arrived for 30 s (`SENSOR_STALE_SEC`).

Malformed or out-of-range packets are ignored and counted; they don't mark the system offline.

## Outside weather and "open the window?"

The weather card shows the conditions where you are, from [Open-Meteo](https://open-meteo.com/) (free, no key). Your location comes from the browser, or roughly from your internet connection if you don't allow it, and is never sent to the backend. You can also pick a town by hand.

It then says whether opening the window would help. Humidity is compared as **absolute** humidity (grams of water per m³), so cold air that reads "90%" outside can still dry a warm room. It never suggests airing in rain or freezing weather, or when it would only warm a hot room or cool a cold one.

## History and exports

The backend stores a reading every 30 seconds in `data/history.db` (SQLite) and keeps 30 days. Nothing is stored while the sensor is offline, so gaps show when it was off.

- **Reports → Download stored readings**: CSV for today, 24 hours, 7 or 30 days.
- **API**: `GET /history.csv?hours=24` downloads every reading, `GET /history/range?hours=12&step=300` returns averages for charts.
- **Stuck sensor**: if humidity or temperature hasn't changed at all for 3 hours, Telegram warns that the sensor may be stuck.

## Install on the phone

Open the Tailscale link on the phone and choose *Add to Home screen* (Safari: Share → Add to Home Screen; Chrome: ⋮ → Install app). Thalpos then opens full-screen with its own icon. Its small service worker only shows an "offline" page when the PC can't be reached; it never caches readings, so what you see is always live.
