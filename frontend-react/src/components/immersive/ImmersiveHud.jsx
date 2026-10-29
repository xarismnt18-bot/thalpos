import { DEMO, THRESHOLDS } from "../../config";
import { humidityLegendGradient, temperatureLegendGradient } from "../../lib/colorScale";
import { lastSeconds, toSeries, trendPer10Min } from "../../lib/series";
import { LIVE_ROOM_ID, ROOMS } from "./layout";
import WindowControl from "../WindowControl";
import WeatherCard from "../WeatherCard";

const VIEWS = [["temp", "Temperature"], ["hum", "Humidity"], ["xray", "X-ray"]];

const fmt = (v, d = 1) => (v == null || Number.isNaN(Number(v)) ? "--" : Number(v).toFixed(d));

function StatusPills({ status, secondsAgo }) {
  const pills = [
    [status.broker, status.api ? (status.broker ? "Broker online" : "Broker offline") : "API offline"],
    [status.sensor, status.sensor ? `Sensor live, ${secondsAgo ?? 0} s ago` : "Sensor offline"],
  ];
  return (
    <div className="imm-status" aria-live="polite">
      {pills.map(([ok, text]) => (
        <span key={text} className="imm-pill">
          <span className={`status-dot ${ok ? "" : "status-dot--off"}`} aria-hidden="true" />
          {text}
        </span>
      ))}
    </div>
  );
}

function Sparkline({ points, color, events=[] }) {
  const W = 280, H = 64, PAD = 6;
  const { TEMP_LOW, TEMP_HIGH } = THRESHOLDS;
  if (points.length < 2) {
    return <p className="imm-muted imm-spark-empty">The chart fills in as packets arrive.</p>;
  }
  const values = points.map((p) => p.value);
  const lo = Math.min(...values, TEMP_LOW) - 0.5;
  const hi = Math.max(...values, TEMP_HIGH) + 0.5;
  const t0 = points[0].ts, t1 = points[points.length - 1].ts || t0 + 1;
  const x = (ts) => ((ts - t0) / (t1 - t0 || 1)) * (W - PAD * 2) + PAD;
  const y = (v) => H - PAD - ((v - lo) / (hi - lo)) * (H - PAD * 2);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(p.ts).toFixed(1)} ${y(p.value).toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  return (
    <svg className="imm-spark" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`Temperature over the last hour, now ${fmt(last.value)} degrees`}>
      <rect x="0" y={y(TEMP_HIGH)} width={W} height={y(TEMP_LOW) - y(TEMP_HIGH)} className="imm-spark__band" />
      {events.filter(e=>e.action==='changed'&&e.ts>=t0&&e.ts<=t1).map(e=><line key={e.id} x1={x(e.ts)} x2={x(e.ts)} y1="0" y2={H} stroke={e.is_open?'#6ee7df':'#f5b879'} strokeDasharray="3 3"><title>{e.is_open?'Window opened':'Window closed'} · manual input</title></line>)}
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(last.ts)} cy={y(last.value)} r="4" fill={color} />
    </svg>
  );
}

const MOLD_TONE = { moderate: "warn", high: "alert" };

/** Small facts as chips: only what is true right now, nothing when there is nothing to say. */
function RoomChips({ latest, healthInfo }) {
  const mold = healthInfo.mold_risk;
  const chips = [];
  if (latest.presence != null) chips.push([latest.presence ? "in" : "", latest.presence ? "Someone is here" : "Empty"]);
  if (MOLD_TONE[mold]) chips.push([MOLD_TONE[mold], `Mold risk ${mold}`]);
  if (!chips.length) return null;
  return <p className="imm-chips-row">{chips.map(([tone, text]) => <span key={text} className={`imm-chip ${tone ? `imm-chip--${tone}` : ""}`}><i aria-hidden="true" />{text}</span>)}</p>;
}

function LiveRoomPanel({ room, latest, healthInfo, history, hasData, status, colorHex, windowState }) {
  const points = lastSeconds(toSeries(history, "temperature"), 3600);
  const trend = trendPer10Min(points);
  const values = points.map((p) => p.value);
  return (
    <>
      <div className="imm-room-head">
        <h1>{room}</h1>
        <small>{latest.sensor || "DHT11"}</small>
      </div>
      {hasData ? (
        <>
          <p className="imm-big num" style={{ color: colorHex }}>{fmt(latest.temperature)}<sup>°C</sup></p>
          <p className="imm-trend" data-rising={trend != null && trend > 0.05}>
            {trend == null ? "Collecting trend…" : trend > 0.05 ? `Rising ${fmt(trend)}° per 10 min`
              : trend < -0.05 ? `Falling ${fmt(Math.abs(trend))}° per 10 min` : "Steady"}
          </p>
        </>
      ) : (
        <p className="imm-waiting">
          {status.api ? (status.broker ? "Waiting for the sensor. No recent packets." : "MQTT broker unreachable.") : "Backend unreachable. Start the API to see live data."}
        </p>
      )}
      <dl className="imm-stats imm-stats--two">
        <div><dt>Humidity</dt><dd className="num">{hasData ? `${fmt(latest.humidity, 0)}%` : "--"}</dd></div>
        <div><dt>Dew point</dt><dd className="num">{hasData && healthInfo.dew_point != null ? `${fmt(healthInfo.dew_point)}°` : "--"}</dd></div>
      </dl>
      {hasData && <RoomChips latest={latest} healthInfo={healthInfo} />}
      <WindowControl windowState={windowState} />
      <Sparkline points={points} color={colorHex ?? "#64748B"} events={windowState.data?.events} />
      {values.length > 1 && (
        <div className="imm-spark-cap">
          <span>Last hour · <span className="num">{fmt(Math.min(...values))}–{fmt(Math.max(...values))}°</span></span>
          <span>shaded = comfort {THRESHOLDS.TEMP_LOW}–{THRESHOLDS.TEMP_HIGH}°</span>
        </div>
      )}
    </>
  );
}

function EmptyRoomPanel({ name }) {
  return (
    <>
      <div className="imm-room-head"><h1>{name}</h1><small>No sensor</small></div>
      <p className="imm-waiting">
        No sensor in this room yet. Flash another ESP8266 + DHT11 with this room name in
        <code> secrets.h</code> and it lights up here on its first packet.
      </p>
    </>
  );
}

function AlertPanel({ status, alerts, room }) {
  let tone = "clear", title = "All rooms comfortable", body = ["Nothing needs attention right now."];
  if (!status.api) {
    tone = "critical"; title = "No data"; body = ["Backend unreachable, so alerts are unknown."];
  } else if (alerts.length) {
    tone = "critical"; title = `${room} needs attention`; body = alerts;
  }
  return (
    <div className={`imm-panel imm-alert imm-alert--${tone}`} role="status">
      <h2>{title}</h2>
      {body.map((line) => <p key={line}>{line}</p>)}
    </div>
  );
}

/** Phone only: the desktop alert panel sits in the right column, which phones don't show. */
function PhoneAlert({ status, alerts, room }) {
  if (!status.api) {
    return <p className="imm-phone-alert" role="status"><strong>No data.</strong> Backend unreachable.</p>;
  }
  if (!alerts.length) return null;
  return (
    <div className="imm-phone-alert" role="status">
      <strong>{room} needs attention</strong>
      {alerts.map((line) => <span key={line}>{line}</span>)}
    </div>
  );
}

export default function ImmersiveHud({
  room, latest, healthInfo, history, status, alerts, hasData, colorHex,
  view, onView, selected, onSelect, onHome, wx, windowState,
}) {
  const inside = hasData ? { temperature: latest.temperature, humidity: latest.humidity } : null;
  const selectedRoom = ROOMS.find((r) => r.id === selected);
  const legend = view === "hum"
    ? [`${THRESHOLDS.HUMIDITY_LOW - 10}%`, humidityLegendGradient(), `${THRESHOLDS.HUMIDITY_CRITICAL}%`]
    : [`${THRESHOLDS.TEMP_LOW - 4}°`, temperatureLegendGradient(), `${THRESHOLDS.TEMP_CRITICAL}°`];

  return (
    <div className="imm-hud">
      <header className="imm-top">
        <p className="imm-place">{room} · {DEMO ? "live demo, simulated sensor" : "live digital twin"}</p>
        <StatusPills status={status} secondsAgo={latest.seconds_since_update} />
      </header>

      <section className="imm-left imm-panel" aria-label="Selected room">
        <PhoneAlert status={status} alerts={alerts} room={room} />
        {selected === LIVE_ROOM_ID
          ? <LiveRoomPanel room={room} latest={latest} healthInfo={healthInfo} history={history} hasData={hasData} status={status} colorHex={colorHex} windowState={windowState} />
          : <EmptyRoomPanel name={selectedRoom?.name} />}
        <div className="wx-phone"><WeatherCard wx={wx} inside={inside} manualWindow={windowState.error?null:windowState.data} compact /></div>
      </section>

      <aside className="imm-right" aria-label="Activity">
        <AlertPanel status={status} alerts={alerts} room={room} />
        <WeatherCard wx={wx} inside={inside} manualWindow={windowState.error?null:windowState.data} />
      </aside>

      <footer className="imm-bottom">
        <div className="imm-legend" aria-hidden="true">
          <span className="num">{legend[0]}</span><i style={{ background: legend[1] }} /><span className="num">{legend[2]}</span>
        </div>
        <div className="imm-controls">
          <div className="imm-seg" role="group" aria-label="View">
            {VIEWS.map(([id, label]) => (
              <button key={id} type="button" aria-pressed={view === id} onClick={() => onView(id)}>{label}</button>
            ))}
          </div>
          <div className="imm-chips" role="group" aria-label="Rooms">
            {ROOMS.filter((r) => r.live || selected === r.id).map((r) => (
              <button key={r.id} type="button" aria-pressed={selected === r.id} onClick={() => onSelect(r.id)}>
                <span className="imm-swatch" style={{ background: r.live && hasData ? colorHex : "#3A4654" }} aria-hidden="true" />
                {r.live ? room : r.name}
              </button>
            ))}
            <button type="button" onClick={onHome}>Whole home</button>
          </div>
        </div>
        <p className="imm-hint">Drag to orbit · scroll to zoom<br />Click a room to fly to it</p>
      </footer>
    </div>
  );
}
