#!/usr/bin/env bash
# Codespaces (.devcontainer/devcontainer.json): runs once when the Codespace is created: broker, Python and dashboard packages.
set -e
sudo apt-get update -qq
sudo apt-get install -y -qq mosquitto >/dev/null
pip install -q -r requirements.txt
(cd frontend-react && npm ci --no-audit --no-fund)
