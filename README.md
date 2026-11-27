# png-squeeze entry

Lossless PNG re-encoder for Node 22. Reads every screenshot under
`/input/<id>/image.png`, decodes it with a self-contained PNG reader, then
writes the smallest valid re-encoding to `/output/<id>/image.png`.

No dependencies, no network, no binaries: only `node:fs`, `node:path` and
`node:zlib`.

The encoder tries grey, grey+alpha, RGB, RGB+tRNS, RGBA and indexed palette
representations where lossless, and for each one searches fixed filters (0-4)
plus three per-row heuristics (minimum absolute sum, distinct bytes, entropy)
across all five zlib strategies at level 9, with a memLevel 9 refinement of
the three best combinations. The smallest candidate wins.

Run locally:

    MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts

Licensed under MIT, see LICENSE.
