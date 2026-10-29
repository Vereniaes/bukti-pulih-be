// Check ISPU parsing, cache behavior and request safety.
import test from "node:test";
import assert from "node:assert/strict";
import { createIspuService, parseIspuDetail, parseIspuStations } from "./ispu.service.js";

const now = Date.parse("2026-10-27T12:00:00Z");
const row = {
  id_stasiun: "STATION_1", nama: "Station One", alamat: "Address", provinsi: "Jawa Barat",
  lat: "-6.2", lon: "106.8", val: "0", cat: "BAIK", param: "PM<sub>2.5</sub>",
  waktu: "2026-10-27 19:00:00", time_z: "WIB", tipe_text: "KLH/BPLH",
  stasiun_show: "1", is_maintenance: "0",
};
const detailRow = { id_stasiun: "STATION_1", pm10: "0", pm25: "8", so2: "0", co: null, o3: "3", no2: "4", hc: "0",
  a_pm10: 999, t_pm10: 1000 };
const stationsPayload = { rows: [row] };
const detailPayload = { rows: [detailRow] };
const response = (payload: unknown) => Response.json(payload);

test("station parser preserves zero, maps timezone/category and strips provider HTML", () => {
  const parsed = parseIspuStations({ rows: [row, null, { ...row, id_stasiun: "bad", lat: "91" }] }, now);
  assert.equal(parsed.stations.length, 1);
  assert.equal(parsed.stations[0].value, 0);
  assert.deepEqual(parsed.stations[0].coordinates, [-6.2, 106.8]);
  assert.equal(parsed.stations[0].dominant_pollutant, "PM2.5");
  assert.equal(parsed.stations[0].observed_at, "2026-10-27T12:00:00.000Z");
  assert.equal(parsed.stations[0].category, "BAIK");
  assert.equal(JSON.stringify(parsed).includes("<sub>"), false);
});
test("station parser drops malformed time, invalid coordinates, hidden and maintained stations", () => {
  for (const bad of [
    { ...row, waktu: "not a date" }, { ...row, time_z: "UTC" }, { ...row, waktu: "2026-02-30 10:00:00" },
    { ...row, lon: "181" }, { ...row, val: null }, { ...row, stasiun_show: "0" }, { ...row, is_maintenance: "1" },
    { ...row, cat: "UNKNOWN" }, { ...row, id_stasiun: "https://example.test" },
  ]) assert.throws(() => parseIspuStations({ rows: [bad] }, now), /ISPU_UNAVAILABLE/);
});
test("detail reads ISPU indices only, retaining zero and missing values as null", () => {
  const station = parseIspuStations(stationsPayload, now).stations[0];
  const parsed = parseIspuDetail(detailPayload, station, now);
  assert.deepEqual(parsed.pollutants.map(p => p.index), [0, 8, 0, null, 3, 4, 0]);
  assert.throws(() => parseIspuDetail({ rows: [{ ...detailRow, id_stasiun: "OTHER" }] }, station), /ISPU_UNAVAILABLE/);
});
test("service shares requests, caches five minutes and limits detail IDs to current stations", async () => {
  let calls = 0, clock = now, authReads = 0;
  const fetcher: typeof fetch = async (input, init) => {
    calls++;
    assert.equal((init?.headers as Record<string, string>).Authorization, "token");
    const url = String(input);
    return response(url.endsWith("/stasiun") ? stationsPayload : detailPayload);
  };
  const service = createIspuService(() => { authReads++; return "token"; }, fetcher, () => clock);
  const [a, b] = await Promise.all([service.stations(), service.stations()]);
  assert.deepEqual(a, b); assert.equal(calls, 1);
  await service.stations(); assert.equal(calls, 1);
  const [d1, d2] = await Promise.all([service.detail("STATION_1"), service.detail("STATION_1")]);
  assert.deepEqual(d1, d2); assert.equal(calls, 2);
  assert.equal(authReads, 2);
  await assert.rejects(service.detail("../etc"), /ISPU_UNAVAILABLE/);
  await assert.rejects(service.detail("OTHER"), /ISPU_UNAVAILABLE/);
  clock += 6 * 60_000; await service.stations(); assert.equal(calls, 3);
});
test("service uses labeled cached snapshots for at most one hour on fetch failure", async () => {
  let calls = 0, clock = now, fail = false;
  const service = createIspuService(() => "token", async url => {
    calls++; if (fail) throw new Error("offline");
    return response(String(url).endsWith("/stasiun") ? stationsPayload : detailPayload);
  }, () => clock);
  await service.stations();
  const firstDetail = await service.detail("STATION_1");
  fail = true; clock += 6 * 60_000;
  assert.equal((await service.stations()).status, "cached");
  assert.equal((await service.detail("STATION_1")).status, "cached");
  assert.equal(firstDetail.fetched_at, (await service.detail("STATION_1")).fetched_at);
  clock += 61 * 60_000;
  await assert.rejects(service.stations(), /ISPU_UNAVAILABLE/);
  assert.ok(calls >= 4);
});


test("station-local WIB, WITA and WIT times normalize to the same UTC instant", () => {
  for (const [zone,hour] of [["WIB","19"],["WITA","20"],["WIT","21"]]) {
    assert.equal(parseIspuStations({rows:[{...row,time_z:zone,waktu:`2026-10-27 ${hour}:00:00`}]},now).stations[0].observed_at,"2026-10-27T12:00:00.000Z");
  }
  assert.equal(parseIspuStations({rows:[{...row,time_z:"WIT",waktu:"2026-10-27 01:00:00"}]},now).stations[0].observed_at,"2026-10-26T16:00:00.000Z");
});
test("detail uses the source observation time and rejects negative subindices", () => {
  const station=parseIspuStations(stationsPayload,now).stations[0];
  const result=parseIspuDetail({rows:[{...detailRow,val:"51",cat:"SEDANG",time_z:"WITA",waktu_24:["2026-10-27 20:00:00"],pm10:"-1"}]},station,now);
  assert.equal(result.station.value,51);assert.equal(result.station.category,"SEDANG");
  assert.equal(result.station.observed_at,"2026-10-27T12:00:00.000Z");assert.equal(result.pollutants[0].index,null);
  assert.throws(()=>parseIspuStations({rows:[{...row,val:"-1"}]},now));
});
