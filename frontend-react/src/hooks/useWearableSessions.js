import { useEffect, useState } from 'react';
import { DEMO } from '../config';

export const WEARABLE_REFRESH_MS = 60_000;

/** Poll only while unlocked and visible; preserve the selected session in the caller. */
export function useWearableSessions(room, token, refreshId, targetHours=8) {
  const [state, setState] = useState({ data: null, error: '', room: null, token: null, refreshed: null });
  useEffect(() => {
    if (!token || DEMO) return;
    let cancelled = false;
    let running = false;
    let unauthorized = false;
    let controller;
    async function load() {
      if (running || cancelled || unauthorized || document.visibilityState === 'hidden') return;
      running = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch(`/wearable/sessions?room=${encodeURIComponent(room)}&days=30&target_hours=${targetHours}`, {
          headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: controller.signal,
        });
        if (!response.ok) {
          unauthorized = response.status === 401;
          throw new Error(unauthorized ? 'Check your sleep pairing key and unlock again.' : `Sleep bridge unavailable (${response.status}).`);
        }
        const data = await response.json();
        if (!cancelled) setState({ data, error: '', room, token, targetHours, refreshed: Date.now() });
      } catch (error) {
        if (!cancelled) setState(previous => ({
          data: !unauthorized && previous.room === room && previous.token === token && previous.targetHours === targetHours ? previous.data : null,
          refreshed: previous.refreshed, room, token, targetHours, error: error.name === 'AbortError' ? 'Sleep refresh timed out; it will retry.' : error.message,
        }));
      } finally { clearTimeout(timeout); running = false; }
    }
    load();
    const timer = setInterval(load, WEARABLE_REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { cancelled = true; clearInterval(timer); controller?.abort(); document.removeEventListener('visibilitychange', onVisible); };
  }, [room, token, refreshId, targetHours]);
  const current = token && state.room === room && state.token === token && state.targetHours === targetHours;
  return {
    data: current ? state.data : null,
    error: token && DEMO ? 'Private wearable data is unavailable in the simulated demo.' : current ? state.error : '',
    loading: !!token && !DEMO && !current,
    refreshed: current ? state.refreshed : null,
  };
}
