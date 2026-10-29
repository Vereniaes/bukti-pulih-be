// Todo:
// -> Fetch provincial BNPB totals and store them with plot coverage in MongoDB.

// --- BNPB cache ---
import { ENV } from "../../config/env.js";
import { BnpbSyncCacheModel, IBnpbProvince } from "./bnpb.model.js";
import { PlotModel } from "../plots/plot.model.js";

interface ArcGISFeature {
  attributes: {
    provinsi: string;
    tgl_update: string;
    today_luas_terbakar: number;
    total_hotspot: number;
    relawan: number | null;
    kualitas_udara_pm25: string;
  };
}

// Purpose: Combine provincial BNPB totals with stored plot coverage.
// Input: Configured BNPB endpoint and current plot records.
// Output: Updated snapshot; fetch failures use an existing snapshot or throw.
export const syncBnpbKarhutlaData = async () => {
  try {
    const url = `${ENV.BNPB_ARCGIS_ENDPOINT}?where=1=1&outFields=provinsi,tgl_update,today_luas_terbakar,total_hotspot,relawan,kualitas_udara_pm25&returnGeometry=false&f=json`;
    const response = await fetch(url, { headers: { Accept: "application/json" } });

    if (!response.ok) {
      throw new Error(`BNPB API merespons dengan status ${response.status}`);
    }

    const json = (await response.json()) as { features: ArcGISFeature[] };
    if (!json.features || !Array.isArray(json.features)) {
      throw new Error("Format respons ArcGIS BNPB tidak valid");
    }

    const plots = await PlotModel.find();

    const provinces: IBnpbProvince[] = json.features.map((f) => {
      const attr = f.attributes;
      const matchedPlots = plots.filter((p) =>
        p.region.toLowerCase().includes(attr.provinsi.toLowerCase())
      );
      const restoredArea = matchedPlots.reduce((acc, p) => acc + p.area_hectares, 0);
      const aliveTrees = matchedPlots.reduce((acc, p) => acc + p.current_alive, 0);

      return {
        provinsi: attr.provinsi,
        tgl_update: attr.tgl_update || new Date().toISOString().split("T")[0],
        today_luas_terbakar_ha: attr.today_luas_terbakar || 0,
        total_hotspot: attr.total_hotspot || 0,
        relawan_lapangan: attr.relawan || 0,
        kualitas_udara_pm25: attr.kualitas_udara_pm25 || "Sedang",
        buktipulih_coverage: {
          active_plots: matchedPlots.length,
          restored_area_ha: Math.round(restoredArea * 100) / 100,
          alive_trees: aliveTrees,
        },
      };
    });

    let cacheDoc = await BnpbSyncCacheModel.findOne();
    if (!cacheDoc) {
      cacheDoc = new BnpbSyncCacheModel({
        source: "WebGIS BNPB (gis.bnpb.go.id - 2026_karhutla)",
        layer: "mv_prov_karhutla_2026",
        sync_timestamp: new Date(),
        provinces,
      });
    } else {
      cacheDoc.sync_timestamp = new Date();
      cacheDoc.provinces = provinces;
    }

    await cacheDoc.save();
    return cacheDoc;
  } catch (error) {
    console.warn("[BNPB Sync] Gagal memperbarui live dari BNPB, menggunakan cache:", error);
    const existingCache = await BnpbSyncCacheModel.findOne();
    if (existingCache) return existingCache;
    throw error;
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
  const totalVolunteers = provinces.reduce((acc, p) => acc + (p.relawan_lapangan || 0), 0);

  return {
    source: cache?.source || "WebGIS BNPB (gis.bnpb.go.id - 2026_karhutla)",
    layer: cache?.layer || "mv_prov_karhutla_2026",
    sync_status: "SYNCHRONIZED",
    sync_timestamp: cache?.sync_timestamp || new Date(),
    total_hectares_burned_national: totalBurned,
    total_hotspots_national: totalHotspots,
    total_volunteers_national: totalVolunteers,
    provinces,
  };
};
// --- end of BNPB cache ---
