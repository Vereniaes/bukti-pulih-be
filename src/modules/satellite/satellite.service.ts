// Refresh satellite sources on schedule and serve durable map snapshots.
import { randomUUID } from "node:crypto";
import { ENV } from "../../config/env.js";
import { createHotspotService, HotspotError, type Bounds, type HotspotHours, type HotspotResult } from "../hotspots/hotspot.service.js";
import { createWindService, type WindResult } from "../wind/wind.service.js";
import { createIspuService, type IspuResult, type IspuDetail, type IspuStation } from "../ispu/ispu.service.js";
import { mongoSnapshotStore, type SnapshotStore, type Snapshot } from "./satellite.store.js";

export const SATELLITE_INTERVAL_MS = 15 * 60_000;
export const SATELLITE_BOUNDS: Bounds = [94, -12, 142, 8];
const HOUR = 3_600_000, DAY = 24 * HOUR;
type Feed = "fire" | "air" | "wind";
interface Providers {
  fire: (bounds: Bounds, hours: HotspotHours) => Promise<HotspotResult>;
  wind: () => Promise<WindResult>;
  air: () => Promise<IspuResult>;
  detail: (id: string, station: IspuStation) => Promise<IspuDetail>;
}
function inside(bounds: Bounds, coverage: Bounds) {
  return bounds[0] >= coverage[0] && bounds[1] >= coverage[1] && bounds[2] <= coverage[2] && bounds[3] <= coverage[3];
}
function usable<T>(snapshot: Snapshot<T> | null, now: number, maxAge: number): snapshot is Snapshot<T> & { data: T; fetched_at: string } {
  return !!snapshot?.data && !!snapshot.fetched_at && now - Date.parse(snapshot.fetched_at) <= maxAge;
}
function stale(snapshot: Snapshot<unknown>, now: number) {
  return snapshot.failed || now - Date.parse(snapshot.checked_at) > SATELLITE_INTERVAL_MS * 2;
}
function mergeFire(current: HotspotResult, previous: HotspotResult | null, now: number): HotspotResult {
  if (current.status !== "partial" || !previous) return current;
  const missing = new Set(current.sources.filter(source => !source.available).map(source => source.name));
  const retained = previous.observations.filter(point => missing.has(point.satellite) && Date.parse(point.observed_at) >= now - 72 * HOUR);
  const observations = [...new Map([...retained, ...current.observations].map(point => [point.id, point])).values()];
  return { ...current, observations, observed_at: observations.map(point => point.observed_at).sort().at(-1) ?? null };
}

export function createSatelliteService(store: SnapshotStore, providers: Providers, clock = Date.now) {
  const sync = async (slot = String(Math.floor(clock() / SATELLITE_INTERVAL_MS))) => {
    const started = clock(), owner = randomUUID(), checkedAt = new Date(started).toISOString();
    if (!await store.claim(slot, owner, new Date(started))) return { skipped: true, failed: false, checked_at: checkedAt };
    try {
      const readers = { fire: () => providers.fire(SATELLITE_BOUNDS, 72), air: providers.air, wind: providers.wind };
      const results = await Promise.all((Object.keys(readers) as Feed[]).map(async key => {
        try {
          const value = await readers[key]();
          if (value.status === "cached") throw new Error("UPSTREAM_UNAVAILABLE");
          if (key === "fire") {
            const saved = value.status === "partial" ? await store.read<HotspotResult>("fire").catch(() => null) : null;
            await store.write(key, mergeFire(value as HotspotResult, saved?.data ?? null, started), checkedAt);
          } else await store.write(key, value, checkedAt);
          return [key, value.status === "partial" ? "partial" : "ready"] as const;
        } catch {
          await store.fail(key, checkedAt);
          return [key, "unavailable"] as const;
        }
      }));
      const sources = Object.fromEntries(results);
      return { skipped: false, failed: results.some(([, status]) => status !== "ready"), checked_at: checkedAt, sources };
    } finally { await store.release(owner); }
  };
  const hotspots = async (bounds: Bounds, hours: HotspotHours = 24): Promise<HotspotResult> => {
    if (!inside(bounds, SATELLITE_BOUNDS)) throw new HotspotError("INVALID_BOUNDS", 400);
    const saved = await store.read<HotspotResult>("fire"), now = clock();
    if (!usable(saved, now, DAY)) throw new HotspotError("FIRMS_UNAVAILABLE", 503);
    const observations = saved.data.observations.filter(point => {
      const [lat, lng] = point.coordinates, time = Date.parse(point.observed_at);
      return time >= now - hours * HOUR && time <= now && lng >= bounds[0] && lng <= bounds[2] && lat >= bounds[1] && lat <= bounds[3];
    });
    return { ...saved.data, observations, bounds, observed_at: observations.map(point => point.observed_at).sort().at(-1) ?? null,
      status: stale(saved, now) ? "cached" : saved.data.status };
  };
  const wind = async (): Promise<WindResult> => {
    const saved = await store.read<WindResult>("wind"), now = clock();
    if (!usable(saved, now, HOUR)) throw new Error("WIND_UNAVAILABLE");
    return { ...saved.data, status: stale(saved, now) ? "cached" : saved.data.status };
  };
  const air = async (): Promise<IspuResult> => {
    const saved = await store.read<IspuResult>("air"), now = clock();
    if (!usable(saved, now, HOUR)) throw new Error("ISPU_UNAVAILABLE");
    return { ...saved.data, status: stale(saved, now) ? "cached" : saved.data.status };
  };
  const pendingDetails = new Map<string, Promise<IspuDetail>>();
  const detail = async (id: string): Promise<IspuDetail> => {
    if (!/^[-A-Za-z0-9_]{1,120}$/.test(id)) throw new Error("ISPU_UNAVAILABLE");
    const list = await air(), station = list.stations.find(item => item.id === id);
    if (!station) throw new Error("ISPU_UNAVAILABLE");
    const key = "ispu-detail:" + id, now = clock(), saved = await store.read<IspuDetail>(key);
    if (usable(saved, now, SATELLITE_INTERVAL_MS) && !saved.failed) return saved.data;
    if (pendingDetails.has(id)) return pendingDetails.get(id)!;
    const job = (async () => {
      try {
        const value = await providers.detail(id, station);
        if (value.status === "cached") throw new Error("UPSTREAM_UNAVAILABLE");
        await store.write(key, value, new Date(now).toISOString());
        return value;
      } catch {
        await store.fail(key, new Date(now).toISOString());
        if (usable(saved, now, HOUR)) return { ...saved.data, status: "cached" as const };
        throw new Error("ISPU_UNAVAILABLE");
      }
    })();
    pendingDetails.set(id, job);
    try { return await job; } finally { pendingDetails.delete(id); }
  };
  const status = async () => {
    const now = clock();
    const entries = await Promise.all((["fire", "air", "wind"] as Feed[]).map(async key => {
      const saved = await store.read<{ status: string }>(key);
      return [key, { status: !usable(saved, now, key === "fire" ? DAY : HOUR) ? "unavailable" :
        stale(saved!, now) ? "cached" : saved!.data!.status, checked_at: saved?.checked_at ?? null, fetched_at: saved?.fetched_at ?? null }];
    }));
    return { contract: "satellite-sync-v1", refresh_seconds: SATELLITE_INTERVAL_MS / 1000, sources: Object.fromEntries(entries) };
  };
  return { sync, hotspots, wind, air, detail, status };
}

const ispu = createIspuService(() => ENV.ISPU_AUTHORIZATION);
export const satelliteService = createSatelliteService(mongoSnapshotStore, {
  fire: (bounds, hours) => createHotspotService(() => ENV.FIRMS_MAP_KEY, fetch, Date.now, 30000)(bounds, hours),
  wind: () => createWindService()(),
  air: () => createIspuService(() => ENV.ISPU_AUTHORIZATION).stations(),
  detail: (id, station) => ispu.detail(id, station),
});

