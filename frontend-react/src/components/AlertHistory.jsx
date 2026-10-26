import { useCallback, useEffect, useState } from "react";
import { getAlertHistory } from "../config";

const RANGES = [[1, "24 hours"], [7, "7 days"], [30, "30 days"]];
const LABELS = {
  temp_high: "Too warm", temp_low: "Too cold", humidity_high: "Humid", humidity_low: "Dry air",
  sensor_offline: "Sensor offline", broker_offline: "Broker offline", sensor_stuck: "Sensor stuck", mold_risk: "Mold risk",
};

function duration(sec) {
  if (sec < 90) return `${Math.max(1, Math.round(sec))} s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  if (sec < 172800) return `${(sec / 3600).toFixed(1)} h`;
  return `${Math.round(sec / 86400)} days`;
}

const when = (ts) => new Date(ts * 1000).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
// the stored text starts with an emoji for Telegram; the label already says what it is
const plain = (text) => (text || "").replace(/^[^\p{L}\p{N}]+/u, "");

function useAlertHistory(days, apiOnline) {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    getAlertHistory(days)
      .then((list) => { setEvents(list); setError(null); })
      .catch((e) => setError(e.message));
  }, [days]);

  useEffect(() => {
    if (!apiOnline) return undefined;
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, [apiOnline, load]);

  return { events, error };
}

/** Alerts page: every alert of the chosen period, newest first. */
export default function AlertHistory({ apiOnline }) {
  const [days, setDays] = useState(7);
  const { events, error } = useAlertHistory(days, apiOnline);

  return (
    <section className="module-card ah" aria-labelledby="ah-title">
      <div className="ah-head">
        <h3 id="ah-title">ALERT HISTORY</h3>
        <div className="ah-range" role="group" aria-label="Period">
          {RANGES.map(([d, label]) => (
            <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}>{label}</button>
          ))}
        </div>
      </div>

      {!apiOnline && <p className="ah-empty">Backend unreachable: history unavailable.</p>}
      {apiOnline && error && <p className="ah-empty">Couldn't load the history: {error}</p>}
      {apiOnline && !error && events == null && <p className="ah-empty">Loading…</p>}
      {apiOnline && events?.length === 0 && (
        <p className="ah-empty">No alerts in the last {RANGES.find(([d]) => d === days)[1]}. Alerts are logged from v6.15 on.</p>
      )}

      {events?.length > 0 && (
        <ol className="ah-list">
          {events.map((e) => (
            <li key={e.id} className={e.ended ? "" : "is-active"}>
              <div className="ah-row">
                <strong>{LABELS[e.key] || e.key}</strong>
                <span className="ah-dur num">{e.ended ? duration(e.duration_sec) : `Active · ${duration(e.duration_sec)}`}</span>
              </div>
              <p>{plain(e.message)}</p>
              <small>
                {when(e.started)}{e.ended ? ` → ${new Date(e.ended * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
                {" · "}{e.notified ? "sent to you" : "not sent (paused, or already sent recently)"}
              </small>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
