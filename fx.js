// Visual FX: particles, damage numbers, camera shake.
// Light-weight pools to keep GC quiet.

import * as THREE from "https://esm.sh/three@0.160.0";

const TMP = new THREE.Vector3();

// === Particle pool ===
const particles = [];
const PARTICLE_GEO = new THREE.SphereGeometry(0.08, 4, 4);

function makeParticleMesh(color, emissive) {
  const mat = new THREE.MeshStandardMaterial({
    color,
    emissive: emissive ?? color,
    emissiveIntensity: 1.4,
    transparent: true,
    opacity: 1,
    depthWrite: false,
  });
  const m = new THREE.Mesh(PARTICLE_GEO, mat);
  m.renderOrder = 5;
  return m;
}

export function spawnParticleBurst(scene, pos, opts = {}) {
  const {
    count = 12,
    color = 0xff8060,
    emissive = null,
    speed = 4,
    spread = 1,
    life = 0.6,
    gravity = 8,
    size = 1,
    sizeVar = 0.5,
    upward = 0.5,
  } = opts;

  for (let i = 0; i < count; i++) {
    const mesh = makeParticleMesh(color, emissive);
    const s = size * (1 - sizeVar + Math.random() * sizeVar * 2);
    mesh.scale.setScalar(s);
    mesh.position.set(pos.x, pos.y, pos.z);
    scene.add(mesh);
    const dir = new THREE.Vector3(
      (Math.random() - 0.5) * 2 * spread,
      Math.random() * upward * 2,
      (Math.random() - 0.5) * 2 * spread
    ).normalize();
    const v = dir.multiplyScalar(speed * (0.6 + Math.random() * 0.6));
    particles.push({
      mesh, v,
      life: life * (0.7 + Math.random() * 0.6),
      maxLife: life,
      gravity,
      shrink: true,
    });
  }
}

export function spawnTrailParticle(scene, pos, opts = {}) {
  const { color = 0xff8060, life = 0.4, size = 0.6 } = opts;
  const mesh = makeParticleMesh(color);
  mesh.scale.setScalar(size);
  mesh.position.copy(pos);
  scene.add(mesh);
  particles.push({ mesh, v: new THREE.Vector3(), life, maxLife: life, gravity: 0, shrink: true });
}

export function updateParticles(scene, dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) {
      scene.remove(p.mesh);
      p.mesh.material.dispose();
      particles.splice(i, 1);
      continue;
    }
    p.v.y -= p.gravity * dt;
    p.mesh.position.addScaledVector(p.v, dt);
    const t = p.life / p.maxLife;
    p.mesh.material.opacity = t;
    if (p.shrink) p.mesh.scale.setScalar(Math.max(0.05, t * p.mesh.scale.x * 1.0 + p.mesh.scale.x * 0.0));
  }
}

// === Damage numbers ===
const damageNums = [];

export function spawnDamageNumber(scene, pos, text, opts = {}) {
  const { color = "#ffe080", outline = "#3a1d10" } = opts;
  const canvas = document.createElement("canvas");
  canvas.width = 256; canvas.height = 96;
  const ctx = canvas.getContext("2d");
  ctx.font = "bold 56px Georgia";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 8;
  ctx.strokeStyle = outline;
  ctx.fillStyle = color;
  ctx.strokeText(text, 128, 50);
  ctx.fillText(text, 128, 50);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.5, 0.6, 1);
  sprite.position.set(pos.x + (Math.random() - 0.5) * 0.4, pos.y + 0.5, pos.z + (Math.random() - 0.5) * 0.4);
  sprite.renderOrder = 1000;
  scene.add(sprite);
  damageNums.push({ sprite, mat, t: 0, life: 1.0, v: new THREE.Vector3((Math.random() - 0.5) * 0.6, 1.6, (Math.random() - 0.5) * 0.6) });
}

export function updateDamageNumbers(scene, dt) {
  for (let i = damageNums.length - 1; i >= 0; i--) {
    const d = damageNums[i];
    d.t += dt;
    d.sprite.position.addScaledVector(d.v, dt);
    d.v.y -= dt * 1.4;
    d.mat.opacity = Math.max(0, 1 - d.t / d.life);
    if (d.t >= d.life) {
      scene.remove(d.sprite);
      d.mat.dispose();
      d.mat.map?.dispose();
      damageNums.splice(i, 1);
    }
  }
}

// === Camera shake ===
let shakeAmount = 0;
let shakeDecay = 0;
const shakeOffset = new THREE.Vector3();

export function cameraShake(amount = 0.4, duration = 0.3) {
  shakeAmount = Math.max(shakeAmount, amount);
  shakeDecay = amount / duration;
}

export function applyCameraShake(camera, dt) {
  // Remove last frame's offset
  camera.position.sub(shakeOffset);
  if (shakeAmount > 0) {
    shakeOffset.set(
      (Math.random() - 0.5) * shakeAmount,
      (Math.random() - 0.5) * shakeAmount,
      (Math.random() - 0.5) * shakeAmount
    );
    camera.position.add(shakeOffset);
    shakeAmount = Math.max(0, shakeAmount - shakeDecay * dt);
  } else {
    shakeOffset.set(0, 0, 0);
  }
}

// === Fireflies (ambient sparkles in forest) ===
const fireflies = [];

export function spawnFireflies(scene, count = 80, bounds) {
  const geo = new THREE.SphereGeometry(0.07, 4, 4);
  const mat = new THREE.MeshBasicMaterial({ color: 0xfff080, transparent: true, opacity: 0.9 });
  for (let i = 0; i < count; i++) {
    const m = new THREE.Mesh(geo, mat.clone());
    m.position.set(
      (Math.random() - 0.5) * bounds.x,
      0.6 + Math.random() * 2.4,
      (Math.random() - 0.5) * bounds.z
    );
    scene.add(m);
    fireflies.push({
      mesh: m,
      base: m.position.clone(),
      phase: Math.random() * Math.PI * 2,
      drift: new THREE.Vector3((Math.random() - 0.5) * 0.4, 0, (Math.random() - 0.5) * 0.4),
    });
  }
}

export function updateFireflies(dt, time) {
  for (const f of fireflies) {
    const t = time * 0.001 + f.phase;
    f.mesh.position.x = f.base.x + Math.sin(t * 0.7) * 1.2 + f.drift.x * Math.sin(t * 0.3);
    f.mesh.position.z = f.base.z + Math.cos(t * 0.6) * 1.2 + f.drift.z * Math.cos(t * 0.4);
    f.mesh.position.y = f.base.y + Math.sin(t * 1.3) * 0.4;
    f.mesh.material.opacity = 0.4 + Math.abs(Math.sin(t * 2.1)) * 0.6;
  }
}
