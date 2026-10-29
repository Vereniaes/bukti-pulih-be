// Exercise scheduled snapshots, freshness rules and persisted station details without provider or database access.
import test from "node:test";
import assert from "node:assert/strict";
import { createSatelliteService, SATELLITE_BOUNDS, SATELLITE_INTERVAL_MS } from "../src/modules/satellite/satellite.service.js";
import type { Bounds, HotspotHours, HotspotObservation, HotspotResult } from "../src/modules/hotspots/hotspot.service.js";
import type { WindResult } from "../src/modules/wind/wind.service.js";
import type { IspuDetail, IspuResult, IspuStation } from "../src/modules/ispu/ispu.service.js";
import type { Snapshot, SnapshotStore } from "../src/modules/satellite/satellite.store.js";

const HOUR=3_600_000, DAY=24*HOUR, T0=Date.parse("2026-10-27T00:00:00Z");
type Feed="fire"|"air"|"wind";

class MemorySnapshotStore implements SnapshotStore {
  records=new Map<string,Snapshot<unknown>>();
  failWrites=new Set<string>();failFailures=new Set<string>();
  lastSlot="";owner="";leaseUntil=0;releases=0;
  async read<T>(key:string):Promise<Snapshot<T>|null> { return structuredClone(this.records.get(key) as Snapshot<T>|undefined ?? null); }
  async write<T extends {fetched_at:string}>(key:string,data:T,checkedAt:string) {
    if(this.failWrites.has(key))throw new Error("WRITE_FAILED");
    this.records.set(key,{data:structuredClone(data),fetched_at:data.fetched_at,checked_at:checkedAt,failed:false});
  }
  async fail(key:string,checkedAt:string) {
    if(this.failFailures.has(key))throw new Error("FAIL_UPDATE_FAILED");
    const saved=this.records.get(key);
    this.records.set(key,{data:saved?.data??null,fetched_at:saved?.fetched_at??null,checked_at:checkedAt,failed:true});
  }
  async claim(slot:string,owner:string,now:Date) {
    if(this.lastSlot===slot||this.leaseUntil>now.getTime())return false;
    this.lastSlot=slot;this.owner=owner;this.leaseUntil=now.getTime()+240_000;return true;
  }
  async release(owner:string) { if(owner===this.owner){this.leaseUntil=0;this.releases++;} }
}

function hotspot(id:string,satellite:"VIIRS_NOAA20_NRT"|"VIIRS_NOAA21_NRT",age:number,coordinates:[number,number]=[-1,110]):HotspotObservation {
  return {id,satellite,coordinates,observed_at:new Date(T0-age).toISOString(),confidence:"high",frp_mw:1};
}
function fire(now=T0,observations:HotspotObservation[]=[hotspot("fire", "VIIRS_NOAA20_NRT",HOUR)]):HotspotResult {
  return {observations,bounds:SATELLITE_BOUNDS,fetched_at:new Date(now).toISOString(),observed_at:observations[0]?.observed_at??null,status:"complete",
    sources:[{name:"VIIRS_NOAA20_NRT",available:true},{name:"VIIRS_NOAA21_NRT",available:true}]};
}
const wind=(now=T0):WindResult=>({points:[{id:"0,100",coordinates:[0,100],speed_kmh:12,direction_deg:90,observed_at:new Date(now).toISOString()}],fetched_at:new Date(now).toISOString(),source:"ECMWF",status:"ready"});
const station:IspuStation={id:"DKI_001",name:"Station One",address:"Jakarta",province:"DKI Jakarta",coordinates:[-6.2,106.8],value:40,category:"BAIK",dominant_pollutant:"PM2.5",observed_at:new Date(T0).toISOString(),station_type:"KLH/BPLH"};
const air=(now=T0):IspuResult=>({stations:[{...station}],fetched_at:new Date(now).toISOString(),source:"KLH/BPLH",status:"ready"});
const detail=(now=T0):IspuDetail=>({station:{...station},pollutants:[{key:"pm25",label:"PM2.5",index:40}],fetched_at:new Date(now).toISOString(),status:"ready"});
type ProviderOverrides=Partial<{fire:(bounds:Bounds,hours:HotspotHours)=>Promise<HotspotResult>;wind:()=>Promise<WindResult>;air:()=>Promise<IspuResult>;detail:(id:string,station:IspuStation)=>Promise<IspuDetail>}>;
function providers(overrides:ProviderOverrides={}) {
  return {fire:async()=>fire(),wind:async()=>wind(),air:async()=>air(),detail:async()=>detail(),...overrides};
}
const snapshot=<T>(data:T&{fetched_at:string},checkedAt=new Date(T0).toISOString(),failed=false):Snapshot<T>=>({data:structuredClone(data),fetched_at:data.fetched_at,checked_at:checkedAt,failed});

 test("sync persists fire, air and wind independently with the fixed 72 hour coverage",async()=>{
  const store=new MemorySnapshotStore();let fireArgs:unknown[]=[];
  const service=createSatelliteService(store,providers({fire:async(bounds,hours)=>{fireArgs=[bounds,hours];return fire();}}),()=>T0);
  const result=await service.sync("slot-a");
  assert.equal(result.failed,false);assert.deepEqual(result.sources,{fire:"ready",air:"ready",wind:"ready"});
  assert.deepEqual(fireArgs,[SATELLITE_BOUNDS,72]);
  for(const key of ["fire","air","wind"] as Feed[])assert.equal((await store.read(key))?.failed,false);
  assert.equal(store.releases,1);
});

test("a failed feed retains its last good snapshot while the other feeds refresh",async()=>{
  const store=new MemorySnapshotStore();
  store.records.set("fire",snapshot(fire(T0-2*HOUR)));store.records.set("air",snapshot(air(T0-2*HOUR)));store.records.set("wind",snapshot(wind(T0-2*HOUR)));
  const service=createSatelliteService(store,providers({air:async()=>{throw new Error("offline");}}),()=>T0);
  const result=await service.sync("slot-b");
  assert.deepEqual(result.sources,{fire:"ready",air:"unavailable",wind:"ready"});
  const savedAir=await store.read<IspuResult>("air"),savedWind=await store.read<WindResult>("wind");
  assert.equal(savedAir?.fetched_at,new Date(T0-2*HOUR).toISOString());assert.equal(savedAir?.failed,true);
  assert.equal(savedWind?.fetched_at,new Date(T0).toISOString());assert.equal(savedWind?.failed,false);
});

test("provider cached responses are failures and are not promoted to fresh snapshots",async()=>{
  const store=new MemorySnapshotStore();store.records.set("wind",snapshot({...wind(T0-20*60_000),status:"ready"}));
  const service=createSatelliteService(store,providers({wind:async()=>({...wind(),status:"cached"})}),()=>T0);
  const result=await service.sync("slot-c");const saved=await store.read<WindResult>("wind");
  assert.equal(result.sources.wind,"unavailable");assert.equal(saved?.fetched_at,new Date(T0-20*60_000).toISOString());assert.equal(saved?.failed,true);
});

test("same-slot and concurrent refreshes allow only one provider set",async()=>{
  const store=new MemorySnapshotStore();let calls=0;
  const service=createSatelliteService(store,providers({fire:async()=>{calls++;return fire();},air:async()=>{calls++;return air();},wind:async()=>{calls++;return wind();}}),()=>T0);
  const [a,b]=await Promise.all([service.sync("slot-d"),service.sync("slot-d")]);
  assert.equal(calls,3);assert.equal([a,b].filter(result=>result.skipped).length,1);
  assert.equal((await service.sync("slot-d")).skipped,true);assert.equal(calls,3);
  assert.equal((await service.sync("slot-e")).skipped,false);assert.equal(calls,6);
});

test("the lease is released after a snapshot write and failure-marker both fail",async()=>{
  const store=new MemorySnapshotStore();store.failWrites.add("wind");store.failFailures.add("wind");let calls=0;
  const service=createSatelliteService(store,providers({wind:async()=>{calls++;return wind();}}),()=>T0);
  await assert.rejects(service.sync("slot-f"),/FAIL_UPDATE_FAILED/);assert.equal(store.releases,1);
  store.failWrites.clear();store.failFailures.clear();
  assert.equal((await service.sync("slot-g")).skipped,false);assert.equal(calls,2);
});

test("hotspot reads trim all supported windows and bounds without provider calls",async()=>{
  const store=new MemorySnapshotStore(),observations=[hotspot("1h","VIIRS_NOAA20_NRT",HOUR),hotspot("10h","VIIRS_NOAA20_NRT",10*HOUR),hotspot("23h","VIIRS_NOAA21_NRT",23*HOUR),hotspot("71h","VIIRS_NOAA21_NRT",71*HOUR),hotspot("outside","VIIRS_NOAA21_NRT",HOUR,[-1,150])];
  store.records.set("fire",snapshot(fire(T0,observations)));let calls=0;
  const service=createSatelliteService(store,providers({fire:async()=>{calls++;return fire();}}),()=>T0);
  for(const [hours,count] of [[6,1],[12,2],[24,3],[72,4]] as const)assert.equal((await service.hotspots(SATELLITE_BOUNDS,hours)).observations.length,count);
  assert.equal(calls,0);await assert.rejects(service.hotspots([0,0,1,1]),/INVALID_BOUNDS/);assert.equal(calls,0);
});

test("stale snapshots are labeled cached and expired feed age is rejected",async()=>{
  const store=new MemorySnapshotStore(),checked=new Date(T0-31*60_000).toISOString();
  store.records.set("fire",snapshot(fire(T0-30*60_000),checked));store.records.set("air",snapshot(air(T0-30*60_000),checked));store.records.set("wind",snapshot(wind(T0-30*60_000),checked));
  let now=T0;const service=createSatelliteService(store,providers(),()=>now);
  assert.equal((await service.hotspots(SATELLITE_BOUNDS,72)).status,"cached");assert.equal((await service.air()).status,"cached");assert.equal((await service.wind()).status,"cached");
  const status=await service.status();assert.equal(status.refresh_seconds,SATELLITE_INTERVAL_MS/1000);assert.equal(status.sources.fire.status,"cached");
  now=T0+25*HOUR;await assert.rejects(service.hotspots(SATELLITE_BOUNDS),/FIRMS_UNAVAILABLE/);
  await assert.rejects(service.air(),/WIND|ISPU_UNAVAILABLE/);await assert.rejects(service.wind(),/WIND_UNAVAILABLE/);
});

test("complete empty fire data is a valid successful snapshot",async()=>{
  const store=new MemorySnapshotStore(),service=createSatelliteService(store,providers({fire:async()=>fire(T0,[])}),()=>T0);
  await service.sync("slot-h");const result=await service.hotspots(SATELLITE_BOUNDS,72);
  assert.deepEqual(result.observations,[]);assert.equal(result.observed_at,null);assert.equal(result.status,"complete");
});

test("partial NASA results retain only recent observations from the unavailable satellite",async()=>{
  const store=new MemorySnapshotStore();
  const previous=fire(T0-1*HOUR,[hotspot("keep","VIIRS_NOAA20_NRT",20*HOUR),hotspot("expire","VIIRS_NOAA20_NRT",73*HOUR),hotspot("replace","VIIRS_NOAA21_NRT",18*HOUR)]);
  store.records.set("fire",snapshot(previous));
  const current:HotspotResult={...fire(T0,[hotspot("new","VIIRS_NOAA21_NRT",HOUR)]),status:"partial",sources:[{name:"VIIRS_NOAA20_NRT",available:false},{name:"VIIRS_NOAA21_NRT",available:true}]};
  const service=createSatelliteService(store,providers({fire:async()=>current}),()=>T0);await service.sync("slot-i");
  const saved=await store.read<HotspotResult>("fire");assert.deepEqual(saved?.data?.observations.map(point=>point.id).sort(),["keep","new"]);
  assert.equal(saved?.data?.status,"partial");
});

test("station details coalesce, persist across service instances and retain one-hour stale data",async()=>{
  const store=new MemorySnapshotStore();store.records.set("air",snapshot(air()));let now=T0,calls=0;
  const getProviders=()=>providers({detail:async()=>{calls++;return detail(now);}});
  const service=createSatelliteService(store,getProviders(),()=>now);
  const [first,parallel]=await Promise.all([service.detail(station.id),service.detail(station.id)]);
  assert.equal(calls,1);assert.equal(first.status,"ready");assert.deepEqual(parallel,first);
  const restarted=createSatelliteService(store,providers({detail:async()=>{calls++;return detail(now);}}),()=>now);
  assert.deepEqual(await restarted.detail(station.id),first);assert.equal(calls,1);
  now+=16*60_000;const failed=createSatelliteService(store,providers({detail:async()=>{calls++;throw new Error("offline");}}),()=>now);
  const cached=await failed.detail(station.id),saved=await store.read<IspuDetail>(`ispu-detail:${station.id}`);
  assert.equal(cached.status,"cached");assert.equal(cached.fetched_at,first.fetched_at);assert.equal(saved?.fetched_at,first.fetched_at);assert.equal(saved?.failed,true);assert.equal(calls,2);
  now+=46*60_000;store.records.set("air",snapshot(air(now)));await assert.rejects(failed.detail(station.id),/ISPU_UNAVAILABLE/);assert.equal(calls,3);
});

test("unknown stations never call detail providers and status exposes no credentials",async()=>{
  const store=new MemorySnapshotStore();store.records.set("air",snapshot(air()));let detailCalls=0;
  const service=createSatelliteService(store,providers({detail:async()=>{detailCalls++;return detail();}}),()=>T0);
  await assert.rejects(service.detail("missing_station"),/ISPU_UNAVAILABLE/);await assert.rejects(service.detail("bad/id"),/ISPU_UNAVAILABLE/);
  assert.equal(detailCalls,0);const status=await service.status();
  assert.deepEqual(Object.keys(status.sources).sort(),["air","fire","wind"]);assert.equal(JSON.stringify(status).includes("AUTHORIZATION"),false);
});




