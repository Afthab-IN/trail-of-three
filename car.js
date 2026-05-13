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

    // Wheel spin & steer
    const speed = this.speed();
    const wheelSpin = (this.vel.dot(this.forward()) / 0.4) * dt;   // wheel radius 0.4
    for (const w of this.wheels) {
      w.rotation.x += wheelSpin;
      if (w.userData.steered) {
        w.rotation.y = this.steerInput * 0.6;
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

  // bodyPivot wraps everything visual EXCEPT wheels (which are children too, but spin in their own local space)
  const bodyPivot = new THREE.Group();
  root.add(bodyPivot);

  // Chassis (low wedge body)
  const lower = new THREE.Mesh(
    new THREE.BoxGeometry(1.8, 0.5, 4.0),
    new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.55 })
  );
  lower.position.y = 0.55;
  bodyPivot.add(lower);

  // Upper cabin (wedge)
  const cabinShape = new THREE.Shape();
  cabinShape.moveTo(-0.65, 0);
  cabinShape.lineTo(0.65, 0);
  cabinShape.lineTo(0.55, 0.55);
  cabinShape.lineTo(-0.55, 0.55);
  cabinShape.lineTo(-0.65, 0);
  const cabinGeo = new THREE.ExtrudeGeometry(cabinShape, { depth: 1.6, bevelEnabled: false });
  const cabin = new THREE.Mesh(cabinGeo, new THREE.MeshStandardMaterial({
    color: 0x1a1a1f, roughness: 0.2, metalness: 0.6, transparent: true, opacity: 0.85,
  }));
  cabin.rotation.y = Math.PI / 2;
  cabin.position.set(0.8, 0.8, 0);
  bodyPivot.add(cabin);

  // Front spoiler (small)
  const front = new THREE.Mesh(
    new THREE.BoxGeometry(1.7, 0.15, 0.4),
    new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.4 })
  );
  front.position.set(0, 0.35, 1.85);
  bodyPivot.add(front);

  // Rear wing
  const wing = new THREE.Mesh(
    new THREE.BoxGeometry(1.9, 0.06, 0.35),
    new THREE.MeshStandardMaterial({ color: 0x202020, metalness: 0.4 })
  );
  wing.position.set(0, 0.95, -1.9);
  bodyPivot.add(wing);
  // wing supports
  for (const x of [-0.7, 0.7]) {
    const s = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.25, 0.08),
      new THREE.MeshStandardMaterial({ color: 0x202020 })
    );
    s.position.set(x, 0.82, -1.9);
    bodyPivot.add(s);
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

  // Wheels
  const wheelGeo = new THREE.CylinderGeometry(0.4, 0.4, 0.35, 14);
  wheelGeo.rotateZ(Math.PI / 2);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x101010, roughness: 0.9 });
  const wheels = [];
  const positions = [
    [-0.95, 0.4,  1.35, true],
    [ 0.95, 0.4,  1.35, true],
    [-0.95, 0.4, -1.35, false],
    [ 0.95, 0.4, -1.35, false],
  ];
  for (const [x, y, z, steered] of positions) {
    // Wrap the wheel in a group so we can rotate Y (steer) on the group and X (spin) on child
    const grp = new THREE.Group();
    grp.position.set(x, y, z);
    grp.userData.steered = steered;
    const w = new THREE.Mesh(wheelGeo, wheelMat);
    grp.add(w);
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
