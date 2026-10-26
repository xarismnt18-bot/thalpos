import { useMemo, useState } from "react";
import { useSleepNights } from "../hooks/useSleepNights";
import { toSeries } from "../lib/series";
import TimeSeriesChart from "./charts/TimeSeriesChart";

const TEMP_COLOR = "#f97316";
const HUM_COLOR = "#22d3ee";
const W = 560;
const H = 170;
const PAD = { top: 22, right: 8, bottom: 26, left: 8 };

const clock = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const weekday = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: "short" });
const longDay = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
const duration = (min) => (min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min` : `${min} min`);

function grade(score) {
  if (score >= 80) return { label: "Good", tone: "good" };
  if (score >= 60) return { label: "Fair", tone: "fair" };
  return { label: "Poor", tone: "poor" };
}

/** Room score per night (oldest left); a click selects the night shown below. */
function NightBars({ nights, selected, onSelect }) {
  const ordered = [...nights].reverse();
  const plotH = H - PAD.top - PAD.bottom;
  const slot = (W - PAD.left - PAD.right) / Math.max(ordered.length, 1);
  const barW = Math.min(36, slot * 0.5);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="sleep-bars" role="group" aria-label="Room score per night, last 7 nights">
      <line x1={PAD.left} x2={W - PAD.right} y1={H - PAD.bottom} y2={H - PAD.bottom} className="presence-chart__axis" />
      {ordered.map((n, i) => {
        const x = PAD.left + slot * i + (slot - barW) / 2;
        const has = n.score != null;
        const h = has ? Math.max(4, (n.score / 100) * plotH) : 0;
        const y = H - PAD.bottom - h;
        const isSel = n.date === selected;
        const label = has ? `${weekday(n.date)}: room score ${n.score}, ${grade(n.score).label}` : `${weekday(n.date)}: no readings`;
        return (
          <g key={n.date} className={`sleep-bars__night ${isSel ? "is-selected" : ""} ${has ? `is-${grade(n.score).tone}` : "is-empty"}`}
            role="button" tabIndex={has ? 0 : -1} aria-pressed={isSel} aria-label={label} aria-disabled={!has}
            onClick={() => has && onSelect(n.date)}
            onKeyDown={(e) => { if (has && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onSelect(n.date); } }}>
            <title>{label}</title>
            <rect x={PAD.left + slot * i} y={PAD.top - 8} width={slot} height={H - PAD.top + 8} className="sleep-bars__hit" />
            {has
              ? <rect x={x} y={y} width={barW} height={h} rx="4" className="sleep-bars__bar" />
              : <text x={x + barW / 2} y={H - PAD.bottom - 8} textAnchor="middle" className="sleep-bars__none">–</text>}
            {has && <text x={x + barW / 2} y={y - 6} textAnchor="middle" className="presence-chart__value">{n.score}</text>}
            <text x={x + barW / 2} y={H - 8} textAnchor="middle" className="presence-chart__day">{weekday(n.date)}</text>
          </g>
        );
      })}
    </svg>
  );
}

function Outside({ night }) {
  const rows = [["warm", "Too warm"], ["cold", "Too cold"], ["humid", "Too humid"], ["dry", "Too dry"]]
    .filter(([k]) => night.minutes_outside[k] >= 5);
  if (!rows.length) return <p className="sleep-night__ok">All night inside the ideal range.</p>;
  return (
    <ul className="sleep-night__outside">
      {rows.map(([k, label]) => <li key={k}><span>{label}</span> <b>{duration(night.minutes_outside[k])}</b></li>)}
    </ul>
  );
}

export default function Sleep({ room }) {
  const { nights, ideal, error, loading } = useSleepNights(7);
  const scored = nights.filter((n) => n.score != null);
  const [picked, setPicked] = useState(null);
  const night = scored.find((n) => n.date === picked) || scored[0] || null;
  const [hoverTs, setHoverTs] = useState(null);
  const temps = useMemo(() => (night ? toSeries(night.series, "temperature") : []), [night]);
  const hums = useMemo(() => (night ? toSeries(night.series, "humidity") : []), [night]);
  const g = night ? grade(night.score) : null;

  return (
    <div className="module-page">
      <h1>Sleep</h1>
      <p className="module-subtitle">
        How the {room.toLowerCase()} was while you slept. The score rates the room, not your sleep:
        100 means the whole night stayed in the ideal range
        {ideal ? ` (${ideal.temp_low}–${ideal.temp_high} °C, ${ideal.hum_low}–${ideal.hum_high} % humidity)` : ""}.
      </p>

      {error && <div className="module-card"><p>Sleep data unavailable: {error}</p></div>}

      {!error && !loading && !night && (
        <div className="module-card sleep-empty">
          <h3>No night with readings yet</h3>
          <p>
            Readings are only stored while the PC running Thalpos is on. Leave it on overnight
            (run <code>keep_awake.bat</code> on a laptop) and the first night appears here the next morning.
            The radar finds when you went to bed and got up.
          </p>
        </div>
      )}

      {night && (
        <div className="sleep-grid">
          <div className="module-card sleep-night">
            <h3>Night to {longDay(night.date)}</h3>
            <div className="sleep-night__score">
              <span className={`big-score sleep-score--${g.tone}`}>{night.score}<small>/100</small></span>
              <span className={`sleep-grade sleep-grade--${g.tone}`}>{g.label}</span>
            </div>
            <p className="sleep-night__when">
              {clock(night.start)} – {clock(night.end)} · {duration(night.minutes)}
              {night.source === "estimated"
                ? <span className="sleep-night__note"> · estimated, no radar data for this night</span>
                : night.interruptions ? <span className="sleep-night__note"> · left the room {night.interruptions}×</span> : null}
            </p>
            <dl className="analytics-health__facts">
              <div>
                <dt>Temperature</dt>
                <dd>{night.temperature.avg.toFixed(1)} °C</dd>
                <dd className="sleep-night__range">{night.temperature.min.toFixed(1)}–{night.temperature.max.toFixed(1)}</dd>
              </div>
              <div>
                <dt>Humidity</dt>
                <dd>{Math.round(night.humidity.avg)} %</dd>
                <dd className="sleep-night__range">{Math.round(night.humidity.min)}–{Math.round(night.humidity.max)}</dd>
              </div>
            </dl>
            <Outside night={night} />
            {night.tip && <p className="sleep-night__tip">{night.tip}</p>}
          </div>

          <div className="module-card presence-chart">
            <h3>Last 7 nights</h3>
            <p className="presence-chart__summary">Select a night to see it hour by hour.</p>
            <NightBars nights={nights} selected={night.date} onSelect={setPicked} />
          </div>

          <div className="module-card">
            <TimeSeriesChart title="Temperature overnight" unit="°C" color={TEMP_COLOR} points={temps}
              band={ideal ? { low: ideal.temp_low, high: ideal.temp_high } : null}
              hoverTs={hoverTs} onHover={setHoverTs} gapSec={1800} bandLabel="Ideal for sleep" />
          </div>
          <div className="module-card">
            <TimeSeriesChart title="Humidity overnight" unit="%" color={HUM_COLOR} points={hums} decimals={0}
              band={ideal ? { low: ideal.hum_low, high: ideal.hum_high } : null}
              hoverTs={hoverTs} onHover={setHoverTs} gapSec={1800} bandLabel="Ideal for sleep" />
          </div>
        </div>
      )}
    </div>
  );
}
