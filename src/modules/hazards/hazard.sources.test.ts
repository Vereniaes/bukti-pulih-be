import test from "node:test";
import assert from "node:assert/strict";
import {
  AIR_GRID, fetchBnpbLayers, loadCamsForecast, normalizeBnpbGeoJson, selectCamsFeatures, HazardSourceError,
} from "./hazard.sources.js";
import type { AirForecastCache } from "./hazard.types.js";

const now = Date.parse("2026-10-26T12:30:00.000Z");
const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
const square = { type: "Polygon", coordinates: [[[100, -2], [101, -2], [101, -1], [100, -1], [100, -2]]] };
function bnpbFeature(id: string, category: string, dt: unknown = now - 1000, geometry: unknown = square) {
  return { type: "Feature", id: `fid-${id}`, geometry, properties: { id, dt, kabupaten: "Kabupaten Contoh", kategori_bencana: category, jumlah_kejadian: 2 } };
}
function collection(features: unknown[]) { return { type: "FeatureCollection", features }; }
function sourceError(code: string) {
  return (error: unknown) => error instanceof HazardSourceError && error.code === code;
}

test("BNPB normalization separates exact categories, validates geometry, and keeps source time", () => {
  const point = { type: "Point", coordinates: [111, -3] };
  const multi = { type: "MultiPolygon", coordinates: [square.coordinates, square.coordinates] };
  const result = normalizeBnpbGeoJson(collection([
    bnpbFeature("f-1", "Kebakaran hutan dan lahan"), bnpbFeature("f-1", "Kebakaran hutan dan lahan"),
    bnpbFeature("b-1", "Banjir", now - 2000, multi), bnpbFeature("b-2", "Banjir", now - 3000, point),
    bnpbFeature("old", "Banjir", weekAgo - 1), bnpbFeature("future", "Banjir", now + 1),
    bnpbFeature("other", "Cuaca ekstrem"),
  ]), now);
  assert.equal(result.fire.length, 1);
  assert.equal(result.flood.length, 2);
  assert.equal(result.fire[0].id, "fire:bnpb:f-1");
  assert.equal(result.fire[0].properties.label, "Karhutla · Kabupaten Contoh");
  assert.equal(result.fire[0].properties.observed_at, new Date(now - 1000).toISOString());
  assert.equal(result.fire[0].properties.plot_ids.length, 0);
  assert.equal(result.fire[0].properties.detail, "Wilayah laporan BNPB · 2 kejadian");
  assert.equal(result.flood[0].geometry.type, "MultiPolygon");
  assert.equal(result.flood[1].geometry.type, "Point");
});

test("BNPB rejects malformed expected geometry, non-ISO dates, and broken rings", () => {
  assert.throws(() => normalizeBnpbGeoJson(collection([bnpbFeature("bad", "Banjir", now, { type: "Polygon", coordinates: [[[100, 0], [101, 0], [101, 1], [100, 1]]] })]), now), sourceError("BNPB_UNAVAILABLE"));
  assert.throws(() => normalizeBnpbGeoJson(collection([bnpbFeature("bad", "Banjir", "1793037000000")]), now), sourceError("BNPB_UNAVAILABLE"));
  assert.throws(() => normalizeBnpbGeoJson(collection([bnpbFeature("bad", "Banjir", "2026-02-31")]), now), sourceError("BNPB_UNAVAILABLE"));
  assert.equal(normalizeBnpbGeoJson(collection([bnpbFeature("date-only", "Banjir", "2026-10-26")]), now).flood.length, 1);
  assert.throws(() => normalizeBnpbGeoJson({ features: [] }, now), sourceError("BNPB_UNAVAILABLE"));
});

test("BNPB fetch uses official fields and emits only normalized report features", async () => {
  let calls = 0;
  const request: typeof fetch = async input => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("f"), "geojson");
    assert.equal(url.searchParams.get("outSR"), "4326");
    assert.equal(url.searchParams.get("outFields"), "id,dt,kabupaten,kategori_bencana,jumlah_kejadian");
    assert.equal(url.searchParams.get("resultRecordCount"), "1000");
    assert.match(url.searchParams.get("where") ?? "", /kategori_bencana IN/);
    return Response.json(collection([bnpbFeature("f", "Kebakaran hutan dan lahan"), bnpbFeature("b", "Banjir")]));
  };
  const result = await fetchBnpbLayers(request, now);
  assert.equal(calls, 1);
  assert.equal(result.fire.length, 1);
  assert.equal(result.flood.length, 1);
});

test("BNPB paginates and fails safely when pages stop advancing", async () => {
  const rows = Array.from({ length: 1000 }, (_, index) => bnpbFeature(`id-${index}`, "Banjir"));
  let calls = 0;
  const paged: typeof fetch = async input => {
    calls++;
    const offset = Number(new URL(String(input)).searchParams.get("resultOffset"));
    return Response.json(collection(offset === 0 ? rows : [bnpbFeature("last", "Banjir")]));
  };
  assert.equal((await fetchBnpbLayers(paged, now)).flood.length, 1001);
  assert.equal(calls, 2);
  let repeatedCalls = 0;
  const repeated: typeof fetch = async () => { repeatedCalls++; return Response.json(collection(rows)); };
  await assert.rejects(fetchBnpbLayers(repeated, now), sourceError("BNPB_UNAVAILABLE"));
  assert.equal(repeatedCalls, 2);
});

test("BNPB upstream errors are reduced to a concise stable code", async () => {
  await assert.rejects(fetchBnpbLayers(async () => new Response("provider details", { status: 403 }), now), error => {
    assert(sourceError("BNPB_UNAVAILABLE")(error));
    assert.equal((error as Error).message, "BNPB_UNAVAILABLE");
    return true;
  });
});

const currentHour = Math.floor(now / 3600000) * 3600;
const run = Date.parse("2026-10-25T00:00:00Z");
const available = Date.parse("2026-10-25T12:00:00Z");
function makeCache(overrides: Partial<AirForecastCache> = {}): AirForecastCache {
  return {
    run, fetched_at: new Date(now - 1000).toISOString(),
    samples: AIR_GRID.map((coordinates, index) => ({ coordinates, times: [currentHour, currentHour + 3600], aqi: [index === 0 ? 0 : 40, 45], pm25: [index === 0 ? 0 : 5, 6] })),
    ...overrides,
  };
}
function camsMetadata(initialisation = run, availabilityTime = available) {
  return { last_run_initialisation_time: Math.floor(initialisation / 1000), last_run_availability_time: Math.floor(availabilityTime / 1000), update_interval_seconds: 43200, temporal_resolution_seconds: 3600 };
}
function camsRequest(options: { metadata?: unknown; allNull?: boolean; units?: boolean } = {}) {
  const calls: string[] = [];
  const request: typeof fetch = async input => {
    const url = String(input); calls.push(url);
    if (url.includes("meta.json")) return Response.json(options.metadata ?? camsMetadata());
    const parsed = new URL(url);
    const latitudes = parsed.searchParams.get("latitude")!.split(",").map(Number);
    const longitudes = parsed.searchParams.get("longitude")!.split(",").map(Number);
    const locations = latitudes.map((latitude, index) => ({ latitude, longitude: longitudes[index], hourly_units: options.units === false ? undefined : { time: "unixtime", us_aqi: "USAQI", pm2_5: "μg/m³" }, hourly: {
      time: [currentHour, currentHour + 3600],
      us_aqi: options.allNull ? [null, null] : [25, 30],
      pm2_5: options.allNull ? [null, null] : [0, 1],
    } }));
    return Response.json(locations);
  };
  return { request, calls };
}

test("CAMS grid has all 275 exact two-degree coordinates in longitude-latitude order", () => {
  assert.equal(AIR_GRID.length, 275);
  assert.deepEqual(AIR_GRID[0], [94, -12]);
  assert.deepEqual(AIR_GRID.at(-1), [142, 8]);
});

test("CAMS cache hit requires current forecast hour and preserves zero while omitting null", async () => {
  const cache = makeCache();
  const features = selectCamsFeatures(cache, now);
  assert.equal(features.length, AIR_GRID.length);
  assert.equal(features[0].properties.aqi, 0);
  assert.equal(features[0].properties.pm25, 0);
  assert.equal(features[0].properties.observed_at, new Date(currentHour * 1000).toISOString());
  const partial = makeCache({ samples: cache.samples.map((sample, index) => index === 0 ? { ...sample, aqi: [null, 30] } : sample) });
  assert.equal(selectCamsFeatures(partial, now).length, AIR_GRID.length - 1);
  const { request, calls } = camsRequest();
  const reused = await loadCamsForecast(cache, request, now);
  assert.equal(calls.length, 1);
  assert.equal(reused.cache, cache);
});

test("CAMS refetches once for a newly available model run in batches of at most 50", async () => {
  const newAvailability = now - 2 * 3600 * 1000;
  const newRun = newAvailability - 4 * 3600 * 1000;
  const { request, calls } = camsRequest({ metadata: camsMetadata(newRun, newAvailability) });
  const result = await loadCamsForecast(makeCache(), request, now);
  assert.equal(calls.length, 7);
  assert.equal(result.cache.run, newRun);
  assert.equal(result.cache.samples.length, AIR_GRID.length);
  for (const url of calls.slice(1)) assert((new URL(url).searchParams.get("latitude") ?? "").split(",").length <= 50);
  assert.equal(result.features.length, AIR_GRID.length);
});


test("CAMS waits ten minutes after a newly reported run becomes available", async () => {
  const recentAvailability = now - 9 * 60 * 1000;
  const recentRun = recentAvailability - 4 * 3600 * 1000;
  const cache = makeCache();
  const { request, calls } = camsRequest({ metadata: camsMetadata(recentRun, recentAvailability) });
  const result = await loadCamsForecast(cache, request, now);
  assert.equal(calls.length, 1);
  assert.equal(result.cache, cache);
});

test("CAMS accepts missing unit metadata but rejects units that contradict requested fields", async () => {
  const absent = camsRequest({ units: false });
  assert.equal((await loadCamsForecast(null, absent.request, now)).features.length, AIR_GRID.length);
  const { request } = camsRequest();
  const wrongUnits: typeof fetch = async input => {
    if (String(input).includes("meta.json")) return Response.json(camsMetadata());
    const response = await request(input);
    const locations = await response.json() as { hourly_units: { us_aqi: string } }[];
    locations[0].hourly_units.us_aqi = "AQI";
    return Response.json(locations);
  };
  await assert.rejects(loadCamsForecast(null, wrongUnits, now), sourceError("CAMS_UNAVAILABLE"));
});

test("CAMS cache is refreshed when the current hour is absent and all-null grids fail", async () => {
  const old = makeCache({ samples: makeCache().samples.map(sample => ({ ...sample, times: [currentHour - 3600], aqi: [12], pm25: [2] })) });
  const { request, calls } = camsRequest();
  const updated = await loadCamsForecast(old, request, now);
  assert.equal(calls.length, 7);
  assert.equal(updated.features.length, AIR_GRID.length);
  const empty = camsRequest({ allNull: true });
  await assert.rejects(loadCamsForecast(null, empty.request, now), sourceError("CAMS_UNAVAILABLE"));
  assert.equal(empty.calls.length, 7);
});

test("CAMS rejects malformed batch data and metadata failures without returning synthetic values", async () => {
  const invalid: typeof fetch = async input => String(input).includes("meta.json")
    ? Response.json(camsMetadata()) : new Response("invalid", { status: 502 });
  await assert.rejects(loadCamsForecast(null, invalid, now), sourceError("CAMS_UNAVAILABLE"));
  const { request } = camsRequest();
  const metadataFailure: typeof fetch = async input => String(input).includes("meta.json")
    ? new Response("secret upstream detail", { status: 403 }) : request(input);
  await assert.rejects(loadCamsForecast(makeCache(), metadataFailure, now), error => {
    assert(sourceError("CAMS_UNAVAILABLE")(error));
    assert.equal((error as Error).message, "CAMS_UNAVAILABLE");
    return true;
  });
});
