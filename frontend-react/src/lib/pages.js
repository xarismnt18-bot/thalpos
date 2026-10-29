import {
  AlertTriangle, Brain, Building2, Cloud, FileText, LayoutDashboard, LineChart, Moon,
  Settings as SettingsIcon, Sparkles, Zap,
} from "lucide-react";

// [id, icon, label]. The id is what App.jsx switches on; the label is what people read.
export const MAIN_PAGES = [
  ["DASHBOARD", LayoutDashboard, "Dashboard"],
  ["FLOORPLAN", Building2, "Floorplan"],
  ["ANALYTICS", LineChart, "Analytics"],
  ["SLEEP", Moon, "Sleep"],
  ["ALERTS", AlertTriangle, "Alerts"],
  ["REPORTS", FileText, "Reports"],
];
export const MORE_PAGES = [
  ["AI BRAIN", Brain, "AI brain"],
  ["PREDICTIONS", Sparkles, "Predictions"],
  ["ENERGY", Zap, "Energy"],
  ["MQTT STREAM", Cloud, "MQTT stream"],
];
export const SETTINGS_PAGE = ["SETTINGS", SettingsIcon, "Settings"];
export const PAGES = [...MAIN_PAGES, ...MORE_PAGES, SETTINGS_PAGE];
