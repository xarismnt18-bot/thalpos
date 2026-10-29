import { useId, useState } from "react";
import { THRESHOLDS } from "../config";
import { describeCode, searchPlaces, windowAdvice } from "../lib/weather";

const fmt = (v, d = 0) => (v == null || Number.isNaN(Number(v)) ? "--" : Number(v).toFixed(d));

function usePlaceSearch(onPick) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const search = async (e) => {
    e.preventDefault();
    if (query.trim().length < 2) return;
    setBusy(true);
    setError(null);
    try {
      const found = await searchPlaces(query.trim());
      setResults(found);
      if (found.length === 0) setError(`No place called "${query.trim()}". Try the nearest town.`);
    } catch {
      setError("Couldn't reach the place search. Check the internet connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const pick = (place) => {
    setResults(null);
    setQuery("");
    onPick(place);
  };

  return { query, setQuery, results, busy, error, search, pick };
}

function PlacePicker({ onPick, onCancel }) {
  const s = usePlaceSearch(onPick);
  const inputId = useId(); // the card is on the page twice (desktop panel and phone panel)
  return (
    <div className="wx-picker">
      <form onSubmit={s.search} className="wx-picker__form">
        <label htmlFor={inputId} className="wx-picker__label">Town or city</label>
        <div className="wx-picker__row">
          <input id={inputId} type="search" value={s.query} onChange={(e) => s.setQuery(e.target.value)}
            placeholder="e.g. Porto Rafti" autoComplete="off" />
          <button type="submit" className="wx-btn" disabled={s.busy || s.query.trim().length < 2}>
            {s.busy ? "Searching…" : "Search"}
          </button>
        </div>
      </form>
      {s.error && <p className="wx-note" role="status">{s.error}</p>}
      {s.results?.length > 0 && (
        <ul className="wx-results">
          {s.results.map((r) => (
            <li key={`${r.lat},${r.lon}`}>
              <button type="button" onClick={() => s.pick(r)}>
                {r.name}<small>{r.detail}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      {onCancel && <button type="button" className="wx-link" onClick={onCancel}>Cancel</button>}
    </div>
  );
}

// no place known at all yet
const NEEDS_PLACE_TEXT = {
  denied: "Location permission is off for this site. Allow it in the browser, or pick a place.",
  unsupported: "This address can't use location (it needs https, e.g. the Tailscale link). Pick a place instead.",
  unavailable: "Windows couldn't work out your position. Pick a place instead.",
  timeout: "Finding your position took too long (no GPS on this device). Try again, or pick a place.",
};

// showing the last known place instead of the current one
const PROBLEM_TEXT = {
  denied: "Location permission is off for this site, so this is your last known place. Pick a place, or allow location in the browser.",
  unsupported: "This address can't use location (it needs https, e.g. the Tailscale link). Pick a place instead.",
  unavailable: "Couldn't get your position right now. Showing your last known place.",
  timeout: "Couldn't get your position in time. Showing your last known place.",
};

/** Outside conditions where you are, and whether opening the window would help the room. */
export default function WeatherCard({ wx, inside, compact = false, manualWindow = null }) {
  const [picking, setPicking] = useState(false);
  const { place, weather, status, problem, choosePlace, retry, manual } = wx;
  const advice = windowAdvice(inside, weather, THRESHOLDS, manualWindow);

  if (status === "needs-place" || picking) {
    return (
      <section className={`imm-panel wx ${compact ? "wx--compact" : ""}`} aria-label="Outside weather">
        <h2 className="wx-title">Weather outside</h2>
        {!picking && (
          <>
            <p className="wx-note">{NEEDS_PLACE_TEXT[problem] || NEEDS_PLACE_TEXT.unavailable}</p>
            <button type="button" className="wx-link" onClick={retry}>Try my location again</button>
          </>
        )}
        <PlacePicker
          onPick={(p) => { setPicking(false); choosePlace(p); }}
          onCancel={picking ? () => setPicking(false) : null}
        />
      </section>
    );
  }

  return (
    <section className={`imm-panel wx ${compact ? "wx--compact" : ""}`} aria-label="Outside weather">
      <div className="wx-head">
        <h2 className="wx-title">Outside · {place?.name || "locating…"}</h2>
        <button type="button" className="wx-link" onClick={() => setPicking(true)}>
          {manual ? "Change" : "Pick a place"}
        </button>
      </div>

      {status === "error" && !weather && <p className="wx-note">Weather service unreachable. Retrying in a few minutes.</p>}
      {status === "locating" && !weather && <p className="wx-note">Finding your location…</p>}

      {weather && (
        <>
          <p className="wx-now">
            <span className="wx-temp num">{fmt(weather.temperature, 1)}°</span>
            <span className="wx-desc">{describeCode(weather.code)}<br />
              <span className="num">{fmt(weather.humidity)}%</span> humidity
              {!compact && <> · wind <span className="num">{fmt(weather.wind)}</span> km/h</>}
            </span>
          </p>
          {advice && (
            <div className={`wx-advice wx-advice--${advice.tone}`} role="status">
              <strong>{advice.title}</strong>
              {!compact && <p>{advice.why}</p>}
            </div>
          )}
          {!compact && (
            <p className="wx-foot">
              {manual ? (
                <button type="button" className="wx-link" onClick={() => choosePlace(null)}>Use my location instead</button>
              ) : place?.source === "demo" ? "Demo location · Open-Meteo"
                : place?.source === "ip" ? "Approximate area, from your internet connection · Open-Meteo"
                : problem ? PROBLEM_TEXT[problem] : "Your current location · Open-Meteo"}
            </p>
          )}
        </>
      )}
    </section>
  );
}
