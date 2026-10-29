// Check real location contracts with isolated sessions and deterministic provider responses.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { UserModel } from "../src/modules/auth/user.model.js";
import { createSession } from "../src/modules/auth/session.service.js";
import { createLocationService, LocationError, normalizeLocations } from "../src/modules/locations/location.service.js";
const feature = (overrides = {}) => ({ type: "Feature", geometry: { type: "Point", coordinates: [109.345, -.041] }, properties: { countrycode: "ID", name: "Jalan Gajah Mada", city: "Pontianak", state: "Kalimantan Barat", osm_type: "W", osm_id: 12, ...overrides } });
const payload = { type: "FeatureCollection", features: [feature()] };
const fetcher = (handler: (url: string) => Promise<Response>) => handler as unknown as typeof fetch;

test("normalization preserves street/administration and drops foreign or malformed geometry", () => {
  const result = normalizeLocations({ features: [feature(), feature(), feature({ countrycode: "MY" }), { ...feature(), geometry: { coordinates: [181, 0] } }] });
  assert.equal(result.length, 1); assert.equal(result[0].province, "Kalimantan Barat"); assert.equal(result[0].city, "Pontianak");
  assert.deepEqual(result[0].coordinates, [109.345, -.041]); assert.equal(result[0].label.includes("78117"), false);
  assert.throws(() => normalizeLocations({ error: "upstream" }), LocationError);
  assert.deepEqual(normalizeLocations({ features: [] }), []);
});
test("concurrent same-query lookups coalesce and use an Indonesian-only request", async () => {
  let calls = 0;
  const service = createLocationService({ interval: 0, fetcher: fetcher(async url => { calls++; const parsed = new URL(url); assert.equal(parsed.searchParams.get("countrycode"), "ID"); assert.equal(parsed.searchParams.get("q"), "Jalan Gajah Mada"); await new Promise(resolve => setTimeout(resolve, 10)); return Response.json(payload); }) });
  const [first, second] = await Promise.all([service.search("Jalan Gajah Mada"), service.search("Jalan Gajah Mada")]);
  assert.deepEqual(first, second); await service.search("Jalan Gajah Mada"); assert.equal(calls, 1);
});
test("provider failures are retryable and reverse results retain their own coordinates", async () => {
  let calls = 0;
  const service = createLocationService({ interval: 0, fetcher: fetcher(async () => { if (++calls === 1) throw new Error("offline"); return Response.json(payload); }) });
  await assert.rejects(() => service.reverse([109.3451, -.0411]), LocationError);
  const result = await service.reverse([109.3451, -.0411]); assert.deepEqual(result[0].coordinates, [109.345, -.041]); assert.equal(calls, 2);
});
test("upstream queue rejects excess work without making an extra request", async () => {
  let calls = 0;
  const service = createLocationService({ interval: 10_000, fetcher: fetcher(async () => { calls++; return Response.json(payload); }) });
  await service.search("Pontianak");
  await assert.rejects(() => service.search("Surabaya"), { message: "LOCATION_BUSY" });
  assert.equal(calls, 1);
});
const dbName = `buktipulih_location_test_${process.pid}`;
let server: Server, base: string, cookie: string, context: string;
let providerCalls = 0;
before(async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27017/${dbName}`); await UserModel.init();
  const user = await UserModel.create({ email: "locations@example.test", username: "LocationTester", participation: "observer" });
  const session = await createSession(user._id.toString()); cookie = `bp_session=${session.token}`; context = session.context;
  server = createApp({ locations: {
    search: async q => { providerCalls++; if (q === "unavailable") throw new LocationError("LOCATION_UNAVAILABLE"); return normalizeLocations(payload); },
    reverse: async point => { assert.deepEqual(point, [109.3, -.02]); return normalizeLocations(payload); },
  } }).listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object"); base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  assert.equal(mongoose.connection.name, dbName); assert.match(dbName, /^buktipulih_location_test_/);
  await mongoose.connection.dropDatabase(); await mongoose.disconnect();
});
test("location routes require a session and bound inputs before provider access", async () => {
  const call = (path: string, signed = true) => fetch(`${base}/api/v1/locations/${path}`, { headers: signed ? { Cookie: cookie, "X-Session-Context": context } : {} });
  const previous = providerCalls;
  assert.equal((await call("search?q=Pontianak", false)).status, 401);
  for (const path of ["search?q=ab", "search?q=" + "a".repeat(161), "search?q=valid&url=https://attacker.test", "reverse?lng=181&lat=0", "reverse?lng=109", "reverse?lng=x&lat=0", "reverse?lng=&lat=0", "reverse?lng=109&lat="]) assert.equal((await call(path)).status, 422);
  assert.equal(providerCalls, previous);
  const response = await call("search?q=Pontianak"); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal((await response.json()).data.items[0].city, "Pontianak");
  assert.equal((await call("reverse?lng=109.3&lat=-0.02")).status, 200);
  const unavailable = await call("search?q=unavailable"); assert.equal(unavailable.status, 503); assert.equal((await unavailable.json()).error.code, "LOCATION_UNAVAILABLE");
});
