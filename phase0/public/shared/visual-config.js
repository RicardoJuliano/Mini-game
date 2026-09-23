// Visual/world/HUD tunables — kept separate from protocol.js (input/vehicle physics)
// so nothing here can accidentally affect steering or the network protocol.
(function (global) {
  const PALETTE = {
    ink: "#241934",
    mint: "#2fe6a0",
    coral: "#ff5d3a",
    sun: "#ffd23f",
    chalk: "#fff4e6",
    asphalt: "#3b3350",
    dusk: "#8a5fbf",
  };

  // Technical layout (plan v3 §5.1): a long straight, a fast sweeper, a chicane,
  // an S-section and a hairpin — the old loop could be driven flat-out with no braking.
  const TRACK = {
    points: [
      [-60, -60], [20, -62], [70, -55],
      [90, -35], [85, -10],
      [60, 0], [55, 15],
      [75, 30], [80, 55], [60, 70],
      [35, 62], [30, 40], [10, 35],
      [-20, 55], [-50, 60],
      [-75, 40], [-80, 0], [-70, -40],
    ],
    roadWidth: 8.5, // ~4 kart widths; was 12 (drivable flat-out, no line discipline needed)
    curbWidth: 1.2,
    samples: 500,   // longer track than before, keep sample spacing similar
    laps: 3,
  };

  const WORLD = {
    wallDist: 2.5,          // was 5 — less room to cut corners (plan v3 §5.2)
    offroadSpeedMul: 0.35,  // was 0.5 (plan v3 §5.2)
    treeCount: 90,
    barrierSpacing: 6,      // world units between tire-barrier stacks on outer corners
    treeRadiusMin: 14,      // trees fill the infield too, not just the outer ring
    treeRadiusMax: 150,
  };

  const HUD = {
    kmhPerUnit: 4.2,        // cosmetic: MAX_FWD (26 units/s) reads as ~110 km/h, boost ~140
    countdownMs: 3000,
    resultsRestartDelayMs: 1500,
  };

  const VFX = {
    dustMax: 200,
    skidMax: 300,
    dustLifeSec: 0.6,
    skidLifeSec: 4,
  };

  // Chase camera feel (plan v3 §2.2)
  const CAMERA = {
    followHeight: 2.2,       // was 3.0 — lower reads as faster
    followDist: 5.6,         // was 6.2
    lookAhead: 4,            // look at a point this far ahead of the kart, not the kart itself
    restFov: 68,
    topFov: 88,
    boostFov: 98,
    fovSpring: 4,            // spring rate for FOV changes (was an instant per-frame lerp)
    pullback: 1.2,           // extra follow distance at top speed
    pullbackSpring: 3.5,
    rumbleMaxSpeedFrac: 0.6, // rumble starts above this fraction of top speed
    rumbleMax: 0.04,
    rollMaxDeg: 3,           // camera bank into the turn, degrees at full steer+speed
  };

  // Optical-flow trackside props (plan v3 §2.3)
  const FLOW = {
    fencePostSpacing: 3.5,
    fencePostOffset: 1.6,    // distance outside the curb
    distanceMarkerEvery: 50, // world units (approximated via sample stride)
  };

  // Drift + mini-turbo (plan v3 §5.4) — reuses the existing GAS/BRAKE buttons, no new input.
  const DRIFT = {
    steerThreshold: 0.35,
    speedThreshold: 0.5,   // fraction of MAX_FWD required to start a drift
    turnRateBonus: 1.3,
    speedDecay: 6,          // units/sec^2 lost while drifting
    bodyAngleDeg: 28,
    chargeRate: 1,          // charge seconds accumulate 1:1 with real time while drifting
    tiers: [
      { minCharge: 0.6, boostMul: 1.15, boostDur: 0.5, color: "#4d8dff" },
      { minCharge: 1.2, boostMul: 1.25, boostDur: 0.8, color: "#ffd23f" },
      { minCharge: 2.0, boostMul: 1.35, boostDur: 1.2, color: "#c04dff" },
    ],
  };

  // Boost pads + medal targets (plan v3 §5.5)
  const BOOST_PADS = {
    // [sampleIndexFraction, lateral offset from center line] — off the obvious racing line
    spots: [[0.28, 2.2], [0.62, -2.0]],
    speedMul: 1.3,
    duration: 0.8,
  };

  const api = { PALETTE, TRACK, WORLD, HUD, VFX, CAMERA, FLOW, DRIFT, BOOST_PADS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.TiltVisualConfig = api;
})(typeof window !== "undefined" ? window : globalThis);
