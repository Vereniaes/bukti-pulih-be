// FIRMS contract tests use fixtures only. No production data or secrets.
import test from "node:test";
import assert from "node:assert/strict";
import { createHotspotService, HotspotError, parseHours, parseBounds, parseHotspots, Bounds } from "./hotspot.service.js";

const now = Date.parse("2026-10-18T00:30:00Z");
const header = "latitude,longitude,acq_date,acq_time,confidence,frp\n";
const row = "-0.85,109.85,2026-10-17,2350,n,12.5\n";
const source = "VIIRS_NOAA20_NRT";
const bounds: Bounds = [109, -2, 111, 1];
const key = () => "test-only-not-a-real-key";

test("CSV preserves categorical confidence, UTC time, and observation identity", () => {
  const csv = header + row + row + "-0.85,109.85,2026-10-18,0010,h,0\n";
  const result = parseHotspots(csv, source, now);
  assert.equal(result.length, 2);
  assert.equal(result[0].confidence, "nominal");
  assert.equal(result[0].observed_at, "2026-10-17T23:50:00.000Z");
  assert.equal(result[1].frp_mw, 0);
  assert.notEqual(result[0].id, parseHotspots(header + row, "VIIRS_NOAA21_NRT", now)[0].id);
});

test("rolling 24-hour window crosses UTC midnight", () => {
  const result = parseHotspots(header + row + "-0.85,109.85,2026-10-17,0029,l,1\n" +
    "-0.85,109.85,2026-10-18,0031,l,1\n", source, now);
  assert.equal(result.length, 1);
});

test("only identical records are removed, including optional source fields", () => {
  const csv = header.trimEnd() + ",bright_ti4\n" + row.trimEnd() + ",320\n" + row.trimEnd() + ",330\n";
  assert.equal(parseHotspots(csv, source, now).length, 2);
});

test("empty observations differ from malformed, rejected, and corrupt CSV", () => {
  assert.deepEqual(parseHotspots(header, source, now), []);
  for (const csv of ["", "Invalid MAP_KEY", "<html>rate limited</html>", header + row.replace("-0.85", "bad"), header + row.replace(",n,", ",91,"), header + row.replace("2026-10-17", "2026-02-31")]) {
    assert.throws(() => parseHotspots(csv, source, now));
  }
  assert.equal(parseHotspots(header + row.replace("12.5", ""), source, now)[0].frp_mw, null);
});

test("validate bounding box before requesting data", () => {
  assert.deepEqual(parseBounds("109,-2,111,1"), bounds);
  for (const input of [undefined, "", "a,b,c,d", "0,,1,2", "181,0,182,1", "1,1,0,0", "0,-91,2,1", ["0,0,1,1"]]) {
    assert.throws(() => parseBounds(input), (e: unknown) => e instanceof HotspotError && e.status === 400);
  }
});

test("parallel callers share the two source requests and cached results", async () => {
  const calls: string[] = [];
  const request: typeof fetch = async input => { calls.push(String(input)); return new Response(header + row); };
  const service = createHotspotService(key, request, () => now);
  const results = await Promise.all(Array.from({ length: 8 }, () => service(bounds)));
  assert.equal(calls.length, 2);
  assert(calls.every(url => url.endsWith("/2/2026-10-17")));
  assert.equal(results[0].observations.length, 2);
  await service(bounds);
  assert.equal(calls.length, 2);
});

test("a failed satellite yields a partial result, not a complete count", async () => {
  const request: typeof fetch = async input => String(input).includes("NOAA21")
    ? new Response("rate limited", { status: 429 }) : new Response(header + row);
  const result = await createHotspotService(key, request, () => now)(bounds);
  assert.equal(result.status, "partial");
  assert.equal(result.observations.length, 1);
  assert.equal(result.sources[1].available, false);
});

test("upstream failure retains dated cache and never includes a key in errors", async () => {
  let time = now, fail = false;
  const request: typeof fetch = async () => { if (fail) throw new Error(key()); return new Response(header + row); };
  const service = createHotspotService(key, request, () => time);
  const original = await service(bounds);
  time += 16 * 60000; fail = true;
  const saved = await service(bounds);
  assert.equal(saved.status, "cached");
  assert.equal(saved.fetched_at, original.fetched_at);
  const unavailable = createHotspotService(key, request, () => time);
  await assert.rejects(unavailable(bounds), (e: unknown) => e instanceof HotspotError && !e.message.includes(key()));
});

test("missing key does not call NASA and does not return synthetic observations", async () => {
  let calls = 0;
  const request: typeof fetch = async () => { calls++; return new Response(header); };
  await assert.rejects(createHotspotService(() => "", request)(bounds), (e: unknown) => e instanceof HotspotError && e.code === "FIRMS_NOT_CONFIGURED");
  assert.equal(calls, 0);
});

test("optional time windows validate and preserve the 24-hour default",()=>{
  assert.equal(parseHours(undefined),24);
  for(const hours of [6,12,24,72])assert.equal(parseHours(String(hours)),hours);
  for(const hours of ["0","7","73",null,[],"72x"])assert.throws(()=>parseHours(hours));
});
test("72-hour requests include four UTC dates and cache their own full rolling window",async()=>{
  const urls:string[]=[];
  const csv=header+row+"-0.85,109.85,2026-10-15,0030,h,8\n"+"-0.85,109.85,2026-10-15,0029,n,2\n";
  let clock=now;
  const service=createHotspotService(key,async(input)=>{urls.push(String(input));return new Response(csv);},()=>clock);
  assert.equal((await service(bounds,72)).observations.length,4);
  assert.ok(urls.every(url=>url.includes("/109,-2,111,1/4/2026-10-15")));
  clock+=60000;
  assert.equal((await service(bounds,72)).observations.length,2);
  assert.equal(urls.length,2);
  await service(bounds);assert.equal(urls.length,4);
  assert.ok(urls[2].includes("/109,-2,111,1/2/2026-10-17"));
});
