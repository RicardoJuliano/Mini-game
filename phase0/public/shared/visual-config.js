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
    // Re-tuned from the original layout (B4): the chicane at (55,15) had a 5.5-radius
    // corner against a 6.45 inner-curb offset, folding the ribbon geometry over itself
    // (confirmed z-fighting flicker there). Every corner here is >=10.3 radius.
    points: [
      [-59, -60], [20, -62], [70, -55],
      [90, -35], [84, -19],
      [57, -2], [54, 11],
      [70, 33], [80, 55], [61, 76],
      [40, 68], [30, 40], [8, 32],
      [-21, 55], [-51, 63],
      [-75, 40], [-78, 0], [-70, -40],
    ],
    roadWidth: 10.5, // eased back up from 8.5 — that was too punishing for a first playtest
    curbWidth: 1.2,
    samples: 500,   // longer track than before, keep sample spacing similar
    laps: 3,
  };

  const WORLD = {
    wallDist: 4,            // eased back up from 2.5 — walls were too close to the road edge
    offroadSpeedMul: 0.5,   // eased back up from 0.35 — off-road was cutting speed too hard
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

  // Chase camera feel (plan v3 §2.2, re-tuned for the B3 kart-relative rig — see host.js).
  // The old lerp-follow rig lagged by speed/rate (~8.7 units at top speed under the old
  // rate of 3), which is what actually read as "camera far away when accelerating" —
  // not the base distances themselves. The rig no longer lags position, only yaw, so
  // these numbers are the camera's real, full-time distance from the kart.
  const CAMERA = {
    followHeight: 1.8,
    followDist: 4.2,
    lookAhead: 4.0,          // look at a point this far ahead of the kart, not the kart itself
    yawSpring: 5,            // only the camera's yaw lags now, not its position
    restFov: 65,
    topFov: 82,
    boostFov: 92,
    fovSpring: 4,            // spring rate for FOV changes (was an instant per-frame lerp)
    pullback: 1.0,           // extra follow distance at top speed (intentional, on top of followDist)
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
