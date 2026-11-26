import fs from "node:fs";
import zlib from "node:zlib";

function crc32Buf(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Minimal programmatic ZIP builder supporting crafted headers for adversarial security tests
 * (arbitrary entry names, external attributes, forged uncompressedSize, deflate/store).
 */
export function buildSyntheticZip(destZipPath, entries) {
  const localChunks = [];
  const cdChunks = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const rawData = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? "", "utf8");
    const method = e.method ?? 8;
    const compressedData = method === 8 ? zlib.deflateRawSync(rawData) : rawData;
    const crc = crc32Buf(rawData);
    const declaredUncompressed = e.forgedUncompressedSize ?? rawData.length;
    const declaredCompressed = e.forgedCompressedSize ?? compressedData.length;
    const extAttr = e.externalFileAttr ?? 0;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(e.flags ?? 0, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(declaredCompressed, 18);
    lfh.writeUInt32LE(declaredUncompressed, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);

    localChunks.push(lfh, nameBuf, compressedData);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(e.versionMadeBy ?? (3 << 8) | 20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(e.flags ?? 0, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(declaredCompressed, 20);
    cdh.writeUInt32LE(declaredUncompressed, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(extAttr, 38);
    cdh.writeUInt32LE(offset, 42);

    cdChunks.push(cdh, nameBuf);
    offset += lfh.length + nameBuf.length + compressedData.length;
  }

  const cdBuf = Buffer.concat(cdChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.writeFileSync(destZipPath, Buffer.concat([...localChunks, cdBuf, eocd]));
}
