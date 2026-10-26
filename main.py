"""
Thalpos - backend entry point.

Usage:
    python main.py            run the FastAPI backend
    python main.py --reload   same, with auto-reload for development

The React dashboard is launched separately (see Run_Thalpos.bat).
"""
import logging
import sys

import uvicorn

from config import API_HOST, API_PORT, API_RELOAD
from backend.sleep_bridge import SleepBridge

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)


if __name__ == "__main__":
    sleep_bridge=SleepBridge()
    sleep_bridge.start()
    try:
        uvicorn.run(
            "backend.api:app",
            host=API_HOST,
            port=API_PORT,
            reload=API_RELOAD or "--reload" in sys.argv,
        )
    finally:
        sleep_bridge.stop()
