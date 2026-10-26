"""
IKEA smart plug through the DIRIGERA hub's local API: no cloud, no request
quota. Used for the alert lamp. Off until setup_ikea.bat has stored the hub
address, an access token and the plug's id in ikea.env.
"""
import json
import logging
import ssl
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime

from backend.voice import in_quiet_hours

logger = logging.getLogger(__name__)

# The hub serves HTTPS on the LAN with a self-signed certificate.
_TLS = ssl.create_default_context()
_TLS.check_hostname = False
_TLS.verify_mode = ssl.CERT_NONE

LAMP_ALERT_KEYS = {"temp_high", "temp_low", "humidity_high", "humidity_low", "mold_risk"}
MIN_ON_SEC = 10 * 60  # a reading hovering at the limit must not make the lamp flicker


class IkeaOutlet:
    def __init__(self, hub_ip: str | None, token: str | None, device_id: str | None):
        self._base = f"https://{hub_ip}:8443/v1" if hub_ip else None
        self._token = token
        self._device_id = device_id

    @property
    def enabled(self) -> bool:
        return bool(self._base and self._token and self._device_id)

    def set_on(self, on: bool) -> None:
        self._request("PATCH", f"/devices/{self._device_id}", [{"attributes": {"isOn": on}}])

    def _request(self, method: str, path: str, body=None):
        """Raises RuntimeError with a readable reason if the hub can't be used."""
        if not self.enabled:
            raise RuntimeError("The IKEA plug is not set up. Run setup_ikea.bat.")
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(
            self._base + path, data=data, method=method,
            headers={"Authorization": f"Bearer {self._token}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=8, context=_TLS) as response:
                raw = response.read()
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"IKEA hub refused the request (HTTP {e.code}).") from None
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise RuntimeError(f"Could not reach the IKEA hub: {e}") from None
        return json.loads(raw) if raw else None


class AlertLamp:
    """Turns the plug on while a temperature/humidity alert is active.

    Only switches the lamp off if it switched it on. Stays dark during quiet
    hours. If you switch it off during an alert (/lamp off), it stays off
    until that alert clears.
    """

    def __init__(self, outlet: IkeaOutlet, quiet_hours: str):
        self.outlet = outlet
        self.quiet_hours = quiet_hours
        self.auto = True          # /lamp auto on|off
        self.lit_by_alert = False
        self._lit_at = 0.0
        self._snoozed = False     # switched off by hand during the current alert
        self._last_error: str | None = None
        self._lock = threading.Lock()

    @property
    def enabled(self) -> bool:
        return self.outlet.enabled

    def sync(self, active_keys: set[str], now: datetime | None = None) -> None:
        """Called after every alert check with the alerts currently reported."""
        if not self.enabled:
            return
        alert = bool(active_keys & LAMP_ALERT_KEYS)
        if not alert:
            self._snoozed = False
        allowed = self.auto and not self._snoozed and not in_quiet_hours(now or datetime.now(), self.quiet_hours)
        with self._lock:
            if alert and allowed and not self.lit_by_alert:
                if self._switch(True):
                    self.lit_by_alert, self._lit_at = True, time.monotonic()
            elif self.lit_by_alert and (not allowed or not alert):
                held = time.monotonic() - self._lit_at < MIN_ON_SEC
                if (allowed and held) or not self._switch(False):
                    return
                self.lit_by_alert = False

    def manual(self, on: bool, alert_active: bool) -> None:
        """/lamp on|off. Raises RuntimeError if the hub can't be reached."""
        with self._lock:
            self.outlet.set_on(on)
            self.lit_by_alert = False
            self._snoozed = not on and alert_active

    def _switch(self, on: bool) -> bool:
        try:
            self.outlet.set_on(on)
        except RuntimeError as e:
            if str(e) != self._last_error:
                logger.warning("Alert lamp: %s", e)
            self._last_error = str(e)
            return False
        self._last_error = None
        logger.info("Alert lamp %s", "on" if on else "off")
        return True
