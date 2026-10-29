// ESP8266 room sensor node for Thalpos -> MQTT.
// Wi-Fi and broker settings live in secrets.h (not committed to git).
//
// v2: knows several Wi-Fi networks (home, phone hotspot, ...) and joins the
// strongest one it can see; firmware updates over Wi-Fi (ArduinoOTA, password
// protected) so the USB cable is only needed once.
// v3: SHT31 temperature/humidity on I2C (found automatically; falls back to the
// DHT11 on D4 when it isn't there), mmWave presence radar on D5, and a 0.96"
// OLED that shows the readings on the device.
// v3.1: the broker beacon must be signed (HMAC-SHA256 with DISCOVERY_KEY from
// secrets.h) and come from the address it names; DISCOVERY_ENABLED 0 turns
// discovery off completely.
// v3.2: while the broker can't be reached (the PC asleep or switched off), a
// reading every 30 s is kept in RAM (up to 10 hours) and sent as a backlog on
// MQTT_TOPIC/backlog once the broker is back (RAM is lost on reset).
// v3.4: always buffer; retry identified batches until the backend confirms storage.
// v3.3: OLED-only quiet hours, 23:00-08:00 Europe/Athens by default.
// Measurements, radar, MQTT and backlog keep running while the display is off.
//
// Wiring (NodeMCU):  SHT31 + OLED: SDA -> D2, SCL -> D1, VCC -> 3V3, GND -> GND
//                    radar: OT1/OUT -> D5, 3V3 -> 3V3, GND -> GND
#include <ESP8266WiFi.h>
#include <ESP8266WiFiMulti.h>
#include <ArduinoOTA.h>
#include <WiFiUdp.h>
#include <PubSubClient.h>
#include <DHT.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <bearssl/bearssl_hmac.h>
#include <time.h>
#include <TZ.h>
extern "C" {
#include <user_interface.h>
}
#include "secrets.h"
#include "oled_policy.h"

#ifndef OLED_NIGHT_MODE
#define OLED_NIGHT_MODE 1
#endif
#ifndef OLED_NIGHT_START_HOUR
#define OLED_NIGHT_START_HOUR 23
#endif
#ifndef OLED_NIGHT_END_HOUR
#define OLED_NIGHT_END_HOUR 8
#endif
#ifndef OLED_TIMEZONE
#define OLED_TIMEZONE TZ_Europe_Athens
#endif
static_assert(OLED_NIGHT_START_HOUR >= 0 && OLED_NIGHT_START_HOUR < 24, "Invalid OLED start hour");
static_assert(OLED_NIGHT_END_HOUR >= 0 && OLED_NIGHT_END_HOUR < 24, "Invalid OLED end hour");

#ifndef DISCOVERY_ENABLED
#define DISCOVERY_ENABLED 1   // set 0 in secrets.h to always use MQTT_SERVER
#endif

#define DHTPIN D4
#define DHTTYPE DHT11
#define PRESENCE_PIN D5        // mmWave radar output: HIGH while someone is in the room
const bool HAS_RADAR = true;   // set false if no radar is wired (the pin would float)

const char* ROOM_NAME = "Bedroom";
const char* FIRMWARE_VERSION = "3.4";
const char* OTA_HOSTNAME = "thalpos-bedroom";   // reachable as thalpos-bedroom.local
const unsigned long PUBLISH_INTERVAL_MS = 3000;   // the DHT11 fallback needs >= 1 s between reads
const unsigned long MQTT_RETRY_MS = 3000;

// Broker discovery: the Thalpos backend broadcasts
//   "THALPOS-BROKER v2 port=1883 ip=192.168.1.23 sig=<hmac>"
// on this UDP port, so a new IP on the PC no longer breaks the sensor.
// The board only follows a beacon whose HMAC-SHA256 (keyed with DISCOVERY_KEY)
// is valid and whose ip= is the sender. MQTT_SERVER in secrets.h is the first guess.
const uint16_t DISCOVERY_PORT = 18831;
const char* BEACON_PREFIX = "THALPOS-BROKER v2 ";
#if DISCOVERY_ENABLED && defined(DISCOVERY_KEY)
const bool DISCOVERY_ON = true;
#else
const bool DISCOVERY_ON = false;
#endif
WiFiUDP discovery;
IPAddress brokerIp;
uint16_t brokerPort = MQTT_PORT;
bool brokerDiscovered = false;

ESP8266WiFiMulti wifiMulti;
WiFiClient espClient;
PubSubClient client(espClient);
DHT dht(DHTPIN, DHTTYPE);
Adafruit_SSD1306 display(128, 64, &Wire, -1);

uint8_t shtAddress = 0;      // 0x44 or 0x45 when an SHT31 answers, 0 = use the DHT11
bool hasDisplay = false;
bool displayOn = false;
float lastTemp = NAN, lastHum = NAN;
bool presence = false;
bool pendingPublish = false;
unsigned long lastDisplay = 0;

String clientId;
unsigned long lastPublish = 0;
unsigned long lastMqttAttempt = 0;

// ---------- offline backlog ----------
// Readings taken while the broker is unreachable, oldest first, in a ring.
// 1200 x 12 bytes = 14 KB of the ~50 KB free RAM. A reboot loses it.
const unsigned long BACKLOG_EVERY_MS = 30000;   // same pace as the backend's history
const uint16_t BACKLOG_SIZE = 1200;             // 10 hours
const uint8_t BACKLOG_CHUNK = 25;               // readings per MQTT message (~700 bytes)
struct Buffered { uint32_t at; int16_t t10; uint16_t h10; bool presence; };
Buffered backlog[BACKLOG_SIZE];
uint16_t backlogStart = 0, backlogCount = 0;
unsigned long lastBuffered = 0;
String backlogTopic, backlogAckTopic, backlogBoot, pendingBatch;
uint8_t pendingCount=0;
uint32_t batchSequence=0, backlogDropped=0;
unsigned long lastBacklogSend=0;

void backlogAck(char* topic, byte* payload, unsigned int length) {
  if (String(topic)!=backlogAckTopic || !pendingCount || length!=pendingBatch.length()) return;
  for (unsigned int i=0;i<length;i++) if ((char)payload[i]!=pendingBatch[i]) return;
  backlogStart=(backlogStart+pendingCount)%BACKLOG_SIZE;
  backlogCount-=pendingCount;
  pendingCount=0;
  pendingBatch="";
}

void bufferReading() {
  if (isnan(lastTemp) || isnan(lastHum)) return;
  if (backlogCount == BACKLOG_SIZE) {   // full: the oldest reading makes room
    backlogStart = (backlogStart + 1) % BACKLOG_SIZE;
    backlogCount--;
    backlogDropped++;
    pendingCount=0; // overflow invalidates the in-flight selection; late ACK is ignored
    pendingBatch="";
  }
  Buffered& b = backlog[(backlogStart + backlogCount) % BACKLOG_SIZE];
  b.at = millis();
  b.t10 = (int16_t) lroundf(lastTemp * 10);
  b.h10 = (uint16_t) lroundf(lastHum * 10);
  b.presence = presence;
  backlogCount++;
}

// Sends one chunk per call (the loop stays responsive); a reading leaves the
// buffer only after the backend acknowledges durable storage. Ages are in seconds, so the board
// needs no clock: the backend subtracts them from the time it receives them.
void flushBacklog() {
  if (backlogCount == 0 || !client.connected()) return;
  if (pendingCount && millis()-lastBacklogSend<5000) return;
  if (!pendingCount) {
    pendingCount=backlogCount<BACKLOG_CHUNK?backlogCount:BACKLOG_CHUNK;
    pendingBatch=backlogBoot+"-"+String(++batchSequence);
  }
  uint8_t n=pendingCount;
  lastBacklogSend=millis();
  unsigned long now = millis();
  String payload = "{\"room\":\"";
  payload += ROOM_NAME;
  payload += "\",\"v\":2,\"batch\":\"";
  payload += pendingBatch;
  payload += "\",\"readings\":[";
  for (uint8_t i = 0; i < n; i++) {
    const Buffered& b = backlog[(backlogStart + i) % BACKLOG_SIZE];
    if (i) payload += ",";
    payload += "[";
    payload += String((now - b.at) / 1000);
    payload += ",";
    payload += String(b.t10 / 10.0f, 1);
    payload += ",";
    payload += String(b.h10 / 10.0f, 1);
    payload += ",";
    payload += b.presence ? "1" : "0";
    payload += "]";
  }
  payload += "]}";
  client.publish(backlogTopic.c_str(), payload.c_str());
  // Keep all samples until the matching application-level ACK arrives.

}

// Every network from secrets.h; WiFiMulti picks the strongest one in range.
void addNetworks() {
  wifiMulti.addAP(WIFI_SSID, WIFI_PASSWORD);
#ifdef WIFI_SSID_2
  wifiMulti.addAP(WIFI_SSID_2, WIFI_PASSWORD_2);
#endif
#ifdef WIFI_SSID_3
  wifiMulti.addAP(WIFI_SSID_3, WIFI_PASSWORD_3);
#endif
#ifdef WIFI_SSID_4
  wifiMulti.addAP(WIFI_SSID_4, WIFI_PASSWORD_4);
#endif
}

bool wasConnected = false;

// Non-blocking: wifiMulti.run() waits at most a few seconds per call, so the
// loop (and OTA) keeps running while no known network is in range.
void connectToWiFi() {
  if (wifiMulti.run(5000) != WL_CONNECTED) {
    if (wasConnected) Serial.println("WiFi lost, looking for a known network...");
    wasConnected = false;
    return;
  }
  if (wasConnected) return;
  wasConnected = true;
  brokerDiscovered = false;  // a new network means the PC may have a new IP
  Serial.print("WiFi connected to ");
  Serial.print(WiFi.SSID());
  Serial.print(", ESP8266 IP: ");
  Serial.println(WiFi.localIP());
}

void setupOta() {
  ArduinoOTA.setHostname(OTA_HOSTNAME);
#ifdef OTA_PASSWORD
  ArduinoOTA.setPassword(OTA_PASSWORD);
#endif
  ArduinoOTA.onStart([]() { Serial.println("OTA update starting"); client.disconnect(); });
  ArduinoOTA.onEnd([]() { Serial.println("OTA update done, rebooting"); });
  ArduinoOTA.onError([](ota_error_t error) { Serial.printf("OTA error %u\n", error); });
  ArduinoOTA.begin();
}

// Non-blocking: one attempt every MQTT_RETRY_MS, so Wi-Fi drops are noticed too.
void ensureMqtt() {
  if (client.connected()) return;
  unsigned long now = millis();
  if (now - lastMqttAttempt < MQTT_RETRY_MS) return;
  lastMqttAttempt = now;

  Serial.print("Connecting to MQTT ");
  if (brokerDiscovered) Serial.print(brokerIp); else Serial.print(MQTT_SERVER);
  Serial.print("...");
  if (client.connect(clientId.c_str(), MQTT_USER, MQTT_PASS)) {
    client.subscribe(backlogAckTopic.c_str());
    Serial.println(" connected!");
  } else {
    Serial.print(" failed, rc=");
    Serial.println(client.state());
  }
}

#if DISCOVERY_ENABLED && defined(DISCOVERY_KEY)
int hexValue(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

// True when sigHex is the HMAC-SHA256 of body[0..bodyLen) with DISCOVERY_KEY.
bool signatureValid(const char* body, size_t bodyLen, const char* sigHex) {
  static uint8_t key[64];
  size_t keyLen = strlen(DISCOVERY_KEY) / 2;
  if (keyLen == 0 || keyLen > sizeof(key) || strlen(sigHex) != 64) return false;
  for (size_t i = 0; i < keyLen; i++) {
    int hi = hexValue(DISCOVERY_KEY[2 * i]), lo = hexValue(DISCOVERY_KEY[2 * i + 1]);
    if (hi < 0 || lo < 0) return false;
    key[i] = (uint8_t) (hi * 16 + lo);
  }
  br_hmac_key_context kc;
  br_hmac_context ctx;
  br_hmac_key_init(&kc, &br_sha256_vtable, key, keyLen);
  br_hmac_init(&ctx, &kc, 0);
  br_hmac_update(&ctx, body, bodyLen);
  uint8_t mac[32];
  br_hmac_out(&ctx, mac);

  uint8_t diff = 0;   // constant time: don't leak how much of a guess was right
  for (int i = 0; i < 32; i++) {
    int hi = hexValue(sigHex[2 * i]), lo = hexValue(sigHex[2 * i + 1]);
    if (hi < 0 || lo < 0) return false;
    diff |= mac[i] ^ (uint8_t) (hi * 16 + lo);
  }
  return diff == 0;
}
#endif

// Reads one pending beacon, if any. Switches broker when the PC's IP changed.
void listenForBroker() {
#if DISCOVERY_ENABLED && defined(DISCOVERY_KEY)
  int size = discovery.parsePacket();
  if (size <= 0) return;

  char buf[192];
  int len = discovery.read(buf, sizeof(buf) - 1);
  if (len <= 0) return;
  buf[len] = '\0';
  if (strncmp(buf, BEACON_PREFIX, strlen(BEACON_PREFIX)) != 0) return;

  char* sig = strstr(buf, " sig=");
  if (!sig) return;
  size_t bodyLen = sig - buf;
  if (!signatureValid(buf, bodyLen, sig + 5)) {
    Serial.println("Ignoring a broker beacon with a bad signature");
    return;
  }
  *sig = '\0';   // from here on, only the signed part is read

  IPAddress from = discovery.remoteIP();
  const char* ipField = strstr(buf, " ip=");
  IPAddress named;
  if (!ipField || !named.fromString(ipField + 4) || named != from) {
    Serial.println("Ignoring a signed beacon sent from another address");
    return;
  }

  uint16_t port = MQTT_PORT;
  const char* p = strstr(buf, " port=");
  if (p) port = (uint16_t) atoi(p + 6);
  if (port == 0) return;
  if (brokerDiscovered && from == brokerIp && port == brokerPort) return;

  brokerIp = from;
  brokerPort = port;
  brokerDiscovered = true;
  Serial.print("Broker found at ");
  Serial.print(brokerIp);
  Serial.print(":");
  Serial.println(brokerPort);

  client.disconnect();
  client.setServer(brokerIp, brokerPort);
  lastMqttAttempt = 0;   // try the new address right away
#endif
}

// ---------- SHT31 (plain I2C, no library) ----------
bool i2cPresent(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

uint8_t crc8(const uint8_t* data, int len) {
  uint8_t crc = 0xFF;
  for (int i = 0; i < len; i++) {
    crc ^= data[i];
    for (int b = 0; b < 8; b++) crc = (crc & 0x80) ? (crc << 1) ^ 0x31 : (crc << 1);
  }
  return crc;
}

// Single-shot, high repeatability measurement (about 15 ms).
bool readSht31(float& temperature, float& humidity) {
  Wire.beginTransmission(shtAddress);
  Wire.write(0x24);
  Wire.write(0x00);
  if (Wire.endTransmission() != 0) return false;
  delay(20);
  if (Wire.requestFrom(shtAddress, (uint8_t) 6) != 6) return false;
  uint8_t d[6];
  for (int i = 0; i < 6; i++) d[i] = Wire.read();
  if (crc8(d, 2) != d[2] || crc8(d + 3, 2) != d[5]) return false;
  temperature = -45.0f + 175.0f * ((d[0] << 8) | d[1]) / 65535.0f;
  humidity = 100.0f * ((d[3] << 8) | d[4]) / 65535.0f;
  return true;
}

bool readClimate(float& temperature, float& humidity) {
  if (shtAddress) return readSht31(temperature, humidity);
  humidity = dht.readHumidity();
  temperature = dht.readTemperature();
  return !isnan(humidity) && !isnan(temperature);
}

const char* sensorName() { return shtAddress ? "SHT31" : "DHT11"; }

// ---------- OLED ----------
bool oledClockReady() {
  return time(nullptr) >= 1704067200;  // do not treat the unsynchronised boot clock as local time
}

bool oledWantsOn() {
  if (!OLED_NIGHT_MODE || OLED_NIGHT_START_HOUR == OLED_NIGHT_END_HOUR) return true;
  // Fail dark until the first NTP sync; sensor acquisition must never wait for time.
  if (!oledClockReady()) return false;
  time_t now = time(nullptr);
  struct tm local;
  if (!localtime_r(&now, &local)) return false;
  return !oledQuietHour(local.tm_hour, OLED_NIGHT_START_HOUR, OLED_NIGHT_END_HOUR);
}

void drawDisplay() {
  if (!hasDisplay) return;
  if (!oledWantsOn()) {
    if (displayOn) {
      display.ssd1306_command(SSD1306_DISPLAYOFF);
      displayOn = false;
      Serial.println("OLED off (quiet hours; measurements continue)");
    }
    return;
  }
  display.clearDisplay();
  // move the whole picture by a pixel every few minutes so the OLED doesn't burn in
  int dx = (millis() / 180000) % 3, dy = (millis() / 540000) % 2;
  display.setTextColor(SSD1306_WHITE);

  display.setTextSize(1);
  display.setCursor(dx, dy);
  display.print("Thalpos  ");
  display.print(ROOM_NAME);

  display.setTextSize(3);
  display.setCursor(dx, 14 + dy);
  if (isnan(lastTemp)) display.print("--.-");
  else display.print(lastTemp, 1);
  display.setTextSize(1);
  display.print(" C");

  display.setTextSize(2);
  display.setCursor(dx, 40 + dy);
  if (isnan(lastHum)) display.print("--%");
  else { display.print((int) round(lastHum)); display.print("%"); }

  if (HAS_RADAR) {
    display.setTextSize(1);
    display.setCursor(64 + dx, 44 + dy);
    display.print(presence ? "Someone in" : "Empty");
  }

  display.setTextSize(1);
  display.setCursor(dx, 56 + dy);
  if (WiFi.status() != WL_CONNECTED) display.print("No Wi-Fi");
  else if (!client.connected()) display.print("Wi-Fi ok, no broker");
  else { display.print(WiFi.SSID().substring(0, 14)); display.print(" ok"); }
  display.display();
  if (!displayOn) {
    display.ssd1306_command(SSD1306_DISPLAYON);
    displayOn = true;
    Serial.println("OLED on (daytime)");
  }
}

// Reads the sensor even while offline, so the OLED keeps showing live values.
bool updateReading() {
  float temperature, humidity;
  if (!readClimate(temperature, humidity)) {
    Serial.print("Failed to read ");
    Serial.println(sensorName());
    return false;
  }
  lastTemp = temperature;
  lastHum = humidity;
  return true;
}

void publishReading() {
  float temperature = lastTemp, humidity = lastHum;

  String payload = "{\"room\":\"";
  payload += ROOM_NAME;
  payload += "\",\"temperature\":";
  payload += String(temperature, 1);
  payload += ",\"humidity\":";
  payload += String(humidity, 1);
  payload += ",\"sensor\":\"";
  payload += sensorName();
  payload += "\"";
  if (HAS_RADAR) {
    payload += ",\"presence\":";
    payload += presence ? "true" : "false";
  }
  payload += ",\"ip\":\"";
  payload += WiFi.localIP().toString();
  payload += "\",\"wifi\":\"";
  payload += WiFi.SSID();
  payload += "\",\"rssi\":";
  payload += String(WiFi.RSSI());
  payload += ",\"fw\":\"";
  payload += FIRMWARE_VERSION;
  payload += "\",\"backlog_count\":";
  payload += backlogCount;
  payload += ",\"backlog_dropped\":";
  payload += backlogDropped;
  payload += ",\"oled_on\":";
  payload += (hasDisplay && displayOn) ? "true" : "false";
  payload += ",\"oled_clock_ready\":";
  payload += oledClockReady() ? "true" : "false";
  payload += "}";

  bool ok = client.publish(MQTT_TOPIC, payload.c_str());
  Serial.print(ok ? "Sent: " : "Publish FAILED: ");
  Serial.println(payload);
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  Wire.begin();   // NodeMCU: SDA = D2, SCL = D1
  Serial.print("I2C devices:");
  for (uint8_t a = 1; a < 127; a++) if (i2cPresent(a)) Serial.printf(" 0x%02X", a);
  Serial.println();
  if (i2cPresent(0x44)) shtAddress = 0x44;
  else if (i2cPresent(0x45)) shtAddress = 0x45;
  if (!shtAddress) dht.begin();
  Serial.printf("Climate sensor: %s\n", sensorName());

  hasDisplay = display.begin(SSD1306_SWITCHCAPVCC, 0x3C) || display.begin(SSD1306_SWITCHCAPVCC, 0x3D);
  if (hasDisplay) {
    display.ssd1306_command(SSD1306_DISPLAYOFF);
    display.ssd1306_command(SSD1306_SETCONTRAST);
    display.ssd1306_command(40);   // dimmer: easier on the eyes at night, slower burn-in
    drawDisplay();
  }
  Serial.println(hasDisplay ? "OLED found" : "No OLED");

  if (HAS_RADAR) pinMode(PRESENCE_PIN, INPUT);

  WiFi.mode(WIFI_STA);
  WiFi.hostname(OTA_HOSTNAME);
  addNetworks();
  connectToWiFi();
  // Non-blocking NTP; the core applies Athens daylight-saving rules from TZ.h.
  configTime(OLED_TIMEZONE, "pool.ntp.org", "time.cloudflare.com");
  setupOta();

  // Unique per board, so two nodes never kick each other off the broker.
  clientId = "ESP8266_THALPOS_" + String(ESP.getChipId(), HEX);
  client.setServer(MQTT_SERVER, MQTT_PORT);
  client.setBufferSize(1024);   // a backlog chunk is ~700 bytes (the default is 256)
  backlogTopic = String(MQTT_TOPIC) + "/backlog";
  backlogAckTopic=backlogTopic+"/ack";
  backlogBoot=String(ESP.getChipId(),HEX)+"-"+String(os_random(),HEX)+"-"+String(os_random(),HEX);
  client.setCallback(backlogAck);
  if (DISCOVERY_ON) {
    discovery.begin(DISCOVERY_PORT);
    Serial.println("Broker discovery: signed beacons only");
  } else {
    Serial.println("Broker discovery off: using MQTT_SERVER from secrets.h");
  }
}

void loop() {
  connectToWiFi();   // returns immediately while connected
  ArduinoOTA.handle();

  if (HAS_RADAR) {
    bool now = digitalRead(PRESENCE_PIN) == HIGH;
    if (now != presence) {
      presence = now;
      Serial.println(presence ? "Presence: someone in the room" : "Presence: room empty");
      lastPublish = millis() - PUBLISH_INTERVAL_MS;   // read and report straight away
    }
  }
  if (millis() - lastPublish >= PUBLISH_INTERVAL_MS) {
    lastPublish = millis();
    if (updateReading()) pendingPublish = true;
  }
  if (millis() - lastDisplay >= 1000) {
    lastDisplay = millis();
    drawDisplay();
  }
  // Keep readings even if MQTT is up but the backend is down.
  if (millis() - lastBuffered >= BACKLOG_EVERY_MS) {
    lastBuffered = millis();
    bufferReading();
  }

  if (WiFi.status() != WL_CONNECTED) return;
  listenForBroker();
  ensureMqtt();
  client.loop();

  if (pendingPublish && client.connected()) {
    pendingPublish = false;
    publishReading();
  }
  flushBacklog();
}
