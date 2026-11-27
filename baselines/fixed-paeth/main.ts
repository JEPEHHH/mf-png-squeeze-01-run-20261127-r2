// make.fun's own fixed-paeth 1.0.0, png-squeeze-01's house baseline: every screenshot written as an RGBA PNG, each
// row filtered by Paeth, zlib level 9 (pack.mjs, derived from pngjs 7.0.0, MIT, Luke Page and Kuba Niegowski; NOTICE).
// No colour-type reduction, no palette, no per-row filter choice. png.mjs is the checker's own decoder.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from './png.mjs';
import { pack } from './pack.mjs';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  if (!image.ok) throw new Error(`${id}/image.png: ${image.why}`);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), pack(image.rgba, image.width, image.height));
}
