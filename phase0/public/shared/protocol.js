// Shared between controller.html and host.html: tunable constants (section 8 of the
// steering/pedals spec), steering math, and the wire-packet helpers.
(function (global) {
  const TILT_CONFIG = {
    MAX_TILT: 50,             // degrees of sideways tilt for full lock (player setting, 30-80)
    DEAD_ZONE: 0.05,          // ignore tiny tilts
    CURVE: 1.3,               // >1 = finer control near center
    ONE_EURO_MIN_CUTOFF: 1.0, // lower = smoother when the phone is nearly still
    ONE_EURO_BETA: 0.02,      // higher = less lag on fast turns
    ONE_EURO_D_CUTOFF: 1.0,
  };

  const VEHICLE_CONFIG = {
    MAX_FWD: 26,        // units/sec — raised from 14: at the old speed nothing looked like it was moving
    MAX_REV: 7,         // units/sec (~27% of forward)
    ACCEL: 30,          // reaches top speed in ~1.2s
    BRAKE: 30,
    REV_ACCEL: 10,
    COAST: 10,          // rolling friction when nothing is held
    STOP_EPS: 0.2,      // "stopped" threshold
    REVERSE_DELAY: 0.2, // seconds holding brake at standstill before reverse kicks in
    TURN_RATE: 2.6,     // rad/sec at REF_SPEED — a touch higher so corners stay possible at the new speed
    REF_SPEED: 9,       // speed at which steering reaches full TURN_RATE
    LAT_GRIP: 30,       // max lateral accel (units/s^2); caps yaw rate so tight corners need braking (B5)
    DRIFT_GRIP_MUL: 1.3, // drifting raises the grip limit, so a good drift beats braking through a corner
  };

  const BUTTONS = { GAS: 1 << 0, BRAKE: 1 << 1, DRIFT: 1 << 2, ITEM: 1 << 3, PAUSE: 1 << 4 };

  // Dead zone + response curve so small corrections are precise and full lock is still reachable.
  function shape(raw, deadZone, curve) {
    deadZone = deadZone === undefined ? TILT_CONFIG.DEAD_ZONE : deadZone;
    curve = curve === undefined ? TILT_CONFIG.CURVE : curve;
    const clamped = Math.max(-1, Math.min(1, raw));
    const mag = Math.abs(clamped);
    if (mag < deadZone) return 0;
    const rescaled = (mag - deadZone) / (1 - deadZone);
    return Math.sign(clamped) * Math.pow(rescaled, curve);
  }

  function encodeInput(seq, steerNormalized, buttons) {
    const steer16 = Math.round(Math.max(-1, Math.min(1, steerNormalized)) * 32767);
    return { type: 1, seq, steer: steer16, buttons: buttons | 0, t: Date.now() };
  }

  // --- lateral-tilt-only steering ---
  // Sideways tilt is read from the gravity component along the phone's horizontal
  // screen axis. Tilting forward/backward rotates the phone around that same axis,
  // so that component doesn't change — steering is immune to pitch with no extra logic.
  const IS_IOS = typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function";

  function screenAngle() {
    const a = (typeof screen !== "undefined" && screen.orientation)
      ? screen.orientation.angle
      : (typeof window !== "undefined" ? window.orientation : 0) || 0;
    return ((a % 360) + 360) % 360;
  }

  // Returns sideways tilt in degrees: 0 = level, positive = tilted right.
  // iOS Safari reports accelerationIncludingGravity with the opposite sign of Android
  // Chrome; the iOS permission API only exists on iOS, so it doubles as the platform check.
  function lateralTiltDeg(g) {
    const s = IS_IOS ? -1 : 1;
    const gx = s * (g.x || 0), gy = s * (g.y || 0), gz = s * (g.z || 0);
    const mag = Math.hypot(gx, gy, gz) || 9.81;
    const a = screenAngle();
    const lateral = a === 90 ? -gy : a === 270 ? gy : a === 180 ? -gx : gx;
    return (Math.asin(Math.max(-1, Math.min(1, lateral / mag))) * 180) / Math.PI;
  }

  // --- One Euro filter: smooths hand shake when still, stays responsive on fast turns ---
  class LowPass {
    constructor() { this.y = null; }
    filter(x, a) { this.y = this.y === null ? x : a * x + (1 - a) * this.y; return this.y; }
  }

  class OneEuro {
    constructor(minCutoff, beta, dCutoff) {
      this.minCutoff = minCutoff === undefined ? TILT_CONFIG.ONE_EURO_MIN_CUTOFF : minCutoff;
      this.beta = beta === undefined ? TILT_CONFIG.ONE_EURO_BETA : beta;
      this.dCutoff = dCutoff === undefined ? TILT_CONFIG.ONE_EURO_D_CUTOFF : dCutoff;
      this.x = new LowPass();
      this.dx = new LowPass();
      this.last = null;
    }
    alpha(cutoff, dt) {
      const tau = 1 / (2 * Math.PI * cutoff);
      return 1 / (1 + tau / dt);
    }
    filter(value, t) {
      const dt = this.last === null ? 1 / 60 : Math.max(1e-3, t - this.last);
      this.last = t;
      const prev = this.x.y === null ? value : this.x.y;
      const d = this.dx.filter((value - prev) / dt, this.alpha(this.dCutoff, dt));
      const cutoff = this.minCutoff + this.beta * Math.abs(d);
      return this.x.filter(value, this.alpha(cutoff, dt));
    }
  }

  const api = {
    TILT_CONFIG, VEHICLE_CONFIG, BUTTONS,
    shape, encodeInput,
    lateralTiltDeg, screenAngle,
    OneEuro, LowPass,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.TiltProtocol = api;
})(typeof window !== "undefined" ? window : globalThis);
