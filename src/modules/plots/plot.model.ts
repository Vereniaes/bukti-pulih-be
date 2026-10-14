// src/modules/plots/plot.model.ts
// -> skema dan model koleksi petak restorasi (plots)
//      -> struktur geospasial point 2dsphere untuk koordinat peta
//      -> data metrik bibit ditanam dan survival rate

import mongoose, { Schema, Document } from "mongoose";

export interface IPlot extends Document {
  plot_code: string;
  name: string;
  region: string;
  ecosystem_type: "gambut" | "hutan_kota" | "mineral";
  location: {
    type: "Point";
    coordinates: [number, number]; // [longitude, latitude]
  };
  area_hectares: number;
  community_name: string;
  coordinator_name: string;
  coordinator_phone?: string;
  initial_planting_date: Date;
  total_planted: number;
  current_alive: number;
  survival_rate: number;
  latest_status: "subur" | "perlu_rawat" | "kritis";
  last_monitored_at: Date;
  cover_image_url: string;
  created_at: Date;
  updated_at: Date;
}

const PlotSchema = new Schema<IPlot>(
  {
    plot_code: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    region: { type: String, required: true, index: true },
    ecosystem_type: {
      type: String,
      enum: ["gambut", "hutan_kota", "mineral"],
      default: "gambut",
    },
    location: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
        required: true,
      },
      coordinates: {
        type: [Number], // [lng, lat]
        required: true,
      },
    },
    area_hectares: { type: Number, required: true, default: 1.0 },
    community_name: { type: String, required: true },
    coordinator_name: { type: String, required: true },
    coordinator_phone: { type: String },
    initial_planting_date: { type: Date, default: Date.now },
    total_planted: { type: Number, required: true, default: 0 },
    current_alive: { type: Number, required: true, default: 0 },
    survival_rate: { type: Number, required: true, default: 100 },
    latest_status: {
      type: String,
      enum: ["subur", "perlu_rawat", "kritis"],
      default: "subur",
      index: true,
    },
    last_monitored_at: { type: Date, default: Date.now },
    cover_image_url: { type: String, required: true },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  }
);

// indeks geospasial untuk kueri radius dan bounding box --------------------------
PlotSchema.index({ location: "2dsphere" });
PlotSchema.index({ region: 1, latest_status: 1 });
// end of indeks -------------------------------------------------------------------

export const PlotModel = mongoose.model<IPlot>("Plot", PlotSchema);
