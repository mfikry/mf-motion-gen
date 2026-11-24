# MF Motion Gen 2.0 — Technical Proof of Concept (HyperFrames Spike)

Direktori ini berisi implementasi mandiri Technical Proof of Concept (POC) untuk mengevaluasi kelayakan engine **HyperFrames** sebagai inti render HTML-to-Video pada proyek **MF Motion Gen 2.0**.

---

## 1. Lingkungan & Prasyarat Sistem Windows

- **Sistem Operasi:** Windows 10/11 x64
- **Node.js:** v22.x diperlukan oleh HyperFrames. (Binary portable `node.exe` v22.23.5 telah disediakan di folder `./tools/node22/` agar tidak mengganggu instalasi Node sistem global).
- **FFmpeg & FFprobe:** Wajib terpasang di sistem PATH (teruji menggunakan FFmpeg 7.0.2 Gyan build).
- **Google Chrome:** Wajib terpasang di lokasi standar (`C:\Program Files\Google\Chrome\Application\chrome.exe`).
- **GPU:** Kompatibel dengan Direct3D11 / ANGLE hardware acceleration.

---

## 2. Struktur Direktori POC

```text
poc/hyperframes-spike/
├── assets/
│   └── gsap.min.js                     # Asset GSAP lokal (offline)
├── compositions/
│   ├── input_b_ai_raw.html             # Kategori B: Raw AI HTML
│   ├── input_b_adapted.html            # Kategori B: Hasil adaptasi ke kontrak MF
│   └── input_c_canvas_adapter.html     # Kategori C: Harness Canvas renderFrame(...)
├── previews/
│   ├── frame-00-at-1s.png ...          # Screenshot preview browser
│   ├── render_frame_1s.png ...         # Ekstrak frame dari video hasil render
│   ├── diff_1s.png ...                 # Visual difference map
│   └── parity_summary.json             # Metrik PSNR & SSIM
├── renders/
│   ├── benchmark_1080p30.mp4           # Output MP4 1080p 30 FPS
│   ├── benchmark_4k30.mp4              # Output MP4 4K (3840x2160) 30 FPS
│   ├── benchmark_4k60.mp4              # Output MP4 4K (3840x2160) 60 FPS (480 frames)
│   ├── benchmark_prores4444.mov        # Output MOV ProRes 4444 dengan Alpha Channel
│   ├── test_canvas.mp4                 # Output render dari JavaScript Canvas mode
│   └── benchmark_summary.json          # Hasil pengukuran render benchmark
├── tests/
│   ├── test_determinism.mjs            # Pengujian seeking acak & repetisi
│   ├── run_render_benchmarks.mjs       # Script otomatisasi render 1080p, 4K, MOV
│   ├── test_input_compatibility.mjs    # Script evaluasi input A, B, C
│   └── evaluate_parity.mjs             # Script evaluasi paritas preview vs render
├── tools/
│   └── node22/node.exe                 # Portable Node.js v22 binary
├── index.html                          # Komposisi utama 8 detik (Aegis Core HUD)
├── hyperframes.json                    # Konfigurasi project HyperFrames
├── meta.json                           # Metadata project
├── package.json                        # Dependency manifest
└── POC_REPORT.md                       # Laporan Teknis Lengkap Bahasa Indonesia
```

---

## 3. Cara Menjalankan POC di Windows

Buka terminal PowerShell dan navigasikan ke folder spike:

```powershell
cd "f:\PROJECT\MF Motion Gen\poc\hyperframes-spike"
```

### A. Menjalankan Preview Snapshot Komposisi

Untuk mengambil snapshot preview pada detik tertentu (misal detik 1, 4, 7):

```powershell
& ".\tools\node22\node.exe" ".\node_modules\hyperframes\bin\hyperframes.mjs" snapshot --at 1,4,7
```

Hasil snapshot dan contact sheet tersimpan di `.hyperframes/artifacts/snapshots/`.

### B. Menjalankan Pengujian Determinisme

Untuk menguji seek acak, seek mundur, dan identitas SHA-256 frame:

```powershell
& ".\tools\node22\node.exe" ".\tests\test_determinism.mjs"
```

### C. Menjalankan Benchmark Render Lengkap (1080p, 4K30, 4K60, MOV ProRes)

Untuk merender seluruh varian video:

```powershell
& ".\tools\node22\node.exe" ".\tests\run_render_benchmarks.mjs"
```

Output video akan disimpan di folder `renders/`.

### D. Menjalankan Evaluasi Paritas Preview vs Render

Untuk mengekstrak frame dari video hasil render dan menghitung nilai PSNR/SSIM terhadap preview:

```powershell
& ".\tools\node22\node.exe" ".\tests\evaluate_parity.mjs"
```

### E. Menjalankan Pengujian Kompatibilitas Input (A, B, C)

Untuk menguji input raw AI dan Canvas `renderFrame`:

```powershell
& ".\tools\node22\node.exe" ".\tests\test_input_compatibility.mjs"
```

---

## 4. Laporan Hasil Lengkap

Silakan baca file [`POC_REPORT.md`](file:///f:/PROJECT/MF%20Motion%20Gen/poc/hyperframes-spike/POC_REPORT.md) untuk analisis komprehensif, tabel benchmark, temuan keamanan, keterbatasan, dan rekomendasi arsitektur final.
