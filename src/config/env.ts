// src/config/env.ts
// -> validasi dan pemuatan variabel konfigurasi lingkungan backend
//      -> konfigurasi port server dan mode aplikasi
//      -> uri koneksi basis data mongodb
//      -> kunci jwt dan rahasia cookie sesi
//      -> endpoint arcgis bnpb karhutla

import dotenv from "dotenv";

dotenv.config();

export const ENV = {
  PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : 5000,
  NODE_ENV: process.env.NODE_ENV || "development",
  MONGODB_URI: process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/buktipulih_db",
  JWT_SECRET: process.env.JWT_SECRET || "buktipulih_dev_jwt_secret_key_2026",
  COOKIE_SECRET: process.env.COOKIE_SECRET || "buktipulih_cookie_secret_2026",
  CORS_ORIGIN: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",")
    : ["http://localhost:3000", "http://localhost:3001"],
  BNPB_ARCGIS_ENDPOINT:
    process.env.BNPB_ARCGIS_ENDPOINT ||
    "https://gis.bnpb.go.id/server/rest/services/2026_karhutla/mv_prov_karhutla_2026/MapServer/3/query",
};
