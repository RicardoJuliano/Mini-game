# Third-party assets

## Kenney Racing Kit
- Source: https://kenney.nl/assets/racing-kit
- Author: Kenney (www.kenney.nl)
- License: CC0 (public domain, no attribution required — credited here anyway)
- Files used (`phase0/public/shared/models/`):
  - `grandStand.glb` — tiled to build the start/finish grandstand
  - `tentRoofDouble.glb` — pit-lane tent landmark
  - `flagCheckers.glb` — checkered corner flags
- Not used from the pack: the road tile set (our track is a procedural spline, not
  tile-based), the pack's race car models (kept our own animated procedural kart —
  it already has working suspension/drift/boost rigging that a swap would have had
  to rebuild blind, with no way to visually verify the result), and its nature/tree
  models (our own instanced, swaying trees already work).
- Recoloring: the pack's materials are flat, unlit, and named ("grey", "red",
  "grass", ...) — see `KENNEY_RECOLOR` in `host.js`. Only "grey" → chalk, "red" →
  coral, and "grass" → mint were retargeted to the mood-board palette; "road" and
  "glass" were left as shipped to limit the blast radius of a recolor pass done
  without being able to see the result.

## three.js
- Source: https://github.com/mrdoob/three.js (r128, `examples/js/`)
- License: MIT
- Vendored files: `three.min.js`, `loaders/GLTFLoader.js`, and the
  `postprocessing/` + shader addons — see `phase0/public/shared/`.

## qrcode-generator
- Source: https://github.com/kazuhikoarase/qrcode-generator
- Author: Kazuhiko Arase
- License: MIT

## Lilita One
- Source: Google Fonts (https://fonts.google.com/specimen/Lilita+One)
- License: SIL Open Font License
