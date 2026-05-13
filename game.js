import * as THREE from "https://esm.sh/three@0.160.0";
import { PointerLockControls } from "https://esm.sh/three@0.160.0/examples/jsm/controls/PointerLockControls.js";
import { STORY_BEATS, computeEnding } from "./story.js";

// --- Globals ---
const state = {
  renderer: null,
  scene: null,
  camera: null,
  controls: null,
  clock: new THREE.Clock(),
  keys: {},
  player: { x: 0, y: 1.6, z: 0, vx: 0, vz: 0 },
  trees: [],     // {x, z, r}
  npcs: {},      // beatId -> { group, light }
  story: { seen: new Set(), flags: {}, currentBeat: null, lineIdx: 0 },
  dialogueOpen: false,
  nearbyBeat: null,
  started: false,
  finished: false,
};

const $ = (s) => document.querySelector(s);

// --- Three.js scene ---
function initScene() {
  const canvas = $("#scene");
  state.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  state.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  state.renderer.setSize(window.innerWidth, window.innerHeight);
  state.renderer.shadowMap.enabled = false;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07060d);
  scene.fog = new THREE.FogExp2(0x07060d, 0.045);
  state.scene = scene;

  const camera = new THREE.PerspectiveCamera(
    72,
    window.innerWidth / window.innerHeight,
    0.1,
    400
  );
  camera.position.set(0, 1.6, 0);
  state.camera = camera;

  // Ground — large dark plane with subtle pattern
  const groundGeo = new THREE.PlaneGeometry(200, 400, 40, 80);
  // Slight terrain variation
  const pos = groundGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const h = Math.sin(x * 0.07) * 0.15 + Math.cos(y * 0.09) * 0.12;
    pos.setZ(i, h);
  }
  groundGeo.computeVertexNormals();
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x1a1f15,
    roughness: 0.95,
    metalness: 0.0,
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.z = -100;
  scene.add(ground);

  // The path — a slightly lighter, longer strip
  const pathGeo = new THREE.PlaneGeometry(3.2, 250);
  const pathMat = new THREE.MeshStandardMaterial({
    color: 0x2e2418,
    roughness: 1.0,
  });
  const path = new THREE.Mesh(pathGeo, pathMat);
  path.rotation.x = -Math.PI / 2;
  path.position.set(0, 0.01, -110);
  scene.add(path);

  // Lighting
  const ambient = new THREE.AmbientLight(0x3a4a66, 0.32);
  scene.add(ambient);

  const moon = new THREE.DirectionalLight(0xa0b8e0, 0.45);
  moon.position.set(-30, 50, -20);
  scene.add(moon);

  // Player lantern — a warm point light following the camera
  const lantern = new THREE.PointLight(0xf5c97a, 1.6, 12, 1.8);
  lantern.position.set(0, 0, 0);
  camera.add(lantern);
  scene.add(camera);

  // Distant moon disc
  const moonGeo = new THREE.CircleGeometry(8, 32);
  const moonMat = new THREE.MeshBasicMaterial({ color: 0xe8e0d0, transparent: true, opacity: 0.5 });
  const moonMesh = new THREE.Mesh(moonGeo, moonMat);
  moonMesh.position.set(-60, 50, -180);
  moonMesh.lookAt(0, 1.6, 0);
  scene.add(moonMesh);

  // Trees scattered along the path
  populateForest();

  // NPCs at story beats
  spawnNPCs();

  // The Watchtower at the end
  buildWatchtower();

  // Controls
  state.controls = new PointerLockControls(camera, state.renderer.domElement);

  state.controls.addEventListener("lock",   () => $("#hud").classList.remove("hidden"));
  state.controls.addEventListener("unlock", () => $("#hud").classList.add("hidden"));

  window.addEventListener("resize", onResize);
}

function onResize() {
  state.camera.aspect = window.innerWidth / window.innerHeight;
  state.camera.updateProjectionMatrix();
  state.renderer.setSize(window.innerWidth, window.innerHeight);
}

function populateForest() {
  const rng = mulberry32(20260513);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x1a1410, roughness: 1.0 });
  const canopyMat = new THREE.MeshStandardMaterial({ color: 0x0c180a, roughness: 1.0 });

  for (let i = 0; i < 220; i++) {
    const side = rng() < 0.5 ? -1 : 1;
    const x = side * (2.2 + rng() * 18);
    const z = -2 - rng() * 200;
    const h = 5 + rng() * 6;
    const r = 0.25 + rng() * 0.25;

    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(r * 0.8, r, h, 6),
      trunkMat
    );
    trunk.position.set(x, h / 2, z);
    state.scene.add(trunk);

    const canopy = new THREE.Mesh(
      new THREE.ConeGeometry(1.4 + rng() * 0.9, 2.6 + rng() * 1.6, 6),
      canopyMat
    );
    canopy.position.set(x, h + 0.6, z);
    state.scene.add(canopy);

    state.trees.push({ x, z, r: r + 0.2 });
  }

  // Ground tufts (small dark cones for variation)
  const tuftMat = new THREE.MeshStandardMaterial({ color: 0x1f2a18, roughness: 1.0 });
  for (let i = 0; i < 120; i++) {
    const x = (rng() - 0.5) * 30;
    const z = -rng() * 200;
    const tuft = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.5, 5), tuftMat);
    tuft.position.set(x, 0.25, z);
    state.scene.add(tuft);
  }
}

function spawnNPCs() {
  for (const beat of STORY_BEATS) {
    if (!beat.npc) continue;
    const g = makeNPC(beat.npc);
    g.position.set(beat.npc.x, 0, beat.npc.z);
    state.scene.add(g);
    state.npcs[beat.id] = g;
  }
}

function makeNPC(spec) {
  const group = new THREE.Group();

  if (spec.type === "storyteller") {
    // tall cloaked figure
    const cloakMat = new THREE.MeshStandardMaterial({ color: 0x1a1024, roughness: 1 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.65, 1.8, 8), cloakMat);
    body.position.y = 0.9;
    group.add(body);
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.25, 8, 8),
      new THREE.MeshStandardMaterial({ color: 0x0a0612, roughness: 1 })
    );
    head.position.y = 1.95;
    group.add(head);
    // Lantern
    const lantern = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.22, 0.18),
      new THREE.MeshStandardMaterial({ color: 0xc08a3e, emissive: 0xf5c97a, emissiveIntensity: 1.2 })
    );
    lantern.position.set(0.55, 1.2, 0);
    group.add(lantern);
    const lanternLight = new THREE.PointLight(0xf5c97a, 1.4, 6, 2);
    lanternLight.position.set(0.55, 1.2, 0);
    group.add(lanternLight);
  } else if (spec.type === "wounded") {
    // crouched figure
    const mat = new THREE.MeshStandardMaterial({ color: 0x4a2230, roughness: 1 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.4, 4, 8), mat);
    body.position.y = 0.55;
    body.rotation.z = 0.35;
    group.add(body);
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 8, 8),
      new THREE.MeshStandardMaterial({ color: 0xc09080, roughness: 1 })
    );
    head.position.set(0.25, 1.0, 0);
    group.add(head);
    const lantern = new THREE.Mesh(
      new THREE.BoxGeometry(0.15, 0.18, 0.15),
      new THREE.MeshStandardMaterial({ color: 0xc08a3e, emissive: 0xc45c5c, emissiveIntensity: 1.0 })
    );
    lantern.position.set(-0.3, 0.4, 0.3);
    group.add(lantern);
    const ll = new THREE.PointLight(0xc45c5c, 0.9, 4, 2);
    ll.position.set(-0.3, 0.4, 0.3);
    group.add(ll);
  } else if (spec.type === "child") {
    const mat = new THREE.MeshStandardMaterial({ color: 0x2a4a3a, roughness: 1 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.5, 4, 8), mat);
    body.position.y = 0.5;
    group.add(body);
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 8, 8),
      new THREE.MeshStandardMaterial({ color: 0xd0a888, roughness: 1 })
    );
    head.position.y = 1.0;
    group.add(head);
    const lantern = new THREE.Mesh(
      new THREE.BoxGeometry(0.13, 0.16, 0.13),
      new THREE.MeshStandardMaterial({ color: 0xc08a3e, emissive: 0x6ec79b, emissiveIntensity: 1.2 })
    );
    lantern.position.set(0.3, 0.5, 0);
    group.add(lantern);
    const ll = new THREE.PointLight(0x6ec79b, 1.0, 5, 2);
    ll.position.set(0.3, 0.5, 0);
    group.add(ll);
  } else if (spec.type === "tower") {
    // Placeholder — actual tower is built separately
  }
  return group;
}

function buildWatchtower() {
  const towerMat = new THREE.MeshStandardMaterial({ color: 0x2a2630, roughness: 1.0 });
  // Tower body
  const body = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.5, 14, 10), towerMat);
  body.position.set(0, 7, -125);
  state.scene.add(body);
  // Top crown
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.5, 1.2, 10), towerMat);
  crown.position.set(0, 14.6, -125);
  state.scene.add(crown);
  // Beacon
  const beacon = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 0.9, 0.6),
    new THREE.MeshStandardMaterial({ color: 0xc08a3e, emissive: 0xf5c97a, emissiveIntensity: 0.6 })
  );
  beacon.position.set(0, 15.6, -125);
  state.scene.add(beacon);
  const beaconLight = new THREE.PointLight(0xf5c97a, 1.8, 30, 2);
  beaconLight.position.set(0, 15.6, -125);
  state.scene.add(beaconLight);

  // Track these for collision
  state.trees.push({ x: 0, z: -125, r: 2.6 });
}

// --- Update loop ---
function update(dt) {
  if (!state.started || state.finished || state.dialogueOpen) return;

  const speed = 4.0; // m/s
  const fwd = (state.keys["w"] || state.keys["ArrowUp"]   ? 1 : 0)
            + (state.keys["s"] || state.keys["ArrowDown"] ? -1 : 0);
  const strafe = (state.keys["d"] || state.keys["ArrowRight"] ? 1 : 0)
              + (state.keys["a"] || state.keys["ArrowLeft"]  ? -1 : 0);

  if (state.controls.isLocked) {
    if (fwd !== 0) state.controls.moveForward(fwd * speed * dt);
    if (strafe !== 0) state.controls.moveRight(strafe * speed * dt);
  }

  // Constrain to play area
  const cam = state.camera.position;
  cam.x = Math.max(-22, Math.min(22, cam.x));
  cam.z = Math.max(-180, Math.min(8, cam.z));
  cam.y = 1.6;

  // Simple tree collision — push out if too close
  for (const t of state.trees) {
    const dx = cam.x - t.x;
    const dz = cam.z - t.z;
    const d2 = dx * dx + dz * dz;
    const minD = t.r + 0.4;
    if (d2 < minD * minD) {
      const d = Math.sqrt(d2) || 0.0001;
      cam.x = t.x + (dx / d) * minD;
      cam.z = t.z + (dz / d) * minD;
    }
  }

  // Story trigger detection
  detectNearbyBeat();
}

function detectNearbyBeat() {
  const cam = state.camera.position;
  let nearest = null;
  let nearestDist = Infinity;
  for (const beat of STORY_BEATS) {
    if (state.story.seen.has(beat.id)) continue;
    const dx = cam.x - beat.triggerAt.x;
    const dz = cam.z - beat.triggerAt.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < beat.triggerRadius && d < nearestDist) {
      nearest = beat;
      nearestDist = d;
    }
  }
  if (nearest !== state.nearbyBeat) {
    state.nearbyBeat = nearest;
    const prompt = $("#interact-prompt");
    if (nearest) prompt.classList.remove("hidden");
    else prompt.classList.add("hidden");
  }
}

function loop() {
  const dt = Math.min(0.05, state.clock.getDelta());
  update(dt);
  state.renderer.render(state.scene, state.camera);
  requestAnimationFrame(loop);
}

// --- Dialogue ---
function openBeat(beat) {
  state.dialogueOpen = true;
  state.story.currentBeat = beat;
  state.story.lineIdx = 0;
  state.controls.unlock();
  $("#interact-prompt").classList.add("hidden");

  if (beat.final) {
    // Compute and show ending directly
    showEnding();
    return;
  }

  $("#dialogue").classList.remove("hidden");
  renderCurrentLine();
}

function renderCurrentLine(extraLines = null) {
  const beat = state.story.currentBeat;
  const lines = extraLines || beat.lines;
  const i = state.story.lineIdx;
  const line = lines[i];
  if (!line) {
    showChoices();
    return;
  }
  $("#dialogue-speaker").textContent = line.who;
  typewrite($("#dialogue-text"), line.text);
  $("#dialogue-choices").innerHTML = "";
  const cont = $("#continue-btn");
  if (i < lines.length - 1) {
    cont.classList.remove("hidden");
    cont.textContent = "Continue ↵";
    cont.onclick = () => {
      state.story.lineIdx++;
      renderCurrentLine(lines);
    };
  } else {
    cont.classList.remove("hidden");
    cont.textContent = "↵";
    cont.onclick = () => {
      // Reached end of lines — show choices
      showChoices();
    };
  }
}

function showChoices() {
  const beat = state.story.currentBeat;
  $("#dialogue-text").textContent = "";
  $("#dialogue-speaker").textContent = "Your move.";
  $("#continue-btn").classList.add("hidden");
  const cs = $("#dialogue-choices");
  cs.innerHTML = "";
  if (!beat.choices || beat.choices.length === 0) {
    closeDialogue();
    return;
  }
  for (const c of beat.choices) {
    const btn = document.createElement("button");
    btn.className = "choice";
    btn.textContent = c.label;
    btn.addEventListener("click", () => selectChoice(c));
    cs.appendChild(btn);
  }
}

function selectChoice(choice) {
  // Apply flags
  if (choice.flags) {
    for (const [k, v] of Object.entries(choice.flags)) {
      if (typeof v === "number") {
        state.story.flags[k] = (state.story.flags[k] || 0) + v;
      } else {
        state.story.flags[k] = v;
      }
    }
  }
  // Followup lines?
  if (choice.followup && choice.followup.length) {
    state.story.lineIdx = 0;
    const lines = choice.followup;
    $("#dialogue-speaker").textContent = lines[0].who;
    typewrite($("#dialogue-text"), lines[0].text);
    $("#dialogue-choices").innerHTML = "";
    const cont = $("#continue-btn");
    cont.classList.remove("hidden");
    let i = 0;
    cont.textContent = "Continue ↵";
    cont.onclick = () => {
      i++;
      if (i >= lines.length) {
        closeDialogue();
      } else {
        $("#dialogue-speaker").textContent = lines[i].who;
        typewrite($("#dialogue-text"), lines[i].text);
        if (i === lines.length - 1) cont.textContent = "↵";
      }
    };
    return;
  }
  closeDialogue();
}

function closeDialogue() {
  const beat = state.story.currentBeat;
  if (beat) state.story.seen.add(beat.id);
  state.dialogueOpen = false;
  state.story.currentBeat = null;
  $("#dialogue").classList.add("hidden");
  state.nearbyBeat = null;
}

function typewrite(el, text) {
  el.textContent = "";
  let i = 0;
  clearInterval(typewrite._t);
  typewrite._t = setInterval(() => {
    el.textContent += text[i] || "";
    i++;
    if (i >= text.length) clearInterval(typewrite._t);
  }, 22);
  // Click to skip
  el.onclick = () => {
    clearInterval(typewrite._t);
    el.textContent = text;
  };
}

// --- Ending ---
function showEnding() {
  state.finished = true;
  const ending = computeEnding(state.story.flags);
  $("#dialogue").classList.add("hidden");
  $("#ending-title").textContent = ending.title;
  $("#ending-text").innerHTML = ending.lines.map(l => `<p>${escapeHTML(l)}</p>`).join("");
  $("#screen-ending").classList.remove("hidden");
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

// --- Start / restart ---
function begin() {
  $("#screen-start").classList.add("hidden");
  state.started = true;
  state.renderer.domElement.requestPointerLock?.();
  state.controls.lock();
}

function restart() {
  location.reload();
}

// --- Input ---
function setupInput() {
  document.addEventListener("keydown", (e) => {
    state.keys[e.key] = true;
    if (e.key.toLowerCase() === "e" && state.nearbyBeat && !state.dialogueOpen) {
      openBeat(state.nearbyBeat);
    }
  });
  document.addEventListener("keyup", (e) => {
    state.keys[e.key] = false;
  });
  // Re-lock pointer on canvas click after pause
  state.renderer.domElement.addEventListener("click", () => {
    if (state.started && !state.dialogueOpen && !state.finished) {
      state.controls.lock();
    }
  });
}

// --- Seeded RNG ---
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Boot ---
document.addEventListener("DOMContentLoaded", () => {
  initScene();
  setupInput();
  $("#begin-btn").addEventListener("click", begin);
  $("#restart-btn").addEventListener("click", restart);
  loop();
});
