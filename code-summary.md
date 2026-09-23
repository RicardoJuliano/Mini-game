# Project Tilt — Code Summary (for AI analysis)

Generated as a snapshot of everything built so far, for an AI reviewer to read and propose improvement projects. Not user-facing documentation — see `project-tilt-plan.md` (full roadmap) and `project-tilt-visual-overhaul.md` (visual/game-feel plan) for product intent; this file describes what actually exists in code today.

## 1. What this is

Project Tilt is a couch-party kart racer: a shared screen runs the game, each player's phone is the controller (tilt to steer, touch zones for gas/brake), no app install. Everything in this repo is **Phase 0** — a technical spike, not a real game. The exit criterion for Phase 0 (from `project-tilt-plan.md`) is: one phone steers a kart placeholder on the host screen, p95 phone-to-host input latency < 30 ms on iOS and Android. Visual/camera work (`project-tilt-visual-overhaul.md` workstream 3.1) and steering/pedal correctness (`steering-and-pedals-spec.md`) have also been layered on top of the spike.

There is no game logic beyond a single kart driving on an empty ground plane: no track, no laps, no items, no other players, no menus.

## 2. Repo layout

```
phase0/
  server.js              Node HTTPS + WebSocket server (single process, single port)
  certs.js                Self-signed TLS cert generation/caching for LAN HTTPS
  package.json / package-lock.json
  public/
    host.html              Game host page: three.js scene, camera, vehicle sim, HUD
    controller.html         Phone controller page: tilt steering, pedals, connection
    shared/
      protocol.js            Shared config + math, loaded by both host and controller
      three.min.js            Vendored three.js r0.128 (no CDN at runtime)
      qrcode.min.js            Vendored qrcode-generator (kazuhikoarase, MIT)
moodboard.html             Visual identity pitch (published as a Claude artifact), not served by the app
project-tilt-plan.md       Original product/architecture plan (see for full context)
project-tilt-visual-overhaul.md   Visual/game-feel workstream plan
steering-and-pedals-spec.md       Spec that drove the current steering/pedal implementation
.gitignore                 Excludes node_modules/ and phase0/certs/ (private keys)
```

No build step. No TypeScript, no bundler, no test framework. Everything is hand-written vanilla JS in `<script>` tags, served as static files.

## 3. Runtime architecture

Single Node process (`server.js`) does three jobs on one HTTPS port (8443):
1. Serves static files from `public/` (hand-rolled, no framework — `fs.readFile` per request, MIME lookup by extension, basic path-traversal guard).
2. Terminates TLS using a self-signed cert from `certs.js`.
3. Runs a `ws` WebSocketServer on the same HTTP(S) server instance, acting as a relay between exactly one "host" connection and one "controller" connection (`room = { host, controller }`, in-memory, no persistence, no auth).

**Why HTTPS at all in a Phase-0 spike:** iOS Safari's `DeviceMotionEvent.requestPermission()` and motion data delivery both require a secure origin. `certs.js` generates a self-signed cert via the `selfsigned` npm package (note: v5.x's `generate()` is `Promise`-based, not sync — this tripped the implementation once, see §6). The cert's SAN list is built from the machine's current LAN IPv4 (`os.networkInterfaces()`), cached to `phase0/certs/{key,cert,meta}.pem` and regenerated automatically if the IP changes or the cert is near its ~350-day expiry. Both `host.html` and `controller.html` pick `wss:`/`ws:` based on `location.protocol` so they never hardcode a scheme.

**No WebRTC.** The original plan (`project-tilt-plan.md` §4) called for WebRTC DataChannels for lower latency, with WebSocket as fallback. The actual implementation only has WebSocket — this was a deliberate simplification for the spike (avoids ICE/STUN/TURN complexity) but means the <30ms p95 target has not been validated against the originally-planned transport.

**Packet format:** JSON text frames, not the 6-byte binary format described in both plan documents. Fields match what the binary format specifies (`type`, `seq`, `steer` as int16 range, `buttons` bitmask) plus a `t` timestamp (`Date.now()`) used for one-way latency estimation. This was a conscious adaptation ("keep the same fields, adapt the format") rather than an oversight, but it costs bandwidth/parsing efficiency the binary format would have kept.

## 4. `phase0/public/shared/protocol.js`

Shared module, loaded via `<script>` tag by both pages (not an ES module — attaches `window.TiltProtocol`). Exports:

- **`TILT_CONFIG`** — `MAX_TILT` (50°), `DEAD_ZONE` (0.05), `CURVE` (1.3), One-Euro filter params (`ONE_EURO_MIN_CUTOFF` 1.0, `ONE_EURO_BETA` 0.02, `ONE_EURO_D_CUTOFF` 1.0).
- **`VEHICLE_CONFIG`** — `MAX_FWD` 14, `MAX_REV` 5, `ACCEL` 18, `BRAKE` 30, `REV_ACCEL` 10, `COAST` 10, `STOP_EPS` 0.2, `REVERSE_DELAY` 0.2s, `TURN_RATE` 2.2 rad/s, `REF_SPEED` 5. All units/sec in the three.js scene, not real-world units — scaled down from the reference spec's m/s values by feel, not measurement.
- **`BUTTONS`** bitmask: `GAS=1, BRAKE=2, DRIFT=4, ITEM=8, PAUSE=16`. Only GAS and BRAKE are wired up anywhere; DRIFT/ITEM/PAUSE are reserved but unused (no drift mechanic, no items, no pause exists yet).
- **`shape(raw, deadZone?, curve?)`** — dead-zone + power-curve response shaping, used for the final steer value.
- **`encodeInput(seq, steerNormalized, buttons)`** — builds the packet object (JSON, see §3).
- **`lateralTiltDeg(g)`** — the core steering-input function. Takes `accelerationIncludingGravity`, reads gravity's component along whichever physical device axis is *currently* the screen's horizontal edge (branches on `screenAngle()` returning 0/90/180/270), so pitch (forward/backward tilt) never contributes to the value by construction — no complementary filter, no gyro (`rotationRate`) involved at all. Applies a `-1` sign flip on iOS (detected via `DeviceMotionEvent.requestPermission` existing) since iOS and Android report `accelerationIncludingGravity` with opposite sign conventions.
- **`screenAngle()`** — normalizes `screen.orientation.angle` / legacy `window.orientation` to `[0, 360)`.
- **`OneEuro` / `LowPass`** classes — One-Euro adaptive low-pass filter (Casiez et al.) smoothing the raw tilt signal: heavier smoothing when the signal is nearly static (reduces hand jitter), lighter smoothing when it's changing fast (reduces perceived lag on quick turns).

Nothing in this file touches rendering, networking framing, or game rules beyond the vehicle tuning constants — it's meant to be the single place tunable feel constants live (`steering-and-pedals-spec.md` §8's "one config file" requirement).

## 5. `phase0/public/controller.html`

Single-file page: inline `<style>`, inline `<script>`, loads `shared/protocol.js`.

**Screens (plain `display` toggling, no router):** start screen (`#screen`, "Tap to start engine" button) → permission-denied screen (`#denied-screen`, shown if iOS motion permission is refused, with instructions to clear Safari site data + a retry button) → portrait rotate-overlay (`#rotate-overlay`, shown whenever `innerHeight > innerWidth`) → the actual wheel view (`#wheel-view`).

**Permission flow:** `startEngine()` is the click handler for both the start button and the retry button. Calls `DeviceMotionEvent.requestPermission()` as the very first `await` in the function (required by iOS to associate the prompt with the user gesture) before touching anything else. On denial/error, shows the denied screen instead of a dead-end `alert()`.

**Steering:** `onMotion(e)` runs on every `devicemotion` event. If portrait, forces `steer = 0` and returns early. Otherwise: `lateralTiltDeg()` → `OneEuro` filter → subtract a `center` offset (set by "Center" button or automatically on orientation change) → divide by `MAX_TILT`, clamp to [-1,1] → `TiltProtocol.shape()`. The resulting `steer` also drives a CSS `rotate()` transform on an inline SVG steering-wheel graphic (`#wheel-graphic`) for visual feedback that the sensor is working.

**Pedals:** Pointer Events (not Touch Events) on two full-height zones (`#brake` left "FREIO / RÉ", `#gas` right "ACELERAR"), with `setPointerCapture` so a dragging finger stays bound to its pedal, tracked in `held.gas`/`held.brake` `Set<pointerId>` so multiple simultaneous pointers work and a single stray `pointerup` can't wrongly clear a still-held button. `releaseAll()` clears both sets and is called on `window.blur` and on `document.hidden` (app switch / screen lock) — a stuck accelerator on backgrounding was an explicit failure mode from the spec.

**Networking:** `connect()` builds a `wss:`/`ws:` URL from `location.protocol`/`location.host` (never hardcodes `localhost`), sends a `hello` handshake, and on `close` reconnects with exponential backoff (`1000 * 2^attempts`, capped at 8000ms). Also reconnects immediately on `visibilitychange` → visible, rather than waiting out the backoff, since iOS suspends the socket on lock/backgrounding. `sendLoop()` runs on a `setTimeout(..., 1000/60)` self-scheduling loop (not `setInterval`), sending the current `steer`/buttons state every ~16ms regardless of whether anything changed (full-state packets, not deltas — a dropped packet costs nothing).

**Debug mode:** `?debug=1` in the URL shows a text overlay with raw tilt, filtered tilt, `steer`, and `buttons` — added to satisfy the acceptance-test checklist in `steering-and-pedals-spec.md` without building the separate diagnostic page the earlier `plano-controle-iphone.md` doc had proposed.

**Other device affordances:** Screen Wake Lock (`navigator.wakeLock`, silently no-ops where unsupported), fullscreen + `screen.orientation.lock('landscape')` requests on start (best-effort, both wrapped in `.catch(() => {})`), and CSS hardening against iOS gesture interference (`position: fixed`, `overscroll-behavior: none`, `touch-action: none`, `-webkit-touch-callout: none`, `-webkit-tap-highlight-color: transparent`, `user-select: none`).

## 6. `phase0/public/host.html`

Single-file page: three.js scene, HUD panel, disconnect overlay.

**Scene:** a 140×140 ground plane + `GridHelper` (mood-board colors: ink `#241934` background/grid, mint `#2fe6a0` ground), one `HemisphereLight` + one `DirectionalLight`, `THREE.Fog`. The kart is a `THREE.Group`: a coral (`#ff5d3a`) box body, four cylinder wheels (front two steer visually, all four spin with speed), and two small emissive boxes as brake lights (lit when braking or reversing).

**Vehicle simulation** (runs every `requestAnimationFrame`, `dt` clamped to 50ms): reads `VEHICLE_CONFIG` from `protocol.js`. Signed speed model — brake always wins over gas; holding gas while `speed < 0` brakes (at `BRAKE` rate) before accelerating forward again; holding brake while moving forward decelerates at `BRAKE` rate; once speed is at/near zero (`STOP_EPS`) and brake is still held, a `REVERSE_DELAY` (0.2s) timer starts, after which the kart accelerates backward at `REV_ACCEL` up to `MAX_REV`; releasing everything coasts to zero at `COAST` rate. Steering (`heading`) is driven by `steer * TURN_RATE * speedFactor * dt` where `speedFactor = clamp(speed / REF_SPEED, -1, 1)` — this means turning is proportional to *signed* speed, so the kart can't rotate in place at a standstill and steers "backwards" (relative to forward-steering intuition) while reversing, matching real car behavior. Position integrates via `sin(heading)`/`cos(heading)`, clamped to a 130×130 world so the kart can't drive off the plane (there are no walls or collision response, just a hard position clamp).

**Camera:** chase camera with *separately* damped position (slower spring, lags visibly in turns) and look-target (faster spring, stays tighter on the kart) — both exponential/critically-damped lerps (`1 - exp(-k*dt)`), not framerate-dependent naive lerps. FOV interpolates 60°→75° with speed magnitude (`speedFrac`, always non-negative — uses `abs(speed)` so reversing also pushes FOV). A decaying shake (`shakeMag`, multiplicative exponential decay) triggers on gas rising-edge (launch kick) and on hard braking above 55% top speed.

**Speed-line vignette:** a separate 2D `<canvas>` overlay (`#speedlines`, z-index above the three.js canvas but below the HUD panel) draws ~36 streaks radiating from screen center, fading in only above 80% of top speed, redrawn every frame independent of the three.js render.

**Input handling:** listens for `input` WebSocket messages, extracts `steer` (÷32767) and `gas`/`brake` booleans from the buttons bitmask. If no packet arrives for `NEUTRAL_MS` (500ms), input is treated as fully released and `steer` forced to 0 (both for the vehicle sim and to trigger the "Player disconnected" overlay).

**HUD panel:** QR code (generated client-side, points at `controller.html` on the same origin) + join URL text, connection status, RTT (from an explicit `ping`/`pong` round-trip, sent every 1s — this is the reliable cross-device number), input p95 latency (computed from one-way `Date.now()` deltas — explicitly noted in a code comment as clock-sync-dependent and less trustworthy than RTT, kept because it's what the plan's exit criterion is phrased against), a `Speed` readout as a percentage with an `R` suffix when reversing, and a packet counter.

## 7. `phase0/certs.js`

Not a game file — infrastructure. `getOrCreateCert()`: finds the first non-internal IPv4 LAN address, checks for a cached cert in `phase0/certs/` matching that IP and not expired, otherwise generates a new one via `selfsigned.generate()` (async in the installed v5.x — see gotcha below) with SAN covering `localhost`, `127.0.0.1`, and the LAN IP, writes `key.pem`/`cert.pem`/`meta.json` to disk. `phase0/certs/` is gitignored (private key material).

## 8. Known gotchas hit during development (worth an AI reviewer knowing)

- **`selfsigned@5.x` made `generate()` return a `Promise`**, breaking the sync API assumed from memory of older versions. `certs.js`/`server.js` are already fixed (async `main()` wrapper in `server.js`), but this is a fragile external dependency to pin against future breaking changes.
- **A temporal-dead-zone bug** shipped briefly in `host.html`: the speed-line canvas `const`s were declared *after* the `animate()` function was both defined and invoked, but `animate()`'s first synchronous call reached `drawSpeedLines()` before those consts initialized, throwing before `renderer.render()` ever ran — total black screen, no console-visible clue from the user's side. Root cause was ordering, not logic. Worth an AI reviewer flagging that this class of bug (function hoisting vs. `const`/`let` TDZ) has no automated guard in this codebase — no linter, no bundler, no tests.
- **Windows/PowerShell environment**: dev loop is `node server.js` run manually in the background, killed via `Stop-Process`, no nodemon/watch, no npm script beyond `start`. Editing a served file takes effect immediately (no caching, `fs.readFile` per request) but *editing `server.js` itself* requires a manual restart.

## 9. What's explicitly NOT built yet

- Any track geometry, lap counting, checkpoints, or race structure.
- Multiple simultaneous players (`room` is hardcoded to exactly one host + one controller; a second controller connecting would silently overwrite the first).
- Drift mechanic, items, mini-turbos (bits reserved in `BUTTONS` but nothing reads them).
- Real kart/character 3D models — still a primitive box+cylinders placeholder (visual-overhaul plan workstream 3.2+).
- Any HUD beyond the debug/latency panel — no position, lap counter, countdown, menus (visual-overhaul plan workstream 3.5).
- Split-screen.
- Audio of any kind.
- WebRTC transport (plan called for it; implementation is WebSocket-only).
- Any authentication/token system for joining a room (plan's §6 security model — room codes, signed QR tokens, rate limiting — is entirely unimplemented; anyone who can reach the LAN IP:port can connect as either role).
- Automated tests of any kind (no unit tests, no integration tests, no CI).
- A11y pass, load testing, multi-device test matrix (all Phase 3 per the roadmap, not started).

## 10. Suggested angles for an improvement analysis

(Not prescriptive — just where the seams are.)

- **Server room model** is the most obviously fragile part for anything beyond a single demo: no multi-room support, no reconnection identity (a controller that drops and rejoins gets treated as a brand-new anonymous connection, not reunited with its "slot"), no validation that steer/buttons values are in range before relaying (the plan's §6 explicitly calls for the host to clamp/validate, but that clamping currently only happens implicitly via `÷32767` in `host.html`, not defensively against a malformed or malicious packet).
- **No automated verification** that the <30ms p95 latency exit criterion is actually met — the HUD displays it live but nothing logs/asserts it, so "Phase 0 passed" is still a manual, undocumented judgment call.
- **Physics/feel constants are tuned by feel**, not measurement, and duplicated in spirit between `project-tilt-plan.md`'s original pseudocode and the real `VEHICLE_CONFIG`/`TILT_CONFIG` — worth checking they haven't drifted apart from what the design docs claim.
- **The One Euro filter and lateral-tilt math have no unit tests**, despite being the single highest-leverage piece of feel-critical code in the project.
- **iOS-specific behavior (permission flow, sign convention, orientation API fallbacks) has not been validated on-device** in this session — implementation follows the spec closely but real hardware may surface the sign-flip issue the spec anticipated (`lateralTiltDeg`'s `IS_IOS` branch) or other Safari-specific quirks.
