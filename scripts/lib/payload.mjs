// Shared wire format for a Goose Paint image, used by the gas-station
// Worker (packing) and scripts/read-tree.mjs (unpacking). Kept as one
// file so the two never drift apart.
//
// Layout (fixed size, 75 bytes total):
//   byte 0        version tag, currently 1
//   bytes 1-4     unix seconds, big-endian u32 (submission time)
//   bytes 5-76    144 pixel values, 4 bits each, packed 2-per-byte
//                 (72 bytes: cell 0 in the high nibble, cell 1 in the
//                 low nibble, cell 2 in the next byte's high nibble, ...)
//
// Each pixel value is 0-16 (17 colors), which fits a nibble (0-15) only
// up to value 15 — value 16 is encoded as nibble 0 with a second pass
// "overflow" bit is unnecessary here since the ALPHA-derived palette
// actually only ever produces indices 0-16 inclusive (17 values), so a
// nibble (max 15) is one short. To keep the packed format simple and
// fixed-size, values are packed as 5 bits each instead of 4 — see
// PIXEL_BITS below. This costs 90 bytes instead of 72 for the pixel data
// but avoids any special-casing.
export const VERSION = 1;
export const GRID_N = 12;
export const CELL_COUNT = GRID_N * GRID_N; // 144
export const PIXEL_BITS = 5; // 0-31 range comfortably covers 0-16
export const PIXEL_DATA_BYTES = Math.ceil((CELL_COUNT * PIXEL_BITS) / 8); // 90
export const PAYLOAD_BYTES = 1 + 4 + PIXEL_DATA_BYTES; // 95

/**
 * Packs 144 pixel values (each 0-16) plus a timestamp into the fixed
 * on-chain payload. Throws if any value is out of range or the array
 * isn't exactly 144 long, since silently truncating a bad scan would
 * corrupt the image record permanently once it's on-chain.
 */
export function packPayload(pixels, timestampSeconds = Math.floor(Date.now() / 1000)) {
  if (!Array.isArray(pixels) || pixels.length !== CELL_COUNT) {
    throw new Error(`pixels must be an array of exactly ${CELL_COUNT} values`);
  }
  for (const v of pixels) {
    if (!Number.isInteger(v) || v < 0 || v > 16) {
      throw new Error(`pixel value out of range 0-16: ${v}`);
    }
  }

  const out = new Uint8Array(PAYLOAD_BYTES);
  out[0] = VERSION;
  out[1] = (timestampSeconds >>> 24) & 0xff;
  out[2] = (timestampSeconds >>> 16) & 0xff;
  out[3] = (timestampSeconds >>> 8) & 0xff;
  out[4] = timestampSeconds & 0xff;

  let bitPos = 0;
  const bitBase = 5 * 8; // pixel data starts after the 5-byte header
  for (let i = 0; i < CELL_COUNT; i++) {
    writeBits(out, bitBase + bitPos, PIXEL_BITS, pixels[i]);
    bitPos += PIXEL_BITS;
  }
  return out;
}

/** Inverse of packPayload. Returns { version, timestampSeconds, pixels }. */
export function unpackPayload(bytes) {
  if (bytes.length !== PAYLOAD_BYTES) {
    throw new Error(`expected ${PAYLOAD_BYTES} bytes, got ${bytes.length}`);
  }
  const version = bytes[0];
  const timestampSeconds = (bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4];
  const pixels = new Array(CELL_COUNT);
  const bitBase = 5 * 8;
  let bitPos = 0;
  for (let i = 0; i < CELL_COUNT; i++) {
    pixels[i] = readBits(bytes, bitBase + bitPos, PIXEL_BITS);
    bitPos += PIXEL_BITS;
  }
  return { version, timestampSeconds: timestampSeconds >>> 0, pixels };
}

function writeBits(buf, bitOffset, bitCount, value) {
  for (let i = 0; i < bitCount; i++) {
    const bit = (value >> (bitCount - 1 - i)) & 1;
    const pos = bitOffset + i;
    const byteIndex = pos >> 3;
    const bitIndex = 7 - (pos & 7);
    if (bit) buf[byteIndex] |= 1 << bitIndex;
  }
}

function readBits(buf, bitOffset, bitCount) {
  let value = 0;
  for (let i = 0; i < bitCount; i++) {
    const pos = bitOffset + i;
    const byteIndex = pos >> 3;
    const bitIndex = 7 - (pos & 7);
    const bit = (buf[byteIndex] >> bitIndex) & 1;
    value = (value << 1) | bit;
  }
  return value;
}
