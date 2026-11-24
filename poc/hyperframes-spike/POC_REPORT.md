# LAPORAN TECHNICAL PROOF OF CONCEPT (POC)
# EVALUASI ENGINE HYPERFRAMES UNTUK MF MOTION GEN 2.0

- **Produk:** MF Motion Gen 2.0
- **Fase Proyek:** Phase 3 — Technical Proof of Concept
- **Lokasi Pengerjaan:** `poc/hyperframes-spike/`
- **Tanggal Evaluasi:** 23 November 2026
- **Status Gate:** **CONDITIONALLY PASSED (RECOMMENDED WITH ADAPTER CONSTRAINTS)**

---

## 1. Environment dan Versi Dependency yang Diuji

| Komponen | Spesifikasi / Versi Aktual | Catatan Teknis |
|---|---|---|
| **Sistem Operasi** | Windows 10/11 x64 (Build kernel win32) | AMD Ryzen 5 5600G with Radeon Graphics (12 logical cores), RAM 14 GB |
| **Node.js System** | v20.20.0 | *Incompatible*: HyperFrames menolak berjalan pada Node < 22 |
| **Node.js POC Pinned** | **v22.23.5** (win-x64 portable) | Dijalankan via binary lokal di `tools/node22/node.exe` |
| **HyperFrames Suite** | `hyperframes@0.9.84`, `@hyperframes/core@0.9.84`, `@hyperframes/engine@0.9.84`, `@hyperframes/producer@0.9.84` | Dipasang di `poc/hyperframes-spike/node_modules/` |
| **GSAP Runtime** | `gsap@3.15.0` (Lokal di `assets/gsap.min.js`) | Digunakan sebagai timeline seekable deterministik tanpa CDN |
| **Chromium / Browser** | Google Chrome v131+ (`C:\Program Files\Google\Chrome\Application\chrome.exe`) | ANGLE Direct3D11 hardware acceleration aktif |
| **FFmpeg Build** | `ffmpeg 7.0.2-essentials_build-www.gyan.dev` | Mendukung encoder `libx264` dan `prores_ks` (ProRes 4444) |

---

## 2. Daftar Test Case dan Hasil Aktual

| ID | Test Case | Target Pengujian | Hasil Aktual | Status |
|---|---|---|---|:---:|
| **TC-01** | **Komposisi Motion Graphic 8 Detik** | Render elemen kompleks: countdown ring, linear progress, system breach glitch, SVG/CSS layers, gradients, glow. | Berhasil dikompilasi dan dirender penuh tanpa error runtime. Visual setara benchmark microstock. | **PASS** |
| **TC-02** | **Repeatability Determinisme Frame** | Pengambilan snapshot berulang pada timestamp identik (t = 3.0s). | Checksum SHA-256 identik 100% bit-for-bit: `1B324E3D22345CC9094C2CE44100B190E6B8C97A940F8511DDB1B1831CF72198`. | **PASS** |
| **TC-03** | **Random & Backward Seeking** | Seek acak ke frame 90 → 10 → 50 → 10 → 90. | Pada level visual PSNR > 73 dB. Ditemukan bahwa pemanggilan imperatif `tl.call()` tidak me-rewind style saat seek mundur; wajib menggunakan GSAP property tween murni. | **PARTIAL / CONSTRAINED** |
| **TC-04** | **Render 1080p 30 FPS MP4** | 1920×1080 pada 30 FPS, durasi 8.0s (240 frame). | Exit Code 0. Berhasil dibuat: `benchmark_1080p30.mp4`, 1.80 MB, H.264 High Profile, `yuv420p`. Durasi: 281.88s. | **PASS** |
| **TC-05** | **Render 4K 30 FPS MP4** | 3840×2160 pada 30 FPS, durasi 8.0s (240 frame). | Exit Code 0. Berhasil dibuat: `benchmark_4k30.mp4`, 4.29 MB, H.264 High Profile, `yuv420p`. Durasi: 297.19s. | **PASS** |
| **TC-06** | **Render 4K 60 FPS MP4** | 3840×2160 pada 60 FPS, durasi 8.0s (480 frame). | Exit Code 0. Berhasil dibuat: `benchmark_4k60.mp4`, 5.53 MB, H.264 High Profile, `yuv420p`. Durasi: 541.38s (~9 menit). | **PASS** |
| **TC-07** | **Render MOV ProRes 4444 Alpha** | Ekspor video transparan MOV ProRes 4444. | Exit Code 0. Berhasil dibuat: `benchmark_prores4444.mov`, 202.46 MB, Codec `prores` Profile `4444`, Pixel Format `yuva444p12le` (Alpha channel utuh). Durasi: 172.31s. | **PASS** |
| **TC-08** | **Kompatibilitas Input Kategori A** | HTML native HyperFrames contract. | Didukung penuh tanpa adapter tambahan. | **PASS** |
| **TC-09** | **Kompatibilitas Input Kategori B** | HTML standalone dari AI tanpa atribut HyperFrames. | Tidak dapat dirender langsung; memerlukan adapter injeksi root container `data-composition-id` dan binding timeline. | **PARTIAL (Perlu Adapter)** |
| **TC-10** | **Kompatibilitas Input Kategori C** | JavaScript Canvas `renderFrame(ctx, time, frame, totalFrames, config)`. | Berhasil dirender menjadi video MP4 (`test_canvas.mp4`, 186 KB) melalui Canvas Adapter Harness. | **PASS (Via Harness)** |
| **TC-11** | **Paritas Preview vs Render Video** | Perbandingan screenshot preview browser vs frame hasil render MP4 pada timestamp 1s, 4s, dan 7s. | Geometri & posisi 100% sejajar. SSIM rata-rata 0.967 (96.7%), PSNR rata-rata 35.3 dB. Deviasi kecil terjadi murni akibat chroma subsampling YUV 4:2:0 dan kompresi lossy DCT H.264. | **PASS** |
| **TC-12** | **Kemandirian Asset Offline** | Bebas dari ketergantungan CDN eksternal saat render. | GSAP dibundel lokal (`assets/gsap.min.js`), seluruh SVG dan style lokal. Font Google difetch dan dicache secara otomatis ke cache lokal deterministik. | **PASS** |

---

## 3. Pengukuran Waktu Rendering dan Penggunaan Resource

Pengujian dilakukan pada mesin Windows: AMD Ryzen 5 5600G (6 Core / 12 Thread), RAM 14 GB, SSD NVMe.

| Konfigurasi Target | Total Frame | Waktu Render (Detik) | Rata-rata FPS Render | Ukuran File | Bitrate Video | Peak RAM Browser Workers |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **1080p @ 30 FPS (MP4)** | 240 frame | **281.88 s** (~4.7 min) | ~0.85 fps | 1.80 MB | 1.88 Mbps | ~650 MB |
| **4K (2160p) @ 30 FPS (MP4)** | 240 frame | **297.19 s** (~4.9 min) | ~0.81 fps | 4.29 MB | 4.49 Mbps | ~1.15 GB |
| **4K (2160p) @ 60 FPS (MP4)** | 480 frame | **541.38 s** (~9.0 min) | ~0.88 fps | 5.53 MB | 5.79 Mbps | ~1.25 GB |
| **1080p @ 30 FPS (MOV ProRes 4444)** | 240 frame | **172.31 s** (~2.8 min) | ~1.39 fps | 202.46 MB | 212.29 Mbps | ~800 MB |
| **1080p @ 30 FPS (Canvas Adapter)** | 240 frame | **142.39 s** (~2.3 min) | ~1.68 fps | 186.0 KB | 0.19 Mbps | ~450 MB |

### Analisis Kinerja:
1. **Performa 4K:** HyperFrames menangani 4K melalui penskalaan DPR (*Device Pixel Ratio* / `deviceScaleFactor = 2`). Render 4K30 membutuhkan waktu hampir sama dengan 1080p30 karena bottleneck utama berada pada screenshot paint capture per frame di Chromium.
2. **Efisiensi ProRes 4444:** MOV ProRes 4444 justru beroperasi **lebih cepat (172s vs 281s)** dibandingkan H.264 MP4 karena encoder ProRes berbasis I-frame murni tanpa inter-frame motion estimation yang kompleks seperti pada encoder H.264 CPU (`libx264`).
3. **Kestabilan Memori:** Penggunaan memori terpantau stabil pada ~1.2 GB peak RAM untuk 2 browser worker, tanpa adanya memory leak atau thrashing pada RAM 14 GB.

---

## 4. Hasil Perbandingan Preview dan Render (Paritas Visual)

Perbandingan dilakukan antara screenshot browser preview (RGB 24-bit tanpa kompresi) dengan frame yang diekstrak dari file video MP4 hasil render pada frame yang sama persis:

```text
Timestamp 1.0s (Frame 30):
  - PSNR: 38.16 dB
  - SSIM: 0.9738 (97.38% kesamaan struktural)
  - Evaluasi: Sempurna. Posisi HUD, text glyph, timer "07.00s", dan progress bar identik.

Timestamp 4.0s (Frame 120):
  - PSNR: 37.59 dB
  - SSIM: 0.9714 (97.14% kesamaan struktural)
  - Evaluasi: Sempurna. Bus telemetry spectrum dan circular gauge terisi 73% persis sejajar.

Timestamp 7.0s (Frame 210):
  - PSNR: 30.18 dB
  - SSIM: 0.9573 (95.73% kesamaan struktural)
  - Evaluasi: Sangat Baik. Munculnya alert glitch merah dengan intensitas kontras tinggi mengalami penurunan PSNR minor akibat chroma subsampling (4:2:0) pada kompresi H.264, namun tidak ada pergeseran posisi atau glitch geometri.
```

Visual difference map (`diff_1s.png`, `diff_4s.png`, `diff_7s.png`) menunjukkan selisih pixel hanya terjadi di area transisi subpixel anti-aliasing teks dan edge gradien warna merah/cyan jenuh tinggi.

---

## 5. Hasil Pengujian Kompatibilitas Input

### A. Kategori A: HTML HyperFrames-Compatible
- **Kelayakan:** **100% Native Compatible.**
- **Mekanisme:** Menggunakan struktur resmi `<div id="root" data-composition-id="main" data-start="0" data-duration="8">`, elemen beranimasi dengan `class="clip"`, dan timeline GSAP `paused: true` yang terdaftar pada `window.__timelines["main"]`.
- **Exact Seeking:** Berfungsi deterministik penuh.

### B. Kategori B: HTML Standalone dari AI (Tanpa Atribut HyperFrames)
- **Kelayakan:** **Tidak dapat dirender langsung tanpa adapter.**
- **Temuan Teknis:**
  1. HyperFrames menuntut keberadaan atribut `data-composition-id` dan `data-duration`. Tanpa itu, compiler gagal menentukan durasi total frame dan target capture.
  2. Animasi AI yang menggunakan infinite loop (`repeat: -1`) atau wall-clock `setInterval`/`requestAnimationFrame` tidak dapat di-seek.
- **Solusi / Adapter yang Dibutuhkan:**
  - Parser otomatis MF Motion Gen yang membungkus konten HTML AI ke dalam root container `<div id="root" data-composition-id="main" ...>`.
  - Injeksi script bridge yang menangkap timeline GSAP yang dibuat oleh AI, memanggil `.pause()`, lalu meregistrasikannya ke `window.__timelines["main"]`.

### C. Kategori C: JavaScript Canvas Mode
- **Signature:** `function renderFrame(ctx, time, frame, totalFrames, config)`
- **Kelayakan:** **Berhasil 100% menggunakan Canvas Adapter Harness.**
- **Temuan Teknis:**
  - HyperFrames tidak memiliki runner murni untuk fungsi Canvas JS tanpa dokumen HTML.
  - Namun, dengan membuat file wrapper HTML harness (`compositions/input_c_canvas_adapter.html`) yang memuat `<canvas width="1920" height="1080">` dan timeline GSAP virtual yang memicu `renderFrame(ctx, time, frame, ...)` pada setiap update tick, komposisi Canvas berhasil dirender menjadi video MP4 yang sangat mulus dan stabil dalam waktu 142 detik.

---

## 6. Temuan Keamanan dan Risiko Untrusted Code

HTML dan JavaScript yang dihasilkan oleh AI dari pihak luar adalah **untrusted code**.

### Temuan Selama Spike:
1. **Node Integration:** Konten HTML yang dimuat langsung di browser Chrome headless tidak memiliki akses ke runtime Node.js, filesystem, atau environment variable host. Ini adalah pemisahan proses yang sehat.
2. **Akses Jaringan:** HyperFrames secara default mencoba mengunduh font Google (`@font-face`) jika terdeteksi font web. Untuk mode produksi offline yang aman, akses jaringan eksternal **wajib diblokir (default-deny)** melalui Content Security Policy (CSP) dan local DNS/network flag.
3. **Risiko Infinite Loop / Memory Bomb:** Skrip untrusted yang sengaja atau tidak sengaja mengeksekusi `while(true)` atau alokasi buffer tak terhingga dapat menggantung proses render.
4. **Local File Access:** Jika Chromium dijalankan dengan flag `--allow-file-access-from-files`, konten untrusted berpotensi membaca file lokal melalui XHR/fetch jika tidak dibatasi oleh sandbox Chromium.

### Model Isolasi Wajib untuk Aplikasi Produksi (MF Motion Gen Desktop):
- Renderer Preview dan Render Worker harus berjalan pada **Chromium Child Process terpisah** (bukan di dalam Main Process Electron).
- `nodeIntegration: false`, `contextIsolation: true`, dan `sandbox: true` diaktifkan secara ketat pada webview/iframe preview.
- Terapkan CSP ketat: `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob: file:; font-src data: file:;`.
- Terapkan batas waktu eksekusi (*render timeout*) dan batas memori maksimum (misal 2.5 GB per worker). Apabila terjadi crash/hang, bunuh worker process secara aman tanpa membuat aplikasi utama desktop tertutup.

---

## 7. Keterbatasan yang Ditemukan (Limitations)

1. **Persyaratan Node.js >= 22:** HyperFrames v0.9.84 secara tegas memblokir eksekusi pada Node.js < 22 (`runtimeVersionError`). Untuk lingkungan produksi Electron, runtime Node internal atau binary child process harus dipastikan berada pada versi Node 22+.
2. **Maturitas Frame Adapter API:** API adapter masih berada pada level v0/eksperimental. Seluruh interaksi dengan HyperFrames wajib dibungkus di dalam internal adapter MF Motion Gen agar perubahan API upstream tidak merusak kode aplikasi utama.
3. **Batasan Callback Imperatif (`tl.call`):** Dalam pengujian backward seek, penggunaan JavaScript callback murni di dalam GSAP timeline (`tl.call()`) tidak secara otomatis mengembalikan state style saat timeline di-seek mundur. Pembuat konten/AI wajib diinstruksikan untuk menganimasikan properti via GSAP tween (`tl.to`, `tl.fromTo`), bukan mutasi DOM manual via callback.
4. **Durasi Render 4K:** Render 4K60 berdurasi 8 detik membutuhkan waktu ~9 menit pada CPU 12-thread. Ini adalah karakteristik normal dari frame-by-frame screenshot rendering, namun UI aplikasi nantinya wajib menyediakan estimasi progress bar, cancellation token, dan indikator waktu yang akurat.

---

## 8. Rekomendasi PASS / PARTIAL / FAIL per Persyaratan

| Persyaratan PRD / Spike | Evaluasi | Catatan & Rekomendasi |
|---|:---:|---|
| **1. Rendering HTML Motion Graphic** | **PASS** | Visual motion graphic berkualitas microstock berhasil dirender dengan ketajaman tinggi. |
| **2. Deterministic Exact Frame Seeking** | **PASS** | Repeatability snapshot terbukti 100% bit-exact (SHA-256 identik). Backward seek memerlukan aturan penulisan GSAP properti murni. |
| **3. Output Video MP4 Stabil** | **PASS** | Berhasil pada 1080p30, 4K30, dan 4K60 dengan encoding H.264 High Profile. |
| **4. Output MOV ProRes 4444 Transparan** | **PASS** | Berhasil diekspor dengan profil `4444` dan pixel format `yuva444p12le` (Alpha channel aktif). |
| **5. Paritas Preview vs Render Video** | **PASS** | SSIM 0.967, PSNR 35.3 dB. Geometri dan timing sejajar sempurna. |
| **6. Penanganan Asset Lokal & Efek Visual** | **PASS** | SVG, CSS gradients, blur, glow, transforms, dan glitch berhasil dieksekusi dengan akselerasi GPU Direct3D11 di Windows. |
| **7. Kompatibilitas Windows** | **PASS** | Berjalan mulus di Windows 10/11 x64 dengan GPU AMD Radeon dan FFmpeg native. |
| **8. Kompatibilitas Input AI & Canvas** | **PASS (VIA ADAPTER)** | Kategori B memerlukan injeksi root metadata; Kategori C memerlukan Canvas Adapter Harness. |

---

## 9. Kesimpulan & Rekomendasi Arsitektur

**HyperFrames terbukti LAYAK dan MEMENUHI SYARAT (RECOMMENDED) untuk dilanjutkan sebagai core render engine MF Motion Gen 2.0.**

### Rekomendasi Implementasi Fase Berikutnya (Phase 4):
1. **Bangun MF Motion Internal Adapter:** Jangan mengekspos API HyperFrames langsung ke UI Electron. Bungkus di balik modul `MfMotionRenderer`.
2. **Implementasikan Ingestion Pre-processor:** Buat modul validator dan auto-wrapper untuk memformat HTML dari AI (Kategori B) dan Canvas functions (Kategori C) ke dalam kontrak HyperFrames sebelum dikirim ke engine render.
3. **Bundling Node 22:** Pastikan Electron worker atau background service yang mengeksekusi HyperFrames menggunakan Node 22 runtime yang sesuai.
