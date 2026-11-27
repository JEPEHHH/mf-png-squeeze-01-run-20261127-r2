import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { constants as zlibConstants, deflateSync, inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

const CHANNELS_BY_COLOR_TYPE: Record<number, number> = {
  0: 1, // Greyscale
  2: 3, // Truecolour RGB
  3: 1, // Indexed-colour palette
  4: 2, // Greyscale with alpha
  6: 4, // Truecolour RGBA
};

const ZLIB_STRATEGIES: readonly number[] = [
  zlibConstants.Z_DEFAULT_STRATEGY,
  zlibConstants.Z_FILTERED,
  zlibConstants.Z_RLE,
];

type FilterMode =
  | 0
  | 1
  | 2
  | 3
  | 4
  | 'viterbi-abs-8'
  | 'viterbi-abs-16'
  | 'viterbi-abs-24'
  | 'viterbi-tri-64'
  | 'viterbi-tri-128'
  | 'viterbi-tri-256'
  | 'brute-grey';

const FILTER_MODES: readonly FilterMode[] = [
  0,
  1,
  2,
  3,
  4,
  'viterbi-abs-16',
  'viterbi-tri-64',
  'viterbi-tri-128',
  'viterbi-tri-256',
];

export interface DecodedPng {
  width: number;
  height: number;
  colorType: number;
  rgba: Uint8Array;
}

interface Chunk {
  type: string;
  data: Uint8Array;
}

interface ImageAnalysis {
  allOpaque: boolean;
  allGrey: boolean;
  canSingleTrnsRgb: boolean;
  singleTrnsRgb: [number, number, number];
  canSingleTrnsGrey: boolean;
  singleTrnsGrey: number;
  paletteMap: Map<number, number> | null;
}

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
  }
  CRC_TABLE[n] = c;
}

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function readUint32BE(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset] << 24) |
      (buf[offset + 1] << 16) |
      (buf[offset + 2] << 8) |
      buf[offset + 3]) >>> 0
  );
}

function writeUint32BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = p >= a ? p - a : a - p;
  const pb = p >= b ? p - b : b - p;
  const pc = p >= c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePng(bytes: Uint8Array): DecodedPng {
  if (bytes.length < 8) {
    throw new Error('PNG too short for signature');
  }
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      throw new Error('Invalid PNG signature');
    }
  }

  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let hasIhdr = false;
  let hasIend = false;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idatChunks: Uint8Array[] = [];

  while (pos < bytes.length) {
    if (hasIend) {
      throw new Error('Trailing bytes after IEND');
    }
    if (pos + 12 > bytes.length) {
      throw new Error(`Truncated chunk header at offset ${pos}`);
    }

    const length = readUint32BE(bytes, pos);
    if (length > 0x7fffffff || pos + 12 + length > bytes.length) {
      throw new Error(`Invalid chunk length ${length} at offset ${pos}`);
    }

    const type = String.fromCharCode(
      bytes[pos + 4],
      bytes[pos + 5],
      bytes[pos + 6],
      bytes[pos + 7],
    );

    const expectedCrc = readUint32BE(bytes, pos + 8 + length);
    const actualCrc = crc32(bytes, pos + 4, pos + 8 + length);
    if (actualCrc !== expectedCrc) {
      throw new Error(`CRC mismatch in ${type} chunk at offset ${pos}`);
    }

    const data = bytes.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length;

    if (!hasIhdr && type !== 'IHDR') {
      throw new Error(`First chunk must be IHDR, got ${type}`);
    }

    if (type === 'IHDR') {
      if (hasIhdr) throw new Error('Duplicate IHDR chunk');
      if (length !== 13) throw new Error(`Invalid IHDR length ${length}`);
      width = readUint32BE(data, 0);
      height = readUint32BE(data, 4);
      bitDepth = data[8];
      colorType = data[9];
      const compression = data[10];
      const filterMethod = data[11];
      const interlace = data[12];
      if (width === 0 || height === 0) throw new Error('Zero image dimension');
      if (bitDepth !== 8) throw new Error(`Unsupported bit depth ${bitDepth}`);
      if (!(colorType in CHANNELS_BY_COLOR_TYPE)) {
        throw new Error(`Unsupported color type ${colorType}`);
      }
      if (compression !== 0 || filterMethod !== 0 || interlace !== 0) {
        throw new Error('Unsupported compression/filter/interlace mode');
      }
      hasIhdr = true;
    } else if (type === 'PLTE') {
      if (colorType !== 3) throw new Error('PLTE only valid for color type 3');
      if (length === 0 || length % 3 !== 0 || length > 768) {
        throw new Error(`Invalid PLTE length ${length}`);
      }
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      if (length !== 0) throw new Error('Non-empty IEND chunk');
      hasIend = true;
    }
  }

  if (!hasIhdr || !hasIend || idatChunks.length === 0) {
    throw new Error('Incomplete PNG (missing IHDR, IDAT, or IEND)');
  }

  const bpp = CHANNELS_BY_COLOR_TYPE[colorType];
  const stride = width * bpp;
  const expectedRawLen = height * (stride + 1);
  const compressed = idatChunks.length === 1 ? idatChunks[0] : Buffer.concat(idatChunks);
  const raw = inflateSync(compressed);
  if (raw.length !== expectedRawLen) {
    throw new Error(`Inflated length ${raw.length} != expected ${expectedRawLen}`);
  }

  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const rawRowStart = y * (stride + 1);
    const filterType = raw[rawRowStart];
    const src = rawRowStart + 1;
    const dst = y * stride;
    const prev = dst - stride;

    if (filterType === 0) {
      samples.set(raw.subarray(src, src + stride), dst);
    } else if (filterType === 1) {
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? samples[dst + i - bpp] : 0;
        samples[dst + i] = (raw[src + i] + left) & 0xff;
      }
    } else if (filterType === 2) {
      for (let i = 0; i < stride; i++) {
        const up = y > 0 ? samples[prev + i] : 0;
        samples[dst + i] = (raw[src + i] + up) & 0xff;
      }
    } else if (filterType === 3) {
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? samples[dst + i - bpp] : 0;
        const up = y > 0 ? samples[prev + i] : 0;
        samples[dst + i] = (raw[src + i] + ((left + up) >>> 1)) & 0xff;
      }
    } else if (filterType === 4) {
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? samples[dst + i - bpp] : 0;
        const up = y > 0 ? samples[prev + i] : 0;
        const upLeft = y > 0 && i >= bpp ? samples[prev + i - bpp] : 0;
        samples[dst + i] = (raw[src + i] + paethPredictor(left, up, upLeft)) & 0xff;
      }
    } else {
      throw new Error(`Invalid PNG filter type ${filterType} at row ${y}`);
    }
  }

  const pixelCount = width * height;
  const rgba = new Uint8Array(pixelCount * 4);

  if (colorType === 6) {
    rgba.set(samples);
  } else if (colorType === 2) {
    const hasKey = trns !== null && trns.length === 6;
    const kr = hasKey ? trns[1] : -1;
    const kg = hasKey ? trns[3] : -1;
    const kb = hasKey ? trns[5] : -1;
    for (let i = 0, s = 0, d = 0; i < pixelCount; i++, s += 3, d += 4) {
      const r = samples[s];
      const g = samples[s + 1];
      const b = samples[s + 2];
      rgba[d] = r;
      rgba[d + 1] = g;
      rgba[d + 2] = b;
      rgba[d + 3] = hasKey && r === kr && g === kg && b === kb ? 0 : 255;
    }
  } else if (colorType === 0) {
    const hasKey = trns !== null && trns.length === 2;
    const kg = hasKey ? trns[1] : -1;
    for (let i = 0, d = 0; i < pixelCount; i++, d += 4) {
      const g = samples[i];
      rgba[d] = g;
      rgba[d + 1] = g;
      rgba[d + 2] = g;
      rgba[d + 3] = hasKey && g === kg ? 0 : 255;
    }
  } else if (colorType === 4) {
    for (let i = 0, s = 0, d = 0; i < pixelCount; i++, s += 2, d += 4) {
      const g = samples[s];
      rgba[d] = g;
      rgba[d + 1] = g;
      rgba[d + 2] = g;
      rgba[d + 3] = samples[s + 1];
    }
  } else if (colorType === 3) {
    if (palette === null) throw new Error('Color type 3 missing PLTE');
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3];
      lut[e * 4 + 1] = palette[e * 3 + 1];
      lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < pixelCount; i++, d += 4) {
      const idx = samples[i];
      if (idx >= entries) {
        throw new Error(`Palette index ${idx} out of range (${entries})`);
      }
      const o = idx * 4;
      rgba[d] = lut[o];
      rgba[d + 1] = lut[o + 1];
      rgba[d + 2] = lut[o + 2];
      rgba[d + 3] = lut[o + 3];
    }
  }

  return { width, height, colorType, rgba };
}

function makeIhdr(width: number, height: number, colorType: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  writeUint32BE(ihdr, 0, width);
  writeUint32BE(ihdr, 4, height);
  ihdr[8] = 8; // bit depth 8
  ihdr[9] = colorType;
  ihdr[10] = 0; // compression method 0
  ihdr[11] = 0; // filter method 0
  ihdr[12] = 0; // non-interlaced
  return ihdr;
}

function buildPng(chunks: readonly Chunk[]): Uint8Array {
  let totalSize = PNG_SIGNATURE.length;
  for (const chunk of chunks) {
    totalSize += 12 + chunk.data.length;
  }
  const out = new Uint8Array(totalSize);
  out.set(PNG_SIGNATURE, 0);
  let pos = PNG_SIGNATURE.length;

  for (const chunk of chunks) {
    const len = chunk.data.length;
    writeUint32BE(out, pos, len);
    out[pos + 4] = chunk.type.charCodeAt(0);
    out[pos + 5] = chunk.type.charCodeAt(1);
    out[pos + 6] = chunk.type.charCodeAt(2);
    out[pos + 7] = chunk.type.charCodeAt(3);
    out.set(chunk.data, pos + 8);
    const c = crc32(out, pos + 4, pos + 8 + len);
    writeUint32BE(out, pos + 8 + len, c);
    pos += 12 + len;
  }
  return out;
}

function filterRow(
  type: number,
  cur: Uint8Array,
  prev: Uint8Array | null,
  bpp: number,
  out: Uint8Array,
): void {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < bpp; i++) out[i] = cur[i];
    for (let i = bpp; i < n; i++) out[i] = (cur[i] - cur[i - bpp]) & 0xff;
  } else if (type === 2) {
    if (prev === null) {
      out.set(cur);
    } else {
      for (let i = 0; i < n; i++) out[i] = (cur[i] - prev[i]) & 0xff;
    }
  } else if (type === 3) {
    if (prev === null) {
      for (let i = 0; i < bpp; i++) out[i] = cur[i];
      for (let i = bpp; i < n; i++) out[i] = (cur[i] - (cur[i - bpp] >>> 1)) & 0xff;
    } else {
      for (let i = 0; i < bpp; i++) out[i] = (cur[i] - (prev[i] >>> 1)) & 0xff;
      for (let i = bpp; i < n; i++) {
        out[i] = (cur[i] - ((cur[i - bpp] + prev[i]) >>> 1)) & 0xff;
      }
    }
  } else {
    if (prev === null) {
      for (let i = 0; i < bpp; i++) out[i] = cur[i];
      for (let i = bpp; i < n; i++) out[i] = (cur[i] - cur[i - bpp]) & 0xff;
    } else {
      for (let i = 0; i < bpp; i++) out[i] = (cur[i] - prev[i]) & 0xff;
      for (let i = bpp; i < n; i++) {
        out[i] = (cur[i] - paethPredictor(cur[i - bpp], prev[i], prev[i - bpp])) & 0xff;
      }
    }
  }
}

const ABS_BYTE = new Uint8Array(256);
for (let v = 0; v < 256; v++) {
  ABS_BYTE[v] = v < 128 ? v : 256 - v;
}

// Compute sum of absolute signed filtered bytes for all 5 PNG filters on every row in one pass.
function computeRowAbsCosts(
  samples: Uint8Array,
  width: number,
  height: number,
  bpp: number,
): Uint32Array {
  const stride = width * bpp;
  const costs = new Uint32Array(height * 5);

  for (let y = 0; y < height; y++) {
    const curOff = y * stride;
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    let s3 = 0;
    let s4 = 0;

    if (y === 0) {
      for (let i = 0; i < bpp; i++) {
        const a = ABS_BYTE[samples[curOff + i]];
        s0 += a;
        s1 += a;
        s2 += a;
        s3 += a;
        s4 += a;
      }
      for (let i = bpp; i < stride; i++) {
        const x = samples[curOff + i];
        const left = samples[curOff + i - bpp];
        const a0 = ABS_BYTE[x];
        const a1 = ABS_BYTE[(x - left) & 0xff];
        const a3 = ABS_BYTE[(x - (left >>> 1)) & 0xff];
        s0 += a0;
        s1 += a1;
        s2 += a0;
        s3 += a3;
        s4 += a1; // Paeth(left, 0, 0) === left
      }
    } else {
      const prevOff = curOff - stride;
      for (let i = 0; i < bpp; i++) {
        const x = samples[curOff + i];
        const up = samples[prevOff + i];
        const a0 = ABS_BYTE[x];
        const a2 = ABS_BYTE[(x - up) & 0xff];
        const a3 = ABS_BYTE[(x - (up >>> 1)) & 0xff];
        s0 += a0;
        s1 += a0;
        s2 += a2;
        s3 += a3;
        s4 += a2; // Paeth(0, up, 0) === up
      }
      for (let i = bpp; i < stride; i++) {
        const x = samples[curOff + i];
        const left = samples[curOff + i - bpp];
        const up = samples[prevOff + i];
        const upLeft = samples[prevOff + i - bpp];

        s0 += ABS_BYTE[x];
        s1 += ABS_BYTE[(x - left) & 0xff];
        s2 += ABS_BYTE[(x - up) & 0xff];
        s3 += ABS_BYTE[(x - ((left + up) >>> 1)) & 0xff];

        const p = left + up - upLeft;
        const pa = p >= left ? p - left : left - p;
        const pb = p >= up ? p - up : up - p;
        const pc = p >= upLeft ? p - upLeft : upLeft - p;
        const pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        s4 += ABS_BYTE[(x - pred) & 0xff];
      }
    }

    const base = y * 5;
    costs[base] = s0;
    costs[base + 1] = s1;
    costs[base + 2] = s2;
    costs[base + 3] = s3;
    costs[base + 4] = s4;
  }

  return costs;
}

// Compute novel 3-byte trigram counts over a small sliding window of previous rows
// (matching LZ77 minimum match length across nearby scanlines) for all 5 PNG filters.
function computeRowNovelTrigramCosts(
  samples: Uint8Array,
  width: number,
  height: number,
  bpp: number,
  winRows: number,
): Uint32Array {
  const stride = width * bpp;
  const costs = new Uint32Array(height * 5);
  const tmp = new Uint8Array(stride);
  const lastSeen = new Int32Array(262144);

  for (let f = 0; f < 5; f++) {
    lastSeen.fill(-100000);
    for (let y = 0; y < height; y++) {
      const cur = samples.subarray(y * stride, (y + 1) * stride);
      const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
      filterRow(f, cur, prev, bpp, tmp);
      const minRow = y - winRows;
      let novel = 0;
      for (let i = 2; i < stride; i++) {
        const key =
          (Math.imul((tmp[i - 2] << 10) ^ (tmp[i - 1] << 5) ^ tmp[i], 2654435761) >>> 14) &
          0x3ffff;
        if (lastSeen[key] < minRow) {
          novel++;
        }
        lastSeen[key] = y;
      }
      costs[y * 5 + f] = novel;
    }
  }

  return costs;
}

// Viterbi DP over the 5 PNG scanline filters:
// transition cost(y, prev -> cur) = rowCost(row y, filter cur) + (prev === cur ? 0 : switchPenalty).
export function viterbiSelectFilters(
  rowCosts: Uint32Array,
  height: number,
  switchPenalty: number,
): Uint8Array {
  const chosen = new Uint8Array(height);
  if (height === 0) return chosen;

  const backptr = new Uint8Array(height * 5);
  let dpPrev = new Float64Array(5);
  let dpCur = new Float64Array(5);

  for (let f = 0; f < 5; f++) {
    dpPrev[f] = rowCosts[f];
  }

  for (let y = 1; y < height; y++) {
    const base = y * 5;
    for (let f = 0; f < 5; f++) {
      let bestPrevCost = Infinity;
      let bestPrev = 0;
      for (let p = 0; p < 5; p++) {
        const cand = dpPrev[p] + (p === f ? 0 : switchPenalty);
        if (cand < bestPrevCost) {
          bestPrevCost = cand;
          bestPrev = p;
        }
      }
      dpCur[f] = bestPrevCost + rowCosts[base + f];
      backptr[base + f] = bestPrev;
    }
    const tmp = dpPrev;
    dpPrev = dpCur;
    dpCur = tmp;
  }

  let bestLast = 0;
  let bestTotal = dpPrev[0];
  for (let f = 1; f < 5; f++) {
    if (dpPrev[f] < bestTotal) {
      bestTotal = dpPrev[f];
      bestLast = f;
    }
  }

  chosen[height - 1] = bestLast;
  for (let y = height - 1; y >= 1; y--) {
    chosen[y - 1] = backptr[y * 5 + chosen[y]];
  }
  return chosen;
}

function applyFilterPlan(
  samples: Uint8Array,
  width: number,
  height: number,
  bpp: number,
  filters: Uint8Array,
): Uint8Array {
  const stride = width * bpp;
  const rowSize = stride + 1;
  const raw = new Uint8Array(height * rowSize);
  for (let y = 0; y < height; y++) {
    const f = filters[y];
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const dstOffset = y * rowSize;
    raw[dstOffset] = f;
    filterRow(f, cur, prev, bpp, raw.subarray(dstOffset + 1, dstOffset + rowSize));
  }
  return raw;
}

function samePlan(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function planForMode(
  mode: FilterMode,
  height: number,
  absCosts: Uint32Array | null,
  triCosts: Uint32Array | null,
): Uint8Array {
  if (typeof mode === 'number') {
    const fixed = new Uint8Array(height);
    fixed.fill(mode);
    return fixed;
  }
  if (mode === 'viterbi-abs-8') return viterbiSelectFilters(absCosts as Uint32Array, height, 8);
  if (mode === 'viterbi-abs-16') return viterbiSelectFilters(absCosts as Uint32Array, height, 16);
  if (mode === 'viterbi-abs-24') return viterbiSelectFilters(absCosts as Uint32Array, height, 24);
  if (mode === 'viterbi-tri-64') return viterbiSelectFilters(triCosts as Uint32Array, height, 64);
  if (mode === 'viterbi-tri-128') return viterbiSelectFilters(triCosts as Uint32Array, height, 128);
  return viterbiSelectFilters(triCosts as Uint32Array, height, 256);
}

function analyzeImage(rgba: Uint8Array): ImageAnalysis {
  let allOpaque = true;
  let allGrey = true;

  // Track single transparent RGB key for lossless color type 0/2 + tRNS
  let hasZeroAlpha = false;
  let hasPartialAlpha = false;
  let keyRgb = -1;
  let singleKeyValid = true;

  let paletteMap: Map<number, number> | null = new Map<number, number>();

  const len = rgba.length;
  for (let i = 0; i < len; i += 4) {
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    const a = rgba[i + 3];

    if (allGrey && (r !== g || g !== b)) {
      allGrey = false;
    }

    if (a !== 255) {
      allOpaque = false;
      if (a === 0) {
        const rgb = (r << 16) | (g << 8) | b;
        if (!hasZeroAlpha) {
          hasZeroAlpha = true;
          keyRgb = rgb;
        } else if (rgb !== keyRgb) {
          singleKeyValid = false;
        }
      } else {
        hasPartialAlpha = true;
        singleKeyValid = false;
      }
    }

    if (paletteMap !== null) {
      const key = (((r << 24) | (g << 16) | (b << 8) | a) >>> 0);
      const count = paletteMap.get(key);
      if (count !== undefined) {
        paletteMap.set(key, count + 1);
      } else if (paletteMap.size < 256) {
        paletteMap.set(key, 1);
      } else {
        paletteMap = null;
      }
    }
  }

  // Verify the transparent key RGB never appears with alpha === 255
  let canSingleTrnsRgb = false;
  let canSingleTrnsGrey = false;
  let singleTrnsRgb: [number, number, number] = [0, 0, 0];
  let singleTrnsGrey = 0;

  if (!allOpaque && hasZeroAlpha && !hasPartialAlpha && singleKeyValid) {
    let collision = false;
    for (let i = 0; i < len; i += 4) {
      if (rgba[i + 3] === 255) {
        const rgb = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
        if (rgb === keyRgb) {
          collision = true;
          break;
        }
      }
    }
    if (!collision) {
      const kr = (keyRgb >>> 16) & 0xff;
      const kg = (keyRgb >>> 8) & 0xff;
      const kb = keyRgb & 0xff;
      canSingleTrnsRgb = true;
      singleTrnsRgb = [kr, kg, kb];
      if (allGrey) {
        canSingleTrnsGrey = true;
        singleTrnsGrey = kr;
      }
    }
  }

  return {
    allOpaque,
    allGrey,
    canSingleTrnsRgb,
    singleTrnsRgb,
    canSingleTrnsGrey,
    singleTrnsGrey,
    paletteMap,
  };
}

interface ColorForm {
  colorType: number;
  samples: Uint8Array;
  extraChunks: Chunk[];
  labelPrefix: string;
}

interface ScreenedPlan {
  mode: FilterMode;
  filtered: Uint8Array;
  idat: Uint8Array;
  totalBytes: number;
}

interface ScreenedForm {
  form: ColorForm;
  plans: ScreenedPlan[];
  bestTotalBytes: number;
}

function extraChunksOverhead(extraChunks: readonly Chunk[]): number {
  let bytes = 0;
  for (const chunk of extraChunks) {
    bytes += 12 + chunk.data.length;
  }
  return bytes;
}

function screenColorForm(
  width: number,
  height: number,
  form: ColorForm,
  filterModes: readonly FilterMode[],
): ScreenedForm {
  const bpp = CHANNELS_BY_COLOR_TYPE[form.colorType];
  const needsAbs = filterModes.some(
    (m) => m === 'viterbi-abs-8' || m === 'viterbi-abs-16' || m === 'viterbi-abs-24',
  );
  const needsTri = filterModes.some(
    (m) => m === 'viterbi-tri-64' || m === 'viterbi-tri-128' || m === 'viterbi-tri-256',
  );
  const absCosts = needsAbs ? computeRowAbsCosts(form.samples, width, height, bpp) : null;
  const triCosts = needsTri ? computeRowNovelTrigramCosts(form.samples, width, height, bpp, 1) : null;

  const uniquePlans: { mode: FilterMode; plan: Uint8Array }[] = [];
  for (const mode of filterModes) {
    const plan = planForMode(mode, height, absCosts, triCosts);
    if (!uniquePlans.some((existing) => samePlan(existing.plan, plan))) {
      uniquePlans.push({ mode, plan });
    }
  }

  const overhead = extraChunksOverhead(form.extraChunks);
  const screened: ScreenedPlan[] = [];
  for (const { mode, plan } of uniquePlans) {
    const filtered = applyFilterPlan(form.samples, width, height, bpp, plan);
    const compressed = deflateSync(filtered, {
      level: 3,
      strategy: zlibConstants.Z_DEFAULT_STRATEGY,
      memLevel: 8,
      chunkSize: 64 * 1024,
    });
    const idat = new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.length);
    screened.push({
      mode,
      filtered,
      idat,
      totalBytes: idat.length + overhead,
    });
  }

  screened.sort((a, b) => a.totalBytes - b.totalBytes);
  return {
    form,
    plans: screened,
    bestTotalBytes: screened[0].totalBytes,
  };
}

function packPng(
  width: number,
  height: number,
  form: ColorForm,
  idat: Uint8Array,
): Uint8Array {
  const chunks: Chunk[] = [
    { type: 'IHDR', data: makeIhdr(width, height, form.colorType) },
    ...form.extraChunks,
    { type: 'IDAT', data: idat },
    { type: 'IEND', data: new Uint8Array(0) },
  ];
  return buildPng(chunks);
}

// ============================================================================
// Pure-TypeScript Zopfli-Style Optimal-Parsing DEFLATE (RFC 1951 + RFC 1950)
// ============================================================================

const DEFLATE_WINDOW_SIZE = 32768;
const DEFLATE_WINDOW_MASK = 32767;
const DEFLATE_MIN_MATCH = 3;
const DEFLATE_MAX_MATCH = 258;
const DEFLATE_HASH_SIZE = 65536;
const DEFLATE_HASH_MASK = 65535;

const LEN_BASE = Uint16Array.of(
  3, 4, 5, 6, 7, 8, 9, 10,
  11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115,
  131, 163, 195, 227, 258,
);
const LEN_EXTRA = Uint8Array.of(
  0, 0, 0, 0, 0, 0, 0, 0,
  1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4,
  5, 5, 5, 5, 0,
);
const DIST_BASE = Uint16Array.of(
  1, 2, 3, 4, 5, 7, 9, 13,
  17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073,
  4097, 6145, 8193, 12289, 16385, 24577,
);
const DIST_EXTRA = Uint8Array.of(
  0, 0, 0, 0, 1, 1, 2, 2,
  3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10,
  11, 11, 12, 12, 13, 13,
);
const CL_ORDER = Uint8Array.of(
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
);

const LEN_SYM = new Uint16Array(259);
const LEN_EXTRA_BITS = new Uint8Array(259);
const LEN_EXTRA_VAL = new Uint8Array(259);
for (let c = 0; c < 29; c++) {
  const base = LEN_BASE[c];
  const extra = LEN_EXTRA[c];
  const maxVal = c === 28 ? 1 : 1 << extra;
  for (let v = 0; v < maxVal; v++) {
    const l = base + v;
    if (l <= 258) {
      LEN_SYM[l] = 257 + c;
      LEN_EXTRA_BITS[l] = extra;
      LEN_EXTRA_VAL[l] = v;
    }
  }
}

const DIST_SYM = new Uint8Array(32769);
const DIST_EXTRA_BITS = new Uint8Array(32769);
const DIST_EXTRA_VAL = new Uint16Array(32769);
for (let c = 0; c < 30; c++) {
  const base = DIST_BASE[c];
  const extra = DIST_EXTRA[c];
  const count = 1 << extra;
  for (let v = 0; v < count; v++) {
    const d = base + v;
    if (d <= 32768) {
      DIST_SYM[d] = c;
      DIST_EXTRA_BITS[d] = extra;
      DIST_EXTRA_VAL[d] = v;
    }
  }
}

function reverseBits(code: number, len: number): number {
  let r = 0;
  for (let i = 0; i < len; i++) {
    r = (r << 1) | (code & 1);
    code >>>= 1;
  }
  return r;
}

function buildCanonicalCodes(lengths: Uint8Array, numSyms: number, outRevCodes: Uint16Array): void {
  const blCount = new Int32Array(16);
  for (let i = 0; i < numSyms; i++) {
    const l = lengths[i];
    if (l > 0) blCount[l]++;
  }
  const nextCode = new Int32Array(16);
  let code = 0;
  for (let bits = 1; bits <= 15; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  for (let i = 0; i < numSyms; i++) {
    const l = lengths[i];
    if (l > 0) {
      outRevCodes[i] = reverseBits(nextCode[l]++, l);
    } else {
      outRevCodes[i] = 0;
    }
  }
}

const FIXED_LL_LEN = new Uint8Array(288);
for (let i = 0; i <= 143; i++) FIXED_LL_LEN[i] = 8;
for (let i = 144; i <= 255; i++) FIXED_LL_LEN[i] = 9;
for (let i = 256; i <= 279; i++) FIXED_LL_LEN[i] = 7;
for (let i = 280; i <= 287; i++) FIXED_LL_LEN[i] = 8;
const FIXED_LL_CODE = new Uint16Array(288);
buildCanonicalCodes(FIXED_LL_LEN, 288, FIXED_LL_CODE);

const FIXED_D_LEN = new Uint8Array(32);
FIXED_D_LEN.fill(5);
const FIXED_D_CODE = new Uint16Array(32);
buildCanonicalCodes(FIXED_D_LEN, 32, FIXED_D_CODE);

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  const n = data.length;
  for (let i = 0; i < n; ) {
    const end = i + 5552 < n ? i + 5552 : n;
    for (; i < end; i++) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

class BitWriter {
  buf: Uint8Array;
  len = 0;
  bitBuf = 0;
  bitCount = 0;

  constructor(initialCapacity = 65536) {
    this.buf = new Uint8Array(initialCapacity);
  }

  private grow(minExtra = 1): void {
    let nextCap = this.buf.length * 2;
    const needed = this.len + minExtra;
    while (nextCap < needed) nextCap *= 2;
    const next = new Uint8Array(nextCap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  writeBits(val: number, nBits: number): void {
    this.bitBuf |= val << this.bitCount;
    this.bitCount += nBits;
    while (this.bitCount >= 8) {
      if (this.len >= this.buf.length) this.grow();
      this.buf[this.len++] = this.bitBuf & 0xff;
      this.bitBuf >>>= 8;
      this.bitCount -= 8;
    }
  }

  alignToByte(): void {
    if (this.bitCount > 0) {
      if (this.len >= this.buf.length) this.grow();
      this.buf[this.len++] = this.bitBuf & 0xff;
      this.bitBuf = 0;
      this.bitCount = 0;
    }
  }

  writeByte(b: number): void {
    if (this.len >= this.buf.length) this.grow();
    this.buf[this.len++] = b & 0xff;
  }

  writeBytes(src: Uint8Array, start: number, end: number): void {
    const count = end - start;
    if (this.len + count > this.buf.length) this.grow(count);
    this.buf.set(src.subarray(start, end), this.len);
    this.len += count;
  }

  finish(): Uint8Array {
    this.alignToByte();
    return this.buf.subarray(0, this.len);
  }
}

// Reusable scratch buffers for exact Package-Merge length-limited Huffman coding
const PM_MAX_SYMS = 286;
const PM_MAX_BITS = 15;
const PM_MAX_ROW = PM_MAX_SYMS * 2;
const pmLeafSym = new Int16Array(PM_MAX_SYMS);
const pmLeafFreq = new Float64Array(PM_MAX_SYMS);
const pmLeafLen = new Uint8Array(PM_MAX_SYMS);
const pmRowWeight = new Float64Array(PM_MAX_BITS * PM_MAX_ROW);
const pmRowLeaf = new Int16Array(PM_MAX_BITS * PM_MAX_ROW);
const pmRowLen = new Int32Array(PM_MAX_BITS);
const pmPkgWeight = new Float64Array(PM_MAX_SYMS);

function computeCodeLengths(
  freqs: Uint32Array,
  numSyms: number,
  maxBits: number,
  outLengths: Uint8Array,
): number {
  outLengths.fill(0, 0, numSyms);
  let m = 0;
  for (let i = 0; i < numSyms; i++) {
    const f = freqs[i];
    if (f > 0) {
      pmLeafSym[m] = i;
      pmLeafFreq[m] = f;
      m++;
    }
  }
  if (m === 0) return 0;
  if (m === 1) {
    outLengths[pmLeafSym[0]] = 1;
    return 1;
  }
  if (m === 2) {
    outLengths[pmLeafSym[0]] = 1;
    outLengths[pmLeafSym[1]] = 1;
    return 2;
  }

  // Deterministic insertion sort by (freq ascending, sym ascending)
  for (let i = 1; i < m; i++) {
    const f = pmLeafFreq[i];
    const s = pmLeafSym[i];
    let j = i - 1;
    while (j >= 0 && (pmLeafFreq[j] > f || (pmLeafFreq[j] === f && pmLeafSym[j] > s))) {
      pmLeafFreq[j + 1] = pmLeafFreq[j];
      pmLeafSym[j + 1] = pmLeafSym[j];
      j--;
    }
    pmLeafFreq[j + 1] = f;
    pmLeafSym[j + 1] = s;
  }

  // Level 0: leaves only
  for (let i = 0; i < m; i++) {
    pmRowWeight[i] = pmLeafFreq[i];
    pmRowLeaf[i] = i;
  }
  pmRowLen[0] = m;

  // Levels 1 .. maxBits - 1: package pairs from previous level and merge with leaves
  for (let d = 1; d < maxBits; d++) {
    const prevBase = (d - 1) * PM_MAX_ROW;
    const prevN = pmRowLen[d - 1];
    const pkgN = prevN >>> 1;
    for (let p = 0; p < pkgN; p++) {
      pmPkgWeight[p] = pmRowWeight[prevBase + (p << 1)] + pmRowWeight[prevBase + (p << 1) + 1];
    }

    const curBase = d * PM_MAX_ROW;
    let li = 0;
    let pi = 0;
    let out = 0;
    while (li < m && pi < pkgN) {
      if (pmLeafFreq[li] <= pmPkgWeight[pi]) {
        pmRowWeight[curBase + out] = pmLeafFreq[li];
        pmRowLeaf[curBase + out] = li;
        li++;
      } else {
        pmRowWeight[curBase + out] = pmPkgWeight[pi];
        pmRowLeaf[curBase + out] = -1;
        pi++;
      }
      out++;
    }
    while (li < m) {
      pmRowWeight[curBase + out] = pmLeafFreq[li];
      pmRowLeaf[curBase + out] = li;
      li++;
      out++;
    }
    while (pi < pkgN) {
      pmRowWeight[curBase + out] = pmPkgWeight[pi];
      pmRowLeaf[curBase + out] = -1;
      pi++;
      out++;
    }
    pmRowLen[d] = out;
  }

  // Backtrack from top level
  pmLeafLen.fill(0, 0, m);
  let take = (m << 1) - 2;
  for (let d = maxBits - 1; d >= 0; d--) {
    const base = d * PM_MAX_ROW;
    let pkgCount = 0;
    for (let i = 0; i < take; i++) {
      const lid = pmRowLeaf[base + i];
      if (lid >= 0) {
        pmLeafLen[lid]++;
      } else {
        pkgCount++;
      }
    }
    take = pkgCount << 1;
  }

  for (let i = 0; i < m; i++) {
    outLengths[pmLeafSym[i]] = pmLeafLen[i];
  }
  return m;
}

// Zopfli's OptimizeHuffmanForRle: smooth small frequency variations so adjacent
// symbols share code lengths and RLE-compress into a smaller dynamic header.
function optimizeHuffmanForRle(counts: Uint32Array, length: number, out: Uint32Array): void {
  let n = length;
  while (n > 0 && counts[n - 1] === 0) n--;
  out.set(counts.subarray(0, length));
  if (n === 0) return;

  const goodForRle = new Uint8Array(n);
  let symbol = out[0];
  let stride = 0;
  for (let i = 0; i <= n; i++) {
    if (i === n || out[i] !== symbol) {
      if ((symbol === 0 && stride >= 5) || (symbol !== 0 && stride >= 7)) {
        for (let k = i - stride; k < i; k++) goodForRle[k] = 1;
      }
      stride = 1;
      if (i < n) symbol = out[i];
    } else {
      stride++;
    }
  }

  stride = 0;
  let limit = out[0];
  let sum = 0;
  for (let i = 0; i <= n; i++) {
    if (
      i === n ||
      goodForRle[i] !== 0 ||
      (i > 0 && goodForRle[i - 1] !== 0) ||
      Math.abs(out[i] - limit) >= 4
    ) {
      if (stride >= 4 || (stride >= 3 && sum === 0)) {
        let count = Math.floor((sum + stride / 2) / stride);
        if (count < 1) count = 1;
        if (sum === 0) count = 0;
        for (let k = i - stride; k < i; k++) out[k] = count;
      }
      stride = 0;
      sum = 0;
      if (i < n - 3) {
        limit = Math.floor((out[i] + out[i + 1] + out[i + 2] + out[i + 3] + 2) / 4);
      } else if (i < n) {
        limit = out[i];
      } else {
        limit = 0;
      }
    }
    if (i < n) {
      stride++;
      sum += out[i];
      if (stride >= 4) {
        limit = Math.floor((sum + stride / 2) / stride);
      }
    }
  }
}

interface DynamicTreePlan {
  hlit: number;
  hdist: number;
  hclen: number;
  llLengths: Uint8Array;
  dLengths: Uint8Array;
  clLengths: Uint8Array;
  rleSyms: Uint8Array;
  rleExtras: Uint8Array;
  rleCount: number;
  headerBits: number;
  totalBits: number;
}

const rleCombinedScratch = new Uint8Array(286 + 30);
const rleSymsScratch = new Uint8Array(320);
const rleExtrasScratch = new Uint8Array(320);
const clCountsScratch = new Uint32Array(19);
const clLenScratch = new Uint8Array(19);
const llLenA = new Uint8Array(286);
const dLenA = new Uint8Array(30);
const llLenB = new Uint8Array(286);
const dLenB = new Uint8Array(30);
const optLlCounts = new Uint32Array(286);
const optDCounts = new Uint32Array(30);

function encodeRleCandidate(
  llLengths: Uint8Array,
  hlit: number,
  dLengths: Uint8Array,
  hdist: number,
  use16: boolean,
  use17: boolean,
): { headerBits: number; hclen: number; rleCount: number } {
  const total = hlit + hdist;
  rleCombinedScratch.set(llLengths.subarray(0, hlit), 0);
  rleCombinedScratch.set(dLengths.subarray(0, hdist), hlit);

  let rleCount = 0;
  clCountsScratch.fill(0);

  let i = 0;
  while (i < total) {
    const v = rleCombinedScratch[i];
    let run = 1;
    while (i + run < total && rleCombinedScratch[i + run] === v) run++;
    i += run;

    if (v === 0 && use17 && run >= 3) {
      while (run >= 11) {
        let c = run < 138 ? run : 138;
        if (run - c === 1 || run - c === 2) {
          if (run >= 14) c = run - 3;
        }
        rleSymsScratch[rleCount] = 18;
        rleExtrasScratch[rleCount] = c - 11;
        rleCount++;
        clCountsScratch[18]++;
        run -= c;
      }
      while (run >= 3) {
        const c = run < 10 ? run : 10;
        rleSymsScratch[rleCount] = 17;
        rleExtrasScratch[rleCount] = c - 3;
        rleCount++;
        clCountsScratch[17]++;
        run -= c;
      }
      while (run > 0) {
        rleSymsScratch[rleCount] = 0;
        rleExtrasScratch[rleCount] = 0;
        rleCount++;
        clCountsScratch[0]++;
        run--;
      }
    } else if (v !== 0 && use16 && run >= 4) {
      rleSymsScratch[rleCount] = v;
      rleExtrasScratch[rleCount] = 0;
      rleCount++;
      clCountsScratch[v]++;
      run--;
      while (run >= 3) {
        let c = run < 6 ? run : 6;
        if (run === 7) c = 4;
        else if (run === 8) c = 5;
        rleSymsScratch[rleCount] = 16;
        rleExtrasScratch[rleCount] = c - 3;
        rleCount++;
        clCountsScratch[16]++;
        run -= c;
      }
      while (run > 0) {
        rleSymsScratch[rleCount] = v;
        rleExtrasScratch[rleCount] = 0;
        rleCount++;
        clCountsScratch[v]++;
        run--;
      }
    } else {
      while (run > 0) {
        rleSymsScratch[rleCount] = v;
        rleExtrasScratch[rleCount] = 0;
        rleCount++;
        clCountsScratch[v]++;
        run--;
      }
    }
  }

  const activeCl = computeCodeLengths(clCountsScratch, 19, 7, clLenScratch);
  // Precode tree MUST be complete in zlib inflate_table(CODES)
  if (activeCl === 1) {
    let firstSym = -1;
    for (let s = 0; s < 19; s++) {
      if (clLenScratch[s] > 0) {
        firstSym = s;
        break;
      }
    }
    clLenScratch[firstSym === 0 ? 1 : 0] = 1;
  }

  let hclen = 19;
  while (hclen > 4 && clLenScratch[CL_ORDER[hclen - 1]] === 0) hclen--;

  let headerBits = 14 + 3 * hclen;
  for (let s = 0; s < 19; s++) {
    const cnt = clCountsScratch[s];
    if (cnt > 0) {
      const extra = s === 16 ? 2 : s === 17 ? 3 : s === 18 ? 7 : 0;
      headerBits += cnt * (clLenScratch[s] + extra);
    }
  }

  return { headerBits, hclen, rleCount };
}

function computeDataBits(
  llCounts: Uint32Array,
  dCounts: Uint32Array,
  llLengths: Uint8Array,
  dLengths: Uint8Array,
): number {
  let bits = 0;
  for (let s = 0; s < 257; s++) {
    const c = llCounts[s];
    if (c > 0) bits += c * llLengths[s];
  }
  for (let s = 257; s < 286; s++) {
    const c = llCounts[s];
    if (c > 0) bits += c * (llLengths[s] + LEN_EXTRA[s - 257]);
  }
  for (let d = 0; d < 30; d++) {
    const c = dCounts[d];
    if (c > 0) bits += c * (dLengths[d] + DIST_EXTRA[d]);
  }
  return bits;
}

function computeDynamicTreeBitsOnly(
  llCounts: Uint32Array,
  dCounts: Uint32Array,
  tryRleOpt: boolean,
): number {
  computeCodeLengths(llCounts, 286, 15, llLenA);
  computeCodeLengths(dCounts, 30, 15, dLenA);

  let hlitA = 286;
  while (hlitA > 257 && llLenA[hlitA - 1] === 0) hlitA--;
  let hdistA = 30;
  while (hdistA > 1 && dLenA[hdistA - 1] === 0) hdistA--;

  const dataA = computeDataBits(llCounts, dCounts, llLenA, dLenA);
  let best = Infinity;
  for (let mask = 0; mask < 4; mask++) {
    const r = encodeRleCandidate(llLenA, hlitA, dLenA, hdistA, (mask & 1) !== 0, (mask & 2) !== 0);
    const total = r.headerBits + dataA;
    if (total < best) best = total;
  }

  if (tryRleOpt) {
    optimizeHuffmanForRle(llCounts, 286, optLlCounts);
    optimizeHuffmanForRle(dCounts, 30, optDCounts);
    // Ensure every actually used symbol keeps count >= 1
    for (let s = 0; s < 286; s++) if (llCounts[s] > 0 && optLlCounts[s] === 0) optLlCounts[s] = 1;
    for (let d = 0; d < 30; d++) if (dCounts[d] > 0 && optDCounts[d] === 0) optDCounts[d] = 1;

    computeCodeLengths(optLlCounts, 286, 15, llLenB);
    computeCodeLengths(optDCounts, 30, 15, dLenB);

    let hlitB = 286;
    while (hlitB > 257 && llLenB[hlitB - 1] === 0) hlitB--;
    let hdistB = 30;
    while (hdistB > 1 && dLenB[hdistB - 1] === 0) hdistB--;

    const dataB = computeDataBits(llCounts, dCounts, llLenB, dLenB);
    for (let mask = 0; mask < 4; mask++) {
      const r = encodeRleCandidate(llLenB, hlitB, dLenB, hdistB, (mask & 1) !== 0, (mask & 2) !== 0);
      const total = r.headerBits + dataB;
      if (total < best) best = total;
    }
  }

  return best;
}

function computeDynamicTreeBitsFast(
  llCounts: Uint32Array,
  dCounts: Uint32Array,
): number {
  computeCodeLengths(llCounts, 286, 15, llLenA);
  computeCodeLengths(dCounts, 30, 15, dLenA);

  let hlitA = 286;
  while (hlitA > 257 && llLenA[hlitA - 1] === 0) hlitA--;
  let hdistA = 30;
  while (hdistA > 1 && dLenA[hdistA - 1] === 0) hdistA--;

  const dataA = computeDataBits(llCounts, dCounts, llLenA, dLenA);
  const r = encodeRleCandidate(llLenA, hlitA, dLenA, hdistA, true, true);
  return r.headerBits + dataA;
}

function encodeRleDp(
  llLengths: Uint8Array,
  hlit: number,
  dLengths: Uint8Array,
  hdist: number,
  initClLen: Uint8Array,
): { headerBits: number; hclen: number; rleCount: number; clLen: Uint8Array; syms: Uint8Array; extras: Uint8Array } {
  const total = hlit + hdist;
  rleCombinedScratch.set(llLengths.subarray(0, hlit), 0);
  rleCombinedScratch.set(dLengths.subarray(0, hdist), hlit);

  const clCost = new Float64Array(19);
  const dp = new Float64Array(total + 1);
  const prevPos = new Int16Array(total + 1);
  const prevSym = new Uint8Array(total + 1);
  const prevExt = new Uint8Array(total + 1);
  const curClLen = new Uint8Array(initClLen);
  const nextClCounts = new Uint32Array(19);
  const nextClLen = new Uint8Array(19);

  let bestHeaderBits = Infinity;
  let bestHclen = 4;
  let bestRleCount = 0;
  let bestClLen = new Uint8Array(19);
  let bestSyms = new Uint8Array(0);
  let bestExtras = new Uint8Array(0);

  for (let pass = 0; pass < 2; pass++) {
    for (let s = 0; s < 19; s++) {
      clCost[s] = curClLen[s] > 0 ? curClLen[s] : 8.5;
    }
    dp.fill(Infinity);
    dp[0] = 0;

    for (let i = 0; i < total; i++) {
      const base = dp[i];
      const v = rleCombinedScratch[i];
      const litC = base + clCost[v];
      if (litC < dp[i + 1]) {
        dp[i + 1] = litC;
        prevPos[i + 1] = i;
        prevSym[i + 1] = v;
        prevExt[i + 1] = 0;
      }

      if (i > 0) {
        const pv = rleCombinedScratch[i - 1];
        const c16 = base + clCost[16] + 2;
        const maxK = total - i < 6 ? total - i : 6;
        for (let k = 1; k <= maxK; k++) {
          if (rleCombinedScratch[i + k - 1] !== pv) break;
          if (k >= 3 && c16 < dp[i + k]) {
            dp[i + k] = c16;
            prevPos[i + k] = i;
            prevSym[i + k] = 16;
            prevExt[i + k] = k - 3;
          }
        }
      }

      if (v === 0) {
        let zRun = 1;
        const maxZ = total - i < 138 ? total - i : 138;
        while (zRun < maxZ && rleCombinedScratch[i + zRun] === 0) zRun++;
        const c17 = base + clCost[17] + 3;
        const lim17 = zRun < 10 ? zRun : 10;
        for (let k = 3; k <= lim17; k++) {
          if (c17 < dp[i + k]) {
            dp[i + k] = c17;
            prevPos[i + k] = i;
            prevSym[i + k] = 17;
            prevExt[i + k] = k - 3;
          }
        }
        if (zRun >= 11) {
          const c18 = base + clCost[18] + 7;
          for (let k = 11; k <= zRun; k++) {
            if (c18 < dp[i + k]) {
              dp[i + k] = c18;
              prevPos[i + k] = i;
              prevSym[i + k] = 18;
              prevExt[i + k] = k - 11;
            }
          }
        }
      }
    }

    // Backtrack
    let cnt = 0;
    let p = total;
    while (p > 0) {
      cnt++;
      p = prevPos[p];
    }
    const syms = new Uint8Array(cnt);
    const extras = new Uint8Array(cnt);
    nextClCounts.fill(0);
    p = total;
    let idx = cnt - 1;
    while (p > 0) {
      const s = prevSym[p];
      syms[idx] = s;
      extras[idx] = prevExt[p];
      nextClCounts[s]++;
      p = prevPos[p];
      idx--;
    }

    const activeCl = computeCodeLengths(nextClCounts, 19, 7, nextClLen);
    if (activeCl === 1) {
      let firstSym = -1;
      for (let s = 0; s < 19; s++) {
        if (nextClLen[s] > 0) {
          firstSym = s;
          break;
        }
      }
      nextClLen[firstSym === 0 ? 1 : 0] = 1;
    }

    let hclen = 19;
    while (hclen > 4 && nextClLen[CL_ORDER[hclen - 1]] === 0) hclen--;

    let headerBits = 14 + 3 * hclen;
    for (let s = 0; s < 19; s++) {
      const c = nextClCounts[s];
      if (c > 0) {
        const ext = s === 16 ? 2 : s === 17 ? 3 : s === 18 ? 7 : 0;
        headerBits += c * (nextClLen[s] + ext);
      }
    }

    if (headerBits < bestHeaderBits) {
      bestHeaderBits = headerBits;
      bestHclen = hclen;
      bestRleCount = cnt;
      bestClLen = new Uint8Array(nextClLen);
      bestSyms = syms;
      bestExtras = extras;
    }
    curClLen.set(nextClLen);
  }

  return {
    headerBits: bestHeaderBits,
    hclen: bestHclen,
    rleCount: bestRleCount,
    clLen: bestClLen,
    syms: bestSyms,
    extras: bestExtras,
  };
}

function buildBestDynamicTreePlan(
  llCounts: Uint32Array,
  dCounts: Uint32Array,
): DynamicTreePlan {
  computeCodeLengths(llCounts, 286, 15, llLenA);
  computeCodeLengths(dCounts, 30, 15, dLenA);
  optimizeHuffmanForRle(llCounts, 286, optLlCounts);
  optimizeHuffmanForRle(dCounts, 30, optDCounts);
  for (let s = 0; s < 286; s++) if (llCounts[s] > 0 && optLlCounts[s] === 0) optLlCounts[s] = 1;
  for (let d = 0; d < 30; d++) if (dCounts[d] > 0 && optDCounts[d] === 0) optDCounts[d] = 1;
  computeCodeLengths(optLlCounts, 286, 15, llLenB);
  computeCodeLengths(optDCounts, 30, 15, dLenB);

  let bestPlan: DynamicTreePlan | null = null;

  const candidates: [Uint8Array, Uint8Array][] = [
    [llLenA, dLenA],
    [llLenB, dLenA],
    [llLenA, dLenB],
    [llLenB, dLenB],
  ];

  for (const [llL, dL] of candidates) {
    let hlit = 286;
    while (hlit > 257 && llL[hlit - 1] === 0) hlit--;
    let hdist = 30;
    while (hdist > 1 && dL[hdist - 1] === 0) hdist--;
    const dataBits = computeDataBits(llCounts, dCounts, llL, dL);

    let bestCandHeader = Infinity;
    let bestCandMask = 3;
    const bestInitCl = new Uint8Array(19);

    for (let mask = 0; mask < 4; mask++) {
      const r = encodeRleCandidate(llL, hlit, dL, hdist, (mask & 1) !== 0, (mask & 2) !== 0);
      if (r.headerBits < bestCandHeader) {
        bestCandHeader = r.headerBits;
        bestCandMask = mask;
        bestInitCl.set(clLenScratch);
      }
    }

    const rHeur = encodeRleCandidate(
      llL,
      hlit,
      dL,
      hdist,
      (bestCandMask & 1) !== 0,
      (bestCandMask & 2) !== 0,
    );
    const heurTotal = rHeur.headerBits + dataBits;
    if (bestPlan === null || heurTotal < bestPlan.totalBits) {
      bestPlan = {
        hlit,
        hdist,
        hclen: rHeur.hclen,
        llLengths: new Uint8Array(llL),
        dLengths: new Uint8Array(dL),
        clLengths: new Uint8Array(clLenScratch),
        rleSyms: rleSymsScratch.slice(0, rHeur.rleCount),
        rleExtras: rleExtrasScratch.slice(0, rHeur.rleCount),
        rleCount: rHeur.rleCount,
        headerBits: rHeur.headerBits,
        totalBits: heurTotal,
      };
    }

    const rDp = encodeRleDp(llL, hlit, dL, hdist, bestInitCl);
    const dpTotal = rDp.headerBits + dataBits;
    if (dpTotal < bestPlan.totalBits) {
      bestPlan = {
        hlit,
        hdist,
        hclen: rDp.hclen,
        llLengths: new Uint8Array(llL),
        dLengths: new Uint8Array(dL),
        clLengths: rDp.clLen,
        rleSyms: rDp.syms,
        rleExtras: rDp.extras,
        rleCount: rDp.rleCount,
        headerBits: rDp.headerBits,
        totalBits: dpTotal,
      };
    }
  }

  return bestPlan as DynamicTreePlan;
}

function computeSameArray(data: Uint8Array): Int32Array {
  const n = data.length;
  const same = new Int32Array(n);
  if (n === 0) return same;
  same[n - 1] = 1;
  for (let i = n - 2; i >= 0; i--) {
    same[i] = data[i] === data[i + 1] ? same[i + 1] + 1 : 1;
  }
  return same;
}

function computeDistMatchArray(data: Uint8Array, dist: number): Int32Array {
  const n = data.length;
  const arr = new Int32Array(n);
  if (dist <= 0 || dist >= n) return arr;
  for (let i = n - 1; i >= dist; i--) {
    if (data[i] === data[i - dist]) {
      arr[i] = i + 1 < n ? arr[i + 1] + 1 : 1;
    }
  }
  return arr;
}

function hash3(data: Uint8Array, i: number): number {
  return (
    Math.imul((data[i] << 16) | (data[i + 1] << 8) | data[i + 2], 2654435761) >>> 16
  );
}

function hash4(data: Uint8Array, i: number): number {
  return (
    Math.imul(
      ((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]) >>> 0,
      2654435761,
    ) >>> 16
  );
}

function hashSame(val: number, runLen: number, nextByte: number): number {
  return Math.imul((val << 16) | (runLen << 8) | nextByte, 2654435761) >>> 16;
}

interface LazyLz77Result {
  symLl: Uint16Array;
  symD: Uint8Array; // 255 = literal, 0..29 = distance sym
  symPos: Int32Array;
  count: number;
}

// Fast lazy LZ77 pass over the full stream for initial statistics and block splitting.
function runLazyLz77(data: Uint8Array, same: Int32Array, chainLimit: number): LazyLz77Result {
  const n = data.length;
  const head1 = new Int32Array(DEFLATE_HASH_SIZE);
  const prev1 = new Int32Array(DEFLATE_WINDOW_SIZE);
  const head2 = new Int32Array(DEFLATE_HASH_SIZE);
  const prev2 = new Int32Array(DEFLATE_WINDOW_SIZE);
  head1.fill(-1);
  prev1.fill(-1);
  head2.fill(-1);
  prev2.fill(-1);

  let cap = Math.max(1024, (n >>> 2) + 1024);
  let symLl = new Uint16Array(cap);
  let symD = new Uint8Array(cap);
  let symPos = new Int32Array(cap + 1);
  let count = 0;

  const ensureCap = () => {
    if (count + 2 >= cap) {
      cap *= 2;
      const nLl = new Uint16Array(cap);
      nLl.set(symLl);
      symLl = nLl;
      const nD = new Uint8Array(cap);
      nD.set(symD);
      symD = nD;
      const nP = new Int32Array(cap + 1);
      nP.set(symPos);
      symPos = nP;
    }
  };

  let lastInserted = -1;
  const insertUpTo = (target: number) => {
    const limit = n - 3;
    const end = target < limit ? target : limit;
    for (let idx = lastInserted + 1; idx <= end; idx++) {
      // Skip deep interior of long uniform runs
      if (idx > 0 && data[idx] === data[idx - 1] && same[idx] >= 260) {
        continue;
      }
      const h1 = hash3(data, idx);
      prev1[idx & DEFLATE_WINDOW_MASK] = head1[h1];
      head1[h1] = idx;
      const s = same[idx];
      if (s >= 3 && s < 258 && idx + s < n) {
        const h2 = hashSame(data[idx], s, data[idx + s]);
        prev2[idx & DEFLATE_WINDOW_MASK] = head2[h2];
        head2[h2] = idx;
      }
    }
    if (end > lastInserted) lastInserted = end;
  };

  let bestLen = 0;
  let bestDist = 0;

  const findBest = (i: number) => {
    bestLen = 0;
    bestDist = 0;
    const maxLen = n - i < DEFLATE_MAX_MATCH ? n - i : DEFLATE_MAX_MATCH;
    if (maxLen < 3) return;

    const si = same[i];
    if (i > 0 && data[i - 1] === data[i]) {
      const rlen = si < maxLen ? si : maxLen;
      if (rlen >= 3) {
        bestLen = rlen;
        bestDist = 1;
        if (bestLen === maxLen) return;
      }
    }

    const minPos = i > DEFLATE_WINDOW_SIZE ? i - DEFLATE_WINDOW_SIZE : 0;
    const b0 = data[i];
    const b1 = data[i + 1];
    const b2 = data[i + 2];

    if (bestLen < si || si < 3) {
      let pos = head1[hash3(data, i)];
      let steps = chainLimit;
      while (pos >= minPos && steps-- > 0) {
        if (bestLen < 3) {
          if (data[pos] === b0 && data[pos + 1] === b1 && data[pos + 2] === b2) {
            let ml = 3;
            if (si >= 3) {
              const sp = same[pos];
              if (sp < si) ml = sp;
              else if (sp > si) ml = si;
              else {
                ml = si;
                while (ml < maxLen && data[pos + ml] === data[i + ml]) ml++;
              }
            } else {
              while (ml < maxLen && data[pos + ml] === data[i + ml]) ml++;
            }
            if (ml > maxLen) ml = maxLen;
            if (ml > bestLen) {
              bestLen = ml;
              bestDist = i - pos;
              if (bestLen === maxLen) return;
              if (si >= 3 && bestLen >= si) break;
            }
          }
        } else if (data[pos + bestLen] === data[i + bestLen] && data[pos] === b0 && data[pos + 1] === b1) {
          let ml = 2;
          while (ml < maxLen && data[pos + ml] === data[i + ml]) ml++;
          if (ml > bestLen) {
            bestLen = ml;
            bestDist = i - pos;
            if (bestLen === maxLen) return;
            if (si >= 3 && bestLen >= si) break;
          }
        }
        const next = prev1[pos & DEFLATE_WINDOW_MASK];
        if (next >= pos) break;
        pos = next;
      }
    }

    if (si >= 3 && si < maxLen && i + si < n) {
      const nb = data[i + si];
      let pos = head2[hashSame(b0, si, nb)];
      let steps = chainLimit;
      while (pos >= minPos && steps-- > 0) {
        if (
          same[pos] === si &&
          data[pos] === b0 &&
          data[pos + si] === nb &&
          data[pos + bestLen] === data[i + bestLen]
        ) {
          let ml = si + 1;
          while (ml < maxLen && data[pos + ml] === data[i + ml]) ml++;
          if (ml > bestLen) {
            bestLen = ml;
            bestDist = i - pos;
            if (bestLen === maxLen) return;
          }
        }
        const next = prev2[pos & DEFLATE_WINDOW_MASK];
        if (next >= pos) break;
        pos = next;
      }
    }
  };

  let i = 0;
  while (i < n) {
    insertUpTo(i - 1);
    findBest(i);
    const l1 = bestLen;
    const d1 = bestDist;

    if (l1 >= 3 && l1 < 16 && i + 1 < n) {
      insertUpTo(i);
      findBest(i + 1);
      if (bestLen > l1 + 1) {
        // Lazy emit literal at i
        ensureCap();
        symLl[count] = data[i];
        symD[count] = 255;
        symPos[count] = i;
        count++;
        i++;
        continue;
      }
    }

    if (l1 >= 3) {
      ensureCap();
      symLl[count] = LEN_SYM[l1];
      symD[count] = DIST_SYM[d1];
      symPos[count] = i;
      count++;
      i += l1;
    } else {
      ensureCap();
      symLl[count] = data[i];
      symD[count] = 255;
      symPos[count] = i;
      count++;
      i++;
    }
  }
  symPos[count] = n;
  return { symLl, symD, symPos, count };
}

// Evaluate exact block cost (min of dynamic and fixed Huffman, without RLE smoothing for speed)
function estimateSplitBlockBits(llCounts: Uint32Array, dCounts: Uint32Array): number {
  llCounts[256] = 1;
  const dyn = computeDynamicTreeBitsOnly(llCounts, dCounts, false);
  const fix = computeDataBits(llCounts, dCounts, FIXED_LL_LEN, FIXED_D_LEN);
  llCounts[256] = 0;
  return (dyn < fix ? dyn : fix) + 3;
}

// Generic coarse-to-fine Zopfli block splitter over a symbol stream (symLl, symD).
function splitSymbolStream(
  symLl: Uint16Array,
  symD: Uint8Array,
  totalSyms: number,
  maxBlocks: number,
  minSegSyms: number,
  minGainBits: number,
  useRleOpt: boolean,
  initialSplits?: number[],
): number[] {
  const splitSyms: number[] = initialSplits ? initialSplits.slice() : [0, totalSyms];
  if (totalSyms < minSegSyms * 2 || maxBlocks <= 1) {
    return splitSyms;
  }
  const done: boolean[] = new Array(splitSyms.length - 1).fill(false);

  const NUM_POINTS = 9;
  const subLl = Array.from({ length: NUM_POINTS + 1 }, () => new Uint32Array(286));
  const subD = Array.from({ length: NUM_POINTS + 1 }, () => new Uint32Array(30));
  const leftLl = new Uint32Array(286);
  const leftD = new Uint32Array(30);
  const rightLl = new Uint32Array(286);
  const rightD = new Uint32Array(30);
  const totalLl = new Uint32Array(286);
  const totalD = new Uint32Array(30);

  const costOf = (ll: Uint32Array, d: Uint32Array): number => {
    ll[256] = 1;
    const dyn = useRleOpt
      ? computeDynamicTreeBitsOnly(ll, d, true)
      : computeDynamicTreeBitsFast(ll, d);
    const fix = computeDataBits(ll, d, FIXED_LL_LEN, FIXED_D_LEN);
    ll[256] = 0;
    return (dyn < fix ? dyn : fix) + 3;
  };

  const findBestSplit = (l: number, r: number): { bestPos: number; bestCost: number; wholeCost: number } => {
    totalLl.fill(0);
    totalD.fill(0);
    for (let i = l; i < r; i++) {
      totalLl[symLl[i]]++;
      const d = symD[i];
      if (d !== 255) totalD[d]++;
    }
    const wholeCost = costOf(totalLl, totalD);

    let lo = l;
    let hi = r;
    let bestPos = l;
    let bestCost = Infinity;
    const pts = new Int32Array(NUM_POINTS + 2);

    for (let round = 0; round < 6; round++) {
      if (hi - lo < 16) break;
      pts[0] = lo;
      for (let k = 1; k <= NUM_POINTS; k++) {
        pts[k] = lo + Math.floor(((hi - lo) * k) / (NUM_POINTS + 1));
      }
      pts[NUM_POINTS + 1] = hi;

      leftLl.fill(0);
      leftD.fill(0);
      for (let i = l; i < lo; i++) {
        leftLl[symLl[i]]++;
        const d = symD[i];
        if (d !== 255) leftD[d]++;
      }

      for (let k = 0; k <= NUM_POINTS; k++) {
        const sLl = subLl[k];
        const sD = subD[k];
        sLl.fill(0);
        sD.fill(0);
        const a = pts[k];
        const b = pts[k + 1];
        for (let i = a; i < b; i++) {
          sLl[symLl[i]]++;
          const d = symD[i];
          if (d !== 255) sD[d]++;
        }
      }

      let roundBestIdx = 1;
      let roundBestCost = Infinity;

      for (let k = 1; k <= NUM_POINTS; k++) {
        const addLl = subLl[k - 1];
        const addD = subD[k - 1];
        for (let s = 0; s < 286; s++) {
          leftLl[s] += addLl[s];
          rightLl[s] = totalLl[s] - leftLl[s];
        }
        for (let d = 0; d < 30; d++) {
          leftD[d] += addD[d];
          rightD[d] = totalD[d] - leftD[d];
        }
        const cost = costOf(leftLl, leftD) + costOf(rightLl, rightD);
        if (cost < roundBestCost) {
          roundBestCost = cost;
          roundBestIdx = k;
        }
        if (cost < bestCost) {
          bestCost = cost;
          bestPos = pts[k];
        }
      }

      lo = pts[roundBestIdx - 1];
      hi = pts[roundBestIdx + 1];
    }

    return { bestPos, bestCost, wholeCost };
  };

  while (splitSyms.length - 1 < maxBlocks) {
    let pickIdx = -1;
    let pickLen = 0;
    for (let i = 0; i < splitSyms.length - 1; i++) {
      if (done[i]) continue;
      const segLen = splitSyms[i + 1] - splitSyms[i];
      if (segLen >= minSegSyms && segLen > pickLen) {
        pickLen = segLen;
        pickIdx = i;
      }
    }
    if (pickIdx < 0) break;

    const l = splitSyms[pickIdx];
    const r = splitSyms[pickIdx + 1];
    const { bestPos, bestCost, wholeCost } = findBestSplit(l, r);

    if (bestPos > l && bestPos < r && bestCost + minGainBits < wholeCost) {
      splitSyms.splice(pickIdx + 1, 0, bestPos);
      done.splice(pickIdx + 1, 0, false);
    } else {
      done[pickIdx] = true;
    }
  }

  return splitSyms;
}

// Zopfli-style coarse-to-fine block splitting over the initial LZ77 symbol stream.
function splitLz77Blocks(
  lazy: LazyLz77Result,
  dataLen: number,
  maxBlocks: number,
  maxBlockBytes: number,
): number[] {
  const splitSyms = splitSymbolStream(
    lazy.symLl,
    lazy.symD,
    lazy.count,
    maxBlocks,
    512,
    8,
    false,
  );
  const { symPos } = lazy;

  // Convert symbol boundaries to byte boundaries and cap any huge block to maxBlockBytes
  const byteBounds: number[] = [0];
  for (let i = 1; i < splitSyms.length; i++) {
    const prevByte = byteBounds[byteBounds.length - 1];
    const nextByte = symPos[splitSyms[i]];
    if (nextByte - prevByte > maxBlockBytes) {
      const pieces = Math.ceil((nextByte - prevByte) / maxBlockBytes);
      for (let p = 1; p < pieces; p++) {
        byteBounds.push(prevByte + Math.floor(((nextByte - prevByte) * p) / pieces));
      }
    }
    if (nextByte > byteBounds[byteBounds.length - 1]) {
      byteBounds.push(nextByte);
    }
  }
  if (byteBounds[byteBounds.length - 1] !== dataLen) {
    byteBounds[byteBounds.length - 1] = dataLen;
  }
  return byteBounds;
}

interface BlockMatchCache {
  blockLen: number;
  offsets: Int32Array; // -1 sentinel marks deep uniform run skip
  lens: Uint8Array;    // stored as len - 3
  dists: Uint16Array;  // stored as dist - 1
  pairCount: number;
}

class SlidingHashState {
  head1 = new Int32Array(DEFLATE_HASH_SIZE);
  prev1 = new Int32Array(DEFLATE_WINDOW_SIZE);
  head2 = new Int32Array(DEFLATE_HASH_SIZE);
  prev2 = new Int32Array(DEFLATE_WINDOW_SIZE);
  head4 = new Int32Array(DEFLATE_HASH_SIZE);
  prev4 = new Int32Array(DEFLATE_WINDOW_SIZE);

  constructor() {
    this.head1.fill(-1);
    this.prev1.fill(-1);
    this.head2.fill(-1);
    this.prev2.fill(-1);
    this.head4.fill(-1);
    this.prev4.fill(-1);
  }
}

const VERTICAL_PROBE_ROWS = Uint8Array.of(1, 2, 3, 4, 8);

// Build Pareto-optimal match cache for [blockStart, blockEnd) while advancing hash continuously.
function buildBlockMatchCache(
  data: Uint8Array,
  same: Int32Array,
  sameBpp: Int32Array | null,
  bpp: number,
  sameRow: Int32Array | null,
  hash: SlidingHashState,
  blockStart: number,
  blockEnd: number,
  chainLimit3: number,
  chainLimit4: number,
  rowSize: number,
): BlockMatchCache {
  const n = data.length;
  const blockLen = blockEnd - blockStart;
  const offsets = new Int32Array(blockLen + 1);
  let cap = Math.max(4096, blockLen * 2);
  let lens = new Uint8Array(cap);
  let dists = new Uint16Array(cap);
  let pairCount = 0;

  const { head1, prev1, head2, prev2, head4, prev4 } = hash;

  const ensureCap = (need: number) => {
    if (pairCount + need > cap) {
      while (pairCount + need > cap) cap *= 2;
      const nL = new Uint8Array(cap);
      nL.set(lens.subarray(0, pairCount));
      lens = nL;
      const nD = new Uint16Array(cap);
      nD.set(dists.subarray(0, pairCount));
      dists = nD;
    }
  };

  let runBehind = 0;
  if (blockStart > 0) {
    let k = blockStart - 1;
    const b = data[blockStart];
    while (k >= 0 && runBehind < 260 && data[k] === b) {
      runBehind++;
      k--;
    }
  }

  let prevOnly258Dist = 0;
  let prevOnly258Streak = 0;

  for (let p = 0; p < blockLen; p++) {
    const i = blockStart + p;
    if (p > 0) {
      if (data[i] === data[i - 1]) runBehind++;
      else runBehind = 0;
    }

    const si = same[i];
    const rem = blockEnd - i;

    // 1) Deep interior of a uniform dist=1 run: skip match-finding and hash insertion
    // Note: runBehind >= 4 is required because optimalParseBlock may pick bestSmallDist in 1..4.
    if (runBehind >= 4 && si >= 260 && rem >= 260) {
      offsets[p] = -1;
      prevOnly258Streak = 0;
      continue;
    }

    // 2) Deep interior of a uniform bpp-periodic run (e.g. flat RGB/RGBA fill): O(1) skip
    const sBpp = sameBpp !== null ? sameBpp[i] : 0;
    if (
      sameBpp !== null &&
      si < 3 &&
      sBpp >= 260 &&
      rem >= 260 &&
      i >= bpp + 4 &&
      sameBpp[i - 4] >= 264
    ) {
      offsets[p] = -(bpp + 2);
      prevOnly258Streak = 0;
      if ((n <= 1_200_000 || (i & 1) === 0) && i + 3 < n) {
        const slot = i & DEFLATE_WINDOW_MASK;
        const h1 = hash3(data, i);
        prev1[slot] = head1[h1];
        head1[h1] = i;
        const h4 = hash4(data, i);
        prev4[slot] = head4[h4];
        head4[h4] = i;
      }
      continue;
    }

    // 3) Verified interior of any 258-byte dominant match at prevOnly258Dist: O(1) skip!
    if (
      prevOnly258Streak >= 4 &&
      rem >= 260 &&
      i >= prevOnly258Dist &&
      data[i + 257] === data[i - prevOnly258Dist + 257] &&
      data[i + 258] === data[i - prevOnly258Dist + 258] &&
      data[i + 259] === data[i - prevOnly258Dist + 259]
    ) {
      offsets[p] = -(prevOnly258Dist + 2);
      prevOnly258Streak++;
      if ((n <= 1_200_000 || (i & 1) === 0) && i + 2 < n && !(runBehind >= 4 && si >= 260)) {
        const slot = i & DEFLATE_WINDOW_MASK;
        const h1 = hash3(data, i);
        prev1[slot] = head1[h1];
        head1[h1] = i;
        if (si < 4 && i + 3 < n) {
          const h4 = hash4(data, i);
          prev4[slot] = head4[h4];
          head4[h4] = i;
        } else if (si >= 4 && si < 258 && i + si < n) {
          const h2 = hashSame(data[i], si, data[i + si]);
          prev2[slot] = head2[h2];
          head2[h2] = i;
        }
      }
      continue;
    }

    // 4) Deep interior of a repeated scanline region (dist = rowSize) on large streams: O(1) skip
    const sRow = sameRow !== null ? sameRow[i] : 0;
    if (
      n > 1_200_000 &&
      sameRow !== null &&
      si < 3 &&
      sBpp < 3 &&
      sRow >= 264 &&
      rem >= 264 &&
      i >= rowSize + 4 &&
      sameRow[i - 4] >= 268
    ) {
      offsets[p] = -(rowSize + 2);
      prevOnly258Dist = rowSize;
      prevOnly258Streak = 4;
      if ((i & 1) === 0 && i + 3 < n) {
        const slot = i & DEFLATE_WINDOW_MASK;
        const h1 = hash3(data, i);
        prev1[slot] = head1[h1];
        head1[h1] = i;
        const h4 = hash4(data, i);
        prev4[slot] = head4[h4];
        head4[h4] = i;
      }
      continue;
    }

    offsets[p] = pairCount;
    const startPair = pairCount;
    const maxLen = rem < DEFLATE_MAX_MATCH ? rem : DEFLATE_MAX_MATCH;

    let cachedH1 = -1;
    let cachedH4 = -1;
    if (maxLen >= 3) {
      ensureCap(64);
      let bestLen = 0;

      // Fast dist=1 check (O(1) via same[])
      if (i > 0 && data[i - 1] === data[i]) {
        const rlen = si < maxLen ? si : maxLen;
        if (rlen >= 3) {
          lens[pairCount] = rlen - 3;
          dists[pairCount] = 0; // dist - 1 = 0
          pairCount++;
          bestLen = rlen;
        }
      }

      // Fast dist=bpp check (O(1) via sameBpp[])
      if (bestLen < maxLen && sBpp >= 3) {
        const blen = sBpp < maxLen ? sBpp : maxLen;
        if (blen > bestLen) {
          // Check closer distances 2..bpp-1 before recording bpp so Pareto order stays exact
          for (let cd = 2; cd < bpp && cd <= i; cd++) {
            const cpos = i - cd;
            if (data[cpos] === data[i] && data[cpos + 1] === data[i + 1] && data[cpos + 2] === data[i + 2]) {
              let ml = 3;
              while (ml < maxLen && data[cpos + ml] === data[i + ml]) ml++;
              if (ml > bestLen) {
                lens[pairCount] = ml - 3;
                dists[pairCount] = cd - 1;
                pairCount++;
                bestLen = ml;
                if (bestLen === maxLen) break;
              }
            }
          }
          if (blen > bestLen) {
            lens[pairCount] = blen - 3;
            dists[pairCount] = bpp - 1;
            pairCount++;
            bestLen = blen;
          }
        }
      }

      if (bestLen < maxLen) {
        const minPos = i > DEFLATE_WINDOW_SIZE ? i - DEFLATE_WINDOW_SIZE : 0;
        const b0 = data[i];
        const b1 = data[i + 1];
        const b2 = data[i + 2];
        let targetEnd = bestLen >= 3 ? data[i + bestLen] : 0;
        let targetEnd1 = bestLen >= 3 ? data[i + bestLen - 1] : 0;

        // 1) 3-byte hash chain: when si < 4 && maxLen >= 4, head4 holds all 4+ byte matches,
        // so head1 is only needed until the first length>=3 match is found.
        const onlyNeed3 = si < 4 && maxLen >= 4;
        if ((!onlyNeed3 && (bestLen < si || si < 3)) || (onlyNeed3 && bestLen < 3)) {
          cachedH1 = hash3(data, i);
          let pos = head1[cachedH1];
          let steps =
            bestLen >= 128 ? 12 : bestLen >= 80 ? (chainLimit3 < 32 ? chainLimit3 : 32) : chainLimit3;
          while (pos >= minPos && steps-- > 0) {
            if (bestLen < 3) {
              if (data[pos] === b0 && data[pos + 1] === b1 && data[pos + 2] === b2) {
                let ml = 3;
                if (si >= 3) {
                  const sp = same[pos];
                  if (sp < si) ml = sp;
                  else if (sp > si) ml = si;
                  else {
                    ml = si;
                    while (ml < maxLen && data[pos + ml] === data[i + ml]) ml++;
                  }
                } else {
                  while (ml < maxLen && data[pos + ml] === data[i + ml]) ml++;
                }
                if (ml > maxLen) ml = maxLen;
                if (ml > bestLen) {
                  const d = i - pos;
                  while (pairCount > startPair && dists[pairCount - 1] >= d - 1) pairCount--;
                  ensureCap(1);
                  lens[pairCount] = ml - 3;
                  dists[pairCount] = d - 1;
                  pairCount++;
                  bestLen = ml;
                  if (bestLen === maxLen) break;
                  targetEnd = data[i + bestLen];
                  targetEnd1 = data[i + bestLen - 1];
                  if (onlyNeed3) break;
                  if (bestLen >= 128 && steps > 12) steps = 12;
                  else if (bestLen >= 80 && steps > 32) steps = 32;
                  if (si >= 3 && bestLen >= si) break;
                }
              }
            } else if (
              data[pos + bestLen] === targetEnd &&
              data[pos + bestLen - 1] === targetEnd1 &&
              data[pos] === b0 &&
              data[pos + 1] === b1 &&
              data[pos + 2] === b2
            ) {
              let ml = 3;
              if (si >= 3) {
                const sp = same[pos];
                if (sp < si) ml = sp;
                else if (sp > si) ml = si;
                else {
                  ml = si;
                  while (ml < maxLen && data[pos + ml] === data[i + ml]) ml++;
                }
              } else {
                while (ml < maxLen && data[pos + ml] === data[i + ml]) ml++;
              }
              if (ml > maxLen) ml = maxLen;
              if (ml > bestLen) {
                const d = i - pos;
                while (pairCount > startPair && dists[pairCount - 1] >= d - 1) pairCount--;
                ensureCap(1);
                lens[pairCount] = ml - 3;
                dists[pairCount] = d - 1;
                pairCount++;
                bestLen = ml;
                if (bestLen === maxLen) break;
                targetEnd = data[i + bestLen];
                targetEnd1 = data[i + bestLen - 1];
                if (bestLen >= 128 && steps > 12) steps = 12;
                else if (bestLen >= 80 && steps > 32) steps = 32;
                if (si >= 3 && bestLen >= si) break;
              }
            }
            const next = prev1[pos & DEFLATE_WINDOW_MASK];
            if (next >= pos) break;
            pos = next;
          }
        }

        // 2) 4-byte hash chain (reaches full 32KB window for 4+ byte matches with minimal collisions)
        let injectedRow = false;
        if (bestLen < maxLen && maxLen >= 4 && si < 4 && i + 3 < n) {
          const b3 = data[i + 3];
          cachedH4 = hash4(data, i);
          let pos = head4[cachedH4];
          const rowPos =
            sRow >= 3 && rowSize > 0 && rowSize <= DEFLATE_WINDOW_SIZE && i >= rowSize
              ? i - rowSize
              : -1;
          let steps =
            bestLen >= 128 ? 12 : bestLen >= 80 ? (chainLimit4 < 40 ? chainLimit4 : 40) : chainLimit4;
          while (pos >= minPos && steps-- > 0) {
            if (!injectedRow && rowPos >= 0 && pos <= rowPos) {
              injectedRow = true;
              const rml = sRow < maxLen ? sRow : maxLen;
              if (rml > bestLen) {
                while (pairCount > startPair && dists[pairCount - 1] >= rowSize - 1) pairCount--;
                ensureCap(1);
                lens[pairCount] = rml - 3;
                dists[pairCount] = rowSize - 1;
                pairCount++;
                bestLen = rml;
                if (bestLen === maxLen) break;
                targetEnd = data[i + bestLen];
                targetEnd1 = data[i + bestLen - 1];
                if (bestLen >= 128 && steps > 12) steps = 12;
                else if (bestLen >= 80 && steps > 40) steps = 40;
              }
            }
            if (
              (bestLen < 4 || (data[pos + bestLen] === targetEnd && data[pos + bestLen - 1] === targetEnd1)) &&
              data[pos] === b0 &&
              data[pos + 1] === b1 &&
              data[pos + 2] === b2 &&
              data[pos + 3] === b3
            ) {
              let ml = 4;
              while (ml < maxLen && data[pos + ml] === data[i + ml]) ml++;
              if (ml > bestLen) {
                const d = i - pos;
                while (pairCount > startPair && dists[pairCount - 1] >= d - 1) pairCount--;
                ensureCap(1);
                lens[pairCount] = ml - 3;
                dists[pairCount] = d - 1;
                pairCount++;
                bestLen = ml;
                if (bestLen === maxLen) break;
                targetEnd = data[i + bestLen];
                targetEnd1 = data[i + bestLen - 1];
                if (bestLen >= 128 && steps > 12) steps = 12;
                else if (bestLen >= 80 && steps > 40) steps = 40;
              }
            }
            const next = prev4[pos & DEFLATE_WINDOW_MASK];
            if (next >= pos) break;
            pos = next;
          }
        }

        // 3) Same-run hash chain (reaches full 32KB window for runs of >= 4 identical bytes)
        if (bestLen < maxLen && si >= 4 && si < maxLen && i + si < n) {
          const nb = data[i + si];
          let pos = head2[hashSame(b0, si, nb)];
          let steps =
            bestLen >= 128 ? 12 : bestLen >= 80 ? (chainLimit4 < 40 ? chainLimit4 : 40) : chainLimit4;
          while (pos >= minPos && steps-- > 0) {
            if (
              same[pos] === si &&
              data[pos] === b0 &&
              data[pos + si] === nb &&
              data[pos + bestLen] === targetEnd
            ) {
              let ml = si + 1;
              while (ml < maxLen && data[pos + ml] === data[i + ml]) ml++;
              if (ml > bestLen) {
                const d = i - pos;
                while (pairCount > startPair && dists[pairCount - 1] >= d - 1) pairCount--;
                ensureCap(1);
                lens[pairCount] = ml - 3;
                dists[pairCount] = d - 1;
                pairCount++;
                bestLen = ml;
                if (bestLen === maxLen) break;
                targetEnd = data[i + bestLen];
                targetEnd1 = data[i + bestLen - 1];
                if (bestLen >= 128 && steps > 12) steps = 12;
                else if (bestLen >= 80 && steps > 40) steps = 40;
              }
            }
            const next = prev2[pos & DEFLATE_WINDOW_MASK];
            if (next >= pos) break;
            pos = next;
          }
        }

        // 4) Direct PNG vertical scanline probes (r=1 via O(1) sameRow[], plus 2, 3, 4, 8 rows above)
        if (bestLen < maxLen && rowSize > 0) {
          if (!injectedRow && sRow >= 3 && rowSize <= DEFLATE_WINDOW_SIZE && i >= rowSize) {
            const rml = sRow < maxLen ? sRow : maxLen;
            if (rml > bestLen) {
              const d = rowSize;
              while (pairCount > startPair && dists[pairCount - 1] >= d - 1) pairCount--;
              ensureCap(1);
              lens[pairCount] = rml - 3;
              dists[pairCount] = d - 1;
              pairCount++;
              bestLen = rml;
              if (bestLen < maxLen) {
                targetEnd = data[i + bestLen];
                targetEnd1 = data[i + bestLen - 1];
              }
            }
          }
          if (bestLen < maxLen) {
            for (let ri = 1; ri < 5; ri++) {
              const d = VERTICAL_PROBE_ROWS[ri] * rowSize;
              if (d > DEFLATE_WINDOW_SIZE || d > i) break;
              const pos = i - d;
              if (
                (bestLen < 3 || data[pos + bestLen] === targetEnd) &&
                data[pos] === b0 &&
                data[pos + 1] === b1 &&
                data[pos + 2] === b2
              ) {
                let ml = 3;
                while (ml < maxLen && data[pos + ml] === data[i + ml]) ml++;
                if (ml > bestLen) {
                  while (pairCount > startPair && dists[pairCount - 1] >= d - 1) pairCount--;
                  ensureCap(1);
                  lens[pairCount] = ml - 3;
                  dists[pairCount] = d - 1;
                  pairCount++;
                  bestLen = ml;
                  if (bestLen === maxLen) break;
                  targetEnd = data[i + bestLen];
                  targetEnd1 = data[i + bestLen - 1];
                }
              }
            }
          }
        }
      }

      // Track consecutive positions whose dominant Pareto match is length 258 at the same distance d.
      // Once inside a verified streak (>= 4), convert to O(1) single-transition skip in DP.
      // Keep strict sole-Pareto on small 1-bpp streams to preserve closer short matches.
      if (
        pairCount > startPair &&
        lens[pairCount - 1] === 255 &&
        (pairCount === startPair + 1 ||
          (n > 1_200_000 && pairCount === startPair + 2 && lens[startPair] <= 3))
      ) {
        const d = dists[pairCount - 1] + 1;
        if (d === prevOnly258Dist) {
          prevOnly258Streak++;
        } else {
          prevOnly258Dist = d;
          prevOnly258Streak = 1;
        }
        if (
          prevOnly258Streak >= 4 &&
          rem >= 260 &&
          data[i + 258] === data[i - d + 258] &&
          data[i + 259] === data[i - d + 259]
        ) {
          pairCount = startPair;
          offsets[p] = -(d + 2);
        }
      } else {
        prevOnly258Streak = 0;
      }
    } else {
      prevOnly258Streak = 0;
    }

    // Insert position i into hash chains (unless deep inside a run)
    if (i + 2 < n && !(runBehind >= 4 && si >= 260)) {
      const slot = i & DEFLATE_WINDOW_MASK;
      const h1 = cachedH1 >= 0 ? cachedH1 : hash3(data, i);
      prev1[slot] = head1[h1];
      head1[h1] = i;
      if (si < 4 && i + 3 < n) {
        const h4 = cachedH4 >= 0 ? cachedH4 : hash4(data, i);
        prev4[slot] = head4[h4];
        head4[h4] = i;
      } else if (si >= 4 && si < 258 && i + si < n) {
        const h2 = hashSame(data[i], si, data[i + si]);
        prev2[slot] = head2[h2];
        head2[h2] = i;
      }
    }
  }
  offsets[blockLen] = pairCount;
  return { blockLen, offsets, lens, dists, pairCount };
}

interface ParsedBlock {
  lens: Uint16Array;  // 1 = literal, 3..258 = match len
  dists: Uint16Array; // 0 = literal, 1..32768 = match dist
  lits: Uint8Array;   // literal byte when lens[k] === 1
  count: number;
  llCounts: Uint32Array;
  dCounts: Uint32Array;
}

const DP_COST_SCALE = 64;
const DP_INF = 0x7fffffff;

// Forward shortest-path DP over cached Pareto matches for one block (quantized 1/64-bit Int32).
function optimalParseBlock(
  data: Uint8Array,
  blockStart: number,
  cache: BlockMatchCache,
  llCost: Float64Array,
  dCost: Float64Array,
  costsBuf: Int32Array,
  chosenLenBuf: Uint16Array,
  chosenDistBuf: Uint16Array,
  llCostInt: Int32Array,
  lenTotalCost: Int32Array,
  distSymTotalCost: Int32Array,
  exactDp = true,
): ParsedBlock {
  const N = cache.blockLen;
  const { offsets, lens, dists } = cache;

  for (let s = 0; s < 286; s++) {
    const c = llCost[s] < 20 ? llCost[s] : 20;
    const v = Math.round(c * DP_COST_SCALE);
    llCostInt[s] = v > 1 ? v : 1;
  }
  for (let l = 3; l <= 258; l++) {
    lenTotalCost[l] = llCostInt[LEN_SYM[l]] + (LEN_EXTRA_BITS[l] << 6);
  }
  for (let ds = 0; ds < 30; ds++) {
    const c = dCost[ds] < 20 ? dCost[ds] : 20;
    const v = Math.round(c * DP_COST_SCALE);
    distSymTotalCost[ds] = (v > 1 ? v : 1) + (DIST_EXTRA[ds] << 6);
  }

  let bestSmallDist = 1;
  let bestSmallDistCost = distSymTotalCost[0];
  for (let d = 2; d <= 4; d++) {
    const c = distSymTotalCost[d - 1];
    if (c < bestSmallDistCost) {
      bestSmallDistCost = c;
      bestSmallDist = d;
    }
  }
  const len258Cost = lenTotalCost[258];
  const run258Cost = len258Cost + bestSmallDistCost;

  costsBuf.fill(DP_INF, 0, N + 1);
  costsBuf[0] = 0;

  for (let p = 0; p < N; p++) {
    const baseC = costsBuf[p];
    const litByte = data[blockStart + p];
    const litC = baseC + llCostInt[litByte];
    if (litC < costsBuf[p + 1]) {
      costsBuf[p + 1] = litC;
      chosenLenBuf[p + 1] = 1;
      chosenDistBuf[p + 1] = 0;
    }

    const startK = offsets[p];
    if (startK < 0) {
      if (startK === -1) {
        const cand258 = baseC + run258Cost;
        if (cand258 < costsBuf[p + 258]) {
          costsBuf[p + 258] = cand258;
          chosenLenBuf[p + 258] = 258;
          chosenDistBuf[p + 258] = bestSmallDist;
        }
      } else {
        const sd = -startK - 2;
        const cand258 = baseC + len258Cost + distSymTotalCost[DIST_SYM[sd]];
        if (cand258 < costsBuf[p + 258]) {
          costsBuf[p + 258] = cand258;
          chosenLenBuf[p + 258] = 258;
          chosenDistBuf[p + 258] = sd;
        }
      }
      continue;
    }

    // Find endK (skip past any negative sentinels to find next valid offset)
    let endK = offsets[p + 1];
    if (endK < 0) {
      let q = p + 2;
      while (offsets[q] < 0) q++;
      endK = offsets[q];
    }

    let prevL = 2;
    for (let k = startK; k < endK; k++) {
      const curL = lens[k] + 3;
      const curD = dists[k] + 1;
      const dBase = baseC + distSymTotalCost[DIST_SYM[curD]];
      if (exactDp || curL <= 16) {
        let dst = p + prevL + 1;
        for (let L = prevL + 1; L <= curL; L++, dst++) {
          const cand = dBase + lenTotalCost[L];
          if (cand < costsBuf[dst]) {
            costsBuf[dst] = cand;
            chosenLenBuf[dst] = L;
            chosenDistBuf[dst] = curD;
          }
        }
      } else {
        let L = prevL + 1;
        let dst = p + L;
        for (; L <= 16; L++, dst++) {
          const cand = dBase + lenTotalCost[L];
          if (cand < costsBuf[dst]) {
            costsBuf[dst] = cand;
            chosenLenBuf[dst] = L;
            chosenDistBuf[dst] = curD;
          }
        }
        const lim2 = curL - 2 < 48 ? curL - 2 : 48;
        for (; L <= lim2; L += 4) {
          const cand = dBase + lenTotalCost[L];
          const d2 = p + L;
          if (cand < costsBuf[d2]) {
            costsBuf[d2] = cand;
            chosenLenBuf[d2] = L;
            chosenDistBuf[d2] = curD;
          }
        }
        const lim3 = curL - 2;
        for (; L <= lim3; L += 12) {
          const cand = dBase + lenTotalCost[L];
          const d2 = p + L;
          if (cand < costsBuf[d2]) {
            costsBuf[d2] = cand;
            chosenLenBuf[d2] = L;
            chosenDistBuf[d2] = curD;
          }
        }
        const tailStart = curL - 1 > prevL ? curL - 1 : prevL + 1;
        for (let t = tailStart; t <= curL; t++) {
          const cand = dBase + lenTotalCost[t];
          const d2 = p + t;
          if (cand < costsBuf[d2]) {
            costsBuf[d2] = cand;
            chosenLenBuf[d2] = t;
            chosenDistBuf[d2] = curD;
          }
        }
      }
      prevL = curL;
    }
  }

  // Count symbols by backtracking
  let symCount = 0;
  let pos = N;
  while (pos > 0) {
    symCount++;
    pos -= chosenLenBuf[pos];
  }

  const outLens = new Uint16Array(symCount);
  const outDists = new Uint16Array(symCount);
  const outLits = new Uint8Array(symCount);
  const llCounts = new Uint32Array(286);
  const dCounts = new Uint32Array(30);
  llCounts[256] = 1; // EOB

  pos = N;
  let idx = symCount - 1;
  while (pos > 0) {
    const l = chosenLenBuf[pos];
    const d = chosenDistBuf[pos];
    pos -= l;
    outLens[idx] = l;
    outDists[idx] = d;
    if (l === 1) {
      const b = data[blockStart + pos];
      outLits[idx] = b;
      llCounts[b]++;
    } else {
      llCounts[LEN_SYM[l]]++;
      dCounts[DIST_SYM[d]]++;
    }
    idx--;
  }

  return { lens: outLens, dists: outDists, lits: outLits, count: symCount, llCounts, dCounts };
}

function updateEntropyCosts(
  statLl: Float64Array,
  statD: Float64Array,
  llCost: Float64Array,
  dCost: Float64Array,
): void {
  let sumLl = 0;
  for (let s = 0; s < 286; s++) sumLl += statLl[s];
  if (sumLl < 1) sumLl = 1;
  const log2Ll = Math.log2(sumLl);
  for (let s = 0; s < 286; s++) {
    const c = statLl[s];
    llCost[s] = c > 0 ? Math.max(0.01, log2Ll - Math.log2(c)) : log2Ll + 0.5;
  }

  let sumD = 0;
  for (let d = 0; d < 30; d++) sumD += statD[d];
  if (sumD < 1) {
    for (let d = 0; d < 30; d++) dCost[d] = 5.0;
  } else {
    const log2D = Math.log2(sumD);
    for (let d = 0; d < 30; d++) {
      const c = statD[d];
      dCost[d] = c > 0 ? Math.max(0.01, log2D - Math.log2(c)) : log2D + 0.5;
    }
  }
}

function updateHuffmanCosts(
  llCounts: Uint32Array,
  dCounts: Uint32Array,
  llCost: Float64Array,
  dCost: Float64Array,
): void {
  const llL = new Uint8Array(286);
  const dL = new Uint8Array(30);
  computeCodeLengths(llCounts, 286, 15, llL);
  computeCodeLengths(dCounts, 30, 15, dL);
  let maxLl = 1;
  for (let s = 0; s < 286; s++) if (llL[s] > maxLl) maxLl = llL[s];
  let maxD = 1;
  for (let d = 0; d < 30; d++) if (dL[d] > maxD) maxD = dL[d];
  for (let s = 0; s < 286; s++) {
    llCost[s] = llL[s] > 0 ? llL[s] : maxLl + 1.5;
  }
  for (let d = 0; d < 30; d++) {
    dCost[d] = dL[d] > 0 ? dL[d] : maxD + 1.5;
  }
}

function writeStoredBlock(
  bw: BitWriter,
  data: Uint8Array,
  start: number,
  end: number,
  isFinal: boolean,
): void {
  let pos = start;
  while (pos < end || (start === end && pos === start)) {
    const chunkEnd = pos + 65535 < end ? pos + 65535 : end;
    const last = isFinal && chunkEnd === end;
    bw.writeBits(last ? 1 : 0, 1);
    bw.writeBits(0, 2); // BTYPE = 00 (stored)
    bw.alignToByte();
    const len = chunkEnd - pos;
    bw.writeByte(len & 0xff);
    bw.writeByte((len >>> 8) & 0xff);
    const nlen = ~len & 0xffff;
    bw.writeByte(nlen & 0xff);
    bw.writeByte((nlen >>> 8) & 0xff);
    bw.writeBytes(data, pos, chunkEnd);
    pos = chunkEnd;
    if (start === end) break;
  }
}

function writeFixedBlock(bw: BitWriter, parse: ParsedBlock, isFinal: boolean): void {
  bw.writeBits(isFinal ? 1 : 0, 1);
  bw.writeBits(1, 2); // BTYPE = 01 (fixed)
  const { lens, dists, lits, count } = parse;
  for (let i = 0; i < count; i++) {
    const l = lens[i];
    if (l === 1) {
      const b = lits[i];
      bw.writeBits(FIXED_LL_CODE[b], FIXED_LL_LEN[b]);
    } else {
      const lSym = LEN_SYM[l];
      bw.writeBits(FIXED_LL_CODE[lSym], FIXED_LL_LEN[lSym]);
      const lExt = LEN_EXTRA_BITS[l];
      if (lExt > 0) bw.writeBits(LEN_EXTRA_VAL[l], lExt);
      const d = dists[i];
      const dSym = DIST_SYM[d];
      bw.writeBits(FIXED_D_CODE[dSym], FIXED_D_LEN[dSym]);
      const dExt = DIST_EXTRA_BITS[d];
      if (dExt > 0) bw.writeBits(DIST_EXTRA_VAL[d], dExt);
    }
  }
  bw.writeBits(FIXED_LL_CODE[256], FIXED_LL_LEN[256]);
}

function writeDynamicBlock(
  bw: BitWriter,
  parse: ParsedBlock,
  plan: DynamicTreePlan,
  isFinal: boolean,
): void {
  bw.writeBits(isFinal ? 1 : 0, 1);
  bw.writeBits(2, 2); // BTYPE = 10 (dynamic)
  bw.writeBits(plan.hlit - 257, 5);
  bw.writeBits(plan.hdist - 1, 5);
  bw.writeBits(plan.hclen - 4, 4);

  for (let i = 0; i < plan.hclen; i++) {
    bw.writeBits(plan.clLengths[CL_ORDER[i]], 3);
  }

  const clCodes = new Uint16Array(19);
  buildCanonicalCodes(plan.clLengths, 19, clCodes);
  for (let i = 0; i < plan.rleCount; i++) {
    const sym = plan.rleSyms[i];
    bw.writeBits(clCodes[sym], plan.clLengths[sym]);
    if (sym === 16) bw.writeBits(plan.rleExtras[i], 2);
    else if (sym === 17) bw.writeBits(plan.rleExtras[i], 3);
    else if (sym === 18) bw.writeBits(plan.rleExtras[i], 7);
  }

  const llCodes = new Uint16Array(286);
  const dCodes = new Uint16Array(30);
  buildCanonicalCodes(plan.llLengths, 286, llCodes);
  buildCanonicalCodes(plan.dLengths, 30, dCodes);

  const { llLengths, dLengths } = plan;
  const { lens, dists, lits, count } = parse;
  for (let i = 0; i < count; i++) {
    const l = lens[i];
    if (l === 1) {
      const b = lits[i];
      bw.writeBits(llCodes[b], llLengths[b]);
    } else {
      const lSym = LEN_SYM[l];
      bw.writeBits(llCodes[lSym], llLengths[lSym]);
      const lExt = LEN_EXTRA_BITS[l];
      if (lExt > 0) bw.writeBits(LEN_EXTRA_VAL[l], lExt);
      const d = dists[i];
      const dSym = DIST_SYM[d];
      bw.writeBits(dCodes[dSym], dLengths[dSym]);
      const dExt = DIST_EXTRA_BITS[d];
      if (dExt > 0) bw.writeBits(DIST_EXTRA_VAL[d], dExt);
    }
  }
  bw.writeBits(llCodes[256], llLengths[256]);
}

function storedBlockBits(bitOffsetMod8: number, rawLen: number): number {
  const numSub = Math.max(1, Math.ceil(rawLen / 65535));
  const firstPad = (8 - ((bitOffsetMod8 + 3) & 7)) & 7;
  // Subsequent stored sub-blocks start byte-aligned, so 3 header bits + 5 pad bits = 8 bits
  return 3 + firstPad + 32 + (numSub - 1) * 40 + rawLen * 8;
}

export function zopfliDeflateZlib(
  data: Uint8Array,
  iterations = 4,
  maxBlocks = 32,
  chainLimit3 = 96,
  chainLimit4 = 256,
  rowSize = 0,
  bpp = 1,
): Uint8Array {
  const n = data.length;
  const same = computeSameArray(data);
  const sameBpp = bpp >= 2 ? computeDistMatchArray(data, bpp) : null;
  const sameRow = rowSize > 0 && rowSize <= DEFLATE_WINDOW_SIZE ? computeDistMatchArray(data, rowSize) : null;
  const lazy = runLazyLz77(data, same, 8);
  const bounds = splitLz77Blocks(lazy, n, maxBlocks, 768 * 1024);
  const numBlocks = bounds.length - 1;

  const hash = new SlidingHashState();
  let maxBlockLen = 0;
  for (let b = 0; b < numBlocks; b++) {
    const bl = bounds[b + 1] - bounds[b];
    if (bl > maxBlockLen) maxBlockLen = bl;
  }

  const costsBuf = new Int32Array(maxBlockLen + 1);
  const chosenLenBuf = new Uint16Array(maxBlockLen + 1);
  const chosenDistBuf = new Uint16Array(maxBlockLen + 1);
  const llCostInt = new Int32Array(286);
  const lenTotalCost = new Int32Array(259);
  const distSymTotalCost = new Int32Array(30);
  const statLl = new Float64Array(286);
  const statD = new Float64Array(30);
  const llCost = new Float64Array(286);
  const dCost = new Float64Array(30);

  let lazyIdx = 0;
  const parsedBlocks: ParsedBlock[] = [];
  let totalParsedSyms = 0;

  for (let b = 0; b < numBlocks; b++) {
    const bStart = bounds[b];
    const bEnd = bounds[b + 1];

    // Initial stats for this block from the lazy LZ77 pass
    statLl.fill(0);
    statD.fill(0);
    while (lazyIdx < lazy.count && lazy.symPos[lazyIdx] < bStart) lazyIdx++;
    while (lazyIdx < lazy.count && lazy.symPos[lazyIdx] < bEnd) {
      statLl[lazy.symLl[lazyIdx]]++;
      const d = lazy.symD[lazyIdx];
      if (d !== 255) statD[d]++;
      lazyIdx++;
    }
    statLl[256] = 1;
    updateEntropyCosts(statLl, statD, llCost, dCost);

    const cache = buildBlockMatchCache(
      data,
      same,
      sameBpp,
      bpp,
      sameRow,
      hash,
      bStart,
      bEnd,
      chainLimit3,
      chainLimit4,
      rowSize,
    );

    let bestParse: ParsedBlock | null = null;
    let bestBits = Infinity;
    let usedHuffmanLast = false;
    let noImprove = 0;

    for (let it = 0; it < iterations; it++) {
      const exactDp = usedHuffmanLast || it + 1 === iterations;
      const parsed = optimalParseBlock(
        data,
        bStart,
        cache,
        llCost,
        dCost,
        costsBuf,
        chosenLenBuf,
        chosenDistBuf,
        llCostInt,
        lenTotalCost,
        distSymTotalCost,
        exactDp,
      );

      const dynBits = 3 + computeDynamicTreeBitsOnly(parsed.llCounts, parsed.dCounts, true);
      const fixBits = 3 + computeDataBits(parsed.llCounts, parsed.dCounts, FIXED_LL_LEN, FIXED_D_LEN);
      const candBits = dynBits < fixBits ? dynBits : fixBits;

      const prevBest = bestBits;
      let improvedBest = false;
      if (candBits < bestBits) {
        bestBits = candBits;
        bestParse = parsed;
        improvedBest = true;
      }

      const gainRatio = n <= 1_200_000 ? 0.00015 : 0.00025;
      const minGain =
        prevBest < Infinity
          ? Math.max(n <= 1_200_000 ? 8 : 16, Math.floor(prevBest * gainRatio))
          : 1;
      const sigImprove = prevBest - bestBits >= minGain;
      if (it >= 1) {
        if (sigImprove) noImprove = 0;
        else noImprove++;
      }

      if (it + 1 < iterations) {
        if (usedHuffmanLast) break;

        if (
          (it + 2 === iterations || noImprove >= 1 || parsed.count <= 256) &&
          bestParse !== null
        ) {
          updateHuffmanCosts(bestParse.llCounts, bestParse.dCounts, llCost, dCost);
          usedHuffmanLast = true;
        } else if (it === 0) {
          for (let s = 0; s < 286; s++) statLl[s] = parsed.llCounts[s];
          for (let d = 0; d < 30; d++) statD[d] = parsed.dCounts[d];
          updateEntropyCosts(statLl, statD, llCost, dCost);
        } else {
          const wNew = improvedBest ? 1.0 : 0.5;
          const wOld = 1.0 - wNew;
          for (let s = 0; s < 286; s++) statLl[s] = wOld * statLl[s] + wNew * parsed.llCounts[s];
          for (let d = 0; d < 30; d++) statD[d] = wOld * statD[d] + wNew * parsed.dCounts[d];
          updateEntropyCosts(statLl, statD, llCost, dCost);
        }
      }
    }

    const chosen = bestParse as ParsedBlock;
    parsedBlocks.push(chosen);
    totalParsedSyms += chosen.count;
  }

  // Post-optimal block refinement: flatten optimal symbols, split sub-blocks, merge redundant adjacent blocks.
  const fullLens = new Uint16Array(totalParsedSyms);
  const fullDists = new Uint16Array(totalParsedSyms);
  const fullLits = new Uint8Array(totalParsedSyms);
  const fullSymLl = new Uint16Array(totalParsedSyms);
  const fullSymD = new Uint8Array(totalParsedSyms);
  const fullBytePos = new Int32Array(totalParsedSyms + 1);
  const initSymSplits: number[] = [0];

  let outOff = 0;
  let byteOff = 0;
  for (let b = 0; b < parsedBlocks.length; b++) {
    const pb = parsedBlocks[b];
    const cnt = pb.count;
    fullLens.set(pb.lens, outOff);
    fullDists.set(pb.dists, outOff);
    fullLits.set(pb.lits, outOff);
    for (let k = 0; k < cnt; k++) {
      fullBytePos[outOff + k] = byteOff;
      const l = pb.lens[k];
      if (l === 1) {
        fullSymLl[outOff + k] = pb.lits[k];
        fullSymD[outOff + k] = 255;
      } else {
        fullSymLl[outOff + k] = LEN_SYM[l];
        fullSymD[outOff + k] = DIST_SYM[pb.dists[k]];
      }
      byteOff += l;
    }
    outOff += cnt;
    initSymSplits.push(outOff);
  }
  fullBytePos[totalParsedSyms] = n;

  // Step A: Fast post-parse sub-block splitting on exact optimal symbols
  const refinedSplits = splitSymbolStream(
    fullSymLl,
    fullSymD,
    totalParsedSyms,
    Math.min(64, maxBlocks * 2),
    256,
    0,
    false,
    initSymSplits,
  );

  // Step B: Cached adjacent block merging using exact RLE-opt dynamic + fixed cost
  const segLl = new Uint32Array(286);
  const segD = new Uint32Array(30);
  const segCost = (a: number, b: number): number => {
    segLl.fill(0);
    segD.fill(0);
    for (let i = a; i < b; i++) {
      segLl[fullSymLl[i]]++;
      const d = fullSymD[i];
      if (d !== 255) segD[d]++;
    }
    segLl[256] = 1;
    const dyn = 3 + computeDynamicTreeBitsOnly(segLl, segD, true);
    const fix = 3 + computeDataBits(segLl, segD, FIXED_LL_LEN, FIXED_D_LEN);
    return dyn < fix ? dyn : fix;
  };

  const blockCosts: number[] = [];
  for (let i = 0; i < refinedSplits.length - 1; i++) {
    blockCosts.push(segCost(refinedSplits[i], refinedSplits[i + 1]));
  }

  let idxMerge = 0;
  while (idxMerge < blockCosts.length - 1) {
    const a = refinedSplits[idxMerge];
    const b = refinedSplits[idxMerge + 2];
    const combined = segCost(a, b);
    if (combined <= blockCosts[idxMerge] + blockCosts[idxMerge + 1]) {
      refinedSplits.splice(idxMerge + 1, 1);
      blockCosts[idxMerge] = combined;
      blockCosts.splice(idxMerge + 1, 1);
      if (idxMerge > 0) idxMerge--;
    } else {
      idxMerge++;
    }
  }

  // Step C: Local boundary re-centering for each internal split point
  if (refinedSplits.length > 2) {
    const cLeftLl = new Uint32Array(286);
    const cLeftD = new Uint32Array(30);
    const cRightLl = new Uint32Array(286);
    const cRightD = new Uint32Array(30);
    const cTotalLl = new Uint32Array(286);
    const cTotalD = new Uint32Array(30);
    const NP = 7;
    const cSubLl = Array.from({ length: NP + 1 }, () => new Uint32Array(286));
    const cSubD = Array.from({ length: NP + 1 }, () => new Uint32Array(30));
    const cPts = new Int32Array(NP + 2);

    const fastCostOf = (ll: Uint32Array, d: Uint32Array): number => {
      ll[256] = 1;
      const dyn = computeDynamicTreeBitsFast(ll, d);
      const fix = computeDataBits(ll, d, FIXED_LL_LEN, FIXED_D_LEN);
      ll[256] = 0;
      return (dyn < fix ? dyn : fix) + 3;
    };

    for (let bi = 1; bi < refinedSplits.length - 1; bi++) {
      const l = refinedSplits[bi - 1];
      const curM = refinedSplits[bi];
      const r = refinedSplits[bi + 1];
      if (r - l < 64) continue;

      cTotalLl.fill(0);
      cTotalD.fill(0);
      for (let i = l; i < r; i++) {
        cTotalLl[fullSymLl[i]]++;
        const d = fullSymD[i];
        if (d !== 255) cTotalD[d]++;
      }

      let lo = l;
      let hi = r;
      let bestM = curM;
      let bestPairFast = Infinity;

      for (let round = 0; round < 4; round++) {
        if (hi - lo < 16) break;
        cPts[0] = lo;
        for (let k = 1; k <= NP; k++) {
          cPts[k] = lo + Math.floor(((hi - lo) * k) / (NP + 1));
        }
        cPts[NP + 1] = hi;

        cLeftLl.fill(0);
        cLeftD.fill(0);
        for (let i = l; i < lo; i++) {
          cLeftLl[fullSymLl[i]]++;
          const d = fullSymD[i];
          if (d !== 255) cLeftD[d]++;
        }
        for (let k = 0; k <= NP; k++) {
          const sLl = cSubLl[k];
          const sD = cSubD[k];
          sLl.fill(0);
          sD.fill(0);
          const a = cPts[k];
          const b = cPts[k + 1];
          for (let i = a; i < b; i++) {
            sLl[fullSymLl[i]]++;
            const d = fullSymD[i];
            if (d !== 255) sD[d]++;
          }
        }

        let rBestIdx = 1;
        let rBestC = Infinity;
        for (let k = 1; k <= NP; k++) {
          const aLl = cSubLl[k - 1];
          const aD = cSubD[k - 1];
          for (let s = 0; s < 286; s++) {
            cLeftLl[s] += aLl[s];
            cRightLl[s] = cTotalLl[s] - cLeftLl[s];
          }
          for (let d = 0; d < 30; d++) {
            cLeftD[d] += aD[d];
            cRightD[d] = cTotalD[d] - cLeftD[d];
          }
          const c = fastCostOf(cLeftLl, cLeftD) + fastCostOf(cRightLl, cRightD);
          if (c < rBestC) {
            rBestC = c;
            rBestIdx = k;
          }
          if (c < bestPairFast) {
            bestPairFast = c;
            bestM = cPts[k];
          }
        }
        lo = cPts[rBestIdx - 1];
        hi = cPts[rBestIdx + 1];
      }

      if (bestM > l && bestM < r && bestM !== curM) {
        const newLeft = segCost(l, bestM);
        const newRight = segCost(bestM, r);
        if (newLeft + newRight < blockCosts[bi - 1] + blockCosts[bi]) {
          refinedSplits[bi] = bestM;
          blockCosts[bi - 1] = newLeft;
          blockCosts[bi] = newRight;
        }
      }
    }
  }

  // Emit final zlib stream
  const bw = new BitWriter(Math.max(4096, n >>> 2));
  bw.writeByte(0x78);
  bw.writeByte(0xda);

  const finalBlocks = refinedSplits.length - 1;
  for (let b = 0; b < finalBlocks; b++) {
    const sStart = refinedSplits[b];
    const sEnd = refinedSplits[b + 1];
    const bStart = fullBytePos[sStart];
    const bEnd = fullBytePos[sEnd];
    const isFinal = b === finalBlocks - 1;

    const llCounts = new Uint32Array(286);
    const dCounts = new Uint32Array(30);
    llCounts[256] = 1;
    for (let i = sStart; i < sEnd; i++) {
      llCounts[fullSymLl[i]]++;
      const d = fullSymD[i];
      if (d !== 255) dCounts[d]++;
    }

    const subParse: ParsedBlock = {
      lens: fullLens.subarray(sStart, sEnd),
      dists: fullDists.subarray(sStart, sEnd),
      lits: fullLits.subarray(sStart, sEnd),
      count: sEnd - sStart,
      llCounts,
      dCounts,
    };

    const plan = buildBestDynamicTreePlan(llCounts, dCounts);
    const dynBits = 3 + plan.totalBits;
    const fixBits = 3 + computeDataBits(llCounts, dCounts, FIXED_LL_LEN, FIXED_D_LEN);
    const stoBits = storedBlockBits(bw.bitCount, bEnd - bStart);

    if (stoBits <= dynBits && stoBits <= fixBits) {
      writeStoredBlock(bw, data, bStart, bEnd, isFinal);
    } else if (fixBits < dynBits) {
      writeFixedBlock(bw, subParse, isFinal);
    } else {
      writeDynamicBlock(bw, subParse, plan, isFinal);
    }
  }

  bw.alignToByte();
  const checksum = adler32(data);
  bw.writeByte((checksum >>> 24) & 0xff);
  bw.writeByte((checksum >>> 16) & 0xff);
  bw.writeByte((checksum >>> 8) & 0xff);
  bw.writeByte(checksum & 0xff);
  return bw.finish();
}

function buildPaletteSamples(
  rgba: Uint8Array,
  orderedColors: readonly number[],
): { samples: Uint8Array; plte: Uint8Array; trns: Uint8Array | null } {
  const entries = orderedColors.length;
  const colorToIndex = new Map<number, number>();
  const plte = new Uint8Array(entries * 3);
  let lastTransparentIdx = -1;

  for (let i = 0; i < entries; i++) {
    const c = orderedColors[i];
    colorToIndex.set(c, i);
    plte[i * 3] = (c >>> 24) & 0xff;
    plte[i * 3 + 1] = (c >>> 16) & 0xff;
    plte[i * 3 + 2] = (c >>> 8) & 0xff;
    if ((c & 0xff) < 255) {
      lastTransparentIdx = i;
    }
  }

  let trns: Uint8Array | null = null;
  if (lastTransparentIdx >= 0) {
    trns = new Uint8Array(lastTransparentIdx + 1);
    for (let i = 0; i <= lastTransparentIdx; i++) {
      trns[i] = orderedColors[i] & 0xff;
    }
  }

  const pixelCount = rgba.length >>> 2;
  const samples = new Uint8Array(pixelCount);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    const key = (((rgba[i] << 24) | (rgba[i + 1] << 16) | (rgba[i + 2] << 8) | rgba[i + 3]) >>> 0);
    samples[p] = colorToIndex.get(key) as number;
  }

  return { samples, plte, trns };
}

function luminanceKey(c: number): number {
  const r = (c >>> 24) & 0xff;
  const g = (c >>> 16) & 0xff;
  const b = (c >>> 8) & 0xff;
  return 299 * r + 587 * g + 114 * b;
}

function bruteFilterGrey(
  samples: Uint8Array,
  width: number,
  height: number,
  switchPenaltyBytes: number,
): Uint8Array {
  const stride = width;
  const rs = stride + 1;
  const raw = new Uint8Array(height * rs);
  const trial = Array.from({ length: 5 }, (_, t) => {
    const a = new Uint8Array(rs);
    a[0] = t;
    return a;
  });
  let prevF = -1;
  for (let y = 0; y < height; y++) {
    const at = y * rs;
    const before = raw.subarray(at > 32768 ? at - 32768 : 0, at);
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? samples.subarray((y - 1) * stride, y * stride) : null;
    let bestF = 0;
    let bestCost = Infinity;
    for (let f = 0; f < 5; f++) {
      filterRow(f, cur, prev, 1, trial[f].subarray(1));
      const c = deflateSync(
        trial[f],
        before.length > 0
          ? { level: 4, memLevel: 8, dictionary: before }
          : { level: 4, memLevel: 8 },
      );
      const cost = c.length + (prevF >= 0 && f !== prevF ? switchPenaltyBytes : 0);
      if (cost < bestCost) {
        bestCost = cost;
        bestF = f;
      }
    }
    raw.set(trial[bestF], at);
    prevF = bestF;
  }
  return raw;
}

export function squeezePng(inputBytes: Uint8Array): { png: Uint8Array; label: string; width: number; height: number } {
  const decoded = decodePng(inputBytes);
  const { width, height, rgba } = decoded;
  const pixelCount = width * height;
  const analysis = analyzeImage(rgba);

  const forms: ColorForm[] = [];

  // Candidate A: Minimal exact direct-color representation (Grey 0, GreyA 4, RGB 2, or RGBA 6),
  // preserving every pixel's exact R, G, B, A channels (including RGB of fully transparent pixels).
  // Skip multi-bpp direct forms on large palette-eligible images (<=256 colors), where 1-bpp PLTE always wins.
  const canPalette =
    analysis.paletteMap !== null && analysis.paletteMap.size > 0 && analysis.paletteMap.size <= 256;
  if (analysis.allGrey) {
    if (analysis.allOpaque || analysis.canSingleTrnsGrey) {
      const grey = new Uint8Array(pixelCount);
      for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
        grey[p] = rgba[i];
      }
      const extra: Chunk[] = analysis.canSingleTrnsGrey
        ? [{ type: 'tRNS', data: Uint8Array.of(0, analysis.singleTrnsGrey) }]
        : [];
      forms.push({
        colorType: 0,
        samples: grey,
        extraChunks: extra,
        labelPrefix: analysis.canSingleTrnsGrey ? 'GREY+tRNS' : 'GREY',
      });
    } else if (!canPalette || pixelCount < 16384) {
      const greyAlpha = new Uint8Array(pixelCount * 2);
      for (let i = 0, d = 0; i < rgba.length; i += 4, d += 2) {
        greyAlpha[d] = rgba[i];
        greyAlpha[d + 1] = rgba[i + 3];
      }
      forms.push({
        colorType: 4,
        samples: greyAlpha,
        extraChunks: [],
        labelPrefix: 'GREYA',
      });
    }
  } else if (!canPalette || pixelCount < 16384) {
    if (analysis.allOpaque || analysis.canSingleTrnsRgb) {
      const rgb = new Uint8Array(pixelCount * 3);
      for (let i = 0, d = 0; i < rgba.length; i += 4, d += 3) {
        rgb[d] = rgba[i];
        rgb[d + 1] = rgba[i + 1];
        rgb[d + 2] = rgba[i + 2];
      }
      const extra: Chunk[] = analysis.canSingleTrnsRgb
        ? [
            {
              type: 'tRNS',
              data: Uint8Array.of(
                0,
                analysis.singleTrnsRgb[0],
                0,
                analysis.singleTrnsRgb[1],
                0,
                analysis.singleTrnsRgb[2],
              ),
            },
          ]
        : [];
      forms.push({
        colorType: 2,
        samples: rgb,
        extraChunks: extra,
        labelPrefix: analysis.canSingleTrnsRgb ? 'RGB+tRNS' : 'RGB',
      });
    } else {
      forms.push({
        colorType: 6,
        samples: rgba,
        extraChunks: [],
        labelPrefix: 'RGBA',
      });
    }
  }

  // Candidate B: Indexed palette (color type 3) when unique RGBA colors <= 256
  // Skip palette on opaque/single-tRNS greyscale with >16 colors (1-bpp GREY has 0 PLTE overhead).
  const skipPalForGrey =
    analysis.allGrey &&
    (analysis.allOpaque || analysis.canSingleTrnsGrey) &&
    analysis.paletteMap !== null &&
    analysis.paletteMap.size > 16;
  if (
    !skipPalForGrey &&
    analysis.paletteMap !== null &&
    analysis.paletteMap.size > 0 &&
    analysis.paletteMap.size <= 256
  ) {
    const entries = Array.from(analysis.paletteMap.entries()); // [rgbaUint32, freq]
    const transEntries = entries.filter(([c]) => (c & 0xff) < 255);
    const opaqueEntries = entries.filter(([c]) => (c & 0xff) === 255);

    // Ordering 1: non-opaque first, then opaque; each group sorted by frequency descending
    const byFreq = [
      ...transEntries.slice().sort((a, b) => b[1] - a[1] || a[0] - b[0]),
      ...opaqueEntries.slice().sort((a, b) => b[1] - a[1] || a[0] - b[0]),
    ].map(([c]) => c);

    // Ordering 2: non-opaque first, then opaque; each group sorted by luminance ascending
    const byLuma = [
      ...transEntries.slice().sort((a, b) => luminanceKey(a[0]) - luminanceKey(b[0]) || a[0] - b[0]),
      ...opaqueEntries.slice().sort((a, b) => luminanceKey(a[0]) - luminanceKey(b[0]) || a[0] - b[0]),
    ].map(([c]) => c);

    const orderings: { name: string; colors: number[] }[] = [
      { name: 'PAL-freq', colors: byFreq },
      { name: 'PAL-luma', colors: byLuma },
    ];

    for (const ordering of orderings) {
      const { samples, plte, trns } = buildPaletteSamples(rgba, ordering.colors);
      const extra: Chunk[] = [{ type: 'PLTE', data: plte }];
      if (trns !== null) {
        extra.push({ type: 'tRNS', data: trns });
      }
      forms.push({
        colorType: 3,
        samples,
        extraChunks: extra,
        labelPrefix: ordering.name,
      });
    }
  }

  // Stage 1: Screen all color forms and deduplicated filter plans at level 3
  const screenedForms = forms.map((form) =>
    screenColorForm(width, height, form, form.labelPrefix === 'PAL-freq' ? [0, 1, 2] : FILTER_MODES),
  );
  screenedForms.sort((a, b) => a.bestTotalBytes - b.bestTotalBytes);
  const bestScreenedBytes = screenedForms[0].bestTotalBytes;

  // Stage 2: Fast level-7 compression across DEFAULT/FILTERED on close top filter plans
  // of each competitive color form (optimal DEFLATE in Stage 3 provides final compression).
  let bestForm = screenedForms[0].form;
  let bestIdat = screenedForms[0].plans[0].idat;
  let bestTotalBytes = screenedForms[0].plans[0].totalBytes;
  let bestMode: FilterMode = screenedForms[0].plans[0].mode;
  let bestStrategy = zlibConstants.Z_DEFAULT_STRATEGY;
  let bestMemLevel = 8;
  let bestFiltered = screenedForms[0].plans[0].filtered;

  const stage2Strategies = [zlibConstants.Z_DEFAULT_STRATEGY, zlibConstants.Z_FILTERED];
  for (const sf of screenedForms) {
    if (sf.bestTotalBytes > bestScreenedBytes * 1.15) continue;
    const overhead = extraChunksOverhead(sf.form.extraChunks);
    const topBytes = sf.plans[0].totalBytes;
    const finalists =
      sf.plans.length > 1 && sf.plans[1].totalBytes <= topBytes * 1.025
        ? sf.plans.slice(0, 2)
        : sf.plans.slice(0, 1);

    for (const entry of finalists) {
      for (const strategy of stage2Strategies) {
        const compressed = deflateSync(entry.filtered, {
          level: 6,
          strategy,
          memLevel: 8,
          chunkSize: 64 * 1024,
        });
        const totalBytes = compressed.length + overhead;
        if (totalBytes < bestTotalBytes) {
          bestForm = sf.form;
          bestIdat = new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.length);
          bestTotalBytes = totalBytes;
          bestMode = entry.mode;
          bestStrategy = strategy;
          bestMemLevel = 8;
          bestFiltered = entry.filtered;
        }
      }
    }
  }

  // Stage 2b: For high-entropy 1-bpp greyscale, also try hysteresis per-row zlib brute filter (~300ms)
  if (bestForm.colorType === 0 && bestTotalBytes > 50_000) {
    const bruteRaw = bruteFilterGrey(bestForm.samples, width, height, 3);
    const overhead = extraChunksOverhead(bestForm.extraChunks);
    for (const strategy of stage2Strategies) {
      const compressed = deflateSync(bruteRaw, {
        level: 6,
        strategy,
        memLevel: 8,
        chunkSize: 64 * 1024,
      });
      const totalBytes = compressed.length + overhead;
      if (totalBytes < bestTotalBytes) {
        bestIdat = new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.length);
        bestTotalBytes = totalBytes;
        bestMode = 'brute-grey';
        bestStrategy = strategy;
        bestFiltered = bruteRaw;
      }
    }
  }

  // Stage 3: Pure-TS optimal DEFLATE on the single best candidate
  const refinedOverhead = extraChunksOverhead(bestForm.extraChunks);
  let deflateTag = `s=${bestStrategy},m=${bestMemLevel}`;
  const bestBpp = CHANNELS_BY_COLOR_TYPE[bestForm.colorType];
  const bestRowSize = width * bestBpp + 1;
  // Work-based deterministic budget scaled by filtered stream length:
  // smaller (1-bpp PAL/GREY) streams run deeper match chains; early-exit skips converged blocks.
  const streamLen = bestFiltered.length;
  const zIters = streamLen <= 1_200_000 ? 10 : streamLen <= 3_000_000 ? 16 : 12;
  const zMaxBlocks = streamLen <= 1_200_000 ? 26 : streamLen <= 3_000_000 ? 28 : 22;
  const zChain3 = streamLen <= 1_200_000 ? 96 : streamLen <= 3_000_000 ? 56 : 40;
  const zChain4 = streamLen <= 1_200_000 ? 320 : streamLen <= 3_000_000 ? 176 : 136;
  const zopfliIdat = zopfliDeflateZlib(
    bestFiltered,
    zIters,
    zMaxBlocks,
    zChain3,
    zChain4,
    bestRowSize,
    bestBpp,
  );
  if (zopfliIdat.length + refinedOverhead < bestTotalBytes) {
    bestIdat = zopfliIdat;
    bestTotalBytes = zopfliIdat.length + refinedOverhead;
    deflateTag = 'opt-deflate';
  }

  const png = packPng(width, height, bestForm, bestIdat);
  const label = `${bestForm.labelPrefix}(ct=${bestForm.colorType},f=${bestMode},${deflateTag})`;
  return { png, label, width, height };
}

function run(): void {
  const inputRoot = process.argv[2] ?? process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outputRoot = process.argv[3] ?? process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

  const dirents = readdirSync(inputRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const tasks: { id: string; inPath: string; outDir: string; outPath: string }[] = [];

  for (const id of dirents) {
    const inPath = join(inputRoot, id, 'image.png');
    if (existsSync(inPath)) {
      const outDir = join(outputRoot, id);
      tasks.push({ id, inPath, outDir, outPath: join(outDir, 'image.png') });
    }
  }

  if (tasks.length === 0) {
    const directIn = join(inputRoot, 'image.png');
    if (existsSync(directIn)) {
      tasks.push({
        id: '.',
        inPath: directIn,
        outDir: outputRoot,
        outPath: join(outputRoot, 'image.png'),
      });
    }
  }

  let totalIn = 0;
  let totalOut = 0;

  for (const task of tasks) {
    const inputBytes = new Uint8Array(readFileSync(task.inPath));
    const result = squeezePng(inputBytes);
    mkdirSync(task.outDir, { recursive: true });
    writeFileSync(task.outPath, result.png);

    totalIn += inputBytes.length;
    totalOut += result.png.length;
    const pct = ((100 * result.png.length) / inputBytes.length).toFixed(2);
    console.log(
      `${task.id}: ${inputBytes.length} -> ${result.png.length} bytes (${pct}%) [${result.label}]`,
    );
  }

  if (tasks.length > 0) {
    const totalPct = ((100 * totalOut) / totalIn).toFixed(2);
    console.log(`TOTAL (${tasks.length} images): ${totalIn} -> ${totalOut} bytes (${totalPct}%)`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  run();
}
