#!/usr/bin/env bash
# Starts the whole stack every time the Codespace starts:
#   Mosquitto -> simulated board -> FastAPI backend -> React dashboard.
# No hardware and no accounts: Telegram, Alexa and the lamp stay off.
# Logs: logs/*.log. Restart: bash tools/codespaces_start.sh
cd "$(dirname "$0")/.."
mkdir -p logs
pkill -f "tools/simulate_board.py" 2>/dev/null || true
pkill -f "main.py" 2>/dev/null || true
pkill -f "vite" 2>/dev/null || true
pgrep -x mosquitto >/dev/null || mosquitto -d -p 1883

export DISCOVERY_ENABLED=false MQTT_BROKER=127.0.0.1
setsid nohup python tools/simulate_board.py > logs/simulator.log 2>&1 < /dev/null &
setsid nohup python main.py > logs/backend.log 2>&1 < /dev/null &
cd frontend-react
setsid nohup npm run dev > ../logs/frontend.log 2>&1 < /dev/null &
echo "Thalpos is starting: the dashboard opens on port 5173 in a few seconds."
