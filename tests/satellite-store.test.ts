// Verify compressed snapshots, failure retention and distributed refresh leases.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { mongoSnapshotStore } from "../src/modules/satellite/satellite.store.js";

const dbName = `buktipulih_satellite_test_${process.pid}`;
const t0 = new Date("2026-10-27T00:00:00Z");
before(async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27017/${dbName}`);
});
after(async () => {
  assert.equal(mongoose.connection.name, dbName);
  assert.match(mongoose.connection.name, /^buktipulih_satellite_test_/);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("compressed snapshots above BSON document size round-trip with metadata", async () => {
  const data = { fetched_at: t0.toISOString(), payload: "x".repeat(17 * 1024 * 1024) };
  const checkedAt = new Date(t0.getTime() + 1000).toISOString();
  await mongoSnapshotStore.write("fire", data, checkedAt);
  const saved = await mongoSnapshotStore.read<typeof data>("fire");
  assert.deepEqual(saved, { data, fetched_at: t0.toISOString(), checked_at: checkedAt, failed: false });
});
test("failed checks retain last good payload and source timestamp", async () => {
  const data = { fetched_at: t0.toISOString(), readings: [0, 1, null] };
  await mongoSnapshotStore.write("air", data, t0.toISOString());
  const checkedAt = new Date(t0.getTime() + 15 * 60_000).toISOString();
  await mongoSnapshotStore.fail("air", checkedAt);
  assert.deepEqual(await mongoSnapshotStore.read<typeof data>("air"), {
    data, fetched_at: t0.toISOString(), checked_at: checkedAt, failed: true,
  });
  await mongoSnapshotStore.fail("missing", checkedAt);
  assert.deepEqual(await mongoSnapshotStore.read("missing"), { data: null, fetched_at: null, checked_at: checkedAt, failed: true });
});
test("writes reject invalid timestamps and cannot replace a newer snapshot", async () => {
  const newer = { fetched_at: new Date(t0.getTime() + 60_000).toISOString(), value: "new" };
  await mongoSnapshotStore.write("wind", newer, newer.fetched_at);
  await mongoSnapshotStore.write("wind", { fetched_at: t0.toISOString(), value: "old" }, t0.toISOString());
  assert.deepEqual(await mongoSnapshotStore.read("wind"), {
    data: newer, fetched_at: newer.fetched_at, checked_at: newer.fetched_at, failed: false,
  });
  const oversized = { fetched_at: newer.fetched_at, payload: "x".repeat(64 * 1024 * 1024 + 1) };
  await assert.rejects(mongoSnapshotStore.write("wind", oversized, newer.fetched_at), /SNAPSHOT_TOO_LARGE/);
  assert.deepEqual(await mongoSnapshotStore.read("wind"), {
    data: newer, fetched_at: newer.fetched_at, checked_at: newer.fetched_at, failed: false,
  });
  await assert.rejects(mongoSnapshotStore.write("wind", { fetched_at: "invalid" }, t0.toISOString()), /INVALID_SNAPSHOT_DATE/);
  await assert.rejects(mongoSnapshotStore.write("wind", { fetched_at: t0.toISOString() }, "invalid"), /INVALID_SNAPSHOT_DATE/);
});
test("corrupt and oversized stored compressed payloads are rejected", async () => {
  await mongoSnapshotStore.write("bad", { fetched_at: t0.toISOString(), value: true }, t0.toISOString());
  await mongoose.connection.collection<{ _id: string; payload: Buffer }>("satellite_snapshots").updateOne({ _id: "bad" }, { $set: { payload: Buffer.from("corrupt") } });
  await assert.rejects(mongoSnapshotStore.read("bad"));
  await mongoose.connection.collection<{ _id: string; payload: Buffer }>("satellite_snapshots").updateOne({ _id: "bad" }, { $set: { payload: Buffer.alloc(12 * 1024 * 1024 + 1) } });
  await assert.rejects(mongoSnapshotStore.read("bad"), /SNAPSHOT_TOO_LARGE/);
});
test("leases have one winner, dedupe released slots and protect newer owners", async () => {
  const results = await Promise.all([
    mongoSnapshotStore.claim("slot-a", "worker-a", t0), mongoSnapshotStore.claim("slot-a", "worker-b", t0),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  const winner = results[0] ? "worker-a" : "worker-b";
  await mongoSnapshotStore.release(winner);
  assert.equal(await mongoSnapshotStore.claim("slot-a", "retry", t0), false);
  assert.equal(await mongoSnapshotStore.claim("slot-b", "worker-c", t0), true);
  await mongoSnapshotStore.release(winner);
  assert.equal(await mongoSnapshotStore.claim("slot-c", "worker-d", t0), false);
  assert.equal(await mongoSnapshotStore.claim("slot-c", "worker-e", new Date(t0.getTime() + 5 * 60_000)), true);
});
