// Verify geometry, durable failure handling and the scheduler boundary.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import mongoose from "mongoose";
import express from "express";
import { createSchedulerGuard } from "../src/modules/hazards/hazard.auth.js";
import { HazardForecastModel, HazardSnapshotModel, HazardLeaseModel } from "../src/modules/hazards/hazard.model.js";
import { syncHazardLayers, getHazardLayers, readableSnapshot, emptySnapshot } from "../src/modules/hazards/hazard.service.js";
import { AIR_GRID } from "../src/modules/hazards/hazard.sources.js";
import { containsCoordinate, matchPlots } from "../src/modules/hazards/hazard.geometry.js";
import { PlotModel } from "../src/modules/plots/plot.model.js";
import type { HazardGeometry } from "../src/modules/hazards/hazard.types.js";

const now = Date.parse("2026-10-26T14:00:00Z");
const outer: [number, number][] = [[100,-2],[102,-2],[102,0],[100,0],[100,-2]];
const hole: [number, number][] = [[100.5,-1.5],[101.5,-1.5],[101.5,-.5],[100.5,-.5],[100.5,-1.5]];
const polygon: HazardGeometry = {type:"Polygon",coordinates:[outer,hole]};
const dbName = `buktipulih_hazard_test_${process.pid}`;
before(async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27017/${dbName}`);
  await Promise.all([HazardSnapshotModel.init(),HazardForecastModel.init(),HazardLeaseModel.init()]);
});
after(async () => {
  assert.equal(mongoose.connection.name, dbName);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("plot matching respects GeoJSON order, holes and separate polygons", () => {
  assert.equal(containsCoordinate(polygon,[100.2,-1]),true);
  assert.equal(containsCoordinate(polygon,[101,-1]),false);
  assert.equal(containsCoordinate(polygon,[99,-1]),false);
  assert.equal(containsCoordinate(polygon,[-1,100.2]),false);
  assert.equal(containsCoordinate({type:"MultiPolygon",coordinates:[[outer],[outer.map(([x,y])=>[x+5,y])]]},[106,-1]),true);
  assert.equal(containsCoordinate({type:"Point",coordinates:[101,-1]},[101.1,-1]),false);
  const feature = {type:"Feature" as const,id:"area",geometry:polygon,properties:{label:"Area",observed_at:null,plot_ids:[]}};
  assert.deepEqual(matchPlots([feature],[{plot_code:"inside",location:{coordinates:[100.2,-1]}},{plot_code:"hole",location:{coordinates:[101,-1]}}])[0].properties.plot_ids,["inside"]);
});

test("staleness is derived from the last actual successful check", () => {
  const fresh = {...emptySnapshot("fire"),status:"ready" as const,checked_at:new Date(now).toISOString()};
  assert.equal(readableSnapshot(fresh,now+600001).status,"stale");
  assert.equal(readableSnapshot(fresh,now+299999).status,"ready");
  assert.equal(emptySnapshot("fire").fetched_at,null);
});

test("Mongo snapshots are idempotent and retain source time/data on upstream failure", async () => {
  const hour=Math.floor(now/3600000)*3600;
  await HazardForecastModel.create({_id:"cams",data:{run:now-43200000,fetched_at:new Date(now-1000).toISOString(),samples:AIR_GRID.map(coordinates=>({coordinates,times:[hour],aqi:[25],pm25:[3]}))}});
  await PlotModel.collection.insertOne({plot_code:"matched",location:{type:"Point",coordinates:[100.2,-1]}});
  let calls=0;
  const request:typeof fetch=async input=>{
    calls++;
    if(String(input).includes("meta.json"))return Response.json({last_run_initialisation_time:(now-43200000)/1000,last_run_availability_time:(now-36000000)/1000});
    return Response.json({type:"FeatureCollection",features:[{type:"Feature",geometry:polygon,properties:{id:"event-1",dt:now-3600000,kabupaten:"Test area",kategori_bencana:"Banjir",jumlah_kejadian:1}}]});
  };
  await syncHazardLayers(request,now);
  await syncHazardLayers(request,now);
  assert.equal(calls,4);
  assert.equal(await HazardSnapshotModel.countDocuments(),3);
  let layers=(await getHazardLayers(now)).layers;
  assert.equal(layers.flood.status,"ready");
  assert.equal(layers.flood.features.length,1);
  assert.equal(layers.air.features.length,275);
  assert.deepEqual(layers.flood.features[0].properties.plot_ids,["matched"]);
  const sourceTime=layers.flood.features[0].properties.observed_at;
  const fetched=layers.flood.fetched_at;
  const result=await syncHazardLayers(async()=>new Response("down",{status:503}),now+300000);
  assert.equal(result.failed,true);
  layers=(await getHazardLayers(now+600000)).layers;
  assert.equal(layers.flood.status,"stale");
  assert.equal(layers.flood.features[0].properties.observed_at,sourceTime);
  assert.equal(layers.flood.fetched_at,fetched);
  assert.equal(layers.flood.checked_at,new Date(now+300000).toISOString());
  assert.equal(layers.air.features.length,275);
  await HazardSnapshotModel.deleteOne({_id:"fire"});
  await syncHazardLayers(async()=>new Response("down",{status:403}),now+600000);
  layers=(await getHazardLayers(now+600000)).layers;
  assert.equal(layers.fire.status,"unavailable");
  assert.equal(layers.fire.features.length,0);
  assert.equal(layers.fire.fetched_at,null);
});

test("an active lease prevents another worker from making provider requests", async () => {
  await HazardLeaseModel.updateOne({_id:"hazards"},{$set:{owner:"other-worker",lease_until:new Date(now+100000)}},{upsert:true});
  let requested=false;
  const result=await syncHazardLayers(async()=>{requested=true;throw Error("unexpected");},now);
  assert.equal(result.skipped,true);
  assert.equal(requested,false);
});

test("scheduler rejects missing config, missing token, failed signatures and wrong identity", async () => {
  const app=express();
  app.post("/missing",createSchedulerGuard({audience:"",serviceAccount:""}),(_req,res)=>res.sendStatus(204));
  app.post("/sync",createSchedulerGuard({audience:"https://service.run.app",serviceAccount:"scheduler@example.iam.gserviceaccount.com"},async(token,audience)=>{
    assert.equal(audience,"https://service.run.app");
    if(token==="bad.signature")throw Error("invalid");
    return {iss:"https://accounts.google.com",aud:audience,sub:"123",iat:1,exp:9999999999,
      email:token==="wrong.identity"?"other@example.com":"scheduler@example.iam.gserviceaccount.com",email_verified:token!=="unverified.identity"};
  }),(_req,res)=>res.sendStatus(204));
  const server=app.listen(0,"127.0.0.1");await once(server,"listening");
  const address=server.address();assert(address&&typeof address==="object");
  const base=`http://127.0.0.1:${address.port}`;
  try{
    assert.equal((await fetch(base+"/missing",{method:"POST"})).status,503);
    assert.equal((await fetch(base+"/sync",{method:"POST"})).status,401);
    for(const [token,status] of [["bad.signature",401],["wrong.identity",403],["unverified.identity",403],["valid.identity",204]] as const){
      assert.equal((await fetch(base+"/sync",{method:"POST",headers:{Authorization:`Bearer ${token}`}})).status,status);
    }
  }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});
