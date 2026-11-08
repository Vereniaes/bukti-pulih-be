// Todo:
// -> verify liveness, database readiness and drain races over HTTP
// -> wait for active scheduler work without changing ordinary task controls

// --- Readiness and scheduler drain ---
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import type { Server } from "node:http";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { disconnectDatabase } from "../src/config/database.js";
import { initBnpbCronJob } from "../src/modules/bnpb/bnpb.cron.js";
import { BnpbSyncCacheModel } from "../src/modules/bnpb/bnpb.model.js";
import { initSatelliteDevelopmentScheduler } from "../src/modules/satellite/satellite.cron.js";

const database = "buktipulih_lifecycle_test_" + randomUUID().replaceAll("-", "");
const uri = `mongodb://127.0.0.1:27017/${database}`;
let server: Server, base: string, draining = false;
const settle = () => new Promise<void>(done => setImmediate(done));
before(async () => {
  console.log(JSON.stringify({ lifecycle_test_database: database }));
  await mongoose.connect(uri);
  await Promise.all(Object.values(mongoose.models).map(model => model.init()));
  server = createApp({ isDraining: () => draining }).listen(0, "127.0.0.1");
  await new Promise<void>(done => server.once("listening", done));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
  if (mongoose.connection.readyState !== 1) await mongoose.connect(uri);
  assert.equal(mongoose.connection.name, database);
  await mongoose.connection.dropDatabase(); await mongoose.disconnect();
});

test("health keeps its liveness contract while ready confirms a usable database", async () => {
  const health = await fetch(base + "/health");
  assert.equal(health.status, 200);
  assert.equal((await health.json() as { status: string }).status, "healthy");
  const ready = await fetch(base + "/ready");
  assert.equal(ready.status, 200); assert.equal(ready.headers.get("cache-control"), "no-store");
  assert.equal((await ready.json() as { status: string }).status, "ready");
});

test("database loss makes ready unavailable while health and later recovery still work", async () => {
  await mongoose.disconnect();
  const response = await fetch(base + "/ready");
  assert.equal(response.status, 503);
  assert.equal((await response.json() as { status: string }).status, "unavailable");
  assert.equal((await fetch(base + "/health")).status, 200);
  await mongoose.connect(uri);
  assert.equal((await fetch(base + "/ready")).status, 200);
});

test("a failed readiness ping is bounded and exposes no dependency detail", async t => {
  const admin = mongoose.connection.db!.admin();
  t.mock.method(mongoose.connection.db!, "admin", () => admin);
  const ping = t.mock.method(admin, "ping", async () => { throw new Error("PRIVATE_DATABASE_DETAIL"); });
  const response = await fetch(base + "/ready");
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes("PRIVATE_DATABASE_DETAIL"));
  assert.equal(ping.mock.calls[0].arguments[0]?.maxTimeMS, 1000);
});

test("drain starting during a database ping cannot publish a stale ready response", async t => {
  let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>(done => { enter = done; });
  const gate = new Promise<void>(done => { finish = done; });
  const admin = mongoose.connection.db!.admin();
  t.mock.method(mongoose.connection.db!, "admin", () => admin);
  t.mock.method(admin, "ping", async () => { enter(); await gate; return { ok: 1 }; });
  try {
    const pending = fetch(base + "/ready");
    const pingStarted = await Promise.race([entered.then(() => true), pending.then(() => false)]);
    assert.equal(pingStarted, true, "Readiness must check the database");
    draining = true; finish();
    assert.equal((await pending).status, 503);
    assert.equal((await fetch(base + "/health")).status, 200);
  } finally { draining = false; finish(); }
});

test("a slow ping shares one operation across probes and returns unavailable within the deadline", async t => {
  let finish!: () => void;
  const gate = new Promise<void>(done => { finish = done; });
  const admin = mongoose.connection.db!.admin();
  t.mock.method(mongoose.connection.db!, "admin", () => admin);
  const ping = t.mock.method(admin, "ping", async () => { await gate; return { ok: 1 }; });
  try {
    const started = performance.now();
    const responses = await Promise.all(Array.from({ length: 3 }, () => fetch(base + "/ready")));
    assert.ok(responses.every(response => response.status === 503));
    assert.ok(performance.now() - started < 2500);
    assert.equal(ping.mock.callCount(), 1);
    assert.equal((await fetch(base + "/ready")).status, 503);
    assert.equal(ping.mock.callCount(), 1);
  } finally { finish(); await settle(); }
});

test("database disconnect reports failure to lifecycle callers", async t => {
  t.mock.method(console, "error", () => {});
  t.mock.method(mongoose, "disconnect", async () => { throw new Error("Fixture"); });
  assert.equal(await disconnectDatabase(), false);
});

test("BNPB terminal drain waits for startup work and prevents a late refresh", async t => {
  t.mock.method(console, "log", () => {});
  let finish!: () => void, calls = 0, stopped = false;
  const gate = new Promise<void>(done => { finish = done; });
  const task = initBnpbCronJob("development", async () => { calls++; await gate; return new BnpbSyncCacheModel(); });
  try {
    await settle();
    const pending = task.stopAndDrain().then(() => { stopped = true; });
    await settle(); assert.equal(stopped, false); assert.equal(task.getStatus(), "stopped");
    finish(); await pending;
    await task.execute();
    assert.equal(calls, 1); assert.equal(stopped, true);
  } finally { finish(); await task.destroy(); }
});

test("satellite terminal drain waits for startup work and prevents a late refresh", async t => {
  t.mock.method(console, "info", () => {});
  let finish!: () => void, calls = 0, stopped = false;
  const gate = new Promise<void>(done => { finish = done; });
  const result = { skipped: false, failed: false, checked_at: new Date().toISOString(), sources: { fire: "ready", air: "ready", wind: "ready" } };
  const task = initSatelliteDevelopmentScheduler(async () => { calls++; await gate; return result; }, "development")!;
  try {
    await settle();
    const pending = task.stopAndDrain().then(() => { stopped = true; });
    await settle(); assert.equal(stopped, false); assert.equal(task.getStatus(), "stopped");
    finish(); await pending;
    await task.execute();
    assert.equal(calls, 1); assert.equal(stopped, true);
  } finally { finish(); await task.destroy(); }
});
// --- end of Readiness and scheduler drain ---
