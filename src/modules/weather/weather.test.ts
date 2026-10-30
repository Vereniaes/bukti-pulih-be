// Todo:
// -> Verify current-time selection, shared refreshes and safe source failures.

// --- Current weather behavior ---
import test from "node:test";
import assert from "node:assert/strict";
import { apparentTemperature, createWeatherService, selectWeatherSlice, WEATHER_FIELDS, WEATHER_GRID, type WeatherGrid } from "./weather.service.js";

const NOW = Date.parse("2026-10-30T04:30:00Z"), HOUR = 3600_000;
const variables = ["rain", "showers", "temperature_2m", "relative_humidity_2m", "wind_u_component_10m", "wind_v_component_10m", "wind_gusts_10m", "direct_radiation", "diffuse_radiation"];
const manifest = (run = "2026-10-30T00:00Z", times = ["2026-10-30T03:00Z", "2026-10-30T04:00Z", "2026-10-30T05:00Z"]) => ({ reference_time: run, valid_times: times, variables });
const fields = Object.fromEntries(WEATHER_FIELDS.map(name => [name, [0, 10, null, 20]])) as WeatherGrid["fields"];

test("selects the newest available current hour and never the next forecast hour", () => {
  assert.deepEqual(selectWeatherSlice([manifest()], NOW), { run_at: "2026-10-30T00:00:00.000Z", valid_at: "2026-10-30T04:00:00.000Z" });
  const newer = manifest("2026-10-30T03:00Z");
  assert.equal(selectWeatherSlice([manifest(), newer], NOW).run_at, "2026-10-30T03:00:00.000Z");
});

test("future, expired, incomplete and malformed publications cannot become current weather", () => {
  for (const value of [manifest(undefined, ["2026-10-30T05:00Z"]), manifest(undefined, ["2026-10-30T02:00Z"]), { ...manifest(), variables: ["temperature_2m"] }, { ...manifest(), reference_time: "invalid" }, manifest("2026-10-30T06:00Z"), null]) {
    assert.throws(() => selectWeatherSlice([value], NOW), /WEATHER_UNAVAILABLE/);
  }
});

test("an in-progress initial step cannot replace complete precipitation data", () => {
  const initial = manifest("2026-10-30T04:00Z", ["2026-10-30T04:00Z"]);
  assert.equal(selectWeatherSlice([manifest(), initial], NOW).run_at, "2026-10-30T00:00:00.000Z");
});

test("humidity raises apparent temperature while wind reduces it", () => {
  const dry = apparentTemperature(30, 30, 2, 400), humid = apparentTemperature(30, 80, 2, 400);
  assert.ok(humid > dry + 5);
  assert.ok(apparentTemperature(30, 80, 8, 400) < humid);
  assert.ok(apparentTemperature(30, 80, 2, 900) > humid);
});

test("concurrent readers share one regional decode and preserve zero and unknown cells", async () => {
  let calls = 0, requests = 0;
  const service = createWeatherService(async () => { calls++; return fields; }, async () => { requests++; return Response.json(manifest()); }, () => NOW);
  const [a, b] = await Promise.all([service(), service()]);
  assert.equal(calls, 1); assert.equal(requests, 2); assert.equal(a, b);
  assert.deepEqual(a.fields.rain, [0, 10, null, 20]);
  assert.equal((await service()).fetched_at, a.fetched_at); assert.equal(calls, 1);
});

test("a newly valid hour refreshes even when the previous cache interval has not elapsed", async () => {
  let now = Date.parse("2026-10-30T04:58Z"), calls = 0;
  const service = createWeatherService(async () => { calls++; return fields; }, async () => Response.json(manifest()), () => now);
  assert.equal((await service()).valid_at, "2026-10-30T04:00:00.000Z");
  now += 3 * 60_000;
  assert.equal((await service()).valid_at, "2026-10-30T05:00:00.000Z");
  assert.equal(calls, 2);
});

test("a delayed model hour is checked once per interval rather than on every page read", async () => {
  let now = Date.parse("2026-10-30T04:58Z"), requests = 0;
  const service = createWeatherService(async () => fields, async () => { requests++; return Response.json(manifest(undefined, ["2026-10-30T04:00Z"])); }, () => now);
  await service(); now += 3 * 60_000; await service();
  const count = requests;
  for (let i = 0; i < 10; i++) await service();
  assert.equal(requests, count);
});

test("a failed refresh retains the old model time and expires rather than claiming live values", async () => {
  let now = NOW, online = true, calls = 0;
  const service = createWeatherService(async () => fields, async () => {
    calls++; if (!online) throw new Error("https://provider.invalid/private");
    return Response.json(manifest());
  }, () => now);
  const first = await service(); online = false; now += 16 * 60_000;
  const cached = await service();
  assert.equal(cached.status, "cached"); assert.equal(cached.fetched_at, first.fetched_at); assert.equal(cached.valid_at, first.valid_at);
  assert.notEqual(cached.checked_at, first.checked_at);
  const attempts = calls; await service(); assert.equal(calls, attempts);
  now += 2 * HOUR;
  await assert.rejects(service(), /^Error: WEATHER_UNAVAILABLE$/);
});

test("a failed cold load is backed off without inventing a snapshot", async () => {
  let calls = 0;
  const service = createWeatherService(async () => fields, async () => { calls++; throw new Error("private-provider-detail"); }, () => NOW);
  await assert.rejects(service(), /WEATHER_UNAVAILABLE/);
  await assert.rejects(service(), /WEATHER_UNAVAILABLE/);
  assert.equal(calls, 2);
});

test("a new backend process reuses a fresh compressed snapshot without downloading model data", async () => {
  const values = new Array(WEATHER_GRID.columns * WEATHER_GRID.rows).fill(0);
  const data: WeatherGrid = { grid: WEATHER_GRID, fields: Object.fromEntries(WEATHER_FIELDS.map(name => [name, values])) as WeatherGrid["fields"],
    run_at: "2026-10-30T00:00:00Z", valid_at: "2026-10-30T04:00:00Z", fetched_at: new Date(NOW - 60_000).toISOString(), checked_at: new Date(NOW - 60_000).toISOString(),
    status: "ready", source: "DWD ICON · Open-Meteo", basis: "model", resolution_km: 14, interval_seconds: 3600 };
  let requests = 0;
  const service = createWeatherService(async () => { throw new Error("unexpected decode"); }, async () => { requests++; throw new Error("unexpected request"); }, () => NOW, {
    read: async <T>() => ({ data: data as T, checked_at: data.checked_at, fetched_at: data.fetched_at, failed: false }),
    write: async () => { throw new Error("unexpected write"); }, fail: async () => {},
  });
  assert.equal((await service()).fetched_at, data.fetched_at);
  assert.equal(requests, 0);
});
// --- end of Current weather behavior ---
