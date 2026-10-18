// Fetch satellite observations and keep a short cache. Tidak membuat data asap.
import { parse } from "csv-parse/sync";
import { createHash } from "node:crypto";

export type Bounds = [number, number, number, number];
const SOURCES = ["VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT"] as const;
type Source = typeof SOURCES[number];
const DAY = 24 * 60 * 60 * 1000;
const TTL = 15 * 60 * 1000;

export interface HotspotObservation {
  id: string;
  coordinates: [number, number];
  observed_at: string;
  satellite: Source;
  confidence: "low" | "nominal" | "high";
  frp_mw: number | null;
}

export interface HotspotResult {
  observations: HotspotObservation[];
  bounds: Bounds;
  fetched_at: string;
  observed_at: string | null;
  status: "complete" | "partial" | "cached";
  sources: { name: Source; available: boolean }[];
}

export class HotspotError extends Error {
  constructor(public code: string, public status: number) { super(code); }
}

export function parseBounds(value: unknown): Bounds {
  if (typeof value !== "string" || !/^[-\d.,\s]+$/.test(value)) {
    throw new HotspotError("INVALID_BOUNDS", 400);
  }
  const parts = value.split(",");
  const b = parts.map(Number);
  if (b.length !== 4 || parts.some(p => !p.trim()) || b.some(n => !Number.isFinite(n)) ||
      b[0] < -180 || b[2] > 180 || b[1] < -90 || b[3] > 90 || b[0] >= b[2] || b[1] >= b[3]) {
    throw new HotspotError("INVALID_BOUNDS", 400);
  }
  return b as Bounds;
}

// FIRMS dates are UTC. Two calendar days cover the rolling 24-hour window.
export function parseHotspots(csv: string, source: Source, now: number): HotspotObservation[] {
  const required = ["latitude", "longitude", "acq_date", "acq_time", "confidence", "frp"];
  let headers: string[] = [];
  const rows = parse(csv, {
    bom: true, skip_empty_lines: true, trim: true,
    columns: (names: string[]) => { headers = names; return names; },
  }) as Record<string, string>[];
  if (!required.every(h => headers.includes(h))) throw new HotspotError("FIRMS_UNAVAILABLE", 502);
  const unique = new Map<string, HotspotObservation>();
  for (const row of rows) {
    const lat = Number(row.latitude), lon = Number(row.longitude);
    const time = row.acq_time.padStart(4, "0");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.acq_date) || !/^\d{4}$/.test(time)) throw new HotspotError("FIRMS_UNAVAILABLE", 502);
    const observed = Date.parse(`${row.acq_date}T${time.slice(0, 2)}:${time.slice(2)}:00Z`);
    const confidence = ({ l: "low", n: "nominal", h: "high" } as const)[row.confidence as "l" | "n" | "h"];
    if (!row.latitude || !row.longitude || !Number.isFinite(lat) || !Number.isFinite(lon) ||
        Math.abs(lat) > 90 || Math.abs(lon) > 180 || !confidence || !Number.isFinite(observed)) {
      throw new HotspotError("FIRMS_UNAVAILABLE", 502);
    }
    if (new Date(observed).toISOString().slice(0, 10) !== row.acq_date) throw new HotspotError("FIRMS_UNAVAILABLE", 502);
    if (observed < now - DAY || observed > now) continue;
    const frp = row.frp.trim() ? Number(row.frp) : NaN;
    const observed_at = new Date(observed).toISOString();
    const frp_mw = Number.isFinite(frp) && frp >= 0 ? frp : null;
    const record = JSON.stringify(Object.keys(row).sort().map(field => [field, row[field]]));
    const id = `${source}:${createHash("sha256").update(record).digest("hex").slice(0, 24)}`;
    unique.set(id, { id, coordinates: [lat, lon], observed_at, satellite: source, confidence, frp_mw });
  }
  return [...unique.values()];
}

export function createHotspotService(key: () => string, request = fetch, clock = Date.now) {
  const cache = new Map<string, { data: HotspotResult; expires: number }>();
  const pending = new Map<string, Promise<HotspotResult>>();
  const recent = (data: HotspotResult): HotspotResult => {
    const observations = data.observations.filter(p => Date.parse(p.observed_at) >= clock() - DAY);
    return { ...data, observations, observed_at: observations.map(p => p.observed_at).sort().at(-1) ?? null };
  };
  return async (bounds: Bounds): Promise<HotspotResult> => {
    if (!key()) throw new HotspotError("FIRMS_NOT_CONFIGURED", 503);
    const cacheKey = bounds.join(",");
    const saved = cache.get(cacheKey);
    if (saved && saved.expires > clock()) return recent(saved.data);
    if (pending.has(cacheKey)) return pending.get(cacheKey)!;
    const job = (async () => {
      const now = clock();
      const start = new Date(now - DAY).toISOString().slice(0, 10);
      const results = await Promise.allSettled(SOURCES.map(async source => {
        const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key())}/${source}/${cacheKey}/2/${start}`;
        const response = await request(url, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new HotspotError("FIRMS_UNAVAILABLE", 502);
        return parseHotspots(await response.text(), source, now);
      }));
      const available = results.filter(r => r.status === "fulfilled").length;
      if (!available) {
        if (saved && now - Date.parse(saved.data.fetched_at) < DAY) {
          return recent({ ...saved.data, status: "cached" });
        }
        // Never forward upstream errors: FIRMS URLs contain the key.
        throw new HotspotError("FIRMS_UNAVAILABLE", 502);
      }
      const observations = results.flatMap(r => r.status === "fulfilled" ? r.value : [])
        .filter(p => p.coordinates[1] >= bounds[0] && p.coordinates[1] <= bounds[2] &&
          p.coordinates[0] >= bounds[1] && p.coordinates[0] <= bounds[3]);
      const data: HotspotResult = {
        observations, bounds, fetched_at: new Date(now).toISOString(),
        observed_at: observations.map(p => p.observed_at).sort().at(-1) ?? null,
        status: available === SOURCES.length ? "complete" : "partial",
        sources: SOURCES.map((name, i) => ({ name, available: results[i].status === "fulfilled" })),
      };
      if (cache.size >= 64 && !cache.has(cacheKey)) cache.delete(cache.keys().next().value!);
      cache.set(cacheKey, { data, expires: now + (available === SOURCES.length ? TTL : 60000) });
      return data;
    })();
    pending.set(cacheKey, job);
    try { return await job; } finally { pending.delete(cacheKey); }
  };
}
