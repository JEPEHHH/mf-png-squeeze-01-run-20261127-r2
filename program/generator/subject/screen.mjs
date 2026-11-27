// png-squeeze-01's screenshot painter, make.fun's own (MIT): one procedural desktop screenshot of 1280 x 720 RGBA8 from
// the generator's stream. Windows with title bars, menus, toolbars and status bars; text in font8x8 (a public-domain
// bitmap font, font8x8.mjs) at one or two times its size or smoothed to one and a half; documents, code, tables,
// charts, forms, galleries, terminals and picture viewers; icons, gradients, soft shadows and smooth "photo" patches,
// a desktop now and then a photo itself. Nothing is taken from a corpus.
//
// Every value is drawn from the stream and computed with integer steps and IEEE arithmetic (+, -, x, / and sqrt,
// each exactly rounded), never a transcendental function, so every engine paints the same bytes.
//
// The theme is the instance's (generate.mjs: THEMES by its index):
//   flat   flat colours, no gradient, no smoothing, no shadow: at most 256 colours, so a palette holds the image
//   rich   gradients, smoothed text and corners, soft shadows, photo patches: thousands of colours, every pixel opaque
//   alpha  a capture of one or two windows on a transparent background: rounded smoothed corners and a soft shadow
//          leave partly transparent pixels
//   grey   the rich look in grey: every pixel's red, green and blue equal (luma, Rec. 601 weights), every pixel opaque

import { glyphOf } from './font8x8.mjs';

export const WIDTH = 1280;
export const HEIGHT = 720;
export const THEMES = Object.freeze(['flat', 'rich', 'alpha', 'grey']);

const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** An RGBA canvas with a clip rectangle and source-over blending of straight (not premultiplied) alpha. */
export class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = new Uint8Array(w * h * 4);
    this.clip = [0, 0, w, h];
  }

  withClip(x0, y0, x1, y1, draw) {
    const old = this.clip;
    this.clip = [Math.max(old[0], x0), Math.max(old[1], y0), Math.min(old[2], x1), Math.min(old[3], y1)];
    draw();
    this.clip = old;
  }

  /** Paint (x, y) with colour c at coverage k of 255 (c's own alpha times k). */
  put(x, y, c, k = 255) {
    const [cx0, cy0, cx1, cy1] = this.clip;
    if (x < cx0 || y < cy0 || x >= cx1 || y >= cy1) return;
    const i = (y * this.w + x) * 4;
    const a = k === 255 ? c[3] : Math.round((c[3] * k) / 255);
    if (a === 0) return;
    const p = this.px;
    if (a === 255) {
      p[i] = c[0];
      p[i + 1] = c[1];
      p[i + 2] = c[2];
      p[i + 3] = 255;
      return;
    }
    const da = p[i + 3];
    const num = a * 255 + da * (255 - a);
    const wd = da * (255 - a);
    p[i] = Math.round((c[0] * a * 255 + p[i] * wd) / num);
    p[i + 1] = Math.round((c[1] * a * 255 + p[i + 1] * wd) / num);
    p[i + 2] = Math.round((c[2] * a * 255 + p[i + 2] * wd) / num);
    p[i + 3] = Math.round(num / 255);
  }

  rect(x, y, w, h, c) {
    const [cx0, cy0, cx1, cy1] = this.clip;
    const x0 = Math.max(cx0, x);
    const y0 = Math.max(cy0, y);
    const x1 = Math.min(cx1, x + w);
    const y1 = Math.min(cy1, y + h);
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.put(xx, yy, c);
  }

  /** A rectangle shaded from c0 to c1, top to bottom (vertical) or left to right. */
  gradient(x, y, w, h, c0, c1, vertical = true) {
    const n = Math.max(1, (vertical ? h : w) - 1);
    for (let t = 0; t < (vertical ? h : w); t++) {
      const c = [0, 1, 2, 3].map((j) => Math.round(c0[j] + ((c1[j] - c0[j]) * t) / n));
      if (vertical) this.rect(x, y + t, w, 1, c);
      else this.rect(x + t, y, 1, h, c);
    }
  }

  /** A rectangle with corners of radius r, smoothed (4 x 4 samples a corner pixel) or not. */
  roundRect(x, y, w, h, r, c, smooth) {
    if (r <= 0) return this.rect(x, y, w, h, c);
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        const cx = xx < x + r ? x + r : xx >= x + w - r ? x + w - r : null;
        const cy = yy < y + r ? y + r : yy >= y + h - r ? y + h - r : null;
        if (cx === null || cy === null) {
          this.put(xx, yy, c);
          continue;
        }
        this.put(xx, yy, c, coverage(xx, yy, cx, cy, r, smooth));
      }
    }
  }

  /** A disc of radius r about (cx, cy), smoothed or not. */
  disc(cx, cy, r, c, smooth) {
    for (let yy = Math.floor(cy - r - 1); yy <= Math.ceil(cy + r + 1); yy++) {
      for (let xx = Math.floor(cx - r - 1); xx <= Math.ceil(cx + r + 1); xx++) {
        const k = coverage(xx, yy, cx, cy, r, smooth);
        if (k > 0) this.put(xx, yy, c, k);
      }
    }
  }

  /** A ring of outer radius r and width t. */
  ring(cx, cy, r, t, c, smooth) {
    for (let yy = Math.floor(cy - r - 1); yy <= Math.ceil(cy + r + 1); yy++) {
      for (let xx = Math.floor(cx - r - 1); xx <= Math.ceil(cx + r + 1); xx++) {
        const k = coverage(xx, yy, cx, cy, r, smooth) - coverage(xx, yy, cx, cy, r - t, smooth);
        if (k > 0) this.put(xx, yy, c, k);
      }
    }
  }

  /** A line from (x0, y0) to (x1, y1): Bresenham's of width w, or smoothed (Wu's) when asked. */
  line(x0, y0, x1, y1, c, w = 1, smooth = false) {
    if (smooth) return this.wuLine(x0, y0, x1, y1, c);
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let x = x0;
    let y = y0;
    for (;;) {
      this.rect(x, y, w, w, c);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }

  wuLine(x0, y0, x1, y1, c) {
    const steep = Math.abs(y1 - y0) > Math.abs(x1 - x0);
    if (steep) [x0, y0, x1, y1] = [y0, x0, y1, x1];
    if (x0 > x1) [x0, y0, x1, y1] = [x1, y1, x0, y0];
    const grad = x1 === x0 ? 0 : (y1 - y0) / (x1 - x0);
    let y = y0;
    for (let x = x0; x <= x1; x++) {
      const fy = Math.floor(y);
      const f = y - fy;
      const k0 = Math.round((1 - f) * 255);
      const k1 = Math.round(f * 255);
      if (steep) {
        this.put(fy, x, c, k0);
        this.put(fy + 1, x, c, k1);
      } else {
        this.put(x, fy, c, k0);
        this.put(x, fy + 1, c, k1);
      }
      y += grad;
    }
  }

  /** A soft shadow under the rectangle (x, y, w, h): alpha falling from `alpha` to 0 over `spread` pixels outside it. */
  shadow(x, y, w, h, spread, alpha) {
    for (let yy = y - spread; yy < y + h + spread; yy++) {
      for (let xx = x - spread; xx < x + w + spread; xx++) {
        const dx = xx < x ? x - xx : xx >= x + w ? xx - (x + w - 1) : 0;
        const dy = yy < y ? y - yy : yy >= y + h ? yy - (y + h - 1) : 0;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d >= spread) continue;
        const t = (spread - d) / spread;
        this.put(xx, yy, [0, 0, 0, Math.round(alpha * t * t)]);
      }
    }
  }

  /** Text in font8x8 at the top left (x, y): `scale` 1 or 2 (crisp), or `smooth` (one and a half, 4 levels of coverage). */
  text(s, x, y, c, { scale = 1, smooth = false } = {}) {
    let at = x;
    for (const ch of s) {
      const g = glyphOf(ch);
      if (smooth) {
        // The glyph at 3 times, box-filtered by 2: 12 x 12 pixels, each covered 0 to 4 of 4.
        for (let oy = 0; oy < 12; oy++) {
          for (let ox = 0; ox < 12; ox++) {
            let k = 0;
            for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
              const gx = Math.floor((ox * 2 + sx) / 3);
              const gy = Math.floor((oy * 2 + sy) / 3);
              if ((g[gy] >> gx) & 1) k++;
            }
            if (k > 0) this.put(at + ox, y + oy, c, (k * 255) / 4);
          }
        }
        at += 11;
      } else {
        for (let gy = 0; gy < 8; gy++) {
          const row = g[gy];
          if (row === 0) continue;
          for (let gx = 0; gx < 8; gx++) if ((row >> gx) & 1) this.rect(at + gx * scale, y + gy * scale, scale, scale, c);
        }
        at += 8 * scale;
      }
    }
    return at;
  }

  /** A smooth patch, a "photo": two octaves of value noise about colours drawn from the stream. */
  photo(x, y, w, h, rng) {
    const base = [rng.int(40, 200), rng.int(40, 200), rng.int(40, 200)];
    const octaves = [
      { cell: rng.pick([24, 32, 48, 64]), amp: rng.int(50, 90) },
      { cell: rng.pick([6, 8, 12]), amp: rng.int(8, 20) },
    ];
    const sum = new Float64Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      sum[i * 3] = base[0];
      sum[i * 3 + 1] = base[1];
      sum[i * 3 + 2] = base[2];
    }
    const smoothstep = (t) => t * t * (3 - 2 * t);
    for (const o of octaves) {
      const gw = Math.ceil(w / o.cell) + 2;
      const gh = Math.ceil(h / o.cell) + 2;
      const v = Int16Array.from({ length: gw * gh * 3 }, () => rng.int(-o.amp, o.amp));
      const tx = Float64Array.from({ length: w }, (_, xx) => smoothstep(xx / o.cell - Math.floor(xx / o.cell)));
      for (let yy = 0; yy < h; yy++) {
        const iy = Math.floor(yy / o.cell);
        const ty = smoothstep(yy / o.cell - iy);
        for (let xx = 0; xx < w; xx++) {
          const ix = Math.floor(xx / o.cell);
          const t = tx[xx];
          const i00 = (iy * gw + ix) * 3;
          const i10 = ((iy + 1) * gw + ix) * 3;
          const o3 = (yy * w + xx) * 3;
          for (let ch = 0; ch < 3; ch++) {
            const a = v[i00 + ch] + (v[i00 + 3 + ch] - v[i00 + ch]) * t;
            const b = v[i10 + ch] + (v[i10 + 3 + ch] - v[i10 + ch]) * t;
            sum[o3 + ch] += a + (b - a) * ty;
          }
        }
      }
    }
    const c = [0, 0, 0, 255];
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const o3 = (yy * w + xx) * 3;
        c[0] = clamp8(sum[o3]);
        c[1] = clamp8(sum[o3 + 1]);
        c[2] = clamp8(sum[o3 + 2]);
        this.put(x + xx, y + yy, c);
      }
    }
  }

  /** A 16 x 16 icon (the bitmap of iconOf) at `scale`. */
  icon(ic, x, y, scale = 1) {
    for (let yy = 0; yy < 16; yy++) for (let xx = 0; xx < 16; xx++) {
      const c = ic[yy * 16 + xx];
      if (c !== null) this.rect(x + xx * scale, y + yy * scale, scale, scale, c);
    }
  }
}

/** Coverage (0 to 255) of pixel (px, py) by the disc of radius r about (cx, cy): 16 samples, or its centre's alone. */
function coverage(px, py, cx, cy, r, smooth) {
  if (r <= 0) return 0;
  const r2 = r * r;
  if (!smooth) {
    const dx = px + 0.5 - cx;
    const dy = py + 0.5 - cy;
    return dx * dx + dy * dy <= r2 ? 255 : 0;
  }
  let n = 0;
  for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
    const dx = px + (sx + 0.5) / 4 - cx;
    const dy = py + (sy + 0.5) / 4 - cy;
    if (dx * dx + dy * dy <= r2) n++;
  }
  return Math.round((n * 255) / 16);
}

/** A 16 x 16 icon, mirrored left to right: an outline colour, a fill and an accent, or null (no pixel). */
export function iconOf(rng, colours) {
  const [outline, fill, accent] = colours;
  const bits = [];
  const shape = rng.int(0, 2);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 8; x++) {
      const dx = 7.5 - x;
      const dy = y - 7.5;
      const inside = shape === 0 ? dx * dx + dy * dy < 56 : shape === 1 ? Math.abs(dy) < 6.5 && dx < 6.5 : Math.abs(dy) + dx < 9;
      const edge = shape === 0 ? dx * dx + dy * dy >= 36 : shape === 1 ? Math.abs(dy) >= 5.5 || dx >= 5.5 : Math.abs(dy) + dx >= 7.5;
      bits.push(!inside ? null : edge ? outline : rng.chance(0.3) ? accent : fill);
    }
  }
  const ic = new Array(256);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) {
    ic[y * 16 + x] = bits[y * 8 + x];
    ic[y * 16 + 15 - x] = bits[y * 8 + x];
  }
  return ic;
}

// ---------------------------------------------------------------- words

const SYLLABLES = ['ka', 'lo', 'mi', 'ter', 'san', 'do', 'vel', 'ra', 'qui', 'nex', 'tor', 'pa', 'lin', 'es', 'ul', 'ro', 'ba', 'den', 'fi', 'gar', 'mon', 'te', 'shi', 'pre', 'cor', 'al', 'vis', 'un', 'ex', 'po'];
const KEYWORDS = ['const', 'let', 'function', 'return', 'if', 'else', 'for', 'while', 'import', 'export', 'class', 'new', 'await', 'async'];

const wordOf = (rng) => Array.from({ length: rng.int(1, 3) }, () => rng.pick(SYLLABLES)).join('');
const capital = (w) => w[0].toUpperCase() + w.slice(1);
const titleOf = (rng, n) => Array.from({ length: n }, () => capital(wordOf(rng))).join(' ');
function sentenceOf(rng, maxChars) {
  let s = capital(wordOf(rng));
  for (;;) {
    const w = wordOf(rng);
    if (s.length + w.length + 2 > maxChars) break;
    s += (rng.chance(0.1) ? ', ' : ' ') + w;
    if (rng.chance(0.12)) break;
  }
  return s + (rng.chance(0.85) ? '.' : '?');
}
const numberOf = (rng) => (rng.chance(0.5) ? String(rng.int(0, 99999)) : `${rng.int(0, 999)}.${String(rng.int(0, 99)).padStart(2, '0')}`);

// ---------------------------------------------------------------- schemes

const LIGHT = [
  { desk: [58, 110, 165], win: [240, 240, 240], title: [0, 84, 166], titleText: [255, 255, 255], text: [20, 20, 20], dim: [110, 110, 110], line: [200, 200, 200], accent: [0, 120, 215], alt: [229, 236, 245], bar: [32, 32, 32], barText: [230, 230, 230] },
  { desk: [96, 125, 80], win: [252, 250, 245], title: [222, 218, 210], titleText: [40, 40, 40], text: [30, 30, 30], dim: [120, 115, 105], line: [210, 205, 195], accent: [200, 90, 40], alt: [244, 240, 230], bar: [230, 226, 218], barText: [40, 40, 40] },
  { desk: [130, 60, 120], win: [255, 255, 255], title: [245, 245, 247], titleText: [60, 60, 67], text: [28, 28, 30], dim: [142, 142, 147], line: [216, 216, 220], accent: [52, 120, 246], alt: [242, 242, 247], bar: [236, 236, 240], barText: [28, 28, 30] },
];
const DARK = [
  { desk: [18, 24, 38], win: [30, 30, 30], title: [45, 45, 48], titleText: [204, 204, 204], text: [212, 212, 212], dim: [128, 128, 128], line: [62, 62, 66], accent: [86, 156, 214], alt: [37, 37, 40], bar: [20, 20, 22], barText: [200, 200, 200] },
  { desk: [40, 20, 50], win: [40, 42, 54], title: [33, 34, 44], titleText: [248, 248, 242], text: [248, 248, 242], dim: [98, 114, 164], line: [68, 71, 90], accent: [189, 147, 249], alt: [47, 49, 63], bar: [25, 26, 33], barText: [248, 248, 242] },
];
const TOKEN_COLOURS = [
  [197, 134, 192],
  [86, 156, 214],
  [206, 145, 120],
  [181, 206, 168],
  [220, 220, 170],
  [78, 201, 176],
];
const SERIES = [
  [230, 80, 70],
  [60, 160, 90],
  [240, 170, 40],
  [90, 110, 220],
  [150, 90, 200],
];

const op = (c) => [c[0], c[1], c[2], 255];
/** A scheme's colour moved a little, the same for every use (so a flat image keeps few colours). */
function jittered(rng, scheme) {
  const out = {};
  for (const [k, c] of Object.entries(scheme)) out[k] = op(c.map((v) => clamp8(v + rng.int(-6, 6))));
  return out;
}

// ---------------------------------------------------------------- windows and their content

/** What a window shows. */
export const KINDS = Object.freeze(['doc', 'code', 'table', 'chart', 'form', 'gallery', 'terminal', 'viewer']);

function drawContent(cv, kind, x, y, w, h, s, look, rng, icons) {
  const smooth = look.smooth;
  const lineH = smooth ? 15 : 11;
  const tx = (str, xx, yy, c) => cv.text(str, xx, yy, c, { smooth });
  cv.rect(x, y, w, h, kind === 'terminal' || kind === 'code' ? look.dark : s.win);
  if (kind === 'doc') {
    let yy = y + 10;
    cv.text(titleOf(rng, rng.int(2, 4)), x + 14, yy, s.text, { scale: 2 });
    yy += 26;
    while (yy < y + h - lineH) {
      const lines = rng.int(2, 6);
      for (let l = 0; l < lines && yy < y + h - lineH; l++) {
        tx(sentenceOf(rng, Math.floor((w - 28) / (smooth ? 11 : 8))), x + 14, yy, s.text);
        yy += lineH;
      }
      yy += lineH >> 1;
    }
  } else if (kind === 'code' || kind === 'terminal') {
    let yy = y + 6;
    let n = rng.int(1, 300);
    let indent = 0;
    while (yy < y + h - lineH) {
      let xx = x + 6;
      if (kind === 'code') {
        tx(String(n++).padStart(4, ' '), xx, yy, look.gutter);
        xx += 5 * (smooth ? 11 : 8) + 6;
        indent = Math.max(0, Math.min(6, indent + rng.int(-1, 1)));
        xx += indent * 2 * (smooth ? 11 : 8);
        const tokens = rng.int(1, 7);
        for (let t = 0; t < tokens; t++) {
          const kindT = rng.int(0, 5);
          const word = kindT === 0 ? rng.pick(KEYWORDS) : kindT === 2 ? `'${wordOf(rng)}'` : kindT === 3 ? numberOf(rng) : wordOf(rng);
          xx = tx(word + (rng.chance(0.3) ? '(' : rng.chance(0.2) ? ';' : ' '), xx, yy, look.tokens[kindT]);
          if (xx > x + w - 40) break;
        }
      } else {
        const prompt = rng.chance(0.3);
        if (prompt) xx = tx(`${wordOf(rng)}@${wordOf(rng)}:~$ `, xx, yy, look.tokens[4]);
        tx(prompt ? `${wordOf(rng)} ${wordOf(rng)} --${wordOf(rng)}` : sentenceOf(rng, Math.floor((w - 20) / (smooth ? 11 : 8))), xx, yy, look.termText);
      }
      yy += lineH;
    }
  } else if (kind === 'table') {
    const cols = rng.int(3, 6);
    const colW = Math.floor((w - 20) / cols);
    const rowH = lineH + 8;
    cv.rect(x, y, w, rowH, s.alt);
    for (let c = 0; c < cols; c++) tx(capital(wordOf(rng)), x + 10 + c * colW, y + 5, s.text);
    let r = 0;
    for (let yy = y + rowH; yy < y + h - rowH; yy += rowH, r++) {
      if (r % 2 === 1) cv.rect(x, yy, w, rowH, s.alt);
      for (let c = 0; c < cols; c++) {
        if (c === 0 && rng.chance(0.6)) cv.icon(rng.pick(icons), x + 8, yy + Math.floor((rowH - 16) / 2));
        const cell = c === 0 ? titleOf(rng, rng.int(1, 2)) : rng.chance(0.5) ? numberOf(rng) : wordOf(rng);
        tx(cell.slice(0, Math.floor((colW - 30) / (smooth ? 11 : 8))), x + 10 + c * colW + (c === 0 ? 20 : 0), yy + 4, c === 0 ? s.text : s.dim);
      }
      cv.rect(x, yy + rowH - 1, w, 1, s.line);
    }
  } else if (kind === 'chart') {
    const px0 = x + 50;
    const py0 = y + 20;
    const pw = w - 70;
    const ph = h - 60;
    for (let g = 0; g <= 5; g++) {
      const gy = py0 + Math.floor((ph * g) / 5);
      cv.rect(px0, gy, pw, 1, s.line);
      tx(String((5 - g) * rng.int(1, 4) * 10), x + 6, gy - 4, s.dim);
    }
    cv.rect(px0, py0, 1, ph + 1, s.dim);
    const bars = rng.chance(0.5);
    const series = rng.int(1, 3);
    for (let k = 0; k < series; k++) {
      const col = op(SERIES[(k + rng.int(0, 4)) % SERIES.length]);
      const points = rng.int(8, 24);
      let v = rng.float() * ph;
      let prev = null;
      for (let p = 0; p < points; p++) {
        v = Math.max(0, Math.min(ph, v + (rng.float() - 0.5) * ph * 0.3));
        const xx = px0 + Math.floor((pw * (p + 0.5)) / points);
        const yy = py0 + ph - Math.floor(v);
        if (bars && k === 0) cv.rect(xx - Math.floor(pw / points / 3), yy, Math.max(2, Math.floor((pw / points) * 0.6)), py0 + ph - yy, col);
        else {
          if (prev !== null) cv.line(prev[0], prev[1], xx, yy, col, 2, smooth);
          cv.disc(xx, yy, 3, col, smooth);
        }
        prev = [xx, yy];
      }
      cv.rect(px0 + 10 + k * 120, y + h - 22, 12, 12, col);
      tx(capital(wordOf(rng)), px0 + 28 + k * 120, y + h - 22, s.text);
    }
  } else if (kind === 'form') {
    let yy = y + 16;
    while (yy < y + h - 40) {
      const what = rng.int(0, 3);
      tx(`${capital(wordOf(rng))}:`, x + 16, yy + 6, s.text);
      const fx = x + 150;
      if (what === 0) {
        cv.rect(fx, yy, Math.min(w - 170, 320), 22, s.line);
        cv.rect(fx + 1, yy + 1, Math.min(w - 170, 320) - 2, 20, look.field);
        tx(wordOf(rng), fx + 6, yy + 6, s.dim);
      } else if (what === 1) {
        for (let k = 0; k < 3; k++) {
          cv.ring(fx + 8 + k * 100, yy + 10, 7, 1.5, s.dim, smooth);
          if (k === 0) cv.disc(fx + 8, yy + 10, 3.5, s.accent, smooth);
          tx(wordOf(rng), fx + 22 + k * 100, yy + 6, s.text);
        }
      } else if (what === 2) {
        cv.rect(fx, yy + 3, 16, 16, s.dim);
        cv.rect(fx + 2, yy + 5, 12, 12, rng.chance(0.5) ? s.accent : look.field);
        tx(sentenceOf(rng, 30), fx + 24, yy + 6, s.text);
      } else {
        const bw = 90;
        cv.roundRect(fx, yy, bw, 24, look.radius, s.accent, smooth);
        tx(capital(wordOf(rng)).slice(0, 8), fx + 10, yy + 7, look.onAccent);
        cv.roundRect(fx + bw + 12, yy, bw, 24, look.radius, s.line, smooth);
        tx(capital(wordOf(rng)).slice(0, 8), fx + bw + 22, yy + 7, s.text);
      }
      yy += 36;
    }
  } else if (kind === 'viewer') {
    // One picture filling the window, a photo in a rich look and a poster of flat bands in a flat one.
    const m = 12;
    if (look.photos) cv.photo(x + m, y + m, w - 2 * m, h - 2 * m, rng);
    else {
      const bands = rng.int(3, 7);
      for (let b = 0; b < bands; b++) cv.rect(x + m, y + m + Math.floor(((h - 2 * m) * b) / bands), w - 2 * m, Math.ceil((h - 2 * m) / bands), op(rng.pick(SERIES)));
      cv.icon(rng.pick(icons), x + (w >> 1) - 32, y + (h >> 1) - 32, 4);
    }
  } else {
    // gallery
    const t = rng.pick([96, 128, 160]);
    for (let yy = y + 10; yy + t + 20 < y + h; yy += t + 26) {
      for (let xx = x + 10; xx + t < x + w; xx += t + 12) {
        if (look.photos) cv.photo(xx, yy, t, t, rng);
        else {
          cv.rect(xx, yy, t, t, s.alt);
          cv.icon(rng.pick(icons), xx + (t >> 1) - 16, yy + (t >> 1) - 16, 2);
        }
        tx(wordOf(rng).slice(0, Math.floor(t / (smooth ? 11 : 8))), xx, yy + t + 6, s.dim);
      }
    }
  }
}

function drawWindow(cv, x, y, w, h, s, look, rng, icons) {
  if (look.shadows) cv.shadow(x + 2, y + 6, w, h, rng.int(10, 22), rng.int(70, 120));
  cv.roundRect(x, y, w, h, look.radius, s.line, look.smooth);
  cv.roundRect(x + 1, y + 1, w - 2, h - 2, Math.max(0, look.radius - 1), s.win, look.smooth);
  const th = look.smooth ? 30 : 24;
  cv.withClip(x + 1, y + 1, x + w - 1, y + h - 1, () => {
    if (look.gradients) cv.gradient(x, y, w, th, look.titleTop, s.title);
    else cv.rect(x, y, w, th, s.title);
    cv.text(titleOf(rng, rng.int(1, 3)), x + (look.smooth ? 84 : 32), y + (th - (look.smooth ? 12 : 8)) / 2, s.titleText, { smooth: look.smooth });
    if (look.smooth) {
      for (const [k, c] of [
        [0, [255, 95, 86, 255]],
        [1, [255, 189, 46, 255]],
        [2, [39, 201, 63, 255]],
      ])
        cv.disc(x + 16 + k * 20, y + th / 2, 6, c, true);
    } else {
      cv.icon(icons[0], x + 8, y + 4);
      for (let k = 0; k < 3; k++) cv.text(['x', '_', '#'][k], x + w - 22 - k * 22, y + 8, s.titleText);
    }
    let cy = y + th;
    if (rng.chance(0.7)) {
      cv.rect(x, cy, w, 22, s.alt);
      let mx = x + 10;
      for (let k = rng.int(3, 7); k > 0 && mx < x + w - 60; k--) mx = cv.text(capital(wordOf(rng)), mx, cy + 7, s.text) + 16;
      cy += 22;
    }
    if (rng.chance(0.6)) {
      cv.rect(x, cy, w, 28, s.win);
      for (let k = 0, ix = x + 8; k < rng.int(4, 12) && ix < x + w - 24; k++, ix += 24) cv.icon(icons[k % icons.length], ix, cy + 6);
      cv.rect(x, cy + 27, w, 1, s.line);
      cy += 28;
    }
    const status = rng.chance(0.5) ? 20 : 0;
    const kind = rng.pick(KINDS);
    let sideW = 0;
    if (w > 600 && rng.chance(0.4)) {
      sideW = rng.int(140, 200);
      cv.rect(x, cy, sideW, y + h - cy - status, s.alt);
      for (let yy = cy + 10; yy < y + h - status - 20; yy += 22) {
        cv.icon(rng.pick(icons), x + 10, yy);
        cv.text(capital(wordOf(rng)).slice(0, 14), x + 32, yy + 4, s.text, { smooth: look.smooth });
      }
    }
    cv.withClip(x + sideW, cy, x + w, y + h - status, () => drawContent(cv, kind, x + sideW, cy, w - sideW, y + h - cy - status, s, look, rng, icons));
    if (status > 0) {
      cv.rect(x, y + h - status, w, status, s.alt);
      cv.text(`${sentenceOf(rng, 40)}  ${numberOf(rng)}`, x + 8, y + h - status + 6, s.dim);
    }
  });
}

/** The theme's look: which effects it draws with, and its derived colours. */
function lookOf(theme, s, rng) {
  const rich = theme !== 'flat';
  const darkCode = op([30, 30, 30].map((v) => v + rng.int(-6, 6)));
  return {
    smooth: rich,
    gradients: rich,
    shadows: rich,
    photos: rich,
    radius: rich ? rng.int(6, 10) : rng.pick([0, 0, 3]),
    titleTop: op(s.title.map((v) => clamp8(v + 40))),
    dark: darkCode,
    gutter: op([110, 118, 129]),
    termText: op([204, 204, 204]),
    tokens: [...TOKEN_COLOURS.map(op), op([212, 212, 212])].slice(0, 6),
    field: op([255, 255, 255].map((v, i) => (s.win[i] < 128 ? s.win[i] + 12 : 255))),
    onAccent: op([255, 255, 255]),
  };
}

/** One screenshot of `theme` (THEMES), drawn from rng: {rgba, width, height}. */
export function paint(rng, theme) {
  const cv = new Canvas(WIDTH, HEIGHT);
  const s = jittered(rng, rng.chance(0.5) ? rng.pick(LIGHT) : rng.pick(DARK));
  const look = lookOf(theme, s, rng);
  const icons = Array.from({ length: rng.int(6, 12) }, () => iconOf(rng, rng.shuffle([s.text, s.accent, op(rng.pick(SERIES)), s.win]).slice(0, 3)));
  const capture = theme === 'alpha';

  // The desktop (none for a capture: its background stays transparent).
  if (!capture) {
    if (look.photos && rng.chance(0.35)) cv.photo(0, 0, WIDTH, HEIGHT, rng);
    else if (look.gradients) {
      const other = op(s.desk.map((v) => clamp8(v + rng.int(-70, 70))));
      cv.gradient(0, 0, WIDTH, HEIGHT, s.desk, other, rng.chance(0.5));
      if (rng.chance(0.6)) {
        const r = rng.int(150, 400);
        const cx = rng.int(0, WIDTH);
        const cy = rng.int(0, HEIGHT);
        for (let k = r; k > 0; k -= 6) cv.disc(cx, cy, k, op(other.map((v) => clamp8(v + ((r - k) * 40) / r))).slice(0, 3).concat([40]), true);
      }
    } else {
      cv.rect(0, 0, WIDTH, HEIGHT, s.desk);
      if (rng.chance(0.5)) {
        const c2 = op(s.desk.map((v) => clamp8(v + 18)));
        const step = rng.pick([8, 16, 32]);
        for (let y = 0; y < HEIGHT; y += step) for (let x = (y / step) % 2 === 0 ? 0 : step; x < WIDTH; x += step * 2) cv.rect(x, y, step, step, c2);
      }
    }
    // Desktop icons down the left.
    if (rng.chance(0.7)) for (let y = 40, k = rng.int(3, 7); k > 0; k--, y += 76) {
      cv.icon(rng.pick(icons), 24, y, 2);
      cv.text(wordOf(rng).slice(0, 8), 16, y + 40, op([255, 255, 255]), { smooth: look.smooth });
    }
  }

  // The windows, the last on top.
  const count = capture ? rng.int(1, 2) : rng.int(1, 3);
  for (let k = 0; k < count; k++) {
    const big = k === 0;
    const w = capture && big ? rng.int(900, 1200) : rng.int(big ? 640 : 360, big ? 1100 : 700);
    const h = capture && big ? rng.int(520, 650) : rng.int(big ? 420 : 240, big ? 620 : 460);
    const x = capture && big ? Math.floor((WIDTH - w) / 2) + rng.int(-20, 20) : rng.int(0, WIDTH - w);
    const y = capture && big ? Math.floor((HEIGHT - h) / 2) + rng.int(-10, 10) : rng.int(0, HEIGHT - h - 40);
    drawWindow(cv, x, y, w, h, s, look, rng, icons);
  }

  // The task bar.
  if (!capture) {
    const bh = rng.int(34, 44);
    if (look.gradients) cv.gradient(0, HEIGHT - bh, WIDTH, bh, op(s.bar.map((v) => clamp8(v + 25))), s.bar);
    else cv.rect(0, HEIGHT - bh, WIDTH, bh, s.bar);
    for (let k = 0, x = 12; k < rng.int(5, 12); k++, x += 40) cv.icon(icons[k % icons.length], x, HEIGHT - bh + Math.floor((bh - 16) / 2));
    const clock = `${String(rng.int(0, 23)).padStart(2, '0')}:${String(rng.int(0, 59)).padStart(2, '0')}`;
    cv.text(clock, WIDTH - 70, HEIGHT - bh + Math.floor((bh - 12) / 2), s.barText, { smooth: look.smooth });
  }

  if (theme === 'grey') {
    const p = cv.px;
    for (let i = 0; i < p.length; i += 4) {
      const g = Math.floor((299 * p[i] + 587 * p[i + 1] + 114 * p[i + 2] + 500) / 1000);
      p[i] = p[i + 1] = p[i + 2] = g;
    }
  }
  return { rgba: cv.px, width: WIDTH, height: HEIGHT };
}
