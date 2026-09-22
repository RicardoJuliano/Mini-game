// Shared between controller.html and host.html.
// Keeps input shaping identical on both ends and defines the wire format.
(function (global) {
  const MAX_ANGLE = 90; // degrees of phone rotation mapped to full steering lock
  const DEAD_ZONE = 0.04; // ignore the innermost 4% of the range
  const CURVE_EXPONENT = 1.5; // >1 => small corrections are more precise, full lock still reachable

  function wrap180(deg) {
    let d = deg % 360;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d;
  }

  // Maps a normalized [-1, 1] raw value through dead zone + response curve.
  function shape(raw) {
    const clamped = Math.max(-1, Math.min(1, raw));
    const mag = Math.abs(clamped);
    if (mag < DEAD_ZONE) return 0;
    const rescaled = (mag - DEAD_ZONE) / (1 - DEAD_ZONE);
    const shaped = Math.pow(rescaled, CURVE_EXPONENT);
    return Math.sign(clamped) * shaped;
  }

  // buttons bitmask
  const BUTTONS = { GAS: 1 << 0, BRAKE: 1 << 1, DRIFT: 1 << 2, ITEM: 1 << 3, PAUSE: 1 << 4 };

  // Complementary filter: gyro for responsiveness, gravity vector to correct drift.
  // Returns a new fused angle (degrees, wrapped to [-180, 180], relative to `center`).
  function fuseAngle(prevAngle, gyroAlphaDegPerSec, dt, gravity, center) {
    const gyroAngle = prevAngle + (gyroAlphaDegPerSec || 0) * dt;
    let tiltAngle = prevAngle;
    if (gravity && (gravity.x !== null || gravity.y !== null)) {
      const rawDeg = (Math.atan2(gravity.y || 0, gravity.x || 0) * 180) / Math.PI;
      tiltAngle = wrap180(rawDeg - center);
    }
    const gMag = gravity ? Math.hypot(gravity.x || 0, gravity.y || 0, gravity.z || 0) : 9.81;
    const trust = 0.02 * Math.min(1, gMag / 9.81);
    return wrap180((1 - trust) * gyroAngle + trust * tiltAngle);
  }

  function encodeInput(seq, steerNormalized, buttons) {
    const steer16 = Math.round(Math.max(-1, Math.min(1, steerNormalized)) * 32767);
    return { type: 1, seq, steer: steer16, buttons: buttons | 0, t: Date.now() };
  }

  const api = { MAX_ANGLE, DEAD_ZONE, CURVE_EXPONENT, wrap180, shape, fuseAngle, encodeInput, BUTTONS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.TiltProtocol = api;
})(typeof window !== "undefined" ? window : globalThis);
