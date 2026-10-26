import { useState } from "react";
import "./App.css";
import { CLIENT, formatTime } from "./config";
import { useTelemetry } from "./hooks/useTelemetry";
import { useToasts } from "./hooks/useToasts";
import Sidebar, { MobileBar } from "./components/layout/Sidebar";
import Toasts from "./components/ui/Toasts";
import Dashboard from "./components/pages/Dashboard";
import Analytics from "./components/pages/Analytics";
import { Alerts, Floorplan } from "./components/pages/RoomPages";
import { MqttPanel } from "./components/pages/shared";
import Energy from "./components/Energy";
import Reports from "./components/Reports";
import Settings from "./components/Settings";
import AIBrain from "./components/AIBrain";
import Predictions from "./components/Predictions";
import Sleep from "./components/Sleep";

function formatReading(value) {
  return value != null ? Number(value).toFixed(1) : "--";
}

export default function App() {
  const [active, setActive] = useState(() => (
    import.meta.env.BASE_URL === '/sleep-lab/' || new URLSearchParams(window.location.search).get('page') === 'SLEEP'
      ? 'SLEEP' : 'DASHBOARD'
  ));
  const [navOpen, setNavOpen] = useState(false);
  const { toasts, push, dismiss } = useToasts();
  const telemetry = useTelemetry({ onEvent: push });
  const { latest, healthInfo, activeAlerts, history, status, refreshConfig } = telemetry;

  const temp = formatReading(latest.temperature);
  const humidity = formatReading(latest.humidity);
  const healthScore = healthInfo.health_score ?? null;
  const health = healthScore ?? "--";
  const lastUpdate = formatTime(latest.last_update);
  const room = CLIENT.ROOM_NAME || latest.room || "Room";

  const navigate = (page) => {
    setActive(page);
    setNavOpen(false);
  };

  return (
    <div className="app">
      <MobileBar open={navOpen} onToggle={() => setNavOpen((o) => !o)} status={status} />
      <Sidebar active={active} onNavigate={navigate} status={status} open={navOpen} sensor={latest.sensor} />

      <main className={active === "DASHBOARD" ? "main main--immersive" : "main"} key={active}>
        {active === "DASHBOARD" && <Dashboard telemetry={telemetry} room={room} />}
        {active === "FLOORPLAN" && <Floorplan room={room} temp={temp} humidity={humidity} health={health} />}
        {active === "ANALYTICS" && <Analytics telemetry={telemetry} room={room} />}
        {active === "SLEEP" && <Sleep room={room} />}
        {active === "MQTT STREAM" && (
          <MqttPanel room={room} latest={latest} health={health} lastUpdate={lastUpdate} connected={status.sensor} />
        )}
        {active === "ALERTS" && (
          <Alerts room={room} health={health} alerts={activeAlerts} apiOnline={status.api} healthInfo={healthInfo} />
        )}
        {active === "AI BRAIN" && <AIBrain temp={temp} humidity={humidity} health={healthScore} history={history} />}
        {active === "PREDICTIONS" && <Predictions />}
        {active === "ENERGY" && <Energy temp={temp} humidity={humidity} history={history} />}
        {active === "REPORTS" && <Reports room={room} history={history} />}
        {active === "SETTINGS" && (
          <Settings
            temp={temp} humidity={humidity} health={health} lastUpdate={lastUpdate}
            status={status} onConfigChange={refreshConfig}
          />
        )}
      </main>

      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
