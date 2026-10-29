// Verify historical dates, NASA product planning and bounded cached reads.
import test from "node:test";
import assert from "node:assert/strict";
import { createHotspotHistoryService, parseAvailability, parseHotspotRange } from "../src/modules/hotspots/hotspot-history.service.js";
import { HotspotError, type Bounds } from "../src/modules/hotspots/hotspot.service.js";
const NOW=Date.parse("2026-10-28T12:30:00Z"),DAY=86400000;
const BOUNDS:Bounds=[94,-12,142,8],KEY="fixture-key-only";
const CATALOG="data_id,min_date,max_date\nVIIRS_NOAA20_NRT,2026-08-01,2026-10-27\nVIIRS_NOAA20_SP,2018-04-01,2026-07-31\nVIIRS_NOAA21_NRT,2024-01-17,2026-10-27\nVIIRS_NOAA21_SP,2023-03-01,2026-07-31\n";
const HEADER="latitude,longitude,acq_date,acq_time,confidence,frp\n";
const interval=(start:string,end:string)=>parseHotspotRange(start,end,NOW);
function provider(calls:string[],fail:()=>boolean=()=>false):typeof fetch {
 return async(input)=>{
  const url=String(input);calls.push(url);
  if(fail())throw new Error(KEY);
  if(url.includes("data_availability"))return new Response(CATALOG);
  const parts=url.split("/"),start=Date.parse(parts.at(-1)!+"T00:00:00Z"),days=Number(parts.at(-2));
  let csv=HEADER;
  for(let i=0;i<days;i++) {
   const date=new Date(start+i*DAY).toISOString().slice(0,10);
   const row=`-2,110,${date},1300,n,10\n`;
   csv+=row+row+`-2,180,${date},1300,n,10\n`;
  }
  return new Response(csv);
 };
}
test("UTC range parser rejects missing, invalid, future and more than five days",()=>{
 assert.equal(interval("2020-01-01T00:00:00Z","2020-01-06T00:00:00Z").end,Date.parse("2020-01-06T00:00:00Z"));
 for(const [start,end] of [[undefined,undefined],["bad","bad"],["2026-02-31T00:00:00Z","2026-03-01T00:00:00Z"],["2026-10-28T00:00:00Z","2026-10-29T00:00:00Z"],["2020-01-01T00:00:00Z","2020-01-06T00:00:01Z"],["2020-01-01T00:00:00Z","2020-01-01T00:00:00Z"]])
  assert.throws(()=>parseHotspotRange(start,end,NOW),(e:unknown)=>e instanceof HotspotError&&e.code==="INVALID_TIME_RANGE");
});
test("catalog preserves NASA min/max dates and rejects malformed metadata",()=>{
 assert.equal(parseAvailability(CATALOG,NOW).sources.length,4);
 for(const csv of ["Invalid MAP_KEY","data_id,min_date,max_date\nVIIRS_NOAA20_SP,2020-02-31,2026-07-31","data_id,min_date,max_date\nMODIS_SP,2000-01-01,2026-01-01"])
  assert.throws(()=>parseAvailability(csv,NOW));
});
test("SP is preferred over overlapping NRT and transitions use the true product",async()=>{
 const calls:string[]=[];const service=createHotspotHistoryService(()=>KEY,provider(calls),()=>NOW);
 const range=interval("2026-07-30T17:00:00Z","2026-08-02T01:00:00Z");
 const values=await Promise.all(Array.from({length:5},()=>service.read(BOUNDS,range)));
 assert.equal(calls.length,5);assert.equal(calls.filter(url=>url.includes("data_availability")).length,1);
 assert.ok(calls.some(url=>url.includes("VIIRS_NOAA21_SP/")&&url.endsWith("/2/2026-07-30")));
 assert.ok(calls.some(url=>url.includes("VIIRS_NOAA21_NRT/")&&url.endsWith("/2/2026-08-01")));
 assert.equal(values[0].observations.length,4);assert.equal(values[0].status,"complete");
 assert.equal(new Set(values[0].observations.map(p=>p.id)).size,4);
 assert.ok(values[0].observations.some(p=>p.satellite==="VIIRS_NOAA20_SP"));
 await service.read(BOUNDS,range);assert.equal(calls.length,5);
});
test("a five-day WIB-sized interval touching six UTC dates is split at NASA's limit",async()=>{
 const calls:string[]=[];const service=createHotspotHistoryService(()=>KEY,provider(calls),()=>NOW);
 await service.read(BOUNDS,interval("2020-07-01T12:00:00Z","2020-07-06T11:00:00Z"));
 const areas=calls.filter(url=>url.includes("/area/"));assert.equal(areas.length,2);
 assert.ok(areas.every(url=>Number(url.split("/").at(-2))<=5));
 assert.ok(areas.every(url=>url.includes("VIIRS_NOAA20_SP")));
});
test("unavailable dates differ from a valid empty observation result",async()=>{
 const calls:string[]=[];const service=createHotspotHistoryService(()=>KEY,provider(calls),()=>NOW);
 await assert.rejects(service.read(BOUNDS,interval("2017-01-01T00:00:00Z","2017-01-02T00:00:00Z")),(e:unknown)=>e instanceof HotspotError&&e.code==="HOTSPOT_DATE_UNAVAILABLE");
 assert.equal(calls.filter(url=>url.includes("/area/")).length,0);
 const empty=createHotspotHistoryService(()=>KEY,async input=>new Response(String(input).includes("data_availability")?CATALOG:HEADER),()=>NOW);
 const result=await empty.read(BOUNDS,interval("2020-07-01T00:00:00Z","2020-07-02T00:00:00Z"));
 assert.equal(result.status,"complete");assert.deepEqual(result.observations,[]);
});
test("partly unavailable dates and a failed product are reported as partial",async()=>{
 const calls:string[]=[];const request=provider(calls);
 const service=createHotspotHistoryService(()=>KEY,async(input,init)=>String(input).includes("/VIIRS_NOAA21_NRT/")?new Response("failure",{status:503}):request(input,init),()=>NOW);
 const result=await service.read(BOUNDS,interval("2026-10-27T00:00:00Z","2026-10-28T12:00:00Z"));
 assert.equal(result.status,"partial");assert.equal(result.observations.length,1);
 assert.equal(result.sources.find(p=>p.name==="VIIRS_NOAA21_NRT")?.available,false);
});
test("historical cache survives provider failure without advancing the selected window or leaking keys",async()=>{
 let now=NOW,fail=false;const calls:string[]=[];
 const service=createHotspotHistoryService(()=>KEY,provider(calls,()=>fail),()=>now);
 const range=interval("2020-07-01T00:00:00Z","2020-07-02T00:00:00Z");
 const original=await service.read(BOUNDS,range);now+=16*60000;fail=true;
 const cached=await service.read(BOUNDS,range);assert.equal(cached.status,"cached");assert.equal(cached.fetched_at,original.fetched_at);assert.deepEqual(cached.observations,original.observations);
 const unavailable=createHotspotHistoryService(()=>KEY,provider([],()=>true),()=>now);
 await assert.rejects(unavailable.read(BOUNDS,range),(e:unknown)=>e instanceof HotspotError&&!e.message.includes(KEY));
 let count=0;const missing=createHotspotHistoryService(()=>"",async()=>{count++;throw new Error();},()=>now);
 await assert.rejects(missing.availability());assert.equal(count,0);
});
