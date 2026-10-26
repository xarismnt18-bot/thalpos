# Hardware and firmware

[← Back to the README](../README.md)

## Parts

### OLED quiet hours

Firmware 3.3 turns only the OLED off from **23:00 to 08:00 Europe/Athens**.
Temperature/humidity sampling, radar, Wi-Fi, MQTT and offline buffering remain
active. The screen wakes automatically at 08:00. NTP synchronises the clock;
the core's Athens timezone includes daylight-saving changes. If the board
reboots before it can obtain time, the display stays dark until time is known.
After a successful time sync it can keep the schedule during a Wi-Fi outage.

Optional settings in local `secrets.h`: `OLED_NIGHT_MODE` (0 disables quiet
hours), `OLED_NIGHT_START_HOUR` and `OLED_NIGHT_END_HOUR` (0–23), and
`OLED_TIMEZONE` (default `TZ_Europe_Athens`). Equal start/end disables the
quiet interval. Changes require a firmware upload. The telemetry fields
`oled_on` and `oled_clock_ready` appear under `/latest` → `device`.

This schedule is independent of smartwatch sleep detection; it does not put
the ESP8266 into deep sleep or interrupt room readings.

| Part | Notes |
|------|-------|
| NodeMCU ESP8266 (CP2102 or CH340) | Board "NodeMCU 1.0 (ESP-12E Module)" |
| SHT31 breakout | Recommended sensor: accurate humidity, I2C address 0x44 or 0x45 (both work) |
| DHT11 module | Fallback sensor, used only when no SHT31 is found. Cheap, but its humidity can get stuck near 95% when damp |
| 0.96" SSD1306 OLED, I2C | Optional. Address 0x3C or 0x3D |
| HMMD 24 GHz mmWave radar | Optional. Only its `OT1` output is used |
| Half-size breadboard, jumper wires | Female-to-male wires let the sensors sit off the board |

Breakout boards that come with loose header pins (often the SHT31) must be **soldered**. Pins that are only pushed through the holes don't make contact, and the board stays invisible to the ESP8266.

## Wiring

All parts run on **3V3**. Never connect anything to `Vin`: it carries 5 V from USB.

| ESP8266 pin | Goes to |
|-------------|---------|
| `3V3` | `VCC` of every part (through the breadboard's + rail) |
| `GND` | `GND` of every part (through the − rail) |
| `D2` (SDA) | `SDA` of the SHT31 **and** the OLED |
| `D1` (SCL) | `SCL` of the SHT31 **and** the OLED |
| `D5` | Radar `OT1` |
| `D4` | DHT11 `DATA` (only if you use a DHT11) |

The radar's `TX` and `RX` and the SHT31's `INT` and `RST` stay unconnected.

On a breadboard, every pin of a part goes in its own row: the five holes of a row (a–e or f–j) are connected inside, so two pins in the same row are shorted.

**Placement tips**

- Keep the **SHT31 a few centimetres away from the ESP8266**. The board warms up and would add 0.5–1 °C to the reading.
- Stand the **radar upright** with its antenna side (the gold patches) facing the room. Lying flat, it looks at the ceiling.
- Point the radar **away from the door**. mmWave goes through doors and thin walls, so it can see people in the corridor. Its back is much less sensitive.

## What the firmware does

`firmware/esp8266_dht11/esp8266_dht11.ino`, version 3.3:

- At boot it lists the I2C devices it finds, then uses an SHT31 if there is one, otherwise the DHT11 on `D4`. An OLED is used if found.
- Every 3 seconds it reads the sensor and publishes a JSON message on `smartroom/dht11`:
  ```json
  {"room": "Bedroom", "temperature": 23.4, "humidity": 51.0, "sensor": "SHT31",
   "presence": true, "ip": "192.168.1.16", "wifi": "Home", "rssi": -62, "fw": "3.2"}
  ```
  A change in presence is sent immediately.
- It keeps reading while offline, so the OLED stays live, and sends again once it is connected.
- **Nothing is lost while the PC sleeps.** While the broker can't be reached (the PC asleep, switched off or restarting), it keeps a reading every 30 seconds in RAM, up to 10 hours, with the radar's presence. When the broker is back it sends them on `smartroom/dht11/backlog`, 25 per message, as `{"room": "Bedroom", "readings": [[age_sec, temperature, humidity, presence], ...]}`. The board has no clock, so it sends each reading's age and the backend works out when it was taken. The backend stores them in the history at that time, never over a reading it already has, and rebuilds the time someone was in the room from the presence flags. The night then shows up on the Sleep page as if the PC had been on. Over 10 hours, the oldest readings make room for new ones; a reboot of the board (or a power cut) loses what it held.
- It listens for the backend's discovery beacon (UDP 18831) and connects to whichever PC sent it. `MQTT_SERVER` in `secrets.h` is only the first guess.
- The OLED is dimmed and shifts its picture by a pixel every few minutes to avoid burn-in.

## Settings: `secrets.h`

Copy `secrets.example.h` to `secrets.h` (git-ignored) and fill in:

- `WIFI_SSID` / `WIFI_PASSWORD`, plus up to three more networks as `WIFI_SSID_2`…`WIFI_SSID_4` (home, phone hotspot, work). The board joins whichever is in range and reconnects by itself. Names are case-sensitive.
- `OTA_PASSWORD` for uploads over Wi-Fi.
- `MQTT_USER` / `MQTT_PASS`: `setup_security.bat` adds these for you.

To add the network the laptop is connected to right now, plug the board in by USB and run `add_wifi.bat`. It reads the name and password from Windows, writes them as the next free `WIFI_SSID_n` and uploads. The password is never shown or logged.

## Uploading

| How | Script | Notes |
|-----|--------|-------|
| USB | `flash_esp.bat` | Finds the board's COM port by itself (ignores Bluetooth ports). Close the Arduino serial monitor first |
| Wi-Fi (OTA) | `flash_ota.bat` | After the first USB upload. Host `thalpos-bedroom.local`, or pass the IP: `flash_ota.bat 192.168.1.50`. Run `allow_ota.bat` once so the firewall lets the board connect back on TCP 48266 |

Both compile with the `arduino-cli` bundled in Arduino IDE, install the needed libraries (PubSubClient, DHT sensor library, Adafruit SSD1306 and GFX) and write `flash_esp.log`.

## Troubleshooting

Run `serial_log.bat` with the board on USB. It restarts the board and saves 40 seconds of what it prints to `serial_log.txt`.

| You see | Meaning |
|---------|---------|
| `I2C devices: 0x3C` only | The OLED works, the SHT31 is not answering: check its 4 wires and solder joints |
| `Climate sensor: DHT11` + `Failed to read DHT11` | No SHT31 found and no DHT11 on `D4` |
| `No OLED` | Check the OLED's SDA/SCL and power |
| `WiFi connected to …` missing | None of the networks in `secrets.h` is in range, or a password is wrong |
| `Connecting to MQTT … failed, rc=-2` then `Broker found at …` | Normal: the first guess was an old IP, the beacon gave the right one |
| `Sent: {...}` lines | Everything works; the readings reach the dashboard |
