// Read durable snapshots and refresh each source without replacing good data on failure.
import { randomUUID } from "node:crypto";
import { PlotModel } from "../plots/plot.model.js";
import { HazardForecastModel, HazardLeaseModel, HazardSnapshotModel } from "./hazard.model.js";
import { fetchBnpbLayers, loadCamsForecast } from "./hazard.sources.js";
import { matchPlots } from "./hazard.geometry.js";
import type { HazardFeature, HazardFeatureCollection, HazardLayer } from "./hazard.types.js";

export const REFRESH_SECONDS = 300;
const LAYERS: HazardLayer[] = ["fire", "air", "flood"];
const SOURCE_URL = "https://gis.bnpb.go.id/server/rest/services/Kejadian_Bencana_Mingguan/MapServer/25";
export function emptySnapshot(layer: HazardLayer): HazardFeatureCollection {
  return { type: "FeatureCollection", features: [], status: "unavailable", fetched_at: null, checked_at: null,
    source: layer === "air" ? "CAMS / Open-Meteo" : "BNPB",
    source_url: layer === "air" ? "https://open-meteo.com/en/docs/air-quality-api" : SOURCE_URL, error: "NOT_SYNCED" };
}
export function readableSnapshot(snapshot: HazardFeatureCollection, now: number): HazardFeatureCollection {
  return snapshot.status === "ready" && (!snapshot.checked_at || now - Date.parse(snapshot.checked_at) > REFRESH_SECONDS * 2000)
    ? { ...snapshot, status: "stale" } : snapshot;
}
export async function getHazardLayers(now = Date.now()) {
  const records = await HazardSnapshotModel.find({ _id: { $in: LAYERS } }).lean();
  return { refresh_seconds: REFRESH_SECONDS, layers: Object.fromEntries(LAYERS.map(layer => [layer,
    readableSnapshot(records.find(record => record._id === layer)?.snapshot ?? emptySnapshot(layer), now),
  ])) as Record<HazardLayer, HazardFeatureCollection> };
}

async function saveSuccess(layer: HazardLayer, features: HazardFeature[], checkedAt: string, fetchedAt = checkedAt) {
  const snapshot = { ...emptySnapshot(layer), features, status: "ready" as const, checked_at: checkedAt, fetched_at: fetchedAt, error: null };
  await HazardSnapshotModel.updateOne({ _id: layer }, { $set: { snapshot } }, { upsert: true });
}
async function saveFailure(layer: HazardLayer, checkedAt: string) {
  const record = await HazardSnapshotModel.findById(layer).lean();
  const snapshot = { ...(record?.snapshot ?? emptySnapshot(layer)), checked_at: checkedAt,
    status: record?.snapshot.fetched_at ? "stale" : "unavailable", error: layer === "air" ? "CAMS_UNAVAILABLE" : "BNPB_UNAVAILABLE" };
  await HazardSnapshotModel.updateOne({ _id: layer }, { $set: { snapshot } }, { upsert: true });
}

export async function syncHazardLayers(request: typeof fetch = fetch, now = Date.now()) {
  const owner = randomUUID();
  try {
    const lease = await HazardLeaseModel.findOneAndUpdate({ _id: "hazards", lease_until: { $lte: new Date(now) } },
      { $set: { owner, lease_until: new Date(now + 240000) } }, { upsert: true, new: true });
    if (!lease) return { skipped: true };
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return { skipped: true };
    throw error;
  }
  const checkedAt = new Date(now).toISOString();
  try {
    const work = await Promise.allSettled([
      (async () => {
        let result;
        try { result = await fetchBnpbLayers(request, now); }
        catch { await Promise.all([saveFailure("fire", checkedAt), saveFailure("flood", checkedAt)]); return; }
        const plots = await PlotModel.find({}, { plot_code: 1, location: 1 }).lean();
        await Promise.all([saveSuccess("fire", matchPlots(result.fire, plots), checkedAt), saveSuccess("flood", matchPlots(result.flood, plots), checkedAt)]);
      })(),
      (async () => {
        const saved = await HazardForecastModel.findById("cams").lean();
        let result;
        try { result = await loadCamsForecast(saved?.data ?? null, request, now); }
        catch { await saveFailure("air", checkedAt); return; }
        if (result.cache !== saved?.data) await HazardForecastModel.updateOne({ _id: "cams" }, { $set: { data: result.cache } }, { upsert: true });
        await saveSuccess("air", result.features, checkedAt, result.cache.fetched_at);
      })(),
    ]);
    if (work.some(result => result.status === "rejected")) throw new Error("HAZARD_STORE_FAILED");
    const data = await getHazardLayers(now);
    const statuses = Object.fromEntries(LAYERS.map(layer => [layer, data.layers[layer].status]));
    return { skipped: false, failed: Object.values(statuses).some(status => status !== "ready"), checked_at: checkedAt, layers: statuses };
  } finally {
    await HazardLeaseModel.updateOne({ _id: "hazards", owner }, { $set: { lease_until: new Date(0) } });
  }
}
