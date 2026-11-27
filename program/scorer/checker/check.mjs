// png-squeeze-01's checker (scripts/releases/new-solver-home.ts's contract): an instance is one screenshot, image.png
// (a stored PNG, generator/subject/generate.mjs); the entry's answer is image.png, a PNG of the same image. png.mjs
// decodePng (generator/subject/png.mjs, byte for byte) reads both; it never runs entry code.
//
//   - An answer the decoder does not read (png.mjs's header: 8-bit, non-interlaced, colour type 0, 2, 3, 4 or 6, only
//     IHDR, PLTE, tRNS, IDAT and IEND), or of another width or height, is invalid: the instance is unanswered.
//   - An answer that reads but differs from the image in any channel of any pixel (red, green, blue and alpha, a fully
//     transparent pixel's colour too) is valid and earns 0 points.
//   - An exact answer of `bytes` bytes earns 1,000 x (floor - bytes) / (floor - target), held to 0 to 1,000: floor and
//     target are the key's floor_bytes and target_bytes (twice and half the bytes of make.fun's scale
//     compressor's PNG of the image, generator/subject/scale.mjs scalePng).

import { decodePng } from './png.mjs';

const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export function points(files, key, outputs) {
  const image = decodePng(files['image.png']);
  if (!image.ok) throw new Error(`the instance's image.png does not read: ${image.why}`);
  if (image.width !== key.width || image.height !== key.height) throw new Error("the instance's image.png and its key disagree on the size");
  if (!(key.floor_bytes > key.target_bytes)) throw new Error("the instance's key has no floor above its target");
  const answer = outputs['image.png'];
  const read = decodePng(answer, { width: key.width, height: key.height });
  if (!read.ok) return { points: 0, valid: false, detail: `image.png is not a PNG the contest reads: ${read.why}` };
  const a = read.rgba;
  const b = image.rgba;
  let differ = 0;
  let first = -1;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) {
      if (first < 0) first = i / 4;
      differ++;
    }
  }
  if (differ > 0) return { points: 0, valid: true, detail: `${grouped(differ)} pixels differ from the image, the first at (${first % key.width}, ${Math.floor(first / key.width)})` };
  const bytes = answer.length;
  const share = Math.min(1, Math.max(0, (key.floor_bytes - bytes) / (key.floor_bytes - key.target_bytes)));
  return { points: 1000 * share, valid: true, detail: `exact, ${grouped(bytes)} bytes (floor ${grouped(key.floor_bytes)}, target ${grouped(key.target_bytes)}, scale ${grouped(key.scale_bytes)})` };
}
