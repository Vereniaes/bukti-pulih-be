// Todo:
// -> Verify BNPB source dates, failed checks and cached retrieval times.

// --- BNPB freshness tests ---
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import cron from "node-cron";
import { initBnpbCronJob } from "./bnpb.cron.js";
import { BnpbSyncCacheModel } from "./bnpb.model.js";
import { getBnpbKarhutlaService, syncBnpbKarhutlaData } from "./bnpb.service.js";
import { PlotModel } from "../plots/plot.model.js";

const NOW = Date.parse("2026-10-30T04:00:00Z");
const HOUR = 60 * 60 * 1000;
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const feature = (date: unknown = "2026-09-26", air: unknown = "Tidak Sehat"): { attributes: Record<string, unknown> } => ({ attributes: {
  provinsi: "Kalimantan Barat", tgl_update: date, today_luas_terbakar: 12.5,
  total_hotspot: 6, relawan: 0, kualitas_udara_pm25: air,
} });

function setup(t: TestContext, cached = true) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  let saved = cached ? new BnpbSyncCacheModel({
    source: "BNPB", layer: "mv_prov_karhutla_2026",
    sync_timestamp: new Date(NOW - HOUR), checked_at: new Date(NOW - HOUR),
    provinces: [{ provinsi: "Kalimantan Barat", tgl_update: "2026-09-26", kualitas_udara_pm25: "Tidak Sehat" }],
  }) : null;
  t.mock.method(BnpbSyncCacheModel, "findOne", async () => saved);
  t.mock.method(BnpbSyncCacheModel.prototype, "save", async function (this: InstanceType<typeof BnpbSyncCacheModel>) {
    saved = this; return this;
  });
  t.mock.method(PlotModel, "find", async () => [
    { region: "Kalimantan Barat", area_hectares: 2.5, current_alive: 90 },
    { region: "Kalimantan Timur", area_hectares: 8, current_alive: 100 },
  ]);
  return { current: () => saved };
}

test("successful retrieval keeps the provider's historical date separate from the fetch time", async t => {
  setup(t);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("where"), "objectid>0");
    assert.equal(url.searchParams.get("returnGeometry"), "false");
    assert.match(url.search, /where=objectid%3E0/);
    return Response.json({ features: [feature()] });
  });
  await syncBnpbKarhutlaData();
  const result = await getBnpbKarhutlaService();
  assert.equal(result.provinces[0].tgl_update, "2026-09-26");
  assert.equal(result.provinces[0].buktipulih_coverage.active_plots, 1);
  assert.equal(result.provinces[0].buktipulih_coverage.restored_area_ha, 2.5);
  assert.equal(result.provinces[0].buktipulih_coverage.alive_trees, 90);
  assert.equal(result.fetched_at, new Date(NOW).toISOString());
  assert.equal(result.checked_at, result.fetched_at);
  assert.equal(result.sync_timestamp, result.fetched_at);
  assert.equal(result.status, "ready");
  assert.equal(result.total_hectares_burned_national, 12.5);
});

test("missing dates, impossible dates and missing air quality remain unknown", async t => {
  setup(t, false);
  const omitted = feature();
  delete omitted.attributes.tgl_update;
  t.mock.method(globalThis, "fetch", async () => Response.json({ features: [
    feature(null, null), feature("2026-02-31", ""), omitted,
  ] }));
  const cache = await syncBnpbKarhutlaData();
  assert.ok(cache.provinces.every(province => province.tgl_update === null));
  assert.equal(cache.provinces[0].kualitas_udara_pm25, null);
  assert.equal(cache.provinces[1].kualitas_udara_pm25, null);
  assert.equal(cache.provinces[0].relawan_lapangan, 0);
});

test("missed scheduled refreshes cannot remain synchronized", async t => {
  const store = setup(t);
  store.current()!.sync_timestamp = new Date(NOW - 12 * HOUR);
  store.current()!.checked_at = null;
  t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected upstream request"); });
  const result = await getBnpbKarhutlaService();
  assert.equal(result.status, "cached");
  assert.equal(result.sync_status, "CACHED");
  assert.equal(result.fetched_at, new Date(NOW - 12 * HOUR).toISOString());
  assert.equal(result.checked_at, result.fetched_at);
});

test("failed refresh advances only the check time and preserves the successful snapshot", async t => {
  setup(t);
  t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
  await syncBnpbKarhutlaData();
  const result = await getBnpbKarhutlaService();
  assert.equal(result.status, "cached");
  assert.equal(result.fetched_at, new Date(NOW - HOUR).toISOString());
  assert.equal(result.checked_at, new Date(NOW).toISOString());
  assert.equal(result.provinces[0].tgl_update, "2026-09-26");
  assert.equal(result.provinces[0].kualitas_udara_pm25, "Tidak Sehat");
});

test("initial provider failure has no fabricated successful fetch time", async t => {
  setup(t, false);
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...values: unknown[]) => { warnings.push(values); });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("https://provider.invalid/private-key"); });
  const result = await getBnpbKarhutlaService();
  assert.equal(result.status, "unavailable");
  assert.equal(result.sync_status, "UNAVAILABLE");
  assert.equal(result.fetched_at, null);
  assert.equal(result.sync_timestamp, null);
  assert.equal(result.checked_at, new Date(NOW).toISOString());
  assert.deepEqual(result.provinces, []);
  assert.deepEqual(warnings, [["[BNPB Sync] Pembaruan gagal; snapshot terakhir dipertahankan.", { upstream_status: null }]]);
});

test("empty or invalid upstream features do not replace a dated snapshot", async t => {
  setup(t);
  for (const features of [[], [{ attributes: {} }]]) {
    t.mock.method(globalThis, "fetch", async () => Response.json({ features }));
    await syncBnpbKarhutlaData();
    const result = await getBnpbKarhutlaService();
    assert.equal(result.status, "cached");
    assert.equal(result.provinces[0].tgl_update, "2026-09-26");
    assert.equal(result.fetched_at, new Date(NOW - HOUR).toISOString());
  }
});

test("missing volunteers stay unknown without changing valid zero counts", async t => {
  setup(t);
  const row = feature();
  row.attributes.relawan = null;
  t.mock.method(globalThis, "fetch", async () => Response.json({ features: [row, feature()] }));
  await syncBnpbKarhutlaData();
  const result = await getBnpbKarhutlaService();
  assert.equal(result.provinces[0].relawan_lapangan, null);
  assert.equal(result.provinces[1].relawan_lapangan, 0);
  assert.equal(result.total_volunteers_national, null);
  assert.equal(result.status, "ready");
});

test("missing or malformed required numbers retain the previous snapshot", async t => {
  setup(t);
  for (const value of [null, "bad", -1]) {
    const row = feature();
    row.attributes.today_luas_terbakar = value;
    t.mock.method(globalThis, "fetch", async () => Response.json({ features: [row] }));
    await syncBnpbKarhutlaData();
    assert.equal((await getBnpbKarhutlaService()).status, "cached");
    assert.equal((await getBnpbKarhutlaService()).fetched_at, new Date(NOW - HOUR).toISOString());
  }
});

test("development catches up on startup while other environments keep the six-hour schedule", async () => {
  for (const mode of ["production", "development"]) {
    let calls = 0;
    const previous = new Set(cron.getTasks().keys());
    initBnpbCronJob(mode, async () => { calls++; return new BnpbSyncCacheModel(); });
    try {
      await settle();
      assert.equal(calls, mode === "development" ? 1 : 0);
    } finally {
      for (const task of cron.getTasks().values()) if (!previous.has(task.id)) await task.destroy();
    }
  }
});

for (const lateBy of [0, 3000, 2 * HOUR]) {
  test(`development catches up when the six-hour timer arrives ${lateBy} ms late`, async t => {
    t.mock.method(console, "log", () => {});
    const start = new Date(2026, 9, 30, 5, 59, 59).getTime();
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: start });
    let calls = 0;
    const task = initBnpbCronJob("development", async () => { calls++; return new BnpbSyncCacheModel(); });
    try {
      await settle();
      assert.equal(calls, 1);
      t.mock.timers.setTime(start + 1000 + lateBy);
      t.mock.timers.tick(0);
      await settle();
      assert.equal(calls, 2);
      await task.destroy();
      t.mock.timers.tick(6 * HOUR);
      await settle();
      assert.equal(calls, 2);
    } finally { await task.destroy(); }
  });
}

test("a scheduled refresh shares the unfinished startup operation", async t => {
  t.mock.method(console, "log", () => {});
  let calls = 0, finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const task = initBnpbCronJob("development", async () => { calls++; await gate; return new BnpbSyncCacheModel(); });
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

test("failed refresh logs no provider details and permits the next attempt", async t => {
  t.mock.method(console, "log", () => {});
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...values: unknown[]) => { errors.push(values); });
  let calls = 0;
  const task = initBnpbCronJob("development", async () => {
    if (++calls === 1) throw new Error("mongodb://private-user:password@provider.invalid");
    return new BnpbSyncCacheModel();
  });
  try {
    await settle();
    assert.deepEqual(errors, [["[Cron Worker] Pembaruan BNPB gagal."]]);
    await task.execute();
    assert.equal(calls, 2);
    assert.equal(errors.length, 1);
  } finally { await task.destroy(); }
});
// --- end of BNPB freshness tests ---
