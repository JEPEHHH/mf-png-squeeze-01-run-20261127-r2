// fixed-paeth's encoder, derived from pngjs 7.0.0 (MIT; NOTICE): PNG.sync.write's path through lib/packer-sync.js,
// lib/packer.js and lib/filter-pack.js with the options { filterType: 4, deflateLevel: 9, deflateStrategy: 0 }. So:
// colour type 6 (RGBA) whatever the image holds, every row filtered by Paeth (filter-pack.js filterPaeth, one filter
// throughout: no per-row choice), the filtered rows deflated in one call at level 9 with zlib's default strategy
// (pngjs's own default strategy is 3, Z_RLE, which writes files several times larger here), and one IDAT between IHDR
// and IEND (packer-sync.js). png.mjs writes the chunks.

import { deflateSync } from 'node:zlib';
import { ihdrOf, pngOf } from './png.mjs';

/** pngjs's paeth-predictor.js. */
function paethPredictor(left, above, upLeft) {
  const paeth = left + above - upLeft;
  const pLeft = Math.abs(paeth - left);
  const pAbove = Math.abs(paeth - above);
  const pUpLeft = Math.abs(paeth - upLeft);
  if (pLeft <= pAbove && pLeft <= pUpLeft) return left;
  if (pAbove <= pUpLeft) return above;
  return upLeft;
}

/** filter-pack.js's filterPaeth over one row: pxData from pxPos, byteWidth bytes, into rawData from rawPos. */
function filterPaeth(pxData, pxPos, byteWidth, rawData, rawPos, bpp) {
  for (let x = 0; x < byteWidth; x++) {
    const left = x >= bpp ? pxData[pxPos + x - bpp] : 0;
    const up = pxPos > 0 ? pxData[pxPos + x - byteWidth] : 0;
    const upleft = pxPos > 0 && x >= bpp ? pxData[pxPos + x - (byteWidth + bpp)] : 0;
    rawData[rawPos + x] = pxData[pxPos + x] - paethPredictor(left, up, upleft);
  }
}

/** filter-pack.js's module function with filterType 4: each row behind its filter byte, 4. */
function filterData(pxData, width, height, bpp) {
  const byteWidth = width * bpp;
  const rawData = new Uint8Array((byteWidth + 1) * height);
  let rawPos = 0;
  let pxPos = 0;
  for (let y = 0; y < height; y++) {
    rawData[rawPos] = 4;
    rawPos++;
    filterPaeth(pxData, pxPos, byteWidth, rawData, rawPos, bpp);
    rawPos += byteWidth;
    pxPos += byteWidth;
  }
  return rawData;
}

/** The PNG fixed-paeth writes for an RGBA image. */
export function pack(rgba, width, height) {
  const compressed = deflateSync(filterData(rgba, width, height, 4), { chunkSize: 32 * 1024, level: 9, strategy: 0 });
  return pngOf([
    ['IHDR', ihdrOf(width, height, 6)],
    ['IDAT', new Uint8Array(compressed)],
    ['IEND', new Uint8Array(0)],
  ]);
}
