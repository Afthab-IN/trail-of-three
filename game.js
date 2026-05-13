import * as THREE from "https://esm.sh/three@0.160.0";
import { EffectComposer } from "https://esm.sh/three@0.160.0/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "https://esm.sh/three@0.160.0/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "https://esm.sh/three@0.160.0/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "https://esm.sh/three@0.160.0/examples/jsm/postprocessing/OutputPass.js";
import { Sky } from "https://esm.sh/three@0.160.0/examples/jsm/objects/Sky.js";
import { GLTFLoader } from "https://esm.sh/three@0.160.0/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "https://esm.sh/three@0.160.0/examples/jsm/environments/RoomEnvironment.js";

import { TRACKS, TRACK_WIDTH, buildTrackGeometry, nearestOnTrack, CHECKPOINT_COUNT } from "./track.js";
import { Car, COLORS } from "./car.js";
import { AIDriver } from "./ai.js";
import { Net, makeRoomCode } from "./net.js";
import {
  setEngine, silenceEngine, setScreech, stopScreech,
  sfxCollision, sfxBoost, sfxCountdownBeep, sfxLap, sfxFinish, unlockAudio,
} from "./audio.js";
import {
  spawnSmoke, spawnSparks, spawnDust, spawnBoostTrail,
  updateParticles, cameraShake, applyCameraShake,
} from "./fx.js";

// =============================================================
//  State
// =============================================================
const state = {
  renderer: null,
  scene: null,
  camera: null,
  composer: null,
  bloom: null,
  clock: new THREE.Clock(),
  themeGroup: null,
  trackGroup: null,
  trackData: null,
  trackId: "vale",

  net: new Net(),
  myId: null,
  myName: "Driver",
  myColor: COLORS[0],
  roomCode: null,
  isHost: false,
  solo: false,

  phase: "title",          // title | track-pick | lobby | countdown | racing | finished
  cars: {},                // id -> Car
  aiDrivers: [],
  myCar: null,
  countdownT: 0,
  countdownStep: -1,
  raceStartT: 0,
  totalLaps: 3,

  keys: {},
  cameraMode: 0,           // 0 chase, 1 cockpit, 2 top
  minimapCtx: null,
  lastPosBroadcast: 0,

  // host-only — but we don't really need authority since each client tracks own race progress.
};

const $ = (s) => document.querySelector(s);

// =============================================================
//  Scene setup
// =============================================================
function initScene() {
  const canvas = $("#scene");
  state.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  state.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  state.renderer.setSize(window.innerWidth, window.innerHeight);

  // Cinematic tone mapping + shadows
  state.renderer.toneMapping = THREE.ACESFilmicToneMapping;
  state.renderer.toneMappingExposure = 1.15;
  state.renderer.outputColorSpace = THREE.SRGBColorSpace;
  state.renderer.shadowMap.enabled = true;
  state.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  state.scene = new THREE.Scene();

  state.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 1200);
  state.camera.position.set(0, 8, 14);
  state.camera.lookAt(0, 0, 0);

  // Environment map — gives cars subtle reflections
  const pmrem = new THREE.PMREMGenerator(state.renderer);
  pmrem.compileEquirectangularShader();
  state.envMap = pmrem.fromScene(new RoomEnvironment(state.renderer), 0.04).texture;
  state.scene.environment = state.envMap;

  // Composer + bloom (tuned for ACES)
  state.composer = new EffectComposer(state.renderer);
  state.composer.addPass(new RenderPass(state.scene, state.camera));
  state.bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.5, 0.6, 0.88
  );
  state.composer.addPass(state.bloom);
  state.composer.addPass(new OutputPass());

  state.themeGroup = new THREE.Group();
  state.scene.add(state.themeGroup);

  // Title cam: orbit a placeholder
  buildPreviewScene();

  // Start loading the Ferrari model in background — used when cars are spawned
  loadFerrariModel();

  window.addEventListener("resize", onResize);
}

// Try to load a real 3D car model. Falls back to procedural if it fails.
let ferrariLoaded = false;
let ferrariTemplate = null;
function loadFerrariModel() {
  const loader = new GLTFLoader();
  const url = "https://threejs.org/examples/models/gltf/ferrari.glb";
  loader.load(
    url,
    (gltf) => {
      const car = gltf.scene;
      car.traverse((c) => {
        if (c.isMesh) {
          c.castShadow = true;
          c.receiveShadow = true;
        }
      });
      ferrariTemplate = car;
      ferrariLoaded = true;
      // Upgrade existing cars on next frame
      for (const c of Object.values(state.cars)) {
        upgradeCarMeshToFerrari(c);
      }
      if (state.previewCar) upgradeCarMeshToFerrari(state.previewCar);
    },
    undefined,
    (err) => {
      console.warn("Ferrari model failed to load, using procedural car", err);
    }
  );
}

function upgradeCarMeshToFerrari(car) {
  if (!ferrariTemplate || car._ferrariUpgraded) return;
  car._ferrariUpgraded = true;

  // Remove old procedural mesh children (keep label)
  const label = car.mesh.userData?.label;
  const oldBody = car.mesh.userData?.bodyPivot;
  if (oldBody) car.mesh.remove(oldBody);
  for (const w of car.mesh.userData?.wheels || []) car.mesh.remove(w);

  const clone = ferrariTemplate.clone(true);
  clone.scale.setScalar(1.0);
  // The Ferrari model's body color comes from a "body" material — tint it
  clone.traverse((c) => {
    if (!c.isMesh) return;
    const m = c.material;
    if (!m) return;
    if (m.name === "body" || m.name === "Body" || (m.color && m.metalness > 0.5)) {
      const tinted = m.clone();
      tinted.color.setHex(car.color);
      tinted.metalness = 0.85;
      tinted.roughness = 0.18;
      tinted.envMapIntensity = 1.0;
      c.material = tinted;
    }
  });

  // Identify wheels by name (Ferrari model uses wheel_fl, wheel_fr, wheel_rl, wheel_rr)
  const wheels = [];
  clone.traverse((c) => {
    if (c.name && /^wheel/i.test(c.name)) {
      const isFront = /fl|fr/i.test(c.name);
      wheels.push({ mesh: c, steered: isFront, baseRotation: c.rotation.clone() });
    }
  });

  car.mesh.add(clone);
  car.mesh.userData.body = clone;
  car.mesh.userData.wheels = wheels;
  car.wheels = wheels;
  if (label) {
    // Keep label
    label.position.y = 1.8;
  }
}

function onResize() {
  state.camera.aspect = window.innerWidth / window.innerHeight;
  state.camera.updateProjectionMatrix();
  state.renderer.setSize(window.innerWidth, window.innerHeight);
  state.composer.setSize(window.innerWidth, window.innerHeight);
  state.bloom.setSize(window.innerWidth, window.innerHeight);
}

function clearGroup(g) {
  while (g.children.length) {
    const c = g.children.pop();
    g.remove(c);
    if (c.geometry) c.geometry.dispose?.();
    if (c.material) {
      if (Array.isArray(c.material)) c.material.forEach(m => m.dispose?.());
      else c.material.dispose?.();
    }
  }
}

// Build a moody background for the title screen.
function buildPreviewScene() {
  const scene = state.scene;
  scene.background = new THREE.Color(0x0a0c14);
  scene.fog = new THREE.FogExp2(0x0a0c14, 0.02);
  const amb = new THREE.AmbientLight(0x404060, 0.4);
  state.themeGroup.add(amb);
  const key = new THREE.DirectionalLight(0xff8030, 1.2);
  key.position.set(20, 10, 20);
  state.themeGroup.add(key);
  // A floating preview car
  const previewCar = new Car({ id: "preview", name: "", color: COLORS[0], scene: state.scene });
  previewCar.mesh.userData.label.visible = false;
  state.previewCar = previewCar;
}

function rebuildTheme(theme) {
  clearGroup(state.themeGroup);

  // Real sky shader for daytime tracks. Neon track keeps a solid dark backdrop.
  if (theme.props !== "neon") {
    const sky = new Sky();
    sky.scale.setScalar(2000);
    const u = sky.material.uniforms;
    u.turbidity.value = theme.props === "desert" ? 12 : 6;
    u.rayleigh.value = theme.props === "desert" ? 2 : 2.5;
    u.mieCoefficient.value = 0.005;
    u.mieDirectionalG.value = 0.8;
    // Sun position (elevation/azimuth)
    const phi = THREE.MathUtils.degToRad(90 - (theme.props === "desert" ? 12 : 45));
    const theta = THREE.MathUtils.degToRad(theme.props === "desert" ? -150 : 60);
    const sunVec = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(sunVec);
    state.themeGroup.add(sky);
    state.skySunVec = sunVec;
    state.scene.background = null; // sky covers it
  } else {
    state.scene.background = new THREE.Color(theme.sky);
  }

  state.scene.fog = new THREE.Fog(theme.fogColor, theme.fogNear, theme.fogFar);

  const amb = new THREE.HemisphereLight(theme.hemiTop, theme.hemiBot, theme.hemiInt);
  state.themeGroup.add(amb);

  // Directional sun, casts shadows
  const sun = new THREE.DirectionalLight(theme.sunColor, theme.sunInt);
  const sp = state.skySunVec ? state.skySunVec.clone().multiplyScalar(220) : new THREE.Vector3(...theme.sunPos);
  sun.position.copy(sp);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 400;
  sun.shadow.camera.left = -90;
  sun.shadow.camera.right = 90;
  sun.shadow.camera.top = 90;
  sun.shadow.camera.bottom = -90;
  sun.shadow.bias = -0.0008;
  state.themeGroup.add(sun);
  state.sunLight = sun;

  state.bloom.strength = theme.bloomStrength;
  state.bloom.threshold = theme.bloomThreshold;
  state.bloom.radius = 0.55;
}

// =============================================================
//  Track + props
// =============================================================
function buildTrack(trackId) {
  const track = TRACKS[trackId];
  state.trackId = trackId;
  state.totalLaps = track.laps;

  // Remove the title-screen preview car so it doesn't block the view at start
  if (state.previewCar) {
    state.scene.remove(state.previewCar.mesh);
    state.previewCar = null;
  }

  // Clear old track
  if (state.trackGroup) {
    clearGroup(state.trackGroup);
    state.scene.remove(state.trackGroup);
  }
  state.trackGroup = new THREE.Group();
  state.scene.add(state.trackGroup);
  state.swayUniforms = [];

  rebuildTheme(track.theme);
  buildGround(track);

  const data = buildTrackGeometry(track);
  state.trackData = data;

  // Road — much brighter so it actually reads as asphalt
  const roadColor = track.id === "neon" ? 0x18181f : 0x4a4a52;
  const roadMat = new THREE.MeshStandardMaterial({
    color: roadColor,
    roughness: 0.85,
    metalness: 0.0,
  });
  const road = new THREE.Mesh(data.roadGeo, roadMat);
  road.receiveShadow = true;
  state.trackGroup.add(road);

  // Walls — railing-like, bright
  const wallMat = track.theme.wallEmissive
    ? new THREE.MeshStandardMaterial({
        color: track.theme.wallEmissive, emissive: track.theme.wallEmissive,
        emissiveIntensity: 1.6,
      })
    : new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.55, metalness: 0.4 });
  const lw = new THREE.Mesh(data.leftWall, wallMat);
  const rw = new THREE.Mesh(data.rightWall, wallMat);
  lw.castShadow = true; rw.castShadow = true;
  lw.receiveShadow = true; rw.receiveShadow = true;
  state.trackGroup.add(lw, rw);

  // Curb stripes (red/white) on the inside edge — strongly visible
  const curbRedMat = new THREE.MeshBasicMaterial({ color: 0xe83040 });
  const curbWhiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const curbLeft = new THREE.Group();
  const curbRight = new THREE.Group();
  for (let i = 0; i < data.samples.length; i += 4) {
    const s = data.samples[i];
    const mat = (i / 4) % 2 === 0 ? curbRedMat : curbWhiteMat;
    const curbW = 0.6;
    const baseL = s.p.clone().addScaledVector(s.right, -(TRACK_WIDTH / 2) + curbW / 2);
    const baseR = s.p.clone().addScaledVector(s.right,  (TRACK_WIDTH / 2) - curbW / 2);
    const cl = new THREE.Mesh(new THREE.PlaneGeometry(curbW, 1.4), mat);
    cl.position.set(baseL.x, baseL.y + 0.07, baseL.z);
    cl.rotation.x = -Math.PI / 2;
    cl.rotation.z = -Math.atan2(s.tan.x, s.tan.z);
    curbLeft.add(cl);
    const cr = new THREE.Mesh(new THREE.PlaneGeometry(curbW, 1.4), mat);
    cr.position.set(baseR.x, baseR.y + 0.07, baseR.z);
    cr.rotation.x = -Math.PI / 2;
    cr.rotation.z = -Math.atan2(s.tan.x, s.tan.z);
    curbRight.add(cr);
  }
  state.trackGroup.add(curbLeft, curbRight);

  // Center line dashes (brighter, more frequent)
  const dashMat = new THREE.MeshBasicMaterial({ color: 0xffff80 });
  for (let i = 0; i < data.samples.length; i += 6) {
    const s = data.samples[i];
    const dash = new THREE.Mesh(new THREE.PlaneGeometry(0.35, 2.4), dashMat);
    dash.position.set(s.p.x, s.p.y + 0.08, s.p.z);
    dash.rotation.x = -Math.PI / 2;
    dash.rotation.z = -Math.atan2(s.tan.x, s.tan.z);
    state.trackGroup.add(dash);
  }

  // Start/finish line
  const finishMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const start = data.samples[0];
  const finishLine = new THREE.Mesh(new THREE.PlaneGeometry(TRACK_WIDTH, 0.6), finishMat);
  finishLine.position.set(start.p.x, start.p.y + 0.1, start.p.z);
  finishLine.rotation.x = -Math.PI / 2;
  finishLine.rotation.z = -Math.atan2(start.tan.x, start.tan.z);
  state.trackGroup.add(finishLine);
  // Checkered overlay using grid sub-strips
  for (let i = 0; i < 8; i++) {
    const block = new THREE.Mesh(
      new THREE.PlaneGeometry(TRACK_WIDTH / 8, 0.3),
      new THREE.MeshBasicMaterial({ color: i % 2 ? 0x000000 : 0xffffff })
    );
    block.position.set(start.p.x, start.p.y + 0.11, start.p.z);
    // Offset laterally along track right
    const offX = ((i + 0.5) / 8 - 0.5) * TRACK_WIDTH;
    block.position.x += start.right.x * offX;
    block.position.z += start.right.z * offX;
    block.rotation.x = -Math.PI / 2;
    block.rotation.z = -Math.atan2(start.tan.x, start.tan.z);
    state.trackGroup.add(block);
  }

  // Theme-specific props
  if (track.theme.props === "forest") placeForestProps(data, track.theme);
  else if (track.theme.props === "desert") placeDesertProps(data, track.theme);
  else if (track.theme.props === "neon") placeNeonProps(data, track.theme);

  // Place camera initially at start
  positionCarsAtStart();
  updateChaseCamera(0.016);
}

function buildGround(track) {
  const SIZE = 1400;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, 80, 80);
  // Subtle far-field rolling — kept SMALL so it never rises above the road surface.
  // The road sits at y≈0.05; if terrain bumps poke above that, they bury the car.
  const pos = geo.attributes.position;
  const bumpAmp = (track.theme.groundBumpScale ?? 1.5) * 0.15; // attenuate to safe range
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    // Strongly suppress bumps near the track centerline
    const distFromCenter = Math.sqrt(x * x + y * y);
    const farMask = Math.min(1, Math.max(0, (distFromCenter - 40) / 200));
    let h = Math.sin(x * 0.012) * bumpAmp + Math.cos(y * 0.014) * bumpAmp;
    h += Math.sin((x + y) * 0.03) * bumpAmp * 0.5;
    h *= farMask;
    pos.setZ(i, h);
  }
  geo.computeVertexNormals();
  // Add subtle vertex colors for a less monotone ground
  const colors = [];
  for (let i = 0; i < pos.count; i++) {
    const base = new THREE.Color(track.theme.ground);
    const jitter = (i * 9301 + 49297) % 233 / 233 * 0.12 - 0.06;
    colors.push(base.r + jitter, base.g + jitter * 0.7, base.b + jitter * 0.4);
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1.0 });
  const ground = new THREE.Mesh(geo, mat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.6;
  ground.receiveShadow = true;
  state.trackGroup.add(ground);
}

function placeForestProps(data, theme) {
  const rng = seededRng(0x42);

  // Three tree variants: tall pine, wide pine, dark fir
  const variants = [
    { color: 0x1f3a16, trunk: 0x2a1a10, height: 1.0 },
    { color: 0x2a4a20, trunk: 0x3a2515, height: 1.4 },
    { color: 0x183010, trunk: 0x251510, height: 0.8 },
  ];
  const byVariant = variants.map(() => []);

  for (let i = 0; i < 1100; i++) {
    const x = (rng() - 0.5) * 1300;
    const z = (rng() - 0.5) * 1300;
    const near = nearestOnTrack(data.samples, x, z);
    // Allow trees right up to 7m from the road for that "racing through forest" feel
    if (near.dist < 7) continue;
    if (near.dist > 350) continue; // skip extreme outliers (we render rest as silhouettes)
    const v = Math.floor(rng() * 3);
    byVariant[v].push({ x, z, s: 0.7 + rng() * 0.9, r: rng() * Math.PI * 2 });
  }

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const eul = new THREE.Euler();
  const sc = new THREE.Vector3();
  const p = new THREE.Vector3();

  variants.forEach((v, vi) => {
    const list = byVariant[vi];
    if (list.length === 0) return;
    const trunkGeo = new THREE.CylinderGeometry(0.35, 0.55, 6 * v.height, 6);
    const trunkMat = new THREE.MeshLambertMaterial({ color: v.trunk });
    const trunkInst = new THREE.InstancedMesh(trunkGeo, trunkMat, list.length);
    trunkInst.castShadow = true;

    // Sway shader for canopies — injects time-based displacement
    const swayUniform = { value: 0 };
    state.swayUniforms = state.swayUniforms || [];
    state.swayUniforms.push(swayUniform);
    const canopyMatColor = new THREE.MeshLambertMaterial({ color: v.color });
    canopyMatColor.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = swayUniform;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nuniform float uTime;")
        .replace(
          "#include <begin_vertex>",
          `vec3 transformed = vec3(position);
           // Sway proportional to vertex height (so top sways more)
           float h = max(0.0, position.y);
           float t = uTime;
           transformed.x += sin(t * 1.4 + position.y * 0.5 + position.z) * 0.12 * h;
           transformed.z += cos(t * 1.1 + position.y * 0.4 + position.x) * 0.10 * h;`
        );
    };

    // Two-cone canopy for fuller silhouette
    const lowerGeo = new THREE.ConeGeometry(2.6, 4.5 * v.height, 7);
    const lowerInst = new THREE.InstancedMesh(lowerGeo, canopyMatColor, list.length);
    lowerInst.castShadow = true;

    const upperGeo = new THREE.ConeGeometry(1.6, 3.5 * v.height, 7);
    const upperInst = new THREE.InstancedMesh(upperGeo, canopyMatColor, list.length);
    upperInst.castShadow = true;

    list.forEach((pp, i) => {
      eul.set(0, pp.r, 0); q.setFromEuler(eul);
      sc.set(pp.s, pp.s, pp.s);

      p.set(pp.x, 3 * v.height * pp.s, pp.z);
      m.compose(p, q, sc); trunkInst.setMatrixAt(i, m);

      p.set(pp.x, (6 * v.height + 2.25 * v.height) * pp.s - 0.3, pp.z);
      m.compose(p, q, sc); lowerInst.setMatrixAt(i, m);

      p.set(pp.x, (6 * v.height + 5 * v.height) * pp.s, pp.z);
      m.compose(p, q, sc); upperInst.setMatrixAt(i, m);
    });

    trunkInst.instanceMatrix.needsUpdate = true;
    lowerInst.instanceMatrix.needsUpdate = true;
    upperInst.instanceMatrix.needsUpdate = true;
    state.trackGroup.add(trunkInst, lowerInst, upperInst);
  });

  // Grass tufts scattered close to the road for foreground interest
  const tuftGeo = new THREE.ConeGeometry(0.18, 0.55, 4);
  const tuftMat = new THREE.MeshLambertMaterial({ color: 0x4a6a3a });
  const tufts = [];
  for (let i = 0; i < 500; i++) {
    const x = (rng() - 0.5) * 800;
    const z = (rng() - 0.5) * 800;
    const near = nearestOnTrack(data.samples, x, z);
    if (near.dist < 6 || near.dist > 40) continue;
    tufts.push({ x, z, r: rng() * Math.PI * 2 });
  }
  if (tufts.length > 0) {
    const tuftInst = new THREE.InstancedMesh(tuftGeo, tuftMat, tufts.length);
    tufts.forEach((t, i) => {
      eul.set(0, t.r, 0); q.setFromEuler(eul);
      p.set(t.x, 0.25, t.z); sc.set(1, 1, 1);
      m.compose(p, q, sc); tuftInst.setMatrixAt(i, m);
    });
    tuftInst.instanceMatrix.needsUpdate = true;
    state.trackGroup.add(tuftInst);
  }

  // Wildflowers (small bright cubes) for spots of color
  const flowerColors = [0xff8060, 0xffd060, 0xe080f0];
  flowerColors.forEach((col, ci) => {
    const fg = new THREE.BoxGeometry(0.18, 0.18, 0.18);
    const fm = new THREE.MeshLambertMaterial({ color: col });
    const flowers = [];
    for (let i = 0; i < 200; i++) {
      const x = (rng() - 0.5) * 600;
      const z = (rng() - 0.5) * 600;
      const near = nearestOnTrack(data.samples, x, z);
      if (near.dist < 7 || near.dist > 24) continue;
      flowers.push({ x, z });
    }
    if (flowers.length === 0) return;
    const finst = new THREE.InstancedMesh(fg, fm, flowers.length);
    flowers.forEach((f, i) => {
      eul.set(0, 0, 0); q.setFromEuler(eul);
      p.set(f.x, 0.15, f.z); sc.set(1, 1, 1);
      m.compose(p, q, sc); finst.setMatrixAt(i, m);
    });
    finst.instanceMatrix.needsUpdate = true;
    state.trackGroup.add(finst);
  });
}

function placeDesertProps(data, theme) {
  const rng = seededRng(0x99);
  // Cacti and rocks
  const cactusGeo = new THREE.CylinderGeometry(0.5, 0.6, 3, 5);
  const cactusMat = new THREE.MeshLambertMaterial({ color: 0x5a7d3a });
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  const rockMat = new THREE.MeshLambertMaterial({ color: 0xa68056 });

  const cacti = [];
  const rocks = [];
  for (let i = 0; i < 240; i++) {
    const x = (rng() - 0.5) * 1400;
    const z = (rng() - 0.5) * 1400;
    const near = nearestOnTrack(data.samples, x, z);
    if (near.dist < 15) continue;
    if (rng() < 0.5) cacti.push({ x, z, s: 0.6 + rng() * 0.9 });
    else rocks.push({ x, z, s: 0.5 + rng() * 1.4, r: rng() * Math.PI * 2 });
  }

  const cactusInst = new THREE.InstancedMesh(cactusGeo, cactusMat, cacti.length);
  const rockInst = new THREE.InstancedMesh(rockGeo, rockMat, rocks.length);
  const m = new THREE.Matrix4(); const q = new THREE.Quaternion();
  const eul = new THREE.Euler(); const sc = new THREE.Vector3(); const p = new THREE.Vector3();
  cacti.forEach((c, i) => {
    p.set(c.x, 1.5 * c.s, c.z); sc.set(c.s, c.s, c.s);
    eul.set(0, 0, 0); q.setFromEuler(eul);
    m.compose(p, q, sc); cactusInst.setMatrixAt(i, m);
  });
  rocks.forEach((r, i) => {
    p.set(r.x, 0.5 * r.s, r.z); sc.set(r.s, r.s * 0.6, r.s);
    eul.set(r.r * 0.3, r.r, r.r * 0.5); q.setFromEuler(eul);
    m.compose(p, q, sc); rockInst.setMatrixAt(i, m);
  });
  cactusInst.instanceMatrix.needsUpdate = true;
  rockInst.instanceMatrix.needsUpdate = true;
  state.trackGroup.add(cactusInst); state.trackGroup.add(rockInst);

  // Distant dunes (low gradient cones)
  const duneMat = new THREE.MeshLambertMaterial({ color: 0xb87a4a });
  for (let i = 0; i < 22; i++) {
    const a = (i / 22) * Math.PI * 2;
    const dist = 480 + rng() * 240;
    const d = new THREE.Mesh(new THREE.ConeGeometry(60 + rng() * 40, 28 + rng() * 20, 7), duneMat);
    d.position.set(Math.cos(a) * dist, 14, Math.sin(a) * dist);
    state.trackGroup.add(d);
  }
}

function placeNeonProps(data, theme) {
  const rng = seededRng(0xC0FFEE);
  // Tall thin neon "buildings"
  for (let i = 0; i < 90; i++) {
    const x = (rng() - 0.5) * 900;
    const z = (rng() - 0.5) * 900;
    const near = nearestOnTrack(data.samples, x, z);
    if (near.dist < 28) continue;
    const h = 12 + rng() * 80;
    const w = 6 + rng() * 12;
    const hue = rng() < 0.5 ? 0xff20a0 : (rng() < 0.5 ? 0x20a0ff : 0x80ffa0);
    const building = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, w),
      new THREE.MeshStandardMaterial({ color: 0x080812, emissive: 0x040408 })
    );
    building.position.set(x, h / 2, z);
    state.trackGroup.add(building);
    // Neon strip on top
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(w * 0.95, 0.4, w * 0.95),
      new THREE.MeshStandardMaterial({ color: hue, emissive: hue, emissiveIntensity: 2.0 })
    );
    stripe.position.set(x, h, z);
    state.trackGroup.add(stripe);
    // Vertical neon line
    if (rng() < 0.6) {
      const line = new THREE.Mesh(
        new THREE.BoxGeometry(0.18, h * 0.8, 0.18),
        new THREE.MeshStandardMaterial({ color: hue, emissive: hue, emissiveIntensity: 1.8 })
      );
      line.position.set(x + w / 2 - 0.1, h * 0.55, z);
      state.trackGroup.add(line);
    }
  }
}

function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// =============================================================
//  Cars
// =============================================================
function positionCarsAtStart() {
  const data = state.trackData;
  if (!data) return;
  const start = data.samples[0];
  const ids = Object.keys(state.cars);
  ids.forEach((id, i) => {
    const car = state.cars[id];
    // Stagger cars in a 2-column grid behind the start
    const col = i % 2 === 0 ? -1 : 1;
    const row = Math.floor(i / 2);
    const offsetBack = 6 + row * 6;
    const back = start.tan.clone().multiplyScalar(-offsetBack);
    const lat = start.right.clone().multiplyScalar(col * 2.8);
    car.pos.set(start.p.x + back.x + lat.x, 0, start.p.z + back.z + lat.z);
    car.vel.set(0, 0, 0);
    car.heading = Math.atan2(start.tan.x, start.tan.z);
    car.currentCheckpoint = 0;
    car.lap = 0;
    car.lapTimes = [];
    car.bestLap = Infinity;
    car.raceTime = 0;
    car.finished = false;
    car.finishTime = 0;
    car.lastTrackIndex = 0;
    car.updateMesh(0.016);
  });
}

function spawnCar({ id, name, color, isLocal }) {
  if (state.cars[id]) return state.cars[id];
  const car = new Car({ id, name, color, isLocal, scene: state.scene });
  state.cars[id] = car;
  return car;
}

function removeCar(id) {
  const c = state.cars[id];
  if (!c) return;
  state.scene.remove(c.mesh);
  delete state.cars[id];
}

// =============================================================
//  Physics integration (local + AI + wall + checkpoint)
// =============================================================
function stepCarPhysics(car, dt, isLocal) {
  if (state.phase === "racing" || state.phase === "finished") {
    car.step(dt);
  } else {
    // Idle — keep wheels still
    car.vel.set(0, 0, 0);
  }

  // Track + wall + off-track
  const data = state.trackData;
  if (!data) return;
  const near = nearestOnTrack(data.samples, car.pos.x, car.pos.z, car.lastTrackIndex);
  car.lastTrackIndex = near.index;

  const halfW = TRACK_WIDTH / 2;
  const wallEdge = halfW + 0.5;
  car.onGrass = Math.abs(near.lateral) > halfW;

  // Wall collision: push back, bounce
  if (Math.abs(near.lateral) > wallEdge) {
    const sign = near.lateral > 0 ? 1 : -1;
    const sample = near.sample;
    const correction = (Math.abs(near.lateral) - wallEdge) * sign;
    car.pos.x -= sample.right.x * correction;
    car.pos.z -= sample.right.z * correction;

    // Bounce: reflect lateral velocity component
    const rt = sample.right;
    const vLat = car.vel.dot(rt);
    const vTan = car.vel.dot(new THREE.Vector3(rt.z, 0, -rt.x)); // perpendicular in plane
    const newLat = -vLat * 0.5;
    car.vel.set(rt.z * vTan + rt.x * newLat, 0, -rt.x * vTan + rt.z * newLat);

    if (isLocal && car.speed() > 6) {
      // FX
      const hitPos = car.pos.clone();
      hitPos.y = 0.6;
      spawnSparks(state.scene, hitPos, { count: 18, speed: 9 });
      sfxCollision(Math.min(1, car.speed() / 30));
      cameraShake(Math.min(0.7, car.speed() / 40));
    }
  }

  // Follow track surface elevation
  const groundY = near.sample.p.y;
  if (!car.airborne) {
    // Snap car to road surface
    car.pos.y = groundY + (car.airborne ? car.yPos : 0);
  }

  // Jump detection — if we're on a lifted track section, we can leave at the end
  // (Not fully simulated here; jumps look fine as smooth rise/fall along centerline.)

  // Checkpoint logic
  if (state.phase === "racing" && !car.finished) {
    // Determine next checkpoint t
    const nextCpIdx = car.currentCheckpoint;
    const nextCp = data.checkpoints[nextCpIdx];
    // Check whether the car's t has passed the checkpoint t (with wrap awareness)
    const carT = near.t;
    let advance = false;
    if (nextCpIdx === 0) {
      // Crossing the start/finish line — must be after passing checkpoint N-1
      // We treat this as: if we previously had checkpoint N-1 and now we crossed t≈0
      // Detect by carT being very small (< 0.05) while we had been near 1.0 recently
      if (carT < 0.06 && car.lastT > 0.9) advance = true;
    } else {
      // Linear advancement
      const cpT = nextCp.t;
      if (carT >= cpT && carT < cpT + 0.2) advance = true;
    }
    car.lastT = carT;
    if (advance) {
      const finishedCp = car.currentCheckpoint;
      car.currentCheckpoint = (car.currentCheckpoint + 1) % CHECKPOINT_COUNT;
      if (finishedCp === 0 && car.lap > 0) {
        // Already done one lap — record lap time
        const lt = car.raceTime - car.lapStartT;
        car.lapStartT = car.raceTime;
        car.lapTimes.push(lt);
        if (lt < car.bestLap) car.bestLap = lt;
      } else if (finishedCp === 0) {
        // First crossing after start
        car.lapStartT = car.raceTime;
      }
      if (car.currentCheckpoint === 0) {
        // Just finished a lap — increment lap counter
        car.lap += 1;
        if (isLocal) {
          if (car.lap === state.totalLaps) {
            car.finished = true;
            car.finishTime = car.raceTime;
            onLocalFinished();
          } else {
            sfxLap();
            showCenterMsg(`LAP ${car.lap + 1}`, 1.0);
          }
        }
      }
    }
  }
}

// =============================================================
//  Camera
// =============================================================
const TMP_V3 = new THREE.Vector3();
const TMP_V3B = new THREE.Vector3();

function updateChaseCamera(dt) {
  const car = state.myCar || state.previewCar;
  if (!car) return;

  const speed = car.vel?.length() ?? 0;
  const fovBoost = car.boostActive ? 6 : 0;
  state.camera.fov = 74 + Math.min(speed * 0.12, 6) + fovBoost;
  state.camera.updateProjectionMatrix();

  if (state.cameraMode === 0) {
    // Chase camera — behind & above, look AT the car so it's always centered
    const fwd = new THREE.Vector3(Math.sin(car.heading), 0, Math.cos(car.heading));
    const camOffset = fwd.clone().multiplyScalar(-7.5);
    const target = new THREE.Vector3(car.pos.x + camOffset.x, car.pos.y + 4.6, car.pos.z + camOffset.z);
    state.camera.position.lerp(target, Math.min(1, dt * 10));
    // Look at the car (slightly above so road behind is visible too)
    state.camera.lookAt(car.pos.x, car.pos.y + 1.0, car.pos.z);
  } else if (state.cameraMode === 1) {
    // Cockpit
    const fwd = new THREE.Vector3(Math.sin(car.heading), 0, Math.cos(car.heading));
    state.camera.position.set(car.pos.x, car.pos.y + 1.45, car.pos.z);
    const look = new THREE.Vector3(car.pos.x + fwd.x * 5, car.pos.y + 1.45, car.pos.z + fwd.z * 5);
    state.camera.lookAt(look);
  } else {
    // Top-down
    state.camera.position.set(car.pos.x, car.pos.y + 22, car.pos.z + 0.001);
    state.camera.lookAt(car.pos.x, car.pos.y, car.pos.z);
  }
}

// =============================================================
//  Networking
// =============================================================
function onMessage(msg) {
  if (!msg) return;
  switch (msg.type) {
    case "hello": {
      if (msg.id === state.myId) break;
      if (!state.cars[msg.id]) {
        const car = spawnCar({ id: msg.id, name: msg.name || "Driver", color: msg.color ?? COLORS[1], isLocal: false });
        car.alive = true;
      } else {
        state.cars[msg.id].name = msg.name;
      }
      updateLobby();
      // Host sends snapshot back
      if (state.isHost) {
        const peerInfo = {};
        for (const [id, c] of Object.entries(state.cars)) {
          if (id === state.myId) peerInfo[id] = { name: state.myName, color: state.myColor };
          else peerInfo[id] = { name: c.name, color: c.color };
        }
        state.net.send({
          type: "snapshot", to: msg.id,
          trackId: state.trackId, phase: state.phase,
          drivers: peerInfo,
        });
      }
      break;
    }
    case "snapshot": {
      if (msg.to !== state.myId) break;
      if (msg.trackId && msg.trackId !== state.trackId) {
        buildTrack(msg.trackId);
      }
      // Add any drivers we don't know
      for (const [id, info] of Object.entries(msg.drivers || {})) {
        if (id === state.myId) continue;
        if (!state.cars[id]) {
          spawnCar({ id, name: info.name, color: info.color, isLocal: false });
        }
      }
      // If race already started, drop into countdown/racing
      if (msg.phase === "countdown" || msg.phase === "racing") {
        ensureLocalCar();
        positionCarsAtStart();
        $("#screen-lobby").classList.add("hidden");
        $("#hud").classList.remove("hidden");
        state.phase = msg.phase;
      }
      updateLobby();
      break;
    }
    case "start-countdown": {
      if (msg.trackId !== state.trackId) buildTrack(msg.trackId);
      $("#screen-lobby").classList.add("hidden");
      $("#hud").classList.remove("hidden");
      ensureLocalCar();
      positionCarsAtStart();
      beginCountdown();
      break;
    }
    case "pos": {
      if (msg.id === state.myId) break;
      const car = state.cars[msg.id];
      if (!car) break;
      car.tx = msg.x; car.ty = msg.y; car.tz = msg.z;
      car.tHeading = msg.h;
      car.boostActive = !!msg.b;
      car.drifting = !!msg.d;
      car.lap = msg.lap ?? car.lap;
      car.currentCheckpoint = msg.cp ?? car.currentCheckpoint;
      car.raceTime = msg.t ?? car.raceTime;
      car.lastNetUpdate = performance.now();
      break;
    }
    case "finished": {
      const car = state.cars[msg.id];
      if (car) {
        car.finished = true;
        car.finishTime = msg.time;
      }
      break;
    }
    case "leave": {
      removeCar(msg.id);
      updateLobby();
      break;
    }
  }
}

function ensureLocalCar() {
  if (!state.cars[state.myId]) {
    state.myCar = spawnCar({ id: state.myId, name: state.myName, color: state.myColor, isLocal: true });
    state.myCar.mesh.userData.label.visible = false; // hide your own label
  } else {
    state.myCar = state.cars[state.myId];
  }
}

// =============================================================
//  Race lifecycle
// =============================================================
function beginCountdown() {
  state.phase = "countdown";
  state.countdownT = 0;
  state.countdownStep = -1;
}

function tickCountdown(dt) {
  if (state.phase !== "countdown") return;
  state.countdownT += dt;
  const step = Math.floor(state.countdownT);
  if (step !== state.countdownStep) {
    state.countdownStep = step;
    if (step === 0) { showCenterMsg("3", 0.9); sfxCountdownBeep(false); }
    else if (step === 1) { showCenterMsg("2", 0.9); sfxCountdownBeep(false); }
    else if (step === 2) { showCenterMsg("1", 0.9); sfxCountdownBeep(false); }
    else if (step === 3) {
      showCenterMsg("GO!", 0.9);
      sfxCountdownBeep(true);
      state.phase = "racing";
      state.raceStartT = performance.now() / 1000;
      // Reset per-car race time
      for (const c of Object.values(state.cars)) {
        c.raceTime = 0;
        c.lapStartT = 0;
      }
    }
  }
}

function onLocalFinished() {
  sfxFinish();
  showCenterMsg("FINISH", 2.0);
  state.net.send({ type: "finished", id: state.myId, time: state.myCar.finishTime });
  setTimeout(showFinishScreen, 1800);
}

function showFinishScreen() {
  state.phase = "finished";
  $("#hud").classList.add("hidden");
  $("#screen-finish").classList.remove("hidden");
  // Build results list (only those finished, then those not finished by progress)
  const all = Object.values(state.cars);
  const finishedCars = all.filter(c => c.finished).sort((a, b) => a.finishTime - b.finishTime);
  const unfinished = all.filter(c => !c.finished)
    .sort((a, b) => raceProgress(b) - raceProgress(a));
  const results = [...finishedCars, ...unfinished];

  $("#finish-title").textContent = state.myCar && results[0] && results[0].id === state.myId
    ? "Victory"
    : "Race complete";

  const root = $("#finish-results");
  root.innerHTML = "";
  results.forEach((c, i) => {
    const row = document.createElement("div");
    row.className = "end-stat-row";
    row.style.color = "#" + new THREE.Color(c.color).getHexString();
    const time = c.finished ? formatTime(c.finishTime) : `Lap ${c.lap + 1}`;
    row.innerHTML = `
      <span class="pos">P${i + 1}</span>
      <span class="nm">${escapeHTML(c.name)}${c.isLocal ? " (you)" : ""}</span>
      <span class="tm">${time}</span>
    `;
    root.appendChild(row);
  });
}

function raceProgress(car) {
  return (car.lap || 0) + ((car.currentCheckpoint || 0) / CHECKPOINT_COUNT);
}

// =============================================================
//  HUD
// =============================================================
function updateHUD() {
  if (state.phase !== "racing" && state.phase !== "countdown" && state.phase !== "finished") return;
  const car = state.myCar;
  if (!car) return;

  // Speed
  const kmh = Math.round(car.speed() * 3.6);
  $("#speed-num").textContent = kmh;

  // Boost bar
  $("#boost-fill").style.width = (car.boost * 100) + "%";
  $("#boost-fill").classList.toggle("full", car.boost >= 0.99);

  // Lap / pos
  $("#lap-num").textContent = `${Math.min(state.totalLaps, car.lap + 1)}/${state.totalLaps}`;

  // Position — sort cars by progress
  const cars = Object.values(state.cars);
  cars.sort((a, b) => {
    if (a.finished && !b.finished) return -1;
    if (!a.finished && b.finished) return 1;
    if (a.finished && b.finished) return a.finishTime - b.finishTime;
    return raceProgress(b) - raceProgress(a);
  });
  const myIdx = cars.findIndex(c => c.id === state.myId);
  $("#pos-num").textContent = `${Math.max(1, myIdx + 1)}/${cars.length}`;

  // Time
  $("#race-time").textContent = formatTime(car.raceTime);
  $("#best-lap").textContent = car.bestLap < Infinity ? formatTime(car.bestLap) : "—";

  // Standings list
  const stRoot = $("#standings");
  stRoot.innerHTML = "";
  cars.forEach((c, i) => {
    const row = document.createElement("div");
    row.className = "standing-row" + (c.id === state.myId ? " me" : "");
    row.style.color = "#" + new THREE.Color(c.color).getHexString();
    const gap = c.finished
      ? formatTime(c.finishTime)
      : i === 0
        ? "—"
        : "+" + Math.max(0, (raceProgress(cars[0]) - raceProgress(c))).toFixed(2);
    row.innerHTML = `
      <span class="pos">P${i + 1}</span>
      <span class="nm">${escapeHTML(c.name)}</span>
      <span class="gap">${gap}</span>
    `;
    stRoot.appendChild(row);
  });

  // Minimap
  drawMinimap();
}

function drawMinimap() {
  const ctx = state.minimapCtx;
  if (!ctx) return;
  const W = 180, H = 180;
  ctx.clearRect(0, 0, W, H);
  const data = state.trackData;
  if (!data) return;
  // Find bounds of track
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < data.samples.length; i += 4) {
    const p = data.samples[i].p;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  const pad = 14;
  const sx = (W - pad * 2) / (maxX - minX || 1);
  const sz = (H - pad * 2) / (maxZ - minZ || 1);
  const s = Math.min(sx, sz);
  const off = (v, min, range, totalRange) => pad + (v - min) * s + (range - totalRange) / 2;
  const projX = (x) => pad + (x - minX) * s + (W - pad * 2 - (maxX - minX) * s) / 2;
  const projZ = (z) => pad + (z - minZ) * s + (H - pad * 2 - (maxZ - minZ) * s) / 2;

  // Track outline
  ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (let i = 0; i < data.samples.length; i += 4) {
    const p = data.samples[i].p;
    const x = projX(p.x), y = projZ(p.z);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.stroke();

  // Start line dot
  const start = data.samples[0].p;
  ctx.fillStyle = "#ff8030";
  ctx.beginPath();
  ctx.arc(projX(start.x), projZ(start.z), 3, 0, Math.PI * 2);
  ctx.fill();

  // Cars
  for (const c of Object.values(state.cars)) {
    ctx.fillStyle = "#" + new THREE.Color(c.color).getHexString();
    ctx.beginPath();
    ctx.arc(projX(c.pos.x), projZ(c.pos.z), c.id === state.myId ? 5 : 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function formatTime(t) {
  if (!isFinite(t)) return "—";
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

function showCenterMsg(text, dur = 1.5) {
  const el = $("#centermsg");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(showCenterMsg._t);
  showCenterMsg._t = setTimeout(() => el.classList.add("hidden"), dur * 1000);
}

function banner(msg, kind = "error") {
  const b = $("#banner");
  b.textContent = msg;
  b.className = kind === "info" ? "info" : "";
  b.classList.remove("hidden");
  clearTimeout(banner._t);
  banner._t = setTimeout(() => b.classList.add("hidden"), 3000);
}

// =============================================================
//  Input
// =============================================================
function setupInput() {
  document.addEventListener("keydown", (e) => {
    state.keys[e.key] = true;
    unlockAudio();
    if (state.phase === "racing" || state.phase === "countdown") {
      if (e.key === " ") {
        // Boost
        if (state.myCar && state.myCar.boost > 0 && !state.myCar.boostActive) {
          state.myCar.boostActive = true;
          sfxBoost();
        }
      }
      if (e.key === "r" || e.key === "R") {
        respawnAtLastCheckpoint();
      }
      if (e.key === "c" || e.key === "C") {
        state.cameraMode = (state.cameraMode + 1) % 3;
      }
    }
  });
  document.addEventListener("keyup", (e) => {
    state.keys[e.key] = false;
    if (e.key === " ") {
      // Release boost = stop active (but keep meter)
      if (state.myCar) state.myCar.boostActive = false;
    }
  });
  document.addEventListener("click", () => unlockAudio());
}

function respawnAtLastCheckpoint() {
  if (!state.myCar || !state.trackData) return;
  const car = state.myCar;
  const cp = state.trackData.checkpoints[Math.max(0, car.currentCheckpoint - 1)] || state.trackData.checkpoints[0];
  car.pos.set(cp.pos.x, 0, cp.pos.z);
  car.vel.set(0, 0, 0);
  car.heading = Math.atan2(cp.forward.x, cp.forward.z);
  showCenterMsg("RESPAWN", 0.6);
}

// =============================================================
//  Title / track-pick / lobby flow
// =============================================================
function renderColorPicker() {
  const root = $("#color-pick");
  root.innerHTML = "";
  COLORS.forEach((col, i) => {
    const sw = document.createElement("div");
    sw.className = "color-swatch" + (col === state.myColor ? " selected" : "");
    sw.style.background = "#" + new THREE.Color(col).getHexString();
    sw.style.color = "#" + new THREE.Color(col).getHexString();
    sw.addEventListener("click", () => {
      state.myColor = col;
      renderColorPicker();
      // Update preview car
      if (state.previewCar) {
        state.previewCar.mesh.children.forEach(ch => {
          if (ch.material && ch.material.color && ch.material.color.getHex() !== 0x101010
              && !ch.material.emissive) {
            // tint chassis-ish parts
          }
        });
      }
    });
    root.appendChild(sw);
  });
}

function renderTrackPick() {
  const root = $("#track-pick");
  root.innerHTML = "";
  Object.values(TRACKS).forEach(t => {
    const card = document.createElement("div");
    card.className = "track-card" + (t.id === state.trackId ? " selected" : "");
    card.innerHTML = `
      <div class="track-name">${escapeHTML(t.name)}</div>
      <div class="track-blurb">${escapeHTML(t.blurb)}</div>
      <div class="track-stats">${t.laps} LAPS</div>
    `;
    card.addEventListener("click", () => {
      state.trackId = t.id;
      renderTrackPick();
    });
    root.appendChild(card);
  });
}

function updateLobby() {
  const root = $("#lobby-drivers");
  if (!root) return;
  root.innerHTML = "";
  const all = [];
  if (state.myId) all.push({ id: state.myId, name: state.myName + (state.isHost ? " (host)" : ""), color: state.myColor, isLocal: true });
  for (const [id, c] of Object.entries(state.cars)) {
    if (id === state.myId) continue;
    all.push({ id, name: c.name, color: c.color, isLocal: false });
  }
  all.forEach(d => {
    const row = document.createElement("div");
    row.className = "driver-row";
    row.style.color = "#" + new THREE.Color(d.color).getHexString();
    row.innerHTML = `
      <div class="swatch-mini"></div>
      <span class="name">${escapeHTML(d.name)}</span>
      ${d.isLocal ? '<span class="tag">YOU</span>' : ''}
    `;
    root.appendChild(row);
  });
  $("#lobby-track").textContent = TRACKS[state.trackId].name;
}

// =============================================================
//  Mode handlers
// =============================================================
async function startSolo() {
  state.solo = true;
  state.isHost = true;
  state.net.initSolo();
  state.net.onMessage = onMessage;
  state.myId = state.net.myId;
  state.myName = $("#name").value.trim() || "Driver";

  // Build chosen track and add player + AI cars
  buildTrack(state.trackId);
  ensureLocalCar();

  // Two AI opponents
  const aiNames = ["Embra", "Korr"];
  const aiSkills = [0.95, 0.88];
  for (let i = 0; i < 2; i++) {
    const id = "ai_" + i;
    const color = COLORS[(i + 1) % COLORS.length];
    const car = spawnCar({ id, name: aiNames[i], color, isLocal: false });
    state.aiDrivers.push(new AIDriver(car, state.trackData.samples, aiSkills[i]));
  }

  positionCarsAtStart();

  // Hide title, show HUD, begin countdown
  $("#screen-track").classList.add("hidden");
  $("#hud").classList.remove("hidden");
  beginCountdown();
}

async function startHost() {
  state.solo = false;
  state.isHost = true;
  state.net.onMessage = onMessage;
  state.net.onPresenceChange = (present) => {
    for (const id of Object.keys(state.cars)) {
      if (id !== state.myId && !present.has(id)) {
        removeCar(id);
        updateLobby();
      }
    }
  };
  state.roomCode = makeRoomCode();
  state.myName = $("#name").value.trim() || "Driver";

  try {
    await state.net.joinRoom(state.roomCode);
  } catch (e) {
    banner("Couldn't host: " + e.message);
    return;
  }
  state.myId = state.net.myId;

  buildTrack(state.trackId);
  ensureLocalCar();
  positionCarsAtStart();

  $("#screen-track").classList.add("hidden");
  $("#screen-lobby").classList.remove("hidden");
  $("#room-code-display").textContent = state.roomCode;
  $("#start-race-btn").classList.remove("hidden");
  $("#lobby-wait").classList.add("hidden");

  state.net.send({ type: "hello", id: state.myId, name: state.myName, color: state.myColor });
  updateLobby();
}

async function startJoin() {
  const code = $("#room-code-input").value.trim().toUpperCase();
  if (code.length !== 6) return banner("Enter a 6-char room code");
  state.solo = false;
  state.isHost = false;
  state.net.onMessage = onMessage;
  state.myName = $("#name").value.trim() || "Driver";

  try {
    await state.net.joinRoom(code);
  } catch (e) {
    banner("Couldn't join: " + e.message);
    return;
  }
  state.myId = state.net.myId;
  state.roomCode = code;

  $("#screen-title").classList.add("hidden");
  $("#screen-lobby").classList.remove("hidden");
  $("#room-code-display").textContent = code;
  $("#start-race-btn").classList.add("hidden");
  $("#lobby-wait").classList.remove("hidden");

  state.net.send({ type: "hello", id: state.myId, name: state.myName, color: state.myColor });
  updateLobby();
}

function startRaceAsHost() {
  state.net.send({ type: "start-countdown", trackId: state.trackId });
  $("#screen-lobby").classList.add("hidden");
  $("#hud").classList.remove("hidden");
  ensureLocalCar();
  positionCarsAtStart();
  beginCountdown();
}

function backToTitleFromTrack() {
  $("#screen-track").classList.add("hidden");
  $("#screen-title").classList.remove("hidden");
}

function gotoTrackPick(nextAction) {
  $("#screen-title").classList.add("hidden");
  $("#screen-track").classList.remove("hidden");
  state._afterTrackPick = nextAction;
}

function confirmTrack() {
  $("#screen-track").classList.add("hidden");
  if (state._afterTrackPick === "solo") startSolo();
  else if (state._afterTrackPick === "host") startHost();
}

function restart() {
  location.reload();
}

// =============================================================
//  Main loop
// =============================================================
function loop() {
  const dt = Math.min(0.05, state.clock.getDelta());

  // Countdown
  if (state.phase === "countdown") tickCountdown(dt);

  // Step local car inputs + physics
  if (state.myCar) {
    if (state.phase === "racing") {
      state.myCar.setLocalInputs(state.keys);
    } else {
      state.myCar.throttle = 0; state.myCar.brake = 0; state.myCar.steerInput = 0; state.myCar.drifting = false; state.myCar.boostActive = false;
    }
    stepCarPhysics(state.myCar, dt, true);
  }

  // AI cars
  if (state.solo && (state.phase === "racing" || state.phase === "countdown")) {
    for (const ai of state.aiDrivers) {
      if (state.phase === "racing") ai.step(dt);
      else { ai.car.throttle = 0; ai.car.brake = 0; ai.car.steerInput = 0; }
      stepCarPhysics(ai.car, dt, false);
    }
  }

  // Remote cars — interpolate position from network state
  for (const [id, car] of Object.entries(state.cars)) {
    if (id === state.myId) continue;
    if (state.solo && state.aiDrivers.some(a => a.car === car)) continue; // AI handled above
    if (car.tx !== undefined) {
      const tt = Math.min(1, dt * 8);
      car.pos.x += (car.tx - car.pos.x) * tt;
      car.pos.y += (car.ty - car.pos.y) * tt;
      car.pos.z += (car.tz - car.pos.z) * tt;
      // Heading interpolate (shortest angle)
      let dh = car.tHeading - car.heading;
      while (dh > Math.PI) dh -= 2 * Math.PI;
      while (dh < -Math.PI) dh += 2 * Math.PI;
      car.heading += dh * tt;
    }
    car.step(dt);
  }

  // Update all car visuals
  for (const car of Object.values(state.cars)) {
    car.updateMesh(dt);
    if (car.mesh.userData?.label) car.mesh.userData.label.lookAt(state.camera.position);
  }

  // FX — local-only feedback
  if (state.myCar && state.phase === "racing") {
    // Tire smoke when drifting fast
    if (state.myCar.drifting && state.myCar.speed() > 18) {
      // Each wheel
      for (let i = 0; i < state.myCar.wheels.length; i++) {
        const w = state.myCar.wheels[i];
        const wp = new THREE.Vector3();
        w.getWorldPosition(wp);
        spawnSmoke(state.scene, wp, { count: 1, speed: 1.0, life: 0.7, size: 0.7 });
      }
      setScreech(Math.min(1, state.myCar.speed() / 35));
    } else if (state.myCar.onGrass && state.myCar.speed() > 8) {
      const wp = new THREE.Vector3();
      state.myCar.wheels[2].getWorldPosition(wp);
      spawnDust(state.scene, wp);
      stopScreech();
    } else {
      stopScreech();
    }

    // Boost trail
    if (state.myCar.boostActive) {
      const back = new THREE.Vector3(Math.sin(state.myCar.heading), 0, Math.cos(state.myCar.heading));
      const trailPos = state.myCar.pos.clone().addScaledVector(back, -2.5);
      trailPos.y += 0.55;
      spawnBoostTrail(state.scene, trailPos);
    }
  } else {
    stopScreech();
  }

  // Engine sound from local car
  if (state.myCar) {
    const speedN = Math.min(1, state.myCar.speed() / 60);
    setEngine(speedN, state.myCar.throttle, state.myCar.boostActive);
  } else {
    silenceEngine();
  }

  // Camera
  updateChaseCamera(dt);
  applyCameraShake(state.camera, dt);

  // Move shadow-casting sun to follow the player so the visible action is always
  // inside the shadow camera frustum (which is finite).
  if (state.sunLight && state.myCar) {
    const dir = new THREE.Vector3();
    if (state.skySunVec) dir.copy(state.skySunVec).normalize().multiplyScalar(120);
    else dir.copy(state.sunLight.position).normalize().multiplyScalar(120);
    state.sunLight.position.set(
      state.myCar.pos.x + dir.x,
      state.myCar.pos.y + dir.y,
      state.myCar.pos.z + dir.z
    );
    state.sunLight.target.position.set(state.myCar.pos.x, state.myCar.pos.y, state.myCar.pos.z);
    state.sunLight.target.updateMatrixWorld();
  }

  // Network broadcast (10-15 Hz)
  const now = performance.now();
  if (!state.solo && state.myCar && now - state.lastPosBroadcast > 80) {
    state.lastPosBroadcast = now;
    state.net.send({
      type: "pos", id: state.myId,
      x: state.myCar.pos.x, y: state.myCar.pos.y, z: state.myCar.pos.z,
      h: state.myCar.heading,
      b: state.myCar.boostActive, d: state.myCar.drifting,
      lap: state.myCar.lap, cp: state.myCar.currentCheckpoint,
      t: state.myCar.raceTime,
    });
  }

  // HUD
  updateHUD();

  // FX update
  updateParticles(state.scene, dt);

  // Drive the tree sway uniforms with elapsed time
  if (state.swayUniforms) {
    const t = performance.now() * 0.001;
    for (const u of state.swayUniforms) u.value = t;
  }

  // Render
  state.composer.render(dt);
  requestAnimationFrame(loop);
}

// Expose state for debugging
if (typeof window !== "undefined") window.__game = state;

// =============================================================
//  Boot
// =============================================================
document.addEventListener("DOMContentLoaded", () => {
  initScene();
  setupInput();

  // Title screen
  renderColorPicker();
  renderTrackPick();
  state.minimapCtx = $("#minimap-canvas").getContext("2d");

  $("#to-solo").addEventListener("click", () => gotoTrackPick("solo"));
  $("#to-host").addEventListener("click", () => gotoTrackPick("host"));
  $("#to-join").addEventListener("click", startJoin);
  $("#track-back").addEventListener("click", backToTitleFromTrack);
  $("#track-confirm").addEventListener("click", confirmTrack);
  $("#start-race-btn").addEventListener("click", startRaceAsHost);
  $("#finish-again").addEventListener("click", restart);
  $("#finish-home").addEventListener("click", restart);

  loop();
});
