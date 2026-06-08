/**
 * Weather API
 * GET /api/weather
 * Uses Open-Meteo (free, no API key)
 *
 * Config:
 * - WEATHER_CITY (optional display/geocoding label)
 * - WEATHER_LAT and WEATHER_LON (optional explicit coordinates)
 * - WEATHER_TZ (optional IANA timezone; defaults to Open-Meteo auto)
 * - NEXT_PUBLIC_AGENT_LOCATION (fallback geocoding label)
 */
import { NextResponse } from 'next/server';

// Cache weather data for 10 minutes
let cache: { data: unknown; ts: number } | null = null;
const CACHE_DURATION = 10 * 60 * 1000;

const WMO_CODES: Record<number, { label: string; emoji: string }> = {
  0: { label: "Clear sky", emoji: "☀️" },
  1: { label: "Mainly clear", emoji: "🌤️" },
  2: { label: "Partly cloudy", emoji: "⛅" },
  3: { label: "Overcast", emoji: "☁️" },
  45: { label: "Foggy", emoji: "🌫️" },
  48: { label: "Icy fog", emoji: "🌫️" },
  51: { label: "Light drizzle", emoji: "🌦️" },
  53: { label: "Drizzle", emoji: "🌦️" },
  55: { label: "Heavy drizzle", emoji: "🌧️" },
  61: { label: "Light rain", emoji: "🌧️" },
  63: { label: "Rain", emoji: "🌧️" },
  65: { label: "Heavy rain", emoji: "🌧️" },
  71: { label: "Light snow", emoji: "🌨️" },
  73: { label: "Snow", emoji: "❄️" },
  75: { label: "Heavy snow", emoji: "❄️" },
  80: { label: "Light showers", emoji: "🌦️" },
  81: { label: "Showers", emoji: "🌧️" },
  82: { label: "Heavy showers", emoji: "⛈️" },
  95: { label: "Thunderstorm", emoji: "⛈️" },
  96: { label: "Thunderstorm with hail", emoji: "⛈️" },
  99: { label: "Thunderstorm with heavy hail", emoji: "⛈️" },
};

interface WeatherLocation {
  city: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

interface GeocodingResult {
  name: string;
  latitude: number;
  longitude: number;
  timezone?: string;
  country_code?: string;
}

function envValue(name: string) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

async function resolveWeatherLocation(): Promise<WeatherLocation> {
  const city = envValue("WEATHER_CITY");
  const latitude = Number.parseFloat(envValue("WEATHER_LAT") || "");
  const longitude = Number.parseFloat(envValue("WEATHER_LON") || "");
  const timezone = envValue("WEATHER_TZ");

  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    return {
      city: city || envValue("NEXT_PUBLIC_AGENT_LOCATION") || `${latitude}, ${longitude}`,
      latitude,
      longitude,
      timezone: timezone || "auto",
    };
  }

  if (envValue("WEATHER_LAT") || envValue("WEATHER_LON")) {
    throw new Error("Invalid weather location config (WEATHER_LAT/WEATHER_LON)");
  }

  const locationName = city || envValue("NEXT_PUBLIC_AGENT_LOCATION");

  if (!locationName) {
    throw new Error("Weather location is not configured");
  }

  const params = new URLSearchParams({
    name: locationName,
    count: "1",
    language: "en",
    format: "json",
  });

  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params.toString()}`, {
    next: { revalidate: 24 * 60 * 60 },
  });

  if (!res.ok) {
    throw new Error(`Weather location lookup failed (${res.status})`);
  }

  const json = (await res.json()) as { results?: GeocodingResult[] };
  const match = json.results?.[0];

  if (!match || !Number.isFinite(match.latitude) || !Number.isFinite(match.longitude)) {
    throw new Error(`Weather location not found: ${locationName}`);
  }

  return {
    city: city || [match.name, match.country_code].filter(Boolean).join(", "),
    latitude: match.latitude,
    longitude: match.longitude,
    timezone: timezone || match.timezone || "auto",
  };
}

export async function GET() {
  // Return cache if valid
  if (cache && Date.now() - cache.ts < CACHE_DURATION) {
    return NextResponse.json(cache.data);
  }

  try {
    const location = await resolveWeatherLocation();
    const params = new URLSearchParams({
      latitude: String(location.latitude),
      longitude: String(location.longitude),
      current: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,precipitation",
      daily: "temperature_2m_max,temperature_2m_min,weather_code",
      timezone: location.timezone,
      forecast_days: "3",
    });

    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`, { next: { revalidate: 600 } });
    if (!res.ok) {
      throw new Error(`Weather forecast lookup failed (${res.status})`);
    }

    const json = await res.json();

    const current = json.current;
    const daily = json.daily;

    const wmo = WMO_CODES[current.weather_code] || { label: "Unknown", emoji: "🌡️" };

    const data = {
      city: location.city,
      temp: Math.round(current.temperature_2m),
      feels_like: Math.round(current.apparent_temperature),
      humidity: current.relative_humidity_2m,
      wind: Math.round(current.wind_speed_10m),
      precipitation: current.precipitation,
      condition: wmo.label,
      emoji: wmo.emoji,
      forecast: daily.time.slice(0, 3).map((day: string, i: number) => ({
        day,
        max: Math.round(daily.temperature_2m_max[i]),
        min: Math.round(daily.temperature_2m_min[i]),
        emoji: (WMO_CODES[daily.weather_code[i]] || { emoji: "🌡️" }).emoji,
      })),
      updated: new Date().toISOString(),
    };

    cache = { data, ts: Date.now() };
    return NextResponse.json(data);
  } catch (error) {
    console.error('[weather] Error:', error);
    return NextResponse.json({ error: 'Failed to fetch weather' }, { status: 500 });
  }
}
