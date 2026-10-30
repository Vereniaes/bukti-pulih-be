// Todo:
// -> Verify local startup catch-up, scheduling and recovery without providers.

// --- Local scheduler behavior ---
import test from "node:test";
import assert from "node:assert/strict";
import { initSatelliteDevelopmentScheduler } from "../src/modules/satellite/satellite.cron.js";

const result = { skipped: false, failed: false, checked_at: "2026-10-30T03:45:00Z", sources: { fire: "ready", air: "ready", wind: "ready" } };
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test("development refreshes immediately and retains the quarter-hour schedule", async t => {
  t.mock.method(console, "info", () => {});
  let calls = 0;
  const task = initSatelliteDevelopmentScheduler(async () => { calls++; return result; }, "development")!;
  try {
    await settle();
    assert.equal(calls, 1);
    assert.equal(task.getPattern(), "*/15 * * * *");
    assert.equal(task.getStatus(), "idle");
    assert.ok(task.getNextRun() instanceof Date);
    assert.ok(task.match(new Date("2026-10-30T03:45:00Z")));
    assert.equal(task.match(new Date("2026-10-30T03:46:00Z")), false);
    await task.execute();
    assert.equal(calls, 2);
  } finally { await task.destroy(); }
});

test("production and tests never start the local sync operation", async () => {
  let calls = 0;
  for (const mode of ["production", "test"]) {
    assert.equal(initSatelliteDevelopmentScheduler(async () => { calls++; return result; }, mode), undefined);
  }
  assert.equal(calls, 0);
});

for (const lateBy of [0, 3000, 2 * 60 * 60_000]) {
  test(`timer refreshes after a quarter-hour tick delivered ${lateBy} ms late`, async t => {
    t.mock.method(console, "info", () => {});
    const start = Date.parse("2026-10-30T03:44:59Z");
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: start });
    let calls = 0;
    const task = initSatelliteDevelopmentScheduler(async () => { calls++; return result; }, "development")!;
    try {
      await settle();
      assert.equal(calls, 1);
      t.mock.timers.setTime(start + 1000 + lateBy);
      t.mock.timers.tick(0);
      await settle();
      assert.equal(calls, 2);
      await task.destroy();
      t.mock.timers.tick(15 * 60_000);
      await settle();
      assert.equal(calls, 2);
    } finally { await task.destroy(); }
  });
}

test("a scheduled run shares an unfinished startup refresh", async t => {
  t.mock.method(console, "info", () => {});
  let calls = 0, finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const task = initSatelliteDevelopmentScheduler(async () => { calls++; await gate; return result; }, "development")!;
  try {
    const tick = task.execute();
    await settle();
    assert.equal(calls, 1);
    finish();
    await tick;
    await task.execute();
    assert.equal(calls, 2);
  } finally { finish(); await task.destroy(); }
});

test("a failed startup logs no provider detail and the next run can recover", async t => {
  t.mock.method(console, "info", () => {});
  const failures: string[] = [];
  t.mock.method(console, "error", (value: string) => { failures.push(value); });
  let calls = 0;
  const task = initSatelliteDevelopmentScheduler(async () => {
    if (++calls === 1) throw new Error("https://provider.invalid/private-key");
    return result;
  }, "development")!;
  try {
    await settle();
    assert.equal(failures.length, 1);
    assert.deepEqual(JSON.parse(failures[0]), { event: "satellite_sync", failed: true, error: "SYNC_UNAVAILABLE" });
    await task.execute();
    assert.equal(calls, 2);
    assert.equal(failures.length, 1);
  } finally { await task.destroy(); }
});
// --- end of Local scheduler behavior ---
