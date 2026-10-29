// Read bounded, cached place lookups from Photon without exposing a generic upstream proxy.
import { ENV } from "../../config/env.js";
import { sanitizeTextInput } from "../../utils/sanitize.js";
export interface LocationMatch { id: string; name: string; label: string; province: string; city: string; coordinates: [number, number]; }
export class LocationError extends Error {}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => typeof value === "string" ? sanitizeTextInput(value).slice(0, 200) : "";
export function normalizeLocations(payload: unknown): LocationMatch[] {
  if (!record(payload) || !Array.isArray(payload.features)) throw new LocationError("LOCATION_UNAVAILABLE");
  const seen = new Set<string>();
  return payload.features.flatMap((feature): LocationMatch[] => {
    if (!record(feature) || !record(feature.properties) || !record(feature.geometry)) return [];
    const p = feature.properties, point = feature.geometry.coordinates;
    if (text(p.countrycode).toUpperCase() !== "ID" || !Array.isArray(point) || point.length !== 2 || !point.every(n => typeof n === "number" && Number.isFinite(n)) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) return [];
    const name = text(p.name) || text(p.street) || text(p.city) || text(p.county);
    const province = text(p.state).slice(0, 100), city = (text(p.city) || text(p.county) || text(p.district)).slice(0, 100);
    const id = `${text(p.osm_type)}:${String(p.osm_id ?? point.join(","))}`;
    if (!name || seen.has(id)) return [];
    seen.add(id);
    return [{ id, name, province, city,
      label: [...new Set([name, text(p.district), city, province].filter(Boolean))].join(", "), coordinates: [point[0], point[1]] }];
  }).slice(0, 6);
}
export function createLocationService(options: { fetcher?: typeof fetch; baseUrl?: string; interval?: number } = {}) {
  const fetcher = options.fetcher ?? fetch;
  const base = (options.baseUrl ?? ENV.PHOTON_BASE_URL).replace(/\/$/, "");
  const cache = new Map<string, { expires: number; items: LocationMatch[] }>();
  const pending = new Map<string, Promise<LocationMatch[]>>();
  let nextStart = 0;
  async function lookup(path: string, params: URLSearchParams) {
    const key = path + "?" + params;
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.items;
    const current = pending.get(key); if (current) return current;
    const delay = Math.max(0, nextStart - Date.now());
    if (pending.size >= 6 || delay > 3500) throw new LocationError("LOCATION_BUSY");
    nextStart = Date.now() + delay + (options.interval ?? 700);
    const task = Promise.resolve().then(async () => {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      try {
        const response = await fetcher(`${base}/${path}?${params}`, { headers: { Accept: "application/json", "User-Agent": "BuktiPulih/1.0 (+https://buktipulih.id)" }, signal: AbortSignal.timeout(6500), redirect: "error" });
        if (!response.ok) throw new LocationError("LOCATION_UNAVAILABLE");
        const items = normalizeLocations(await response.json());
        cache.delete(key); cache.set(key, { expires: Date.now() + 10 * 60_000, items });
        if (cache.size > 256) cache.delete(cache.keys().next().value!);
        return items;
      } catch { throw new LocationError("LOCATION_UNAVAILABLE"); }
      finally { pending.delete(key); }
    });
    pending.set(key, task); return task;
  }
  return {
    search: (query: string) => lookup("api/", new URLSearchParams({ q: query.trim().replace(/\s+/g, " "), countrycode: "ID", limit: "6" })),
    reverse: (point: [number, number]) => lookup("reverse", new URLSearchParams({ lon: point[0].toFixed(5), lat: point[1].toFixed(5), limit: "1", radius: "1" })),
  };
}
export type LocationService = ReturnType<typeof createLocationService>;
