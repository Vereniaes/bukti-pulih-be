# ⚙️ Bukti Pulih — Backend API Service & Data Pipeline

> **Layanan Backend Microservice Spasial, Integrasi Data Satelit Otomatis, & Autentikasi OTP**  
> *Karya Web Development Competition UINIC 8.0 — Tim Fomo Kemenangan*

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.12.0-green?logo=node.js)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.21.2-lightgrey?logo=express)](https://expressjs.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7.3-blue?logo=typescript)](https://www.typescriptlang.org/)
[![MongoDB](https://img.shields.io/badge/MongoDB%20Atlas-Mongoose%208.9-brightgreen?logo=mongodb)](https://www.mongodb.com/atlas)
[![Google Cloud Run](https://img.shields.io/badge/Deployed-Google%20Cloud%20Run-blue?logo=googlecloud)](https://cloud.google.com/run)
[![Frontend App](https://img.shields.io/badge/Frontend-BuktiPulih%20Web-success?logo=vercel)](https://bukti-pulih.vercel.app)

---

## 🔗 Keterhubungan dengan Frontend Web

Backend microservice ini dirancang secara khusus untuk melayani seluruh kebutuhan data spasial dan transaksi pengguna pada antarmuka frontend:
* **Repositori Frontend Lokal**: [`../BuktiPulih`](../BuktiPulih)
* **Website Frontend Live (Vercel Edge)**: [`https://bukti-pulih.vercel.app`](https://bukti-pulih.vercel.app)
* **Alamat Layanan Backend Live (Google Cloud Run)**: [`https://bukti-pulih-be-1049969018442.asia-southeast2.run.app`](https://bukti-pulih-be-1049969018442.asia-southeast2.run.app)
* **Status Health Check Live**: [`https://bukti-pulih-be-1049969018442.asia-southeast2.run.app/health`](https://bukti-pulih-be-1049969018442.asia-southeast2.run.app/health)

Backend mengelola pemrosesan data geospasial titik panas satelit, orkestrasi pembaruan berkala via Cloud Scheduler, validasi skema input pengguna, serta pengiriman email autentikasi passwordless OTP.

---

## 🏛️ Arsitektur Data Pipeline & Microservice (Mermaid Diagram)

```mermaid
graph TD
    subgraph Scheduler["⏱️ Cloud Scheduler (GCP Serverless)"]
        CronJob["Job: buktipulih-satellite-15m<br/>Jadwal: */15 * * * *<br/>Auth: OIDC Service Account"]
    end

    subgraph Service["☁️ Google Cloud Run (Containerized Microservice)"]
        Gateway["Express API Gateway & Security (Helmet, CORS, Rate Limit)"]
        CronEndpoint["POST /api/cron/sync-satellites<br/>(Verifikasi Token OIDC)"]
        WorkerSync["Worker Sinkronisasi Satelit & Sensor"]
        AuthModule["Modul Autentikasi Passwordless OTP"]
        SpatialModule["Modul Kueri Spasial & Polygon Petak"]
        PostsModule["Modul Pelaporan & Sanitasi Konten Warga"]
    end

    subgraph ExternalFeeds["🌐 Penyedia Data Eksternal Resmi"]
        NASA["NASA FIRMS API<br/>(Satelit VIIRS NOAA-20/21)"]
        ISPU["Kementerian Lingkungan Hidup<br/>(Sensor ISPU & PM2.5)"]
        BNPB["BNPB Geoportal MapServer 3<br/>(Layer Karhutla Provinsi)"]
        ECMWF["ECMWF IFS & Open-Meteo<br/>(Dispersi Angin 10m)"]
        Brevo["Brevo API Gateway<br/>(Transactional Email OTP)"]
    end

    subgraph Storage["🗄️ Basis Data MongoDB Atlas"]
        HotspotCol[("Collection: hotspots<br/>(2dsphere Spatial Index)")]
        HazardCol[("Collection: hazards & air_quality")]
        PlotsCol[("Collection: recovery_plots")]
        PostsCol[("Collection: community_posts")]
        UsersCol[("Collection: users & otp_sessions")]
    end

    subgraph ClientLayer["💻 Klien Konsumen"]
        NextFrontend["Frontend Next.js 16 (BuktiPulih)"]
    end

    CronJob -->|Pemicu Terjadwal 15 Menit| CronEndpoint
    CronEndpoint --> WorkerSync
    WorkerSync -->|Unduh Titik Panas NRT| NASA
    WorkerSync -->|Unduh Nilai ISPU Real-Time| ISPU
    WorkerSync -->|Unduh Poligon Bencana| BNPB
    WorkerSync -->|Simpan & Perbarui GeoJSON| HotspotCol
    WorkerSync -->|Simpan Status Mutakhir| HazardCol

    NextFrontend <-->|REST API HTTPS| Gateway
    Gateway --> AuthModule
    Gateway --> SpatialModule
    Gateway --> PostsModule

    AuthModule -->|Kirim Kode Verifikasi 6-Digit| Brevo
    AuthModule <-->|Simpan Hash HMAC-SHA256 & Sesi| UsersCol
    SpatialModule <-->|Kueri Spasial Radius & Bounds| HotspotCol
    SpatialModule <-->|Kueri Poligon Restorasi| PlotsCol
    PostsModule <-->|Simpan Laporan Bukti Terverifikasi| PostsCol
```

---

## 🛠️ Tech Stack & Modul Backend

* **Runtime Lingkungan**: [Node.js](https://nodejs.org/) versi `>= 22.12.0` (LTS)
* **Framework Web**: [Express (v4.21.2)](https://expressjs.com/) dengan TypeScript murni
* **Transpiler & Watcher**: [tsx (v4.19.2)](https://www.npmjs.com/package/tsx) & [TypeScript 5.7.3](https://www.typescriptlang.org/)
* **Basis Data Spasial**: [MongoDB Atlas](https://www.mongodb.com/atlas) dengan [Mongoose (v8.9.5)](https://mongoosejs.com/)
  * Indeks Geospasial `2dsphere` untuk kueri koordinat titik panas dan batas poligon petak pemulihan
* **Otomasi Terjadwal**: Google Cloud Scheduler (HTTP Target dengan OIDC Token)
* **Autentikasi & Email Transaksional**:
  * [Brevo Transactional Email API](https://www.brevo.com/) untuk pengiriman kode OTP numerik 6 digit
  * Enkripsi salt & peppered hash menggunakan Node.js Native Crypto `HMAC-SHA256` (masa kedaluwarsa 10 menit)
  * [jsonwebtoken (v9.0.2)](https://www.npmjs.com/package/jsonwebtoken) untuk penerbitan token sesi aman
* **Keamanan & Validasi Input**:
  * [Zod (v4.6.7)](https://zod.dev/) untuk validasi skema payload ketat
  * [sanitize-html (v2.18.1)](https://www.npmjs.com/package/sanitize-html) untuk proteksi serangan XSS pada postingan dan komentar warga
  * `cors`, `compression`, dan `cookie-parser`
* **Parser Berkas Satelit**: `csv-parse (v7.0.3)` untuk penguraian aliran data NASA FIRMS NRT CSV

---

## 📡 Daftar Kontrak Endpoint REST API

### 1. Sistem & Pemantauan Kesehatan
| Metode | Endpoint | Deskripsi |
| :--- | :--- | :--- |
| `GET` | `/health` | Memeriksa status hidup layanan Cloud Run dan koneksi MongoDB |

### 2. Autentikasi Passwordless OTP
| Metode | Endpoint | Deskripsi |
| :--- | :--- | :--- |
| `POST` | `/api/auth/request-otp` | Mengirimkan kode OTP 6-digit ke email pemohon via Brevo API |
| `POST` | `/api/auth/verify-otp` | Memvalidasi kode OTP dan mengembalikan token otentikasi sesi |
| `GET` | `/api/auth/me` | Mengambil data profil kontributor yang sedang aktif |
| `POST` | `/api/auth/logout` | Menghapus sesi otentikasi aktif |

### 3. Modul Spasial Karhutla & Kualitas Udara
| Metode | Endpoint | Deskripsi |
| :--- | :--- | :--- |
| `GET` | `/api/hotspots` | Mengambil data titik panas satelit NASA FIRMS (parameter: `province`, `confidence`, `startDate`, `endDate`) |
| `GET` | `/api/air-quality` | Mengambil indeks kualitas udara (ISPU KLH & PM2.5) stasiun pemantau |
| `GET` | `/api/hazards/summary` | Ringkasan indikator bahaya karhutla per provinsi terdampak |

### 4. Modul Pemulihan Lahan (Restorasi)
| Metode | Endpoint | Deskripsi |
| :--- | :--- | :--- |
| `GET` | `/api/recovery-plots` | Mengambil daftar petak pemulihan, batas poligon, bibit hidup, dan status TMAT |
| `GET` | `/api/recovery-plots/:id` | Rincian lengkap petak termasuk kronologi galeri foto Before-After |

### 5. Modul Pelaporan Partisipatif & Forum Komunitas
| Metode | Endpoint | Deskripsi |
| :--- | :--- | :--- |
| `GET` | `/api/posts` | Mengambil feed kiriman laporan warga (dengan filter wilayah dan kategori) |
| `GET` | `/api/posts/:id` | Detail kiriman bukti warga beserta thread komentar |
| `POST` | `/api/posts` | Mengunggah laporan bukti baru bergeolokasi (memerlukan token sesi OTP) |
| `POST` | `/api/posts/:id/comments` | Menambahkan tanggapan/komentar pada laporan warga |

### 6. Endpoint Pemicu Otomasi Satelit (Cloud Scheduler)
| Metode | Endpoint | Deskripsi |
| :--- | :--- | :--- |
| `POST` | `/api/cron/sync-satellites` | Memperbarui data satelit NASA FIRMS & ISPU KLH (terproteksi OIDC GCP) |

---

## 🔑 Konfigurasi Environment Variables

Salin berkas `.env.example` ke `.env` pada direktori `bukti-pulih-be/`:

```env
# Server Configuration
PORT=5000
NODE_ENV=production

# MongoDB Database Connection
MONGODB_URI=mongodb+srv://<username>:<password>@cluster0.mongodb.net/buktipulih?retryWrites=true&w=majority

# NASA FIRMS Satellite API (Kunci Akses Peta)
FIRMS_MAP_KEY=your_nasa_firms_map_key_here

# Kementerian Lingkungan Hidup ISPU API Header
ISPU_AUTHORIZATION=Bearer your_klh_ispu_token_here

# Brevo Transactional Email Service
BREVO_API_KEY=xkeysib-your_brevo_api_key_here
BREVO_SENDER_EMAIL=noreply@buktipulih.org
BREVO_SENDER_NAME=Bukti Pulih System

# Keamanan Sesi & OTP
JWT_SECRET=super_secret_jwt_key_here
OTP_PEPPER_SECRET=hmac_sha256_pepper_secret_here

# Google Cloud Scheduler Ingestion Protection
SATELLITE_SCHEDULER_AUDIENCE=https://bukti-pulih-be-1049969018442.asia-southeast2.run.app
```

---

## 🚀 Panduan Menjalankan Secara Lokal & Pengujian

### 1. Instalasi Dependensi
```bash
cd bukti-pulih-be
npm install
```

### 2. Menjalankan Server Pengembangan
```bash
npm run dev
```
Layanan akan aktif di `http://localhost:5000`.

### 3. Menjalankan Script Sinkronisasi Data Manual
```bash
# Sinkronisasi data titik panas NASA FIRMS
npm run sync:satellite

# Sinkronisasi data layer bencana karhutla BNPB
npm run sync:hazards
```

### 4. Eksekusi Pengujian Otomatis (Test Suite)
```bash
# Uji modul satelit dan scheduler
npm run test:satellite

# Uji autentikasi email OTP dan profil
npm run test:email-auth

# Uji pelaporan bukti geolokasi
npm run test:evidence
```

### 5. Build Container Docker
```bash
docker build -t bukti-pulih-be .
docker run -p 5000:5000 --env-file .env bukti-pulih-be
```

---

## 📄 Lisensi & Hak Cipta

Proyek ini dikembangkan oleh **Tim Fomo Kemenangan** untuk **Web Development Competition UINIC 8.0 (2026)**. Seluruh hak cipta dilindungi undang-undang.
