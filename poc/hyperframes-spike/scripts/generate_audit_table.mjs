import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rawClipsPath = path.resolve(__dirname, "..", "compositions", "clip_audit_raw.json");

const rawClips = JSON.parse(fs.readFileSync(rawClipsPath, "utf-8"));

// Define semantics and required corrections for all 58 static elements + JS conduits
const auditTable = rawClips.map((item) => {
  const { id, tag, line, start, duration } = item;
  const originalEnd = (start + duration).toFixed(2);
  let category = "Permanent HUD / Structure";
  let expectedLifetime = "Visible until end (8.00s)";
  let correctedDuration = (8.0 - start).toFixed(2);
  let status = "CORRECTED";
  let reason = "";

  // Check transient elements
  if (id.startsWith("core-pulse-") || id === "core-sync-flash") {
    category = "Transient Optical FX";
    expectedLifetime = `Visible temporarily (${start}s -> ${originalEnd}s)`;
    correctedDuration = duration;
    status = "PRESERVED_AS_IS";
    reason = "Gelombang radiasi pulsa inti dan flash konvergensi hanya muncul sesaat.";
  } else if (id.startsWith("core-glitch-") || id.startsWith("glitch-bar-") || id === "status-glitch") {
    category = "Transient Glitch Overlay";
    expectedLifetime = `Visible temporarily (${start}s -> ${originalEnd}s)`;
    correctedDuration = duration;
    status = "PRESERVED_AS_IS";
    reason = "Efek glitch kromatik dan bar interferensi sinyal terkontrol hanya aktif pada Stage 3 (4.12s - 4.68s).";
  } else if (id === "status-init") {
    category = "Phased Status Text";
    expectedLifetime = `Visible 0.35s -> 1.05s`;
    correctedDuration = duration;
    status = "PRESERVED_AS_IS";
    reason = "Teks status 'INITIALIZING' digantikan oleh 'ESTABLISHING' pada Stage 2.";
  } else if (id === "status-est") {
    category = "Phased Status Text";
    expectedLifetime = `Visible 1.00s -> 3.50s`;
    correctedDuration = duration;
    status = "PRESERVED_AS_IS";
    reason = "Teks status 'ESTABLISHING' digantikan oleh 'TRANSMITTING' pada Stage 3.";
  } else if (id === "status-tx") {
    category = "Phased Status Text";
    expectedLifetime = `Visible 3.40s -> 6.30s`;
    correctedDuration = duration;
    status = "PRESERVED_AS_IS";
    reason = "Teks status 'TRANSMITTING' digantikan oleh 'SYNCHRONIZED' pada Stage 4.";
  } else if (id === "sync-label-progress") {
    category = "Phased Status Text";
    expectedLifetime = `Visible 0.40s -> 6.30s`;
    correctedDuration = duration;
    status = "PRESERVED_AS_IS";
    reason = "Label 'NETWORK SYNCHRONIZATION' digantikan oleh 'SYNCHRONIZATION COMPLETE' saat progres mencapai 100%.";
  } else if (Math.abs(start + duration - 8.0) < 0.05) {
    category = "Permanent HUD / Structure";
    expectedLifetime = `Visible until end (8.00s)`;
    correctedDuration = duration;
    status = "ALREADY_CORRECT";
    reason = "Lifetime elemen sudah didefinisikan hingga detik ke-8.";
  } else {
    // These are mistakenly clipped elements!
    if (id === "bg-grid") {
      reason = "Grid latar belakang HUD teknologi; wajib tetap tampil di background sepanjang video.";
    } else if (id === "perimeter-frame" || id === "outer-border" || id.startsWith("corner-") || id.startsWith("axis-")) {
      reason = "Frame luar, siku L, dan garis bidik HUD; GSAP menganimasikan masuk di Stage 1 lalu menetap permanen.";
    } else if (id === "title-block") {
      reason = "Blok judul utama ('NEXUS // ADVANCED DATA TRANSMISSION'); wajib terbaca di pojok kiri atas hingga akhir.";
    } else if (id === "core-sync-ring-group" || id === "core-sync-arc") {
      reason = "Cincin progres radial inti; setelah terisi penuh (100% pada 6.25s), cincin harus tetap menyala hingga 8.0s.";
    } else if (id === "sync-bar-fill") {
      reason = "Bilah pengisi progres sinkronisasi; setelah 100% (6.25s), bilah harus tetap terisi penuh sampai akhir durasi.";
    }
  }

  return {
    line,
    selector: `#${id}`,
    tag,
    dataStart: start,
    originalDuration: duration,
    originalLifetime: `${start}s -> ${originalEnd}s`,
    category,
    expectedBehavior: expectedLifetime,
    correctedDuration: Number(correctedDuration),
    correctedLifetime: `${start}s -> ${(start + Number(correctedDuration)).toFixed(2)}s`,
    status,
    reason
  };
});

// Also add JS conduits
auditTable.push({
  line: 907,
  selector: "path[id^='conduit-base-'] (14 conduits)",
  tag: "path (JS created)",
  dataStart: "c.start (1.25s - 1.75s)",
  originalDuration: "c.dur (0.65s - 0.75s)",
  originalLifetime: "start -> start + c.dur (~2.00s - 2.40s)",
  category: "Permanent Vector Conduits",
  expectedBehavior: "Visible until end (8.00s)",
  correctedDuration: "(8.0 - c.start)",
  correctedLifetime: "start -> 8.00s",
  status: "CORRECTED",
  reason: "Sirkuit penghubung node ke inti; setelah digambar masuk oleh GSAP, sirkuit harus tetap terlihat sebagai jalur pulsa data."
});

fs.writeFileSync(
  path.resolve(__dirname, "..", "compositions", "clip_audit_table.json"),
  JSON.stringify(auditTable, null, 2),
  "utf-8"
);

console.log(`Generated Audit Table with ${auditTable.length} audited items.`);
const correctedCount = auditTable.filter(x => x.status === "CORRECTED").length;
const preservedCount = auditTable.filter(x => x.status === "PRESERVED_AS_IS").length;
const alreadyCorrectCount = auditTable.filter(x => x.status === "ALREADY_CORRECT").length;
console.log(`Summary: ${correctedCount} elements corrected, ${preservedCount} preserved as transient, ${alreadyCorrectCount} already correct.`);
