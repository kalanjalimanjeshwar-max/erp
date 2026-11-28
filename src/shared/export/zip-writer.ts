/**
 * Zero-dependency pure-TypeScript ZIP archive writer (PKZIP 2.0 Store method).
 * Works identically in Node.js (unit tests / server) and modern browsers (client export).
 * Used for both OOXML SpreadsheetML (.xlsx) workbooks and multi-page JPG/PNG archives.
 */

export interface ZipArchiveEntry {
  name: string;
  data: Uint8Array;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function computeCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function encodeUtf8(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function toDosTimeDate(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  const dosTime = ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f);
  return { dosTime, dosDate };
}

/**
 * Builds a valid ZIP archive byte array from an ordered list of entries.
 */
export function createZipArchive(entries: ZipArchiveEntry[], now = new Date()): Uint8Array {
  const { dosTime, dosDate } = toDosTimeDate(now);
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const safeName = entry.name.replace(/^\/+/, '').replace(/\\/g, '/');
    const nameBytes = encodeUtf8(safeName);
    const data = entry.data;
    const crc = computeCrc32(data);
    const size = data.length;

    // Local File Header (30 bytes + filename)
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true); // Local file header signature
    lv.setUint16(4, 20, true); // Version needed to extract (2.0)
    lv.setUint16(6, 0x0800, true); // General purpose bit flag (UTF-8 filename)
    lv.setUint16(8, 0, true); // Compression method: 0 (store)
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // Extra field length
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, data);

    // Central Directory Header (46 bytes + filename)
    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true); // Central directory signature
    cv.setUint16(4, 20, true); // Version made by
    cv.setUint16(6, 20, true); // Version needed to extract
    cv.setUint16(8, 0x0800, true); // UTF-8 filename flag
    cv.setUint16(10, 0, true); // Compression method: store
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // Extra length
    cv.setUint16(32, 0, true); // Comment length
    cv.setUint16(34, 0, true); // Disk number start
    cv.setUint16(36, 0, true); // Internal attributes
    cv.setUint32(38, 0, true); // External attributes
    cv.setUint32(42, offset, true); // Relative offset of local header
    centralHeader.set(nameBytes, 46);

    centralParts.push(centralHeader);
    offset += localHeader.length + data.length;
  }

  const centralDirStart = offset;
  let centralDirSize = 0;
  for (const part of centralParts) {
    centralDirSize += part.length;
  }

  // End of Central Directory Record (22 bytes)
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // EOCD signature
  ev.setUint16(4, 0, true); // Number of this disk
  ev.setUint16(6, 0, true); // Disk with central directory
  ev.setUint16(8, entries.length, true); // Entries on this disk
  ev.setUint16(10, entries.length, true); // Total entries
  ev.setUint32(12, centralDirSize, true);
  ev.setUint32(16, centralDirStart, true);
  ev.setUint16(20, 0, true); // Comment length

  const totalSize = offset + centralDirSize + eocd.length;
  const output = new Uint8Array(totalSize);
  let cursor = 0;
  for (const part of localParts) {
    output.set(part, cursor);
    cursor += part.length;
  }
  for (const part of centralParts) {
    output.set(part, cursor);
    cursor += part.length;
  }
  output.set(eocd, cursor);
  return output;
}

/**
 * Parses entry file names and uncompressed payloads from a store-mode ZIP archive.
 * Useful for verification and unit testing without external dependencies.
 */
export function listZipEntryNames(archive: Uint8Array): string[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const names: string[] = [];
  let offset = 0;
  const decoder = new TextDecoder();

  while (offset + 30 <= archive.byteLength) {
    const sig = view.getUint32(offset, true);
    if (sig !== 0x04034b50) break;
    const compSize = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > archive.byteLength) break;
    names.push(decoder.decode(archive.subarray(nameStart, nameEnd)));
    offset = nameEnd + extraLen + compSize;
  }
  return names;
}
