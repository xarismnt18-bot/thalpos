import { useMemo, useState } from "react";
import * as THREE from "three";
import { THRESHOLDS } from "../../config";
import { humidityColor, temperatureColor } from "../../lib/colorScale";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useOutdoorWeather } from "../../hooks/useOutdoorWeather";
import { useWindowState } from "../../hooks/useWindowState";
import ImmersiveScene from "../immersive/ImmersiveScene";
import ImmersiveHud from "../immersive/ImmersiveHud";
import { LIVE_ROOM_ID } from "../immersive/layout";

const ALERT_RED = "#EF4444";

function alertLevel(alerts, temp, hum) {
  if (alerts.length === 0) return null;
  return temp >= THRESHOLDS.TEMP_CRITICAL || hum >= THRESHOLDS.HUMIDITY_CRITICAL ? "critical" : "warning";
}

/** Dashboard = the house itself: full-bleed live 3D twin with a HUD on top. */
export default function Dashboard({ telemetry, room, active=true }) {
  const { latest, healthInfo, activeAlerts, history, status, packetSeq } = telemetry;
  const reduced = usePrefersReducedMotion();
  const narrow = useMediaQuery("(max-width: 767.98px)");
  const [view, setView] = useState("temp");
  const [selected, setSelected] = useState(LIVE_ROOM_ID);
  const [focus, setFocus] = useState("home");
  const wx = useOutdoorWeather();
  const windowState = useWindowState(latest.room || room);

  const temp = latest.temperature;
  const hum = latest.humidity;
  const hasData = status.sensor && temp != null && hum != null;
  const alert = hasData ? alertLevel(activeAlerts, temp, hum) : null;
  // any active alert turns the room red (and it pulses); otherwise it follows the view's scale
  const liveColor = useMemo(() => {
    if (!hasData) return null;
    if (alert) return new THREE.Color(ALERT_RED);
    return view === "hum" ? humidityColor(hum) : temperatureColor(temp);
  }, [hasData, alert, view, temp, hum]);
  // the HUD numbers always use the temperature colour, whatever the 3D view
  const tempHex = hasData ? `#${temperatureColor(temp).getHexString()}` : null;

  const selectRoom = (id) => {
    setSelected(id);
    setFocus(id);
  };

  return (
    <div className="imm">
      <ImmersiveScene
        active={active}
        windowState={windowState.visualState}
        liveName={room}
        liveColor={liveColor}
        liveText={hasData ? `${temp.toFixed(1)}° · ${Math.round(hum)}%` : status.api ? "no data" : "offline"}
        view={view}
        focus={focus}
        selected={selected}
        onSelect={selectRoom}
        alert={alert}
        packetSeq={packetSeq}
        status={status}
        reduced={reduced}
        narrow={narrow}
        presence={hasData && latest.presence === true}
        presenceSince={latest.presence_since}
      />
      <ImmersiveHud
        room={room}
        latest={latest}
        healthInfo={healthInfo}
        history={history}
        status={status}
        alerts={activeAlerts}
        hasData={hasData}
        colorHex={tempHex}
        view={view}
        onView={setView}
        selected={selected}
        onSelect={selectRoom}
        onHome={() => setFocus("home")}
        windowState={windowState}
        wx={wx}
      />
    </div>
  );
}
