// Store compressed provider snapshots and coordinate scheduled refreshes.
import mongoose, { Schema } from "mongoose";
import { gzip as gzipCallback, gunzip as gunzipCallback } from "node:zlib";
import { promisify } from "node:util";

const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);
const MAX_COMPRESSED = 12 * 1024 * 1024;
const MAX_DECOMPRESSED = 64 * 1024 * 1024;
const LEASE_MS = 240_000;

interface SnapshotRecord {
  _id: string; payload?: Buffer; fetched_at?: Date; checked_at: Date; failed: boolean;
}
interface LeaseRecord { _id: string; owner: string; slot: string; lease_until: Date; }
const SnapshotSchema = new Schema<SnapshotRecord>({
  _id: { type: String, required: true }, payload: { type: Buffer }, fetched_at: Date,
  checked_at: { type: Date, required: true }, failed: { type: Boolean, required: true },
}, { versionKey: false, collection: "satellite_snapshots" });
const LeaseSchema = new Schema<LeaseRecord>({
  _id: { type: String, required: true }, owner: { type: String, required: true },
  slot: { type: String, required: true }, lease_until: { type: Date, required: true },
}, { versionKey: false, collection: "satellite_sync_leases" });
const SnapshotModel = mongoose.models.SatelliteSnapshot ?? mongoose.model<SnapshotRecord>("SatelliteSnapshot", SnapshotSchema);
const LeaseModel = mongoose.models.SatelliteLease ?? mongoose.model<LeaseRecord>("SatelliteLease", LeaseSchema);

export interface Snapshot<T> { data: T | null; fetched_at: string | null; checked_at: string; failed: boolean; }
export interface SnapshotStore {
  read<T>(key: string): Promise<Snapshot<T> | null>;
  write<T extends { fetched_at: string }>(key: string, data: T, checkedAt: string): Promise<void>;
  fail(key: string, checkedAt: string): Promise<void>;
  claim(slot: string, owner: string, now: Date): Promise<boolean>;
  release(owner: string): Promise<void>;
}
const validDate = (value: string): Date => {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error("INVALID_SNAPSHOT_DATE");
  return new Date(time);
};
const duplicateKey = (error: unknown): boolean => (error as { code?: number })?.code === 11000;

export const mongoSnapshotStore: SnapshotStore = {
  async read<T>(key: string): Promise<Snapshot<T> | null> {
    const doc = await SnapshotModel.findById(key);
    if (!doc) return null;
    const checkedAt = doc.checked_at?.toISOString();
    if (!checkedAt) throw new Error("INVALID_SNAPSHOT_RECORD");
    if (!doc.payload) return { data: null, fetched_at: doc.fetched_at?.toISOString() ?? null, checked_at: checkedAt, failed: doc.failed };
    if (doc.payload.byteLength > MAX_COMPRESSED) throw new Error("SNAPSHOT_TOO_LARGE");
    const raw = await gunzip(Buffer.from(doc.payload), { maxOutputLength: MAX_DECOMPRESSED });
    const data = JSON.parse(raw.toString("utf8")) as T;
    return { data, fetched_at: doc.fetched_at?.toISOString() ?? null, checked_at: checkedAt, failed: doc.failed };
  },
  async write<T extends { fetched_at: string }>(key: string, data: T, checkedAt: string): Promise<void> {
    const fetchedDate = validDate(data.fetched_at), checkedDate = validDate(checkedAt);
    const raw = Buffer.from(JSON.stringify(data));
    if (raw.byteLength > MAX_DECOMPRESSED) throw new Error("SNAPSHOT_TOO_LARGE");
    const payload = await gzip(raw);
    if (payload.byteLength > MAX_COMPRESSED) throw new Error("SNAPSHOT_TOO_LARGE");
    try {
      await SnapshotModel.updateOne({ _id: key, $or: [
        { fetched_at: { $exists: false } }, { fetched_at: null }, { fetched_at: { $lte: fetchedDate } },
      ] }, { $set: { payload, fetched_at: fetchedDate, checked_at: checkedDate, failed: false } }, { upsert: true });
    } catch (error) {
      if (!duplicateKey(error)) throw error;
    }
  },
  async fail(key: string, checkedAt: string): Promise<void> {
    await SnapshotModel.updateOne({ _id: key }, { $set: { checked_at: validDate(checkedAt), failed: true } }, { upsert: true });
  },
  async claim(slot: string, owner: string, now: Date): Promise<boolean> {
    try {
      const lease = await LeaseModel.findOneAndUpdate({ _id: "satellite", slot: { $ne: slot }, lease_until: { $lte: now } },
        { $set: { owner, slot, lease_until: new Date(now.getTime() + LEASE_MS) } }, { upsert: true, new: true });
      return lease?.owner === owner;
    } catch (error) {
      if (duplicateKey(error)) return false;
      throw error;
    }
  },
  async release(owner: string): Promise<void> {
    await LeaseModel.updateOne({ _id: "satellite", owner }, { $set: { lease_until: new Date(0) } });
  },
};
