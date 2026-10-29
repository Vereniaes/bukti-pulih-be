// Todo:
// -> Open and close the shared MongoDB connection.

// --- Database connection ---
import mongoose from "mongoose";
import { ENV } from "./env.js";

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

export const disconnectDatabase = async (): Promise<void> => {
  try {
    await mongoose.disconnect();
    console.log("[MongoDB] Koneksi berhasil diputuskan.");
  } catch (error) {
    console.error("[MongoDB] Galat saat pemutusan koneksi:", error);
  }
};
// --- end of Database connection ---
