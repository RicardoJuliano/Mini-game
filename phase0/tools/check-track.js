// node tools/check-track.js
// Fails the build if any corner is tighter than radius 10, or if two non-adjacent
// sections of the track pass close enough to overlap each other's wall/prop zone.
global.window = global;
const THREE = require("../public/shared/three.min.js");
const { TRACK, WORLD } = require("../public/shared/visual-config.js");

const N = TRACK.samples;
const curve = new THREE.CatmullRomCurve3(TRACK.points.map(([x, z]) => new THREE.Vector3(x, 0, z)), true, "centripetal");
const s = curve.getSpacedPoints(N), tg = s.map((_, i) => curve.getTangentAt(i / N)), L = curve.getLength();

let minR = Infinity, at = null;
for (let i = 0; i < N; i++) {
  const ang = Math.acos(Math.min(1, tg[(i + N - 1) % N].dot(tg[(i + 1) % N])));
  const r = (2 * L / N) / Math.max(ang, 1e-9);
  if (r < minR) { minR = r; at = s[i]; }
}
const zone = TRACK.roadWidth / 2 + TRACK.curbWidth + WORLD.wallDist;
let minSep = Infinity;
for (let i = 0; i < N; i += 2) {
  for (let j = i + 60; j < N; j += 2) {
    if (N - (j - i) < 60) continue;
    minSep = Math.min(minSep, s[i].distanceTo(s[j]));
  }
}

console.log(`length ${L.toFixed(0)}  min radius ${minR.toFixed(1)} at (${at.x.toFixed(0)}, ${at.z.toFixed(0)})  min separation ${minSep.toFixed(1)}`);
let failed = false;
if (minR < 10) { console.error("FAIL: corner tighter than radius 10"); failed = true; }
if (minSep < 2 * zone + 2) { console.error("FAIL: track sections overlap"); failed = true; }
if (failed) process.exit(1);
