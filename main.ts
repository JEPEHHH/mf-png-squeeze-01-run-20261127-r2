// Lossless PNG re-encoder for the png-squeeze bounty.
// Reads each stored RGBA screenshot, then tries several colour models and
// filter/heuristic combinations and writes the smallest valid PNG.
import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  deflateSync, inflateSync, constants as zc,
} from 'node:zlib';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const BPP: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const STRATS = [zc.Z_DEFAULT_STRATEGY, zc.Z_FILTERED, zc.Z_HUFFMAN_ONLY, zc.Z_RLE, zc.Z_FIXED];
type Heuristic = 0 | 1 | 2 | 3 | 4 | 'sum' | 'distinct' | 'entropy';
const HEURISTICS: Heuristic[] = [0, 1, 2, 3, 4, 'sum', 'distinct', 'entropy'];

const CRCT = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc(buf: Uint8Array, from: number, to: number): number {
  let c = 0xffffffff;
  for (let i = from; i < to; i++) c = CRCT[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function be32(buf: Uint8Array, off: number): number {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

function put32(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v >>> 24; buf[off + 1] = v >>> 16; buf[off + 2] = v >>> 8; buf[off + 3] = v;
}

function predictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

interface Chunk { type: string; data: Uint8Array }

class PngReader {
  w = 0; h = 0; depth = 0; color = -1;
  palette: Uint8Array | null = null;
  transparency: Uint8Array | null = null;
  idat: Uint8Array[] = [];
  pixels = new Uint8Array(0);

  constructor(bytes: Uint8Array) {
    if (bytes.length < 8 || !SIG.equals(Buffer.from(bytes.buffer, bytes.byteOffset, 8)))
      throw new Error('bad signature');
    let p = 8, gotHeader = false, gotEnd = false;
    while (p + 12 <= bytes.length) {
      const len = be32(bytes, p);
      if (len > 0x7fffffff || p + 12 + len > bytes.length) throw new Error('bad chunk length');
      const tag = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
      if (crc(bytes, p + 4, p + 8 + len) !== be32(bytes, p + 8 + len)) throw new Error('bad CRC: ' + tag);
      const body = bytes.subarray(p + 8, p + 8 + len);
      p += 12 + len;
      if (!gotHeader && tag !== 'IHDR') throw new Error('IHDR must come first');
      if (tag === 'IHDR') {
        if (gotHeader || len !== 13) throw new Error('IHDR');
        this.w = be32(body, 0); this.h = be32(body, 4);
        this.depth = body[8]; this.color = body[9];
        if (!this.w || !this.h || this.depth !== 8 || !(this.color in BPP))
          throw new Error('unsupported header');
        if (body[10] || body[11] || body[12]) throw new Error('unsupported mode');
        gotHeader = true;
      } else if (tag === 'PLTE') this.palette = body;
      else if (tag === 'tRNS') this.transparency = body;
      else if (tag === 'IDAT') this.idat.push(body);
      else if (tag === 'IEND') { gotEnd = true; break; }
    }
    if (!gotHeader || !gotEnd || !this.idat.length) throw new Error('incomplete PNG');
    this.expand(inflateSync(Buffer.concat(this.idat.map((c) => Buffer.from(c)))));
  }

  expand(raw: Buffer): void {
    const stride = this.w * BPP[this.color];
    if (raw.length !== this.h * (stride + 1)) throw new Error('bad raw size');
    const rows = new Uint8Array(stride * this.h);
    for (let y = 0; y < this.h; y++) {
      const at = y * (stride + 1), f = raw[at], src = at + 1, dst = y * stride, up = dst - stride;
      if (f > 4) throw new Error('bad filter ' + f);
      for (let i = 0; i < stride; i++) {
        const left = i >= BPP[this.color] ? rows[dst + i - BPP[this.color]] : 0;
        const above = y > 0 ? rows[up + i] : 0;
        const corner = y > 0 && i >= BPP[this.color] ? rows[up + i - BPP[this.color]] : 0;
        let v = raw[src + i];
        if (f === 1) v += left;
        else if (f === 2) v += above;
        else if (f === 3) v += (left + above) >>> 1;
        else if (f === 4) v += predictor(left, above, corner);
        rows[dst + i] = v & 255;
      }
    }
    const n = this.w * this.h, out = new Uint8Array(n * 4);
    if (this.color === 6) out.set(rows);
    else if (this.color === 2) {
      const trns = this.transparency, key = trns && trns.length === 6;
      const kr = key ? be16(trns, 1) : -1, kg = key ? be16(trns, 3) : -1, kb = key ? be16(trns, 5) : -1;
      for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
        out[d] = rows[s]; out[d + 1] = rows[s + 1]; out[d + 2] = rows[s + 2];
        out[d + 3] = kr === rows[s] && kg === rows[s + 1] && kb === rows[s + 2] ? 0 : 255;
      }
    } else if (this.color === 0) {
      const trns = this.transparency, key = trns && trns.length === 2 ? be16(trns, 1) : -1;
      for (let i = 0, d = 0; i < n; i++, d += 4) {
        out[d] = out[d + 1] = out[d + 2] = rows[i];
        out[d + 3] = key === rows[i] ? 0 : 255;
      }
    } else if (this.color === 4) {
      for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
        out[d] = out[d + 1] = out[d + 2] = rows[s]; out[d + 3] = rows[s + 1];
      }
    } else if (this.color === 3) {
      if (!this.palette) throw new Error('missing palette');
      const cnt = this.palette.length / 3;
      for (let i = 0, d = 0; i < n; i++, d += 4) {
        const idx = rows[i];
        if (idx >= cnt) throw new Error('palette index out of range');
        out[d] = this.palette[idx * 3]; out[d + 1] = this.palette[idx * 3 + 1];
        out[d + 2] = this.palette[idx * 3 + 2];
        out[d + 3] = this.transparency && idx < this.transparency.length ? this.transparency[idx] : 255;
      }
    }
    this.pixels = out;
  }
}

function be16(b: Uint8Array, o: number): number { return (b[o] << 8) | b[o + 1]; }

const SEEN = new Uint8Array(256);
const HIST = new Uint32Array(256);

// Scanlines are prepared once per colour model; each heuristic picks a filter per row.
function filterPass(rows: Uint8Array, w: number, h: number, bpp: number, mode: Heuristic): Uint8Array {
  const stride = w * bpp, line = stride + 1;
  const out = new Uint8Array(h * line);
  const tryBuf = typeof mode === 'number' ? null : new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const cur = rows.subarray(y * stride, (y + 1) * stride);
    const prior = y === 0 ? null : rows.subarray((y - 1) * stride, y * stride);
    const at = y * line;
    if (typeof mode === 'number') {
      out[at] = mode;
      transform(mode, cur, prior, bpp, out.subarray(at + 1, at + line));
      continue;
    }
    let best = 0, bestScore = Infinity;
    const five = [0, 1, 2, 3, 4];
    for (const t of five) {
      transform(t as number, cur, prior, bpp, tryBuf as Uint8Array);
      let score: number;
      if (mode === 'sum') {
        score = 0;
        for (let i = 0; i < stride; i++) score += (tryBuf as Uint8Array)[i] < 128 ? tryBuf[i] : 256 - tryBuf[i];
      } else if (mode === 'distinct') {
        SEEN.fill(0); score = 0;
        for (let i = 0; i < stride; i++) if (!SEEN[tryBuf![i]]) { SEEN[tryBuf![i]] = 1; score++; }
      } else {
        HIST.fill(0);
        for (let i = 0; i < stride; i++) HIST[tryBuf![i]]++;
        score = 0;
        for (let i = 0; i < 256; i++) if (HIST[i]) score += HIST[i] * Math.log2(HIST[i]);
      }
      if (score < bestScore) { bestScore = score; best = t; }
    }
    out[at] = best;
    transform(best, cur, prior, bpp, out.subarray(at + 1, at + line));
  }
  return out;
}

function transform(type: number, cur: Uint8Array, prior: Uint8Array | null, bpp: number, dst: Uint8Array): void {
  const n = cur.length;
  for (let i = 0; i < n; i++) {
    const left = i >= bpp ? cur[i - bpp] : 0;
    const above = prior ? prior[i] : 0;
    const corner = prior && i >= bpp ? prior[i - bpp] : 0;
    let delta = 0;
    if (type === 1) delta = left;
    else if (type === 2) delta = above;
    else if (type === 3) delta = (left + above) >>> 1;
    else if (type === 4) delta = predictor(left, above, corner);
    dst[i] = (cur[i] - delta) & 255;
  }
}

function assemble(chunks: Chunk[]): Uint8Array {
  let size = 8;
  for (const c of chunks) size += 12 + c.data.length;
  const out = new Uint8Array(size);
  out.set(SIG, 0);
  let p = 8;
  for (const c of chunks) {
    const len = c.data.length;
    put32(out, p, len);
    for (let i = 0; i < 4; i++) out[p + 4 + i] = c.type.charCodeAt(i);
    out.set(c.data, p + 8);
    put32(out, p + 8 + len, crc(out, p + 4, p + 8 + len));
    p += 12 + len;
  }
  return out;
}

function ihdr(w: number, h: number, color: number): Uint8Array {
  const d = new Uint8Array(13);
  put32(d, 0, w); put32(d, 4, h); d[8] = 8; d[9] = color;
  return d;
}

interface Try { png: Uint8Array; note: string }

// Compress the same scanlines under each strategy, with a second memLevel pass on the best few.
function bestPack(w: number, h: number, color: number, rows: Uint8Array, extra: Chunk[]): Try {
  const filtered = HEURISTICS.map((m) => ({ mode: m, bytes: filterPass(rows, w, h, BPP[color], m) }));
  const shortlist: { bytes: Uint8Array; mode: Heuristic; strat: number; n: number }[] = [];
  let champion: Uint8Array | null = null;
  let chosen = '';
  for (const f of filtered) {
    for (const s of STRATS) {
      const z = deflateSync(f.bytes, { level: 9, strategy: s, memLevel: 8 });
      if (!champion || z.length < champion.length) {
        champion = z; chosen = `h=${f.mode} s=${s} m=8`;
      }
      if (shortlist.length < 3 || z.length < shortlist[2].n) {
        shortlist.push({ bytes: f.bytes, mode: f.mode, strat: s, n: z.length });
        shortlist.sort((a, b) => a.n - b.n);
        if (shortlist.length > 3) shortlist.pop();
      }
    }
  }
  for (const c of shortlist) {
    const z = deflateSync(c.bytes, { level: 9, strategy: c.strat, memLevel: 9 });
    if (champion === null || z.length < champion.length) { champion = z; chosen = `h=${c.mode} s=${c.strat} m=9`; }
  }
  const parts: Chunk[] = [{ type: 'IHDR', data: ihdr(w, h, color) }, ...extra,
    { type: 'IDAT', data: champion as Uint8Array }, { type: 'IEND', data: new Uint8Array(0) }];
  return { png: assemble(parts), note: chosen };
}

interface Scan { opaque: boolean; grey: boolean; single: boolean; key: number; colors: Map<number, number> | null }

function inspect(rgba: Uint8Array): Scan {
  let opaque = true, grey = true, single = true, seenZero = false, key = 0;
  let colors: Map<number, number> | null = new Map();
  const seenOpaque = new Set<number>();
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2], a = rgba[i + 3];
    if (r !== g || g !== b) grey = false;
    if (a !== 255) {
      opaque = false;
      const packed = r * 65536 + g * 256 + b;
      if (a === 0) {
        if (!seenZero) { seenZero = true; key = packed; }
        else if (packed !== key) single = false;
      } else single = false;
    } else seenOpaque.add(r * 65536 + g * 256 + b);
    if (colors) {
      const k = (((r << 24) | (g << 16) | (b << 8) | a) >>> 0);
      const old = colors.get(k);
      if (old !== undefined) colors.set(k, old + 1);
      else if (colors.size < 256) colors.set(k, 1);
      else colors = null;
    }
  }
  if (single && seenOpaque.has(key)) single = false;
  return { opaque, grey, single, key, colors };
}

function paletteEntry(rgba: Uint8Array, order: number[]): { idx: Uint8Array; plte: Uint8Array; trns: Uint8Array | null } {
  const map = new Map<number, number>();
  const plte = new Uint8Array(order.length * 3);
  let lastA = -1;
  for (let i = 0; i < order.length; i++) {
    const c = order[i];
    map.set(c, i);
    plte[i * 3] = c >>> 24; plte[i * 3 + 1] = (c >>> 16) & 255; plte[i * 3 + 2] = (c >>> 8) & 255;
    if ((c & 255) < 255) lastA = i;
  }
  const trns = lastA < 0 ? null : new Uint8Array(lastA + 1);
  if (trns) for (let i = 0; i <= lastA; i++) trns[i] = order[i] & 255;
  const idx = new Uint8Array(rgba.length >>> 2);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    const key = (((rgba[i] << 24) | (rgba[i + 1] << 16) | (rgba[i + 2] << 8) | rgba[i + 3]) >>> 0);
    idx[p] = map.get(key) as number;
  }
  return { idx, plte, trns };
}

function squeeze(source: Uint8Array): { png: Uint8Array; note: string } {
  const img = new PngReader(source);
  const { w, h } = img;
  const rgba = img.pixels, n = w * h;
  const s = inspect(rgba);
  const trials: Try[] = [];

  // Direct colour model with the fewest channels that still encodes every channel exactly.
  if (s.grey) {
    if (s.opaque || s.single) {
      const g = new Uint8Array(n);
      for (let i = 0, p = 0; i < rgba.length; i += 4, p++) g[p] = rgba[i];
      const extra = s.single ? [{ type: 'tRNS', data: Uint8Array.of(0, s.key & 255) }] : [];
      trials.push(bestPack(w, h, 0, g, extra));
    } else {
      const ga = new Uint8Array(n * 2);
      for (let i = 0, p = 0; i < rgba.length; i += 4, p += 2) { ga[p] = rgba[i]; ga[p + 1] = rgba[i + 3]; }
      trials.push(bestPack(w, h, 4, ga, []));
    }
  } else if (s.opaque || s.single) {
    const rgb = new Uint8Array(n * 3);
    for (let i = 0, p = 0; i < rgba.length; i += 4, p += 3) {
      rgb[p] = rgba[i]; rgb[p + 1] = rgba[i + 1]; rgb[p + 2] = rgba[i + 2];
    }
    const extra = s.single
      ? [{ type: 'tRNS', data: Uint8Array.of(0, (s.key >>> 16) & 255, 0, (s.key >>> 8) & 255, 0, s.key & 255) }]
      : [];
    trials.push(bestPack(w, h, 2, rgb, extra));
  } else trials.push(bestPack(w, h, 6, rgba, []));

  // Indexed colour: only when all distinct RGBA tuples fit in one palette.
  if (s.colors && s.colors.size) {
    const all = [...s.colors.entries()];
    const clear = all.filter(([c]) => (c & 255) === 255);
    const faded = all.filter(([c]) => (c & 255) !== 255);
    const freq = [...faded.sort((a, b) => b[1] - a[1] || a[0] - b[0]),
      ...clear.sort((a, b) => b[1] - a[1] || a[0] - b[0])].map(([c]) => c);
    const lum = (c: number) => 299 * ((c >>> 24) & 255) + 587 * ((c >>> 16) & 255) + 114 * ((c >>> 8) & 255);
    const shade = [...faded.sort((a, b) => lum(a[0]) - lum(b[0]) || a[0] - b[0]),
      ...clear.sort((a, b) => lum(a[0]) - lum(b[0]) || a[0] - b[0])].map(([c]) => c);
    for (const order of [freq, shade]) {
      const p = paletteEntry(rgba, order);
      const extra: Chunk[] = [{ type: 'PLTE', data: p.plte }];
      if (p.trns) extra.push({ type: 'tRNS', data: p.trns });
      trials.push(bestPack(w, h, 3, p.idx, extra));
    }
  }
  let best = trials[0];
  for (const t of trials) if (t.png.length < best.png.length) best = t;
  return best;
}

const where = process.env.MAKEFUN_INPUT_DIR ?? process.argv[2] ?? '/input';
const destination = process.env.MAKEFUN_OUTPUT_DIR ?? process.argv[3] ?? '/output';
const names = readdirSync(where, { withFileTypes: true })
  .filter((d) => d.isDirectory()).map((d) => d.name).sort();
for (const name of names) {
  const file = join(where, name, 'image.png');
  if (!existsSync(file)) continue;
  const answer = squeeze(new Uint8Array(readFileSync(file)));
  mkdirSync(join(destination, name), { recursive: true });
  writeFileSync(join(destination, name, 'image.png'), answer.png);
  console.log(`${name}: ${answer.png.length} bytes [${answer.note}]`);
}
