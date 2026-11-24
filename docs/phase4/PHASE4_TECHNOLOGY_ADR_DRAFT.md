# MF Motion Gen 2.0 — Architecture Decision Records (ADR)
## Phase 4: Technology Evaluation & Selection (Final Validation Draft)

**Dokumen:** Architecture Decision Records (ADR) Final Validation Draft  
**Tahap:** Phase 4 — Architecture & Design  
**Tanggal:** 24 November 2026  
**Penulis:** Antigravity (Implementation Engineer & Technical Researcher)  
**Reviewer:** ChatGPT (Project Manager & Technical Architect)  
**Persetujuan & Keputusan:** Product Owner (User)  
**Status Dokumen:** REVISED DRAFT FOR PM & PO REVIEW (Pending Validation Gate)

---

## Bagian Khusus: PM Review Corrections & Decision Status

Revisi ini menyelesaikan seluruh temuan akhir dari Project Manager (PM):
1. **ADR-001 & ADR-002 (Electron Lifecycle & Node Runtime Cadence):**
   - Menghapus terminologi "LTS" untuk Electron 46/47; menggunakan istilah resmi **stable release** dan **supported releases** (kebijakan resmi hanya mendukung 3 rilis major terakhir).
   - Menegaskan jadwal resmi: **Electron 45 EOL pada 27 April 2027**; **Electron 46 stable dijadwalkan pada 5 Januari 2027 (tentatif)** dengan cadence rilis ~8 minggu.
   - Menegaskan bahwa runtime Node.js terikat langsung (*tightly bound*) pada versi yang dipaketkan oleh Electron target (bukan runtime independen yang permanen).
   - Menolak penguncian permanen pada Electron 45.4.1 dan menetapkan matriks pengujian regresi visual saat upgrade versi.
   - *Status: Proposed (Menunggu Persetujuan PM & PO).*
2. **ADR-003 & ADR-006 (HyperFrames Engine, Parity Wording & chrome-headless-shell):**
   - Memperbaiki klaim paritas: menyematkan biner renderer/browser (*pinned engine*) meminimalkan variasi versi browser engine, namun **paritas piksel eksak (*exact bit-level pixel parity*) tetap dipengaruhi oleh font rasterizer, akselerasi GPU/Skia display list, codec colorspace conversion, dan lingkungan host**.
   - Mengkaji arsitektur internal HyperFrames yang mengandalkan biner tersemat `chrome-headless-shell` dan Chrome DevTools Protocol (CDP) `HeadlessExperimental.beginFrame`.
   - Menyajikan matriks komparasi 8 dimensi antara Opsi A (Hybrid) vs Opsi B (Unified Engine).
   - Menetapkan gerbang validasi wajib (*Spike Test 4.1-A*) sebelum keputusan akhir diambil.
   - *Status: Pending Validation Gate (Spike Test 4.1-A).*
3. **ADR-004 (HTML / GSAP Authoring Compatibility & Seek Protocols):**
   - Memverifikasi kontrak dasar `window.__hf`: hanya mencakup properti `duration` (numerik detik) dan `seek(timeInSeconds)`. Properti `media` **tidak dijadikan properti wajib**, melainkan dijelaskan sebagai integrasi opsional terpisah jika komposisi memuat elemen audio/video lokal.
   - Menangani pendaftaran timeline yang tertunda (*late timeline registration*) secara eksplisit via getter/setter trap atau event listener.
   - Mengevaluasi parameter `suppressEvents = true` pada GSAP `.seek()` terhadap dependensi callback (`onUpdate`, `onComplete`, `call()`).
   - Menolak klaim bahwa seluruh animasi GSAP otomatis kompatibel; jika terdeteksi struktur timeline atau callback ambigu, sistem wajib mengeluarkan status `[WARNING: UNSUPPORTED / AMBIGUOUS TIMELINE / CALLBACK DEPENDENCY]`.
   - Mengeliminasi modifikasi visibilitas manual elemen `.clip` sebelum validasi empiris di Milestone 4.1.
   - *Status: Proposed (Menunggu Persetujuan PM & PO).*
4. **ADR-005 (Re-evaluasi `@hyperframes/producer` vs Custom FFmpeg Pipeline):**
   - Mengakui bahwa dokumentasi upstream `@hyperframes/producer` menyebutkan dukungan untuk: **audio mixing, MP4 H.264, MOV transparent ProRes 4444, dan pembatalan berbasis `AbortSignal`**.
   - Menyajikan matriks komparasi yang membedakan: (1) Kemampuan yang didokumentasikan upstream, (2) Kemampuan yang telah terbukti pada versi tertentu, dan (3) Kemampuan yang belum divalidasi.
   - Memprioritaskan pengujian empiris terhadap kandidat pinned `@hyperframes/producer` versi 0.9.86 pada Spike Test 4.1-B (tanpa menambah dependensi sekarang) untuk memvalidasi: ProRes 4444, presisi alpha channel, format piksel (`yuva444p12le`), audio mixing, kualitas output, pembatalan `AbortSignal`, serta kompatibilitas aset lokal/font/HTML Gemini.
   - Menyoroti perilaku Producer terkait pengunduhan remote scripts/stylesheets dan menetapkan keharusan isolasi offline (*default-deny*).
   - Mendokumentasikan implikasi lisensi GPL v3 untuk biner eksternal Gyan.dev dan menandai kebutuhan **Legal Review**.
   - *Status: Proposed (Menunggu Spike Test 4.1-B & Legal Review).*

---

## ADR-001: Desktop Application Framework & Lifecycle Management

### 1. Context & Problem Statement
MF Motion Gen 2.0 membutuhkan kerangka kerja desktop Windows untuk mengorkestrasi antarmuka visual studio, memuat komposisi HTML eksternal yang tidak tepercaya, dan mengelola proses render video latar belakang berkinerja tinggi. 

Pada peninjauan tanggal 24 November 2026, Electron v45.4.1 berstatus *Current Stable* (Chromium 156, Node 24.22.3). Namun, jadwal siklus hidup resmi Electron menetapkan bahwa:
- Electron memiliki siklus rilis major setiap **8 minggu**.
- Electron **hanya mendukung tiga rilis major terakhir** secara bersamaan (*three supported major versions policy*).
- **Electron 45 mencapai End-of-Life (EOL) pada 27 April 2027** (~5 bulan lagi).
- **Electron 46 stable dijadwalkan rilis pada 5 Januari 2027 (tentatif)**.
- Electron **TIDAK menggunakan istilah Long Term Support (LTS)** untuk rilis 46 atau 47; seluruh rilis adalah *stable release* dengan jendela dukungan terbatas selama 3 siklus major (~24 minggu).

Oleh karena itu, MF Motion Gen tidak boleh mengunci (*hard-lock*) versi Electron 45.4.1 secara permanen sebagai versi produk akhir, melainkan wajib memiliki strategi siklus hidup dan prosedur pembaruan yang terdefinisi.

### 2. Kandidat Teknologi
1. **Electron (Cadence-Tracking Stable Architecture):** Mengawali pengembangan pondasi Phase 4 pada Electron 45.4.1 Stable, dengan arsitektur terisolasi (*decoupled*) yang siap bertransisi ke Electron 46 saat rilis stabil tersedia, sebelum Electron 45 mencapai EOL pada April 2027.
2. **Tauri 2.x:** Berbasis Rust dengan Microsoft Edge WebView2 bawaan Windows.
3. **Custom .NET 9 WinUI 3 + WebView2:** Aplikasi native Windows berbasis C# / XAML.

### 3. Bukti Kompatibilitas dengan Hasil POC Phase 3
- Seluruh pipeline pengujian Phase 3 tervalidasi menggunakan Chromium Engine (v158.0). Paritas rasterisasi Skia GPU terbukti menghasilkan SSIM 0.9879 pada render mezzanine ProRes 4444 (Round 1).
- Electron menyediakan lingkungan Chromium terpaket yang seragam di seluruh instalasi Windows tanpa terpengaruh oleh variasi versi browser Edge lokal pada sistem operasi pengguna.

### 4. Analisis Kelebihan & Kekurangan
| Kandidat | Kelebihan | Kekurangan |
| :--- | :--- | :--- |
| **Electron** | • Menjamin keseragaman engine Chromium di seluruh instalasi Windows tanpa variasi sistem pengguna.<br>• Ekosistem multi-proses matang (`Main`, `Renderer`, `utilityProcess`).<br>• Dukungan mendalam terhadap integrasi Puppeteer dan Chrome DevTools Protocol (CDP). | • Ukuran installer besar (~150 MB).<br>• Siklus EOL cepat (~6 bulan per versi major; Electron 45 EOL pada 27 April 2027).<br>• Memerlukan alokasi pemeliharaan berkala untuk mengikuti upgrade major. |
| **Tauri 2.x** | • Ukuran installer sangat kecil (~25 MB).<br>• Keamanan memori berbasis Rust. | • Bergantung pada runtime WebView2 Windows yang versinya bervariasi antar-komputer pengguna (berisiko memicu *visual drift*).<br>• Integrasi CDP tingkat rendah untuk stepping frame virtual terbatas. |
| **.NET 9 WinUI 3** | • Integrasi antarmuka native Windows yang sangat mulus. | • Memerlukan implementasi ulang seluruh ekosistem JavaScript/DOM di lingkungan C#.<br>• Ketergantungan WebView2 sama dengan Tauri. |

### 5. Kebijakan Siklus Hidup & Pembaruan Keamanan (Lifecycle & Upgrade Policy)
- **Security Patch Cadence:** Mengikuti rilis patch minor (misal `45.4.x`) secara terjadwal untuk menambal kerentanan keamanan upstream Chromium dan Node.js.
- **Major Upgrade Cadence (8 Minggu):** Tim engineering menjadwalkan evaluasi rilis major baru setiap 8 minggu. Ketika Electron 46 dirilis stabil (tentatif 5 Januari 2027), cabang evaluasi dibuat untuk menguji kompatibilitas. Transisi penuh wajib selesai sebelum 27 April 2027 (saat Electron 45 EOL).
- **Automated Regression Visual Test Matrix:** Setiap pembaruan versi major Electron wajib menjalankan suite benchmark otomatis Round 1 (NEXUS) dan Round 2 (Breaking News) untuk mendeteksi potensi regresi rasterisasi font Skia, rendering kurva SVG, atau tata letak CSS.

### 6. Rekomendasi
**Rekomendasi: Adopsi Electron dengan Kebijakan Pembaruan Cadence Aktif (Bukan Hard-Lock).**  
Pondasi arsitektur Phase 4 diinisialisasi pada **Electron 45.4.1 Stable**, dengan struktur kode yang dirancang modular agar pembaruan ke Electron 46 (awal 2027) dapat dieksekusi tanpa merombak logika bisnis aplikasi.

### 7. Konsekuensi Keputusan
- Roadmap proyek wajib mengalokasikan sprint pemeliharaan reguler setiap 2–3 bulan.
- Seluruh kode pemanggil Electron diisolasi di balik layer abstraksi host agar tidak terikat pada API internal yang terdepresiasi.

### 8. Sumber Resmi & Tanggal Pengecekan
- Electron Release Timelines: https://www.electronjs.org/docs/latest/tutorial/electron-timelines (Diperiksa: 24 November 2026 — Electron 45 EOL: 27 April 2027; Electron 46 tentatif: 5 Januari 2027).
- Electron Supported Versions Policy: https://www.electronjs.org/docs/latest/tutorial/support#supported-versions (Hanya 3 versi major terakhir yang didukung).

---

## ADR-002: Application & Worker Runtime

### 1. Context & Problem Statement
Aplikasi membutuhkan runtime JavaScript/TypeScript untuk Main Process, orkestrasi worker rendering latar belakang, parser DOM statis, dan interaksi sistem berkas. Diperlukan kepastian apakah worker rendering dijalankan melalui `utilityProcess` bawaan Electron atau melalui biner `node.exe` eksternal (*standalone sidecar*).

Selain itu, runtime Node.js dalam Electron **terikat langsung pada versi yang dipaketkan oleh Electron target** (misalnya Node.js 24.22.3 pada Electron 45.4.1), bukan entitas independen yang diasumsikan statis atau tidak berubah.

### 2. Kandidat Teknologi
1. **Node.js Terbundel via Electron `utilityProcess`:** Runtime Node.js bawaan Electron yang mengikuti versi Electron target (Node 24 pada Electron 45).
2. **Node.js Standalone Sidecar (`node.exe` terpisah):** Mendistribusikan biner `node.exe` mandiri (misal Node 22 atau Node 24) di dalam installer aplikasi.

### 3. Bukti Kompatibilitas dengan Hasil POC Phase 3
- Seluruh kode spike Phase 3 ditulis dalam JavaScript ESM murni tanpa ketergantungan pada native C++ addons (`node-gyp`).
- Skrip audit DOM, parser metadata, generator checksum SHA-256, dan pipeline spawning FFmpeg terbukti berjalan 100% mulus pada modul standar Node.js `fs`, `child_process`, `stream/promises`, dan `crypto`.

### 4. Analisis Kelebihan & Kekurangan
| Kandidat | Kelebihan | Kekurangan |
| :--- | :--- | :--- |
| **Node.js Terbundel (`utilityProcess`)** | • Mengeliminasi kebutuhan mendistribusikan biner `node.exe` terpisah (~83 MB dihemat dari installer).<br>• Komunikasi IPC efisien berbasis `MessagePort`.<br>• Proses latar belakang terisolasi tanpa overhead jendela grafis Chromium. | • Versi Node.js terikat pada versi Electron target (mengalami upgrade otomatis saat Electron di-upgrade). |
| **Node.js Standalone Sidecar** | • Versi runtime Node.js dapat dikunci independen dari versi Electron. | • Ukuran installer membengkak ganda.<br>• Berisiko tinggi memicu false-positive pada antivirus Windows (Windows Defender memblokir eksekusi `node.exe` yang di-spawn dari direktori lokal pengguna). |

### 5. Batas Keamanan Mutlak Worker (`utilityProcess`)
- **PENTING:** Electron `utilityProcess` berjalan **dengan integrasi Node.js aktif** (`nodeIntegration: true` secara internal).
- Oleh karena itu, `utilityProcess` **HANYA BOLEH BERTINDAK SEBAGAI TRUSTED ORCHESTRATOR**.
- Konten HTML, CSS, dan JavaScript yang diimpor dari Gemini AI Studio **DILARANG KERAS dieksekusi langsung di dalam konteks `utilityProcess`**. Konten tidak tepercaya wajib tetap dieksekusi di dalam kontainer browser sandbox terisolasi.

### 6. Rekomendasi
**Rekomendasi: Adopsi Node.js Terbundel via Electron `utilityProcess` sebagai Trusted Orchestrator.**  
Menghapus seluruh dependensi biner `node.exe` eksternal dari installer produksi, dan memastikan pembaruan versi Node diperlakukan sebagai konsekuensi terencana dari upgrade siklus hidup Electron.

### 7. Konsekuensi Keputusan
- Kode orchestrator worker wajib mematuhi standar Node.js ESM yang kompatibel dengan versi Node pada rilis Electron aktif.
- Pengujian regresi IPC `MessagePort` wajib dilakukan pada setiap upgrade Electron untuk mendeteksi potensi perubahan perilaku streaming buffer.

### 8. Sumber Resmi & Tanggal Pengecekan
- Electron UtilityProcess API: https://www.electronjs.org/docs/latest/api/utility-process (Diperiksa: 24 November 2026).
- Node.js Previous Releases: https://nodejs.org/en/about/previous-releases (Node 24 packaged in Electron 45).

---

## ADR-003: Video Rendering Engine & Abstraction Contract

### 1. Context & Problem Statement
Mesin render bertugas mengeksekusi seeking waktu absolut secara deterministik pada dokumen HTML impor, menangkap buffer gambar mentah per frame, dan mengalirkannya ke encoder video.

HyperFrames versi 0.9.84 telah divalidasi di Phase 3 dengan hasil determinisme bit-exact pada 6/9 frame dan deviasi mikro $\ge 0.9997$ pada sub-pixel ticker. Versi 0.9.86 telah dirilis secara upstream di npm. Namun, API Frame Adapter HyperFrames secara upstream masih berstatus eksperimental. MF Motion Gen tidak boleh terikat secara langsung (*tightly coupled*) pada implementasi internal pustaka pihak ketiga.

### 2. Kandidat Teknologi
1. **HyperFrames (Pinned v0.9.84) di Balik Abstraksi Internal `MfMotionRenderer`:** Mengunci versi yang terbukti secara empiris di Phase 3 dan menyembunyikannya di balik antarmuka internal netral.
2. **HyperFrames (Latest v0.9.86 Langsung):** Menggunakan versi terbaru tanpa layer proteksi.
3. **Custom Playwright / Puppeteer Capture Pipeline:** Membangun pipa capture mandiri dari nol.

### 3. Bukti Kompatibilitas dengan Hasil POC Phase 3
- HyperFrames 0.9.84 membuktikan determinisme seeking pada Round 1 dan Round 2, serta paritas visual pada ProRes 4444.
- HyperFrames mengandalkan antarmuka Chrome DevTools Protocol `HeadlessExperimental.beginFrame` untuk melakukan stepping waktu virtual tanpa dipengaruhi clock sistem operasi.

### 4. Analisis Kelebihan & Kekurangan
| Kandidat | Kelebihan | Kekurangan |
| :--- | :--- | :--- |
| **HyperFrames 0.9.84 + MfMotionRenderer** | • Perilaku rendering deterministik telah terbukti empiris.<br>• Abstraction layer (`IMotionRenderer`) melindungi aplikasi dari perubahan breaking API HyperFrames.<br>• Memungkinkan penggantian engine di masa depan tanpa mengubah kode UI. | • Memerlukan penulisan adapter anti-corruption layer internal. |
| **HyperFrames 0.9.86 Langsung** | • Mendapatkan perbaikan bug terbaru upstream. | • Berisiko memperkenalkan regresi visual tanpa validasi menyeluruh.<br>• Menyatukan kode produk langsung dengan dependensi eksperimental. |
| **Custom Pipeline** | • Kendali arsitektur 100% di tangan tim internal. | • Membutuhkan waktu pengembangan besar untuk mengimplementasikan ulang penanganan font ready, audio sync, dan virtual clock stepping. |

### 5. Hubungan Arsitektural Komponen Render
```
[Application Core / UI Store]
       │ (memanggil interface netral)
       ▼
[IMotionRenderer (MfMotionRenderer Interface)]
       │ (implementasi konkret)
       ▼
[HyperFramesAdapter (Anti-Corruption Layer)]
       │ (memanggil library pinned)
       ▼
[@hyperframes/engine (v0.9.84 pinned)]
       │ (mengendalikan via CDP HeadlessExperimental.beginFrame)
       ▼
[chrome-headless-shell (Dedicated Binary) / Evaluasi Unified Engine]
```

### 6. Rekomendasi
**Rekomendasi: Kunci HyperFrames pada versi 0.9.84 dan sembunyikan 100% di balik antarmuka internal `IMotionRenderer`.**  
Versi 0.9.86 atau pustaka alternatif hanya akan diuji pada validation gate terpisah.

### 7. Konsekuensi Keputusan
- Kode studio UI dan job queue hanya mengenal kontrak `IMotionRenderer`.
- Upgrade dependensi render engine diisolasi sepenuhnya di dalam modul adapter.

### 8. Sumber Resmi & Tanggal Pengecekan
- HyperFrames Releases: https://github.com/hyperframes/hyperframes (Diperiksa: 24 November 2026 — v0.9.84 validated, v0.9.86 released).

---

## ADR-004: HTML / GSAP Authoring Compatibility & Seek Protocols

### 1. Context & Problem Statement
Komposisi motion graphic yang dihasilkan oleh Gemini AI Studio memiliki pola authoring spesifik yang terbukti secara empiris di Phase 3:
- Komposisi mendaftarkan timeline animasi pada objek global: `window.__timelines["main"]`.
- Timeline berada dalam kondisi *paused* (`paused: true`).
- Pada benchmark Round 2 (Breaking News), elemen persisten (seperti globe SVG, cincin orbit, dan running ticker container) **TIDAK memiliki atribut `class="clip"`**, namun tetap tampil stabil tanpa menghilang.
- HyperFrames upstream mendefinisikan protokol seeking resmi melalui antarmuka global `window.__hf`.

Diperlukan rancangan **Compatibility Adapter Layer** (`GeminiToHyperFramesAdapter`) yang fleksibel, mematuhi kontrak protokol seeking secara utuh, menangani pendaftaran timeline yang tertunda (*late timeline registration*), dan tidak memaksakan asumsi kaku yang merusak komposisi pengguna.

### 2. Spesifikasi Kontrak Protokol `window.__hf`
Berdasarkan dokumentasi resmi dan kode upstream `@hyperframes/engine`:
- **Kontrak Dasar Engine (Wajib):**
  1. `window.__hf.duration`: Properti numerik (atau getter) yang mengembalikan durasi total animasi dalam detik (misal `10.0`).
  2. `window.__hf.seek(timeInSeconds)`: Fungsi seeking deterministik yang menerima parameter waktu float ($t \ge 0$) dan memposisikan seluruh animasi pada timestamp tersebut.
- **Integrasi Media Opsional (`window.__hf.media`):**
  - Properti `media` **BUKAN properti wajib** pada kontrak dasar engine.
  - Jika sebuah komposisi memuat elemen audio atau video lokal yang membutuhkan sinkronisasi playhead, adapter dapat secara opsional mendeklarasikan array elemen media: `window.__hf.media = Array.from(document.querySelectorAll('audio, video'))`.
  - Jika tidak ada media, properti ini tidak perlu dideklarasikan agar tidak memicu overhead verifikasi kosong.

### 3. Pendaftaran Timeline Tertunda (*Late Timeline Registration*)
Pada komposisi dari Gemini AI Studio, script animasi GSAP dapat dieksekusi secara asinkron atau berada di akhir tag `<body>`. Adapter harus mampu menangani pendaftaran timeline yang terjadi setelah script adapter disuntikkan:
1. **Getter/Setter Trap pada `window.__timelines`:** Menggunakan `Object.defineProperty` pada `window` untuk mencegat saat `__timelines` atau `__timelines["main"]` didefinisikan oleh authoring script.
2. **Event Kesiapan Dokumen:** Memeriksa kembali ketersediaan timeline pada `DOMContentLoaded` dan `window.onload`.
3. **Peringatan Timeline Ambigu:**
   - Adapter **DILARANG secara otomatis mengasumsikan `gsap.globalTimeline` sebagai master timeline**. `gsap.globalTimeline` di GSAP 3 mencakup seluruh tween yang pernah dibuat, termasuk tween parsial, animasi hover yang belum di-kill, atau ticker internal.
   - Jika master timeline tidak dapat diidentifikasi secara pasti, adapter **wajib mengeluarkan status peringatan eksplisit: `[WARNING: UNSUPPORTED / AMBIGUOUS TIMELINE / CALLBACK DEPENDENCY]`** dan meminta konfirmasi pengguna di UI Studio.

### 4. Perilaku `suppressEvents` & Dependensi Callback GSAP
Pada method GSAP `timeline.seek(time, suppressEvents)`:
- Jika `suppressEvents = true` (default determinisme murni):
  - Event callback GSAP seperti `onUpdate`, `onComplete`, `onStart`, dan method `call()` **TIDAK AKAN DIPANGGIL**.
  - **Dampak Positif:** Menjamin determinisme visual murni dan mencegah eksekusi berulang pada seeking acak/mundur.
  - **Risiko Negatif:** Jika authoring animasi mengandalkan callback JavaScript untuk memanipulasi DOM (misal mengubah teks dinamis atau menambahkan kelas CSS), animasi akan berhenti berfungsi sebagaimana mestinya.
- Jika `suppressEvents = false`:
  - Seluruh callback dieksekusi. Namun, seeking mundur atau melompat acak dapat memicu callback berjalan di luar urutan aslinya, berisiko merusak state visual (*state corruption*).
- **Kebijakan Adapter:** Default menggunakan `suppressEvents = true`. Jika Static Analyzer mendeteksi adanya callback `.call()`, `onUpdate`, atau `onComplete` pada timeline master, sistem menampilkan peringatan ke pengguna dan mengizinkan toggle fallback `suppressEvents = false`.
- **Tidak Ada Garansi Otomatis:** MF Motion Gen **tidak menjanjikan seluruh komposisi GSAP otomatis kompatibel**. Komposisi yang memiliki dependensi callback non-idempoten diklasifikasikan sebagai *unsupported pattern*.

### 5. Desain Kode Runtime Adapter (`GeminiToHyperFramesAdapter`)
```javascript
// Runtime Bridge: Gemini AI Studio -> HyperFrames Base Seek Contract
(function initMotionCompatibilityBridge() {
  let masterTl = null;
  let hasWarnedAmbiguous = false;

  function bindHyperFramesContract(tl, source) {
    masterTl = tl;
    if (typeof masterTl.pause === "function") {
      masterTl.pause();
    }

    window.__hf = window.__hf || {};

    // 1. Kontrak Wajib: duration getter numerik dalam detik
    Object.defineProperty(window.__hf, "duration", {
      get: function() {
        return typeof masterTl.duration === "function" ? masterTl.duration() : 0;
      },
      configurable: true
    });

    // 2. Kontrak Wajib: seek function deterministik
    window.__hf.seek = function(timeInSeconds) {
      if (typeof masterTl.seek === "function") {
        masterTl.seek(timeInSeconds, true); // suppressEvents: true untuk determinisme murni
      }
    };

    // 3. Integrasi Media Opsional (hanya jika ada media lokal)
    const localMedia = document.querySelectorAll('audio, video');
    if (localMedia.length > 0) {
      window.__hf.media = Array.from(localMedia);
    }

    console.info(`[COMPATIBILITY BRIDGE] Successfully bound window.__hf to ${source} (Duration: ${window.__hf.duration}s).`);
  }

  function detectTimeline() {
    if (masterTl) return true;

    // Prioritas 1: Standar Gemini AI Studio
    if (window.__timelines && window.__timelines["main"]) {
      bindHyperFramesContract(window.__timelines["main"], "window.__timelines['main']");
      return true;
    }

    // Prioritas 2: Standar GSAP klasik
    if (window.timeline && typeof window.timeline.seek === "function") {
      bindHyperFramesContract(window.timeline, "window.timeline");
      return true;
    }

    return false;
  }

  // Intercept Late Timeline Registration via Property Trap
  let timelinesStorage = window.__timelines;
  Object.defineProperty(window, "__timelines", {
    get: function() { return timelinesStorage; },
    set: function(val) {
      timelinesStorage = val;
      if (val && val["main"]) {
        bindHyperFramesContract(val["main"], "late window.__timelines['main']");
      }
    },
    configurable: true
  });

  // Listener siklus dokumen
  if (!detectTimeline()) {
    document.addEventListener("DOMContentLoaded", function() {
      if (!detectTimeline() && !hasWarnedAmbiguous) {
        hasWarnedAmbiguous = true;
        console.warn("[WARNING: UNSUPPORTED / AMBIGUOUS TIMELINE / CALLBACK DEPENDENCY] Master timeline not found during DOMContentLoaded.");
      }
    });
  }
})();
```

### 6. Rekomendasi
**Rekomendasi: Terapkan Dual-Protocol Compatibility Adapter dengan Penanganan Late Registration dan Peringatan Ambigu Eksplisit.**  
Menghormati kontrak minimalis `duration` dan `seek(time)`, tidak memanipulasi DOM `.clip` secara manual sebelum validasi empiris, dan secara jujur menolak authoring yang tidak didukung.

### 7. Konsekuensi Keputusan
- Komposisi standar Gemini AI Studio terpetakan secara mulus ke engine HyperFrames.
- Pengguna terlindungi dari kegagalan render tersembunyi berkat peringatan dini jika timeline atau callback tidak memenuhi syarat determinisme.

---

## ADR-005: Video Encoder Pipeline, Distribution & Third-Party Binaries

### 1. Context & Problem Statement
Aplikasi membutuhkan pipa encoding video untuk mengubah frame grafis mentah RGBA menjadi format master MP4 (H.264) dan mezzanine broadcast Apple ProRes 4444 MOV dengan transparansi alpha channel.

Diperlukan evaluasi komparatif mendalam antara pustaka upstream `@hyperframes/producer` (versi target 0.9.86) versus pipa Custom FFmpeg Pipeline mandiri, serta penetapan kepatuhan lisensi biner pihak ketiga (Gyan.dev).

### 2. Evaluasi Menyeluruh: `@hyperframes/producer` vs Custom FFmpeg Pipeline

Dokumentasi resmi terkini `@hyperframes/producer` menyebutkan kapabilitas:
- Audio mixing (multiplexing trek audio lokal ke video).
- Ekspor video format MP4 (H.264 via FFmpeg).
- Ekspor video format MOV transparan (ProRes 4444 dengan kanal alpha).
- Pembatalan proses rendering menggunakan `AbortSignal`.

Berikut adalah matriks komparasi 3 tingkat pembuktian teknis:

| Kategori Evaluasi | Upstream Documented Capabilities (`@hyperframes/producer` v0.9.86) | Status Pembuktian di Phase 3 POC | Unvalidated Capabilities / Rencana Validasi (Spike 4.1-B) |
| :--- | :--- | :--- | :--- |
| **MP4 H.264 Export** | Didukung resmi via argumen `--format mp4`. | **Terbukti Stabil:** Pipa custom FFmpeg CLI menghasilkan MP4 1080p30 (SSIM 0.9789 pada Round 2). | Producer v0.9.86 belum diuji langsung di Windows harness; perlu diukur throughput (fps) dan pemanfaatan memori. |
| **Transparent MOV (ProRes 4444)** | Didukung resmi via argumen `--format mov` dengan transparansi alpha. | **Terbukti Stabil:** Pipa custom FFmpeg dengan `prores_ks` format `yuva444p12le` terbukti menghasilkan alpha 100% bit-exact. | **KRITIS:** Belum divalidasi apakah flag internal Producer menghasilkan format piksel `yuva444p12le` yang benar, presisi alpha channel, dan kompatibilitas NLE broadcast. |
| **Audio Mixing** | Didukung resmi via deklarasi trek audio atau elemen `<audio>`. | **Tidak Diuji di Phase 3:** Seluruh benchmark Phase 3 murni video tanpa trek audio. | Belum divalidasi apakah sinkronisasi audio presisi terhadap virtual frame clock dan tidak mengalami audio drift. |
| **Process Cancellation** | Mendukung opsi `{ signal: abortSignal }` untuk pembatalan anggun. | **Terbukti via Wrapper:** Pembatalan diuji via SIGINT / proses timeout Puppeteer. | Belum divalidasi apakah `AbortSignal` Producer mampu mematikan child process `ffmpeg.exe` secara bersih di Windows tanpa proses zombie. |
| **Perilaku Remote Assets & Network** | Producer secara internal dapat mengunduh font/stylesheet dari URL jika ditemukan di DOM. | **Terbukti Luring:** Phase 3 membuktikan komposisi berjalan 100% luring dengan font lokal. | **RISIKO KEAMANAN:** Perilaku download remote Producer wajib dicegat/dibatasi oleh sandbox agar mematuhi kebijakan *default-deny offline*. |
| **Kustomisasi Parameter Codec** | Parameter FFmpeg dibungkus di dalam pustaka; opsi kustom lanjutan terbatas. | **Kendali Penuh:** Custom pipeline memungkinkan fine-tuning CRF, GOP size, color primaries, dan matrix coefficients. | Keterbatasan parameter pada Producer dapat menghambat optimasi bitrate khusus. |

### 3. Rencana Pengujian Validasi `@hyperframes/producer` v0.9.86 (*Spike Test 4.1-B*)
Sebelum memutuskan apakah `@hyperframes/producer` dapat menggantikan Custom FFmpeg Pipeline, tim engineering wajib menjalankan pengujian empiris terisolasi pada Milestone 4.1 (*Spike Test 4.1-B*):
1. **Validasi ProRes 4444 Alpha:** Menguji apakah ekspor MOV Producer menghasilkan format `yuva444p12le` dengan kanal alpha yang mathematically lossless (SSIM alpha = 1.000000).
2. **Validasi Audio Sync:** Menguji sinkronisasi audio 48 kHz terhadap video 30 fps dan 60 fps tanpa drift.
3. **Validasi `AbortSignal`:** Memverifikasi pembatalan render saat berjalan di Windows, memastikan biner FFmpeg tertutup tanpa file lock.
4. **Validasi Isolasi Jaringan:** Memastikan Producer tidak melakukan request HTTP keluar saat merender komposisi yang memuat link eksternal yang diblokir CSP.

### 4. Evaluasi Biner Pihak Ketiga (Gyan.dev) & Implikasi Lisensi GPL v3
- **Fakta Upstream FFmpeg:** ffmpeg.org hanya mendistribusikan *source code*. Biner Windows bersumber dari third-party packagers (Gyan.dev).
- **Koreksi Asumsi Lisensi:** Memanggil biner GPL sebagai child process tidak secara otomatis membebaskan aplikasi dari risiko lisensi jika biner tersebut didistribusikan bersama installer aplikasi sebagai bagian inti alur kerja produk.
- **Kewajiban Distribusi GPL v3:**
  1. Menyertakan salinan lengkap Lisensi GNU GPL v3 (`resources/licenses/FFMPEG_GPLv3.txt`).
  2. Menyediakan akses ke exact source code FFmpeg yang bersesuaian dengan biner Gyan.dev yang dibundel, termasuk konfigurasi build flags.
  3. Menyertakan atribusi hak cipta pada menu "About / Third-Party Licenses".
  4. Penilaian hukum final **wajib melalui Legal Review oleh Product Owner / Penasihat Hukum**.
- **Integritas Biner:** Biner `ffmpeg.exe` wajib diverifikasi menggunakan hash SHA-256 yang tersimpan di repositori (`build/binaries/ffmpeg-windows-x64.sha256`).

### 5. Rekomendasi
**Rekomendasi: Tetapkan Custom FFmpeg Pipeline sebagai Baseline Aman (Safe Baseline), dengan `@hyperframes/producer` v0.9.86 sebagai Target Validasi Bersyarat (Spike Test 4.1-B).**  
- Pipa Custom FFmpeg mempertahankan status terbukti dari Phase 3 (menjamin ProRes 4444 Alpha `yuva444p12le`).
- Jika Spike Test 4.1-B membuktikan bahwa Producer v0.9.86 memenuhi seluruh kriteria kualitas alpha, audio sync, dan cancellation di Windows, Producer dapat diadopsi untuk menyederhanakan basis kode aplikasi.

### 6. Konsekuensi Keputusan
- Arsitektur rendering dirancang agnostik di balik interface `IMotionExporter` sehingga peralihan antara Producer dan Custom FFmpeg tidak mempengaruhi antarmuka UI.

---

## ADR-006: Browser Engine Architecture: Electron Chromium vs chrome-headless-shell

### 1. Context & Problem Statement
Terjadi kebutuhan teknis yang saling bersinggungan:
- **Paritas Visual:** Pratinjau di viewport studio dan video hasil render akhir wajib konsisten secara visual pada timestamp yang sama.
- **Determinisme Rendering:** HyperFrames `@hyperframes/engine` secara internal dirancang dan dioptimalkan untuk mengendalikan **`chrome-headless-shell`** (biner Chromium khusus headless) menggunakan Chrome DevTools Protocol (CDP) `HeadlessExperimental.beginFrame`.

### 2. Klarifikasi Pernyataan Paritas Visual (*Rendering Parity Wording*)
- **Koreksi Pernyataan:** Menyematkan versi renderer/browser yang sama (*pinned engine*) meminimalkan variasi versi browser engine. Namun, **paritas piksel eksak (*exact bit-level pixel parity*) tidak dapat dijamin 100% mutlak hanya dengan menyematkan biner browser**, karena rendering tetap dipengaruhi oleh:
  1. Perbedaan rasterisasi display list Skia GPU pada jendela GUI vs headless framebuffer.
  2. Sub-pixel antialiasing font pada resolusi dan DPI layar yang berbeda.
  3. Konversi format warna (RGB browser framebuffer ke YUV video matrix).
  4. Driver grafis perangkat keras sistem operasi host.

### 3. Komparasi Dua Opsi Arsitektur
```
+----------------------------------------------------------------------------------------------------+
| OPSI A: Arsitektur Hibrida (Hybrid Architecture — Safe Baseline)                                   |
| Preview: Electron Chromium Window (GUI Viewport)                                                   |
| Render:  HyperFrames mengendalikan Pinned chrome-headless-shell Binary (CDP BeginFrame)            |
+----------------------------------------------------------------------------------------------------+
| OPSI B: Arsitektur Terpadu (Unified Engine Architecture)                                           |
| Preview & Render: Menggunakan Engine Browser yang Sama Persis (Menjalankan Chromium Terpadu       |
|                   atau mengarahkan HyperFrames langsung ke executable Electron via CDP)            |
+----------------------------------------------------------------------------------------------------+
```

### 4. Matriks Evaluasi Dampak 8 Dimensi
| Dimensi Evaluasi | Opsi A: Hybrid (Electron GUI + chrome-headless-shell) | Opsi B: Unified Engine (Chromium Terpadu) |
| :--- | :--- | :--- |
| **1. Visual Parity** | **Sangat Baik (Terbukti di Phase 3):** Mencapai SSIM **0.9879** pada Round 1. Deviasi minor berasal dari Skia display list vs headless rasterization. | **Secara Teori Lebih Konsisten:** Menghilangkan potensi perbedaan revisi internal Chromium antara Electron dan headless shell. |
| **2. Version Mismatch** | **Ada Potensi:** Versi Chromium Electron (misal v156) dan versi `chrome-headless-shell` (misal v158) dapat berbeda beberapa rilis minor. | **Nol:** Kedua lingkungan berbagi versi Chromium yang persis sama. |
| **3. Font Rendering** | Stabil pada font lokal (Bahnschrift, Cascadia Mono terbukti konsisten di Phase 3). | Stabil dan seragam di kedua lingkungan. |
| **4. GPU Acceleration** | Berjalan dengan software rasterization (SwiftShader) atau headless Skia GPU flags (`--enable-gpu-rasterization`). | Memanfaatkan akselerasi GPU perangkat keras native jendela Electron. |
| **5. Packaging Size** | **Membengkak (+~150 MB):** Installer wajib menyertakan biner `chrome-headless-shell` di dalam bundel resources. | **Ramping:** Menghemat ~150 MB karena hanya mendistribusikan biner Electron utama. |
| **6. Render Performance**| **Sangat Cepat:** `chrome-headless-shell` sangat ringan dan dioptimalkan khusus untuk headless capture tanpa overhead antarmuka desktop. | Berisiko lebih berat karena instance Electron membawa overhead arsitektur desktop penuh. |
| **7. Security & Isolation**| **Terisolasi Alami:** Proses render headless berjalan sebagai proses sistem operasi terpisah di luar siklus hidup GUI studio. | Memerlukan isolasi context dan sanitasi window offscreen yang sangat ketat. |
| **8. Maintenance Risk** | **Sangat Rendah:** Mengikuti jalur upstream resmi yang telah divalidasi oleh HyperFrames. | **Tinggi:** Berisiko gagal jika flag CDP `HeadlessExperimental.beginFrame` tidak didukung penuh oleh biner Electron di Windows desktop. |

### 5. Eksperimen Validasi Wajib (*Spike Test 4.1-A*)
Sebelum keputusan arsitektur dialihkan ke Opsi B, tim engineering wajib menjalankan uji pembuktian empiris minimum (*Spike Test 4.1-A*):
1. Mengonfigurasi Puppeteer agar mengarahkan `executablePath` langsung ke biner `electron.exe` (dengan opsi `--headless=new` atau jendela offscreen).
2. Memverifikasi apakah domain CDP `HeadlessExperimental.beginFrame` mengembalikan frame buffer tanpa error pada platform Windows.
3. Mengukur throughput render (fps), konsumsi RAM, dan paritas visual frame-by-frame terhadap baseline Phase 3.

### 6. Rekomendasi
**Rekomendasi: Tetapkan OPSI A sebagai Baseline Aman (Safe Baseline), dengan Opsi B sebagai Target Validasi Bersyarat (Spike Test 4.1-A).**  
- **Baseline (Opsi A):** Menggunakan biner `chrome-headless-shell` tersemat yang selaras dengan HyperFrames 0.9.84 untuk meminimalkan deviasi terhadap hasil POC Phase 3.
- **Validasi Opsi B:** Eksperimen Spike Test 4.1-A dieksekusi pada Milestone 4.1. Jika Opsi B terbukti lulus uji determinisme dan menghemat ukuran installer sebesar ~150 MB, transisi dapat diajukan kepada PM dan Product Owner.

---

## Ringkasan Status Keputusan ADR

| Nomor ADR | Domain Arsitektur | Keputusan Rekomendasi | Status Keputusan |
| :--- | :--- | :--- | :--- |
| **ADR-001** | Desktop Framework | Electron (Cadence Tracking, Mulai v45.4.1) | **Proposed (Menunggu Persetujuan PO)** |
| **ADR-002** | Runtime | Node.js Terbundel via Electron `utilityProcess` | **Proposed (Menunggu Persetujuan PO)** |
| **ADR-003** | Render Engine | HyperFrames v0.9.84 di Balik `MfMotionRenderer` | **Proposed (Menunggu Persetujuan PM & PO)** |
| **ADR-004** | GSAP & Authoring | Dual-Protocol Compatibility Adapter (Late Reg Safe) | **Proposed (Menunggu Persetujuan PM & PO)** |
| **ADR-005** | Video Encoder | Custom FFmpeg Baseline + Producer Evaluation | **Proposed (Menunggu Spike Test 4.1-B & Legal)** |
| **ADR-006** | Browser Architecture | Opsi A (Hybrid) dengan Gate Eksperimen Opsi B | **Pending Validation Gate (Spike Test 4.1-A)** |

---

## Daftar Risiko Teknis yang Belum Terselesaikan (*Unresolved Technical Risks*)

1. **Risiko 1 — Electron 45 EOL Window (April 2027):** Membutuhkan alokasi sprint pembaruan ke Electron 46 pada Q1 2027 sebelum Electron 45 mencapai akhir masa dukungan resmi.
2. **Risiko 2 — Evaluasi Upstream `@hyperframes/producer` v0.9.86:** Perlu pembuktian empiris apakah ProRes 4444 Alpha, audio mixing, dan pembatalan `AbortSignal` berjalan stabil di Windows tanpa memory leak.
3. **Risiko 3 — Dukungan CDP `beginFrame` pada Electron Binary (Opsi B):** Jika Electron headless tidak mendukung virtual frame stepping CDP di Windows, aplikasi tetap wajib mengemas `chrome-headless-shell` (+150 MB).
4. **Risiko 4 — Legal Review Distribusi Biner FFmpeg GPL v3:** Kebutuhan evaluasi hukum komersial oleh Product Owner terhadap distribusi biner Gyan.dev GPL v3.
5. **Risiko 5 — GSAP Callback Side-Effects:** Komposisi animasi pihak ketiga yang mengandalkan callback non-idempoten berisiko mengalami glitch visual jika dijalankan dengan `suppressEvents = true`.
