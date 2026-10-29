// Outdoor weather (Open-Meteo, free, no key) for wherever the viewer is, and
// the "should I open the window?" advice that compares it with the room.
// Everything runs in the browser: the backend never learns your location.

const FORECAST = "https://api.open-meteo.com/v1/forecast";
const GEOCODE = "https://geocoding-api.open-meteo.com/v1/search";
// Free client-side reverse geocoding, allowed for the device's own position.
const REVERSE = "https://api.bigdatacloud.net/data/reverse-geocode-client";
// Rough position from the internet connection, when the browser won't give one.
const IP_GEO = "https://get.geojs.io/v1/ip/geo.json";

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchOutdoor({ lat, lon }) {
  const params = new URLSearchParams({
    latitude: lat.toFixed(3),
    longitude: lon.toFixed(3),
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,is_day",
    timezone: "auto",
  });
  const json = await getJson(`${FORECAST}?${params}`);
  const c = json.current;
  return {
    temperature: c.temperature_2m,
    humidity: c.relative_humidity_2m,
    feelsLike: c.apparent_temperature,
    precipitation: c.precipitation,
    code: c.weather_code,
    wind: c.wind_speed_10m,
    isDay: c.is_day === 1,
    time: c.time,
  };
}

export async function placeName({ lat, lon }) {
  const params = new URLSearchParams({ latitude: lat, longitude: lon, localityLanguage: "en" });
  const json = await getJson(`${REVERSE}?${params}`);
  return json.locality || json.city || json.principalSubdivision || json.countryName || null;
}

/** City-level position from the public IP address: no permission needed, roughly the right town. */
export async function ipLocation() {
  const json = await getJson(IP_GEO);
  const lat = Number(json.latitude), lon = Number(json.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("no position");
  return { lat, lon, name: json.city || json.region || json.country || "Your area", source: "ip" };
}

export async function searchPlaces(query) {
  const params = new URLSearchParams({ name: query, count: "5", language: "en", format: "json" });
  const json = await getJson(`${GEOCODE}?${params}`);
  return (json.results || []).map((r) => ({
    name: r.name,
    detail: [r.admin1, r.country].filter(Boolean).join(", "),
    lat: r.latitude,
    lon: r.longitude,
  }));
}

// WMO weather codes, grouped
const CODES = [
  [[0], "Clear"], [[1], "Mostly clear"], [[2], "Partly cloudy"], [[3], "Overcast"],
  [[45, 48], "Fog"], [[51, 53, 55, 56, 57], "Drizzle"], [[61, 63, 65, 66, 67], "Rain"],
  [[71, 73, 75, 77, 85, 86], "Snow"], [[80, 81, 82], "Showers"], [[95, 96, 99], "Thunderstorm"],
];

export function describeCode(code) {
  return CODES.find(([codes]) => codes.includes(code))?.[1] ?? "—";
}

const WET = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99]);

/** Water vapour in the air, g/m³ (Magnus formula). Compares damp air across temperatures. */
export function absoluteHumidity(tempC, rh) {
  const saturation = 6.112 * Math.exp((17.67 * tempC) / (tempC + 243.5));
  return (saturation * rh * 2.1674) / (273.15 + tempC);
}

/**
 * tone: "open" (airing helps), "closed" (keep it shut) or "neutral".
 * Humidity is compared as absolute humidity: 90% at 8°C outside can still be
 * much drier than 65% at 24°C inside.
 */
function baseWindowAdvice(inside, outside, t) {
  if (inside?.temperature == null || inside?.humidity == null || !outside) return null;
  const inT = inside.temperature, inH = inside.humidity;
  const outT = outside.temperature, outH = outside.humidity;
  const inAH = absoluteHumidity(inT, inH), outAH = absoluteHumidity(outT, outH);
  const cold = outT < inT - 8;
  const brief = cold ? " Keep it short (5–10 minutes): it's much colder outside." : "";

  if (WET.has(outside.code) || outside.precipitation > 0.2) {
    const kind = describeCode(outside.code);
    const why = kind === "Thunderstorm" ? "There's a thunderstorm outside."
      : kind === "Snow" ? "It's snowing outside." : "It's raining outside.";
    return { tone: "closed", title: "Keep the window closed", why };
  }
  if (outT < 0) {
    return { tone: "closed", title: "Keep the window closed", why: "It's below freezing outside." };
  }
  if (inH > t.HUMIDITY_HIGH) {
    if (outAH < inAH - 1) {
      return {
        tone: "open", title: "Open the window",
        why: `The air outside holds ${(inAH - outAH).toFixed(1)} g/m³ less water than the room, so airing brings humidity down.${brief}`,
      };
    }
    return {
      tone: "closed", title: "Airing won't help",
      why: "The air outside is just as damp as the room. A dehumidifier is the way to dry it.",
    };
  }
  if (inT > t.TEMP_HIGH) {
    return outT < inT - 1.5
      ? { tone: "open", title: "Open the window", why: `It's ${(inT - outT).toFixed(1)}° cooler outside.` }
      : { tone: "closed", title: "Keep the window closed", why: "It's as warm or warmer outside." };
  }
  if (inT < t.TEMP_LOW && outT < inT) {
    return { tone: "closed", title: "Keep the window closed", why: "The room is cold and it's colder outside." };
  }
  if (inH < t.HUMIDITY_LOW) {
    return outAH > inAH + 1
      ? { tone: "open", title: "Open the window", why: "The air outside is more humid and will make the room less dry." }
      : { tone: "closed", title: "Keep the window closed", why: "The air outside is dry too." };
  }
  return { tone: "neutral", title: "Temperature / humidity within limits", why: "These measurements do not determine ventilation needs: CO₂ is not measured." };
}


export function windowAdvice(inside, outside, thresholds, manual=null) {
  const advice=baseWindowAdvice(inside,outside,thresholds);
  // an unconfirmed window is asked about once, in the room card; here just give the outdoor advice
  if(manual?.needs_confirmation) return advice;
  if(manual?.state==='open') return {
    tone:advice?.tone==='closed'?'closed':'neutral',
    title:advice?.tone==='closed'?'Window open · check outdoor conditions':'Window is already open',
    why:advice?.tone==='closed'?advice.why:'Manual input. Monitor the room trend; CO₂ and the actual window position are not measured.'};
  return advice;
}
