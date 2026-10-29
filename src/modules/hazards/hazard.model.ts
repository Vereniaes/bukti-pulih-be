// Store source snapshots separately from restoration records.
import mongoose, { Schema } from "mongoose";
import type { AirForecastCache, HazardFeatureCollection } from "./hazard.types.js";

interface SnapshotRecord { _id: string; snapshot: HazardFeatureCollection; }
interface ForecastRecord { _id: string; data: AirForecastCache; }
interface LeaseRecord { _id: string; owner: string; lease_until: Date; }

export const HazardSnapshotModel = mongoose.model<SnapshotRecord>("HazardSnapshot", new Schema<SnapshotRecord>({
  _id: { type: String, required: true }, snapshot: { type: Schema.Types.Mixed, required: true },
}, { versionKey: false, collection: "hazard_snapshots" }));
export const HazardForecastModel = mongoose.model<ForecastRecord>("HazardForecast", new Schema<ForecastRecord>({
  _id: { type: String, required: true }, data: { type: Schema.Types.Mixed, required: true },
}, { versionKey: false, collection: "hazard_forecasts" }));
export const HazardLeaseModel = mongoose.model<LeaseRecord>("HazardLease", new Schema<LeaseRecord>({
  _id: { type: String, required: true }, owner: { type: String, required: true }, lease_until: { type: Date, required: true },
}, { versionKey: false, collection: "hazard_sync_leases" }));
