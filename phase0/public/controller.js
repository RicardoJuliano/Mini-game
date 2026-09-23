const P = TiltProtocol;
const startScreen = document.getElementById("screen");
const deniedScreen = document.getElementById("denied-screen");
const wheelView = document.getElementById("wheel-view");
const rotateOverlay = document.getElementById("rotate-overlay");
const wheelGraphic = document.getElementById("wheel-graphic");
const debugReadout = document.getElementById("debug-readout");
const connBadge = document.getElementById("conn-badge");
const DEBUG = new URLSearchParams(location.search).has("debug");
if (DEBUG) debugReadout.style.display = "block";

// --- lateral-tilt-only steering (task 3): pitch never reaches `steer` ---
const tiltFilter = new P.OneEuro();
let center = 0;
let lastGravity = null;
let rawTiltDeg = 0, filteredTiltDeg = 0;
let steer = 0;
let isPortrait = true;
let seq = 0;

function onMotion(e) {
  const g = e.accelerationIncludingGravity;
  if (!g || g.x == null) return;
  lastGravity = g;

  if (isPortrait) { steer = 0; return; }

  rawTiltDeg = P.lateralTiltDeg(g);
  filteredTiltDeg = tiltFilter.filter(rawTiltDeg, performance.now() / 1000);
  const x = Math.max(-1, Math.min(1, (filteredTiltDeg - center) / P.TILT_CONFIG.MAX_TILT));
  steer = P.shape(x);
  wheelGraphic.style.transform = `rotate(${steer * 90}deg)`;
}

function recenter() {
  if (lastGravity) center = P.lateralTiltDeg(lastGravity);
}
document.getElementById("center-btn").addEventListener("click", recenter);

// --- orientation: landscape only, steer forced to 0 in portrait ---
function updateOrientationState() {
  isPortrait = window.innerHeight > window.innerWidth;
  rotateOverlay.style.display = isPortrait ? "flex" : "none";
  if (isPortrait) steer = 0;
  else recenter();
}
window.addEventListener("resize", updateOrientationState);
if (screen.orientation) screen.orientation.addEventListener("change", updateOrientationState);
else window.addEventListener("orientationchange", updateOrientationState);

// --- pedals: Pointer Events with capture, so multi-touch works and a finger
// sliding off (or the app losing focus) never leaves a button stuck ---
const held = { gas: new Set(), brake: new Set() };
function bindPedal(el, key) {
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    held[key].add(e.pointerId);
    el.classList.add("pressed");
  });
  const up = (e) => {
    held[key].delete(e.pointerId);
    if (held[key].size === 0) el.classList.remove("pressed");
  };
  ["pointerup", "pointercancel", "lostpointercapture"].forEach((t) => el.addEventListener(t, up));
}
function releaseAll() {
  held.gas.clear();
  held.brake.clear();
  document.querySelectorAll(".pressed").forEach((el) => el.classList.remove("pressed"));
}
function buttonsMask() {
  return (held.gas.size ? P.BUTTONS.GAS : 0) | (held.brake.size ? P.BUTTONS.BRAKE : 0);
}
bindPedal(document.getElementById("gas"), "gas");
bindPedal(document.getElementById("brake"), "brake");
window.addEventListener("blur", releaseAll);

// --- wake lock ---
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
  } catch { /* not fatal for the spike */ }
}

// --- websocket ---
// Protocol-relative: the page is HTTPS on-device, so the socket must be WSS,
// and it must never say "localhost" — that resolves to the phone itself, not the host.
let ws, reconnectAttempts = 0;
function connect() {
  if (ws && ws.readyState <= 1) return; // already connecting/connected
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${scheme}://${location.host}`);
  ws.addEventListener("open", () => {
    reconnectAttempts = 0;
    ws.send(JSON.stringify({ type: "hello", role: "controller" }));
    connBadge.textContent = "connected";
  });
  ws.addEventListener("close", () => {
    connBadge.textContent = "reconnecting…";
    const delay = Math.min(1000 * 2 ** reconnectAttempts++, 8000);
    setTimeout(connect, delay);
  });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "host-ready") connBadge.textContent = "connected";
  });
}

// The phone suspends the WS (and can leave pedals "stuck") when the screen locks
// or the player switches apps; reconnect and clear input as soon as it's visible again.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    releaseAll();
  } else if (wheelView.style.display !== "none") {
    requestWakeLock();
    connect();
  }
});

// --- send loop, ~60Hz ---
function sendLoop() {
  const btns = buttonsMask();
  if (ws && ws.readyState === ws.OPEN) {
    const packet = P.encodeInput(seq++, steer, btns);
    packet.type = "input";
    ws.send(JSON.stringify(packet));
  }
  if (DEBUG) {
    debugReadout.textContent =
      `raw=${rawTiltDeg.toFixed(1)}° filt=${filteredTiltDeg.toFixed(1)}°\n` +
      `steer=${steer.toFixed(3)} buttons=${btns}`;
  }
  setTimeout(sendLoop, 1000 / 60);
}

// --- start flow ---
async function startEngine() {
  // iOS requires this permission request to originate from a user gesture,
  // with nothing awaited before it — so it must be the very first thing here.
  if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
    let result = "denied";
    try {
      result = await DeviceMotionEvent.requestPermission();
    } catch { /* treated as denied below */ }
    if (result !== "granted") {
      startScreen.style.display = "none";
      deniedScreen.style.display = "flex";
      return;
    }
  }
  window.addEventListener("devicemotion", onMotion);
  requestWakeLock();
  if (document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(() => {});
  }
  if (screen.orientation && screen.orientation.lock) {
    screen.orientation.lock("landscape").catch(() => {});
  }
  startScreen.style.display = "none";
  deniedScreen.style.display = "none";
  wheelView.style.display = "block";
  updateOrientationState();
  connect();
  sendLoop();
}
document.getElementById("start-btn").addEventListener("click", startEngine);
document.getElementById("retry-btn").addEventListener("click", startEngine);
