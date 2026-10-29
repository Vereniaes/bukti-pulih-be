// Serve model wind samples without inventing missing readings.
export interface WindPoint { id: string; coordinates: [number, number]; speed_kmh: number; direction_deg: number; observed_at: string }
export interface WindResult { points: WindPoint[]; fetched_at: string; source: string; status: "ready" | "cached" }
const GRID = [-10, -5, 0, 5].flatMap(lat => [95,100,105,110,115,120,125,130,135,140].map(lon => [lat, lon]));
const TTL = 15 * 60 * 1000;
export function parseWind(input: unknown, now = Date.now()): WindResult {
  if (!Array.isArray(input)) throw new Error("WIND_UNAVAILABLE");
  const points: WindPoint[] = input.flatMap(row => {
    const { latitude: lat, longitude: lon, current: c, current_units: units } = row ?? {};
    if (!c || units?.wind_speed_10m !== "km/h" || units?.wind_direction_10m !== "°" ||
        ![lat,lon,c.time,c.wind_speed_10m,c.wind_direction_10m].every(v => typeof v === "number" && Number.isFinite(v)) ||
        Math.abs(lat)>90 || Math.abs(lon)>180 || c.wind_speed_10m<0 || c.wind_direction_10m<0 || c.wind_direction_10m>360 ||
        c.time*1000 > now+3600000 || c.time*1000 < now-3600000) return [];
    return [{ id: `${lat},${lon}`, coordinates: [lat,lon] as [number,number], speed_kmh:c.wind_speed_10m,
      direction_deg:c.wind_direction_10m, observed_at:new Date(c.time*1000).toISOString() }];
  });
  if (!points.length) throw new Error("WIND_UNAVAILABLE");
  return { points, fetched_at:new Date(now).toISOString(), source:"ECMWF IFS · Open-Meteo", status:"ready" };
}
export function createWindService(request = fetch, clock = Date.now) {
  let saved: WindResult | undefined, pending: Promise<WindResult> | undefined;
  return async (): Promise<WindResult> => {
    if (saved && clock()-Date.parse(saved.fetched_at)<TTL) return saved;
    if (pending) return pending;
    pending = (async () => {
      try {
        const query = new URLSearchParams({ latitude:GRID.map(p=>p[0]).join(","), longitude:GRID.map(p=>p[1]).join(","),
          current:"wind_speed_10m,wind_direction_10m", wind_speed_unit:"kmh", timeformat:"unixtime", timezone:"GMT", models:"ecmwf_ifs025" });
        const response = await request(`https://api.open-meteo.com/v1/forecast?${query}`, { signal:AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error("WIND_UNAVAILABLE");
        saved = parseWind(await response.json(), clock()); return saved;
      } catch {
        if (saved && clock()-Date.parse(saved.fetched_at)<3600000) return { ...saved, status:"cached" };
        throw new Error("WIND_UNAVAILABLE");
      }
    })();
    try { return await pending; } finally { pending=undefined; }
  };
}
