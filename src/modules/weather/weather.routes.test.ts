// Todo:
// -> Verify unchanged grids avoid repeated downloads and errors remain safe.

// --- Weather HTTP behavior ---
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createWeatherRoutes } from "./weather.routes.js";
import { WEATHER_FIELDS, WEATHER_GRID, type WeatherGrid } from "./weather.service.js";

const data: WeatherGrid = { grid: WEATHER_GRID,
  fields: Object.fromEntries(WEATHER_FIELDS.map(field => [field, [0, null, 5, 10]])) as WeatherGrid["fields"],
  valid_at: "2026-10-30T04:00:00Z", run_at: "2026-10-30T00:00:00Z", fetched_at: "2026-10-30T04:05:00Z", checked_at: "2026-10-30T04:05:00Z",
  status: "ready", source: "DWD ICON · Open-Meteo", basis: "model", resolution_km: 14, interval_seconds: 3600 };

test("unchanged data returns no body while a changed source status invalidates its tag", async () => {
  let cached = false;
  const app = express(); app.use(createWeatherRoutes(async () => ({ ...data, status: cached ? "cached" : "ready" })));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/weather`;
  try {
    const first = await fetch(url), tag = first.headers.get("etag")!;
    assert.match(tag, /^W\/"weather-[a-f0-9]{24}"$/);
    assert.equal((await first.json() as { data: WeatherGrid }).data.valid_at, data.valid_at);
    const unchanged = await fetch(url, { headers: { "If-None-Match": tag } });
    assert.equal(unchanged.status, 304); assert.equal(await unchanged.text(), "");
    cached = true;
    const changed = await fetch(url, { headers: { "If-None-Match": tag } });
    assert.equal(changed.status, 200); assert.notEqual(changed.headers.get("etag"), tag);
    assert.equal((await changed.json() as { data: WeatherGrid }).data.status, "cached");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("failed weather reads return unavailable without provider URLs and are rate limited", async () => {
  const app = express(); app.use(createWeatherRoutes(async () => { throw new Error("https://provider.invalid/private-key"); }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/weather`;
  try {
    const first = await fetch(url), body = await first.text();
    assert.equal(first.status, 503); assert.ok(body.includes("WEATHER_UNAVAILABLE")); assert.ok(!body.includes("private-key"));
    for (let i = 0; i < 29; i++) await (await fetch(url)).text();
    const limited = await fetch(url);
    assert.equal(limited.status, 429); assert.equal(limited.headers.get("retry-after"), "60");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
// --- end of Weather HTTP behavior ---
