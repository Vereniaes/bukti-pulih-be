// Todo:
// -> Store provincial BNPB totals and plot coverage.
// -> Keep source dates separate from successful fetches and failed checks.

// --- BNPB cache ---
import { ENV } from "../../config/env.js";
import { BnpbSyncCacheModel, IBnpbProvince } from "./bnpb.model.js";
import { PlotModel } from "../plots/plot.model.js";

const SOURCE = "WebGIS BNPB (gis.bnpb.go.id - 2026_karhutla)";
const LAYER = "mv_prov_karhutla_2026";
const MAX_SYNC_AGE_MS = 12 * 60 * 60 * 1000;

interface ArcGISFeature {
  attributes: {
    provinsi: string;
    tgl_update?: unknown;
    today_luas_terbakar: unknown;
    total_hotspot: unknown;
    relawan?: unknown;
    kualitas_udara_pm25?: unknown;
  };
}

function sourceDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// Purpose: Combine provincial BNPB totals with stored plot coverage.
// Input: Configured BNPB endpoint and current plot records.
// Output: Snapshot; failed checks retain the last successful fetch and source dates.
export const syncBnpbKarhutlaData = async () => {
  let upstreamStatus: number | null = null;
  try {
    const url = new URL(ENV.BNPB_ARCGIS_ENDPOINT);
    url.search = new URLSearchParams({
      where: "objectid>0",
      outFields: "provinsi,tgl_update,today_luas_terbakar,total_hotspot,relawan,kualitas_udara_pm25",
      returnGeometry: "false", f: "json",
    }).toString();
    const response = await fetch(url, {
      headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000),
    });
    upstreamStatus = response.status;

    if (!response.ok) {
      throw new Error(`BNPB API merespons dengan status ${response.status}`);
    }

    const json = (await response.json()) as { features: ArcGISFeature[] };
    if (!Array.isArray(json.features) || json.features.length === 0) {
      throw new Error("Format respons ArcGIS BNPB tidak valid");
    }

    const plots = await PlotModel.find();

    const provinces: IBnpbProvince[] = json.features.map((f) => {
      const attr = f?.attributes;
      if (!attr || typeof attr.provinsi !== "string" || !attr.provinsi.trim()) {
        throw new Error("Format provinsi BNPB tidak valid");
      }
      if (!nonNegativeNumber(attr.today_luas_terbakar) || !nonNegativeNumber(attr.total_hotspot)
        || !Number.isInteger(attr.total_hotspot)
        || (attr.relawan != null && (!nonNegativeNumber(attr.relawan) || !Number.isInteger(attr.relawan)))) {
        throw new Error("Angka BNPB tidak valid");
      }
      const matchedPlots = plots.filter((p) =>
        p.region.toLowerCase().includes(attr.provinsi.toLowerCase())
      );
      const restoredArea = matchedPlots.reduce((acc, p) => acc + p.area_hectares, 0);
      const aliveTrees = matchedPlots.reduce((acc, p) => acc + p.current_alive, 0);

      return {
        provinsi: attr.provinsi,
        tgl_update: sourceDate(attr.tgl_update),
        today_luas_terbakar_ha: attr.today_luas_terbakar,
        total_hotspot: attr.total_hotspot,
        relawan_lapangan: attr.relawan ?? null,
        kualitas_udara_pm25: typeof attr.kualitas_udara_pm25 === "string"
          ? attr.kualitas_udara_pm25.trim() || null : null,
        buktipulih_coverage: {
          active_plots: matchedPlots.length,
          restored_area_ha: Math.round(restoredArea * 100) / 100,
          alive_trees: aliveTrees,
        },
      };
    });

    const cacheDoc = await BnpbSyncCacheModel.findOne()
      ?? new BnpbSyncCacheModel({ source: SOURCE, layer: LAYER });
    cacheDoc.sync_timestamp = new Date();
    cacheDoc.checked_at = cacheDoc.sync_timestamp;
    cacheDoc.sync_failed = false;
    cacheDoc.provinces = provinces;

    await cacheDoc.save();
    return cacheDoc;
  } catch {
    console.warn("[BNPB Sync] Pembaruan gagal; snapshot terakhir dipertahankan.", { upstream_status: upstreamStatus });
    const existingCache = await BnpbSyncCacheModel.findOne()
      ?? new BnpbSyncCacheModel({ source: SOURCE, layer: LAYER, provinces: [] });
    existingCache.checked_at = new Date();
    existingCache.sync_failed = true;
    await existingCache.save();
    return existingCache;
  }
};

export const getBnpbKarhutlaService = async () => {
  let cache = await BnpbSyncCacheModel.findOne();
  if (!cache) {
    cache = await syncBnpbKarhutlaData();
  }

  const provinces = cache?.provinces || [];
  const totalBurned = provinces.reduce((acc, p) => acc + (p.today_luas_terbakar_ha || 0), 0);
  const totalHotspots = provinces.reduce((acc, p) => acc + (p.total_hotspot || 0), 0);
  const totalVolunteers = provinces.some(p => p.relawan_lapangan == null) ? null
    : provinces.reduce((acc, p) => acc + (p.relawan_lapangan ?? 0), 0);
  const fetchedAt = cache?.sync_timestamp?.toISOString() ?? null;
  const status = !fetchedAt ? "unavailable"
    : cache.sync_failed || Date.now() - Date.parse(fetchedAt) >= MAX_SYNC_AGE_MS ? "cached" : "ready";

  return {
    source: cache?.source || SOURCE,
    layer: cache?.layer || LAYER,
    status,
    sync_status: status === "ready" ? "SYNCHRONIZED" : status === "cached" ? "CACHED" : "UNAVAILABLE",
    sync_timestamp: fetchedAt,
    fetched_at: fetchedAt,
    checked_at: cache?.checked_at?.toISOString() ?? fetchedAt,
    total_hectares_burned_national: totalBurned,
    total_hotspots_national: totalHotspots,
    total_volunteers_national: totalVolunteers,
    provinces,
  };
};
// --- end of BNPB cache ---
