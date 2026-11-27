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
  | 'viterbi-tri-256';

const FILTER_MODES: readonly FilterMode[] = [
  0,
  1,
  2,
  3,
  4,
  'viterbi-abs-8',
  'viterbi-abs-16',
  'viterbi-abs-24',
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
      level: 6,
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

export function squeezePng(inputBytes: Uint8Array): { png: Uint8Array; label: string; width: number; height: number } {
  const decoded = decodePng(inputBytes);
  const { width, height, rgba } = decoded;
  const pixelCount = width * height;
  const analysis = analyzeImage(rgba);

  const forms: ColorForm[] = [];

  // Candidate A: Minimal exact direct-color representation (Grey 0, GreyA 4, RGB 2, or RGBA 6),
  // preserving every pixel's exact R, G, B, A channels (including RGB of fully transparent pixels).
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
    } else {
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
  } else if (analysis.allOpaque || analysis.canSingleTrnsRgb) {
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

  // Candidate B: Indexed palette (color type 3) when unique RGBA colors <= 256
  if (analysis.paletteMap !== null && analysis.paletteMap.size > 0 && analysis.paletteMap.size <= 256) {
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

  // Stage 1: Screen all color forms and deduplicated filter plans at level 6
  const screenedForms = forms.map((form) => screenColorForm(width, height, form, FILTER_MODES));
  screenedForms.sort((a, b) => a.bestTotalBytes - b.bestTotalBytes);
  const bestScreenedBytes = screenedForms[0].bestTotalBytes;

  // Stage 2: Full level-9 compression (memLevel 8) across DEFAULT/FILTERED/RLE
  // on top 2 filter plans of each competitive color form.
  let bestForm = screenedForms[0].form;
  let bestIdat = screenedForms[0].plans[0].idat;
  let bestTotalBytes = screenedForms[0].plans[0].totalBytes;
  let bestMode: FilterMode = screenedForms[0].plans[0].mode;
  let bestStrategy = zlibConstants.Z_DEFAULT_STRATEGY;
  let bestMemLevel = 8;
  let bestFiltered = screenedForms[0].plans[0].filtered;

  for (const sf of screenedForms) {
    if (sf.bestTotalBytes > bestScreenedBytes * 1.25) continue;
    const overhead = extraChunksOverhead(sf.form.extraChunks);
    const finalists = sf.plans.slice(0, 2);

    for (const entry of finalists) {
      for (const strategy of ZLIB_STRATEGIES) {
        const compressed = deflateSync(entry.filtered, {
          level: 9,
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

  // Stage 3: Refine ONLY the single best candidate with memLevel 9
  const refined = deflateSync(bestFiltered, {
    level: 9,
    strategy: bestStrategy,
    memLevel: 9,
    chunkSize: 64 * 1024,
  });
  const refinedOverhead = extraChunksOverhead(bestForm.extraChunks);
  if (refined.length + refinedOverhead < bestTotalBytes) {
    bestIdat = new Uint8Array(refined.buffer, refined.byteOffset, refined.length);
    bestMemLevel = 9;
  }

  const png = packPng(width, height, bestForm, bestIdat);
  const label = `${bestForm.labelPrefix}(ct=${bestForm.colorType},f=${bestMode},s=${bestStrategy},m=${bestMemLevel})`;
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
