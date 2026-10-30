// Todo:
// -> Verify viewport limits, rain timing, missing data, and shared source budgets.

// --- Model fixtures ---
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { type Bounds } from "../hotspots/hotspot.service.js";
import { createRainService, parseRain, rainGrid, RainError } from "./rain.service.js";
import { createRainRoutes } from "./rain.routes.js";

const HOUR = 3_600_000, now = Date.parse("2026-10-30T04:30:00Z");
const bounds: Bounds = [106.801, -6.199, 106.809, -6.191];
const grid = rainGrid(bounds);
function fixture(current = 0, rainHour = -1, timestamp = now) {
  const times = Array.from({ length: 12 }, (_, i) => Math.floor(now / HOUR) * HOUR - (11 - i) * HOUR);
  return { current: { time: timestamp / 1000, interval: 900, precipitation: current, rain: current, showers: 0 },
    current_units: { time: "unixtime", precipitation: "mm", rain: "mm", showers: "mm" },
    hourly: { time: times.map(at => at / 1000), precipitation: times.map((_, i) => i === rainHour ? 2 : 0), rain: times.map((_, i) => i === rainHour ? 2 : 0), showers: times.map(() => 0) },
    hourly_units: { time: "unixtime", precipitation: "mm", rain: "mm", showers: "mm" } };
}
const point = (row = fixture()) => parseRain(grid.coordinates.map(() => row), grid, now).points[0];
const batch = (url: string | URL | Request) => new URL(String(url)).searchParams.get("latitude")!.split(",").map(() => fixture());
// --- end of Model fixtures ---

// --- Viewport and time rules ---
test("rain sampling stays bounded, quantized, and inside Indonesia", () => {
  const national = rainGrid([80, -20, 160, 20]);
  assert.ok(national.coordinates.length <= 30);
  assert.ok(national.coordinates.every(([lat, lng]) => lat >= -12 && lat <= 8 && lng >= 94 && lng <= 142));
  assert.deepEqual(national.bounds, [94, -12, 142, 8]);
  assert.equal(grid.key, rainGrid([106.802, -6.198, 106.808, -6.192]).key);
  for (const bad of [[0, 0, 1, 1], [110, 0, 100, 1], [100, NaN, 110, 1]]) assert.throws(() => rainGrid(bad as Bounds), RainError);
});

test("rain states use current rain, completed past hours, and complete dry coverage", () => {
  assert.equal(point(fixture(0.1)).state, "now");
  const recent = point(fixture(0, 10));
  assert.equal(recent.state, "recent");
  assert.equal(recent.recent_mm, 2);
  assert.equal(recent.last_rain_at, "2026-10-30T03:00:00.000Z");
  assert.equal(point().state, "dry");
  assert.equal(point().current_mm, 0);
  const snow = fixture(); snow.current.precipitation = 3;
  assert.equal(point(snow).state, "dry");
});

test("future rain and intervals older than twelve hours never become recent rain", () => {
  const row = fixture();
  row.hourly.time.push((now + HOUR) / 1000, (now - 12 * HOUR) / 1000);
  row.hourly.rain.push(2, 2); row.hourly.precipitation.push(2, 2); row.hourly.showers.push(0, 0);
  assert.equal(point(row).state, "dry");
  assert.equal(point(row).recent_mm, 0);
  assert.equal(point(fixture(1, -1, now + 60_000)).state, "unknown");
  assert.equal(point(fixture(1, -1, now - 31 * 60_000)).state, "unknown");
});

test("missing, negative, wrong-unit and duplicate data remain unknown rather than dry", () => {
  const missing = fixture(); (missing.current as Record<string, unknown>).rain = null;
  assert.equal(point(missing).state, "unknown");
  assert.equal(point(fixture(-1)).state, "unknown");
  const wrong = fixture(); wrong.current_units.rain = "inch";
  assert.equal(point(wrong).state, "unknown");
  const partial = fixture(); (partial.hourly.rain as unknown[])[0] = null;
  assert.equal(point(partial).state, "unknown");
  const duplicate = fixture(); duplicate.hourly.time[0] = duplicate.hourly.time[1];
  assert.equal(point(duplicate).state, "unknown");
  const incompleteRain = fixture(0, 10); (incompleteRain.hourly.rain as unknown[])[0] = null;
  assert.equal(point(incompleteRain).state, "recent");
  assert.equal(point(incompleteRain).recent_mm, null);
  assert.throws(() => parseRain([], grid, now), RainError);
});
// --- end of Viewport and time rules ---

// --- Cache and request limits ---
test("matching viewports share one batch, cache fifteen minutes, and bound stale fallback", async () => {
  let calls = 0, time = now, fail = false;
  const read = createRainService(async url => {
    calls++;
    const query = new URL(String(url)).searchParams;
    assert.equal(query.get("past_hours"), "12");
    assert.equal(query.get("forecast_hours"), "1");
    assert.equal(query.get("current"), "precipitation,rain,showers");
    assert.ok(query.get("latitude")!.split(",").length <= 30);
    if (fail) throw Error();
    return Response.json(batch(url));
  }, () => time);
  const [first, second] = await Promise.all([read(bounds), read(bounds)]);
  assert.deepEqual(first, second); assert.equal(calls, 1);
  await read([106.802, -6.198, 106.808, -6.192]); assert.equal(calls, 1);
  fail = true; time += 16 * 60_000;
  const stale = await read(bounds);
  assert.equal(stale.status, "cached");
  assert.ok(stale.points.every(p => p.state === "unknown" && p.current_mm === null && p.recent_mm === null));
  assert.equal(stale.fetched_at, first.fetched_at);
  time += HOUR; await assert.rejects(read(bounds), /RAIN_UNAVAILABLE/);
});

test("cached current readings expire before a failed request can claim Rain Now", async () => {
  let time = now;
  const read = createRainService(async url => Response.json(batch(url).map(() => fixture(1, -1, now - 25 * 60_000))), () => time);
  assert.equal((await read(bounds)).points[0].state, "now");
  time += 6 * 60_000;
  assert.equal((await read(bounds)).points[0].state, "unknown");
});

test("new upstream geography is rate limited while cached geography stays available", async () => {
  let calls = 0;
  const read = createRainService(async url => { calls++; return Response.json(batch(url)); }, () => now);
  for (let i = 0; i < 10; i++) await read([100 + i * 0.1, -6.2, 100.008 + i * 0.1, -6.192]);
  await assert.rejects(read([120, -6.2, 120.008, -6.192]), (error: unknown) => error instanceof RainError && error.status === 429);
  await read([100, -6.2, 100.008, -6.192]);
  assert.equal(calls, 10);
});

test("cache evicts old geography after sixty-four entries", async () => {
  let calls = 0, time = now;
  const read = createRainService(async url => { calls++; return Response.json(batch(url)); }, () => time);
  for (let i = 0; i < 65; i++) {
    await read([100 + i * 0.1, -6.2, 100.008 + i * 0.1, -6.192]);
    if (i % 9 === 8) time += 61_000;
  }
  await read([100, -6.2, 100.008, -6.192]);
  assert.equal(calls, 66);
});
// --- end of Cache and request limits ---

// --- Public route ---
test("rain endpoint validates bbox, returns the envelope, and limits repeated visitors", async () => {
  let calls = 0;
  const app = express();
  app.use("/api/v1/external", createRainRoutes(async requested => { calls++; return parseRain(grid.coordinates.map(() => fixture()), rainGrid(requested), now); }));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/v1/external/rain`;
  try {
    assert.equal((await fetch(base + "?bbox=bad")).status, 400);
    const response = await fetch(base + "?bbox=" + bounds.join(","));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json() as { data: { basis: string } }).data.basis, "model");
    for (let i = 1; i < 60; i++) assert.equal((await fetch(base + "?bbox=" + bounds.join(","))).status, 200);
    const blocked = await fetch(base + "?bbox=" + bounds.join(","));
    assert.equal(blocked.status, 429); assert.equal(blocked.headers.get("retry-after"), "60");
    assert.equal(calls, 60);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
// --- end of Public route ---
