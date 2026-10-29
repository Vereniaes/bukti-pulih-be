// Read the available NASA dates and fetch bounded historical observations.
import { parse } from "csv-parse/sync";
import { HotspotError, parseHotspots, type Bounds, type Source, type HotspotRange, type HotspotResult } from "./hotspot.service.js";

const DAY=86400000,TTL=15*60000;
const PRODUCTS:Source[]=["VIIRS_NOAA20_SP","VIIRS_NOAA20_NRT","VIIRS_NOAA21_SP","VIIRS_NOAA21_NRT"];
interface AvailableProduct { name:Source; min_date:string; max_date:string }
export interface HotspotAvailability { sources:AvailableProduct[]; fetched_at:string; status:"complete"|"cached" }
const day=(time:number)=>Math.floor(time/DAY)*DAY;
const date=(time:number)=>new Date(time).toISOString().slice(0,10);
function dateTime(value:unknown) {
  if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))return NaN;
  const time=Date.parse(value);
  return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===value.slice(0,10)?time:NaN;
}
export function parseHotspotRange(start:unknown,end:unknown,now=Date.now()):HotspotRange {
  const a=dateTime(start),b=dateTime(end);
  if(!Number.isFinite(a)||!Number.isFinite(b)||a>=b||b-a>5*DAY||b>now)throw new HotspotError("INVALID_TIME_RANGE",400);
  return {start:a,end:b};
}
export function parseAvailability(csv:string,now:number):HotspotAvailability {
  let headers:string[]=[];
  const rows=parse(csv,{bom:true,skip_empty_lines:true,trim:true,columns:(names:string[])=>{headers=names;return names;}}) as Record<string,string>[];
  if(!["data_id","min_date","max_date"].every(name=>headers.includes(name)))throw new HotspotError("FIRMS_UNAVAILABLE",502);
  const sources:AvailableProduct[]=[];
  for(const row of rows) {
    if(!PRODUCTS.includes(row.data_id as Source))continue;
    const min=Date.parse(row.min_date+"T00:00:00Z"),max=Date.parse(row.max_date+"T00:00:00Z");
    if(!Number.isFinite(min)||!Number.isFinite(max)||date(min)!==row.min_date||date(max)!==row.max_date||min>max)throw new HotspotError("FIRMS_UNAVAILABLE",502);
    sources.push({name:row.data_id as Source,min_date:row.min_date,max_date:row.max_date});
  }
  if(!sources.length)throw new HotspotError("FIRMS_UNAVAILABLE",502);
  return {sources,fetched_at:new Date(now).toISOString(),status:"complete"};
}

export function createHotspotHistoryService(key:()=>string,request=fetch,clock=Date.now,timeoutMs=15000) {
  let catalog:HotspotAvailability|null=null,pendingCatalog:Promise<HotspotAvailability>|null=null;
  const cache=new Map<string,{data:HotspotResult;expires:number}>(),pending=new Map<string,Promise<HotspotResult>>();
  const availability=async():Promise<HotspotAvailability>=>{
    if(!key())throw new HotspotError("FIRMS_NOT_CONFIGURED",503);
    if(catalog&&clock()-Date.parse(catalog.fetched_at)<3600000)return catalog;
    if(pendingCatalog)return pendingCatalog;
    pendingCatalog=(async()=>{
      try {
        const response=await request(`https://firms.modaps.eosdis.nasa.gov/api/data_availability/csv/${encodeURIComponent(key())}/all`,{signal:AbortSignal.timeout(timeoutMs)});
        if(!response.ok)throw new Error();
        catalog=parseAvailability(await response.text(),clock());return catalog;
      } catch {
        if(catalog&&clock()-Date.parse(catalog.fetched_at)<DAY)return {...catalog,status:"cached"};
        throw new HotspotError("FIRMS_UNAVAILABLE",502);
      }
    })();
    try{return await pendingCatalog;}finally{pendingCatalog=null;}
  };
  const read=async(bounds:Bounds,range:HotspotRange):Promise<HotspotResult>=>{
    const normalized=parseHotspotRange(new Date(range.start).toISOString(),new Date(range.end).toISOString(),clock());
    const cacheKey=JSON.stringify([bounds,normalized]);
    const saved=cache.get(cacheKey);
    if(saved&&saved.expires>clock())return saved.data;
    if(pending.has(cacheKey))return pending.get(cacheKey)!;
    const job=(async()=>{
      const available=await availability();
      const groups:{name:Source;start:number;days:number}[]=[];let missing=false;
      // Prefer standard archives, and never request both products for the same satellite/day.
      for(let current=day(range.start);current<=day(range.end);current+=DAY) {
        let covered=false;
        for(const satellite of ["NOAA20","NOAA21"]) {
          const product=PRODUCTS.map(name=>available.sources.find(item=>item.name===name)).find(item=>item&&item.name.includes(satellite)&&item.min_date<=date(current)&&item.max_date>=date(current));
          if(!product)continue;
          covered=true;
          const previous=groups.filter(item=>item.name===product.name).at(-1);
          if(previous&&previous.start+previous.days*DAY===current&&previous.days<5)previous.days+=1;
          else groups.push({name:product.name,start:current,days:1});
        }
        if(!covered)missing=true;
      }
      if(!groups.length)throw new HotspotError("HOTSPOT_DATE_UNAVAILABLE",422);
      const results=await Promise.allSettled(groups.map(async group=>{
        const response=await request(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key())}/${group.name}/${bounds.join(",")}/${group.days}/${date(group.start)}`,{signal:AbortSignal.timeout(timeoutMs)});
        if(!response.ok)throw new Error();
        return parseHotspots(await response.text(),group.name,clock(),range);
      }));
      const fulfilled=results.filter(item=>item.status==="fulfilled").length;
      if(!fulfilled) {
        if(saved&&clock()-Date.parse(saved.data.fetched_at)<DAY)return {...saved.data,status:"cached" as const};
        throw new HotspotError("FIRMS_UNAVAILABLE",502);
      }
      const observations=[...new Map(results.flatMap(item=>item.status==="fulfilled"?item.value:[]).filter(point=>point.coordinates[1]>=bounds[0]&&point.coordinates[1]<=bounds[2]&&point.coordinates[0]>=bounds[1]&&point.coordinates[0]<=bounds[3]).map(point=>[point.id,point])).values()];
      const data:HotspotResult={observations,bounds,fetched_at:new Date(clock()).toISOString(),observed_at:observations.map(point=>point.observed_at).sort().at(-1)??null,status:fulfilled===results.length&&!missing?"complete":"partial",sources:[...new Set(groups.map(item=>item.name))].map(name=>({name,available:groups.every((item,index)=>item.name!==name||results[index].status==="fulfilled")}))};
      if(cache.size>=32&&!cache.has(cacheKey))cache.delete(cache.keys().next().value!);
      cache.set(cacheKey,{data,expires:clock()+(data.status==="complete"?TTL:60000)});
      return data;
    })();
    pending.set(cacheKey,job);
    try{return await job;}finally{pending.delete(cacheKey);}
  };
  return {availability,read};
}
