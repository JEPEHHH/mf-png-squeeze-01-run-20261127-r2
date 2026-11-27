// png-squeeze-01's generator (scripts/releases/new-solver-home.ts's contract): instance k of a set is one procedural
// desktop screenshot of 1280 x 720 RGBA8 (screen.mjs), of theme THEMES[k % 4] (flat, rich, alpha, grey), so a set of 8
// holds two of each. No corpus: every pixel is drawn from the instance's stream.
//
// image.png is the screenshot as a stored PNG (png.mjs storedPng: colour type 6, every row unfiltered, the zlib stream
// in stored blocks), the one file an entry reads. The key states what the checker scores it by:
//   scale_bytes   the bytes of the scale's PNG of the image (scale.mjs scalePng: palette and colour-type reduction,
//                 fixed and adaptive filters but brute force, the smallest by zlib at level 6, in that zlib stream),
//                 a compressor of bounded cost, so the draw stays well inside its wall
//   floor_bytes   FLOOR_TIMES x scale_bytes: an answer this large or larger earns 0 points
//   target_bytes  TARGET_SHARE x scale_bytes, rounded down: an answer this small or smaller earns 1,000
//   stored_bytes  image.png's own bytes, for the record
// The points run straight from 0 at the floor to 1,000 at the target, so a file of the scale's own bytes earns
// 1,000 x (FLOOR_TIMES - 1) / (FLOOR_TIMES - TARGET_SHARE) of 1,000. The reference (reference/squeeze.mjs: the same
// screen with brute force, its winner in its own optimal-parsing deflate) never writes more than the scale, so it
// earns that or more on every image; it is not run here.

import { storedPng } from './png.mjs';
import { scalePng } from './scale.mjs';
import { paint, THEMES } from './screen.mjs';

/** The floor, as a multiple of the scale's bytes. */
export const FLOOR_TIMES = 2;
/** The target, as a share of the scale's bytes. */
export const TARGET_SHARE = 0.5;

export function generate(rng, index) {
  const theme = THEMES[index % THEMES.length];
  const { rgba, width, height } = paint(rng, theme);
  const stored = storedPng(rgba, width, height);
  const scale = scalePng(rgba, width, height).length;
  return {
    files: { 'image.png': stored },
    key: { width, height, theme, stored_bytes: stored.length, scale_bytes: scale, floor_bytes: FLOOR_TIMES * scale, target_bytes: Math.floor(TARGET_SHARE * scale) },
  };
}
