import type { AirForecastCache, HazardFeature } from "./hazard.types.js";

const BNPB_URL = "https://gis.bnpb.go.id/server/rest/services/Kejadian_Bencana_Mingguan/MapServer/25/query";
const CAMS_META_URL = "https://air-quality-api.open-meteo.com/data/cams_global/static/meta.json";
const CAMS_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";
const WEEK = 7 * 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const PAGE_SIZE = 1000;
const MAX_RECORDS = 10000;

export class HazardSourceError extends Error {
  constructor(public readonly code: "BNPB_UNAVAILABLE" | "CAMS_UNAVAILABLE") { super(code); }
}

function unavailable(code: HazardSourceError["code"]): never { throw new HazardSourceError(code); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBnpbDate(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))?$/.test(value)) {
    const parsed = Date.parse(value);
    const date = value.slice(0, 10);
    const [year, month, day] = date.split("-").map(Number);
    const calendarDate = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
    if (Number.isFinite(parsed) && calendarDate === date) return parsed;
  }
  return unavailable("BNPB_UNAVAILABLE");
}

function finitePoint(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2 || typeof value[0] !== "number" || typeof value[1] !== "number") return null;
  const [lng, lat] = value;
  return Number.isFinite(lng) && Number.isFinite(lat) && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90 ? [lng, lat] : null;
}
function validRing(value: unknown): [number, number][] | null {
  if (!Array.isArray(value) || value.length < 4) return null;
  const positions = value.map(finitePoint);
  if (positions.some(point => !point)) return null;
  const ring = positions as [number, number][];
  const first = ring[0], last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1] ? ring : null;
}
function normalizeGeometry(value: unknown): HazardFeature["geometry"] | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  if (value.type === "Point") {
    const coordinates = finitePoint(value.coordinates);
    return coordinates ? { type: "Point", coordinates } : null;
  }
  if (value.type === "Polygon") {
    if (!Array.isArray(value.coordinates) || !value.coordinates.length) return null;
    const rings = value.coordinates.map(validRing);
    return rings.every((ring): ring is [number, number][] => ring !== null) ? { type: "Polygon", coordinates: rings } : null;
  }
  if (value.type === "MultiPolygon") {
    if (!Array.isArray(value.coordinates) || !value.coordinates.length) return null;
    const polygons = value.coordinates.map(polygon => {
      if (!Array.isArray(polygon) || !polygon.length) return null;
      const rings = polygon.map(validRing);
      return rings.every((ring): ring is [number, number][] => ring !== null) ? rings : null;
    });
    return polygons.every((polygon): polygon is [number, number][][] => polygon !== null)
      ? { type: "MultiPolygon", coordinates: polygons } : null;
  }
  return null;
}

export function normalizeBnpbGeoJson(input: unknown, now: number): { fire: HazardFeature[]; flood: HazardFeature[] } {
  if (!isRecord(input) || input.type !== "FeatureCollection" || !Array.isArray(input.features) || !Number.isFinite(now)) {
    return unavailable("BNPB_UNAVAILABLE");
  }
  const fire = new Map<string, HazardFeature>();
  const flood = new Map<string, HazardFeature>();
  for (const item of input.features) {
    if (!isRecord(item) || !isRecord(item.properties)) return unavailable("BNPB_UNAVAILABLE");
    const props = item.properties;
    const category = props.kategori_bencana;
    const kind = category === "Banjir" ? "flood" : category === "Kebakaran hutan dan lahan" ? "fire" : null;
    if (!kind) continue;
    const observed = parseBnpbDate(props.dt);
    if (observed < now - WEEK || observed > now) continue;
    if (typeof props.id !== "string" || !props.id.trim() || typeof props.kabupaten !== "string" || !props.kabupaten.trim() ||
        typeof props.jumlah_kejadian !== "number" || !Number.isFinite(props.jumlah_kejadian) || props.jumlah_kejadian < 0) {
      return unavailable("BNPB_UNAVAILABLE");
    }
    const geometry = normalizeGeometry(item.geometry);
    if (!geometry) return unavailable("BNPB_UNAVAILABLE");
    const id = `${kind}:bnpb:${props.id}`;
    const collection = kind === "fire" ? fire : flood;
    if (collection.has(id)) continue;
    const label = kind === "fire" ? "Karhutla" : "Banjir";
    collection.set(id, {
      type: "Feature", id, geometry,
      properties: {
        label: `${label} · ${props.kabupaten.trim()}`,
        observed_at: new Date(observed).toISOString(), plot_ids: [],
        detail: `Wilayah laporan BNPB · ${props.jumlah_kejadian} kejadian`,
      },
    });
  }
  return { fire: [...fire.values()], flood: [...flood.values()] };
}

export async function fetchBnpbLayers(request: typeof fetch = fetch, now = Date.now()): Promise<{ fire: HazardFeature[]; flood: HazardFeature[] }> {
  try {
    const allFeatures: unknown[] = [];
    const seenIds = new Set<string>();
    let offset = 0;
    while (true) {
      if (offset >= MAX_RECORDS) return unavailable("BNPB_UNAVAILABLE");
      const start = new Date(now - WEEK).toISOString().replace(/\.\d{3}Z$/, "Z").replace("T", " ").replace(/Z$/, "");
      const params = new URLSearchParams({
        f: "geojson", outSR: "4326", returnZ: "false", returnM: "false", geometryPrecision: "5",
        where: `dt>=TIMESTAMP '${start}' AND kategori_bencana IN ('Banjir','Kebakaran hutan dan lahan')`,
        outFields: "id,dt,kabupaten,kategori_bencana,jumlah_kejadian", resultRecordCount: String(PAGE_SIZE),
        resultOffset: String(offset), orderByFields: "id",
      });
      const response = await request(`${BNPB_URL}?${params}`, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) return unavailable("BNPB_UNAVAILABLE");
      const page: unknown = await response.json();
      if (!isRecord(page) || !Array.isArray(page.features) || page.exceededTransferLimit === true && page.features.length === 0) {
        return unavailable("BNPB_UNAVAILABLE");
      }
      if (page.features.length > PAGE_SIZE || offset + page.features.length > MAX_RECORDS) return unavailable("BNPB_UNAVAILABLE");
      let advanced = false;
      for (const feature of page.features) {
        if (!isRecord(feature) || !isRecord(feature.properties) || typeof feature.properties.id !== "string") return unavailable("BNPB_UNAVAILABLE");
        if (!seenIds.has(feature.properties.id)) advanced = true;
        seenIds.add(feature.properties.id);
      }
      if (page.features.length && !advanced) return unavailable("BNPB_UNAVAILABLE");
      allFeatures.push(...page.features);
      const hasMore = page.exceededTransferLimit === true || page.features.length === PAGE_SIZE;
      offset += page.features.length;
      if (!hasMore) break;
    }
    return normalizeBnpbGeoJson({ type: "FeatureCollection", features: allFeatures }, now);
  } catch {
    return unavailable("BNPB_UNAVAILABLE");
  }
}

export const AIR_GRID: [number, number][] = Array.from({ length: 11 }, (_, y) =>
  Array.from({ length: 25 }, (_, x) => [94 + x * 2, -12 + y * 2] as [number, number]),
).flat();

interface CamsMetadata { last_run_initialisation_time: unknown; last_run_availability_time: unknown; }
type Request = typeof fetch;
function parseRun(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 && value < 100_000_000_000 ? value * 1000 : null;
  }
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function cacheIsUsable(cache: AirForecastCache, now: number): boolean {
  try { selectCamsFeatures(cache, now); return true; } catch { return false; }
}
function validateCache(cache: AirForecastCache): void {
  if (!isRecord(cache) || !Number.isFinite(cache.run) || typeof cache.fetched_at !== "string" || !Number.isFinite(Date.parse(cache.fetched_at)) || !Array.isArray(cache.samples)) unavailable("CAMS_UNAVAILABLE");
  const byCoord = new Map<string, AirForecastCache["samples"][number]>();
  for (const sample of cache.samples) {
    if (!Array.isArray(sample.coordinates) || sample.coordinates.length !== 2 || sample.coordinates.some(n => typeof n !== "number" || !Number.isFinite(n)) ||
        !Array.isArray(sample.times) || !sample.times.length || !Array.isArray(sample.aqi) || !Array.isArray(sample.pm25) || sample.times.length !== sample.aqi.length || sample.times.length !== sample.pm25.length ||
        sample.times.some((time, i) => !Number.isInteger(time) || time <= 0 || i > 0 && time <= sample.times[i - 1]) ||
        sample.aqi.some(n => n !== null && (typeof n !== "number" || !Number.isFinite(n) || n < 0)) ||
        sample.pm25.some(n => n !== null && (typeof n !== "number" || !Number.isFinite(n) || n < 0))) unavailable("CAMS_UNAVAILABLE");
    byCoord.set(`${sample.coordinates[0]},${sample.coordinates[1]}`, sample);
  }
  if (byCoord.size !== AIR_GRID.length || AIR_GRID.some(([lng, lat]) => !byCoord.has(`${lng},${lat}`))) unavailable("CAMS_UNAVAILABLE");
}

export function selectCamsFeatures(cache: AirForecastCache, now: number): HazardFeature[] {
  validateCache(cache);
  const hour = Math.floor(now / HOUR) * HOUR / 1000;
  const features: HazardFeature[] = [];
  for (const sample of cache.samples) {
    const index = sample.times.indexOf(hour);
    if (index < 0) continue;
    const aqi = sample.aqi[index], pm25 = sample.pm25[index];
    if (aqi === null || pm25 === null) continue;
    const [lng, lat] = sample.coordinates;
    features.push({
      type: "Feature", id: `air:${lng}:${lat}`, geometry: { type: "Point", coordinates: [lng, lat] },
      properties: {
        label: "CAMS · Perkiraan udara", observed_at: new Date(hour * 1000).toISOString(), plot_ids: [], aqi, pm25,
        detail: "Perkiraan model CAMS · interpolasi antar titik grid",
      },
    });
  }
  if (!features.length) return unavailable("CAMS_UNAVAILABLE");
  return features;
}

async function fetchCamsBatch(coordinates: [number, number][], request: Request): Promise<AirForecastCache["samples"]> {
  const params = new URLSearchParams({
    latitude: coordinates.map(([, lat]) => String(lat)).join(","),
    longitude: coordinates.map(([lng]) => String(lng)).join(","),
    hourly: "pm2_5,us_aqi", domains: "cams_global", forecast_days: "3", timeformat: "unixtime",
  });
  const response = await request(`${CAMS_URL}?${params}`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) return unavailable("CAMS_UNAVAILABLE");
  const payload: unknown = await response.json();
  const locations = Array.isArray(payload) ? payload : [payload];
  if (locations.length !== coordinates.length) return unavailable("CAMS_UNAVAILABLE");
  const result: AirForecastCache["samples"] = [];
  const used = new Set<number>();
  for (const location of locations) {
    if (!isRecord(location) || typeof location.latitude !== "number" || typeof location.longitude !== "number" || !isRecord(location.hourly)) return unavailable("CAMS_UNAVAILABLE");
    const index = coordinates.findIndex(([lng, lat], i) => !used.has(i) && Math.abs(lng - (location.longitude as number)) <= 0.5 && Math.abs(lat - (location.latitude as number)) <= 0.5);
    if (index < 0) return unavailable("CAMS_UNAVAILABLE");
    used.add(index);
    if (location.hourly_units !== undefined) {
      const units = location.hourly_units;
      if (!isRecord(units) || units.time !== "unixtime" || units.us_aqi !== "USAQI" ||
          (units.pm2_5 !== "μg/m³" && units.pm2_5 !== "µg/m³")) return unavailable("CAMS_UNAVAILABLE");
    }
    const hourly = location.hourly;
    if (!Array.isArray(hourly.time) || !Array.isArray(hourly.us_aqi) || !Array.isArray(hourly.pm2_5) || !hourly.time.length || hourly.time.length !== hourly.us_aqi.length || hourly.time.length !== hourly.pm2_5.length) return unavailable("CAMS_UNAVAILABLE");
    const times = hourly.time;
    const aqi = hourly.us_aqi;
    const pm25 = hourly.pm2_5;
    if (times.some((value, i) => typeof value !== "number" || !Number.isInteger(value) || value <= 0 || i > 0 && (value as number) <= (times[i - 1] as number)) ||
        aqi.some(value => value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) ||
        pm25.some(value => value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0))) return unavailable("CAMS_UNAVAILABLE");
    result.push({ coordinates: coordinates[index], times: times as number[], aqi: aqi as (number | null)[], pm25: pm25 as (number | null)[] });
  }
  return result;
}

export async function loadCamsForecast(
  saved: AirForecastCache | null,
  request: Request = fetch,
  now = Date.now(),
): Promise<{ cache: AirForecastCache; features: HazardFeature[] }> {
  try {
    const metaResponse = await request(CAMS_META_URL, { signal: AbortSignal.timeout(15000) });
    if (!metaResponse.ok) return unavailable("CAMS_UNAVAILABLE");
    const metadata: unknown = await metaResponse.json();
    if (!isRecord(metadata)) return unavailable("CAMS_UNAVAILABLE");
    const run = parseRun((metadata as unknown as CamsMetadata).last_run_initialisation_time);
    const availability = parseRun((metadata as unknown as CamsMetadata).last_run_availability_time);
    if (run === null || availability === null) return unavailable("CAMS_UNAVAILABLE");
    if (saved && cacheIsUsable(saved, now)) {
      const ready = run === saved.run && now >= availability + 10 * 60 * 1000;
      const newerReady = run > saved.run && now >= availability + 10 * 60 * 1000;
      if (ready || run <= saved.run || !newerReady) return { cache: saved, features: selectCamsFeatures(saved, now) };
    }
    const samples: AirForecastCache["samples"] = [];
    for (let offset = 0; offset < AIR_GRID.length; offset += 50) {
      samples.push(...await fetchCamsBatch(AIR_GRID.slice(offset, offset + 50), request));
    }
    const cache: AirForecastCache = { run, fetched_at: new Date(now).toISOString(), samples };
    const features = selectCamsFeatures(cache, now);
    return { cache, features };
  } catch (error) {
    if (error instanceof HazardSourceError) throw error;
    return unavailable("CAMS_UNAVAILABLE");
  }
}
