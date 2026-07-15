"use client";

// Weather via Open-Meteo — free, no API key, CORS-friendly. Location comes
// from the browser once and is cached; forecasts cache for 30 min.

import { useEffect, useState } from "react";

type Wx = { hi: number; lo: number; rainPct: number; code: number };

const CODE_EMOJI: [number, string, string][] = [
  [0, "☀️", "clear"], [1, "🌤️", "mostly clear"], [2, "⛅", "partly cloudy"], [3, "☁️", "overcast"],
  [45, "🌫️", "fog"], [48, "🌫️", "fog"],
  [51, "🌦️", "drizzle"], [53, "🌦️", "drizzle"], [55, "🌦️", "drizzle"],
  [61, "🌧️", "rain"], [63, "🌧️", "rain"], [65, "🌧️", "heavy rain"],
  [71, "🌨️", "snow"], [73, "🌨️", "snow"], [75, "❄️", "heavy snow"],
  [80, "🌧️", "showers"], [81, "🌧️", "showers"], [82, "⛈️", "heavy showers"],
  [95, "⛈️", "thunderstorm"], [96, "⛈️", "thunderstorm"], [99, "⛈️", "thunderstorm"],
];
function describe(code: number): { emoji: string; label: string } {
  let best: [number, string, string] = CODE_EMOJI[0];
  for (const c of CODE_EMOJI) if (code >= c[0]) best = c;
  return { emoji: best[1], label: best[2] };
}

async function getCoords(): Promise<{ lat: number; lon: number } | null> {
  const cached = localStorage.getItem("daily.geo");
  if (cached) { try { return JSON.parse(cached); } catch { /* refetch */ } }
  if (!("geolocation" in navigator)) return null;
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const c = { lat: Math.round(pos.coords.latitude * 100) / 100, lon: Math.round(pos.coords.longitude * 100) / 100 };
        localStorage.setItem("daily.geo", JSON.stringify(c));
        resolve(c);
      },
      () => resolve(null),
      { timeout: 8000, maximumAge: 3600_000 },
    );
  });
}

// dayOffset: 0 = today, 1 = tomorrow
export default function WeatherStrip({ dayOffset }: { dayOffset: 0 | 1 }) {
  const [wx, setWx] = useState<Wx | null | "unavailable">(null);

  useEffect(() => {
    (async () => {
      try {
        const cacheKey = `daily.wx.${dayOffset}`;
        const cached = localStorage.getItem(cacheKey);
        if (cached) {
          const { at, data } = JSON.parse(cached);
          if (Date.now() - at < 30 * 60_000) { setWx(data); return; }
        }
        const c = await getCoords();
        if (!c) { setWx("unavailable"); return; }
        const r = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}` +
          `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code` +
          `&temperature_unit=fahrenheit&forecast_days=${dayOffset + 1}&timezone=auto`,
        );
        if (!r.ok) { setWx("unavailable"); return; }
        const j = await r.json();
        const i = dayOffset;
        const data: Wx = {
          hi: Math.round(j.daily.temperature_2m_max[i]),
          lo: Math.round(j.daily.temperature_2m_min[i]),
          rainPct: j.daily.precipitation_probability_max?.[i] ?? 0,
          code: j.daily.weather_code[i],
        };
        localStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), data }));
        setWx(data);
      } catch {
        setWx("unavailable");
      }
    })();
  }, [dayOffset]);

  if (wx === null || wx === "unavailable") return null; // silent — weather is garnish, never noise
  const d = describe(wx.code);

  return (
    <span className="text-xs opacity-60">
      {d.emoji} {wx.hi}°/{wx.lo}° {d.label}{wx.rainPct >= 30 ? ` · ☔ ${wx.rainPct}%` : ""}
    </span>
  );
}
