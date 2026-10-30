// Todo:
// -> Read the current DWD ICON grid for Indonesia without downloading the globe.
// -> Share bounded refreshes and preserve source times on failures.

// --- Regional weather contract ---
import { LruBlockCache, OmDataType, OmHttpBackend } from "@openmeteo/file-reader";
import type { SnapshotStore } from "../satellite/satellite.store.js";

export const WEATHER_GRID = { west: 80, south: -40, step: 0.125, columns: 641, rows: 641 } as const;
export const WEATHER_FIELDS = ["rain", "wind", "gust", "temperature", "feels_like", "u", "v"] as const;
type Field = typeof WEATHER_FIELDS[number];
export interface WeatherGrid {
  grid: typeof WEATHER_GRID;
  fields: Record<Field, (number | null)[]>;
  valid_at: string;
  run_at: string;
  fetched_at: string;
  checked_at: string;
  status: "ready" | "cached";
  source: string;
  basis: "model";
  resolution_km: number;
  interval_seconds: number;
}
interface Manifest { reference_time: string; valid_times: string[]; variables: string[]; }
export interface WeatherSlice { run_at: string; valid_at: string; }
const ROOT = "https://openmeteo.s3.amazonaws.com/data_spatial/dwd_icon";
const HOUR = 3600_000, REFRESH = 15 * 60_000, RETRY = 60_000;
const VARIABLES = ["rain", "showers", "temperature_2m", "relative_humidity_2m", "wind_u_component_10m", "wind_v_component_10m", "wind_gusts_10m", "direct_radiation", "diffuse_radiation"];
const count = WEATHER_GRID.columns * WEATHER_GRID.rows;
// --- end of Regional weather contract ---

// --- Source selection and values ---
/** Purpose: Select one available current hour, never a future valid time.
 * Input: Published manifests and clock. Output: Latest eligible source run and hour.
 */
export function selectWeatherSlice(manifests: unknown[], now: number): WeatherSlice {
  const slices = manifests.flatMap(value => {
    const manifest = value as Partial<Manifest> | null;
    const run = Date.parse(manifest?.reference_time ?? "");
    if (!Number.isFinite(run) || run > now || now - run > 24 * HOUR ||
        !Array.isArray(manifest?.variables) || !VARIABLES.every(name => manifest.variables!.includes(name)) ||
        !Array.isArray(manifest.valid_times)) return [];
    // Accumulated rain/radiation are not published at the initial run step.
    const valid = manifest.valid_times.map(time => Date.parse(time)).filter(time => Number.isFinite(time) && time > run && time <= now && now - time < 2 * HOUR);
    return valid.length ? [{ run_at: new Date(run).toISOString(), valid_at: new Date(Math.max(...valid)).toISOString() }] : [];
  });
  slices.sort((a, b) => Date.parse(b.valid_at) - Date.parse(a.valid_at) || Date.parse(b.run_at) - Date.parse(a.run_at));
  if (!slices.length) throw new Error("WEATHER_UNAVAILABLE");
  return slices[0];
}

/** Steadman apparent temperature from humidity, 2 m wind and absorbed radiation.
 * Input: Celsius, percent, m/s and W/m². Output: Celsius.
 */
export function apparentTemperature(temperature: number, humidity: number, wind: number, radiation: number): number {
  const vapour = humidity / 100 * 6.105 * Math.exp(17.27 * temperature / (237.7 + temperature));
  const bodyWind = wind * 0.75, absorbed = Math.max(0, 0.1 * (radiation - 550));
  return temperature + 0.348 * vapour - 0.7 * bodyWind + 0.7 * absorbed / (bodyWind + 10) - 4.25;
}
const rounded = (value: number) => Number.isFinite(value) ? Math.round(value * 100) / 100 : null;

function deriveFields(raw: Record<string, Float32Array>): WeatherGrid["fields"] {
  const fields = Object.fromEntries(WEATHER_FIELDS.map(field => [field, new Array<number | null>(count)])) as WeatherGrid["fields"];
  for (let i = 0; i < count; i++) {
    const u = raw.wind_u_component_10m[i], v = raw.wind_v_component_10m[i], speed = Math.hypot(u, v);
    const temperature = raw.temperature_2m[i], humidity = raw.relative_humidity_2m[i];
    fields.rain[i] = rounded(Math.max(0, raw.rain[i] + raw.showers[i]));
    fields.wind[i] = rounded(speed * 3.6);
    fields.gust[i] = rounded(Math.max(0, raw.wind_gusts_10m[i]) * 3.6);
    fields.temperature[i] = rounded(temperature);
    fields.feels_like[i] = rounded(apparentTemperature(temperature, humidity, speed, raw.direct_radiation[i] + raw.diffuse_radiation[i]));
    fields.u[i] = rounded(u); fields.v[i] = rounded(v);
  }
  return fields;
}
// --- end of Source selection and values ---

// --- Native regional reader ---
/** Purpose: Decode only the Indonesian rectangle using bounded HTTP ranges.
 * Input: An advertised current model slice. Output: Seven regional scalar/vector fields.
 */
export async function readWeatherFields(slice: WeatherSlice): Promise<WeatherGrid["fields"]> {
  const run = slice.run_at.slice(0, 13).replace(/-/g, "/").replace("T", "/") + "00Z";
  const time = slice.valid_at.slice(0, 16).replace(":", "");
  const backend = new OmHttpBackend({ url: `${ROOT}/${run}/${time}.om`, timeoutMs: 12_000, retries: 1 });
  const cache = new LruBlockCache(64 * 1024, 128), reader = await backend.asCachedReader(cache);
  const raw: Record<string, Float32Array> = {};
  const signal = AbortSignal.timeout(45_000);
  try {
    for (const name of VARIABLES) {
      const variable = await reader.getChildByName(name);
      if (!variable) throw new Error("WEATHER_UNAVAILABLE");
      try {
        if (variable.getDimensions().join(",") !== "1441,2879") throw new Error("WEATHER_GRID_CHANGED");
        raw[name] = await variable.read({ type: OmDataType.FloatArray,
          ranges: [{ start: 400, end: 1041 }, { start: 2080, end: 2721 }],
          prefetch: true, prefetchConcurrency: 3, ioSizeMerge: 65536n, ioSizeMax: 1048576n, signal });
        if (raw[name].length !== count) throw new Error("WEATHER_GRID_CHANGED");
      } finally { variable.dispose(); }
    }
    return deriveFields(raw);
  } finally { reader.dispose(); await backend.close(); cache.clear(); }
}
// --- end of Native regional reader ---

// --- Shared current cache ---
/** Purpose: Reuse one regional snapshot and retry failed refreshes without a request storm.
 * Input: Optional source readers and clock. Output: Shared current-grid reader.
 */
export function createWeatherService(
  readFields = readWeatherFields,
  request: typeof fetch = fetch,
  clock = Date.now,
  store?: Pick<SnapshotStore, "read" | "write" | "fail">,
) {
  let saved: WeatherGrid | null = null, pending: Promise<WeatherGrid> | null = null, nextCheck = 0;
  const retained = () => {
    if (saved && clock() - Date.parse(saved.valid_at) < 2 * HOUR) return saved;
    throw new Error("WEATHER_UNAVAILABLE");
  };
  return async (): Promise<WeatherGrid> => {
    const now = clock();
    if (now < nextCheck && saved && [saved.valid_at, saved.checked_at].some(time => Math.floor(Date.parse(time) / HOUR) === Math.floor(now / HOUR))) return retained();
    if (now < nextCheck && saved?.status === "cached") return retained();
    if (now < nextCheck && !saved) throw new Error("WEATHER_UNAVAILABLE");
    if (pending) return pending;
    pending = (async () => {
      const checked_at = new Date(now).toISOString();
      try {
        if (!saved && store) {
          const cached = await store.read<WeatherGrid>("weather:icon:current").catch(() => null);
          const data = cached?.data;
          if (data && JSON.stringify(data.grid) === JSON.stringify(WEATHER_GRID) && Date.parse(data.valid_at) <= now && now - Date.parse(data.valid_at) < 2 * HOUR &&
              WEATHER_FIELDS.every(field => data.fields[field]?.length === count)) {
            saved = { ...data, status: cached.failed ? "cached" : data.status };
            if (!cached.failed && Math.floor(Date.parse(data.valid_at) / HOUR) === Math.floor(now / HOUR) && now - Date.parse(cached.checked_at) < REFRESH) {
              nextCheck = Date.parse(cached.checked_at) + REFRESH;
              return saved;
            }
          }
        }
        const manifests = await Promise.allSettled(["latest", "in-progress"].map(async name => {
          const response = await request(`${ROOT}/${name}.json`, { signal: AbortSignal.timeout(12_000) });
          if (!response.ok) throw new Error("WEATHER_UNAVAILABLE");
          return response.json();
        }));
        const slice = selectWeatherSlice(manifests.flatMap(result => result.status === "fulfilled" ? [result.value] : []), now);
        const same = saved?.valid_at === slice.valid_at && saved.run_at === slice.run_at;
        saved = { grid: WEATHER_GRID, fields: same ? saved!.fields : await readFields(slice), ...slice,
          fetched_at: same ? saved!.fetched_at : new Date(clock()).toISOString(), checked_at,
          status: "ready", source: "DWD ICON · Open-Meteo", basis: "model", resolution_km: 14, interval_seconds: 3600 };
        await store?.write("weather:icon:current", saved, checked_at).catch(() => {});
        nextCheck = now + REFRESH;
        return saved;
      } catch {
        nextCheck = now + RETRY;
        if (saved) saved = { ...saved, checked_at, status: "cached" };
        await store?.fail("weather:icon:current", checked_at).catch(() => {});
        return retained();
      } finally { pending = null; }
    })();
    return pending;
  };
}
// --- end of Shared current cache ---
