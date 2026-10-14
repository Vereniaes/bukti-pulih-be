// src/modules/bnpb/bnpb.model.ts
// -> skema dan model koleksi cache sinkronisasi karhutla bnpb (bnpb_sync_cache)
//      -> data atribut provinsi, hotspot, luas terbakar, personel relawan
//      -> korelasi dengan cakupan restorasi buktipulih di provinsi terkait

import mongoose, { Schema, Document } from "mongoose";

export interface IBnpbProvince {
  provinsi: string;
  tgl_update: string;
  today_luas_terbakar_ha: number;
  total_hotspot: number;
  relawan_lapangan: number;
  kualitas_udara_pm25: string;
  buktipulih_coverage: {
    active_plots: number;
    restored_area_ha: number;
    alive_trees: number;
  };
}

export interface IBnpbSyncCache extends Document {
  source: string;
  layer: string;
  sync_timestamp: Date;
  provinces: IBnpbProvince[];
  created_at: Date;
  updated_at: Date;
}

const BnpbSyncCacheSchema = new Schema<IBnpbSyncCache>(
  {
    source: { type: String, required: true },
    layer: { type: String, required: true },
    sync_timestamp: { type: Date, default: Date.now },
    provinces: [
      {
        provinsi: { type: String, required: true },
        tgl_update: { type: String, required: true },
        today_luas_terbakar_ha: { type: Number, default: 0 },
        total_hotspot: { type: Number, default: 0 },
        relawan_lapangan: { type: Number, default: 0 },
        kualitas_udara_pm25: { type: String, default: "Sedang" },
        buktipulih_coverage: {
          active_plots: { type: Number, default: 0 },
          restored_area_ha: { type: Number, default: 0 },
          alive_trees: { type: Number, default: 0 },
        },
      },
    ],
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  }
);

export const BnpbSyncCacheModel = mongoose.model<IBnpbSyncCache>(
  "BnpbSyncCache",
  BnpbSyncCacheSchema
);
