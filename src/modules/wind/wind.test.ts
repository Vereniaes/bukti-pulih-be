// Verify source validation, shared fetching and bounded stale data.
import test from "node:test";
import assert from "node:assert/strict";
import {parseWind,createWindService} from "./wind.service.js";
const now=Date.parse("2026-10-27T00:00:00Z");
const row={latitude:-5,longitude:110,current:{time:now/1000,wind_speed_10m:0,wind_direction_10m:0},current_units:{wind_speed_10m:"km/h",wind_direction_10m:"°"}};
test("wind retains calm zeroes and drops missing or invalid readings",()=>{
  assert.equal(parseWind([row],now).points[0].speed_kmh,0);
  for(const bad of [null,{}, {...row,latitude:95},{...row,current_units:{}},{...row,current:{...row.current,wind_speed_10m:null}}, {...row,current:{...row.current,wind_direction_10m:361}}, {...row,current:{...row.current,time:now/1000-7200}}])assert.throws(()=>parseWind([bad],now));
  assert.equal(parseWind([row,null],now).points.length,1);
});
test("wind batches locations and shares requests, then expires stale data",async()=>{
  let calls=0,clock=now,fail=false;
  const read=createWindService(async(url)=>{calls++;assert.equal(new URL(String(url)).searchParams.get("latitude")?.split(",").length,40);if(fail)throw Error();return Response.json([row]);},()=>clock);
  const [a,b]=await Promise.all([read(),read()]);assert.deepEqual(a,b);assert.equal(calls,1);
  await read();assert.equal(calls,1);
  fail=true;clock+=16*60000;assert.equal((await read()).status,"cached");
  clock+=60*60000;await assert.rejects(read());
});
