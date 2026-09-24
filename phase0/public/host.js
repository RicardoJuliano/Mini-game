// ===================================================================
// DOM refs
// ===================================================================
const DEBUG = new URLSearchParams(location.search).has("debug");
const QUALITY_LOW = new URLSearchParams(location.search).get("quality") === "low"; // disables post FX, shadows, halves particle pools
const panelEl = document.getElementById("panel");
if (DEBUG) panelEl.style.display = "block";

const lobbyEl = document.getElementById("lobby");
const lobbyStatusEl = document.getElementById("lobby-status");
const lobbyHintEl = document.getElementById("lobby-hint");
const hudEl = document.getElementById("hud");
const resultsEl = document.getElementById("results");
const overlayEl = document.getElementById("overlay");
const minimapCanvas = document.getElementById("hud-minimap");
const speedlinesCanvas = document.getElementById("speedlines");

const PALETTE = TiltVisualConfig.PALETTE;
const TRACK = TiltVisualConfig.TRACK;
const WORLD = TiltVisualConfig.WORLD;
const HUDCFG = TiltVisualConfig.HUD;
const VFXCFG = TiltVisualConfig.VFX;
const V = TiltProtocol.VEHICLE_CONFIG;
const DRIFTCFG = TiltVisualConfig.DRIFT;

function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// ===================================================================
// QR codes (debug panel + lobby)
// ===================================================================
const controllerUrl = `${location.protocol}//${location.host}/controller.html`;
document.getElementById("url").textContent = controllerUrl;
{
  const qrSmall = qrcode(0, "M");
  qrSmall.addData(controllerUrl);
  qrSmall.make();
  document.getElementById("qr").innerHTML = qrSmall.createSvgTag({ cellSize: 4, margin: 2 });

  const qrBig = qrcode(0, "M");
  qrBig.addData(controllerUrl);
  qrBig.make();
  document.getElementById("lobby-qr").innerHTML = qrBig.createSvgTag({ cellSize: 6, margin: 2 });
}

// ===================================================================
// three.js renderer / scene / camera — color pipeline + shadows (step 1)
// ===================================================================
const sceneEl = document.getElementById("scene");
const scene = new THREE.Scene();

// r128 does not convert hex colors to linear automatically.
// Use this helper for every material color so the mood board hex values render as designed.
const col = (hex) => new THREE.Color(hex).convertSRGBToLinear();

scene.fog = new THREE.Fog(col(PALETTE.dusk).getHex(), 120, 450);

const CAMCFG = TiltVisualConfig.CAMERA;
// A tiny near plane destroys depth-buffer precision and is the #1 cause of
// distance z-fighting/flicker; 0.3 is the smallest safe value for this scene scale.
const CAM_NEAR = 0.3, CAM_FAR = 500;
const camera = new THREE.PerspectiveCamera(CAMCFG.restFov, window.innerWidth / window.innerHeight, CAM_NEAR, CAM_FAR);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = !QUALITY_LOW;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
sceneEl.appendChild(renderer.domElement);

// ===================================================================
// Post-processing (plan v3 §2.4): UnrealBloomPass on bright things only (brake
// lights, boost flames, sparks), plus a custom radial blur driven by speed.
// Skipped entirely under ?quality=low.
// ===================================================================
const RadialBlurShader = {
  uniforms: { tDiffuse: { value: null }, strength: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float strength; varying vec2 vUv;
    void main(){
      vec2 dir = vUv - 0.5;
      vec4 c = vec4(0.0);
      for (int i = 0; i < 8; i++) {
        float t = float(i) / 7.0;
        c += texture2D(tDiffuse, vUv - dir * strength * t * 0.08);
      }
      gl_FragColor = c / 8.0;
    }`,
};

let composer = null, radialBlurPass = null;
if (!QUALITY_LOW) {
  composer = new THREE.EffectComposer(renderer);
  composer.addPass(new THREE.RenderPass(scene, camera));
  // Threshold is tuned lower than the plan's suggested 0.85: our brake lights are a pure
  // red emissive, and standard luminance weighting (0.299/0.587/0.114) puts pure red at
  // ~0.3, never crossing a high threshold. Bloom-source materials are also marked
  // toneMapped=false below so they read as reliably "bright" regardless of exposure.
  const bloomPass = new THREE.UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.7, 0.4, 0.55);
  composer.addPass(bloomPass);
  radialBlurPass = new THREE.ShaderPass(RadialBlurShader);
  radialBlurPass.renderToScreen = true;
  composer.addPass(radialBlurPass);
}

// Ground layers sit only centimeters apart in Y; on their own the GPU can't reliably
// tell which wins at distance, so every layer above grass also gets a polygon offset.
function layered(material, level) {
  material.polygonOffset = true;
  material.polygonOffsetFactor = -level;
  material.polygonOffsetUnits = -level;
  return material;
}

// ===================================================================
// Toon shading + outlines (step 2)
// ===================================================================
function toonGradient() {
  const data = new Uint8Array([80, 170, 255]);
  const tex = new THREE.DataTexture(data, 3, 1, THREE.LuminanceFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}
const GRADIENT = toonGradient();
const toon = (hex) => new THREE.MeshToonMaterial({ color: col(hex), gradientMap: GRADIENT });

const OUTLINE_MAT = new THREE.MeshBasicMaterial({ color: col(PALETTE.ink), side: THREE.BackSide });
function addOutline(mesh, thickness) {
  const hull = new THREE.Mesh(mesh.geometry, OUTLINE_MAT);
  hull.scale.setScalar(thickness === undefined ? 1.06 : thickness);
  mesh.add(hull);
}

// ===================================================================
// Lights: one directional (shadow-casting, follows the kart) + hemisphere fill
// ===================================================================
// Late-afternoon look: warm low sun for long shadows, cool sky bounce, mint ground bounce.
scene.add(new THREE.HemisphereLight(col("#8ec5ff").getHex(), col(PALETTE.mint).getHex(), 0.7));
const sun = new THREE.DirectionalLight(col("#ffd9a8").getHex(), 1.4);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
const SHADOW_SPAN = 40; // left..right span of the shadow camera, used for texel snapping below
Object.assign(sun.shadow.camera, { left: -SHADOW_SPAN / 2, right: SHADOW_SPAN / 2, top: SHADOW_SPAN / 2, bottom: -SHADOW_SPAN / 2, near: 1, far: 80 });
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02; // kills the striped shadow-acne pattern on the road
scene.add(sun);
scene.add(sun.target);

// The shadow camera follows the kart, but a sub-texel move re-rasterizes the whole
// map and shadows shimmer; snapping the follow target to whole texels fixes that
// (an approximation for our fixed sun direction — good enough at this scale).
const SHADOW_TEXEL = SHADOW_SPAN / sun.shadow.mapSize.x;
const snapToTexel = (v) => Math.round(v / SHADOW_TEXEL) * SHADOW_TEXEL;
function followShadow(kartPos) {
  const cx = snapToTexel(kartPos.x), cz = snapToTexel(kartPos.z);
  sun.target.position.set(cx, 0, cz);
  sun.position.set(cx + 26, 15, cz + 18); // ~30deg elevation, for long late-afternoon shadows
  sun.target.updateMatrixWorld();
}

// ===================================================================
// Sky: gradient sphere (Ink at top, Dusk at horizon)
// ===================================================================
const SKY_RADIUS = CAM_FAR * 0.9;
{
  const geo = new THREE.SphereGeometry(SKY_RADIUS, 24, 16);
  const top = col(PALETTE.ink), bottom = col(PALETTE.dusk);
  const colors = [];
  const posAttr = geo.attributes.position;
  for (let i = 0; i < posAttr.count; i++) {
    const t = THREE.MathUtils.clamp((posAttr.getY(i) + SKY_RADIUS) / (SKY_RADIUS * 2), 0, 1);
    const c = bottom.clone().lerp(top, t);
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false });
  scene.add(new THREE.Mesh(geo, mat));
}

// ===================================================================
// Grass ground (replaces the old grid plane)
// ===================================================================
const grassMesh = new THREE.Mesh(new THREE.PlaneGeometry(320, 320), toon(PALETTE.mint));
grassMesh.rotation.x = -Math.PI / 2;
grassMesh.receiveShadow = true;
scene.add(grassMesh);

// ===================================================================
// Clouds: slow-drifting billboard sprites (plan v3 §4.2)
// ===================================================================
function cloudTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
const cloudTex = cloudTexture();
const clouds = Array.from({ length: 14 }, () => {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: cloudTex, transparent: true, opacity: 0.5, fog: false, depthWrite: false }));
  const scale = 18 + Math.random() * 20;
  sprite.scale.set(scale, scale * 0.5, 1);
  sprite.position.set((Math.random() - 0.5) * 400, 60 + Math.random() * 50, (Math.random() - 0.5) * 400);
  scene.add(sprite);
  return { sprite, speed: 0.6 + Math.random() * 0.8 };
});
function updateClouds(dt) {
  clouds.forEach((c) => {
    c.sprite.position.x += c.speed * dt;
    if (c.sprite.position.x > 220) c.sprite.position.x = -220;
  });
}

// ===================================================================
// Track: closed Catmull-Rom spline, road + curbs + start line + barriers + trees (step 4)
// ===================================================================
const curve = new THREE.CatmullRomCurve3(
  TRACK.points.map(([x, z]) => new THREE.Vector3(x, 0, z)), true, "centripetal"
);
const samples = curve.getSpacedPoints(TRACK.samples);
const tangents = samples.map((_p, i) => curve.getTangentAt(i / TRACK.samples));
const HALF_ROAD = TRACK.roadWidth / 2;

function ribbon(offA, offB, y, material) {
  const pos = [], uv = [], idx = [];
  let dist = 0;
  for (let i = 0; i <= TRACK.samples; i++) {
    const p = samples[i % TRACK.samples], t = tangents[i % TRACK.samples];
    const n = new THREE.Vector3(-t.z, 0, t.x).normalize();
    if (i > 0) dist += p.distanceTo(samples[(i - 1) % TRACK.samples]);
    pos.push(p.x + n.x * offB, y, p.z + n.z * offB, p.x + n.x * offA, y, p.z + n.z * offA);
    uv.push(1, dist / 2, 0, dist / 2);
    if (i < TRACK.samples) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  return mesh;
}

// Crisp up close (NearestFilter), smooth in the distance (mipmaps) — without both,
// striped/checkered textures sparkle and swim as the camera moves (cause 1.4).
function finishTexture(tex) {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.encoding = THREE.sRGBEncoding;
  return tex;
}
function stripeTexture(colorA, colorB) {
  const c = document.createElement("canvas");
  c.width = 4; c.height = 16;
  const ctx = c.getContext("2d");
  ctx.fillStyle = colorA; ctx.fillRect(0, 0, 4, 8);
  ctx.fillStyle = colorB; ctx.fillRect(0, 8, 4, 8);
  const tex = finishTexture(new THREE.CanvasTexture(c));
  tex.repeat.set(1, 40);
  return tex;
}
const curbMaterial = layered(new THREE.MeshBasicMaterial({ map: stripeTexture(PALETTE.coral, PALETTE.chalk) }), 2);

// Road sits just above grass (both would otherwise share y=0 and z-fight — cause 1.2),
// curbs above the road, start line above curbs; each level also gets a polygon offset.
const roadMesh = ribbon(-HALF_ROAD, HALF_ROAD, 0.03, layered(toon(PALETTE.asphalt), 1));
const curbMeshes = [
  ribbon(HALF_ROAD, HALF_ROAD + TRACK.curbWidth, 0.05, curbMaterial),
  ribbon(-HALF_ROAD - TRACK.curbWidth, -HALF_ROAD, 0.05, curbMaterial),
];
scene.add(roadMesh, ...curbMeshes);

// Start/finish line: checkered plane across the road at sample 0
let startPlane;
{
  const c = document.createElement("canvas");
  c.width = 16; c.height = 16;
  const ctx = c.getContext("2d");
  ctx.fillStyle = PALETTE.chalk; ctx.fillRect(0, 0, 16, 16);
  ctx.fillStyle = PALETTE.ink;
  ctx.fillRect(0, 0, 8, 8); ctx.fillRect(8, 8, 8, 8);
  const tex = finishTexture(new THREE.CanvasTexture(c));
  tex.repeat.set(4, 1);
  startPlane = new THREE.Mesh(new THREE.PlaneGeometry(TRACK.roadWidth, 1.5), layered(new THREE.MeshBasicMaterial({ map: tex }), 3));
  startPlane.rotation.x = -Math.PI / 2;
  const t0 = tangents[0];
  startPlane.position.copy(samples[0]).setY(0.06);
  startPlane.rotation.z = Math.atan2(t0.x, t0.z);
  scene.add(startPlane);
}

// Tire barriers: instanced stacked cylinders on the outer edge of sharp corners
{
  const barrierGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.5, 12);
  const barrierPositions = [];
  for (let i = 0; i < TRACK.samples; i += WORLD.barrierSpacing) {
    const a = tangents[(i + 6) % TRACK.samples], b = tangents[(i - 6 + TRACK.samples) % TRACK.samples];
    const turn = a.x * b.z - a.z * b.x; // curvature sign/magnitude proxy
    if (Math.abs(turn) < 0.12) continue; // only place on noticeably curved sections
    const p = samples[i], t = tangents[i];
    const n = new THREE.Vector3(-t.z, 0, t.x).normalize();
    const side = turn > 0 ? 1 : -1;
    const bx = p.x + n.x * side * (HALF_ROAD + TRACK.curbWidth + 1.2);
    const bz = p.z + n.z * side * (HALF_ROAD + TRACK.curbWidth + 1.2);
    barrierPositions.push([bx, 0.25, bz], [bx, 0.72, bz]);
  }
  const barrierMesh = new THREE.InstancedMesh(barrierGeo, toon(PALETTE.coral), barrierPositions.length || 1);
  barrierMesh.castShadow = true;
  barrierMesh.receiveShadow = true;
  const dummy = new THREE.Object3D();
  barrierPositions.forEach(([x, y, z], i) => {
    dummy.position.set(x, y, z);
    dummy.updateMatrix();
    barrierMesh.setMatrixAt(i, dummy.matrix);
    if (i % 2 === 1) barrierMesh.setColorAt(i, col(PALETTE.chalk));
  });
  scene.add(barrierMesh);
}

// Trees: instanced cone + cylinder, scattered outside the track. The canopy (leafMesh)
// sways each frame (plan v3 §4.2); the trunk stays static since it's cheap and unnoticeable.
const treeLeafMesh = new THREE.InstancedMesh(new THREE.ConeGeometry(0.9, 1.8, 7), toon(PALETTE.mint), WORLD.treeCount);
const treeData = []; // { x, z, scale, phase } — needed each frame to recompute leaf sway
{
  const trunkGeo = new THREE.CylinderGeometry(0.15, 0.18, 0.9, 6);
  const trunkMesh = new THREE.InstancedMesh(trunkGeo, toon(PALETTE.asphalt), WORLD.treeCount);
  trunkMesh.castShadow = treeLeafMesh.castShadow = true;
  const dummy = new THREE.Object3D();
  let placed = 0, guard = 0;
  while (placed < WORLD.treeCount && guard < WORLD.treeCount * 20) {
    guard++;
    const angle = Math.random() * Math.PI * 2;
    const radius = WORLD.treeRadiusMin + Math.random() * (WORLD.treeRadiusMax - WORLD.treeRadiusMin);
    const x = Math.cos(angle) * radius, z = Math.sin(angle) * radius;
    // skip trees too close to the track center line
    let tooClose = false;
    for (let i = 0; i < TRACK.samples; i += 25) {
      if (samples[i].distanceTo(new THREE.Vector3(x, 0, z)) < HALF_ROAD + TRACK.curbWidth + 6) { tooClose = true; break; }
    }
    if (tooClose) continue;
    const scale = 0.7 + Math.random() * 0.6;
    dummy.position.set(x, 0.45 * scale, z);
    dummy.scale.setScalar(scale);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    trunkMesh.setMatrixAt(placed, dummy.matrix);
    treeData.push({ x, z, scale, phase: Math.random() * Math.PI * 2 });
    placed++;
  }
  scene.add(trunkMesh);
  scene.add(treeLeafMesh);
}
function updateTreeSway(now) {
  const dummy = new THREE.Object3D();
  treeData.forEach((t, i) => {
    dummy.position.set(t.x, 1.55 * t.scale, t.z);
    dummy.scale.setScalar(t.scale);
    dummy.rotation.z = Math.sin(now / 1400 + t.phase) * 0.06;
    dummy.rotation.x = Math.cos(now / 1700 + t.phase) * 0.04;
    dummy.updateMatrix();
    treeLeafMesh.setMatrixAt(i, dummy.matrix);
  });
  treeLeafMesh.instanceMatrix.needsUpdate = true;
}

// Flicker-isolation keys (?debug=1 only): hide one layer at a time to find which
// one is actually causing a visual artifact, per project-tilt-plan-v3.md section 1.5.
if (DEBUG) {
  window.addEventListener("keydown", (e) => {
    if (e.key === "1") grassMesh.visible = !grassMesh.visible;
    else if (e.key === "2") roadMesh.visible = !roadMesh.visible;
    else if (e.key === "3") { curbMeshes.forEach((m) => (m.visible = !m.visible)); startPlane.visible = !startPlane.visible; }
    else if (e.key === "4") renderer.shadowMap.enabled = !renderer.shadowMap.enabled;
    // 5 (post-processing) is reserved: no post FX pipeline exists yet in this build.
  });
}

// ===================================================================
// Optical flow (plan v3 §2.3): things passing close to the camera are the
// strongest cue for speed — open space in the distance looks slow no matter what.
// ===================================================================
const FLOW = TiltVisualConfig.FLOW;
const trackLength = curve.getLength();
const sampleSpacing = trackLength / TRACK.samples;

// Fence posts along both edges, close enough to blur past at speed.
{
  const postGeo = new THREE.CylinderGeometry(0.05, 0.05, 1.1, 6);
  const stride = Math.max(1, Math.round(FLOW.fencePostSpacing / sampleSpacing));
  const postCount = Math.floor(TRACK.samples / stride) * 2;
  const postMesh = new THREE.InstancedMesh(postGeo, toon(PALETTE.chalk), postCount);
  postMesh.castShadow = true;
  const dummy = new THREE.Object3D();
  let idx = 0;
  for (let i = 0; i < TRACK.samples; i += stride) {
    const p = samples[i], t = tangents[i];
    const n = new THREE.Vector3(-t.z, 0, t.x).normalize();
    const off = HALF_ROAD + TRACK.curbWidth + FLOW.fencePostOffset;
    [1, -1].forEach((side) => {
      dummy.position.set(p.x + n.x * off * side, 0.55, p.z + n.z * off * side);
      dummy.updateMatrix();
      postMesh.setMatrixAt(idx++, dummy.matrix);
    });
  }
  scene.add(postMesh);
}

// Distance markers: small colored pylons every ~50 units, so open straights read as fast too.
{
  const markerGeo = new THREE.ConeGeometry(0.35, 1.4, 6);
  const stride = Math.max(1, Math.round(FLOW.distanceMarkerEvery / sampleSpacing));
  const positions = [];
  for (let i = 0; i < TRACK.samples; i += stride) positions.push(i);
  const markerMesh = new THREE.InstancedMesh(markerGeo, toon(PALETTE.sun), positions.length || 1);
  markerMesh.castShadow = true;
  const dummy = new THREE.Object3D();
  positions.forEach((i, k) => {
    const p = samples[i], t = tangents[i];
    const n = new THREE.Vector3(-t.z, 0, t.x).normalize();
    const off = HALF_ROAD + TRACK.curbWidth + FLOW.fencePostOffset + 0.6;
    dummy.position.set(p.x + n.x * off, 0.7, p.z + n.z * off);
    dummy.updateMatrix();
    markerMesh.setMatrixAt(k, dummy.matrix);
  });
  scene.add(markerMesh);
}

// Start/finish gantry: passing under something overhead is a strong speed cue.
// Also carries the 3 countdown lights (plan v3 §4.3) and two waving flags (§4.2).
const gantryLights = [];
const gantryFlags = [];
{
  const postGeo = new THREE.BoxGeometry(0.5, 4.5, 0.5);
  const beamGeo = new THREE.BoxGeometry(TRACK.roadWidth + TRACK.curbWidth * 2 + 1, 0.6, 0.5);
  const gantry = new THREE.Group();
  const postMat = toon(PALETTE.ink), beamMat = toon(PALETTE.coral);
  const leftPost = new THREE.Mesh(postGeo, postMat);
  const rightPost = new THREE.Mesh(postGeo, postMat);
  const beam = new THREE.Mesh(beamGeo, beamMat);
  leftPost.position.set(-(HALF_ROAD + TRACK.curbWidth + 0.5), 2.25, 0);
  rightPost.position.set(HALF_ROAD + TRACK.curbWidth + 0.5, 2.25, 0);
  beam.position.set(0, 4.4, 0);
  [leftPost, rightPost, beam].forEach((m) => { m.castShadow = true; gantry.add(m); });

  const lightGeo = new THREE.SphereGeometry(0.16, 10, 8);
  [-0.7, 0, 0.7].forEach((lx) => {
    const light = new THREE.Mesh(lightGeo, new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0x000000 }));
    light.position.set(lx, 4.1, 0.3);
    gantry.add(light);
    gantryLights.push(light);
  });

  const flagGeo = new THREE.PlaneGeometry(0.5, 0.35, 4, 1);
  [-(HALF_ROAD + TRACK.curbWidth + 0.5), HALF_ROAD + TRACK.curbWidth + 0.5].forEach((fx) => {
    const pivot = new THREE.Group();
    pivot.position.set(fx, 4.3, 0);
    const flag = new THREE.Mesh(flagGeo, new THREE.MeshBasicMaterial({ color: col(PALETTE.chalk), side: THREE.DoubleSide }));
    flag.position.x = 0.25 * Math.sign(fx || 1);
    pivot.add(flag);
    gantry.add(pivot);
    gantryFlags.push(pivot);
  });

  const t0 = tangents[0];
  gantry.position.copy(samples[0]);
  gantry.rotation.y = Math.atan2(t0.x, t0.z);
  scene.add(gantry);
}
function setGantryLights(litCount, allGreen) {
  gantryLights.forEach((light, i) => {
    const on = allGreen || i < litCount;
    const hex = allGreen ? 0x2fe6a0 : 0xff3030;
    light.material.color.setHex(on ? hex : 0x330000);
    light.material.emissive.setHex(on ? hex : 0x000000);
  });
}
function updateGantryFlags(now) {
  gantryFlags.forEach((pivot, i) => {
    pivot.rotation.y = Math.sin(now / 260 + i * 2) * 0.5;
  });
}

// ===================================================================
// GLB landmarks (plan v3 §3.1/3.3): Kenney Racing Kit, CC0 — see CREDITS.md.
// Loaded async; a failed load logs a warning and is skipped, never breaks the game
// (there's no way to visually confirm these placements from here, so this stays defensive).
// ===================================================================
const gltfLoader = new THREE.GLTFLoader();
// The pack's materials are flat/unlit and named — only retarget the neutral/accent ones
// toward the mood-board palette; leave "road"/"glass" as shipped (see CREDITS.md).
const KENNEY_RECOLOR = { grey: PALETTE.chalk, red: PALETTE.coral, grass: PALETTE.mint };

function loadGLB(path) {
  return new Promise((resolve, reject) => {
    gltfLoader.load(`shared/models/${path}`, (gltf) => resolve(gltf.scene), undefined, reject);
  });
}

function recolorKenneyModel(root) {
  root.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = true;
    child.receiveShadow = true;
    const target = KENNEY_RECOLOR[child.material.name];
    if (target) {
      child.material = child.material.clone(); // don't mutate a material shared with sibling instances
      child.material.color.copy(col(target));
    }
  });
}

// Grandstand: the model is one ~1-unit tile, meant to be tiled — 6 copies scaled up
// and lined up along the start straight, set back behind the outer curb.
loadGLB("grandStand.glb").then((base) => {
  const t0 = tangents[0], n0 = new THREE.Vector3(-t0.z, 0, t0.x).normalize();
  const standScale = 3, tileCount = 6;
  const standCenter = samples[0].clone().addScaledVector(n0, HALF_ROAD + TRACK.curbWidth + 5);
  const facingAngle = Math.atan2(-n0.x, -n0.z); // face back toward the track
  for (let i = 0; i < tileCount; i++) {
    const tile = base.clone(true);
    recolorKenneyModel(tile);
    tile.scale.setScalar(standScale);
    tile.position.copy(standCenter).addScaledVector(t0, (i - (tileCount - 1) / 2) * standScale);
    tile.rotation.y = facingAngle;
    scene.add(tile);
  }
}).catch((err) => console.warn("grandStand.glb failed to load, skipping:", err));

// Pit tent: planted just past one end of the grandstand.
loadGLB("tentRoofDouble.glb").then((tent) => {
  recolorKenneyModel(tent);
  const t0 = tangents[0], n0 = new THREE.Vector3(-t0.z, 0, t0.x).normalize();
  const scale = 2.5;
  tent.scale.setScalar(scale);
  tent.position.copy(samples[0])
    .addScaledVector(n0, HALF_ROAD + TRACK.curbWidth + 5)
    .addScaledVector(t0, -3 * 3 - 4); // past the grandstand's near end (standScale=3, half tileCount*standScale)
  tent.rotation.y = Math.atan2(t0.x, t0.z);
  scene.add(tent);
}).catch((err) => console.warn("tentRoofDouble.glb failed to load, skipping:", err));

// Checkered flags at a few of the sharpest corners — also doubles as a braking reference.
loadGLB("flagCheckers.glb").then((base) => {
  const corners = [];
  for (let i = 0; i < TRACK.samples; i += 8) {
    const a = tangents[(i + 6) % TRACK.samples], b = tangents[(i - 6 + TRACK.samples) % TRACK.samples];
    if (Math.abs(a.x * b.z - a.z * b.x) > 0.15) corners.push(i);
  }
  const picked = [];
  corners.forEach((i) => { if (!picked.some((p) => Math.abs(p - i) < 40)) picked.push(i); });
  picked.slice(0, 4).forEach((i) => {
    const p = samples[i], t = tangents[i];
    const n = new THREE.Vector3(-t.z, 0, t.x).normalize();
    const flag = base.clone(true);
    recolorKenneyModel(flag);
    flag.scale.setScalar(2.2);
    flag.position.copy(p).addScaledVector(n, HALF_ROAD + TRACK.curbWidth + 1.4);
    flag.rotation.y = Math.atan2(t.x, t.z);
    scene.add(flag);
  });
}).catch((err) => console.warn("flagCheckers.glb failed to load, skipping:", err));

// Boost pads (plan v3 §5.5): placed off the obvious racing line, so taking one is a choice.
const BOOST_PADS = TiltVisualConfig.BOOST_PADS;
// Scrolling arrow texture (plan v3 §4.2) — a chevron repeated down the pad, offset animated each frame.
function boostArrowTexture() {
  const c = document.createElement("canvas");
  c.width = 32; c.height = 32;
  const ctx = c.getContext("2d");
  ctx.fillStyle = PALETTE.sun; ctx.fillRect(0, 0, 32, 32);
  ctx.strokeStyle = PALETTE.ink; ctx.lineWidth = 5; ctx.lineJoin = "round";
  ctx.beginPath(); ctx.moveTo(6, 6); ctx.lineTo(16, 20); ctx.lineTo(26, 6); ctx.stroke();
  const tex = finishTexture(new THREE.CanvasTexture(c));
  tex.repeat.set(1, 3);
  return tex;
}
const boostPads = BOOST_PADS.spots.map(([frac, lateral]) => {
  const i = Math.round(frac * TRACK.samples) % TRACK.samples;
  const p = samples[i], t = tangents[i];
  const n = new THREE.Vector3(-t.z, 0, t.x).normalize();
  const center = new THREE.Vector3(p.x + n.x * lateral, 0.06, p.z + n.z * lateral);
  const arrowTex = boostArrowTexture();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 2.4), layered(new THREE.MeshBasicMaterial({ map: arrowTex }), 3));
  mesh.rotation.x = -Math.PI / 2;
  mesh.rotation.z = Math.atan2(t.x, t.z);
  mesh.position.copy(center);
  scene.add(mesh);
  return { center, lastTriggeredAt: -Infinity, tex: arrowTex };
});
function updateBoostPads(dt) {
  boostPads.forEach((pad) => { pad.tex.offset.y -= dt * 0.6; });
}

// Nearest-point-on-track query, incremental (fast) with an optional full search.
let trackIdx = 0;
function trackQuery(queryPos, fullSearch) {
  let best = trackIdx, bestD = Infinity;
  const range = fullSearch ? Math.floor(TRACK.samples / 2) : 20;
  for (let k = -range; k <= range; k++) {
    const i = (trackIdx + k + TRACK.samples) % TRACK.samples;
    const d = (samples[i].x - queryPos.x) ** 2 + (samples[i].z - queryPos.z) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  trackIdx = best;
  return { i: best, dist: Math.sqrt(bestD) };
}

// ===================================================================
// Kart: kartRoot -> wheels + blob shadow + bodyPivot -> body/seat/spoiler/exhaust/driver (step 3)
// ===================================================================
const kartRoot = new THREE.Group();
scene.add(kartRoot);

const blobShadowGeo = new THREE.CircleGeometry(1.1, 20);
const blobShadow = new THREE.Mesh(blobShadowGeo, new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }));
blobShadow.rotation.x = -Math.PI / 2;
blobShadow.position.y = 0.035; // just above the road layer (0.03), or it renders occluded under it
kartRoot.add(blobShadow);

const frontWheelGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.24, 16);
const rearWheelGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.3, 16);
const wheelMat = toon(PALETTE.ink);
const wheels = [];
const wheelBaseY = [];
const wheelPhase = [];
[[-0.6, 0.28, 0.62, frontWheelGeo], [0.6, 0.28, 0.62, frontWheelGeo],
 [-0.66, 0.36, -0.68, rearWheelGeo], [0.66, 0.36, -0.68, rearWheelGeo]].forEach(([x, y, z, geo]) => {
  const w = new THREE.Mesh(geo, wheelMat);
  w.rotation.z = Math.PI / 2;
  w.position.set(x, y, z);
  w.castShadow = true;
  kartRoot.add(w);
  wheels.push(w);
  wheelBaseY.push(y);
  wheelPhase.push(Math.random() * Math.PI * 2); // independent per-wheel suspension noise
});
const frontWheels = [wheels[0], wheels[1]];

const bodyPivot = new THREE.Group();
kartRoot.add(bodyPivot);

const body = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.42, 1.7), toon(PALETTE.coral));
body.position.set(0, 0.5, -0.05);
body.castShadow = true;
addOutline(body);
bodyPivot.add(body);

const nose = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.3, 0.5), toon(PALETTE.coral));
nose.position.set(0, 0.42, 0.95);
nose.castShadow = true;
addOutline(nose);
bodyPivot.add(nose);

const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.28, 0.5), toon(PALETTE.ink));
seat.position.set(0, 0.72, -0.15);
seat.castShadow = true;
bodyPivot.add(seat);

const column = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.35, 8), toon(PALETTE.ink));
column.position.set(0, 0.78, 0.55);
column.rotation.x = Math.PI / 5;
bodyPivot.add(column);

const steeringWheel = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.03, 8, 16), toon(PALETTE.chalk));
steeringWheel.position.set(0, 0.95, 0.68);
steeringWheel.rotation.x = Math.PI / 2.4;
bodyPivot.add(steeringWheel);

const spoiler = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.06, 0.18), toon(PALETTE.ink));
spoiler.position.set(0, 0.86, -0.95);
spoiler.castShadow = true;
bodyPivot.add(spoiler);

const exhaustGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.3, 8);
const exhaustL = new THREE.Mesh(exhaustGeo, toon(PALETTE.ink));
const exhaustR = exhaustL.clone();
exhaustL.rotation.z = Math.PI / 2; exhaustR.rotation.z = Math.PI / 2;
exhaustL.position.set(-0.3, 0.35, -0.85);
exhaustR.position.set(0.3, 0.35, -0.85);
bodyPivot.add(exhaustL, exhaustR);
const exhaustLocalL = new THREE.Vector3(-0.3, 0.35, -0.95);
const exhaustLocalR = new THREE.Vector3(0.3, 0.35, -0.95);

// Boost flames: hidden cones at each exhaust pipe, shown + flickered only while boosting
const flameGeo = new THREE.ConeGeometry(0.07, 0.35, 8);
const flameMat = new THREE.MeshBasicMaterial({ color: col(PALETTE.sun), transparent: true, toneMapped: false });
const flameL = new THREE.Mesh(flameGeo, flameMat.clone());
const flameR = new THREE.Mesh(flameGeo, flameMat.clone());
[flameL, flameR].forEach((f, i) => {
  f.rotation.x = Math.PI / 2;
  f.position.set(i === 0 ? -0.3 : 0.3, 0.35, -1.05);
  f.visible = false;
  bodyPivot.add(f);
});

// Driver: torso + head + helmet + visor
const driver = new THREE.Group();
driver.position.set(0, 0.72, -0.15);
bodyPivot.add(driver);
const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.4, 10), toon(PALETTE.dusk));
torso.position.y = 0.2;
torso.castShadow = true;
driver.add(torso);

// Arms: shoulder pivots so rotating the pivot swings the forearm like turning a wheel
const armGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.32, 6);
const armMat = toon(PALETTE.dusk);
const armPivotL = new THREE.Group();
const armPivotR = new THREE.Group();
armPivotL.position.set(-0.16, 0.42, 0.18);
armPivotR.position.set(0.16, 0.42, 0.18);
[armPivotL, armPivotR].forEach((pivot) => {
  const arm = new THREE.Mesh(armGeo, armMat);
  arm.position.set(0, -0.14, 0.1);
  arm.rotation.x = -Math.PI / 3.2;
  arm.castShadow = true;
  pivot.add(arm);
  driver.add(pivot);
});

const driverHead = new THREE.Group();
driverHead.position.y = 0.5;
driver.add(driverHead);
const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 10), toon(PALETTE.chalk));
head.castShadow = true;
driverHead.add(head);
const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.145, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.62), toon(PALETTE.sun));
helmet.position.y = 0.015;
driverHead.add(helmet);
const visor = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), new THREE.MeshBasicMaterial({ color: col(PALETTE.ink) }));
visor.scale.set(1, 0.6, 0.6);
visor.position.set(0, 0, 0.09);
driverHead.add(visor);

// Brake lights: lit while braking or reversing
const brakeLightGeo = new THREE.BoxGeometry(0.16, 0.1, 0.05);
const brakeLights = [];
[[-0.35, 0.5, -0.88], [0.35, 0.5, -0.88]].forEach(([x, y, z]) => {
  const m = new THREE.Mesh(brakeLightGeo, new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0x000000, toneMapped: false }));
  m.position.set(x, y, z);
  bodyPivot.add(m);
  brakeLights.push(m);
});

// Procedural body animation (plan v3 §4.1): spring-driven roll/pitch/squash, per-wheel
// suspension, driver arms + head follow, boost pitch/flame, wall-hit wobble, idle buzz.
const BODY = { maxRoll: 0.22, maxPitch: 0.12, bounceAmp: 0.03, spring: 10 };
let bodyRoll = 0, bodyPitch = 0, prevSpeedForBody = 0;
let wallWobbleTimer = 0; // counts down from 1 after a wall hit; drives a damped-sine wobble

function triggerWallWobble() { wallWobbleTimer = 1; }

function animateBody(dt, steerVal, speedVal, isDrifting, isBoosting, isOffroad, driftDirVal) {
  const speedFrac = Math.min(1, Math.abs(speedVal) / V.MAX_FWD);
  const accel = (speedVal - prevSpeedForBody) / Math.max(dt, 1e-3);
  prevSpeedForBody = speedVal;
  const now = performance.now();

  const k = 1 - Math.exp(-BODY.spring * dt);
  const rollTarget = isDrifting ? -driftDirVal * 0.9 : -steerVal * speedFrac; // lean hard into a drift
  bodyRoll += (rollTarget * BODY.maxRoll - bodyRoll) * k;
  const pitchTarget = isBoosting ? -0.6 : THREE.MathUtils.clamp(-accel / 40, -1, 1);
  bodyPitch += (pitchTarget * BODY.maxPitch - bodyPitch) * k;

  // Wall hit: a short damped-sine wobble layered on top of the spring animation.
  wallWobbleTimer = Math.max(0, wallWobbleTimer - dt * 2.2);
  const wobble = Math.sin(wallWobbleTimer * Math.PI * 6) * wallWobbleTimer * 0.25;
  const squash = 1 - wallWobbleTimer * 0.12;

  // Idle vibration: tiny high-frequency buzz whenever the engine is "on" (racing) and near-stopped.
  const idleBuzz = speedFrac < 0.05 ? Math.sin(now / 35) * 0.006 : 0;

  bodyPivot.rotation.z = bodyRoll + wobble;
  bodyPivot.rotation.x = bodyPitch;
  bodyPivot.position.y = Math.sin(now / 90) * BODY.bounceAmp * speedFrac + idleBuzz;
  bodyPivot.position.x = idleBuzz * 0.6;
  bodyPivot.scale.set(1 + wallWobbleTimer * 0.05, squash, 1 + wallWobbleTimer * 0.05);

  // Suspension: each wheel bounces on its own noisy phase, more on grass than on the road.
  const suspAmp = (isOffroad ? 0.03 : 0.012) * (0.4 + speedFrac);
  wheels.forEach((w, i) => {
    w.position.y = wheelBaseY[i] + Math.sin(now / 60 + wheelPhase[i]) * suspAmp;
  });

  // Driver: arms follow steer like turning a wheel, head bobs with speed and leans into drifts.
  const armAngle = steerVal * 0.6;
  armPivotL.rotation.x = -armAngle * 0.5;
  armPivotR.rotation.x = armAngle * 0.5;
  armPivotL.rotation.z = armAngle * 0.3;
  armPivotR.rotation.z = armAngle * 0.3;
  driverHead.rotation.z = bodyRoll * 1.8 + (isDrifting ? -driftDirVal * 0.15 : 0);
  driverHead.position.y = 0.5 + Math.sin(now / 140) * 0.01 * speedFrac;

  // Boost flames: visible and flickering only while boosting.
  flameL.visible = flameR.visible = isBoosting;
  if (isBoosting) {
    const flicker = 0.8 + Math.random() * 0.5;
    flameL.scale.set(flicker, flicker * (0.9 + Math.random() * 0.3), flicker);
    flameR.scale.set(flicker, flicker * (0.9 + Math.random() * 0.3), flicker);
  }
}

// ===================================================================
// Vehicle sim state (step D from the earlier steering spec — unchanged rules)
// ===================================================================
let targetSteer = 0;
let rawGas = false, brake = false;
let lastPacketAt = 0;
let packetCount = 0;
const NEUTRAL_MS = 500;

let speed = 0;
let brakeHold = 0;
let heading = 0;      // real travel direction — position always integrates from this
let visualHeading = 0; // kart model orientation; diverges from `heading` only while drifting
const pos = new THREE.Vector3(0, 0, 0);
let prevGas = false, prevBrake = false, prevRawGas = false, prevWallHit = false;
let boosting = false; // set by the drift/mini-turbo system below

// Drift + mini-turbo (plan v3 §5.4)
let drifting = false;
let driftCharge = 0;
let driftDir = 1;
let boostTimer = 0;
let boostSpeedMul = 1;

function resetKartToStart() {
  pos.copy(samples[0]);
  const t0 = tangents[0];
  heading = Math.atan2(t0.x, t0.z);
  visualHeading = heading;
  speed = 0;
  brakeHold = 0;
  drifting = false;
  driftCharge = 0;
  boostTimer = 0;
  boosting = false;
  trackIdx = 0;
  trackQuery(pos, true);
}
resetKartToStart();

// ===================================================================
// Chase camera: separately damped position (lags in turns) and look target,
// plus speed pullback, FOV spring, rumble and turn roll (plan v3 §2.2)
// ===================================================================
const FOLLOW_DIST = CAMCFG.followDist, FOLLOW_HEIGHT = CAMCFG.followHeight, LOOK_HEIGHT = 0.6;
const camPos = new THREE.Vector3(pos.x, FOLLOW_HEIGHT, pos.z + FOLLOW_DIST);
const lookPos = new THREE.Vector3(pos.x, LOOK_HEIGHT, pos.z);
camera.position.copy(camPos);
camera.fov = CAMCFG.restFov;
let shakeMag = 0;
let fovCurrent = CAMCFG.restFov;
let pullbackCurrent = 0;
let cameraRoll = 0;

// ===================================================================
// Speed-line vignette (own canvas, drawn every frame independent of three.js)
// ===================================================================
speedlinesCanvas.width = window.innerWidth;
speedlinesCanvas.height = window.innerHeight;
const slCtx = speedlinesCanvas.getContext("2d");
const LINE_COUNT = 36;
const lineSeeds = Array.from({ length: LINE_COUNT }, () => ({
  angle: Math.random() * Math.PI * 2,
  len: 0.3 + Math.random() * 0.5,
  width: 1 + Math.random() * 2,
}));
const SPEEDLINE_THRESHOLD = 0.7;
function drawSpeedLines(speedFrac, isBoosting) {
  const w = speedlinesCanvas.width, h = speedlinesCanvas.height;
  slCtx.clearRect(0, 0, w, h);
  if (speedFrac <= SPEEDLINE_THRESHOLD) return;
  const alpha = (speedFrac - SPEEDLINE_THRESHOLD) / (1 - SPEEDLINE_THRESHOLD);
  const cx = w / 2, cy = h / 2;
  const maxR = Math.hypot(w, h) / 2;
  slCtx.strokeStyle = `rgba(255,247,236,${(alpha * (isBoosting ? 0.75 : 0.5)).toFixed(3)})`;
  const activeSeeds = isBoosting ? lineSeeds : lineSeeds.slice(0, lineSeeds.length * 0.6);
  activeSeeds.forEach((s) => {
    const rOuter = maxR * (0.55 + 0.4 * Math.random());
    const rInner = rOuter * (1 - s.len);
    slCtx.lineWidth = s.width;
    slCtx.beginPath();
    slCtx.moveTo(cx + Math.cos(s.angle) * rInner, cy + Math.sin(s.angle) * rInner);
    slCtx.lineTo(cx + Math.cos(s.angle) * rOuter, cy + Math.sin(s.angle) * rOuter);
    slCtx.stroke();
  });
}

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (composer) composer.setSize(window.innerWidth, window.innerHeight);
  speedlinesCanvas.width = window.innerWidth;
  speedlinesCanvas.height = window.innerHeight;
});

// ===================================================================
// VFX pools (step 7) — allocated once, recycled every frame, never `new`d in animate()
// ===================================================================
function makePool(count, geometry, material) {
  const items = [];
  for (let i = 0; i < count; i++) {
    const mesh = new THREE.Mesh(geometry, material.clone());
    mesh.material.transparent = true;
    mesh.visible = false;
    scene.add(mesh);
    items.push({ mesh, life: 0, maxLife: 1, vel: new THREE.Vector3() });
  }
  let cursor = 0;
  return {
    spawn(spawnPos, opts) {
      const p = items[cursor]; cursor = (cursor + 1) % items.length;
      p.mesh.position.copy(spawnPos);
      if (opts.rotation) p.mesh.rotation.copy(opts.rotation);
      p.mesh.scale.setScalar(opts.scale || 1);
      p.mesh.visible = true;
      p.life = p.maxLife = opts.life;
      p.vel.copy(opts.vel || new THREE.Vector3());
      p.baseOpacity = opts.opacity === undefined ? 1 : opts.opacity;
      p.mesh.material.opacity = p.baseOpacity;
      if (opts.color) p.mesh.material.color.set(opts.color);
      p.gravity = opts.gravity || 0;
      p.spin = opts.spin || 0;
    },
    update(dt) {
      for (const p of items) {
        if (p.life <= 0) continue;
        p.life -= dt;
        if (p.gravity) p.vel.y -= p.gravity * dt;
        p.mesh.position.addScaledVector(p.vel, dt);
        if (p.spin) p.mesh.rotation.x += p.spin * dt;
        if (p.life <= 0) { p.mesh.visible = false; continue; }
        p.mesh.material.opacity = (p.life / p.maxLife) * p.baseOpacity;
      }
    },
  };
}
const qualityScale = QUALITY_LOW ? 0.5 : 1;
const dustPool = makePool(Math.round(VFXCFG.dustMax * qualityScale), new THREE.SphereGeometry(0.15, 6, 6), new THREE.MeshBasicMaterial({ color: col(PALETTE.chalk) }));
const skidPool = makePool(Math.round(VFXCFG.skidMax * qualityScale), new THREE.PlaneGeometry(0.3, 0.6), layered(new THREE.MeshBasicMaterial({ color: col(PALETTE.ink), depthWrite: false }), 3));
const exhaustPool = makePool(40, new THREE.SphereGeometry(0.09, 6, 6), new THREE.MeshBasicMaterial({ color: col(PALETTE.ink) }));

// Drift-tier sparks: color is set per-spawn (mini-turbo tier), geometry stays a small shard.
const sparkPool = makePool(60, new THREE.BoxGeometry(0.06, 0.06, 0.12), new THREE.MeshBasicMaterial({ color: col(PALETTE.sun), toneMapped: false }));
function spawnDriftSparks(hexColor) {
  const rearLocal = [new THREE.Vector3(-0.5, 0.32, -0.9), new THREE.Vector3(0.5, 0.32, -0.9)];
  rearLocal.forEach((local) => {
    const origin = kartRoot.localToWorld(local.clone());
    for (let k = 0; k < 6; k++) {
      sparkPool.spawn(origin, {
        life: 0.35 + Math.random() * 0.2, opacity: 0.9, scale: 0.6 + Math.random() * 0.5,
        color: col(hexColor),
        vel: new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 2, (Math.random() - 0.5) * 3),
      });
    }
  });
}

// Finish-line confetti (plan v3 §4.3)
const CONFETTI_COLORS = [PALETTE.coral, PALETTE.sun, PALETTE.mint, PALETTE.chalk, PALETTE.dusk];
const confettiPool = makePool(120, new THREE.PlaneGeometry(0.12, 0.18), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
function spawnConfetti(originPos) {
  for (let i = 0; i < 90; i++) {
    confettiPool.spawn(originPos, {
      life: 1.5 + Math.random() * 1.5, opacity: 1,
      color: col(CONFETTI_COLORS[i % CONFETTI_COLORS.length]),
      vel: new THREE.Vector3((Math.random() - 0.5) * 4, 4 + Math.random() * 3, (Math.random() - 0.5) * 4),
      gravity: 6, spin: (Math.random() - 0.5) * 12,
    });
  }
}

// ===================================================================
// Audio (plan v3 §2.5) — fully synthesized with Web Audio, no asset files.
// Browsers require a real gesture ON THIS PAGE before sound can play, hence the badge.
// ===================================================================
const gameAudio = (() => {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return { update() {}, wallThump() {}, countdownBeep() {}, boostWhoosh() {}, resume() {} };

  const audio = new AudioCtx();
  const master = audio.createGain();
  master.gain.value = 0.6;
  master.connect(audio.destination);

  // Engine: two detuned oscillators through a low-pass filter
  const eng1 = audio.createOscillator(); eng1.type = "sawtooth";
  const eng2 = audio.createOscillator(); eng2.type = "square"; eng2.detune.value = 7;
  const engFilter = audio.createBiquadFilter(); engFilter.type = "lowpass";
  const engGain = audio.createGain(); engGain.gain.value = 0;
  [eng1, eng2].forEach((o) => { o.connect(engFilter); o.start(); });
  engFilter.connect(engGain).connect(master);

  // Shared white-noise buffer for wind and tire screech
  const noiseBuf = audio.createBuffer(1, audio.sampleRate * 2, audio.sampleRate);
  const noiseData = noiseBuf.getChannelData(0);
  for (let i = 0; i < noiseData.length; i++) noiseData[i] = Math.random() * 2 - 1;

  const wind = audio.createBufferSource(); wind.buffer = noiseBuf; wind.loop = true;
  const windFilter = audio.createBiquadFilter(); windFilter.type = "bandpass"; windFilter.Q.value = 0.7;
  const windGain = audio.createGain(); windGain.gain.value = 0;
  wind.connect(windFilter).connect(windGain).connect(master); wind.start();

  const screechSrc = audio.createBufferSource(); screechSrc.buffer = noiseBuf; screechSrc.loop = true;
  const screechFilter = audio.createBiquadFilter(); screechFilter.type = "bandpass"; screechFilter.frequency.value = 2400; screechFilter.Q.value = 4;
  const screechGain = audio.createGain(); screechGain.gain.value = 0;
  screechSrc.connect(screechFilter).connect(screechGain).connect(master); screechSrc.start();

  function update(speedFracVal, gasHeld, isBoosting, isScreeching) {
    const t = audio.currentTime;
    const f = 50 + speedFracVal * 170 + (gasHeld ? 12 : 0) + (isBoosting ? 30 : 0);
    eng1.frequency.setTargetAtTime(f, t, 0.05);
    eng2.frequency.setTargetAtTime(f * 1.5, t, 0.05);
    engFilter.frequency.setTargetAtTime(500 + speedFracVal * 2500, t, 0.08);
    engGain.gain.setTargetAtTime(0.06 + speedFracVal * 0.08, t, 0.1);
    windFilter.frequency.setTargetAtTime(400 + speedFracVal * 1600, t, 0.1);
    windGain.gain.setTargetAtTime(speedFracVal ** 2 * 0.12, t, 0.1);
    screechGain.gain.setTargetAtTime(isScreeching ? 0.09 : 0, t, 0.05);
  }

  function pluck(freq, dur, type, gainVal) {
    const t = audio.currentTime;
    const osc = audio.createOscillator(); osc.type = type || "sine"; osc.frequency.value = freq;
    const g = audio.createGain();
    g.gain.setValueAtTime(gainVal === undefined ? 0.25 : gainVal, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(master);
    osc.start(t); osc.stop(t + dur);
  }
  function wallThump() { pluck(90, 0.3, "sine", 0.35); }
  function countdownBeep(isGo) { pluck(isGo ? 880 : 440, isGo ? 0.3 : 0.15, "sine"); }
  function boostWhoosh() {
    const t = audio.currentTime;
    const osc = audio.createOscillator(); osc.type = "sawtooth";
    osc.frequency.setValueAtTime(200, t);
    osc.frequency.exponentialRampToValueAtTime(900, t + 0.25);
    const filt = audio.createBiquadFilter(); filt.type = "lowpass";
    filt.frequency.setValueAtTime(300, t);
    filt.frequency.exponentialRampToValueAtTime(4000, t + 0.25);
    const g = audio.createGain();
    g.gain.setValueAtTime(0.2, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    osc.connect(filt).connect(g).connect(master);
    osc.start(t); osc.stop(t + 0.4);
  }
  function resume() { if (audio.state === "suspended") audio.resume(); }

  return { update, wallThump, countdownBeep, boostWhoosh, resume };
})();

const audioPromptEl = document.getElementById("audio-prompt");
function unlockAudio() {
  gameAudio.resume();
  audioPromptEl.classList.add("hidden");
}
window.addEventListener("click", unlockAudio, { once: true });
window.addEventListener("keydown", unlockAudio, { once: true });

// ===================================================================
// Minimap: track outline pre-rendered once, kart marker drawn each frame
// ===================================================================
const minimapOffscreen = document.createElement("canvas");
minimapOffscreen.width = 240; minimapOffscreen.height = 240;
let minimapScale = 1, minimapOffsetX = 0, minimapOffsetY = 0;
{
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  samples.forEach((p) => { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); });
  const pad = 22, w = 240, h = 240;
  minimapScale = Math.min((w - 2 * pad) / (maxX - minX), (h - 2 * pad) / (maxZ - minZ));
  minimapOffsetX = w / 2 - ((minX + maxX) / 2) * minimapScale;
  minimapOffsetY = h / 2 - ((minZ + maxZ) / 2) * minimapScale;

  const octx = minimapOffscreen.getContext("2d");
  octx.strokeStyle = PALETTE.chalk;
  octx.lineWidth = 4;
  octx.beginPath();
  samples.forEach((p, i) => {
    const x = p.x * minimapScale + minimapOffsetX, y = p.z * minimapScale + minimapOffsetY;
    if (i === 0) octx.moveTo(x, y); else octx.lineTo(x, y);
  });
  octx.closePath();
  octx.stroke();
  octx.strokeStyle = PALETTE.coral;
  octx.lineWidth = 3;
  const s0 = samples[0], t0 = tangents[0];
  const n0 = new THREE.Vector3(-t0.z, 0, t0.x).normalize();
  const ax = s0.x * minimapScale + minimapOffsetX + n0.x * 9, ay = s0.z * minimapScale + minimapOffsetY + n0.z * 9;
  const bx = s0.x * minimapScale + minimapOffsetX - n0.x * 9, by = s0.z * minimapScale + minimapOffsetY - n0.z * 9;
  octx.beginPath(); octx.moveTo(ax, ay); octx.lineTo(bx, by); octx.stroke();
}
const mmCtx = minimapCanvas.getContext("2d");
function drawMinimap() {
  mmCtx.clearRect(0, 0, 240, 240);
  mmCtx.drawImage(minimapOffscreen, 0, 0);
  const cx = pos.x * minimapScale + minimapOffsetX, cy = pos.z * minimapScale + minimapOffsetY;
  const fx = Math.sin(heading), fz = Math.cos(heading);
  const rx = fz, rz = -fx;
  const tipX = cx + fx * 8, tipY = cy + fz * 8;
  const leftX = cx - fx * 4 + rx * 5, leftY = cy - fz * 4 + rz * 5;
  const rightX = cx - fx * 4 - rx * 5, rightY = cy - fz * 4 - rz * 5;
  mmCtx.fillStyle = PALETTE.coral;
  mmCtx.strokeStyle = PALETTE.chalk;
  mmCtx.lineWidth = 1.5;
  mmCtx.beginPath();
  mmCtx.moveTo(tipX, tipY); mmCtx.lineTo(leftX, leftY); mmCtx.lineTo(rightX, rightY);
  mmCtx.closePath();
  mmCtx.fill(); mmCtx.stroke();
}

// ===================================================================
// HUD controller (step 6)
// ===================================================================
const hud = (() => {
  const elCache = {};
  const el = (id) => elCache[id] || (elCache[id] = document.getElementById(id));
  const textCache = {};
  // `pop` (plan v3 §4.4): a quick scale animation, only for numbers that change occasionally
  // (lap, best lap) — never for ones that change every frame (timer, speed), or it'd spam.
  const set = (id, text, pop) => {
    if (textCache[id] === text) return;
    const first = textCache[id] === undefined;
    textCache[id] = text;
    const node = el(id);
    node.textContent = text;
    if (pop && !first) {
      node.classList.remove("pop");
      void node.offsetWidth;
      node.classList.add("pop");
    }
  };
  let displayedSpeedFrac = 0, speedVelocity = 0, lastUpdateT = null;
  const fmt = (ms) => {
    if (!isFinite(ms)) return "--:--.---";
    const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, x = Math.floor(ms % 1000);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(x).padStart(3, "0")}`;
  };

  function banner(text, kind) {
    const b = el("hud-banner");
    b.className = "hud-banner";
    void b.offsetWidth; // restart the animation
    b.textContent = text;
    b.className = `hud-banner show ${kind || ""}`;
  }

  return {
    fmt, banner,
    countdown(total) {
      [3, 2, 1].forEach((n, i) => setTimeout(() => banner(String(n)), i * (total / 3)));
    },
    update(now, speedVal, race) {
      const racing = race.state === "RACING";
      set("hud-lap", String(Math.max(1, race.lap)), true);
      set("hud-laps", String(TRACK.laps));
      set("hud-time", racing ? fmt(now - race.t0) : fmt(0));
      set("hud-best", fmt(race.best), true);

      // Speedometer overshoots slightly and settles instead of snapping (plan v3 §4.4):
      // an underdamped mass-spring-damper on the displayed fraction, not a plain ease.
      const dt = lastUpdateT === null ? 1 / 60 : Math.min(0.1, (now - lastUpdateT) / 1000);
      lastUpdateT = now;
      const targetFrac = Math.min(1, Math.abs(speedVal) / V.MAX_FWD);
      const STIFFNESS = 100, DAMPING = 9;
      const accel = (targetFrac - displayedSpeedFrac) * STIFFNESS - speedVelocity * DAMPING;
      speedVelocity += accel * dt;
      displayedSpeedFrac += speedVelocity * dt;

      set("hud-speed", String(Math.round(Math.max(0, displayedSpeedFrac) * V.MAX_FWD * HUDCFG.kmhPerUnit)));
      const reverse = speedVal < -0.2;
      set("hud-gear", reverse ? "R" : "D");
      el("hud-gear").classList.toggle("reverse", reverse);
      el("speedo-fill").style.strokeDasharray = `${(235.6 * Math.max(0, displayedSpeedFrac)).toFixed(1)} 314.2`;
    },
    flashBestLap() { banner("MELHOR VOLTA!", "go"); },
    showResults(total, best) {
      set("results-total", fmt(total));
      set("results-best", fmt(best));
      resultsEl.classList.add("show");
    },
    setConn(connected, rttMs) {
      el("hud-conn-dot").classList.toggle("off", !connected);
      set("hud-rtt", connected ? `${rttMs.toFixed(0)} ms` : "-- ms");
    },
    setDrift(isDrifting, charge, tiers) {
      el("hud-drift").hidden = !isDrifting;
      if (!isDrifting) return;
      const maxCharge = tiers[tiers.length - 1].minCharge;
      const frac = Math.min(1, charge / maxCharge);
      const tier = [...tiers].reverse().find((t) => charge >= t.minCharge);
      const fill = el("hud-drift-fill");
      fill.style.width = `${(frac * 100).toFixed(0)}%`;
      fill.style.backgroundColor = tier ? tier.color : "#4d8dff";
    },
  };
})();

// ===================================================================
// Race state machine (step 5)
// ===================================================================
const SECTORS = 4;
const RACE = {
  state: "LOBBY", lap: 0, t0: 0, lapStart: 0, best: Infinity, lastLap: 0,
  sector: 0, countdownEnd: 0, finishedAt: 0, wrongWayTime: 0,
};
let controllerConnected = false;
let finishOrbitStart = 0; // performance.now() timestamp; drives the 5s finish camera orbit
let lastTrackIdxForWrongWay = 0;
let wrongWayCooldown = 0;

function startCountdown(now) {
  resetKartToStart();
  lastTrackIdxForWrongWay = 0;
  RACE.wrongWayTime = 0;
  wrongWayCooldown = 0;
  Object.assign(RACE, { state: "COUNTDOWN", countdownEnd: now + HUDCFG.countdownMs });
  hud.countdown(HUDCFG.countdownMs);
  setGantryLights(0, false);
  [3, 2, 1].forEach((n, i) => setTimeout(() => {
    gameAudio.countdownBeep(false);
    setGantryLights(i + 1, false); // lights turn on one at a time
  }, i * (HUDCFG.countdownMs / 3)));
  resultsEl.classList.remove("show");
  lobbyEl.classList.add("hidden");
  hudEl.hidden = false;
}

function completeLap(now) {
  const lapTime = now - RACE.lapStart;
  RACE.lastLap = lapTime;
  if (lapTime < RACE.best) { RACE.best = lapTime; hud.flashBestLap(); }
  if (RACE.lap >= TRACK.laps) {
    Object.assign(RACE, { state: "FINISHED", finishedAt: now });
    finishOrbitStart = now;
    hud.showResults(now - RACE.t0, RACE.best);
    spawnConfetti(new THREE.Vector3(pos.x, 1.2, pos.z));
    return;
  }
  RACE.lap++;
  RACE.lapStart = now;
  hud.banner(RACE.lap === TRACK.laps ? "ÚLTIMA VOLTA!" : `VOLTA ${RACE.lap}`, "lap");
}

function updateLaps(now) {
  const q = trackQuery(pos);
  const sector = Math.floor(q.i / (TRACK.samples / SECTORS));
  if (sector === (RACE.sector + 1) % SECTORS) {
    if (sector === 0) completeLap(now);
    RACE.sector = sector;
  } else if (sector !== RACE.sector) {
    RACE.sector = sector; // moving backward through a sector: track position, do not score
  }
}

function checkWrongWay(dt, q) {
  if (RACE.state !== "RACING") { RACE.wrongWayTime = 0; return; }
  let delta = q.i - lastTrackIdxForWrongWay;
  if (delta > TRACK.samples / 2) delta -= TRACK.samples;
  if (delta < -TRACK.samples / 2) delta += TRACK.samples;
  lastTrackIdxForWrongWay = q.i;
  if (Math.abs(speed) > 2 && delta < 0) RACE.wrongWayTime += dt;
  else if (delta > 0) RACE.wrongWayTime = 0;
  wrongWayCooldown -= dt;
  if (RACE.wrongWayTime > 1 && wrongWayCooldown <= 0) {
    hud.banner("CONTRAMÃO!", "warn");
    wrongWayCooldown = 1.2;
  }
}

function updateRace(now, gasPressedEdge) {
  switch (RACE.state) {
    case "LOBBY":
      lobbyStatusEl.textContent = controllerConnected ? "Controle conectado" : "Aguardando controle…";
      lobbyStatusEl.className = controllerConnected ? "ready" : "waiting";
      lobbyHintEl.style.visibility = controllerConnected ? "visible" : "hidden";
      if (controllerConnected && gasPressedEdge) startCountdown(now);
      break;
    case "COUNTDOWN":
      if (now >= RACE.countdownEnd) {
        Object.assign(RACE, { state: "RACING", lap: 1, t0: now, lapStart: now, sector: 0 });
        hud.banner("JÁ!", "go");
        gameAudio.countdownBeep(true);
        setGantryLights(3, true);
        setTimeout(() => setGantryLights(0, false), 600); // lights out shortly after go
      }
      break;
    case "RACING":
      updateLaps(now);
      break;
    case "FINISHED":
      if (gasPressedEdge && now - RACE.finishedAt > HUDCFG.resultsRestartDelayMs) startCountdown(now);
      break;
  }
}

// ===================================================================
// Disconnect overlay (poll, matches the pre-visual-overhaul behavior)
// ===================================================================
setInterval(() => {
  overlayEl.style.display = lastPacketAt > 0 && performance.now() - lastPacketAt > NEUTRAL_MS ? "flex" : "none";
}, 150);

// ===================================================================
// Latency tracking (p95 over a rolling window) — debug panel only
// ===================================================================
const latencies = [];
function recordLatency(ms) {
  latencies.push(ms);
  if (latencies.length > 200) latencies.shift();
  const sorted = [...latencies].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  const p95 = sorted[idx];
  const p95El = document.getElementById("p95");
  p95El.textContent = `${p95.toFixed(1)} ms`;
  p95El.className = "v " + (p95 < 30 ? "ok" : p95 < 60 ? "warn" : "bad");
}

// ===================================================================
// WebSocket
// ===================================================================
const wsScheme = location.protocol === "https:" ? "wss" : "ws";
const ws = new WebSocket(`${wsScheme}://${location.host}`);
ws.addEventListener("open", () => {
  ws.send(JSON.stringify({ type: "hello", role: "host" }));
  document.getElementById("conn").textContent = "host online";
  setInterval(() => ws.send(JSON.stringify({ type: "ping", t: performance.now() })), 1000);
});
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === "pong") {
    const rtt = performance.now() - msg.t;
    const rttEl = document.getElementById("rtt");
    rttEl.textContent = `${rtt.toFixed(1)} ms`;
    rttEl.className = "v " + (rtt < 40 ? "ok" : rtt < 100 ? "warn" : "bad");
    hud.setConn(controllerConnected, rtt);
  } else if (msg.type === "controller-joined") {
    controllerConnected = true;
    document.getElementById("conn").textContent = "controller connected";
  } else if (msg.type === "controller-left") {
    controllerConnected = false;
    document.getElementById("conn").textContent = "controller left";
    hud.setConn(false, 0);
  } else if (msg.type === "input") {
    const now = performance.now();
    lastPacketAt = now;
    packetCount++;
    document.getElementById("pkts").textContent = packetCount;
    targetSteer = msg.steer / 32767;
    rawGas = !!(msg.buttons & TiltProtocol.BUTTONS.GAS);
    brake = !!(msg.buttons & TiltProtocol.BUTTONS.BRAKE);
    // Clocks aren't synced across devices, so this one-way estimate is noisier than
    // the ping/pong RTT above; kept because it's what the Phase 0 p95 target is phrased against.
    const oneWay = Date.now() - msg.t;
    if (oneWay >= 0 && oneWay < 1000) recordLatency(oneWay);
  }
});
ws.addEventListener("close", () => {
  document.getElementById("conn").textContent = "server disconnected";
  hud.setConn(false, 0);
});

// ===================================================================
// Main loop — declared last per the ordering rule that caused the earlier TDZ bug
// ===================================================================
let lastFrame = performance.now();
function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  const sinceLast = now - lastPacketAt;
  const inputLive = lastPacketAt > 0 && sinceLast <= NEUTRAL_MS;
  const steer = inputLive ? targetSteer : 0;

  const gasPressedEdge = inputLive && rawGas && !prevRawGas;
  prevRawGas = inputLive && rawGas;
  updateRace(now, gasPressedEdge);

  const racing = RACE.state === "RACING";

  // Drift (plan v3 §5.4): both pedals + turning at speed hijacks the normal
  // "both held = brake" rule. Everywhere else, both held still just brakes.
  const bothHeld = racing && inputLive && rawGas && brake;
  const canStartDrift = bothHeld && Math.abs(steer) > DRIFTCFG.steerThreshold && speed > V.MAX_FWD * DRIFTCFG.speedThreshold;
  if (!drifting && canStartDrift) {
    drifting = true;
    driftCharge = 0;
    driftDir = Math.sign(steer) || 1;
  }
  if (drifting && !bothHeld) {
    drifting = false;
    const tier = [...DRIFTCFG.tiers].reverse().find((tr) => driftCharge >= tr.minCharge);
    if (tier) {
      boostTimer = tier.boostDur;
      boostSpeedMul = tier.boostMul;
      speed = Math.max(speed, V.MAX_FWD * 0.85); // immediate kick, not a slow ACCEL-limited climb
      spawnDriftSparks(tier.color);
      gameAudio.boostWhoosh();
      shakeMag = Math.max(shakeMag, 0.15);
    }
    driftCharge = 0;
  }

  const brakeHeld = racing && inputLive && brake && !drifting;
  const gas = racing && inputLive && rawGas && !brakeHeld && !drifting; // brake wins over gas

  if (gas && !prevGas) shakeMag = Math.max(shakeMag, 0.12);
  if (brakeHeld && !prevBrake && speed > V.MAX_FWD * 0.55) shakeMag = Math.max(shakeMag, 0.2);
  prevGas = gas; prevBrake = brakeHeld;

  if (racing) {
    if (drifting) {
      driftCharge += dt * DRIFTCFG.chargeRate * (0.5 + Math.abs(steer));
      speed -= DRIFTCFG.speedDecay * dt;
    } else if (!brakeHeld) {
      brakeHold = 0;
    }
    if (!drifting) {
      if (gas) {
        speed += (speed < 0 ? V.BRAKE : V.ACCEL) * dt;
      } else if (brakeHeld) {
        if (speed > V.STOP_EPS) {
          speed = Math.max(0, speed - V.BRAKE * dt);
          brakeHold = 0;
        } else {
          brakeHold += dt;
          if (brakeHold >= V.REVERSE_DELAY) speed -= V.REV_ACCEL * dt;
        }
      } else {
        speed -= Math.sign(speed) * Math.min(Math.abs(speed), V.COAST * dt);
      }
    }

    if (boostTimer > 0) { boostTimer = Math.max(0, boostTimer - dt); }
    boosting = boostTimer > 0;
    const effectiveMaxFwd = boosting ? V.MAX_FWD * boostSpeedMul : V.MAX_FWD;
    speed = Math.max(-V.MAX_REV, Math.min(effectiveMaxFwd, speed));

    const turnRateMul = drifting ? DRIFTCFG.turnRateBonus : 1;
    const speedFactor = Math.max(-1, Math.min(1, speed / V.REF_SPEED));
    heading += steer * V.TURN_RATE * turnRateMul * speedFactor * dt;

    pos.x += Math.sin(heading) * speed * dt;
    pos.z += Math.cos(heading) * speed * dt;
  } else {
    speed = 0; // frozen during lobby/countdown/finished
    drifting = false; driftCharge = 0; boostTimer = 0; boosting = false;
  }
  const speedFrac = Math.min(1, Math.abs(speed) / V.MAX_FWD);

  // Visual-only slip: the body/wheels yaw off the real travel direction while drifting,
  // without touching the trajectory itself (which still integrates from `heading`).
  const driftYawOffset = drifting ? driftDir * THREE.MathUtils.degToRad(DRIFTCFG.bodyAngleDeg) : 0;
  const targetVisualHeading = heading + driftYawOffset;
  visualHeading += angleDelta(visualHeading, targetVisualHeading) * (1 - Math.exp(-8 * dt));

  const q = trackQuery(pos);
  checkWrongWay(dt, q);
  let offroad = false;
  let wallHit = false;
  if (racing) {
    if (q.dist > HALF_ROAD + TRACK.curbWidth + WORLD.wallDist) {
      wallHit = true;
      const dx = pos.x - samples[q.i].x, dz = pos.z - samples[q.i].z;
      const d = Math.hypot(dx, dz) || 1;
      const threshold = HALF_ROAD + TRACK.curbWidth + WORLD.wallDist;
      pos.x = samples[q.i].x + (dx / d) * threshold;
      pos.z = samples[q.i].z + (dz / d) * threshold;
      speed *= 0.55; // eased from 0.4 — hitting a wall shouldn't cost almost all your speed
      shakeMag = Math.max(shakeMag, 0.25);
      if (!prevWallHit) { gameAudio.wallThump(); triggerWallWobble(); }
    } else if (q.dist > HALF_ROAD) {
      offroad = true;
      if (speed > V.MAX_FWD * WORLD.offroadSpeedMul) speed = V.MAX_FWD * WORLD.offroadSpeedMul;
    }
  }
  prevWallHit = wallHit;

  if (racing) {
    for (const pad of boostPads) {
      if (now - pad.lastTriggeredAt < 1000) continue;
      if (pad.center.distanceTo(pos) < 1.3) {
        pad.lastTriggeredAt = now;
        boostTimer = BOOST_PADS.duration;
        boostSpeedMul = BOOST_PADS.speedMul;
        speed = Math.max(speed, V.MAX_FWD * 0.9);
        gameAudio.boostWhoosh();
        shakeMag = Math.max(shakeMag, 0.12);
      }
    }
  }

  kartRoot.position.copy(pos);
  kartRoot.rotation.y = visualHeading;
  kartRoot.updateMatrixWorld(); // exhaust spawn below needs this frame's transform, not last frame's
  animateBody(dt, steer, speed, drifting, boosting, offroad, driftDir);
  frontWheels.forEach((w) => (w.rotation.y = steer * 0.5));
  wheels.forEach((w) => (w.rotation.x -= speed * dt * 3));

  const lit = brakeHeld || speed < 0;
  brakeLights.forEach((m) => {
    m.material.color.setHex(lit ? 0xff3030 : 0x400000);
    m.material.emissive.setHex(lit ? 0xff0000 : 0x000000);
  });

  // --- VFX triggers ---
  if (racing && Math.abs(speed) > 1 && (offroad || (Math.abs(steer) > 0.7 && speedFrac > 0.6)) && Math.random() < 0.6) {
    dustPool.spawn(new THREE.Vector3(pos.x, 0.05, pos.z), {
      life: VFXCFG.dustLifeSec, opacity: 0.35, scale: 0.25 + Math.random() * 0.2,
      vel: new THREE.Vector3((Math.random() - 0.5) * 1.5, 1.2, (Math.random() - 0.5) * 1.5),
    });
  }
  const skidding = racing && ((Math.abs(steer) > 0.8 && speedFrac > 0.7) || (brakeHeld && speed > V.MAX_FWD * 0.5));
  if (skidding && Math.random() < 0.5) {
    skidPool.spawn(new THREE.Vector3(pos.x, 0.06, pos.z), {
      life: VFXCFG.skidLifeSec, opacity: 0.4, rotation: new THREE.Euler(-Math.PI / 2, 0, heading),
    });
  }
  gameAudio.update(speedFrac, gas, boosting, skidding);
  if (gas && !prevGas) {
    [exhaustLocalL, exhaustLocalR].forEach((local) => {
      exhaustPool.spawn(kartRoot.localToWorld(local.clone()), {
        life: 0.5, opacity: 0.5, scale: 0.12,
        vel: new THREE.Vector3(-Math.sin(heading) * 0.3, 0.8, -Math.cos(heading) * 0.3),
      });
    });
  }
  dustPool.update(dt);
  skidPool.update(dt);
  exhaustPool.update(dt);
  sparkPool.update(dt);
  confettiPool.update(dt);

  // --- finish camera: 5s orbit around the kart (plan v3 §4.3) ---
  const finishOrbitElapsed = now - finishOrbitStart;
  if (RACE.state === "FINISHED" && finishOrbitElapsed < 5000) {
    const orbitAngle = (finishOrbitElapsed / 5000) * Math.PI * 2;
    const orbitRadius = 8;
    camPos.set(pos.x + Math.sin(orbitAngle) * orbitRadius, pos.y + 4, pos.z + Math.cos(orbitAngle) * orbitRadius);
    lookPos.set(pos.x, pos.y + 0.8, pos.z);
    camera.position.copy(camPos);
    camera.rotation.z = 0; // clear any leftover bank from the last racing frame
    camera.lookAt(lookPos);
    fovCurrent += (CAMCFG.restFov - fovCurrent) * (1 - Math.exp(-CAMCFG.fovSpring * dt));
    camera.fov = fovCurrent; // keep in sync with the chase-cam branch, or FOV snaps when the orbit ends
    camera.updateProjectionMatrix();
  } else {
    // --- chase camera: pullback, position/look lag (look-ahead, not at the kart), rumble, roll, FOV spring ---
    const pullbackTarget = CAMCFG.pullback * speedFrac;
    pullbackCurrent += (pullbackTarget - pullbackCurrent) * (1 - Math.exp(-CAMCFG.pullbackSpring * dt));
    const effectiveDist = FOLLOW_DIST + pullbackCurrent;

    const forward = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
    const idealCam = new THREE.Vector3(pos.x - forward.x * effectiveDist, pos.y + FOLLOW_HEIGHT, pos.z - forward.z * effectiveDist);
    const idealLook = new THREE.Vector3(pos.x + forward.x * CAMCFG.lookAhead, pos.y + LOOK_HEIGHT, pos.z + forward.z * CAMCFG.lookAhead);
    camPos.lerp(idealCam, 1 - Math.exp(-3.0 * dt));
    lookPos.lerp(idealLook, 1 - Math.exp(-9.0 * dt));

    shakeMag *= Math.pow(0.002, dt);
    const rumble = speedFrac > CAMCFG.rumbleMaxSpeedFrac
      ? CAMCFG.rumbleMax * (speedFrac - CAMCFG.rumbleMaxSpeedFrac) / (1 - CAMCFG.rumbleMaxSpeedFrac)
      : 0;
    const totalShake = shakeMag + rumble;
    const shakeOffset = totalShake > 0.001
      ? new THREE.Vector3((Math.random() - 0.5) * totalShake, (Math.random() - 0.5) * totalShake, (Math.random() - 0.5) * totalShake)
      : new THREE.Vector3();

    camera.position.copy(camPos).add(shakeOffset);
    camera.lookAt(lookPos);

    const rollTarget = -steer * speedFrac * THREE.MathUtils.degToRad(CAMCFG.rollMaxDeg);
    cameraRoll += (rollTarget - cameraRoll) * (1 - Math.exp(-8 * dt));
    camera.rotateZ(cameraRoll); // banking, applied after lookAt so it doesn't fight the look target

    const fovTarget = boosting ? CAMCFG.boostFov : CAMCFG.restFov + (CAMCFG.topFov - CAMCFG.restFov) * speedFrac;
    fovCurrent += (fovTarget - fovCurrent) * (1 - Math.exp(-CAMCFG.fovSpring * dt));
    camera.fov = fovCurrent;
    camera.updateProjectionMatrix();
  }

  followShadow(kartRoot.position);

  updateTreeSway(now);
  updateGantryFlags(now);
  updateBoostPads(dt);
  updateClouds(dt);
  drawSpeedLines(speedFrac, boosting);
  drawMinimap();
  hud.update(now, speed, RACE);
  hud.setDrift(drifting, driftCharge, DRIFTCFG.tiers);
  document.getElementById("speed").textContent = `${Math.round(speedFrac * 100)}%${speed < 0 ? " R" : ""}`;

  if (composer) {
    // Radial blur: 0 below 70% speed, up to 0.6 at top speed, 1.0 while boosting.
    const blurStrength = boosting ? 1.0 : speedFrac > 0.7 ? ((speedFrac - 0.7) / 0.3) * 0.6 : 0;
    radialBlurPass.uniforms.strength.value = blurStrength;
    composer.render();
  } else {
    renderer.render(scene, camera);
  }
}
animate();
