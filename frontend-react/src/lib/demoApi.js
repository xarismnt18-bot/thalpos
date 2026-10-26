// In-browser stand-in for the FastAPI backend, used by the public demo build
// (VITE_DEMO=1). It mirrors the backend's responses and maths closely enough
// for every page to work, with a simulated DHT11 sending a packet every 3 s.
// Humidity drifts slowly, so visitors see the room in alert and then recover.

const PACKET_MS = 3000;
const HISTORY_MAX = 500;
const DEFAULT_THRESHOLDS = {
  TEMP_LOW: 18, TEMP_HIGH: 27, TEMP_CRITICAL: 32,
  HUMIDITY_LOW: 35, HUMIDITY_HIGH: 70, HUMIDITY_CRITICAL: 85,
};

let thresholds = { ...DEFAULT_THRESHOLDS };
const history = [];
const startedAt = Date.now();

function reading(atMs) {
  const t = (atMs - startedAt) / 1000;
  const noise = () => (Math.random() - 0.5);
  return {
    // visit starts with humidity just over the limit (red room), easing back
    // below it after ~7 minutes; slow waves so the 20-minute forecast makes sense
    temperature: +(24.2 + 1.4 * Math.sin(t / 900 + 0.4) + 0.15 * noise()).toFixed(1),
    humidity: +(66 + 7 * Math.sin(t / 300 + 1.2) + 0.5 * noise()).toFixed(1),
  };
}

function push(atMs) {
  const r = reading(atMs);
  history.push({ room: "Bedroom", ...r, timestamp: new Date(atMs).toISOString(), ts: atMs / 1000 });
  if (history.length > HISTORY_MAX) history.shift();
}

// back-fill 25 minutes so charts and forecasts have data straight away
for (let i = HISTORY_MAX - 1; i >= 0; i--) push(startedAt - i * PACKET_MS);
setInterval(() => push(Date.now()), PACKET_MS);

const last = () => history[history.length - 1];

// ---- same formulas as ai/engines/comfort.py ----
function healthScore(temp, hum, t) {
  let score = 100;
  if (temp > t.TEMP_HIGH) score -= Math.min((temp - t.TEMP_HIGH) * 8, 35);
  if (temp < t.TEMP_LOW) score -= Math.min((t.TEMP_LOW - temp) * 6, 30);
  if (hum > t.HUMIDITY_HIGH) score -= Math.min((hum - t.HUMIDITY_HIGH) * 4, 35);
  if (hum < t.HUMIDITY_LOW) score -= Math.min((t.HUMIDITY_LOW - hum) * 2, 20);
  return Math.max(Math.trunc(score), 20);
}
const healthStatus = (s) => (s >= 80 ? "OPTIMAL" : s >= 60 ? "ATTENTION_REQUIRED" : "CRITICAL");
function dewPoint(temp, hum) {
  const a = 17.62, b = 243.12;
  const g = Math.log(Math.max(hum, 1) / 100) + (a * temp) / (b + temp);
  return Math.round(((b * g) / (a - g)) * 10) / 10;
}
function moldRisk(temp, hum) {
  if (temp < 18) return hum < 70 ? "low" : "moderate";
  if (hum >= 70) return "high";
  if (hum >= 60) return "moderate";
  return "low";
}

function alerts(r) {
  const t = thresholds;
  const out = [];
  if (r.temperature > t.TEMP_HIGH) out.push("Temperature is above comfort threshold.");
  if (r.temperature < t.TEMP_LOW) out.push("Temperature is below comfort threshold.");
  if (r.humidity > t.HUMIDITY_HIGH) out.push("Humidity is above comfort threshold. Mold risk may increase.");
  if (r.humidity < t.HUMIDITY_LOW) out.push("Humidity is low. Dry-air conditions detected.");
  return out;
}

// ---- forecast: weighted linear regression over the last 20 minutes ----
function forecast(field, warn, crit) {
  const now = last().ts;
  const pts = history.filter((p) => p.ts >= now - 20 * 60);
  const n = pts.length;
  const current = last()[field];
  if (n < 5) return { current, predicted: null, confidence: 0, trend: "unknown", risk: "unknown", data_points: n };
  const xs = pts.map((p) => p.ts - now);
  const ys = pts.map((p) => p[field]);
  const ws = xs.map((_, i) => 0.5 + i / n);
  const sw = ws.reduce((a, b) => a + b, 0);
  const mx = xs.reduce((a, x, i) => a + x * ws[i], 0) / sw;
  const my = ys.reduce((a, y, i) => a + y * ws[i], 0) / sw;
  const sxx = xs.reduce((a, x, i) => a + ws[i] * (x - mx) ** 2, 0);
  const sxy = xs.reduce((a, x, i) => a + ws[i] * (x - mx) * (ys[i] - my), 0);
  const slope = sxy / (sxx || 1);
  const predicted = my + slope * (600 - mx);
  const resid = Math.sqrt(ys.reduce((a, y, i) => a + ws[i] * (y - (my + slope * (xs[i] - mx))) ** 2, 0) / sw);
  const perMin = slope * 60;
  const limit = field === "temperature" ? 0.02 : 0.05;
  const risk = predicted >= crit ? "critical" : predicted >= warn ? "warning" : "normal";
  return {
    current,
    predicted: Math.round(predicted * 10) / 10,
    confidence: Math.max(10, Math.min(95, Math.round(95 - resid * 40))),
    trend: perMin > limit ? "rising" : perMin < -limit ? "falling" : "stable",
    risk,
    slope_per_min: Math.round(perMin * 1000) / 1000,
    data_points: n,
  };
}

function predictions() {
  const t = thresholds;
  const temperature = forecast("temperature", t.TEMP_HIGH, t.TEMP_CRITICAL);
  const humidity = forecast("humidity", t.HUMIDITY_HIGH, t.HUMIDITY_CRITICAL);
  return {
    temperature, humidity, minutes_ahead: 10,
    data_points: Math.max(temperature.data_points, humidity.data_points),
    generated_at: Date.now() / 1000, data_age_sec: 0, stale: false,
  };
}

function recommendations() {
  const r = last();
  const t = thresholds;
  const p = predictions();
  const recs = [];
  const rec = (priority, title, message, action) => recs.push({ priority, title, message, action });
  if (r.temperature > t.TEMP_HIGH) rec("warning", "Temperature High", `Current ${r.temperature}°C exceeds ${t.TEMP_HIGH}°C.`, "Open a window or switch on the AC.");
  else if (p.temperature.risk !== "normal" && p.temperature.risk !== "unknown") rec("info", "Temperature Rising", `Forecast ${p.temperature.predicted}°C in 10 min.`, "Plan to cool the room.");
  if (r.humidity > t.HUMIDITY_HIGH) rec("warning", "High Humidity", `Humidity ${r.humidity}% exceeds ${t.HUMIDITY_HIGH}%.`, "Ventilate or run a dehumidifier.");
  else if (p.humidity.risk !== "normal" && p.humidity.risk !== "unknown") rec("info", "Humidity Rising", `Forecast ${p.humidity.predicted}% in 10 min.`, "Ventilate before it crosses the limit.");
  const mold = moldRisk(r.temperature, r.humidity);
  if (mold === "high") rec("warning", "Mold Risk High", "Warm and humid: conditions favour mold.", "Keep humidity under 60%.");
  else if (mold === "moderate") rec("info", "Mold Risk Moderate", "Humidity is getting close to mold-friendly levels.", "Air the room for a few minutes.");
  if (recs.length === 0) rec("success", "Optimal Conditions", "Everything is inside the comfort range.", "No action needed.");
  return recs.slice(0, 5);
}

function latest() {
  const r = last();
  return {
    room: "Bedroom",
    temperature: r.temperature,
    humidity: r.humidity,
    last_update: r.timestamp,
    seconds_since_update: Math.round((Date.now() - r.ts * 1000) / 100) / 10,
    broker_connected: true,
    sensor_online: true,
    connected: true,
    invalid_packets: 0,
    sensor: "SHT31",
    // someone is in the room for 4 minutes out of every 6 (came in 17 min before the demo opened)
    presence: ((Date.now() - startedAt) / 1000) % 360 < 240,
    presence_since: ((Date.now() - startedAt) / 1000) % 360 < 240
      ? Math.round((startedAt + Math.floor((Date.now() - startedAt) / 360000) * 360000) / 1000) - 17 * 60 : null,
    device: { fw: "3.0", wifi: "Home", rssi: -58, ip: "192.168.1.20" },
  };
}

const notify = {
  telegram_enabled: false, voice_enabled: true, lamp_enabled: true, muted_until: null,
  voice_on: true, voice_quiet_hours: "23:00-08:00", lamp_auto: true, lamp_quiet_hours: "23:00-08:00",
  presence_on: true, presence_quiet_hours: "23:00-08:00", alerts_only_present: true, airing_reminder: true,
};

// a believable week of time in the room (minutes per day), today grows while the demo runs
const DEMO_WEEK = [312, 455, 270, 520, 388, 610];
function demoPresenceDays() {
  const out = [];
  const now = new Date();
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const minutes = i === 0 ? 95 + Math.round((Date.now() - startedAt) / 60000) : DEMO_WEEK[6 - i];
    out.push({ date: iso, minutes });
  }
  const l = latest();
  return { days: out, in_now: l.presence, since: l.presence_since };
}

// a believable week of alerts for the Alerts page
function demoAlertLog() {
  const now = Date.now() / 1000;
  const h = 3600;
  const ev = (id, key, message, ago, lasted, notified = true) => ({
    id, key, message, started: now - ago, ended: lasted == null ? null : now - ago + lasted,
    notified, duration_sec: Math.round(lasted ?? ago),
  });
  const r = last();
  const list = [
    ev(1, "humidity_high", "💧 Bedroom humidity is high: 74% (limit 70%). Mold risk rises; open a window or run the dehumidifier.", 26 * h, 1.6 * h),
    ev(2, "sensor_offline", "📡 Bedroom sensor stopped sending (last packet 45 s ago).", 50 * h, 0.2 * h, false),
    ev(3, "temp_high", "🌡️ Bedroom is warm: 27.6°C (comfort limit 27°C).", 75 * h, 2.4 * h),
    ev(4, "humidity_high", "💧 Bedroom humidity is high: 72% (limit 70%).", 5 * 24 * h, 3.1 * h),
  ];
  if (r.humidity > thresholds.HUMIDITY_HIGH) {
    list.unshift(ev(0, "humidity_high", `💧 Bedroom humidity is high: ${Math.round(r.humidity)}% (limit ${thresholds.HUMIDITY_HIGH}%).`, 240, null));
  }
  return list;
}

// a believable week of nights for the Sleep page (same score maths as backend/sleep.py)
const SLEEP_IDEAL = { temp_low: 16, temp_high: 20, hum_low: 40, hum_high: 60 };
const DEMO_NIGHTS = [  // [bed hh:mm, up hh:mm, temp at bedtime, humidity, interruptions | null = estimated, has readings]
  [[23, 40], [7, 10], 22.4, 63, 1, true], [[0, 15], [7, 45], 21.6, 58, 0, true], [[23, 5], [6, 50], 23.1, 66, 2, true],
  [[23, 0], [7, 0], 21.0, 55, null, true], [[0, 40], [8, 5], 20.6, 52, 0, true], [[23, 30], [7, 20], 22.0, 61, 1, false],
  [[23, 55], [7, 30], 21.2, 57, 1, true],
];
function demoSleep() {
  const out = [];
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getHours() < 1 ? 1 : 0));
  DEMO_NIGHTS.forEach(([bed, up, t0, h0, interruptions, has], i) => {
    const morning = new Date(first.getFullYear(), first.getMonth(), first.getDate() - i);
    const iso = `${morning.getFullYear()}-${String(morning.getMonth() + 1).padStart(2, "0")}-${String(morning.getDate()).padStart(2, "0")}`;
    const start = new Date(morning.getFullYear(), morning.getMonth(), morning.getDate() - (bed[0] >= 12 ? 1 : 0), bed[0], bed[1]).getTime() / 1000;
    const end = new Date(morning.getFullYear(), morning.getMonth(), morning.getDate(), up[0], up[1]).getTime() / 1000;
    const source = interruptions == null ? "estimated" : "radar";
    if (!has) { out.push({ date: iso, source, score: null, start, end, missing: "no readings", tip: null }); return; }
    const series = [];
    for (let ts = Math.ceil(start / 600) * 600; ts <= end; ts += 600) {
      const f = (ts - start) / (end - start);   // the room cools through the night, humidity creeps up
      series.push({ ts, temperature: +(t0 - 1.6 * f + 0.15 * Math.sin(ts / 1500)).toFixed(2), humidity: +(h0 + 4 * f + Math.sin(ts / 2100)).toFixed(1) });
    }
    const ts = series.map((p) => p.temperature), hs = series.map((p) => p.humidity);
    const outside = { warm: 0, cold: 0, humid: 0, dry: 0 };
    let score = 0;
    series.forEach((p) => {
      const tOut = Math.max(SLEEP_IDEAL.temp_low - p.temperature, p.temperature - SLEEP_IDEAL.temp_high, 0);
      const hOut = Math.max(SLEEP_IDEAL.hum_low - p.humidity, p.humidity - SLEEP_IDEAL.hum_high, 0);
      score += 100 - Math.min(tOut * 10, 50) - Math.min(hOut * 2.5, 50);
      outside.warm += p.temperature > SLEEP_IDEAL.temp_high ? 10 : 0;
      outside.cold += p.temperature < SLEEP_IDEAL.temp_low ? 10 : 0;
      outside.humid += p.humidity > SLEEP_IDEAL.hum_high ? 10 : 0;
      outside.dry += p.humidity < SLEEP_IDEAL.hum_low ? 10 : 0;
    });
    const avg = (a) => Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10;
    const worst = Object.entries(outside).sort((a, b) => b[1] - a[1])[0];
    const hours = `${(worst[1] / 60).toFixed(1)} h`;
    const tip = worst[1] < 30 ? "The room stayed in the ideal range for sleeping." : {
      warm: `Too warm for ${hours}: cool the room before bed (air it, or the AC around ${SLEEP_IDEAL.temp_high} °C).`,
      humid: `Too humid for ${hours}: air the room before bed, and a dehumidifier would help.`,
      cold: `Too cold for ${hours}: warm the room a little before bed, or add a blanket.`,
      dry: `Too dry for ${hours}: a bowl of water or a humidifier would help.`,
    }[worst[0]];
    out.push({
      date: iso, source, start, end, minutes: Math.round((end - start) / 60), interruptions,
      score: Math.round(score / series.length),
      temperature: { avg: avg(ts), min: Math.min(...ts), max: Math.max(...ts) },
      humidity: { avg: avg(hs), min: Math.min(...hs), max: Math.max(...hs) },
      minutes_outside: outside, series, tip,
    });
  });
  return { ideal: SLEEP_IDEAL, nights: out };
}

const config = () => ({ thresholds: { ...thresholds }, mqtt_topic: "smartroom/dht11" });

/** Same contract as config.js request(): resolves to JSON or throws Error(detail). */
export async function demoRequest(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const route = path.split("?")[0];
  const r = last();

  if (route === "/latest") return latest();
  if (route === "/history") return history.slice();
  if (route === "/health") {
    const score = healthScore(r.temperature, r.humidity, thresholds);
    return {
      status: healthStatus(score), health_score: score,
      temperature: r.temperature, humidity: r.humidity,
      dew_point: dewPoint(r.temperature, r.humidity), mold_risk: moldRisk(r.temperature, r.humidity),
      sensor_online: true,
    };
  }
  if (route === "/alerts") {
    const list = alerts(r);
    return { alerts: list.length ? list : ["No active alerts."] };
  }
  if (route === "/predictions") return predictions();
  if (route === "/recommendations") return { recommendations: recommendations() };
  if (route === "/config") {
    if (method === "PUT") thresholds = { ...thresholds, ...JSON.parse(options.body || "{}") };
    if (method === "DELETE") thresholds = { ...DEFAULT_THRESHOLDS };
    return config();
  }
  if (route === "/notifications") {
    if (method === "PUT") Object.assign(notify, JSON.parse(options.body || "{}"));
    return { ...notify };
  }
  if (route === "/notifications/mute") {
    const minutes = Number(new URLSearchParams(path.split("?")[1] || "").get("minutes")) || 60;
    notify.muted_until = method === "DELETE" ? null : Date.now() / 1000 + minutes * 60;
    return { ...notify };
  }
  if (route === "/alerts/history") return demoAlertLog();
  if (route === "/presence/daily") return demoPresenceDays();
  if (route === "/sleep") return demoSleep();
  if (route === "/history/range") {
    const params = new URLSearchParams(path.split("?")[1] || "");
    const hours = Number(params.get("hours")) || 24;
    const step = Number(params.get("step")) || 300;
    const end = Math.floor(Date.now() / 1000 / step) * step;
    const out = [];
    for (let ts = end - hours * 3600; ts <= end; ts += step) {
      const day = Math.sin(((ts % 86400) / 86400) * 2 * Math.PI - 2);  // warmer afternoons
      out.push({ ts, temperature: +(22.5 + 2.2 * day).toFixed(2), humidity: +(62 - 9 * day + 4 * Math.sin(ts / 9000)).toFixed(1) });
    }
    return out;
  }
  if (route === "/lamp") {
    if (method === "POST") throw new Error("The lamp isn't available in the online demo.");
    return { enabled: false, auto: true, lit_by_alert: false, quiet_hours: "23:00-08:00" };
  }
  if (route === "/notifications/test") throw new Error("Telegram isn't available in the online demo.");
  throw new Error(`Not available in the demo: ${route}`);
}
