// Todo:
// -> Sample model rain inside the map viewport.
// -> Keep recent hours, source times, and bounded shared caches.

// --- Rain contract ---
import { type Bounds } from "../hotspots/hotspot.service.js";

export interface RainPoint {
  id: string;
  coordinates: [number, number];
  state: "now" | "recent" | "dry" | "unknown";
  at: string | null;
  last_rain_at: string | null;
  current_mm: number | null;
  current_interval_seconds: number | null;
  recent_mm: number | null;
}
export interface RainResult {
  points: RainPoint[];
  bounds: Bounds;
  fetched_at: string;
  status: "ready" | "cached";
  source: "Open-Meteo";
  basis: "model";
  sample_step_deg: number;
}
export class RainError extends Error {
  constructor(public code: string, public status = 502) { super(code); }
}
const HOUR = 3_600_000, TTL = 15 * 60_000, CURRENT_AGE = 30 * 60_000;
const INDONESIA: Bounds = [94, -12, 142, 8];
type Grid = { bounds: Bounds; step: number; coordinates: [number, number][]; key: string };
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" ? value as RecordValue : {};
const amount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const rounded = (value: number) => Number(value.toFixed(5));
// --- end of Rain contract ---

// --- Viewport samples ---
/** Purpose: Build a stable grid of at most 30 samples, clipped to Indonesia.
 * Input: West, south, east, north in WGS84. Output: Quantized bounds and sample centres.
 */
export function rainGrid(input: Bounds): Grid {
  if (input.length !== 4 || !input.every(Number.isFinite) || input[0] >= input[2] || input[1] >= input[3]) throw new RainError("INVALID_BOUNDS", 400);
  const bounds: Bounds = [Math.max(INDONESIA[0], input[0]), Math.max(INDONESIA[1], input[1]), Math.min(INDONESIA[2], input[2]), Math.min(INDONESIA[3], input[3])];
  if (bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) throw new RainError("INVALID_BOUNDS", 400);
  let step = 0.02;
  const cells = () => [Math.floor(bounds[0] / step), Math.floor(bounds[1] / step), Math.ceil(bounds[2] / step), Math.ceil(bounds[3] / step)];
  while ((cells()[2] - cells()[0]) * (cells()[3] - cells()[1]) > 30) step *= 2;
  const [west, south, east, north] = cells();
  const coverage: Bounds = [rounded(Math.max(INDONESIA[0], west * step)), rounded(Math.max(INDONESIA[1], south * step)), rounded(Math.min(INDONESIA[2], east * step)), rounded(Math.min(INDONESIA[3], north * step))];
  const coordinates: [number, number][] = [];
  for (let y = south; y < north; y++) for (let x = west; x < east; x++) {
    const lat = (Math.max(INDONESIA[1], y * step) + Math.min(INDONESIA[3], (y + 1) * step)) / 2;
    const lng = (Math.max(INDONESIA[0], x * step) + Math.min(INDONESIA[2], (x + 1) * step)) / 2;
    coordinates.push([rounded(lat), rounded(lng)]);
  }
  return { bounds: coverage, step: rounded(step), coordinates, key: `${step}:${west}:${south}:${east}:${north}` };
}
// --- end of Viewport samples ---

// --- Source validation ---
function rainAmount(value: RecordValue, units: RecordValue): number | null {
  return units.precipitation === "mm" && units.rain === "mm" && units.showers === "mm" &&
    amount(value.precipitation) && amount(value.rain) && amount(value.showers) ? rounded(value.rain + value.showers) : null;
}
function parsePoint(input: unknown, coordinates: [number, number], now: number): RainPoint {
  const row = record(input), current = record(row.current), units = record(row.current_units), hourly = record(row.hourly), hourlyUnits = record(row.hourly_units);
  const timestamp = typeof current.time === "number" && Number.isInteger(current.time) && current.time > 0 && current.time * 1000 <= now ? current.time * 1000 : null;
  const interval = typeof current.interval === "number" && current.interval > 0 && current.interval <= 3600 ? current.interval : null;
  const currentMm = timestamp !== null && now - timestamp <= CURRENT_AGE && units.time === "unixtime" && interval !== null ? rainAmount(current, units) : null;
  const hours = new Map<number, number | null>();
  if (hourlyUnits.time === "unixtime" && Array.isArray(hourly.time)) {
    const fields = ["precipitation", "rain", "showers"] as const;
    const aligned = fields.every(field => Array.isArray(hourly[field]) && (hourly[field] as unknown[]).length === (hourly.time as unknown[]).length);
    if (aligned) hourly.time.forEach((time: unknown, index: number) => {
      if (typeof time !== "number" || !Number.isInteger(time) || time % 3600 || time * 1000 > now || time * 1000 <= now - 12 * HOUR) return;
      const values = Object.fromEntries(fields.map(field => [field, (hourly[field] as unknown[])[index]]));
      const at = time * 1000;
      hours.set(at, hours.has(at) ? null : rainAmount(values, hourlyUnits));
    });
  }
  const positive = [...hours].filter((entry): entry is [number, number] => entry[1] !== null && entry[1] > 0);
  const last = positive.reduce<number | null>((latest, [at]) => Math.max(latest ?? at, at), null);
  const fullHour = Math.floor(now / HOUR) * HOUR;
  const complete = Array.from({ length: 12 }, (_, i) => fullHour - i * HOUR).every(at => hours.has(at) && hours.get(at) !== null);
  const recentMm = complete ? rounded([...hours.values()].reduce<number>((total, value) => total + (value ?? 0), 0)) : null;
  return {
    id: coordinates.join(","), coordinates,
    state: currentMm === null ? "unknown" : currentMm > 0 ? "now" : last !== null ? "recent" : complete ? "dry" : "unknown",
    at: timestamp === null ? null : new Date(timestamp).toISOString(),
    last_rain_at: currentMm !== null && currentMm > 0 ? new Date(timestamp!).toISOString() : last === null ? null : new Date(last).toISOString(),
    current_mm: currentMm, current_interval_seconds: interval, recent_mm: recentMm,
  };
}
/** Purpose: Read only current and completed past rain intervals from the model.
 * Input: Provider response and viewport grid. Output: Points with explicit missing-data states.
 */
export function parseRain(input: unknown, grid: Grid, now = Date.now()): RainResult {
  const rows = Array.isArray(input) ? input : [input];
  if (rows.length !== grid.coordinates.length || rows.some(row => !row || typeof row !== "object" || !("current" in row))) throw new RainError("RAIN_UNAVAILABLE");
  return { points: rows.map((row, index) => parsePoint(row, grid.coordinates[index], now)), bounds: grid.bounds,
    fetched_at: new Date(now).toISOString(), status: "ready", source: "Open-Meteo", basis: "model", sample_step_deg: grid.step };
}
function expirePoints(data: RainResult, now: number, stale = false): RainResult {
  return { ...data, status: stale ? "cached" : data.status, points: data.points.map(point => {
    const expired = stale || point.at === null || now - Date.parse(point.at) > CURRENT_AGE || point.last_rain_at !== null && now - Date.parse(point.last_rain_at) >= 12 * HOUR && point.state === "recent";
    return expired ? { ...point, state: "unknown", current_mm: null, recent_mm: null } : point;
  }) };
}
// --- end of Source validation ---

// --- Shared requests ---
/** Purpose: Share bounded viewport requests and label stale fallback explicitly.
 * Input: Fetch and clock adapters. Output: Cached rain reader without synthetic values.
 */
export function createRainService(request = fetch, clock = Date.now) {
  const cache = new Map<string, RainResult>(), pending = new Map<string, Promise<RainResult>>();
  let attempts: number[] = [];
  return async (bounds: Bounds): Promise<RainResult> => {
    const grid = rainGrid(bounds), now = clock(), saved = cache.get(grid.key);
    if (saved && now - Date.parse(saved.fetched_at) < TTL) return expirePoints(saved, now);
    if (pending.has(grid.key)) return pending.get(grid.key)!;
    attempts = attempts.filter(at => at > now - 60_000);
    if (pending.size >= 4 || attempts.length >= 10) throw new RainError("RATE_LIMITED", 429);
    attempts.push(now);
    const job = (async () => {
      try {
        const params = new URLSearchParams({ latitude: grid.coordinates.map(p => p[0]).join(","), longitude: grid.coordinates.map(p => p[1]).join(","),
          current: "precipitation,rain,showers", hourly: "precipitation,rain,showers", past_hours: "12", forecast_hours: "1", timeformat: "unixtime", timezone: "GMT", precipitation_unit: "mm", cell_selection: "nearest" });
        const response = await request(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new RainError("RAIN_UNAVAILABLE");
        const data = parseRain(await response.json(), grid, clock());
        if (cache.size >= 64) cache.delete(cache.keys().next().value!);
        cache.set(grid.key, data);
        return data;
      } catch {
        if (saved && clock() - Date.parse(saved.fetched_at) < HOUR) return expirePoints(saved, clock(), true);
        throw new RainError("RAIN_UNAVAILABLE");
      }
    })();
    pending.set(grid.key, job);
    try { return await job; } finally { pending.delete(grid.key); }
  };
}
// --- end of Shared requests ---
