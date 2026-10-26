import { useEffect, useState } from "react";
import { apiGet } from "../config";

const REFRESH_MS = 5 * 60_000;

/** The last `nights` nights from GET /sleep, newest first. */
export function useSleepNights(nights = 7) {
  const [state, setState] = useState({ nights: [], ideal: null, error: null, loading: true });

  useEffect(() => {
    let cancelled = false;
    const load = () => apiGet(`/sleep?nights=${nights}`)
      .then((r) => !cancelled && setState({ nights: r.nights, ideal: r.ideal, error: null, loading: false }))
      .catch((e) => !cancelled && setState((s) => ({ ...s, error: e.message, loading: false })));
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [nights]);

  return state;
}
