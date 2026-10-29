// Two kinds of settings:
//  * client settings (API URL, refresh rate, display name, heatmap colours)
//    live in this browser's localStorage;
//  * alert thresholds live in the backend (GET/PUT /config) so the dashboard
//    and the backend's /alerts, /health and /recommendations always agree.

import { demoRequest } from "./lib/demoApi";

const STORAGE_KEY = "smartbuilding_settings";

// Public demo build (GitHub Pages): no backend, a simulated sensor in the browser.
export const DEMO = import.meta.env.VITE_DEMO === "1";
export const REPO_URL = "https://github.com/xarismnt18-bot/thalpos";
export const APP_NAME = "Thalpos";
export const AUTHOR = { name: "Charalampos Mentsios", linkedin: "https://www.linkedin.com/in/charalampos-mentsios/" };

const clientDefaults = {
  // same-origin path, proxied to the backend by the Vite dev server
  API_URL: "/api",
  REFRESH_INTERVAL: 2000,
  ROOM_NAME: "Bedroom",
  TEMP_WARM: 25,
  HUMIDITY_WARM: 65,
};

const thresholdDefaults = {
  TEMP_LOW: 18,
  TEMP_HIGH: 27,
  TEMP_CRITICAL: 32,
  HUMIDITY_LOW: 35,
  HUMIDITY_HIGH: 70,
  HUMIDITY_CRITICAL: 85,
};

const LEGACY_API_URLS = new Set(["http://127.0.0.1:8000", "http://localhost:8000"]);

function loadClientOverrides() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    // the old default only works on this PC; drop it so /api is used everywhere
    if (LEGACY_API_URLS.has(parsed.API_URL)) delete parsed.API_URL;
    // keep only keys that still exist (older versions stored thresholds here)
    return Object.fromEntries(Object.entries(parsed).filter(([k]) => k in clientDefaults));
  } catch {
    return {};
  }
}

export function getClientSettings() {
  return { ...clientDefaults, ...loadClientOverrides() };
}

export function saveClientSettings(values) {
  const clean = Object.fromEntries(Object.entries(values).filter(([k]) => k in clientDefaults));
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // storage unavailable (private mode) - settings apply until reload only
  }
  Object.assign(CLIENT, clean);
}

export function resetClientSettings() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  Object.assign(CLIENT, clientDefaults);
}

// Live objects: components read these at render time, so updating them in
// place (Object.assign) is picked up on the next render without a reload.
export const CLIENT = getClientSettings();
export const THRESHOLDS = {
  ...thresholdDefaults,
  get TEMP_WARM() { return CLIENT.TEMP_WARM; },
  get HUMIDITY_WARM() { return CLIENT.HUMIDITY_WARM; },
};
export const SERVER = { mqttTopic: "--" };

function applyServerConfig(json) {
  Object.assign(THRESHOLDS, json.thresholds || {});
  if (json.mqtt_topic) SERVER.mqttTopic = json.mqtt_topic;
  return json;
}

async function request(path, options) {
  if (DEMO) return demoRequest(path, options);
  const res = await fetch(`${CLIENT.API_URL}${path}`, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

export function apiGet(path, options) {
  return request(path, options);
}

export async function loadServerConfig() {
  return applyServerConfig(await request("/config"));
}

export async function saveThresholds(changes) {
  return applyServerConfig(await request("/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(changes),
  }));
}

export async function resetThresholds() {
  return applyServerConfig(await request("/config", { method: "DELETE" }));
}

export async function sendTestNotification() {
  return request("/notifications/test", { method: "POST" });
}

export async function saveNotificationSettings(changes) {
  return request("/notifications", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(changes),
  });
}

export async function muteAlerts(minutes) {
  return request(`/notifications/mute?minutes=${minutes}`, { method: "POST" });
}

export async function unmuteAlerts() {
  return request("/notifications/mute", { method: "DELETE" });
}

export function getAlertHistory(days) {
  return request(`/alerts/history?days=${days}`);
}

/** Link that downloads every stored reading of the last `hours` as CSV (null in the demo). */
export function historyCsvUrl(hours) {
  return DEMO ? null : `${CLIENT.API_URL}/history.csv?hours=${Math.max(0.1, hours).toFixed(2)}`;
}

export async function switchLamp(on) {
  return request(`/lamp?on=${on}`, { method: "POST" });
}

export async function setLampAuto(on) {
  return request(`/lamp/auto?on=${on}`, { method: "PUT" });
}

export function formatTime(iso) {
  if (!iso) return "--";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleTimeString();
}

export function apiPut(path, body) {
  return request(path, {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
}
