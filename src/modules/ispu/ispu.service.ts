// Turn the official ISPU feed into safe station data for the map.
export type IspuCategory = "BAIK" | "SEDANG" | "TIDAK SEHAT" | "SANGAT TIDAK SEHAT" | "BERBAHAYA";
export interface IspuStation {
  id: string; name: string; address: string; province: string; coordinates: [number, number]; value: number;
  category: IspuCategory; dominant_pollutant: string; observed_at: string; station_type: string;
}
export interface IspuResult { stations: IspuStation[]; fetched_at: string; source: "KLH/BPLH"; status: "ready" | "cached" }
export interface IspuDetail {
  station: IspuStation; pollutants: { key: string; label: string; index: number | null }[];
  fetched_at: string; status: "ready" | "cached";
}
const BASE = "https://ispu.kemenlh.go.id/apiweb/";
const TTL = 5 * 60_000, MAX_STALE = 60 * 60_000, MAX_DETAILS = 128;
const CATEGORIES = new Set<IspuCategory>(["BAIK", "SEDANG", "TIDAK SEHAT", "SANGAT TIDAK SEHAT", "BERBAHAYA"]);
const POLLUTANTS = [["pm10", "PM10"], ["pm25", "PM2.5"], ["so2", "SO2"], ["co", "CO"], ["o3", "O3"], ["no2", "NO2"], ["hc", "HC"]] as const;
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const str = (v: unknown): string => typeof v === "string" ? v.trim() : "";
const number = (v: unknown): number | null => {
  if (typeof v !== "number" && typeof v !== "string") return null;
  if (typeof v === "string" && !v.trim()) return null;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : null;
};
const nonnegative = (value: unknown): number | null => { const n = number(value); return n !== null && n >= 0 ? n : null; };
const localTimestamp = (value: unknown, zone: unknown): string | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(str(value));
  const offsetMinutes = ({ WIB: 420, WITA: 480, WIT: 540 } as Record<string, number>)[str(zone)];
  if (!match || offsetMinutes === undefined) return null;
  const [, y, mo, d, h, mi, s] = match;
  const local = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
  if (Number.isNaN(local.getTime()) || local.toISOString().slice(0, 19) !== `${y}-${mo}-${d}T${h}:${mi}:${s}`) return null;
  return new Date(local.getTime() - offsetMinutes * 60_000).toISOString();
};
const pollutantLabel = (value: unknown): string => {
  const normalized = str(value).replace(/<[^>]*>/g, "").replace(/\s+/g, "").toUpperCase();
  const labels: Record<string, string> = { PM10: "PM10", "PM2.5": "PM2.5", SO2: "SO2", CO: "CO", O3: "O3", NO2: "NO2", HC: "HC" };
  return labels[normalized] ?? "Unknown";
};
const unavailable = (): Error => new Error("ISPU_UNAVAILABLE");
export function parseIspuStations(input: unknown, now = Date.now()): IspuResult {
  const rows = record(input).rows;
  if (!Array.isArray(rows)) throw unavailable();
  const stations = rows.flatMap((item): IspuStation[] => {
    const row = record(item);
    const id = str(row.id_stasiun), name = str(row.nama), address = str(row.alamat), province = str(row.provinsi);
    const lat = number(row.lat), lon = number(row.lon), value = nonnegative(row.val), category = str(row.cat) as IspuCategory;
    const observedAt = localTimestamp(row.waktu, row.time_z);
    if (!id || !/^[-A-Za-z0-9_]{1,120}$/.test(id) || !name || !address || !province || lat === null || lon === null ||
        Math.abs(lat) > 90 || Math.abs(lon) > 180 || value === null || !CATEGORIES.has(category) || !observedAt ||
        String(row.is_maintenance ?? "") === "1" || String(row.stasiun_show ?? "") === "0") return [];
    return [{ id, name, address, province, coordinates: [lat, lon], value, category,
      dominant_pollutant: pollutantLabel(row.param), observed_at: observedAt, station_type: str(row.tipe_text) || "KLH/BPLH" }];
  });
  if (!stations.length) throw unavailable();
  return { stations, fetched_at: new Date(now).toISOString(), source: "KLH/BPLH", status: "ready" };
}
export function parseIspuDetail(input: unknown, station: IspuStation, now = Date.now()): IspuDetail {
  const rows = record(input).rows;
  const row = record(Array.isArray(rows) ? rows[0] : undefined);
  if (str(row.id_stasiun) !== station.id) throw unavailable();
  const lastTime = Array.isArray(row.waktu_24) ? row.waktu_24.at(-1) : null;
  const observedAt = localTimestamp(row.waktu, row.time_z) ?? localTimestamp(lastTime, row.time_z) ?? station.observed_at;
  const overall = nonnegative(row.val), category = str(row.cat) as IspuCategory;
  const current = { ...station, observed_at: observedAt, value: overall !== null ? overall : station.value,
    category: CATEGORIES.has(category) ? category : station.category };
  return { station: current, pollutants: POLLUTANTS.map(([key, label]) => ({ key, label, index: nonnegative(row[key]) })),
    fetched_at: new Date(now).toISOString(), status: "ready" };
}
export function createIspuService(readAuth: () => string, request: typeof fetch = fetch, clock: () => number = Date.now) {
  let saved: IspuResult | undefined, pending: Promise<IspuResult> | undefined;
  const details = new Map<string, IspuDetail>(), detailPending = new Map<string, Promise<IspuDetail>>();
  const stations = async (): Promise<IspuResult> => {
    if (saved && clock() - Date.parse(saved.fetched_at) < TTL) return saved;
    if (pending) return pending;
    pending = (async () => {
      try {
        const response = await request(`${BASE}stasiun`, { headers: { Authorization: readAuth() }, signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw unavailable();
        saved = parseIspuStations(await response.json(), clock());
        return saved;
      } catch {
        if (saved && clock() - Date.parse(saved.fetched_at) < MAX_STALE) return { ...saved, status: "cached" };
        throw unavailable();
      }
    })();
    try { return await pending; } finally { pending = undefined; }
  };
  const detail = async (id: string, knownStation?: IspuStation): Promise<IspuDetail> => {
    if (!/^[-A-Za-z0-9_]{1,120}$/.test(id)) throw unavailable();
    const station = knownStation?.id === id ? knownStation : (await stations()).stations.find(item => item.id === id);
    if (!station) throw unavailable();
    const cached = details.get(id);
    if (cached && clock() - Date.parse(cached.fetched_at) < TTL) return cached;
    const inFlight = detailPending.get(id);
    if (inFlight) return inFlight;
    const work: Promise<IspuDetail> = (async () => {
      try {
        const response = await request(`${BASE}stasiun/detail/id/${encodeURIComponent(id)}`, {
          headers: { Authorization: readAuth() }, signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw unavailable();
        const value = parseIspuDetail(await response.json(), station, clock());
        details.set(id, value);
        if (details.size > MAX_DETAILS) details.delete(details.keys().next().value!);
        return value;
      } catch {
        const previous = details.get(id);
        if (previous && clock() - Date.parse(previous.fetched_at) < MAX_STALE) return { ...previous, status: "cached" };
        throw unavailable();
      }
    })();
    detailPending.set(id, work);
    try { return await work; } finally { detailPending.delete(id); }
  };
  return { stations, detail };
}
