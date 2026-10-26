"""Manage the optional private sleep service alongside the main Thalpos process."""
import logging
import os
import socket
import subprocess
import sys
from pathlib import Path

from dotenv import dotenv_values

logger=logging.getLogger(__name__)


class SleepBridge:
    def __init__(self, root=None):
        self.root=Path(root or Path(__file__).resolve().parents[1])
        self.process=None

    def start(self):
        values=dotenv_values(self.root/'sleep_sync.env')
        token=os.environ.get('SLEEP_SYNC_TOKEN') or values.get('SLEEP_SYNC_TOKEN')
        if not token:
            logger.info('Wearable sleep is optional: run setup_sleep_sync.bat to pair it.')
            return False
        if len(token)<32:
            logger.warning('Sleep bridge not started: pairing key is invalid. Run setup_sleep_sync.bat.')
            return False
        try:
            with socket.create_connection(('127.0.0.1',8001),timeout=.4):
                logger.warning('Sleep port 8001 is already in use; leaving that process untouched.')
                return False
        except OSError:
            pass
        flags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0
        try:
            self.process=subprocess.Popen(
                [sys.executable,'-m','uvicorn','backend.wearable_api:configured_app','--factory',
                 '--host','127.0.0.1','--port','8001','--no-access-log'],
                cwd=self.root,creationflags=flags,
            )
            logger.info('Private sleep bridge started alongside Thalpos on 127.0.0.1:8001.')
            return True
        except OSError:
            logger.exception('Could not start optional sleep bridge; main Thalpos will still run.')
            return False

    def stop(self):
        if self.process is None:
            return
        if self.process.poll() is None:
            if sys.platform=='win32':
                # Windows venv redirectors can own a second Python process.
                # Stop our child tree, not only its launcher, to avoid orphans.
                subprocess.run(['taskkill','/PID',str(self.process.pid),'/T','/F'],
                               stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=False)
            else:
                self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        self.process=None
