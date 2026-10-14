// src/scripts/seed.ts
// -> skrip seeder data awal basis data buktipulih
//      -> menyuntikkan petak restorasi (kalbar, bekasi, kalteng)
//      -> menyuntikkan akun kader lapangan default (pak suwardi, pin: 123456)
//      -> menyuntikkan catatan linimasa dan cache data bnpb karhutla

import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { connectDatabase, disconnectDatabase } from "../config/database.js";
import { PlotModel } from "../modules/plots/plot.model.js";
import { UserModel } from "../modules/auth/user.model.js";
import { MonitoringLogModel } from "../modules/timeline/timeline.model.js";
import { BnpbSyncCacheModel } from "../modules/bnpb/bnpb.model.js";

const runSeed = async () => {
  console.log("[Seeder] Memulai pengisian data awal BuktiPulih...");
  await connectDatabase();

  // bersihkan data lama -----------------------------------------------------------
  await Promise.all([
    PlotModel.deleteMany({}),
    UserModel.deleteMany({}),
    MonitoringLogModel.deleteMany({}),
    BnpbSyncCacheModel.deleteMany({}),
  ]);
  console.log("[Seeder] Koleksi lama dibersihkan.");

  // 1. seed akun pengguna kader ----------------------------------------------------
  const pinHash = await bcrypt.hash("123456", 12);
  const kader = await UserModel.create({
    phone_number: "081234567890",
    full_name: "Pak Suwardi",
    pin_hash: pinHash,
    role: "COMMUNITY_VOLUNTEER",
    role_badge: "🌿 Kader Terdaftar ✓",
    organization_name: "Kelompok Tani Peduli Gambut Kubu Raya",
    assigned_plots: ["PL-KALBAR-001"],
    is_active: true,
  });
  console.log("[Seeder] Akun kader lapangan dibuat:", kader.full_name);

  // 2. seed petak restorasi --------------------------------------------------------
  const plotKalbar = await PlotModel.create({
    plot_code: "PL-KALBAR-001",
    name: "Petak Restorasi Gambut Parit Tokaya",
    region: "Kalimantan Barat",
    ecosystem_type: "gambut",
    location: {
      type: "Point",
      coordinates: [109.3333, -0.0222],
    },
    area_hectares: 2.5,
    community_name: "Kelompok Tani Peduli Gambut Kubu Raya",
    coordinator_name: "Pak Suwardi",
    coordinator_phone: "0812-3456-7890",
    initial_planting_date: new Date("2026-01-15T00:00:00Z"),
    total_planted: 1200,
    current_alive: 1040,
    survival_rate: 86.67,
    latest_status: "subur",
    last_monitored_at: new Date("2026-10-12T07:15:00Z"),
    cover_image_url:
      "https://images.unsplash.com/photo-1542601906990-b4d3fb778b09?w=800&auto=format&fit=crop&q=80",
  });

  const plotBekasi = await PlotModel.create({
    plot_code: "PL-BEKASI-002",
    name: "Hutan Kota Patriot Bina Bangsa",
    region: "Jawa Barat",
    ecosystem_type: "hutan_kota",
    location: {
      type: "Point",
      coordinates: [106.9924, -6.2383],
    },
    area_hectares: 1.8,
    community_name: "Relawan Hijau Patriot Bekasi",
    coordinator_name: "Ibu Ratna Dewi",
    coordinator_phone: "0813-8899-7766",
    initial_planting_date: new Date("2026-02-01T00:00:00Z"),
    total_planted: 850,
    current_alive: 710,
    survival_rate: 83.53,
    latest_status: "subur",
    last_monitored_at: new Date("2026-10-11T10:00:00Z"),
    cover_image_url:
      "https://images.unsplash.com/photo-1513836279014-a89f7a76ae86?w=800&auto=format&fit=crop&q=80",
  });

  const plotKalteng = await PlotModel.create({
    plot_code: "PL-KALTENG-003",
    name: "Zona Pemulihan Sebangau Kahayan",
    region: "Kalimantan Tengah",
    ecosystem_type: "gambut",
    location: {
      type: "Point",
      coordinates: [113.9213, -2.2136],
    },
    area_hectares: 3.5,
    community_name: "Forum Masyarakat Peduli Rawa Palangka",
    coordinator_name: "Bapak Markus",
    coordinator_phone: "0821-5544-3322",
    initial_planting_date: new Date("2026-01-20T00:00:00Z"),
    total_planted: 2100,
    current_alive: 1690,
    survival_rate: 80.48,
    latest_status: "perlu_rawat",
    last_monitored_at: new Date("2026-10-09T14:20:00Z"),
    cover_image_url:
      "https://images.unsplash.com/photo-1448375240586-882707db888b?w=800&auto=format&fit=crop&q=80",
  });
  console.log("[Seeder] 3 petak restorasi berhasil disimpan.");

  // 3. seed catatan linimasa relawan -----------------------------------------------
  await MonitoringLogModel.create([
    {
      plot_id: plotKalbar._id,
      plot_code: plotKalbar.plot_code,
      plot_name: plotKalbar.name,
      reporter: {
        user_id: kader._id,
        full_name: kader.full_name,
        role_label: kader.role_badge,
        is_verified: true,
      },
      monitoring_date: new Date("2026-10-12T07:15:00Z"),
      postmark_badge: "12 Okt 2026 • Petak #KB-04",
      tree_metrics: {
        height_cm: 85,
        condition_status: "subur",
        condition_label: "Tumbuh Subur 🌿",
        estimated_survival_rate: 88.5,
      },
      field_notes:
        "Alhamdulillah, bibit jelutung rawa petak utara sudah berdaun lebat. Sekat kanal gambut berfungsi menjaga kelembaban tanah sehingga tidak terbakar di kemarau.",
      images: {
        initial_photo_url:
          "https://images.unsplash.com/photo-1542601906990-b4d3fb778b09?w=600&auto=format&fit=crop&q=80",
        initial_label: "15 Jan 2026 (Bibit 20cm)",
        current_photo_url:
          "https://images.unsplash.com/photo-1502082553048-f009c37129b9?w=600&auto=format&fit=crop&q=80",
        current_label: "12 Okt 2026 (Pohon 85cm)",
      },
      community_verifications: {
        confirmed_subur_count: 42,
        dispute_count: 0,
        verified_visitors: [],
      },
      comment_count: 8,
    },
    {
      plot_id: plotBekasi._id,
      plot_code: plotBekasi.plot_code,
      plot_name: plotBekasi.name,
      reporter: {
        user_id: new mongoose.Types.ObjectId(),
        full_name: "Ibu Ratna Dewi",
        role_label: "Kader Lapangan Terdaftar",
        is_verified: true,
      },
      monitoring_date: new Date("2026-10-11T10:00:00Z"),
      postmark_badge: "11 Okt 2026 • Petak #BK-02",
      tree_metrics: {
        height_cm: 110,
        condition_status: "subur",
        condition_label: "Tumbuh Subur 🌿",
        estimated_survival_rate: 83.5,
      },
      field_notes:
        "Penyiraman rutin bersama warga komplek berjalan lancar tiap akhir pekan. Pohon trembesi dan mahoni sudah mulai meneduhi area bekas pembuangan sampah liar.",
      images: {
        initial_photo_url:
          "https://images.unsplash.com/photo-1513836279014-a89f7a76ae86?w=600&auto=format&fit=crop&q=80",
        initial_label: "01 Feb 2026 (Bibit 30cm)",
        current_photo_url:
          "https://images.unsplash.com/photo-1448375240586-882707db888b?w=600&auto=format&fit=crop&q=80",
        current_label: "11 Okt 2026 (Pohon 110cm)",
      },
      community_verifications: {
        confirmed_subur_count: 31,
        dispute_count: 1,
        verified_visitors: [],
      },
      comment_count: 5,
    },
  ]);
  console.log("[Seeder] Catatan linimasa polaroid berhasil dibuat.");

  // 4. seed cache bnpb karhutla ----------------------------------------------------
  await BnpbSyncCacheModel.create({
    source: "WebGIS BNPB (gis.bnpb.go.id - 2026_karhutla)",
    layer: "mv_prov_karhutla_2026",
    sync_timestamp: new Date(),
    provinces: [
      {
        provinsi: "Kalimantan Barat",
        tgl_update: "2026-09-26",
        today_luas_terbakar_ha: 120.44,
        total_hotspot: 44,
        relawan_lapangan: 5281,
        kualitas_udara_pm25: "Tidak Sehat",
        buktipulih_coverage: {
          active_plots: 6,
          restored_area_ha: 18.2,
          alive_trees: 4850,
        },
      },
      {
        provinsi: "Kalimantan Tengah",
        tgl_update: "2026-09-26",
        today_luas_terbakar_ha: 335.1,
        total_hotspot: 3608,
        relawan_lapangan: 1163,
        kualitas_udara_pm25: "Baik-Berbahaya",
        buktipulih_coverage: {
          active_plots: 4,
          restored_area_ha: 12.5,
          alive_trees: 3200,
        },
      },
    ],
  });
  console.log("[Seeder] Cache awal data BNPB berhasil disuntikkan.");

  console.log("[Seeder] Seluruh pengisian data selesai dengan sukses!");
  await disconnectDatabase();
};

runSeed().catch((err) => {
  console.error("[Seeder] Galat:", err);
  process.exit(1);
});
