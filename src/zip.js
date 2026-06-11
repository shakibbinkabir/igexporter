// src/zip.js
//
// Minimal, dependency-free ZIP writer. Uses the STORE method (no compression)
// because Instagram media (JPEG/MP4) is already compressed — deflating it
// again would burn CPU for no size win. Keeping it store-only also keeps this
// file small enough to read end-to-end, in line with the project's "audit
// every line before installing" promise.
//
// Foldering is implicit: an entry path of "001_post/01.jpg" creates the folder.
//
// Limitations (intentional, documented in README): no ZIP64, so a single file
// or the whole archive must stay under 4 GiB, and at most 65535 entries.

const textEncoder = new TextEncoder();

// Standard CRC-32 (IEEE 802.3) lookup table, built once.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Convert a JS Date into the packed DOS date/time fields ZIP uses.
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    (Math.floor(date.getSeconds() / 2));
  const dosDate =
    ((year - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate();
  return { dosTime: dosTime & 0xffff, dosDate: dosDate & 0xffff };
}

/**
 * Build a ZIP archive.
 * @param {Array<{path: string, bytes: Uint8Array}>} entries
 * @param {Date} [modDate] modification stamp applied to every entry
 * @returns {Uint8Array}
 */
export function createZip(entries, modDate = new Date()) {
  const { dosTime, dosDate } = dosDateTime(modDate);

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = textEncoder.encode(entry.path);
    const data = entry.bytes;
    const crc = crc32(data);
    const size = data.length >>> 0;

    // ---- Local file header (30 bytes + name) ----
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // flags: UTF-8 filename
    lv.setUint16(8, 0, true); // method: store
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); // compressed size
    lv.setUint32(22, size, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra length
    local.set(nameBytes, 30);

    localParts.push(local, data);

    // ---- Central directory header (46 bytes + name) ----
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); // signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true); // flags: UTF-8
    cv.setUint16(10, 0, true); // method: store
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra length
    cv.setUint16(32, 0, true); // comment length
    cv.setUint16(34, 0, true); // disk number start
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // local header offset
    central.set(nameBytes, 46);

    centralParts.push(central);

    offset += local.length + data.length;
  }

  const centralSize = centralParts.reduce((n, p) => n + p.length, 0);
  const centralOffset = offset;

  // ---- End of central directory (22 bytes) ----
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // signature
  ev.setUint16(4, 0, true); // disk number
  ev.setUint16(6, 0, true); // disk with central dir
  ev.setUint16(8, entries.length, true); // entries on this disk
  ev.setUint16(10, entries.length, true); // total entries
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);
  ev.setUint16(20, 0, true); // comment length

  // ---- Concatenate everything ----
  const total = centralOffset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of localParts) {
    out.set(part, pos);
    pos += part.length;
  }
  for (const part of centralParts) {
    out.set(part, pos);
    pos += part.length;
  }
  out.set(eocd, pos);

  return out;
}
