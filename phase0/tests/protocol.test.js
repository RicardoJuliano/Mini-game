const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../public/shared/protocol.js");

test("shape(): dead zone returns 0", () => {
  assert.equal(P.shape(0.02), 0);
  assert.equal(P.shape(-0.02), 0);
});

test("shape(): full deflection maps to +/-1", () => {
  assert.equal(P.shape(1), 1);
  assert.equal(P.shape(-1), -1);
});

test("shape(): monotonic for positive input", () => {
  const a = P.shape(0.3), b = P.shape(0.6), c = P.shape(0.9);
  assert.ok(a < b && b < c);
});

test("lateralTiltDeg(): level phone (gravity straight down) reads ~0", () => {
  // At screen angle 0, lateral = gx. A level phone in landscape has gx ~ 0.
  const deg = P.lateralTiltDeg({ x: 0, y: 0, z: 9.81 });
  assert.ok(Math.abs(deg) < 1, `expected ~0, got ${deg}`);
});

test("lateralTiltDeg(): sideways tilt gives a non-zero, bounded result", () => {
  const deg = P.lateralTiltDeg({ x: 5, y: 0, z: 8.4 });
  assert.ok(Math.abs(deg) > 1 && Math.abs(deg) <= 90);
});

test("OneEuro: constant input converges to that value", () => {
  const f = new P.OneEuro();
  let v = 0;
  for (let i = 0; i < 30; i++) v = f.filter(10, i * (1 / 60));
  assert.ok(Math.abs(v - 10) < 0.01, `expected ~10, got ${v}`);
});

test("OneEuro: follows a step input within a bounded number of frames", () => {
  const f = new P.OneEuro();
  let t = 0;
  for (let i = 0; i < 10; i++) { f.filter(0, t); t += 1 / 60; }
  let v = 0, settledAt = -1;
  for (let i = 0; i < 60; i++) {
    v = f.filter(10, t);
    t += 1 / 60;
    if (settledAt < 0 && Math.abs(v - 10) < 0.5) settledAt = i;
  }
  assert.ok(settledAt >= 0 && settledAt < 50, `did not settle in time (settledAt=${settledAt})`);
});

test("encodeInput(): clamps steer to [-1, 1] before scaling to int16", () => {
  assert.equal(P.encodeInput(0, 2, 0).steer, 32767);
  assert.equal(P.encodeInput(0, -2, 0).steer, -32767);
});
