// Car — arcade physics + low-poly mesh.

import * as THREE from "https://esm.sh/three@0.160.0";

export const TOP_SPEED       = 55;    // m/s, ~200 km/h
export const TOP_SPEED_BOOST = 80;    // m/s, ~290 km/h
export const ACCEL           = 24;    // m/s²
export const ACCEL_BOOST     = 36;
export const BRAKE_FORCE     = 42;
export const REVERSE_TOP     = 14;
export const TURN_RATE_LOW   = 2.2;   // rad/s at very low speed
export const TURN_RATE_HIGH  = 0.9;   // rad/s at top speed
export const GRIP_NORMAL     = 9.0;
export const GRIP_DRIFT      = 2.4;
export const DRAG_FACTOR     = 0.001;
export const GRASS_SLOWDOWN  = 0.45;
export const WALL_BOUNCE     = 0.7;
export const BOOST_DRAIN     = 0.32;  // fraction per second
export const BOOST_FROM_DRIFT = 0.14;  // per second of drifting

export const COLORS = [0xc83040, 0x3a90e0, 0x80c040, 0xe0a040, 0xd060c0, 0x40c8a8];

export class Car {
  constructor({ id, name, color, isLocal, scene }) {
    this.id = id;
    this.name = name;
    this.color = color ?? COLORS[0];
    this.isLocal = !!isLocal;
    this.scene = scene;

    // Kinematic state
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.heading = 0;             // yaw in radians
    this.steerInput = 0;
    this.throttle = 0;
    this.brake = 0;
    this.drifting = false;
    this.boostActive = false;
    this.boost = 0.0;             // 0..1
    this.lateralSpeed = 0;        // computed each frame for smoke fx
    this.onGrass = false;
    this.airborne = false;
    this.yVel = 0;
    this.yPos = 0;

    // Race state
    this.currentCheckpoint = 0;
    this.lap = 0;
    this.lapTimes = [];
    this.lapStartT = 0;
    this.bestLap = Infinity;
    this.raceTime = 0;
    this.finished = false;
    this.finishTime = 0;
    this.position = 1;          // race position
    this.lastTrackIndex = 0;    // for nearestOnTrack hint

    // Visual
    this.mesh = buildCarMesh(this.color, this.name);
    this.scene.add(this.mesh);
    this.wheels = this.mesh.userData.wheels;
    this.bodyPivot = this.mesh.userData.bodyPivot;
    this.boostLight = this.mesh.userData.boostLight;

    // Remote interpolation
    this.tx = 0; this.ty = 0; this.tz = 0; this.tHeading = 0;
    this.lastNetUpdate = 0;
  }

  speed() { return this.vel.length(); }
  forward() {
    return new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
  }
  right() {
    return new THREE.Vector3(Math.cos(this.heading), 0, -Math.sin(this.heading));
  }

  // Apply inputs and integrate physics. `dt` in seconds.
  step(dt) {
    if (this.finished) {
      // Coast to a stop
      this.vel.multiplyScalar(0.96);
    }

    const speed = this.speed();
    const fwd = this.forward();
    const rt = this.right();

    // Decompose velocity into forward + lateral
    let vF = this.vel.dot(fwd);
    let vL = this.vel.dot(rt);

    // Throttle / brake
    if (this.throttle > 0) {
      const topSpd = this.boostActive ? TOP_SPEED_BOOST : TOP_SPEED;
      const accel = this.boostActive ? ACCEL_BOOST : ACCEL;
      const grassMul = this.onGrass ? GRASS_SLOWDOWN : 1.0;
      if (vF < topSpd * grassMul) vF += accel * this.throttle * grassMul * dt;
    }
    if (this.brake > 0) {
      if (vF > 0) vF -= BRAKE_FORCE * this.brake * dt;
      else if (vF > -REVERSE_TOP) vF -= ACCEL * 0.45 * this.brake * dt;
      if (vF < -REVERSE_TOP) vF = -REVERSE_TOP;
    }

    // Drag
    const dragF = -Math.sign(vF) * DRAG_FACTOR * vF * vF;
    vF += dragF * dt;
    if (Math.abs(vF) < 0.05) vF = 0;

    // Lateral grip — slides bleed off
    const grip = this.drifting ? GRIP_DRIFT : GRIP_NORMAL;
    const grassGrip = this.onGrass ? grip * 0.5 : grip;
    const lateralDecay = Math.exp(-grassGrip * dt);
    vL *= lateralDecay;
    this.lateralSpeed = Math.abs(vL);

    // Steering — turn rate scales down with forward speed
    const speedT = Math.min(1, Math.abs(vF) / TOP_SPEED);
    const turnRate = TURN_RATE_LOW + (TURN_RATE_HIGH - TURN_RATE_LOW) * speedT;
    if (Math.abs(vF) > 0.5) {
      this.heading += this.steerInput * turnRate * dt * Math.sign(vF);
      // Drifting carries the rear out — apply some lateral force opposite steer
      if (this.drifting && Math.abs(vF) > 18) {
        vL -= this.steerInput * Math.abs(vF) * 0.5 * dt;
      } else {
        // Normal turn re-projects velocity onto new heading direction
        // (handled by reassembling vel below)
      }
    }

    // Reassemble velocity from forward + lateral
    const newFwd = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    const newRt = new THREE.Vector3(Math.cos(this.heading), 0, -Math.sin(this.heading));
    this.vel.copy(newFwd).multiplyScalar(vF).addScaledVector(newRt, vL);

    // Boost
    if (this.boostActive && this.boost > 0) {
      this.boost = Math.max(0, this.boost - BOOST_DRAIN * dt);
      if (this.boost <= 0) this.boostActive = false;
    }
    // Drift charges boost
    if (this.drifting && Math.abs(vF) > 18) {
      this.boost = Math.min(1, this.boost + BOOST_FROM_DRIFT * dt);
    }

    // Integrate position
    this.pos.addScaledVector(this.vel, dt);

    // Vertical (jump landing)
    if (this.airborne) {
      this.yVel -= 22 * dt;
      this.yPos += this.yVel * dt;
      if (this.yPos <= 0) {
        this.yPos = 0; this.yVel = 0; this.airborne = false;
      }
    }
    this.pos.y = this.yPos;

    if (!this.finished) this.raceTime += dt;
  }

  // Update visual mesh from physics state.
  updateMesh(dt, time = 0) {
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.y = this.heading;

    // Wheel spin & steer — handle both procedural (Group with userData.steered)
    // and Ferrari ({mesh, steered, baseRotation}) wheel formats.
    const speed = this.speed();
    const wheelSpin = (this.vel.dot(this.forward()) / 0.4) * dt;
    for (const w of this.wheels) {
      if (w && w.mesh) {
        // Ferrari-style descriptor
        w.mesh.rotation.x = (w.mesh.rotation.x || 0) + wheelSpin;
        if (w.steered) w.mesh.rotation.y = this.steerInput * 0.6;
      } else if (w && w.rotation) {
        // Procedural Group
        w.rotation.x += wheelSpin;
        if (w.userData && w.userData.steered) {
          w.rotation.y = this.steerInput * 0.6;
        }
      }
    }

    // Body roll & dive
    const targetRoll = -this.steerInput * Math.min(0.16, speed * 0.004);
    const targetPitch = (this.brake > 0 ? 0.04 : 0) + (this.throttle > 0 ? -0.02 : 0);
    this.bodyPivot.rotation.z += (targetRoll - this.bodyPivot.rotation.z) * Math.min(1, dt * 8);
    this.bodyPivot.rotation.x += (targetPitch - this.bodyPivot.rotation.x) * Math.min(1, dt * 8);

    // Boost light + visible flame
    if (this.boostLight) {
      this.boostLight.intensity = this.boostActive ? 3.2 : 0;
      this.boostLight.visible = this.boostActive;
    }
    const flame = this.mesh.userData?.flame;
    if (flame) {
      flame.visible = this.boostActive;
      if (this.boostActive) {
        flame.scale.set(0.9 + Math.random() * 0.3, 1.0 + Math.random() * 0.5, 0.9 + Math.random() * 0.3);
      }
    }
    // Brake lights brighten when braking or coasting backwards
    const tls = this.mesh.userData?.tailLights;
    if (tls) {
      const t = this.brake > 0.1 ? 2.6 : (this.throttle > 0 ? 0.6 : 1.4);
      for (const m of tls) m.emissiveIntensity = t;
    }
  }

  setLocalInputs(keys) {
    const fwd = (keys["w"] || keys["W"] || keys["ArrowUp"]) ? 1 : 0;
    const back = (keys["s"] || keys["S"] || keys["ArrowDown"]) ? 1 : 0;
    const left = (keys["a"] || keys["A"] || keys["ArrowLeft"]) ? 1 : 0;
    const right = (keys["d"] || keys["D"] || keys["ArrowRight"]) ? 1 : 0;
    this.throttle = fwd;
    this.brake = back;
    this.steerInput = (left ? -1 : 0) + (right ? 1 : 0);
    this.drifting = !!keys["Shift"];
  }
}

function buildCarMesh(color, name) {
  const root = new THREE.Group();
  const bodyPivot = new THREE.Group();
  root.add(bodyPivot);

  // Reusable paint material with high metalness so the env map gives reflections
  const paintMat = new THREE.MeshStandardMaterial({
    color, roughness: 0.22, metalness: 0.85, envMapIntensity: 1.5,
  });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x111114, roughness: 0.3, metalness: 0.7 });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0x101018, roughness: 0.05, metalness: 0.0, transmission: 0.4,
    transparent: true, opacity: 0.55, clearcoat: 1.0, clearcoatRoughness: 0.05, ior: 1.5,
  });

  // Sleek body using a Lathe-like profile via ExtrudeGeometry along Z.
  // Side profile (in XY): low and tapered front, slightly higher rear.
  const bodyShape = new THREE.Shape();
  bodyShape.moveTo(-2.1, 0.05);            // back-bottom
  bodyShape.lineTo( 2.1, 0.05);            // front-bottom
  bodyShape.quadraticCurveTo(2.3, 0.18, 2.25, 0.42);  // front lip up
  bodyShape.lineTo( 1.5, 0.55);            // up to hood
  bodyShape.quadraticCurveTo(0.4, 0.95, -0.4, 0.95);  // roof curve
  bodyShape.lineTo(-1.6, 0.7);             // back-down
  bodyShape.lineTo(-2.1, 0.42);            // tail
  bodyShape.lineTo(-2.1, 0.05);
  const bodyGeo = new THREE.ExtrudeGeometry(bodyShape, {
    depth: 1.7, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.06, bevelSegments: 3,
    steps: 4, curveSegments: 12,
  });
  bodyGeo.translate(0, 0, -0.85);   // center along Z (which becomes width after rotation)
  bodyGeo.rotateY(Math.PI / 2);     // align extrude axis with car X (width)
  const body = new THREE.Mesh(bodyGeo, paintMat);
  bodyPivot.add(body);

  // Greenhouse glass — slightly inset on top of the cabin curve
  const glassShape = new THREE.Shape();
  glassShape.moveTo(-1.0, 0);
  glassShape.lineTo( 0.6, 0);
  glassShape.quadraticCurveTo( 0.3, 0.32, -0.4, 0.32);
  glassShape.lineTo(-1.0, 0);
  const glassGeo = new THREE.ExtrudeGeometry(glassShape, {
    depth: 1.55, bevelEnabled: false, curveSegments: 8,
  });
  glassGeo.translate(0, 0, -0.775);
  glassGeo.rotateY(Math.PI / 2);
  const glass = new THREE.Mesh(glassGeo, glassMat);
  glass.position.y = 0.66;
  bodyPivot.add(glass);

  // Rear wing
  const wing = new THREE.Mesh(
    new THREE.BoxGeometry(1.85, 0.07, 0.45),
    trimMat
  );
  wing.position.set(0, 0.95, -1.95);
  bodyPivot.add(wing);
  for (const x of [-0.78, 0.78]) {
    const sup = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.22, 0.1),
      trimMat
    );
    sup.position.set(x, 0.83, -1.95);
    bodyPivot.add(sup);
  }

  // Headlights (emissive)
  for (const x of [-0.65, 0.65]) {
    const hl = new THREE.Mesh(
      new THREE.BoxGeometry(0.25, 0.12, 0.05),
      new THREE.MeshStandardMaterial({ color: 0xfff0c0, emissive: 0xfff0c0, emissiveIntensity: 1.2 })
    );
    hl.position.set(x, 0.55, 1.95);
    bodyPivot.add(hl);
  }
  // Tail lights — referenced so they can brighten when braking
  const tailLights = [];
  for (const x of [-0.7, 0.7]) {
    const tlMat = new THREE.MeshStandardMaterial({ color: 0xff3030, emissive: 0xff2020, emissiveIntensity: 0.6 });
    const tl = new THREE.Mesh(
      new THREE.BoxGeometry(0.25, 0.12, 0.05),
      tlMat
    );
    tl.position.set(x, 0.55, -1.98);
    bodyPivot.add(tl);
    tailLights.push(tlMat);
  }

  // Wheels — tire + visible rim (silver hub) for proper detail
  const tireGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.32, 20);
  tireGeo.rotateZ(Math.PI / 2);
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0c, roughness: 0.9, metalness: 0.0 });

  const rimGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.34, 14);
  rimGeo.rotateZ(Math.PI / 2);
  const rimMat = new THREE.MeshStandardMaterial({
    color: 0xb8b8c0, roughness: 0.25, metalness: 0.9, envMapIntensity: 1.4,
  });

  // 5-spoke pattern via thin boxes spanning the rim diameter
  function makeWheel() {
    const grp = new THREE.Group();
    const tire = new THREE.Mesh(tireGeo, tireMat);
    grp.add(tire);
    const rim = new THREE.Mesh(rimGeo, rimMat);
    grp.add(rim);
    const spokeMat = new THREE.MeshStandardMaterial({ color: 0xd0d0d8, metalness: 0.85, roughness: 0.25 });
    for (let i = 0; i < 5; i++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.05, 0.08), spokeMat);
      spoke.rotation.x = (i / 5) * Math.PI * 2;
      spoke.position.x = 0;
      grp.add(spoke);
    }
    return grp;
  }

  const wheels = [];
  const positions = [
    [-0.95, 0.42,  1.30, true],
    [ 0.95, 0.42,  1.30, true],
    [-0.95, 0.42, -1.30, false],
    [ 0.95, 0.42, -1.30, false],
  ];
  for (const [x, y, z, steered] of positions) {
    const grp = makeWheel();
    grp.position.set(x, y, z);
    grp.userData.steered = steered;
    root.add(grp);
    wheels.push(grp);
  }

  // Boost flame at exhaust (hidden until boost active)
  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(0.2, 1.0, 8),
    new THREE.MeshStandardMaterial({ color: 0xff8030, emissive: 0xffa050, emissiveIntensity: 2.2, transparent: true, opacity: 0.85 })
  );
  flame.rotation.x = Math.PI / 2;
  flame.position.set(0, 0.55, -2.4);
  flame.visible = false;
  bodyPivot.add(flame);

  // Boost light
  const boostLight = new THREE.PointLight(0xff8030, 0, 6, 2);
  boostLight.position.set(0, 0.5, -2.5);
  boostLight.visible = false;
  bodyPivot.add(boostLight);

  // Name label
  const labelTex = makeNameTexture(name);
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTex, depthTest: false, transparent: true }));
  label.scale.set(3, 0.75, 1);
  label.position.y = 2.4;
  label.renderOrder = 999;
  root.add(label);

  // Cast shadows on all body parts
  root.traverse((c) => {
    if (c.isMesh) {
      c.castShadow = true;
      c.receiveShadow = false;
    }
  });

  root.userData.wheels = wheels;
  root.userData.bodyPivot = bodyPivot;
  root.userData.boostLight = boostLight;
  root.userData.flame = flame;
  root.userData.label = label;
  root.userData.tailLights = tailLights;
  return root;
}

function makeNameTexture(name) {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 64;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "rgba(0,0,0,0.7)";
  ctx.fillRect(0, 0, 256, 64);
  ctx.font = "bold 30px Georgia";
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(name, 128, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  return tex;
}
