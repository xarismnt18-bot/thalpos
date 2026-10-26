# API and configuration

[← Back to the README](../README.md)

## REST API

The backend listens on `http://127.0.0.1:8000` (the dashboard reaches it at `/api`). Interactive docs: http://127.0.0.1:8000/docs.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | API, broker and sensor status |
| `/latest` | GET | Latest reading and connection state, plus `presence`, `presence_since`, `sensor` and device info |
| `/history?limit=N` | GET | Recent readings kept in memory |
| `/history/range?hours=12&step=300` | GET | Stored history, averaged for charts |
| `/history.csv?hours=24` | GET | Every stored reading as CSV |
| `/health` | GET | Health score, dew point, mold risk |
| `/alerts` | GET | Active alerts |
| `/alerts/history?days=7` | GET | Alert log, newest first |
| `/presence/daily?days=7` | GET | Minutes someone was in the room per day, and whether someone is in now |
| `/predictions` | GET | 10-minute forecasts for temperature and humidity, with `generated_at` and `data_age_sec`. When the newest reading is over 2 minutes old the result is `stale: true` and carries no forecast |
| `/recommendations` | GET | Suggested actions |
| `/config` | GET / PUT / DELETE | Read, update (partial JSON) or reset the thresholds |
| `/notifications` | GET / PUT | Channels set up, pause state, and the on/off and quiet-hours settings (`voice_on`, `voice_quiet_hours`, `lamp_auto`, `lamp_quiet_hours`, `presence_on`, `presence_quiet_hours`, `alerts_only_present`, `airing_reminder`) |
| `/notifications/mute?minutes=60` | POST / DELETE | Pause or resume messages |
| `/notifications/test` | POST | Send a Telegram test message |
| `/voice/test`, `/voice/status` | POST / GET | Alexa test sentence / the status sentence |
| `/lamp`, `/lamp/auto` | GET, POST / PUT | Alert lamp state, switch it, automation on/off |

## Configuration

Settings come from `.env` (copy `.env.example`); `config.py` has the full list.

| Variable | Default | Description |
|----------|---------|-------------|
| `MQTT_BROKER` / `MQTT_PORT` | `127.0.0.1` / `1883` | Broker address as seen by the backend |
| `MQTT_TOPIC` | `smartroom/dht11` | Topic the sensor publishes on |
| `SENSOR_STALE_SEC` | `30` | Seconds without packets before the sensor counts as offline |
| `DISCOVERY_ENABLED` / `DISCOVERY_PORT` | `true` / `18831` | Broadcast the broker's address so the board finds it |
| `TEMP_HIGH` / `TEMP_LOW` | `27` / `18` | Initial temperature limits (°C) |
| `HUMIDITY_HIGH` / `HUMIDITY_LOW` | `70` / `35` | Initial humidity limits (%) |
| `HUMIDITY_HOLD_MIN` | `20` | Minutes above the humidity limit before *humid* is sent (critical humidity is sent at once) |
| `MOLD_EXPOSURE_HOURS` | `3` | Hours above the humidity limit without a break before the mold-risk alert |
| `NOTIFY_COOLDOWN_MIN` | `30` | Minimum minutes between two messages for the same alert |
| `DAILY_SUMMARY_TIME` | `09:00` | When the morning summary is sent |
| `VOICE_QUIET_HOURS` / `LAMP_QUIET_HOURS` | `23:00-08:00` | Default quiet hours |
| `VOICE_STATUS_ENABLED` / `VOICE_STATUS_SEC` | on / `300` | "Alexa, bedroom status" kept current, at most every 5 minutes (free plan). Off: a timed snapshot, at most 3 updates a day |
| `API_RELOAD` | `false` | Reload the backend on code changes |

Thresholds changed in the dashboard are saved to `data/settings.json` and override `.env`; **Reset to defaults** deletes that file. Notification settings are saved to `data/preferences.json`.

## How the forecasts work

A weighted linear regression over the last few minutes, fitted against the real timestamps, so the 10-minute horizon is right whatever the sensor's send rate. The confidence comes from the spread of the residuals and is widened the further the forecast reaches beyond the observed window.

## Online demo

`VITE_DEMO=1 npm run build` builds the dashboard with an in-browser stand-in for the backend (`frontend-react/src/lib/demoApi.js`, using the same formulas as the Python engines). `publish_demo.bat` builds it this way and pushes it to the `gh-pages` branch, which GitHub Pages serves.

## ML demos

The scripts in `ai/` that use CO₂ and power (`train_occupancy_model.py`, `train_anomaly_model.py`, `anomaly_detection.py`, `live_prediction.py`) run on **simulated** data from `sensors/fake_sensor_generator.py`, because the room sensor measures neither. The occupancy labels are derived from rules, so these are pipeline demos, not validated models, and the backend doesn't use them.

```bash
python sensors/fake_sensor_generator.py   # collect simulated rows (Ctrl+C to stop)
python ai/train_occupancy_model.py
python ai/train_anomaly_model.py
python ai/anomaly_detection.py
```
