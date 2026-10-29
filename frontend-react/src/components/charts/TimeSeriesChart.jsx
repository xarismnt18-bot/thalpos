import { useMemo } from "react";
import { useElementWidth } from "../../hooks/useElementWidth";

const HEIGHT = 220;
const MARGIN = { top: 14, right: 18, bottom: 28, left: 44 };
const Y_TICKS = 4;

function niceStep(span, count) {
  const raw = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

function yDomain(values, band) {
  const all = [...values, band?.low, band?.high].filter((v) => v != null);
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (hi - lo < 2) {
    lo -= 1;
    hi += 1;
  }
  const step = niceStep(hi - lo, Y_TICKS);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toFixed(6)));
  return { lo, hi, ticks };
}

function formatClock(ts, withSeconds = false) {
  return new Date(ts * 1000).toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", ...(withSeconds ? { second: "2-digit" } : {}),
  });
}

function formatDay(ts) {
  return new Date(ts * 1000).toLocaleDateString([], { weekday: "short", day: "numeric" });
}

function formatMoment(ts, longRange, withSeconds) {
  return longRange ? `${formatDay(ts)} ${formatClock(ts)}` : formatClock(ts, withSeconds);
}

function nearestIndex(points, ts) {
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].ts < ts) lo = mid;
    else hi = mid;
  }
  return Math.abs(points[lo].ts - ts) <= Math.abs(points[hi].ts - ts) ? lo : hi;
}

/**
 * Single-series time chart: time axis, rounded y ticks, comfort band,
 * crosshair + tooltip (pointer and keyboard), and a table fallback.
 * `hoverTs` / `onHover` let several charts share one crosshair.
 */
export default function TimeSeriesChart({
  title, unit, color, points, band, hoverTs, onHover, decimals = 1, gapSec = Infinity, longRange = false,
  bandLabel = "Comfort range", annotations = [],
}) {
  const [frameRef, width] = useElementWidth();
  const innerW = Math.max(width - MARGIN.left - MARGIN.right, 10);
  const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;

  const geometry = useMemo(() => {
    if (points.length < 2) return null;
    const t0 = points[0].ts;
    const t1 = points[points.length - 1].ts;
    const { lo, hi, ticks } = yDomain(points.map((p) => p.value), band);
    const x = (ts) => ((ts - t0) / (t1 - t0 || 1)) * innerW;
    const y = (v) => innerH - ((v - lo) / (hi - lo || 1)) * innerH;
    // a pause longer than gapSec (sensor or PC off) breaks the line instead of bridging it
    const path = points.map((p, i) => {
      const move = i === 0 || p.ts - points[i - 1].ts > gapSec;
      return `${move ? "M" : "L"}${x(p.ts).toFixed(1)},${y(p.value).toFixed(1)}`;
    }).join("");
    const tickCount = innerW < 360 ? 3 : 5; // fewer labels on a phone so they don't overlap
    const timeTicks = Array.from({ length: tickCount }, (_, i) => t0 + ((t1 - t0) * i) / (tickCount - 1));
    return { t0, t1, lo, hi, ticks, x, y, path, timeTicks };
  }, [points, band, innerW, innerH, gapSec]);

  const hovered = geometry && hoverTs != null && hoverTs >= geometry.t0 && hoverTs <= geometry.t1
    ? points[nearestIndex(points, hoverTs)]
    : null;
  const last = points[points.length - 1];

  const handlePointer = (e) => {
    if (!geometry) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = Math.min(Math.max((e.clientX - rect.left - MARGIN.left) / innerW, 0), 1);
    onHover(geometry.t0 + fraction * (geometry.t1 - geometry.t0));
  };

  const handleKey = (e) => {
    if (!geometry || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const current = hovered ? points.indexOf(hovered) : points.length - 1;
    const next = {
      ArrowLeft: Math.max(current - 1, 0),
      ArrowRight: Math.min(current + 1, points.length - 1),
      Home: 0,
      End: points.length - 1,
    }[e.key];
    onHover(points[next].ts);
  };

  const summary = last
    ? `${title}: latest ${last.value.toFixed(decimals)}${unit}, ${points.length} readings`
    : `${title}: no readings yet`;

  return (
    <figure className="ts-chart">
      <figcaption className="ts-chart__head">
        <h3>{title}</h3>
        <p className="ts-chart__value">
          {hovered ? hovered.value.toFixed(decimals) : last ? last.value.toFixed(decimals) : "--"}
          <span>{unit}</span>
          <small>{hovered ? formatMoment(hovered.ts, longRange, true) : "latest"}</small>
        </p>
      </figcaption>

      <div className="ts-chart__frame" ref={frameRef}>
        {!geometry ? (
          <p className="ts-chart__empty">Waiting for readings. The chart fills in as the sensor reports.</p>
        ) : (
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-label={summary}
            tabIndex={0}
            onPointerMove={handlePointer}
            onPointerLeave={() => onHover(null)}
            onKeyDown={handleKey}
            onBlur={() => onHover(null)}
          >
            <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
              {band && (
                <rect
                  className="ts-chart__band"
                  x={0}
                  width={innerW}
                  y={geometry.y(Math.min(band.high, geometry.hi))}
                  height={Math.max(geometry.y(Math.max(band.low, geometry.lo)) - geometry.y(Math.min(band.high, geometry.hi)), 0)}
                />
              )}
              {geometry.ticks.map((t) => (
                <g key={t}>
                  <line className="ts-chart__grid" x1={0} x2={innerW} y1={geometry.y(t)} y2={geometry.y(t)} />
                  <text className="ts-chart__axis" x={-8} y={geometry.y(t)} dy="0.32em" textAnchor="end">{t}</text>
                </g>
              ))}
              {geometry.timeTicks.map((t, i) => (
                <text
                  key={t}
                  className="ts-chart__axis"
                  x={geometry.x(t)}
                  y={innerH + 20}
                  textAnchor={i === 0 ? "start" : i === geometry.timeTicks.length - 1 ? "end" : "middle"}
                >
                  {longRange ? formatDay(t) : formatClock(t)}
                </text>
              ))}

              {annotations.filter(e=>e.action==='changed'&&e.ts>=geometry.t0&&e.ts<=geometry.t1).map(e=><line key={e.id} x1={geometry.x(e.ts)} x2={geometry.x(e.ts)} y1={0} y2={innerH} stroke={e.is_open?'#6ee7df':'#f5b879'} strokeDasharray="4 4"><title>{e.is_open?'Window opened':'Window closed'} · {formatClock(e.ts)} · manual input</title></line>)}
              <path d={geometry.path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              <circle cx={geometry.x(last.ts)} cy={geometry.y(last.value)} r={4} fill={color} className="ts-chart__dot" />

              {hovered && (
                <g pointerEvents="none">
                  <line className="ts-chart__crosshair" x1={geometry.x(hovered.ts)} x2={geometry.x(hovered.ts)} y1={0} y2={innerH} />
                  <circle cx={geometry.x(hovered.ts)} cy={geometry.y(hovered.value)} r={5} fill={color} className="ts-chart__dot" />
                </g>
              )}
              <rect x={0} y={0} width={innerW} height={innerH} fill="transparent" />
            </g>
          </svg>
        )}
      </div>

      {band && (
        <p className="ts-chart__legend">
          <i className="ts-chart__key" style={{ background: color }} /> {title}
          <i className="ts-chart__key ts-chart__key--band" /> {bandLabel} {band.low}–{band.high}{unit}
        </p>
      )}

      {points.length > 0 && (
        <details className="ts-chart__table">
          <summary>Show data table</summary>
          <table>
            <thead><tr><th scope="col">Time</th><th scope="col">{title} ({unit.trim()})</th></tr></thead>
            <tbody>
              {points.slice(-30).reverse().map((p) => (
                <tr key={p.ts}><td>{formatMoment(p.ts, longRange, true)}</td><td>{p.value.toFixed(decimals)}</td></tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </figure>
  );
}
