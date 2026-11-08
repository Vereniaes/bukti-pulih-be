// Todo:
// -> Open and close the shared MongoDB connection.
// -> Check readiness with one bounded probe at a time.

// --- Database connection ---
import mongoose from "mongoose";
import { ENV } from "./env.js";

const READINESS_TIMEOUT_MS = 1000;
let readinessPing: Promise<boolean> | undefined;

// Purpose: Check the shared connection without stacking slow database probes.
// Input: Current connection. Output: Ready within one second, or false.
export const isDatabaseReady = async (): Promise<boolean> => {
  const connection = mongoose.connection;
  const database = connection.db;
  if (connection.readyState !== 1 || !database) return false;

  readinessPing ??= Promise.resolve()
    .then(() => database.admin().ping({ maxTimeMS: READINESS_TIMEOUT_MS }))
    .then(() => connection.readyState === 1 && connection.db === database, () => false)
    .finally(() => { readinessPing = undefined; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      readinessPing,
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), READINESS_TIMEOUT_MS); }),
    ]) && connection.readyState === 1 && connection.db === database;
  } finally {
    clearTimeout(timer);
  }
};

export const connectDatabase = async (): Promise<void> => {
  try {
    mongoose.set("strictQuery", true);
    await mongoose.connect(ENV.MONGODB_URI);
    console.log("[MongoDB] Terhubung dengan basis data:", mongoose.connection.name);
  } catch (error) {
    console.error("[MongoDB] Gagal terhubung dengan basis data:", error);
    process.exit(1);
  }
};

export const disconnectDatabase = async (): Promise<boolean> => {
  try {
    await mongoose.disconnect();
    console.log("[MongoDB] Koneksi berhasil diputuskan.");
    return true;
  } catch (error) {
    console.error("[MongoDB] Galat saat pemutusan koneksi:", error);
    return false;
  }
};
// --- end of Database connection ---
