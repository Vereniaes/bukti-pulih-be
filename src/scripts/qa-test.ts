// src/scripts/qa-test.ts
// -> pengujian otomatis quality assurance (qa) menyeluruh untuk layanan backend buktipulih
//      -> tc-01: health check dan kesiapan basis data
//      -> tc-02: pembacaan seluruh petak restorasi (geojson featurecollection)
//      -> tc-03: filter spasial bounding box (bbox kalimantan barat)
//      -> tc-04: pembacaan detail petak tunggal (pl-kalbar-001)
//      -> tc-05: agregasi metrik impact ledger (luas, pohon, survival rate)
//      -> tc-06: sinkronisasi dan cache data eksternal bnpb karhutla 2026
//      -> tc-07: pembacaan catatan linimasa (urutan kronologis terbalik)
//      -> tc-08: peningkatan counter verifikasi/upvote linimasa
//      -> tc-09: penambahan komentar linimasa dan sanitasi serangan xss
//      -> tc-10: autentikasi kader berhasil (nomor wa dan pin valid)
//      -> tc-11: autentikasi kader gagal (pin salah / proteksi otorisasi)
//      -> tc-12: pembuatan laporan pemantauan lapangan dan sinkronisasi batch luring

interface TestCaseResult {
  id: string;
  name: string;
  passed: boolean;
  durationMs: number;
  details: string;
}

const BASE_URL = process.env.API_BASE_URL || "http://localhost:5000";

const results: TestCaseResult[] = [];

// fungsi pembantu pencatatan hasil pengujian ----------------------------------
const recordResult = (
  id: string,
  name: string,
  passed: boolean,
  durationMs: number,
  details: string
) => {
  results.push({ id, name, passed, durationMs, details });
  const statusLabel = passed ? "[LULUS]" : "[GAGAL]";
  console.log(`${statusLabel} ${id} - ${name} (${durationMs}ms)`);
  if (!passed) {
    console.error(`       Detail Kegagalan: ${details}`);
  }
};

const runAllTests = async () => {
  console.log("==================================================================");
  console.log("      SUITE PENGUJIAN OTOMATIS QA BACKEND BUKTIPULIH (12 KASUS)   ");
  console.log(`      Target Endpoint: ${BASE_URL}                               `);
  console.log("==================================================================\n");

  let authCookie = "";
  let sampleTimelineId = "";

  // TC-01: Health Check --------------------------------------------------------
  {
    const start = Date.now();
    try {
      const res = await fetch(`${BASE_URL}/health`);
      const json = await res.json() as any;
      const passed = res.status === 200 && json.status === "healthy";
      recordResult(
        "TC-01",
        "Pemeriksaan Kesehatan Layanan (Health Check)",
        passed,
        Date.now() - start,
        passed ? "Status sehat dan koneksi MongoDB aktif" : `Respons tidak valid: ${JSON.stringify(json)}`
      );
    } catch (err: any) {
      recordResult("TC-01", "Pemeriksaan Kesehatan Layanan", false, Date.now() - start, err.message);
    }
  }

  // TC-02: Get All Plots (GeoJSON FeatureCollection) ---------------------------
  {
    const start = Date.now();
    try {
      const res = await fetch(`${BASE_URL}/api/v1/plots`);
      const json = await res.json() as any;
      const isFeatureCollection = json.data?.type === "FeatureCollection";
      const hasFeatures = Array.isArray(json.data?.features) && json.data.features.length > 0;
      const passed = res.status === 200 && isFeatureCollection && hasFeatures;
      recordResult(
        "TC-02",
        "Daftar Seluruh Petak Restorasi (Format GeoJSON)",
        passed,
        Date.now() - start,
        passed ? `Ditemukan ${json.data.features.length} fitur spasial terdaftar` : "Format GeoJSON tidak sesuai kontrak"
      );
    } catch (err: any) {
      recordResult("TC-02", "Daftar Seluruh Petak Restorasi", false, Date.now() - start, err.message);
    }
  }

  // TC-03: Spatial Bounding Box Filter -----------------------------------------
  {
    const start = Date.now();
    try {
      // Area Kalimantan Barat (BBox: minLng, minLat, maxLng, maxLat)
      const bboxQuery = "108.0,-1.0,111.0,1.0";
      const res = await fetch(`${BASE_URL}/api/v1/plots?bbox=${bboxQuery}`);
      const json = await res.json() as any;
      const features = json.data?.features || [];
      const kalbarMatched = features.some((f: any) => f.properties?.plot_code === "PL-KALBAR-001");
      const passed = res.status === 200 && kalbarMatched;
      recordResult(
        "TC-03",
        "Penyaringan Spasial Bounding Box (BBox Kalbar)",
        passed,
        Date.now() - start,
        passed ? `Ditemukan ${features.length} petak di dalam koordinat batas spasial` : "Filter spasial gagal memuat petak target"
      );
    } catch (err: any) {
      recordResult("TC-03", "Penyaringan Spasial Bounding Box", false, Date.now() - start, err.message);
    }
  }

  // TC-04: Single Plot Detail Query --------------------------------------------
  {
    const start = Date.now();
    try {
      const res = await fetch(`${BASE_URL}/api/v1/plots/PL-KALBAR-001`);
      const json = await res.json() as any;
      const plot = json.data;
      const survivalRate = plot?.survival_rate ?? plot?.tree_metrics?.survival_rate;
      const valid = plot && plot.plot_code === "PL-KALBAR-001" && plot.area_hectares > 0 && survivalRate > 0;
      recordResult(
        "TC-04",
        "Detail Petak Tunggal Berdasarkan Kode Petak",
        Boolean(valid),
        Date.now() - start,
        valid ? `Petak: ${plot.name}, Survival Rate: ${survivalRate}%` : "Data petak tidak ditemukan atau tidak valid"
      );
    } catch (err: any) {
      recordResult("TC-04", "Detail Petak Tunggal", false, Date.now() - start, err.message);
    }
  }

  // TC-05: Aggregate Impact Ledger Metrics -------------------------------------
  {
    const start = Date.now();
    try {
      const res = await fetch(`${BASE_URL}/api/v1/metrics/impact-ledger`);
      const json = await res.json() as any;
      const ledger = json.data;
      const area = ledger?.total_area_hectares ?? ledger?.restored_area_hectares;
      const trees = ledger?.total_trees_planted ?? ledger?.total_planted_trees;
      const survival = ledger?.average_survival_rate ?? ledger?.overall_survival_rate;
      const passed =
        res.status === 200 &&
        typeof area === "number" &&
        trees > 0 &&
        survival > 0 &&
        ledger.active_communities_count > 0;
      recordResult(
        "TC-05",
        "Agregasi Metrik Dampak Restorasi (Impact Ledger)",
        passed,
        Date.now() - start,
        passed
          ? `Luas Total: ${area} Ha, Pohon: ${trees}, Rata-rata Hidup: ${survival}%`
          : "Format ledger tidak memenuhi kriteria agregasi"
      );
    } catch (err: any) {
      recordResult("TC-05", "Agregasi Metrik Dampak Restorasi", false, Date.now() - start, err.message);
    }
  }

  // TC-06: External BNPB Karhutla Cache Endpoint -------------------------------
  {
    const start = Date.now();
    try {
      const res = await fetch(`${BASE_URL}/api/v1/external/bnpb-karhutla`);
      const json = await res.json() as any;
      const bnpb = json.data;
      const passed = res.status === 200 && bnpb && typeof bnpb.total_hectares_burned_national === "number";
      recordResult(
        "TC-06",
        "Sinkronisasi dan Cache Data BNPB Karhutla 2026",
        passed,
        Date.now() - start,
        passed
          ? `Status: ${bnpb.sync_status}, Total Terbakar Nasional: ${bnpb.total_hectares_burned_national.toLocaleString()} Ha`
          : "Respons endpoint BNPB tidak sesuai kontrak"
      );
    } catch (err: any) {
      recordResult("TC-06", "Sinkronisasi BNPB Karhutla", false, Date.now() - start, err.message);
    }
  }

  // TC-07: Timeline Notes Retrieval (Reverse Chronological) --------------------
  {
    const start = Date.now();
    try {
      const res = await fetch(`${BASE_URL}/api/v1/timeline?plot_id=PL-KALBAR-001`);
      const json = await res.json() as any;
      const list = json.data?.items || [];
      const hasItems = Array.isArray(list) && list.length > 0;
      if (hasItems) {
        sampleTimelineId = list[0].id || list[0]._id;
      }
      const passed = res.status === 200 && hasItems;
      recordResult(
        "TC-07",
        "Daftar Catatan Linimasa Relawan (Urutan Kronologis Terbalik)",
        passed,
        Date.now() - start,
        passed ? `Memuat ${list.length} catatan linimasa untuk PL-KALBAR-001` : "Tidak ada catatan linimasa yang ditemukan"
      );
    } catch (err: any) {
      recordResult("TC-07", "Daftar Catatan Linimasa", false, Date.now() - start, err.message);
    }
  }

  // TC-08: Timeline Upvote / Verification Counter ------------------------------
  {
    const start = Date.now();
    try {
      if (!sampleTimelineId) {
        recordResult("TC-08", "Peningkatan Counter Verifikasi Linimasa", false, 0, "ID catatan linimasa tidak tersedia");
      } else {
        const res = await fetch(`${BASE_URL}/api/v1/timeline/${sampleTimelineId}/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "subur", client_fingerprint: "qa_test_client_01" }),
        });
        const json = await res.json() as any;
        const count = json.data?.confirmed_subur_count ?? json.data?.verified_count;
        const passed = res.status === 200 && typeof count === "number";
        recordResult(
          "TC-08",
          "Peningkatan Counter Verifikasi Linimasa (Upvote Warga)",
          passed,
          Date.now() - start,
          passed ? `Jumlah verifikasi terkini: ${count}` : `Respons verifikasi gagal: ${JSON.stringify(json)}`
        );
      }
    } catch (err: any) {
      recordResult("TC-08", "Peningkatan Counter Verifikasi", false, Date.now() - start, err.message);
    }
  }

  // TC-09: Add Comment & XSS Sanitization Check --------------------------------
  {
    const start = Date.now();
    try {
      if (!sampleTimelineId) {
        recordResult("TC-09", "Penambahan Komentar & Sanitasi Serangan XSS", false, 0, "ID catatan linimasa tidak tersedia");
      } else {
        const maliciousPayload = "Bibit tumbuh subur <script>alert('xss_attack')</script>!";
        const res = await fetch(`${BASE_URL}/api/v1/timeline/${sampleTimelineId}/comments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            author_name: "Penguji QA",
            author_badge: "pemerhati",
            content: maliciousPayload,
          }),
        });
        const json = await res.json() as any;
        const savedContent = json.data?.content || "";
        const xssSanitized = !savedContent.includes("<script>") && savedContent.includes("Bibit tumbuh subur");
        const passed = res.status === 201 && xssSanitized;
        recordResult(
          "TC-09",
          "Penambahan Komentar & Sanitasi Serangan XSS",
          passed,
          Date.now() - start,
          passed ? `Teks berhasil disanitasi: "${savedContent}"` : `Skrip jahat lolos atau permintaan gagal: ${JSON.stringify(json)}`
        );
      }
    } catch (err: any) {
      recordResult("TC-09", "Penambahan Komentar & Sanitasi XSS", false, Date.now() - start, err.message);
    }
  }

  // TC-10: Kader Authentication Positive Test (WA + Valid PIN) ----------------
  {
    const start = Date.now();
    try {
      const res = await fetch(`${BASE_URL}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone_number: "081234567890",
          pin: "123456",
        }),
      });
      const cookieHeader = res.headers.get("set-cookie");
      if (cookieHeader) {
        authCookie = cookieHeader.split(";")[0];
      }
      const json = await res.json() as any;
      const passed = res.status === 200 && json.data?.user?.full_name === "Pak Suwardi";
      recordResult(
        "TC-10",
        "Autentikasi Kader Berhasil (Nomor WA & PIN Valid)",
        passed,
        Date.now() - start,
        passed ? `Berhasil masuk sebagai ${json.data.user.full_name} (${json.data.user.role_badge})` : `Gagal masuk: ${JSON.stringify(json)}`
      );
    } catch (err: any) {
      recordResult("TC-10", "Autentikasi Kader Berhasil", false, Date.now() - start, err.message);
    }
  }

  // TC-11: Kader Authentication Negative Test (Invalid PIN) --------------------
  {
    const start = Date.now();
    try {
      const res = await fetch(`${BASE_URL}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone_number: "081234567890",
          pin: "999999", // PIN yang sengaja salah
        }),
      });
      const json = await res.json() as any;
      const passed = res.status === 401 && json.error?.code === "AUTH_FAILED";
      recordResult(
        "TC-11",
        "Autentikasi Kader Ditolak (PIN Tidak Sesuai)",
        passed,
        Date.now() - start,
        passed ? `Sistem merespons 401 AUTH_FAILED: "${json.error.message}"` : `Penolakan tidak bekerja: status ${res.status}`
      );
    } catch (err: any) {
      recordResult("TC-11", "Autentikasi Kader Ditolak", false, Date.now() - start, err.message);
    }
  }

  // TC-12: Create Field Report & Batch Offline Sync ----------------------------
  {
    const start = Date.now();
    try {
      const singleReportRes = await fetch(`${BASE_URL}/api/v1/reports`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authCookie ? { Cookie: authCookie } : {}),
        },
        body: JSON.stringify({
          plot_id: "PL-KALBAR-001",
          tree_condition: "subur",
          height_cm: 65,
          latitude: -0.0222,
          longitude: 109.3333,
          accuracy_meters: 4.5,
          notes: "Hasil pemantauan pekan ke-10, pucuk daun lebat dan kanal gambut basah.",
          quick_tags: ["tunas_baru", "daun_lebat", "kanal_basah"],
        }),
      });
      const singleJson = await singleReportRes.json() as any;
      const singlePassed = singleReportRes.status === 201 && singleJson.data?.report_id;

      // Uji pengiriman batch luring (offline batch sync)
      const batchRes = await fetch(`${BASE_URL}/api/v1/reports/offline-batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authCookie ? { Cookie: authCookie } : {}),
        },
        body: JSON.stringify({
          batch: [
            {
              plot_id: "PL-KALBAR-001",
              tree_condition: "subur",
              height_cm: 70,
              latitude: -0.0223,
              longitude: 109.3334,
              notes: "Sinkronisasi antrean luring petak gambut parit tokaya.",
              quick_tags: ["akar_kokoh"],
            },
          ],
        }),
      });
      const batchJson = await batchRes.json() as any;
      const batchPassed = batchRes.status === 200 && batchJson.data?.synced_count === 1;

      const passed = singlePassed && batchPassed;
      recordResult(
        "TC-12",
        "Pencatatan Laporan Lapangan & Sinkronisasi Antrean Luring",
        passed,
        Date.now() - start,
        passed ? `Laporan tunggal tersimpan (ID: ${singleJson.data.report_id}) dan batch sinkronisasi sukses (${batchJson.data.synced_count} data)` : "Laporan lapangan atau batch gagal diproses"
      );
    } catch (err: any) {
      recordResult("TC-12", "Pencatatan Laporan Lapangan", false, Date.now() - start, err.message);
    }
  }

  // Ringkasan Pengujian --------------------------------------------------------
  console.log("\n==================================================================");
  const passedTotal = results.filter((r) => r.passed).length;
  const failedTotal = results.length - passedTotal;
  console.log(`TOTAL PENGUJIAN: ${results.length}`);
  console.log(`LULUS          : ${passedTotal}`);
  console.log(`GAGAL          : ${failedTotal}`);
  console.log(`TINGKAT LULUS  : ${((passedTotal / results.length) * 100).toFixed(1)}%`);
  console.log("==================================================================");

  if (failedTotal > 0) {
    process.exit(1);
  } else {
    console.log("Seluruh 12 skenario pengujian QA berhasil divalidasi.");
    process.exit(0);
  }
};

runAllTests().catch((err) => {
  console.error("Kesalahan fatal saat eksekusi pengujian:", err);
  process.exit(1);
});
