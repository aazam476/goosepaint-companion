// Mirrors scripts/lib/payload.mjs exactly (packing must match on both
// the write side, here, and the read side in scripts/read-tree.mjs).
// Duplicated rather than imported because Cloudflare Pages Functions and
// the local Node scripts are bundled by two different toolchains and
// don't currently share a build step; keep both files in sync by hand
// if the wire format ever changes.

export const VERSION = 1;
export const GRID_N = 12;
export const CELL_COUNT = GRID_N * GRID_N; // 144
export const PIXEL_BITS = 5;
export const PIXEL_DATA_BYTES = Math.ceil((CELL_COUNT * PIXEL_BITS) / 8); // 90
export const PAYLOAD_BYTES = 1 + 4 + PIXEL_DATA_BYTES; // 95

export function packPayload(pixels: number[], timestampSeconds: number): Uint8Array {
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
  const bitBase = 5 * 8;
  for (let i = 0; i < CELL_COUNT; i++) {
    writeBits(out, bitBase + bitPos, PIXEL_BITS, pixels[i]);
    bitPos += PIXEL_BITS;
  }
  return out;
}

function writeBits(buf: Uint8Array, bitOffset: number, bitCount: number, value: number) {
  for (let i = 0; i < bitCount; i++) {
    const bit = (value >> (bitCount - 1 - i)) & 1;
    const pos = bitOffset + i;
    const byteIndex = pos >> 3;
    const bitIndex = 7 - (pos & 7);
    if (bit) buf[byteIndex] |= 1 << bitIndex;
  }
}

export interface UnpackedPayload {
  version: number;
  timestampSeconds: number;
  pixels: number[];
}

/** Inverse of packPayload, used by the /api/feed reader. */
export function unpackPayload(bytes: Uint8Array): UnpackedPayload {
  if (bytes.length !== PAYLOAD_BYTES) {
    throw new Error(`expected ${PAYLOAD_BYTES} bytes, got ${bytes.length}`);
  }
  const version = bytes[0];
  const timestampSeconds =
    ((bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4]) >>> 0;

  const pixels: number[] = new Array(CELL_COUNT);
  const bitBase = 5 * 8;
  let bitPos = 0;
  for (let i = 0; i < CELL_COUNT; i++) {
    pixels[i] = readBits(bytes, bitBase + bitPos, PIXEL_BITS);
    bitPos += PIXEL_BITS;
  }
  return { version, timestampSeconds, pixels };
}

function readBits(buf: Uint8Array, bitOffset: number, bitCount: number): number {
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
