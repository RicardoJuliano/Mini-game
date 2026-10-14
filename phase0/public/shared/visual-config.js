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

  // Unified boost system (plan v4 §3.1): every boost source (mini-turbo tiers, pads,
  // rocket start, slipstream) goes through the same applyBoost()/soft-cap machinery in
  // host.js, instead of each source hand-rolling its own speed clamp.
  const BOOST = {
    sources: {
      mt1: { mul: 1.15, dur: 0.7, impulse: 3, color: "#4d8dff" },   // blue mini-turbo
      mt2: { mul: 1.22, dur: 1.1, impulse: 4, color: "#ffb02e" },   // orange
      mt3: { mul: 1.30, dur: 1.6, impulse: 5, color: "#c04dff" },   // purple
      pad: { mul: 1.30, dur: 1.0, impulse: 6, color: "#ffd23f" },
      rocket: { mul: 1.25, dur: 1.2, impulse: 8, color: "#ffffff" },
      draft: { mul: 1.10, dur: 1.0, impulse: 2, color: "#bfe6ff" },
    },
    propel: 40,           // units/s^2 pushed forward while boosting, gas held or not
    overspeedDecay: 9,    // units/s^2 back down to the normal cap after a boost (no hard clamp)
    offroadDecay: 30,     // units/s^2 down to the off-road cap when not boosting
    chainBonus: 0.25,     // extra seconds when a boost starts while another is already active
    gripMul: 1.15,        // a bit more grip while boosting
    ignoresOffroad: true, // boosting through grass keeps full speed (risk/reward)
  };

  // Drift + mini-turbo (plan v4 §3.2) — reuses the existing GAS/BRAKE buttons, no new input.
  const DRIFT = {
    steerThreshold: 0.35,
    speedThreshold: 0.5,   // fraction of MAX_FWD required to start a drift
    turnRateBonus: 1.3,
    speedDecay: 4,          // units/sec^2 lost while drifting (was 6 — a long drift shouldn't be a trap)
    minSpeedFrac: 0.45,     // drift self-cancels (no boost) if speed drops below this fraction of max
    bodyAngleDeg: 28,
    hopAmp: 0.15, hopDur: 0.18, // visual-only hop at drift start
    tiers: [
      { minCharge: 0.7, source: "mt1" },
      { minCharge: 1.4, source: "mt2" },
      { minCharge: 2.2, source: "mt3" },
    ],
  };

  // Boost pads (plan v4 §3.3): track-space hitbox (trackIdx + lateral), not a world-space
  // circle — a circle on a 1.6x2.4 pad offset 2.2 off-center was easy to miss visually.
  const BOOST_PADS = {
    // [sampleIndexFraction, lateral offset from center line]
    spots: [[0.1, 2.6], [0.28, 2.2], [0.5, -2.6], [0.62, -2.0]],
    halfLen: 2.0, halfWidth: 1.5 + 0.6, // track-space box half-extents for the hitbox
    cooldownMs: 800,       // per kart, not per pad
  };

  // Rocket start (plan v4 §3.4)
  const ROCKET_START = {
    windowMs: 350,     // gas pressed in the last N ms before GO => rocket
    stallMinMs: 1000,  // gas pressed before this => too early, risk of stall
    stallDurSec: 0.6,
  };

  // Slipstream / draft (plan v4 §3.5)
  const DRAFT = {
    minDist: 2, maxDist: 10, maxLateral: 1.6, // cone behind another kart that counts as drafting
    minSpeedFrac: 0.7,
    buildRate: 1, decayRate: 2, // draft meter units/sec
    triggerAt: 1.0,
  };

  // Kart-to-kart collisions (plan v4 §5.1): simple circle-circle push-apart between
  // the player and bots, and bots against each other.
  const KART = {
    radius: 0.9,       // collision circle radius, world units
    speedLoss: 0.12,   // fraction of speed each kart sheds on contact
    shakeOnHit: 0.12,
  };

  // Light rubber-banding (plan §5, "tech stack" row): bots a bit faster when trailing
  // the player, a bit slower when well ahead — keeps the pack close without being
  // unfair, measured off the same unwrapped lapProgress used for lap counting.
  const RUBBER_BAND = {
    gapNorm: 70,    // lapProgress units (track samples) for the full effect to kick in
    maxBoost: 0.06, // bot trailing by gapNorm or more: up to +6% target speed
    maxSlow: 0.05,  // bot leading by gapNorm or more: up to -5% target speed
  };

  const api = { PALETTE, TRACK, WORLD, HUD, VFX, CAMERA, FLOW, BOOST, DRIFT, BOOST_PADS, ROCKET_START, DRAFT, KART, RUBBER_BAND };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.TiltVisualConfig = api;
})(typeof window !== "undefined" ? window : globalThis);
