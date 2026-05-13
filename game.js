import * as THREE from "https://esm.sh/three@0.160.0";
import { PointerLockControls } from "https://esm.sh/three@0.160.0/examples/jsm/controls/PointerLockControls.js";
import { EffectComposer } from "https://esm.sh/three@0.160.0/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "https://esm.sh/three@0.160.0/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "https://esm.sh/three@0.160.0/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "https://esm.sh/three@0.160.0/examples/jsm/postprocessing/OutputPass.js";

import { WORLD, heightAt, isWater, buildTerrainGeometry, placeProps, placeEntities } from "./world.js";
import { Net, makeRoomCode } from "./net.js";
import {
  sfxSwordSwing, sfxHit, sfxEnemyDeath, sfxPlayerHurt, sfxFireball, sfxFireballHit,
  sfxPickup, sfxPotion, sfxJump, sfxFootstep, sfxDragonRoar, sfxVictory, unlockAudio,
} from "./audio.js";
import {
  spawnParticleBurst, spawnTrailParticle, updateParticles,
  spawnDamageNumber, updateDamageNumbers,
  cameraShake, applyCameraShake,
  spawnFireflies, updateFireflies,
} from "./fx.js";

// ============================================================
//  State
// ============================================================
const state = {
  renderer: null,
  scene: null,
  camera: null,
  controls: null,
  clock: new THREE.Clock(),
  keys: {},
  mouseDown: false,

  net: new Net(),
  isHost: false,
  myId: null,
  myName: "",
  roomCode: null,

  // Local player movement
  vel: new THREE.Vector3(),
  onGround: true,
  swingT: 0,                // sword swing timer (0 = idle, >0 active)
  attackCd: 0,              // seconds left before next swing
  hp: 100,
  maxHp: 100,
  mp: 50,
  maxMp: 50,
  manaRegen: 6,             // per second
  hpPotions: 1,
  gold: 0,
  alive: true,
  lastHurtAt: 0,
  respawnAt: 0,
  footstepT: 0,
  fireballCd: 0,
  composer: null,
  bloom: null,
  sun: null,
  hemiLight: null,
  dayT: 0.30,               // 0 = midnight, 0.5 = noon, 1 = midnight
  fireballs: [],            // { mesh, dir, life, owner, target? }
  lootDrops: {},            // id -> { type, x, z, mesh }
  trailEmit: 0,

  // Remote players: id -> { name, mesh, x, y, z, rotY, hp, maxHp, gold, alive, tx, ty, tz, lastUpdate }
  players: {},

  // Entities (host-authoritative): id -> entity data
  entities: {},

  // Visual meshes per entity id
  entityMeshes: {},

  // World state
  worldSeed: null,
  bossAggro: false,
  phase: "title",    // title | lobby | playing | won | lost
  finished: false,

  // Networking timing
  lastPosBroadcast: 0,
  lastHostTick: 0,

  // Sword mesh attached to camera
  sword: null,
};

const $ = (s) => document.querySelector(s);
const TMP_V = new THREE.Vector3();
const TMP_V2 = new THREE.Vector3();
const PLAYER_HEIGHT = 1.7;
const PLAYER_RADIUS = 0.45;
const GRAVITY = 22;
const JUMP_VEL = 8;
const WALK_SPEED = 5.5;
const SPRINT_SPEED = 9.5;
const ATTACK_RANGE = 3.2;
const ATTACK_DMG = 18;
const ATTACK_CD = 0.55;

// ============================================================
//  Scene setup
// ============================================================
function initScene() {
  const canvas = $("#scene");
  state.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  state.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  state.renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x88a0c0);
  scene.fog = new THREE.Fog(0x88a0c0, 80, 240);
  state.scene = scene;

  const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.position.set(WORLD.SPAWN.x, 5, WORLD.SPAWN.z);
  state.camera = camera;

  // Hemisphere + directional sun (controlled by day/night cycle)
  const hemi = new THREE.HemisphereLight(0xb0c8e8, 0x2a2418, 0.65);
  scene.add(hemi);
  state.hemiLight = hemi;

  const sun = new THREE.DirectionalLight(0xfff0c8, 1.0);
  sun.position.set(120, 180, 60);
  scene.add(sun);
  state.sun = sun;

  // Post-processing — selective bloom on emissive things (lanterns, gold, fireballs, eyes)
  const composer = new EffectComposer(state.renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.85,   // strength
    0.55,   // radius
    0.78    // threshold
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  state.composer = composer;
  state.bloom = bloom;

  // Sky dome — large back sphere with gradient
  const skyGeo = new THREE.SphereGeometry(400, 24, 16);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {
      topColor:    { value: new THREE.Color(0x4a6a9e) },
      bottomColor: { value: new THREE.Color(0xc8b8a0) },
    },
    vertexShader: `
      varying vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      varying vec3 vWorldPos;
      void main() {
        float h = normalize(vWorldPos).y;
        float t = smoothstep(-0.1, 0.5, h);
        gl_FragColor = vec4(mix(bottomColor, topColor, t), 1.0);
      }
    `,
    depthWrite: false,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  scene.add(sky);

  // Terrain
  const terrainGeo = buildTerrainGeometry();
  const terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const terrain = new THREE.Mesh(terrainGeo, terrainMat);
  scene.add(terrain);

  // Water — large blue plane at y=-1.4
  const waterGeo = new THREE.PlaneGeometry(WORLD.SIZE * 2, WORLD.SIZE * 2);
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x2a5a7a,
    transparent: true,
    opacity: 0.78,
    roughness: 0.5,
    metalness: 0.1,
  });
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.rotation.x = -Math.PI / 2;
  water.position.y = -1.3;
  scene.add(water);

  // Trees and rocks
  buildPropsForSeed(state.worldSeed ?? 20260513);

  // Fireflies float through the spawn-camp area for ambient life
  spawnFireflies(scene, 70, { x: 80, z: 80 });

  // Spawn camp marker — wooden sign + campfire
  buildSpawnCamp();

  // Boss platform — flat stone ring at the peak
  buildBossPlatform();

  // Camera-attached sword
  buildSword();

  // Controls
  state.controls = new PointerLockControls(camera, state.renderer.domElement);
  scene.add(state.controls.getObject());
  state.controls.getObject().position.set(WORLD.SPAWN.x, heightAt(WORLD.SPAWN.x, WORLD.SPAWN.z) + PLAYER_HEIGHT, WORLD.SPAWN.z);

  state.controls.addEventListener("lock", () => {
    if (state.phase === "playing") $("#hud").classList.remove("hidden");
  });
  state.controls.addEventListener("unlock", () => {
    // Keep HUD visible during gameplay; just don't accept input
  });

  window.addEventListener("resize", onResize);
}

function onResize() {
  state.camera.aspect = window.innerWidth / window.innerHeight;
  state.camera.updateProjectionMatrix();
  state.renderer.setSize(window.innerWidth, window.innerHeight);
  if (state.composer) state.composer.setSize(window.innerWidth, window.innerHeight);
  if (state.bloom) state.bloom.setSize(window.innerWidth, window.innerHeight);
}

// ============================================================
//  Props (instanced trees + rocks)
// ============================================================
let propsGroup = null;

function buildPropsForSeed(seed) {
  if (propsGroup) state.scene.remove(propsGroup);
  propsGroup = new THREE.Group();
  state.scene.add(propsGroup);

  const props = placeProps(seed);
  state.treeColliders = [];

  // Tree trunks (instanced cylinder)
  const trunkGeo = new THREE.CylinderGeometry(0.35, 0.55, 5, 6);
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x2a1a10 });
  const trunkInst = new THREE.InstancedMesh(trunkGeo, trunkMat, props.trees.length + props.bigTrees.length);
  // Tree canopy (instanced cone)
  const canopyGeo = new THREE.ConeGeometry(2.2, 5, 6);
  const canopyMat = new THREE.MeshLambertMaterial({ color: 0x1f3a16 });
  const canopyInst = new THREE.InstancedMesh(canopyGeo, canopyMat, props.trees.length + props.bigTrees.length);

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const eul = new THREE.Euler();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();

  let idx = 0;
  for (const t of [...props.trees, ...props.bigTrees]) {
    const trunkH = 5 * t.scale;
    const canopyH = 5 * t.scale;
    eul.set(0, t.rot, 0);
    q.setFromEuler(eul);

    // Trunk
    p.set(t.x, t.y + trunkH / 2, t.z);
    s.set(t.scale, t.scale, t.scale);
    m.compose(p, q, s);
    trunkInst.setMatrixAt(idx, m);

    // Canopy
    p.set(t.x, t.y + trunkH + canopyH / 2 - 0.4, t.z);
    m.compose(p, q, s);
    canopyInst.setMatrixAt(idx, m);

    state.treeColliders.push({ x: t.x, z: t.z, r: 0.6 * t.scale });
    idx++;
  }
  trunkInst.instanceMatrix.needsUpdate = true;
  canopyInst.instanceMatrix.needsUpdate = true;
  propsGroup.add(trunkInst);
  propsGroup.add(canopyInst);

  // Rocks (instanced dodecahedron)
  const rockGeo = new THREE.DodecahedronGeometry(0.7, 0);
  const rockMat = new THREE.MeshLambertMaterial({ color: 0x4a4a52 });
  const rockInst = new THREE.InstancedMesh(rockGeo, rockMat, props.rocks.length);
  let ri = 0;
  for (const r of props.rocks) {
    eul.set(r.rot * 0.5, r.rot, r.rot * 0.3);
    q.setFromEuler(eul);
    p.set(r.x, r.y + 0.3, r.z);
    s.set(r.scale, r.scale * 0.7, r.scale);
    m.compose(p, q, s);
    rockInst.setMatrixAt(ri, m);
    if (r.scale > 1.0) state.treeColliders.push({ x: r.x, z: r.z, r: 0.5 * r.scale });
    ri++;
  }
  rockInst.instanceMatrix.needsUpdate = true;
  propsGroup.add(rockInst);
}

function buildSpawnCamp() {
  // Sign post
  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(0.1, 0.1, 2.5, 5),
    new THREE.MeshLambertMaterial({ color: 0x3a2615 })
  );
  post.position.set(WORLD.SPAWN.x + 1.5, heightAt(WORLD.SPAWN.x + 1.5, WORLD.SPAWN.z) + 1.25, WORLD.SPAWN.z);
  state.scene.add(post);

  // Sign board
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, 0.8, 0.08),
    new THREE.MeshLambertMaterial({ color: 0x5a3c20 })
  );
  board.position.set(WORLD.SPAWN.x + 1.5, heightAt(WORLD.SPAWN.x + 1.5, WORLD.SPAWN.z) + 2.2, WORLD.SPAWN.z);
  state.scene.add(board);

  // Campfire stones
  const stoneMat = new THREE.MeshLambertMaterial({ color: 0x4a4a52 });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const stone = new THREE.Mesh(new THREE.DodecahedronGeometry(0.25, 0), stoneMat);
    stone.position.set(
      WORLD.SPAWN.x + Math.cos(a) * 0.8,
      heightAt(WORLD.SPAWN.x + Math.cos(a) * 0.8, WORLD.SPAWN.z + Math.sin(a) * 0.8) + 0.25,
      WORLD.SPAWN.z + Math.sin(a) * 0.8
    );
    state.scene.add(stone);
  }
  // Fire — emissive sphere + point light
  const fire = new THREE.Mesh(
    new THREE.SphereGeometry(0.3, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xff8c30 })
  );
  fire.position.set(WORLD.SPAWN.x, heightAt(WORLD.SPAWN.x, WORLD.SPAWN.z) + 0.4, WORLD.SPAWN.z);
  state.scene.add(fire);
  state.fireMesh = fire;
  const fireLight = new THREE.PointLight(0xff8c30, 1.8, 18, 2);
  fireLight.position.copy(fire.position);
  fireLight.position.y += 0.4;
  state.scene.add(fireLight);
  state.fireLight = fireLight;
}

function buildBossPlatform() {
  const ringMat = new THREE.MeshLambertMaterial({ color: 0x6a5e4a });
  // Flat top
  const top = new THREE.Mesh(new THREE.CylinderGeometry(WORLD.PEAK.r * 0.6, WORLD.PEAK.r * 0.65, 1.5, 18), ringMat);
  top.position.set(WORLD.PEAK.x, heightAt(WORLD.PEAK.x, WORLD.PEAK.z) + 1.0, WORLD.PEAK.z);
  state.scene.add(top);

  // Standing stones around the perimeter
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const sx = WORLD.PEAK.x + Math.cos(a) * (WORLD.PEAK.r * 0.55);
    const sz = WORLD.PEAK.z + Math.sin(a) * (WORLD.PEAK.r * 0.55);
    const sy = heightAt(sx, sz);
    const stone = new THREE.Mesh(new THREE.BoxGeometry(1.3, 4, 0.8), new THREE.MeshLambertMaterial({ color: 0x3a3540 }));
    stone.position.set(sx, sy + 2, sz);
    stone.rotation.y = a + Math.PI / 2;
    state.scene.add(stone);
  }
}

function buildSword() {
  const swordGroup = new THREE.Group();

  const blade = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.06, 0.9),
    new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.7, roughness: 0.3 })
  );
  blade.position.set(0, 0, -0.45);
  swordGroup.add(blade);

  const guard = new THREE.Mesh(
    new THREE.BoxGeometry(0.3, 0.06, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x8a6a3a, metalness: 0.6 })
  );
  swordGroup.add(guard);

  const hilt = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.04, 0.2, 6),
    new THREE.MeshStandardMaterial({ color: 0x3a2615 })
  );
  hilt.rotation.x = Math.PI / 2;
  hilt.position.set(0, 0, 0.1);
  swordGroup.add(hilt);

  // Position relative to camera (right hand)
  swordGroup.position.set(0.32, -0.28, -0.4);
  swordGroup.rotation.set(0, -0.05, 0);
  state.camera.add(swordGroup);
  state.sword = swordGroup;
}

// ============================================================
//  Entity meshes
// ============================================================
function makeEntityMesh(e) {
  let mesh;
  if (e.type === "wolf") {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.5, 1.2), new THREE.MeshLambertMaterial({ color: 0x3a3540 }));
    body.position.y = 0.5;
    g.add(body);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.5), new THREE.MeshLambertMaterial({ color: 0x4a4248 }));
    head.position.set(0, 0.65, 0.7);
    g.add(head);
    for (let i = 0; i < 4; i++) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.4, 0.12), new THREE.MeshLambertMaterial({ color: 0x2a2530 }));
      leg.position.set(i % 2 ? 0.25 : -0.25, 0.2, i < 2 ? 0.4 : -0.4);
      g.add(leg);
    }
    mesh = g;
  } else if (e.type === "skeleton") {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.0, 0.3), new THREE.MeshLambertMaterial({ color: 0xc8b8a0 }));
    body.position.y = 0.7;
    g.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.25, 8, 8), new THREE.MeshLambertMaterial({ color: 0xe8d8b8 }));
    head.position.y = 1.5;
    g.add(head);
    for (let i = 0; i < 2; i++) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.8, 0.12), new THREE.MeshLambertMaterial({ color: 0xc8b8a0 }));
      arm.position.set(i ? 0.32 : -0.32, 0.7, 0);
      g.add(arm);
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.7, 0.14), new THREE.MeshLambertMaterial({ color: 0xc8b8a0 }));
      leg.position.set(i ? 0.13 : -0.13, 0.0, 0);
      g.add(leg);
    }
    mesh = g;
  } else if (e.type === "troll") {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.6, 0.9), new THREE.MeshLambertMaterial({ color: 0x4a5a3a }));
    body.position.y = 1.2;
    g.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.55, 10, 8), new THREE.MeshLambertMaterial({ color: 0x5a6a4a }));
    head.position.y = 2.4;
    g.add(head);
    for (let i = 0; i < 2; i++) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.5, 0.35), new THREE.MeshLambertMaterial({ color: 0x4a5a3a }));
      arm.position.set(i ? 0.9 : -0.9, 1.2, 0);
      g.add(arm);
    }
    mesh = g;
  } else if (e.type === "dragon") {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(3.0, 1.8, 6.0), new THREE.MeshLambertMaterial({ color: 0x4a2235 }));
    body.position.y = 1.5;
    g.add(body);
    const head = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.2, 1.6), new THREE.MeshLambertMaterial({ color: 0x5a2c40 }));
    head.position.set(0, 2.0, 3.6);
    g.add(head);
    // Wings (folded)
    for (let i = 0; i < 2; i++) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.4, 3.6), new THREE.MeshLambertMaterial({ color: 0x3a1828 }));
      wing.position.set(i ? 1.8 : -1.8, 2.2, 0);
      wing.rotation.z = (i ? 1 : -1) * 0.5;
      g.add(wing);
    }
    // Tail
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.5, 3, 6), new THREE.MeshLambertMaterial({ color: 0x4a2235 }));
    tail.position.set(0, 1.0, -4.5);
    tail.rotation.x = -Math.PI / 2;
    g.add(tail);
    // Glowing eyes
    for (let i = 0; i < 2; i++) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 6), new THREE.MeshBasicMaterial({ color: 0xff4030 }));
      eye.position.set(i ? 0.4 : -0.4, 2.2, 4.3);
      g.add(eye);
    }
    mesh = g;
  } else if (e.type === "gold_pile") {
    mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xf5c97a, emissive: 0xf5c97a, emissiveIntensity: 0.6, metalness: 0.8 })
    );
  } else if (e.type === "chest") {
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.6, 0.6), new THREE.MeshLambertMaterial({ color: 0x5a3c20 }));
    base.position.y = 0.3;
    g.add(base);
    const lid = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.2, 0.6), new THREE.MeshLambertMaterial({ color: 0x6a4828 }));
    lid.position.y = 0.7;
    g.add(lid);
    const lock = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.16, 0.05), new THREE.MeshStandardMaterial({ color: 0xc08a3e, emissive: 0xc08a3e, emissiveIntensity: 0.3 }));
    lock.position.set(0, 0.5, 0.32);
    g.add(lock);
    mesh = g;
  } else {
    mesh = new THREE.Mesh(new THREE.SphereGeometry(0.5, 6, 6), new THREE.MeshLambertMaterial({ color: 0xff00ff }));
  }
  return mesh;
}

function makePlayerMesh(name, color = 0x6ec79b) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.0, 0.4), new THREE.MeshLambertMaterial({ color }));
  body.position.y = 0.7;
  g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), new THREE.MeshLambertMaterial({ color: 0xd0a888 }));
  head.position.y = 1.45;
  g.add(head);
  // Legs
  for (let i = 0; i < 2; i++) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.6, 0.2), new THREE.MeshLambertMaterial({ color: 0x2a1a10 }));
    leg.position.set(i ? 0.12 : -0.12, 0.0, 0);
    g.add(leg);
  }
  // Arms
  for (let i = 0; i < 2; i++) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.8, 0.18), new THREE.MeshLambertMaterial({ color }));
    arm.position.set(i ? 0.39 : -0.39, 0.7, 0);
    g.add(arm);
  }
  // Floating name label
  const label = makeNameSprite(name);
  label.position.set(0, 2.1, 0);
  g.add(label);
  g.userData.label = label;
  return g;
}

function makeNameSprite(name) {
  const canvas = document.createElement("canvas");
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgba(0,0,0,0.7)";
  ctx.fillRect(0, 0, 256, 64);
  ctx.fillStyle = "#ecdcc8";
  ctx.font = "bold 30px Georgia";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(name, 128, 32);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(2.2, 0.55, 1);
  sprite.renderOrder = 999;
  return sprite;
}

function ensureEntityMesh(id, e) {
  let mesh = state.entityMeshes[id];
  if (!mesh) {
    mesh = makeEntityMesh(e);
    state.scene.add(mesh);
    state.entityMeshes[id] = mesh;
    // Add HP bar for monsters/boss
    if (e.type === "wolf" || e.type === "skeleton" || e.type === "troll") {
      const bar = makeHPBar();
      bar.position.y = 2.4;
      mesh.add(bar);
      mesh.userData.hpBar = bar;
    }
  }
  return mesh;
}

function makeHPBar() {
  const g = new THREE.Group();
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.12), new THREE.MeshBasicMaterial({ color: 0x000000, depthTest: false }));
  g.add(bg);
  const fill = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.1), new THREE.MeshBasicMaterial({ color: 0xff6464, depthTest: false }));
  fill.position.z = 0.001;
  g.add(fill);
  g.userData.fill = fill;
  g.renderOrder = 998;
  return g;
}

function removeEntityMesh(id) {
  const mesh = state.entityMeshes[id];
  if (mesh) {
    state.scene.remove(mesh);
    delete state.entityMeshes[id];
  }
}

function spawnLootDrop(id, drop) {
  if (state.lootDrops[id]) return;
  let mesh;
  if (drop.type === "hp_potion") {
    const g = new THREE.Group();
    const bottle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.22, 0.45, 8),
      new THREE.MeshStandardMaterial({ color: 0xc45c5c, emissive: 0xc45c5c, emissiveIntensity: 0.7, transparent: true, opacity: 0.9 })
    );
    g.add(bottle);
    const neck = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.09, 0.18, 6),
      new THREE.MeshStandardMaterial({ color: 0x3a2615 })
    );
    neck.position.y = 0.3;
    g.add(neck);
    const light = new THREE.PointLight(0xff6868, 0.8, 4, 2);
    light.position.y = 0.5;
    g.add(light);
    mesh = g;
  } else {
    mesh = new THREE.Mesh(new THREE.SphereGeometry(0.3, 6, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  }
  mesh.position.set(drop.x, heightAt(drop.x, drop.z) + 0.45, drop.z);
  state.scene.add(mesh);
  state.lootDrops[id] = { ...drop, mesh, id };
}

function removeLootDrop(id) {
  const l = state.lootDrops[id];
  if (l) {
    state.scene.remove(l.mesh);
    delete state.lootDrops[id];
  }
}

function updateDayNight(dt) {
  // 0..1 maps to one full cycle. 0=midnight, 0.5=noon, 1=midnight again.
  // ~6 minute cycle for some atmosphere variety.
  state.dayT = (state.dayT + dt / 360) % 1;
  const t = state.dayT;
  const sunAngle = (t - 0.25) * Math.PI * 2; // 0.25 = sunrise
  const sx = Math.cos(sunAngle) * 200;
  const sy = Math.sin(sunAngle) * 200;
  state.sun.position.set(sx, Math.max(20, sy), 80);

  // Intensity: bright during day, dim at night
  const dayness = Math.max(0, Math.sin(sunAngle));
  state.sun.intensity = 0.2 + dayness * 0.9;
  state.hemiLight.intensity = 0.3 + dayness * 0.5;

  // Tint
  const dayColor = new THREE.Color(0x88a0c0);
  const nightColor = new THREE.Color(0x0a0814);
  const tint = nightColor.clone().lerp(dayColor, dayness);
  state.scene.background = tint;
  state.scene.fog.color = tint;

  // Bloom strength rises slightly at night for atmosphere
  if (state.bloom) state.bloom.strength = 0.85 + (1 - dayness) * 0.6;
}

// ============================================================
//  Player movement & combat
// ============================================================
function updatePlayer(dt) {
  if (state.phase !== "playing" || !state.alive) {
    if (state.phase === "playing" && !state.alive && state.respawnAt && performance.now() > state.respawnAt) {
      respawnLocal();
    }
    return;
  }

  const obj = state.controls.getObject();
  const isLocked = state.controls.isLocked;

  // Inputs
  const fwd = (state.keys["w"] || state.keys["W"] || state.keys["ArrowUp"] ? 1 : 0)
            - (state.keys["s"] || state.keys["S"] || state.keys["ArrowDown"] ? 1 : 0);
  const strafe = (state.keys["d"] || state.keys["D"] || state.keys["ArrowRight"] ? 1 : 0)
              - (state.keys["a"] || state.keys["A"] || state.keys["ArrowLeft"] ? 1 : 0);

  const sprinting = state.keys["Shift"];
  const speed = sprinting ? SPRINT_SPEED : WALK_SPEED;

  if (isLocked) {
    if (fwd !== 0) state.controls.moveForward(fwd * speed * dt);
    if (strafe !== 0) state.controls.moveRight(strafe * speed * dt);
  }

  // Gravity & jump
  state.vel.y -= GRAVITY * dt;
  obj.position.y += state.vel.y * dt;

  const groundY = heightAt(obj.position.x, obj.position.z) + PLAYER_HEIGHT;
  if (obj.position.y <= groundY) {
    obj.position.y = groundY;
    state.vel.y = 0;
    state.onGround = true;
  } else {
    state.onGround = false;
  }

  if (state.keys[" "] && state.onGround) {
    state.vel.y = JUMP_VEL;
    state.onGround = false;
    sfxJump();
  }

  // Footstep audio when walking on ground
  if (state.onGround && (fwd !== 0 || strafe !== 0)) {
    state.footstepT += dt;
    const stepInterval = sprinting ? 0.32 : 0.46;
    if (state.footstepT > stepInterval) {
      state.footstepT = 0;
      sfxFootstep();
    }
  }

  // Mana regen + cooldown decrement
  state.mp = Math.min(state.maxMp, state.mp + state.manaRegen * dt);
  if (state.fireballCd > 0) state.fireballCd -= dt;

  // Constrain to world
  const lim = WORLD.SIZE - 5;
  obj.position.x = Math.max(-lim, Math.min(lim, obj.position.x));
  obj.position.z = Math.max(-lim, Math.min(lim, obj.position.z));

  // Tree/rock collision
  for (const c of state.treeColliders) {
    const dx = obj.position.x - c.x;
    const dz = obj.position.z - c.z;
    const d2 = dx * dx + dz * dz;
    const minD = c.r + PLAYER_RADIUS;
    if (d2 < minD * minD) {
      const d = Math.sqrt(d2) || 0.0001;
      obj.position.x = c.x + (dx / d) * minD;
      obj.position.z = c.z + (dz / d) * minD;
    }
  }

  // Sword animation
  if (state.swingT > 0) {
    state.swingT = Math.max(0, state.swingT - dt);
    const t = 1 - state.swingT / 0.35;
    const a = Math.sin(t * Math.PI);
    state.sword.rotation.x = -a * 1.6;
    state.sword.rotation.z = a * 0.3;
  } else {
    state.sword.rotation.x = 0;
    state.sword.rotation.z = 0;
  }

  if (state.attackCd > 0) state.attackCd -= dt;

  // Pickup check (gold/chest)
  for (const [id, e] of Object.entries(state.entities)) {
    if (e.type !== "gold_pile" && e.type !== "chest") continue;
    const dx = obj.position.x - e.x;
    const dz = obj.position.z - e.z;
    if (dx * dx + dz * dz < 1.4 * 1.4) {
      // Request pickup (host resolves)
      state.net.send({ type: "pickup", who: state.myId, id });
      // Optimistic local: temporarily mark as collected to avoid spamming requests
      e.pending = true;
      setTimeout(() => { if (state.entities[id]) state.entities[id].pending = false; }, 800);
    }
  }

  // Broadcast position at 10 Hz
  const now = performance.now();
  if (now - state.lastPosBroadcast > 100) {
    state.lastPosBroadcast = now;
    state.net.send({
      type: "pos",
      id: state.myId,
      x: obj.position.x, y: obj.position.y, z: obj.position.z,
      ry: state.camera.rotation.y, // not quite right but enough for facing
      swing: state.swingT > 0 ? 1 : 0,
    });
  }
}

function attack() {
  if (!state.alive || state.attackCd > 0 || state.phase !== "playing") return;
  if (!state.controls.isLocked) return;
  state.attackCd = ATTACK_CD;
  state.swingT = 0.35;
  sfxSwordSwing();

  // Find nearest enemy in front of player within ATTACK_RANGE
  const obj = state.controls.getObject();
  const dir = new THREE.Vector3();
  state.camera.getWorldDirection(dir);
  dir.y = 0; dir.normalize();

  let bestId = null, bestDot = -1;
  for (const [id, e] of Object.entries(state.entities)) {
    if (e.type !== "wolf" && e.type !== "skeleton" && e.type !== "troll" && e.type !== "dragon") continue;
    TMP_V.set(e.x - obj.position.x, 0, e.z - obj.position.z);
    const dist = TMP_V.length();
    if (dist > ATTACK_RANGE + (e.type === "dragon" ? 2 : 0.6)) continue;
    TMP_V.normalize();
    const dot = TMP_V.dot(dir);
    if (dot < 0.5) continue; // ~60° cone
    if (dot > bestDot) { bestDot = dot; bestId = id; }
  }
  if (bestId) {
    state.net.send({ type: "attack-entity", who: state.myId, target: bestId, dmg: ATTACK_DMG });
  }
}

function castFireball() {
  if (!state.alive || state.fireballCd > 0 || state.phase !== "playing") return;
  if (!state.controls.isLocked) return;
  if (state.mp < 18) {
    showEvent("Not enough mana", "");
    return;
  }
  state.mp -= 18;
  state.fireballCd = 0.7;
  sfxFireball();
  updateHUD();

  const dir = new THREE.Vector3();
  state.camera.getWorldDirection(dir);
  const origin = state.camera.position.clone();
  origin.addScaledVector(dir, 0.5);
  spawnFireball(origin, dir.normalize().clone(), state.myId);
  state.net.send({ type: "fireball", from: state.myId, x: origin.x, y: origin.y, z: origin.z, dx: dir.x, dy: dir.y, dz: dir.z });
}

function spawnFireball(pos, dir, owner) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.32, 8, 8),
    new THREE.MeshStandardMaterial({
      color: 0xff8030, emissive: 0xff6020, emissiveIntensity: 2.5, transparent: true, opacity: 0.95,
    })
  );
  mesh.position.copy(pos);
  state.scene.add(mesh);
  const light = new THREE.PointLight(0xff8030, 1.2, 8, 2);
  mesh.add(light);
  state.fireballs.push({
    mesh, dir: dir.clone(), life: 2.2, owner, speed: 30,
  });
}

function updateFireballs(dt) {
  for (let i = state.fireballs.length - 1; i >= 0; i--) {
    const fb = state.fireballs[i];
    fb.life -= dt;
    fb.mesh.position.addScaledVector(fb.dir, fb.speed * dt);

    // Trail
    state.trailEmit = (state.trailEmit || 0) + dt;
    if (state.trailEmit > 0.025) {
      state.trailEmit = 0;
      spawnTrailParticle(state.scene, fb.mesh.position, { color: 0xff7030, life: 0.4, size: 0.5 });
    }

    // Ground collision
    const gy = heightAt(fb.mesh.position.x, fb.mesh.position.z);
    let hit = false;
    if (fb.mesh.position.y < gy + 0.1) hit = true;

    // Entity hit (host authoritative — only host applies damage but everyone shows fx)
    if (!hit) {
      for (const [id, e] of Object.entries(state.entities)) {
        if (e.type !== "wolf" && e.type !== "skeleton" && e.type !== "troll" && e.type !== "dragon") continue;
        const dx = fb.mesh.position.x - e.x;
        const dz = fb.mesh.position.z - e.z;
        const ey = heightAt(e.x, e.z) + 1.2;
        const dy = fb.mesh.position.y - ey;
        const r = (e.type === "dragon" ? 3.5 : 1.0);
        if (dx * dx + dy * dy + dz * dz < r * r) {
          // Local visual hit
          spawnParticleBurst(state.scene, fb.mesh.position, { count: 24, color: 0xff6030, speed: 6, life: 0.8 });
          sfxFireballHit();
          cameraShake(0.25, 0.25);
          // Host applies damage
          if (fb.owner === state.myId) {
            state.net.send({ type: "attack-entity", who: state.myId, target: id, dmg: 38 });
          }
          hit = true;
          break;
        }
      }
    }

    if (hit || fb.life <= 0) {
      if (hit) {
        spawnParticleBurst(state.scene, fb.mesh.position, { count: 18, color: 0xffa040, speed: 5, life: 0.6 });
        sfxFireballHit();
      }
      state.scene.remove(fb.mesh);
      fb.mesh.material.dispose();
      state.fireballs.splice(i, 1);
    }
  }
}

function useHpPotion() {
  if (state.hpPotions <= 0) return;
  if (state.hp >= state.maxHp) return;
  state.hpPotions--;
  const heal = 40;
  state.hp = Math.min(state.maxHp, state.hp + heal);
  sfxPotion();
  spawnParticleBurst(state.scene, state.camera.position, { count: 14, color: 0x6ec79b, speed: 2.5, life: 0.5, upward: 1.2 });
  showEvent(`+${heal} HP`, "heal");
  updateHUD();
}

function respawnLocal() {
  state.alive = true;
  state.hp = state.maxHp;
  state.respawnAt = 0;
  const obj = state.controls.getObject();
  obj.position.set(WORLD.SPAWN.x, heightAt(WORLD.SPAWN.x, WORLD.SPAWN.z) + PLAYER_HEIGHT, WORLD.SPAWN.z);
  state.vel.set(0, 0, 0);
  state.net.send({ type: "respawn", id: state.myId, x: obj.position.x, y: obj.position.y, z: obj.position.z });
  updateHUD();
}

// ============================================================
//  Host simulation
// ============================================================
function hostTick(dt) {
  if (!state.isHost || state.phase !== "playing") return;

  // Gather all alive players (self + remote)
  const players = [];
  const selfObj = state.controls.getObject();
  if (state.alive) {
    players.push({ id: state.myId, x: selfObj.position.x, z: selfObj.position.z });
  }
  for (const [id, p] of Object.entries(state.players)) {
    if (p.alive !== false) players.push({ id, x: p.x ?? 0, z: p.z ?? 0 });
  }
  if (players.length === 0) return;

  let changed = false;
  for (const e of Object.values(state.entities)) {
    if (e.type !== "wolf" && e.type !== "skeleton" && e.type !== "troll" && e.type !== "dragon") continue;

    // Find nearest player
    let nearest = null, nearestD2 = Infinity;
    for (const p of players) {
      const dx = p.x - e.x, dz = p.z - e.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < nearestD2) { nearestD2 = d2; nearest = p; }
    }
    if (!nearest) continue;
    const d = Math.sqrt(nearestD2);

    // Dragon aggro persists once started
    if (e.type === "dragon") {
      if (!e.aggro && d < e.sightRange) {
        e.aggro = true;
        state.net.send({ type: "boss-aggro" });
      }
      if (!e.aggro) continue;
    } else {
      if (d > e.sightRange) continue;
    }

    // Move toward
    if (d > e.attackRange) {
      const step = e.speed * dt;
      const nx = e.x + (nearest.x - e.x) / d * step;
      const nz = e.z + (nearest.z - e.z) / d * step;
      e.x = nx;
      e.z = nz;
      changed = true;
    }

    // Attack
    e.attackCd = (e.attackCd || 0) - dt;
    if (d <= e.attackRange + 0.2 && e.attackCd <= 0) {
      e.attackCd = e.type === "dragon" ? 1.8 : (e.type === "troll" ? 2.0 : 1.2);
      // Damage the nearest player
      state.net.send({ type: "player-dmg", id: nearest.id, dmg: e.dmg, from: e.id });
    }
  }

  // Broadcast entity positions every 250ms
  const now = performance.now();
  if (now - state.lastHostTick > 220) {
    state.lastHostTick = now;
    const compact = {};
    for (const [id, e] of Object.entries(state.entities)) {
      if (e.type === "wolf" || e.type === "skeleton" || e.type === "troll" || e.type === "dragon") {
        compact[id] = { x: e.x, z: e.z, hp: e.hp };
      }
    }
    state.net.send({ type: "entities-pos", data: compact });
  }
}

// ============================================================
//  Network message handler
// ============================================================
function onMessage(msg) {
  if (!msg) return;

  switch (msg.type) {
    case "hello": {
      // A peer announced themselves
      if (!state.players[msg.id] && msg.id !== state.myId) {
        const p = {
          name: msg.name || "Wanderer",
          x: WORLD.SPAWN.x, y: 0, z: WORLD.SPAWN.z,
          tx: WORLD.SPAWN.x, ty: 0, tz: WORLD.SPAWN.z,
          hp: 100, maxHp: 100, gold: 0, alive: true,
          mesh: null,
          lastUpdate: performance.now(),
        };
        const colors = [0x6ec79b, 0xd97455, 0x9b7ed4, 0xd4a259];
        const colorIdx = Object.keys(state.players).length % colors.length;
        p.mesh = makePlayerMesh(p.name, colors[colorIdx]);
        state.scene.add(p.mesh);
        state.players[msg.id] = p;
        updatePlayerList();
      }
      // If host, send full state snapshot to this peer
      if (state.isHost && msg.id !== state.myId) {
        state.net.send({
          type: "snapshot", to: msg.id,
          seed: state.worldSeed,
          entities: state.entities,
          players: dumpPlayersForSnapshot(),
          phase: state.phase,
        });
      }
      break;
    }
    case "snapshot": {
      if (msg.to !== state.myId) return;
      if (msg.seed !== undefined && state.worldSeed !== msg.seed) {
        state.worldSeed = msg.seed;
        buildPropsForSeed(msg.seed);
      }
      state.entities = msg.entities || {};
      // Rebuild meshes for all entities
      for (const id of Object.keys(state.entityMeshes)) removeEntityMesh(id);
      for (const [id, e] of Object.entries(state.entities)) {
        const mesh = ensureEntityMesh(id, e);
        mesh.position.set(e.x, heightAt(e.x, e.z), e.z);
      }
      // Apply player records
      for (const [pid, pdata] of Object.entries(msg.players || {})) {
        if (pid === state.myId) continue;
        if (!state.players[pid]) {
          const colors = [0x6ec79b, 0xd97455, 0x9b7ed4, 0xd4a259];
          const colorIdx = Object.keys(state.players).length % colors.length;
          const m = makePlayerMesh(pdata.name || "Wanderer", colors[colorIdx]);
          state.scene.add(m);
          state.players[pid] = {
            ...pdata, mesh: m,
            tx: pdata.x, ty: pdata.y, tz: pdata.z,
            lastUpdate: performance.now(),
          };
        }
      }
      if (msg.phase === "playing" && state.phase !== "playing") {
        enterGame();
      }
      updatePlayerList();
      break;
    }
    case "pos": {
      if (msg.id === state.myId) return;
      const p = state.players[msg.id];
      if (!p) return;
      p.tx = msg.x; p.ty = msg.y; p.tz = msg.z;
      p.lastUpdate = performance.now();
      if (msg.swing && p.mesh) {
        // Animate the arm? For simplicity, briefly tint the mesh
        p.mesh.userData.swingT = 0.3;
      }
      if (msg.ry !== undefined && p.mesh) p.mesh.rotation.y = msg.ry;
      break;
    }
    case "start": {
      if (msg.seed !== undefined && state.worldSeed !== msg.seed) {
        state.worldSeed = msg.seed;
        buildPropsForSeed(msg.seed);
      }
      state.entities = msg.entities || {};
      for (const id of Object.keys(state.entityMeshes)) removeEntityMesh(id);
      for (const [id, e] of Object.entries(state.entities)) {
        const mesh = ensureEntityMesh(id, e);
        mesh.position.set(e.x, heightAt(e.x, e.z), e.z);
      }
      enterGame();
      break;
    }
    case "entities-pos": {
      if (state.isHost) return; // host is authoritative
      for (const [id, e] of Object.entries(msg.data || {})) {
        if (!state.entities[id]) continue;
        Object.assign(state.entities[id], e);
      }
      break;
    }
    case "attack-entity": {
      if (!state.isHost) return;
      const e = state.entities[msg.target];
      if (!e) return;
      e.hp = (e.hp || 0) - (msg.dmg || 0);
      // Tell all clients to show damage number + hit particles at this entity
      state.net.send({ type: "entity-hurt", id: msg.target, dmg: msg.dmg, x: e.x, z: e.z });
      if (e.hp <= 0) {
        // Loot drop chance (host rolls)
        let drop = null;
        if (Math.random() < 0.35 && e.type !== "dragon") {
          drop = { type: "hp_potion", x: e.x, z: e.z };
        }
        const goldAward = e.gold || 0;
        state.net.send({ type: "kill-entity", id: e.id || msg.target, by: msg.who, gold: goldAward, kind: e.type, x: e.x, z: e.z, drop });
        delete state.entities[msg.target];
        if (e.type === "dragon") {
          state.net.send({ type: "victory", by: msg.who });
          state.phase = "won";
        }
      } else {
        state.net.send({ type: "entity-hp", id: msg.target, hp: e.hp });
      }
      break;
    }
    case "entity-hurt": {
      // All clients show feedback
      const yWorld = heightAt(msg.x, msg.z) + 1.6;
      const pos = new THREE.Vector3(msg.x, yWorld, msg.z);
      spawnDamageNumber(state.scene, pos, "-" + msg.dmg, { color: "#ffe080" });
      spawnParticleBurst(state.scene, pos, { count: 10, color: 0xff5050, speed: 4, life: 0.4 });
      sfxHit();
      break;
    }
    case "kill-entity": {
      // All clients: death poof, sound, remove mesh
      const yWorld = heightAt(msg.x ?? 0, msg.z ?? 0) + 0.6;
      const pos = new THREE.Vector3(msg.x ?? 0, yWorld, msg.z ?? 0);
      spawnParticleBurst(state.scene, pos, {
        count: 26,
        color: msg.kind === "dragon" ? 0xff4030 : 0x603020,
        emissive: msg.kind === "dragon" ? 0xff6040 : 0x301810,
        speed: 6, life: 0.9, upward: 1.2,
      });
      sfxEnemyDeath();
      if (msg.kind === "dragon") {
        cameraShake(0.9, 0.8);
        spawnParticleBurst(state.scene, pos, { count: 80, color: 0xff7050, speed: 10, life: 1.4, upward: 1.4 });
        sfxVictory();
      }
      removeEntityMesh(msg.id);
      delete state.entities[msg.id];
      if (msg.kind === "dragon") {
        showEvent("The Pale Dragon falls!", "kill");
      } else {
        showEvent(`${msg.kind} slain`, "kill");
      }
      if (msg.by === state.myId) {
        state.gold += msg.gold || 0;
        updateHUD();
        showEvent(`+${msg.gold || 0} gold`, "gold");
      } else if (state.players[msg.by]) {
        state.players[msg.by].gold = (state.players[msg.by].gold || 0) + (msg.gold || 0);
        updatePlayerList();
      }
      // Spawn loot drop (mesh visible to all)
      if (msg.drop) {
        const dropId = "drop_" + msg.id;
        spawnLootDrop(dropId, msg.drop);
      }
      break;
    }
    case "entity-hp": {
      const e = state.entities[msg.id];
      if (e) e.hp = msg.hp;
      break;
    }
    case "pickup": {
      if (!state.isHost) return;
      const e = state.entities[msg.id];
      if (!e || (e.type !== "gold_pile" && e.type !== "chest")) return;
      const val = e.value || 0;
      state.net.send({ type: "picked-up", id: msg.id, by: msg.who, value: val });
      delete state.entities[msg.id];
      break;
    }
    case "picked-up": {
      // Sparkle + sound
      const e = state.entities[msg.id];
      if (e) {
        const pos = new THREE.Vector3(e.x, heightAt(e.x, e.z) + 0.6, e.z);
        spawnParticleBurst(state.scene, pos, { count: 14, color: 0xf5c97a, speed: 3, life: 0.7, upward: 1.6 });
      }
      sfxPickup();
      removeEntityMesh(msg.id);
      delete state.entities[msg.id];
      if (msg.by === state.myId) {
        state.gold += msg.value || 0;
        updateHUD();
        showEvent(`+${msg.value} gold`, "gold");
      } else if (state.players[msg.by]) {
        state.players[msg.by].gold = (state.players[msg.by].gold || 0) + (msg.value || 0);
        updatePlayerList();
      }
      break;
    }
    case "fireball": {
      // Other players' fireballs — render visual only (host handles damage)
      if (msg.from === state.myId) return;
      const pos = new THREE.Vector3(msg.x, msg.y, msg.z);
      const dir = new THREE.Vector3(msg.dx, msg.dy, msg.dz);
      spawnFireball(pos, dir, msg.from);
      break;
    }
    case "loot-pickup": {
      // Local player picked up potion
      if (msg.by === state.myId) {
        if (msg.kind === "hp_potion") {
          state.hpPotions = Math.min(5, state.hpPotions + 1);
          showEvent("HP Potion picked up", "heal");
          sfxPickup();
        }
        updateHUD();
      }
      removeLootDrop(msg.id);
      break;
    }
    case "player-dmg": {
      // Apply to local player or remote
      if (msg.id === state.myId) {
        state.hp = Math.max(0, state.hp - msg.dmg);
        state.lastHurtAt = performance.now();
        flashHurt();
        sfxPlayerHurt();
        cameraShake(0.5, 0.35);
        if (state.hp <= 0) {
          state.alive = false;
          state.respawnAt = performance.now() + 4000;
          showEvent("You fell. Respawning…", "kill");
          state.net.send({ type: "player-died", id: state.myId });
          spawnParticleBurst(state.scene, state.camera.position, { count: 40, color: 0xc45c5c, speed: 5, life: 1.0, upward: 1.5 });
        }
        updateHUD();
      } else if (state.players[msg.id]) {
        const p = state.players[msg.id];
        p.hp = Math.max(0, (p.hp || p.maxHp || 100) - msg.dmg);
        if (p.hp <= 0) { p.alive = false; if (p.mesh) p.mesh.visible = false; }
        updatePlayerList();
      }
      break;
    }
    case "player-died": {
      if (state.players[msg.id]) {
        state.players[msg.id].alive = false;
        if (state.players[msg.id].mesh) state.players[msg.id].mesh.visible = false;
      }
      break;
    }
    case "respawn": {
      if (msg.id === state.myId) return;
      const p = state.players[msg.id];
      if (!p) return;
      p.alive = true;
      p.hp = p.maxHp || 100;
      p.tx = msg.x; p.ty = msg.y; p.tz = msg.z;
      if (p.mesh) p.mesh.visible = true;
      updatePlayerList();
      break;
    }
    case "boss-aggro": {
      state.bossAggro = true;
      $("#boss-bar").classList.remove("hidden");
      showEvent("The Pale Dragon stirs.", "kill");
      sfxDragonRoar();
      cameraShake(0.6, 0.8);
      break;
    }
    case "victory": {
      state.phase = "won";
      showEndScreen(true);
      break;
    }
    case "hello-back":
      // No-op — used by some hello patterns
      break;
  }
}

function dumpPlayersForSnapshot() {
  const out = {};
  const self = state.controls.getObject();
  out[state.myId] = { name: state.myName, x: self.position.x, y: self.position.y, z: self.position.z, hp: state.hp, maxHp: state.maxHp, gold: state.gold, alive: state.alive };
  for (const [id, p] of Object.entries(state.players)) {
    out[id] = { name: p.name, x: p.tx, y: p.ty, z: p.tz, hp: p.hp, maxHp: p.maxHp, gold: p.gold, alive: p.alive };
  }
  return out;
}

// ============================================================
//  HUD
// ============================================================
function updateHUD() {
  const pct = (state.hp / state.maxHp) * 100;
  $("#hp-fill").style.width = pct + "%";
  $("#hp-num").textContent = `${Math.max(0, Math.floor(state.hp))}/${state.maxHp}`;
  const mpPct = (state.mp / state.maxMp) * 100;
  $("#mp-fill").style.width = mpPct + "%";
  $("#mp-num").textContent = `${Math.max(0, Math.floor(state.mp))}/${state.maxMp}`;
  $("#gold-num").textContent = state.gold;
  $("#potion-count").textContent = state.hpPotions;

  // Boss bar
  const boss = state.entities["boss"];
  if (boss && state.bossAggro) {
    $("#boss-bar").classList.remove("hidden");
    $("#boss-hp-fill").style.width = ((boss.hp / boss.maxHp) * 100) + "%";
  } else if (!boss && state.bossAggro) {
    $("#boss-bar").classList.add("hidden");
  }

  // Objective distance
  if (boss) {
    const obj = state.controls.getObject();
    const dx = boss.x - obj.position.x, dz = boss.z - obj.position.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    $("#obj-distance").textContent = `${d.toFixed(0)}m`;
  } else {
    $("#obj-distance").textContent = "— —";
  }
}

function updatePlayerList() {
  const list = $("#player-list");
  list.innerHTML = "";
  for (const [id, p] of Object.entries(state.players)) {
    const tag = document.createElement("div");
    tag.className = "player-tag" + (p.alive === false ? " dead" : "");
    tag.innerHTML = `
      <div class="ptag-name">${escapeHTML(p.name || "Wanderer")}</div>
      <div class="ptag-hp">${Math.max(0, Math.floor(p.hp || 0))}/${p.maxHp || 100}  ·  ★ ${p.gold || 0}</div>
    `;
    list.appendChild(tag);
  }

  // Lobby roster — show self + all known players
  const lobby = $("#lobby-players");
  if (lobby) {
    lobby.innerHTML = "";
    const roster = [
      { id: state.myId, name: state.myName + (state.isHost ? " (host)" : ""), self: true },
      ...Object.entries(state.players).map(([id, p]) => ({ id, name: p.name || "Wanderer" })),
    ];
    for (const r of roster) {
      const row = document.createElement("div");
      row.className = "player-row";
      row.innerHTML = `<span class="name">${escapeHTML(r.name)}</span>`;
      lobby.appendChild(row);
    }
  }
}

function flashHurt() {
  document.body.style.transition = "background 0.18s";
  document.body.style.background = "rgba(196,92,92,0.4)";
  setTimeout(() => { document.body.style.background = ""; }, 180);
}

function showEvent(text, kind = "") {
  const el = document.createElement("div");
  el.className = "event " + kind;
  el.textContent = text;
  $("#event-log").appendChild(el);
  setTimeout(() => el.classList.add("fade"), 2000);
  setTimeout(() => el.remove(), 3200);
}

function showEndScreen(victory) {
  state.finished = true;
  state.controls.unlock();
  $("#hud").classList.add("hidden");
  $("#screen-end").classList.remove("hidden");
  $("#end-title").textContent = victory ? "The Pale Dragon Falls" : "The Vale Defeats You";
  const stats = $("#end-stats");
  stats.innerHTML = "";
  const allPlayers = [
    { name: state.myName + " (you)", gold: state.gold, hp: state.hp, maxHp: state.maxHp },
    ...Object.values(state.players).map(p => ({ name: p.name, gold: p.gold || 0, hp: p.hp || 0, maxHp: p.maxHp || 100 })),
  ];
  for (const p of allPlayers) {
    const row = document.createElement("div");
    row.className = "end-stat-row";
    row.innerHTML = `<span>${escapeHTML(p.name)}</span><span>★ ${p.gold}</span>`;
    stats.appendChild(row);
  }
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

function banner(msg, kind = "error") {
  const b = $("#banner");
  b.textContent = msg;
  b.className = kind === "info" ? "info" : "";
  b.classList.remove("hidden");
  clearTimeout(banner._t);
  banner._t = setTimeout(() => b.classList.add("hidden"), 3500);
}

// ============================================================
//  Boot / mode selection
// ============================================================
async function startSolo() {
  const name = $("#name").value.trim();
  if (!name) return banner("Enter your name first.");
  state.myName = name;
  state.net.initSolo();
  state.net.onMessage = onMessage;
  state.isHost = true;
  state.myId = state.net.myId;
  state.worldSeed = Math.floor(Math.random() * 0x7fffffff);
  buildPropsForSeed(state.worldSeed);
  state.entities = placeEntities(state.worldSeed);
  // Halve boss HP for solo
  if (state.entities["boss"]) {
    state.entities["boss"].hp = 110;
    state.entities["boss"].maxHp = 110;
  }
  for (const [id, e] of Object.entries(state.entities)) {
    const m = ensureEntityMesh(id, e);
    m.position.set(e.x, heightAt(e.x, e.z), e.z);
  }
  $("#screen-start").classList.add("hidden");
  enterGame();
}

async function hostCoop() {
  const name = $("#name").value.trim();
  if (!name) return banner("Enter your name first.");
  state.myName = name;
  state.roomCode = makeRoomCode();
  state.net.onMessage = onMessage;
  state.net.onPresenceChange = (present) => {
    for (const id of Object.keys(state.players)) {
      if (!present.has(id)) {
        if (state.players[id].mesh) state.scene.remove(state.players[id].mesh);
        delete state.players[id];
        updatePlayerList();
      }
    }
  };
  try {
    await state.net.joinRoom(state.roomCode);
  } catch (e) {
    return banner("Could not start room: " + e.message);
  }
  state.isHost = true;
  state.myId = state.net.myId;
  state.worldSeed = Math.floor(Math.random() * 0x7fffffff);
  buildPropsForSeed(state.worldSeed);
  state.entities = placeEntities(state.worldSeed);
  for (const [id, e] of Object.entries(state.entities)) {
    const m = ensureEntityMesh(id, e);
    m.position.set(e.x, heightAt(e.x, e.z), e.z);
  }

  // Show lobby (host sees the Enter button)
  $("#screen-start").classList.add("hidden");
  $("#room-code-display").textContent = state.roomCode;
  $("#screen-lobby").classList.remove("hidden");
  $("#enter-btn").classList.remove("hidden");
  $("#lobby-hint").classList.remove("hidden");
  $("#lobby-hint-join").classList.add("hidden");
  state.phase = "lobby";

  // Announce self
  state.net.send({ type: "hello", id: state.myId, name: state.myName });
  updatePlayerList();
}

async function joinCoop() {
  const name = $("#name").value.trim();
  const code = $("#room-code-input").value.trim().toUpperCase();
  if (!name) return banner("Enter your name first.");
  if (code.length !== 6) return banner("Enter a 6-char room code.");
  state.myName = name;
  state.roomCode = code;
  state.net.onMessage = onMessage;
  try {
    await state.net.joinRoom(code);
  } catch (e) {
    return banner("Could not join room: " + e.message);
  }
  state.isHost = false;
  state.myId = state.net.myId;

  $("#screen-start").classList.add("hidden");
  $("#room-code-display").textContent = code;
  $("#screen-lobby").classList.remove("hidden");
  // Joiners don't see Enter button — host starts the game
  $("#enter-btn").classList.add("hidden");
  $("#lobby-hint").classList.add("hidden");
  $("#lobby-hint-join").classList.remove("hidden");
  state.phase = "lobby";

  // Announce self — host will send snapshot
  state.net.send({ type: "hello", id: state.myId, name: state.myName });
}

function enterCoopGame() {
  // Host triggers everyone to enter the game
  if (state.isHost) {
    state.net.send({
      type: "start",
      seed: state.worldSeed,
      entities: state.entities,
    });
  }
  enterGame();
}

function enterGame() {
  $("#screen-lobby").classList.add("hidden");
  $("#hud").classList.remove("hidden");
  state.phase = "playing";
  // Position player
  const obj = state.controls.getObject();
  obj.position.set(WORLD.SPAWN.x, heightAt(WORLD.SPAWN.x, WORLD.SPAWN.z) + PLAYER_HEIGHT, WORLD.SPAWN.z);
  // Lock pointer
  state.renderer.domElement.requestPointerLock?.();
  state.controls.lock();
  updateHUD();
  updatePlayerList();
}

function restart() {
  location.reload();
}

// ============================================================
//  Input
// ============================================================
function setupInput() {
  document.addEventListener("keydown", (e) => {
    state.keys[e.key] = true;
    unlockAudio();
    if (state.phase === "playing") {
      if (e.key === "1") useHpPotion();
    }
  });
  document.addEventListener("keyup", (e) => {
    state.keys[e.key] = false;
  });

  state.renderer.domElement.addEventListener("mousedown", (e) => {
    unlockAudio();
    if (state.phase !== "playing") return;
    if (!state.controls.isLocked) {
      state.controls.lock();
      return;
    }
    if (e.button === 0) {
      state.mouseDown = true;
      attack();
    } else if (e.button === 2) {
      castFireball();
    }
  });
  document.addEventListener("mouseup", (e) => {
    if (e.button === 0) state.mouseDown = false;
  });
  // Suppress browser context menu for right-click
  state.renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());

  // Unlock audio on any click anywhere
  document.addEventListener("click", () => unlockAudio(), { once: false });
}

// ============================================================
//  Main loop
// ============================================================
function loop() {
  const dt = Math.min(0.05, state.clock.getDelta());

  // Interpolate remote players
  for (const [id, p] of Object.entries(state.players)) {
    if (!p.mesh) continue;
    const lerpT = 0.18;
    p.x = p.x + (p.tx - p.x) * lerpT;
    p.y = p.y + (p.ty - p.y) * lerpT;
    p.z = p.z + (p.tz - p.z) * lerpT;
    p.mesh.position.set(p.x, p.y - PLAYER_HEIGHT, p.z);
  }

  // Entity meshes follow logical positions
  for (const [id, e] of Object.entries(state.entities)) {
    const mesh = state.entityMeshes[id];
    if (!mesh) continue;
    if (e.x !== undefined) {
      mesh.position.x = e.x;
      mesh.position.z = e.z;
      mesh.position.y = heightAt(e.x, e.z);
    }
    // Face nearest player (for monsters)
    if ((e.type === "wolf" || e.type === "skeleton" || e.type === "troll" || e.type === "dragon") && e.aggro !== false) {
      const obj = state.controls.getObject();
      let tx = obj.position.x, tz = obj.position.z, tD2 = (tx - e.x) ** 2 + (tz - e.z) ** 2;
      for (const p of Object.values(state.players)) {
        const d2 = (p.x - e.x) ** 2 + (p.z - e.z) ** 2;
        if (d2 < tD2) { tx = p.x; tz = p.z; tD2 = d2; }
      }
      const ang = Math.atan2(tx - e.x, tz - e.z);
      mesh.rotation.y = ang;
    }
    // HP bar update + billboard
    if (mesh.userData?.hpBar) {
      const bar = mesh.userData.hpBar;
      const pct = Math.max(0, (e.hp || 0) / (e.maxHp || 1));
      bar.userData.fill.scale.x = pct;
      bar.userData.fill.position.x = -(1 - pct) * 0.5;
      bar.visible = pct < 1.0;
      bar.lookAt(state.camera.position);
    }
    // Gold pile bob
    if (e.type === "gold_pile") {
      mesh.position.y = heightAt(e.x, e.z) + 0.4 + Math.sin(performance.now() * 0.003 + e.x) * 0.08;
      mesh.rotation.y += dt * 1.4;
    }
  }

  // Campfire flicker
  if (state.fireLight) {
    state.fireLight.intensity = 1.6 + Math.sin(performance.now() * 0.012) * 0.4 + Math.random() * 0.15;
    state.fireMesh.scale.setScalar(0.9 + Math.sin(performance.now() * 0.018) * 0.12);
  }

  // Update HP bars to face camera (player labels too)
  for (const p of Object.values(state.players)) {
    if (p.mesh?.userData?.label) {
      p.mesh.userData.label.lookAt(state.camera.position);
    }
  }

  updatePlayer(dt);
  hostTick(dt);
  if (state.phase === "playing") updateHUD();

  // Day/night
  if (state.phase === "playing") updateDayNight(dt);

  // FX
  updateParticles(state.scene, dt);
  updateDamageNumbers(state.scene, dt);
  updateFireballs(dt);
  updateFireflies(dt, performance.now());

  // Loot drops bob and check pickup
  for (const [id, l] of Object.entries(state.lootDrops)) {
    l.mesh.position.y = heightAt(l.x, l.z) + 0.45 + Math.sin(performance.now() * 0.004 + l.x) * 0.08;
    l.mesh.rotation.y += dt * 1.6;
    // Pickup if local player walks over
    if (state.alive && state.phase === "playing") {
      const obj = state.controls.getObject();
      const dx = obj.position.x - l.x, dz = obj.position.z - l.z;
      if (dx * dx + dz * dz < 1.4 * 1.4 && !l.pending) {
        l.pending = true;
        state.net.send({ type: "loot-pickup", by: state.myId, id, kind: l.type });
      }
    }
  }

  // Camera shake
  applyCameraShake(state.camera, dt);

  state.composer.render(dt);
  requestAnimationFrame(loop);
}

// ============================================================
//  Boot
// ============================================================
document.addEventListener("DOMContentLoaded", () => {
  initScene();
  setupInput();

  $("#solo-btn").addEventListener("click", startSolo);
  $("#host-btn").addEventListener("click", hostCoop);
  $("#join-btn").addEventListener("click", joinCoop);
  $("#enter-btn").addEventListener("click", enterCoopGame);
  $("#restart-btn").addEventListener("click", restart);

  loop();
});
