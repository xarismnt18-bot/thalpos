import { useMemo, useState } from "react";
import { THRESHOLDS } from "../../config";
import { useWindowState } from "../../hooks/useWindowState";
import { useStoredHistory } from "../../hooks/useStoredHistory";
import { lastSeconds, toSeries } from "../../lib/series";
import PresenceChart from "../charts/PresenceChart";
import TimeSeriesChart from "../charts/TimeSeriesChart";
import AnimatedNumber from "../ui/AnimatedNumber";

// [label, seconds, bucket size]; the live range uses the in-memory packets,
// the others the readings the backend stores every 30 s (kept 30 days).
const RANGES = [
  { label: "Live hour", seconds: 3600, step: null },
  { label: "24 hours", seconds: 24 * 3600, step: 300 },
  { label: "7 days", seconds: 7 * 24 * 3600, step: 1800 },
  { label: "30 days", seconds: 30 * 24 * 3600, step: 7200 },
];
const TEMP_COLOR = "#f97316";
const HUM_COLOR = "#22d3ee";

export default function Analytics({ telemetry, room }) {
  const { history, healthInfo } = telemetry;
  const [range, setRange] = useState(RANGES[1]);
  const [hoverTs, setHoverTs] = useState(null);
  const live = range.step === null;
  const windowState = useWindowState(telemetry.latest.room || room, range.seconds/3600);
  const stored = useStoredHistory(live ? null : range.seconds, range.step);

  const source = live ? history : stored.points;
  const liveWindow = live ? range.seconds : null;
  const temps = useMemo(() => lastSeconds(toSeries(source, "temperature"), liveWindow), [source, liveWindow]);
  const hums = useMemo(() => lastSeconds(toSeries(source, "humidity"), liveWindow), [source, liveWindow]);
  const chartProps = {
    annotations: windowState.data?.events || [],
    hoverTs, onHover: setHoverTs,
    gapSec: live ? 60 : range.step * 3,
    longRange: range.seconds > 2 * 24 * 3600,
  };
  const note = live
    ? `${temps.length} live packets from the last hour`
    : stored.error
      ? `Stored history unavailable: ${stored.error}`
      : `${temps.length} points, ${range.step / 60}-minute averages of the readings stored every 30 s`;

  return (
    <div className="module-page">
      <h1>Analytics</h1>
      <p className="module-subtitle">{room} telemetry. Hover or use the arrow keys on a chart to inspect a moment.</p>

      <div className="range-filter" role="group" aria-label="Time range">
        {RANGES.map((r) => (
          <button
            key={r.label}
            type="button"
            className={range === r ? "active" : ""}
            aria-pressed={range === r}
            onClick={() => setRange(r)}
          >
            {r.label}
          </button>
        ))}
        <span className="range-filter__note">{note}</span>
      </div>

      <details className="window-history"><summary>Window activity · manual entries</summary>{windowState.error&&<p>{windowState.error}</p>}{!windowState.data?.events.length&&<p>No window entries in this period.</p>}<ul>{windowState.data?.events.map(e=><li key={e.id}>{new Date(e.ts*1000).toLocaleString('el-GR')} · {e.is_open?'Open':'Closed'}{e.action==='confirmed'?' (confirmed)':''}</li>)}</ul><p>Dashed markers: teal = opened, amber = closed. Manual entries do not establish the cause of a change.</p></details>
      <div className="analytics-grid">
        <div className="module-card">
          <TimeSeriesChart
            title="Temperature"
            unit="°C"
            color={TEMP_COLOR}
            points={temps}
            band={{ low: THRESHOLDS.TEMP_LOW, high: THRESHOLDS.TEMP_HIGH }}
            {...chartProps}
          />
        </div>
        <div className="module-card">
          <TimeSeriesChart
            title="Humidity"
            unit="%"
            color={HUM_COLOR}
            points={hums}
            band={{ low: THRESHOLDS.HUMIDITY_LOW, high: THRESHOLDS.HUMIDITY_HIGH }}
            {...chartProps}
          />
        </div>
        <div className="module-card analytics-presence">
          <PresenceChart />
        </div>
        <div className="module-card analytics-health">
          <h3>Health score</h3>
          <div className="big-score">
            <AnimatedNumber value={healthInfo.health_score ?? null} decimals={0} suffix="/100" />
          </div>
          <dl className="analytics-health__facts">
            <div><dt>Status</dt><dd>{healthInfo.status?.replaceAll("_", " ").toLowerCase() ?? "--"}</dd></div>
            <div><dt>Dew point</dt><dd>{healthInfo.dew_point != null ? `${healthInfo.dew_point} °C` : "--"}</dd></div>
            <div><dt>Mold risk</dt><dd>{healthInfo.mold_risk ?? "--"}</dd></div>
          </dl>
        </div>
      </div>
    </div>
  );
}
